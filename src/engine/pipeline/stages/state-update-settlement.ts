import { get } from 'lodash-es';
import type { PipelineContext, PipelineStage, PromptStepMetrics } from '../types';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { AIMessage } from '../../ai/types';
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { RoundStateUpdates } from '../../state-updates/round-state-updates';
import { estimateMessagesTokens, estimateTextTokens } from '../../core/metrics-helpers';
import { emitPromptAssemblyDebug, emitPromptResponseDebug, extractThinkingFromRaw } from '../../core/prompt-debug';

const PLACEHOLDERS = ['PLAYER_NAME', 'ITEMS_JSON', 'BALANCES_JSON', 'NARRATIVE'] as const;

/** The pack owns the wording; this function only fills the frozen values. */
export function renderSettlementInput(template: string, values: Record<typeof PLACEHOLDERS[number], string>): string {
  let result = template;
  for (const key of PLACEHOLDERS) {
    const marker = `{{${key}}}`;
    if (!result.includes(marker)) throw new Error(`Settlement prompt is missing ${marker}`);
    result = result.split(marker).join(values[key]);
  }
  return result.trim();
}

function isStrictSettlementJson(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && Object.hasOwn(value, 'state_updates');
  } catch { return false; }
}

/** Runs only after Step2 repair and optional polish, before any state mutation. */
export class StateUpdateSettlementStage implements PipelineStage {
  name = 'StateUpdateSettlement';
  constructor(private ai: Pick<AIService, 'generate'>, private parser: Pick<ResponseParser, 'parse'>,
    private updates: RoundStateUpdates) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const input = this.updates.settlementInput(ctx);
    if (!input) return ctx;
    ctx.meta.roundOwnership?.guard();
    ctx.meta.plotVectorGuard?.();
    if (ctx.parsedResponse?.parseOk !== true) throw new Error('Step2 结构未修复，未发送独立物品结算请求');
    const narrative = ctx.parsedResponse.text.trim();
    if (!narrative) throw new Error('本回合正文为空，未发送独立物品结算请求');
    const protagonist = get(ctx.stateSnapshot, DEFAULT_ENGINE_PATHS.playerName);
    const userContent = renderSettlementInput(input.template, {
      PLAYER_NAME: typeof protagonist === 'string' ? protagonist : '',
      ITEMS_JSON: JSON.stringify(input.baseline.items),
      BALANCES_JSON: JSON.stringify(input.baseline.balances),
      NARRATIVE: narrative,
    });
    const messages: AIMessage[] = [
      { role: 'system', content: input.protocol },
      { role: 'user', content: userContent },
    ];
    const sources = ['state-update-protocol', 'state-settlement-input'];
    const generationId = `${ctx.generationId ?? ''}_settlement`;
    emitPromptAssemblyDebug({ flow: 'stateSettlement', variables: {}, messages,
      messageSources: sources, generationId, roundNumber: ctx.roundNumber });
    const started = performance.now();
    const raw = await this.ai.generate({ messages, stream: false, usageType: 'main',
      maxTokens: 4096, temperature: 1, singleAttempt: true,
      checkpoint: ctx.meta.plotVectorCheckpoint?.('settlement'), generationId, signal: ctx.abortSignal });
    ctx.meta.roundOwnership?.guard();
    ctx.meta.plotVectorGuard?.();
    emitPromptResponseDebug({ flow: 'stateSettlement', generationId,
      thinking: extractThinkingFromRaw(raw), rawResponse: raw });
    const parsed = this.parser.parse(raw);
    if (!parsed.parseOk || parsed.customFields?.state_updates === undefined)
      throw new Error('独立物品结算未返回可编译的 state_updates；本回合未保存');
    const durationMs = performance.now() - started;
    const metrics: PromptStepMetrics = { inputTokens: estimateMessagesTokens(messages), outputTokens: estimateTextTokens(raw),
      breakdown: messages.map((message, i) => ({ source: sources[i], tokens: estimateMessagesTokens([message]) })) };
    return { ...ctx, aiCallDurationMs: (ctx.aiCallDurationMs ?? 0) + durationMs,
      promptMetrics: ctx.promptMetrics ? { ...ctx.promptMetrics, settlement: metrics } : undefined,
      meta: { ...ctx.meta, stateSettlementUpdates: parsed.customFields.state_updates,
        stateSettlementRaw: raw, stateSettlementStrict: isStrictSettlementJson(raw),
        stateSettlementDurationMs: durationMs } };
  }
}
