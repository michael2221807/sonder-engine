/**
 * 长期记忆二级精炼子管线 — 2026-04-11 新增
 *
 * 触发时机：
 * 长期记忆条目数超过 `longTermCap`（默认 30）时，由 `game-orchestrator` 在
 * post-round sub-pipelines 末尾检测并触发。
 *
 * 精炼语义（二级精炼，"长期 → 主题存档"）：
 *
 * - 输入：最旧的 N 条长期记忆（N = 溢出量 + 一个压缩窗口，典型 5-10 条）
 * - 调用：`longTermCompact` prompt flow（memory_summary usageType）
 * - 输出：1-2 条 "主题存档" 级别的高度抽象条目，替代输入的 N 条
 * - 目的：释放长期记忆空间，同时保留信息要点
 *
 * 与 MidTermRefinePipeline 的区别：
 * - MidTermRefine 是"去重合并"（相同主题合并）
 * - LongTermCompact 是"抽象到更高层"（多主题融合为主题弧光）
 *
 * Fallback：若 AI 调用失败或返回空，orchestrator 会退化到 FIFO 丢弃
 * （`memoryManager.fallbackTrimLongTerm()`），确保长期记忆不会无限增长。
 *
 * 对应 design note §"中期记忆逻辑修订 · 长期记忆"以及 2026-04-11 新增的
 * "未实现 → 已实现"列表中的 "Feature B"。
 */
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { LongTermEntry } from '../../memory/memory-manager';
import type { IMemoryManager } from '../types';
import type { GamePack } from '../../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { logger } from '../../core/logger';
import { extractJsonObjectByKey } from '../../ai/json-extract';
import { generateMemoryId } from '../../memory/id-generator';

/** 超过 cap 时精炼"最旧的 N 条" —— N = 溢出量 + WINDOW_EXTRA */
const WINDOW_EXTRA = 5;

/**
 * 2026-04-11 CR M-03 修复：单次压缩窗口硬上限
 *
 * 防止旧存档迁移 / 极端 cap 配置（例如 cap=0）时，windowSize 跟着 overflow
 * 一起膨胀，把整个长期记忆数组一次性丢给 AI。
 *
 * 超过此上限时，单次调用只压缩最旧的 MAX_COMPACT_WINDOW 条，剩余的下一回合再来。
 */
const MAX_COMPACT_WINDOW = 15;

/** 最大 retry 次数 */
const MAX_RETRY = 2;

