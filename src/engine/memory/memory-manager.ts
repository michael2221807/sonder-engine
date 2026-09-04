/**
 * 记忆管理器 — 四层记忆系统（2026-04-11 完整重构）
 *
 * 架构参照 demo `AIBidirectionalSystem.ts` + `memoryHelpers.ts`，按 design note
 * 规范（`/h/ming/docs/design note` §"中期记忆逻辑修订"）实现。
 *
 * ### 四层设计
 *
 * 1. **短期记忆（short-term）** — `记忆.短期`
 *    - 每轮 AI 回复的 `text` 字段（纯叙事），push 进来
 *    - 默认容量 5 条，可配置
 *    - 满时 shift 最旧一条
 *
 * 2. **隐式中期记忆（implicit mid-term）** — `记忆.隐式中期`
 *    - 每轮 AI 在 `mid_term_memory` 字段输出的结构化总结
 *      （`{相关角色, 事件时间, 记忆主体}`）
 *    - **和短期记忆 1:1 配对**：同一回合的短期叙事 + 该回合的结构化总结
 *    - 短期 shift 时对应的隐式 shift 并**升级为正式中期记忆**
 *    - 发送给 AI 时按"相关角色 ∩ 当前 context"过滤（见 MemoryRetriever）
 *
 * 3. **中期记忆（mid-term）** — `记忆.中期`
 *    - 由隐式中期升级而来（短期 shift 时 1:1 同步升级，无 AI 调用）
 *    - 达到 `midTermRefineThreshold` (默认 25) 时触发 **in-place 精炼** (AI 调用)
 *    - 精炼是"去重合并、不删减记忆点"，精炼后 `已精炼: true` 标记为 permanent
 *    - 下次精炼跳过已精炼条目，只送新的未精炼条目给 AI
 *    - 达到 `longTermSummaryThreshold` (默认 50) 时触发 **worldview evolution**
 *      (AI 调用)，产生一条长期记忆，消费掉参与的旧中期条目
 *
 * 4. **长期记忆（long-term）** — `记忆.长期`
 *    - 由中期记忆通过"世界观进化"汇总而来
 *    - 每次汇总生成 1 条长期记忆条目
 *    - FIFO cap 30（防止无界增长）
 *
 * ### Pipeline 触发关系
 *
 * - 短→中：`PostProcessStage` 同步完成（无 pipeline，无 AI）
 * - 中 in-place refine：`MidTermRefinePipeline` (at 25)
 * - 中→长 worldview evolution：`MemorySummaryPipeline` (at 50) —— 类名保留但语义变
 * - `game-orchestrator.runPostRoundSubPipelines` 按 if-else 二选一触发
 *   (`>=50` 优先，否则 `>=25`)
 *
 * ### 消费逻辑 (MEMORY_BLOCK)
 *
 * `MemoryRetriever.retrieve()` 按层级拼接：
 * - 长期（全量，少而精）
 * - 中期（全量，含已精炼标记）
 * - 隐式中期（**仅当 `相关角色` 与当前 context 交集时注入**）
 * - 短期（全量，最近 5 条）
 *
 * 对应 STEP-02 §3.10.4、STEP-03B M3、demo `memoryHelpers.ts`。
 */
import type { StateManager } from '../core/state-manager';
import { eventBus } from '../core/event-bus';
import { logger } from '../core/logger';


/** 短期记忆条目 — 每轮 AI 回复后追加一条 */
export interface ShortTermEntry {
  /** 轮次编号 */
  round: number;
  /** 摘要文本（AI 的 text 字段，纯叙事） */
  summary: string;
  /** 记录时间戳 */
  timestamp: number;
}

/**
 * 中期记忆条目 — 2026-04-11 重构：中文字段 + `已精炼` 标记
 *
 * 由隐式中期记忆 1:1 升级而来（短期 shift 时同步）。
 * 达到 refine 阈值时 AI 去重合并，精炼后标 `已精炼: true`，下次 refine 跳过。
 */
export interface MidTermEntry {
  /** 相关角色列表（含玩家名） */
  相关角色: string[];
  /** 事件发生的游戏时间字符串（如 "1-01-15-08-30"） */
  事件时间: string;
  /** 记忆主体：剧情总结 + 事件影响 +（事件重要性权重 1-10 括号内），50-100 字 */
  记忆主体: string;
  /**
   * 是否已被精炼 — `true` 表示该条目已参与过 in-place refine，成为 permanent。
   * 下次 refine 跳过，不送 AI，减少 token 浪费。
   */
  已精炼?: boolean;
}

