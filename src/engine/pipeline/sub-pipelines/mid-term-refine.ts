/**
 * 中期记忆 in-place 精炼子管线
 *
 * 触发时机：
 * 中期记忆条目数达到 `midTermRefineThreshold`（默认 25）时，由
 * `game-orchestrator.runPostRoundSubPipelines` 触发（if-else 二选一，优先级
 * 低于长期汇总 `longTermSummaryThreshold=50`）。
 *
 * 精炼语义（参照 demo `AIBidirectionalSystem.triggerMidTermRefine` + design note；
 * 旧的"消费到长期记忆"路径已废弃，Changelog: 2026-04-11 记忆重构）：
 *   1. **分离已精炼和未精炼条目**：已精炼的 permanent 条目不送 AI
 *   2. **AI 调用**只处理未精炼的新条目 —— 去重合并、不删减记忆点
 *   3. AI 返回 `refined` 数组，全部标记为 `已精炼: true`
 *   4. **新中期记忆** = [原已精炼条目] + [AI 新精炼的条目]
 *   5. 下次精炼触发时，已精炼条目再次被跳过（permanent 语义）
 *
 * 这样做的好处：
 * - 稳定的 token 预算：permanent 条目只参与首次精炼，之后不再消耗 AI 调用
 * - 增量处理：每次只精炼新增的条目，AI 压力小
 * - 保留所有记忆点：demo 的 design note 强调"不删减"
 *
 * 对应 design note §"中期记忆逻辑修订"。
 */
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { MidTermEntry } from '../../memory/memory-manager';
import type { IMemoryManager } from '../types';
import { extractJsonObjectByKey } from '../../ai/json-extract';
import type { GamePack } from '../../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { logger } from '../../core/logger';

/** 最大 retry 次数（Feature D 完整性） */
const MAX_RETRY = 2;

