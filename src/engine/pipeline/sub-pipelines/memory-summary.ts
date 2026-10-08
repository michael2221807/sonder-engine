/**
 * 长期记忆 worldview evolution 子管线
 *
 * 类名保留 `MemorySummaryPipeline`（避免重命名污染），但它不再做"短期记忆 → 中期记忆"
 * 的总结（那条旧路径已废弃，短期与隐式中期改为 1:1 配对；Changelog: 2026-04-11 记忆重构）：
 *
 * - 触发：中期记忆达到 `longTermSummaryThreshold`（默认 50 条）
 * - 功能：AI 分析旧中期记忆 → 产出"**世界观进化**"长期记忆（1-3 条）
 *   - 世界的宏观变化（局部格局/势力/规则/环境）
 *   - 主角的成长与经历（主线阶段性总结）
 *   - 故事主线的演化走向
 * - 消费逻辑：取最旧 N 条中期记忆送给 AI（N=longTermSummarizeCount，默认 50），
 *   AI 返回长期记忆后从中期数组移除这 N 条
 * - 产生 1-3 条长期记忆（`LongTermEntry`）并 push 到 `记忆.长期`
 *
 * 优先级：比 `MidTermRefinePipeline` (25 阈值) **高** —— orchestrator 应 if-else
 * 二选一，当 mid >= 50 时走本管线，否则才考虑 refine。
 *
 * 对应 design note §"中期记忆逻辑修订 · 长期记忆"：
 * > 从之前的"记忆总结"改为**世界观进化**，需要 ai 根据中期记忆对世界的宏观
 * > 影响，以及对人物成长的改变和影响...生成目前世界的大背景和主角的经历
 * > 以及整个故事的导向。
 */
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type {
  MidTermEntry,
  LongTermEntry,
} from '../../memory/memory-manager';
import type { IMemoryManager, EnginePathConfig } from '../types';
import type { StateManager } from '../../core/state-manager';
import type { GamePack } from '../../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { logger } from '../../core/logger';
import { extractJsonObjectByKey } from '../../ai/json-extract';
import { generateMemoryId } from '../../memory/id-generator';

/** 最大 retry 次数（AI 返回空时重试） */
const MAX_RETRY = 2;