/**
 * 隐式中期记忆条目 — 2026-04-11 重构：结构化对象（之前是 `unknown`）
 *
 * AI 每轮 `mid_term_memory` 字段的输出形状。和短期 1:1 配对，短期 shift 时
 * 对应的隐式也 shift 并升级为正式中期记忆（同形状，无需转换）。
 *
 * 发送给 AI 时按 `相关角色 ∩ 当前 context (玩家+最近 NPC)` 过滤。
 *
 * ### `_占位` 字段（2026-04-11 CR C-01 修复）
 *
 * 当 AI 违反"每回合必输出 mid_term_memory"约束时（null/空/格式错误），
 * PostProcessStage 会插入一条 `_占位: true` 的占位条目，用于维持和短期记忆
 * 的 1:1 位置配对不变量。占位条目：
 * - 不会被 `filterImplicitByRelevantChars` 注入 prompt
 * - 不会被 `MidTermRefinePipeline` 送给 AI 精炼
 * - 只在结构上占位，确保 `shiftAndPromoteOldest` 升级时不会错配回合
 */
export interface ImplicitMidTermEntry {
  相关角色: string[];
  事件时间: string;
  记忆主体: string;
  /** 2026-04-11 CR C-01: 占位条目标记（AI 未输出本回合时由引擎插入） */
  _占位?: boolean;
}

/** 长期记忆条目 — 由 worldview evolution 汇总产生 */
export interface LongTermEntry {
  /** 唯一标识 */
  id: string;
  /** 类别（如 "世界观进化"、"主角经历"、"故事主线"） */
  category: string;
  /** 记忆内容（通常是 200-500 字的世界观演变总结） */
  content: string;
  /** 创建时间戳 */
  createdAt: number;
}

/** 记忆路径配置 — 由 main.ts 注入（仅路径，容量/阈值是可覆盖的默认值） */
export interface MemoryPathConfig {
  shortTermPath: string;
  midTermPath: string;
  longTermPath: string;
  /** 隐式中期记忆路径（AI 自主标记的重要片段，和短期 1:1 配对） */
  implicitMidTermPath: string;
  /** 语义记忆路径（Engram 扩展数据），可选 */
  semanticMemoryPath?: string;
  /**
   * 短期记忆最大条数 —— 默认值 5（可被 localStorage `aga_memory_settings.shortTermLimit` 覆盖）
   */
  shortTermCapacity: number;
  /**
   * 中期记忆 in-place refine 阈值 —— 默认值 25（可被 `aga_memory_settings.midTermRefineThreshold` 覆盖）
   */
  midTermRefineThreshold: number;
  /**
   * 长期记忆汇总阈值 —— 默认值 50（可被 `aga_memory_settings.longTermSummaryThreshold` 覆盖）
   */
  longTermSummaryThreshold: number;
  /**
   * 2026-04-11 新增：长期汇总时一次性消费的中期条目数上限 —— 默认 50
   * 可被 `aga_memory_settings.longTermSummarizeCount` 覆盖
   */
  longTermSummarizeCount: number;
  /**
   * 2026-04-11 新增：长期汇总后保留的最新中期条目数 —— 默认 0 (消费掉全部参与的)
   * 可被 `aga_memory_settings.midTermKeep` 覆盖
   * 例如设为 10 则长期汇总时保留最新 10 条中期不消费
   */
  midTermKeep: number;
  /**
   * 2026-04-11 新增：长期记忆 FIFO cap —— 默认 30
   * 达到上限时触发**二级精炼**（若 LongTermCompact 管线可用）或 FIFO 丢弃
   * 可被 `aga_memory_settings.longTermCap` 覆盖
   */
  longTermCap: number;
}

/**
 * localStorage 存储的 memory settings 形状（可选覆盖每个字段）
 *
 * 2026-09-04（Context Compiler v1，PO 决议 Q3）：`shortTermInjectionStyle` /
 * `fewShotPairs` 两个键已移除 —— 历史对数改为常量（见
 * `prompt/context-compiler.ts` 的 `STEP2_FEW_SHOT_PAIRS` / `LEGACY_FEW_SHOT_PAIRS` /
 * `SUB_PIPELINE_HISTORY_PAIRS`）。旧备份里残留的这两个键无人读取，无害。
 */