export class LongTermCompactPipeline {
  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private memoryManager: IMemoryManager,
    private gamePack: GamePack,
  ) {}

  /**
   * 执行二级精炼
   *
   * @returns true 成功精炼，false 失败 / 跳过（调用方应 fallback）
   */
  async execute(): Promise<boolean> {
    const allLong = this.memoryManager.getLongTermEntries();
    const cap = this.memoryManager.getEffectiveConfig().longTermCap;

    if (allLong.length <= cap) return false; // 不应该到这里，但安全检查

    // 计算压缩窗口：溢出量 + WINDOW_EXTRA
    // 典型：cap=30，实际 32 条 → 溢出 2 → 窗口 7 → 精炼最旧 7 条为 1-2 条
    //
    // 硬上限 MAX_COMPACT_WINDOW：单次最多压缩 15 条，剩余下一回合再来，
    // 避免一次送入几十条导致 AI token 超限。
    const overflow = allLong.length - cap;
    const windowSize = Math.min(
      overflow + WINDOW_EXTRA,
      MAX_COMPACT_WINDOW,
      allLong.length,
    );
    const toCompact = allLong.slice(0, windowSize);
    const toKeep = allLong.slice(windowSize);

    if (toCompact.length === 0) return false;

    // 防御断言：单次压缩绝不能吞掉全量长期记忆（toKeep 必须非空，除非原数组本来就极少）
    if (toKeep.length === 0 && allLong.length > MAX_COMPACT_WINDOW) {
      logger.error(
        `[LongTermCompact] assertion failed: toKeep empty with allLong=${allLong.length}. Aborting.`,
      );
      return false;
    }

    // 尝试 AI 调用 (含 retry) — 2026-04-11 CR M-07 bestResult 模式
    let bestResult: LongTermEntry[] = [];
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const attemptResult = await this.compactViaAI(toCompact, toKeep);
        if (attemptResult.length > 0) {
          bestResult = attemptResult;
          break;
        }
        logger.warn(
          `[LongTermCompact] Attempt ${attempt + 1}/${MAX_RETRY + 1}: AI returned no entries`,
        );
      } catch (err) {
        logger.error(`[LongTermCompact] Attempt ${attempt + 1} failed:`, err);
      }
    }

    if (bestResult.length === 0) {
      logger.warn('[LongTermCompact] All retries failed');
      return false;
    }

    const compacted = bestResult;

    // 新长期记忆 = 新压缩条目 (插在最前，因为它们替代的是最旧的) + 保留的
    const nextLong = [...compacted, ...toKeep];
    this.memoryManager.setLongTermEntries(nextLong);

    logger.debug(
      `[LongTermCompact] compacted ${toCompact.length} oldest long-term → ` +
      `${compacted.length} theme archives (total ${nextLong.length} / cap ${cap})`,
    );
    return true;
  }

  /**
   * 调用 AI 进行长期记忆二级精炼
   *
   * 使用 `longTermCompact` prompt flow。AI 应返回：
   * ```json
   * { "semantic_memory": { "long_term_memories": [{"category":"...","content":"..."}] } }
   * ```
   */
  private async compactViaAI(
    toCompact: LongTermEntry[],
    kept: LongTermEntry[],
  ): Promise<LongTermEntry[]> {
    const flow = this.gamePack.promptFlows['longTermCompact'];
    if (!flow) {
      logger.warn('[LongTermCompact] No "longTermCompact" prompt flow found');
      return [];
    }

    const formatted = toCompact
      .map((e, i) => `${i + 1}. [${e.category}] ${e.content}`)
      .join('\n\n');

    const keptFormatted = kept.length > 0
      ? kept.map((e) => `- [${e.category}] ${e.content.slice(0, 150)}${e.content.length > 150 ? '...' : ''}`).join('\n')
      : '（无）';

    const variables: Record<string, string> = {
      LONG_TERM_TO_COMPACT: formatted,
      LONG_TERM_KEPT: keptFormatted,
      ENTRY_COUNT: String(toCompact.length),
    };

    const assembled = this.promptAssembler.assemble(flow, variables);
    const generationId = `longTermCompact_${Date.now()}`;

    emitPromptAssemblyDebug({
      flow: 'longTermCompact',
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
      flow: 'longTermCompact',
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    return this.parseResponse(rawResponse);
  }

  private parseResponse(rawResponse: string): LongTermEntry[] {
    const parsed = this.responseParser.parse(rawResponse);

    const semanticMem = parsed.semanticMemory as Record<string, unknown> | undefined;
    const memories = semanticMem?.long_term_memories;
    const items: unknown[] = Array.isArray(memories) ? memories : [];

    if (items.length === 0) {
      // 2026-04-11 CR M-08 修复：用 extractJsonObjectByKey 替换贪婪 regex
      const extracted = extractJsonObjectByKey(rawResponse, 'long_term_memories');
      if (extracted) {
        const sem = extracted['semantic_memory'] as { long_term_memories?: unknown } | undefined;
        const arr = (sem?.long_term_memories ?? extracted['long_term_memories']) as unknown;
        if (Array.isArray(arr)) items.push(...arr);
      }
    }

    if (items.length === 0) {
      // S-08: 不再把 AI 原始 text 包装为主题存档。错误文本可能永久污染长期记忆。
      // 返回空数组让 execute() 返回 false，触发 orchestrator 的 FIFO fallback。
      if (parsed.text) {
        logger.warn('[LongTermCompact] AI 响应无法提取结构化长期记忆，放弃本次压缩');
      }
      return [];
    }

    const out: LongTermEntry[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const content = typeof o['content'] === 'string' ? (o['content'] as string).trim() : '';
      if (!content) continue;
      const category = typeof o['category'] === 'string' ? (o['category'] as string) : '主题存档';
      out.push({
        id: generateMemoryId('lt_archive'),
        category,
        content,
        createdAt: Date.now(),
      });
    }
    return out;
  }
}