export class MemorySummaryPipeline {
  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private memoryManager: IMemoryManager,
    private gamePack: GamePack,
    /** 2026-04-11 新增：读取游戏状态概要注入 prompt 供 AI 分析 */
    private stateManager?: StateManager,
    /**
     * 通过 EnginePathConfig 读取状态路径，不硬编码 pack 的路径。生产环境总会提供；
     * 未提供时降级到无状态摘要（主要给单测用）。
     */
    private paths?: EnginePathConfig,
  ) {}

  /**
   * 执行 worldview evolution 流水线
   *
   * 2026-04-11 强化：
   * - 消费数量和保留数量从 MemoryManager 的 effective config 读取
   *   （`longTermSummarizeCount` / `midTermKeep`），用户可通过 SettingsPanel 调整
   * - AI 返回空或格式错误时最多 retry MAX_RETRY 次
   * - 保留策略：消费最旧 N 条，可选保留最新 midTermKeep 条
   *
   * 返回 true 表示成功，false 表示执行失败（所有 retry 都失败）。
   */
  async execute(): Promise<boolean> {
    const allMid = this.memoryManager.getMidTermEntries();
    if (allMid.length === 0) return false;

    const cfg = this.memoryManager.getEffectiveConfig();

    // ── 切分 toConsume / toKeep（2026-04-11 CR M-04 修复：澄清 ordering） ──
    //
    // 中期记忆数组的时序约定：
    //   - 数组**头部（index 0）= 最旧**：由 `shiftAndPromoteOldest` 从隐式中期
    //     FIFO 升级上来，最先升级的在最前
    //   - 数组**尾部 = 最新**：每次 shift 都 append 到尾部
    //   - `MidTermRefinePipeline` 是 in-place 精炼，permanent 条目保持在输出前部，
    //     新精炼条目依次 append —— 不改变"头旧尾新"的全局约定
    //
    // 消费策略：
    //   - `toConsume` = 头部（最旧）的 N 条 → 送给 AI 做 worldview evolution
    //   - `toKeep`    = 尾部（最新）的 midTermKeep 条 + eligible 切完后剩下的未消费部分
    //
    // midTermKeep = 0（默认）：消费最旧 longTermSummarizeCount 条，其余继续留在中期
    // midTermKeep > 0：尾部 midTermKeep 条绝对不碰，只从头部 eligible 里挑要消费的
    let toConsume: MidTermEntry[];
    let toKeep: MidTermEntry[];

    if (cfg.midTermKeep > 0 && cfg.midTermKeep < allMid.length) {
      const protectedNewest = allMid.slice(allMid.length - cfg.midTermKeep); // 尾部，绝对保留
      const eligible = allMid.slice(0, allMid.length - cfg.midTermKeep);      // 头部，可消费
      const consumeCount = Math.min(eligible.length, cfg.longTermSummarizeCount);
      toConsume = eligible.slice(0, consumeCount);                           // 头部前 N 条（最旧）
      // toKeep = 未被消费的 eligible 部分（中间段） + 尾部保护段
      toKeep = [...eligible.slice(consumeCount), ...protectedNewest];
    } else {
      const consumeCount = Math.min(allMid.length, cfg.longTermSummarizeCount);
      toConsume = allMid.slice(0, consumeCount);        // 头部（最旧）
      toKeep = allMid.slice(consumeCount);              // 尾部（较新）
    }

    if (toConsume.length === 0) {
      logger.warn('[MemorySummary] No mid-term entries eligible for consumption');
      return false;
    }

    // 尝试 AI 调用 (含 retry) — 2026-04-11 CR M-07 bestResult 模式
    let bestResult: LongTermEntry[] = [];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const attemptResult = await this.summarizeViaAI(toConsume);
        if (attemptResult.length > 0) {
          bestResult = attemptResult;
          break;
        }
        logger.warn(
          `[MemorySummary] Attempt ${attempt + 1}/${MAX_RETRY + 1}: AI returned no entries, retrying...`,
        );
      } catch (err) {
        lastErr = err;
        logger.error(`[MemorySummary] Attempt ${attempt + 1}/${MAX_RETRY + 1} failed:`, err);
      }
    }

    if (bestResult.length === 0) {
      logger.error('[MemorySummary] All retries exhausted, aborting summary', lastErr);
      return false;
    }

    const newLongTermEntries = bestResult;

    // 2026-04-11 CR M-01 修复：原子提交 long-term push + mid-term 消费
    // 旧版本拆成两步调用，若之间抛异常会导致重复消费
    this.memoryManager.commitSummaryResult(newLongTermEntries, toKeep);

    logger.debug(
      `[MemorySummary] worldview evolution: consumed ${toConsume.length} mid-term → ` +
      `${newLongTermEntries.length} long-term entries, kept ${toKeep.length} mid-term`,
    );
    return true;
  }

  /**
   * 调用 AI 进行 worldview evolution
   *
   * 使用 `memorySummary` prompt flow。AI 应返回：
   * ```json
   * { "semantic_memory": { "long_term_memories": [{"category":"...","content":"..."}] } }
   * ```
   */
  private async summarizeViaAI(entries: MidTermEntry[]): Promise<LongTermEntry[]> {
    const flow = this.gamePack.promptFlows['memorySummary'];
    if (!flow) {
      logger.warn('[MemorySummary] No "memorySummary" prompt flow found in Game Pack');
      return [];
    }

    // 编译中期记忆为可读文本
    const midTermText = entries
      .map((e, i) => {
        const roles =
          Array.isArray(e.相关角色) && e.相关角色.length > 0
            ? `【相关角色: ${e.相关角色.join('、')}】`
            : '';
        const time = e.事件时间 && e.事件时间.trim() ? `【${e.事件时间.trim()}】` : '';
        const refinedTag = e.已精炼 ? '[已精炼] ' : '';
        return `${i + 1}. ${refinedTag}${roles}${time}${e.记忆主体 ?? ''}`;
      })
      .join('\n');

    // 编译现有长期记忆为参考（让 AI 去重）
    const existing = this.memoryManager.getLongTermEntries();
    const longTermText = existing
      .map((e) => `- [${e.category}] ${e.content}`)
      .join('\n');

    // 2026-04-11：给 AI 注入当前游戏状态概要（角色 + 位置 + 当前时间等）
    // 让 AI 能理解"汇总之后的世界应该呈现什么样的宏观状态"。与 demo
    // `_extractEssentialDataForSummary` 对齐。
    const gameStateSummary = this.buildGameStateSummary();

    const variables: Record<string, string> = {
      MID_TERM_TO_REFINE: midTermText,
      EXISTING_LONG_TERM: longTermText || '（暂无现有长期记忆）',
      GAME_STATE_SUMMARY: gameStateSummary,
      ENTRY_COUNT: String(entries.length),
    };

    const assembled = this.promptAssembler.assemble(flow, variables);
    const generationId = `memorySummary_${Date.now()}`;

    // G3: PromptAssemblyPanel 可见
    emitPromptAssemblyDebug({
      flow: 'memorySummary',
      variables,
      messages: assembled.messages,
      messageSources: assembled.messageSources,
      generationId,
    });

    const rawResponse = await this.aiService.generate({
      messages: assembled.messages,
      usageType: 'memory_summary',
    });

    emitPromptResponseDebug({
      flow: 'memorySummary',
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    return this.parseLongTermResponse(rawResponse);
  }

  /**
   * 构建当前游戏状态的简短概要 —— 供 worldview evolution AI 参考
   *
   * 只包含：角色名、职业/地位、当前位置、游戏时间、主要世界观说明。
   * 不包含完整状态树（会爆 token）。
   *
   * 2026-04-11 CR M-09 修复：从 EnginePathConfig 读取路径，不再硬编码天命 pack 路径。
   * 未注入 `paths` 时降级返回"状态概要不可用"，避免把 undefined 字段塞进 prompt。
   */
  private buildGameStateSummary(): string {
    if (!this.stateManager || !this.paths) return '（状态概要不可用）';

    const lines: string[] = [];
    const name = this.stateManager.get<string>(this.paths.playerName);
    if (name) lines.push(`- 角色：${name}`);
    const status = this.stateManager.get<string>(this.paths.characterOccupation);
    if (status) lines.push(`- 地位：${status}`);
    const loc = this.stateManager.get<string>(this.paths.playerLocation);
    if (loc) lines.push(`- 当前位置：${loc}`);

    const time = this.stateManager.get<{
      年?: number; 月?: number; 日?: number; 小时?: number; 分钟?: number;
    }>(this.paths.gameTime);
    if (time && typeof time === 'object') {
      const { 年 = 0, 月 = 0, 日 = 0, 小时, 分钟 } = time;
      let timeStr = `${年}年${月}月${日}日`;
      if (typeof 小时 === 'number' && typeof 分钟 === 'number') {
        timeStr += ` ${String(小时).padStart(2, '0')}:${String(分钟).padStart(2, '0')}`;
      }
      lines.push(`- 游戏时间：${timeStr}`);
    }

    const worldDesc = this.stateManager.get<string>(this.paths.worldDescription);
    if (worldDesc && typeof worldDesc === 'string' && worldDesc.trim()) {
      const short = worldDesc.length > 200 ? worldDesc.slice(0, 200) + '...' : worldDesc;
      lines.push(`- 世界观：${short}`);
    }

    return lines.length > 0 ? lines.join('\n') : '（暂无状态概要）';
  }

  /**
   * 解析 AI 返回的 `semantic_memory.long_term_memories` 数组 → LongTermEntry[]
   */
  private parseLongTermResponse(rawResponse: string): LongTermEntry[] {
    const parsed = this.responseParser.parse(rawResponse);

    // 优先从 ResponseParser 解析出的 semanticMemory 里拿
    const semanticMem = parsed.semanticMemory as Record<string, unknown> | undefined;
    const memories = semanticMem?.long_term_memories;

    const items: unknown[] = Array.isArray(memories) ? memories : [];

    // 若主路径没拿到，用 extractJsonObjectByKey 做 fallback
    // (2026-04-11 CR M-08 修复：替换贪婪 regex，支持 markdown 栅栏剥离 + 平衡扫描)
    if (items.length === 0) {
      const extracted = extractJsonObjectByKey(rawResponse, 'long_term_memories');
      if (extracted) {
        const sem = extracted['semantic_memory'] as { long_term_memories?: unknown } | undefined;
        const arr = (sem?.long_term_memories ?? extracted['long_term_memories']) as unknown;
        if (Array.isArray(arr)) items.push(...arr);
      }
    }

    if (items.length === 0) {
      // S-08: 不再把 AI 原始 text 包装为长期记忆。
      // 旧版本在此做 last-resort fallback（把 text 包成 category=综合 的长期条目），
      // 但若 AI 响应包含错误提示（rate limit / 拒绝回复 / 无法理解），错误文本会
      // 永久进入长期记忆，污染后续所有 AI 调用上下文。
      // 现在返回空数组，由 execute() 返回 false 让 orchestrator 跳过本次汇总，
      // 中期记忆不消费，下一回合再尝试。
      if (parsed.text) {
        logger.warn('[MemorySummary] AI 响应无法提取结构化长期记忆，放弃本次汇总（不污染长期）');
      }
      return [];
    }

    const out: LongTermEntry[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const content = typeof o['content'] === 'string' ? (o['content'] as string).trim() : '';
      if (!content) continue;
      const category = typeof o['category'] === 'string' ? (o['category'] as string) : '综合';
      out.push({
        id: generateMemoryId('lt'),
        category,
        content,
        createdAt: Date.now(),
      });
    }
    return out;
  }
}