export interface MemorySettingsOverride {
  shortTermLimit?: number;
  midTermRefineThreshold?: number;
  longTermSummaryThreshold?: number;
  longTermSummarizeCount?: number;
  midTermKeep?: number;
  longTermCap?: number;
}

/** localStorage key for user memory settings override */
export const MEMORY_SETTINGS_KEY = 'aga_memory_settings';

export class MemoryManager {
  /** S-01: 短期缓存 effective config（5 秒 TTL，覆盖一个完整回合周期） */
  private _configCache: ReturnType<MemoryManager['getEffectiveConfig']> | null = null;
  private _configCacheTs = 0;
  private static readonly CONFIG_CACHE_TTL = 5000;

  constructor(
    private stateManager: StateManager,
    private pathConfig: MemoryPathConfig,
  ) {}

  /**
   * 读取 localStorage `aga_memory_settings` 的用户覆盖
   *
   * 每次调用都**实时读取**localStorage（不缓存），这样用户在 SettingsPanel 改
   * 阈值后下一回合立即生效，无需重启游戏。read 失败（localStorage 不可用 /
   * JSON 破损）时返回空对象，使用 pathConfig 默认值。
   */
  private readSettingsOverride(): MemorySettingsOverride {
    try {
      const raw = localStorage.getItem(MEMORY_SETTINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as MemorySettingsOverride;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * 获取实时 effective config —— 合并 pathConfig 默认值和 localStorage 覆盖
   *
   * 2026-04-11 CR S-01 修复：加 5 秒 TTL 缓存。一个回合周期内（post-process
   * + orchestrator sub-pipelines）会调用 4-6 次，缓存避免重复 JSON.parse。
   * 5 秒内用户在 SettingsPanel 改配置后，最迟 5 秒生效。
   */
  getEffectiveConfig(): {
    shortTermCapacity: number;
    midTermRefineThreshold: number;
    longTermSummaryThreshold: number;
    longTermSummarizeCount: number;
    midTermKeep: number;
    longTermCap: number;
  } {
    const now = Date.now();
    if (this._configCache && now - this._configCacheTs < MemoryManager.CONFIG_CACHE_TTL) {
      return this._configCache;
    }
    const o = this.readSettingsOverride();
    const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
      return Math.max(min, Math.min(max, Math.floor(v)));
    };
    const result = {
      shortTermCapacity: clamp(o.shortTermLimit, this.pathConfig.shortTermCapacity, 1, 50),
      midTermRefineThreshold: clamp(o.midTermRefineThreshold, this.pathConfig.midTermRefineThreshold, 5, 200),
      longTermSummaryThreshold: clamp(o.longTermSummaryThreshold, this.pathConfig.longTermSummaryThreshold, 10, 500),
      longTermSummarizeCount: clamp(o.longTermSummarizeCount, this.pathConfig.longTermSummarizeCount, 1, 200),
      midTermKeep: clamp(o.midTermKeep, this.pathConfig.midTermKeep, 0, 200),
      longTermCap: clamp(o.longTermCap, this.pathConfig.longTermCap, 5, 200),
    };
    this._configCache = result;
    this._configCacheTs = now;
    return result;
  }

  // ─── 短期记忆 ───

  /** 获取所有短期记忆条目 */
  getShortTermEntries(): ShortTermEntry[] {
    return this.stateManager.get<ShortTermEntry[]>(this.pathConfig.shortTermPath) ?? [];
  }

  /**
   * 追加叙事文本到短期记忆 — IMemoryManager 适配方法
   *
   * PostProcessStage 只拿到 AI 返回的原始文本，
   * 不掌握回合号等结构化信息，此方法自动填充缺失字段。
   */
  appendShortTerm(content: string, round: number): void {
    const entry: ShortTermEntry = {
      round,
      summary: content,
      timestamp: Date.now(),
    };
    this.stateManager.push(this.pathConfig.shortTermPath, entry, 'system');
  }

  /** 追加一条完整的短期记忆（sub-pipeline 使用） */
  pushShortTermEntry(entry: ShortTermEntry): void {
    this.stateManager.push(this.pathConfig.shortTermPath, entry, 'system');
  }

  /** 替换整个短期记忆数组（总结消费后使用） */
  setShortTermEntries(entries: ShortTermEntry[]): void {
    this.stateManager.set(this.pathConfig.shortTermPath, entries, 'system');
  }

  /** 短期记忆是否达到容量上限（溢出后需 shift 最旧 + 升级对应隐式中期） */
  isShortTermFull(): boolean {
    return this.getShortTermEntries().length >= this.getEffectiveConfig().shortTermCapacity;
  }

  /**
   * 2026-04-11 重构：短→中 1:1 shift 升级
   *
   * 当短期记忆条数超过 `shortTermCapacity` 时调用。每次 shift 一对：
   * - 从短期记忆头部 shift 1 条（丢弃）
   * - 从隐式中期记忆头部 shift 1 条 → push 到正式中期记忆数组
   *
   * **不变量（CR C-01）：** 短期和隐式中期数组应始终等长（1:1 位置配对）。
   * PostProcessStage 通过占位插入保证这一点。若断言失败（运行期检测到不
   * 等长），记录警告、emit UI toast、但仍按 `min(overflow, implicit.length)`
   * 降级处理，避免崩溃。**升级中期时跳过 `_占位` 条目**，防止占位污染。
   *
   * 这是**同步非 AI** 操作，在 `PostProcessStage` 每回合末调用。
   *
   * @returns 实际被升级到正式中期记忆的条目数（可能为 0）
   */
  shiftAndPromoteOldest(): number {
    const short = this.getShortTermEntries();
    const cap = this.getEffectiveConfig().shortTermCapacity;
    if (short.length <= cap) return 0;

    // 2026-04-11 CR C-01: 1:1 配对不变量断言
    const implicit = this.getImplicitMidTerm();
    if (implicit.length !== short.length) {
      const msg =
        `[MemoryManager] 1:1 配对不变量被破坏: short=${short.length}, implicit=${implicit.length}. ` +
        `PostProcessStage 占位逻辑应保证等长，请检查 AI 响应解析链路。`;
      logger.warn(msg);
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.memoryPairMismatch',
        i18nParams: { short: short.length, implicit: implicit.length },
        message: `短期/隐式中期记忆配对异常 (${short.length} vs ${implicit.length})，可能丢失回合对齐`,
        duration: 4000,
      });
    }

    const overflow = short.length - cap;
    const newShort = short.slice(overflow); // 保留最近 cap 条
    this.stateManager.set(this.pathConfig.shortTermPath, newShort, 'system');

    // 同步 shift 对应数量的隐式中期 → 升级为正式中期
    const promoteCount = Math.min(overflow, implicit.length);
    if (promoteCount === 0) return 0;

    const toPromote = implicit.slice(0, promoteCount) as ImplicitMidTermEntry[];
    const newImplicit = implicit.slice(promoteCount);
    this.stateManager.set(this.pathConfig.implicitMidTermPath, newImplicit, 'system');

    // 升级：隐式结构 → 正式中期结构（shape 相同，直接 push）
    // 但过滤掉 _占位 条目，避免占位污染正式中期
    const realPromoted = toPromote.filter((e) => !e._占位);
    if (realPromoted.length === 0) return 0;

    const currentMid = this.getMidTermEntries();
    const nextMid = [...currentMid, ...realPromoted];
    this.stateManager.set(this.pathConfig.midTermPath, nextMid, 'system');

    return realPromoted.length;
  }

