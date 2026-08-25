/**
 * AI 调用阶段 — 将组装好的消息列表发送给 AI 并解析响应
 *
 * 这是管线中唯一的外部 I/O 阶段（网络请求），也是最耗时的阶段。
 * 职责被刻意保持简单（调用 + 解析），复杂性交给 AIService 和 ResponseParser：
 * - AIService 处理 provider 选择、重试、超时、取消
 * - ResponseParser 处理 JSON 提取、sanitize、字段规范化
 *
 * 为什么不把解析放到下一个阶段：
 * 解析和调用是原子操作 — 如果响应格式错误，应该在同一阶段立即报错，
 * 而不是让无效数据流入 CommandExecutionStage 导致更难定位的错误。
 *
 * 对应 STEP-03B M3.4 AICallStage。
 */
import type { PipelineStage, PipelineContext } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { AIMessage, AIResponse } from '../../ai/types';
import { eventBus } from '../../core/event-bus';
import { emitPromptAssemblyDebug } from '../../core/prompt-debug';

export class AICallStage implements PipelineStage {
  name = 'AICall';

  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const splitStep2Messages = ctx.meta.splitStep2Messages; // typed via PipelineMeta (L-1)

    if (Array.isArray(splitStep2Messages)) {
      return this.executeSplitGen(ctx, splitStep2Messages);
    }
    return this.executeSingleCall(ctx);
  }

  /**
   * 普通单次调用
   * - stream: 由调用方是否提供 onStreamChunk 决定
   * - usageType: 主回合固定为 'main'
   */
  private async executeSingleCall(ctx: PipelineContext): Promise<PipelineContext> {
    // Phase 1 (2026-04-19): capture per-turn timing for narrativeHistory `_metrics`.
    const aiCallStartedAt = performance.now();

    const streamFilter = ctx.onStreamChunk
      ? createJsonTextStreamUnwrapper(ctx.onStreamChunk)
      : null;

    const rawResponse = await this.aiService.generate({
      messages: ctx.messages,
      stream: !!streamFilter,
      usageType: 'main',
      generationId: ctx.generationId,
      onStreamChunk: streamFilter?.onChunk,
      signal: ctx.abortSignal,
    });
    streamFilter?.flush();
    const aiCallDurationMs = performance.now() - aiCallStartedAt;
    const captureThinking = ctx.meta.cotEnabled === true;
    const parsedResponse = this.responseParser.parse(rawResponse, { captureThinking });
    emitDebugPromptResponse('mainRound', ctx.generationId, parsedResponse.thinking, rawResponse);
    return { ...ctx, rawResponse, parsedResponse, aiCallStartedAt, aiCallDurationMs };
  }

  /**
   * 分步生成（两次 API 调用）
   *
   * 第1步：使用 splitGenStep1 flow 的消息（ctx.messages），流式输出正文叙事
   * 第2步：使用 splitGenStep2 flow 的消息 + 第1步响应作为上下文，非流式输出指令/选项/记忆
   * 合并：text 取第1步，commands/actionOptions/midTermMemory/semanticMemory 取第2步
   */
  private async executeSplitGen(
    ctx: PipelineContext,
    step2BaseMessages: AIMessage[],
  ): Promise<PipelineContext> {
    // Phase 1 (2026-04-19): capture end-to-end timing across both step1 + step2 calls.
    // `aiCallDurationMs` = step2 end − step1 start (total wall-clock including parsing
    // between calls). This is what users see as "how long did this round take".
    const aiCallStartedAt = performance.now();
    // ── 第1步：正文（流式，让用户看到逐字输出） ──
    ctx.onProgress?.({ i18nKey: 'engine.progress.aiCallStep1', message: '[AICall:分步第1步]' });

    // splitGenStep1 asks the model to output {"text":"..."} JSON — strip
    // the envelope during streaming so the UI sees clean narrative text.
    const streamFilter = ctx.onStreamChunk
      ? createJsonTextStreamUnwrapper(ctx.onStreamChunk)
      : null;

    const rawStep1 = await this.aiService.generate({
      messages: ctx.messages,
      stream: !!streamFilter,
      usageType: 'main',
      generationId: ctx.generationId + '_step1',
      onStreamChunk: streamFilter?.onChunk,
      signal: ctx.abortSignal,
    });
    streamFilter?.flush();
    const captureThinking = ctx.meta.cotEnabled === true;
    const parsedStep1 = this.responseParser.parse(rawStep1, { captureThinking });
    emitDebugPromptResponse(
      'splitGenMainRoundStep1',
      `${ctx.generationId ?? ''}_step1`,
      parsedStep1.thinking,
      rawStep1,
    );

    // ── 第2步：指令 + 选项 + 记忆（非流式，结果不显示给用户） ──
    ctx.onProgress?.({ i18nKey: 'engine.progress.aiCallStep2', message: '[AICall:分步第2步]' });
    //
    // CR-R12 修复（2026-04-11）：第2步消息必须以 user 结尾（Claude 原生 API 严格要求）。
    // 旧版本直接把 step1 响应作为最后一条 assistant，Claude 会把它当 prefill 继续生成
    // 正文（而非产出结构化数据）。新版本：assistant(step1) → user(指令)，构成
    // 标准的多轮结构，模型从新的 user 指令开始生成第2步的结构化输出。
    //
    // 2026-04-11 (round 2): 加入反截断 + 输出格式铁律 —— 之前的 followup 只是
    // "请按 step2 规范输出..."，没有反截断保护，结果 commands/options 输出半截
    // 被切。现在显式要求完整输出 + 不允许省略 + 直接 JSON 不带解释。
    //
    // Canon Capture (2026-08-25): this followup is the LAST instruction the model reads,
    // and an enumerated "必须全部给出" checklist here overrides the settingCapture system
    // module buried tens of thousands of tokens earlier. Round-62 real-API incident: the
    // checklist named four fields, the model emitted exactly those four, and the player's
    // marked setting produced zero candidates (banner 0/0/0). On tagged rounds the field
    // list MUST include setting_updates; on untagged rounds the text stays byte-identical
    // to the pre-capture version (D6: no prompt delta when the feature is unused).
    const captureActive = ctx.meta.settingCaptureActive === true;
    const STEP2_FOLLOWUP_USER =
      '请基于上面的叙事正文，输出 step2 的结构化数据。要求：\n\n' +
      (captureActive
        ? '1. **完整输出**：commands / action_options / mid_term_memory / knowledge_facts / setting_updates 五个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n'
        : '1. **完整输出**：commands / action_options / mid_term_memory / knowledge_facts 四个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n') +
      '2. **action_options 必须 3-5 个**（按 `actionOptions` 或 `actionOptionsStory` 模块要求的长度），绝不可空数组或只给 1-2 个。\n' +
      '3. **commands 必须完整**：若本回合正文描述了多个状态变化（位置/时间/NPC/物品/体力/技能等），每条都要对应一条 command；不得合并省略。\n' +
      '4. **格式铁律**：直接输出一个合法 JSON 对象 —— 无 ``` 代码围栏、无前后缀文字、无 `<thinking>` 标签。不重复或扩写正文（正文已由 step1 生成）。\n' +
      (captureActive
        ? '5. **setting_updates 绝不可省略**：本回合玩家输入包含设定标记，必须按系统提示词中「设定提取协议」的工作方法，把标记内容吃透并拆解为一条或多条独立设定，输出到 setting_updates 数组（每条含 kind / statement / evidence / anchors / entities）。漏掉该字段等于丢弃玩家明确要求记录的设定。\n'
        : '') +
      '\n现在请输出这个 JSON 对象。';
    // Sprint CoT-3: inject step1's thinking as context for step2 (PRINCIPLES §3.10, §13.7)
    // Step2 OUTPUT still forbids <thinking> (STEP2_FOLLOWUP_USER rule unchanged).
    // This is INPUT context only — CoT reasoning informs better action-option generation.
    const step2ThinkingContext: AIMessage[] = [];
    if (ctx.meta.cotInjectStep2 === true && parsedStep1.thinking) {
      step2ThinkingContext.push({
        role: 'system',
        content: `## Step 1 Reasoning Context (for reference only — do NOT include thinking tags in your output)\n\n${parsedStep1.thinking}`,
      });
    }

    // When thinking was injected as a separate system message, strip it from
    // rawStep1 to avoid sending COT content twice in the step2 request.
    const step1ContentForStep2 = step2ThinkingContext.length > 0
      ? this.responseParser.extractAndSanitize(rawStep1).sanitized
      : rawStep1;

    const step2Messages: AIMessage[] = [
      ...step2BaseMessages,
      ...step2ThinkingContext,
      { role: 'assistant', content: step1ContentForStep2 },
      { role: 'user', content: STEP2_FOLLOWUP_USER },
    ];

    // Emit step2 snapshot HERE (not in context-assembly) — only at this point
    // do we have the fully-constructed message list. Prior code emitted from
    // context-assembly with only `step2BaseMessages` (flow-assembled), which
    // meant the debug panel's step2 snapshot was missing the last 2-3 actual
    // messages (step1 thinking injection / step1 raw / step2 followup user).
    const step2DebugSources: string[] = [
      ...(ctx.meta.splitStep2Sources ?? []),
      ...(step2ThinkingContext.length > 0 ? ['step1_thinking_context'] : []),
      'step1_response',
      'step2_followup',
    ];
    emitPromptAssemblyDebug({
      flow: 'splitGenMainRoundStep2',
      variables: ctx.meta.debugVariables ?? {},
      messages: step2Messages,
      messageSources: step2DebugSources,
      generationId: `${ctx.generationId ?? ''}_step2`,
      roundNumber: ctx.meta.debugRoundNumber,
    });

    const rawStep2 = await this.aiService.generate({
      messages: step2Messages,
      stream: false,
      usageType: 'main',
      generationId: ctx.generationId + '_step2',
      signal: ctx.abortSignal,
    });
    const parsedStep2 = this.responseParser.parse(rawStep2);
    emitDebugPromptResponse(
      'splitGenMainRoundStep2',
      `${ctx.generationId ?? ''}_step2`,
      parsedStep2.thinking,
      rawStep2,
    );

    const aiCallDurationMs = performance.now() - aiCallStartedAt;

    // ── 合并：叙事正文来自第1步，结构化数据来自第2步 ──
    const parsedResponse: AIResponse = {
      text: parsedStep1.text,
      commands: parsedStep2.commands ?? [],
      actionOptions: parsedStep2.actionOptions ?? [],
      midTermMemory: parsedStep2.midTermMemory,
      knowledgeFacts: parsedStep2.knowledgeFacts,
      // Canon Capture: step2 is where the structured fields are produced, so the
      // captured settings ride along with them. This whitelist is hand-written —
      // omitting the field here would silently drop the player's marked settings in
      // split-gen mode only, which is exactly the class of bug this merge causes.
      settingUpdates: parsedStep2.settingUpdates,
      customFields: parsedStep2.customFields,
      thinking: parsedStep1.thinking,
      raw: rawStep1,
    };

    // Phase 1 (2026-04-19): persist step2 raw on ctx.meta so PostProcess can
    // attach it to the narrative entry as `_rawResponseStep2` for the raw viewer.
    return {
      ...ctx,
      rawResponse: rawStep1,
      parsedResponse,
      aiCallStartedAt,
      aiCallDurationMs,
      meta: { ...ctx.meta, rawResponseStep2: rawStep2 },
    };
  }
}

