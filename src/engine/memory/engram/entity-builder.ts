/**
 * 实体节点构建器 — 双源聚合实体信息（2026-04-14 重构）
 *
 * **双源设计**：实体不只从 events 抽取，还要从状态树 `社交.关系` 读：
 * - 玩家（`角色.基础信息.姓名`）始终是第一个实体
 * - `社交.关系` 数组中每个非"普通"类型的 NPC 建为 char 实体
 * - events 的 `structured_kv.role` / `location` 继续扫描补充
 *
 * 旧版本只看 events，而 events 在 EventBuilder 旧版本里是碎片
 * （subject/object/location 全空），导致 entities 永远为空。新版本
 * 即使 events 空，也能从状态树直接建玩家 + NPC 实体。
 *
 * 新增字段：
 * - `summary`：NPC 的「生平（背景）+ 外貌描述」拼接，供 embedding 输入（稳定知识；
 *   刻意排除内心想法等瞬时状态，避免污染实体检索向量）
 * - `is_embedded`：向量化成功后置 true，供调试面板统计
 *
 * 对应 STEP-03B M3.6 Engram 数据流（EntityBuilder 阶段）。
 */
import type { EngramEventNode, EngramStateReader } from './event-builder';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';
import { TIANMING_LEGACY_NPC_KEYS } from '../../pack/tianming-coupling';

// ─── 类型定义 ───

/** 实体节点 — 知识图谱中的"对象"单元 */
export interface EngramEntity {
  /** 实体名称（也是主键，用于合并同名实体） */
  name: string;
  /** 实体类型 */
  type: 'player' | 'npc' | 'location' | 'item';
  /** 实体属性（从事件上下文中累积的信息） */
  attributes: Record<string, unknown>;
  /** 首次出现的回合序号 */
  firstSeen: number;
  /** 最近出现的回合序号 */
  lastSeen: number;
  /** 累计出现次数（重要性指标） */
  mentionCount: number;
  /**
   * 实体描述文本 —— 供 Embedding 输入（实体语义检索 / Node search）
   * 对于 NPC 是「生平（背景）+ 外貌描述」的组合（稳定知识；刻意排除内心想法等
   * 瞬时状态，避免污染实体检索向量）；对于玩家填占位字符串。
   */
  summary: string;
  /**
   * 是否已完成向量化。engram-manager 向量化成功后置 true。
   * 2026-04-14 新增。
   */
  is_embedded: boolean;
  /**
   * Tier 1 补桩标记：此实体由引擎自动创建（缺失的事实边端点），
   * summary 尚未由 AI 填充。Tier 2（FieldRepairPipeline combined step）
   * 成功写入描述后移除此标记。
   */
  _pendingEnrichment?: boolean;
  /** Round when Tier 2 AI enrichment filled the description */
  enrichedAtRound?: number;

  /**
   * 数据来源标记。
   * undefined = legacy / EntityBuilder 派生（迁移时视为 'derived'）
   */
  source?: 'derived' | 'user' | 'card-import';

  /** 用户手动编辑时记录回合号 */
  userEditedAtRound?: number;
}

/** EntityBuilder 从 state 读取时使用的路径集合 */
export interface EntityBuilderPaths {
  /** 玩家名 —— 默认 "角色.基础信息.姓名" */
  playerName: string;
  /** 社交关系数组 —— 默认 "社交.关系"，结构为 NpcRelationshipEntry[] */
  relationships: string;
  /**
   * NPC 实体 summary 的来源字段名（注入，避免在引擎里硬编码游戏特定中文字段名）。
   * summary = 生平（background）+ 外貌（appearance）；description 仅作兜底。
   * 刻意不含内心想法/在做事项等瞬时字段 —— Engram 实体向量只承载稳定知识。
   */
  npcDescriptionFields: {
    /** 生平/背景 字段名（默认 '背景'） */
    background: string;
    /** 外貌描述 字段名（默认 '外貌描述'） */
    appearance: string;
    /** 一句话身份描述 字段名（默认 '描述'，仅当背景+外貌均空时兜底） */
    description: string;
  };
}