  // ─── 中期记忆 ───

  /** 获取所有中期记忆条目 */
  getMidTermEntries(): MidTermEntry[] {
    return this.stateManager.get<MidTermEntry[]>(this.pathConfig.midTermPath) ?? [];
  }

  /** 追加一条中期记忆 */
  pushMidTermEntry(entry: MidTermEntry): void {
    this.stateManager.push(this.pathConfig.midTermPath, entry, 'system');
  }

  /** R-04: 清除 getEffectiveConfig 缓存（rollback 后调用，确保不用旧阈值） */
  clearConfigCache(): void {
    this._configCache = null;
  }

  /** 替换整个中期记忆数组 */
  setMidTermEntries(entries: MidTermEntry[]): void {
    this.stateManager.set(this.pathConfig.midTermPath, entries, 'system');
  }

  /**
   * 2026-04-11 CR M-01 修复：worldview evolution 的原子提交
   *
   * MemorySummaryPipeline 需要同时做两件事：
   * 1. 追加一批新生成的长期记忆条目
   * 2. 把被消费的中期条目替换为 "剩余保留" 列表
   *
   * 拆成两次 push/set 调用时，若第一步完成后第二步抛异常，长期已涨但中期未消费，
   * 下一回合会二次消费同一批中期条目，产生重复长期记忆。
   *
   * 本方法：
   * - 先把新长期记忆合并为一个完整数组（内存计算，不写状态）
   * - 然后两次 `stateManager.set` 背靠背执行（同步，无 await 缝隙）
   * - 若第二次 set 抛异常，尝试把长期回滚到调用前的快照，最大程度避免状态撕裂
   *
   * 注意：StateManager.set 是同步 reactive 写入，正常路径下不抛异常。
   * 回滚逻辑是对"极端意外"（例如 schema 校验中间件抛错）的 best-effort 防御。
   */
  commitSummaryResult(
    newLongTerm: LongTermEntry[],
    midTermKeep: MidTermEntry[],
  ): void {
    const snapshotLong = this.getLongTermEntries();
    const nextLong = [...snapshotLong, ...newLongTerm];

    this.stateManager.set(this.pathConfig.longTermPath, nextLong, 'system');
    try {
      this.stateManager.set(this.pathConfig.midTermPath, midTermKeep, 'system');
    } catch (err) {
      // 回滚长期记忆，避免 "长期已涨但中期未消费" 这种半提交状态
      try {
        this.stateManager.set(this.pathConfig.longTermPath, snapshotLong, 'system');
      } catch (rollbackErr) {
        logger.error(
          '[MemoryManager] commitSummaryResult rollback also failed; state may be inconsistent:',
          rollbackErr,
        );
      }
      throw err;
    }
  }

