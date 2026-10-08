// Archived research: docs/status/archive/research-custom-creation-presets-2026-04-14.md
/**
 * CustomPresetStore — 用户自定义创角预设的 IDB 持久化层
 *
 * 设计目的：让玩家在创角时可以追加自己设计的世界 / 出身 / 特质 / 天赋等
 * 预设条目，与 Game Pack 内置预设并排显示。**生产对 game pack 内容是只读的**，
 * 用户自定义只能"追加"，不能编辑或删除 pack 内置项。
 *
 * 数据按 packId 隔离 —— 切换 pack 时各自独立，不会互相污染。
 *
 * 存储结构：IDB key 为 `custom_presets_{packId}`，value 形如：
 * ```json
 * {
 *   "packId": "tianming",
 *   "schemaVersion": 1,
 *   "presets": {
 *     "worlds":   [{ id, source: 'user', createdAt, generatedBy, name, description, ... }],
 *     "origins":  [...],
 *     "talents":  [...],
 *     ...
 *   },
 *   "meta": { "lastUpdated": 1776200000000 }
 * }
 * ```
 *
 * **ID 命名约定**：用户条目的 id 必须以 `user_` 前缀开头（如 `user_mxyz_abc`），
 * pack 内置不应使用此前缀，避免 merge 时冲突。`generateUserPresetId()` 已强制此规则。
 *
 * 对应 docs/status/research-custom-creation-presets-2026-04-14.md Phase 1。
 */
import { idbAdapter } from './idb-adapter';

// ─── 类型 ───

/**
 * 用户自定义预设条目 —— 字段视具体 preset 类型而定（worlds/origins/...）
 *
 * 必须字段：
 * - `id`：主键，强制 `user_` 前缀
 * - `source: 'user'`：用于 UI 标记可编辑可删除
 * - `createdAt`：时间戳（毫秒）
 * - `generatedBy`：来源标记（手填 vs AI 生成）
 *
 * 其余字段（name/description/talent_cost 等）由 `creation-flow.json` 的
 * `customSchema.fields` 决定，本类型不强约束。
 */
export interface CustomPresetEntry {
  id: string;
  source: 'user';
  createdAt: number;
  generatedBy: 'manual' | 'ai';
  [key: string]: unknown;
}

/** 单个 pack 的全部用户预设数据 */
export interface CustomPresetsData {
  packId: string;
  /** Schema 版本号，未来字段变化时供 migration 用 */
  schemaVersion: number;
  /** key = preset 类型（如 "worlds", "origins"），value = 该类型下的条目数组 */
  presets: Record<string, CustomPresetEntry[]>;
  meta: {
    lastUpdated: number;
  };
}

/** 当前数据格式版本 */
const CURRENT_SCHEMA_VERSION = 1;

/** IDB key 前缀 —— 与其他存档/向量数据共用 `aga-saves` store，但 key 命名空间隔离 */
const KEY_PREFIX = 'custom_presets_';

/** 用户自定义条目的 ID 强制前缀 */
const USER_ID_PREFIX = 'user_';

// ─── 工具函数 ───

/**
 * 生成用户预设条目的唯一 ID
 *
 * 格式：`user_{base36-timestamp}_{6-char-random}` —— 时间戳保证大致有序，
 * 随机后缀处理同毫秒内多次添加。
 */