/**
 * Character-level state machine that strips the JSON envelope from streamed
 * AI output. Works for both single-call (`{"text":"...","commands":...}`) and
 * splitGen step1 (`{"text":"..."}`).
 *
 * States: SEEKING → IN_TEXT → (ESCAPE) → DONE / PASSTHROUGH
 *
 * - SEEKING: buffers chars until `{"text":"` prefix is detected
 * - IN_TEXT: emits narrative chars, decodes JSON escapes (\n→newline, \"→")
 * - ESCAPE: just saw `\` inside the text value
 * - DONE: hit the closing `"` of the text value — discards the rest
 * - PASSTHROUGH: prefix not detected after 20 chars — emits everything raw
 */
function createJsonTextStreamUnwrapper(
  onChunk: (chunk: string) => void,
): { onChunk: (chunk: string) => void; flush: () => void } {
  const PREFIX_RE = /^\s*\{\s*"text"\s*:\s*"/;
  const PREFIX_MAX = 20;

  let state: 'seeking' | 'text' | 'escape' | 'done' | 'passthrough' = 'seeking';
  let seekBuf = '';

  return {
    onChunk(chunk: string) {
      if (state === 'done') return;

      if (state === 'passthrough') {
        onChunk(chunk);
        return;
      }

      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        switch (state) {
          case 'seeking':
            seekBuf += ch;
            if (PREFIX_RE.test(seekBuf)) {
              state = 'text';
              seekBuf = '';
            } else if (seekBuf.length > PREFIX_MAX) {
              state = 'passthrough';
              onChunk(seekBuf + chunk.slice(i + 1));
              seekBuf = '';
              return;
            }
            break;

          case 'text':
            if (ch === '\\') {
              state = 'escape';
            } else if (ch === '"') {
              state = 'done';
              return;
            } else {
              onChunk(ch);
            }
            break;

          case 'escape': {
            const ESCAPE_MAP: Record<string, string> = {
              n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/',
            };
            onChunk(ESCAPE_MAP[ch] ?? '\\' + ch);
            state = 'text';
            break;
          }
        }
      }
    },

    flush() {
      if (state === 'seeking' && seekBuf) {
        onChunk(seekBuf);
      }
    },
  };
}

/**
 * Emit a prompt-response event so PromptAssemblyPanel can attach CoT / raw
 * text to the matching snapshot. Fails silently if the event bus isn't
 * listening — this is purely debug instrumentation.
 *
 * generationId convention (2026-04-19):
 *   - single call:  bare `ctx.generationId`
 *   - split step1:  `${ctx.generationId}_step1`
 *   - split step2:  `${ctx.generationId}_step2`
 * ContextAssemblyStage emits snapshots with the same suffix scheme, so each
 * snapshot gets its own response attached and the two CoT streams don't collide.
 */
function emitDebugPromptResponse(
  flow: string,
  generationId: string | undefined,
  thinking: string | undefined,
  rawResponse: string,
): void {
  try {
    eventBus.emit('ui:debug-prompt-response', {
      flow,
      generationId,
      thinking,
      rawResponse,
    });
  } catch {
    /* debug-only, never throw */
  }
}