  /** 中期记忆是否达到 **refine 阈值**（需要 in-place 精炼） */
  shouldRefineMidTerm(): boolean {
    return this.getMidTermEntries().length >= this.getEffectiveConfig().midTermRefineThreshold;
  }

  /** 中期记忆是否达到 **长期汇总阈值**（需要 worldview evolution） */
  shouldSummarizeLongTerm(): boolean {
    return this.getMidTermEntries().length >= this.getEffectiveConfig().longTermSummaryThreshold;
  }

  /**
   * 判断中期记忆条目是否已精炼 —— 跳过下次 refine 的标记
   *
   * 已精炼的条目视为 permanent：保留在中期数组中，但 `MidTermRefinePipeline`
   * 不会再把它送给 AI 处理，只处理未精炼的新条目。
   */
  isMidTermEntryRefined(entry: MidTermEntry): boolean {
    return entry.已精炼 === true;
  }

  // ─── 长期记忆 ───
  //
  // 长期记忆是 tier 系统的终点。pushLongTermEntry 时自动 FIFO trim 到
  // `getEffectiveConfig().longTermCap`（默认 30）。
  //
  // 2026-04-11 强化：当长期记忆达到 cap 且新条目被 push 时，**不再直接 FIFO
  // 丢弃最旧的**，而是触发**二级精炼机制**（见 LongTermCompactPipeline / design
  // note "长期记忆二级精炼"）。本类只暴露 `shouldCompactLongTerm()` 判定，具体
  // 触发由 orchestrator 负责。若没有触发到二级精炼，退化为 FIFO 丢弃。

  /** 获取所有长期记忆条目 */
  getLongTermEntries(): LongTermEntry[] {
    return this.stateManager.get<LongTermEntry[]>(this.pathConfig.longTermPath) ?? [];
  }

  /**
   * 追加一条长期记忆
   *
   * 不做 FIFO trim —— 由 orchestrator 的 `LongTermCompactPipeline`（或 fallback
   * FIFO）统一处理溢出。这样：
   * - 允许长期记忆暂时溢出（cap + 1）让 compact 管线有机会介入
   * - 不会在此方法里悄悄丢数据（符合"no silent data loss"原则）
   */
  pushLongTermEntry(entry: LongTermEntry): void {
    this.stateManager.push(this.pathConfig.longTermPath, entry, 'system');
  }