/**
 * NPC 关系数组条目（Production schema：社交.关系 是数组）
 */
interface NpcRelationshipEntry {
  /** NPC 姓名（数组元素的主键） */
  名称: string;
  /** NPC 类型：'重点' | '普通' | undefined（未标记视为重点） */
  类型?: string;
  /** 与玩家关系 */
  关系状态?: string;
  与玩家关系?: string;
  /** 位置 */
  位置?: string;
  // summary 来源字段（背景/外貌描述/描述）通过 EntityBuilderPaths.npcDescriptionFields
  // 的动态键名访问，走下方 index signature，不在此硬编码具体中文字段名。
  [key: string]: unknown;
}

type EntityMap = Map<string, EngramEntity>;

export class EntityBuilder {
  /**
   * 构建实体节点列表（双源）
   *
   * 顺序：
   * 1. 从 state tree 读玩家名 → 玩家实体（type=player）
   * 2. 遍历 `社交.关系`，非"普通"类型的 NPC → char 实体（type=npc）
   * 3. 遍历 events，补充出现在 structured_kv.role / location 中但还未建的实体
   *
   * @param events 当前所有事件（含历史）
   * @param stateManager 状态管理器（读玩家名 + 社交关系）
   * @param paths 状态路径配置
   */
  build(
    events: EngramEventNode[],
    stateManager: EngramStateReader,
    paths: EntityBuilderPaths,
    options?: { includeAllNpcTypes?: boolean },
  ): EngramEntity[] {
    const entityMap: EntityMap = new Map();

    // ── 1 + 2. 玩家 + 社交关系中的 NPC ──
    const playerName = this.seedPlayerAndNpcs(entityMap, stateManager, paths, options);

    // ── 3 + 4. 从 events 补充 role / location 实体 ──
    this.addEventEntities(entityMap, events, playerName);

    // ── 5. Fix firstSeen/lastSeen from events ──
    this.fixSeenRounds(entityMap, events, playerName);

    return Array.from(entityMap.values());
  }

  /** Steps 1-2: the player entity, then the relationship-array NPCs. Returns the resolved player name. */
  private seedPlayerAndNpcs(
    entityMap: EntityMap,
    stateManager: EngramStateReader,
    paths: EntityBuilderPaths,
    options?: { includeAllNpcTypes?: boolean },
  ): string {
    const F = DEFAULT_ENGINE_PATHS.npcFieldNames;

    // ── 1. 玩家 ──
    const playerName = stateManager.get<string>(paths.playerName) || '玩家';
    this.upsertEntity(entityMap, playerName, 'player', 0, '玩家角色');

    // ── 2. 社交关系中的 NPC ──
    const relationships = stateManager.get<NpcRelationshipEntry[]>(paths.relationships);
    if (Array.isArray(relationships)) {
      for (const npc of relationships) {
        if (!npc || typeof npc !== 'object') continue;
        const rawName = npc[F.name];
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (!name) continue;
        if (!options?.includeAllNpcTypes && npc[F.type] === DEFAULT_ENGINE_PATHS.npcTypeExclude) continue;
        const description = this.buildNpcDescription(npc, paths.npcDescriptionFields);
        this.upsertEntity(entityMap, name, 'npc', 0, description, {
          relationToPlayer: npc[F.relationshipStatus] ?? npc[TIANMING_LEGACY_NPC_KEYS.relationToPlayer],
          location: npc[F.location],
          source: 'relationship',
        });
      }
    }
    return playerName;
  }