export class MidTermRefinePipeline {
  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private memoryManager: IMemoryManager,
    private gamePack: GamePack,
  ) {}

  /**
   * 执行精炼流水线
   *
   * 2026-04-11 强化（Feature D）：AI 返回空或报错时最多 retry MAX_RETRY 次。
   * 质量 sanity check：若输出条目数 > 输入条目数（refine 应减少不增加），
   * warn 但不拦截（降级优于崩溃）。
   *
   * @returns true 精炼成功或 no-op，false 执行失败（所有 retry 用尽）
   */
  async execute(): Promise<boolean> {
    const allEntries = this.memoryManager.getMidTermEntries();
    if (allEntries.length === 0) return false;

    // 分离已精炼和未精炼
    const refinedPermanent: MidTermEntry[] = [];
    const unrefined: MidTermEntry[] = [];
    for (const e of allEntries) {
      if (this.memoryManager.isMidTermEntryRefined(e)) {
        refinedPermanent.push(e);
      } else {
        unrefined.push(e);
      }
    }

    // 没有未精炼的条目 → no-op（阈值又被触达但全部是 permanent）
    if (unrefined.length === 0) {
      logger.debug(
        `[MidTermRefine] All ${allEntries.length} entries are permanent (已精炼). Skipping.`,
      );
      return true;
    }

    // bestResult 模式：只在得到非空结果时更新，重试中的异常或退化结果永不覆盖已有的好结果。
    let bestResult: MidTermEntry[] = [];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const attemptResult = await this.refineViaAI(unrefined);
        if (attemptResult.length > 0) {
          bestResult = attemptResult;
          break;
        }
        logger.warn(
          `[MidTermRefine] Attempt ${attempt + 1}/${MAX_RETRY + 1}: AI returned no entries`,
        );
      } catch (err) {
        lastErr = err;
        logger.error(`[MidTermRefine] Attempt ${attempt + 1}/${MAX_RETRY + 1} failed:`, err);
      }
    }

    if (bestResult.length === 0) {
      logger.error('[MidTermRefine] All retries exhausted, keeping original mid-term', lastErr);
      return false;
    }

    const newlyRefined = bestResult;

    // 2026-04-11 CR M-02 修复：硬截断精炼膨胀
    // 精炼的语义是"去重合并"，输出数必须 ≤ 输入数。若 AI 违反契约返回更多条目，
    // 旧版本只 warn 不截断，会让中期记忆净增长，快速触达 longTermSummaryThreshold，
    // 形成 AI 调用风暴。现在强制截断到 unrefined.length，保留前 N 条。
    let finalRefined = newlyRefined;
    if (newlyRefined.length > unrefined.length) {
      logger.warn(
        `[MidTermRefine] AI 返回 ${newlyRefined.length} 条 > 输入 ${unrefined.length} 条 — ` +
        `违反"去重合并"契约，强制截断到前 ${unrefined.length} 条`,
      );
      finalRefined = newlyRefined.slice(0, unrefined.length);
    }

    // 新中期记忆 = permanent 条目 + 新精炼条目（全部标 已精炼）
    const nextMidTerm: MidTermEntry[] = [
      ...refinedPermanent,
      ...finalRefined.map((e) => ({ ...e, 已精炼: true as const })),
    ];
    this.memoryManager.setMidTermEntries(nextMidTerm);

    logger.debug(
      `[MidTermRefine] ${unrefined.length} unrefined → ${newlyRefined.length} refined ` +
      `(kept ${refinedPermanent.length} permanent, total ${nextMidTerm.length})`,
    );
    return true;
  }

  /**
   * 调用 AI 进行 in-place 精炼
   *
   * 使用 `midTermRefine` prompt flow。AI 应返回 `{"refined": [{相关角色, 事件时间, 记忆主体}, ...]}`。
   * 返回的条目将被标记为 `已精炼: true`（在 execute() 里设置）。
   */
  private async refineViaAI(entries: MidTermEntry[]): Promise<MidTermEntry[]> {
    const flow = this.gamePack.promptFlows['midTermRefine'];
    if (!flow) {
      logger.warn('[MidTermRefine] No "midTermRefine" prompt flow found in Game Pack');
      return [];
    }

    // 序列化中期记忆为可读文本（对齐 demo formatMidTermEntryForPrompt）
    const memoriesText = entries
      .map((e, i) => {
        const roles =
          Array.isArray(e.相关角色) && e.相关角色.length > 0
            ? `【相关角色: ${e.相关角色.join('、')}】`
            : '';
        const time = e.事件时间 && e.事件时间.trim() ? `【事件时间: ${e.事件时间.trim()}】` : '';
        const body = e.记忆主体 ?? '';
        return `${i + 1}. ${roles}${time}${body}`;
      })
      .join('\n');

    const variables: Record<string, string> = {
      MID_TERM_TO_REFINE: memoriesText,
      ENTRY_COUNT: String(entries.length),
    };

    const assembled = this.promptAssembler.assemble(flow, variables);
    const generationId = `midTermRefine_${Date.now()}`;

    // G3: 让 PromptAssemblyPanel 可见
    emitPromptAssemblyDebug({
      flow: 'midTermRefine',
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
      flow: 'midTermRefine',
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    return this.parseRefineResponse(rawResponse);
  }

  /**
   * 解析 AI 精炼响应 — 提取 `refined` 数组
   *
   * 期望格式：
   * ```json
   * {"refined": [{"相关角色": [...], "事件时间": "...", "记忆主体": "..."}]}
   * ```
   */
  private parseRefineResponse(rawResponse: string): MidTermEntry[] {
    const parsed = this.responseParser.parse(rawResponse);

    // 2026-04-11 CR M-08 修复：用 extractJsonObjectByKey 替换贪婪 regex
    // 新版本：先剥离 markdown 代码栅栏，再用括号平衡扫描找出所有顶层 {...} 块，
    // 返回第一个包含 "refined" key 的有效对象。
    const extracted = extractJsonObjectByKey(rawResponse, 'refined');
    if (!extracted) {
      logger.warn('[MidTermRefine] Response does not contain parseable "refined" field');
      return this.fallbackToText(parsed.text);
    }

    const refinedRaw = extracted['refined'];
    if (!Array.isArray(refinedRaw)) {
      return this.fallbackToText(parsed.text);
    }

    // 规范化每条条目
    const out: MidTermEntry[] = [];
    for (const item of refinedRaw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const body = typeof o['记忆主体'] === 'string' ? (o['记忆主体'] as string).trim() : '';
      if (!body) continue;
      const 相关角色Raw = o['相关角色'];
      const 相关角色 = Array.isArray(相关角色Raw)
        ? 相关角色Raw.filter((v): v is string => typeof v === 'string')
        : [];
      const 事件时间 = typeof o['事件时间'] === 'string' ? (o['事件时间'] as string) : '';
      out.push({ 相关角色, 事件时间, 记忆主体: body });
    }
    return out;
  }

  /** AI 响应格式错误时的降级：把整段文本包装为单条记忆 */
  /** S-03: 按句子边界截断（500 字符），避免截断中文代理对和语义不完整 */
  private fallbackToText(text: string): MidTermEntry[] {
    if (!text || typeof text !== 'string' || !text.trim()) return [];
    let t = text.trim();
    if (t.length > 500) {
      const sentenceEnd = t.lastIndexOf('。', 500);
      const newlineEnd = t.lastIndexOf('\n', 500);
      const cutAt = Math.max(sentenceEnd, newlineEnd);
      t = cutAt > 100 ? t.slice(0, cutAt + 1) : t.slice(0, 500) + '…';
    }
    return [
      { 相关角色: ['玩家'], 事件时间: '', 记忆主体: t },
    ];
  }
}