  /** 长期记忆是否达到（或超过）cap —— orchestrator 据此触发 LongTermCompact 或 FIFO */
  /**
   * S-05: 有意使用严格大于 `>`（而非 `>=`），与 shouldRefineMidTerm/shouldSummarizeLongTerm
   * 的 `>=` 不同。原因：long-term compact 是"溢出后再压缩"（cap+1 触发），
   * 而 mid-term refine/summary 是"达到阈值即触发"。这与 LongTermCompactPipeline
   * 的 `overflow = allLong.length - cap` 计算一致——刚好等于 cap 时 overflow=0，无需压缩。
   */
  shouldCompactLongTerm(): boolean {
    return this.getLongTermEntries().length > this.getEffectiveConfig().longTermCap;
  }

  /**
   * 长期记忆 FIFO 兜底裁剪 —— 在 compact 管线失败或不可用时保底
   *
   * 裁剪到 `longTermCap` 条，保留最新的。仅由 orchestrator 调用。
   */
  fallbackTrimLongTerm(): number {
    const existing = this.getLongTermEntries();
    const cap = this.getEffectiveConfig().longTermCap;
    if (existing.length <= cap) return 0;
    const trimmed = existing.slice(existing.length - cap);
    this.stateManager.set(this.pathConfig.longTermPath, trimmed, 'system');
    return existing.length - cap;
  }

  /** 替换整个长期记忆数组 */
  setLongTermEntries(entries: LongTermEntry[]): void {
    this.stateManager.set(this.pathConfig.longTermPath, entries, 'system');
  }

  // ─── 隐式中期记忆 ───
  //
  // 2026-04-11 重构：与短期记忆 **1:1 配对**。
  //
  // 每轮 AI 在 `mid_term_memory` 字段产出一条结构化对象 → append 进来。短期
  // 记忆（纯叙事）和隐式中期记忆（结构化总结）应当**等长**（除非 AI 某些
  // 回合跳过 mid_term_memory）。
  //
  // 旧版本的独立 40-cap + 丢弃最旧策略已废弃 —— 隐式中期不再独立 trim，而是
  // 跟随短期记忆 shift 时**升级为正式中期**（`shiftAndPromoteOldest`）。
  // 因此隐式中期长度通常等于 shortTermCapacity（默认 5）。