  /** Steps 3-4: pre-scan known locations, then add role / location / legacy-field entities. */
  private addEventEntities(
    entityMap: EntityMap,
    events: EngramEventNode[],
    playerName: string,
  ): void {
    // ── 3. Pre-scan: collect all known location names from events ──
    const knownLocations = new Set<string>();
    for (const event of events) {
      const kv = event.structured_kv;
      if (kv && Array.isArray(kv.location)) {
        for (const loc of kv.location) {
          if (typeof loc === 'string' && loc.trim()) knownLocations.add(loc.trim());
        }
      }
      if (event.location) knownLocations.add(event.location.trim());
    }

    // ── 4. 从 events 补充 role / location 实体（uses knownLocations from step 3） ──
    for (const event of events) {
      const round = event.roundNumber ?? 0;
      const kv = event.structured_kv;

      // role → char（"玩家" 字面量合并到实际玩家名，避免重复 player 实体）
      if (kv && Array.isArray(kv.role)) {
        for (const role of kv.role) {
          if (typeof role !== 'string' || !role.trim()) continue;
          const trimmedName = role.trim();
          // "玩家"/"player" 字面量 → 合并到真实玩家名
          const isPlayerAlias = trimmedName === '玩家' || trimmedName === 'player';
          const resolvedName = (isPlayerAlias || trimmedName === playerName) ? playerName : trimmedName;
          const type = (isPlayerAlias || resolvedName === playerName) ? 'player' : this.inferType(resolvedName, knownLocations);
          this.upsertEntity(entityMap, resolvedName, type, round, '', {
            source: 'event_role',
            lastEventId: event.id,
          });
        }
      }

      // location → location
      if (kv && Array.isArray(kv.location)) {
        for (const loc of kv.location) {
          if (typeof loc !== 'string' || !loc.trim()) continue;
          this.upsertEntity(entityMap, loc.trim(), 'location', round, '', {
            source: 'event_location',
            lastEventId: event.id,
          });
        }
      }

      // 兼容旧字段：event.subject / event.object / event.location（平铺字段）
      if (event.subject) {
        const subj = event.subject === '玩家' || event.subject === 'player' ? playerName : event.subject;
        const subjType = subj === playerName ? 'player' : this.inferType(subj, knownLocations);
        this.upsertEntity(entityMap, subj, subjType, round, '');
      }
      if (event.object) {
        const obj = event.object === '玩家' || event.object === 'player' ? playerName : event.object;
        this.upsertEntity(entityMap, obj, this.inferType(obj, knownLocations), round, '');
      }
      if (event.location) {
        this.upsertEntity(entityMap, event.location, 'location', round, '');
      }
    }
  }

  /** Step 5: derive firstSeen/lastSeen of non-player entities from the events. */
  private fixSeenRounds(
    entityMap: EntityMap,
    events: EngramEventNode[],
    playerName: string,
  ): void {
    // ── 5. Fix firstSeen/lastSeen from events ──
    // Step 2 hardcodes round=0 for relationship-sourced entities because 社交.関係
    // doesn't record when an NPC was added. This post-processing pass derives the
    // actual first/last appearance round from event data (authoritative source).
    const eventRounds = new Map<string, { first: number; last: number }>();
    for (const event of events) {
      const round = event.roundNumber ?? 0;
      const kv = event.structured_kv;
      const names = new Set<string>();
      if (kv?.role) {
        for (const r of kv.role) {
          if (typeof r !== 'string' || !r.trim()) continue;
          const n = r.trim();
          names.add((n === '玩家' || n === 'player') ? playerName : n);
        }
      }
      if (kv?.location) {
        for (const l of kv.location) {
          if (typeof l === 'string' && l.trim()) names.add(l.trim());
        }
      }
      if (event.subject) names.add(event.subject === '玩家' || event.subject === 'player' ? playerName : event.subject);
      if (event.object) names.add(event.object === '玩家' || event.object === 'player' ? playerName : event.object);
      if (event.location) names.add(event.location);

      for (const n of names) {
        const existing = eventRounds.get(n);
        if (existing) {
          if (round < existing.first) existing.first = round;
          if (round > existing.last) existing.last = round;
        } else {
          eventRounds.set(n, { first: round, last: round });
        }
      }
    }

    for (const entity of entityMap.values()) {
      if (entity.type === 'player') continue;
      const er = eventRounds.get(entity.name);
      if (er) {
        entity.firstSeen = er.first;
        entity.lastSeen = er.last;
      }
    }
  }