export function generateUserPresetId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${USER_ID_PREFIX}${ts}_${rand}`;
}

/** 校验 ID 是否带 user_ 前缀（其他模块写入前可调用） */
export function isUserPresetId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(USER_ID_PREFIX);
}

function buildKey(packId: string): string {
  return `${KEY_PREFIX}${packId}`;
}

function createEmpty(packId: string): CustomPresetsData {
  return {
    packId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    presets: {},
    meta: { lastUpdated: 0 },
  };
}

// ─── Store 实现 ───

export class CustomPresetStore {
  /**
   * 写入互斥锁 —— 修复 CR-2026-04-14 P0-1 的 load→mutate→save 竞争
   *
   * 所有"读—修改—写回"语义的方法（add/update/remove/replaceAll/clear/bulkAppend）
   * 都通过 `withWriteLock` 串行化，避免并发场景下数据丢失：
   *
   * ```
   * 时序                A.add()                 B.add()
   * 0ms                 load(snapshot=v0)
   * 5ms                                          load(snapshot=v0) ← 拿到旧快照
   * 10ms                save(v0+entryA)
   * 15ms                                          save(v0+entryB) ← 覆盖了 A
   * ```
   *
   * 锁是 in-memory 的（per-instance），跨 tab 不生效 —— 如果未来要支持
   * 多 tab 并发写，需要 IDB-level 锁或事件广播。
   */
  private writeLock: Promise<unknown> = Promise.resolve();

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let resolver: (v: unknown) => void;
    this.writeLock = new Promise((res) => { resolver = res; });
    try {
      // 等待上一个写操作完成（忽略其结果，只保证顺序）
      await prev.catch(() => {});
      return await fn();
    } finally {
      resolver!(undefined);
    }
  }

  /**
   * 加载某 pack 的全部用户预设数据
   *
   * 不存在时返回空结构（不是 undefined）—— 调用方无需 null check。
   * 校验 schemaVersion；不匹配未来可在此插 migration 钩子（当前直接返回原数据 + 警告）。
   */
  async load(packId: string): Promise<CustomPresetsData> {
    if (!packId) return createEmpty('');
    const raw = await idbAdapter.get<CustomPresetsData>(buildKey(packId));
    if (!raw) return createEmpty(packId);

    if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[CustomPresetStore] Schema version mismatch for pack "${packId}": ` +
          `stored=${raw.schemaVersion}, current=${CURRENT_SCHEMA_VERSION}. ` +
          `Loading as-is; future migrations should hook here.`,
      );
    }

    // 防御性兜底：缺字段时补齐
    return {
      packId: raw.packId ?? packId,
      schemaVersion: raw.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      presets: raw.presets ?? {},
      meta: raw.meta ?? { lastUpdated: 0 },
    };
  }

  /** 持久化某 pack 的全部用户预设数据 */
  async save(data: CustomPresetsData): Promise<void> {
    if (!data.packId) {
      throw new Error('[CustomPresetStore] save() requires packId');
    }
    const toWrite: CustomPresetsData = {
      ...data,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      meta: { lastUpdated: Date.now() },
    };
    await idbAdapter.set(buildKey(data.packId), toWrite);
  }

  /**
   * 取某 pack 某 preset 类型的用户条目数组
   *
   * 例：`get('tianming', 'worlds')` → `[{id: 'user_xxx', name: '...', ...}, ...]`
   */
  async get(packId: string, presetType: string): Promise<CustomPresetEntry[]> {
    const data = await this.load(packId);
    const list = data.presets[presetType];
    return Array.isArray(list) ? list : [];
  }

  /**
   * 追加一条用户预设
   *
   * @param packId 当前 pack
   * @param presetType preset 类型（如 "worlds"）
   * @param fields 用户填写的字段（可包含 name/description/talent_cost 等）
   * @param generatedBy 标记来源（手填/AI 生成）
   * @returns 新建条目的完整对象（含新生成的 id / source / createdAt）
   */
  async add(
    packId: string,
    presetType: string,
    fields: Record<string, unknown>,
    generatedBy: 'manual' | 'ai' = 'manual',
  ): Promise<CustomPresetEntry> {
    return this.withWriteLock(async () => {
      const data = await this.load(packId);
      const list = Array.isArray(data.presets[presetType]) ? data.presets[presetType] : [];
      const entry: CustomPresetEntry = {
        ...fields,
        id: generateUserPresetId(),
        source: 'user',
        createdAt: Date.now(),
        generatedBy,
      };
      // unshift —— 新加的排在最前，与 demo 行为一致
      list.unshift(entry);
      data.presets[presetType] = list;
      await this.save(data);
      return entry;
    });
  }

  /**
   * 更新某用户条目的字段（partial patch）
   *
   * 不允许通过 patch 改 id / source / createdAt（这三个字段被强制忽略）。
   * 找不到条目时静默 no-op，返回 false。
   */
  async update(
    packId: string,
    presetType: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isUserPresetId(id)) {
      console.warn(`[CustomPresetStore] update() ignored — id "${id}" lacks "user_" prefix`);
      return false;
    }
    return this.withWriteLock(async () => {
      const data = await this.load(packId);
      const list = data.presets[presetType];
      if (!Array.isArray(list)) return false;
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) return false;

      // 保护字段：id / source / createdAt / generatedBy 都不可被 patch 覆盖
      // —— generatedBy 是出处元数据（CR-2026-04-14 P2-5），与 createdAt 同语义
      const {
        id: _ignoreId,
        source: _ignoreSrc,
        createdAt: _ignoreTs,
        generatedBy: _ignoreGenBy,
        ...safeFields
      } = patch as Record<string, unknown>;
      void _ignoreId; void _ignoreSrc; void _ignoreTs; void _ignoreGenBy;

      list[idx] = { ...list[idx], ...safeFields };
      data.presets[presetType] = list;
      await this.save(data);
      return true;
    });
  }

  /**
   * 删除某用户条目
   *
   * 仅 `user_` 前缀的 id 可删；尝试删 pack 内置 id 静默拒绝。
   * 找不到条目时返回 false（不报错）。
   */
  async remove(packId: string, presetType: string, id: string): Promise<boolean> {
    if (!isUserPresetId(id)) {
      console.warn(`[CustomPresetStore] remove() ignored — id "${id}" is not a user preset`);
      return false;
    }
    return this.withWriteLock(async () => {
      const data = await this.load(packId);
      const list = data.presets[presetType];
      if (!Array.isArray(list)) return false;
      const before = list.length;
      data.presets[presetType] = list.filter((e) => e.id !== id);
      if (data.presets[presetType].length === before) return false;
      await this.save(data);
      return true;
    });
  }

  /**
   * 整个 pack 的用户预设全量替换
   *
   * 用于：
   * 1. 全量备份恢复时的 customPresets restore
   * 2. 单独导入"自定义预设包"时
   *
   * 入参的 entries 会被强制规范化（缺 id 补一个、source 强制为 'user'、
   * createdAt 缺则补当前时间）。
   */
  async replaceAll(packId: string, presetsByType: Record<string, CustomPresetEntry[]>): Promise<void> {
    return this.withWriteLock(async () => {
      const normalized: Record<string, CustomPresetEntry[]> = {};
      for (const [type, list] of Object.entries(presetsByType)) {
        if (!Array.isArray(list)) continue;
        // CR-2026-04-14 P1-5：按 id 去重，避免备份/导入文件含同 id 重复条目
        // 时产生孤儿数据。规范化后再去重 —— 因为 normalizeEntry 可能给缺失/
        // 错误前缀的 id 重新生成。保留首次出现的条目（与 unshift 顺序一致）。
        const seen = new Set<string>();
        const deduped: CustomPresetEntry[] = [];
        for (const raw of list) {
          const entry = this.normalizeEntry(raw);
          if (seen.has(entry.id)) {
            console.warn(
              `[CustomPresetStore] replaceAll: 跳过重复 id "${entry.id}" in pack "${packId}" type "${type}"`,
            );
            continue;
          }
          seen.add(entry.id);
          deduped.push(entry);
        }
        normalized[type] = deduped;
      }
      const data: CustomPresetsData = {
        packId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        presets: normalized,
        meta: { lastUpdated: Date.now() },
      };
      await this.save(data);
    });
  }

  /**
   * 批量追加多条用户预设到既有数据 —— 单次 IDB 事务（CR-2026-04-14 P2-1）
   *
   * 与"对每条调一次 add()"等价，但只产生一次 load+save，避免 N×IDB roundtrip。
   * SavePanel 单独导入"自定义预设包"流程使用本方法。
   *
   * 规则：
   * - 每条都生成新的 user_ id（**不**复用入参的 id —— 避免与既有数据冲突）
   * - createdAt 缺则补当前时间
   * - generatedBy：使用入参字段；非 'ai' 一律视为 'manual'
   * - 入参 fields 中的 id/source 字段会被覆盖
   *
   * @returns 实际新增的条目（含分配的 id），按入参顺序
   */
  async bulkAppend(
    packId: string,
    presetsByType: Record<string, ReadonlyArray<Record<string, unknown>>>,
  ): Promise<CustomPresetEntry[]> {
    return this.withWriteLock(async () => {
      const data = await this.load(packId);
      const added: CustomPresetEntry[] = [];
      const now = Date.now();
      for (const [presetType, list] of Object.entries(presetsByType)) {
        if (!Array.isArray(list) || list.length === 0) continue;
        const existing = Array.isArray(data.presets[presetType])
          ? data.presets[presetType]
          : [];
        for (const raw of list) {
          if (!raw || typeof raw !== 'object') continue;
          const { id: _id, source: _src, createdAt: _ts, generatedBy: gb, ...fields } =
            raw as Record<string, unknown>;
          void _id; void _src; void _ts;
          const entry: CustomPresetEntry = {
            ...fields,
            id: generateUserPresetId(),
            source: 'user',
            createdAt: typeof _ts === 'number' && Number.isFinite(_ts) ? _ts : now,
            generatedBy: gb === 'ai' ? 'ai' : 'manual',
          };
          existing.unshift(entry);
          added.push(entry);
        }
        data.presets[presetType] = existing;
      }
      if (added.length > 0) {
        await this.save(data);
      }
      return added;
    });
  }

  /**
   * 追加多条预设到既有数据，**保留入参的 id**，按 id append-if-absent（Story 6 卡导入 OD-J）
   *
   * 与既有两个方法的关键区别（三者都不可混用）：
   * - `replaceAll`：**抹掉**玩家既有预设 → 卡导入不能用（会删玩家自定义）。
   * - `bulkAppend`：**重新生成** id → 卡导入不能用（卡的 `角色` 可能按 id 引用某预设，
   *   重生 id 会让引用悬空，origin/天赋等解析失败）。
   * - 本方法：保留卡 preset 的 id 原样，仅当该 id 在玩家同类型列表中**尚不存在**时才追加，
   *   既不抹玩家、也不破卡引用。
   *
   * 规则：
   * - id 原样保留（不重生）；source 强制 'user'、createdAt 缺则补、generatedBy 非 'ai' 视为 'manual'。
   * - 玩家既有同 id → 跳过（append-if-absent，幂等：重复导入同卡不产生重复条目）。
   * - 卡自身列表内同 id 重复 → 保留首次出现。
   * - 缺 id 的脏条目 → 跳过并告警（无 id 无法保 id 语义，且会破引用一致性）。
   *
   * @returns 实际新增的条目（含被保留的原 id），按入参顺序
   */
  async appendPreservingIds(
    packId: string,
    presetsByType: Record<string, CustomPresetEntry[]>,
  ): Promise<CustomPresetEntry[]> {
    return this.withWriteLock(async () => {
      const data = await this.load(packId);
      const added: CustomPresetEntry[] = [];
      const now = Date.now();
      for (const [presetType, list] of Object.entries(presetsByType)) {
        if (!Array.isArray(list) || list.length === 0) continue;
        const existing = Array.isArray(data.presets[presetType])
          ? data.presets[presetType]
          : [];
        const seen = new Set(existing.map((e) => e.id));
        for (const raw of list) {
          if (!raw || typeof raw !== 'object') continue;
          const rawId = typeof raw.id === 'string' ? raw.id : '';
          if (!rawId) {
            console.warn(
              `[CustomPresetStore] appendPreservingIds: 跳过缺 id 的条目 in pack "${packId}" type "${presetType}"`,
            );
            continue;
          }
          // append-if-absent：玩家或卡自身已有同 id → 跳过（保 id 语义下的去重）
          if (seen.has(rawId)) continue;
          const entry: CustomPresetEntry = {
            ...raw,
            id: rawId, // 原样保留卡的 id —— 卡 角色 引用靠它解析
            source: 'user',
            createdAt:
              typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
                ? raw.createdAt
                : now,
            generatedBy: raw.generatedBy === 'ai' ? 'ai' : 'manual',
          };
          seen.add(rawId);
          existing.push(entry);
          added.push(entry);
        }
        data.presets[presetType] = existing;
      }
      if (added.length > 0) {
        await this.save(data);
      }
      return added;
    });
  }

  /**
   * 清除某 pack 的全部用户预设
   *
   * 用于：导入时清除来包里没有的 pack 的预设（backup-service 里的 customPresetStore.clear 调用）。
   */
  async clear(packId: string): Promise<void> {
    if (!packId) return;
    return this.withWriteLock(async () => {
      await idbAdapter.delete(buildKey(packId));
    });
  }

  /**
   * 列出所有已持有用户预设的 packId
   *
   * 供 BackupService 全量导出时遍历所有 pack 的用户数据。
   * 实现方式：扫 IDB 全 key 列表，过滤 `custom_presets_*` 前缀。
   */
  async listPackIds(): Promise<string[]> {
    const allKeys = await idbAdapter.keys();
    return allKeys
      .filter((k) => k.startsWith(KEY_PREFIX))
      .map((k) => k.slice(KEY_PREFIX.length));
  }

  /**
   * 规范化一个外部传入的 entry —— 用于 replaceAll / 导入场景
   *
   * 强制：
   * - id：缺则补；不带 user_ 前缀则补
   * - source：强制 'user'
   * - createdAt：缺则补当前时间，存在则保留
   * - generatedBy：缺则视为 'manual'
   */
  private normalizeEntry(raw: Record<string, unknown>): CustomPresetEntry {
    const rawId = typeof raw.id === 'string' ? raw.id : '';
    const id = isUserPresetId(rawId) ? rawId : generateUserPresetId();
    const createdAt =
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now();
    const generatedBy =
      raw.generatedBy === 'ai' ? 'ai' : 'manual';

    return {
      ...raw,
      id,
      source: 'user',
      createdAt,
      generatedBy,
    };
  }
}
