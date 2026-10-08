/**
 * 事件节点构建器 — 从 AI 响应中构建结构化事件（2026-04-14 重写）
 *
 * 设计原则（与 demo 对齐）：
 * - **每回合产出 1 个事件**（旧版本按句子切成 3 个碎片，导致 entity/relation 构建器无从下手）
 * - 事件包含丰富的元数据：时间、地点、相关角色、事件标题、burned summary
 * - `summary` 字段作为 Embedding 输入（命中 query 里的时间/地点/人物关键词）
 * - `structured_kv` 字段供下游 EntityBuilder 提取实体
 * - `is_embedded` 标记供调试面板统计，由 engram-manager 在向量化成功后置 true
 *
 * Role / location / time 的取数路径：
 * - role：`response.midTermMemory.相关角色`（mainRound.md 要求 AI 每回合必填）
 * - location：`stateManager.get(paths.playerLocation)` → "角色.基础信息.当前位置"
 * - time：`stateManager.get(paths.gameTime)` → "世界.时间" = { 年, 月, 日, 小时, 分钟 }
 * - subject：玩家名，从 `paths.playerName` 读（避免 EntityBuilder 空掉）
 *
 * 对应 STEP-03B M3.6 Engram 数据流（EventBuilder 阶段）。
 */
import type { AIResponse } from '../../ai/types';
import type { StatePath } from '../../types';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';

/**
 * 最小化状态读取接口 —— EventBuilder 只需要 `.get()`，
 * 定义结构化接口而非依赖具体 StateManager 类，便于单元测试
 * 用 mock 替代（mock 不必实现 state/changeHistory 等私有字段）。
 */
export interface EngramStateReader {
  get<T = unknown>(path: StatePath): T | undefined;
}

// ─── 类型定义 ───

/** 事件节点结构化元数据（供 EntityBuilder 提取） */
export interface EngramEventStructuredKV {
  /** 事件标题 —— 第一句（≤48 字） */
  event: string;
  /** 相关角色名称列表 */
  role: string[];
  /** 事件发生地点（数组，便于未来多地点支持） */
  location: string[];
  /** 时间锚（格式化后的字符串） */
  time_anchor: string;
  /** 因果标记（"承接" | "转折" | ...），目前固定 "承接" */
  causality: string;
  /** 逻辑标签（扩展字段，目前留空） */
  logic: string[];
}

/** 单个事件节点 — 知识图谱中的"事实"单元 */
export interface EngramEventNode {
  /** 唯一标识（基于时间戳 + 随机后缀） */
  id: string;
  /** 动作发起者（通常是玩家名） */
  subject: string;
  /** 动作接收者（可选） */
  object?: string;
  /** 发生的动作（`narrative` 表示原始叙事事件） */
  action: string;
  /** 事件发生的故事内时间（冗余字段，structured_kv.time_anchor 为主） */
  time?: string;
  /** 发生地点（冗余字段，structured_kv.location[0] 为主） */
  location?: string;
  /** 分类标签 */
  tags: string[];
  /** 原始叙事文本片段 */
  text: string;
  /**
   * burned summary —— 含标题 + 元数据 + 原文的完整总结。
   * 2026-04-14 新增：作为 Embedding 输入，让向量检索可以命中
   * query 里的时间/地点/人物关键词，而不是只匹配叙事字面。
   */
  summary: string;
  /**
   * 结构化元数据 —— 供 EntityBuilder 提取实体
   */
  structured_kv: EngramEventStructuredKV;
  /**
   * 是否已完成向量化。engram-manager 向量化成功后置 true，
   * Rollback / model 变更场景下回退为 false 并重嵌。
   */
  is_embedded: boolean;
  /** 产生此事件的游戏回合序号 */
  roundNumber?: number;
  /** AI 生成的中期记忆摘要（50-100字），用于 2-hop 图谱充实（避免注入完整原文） */
  midTermSummary?: string;
  /** V2: 本事件提及的实体名（从 structured_kv.role 填充，对齐 Graphiti 的 EpisodicEdge MENTIONS） */
  mentionedEntities?: string[];
}

/** EventBuilder 从 state 读取时使用的路径集合（由外部注入，避免硬编码） */
export interface EventBuilderPaths {
  /** 玩家名 —— 默认 "角色.基础信息.姓名" */
  playerName: string;
  /** 玩家当前位置 —— 默认 "角色.基础信息.当前位置" */
  playerLocation: string;
  /** 游戏时间对象 —— 默认 "世界.时间"（{年,月,日,小时,分钟}） */
  gameTime: string;
}

// ─── 工具函数 ───

/**
 * 从叙事文本中提取第一句作为事件标题
 * 规则：按 `。！？` 切，取第一段；超过 max 字则截断
 */