  /**
   * 拼接 NPC 实体描述字符串（供 Embedding / 实体语义检索）
   *
   * summary = 生平（背景）+ 外貌描述（稳定知识）；两者皆空时用一句话「描述」兜底。
   * **刻意排除** 内心想法 / 在做事项 等瞬时状态 —— 它们每回合变化，放进实体检索向量
   * 会污染召回质量（Engram 实体只承载稳定知识）。
   * 字段名经 paths 注入，不在引擎内硬编码游戏特定中文字段名。
   */
  private buildNpcDescription(
    npc: NpcRelationshipEntry,
    fields: EntityBuilderPaths['npcDescriptionFields'],
  ): string {
    const read = (key: string): string => {
      const v = npc[key];
      return typeof v === 'string' ? v.trim() : '';
    };
    const parts: string[] = [];
    const background = read(fields.background);
    if (background) parts.push(background);
    const appearance = read(fields.appearance);
    if (appearance) parts.push(appearance);
    // 兜底：背景与外貌都缺失时，用一句话身份「描述」避免空 summary。
    if (parts.length === 0) {
      const desc = read(fields.description);
      if (desc) parts.push(desc);
    }
    return parts.join('；');
  }

  /**
   * Upsert 实体 —— 已存在则更新 lastSeen/mentionCount/description/attributes
   *
   * 类型在首次创建时确定，后续不改。
   * description: 每次有非空新值就更新（持续从 NPC 的当前状态刷新，参照 ming）。
   * 空描述不会覆盖已有的非空描述。
   */
  private upsertEntity(
    map: EntityMap,
    name: string,
    type: EngramEntity['type'],
    round: number,
    description: string,
    extraAttrs: Record<string, unknown> = {},
  ): void {
    const existing = map.get(name);
    if (existing) {
      existing.lastSeen = Math.max(existing.lastSeen, round);
      existing.firstSeen = Math.min(existing.firstSeen, round);
      existing.mentionCount += 1;
      // 持续更新描述：新的非空描述覆盖旧的（NPC 外貌/状态会变化）
      if (description && existing.summary !== description) {
        if (existing.is_embedded) existing.is_embedded = false;
        existing.summary = description;
      }
      existing.attributes = { ...existing.attributes, ...extraAttrs };
      return;
    }
    map.set(name, {
      name,
      type,
      attributes: { ...extraAttrs },
      firstSeen: round,
      lastSeen: round,
      mentionCount: 1,
      summary: description,
      is_embedded: false,
    });
  }

  private inferType(name: string, knownLocations?: ReadonlySet<string>): EngramEntity['type'] {
    return inferEntityType(name, knownLocations);
  }
}

/**
 * Junk-name guard for knowledge-fact endpoints: a name that reads like a clause
 * (comma/verb/particle markers) is a descriptive phrase, not an entity.
 */
export function isSentenceLikeName(s: string): boolean {
  return s.length > 6 && /[，。了的被在过着得让把将与从]/.test(s);
}

/**
 * Auto-stub for a fact endpoint that has no entity yet (pending enrichment).
 * Key order is part of the persisted bytes — do not reorder.
 */
export function makeFactStubEntity(
  name: string,
  type: EngramEntity['type'],
  round: number,
): EngramEntity {
  return {
    name,
    type,
    summary: '',
    attributes: {},
    firstSeen: round,
    lastSeen: round,
    mentionCount: 1,
    is_embedded: false,
    _pendingEnrichment: true,
  };
}

export function inferEntityType(
  name: string,
  knownLocations?: ReadonlySet<string>,
): EngramEntity['type'] {
  if (name === '玩家' || name === 'player') return 'player';
  if (knownLocations?.has(name)) return 'location';
  if (/[·]/.test(name) || /[村镇城池山林洞窟街道广场酒馆教堂寺庙道观宫殿区域大陆]/.test(name)) return 'location';
  if (/[计划文件卷轴药剑书戒指吊坠笔记本信件地图钥匙]/.test(name)) return 'item';
  return 'npc';
}
