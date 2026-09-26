/**
 * BodyPolishStage — post-main-call text refinement (Phase 4, 2026-04-19).
 *
 * Runs AFTER AICallStage and BEFORE ReasoningIngestStage. When enabled via
 * `系统.设置.bodyPolish`, sends the main narrative text to a separate AI call
 * with the polish prompt (DEFAULT_BODY_POLISH_PROMPT + BODY_POLISH_COT,
 * with wuxia content removed per docs §8.1) and replaces `parsedResponse.text`
 * with the polished output.
 *
 * Why a pipeline Stage (not a sub-pipeline like before):
 * The previous `BodyPolishPipeline` ran AFTER the entire pipeline completed,
 * but PostProcessStage had already pushed the ORIGINAL text into
 * narrativeHistory. Polish only mutated `finalCtx.parsedResponse.text` in
 * memory — never reached storage or the UI re-render. Promoting to a stage
 * ensures polish happens before PostProcess persists the round.
 *
 * Design references:
 *   - Ported polish flow: `剥离首尾思考区段` + `提取正文标签内容`
 *   - AGA plan: docs/research/mrjh-migration/06-round-divider-plan.md §8.2
 *
 * Design constraints:
 *   - MUST emit to PromptAssemblyPanel (debug visibility is a user requirement).
 *   - MUST NOT touch `parsedResponse.thinking` / `commands` / `actionOptions` —
 *     polish is cosmetic on text only.
 *   - MUST respect `ctx.abortSignal` so users can cancel mid-polish.
 *   - MUST degrade to original text on any failure (parser error, HTTP error,
 *     extraction failure, result too short). Polish is optional — never a
 *     blocker to delivering the round.
 */
// App doc: docs/user-guide/pages/game-main.md §流式生成状态
import type { PipelineStage, PipelineContext } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { StateManager } from '../../core/state-manager';
import type { AIMessage } from '../../ai/types';
import { DEFAULT_BODY_POLISH_PROMPT } from '../../prompts/body-polish-default';
import { BODY_POLISH_COT } from '../../prompts/body-polish-cot';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { eventBus } from '../../core/event-bus';

/**
 * Extract the polished body from the AI response.
 *
 * Ported from `剥离首尾思考区段` + `提取正文标签内容`.
 *
 * Strategy:
 *   1. Find the LAST `<正文>` open tag (skips any thinking blocks that
 *      might contain the tag as a literal example).
 *   2. Take everything from that open tag to the next `</正文>` (or end of
 *      string if unterminated).
 *   3. Trim leading/trailing whitespace on each line.
 *
 * Returns empty string if no `<正文>` found.
 */
export function extractBodyFromPolishOutput(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const openRe = /<\s*正文\s*>/gi;
  let lastOpen: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(raw)) !== null) {
    lastOpen = m;
  }
  if (!lastOpen || typeof lastOpen.index !== 'number') return '';
  const afterOpen = raw.slice(lastOpen.index + lastOpen[0].length);
  const closeMatch = afterOpen.match(/<\s*\/\s*正文\s*>/i);
  const body = closeMatch ? afterOpen.slice(0, closeMatch.index) : afterOpen;
  // Trim leading/trailing whitespace on each line, then overall.
  return body.replace(/^[\t ]+|[\t ]+$/gm, '').trim();
}

export class BodyPolishStage implements PipelineStage {
  name = 'BodyPolish';