function extractTitle(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '事件';
  const endIdx = clean.search(/[。！？.!?]/);
  const first = endIdx > 0 ? clean.slice(0, endIdx) : clean;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/**
 * 格式化游戏时间对象为可读字符串
 * 接受 `{年, 月, 日, 小时, 分钟}` 任意子集，缺字段用 0/— 补
 */
function formatGameTime(time: unknown): string {
  if (time === null || typeof time !== 'object') return '';
  const t = time as Record<string, unknown>;
  const F = DEFAULT_ENGINE_PATHS.gameTimeFieldNames;
  const year = typeof t[F.year] === 'number' ? t[F.year] : undefined;
  const month = typeof t[F.month] === 'number' ? t[F.month] : undefined;
  const day = typeof t[F.day] === 'number' ? t[F.day] : undefined;
  const hour = typeof t[F.hour] === 'number' ? t[F.hour] : undefined;
  const minute = typeof t[F.minute] === 'number' ? t[F.minute] : undefined;
  if (year === undefined && month === undefined && day === undefined) return '';
  const datePart = `${year ?? 0}年${month ?? 0}月${day ?? 0}日`;
  if (hour !== undefined && minute !== undefined) {
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${datePart} ${hh}:${mm}`;
  }
  return datePart;
}

/**
 * 构造 burned summary —— 向量检索用
 *
 * 格式：`{title}({causality} | {logic}):\n({time_anchor} | {location} | {roles}) {rawText}`
 *
 * - title 行：标题 + 因果/逻辑标签（括号内）
 * - meta 行：时间 | 地点 | 相关角色（括号内）
 * - body：原始叙事文本
 *
 * 例：
 *   `与张三的对话(承接):\n(仙道1年3月5日 14:20 | 青城山 | 玩家, 张三) 你点了点头...`
 */
function buildBurnedSummary(
  rawText: string,
  kv: EngramEventStructuredKV,
): string {
  const titleSuffixParts: string[] = [];
  if (kv.causality) titleSuffixParts.push(kv.causality);
  if (kv.logic.length > 0) titleSuffixParts.push(kv.logic.join(', '));
  const titleSuffix = titleSuffixParts.length > 0 ? `(${titleSuffixParts.join(' | ')})` : '';
  const titleLine = kv.event ? `${kv.event}${titleSuffix}:\n` : '';

  const metaParts: string[] = [];
  if (kv.time_anchor) metaParts.push(kv.time_anchor);
  if (kv.location.length > 0) metaParts.push(kv.location.join(', '));
  if (kv.role.length > 0) metaParts.push(kv.role.join(', '));
  const metaLine = metaParts.length > 0 ? `(${metaParts.join(' | ')}) ` : '';

  return `${titleLine}${metaLine}${rawText}`.trim();
}

// ─── EventBuilder ───

export class EventBuilder {
  /**
   * 从 AI 响应 + 状态树中构建事件列表
   *
   * 正常情况返回恰好 1 条事件；若响应 text 为空，返回 [].
   *
   * @param response AI 解析后的结构化响应
   * @param stateManager 当前状态树（用于读取玩家名/位置/时间）
   * @param roundNumber 当前回合序号
   * @param paths 状态树路径集合（由 engram-manager 注入）
   */
  build(
    response: AIResponse,
    stateManager: EngramStateReader,
    roundNumber: number,
    paths: EventBuilderPaths,
  ): EngramEventNode[] {
    const rawText = (response.text ?? '').trim();
    if (!rawText) return [];

    // ── 从状态树取 subject / location / time ──
    const playerName =
      stateManager.get<string>(paths.playerName) || '玩家';
    const locationRaw = stateManager.get<string>(paths.playerLocation);
    const location = typeof locationRaw === 'string' && locationRaw.trim().length > 0
      ? [locationRaw.trim()]
      : [];
    const timeObj = stateManager.get<unknown>(paths.gameTime);
    const timeAnchor = formatGameTime(timeObj);

    // ── 从 AI 响应取 role（中期记忆相关角色） ──
    const mid = response.midTermMemory;
    const rolesRaw =
      mid && typeof mid === 'object' && !Array.isArray(mid) && Array.isArray(mid.相关角色)
        ? (mid.相关角色 as unknown[])
        : [];
    const roles = rolesRaw
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((s) => s.trim());

    // ── 构造 structured_kv ──
    const title = extractTitle(rawText, 48);
    const kv: EngramEventStructuredKV = {
      event: title,
      role: roles,
      location,
      time_anchor: timeAnchor,
      causality: '承接',
      logic: [],
    };

    const summary = buildBurnedSummary(rawText, kv);

    return [
      {
        id: this.generateId(),
        subject: playerName,
        action: 'narrative',
        tags: ['narrative'],
        text: rawText,
        summary,
        structured_kv: kv,
        is_embedded: false,
        time: timeAnchor || undefined,
        location: location[0],
        roundNumber,
        mentionedEntities: [playerName, ...roles].filter((v, i, a) => a.indexOf(v) === i),
      },
    ];
  }

  /**
   * 生成唯一事件 ID
   * 格式: `evt_{timestamp}_{random}` —— 时间戳 base36 + 6 字符随机后缀
   */
  private generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `evt_${ts}_${rand}`;
  }
}