  /**
   * 追加一条 AI 自主标记的隐式中期记忆
   *
   * 只做 push，不做 trim —— trim 由 `shiftAndPromoteOldest` 在短期溢出时
   * 统一处理（升级为正式中期）。
   *
   * 2026-04-11：参数类型从 `unknown` 收紧为 `ImplicitMidTermEntry` 或旧格式
   * 的字符串（兼容），内部做格式归一化（`normalizeImplicitEntry`）。
   */
  appendImplicitMidTerm(entry: ImplicitMidTermEntry | string | Record<string, unknown>): void {
    const normalized = this.normalizeImplicitEntry(entry);
    if (!normalized) return;
    this.stateManager.push(this.pathConfig.implicitMidTermPath, normalized, 'system');

    // 2026-04-11 CR C-03: 防御性上限守护
    // 隐式中期应和短期 1:1 配对，正常情况长度 ≤ shortTermCapacity。
    // 若因旧存档迁移 / 手动编辑 / 上游 bug 导致超出 cap + buffer，trim 并告警。
    // 保留最新 N 条（slice from tail），因为最新条目更可能匹配尚存的短期。
    const implicit = this.getImplicitMidTerm();
    const shortCap = this.getEffectiveConfig().shortTermCapacity;
    const threshold = shortCap + 2; // 2 条缓冲（允许短暂超出）
    if (implicit.length > threshold) {
      const keep = implicit.slice(implicit.length - shortCap);
      this.stateManager.set(this.pathConfig.implicitMidTermPath, keep, 'system');
      const msg =
        `[MemoryManager] 隐式中期溢出 (${implicit.length} > ${threshold})，` +
        `已 trim 到 ${keep.length}（保留最新 ${shortCap} 条）`;
      logger.warn(msg);
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.implicitMemoryOverflow',
        i18nParams: { before: implicit.length, after: keep.length },
        message: `隐式中期记忆异常溢出，已自动清理 (${implicit.length} → ${keep.length})`,
        duration: 4500,
      });
    }
  }

  /**
   * 归一化任意形态的隐式中期条目为规范的 ImplicitMidTermEntry
   *
   * 兼容三种形态：
   * 1. 规范对象 `{相关角色, 事件时间, 记忆主体}` — 直接透传
   * 2. 旧格式字符串 —— 包装为 `{相关角色:[], 事件时间:'', 记忆主体:str}`
   * 3. 英文字段旧对象 `{characters, gameTime, content}` — 字段名映射
   */
  private normalizeImplicitEntry(
    entry: ImplicitMidTermEntry | string | Record<string, unknown>,
  ): ImplicitMidTermEntry | null {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) return null;
      return { 相关角色: [], 事件时间: '', 记忆主体: trimmed };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const 记忆主体 =
        (typeof obj['记忆主体'] === 'string' && (obj['记忆主体'] as string)) ||
        (typeof obj['content'] === 'string' && (obj['content'] as string)) ||
        '';
      if (!记忆主体.trim()) return null;
      const 相关角色Raw = obj['相关角色'] ?? obj['characters'];
      const 相关角色 = Array.isArray(相关角色Raw)
        ? 相关角色Raw.filter((v): v is string => typeof v === 'string')
        : [];
      const 事件时间 =
        (typeof obj['事件时间'] === 'string' && (obj['事件时间'] as string)) ||
        (typeof obj['gameTime'] === 'string' && (obj['gameTime'] as string)) ||
        '';
      const out: ImplicitMidTermEntry = { 相关角色, 事件时间, 记忆主体: 记忆主体.trim() };
      if (obj['_占位'] === true) out._占位 = true;
      return out;
    }
    return null;
  }

  /** 获取所有隐式中期记忆条目（已归一化的规范形态） */
  getImplicitMidTerm(): ImplicitMidTermEntry[] {
    const raw = this.stateManager.get<unknown[]>(this.pathConfig.implicitMidTermPath) ?? [];
    const out: ImplicitMidTermEntry[] = [];
    for (const v of raw) {
      const n = this.normalizeImplicitEntry(v as ImplicitMidTermEntry | string | Record<string, unknown>);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * 按"相关角色 ∩ 当前 context"过滤隐式中期记忆
   *
   * 仅返回 `相关角色` 与 `(playerName + recentNpcNames + '玩家')` 有交集
   * 的条目。用于 `MemoryRetriever` 按相关性注入 prompt，避免把无关的隐式
   * 记忆全量 dump 进 MEMORY_BLOCK。
   *
   * 参照 demo `memoryHelpers.ts:filterImplicitMidTermByRelevantCharacters`。
   */
  filterImplicitByRelevantChars(
    playerName: string,
    recentNpcNames: string[],
  ): ImplicitMidTermEntry[] {
    // 2026-04-11 CR C-01: 占位条目（AI 未输出本回合时引擎插入的）一律跳过，
    // 不注入 prompt，避免把 "[占位 · round X]" 文本送给 AI。
    const entries = this.getImplicitMidTerm().filter((e) => !e._占位);
    if (entries.length === 0) return [];

    const relevant = new Set<string>();
    relevant.add('玩家');
    if (playerName && playerName.trim()) relevant.add(playerName.trim());
    for (const n of recentNpcNames) {
      if (n && typeof n === 'string' && n.trim()) relevant.add(n.trim());
    }

    return entries.filter((e) => {
      const chars = e.相关角色 || [];
      // subject 侧：条目里有任意一个角色出现在 relevant 集合
      for (const c of chars) {
        if (c && relevant.has(c)) return true;
      }
      // object 侧：记忆主体文本里直接提到玩家 —— 作为 fallback 宽松匹配
      // S-04: 仅当玩家名 ≥ 2 字符时启用文本 includes，避免单字名（如"云"）
      // 在"云雷"、"云海"等无关文本中误匹配
      if (e.记忆主体 && playerName && playerName.length >= 2 && e.记忆主体.includes(playerName)) return true;
      return false;
    });
  }

  // ─── 查询 ───

  /** 获取记忆路径配置 */
  getPathConfig(): MemoryPathConfig {
    return this.pathConfig;
  }
}