  constructor(
    private aiService: AIService,
    private stateManager: StateManager,
    private promptAssembler: PromptAssembler,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const enabled = this.stateManager.get<boolean>('系统.设置.bodyPolish') === true;
    if (!enabled) return ctx;

    const originalText = ctx.parsedResponse?.text ?? '';
    if (!originalText.trim()) return ctx;

    const polishStartedAt = performance.now();
    ctx.onProgress?.({ i18nKey: 'engine.progress.bodyPolish', message: '[BodyPolish:润色中]' });

    try {
      // Prefer pack / worldbook-overridden prompt content (so users can customize
      // via worldbook entry with `builtinSlotId: 'body_polish'`). Fallback to TS
      // constants when the pack prompt isn't present.
      const overridden = this.promptAssembler.renderSingle('bodyPolish', {});
      const systemContent =
        overridden && overridden.trim().length > 0
          ? overridden
          : `${DEFAULT_BODY_POLISH_PROMPT}\n\n${BODY_POLISH_COT}`;

      // 2026-04-19 env-tags P2: prepend `{{ENVIRONMENT_BLOCK}}` (forwarded
      // from ContextAssemblyStage via ctx.meta) to the user message as a
      // read-only reference. Polish's existing "不改写事实" rule keeps it
      // from mutating weather / festival / env — but seeing the block helps
      // polish avoid contradictions (e.g., rewriting "雨中" → "阳光下" when
      // the ambiguous original left weather unspecified).
      const envBlock = typeof ctx.meta.environmentBlock === 'string'
        ? ctx.meta.environmentBlock.trim()
        : '';
      const userContent = envBlock
        ? `${envBlock}\n（以上为当前环境，仅供润色参考。不得改写、不写入判定修正。）\n\n【待润色正文】\n${originalText}`
        : `【待润色正文】\n${originalText}`;

      const messages: AIMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ];

      const polishGenId = `${ctx.generationId ?? ''}_polish`;

      // Emit BEFORE the network call so users see the request in PromptAssemblyPanel
      // even if the call crashes.
      emitPromptAssemblyDebug({
        flow: 'bodyPolish',
        variables: {},
        messages,
        messageSources: ['builder:bodyPolish_system', 'builder:bodyPolish_user'],
        generationId: polishGenId,
        roundNumber: ctx.roundNumber,
      });

      // Streaming: reuse the main pipeline's streaming flag so polish text
      // progressively replaces the step1 narrative in the UI typing bubble.
      const useStreaming = !!ctx.onStreamChunk;
      let accumulated = '';
      let tagFound = false;
      const raw = await this.aiService.generate({
        messages,
        stream: useStreaming,
        usageType: 'bodyPolish',
        generationId: polishGenId,
        signal: ctx.abortSignal,
        onStreamChunk: useStreaming
          ? (chunk: string) => {
              accumulated += chunk;
              if (!tagFound) {
                tagFound = /<\s*正文\s*>/i.test(accumulated);
                if (!tagFound) return;
              }
              const partial = extractBodyFromPolishOutput(accumulated);
              if (partial) {
                eventBus.emit('ai:polish-chunk', { text: partial });
              }
            }
          : undefined,
      });

      emitPromptResponseDebug({
        flow: 'bodyPolish',
        generationId: polishGenId,
        thinking: extractThinkingFromRaw(raw),
        rawResponse: raw,
      });

      const polished = extractBodyFromPolishOutput(raw);

      // Guard rails — "polishedLogs.length === 0" fallback.
      // If extraction failed OR the result is suspiciously shorter than the input,
      // keep the original — never deliver a truncated polish to the user.
      if (!polished || polished.length < originalText.length * 0.3) {
        console.debug(
          '[BodyPolish] result unusable (len=%d, original=%d); keeping original',
          polished.length,
          originalText.length,
        );
        if (useStreaming) {
          eventBus.emit('ai:polish-chunk', { text: originalText });
        }
        return ctx;
      }

      const polishDurationMs = performance.now() - polishStartedAt;
      const polishApi = this.aiService.getConfigForUsage('bodyPolish');

      return {
        ...ctx,
        parsedResponse: { ...ctx.parsedResponse!, text: polished },
        meta: {
          ...ctx.meta,
          polishApplied: true,
          polishOriginalText: originalText,
          polishModel: polishApi?.model ?? 'unknown',
          polishDurationMs,
          polishManual: false,
        },
      };
    } catch (err) {
      console.debug('[BodyPolish] failed, keeping original text:', err);
      if (ctx.onStreamChunk) {
        eventBus.emit('ai:polish-chunk', { text: originalText });
      }
      return ctx;
    }
  }
}
