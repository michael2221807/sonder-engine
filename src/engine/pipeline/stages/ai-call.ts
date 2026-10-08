// App doc: docs/user-guide/pages/game-main.md §3.5（指标药丸 · 分步两次调用合计计量）
/**
 * AI 调用阶段 — 将组装好的消息列表发送给 AI 并解析响应
 *
 * 这是发出主叙事 AI 请求的阶段，也是最耗时的阶段（ResponseRepair、BodyPolish
 * 等阶段需要时也会各自调用 AI）。除了调用 + 解析，本文件还包含流式接收和分步生成
 * 的状态机；provider 细节和 JSON 解析细节交给 AIService 和 ResponseParser：
 * - AIService 处理 provider 选择、重试、超时、取消
 * - ResponseParser 处理 JSON 提取、sanitize、字段规范化
 *
 * 为什么不把解析放到下一个阶段：
 * 解析和调用是原子操作 — 如果响应格式错误，应该在同一阶段立即报错，
 * 而不是让无效数据流入 CommandExecutionStage 导致更难定位的错误。
 *
 * 对应 STEP-03B M3.4 AICallStage。
 */
import type { PipelineStage, PipelineContext, PromptMetrics, PromptStepMetrics } from '../types';
import type { AIService } from '../../ai/ai-service';
import { COT_BLOCKS, COT_PSEUDO_TAGS, ENVELOPE_KEY_HEAD, RESIDUAL_ESCAPES, THINKING_TAGS, type ResponseParser } from '../../ai/response-parser';
import type { AIMessage, AIResponse } from '../../ai/types';
import { eventBus } from '../../core/event-bus';
import { emitPromptAssemblyDebug } from '../../core/prompt-debug';
import { buildStep2FollowupUser } from '../../prompt/step2-followup';
import { estimateMessagesTokens, estimateTextTokens } from '../../core/metrics-helpers';

export class AICallStage implements PipelineStage {
  name = 'AICall';

  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const splitStep2Messages = ctx.meta.splitStep2Messages; // typed via PipelineMeta (L-1)
    // ContextAssembly precedes the optional component. Publish the actual request,
    // including its mode contract and numerical impulse, at the send boundary.
    if (ctx.meta.plotVectorPromptMode) {
      ctx.meta.plotVectorGuard?.();
      const split = Array.isArray(splitStep2Messages);
      emitPromptAssemblyDebug({ flow: split ? 'splitGenMainRoundStep1' : 'mainRound',
        variables: ctx.meta.debugVariables ?? {}, messages: ctx.messages, messageSources: ctx.messageSources,
        generationId: split ? `${ctx.generationId ?? ''}_step1` : ctx.generationId,
        roundNumber: ctx.meta.debugRoundNumber, compileTrace: ctx.meta.compileTrace });
    }

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

    ctx.meta.plotVectorGuard?.();
    ctx.meta.roundOwnership?.guard();
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
    const parsedResponse = this.responseParser.parse(rawResponse, { captureThinking, sidecars: ctx.meta.responseSidecars });
    emitDebugPromptResponse('mainRound', ctx.generationId, parsedResponse.thinking, rawResponse);
    const promptMetrics: PromptMetrics = {
      step1: buildStepMetrics(ctx.messages, ctx.messageSources, rawResponse),
    };
    return { ...ctx, rawResponse, parsedResponse, aiCallStartedAt, aiCallDurationMs, promptMetrics };
  }

  /**
   * 分步生成（两次 API 调用）
   *
   * 第1步：使用 splitGenStep1 flow 的消息（ctx.messages），流式输出正文叙事
   * 第2步：使用 splitGenStep2 flow 的消息 + 第1步响应作为上下文，非流式输出指令/选项/记忆
   * 合并：text 取第1步，commands/actionOptions/midTermMemory 取第2步
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

    ctx.meta.plotVectorGuard?.();
    ctx.meta.roundOwnership?.guard();
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
    // 第2步消息必须以 user 结尾（Claude 原生 API 严格要求）：step1 响应作为 assistant
    // 放在最后会被当 prefill 继续写正文。所以是 assistant(step1) → user(指令)。
    // 指令里显式要求完整输出、不省略、直接 JSON，防止 commands/options 被截断。
    //
    // 这条 followup 是模型读到的最后一条指令，它列出的必填字段会压过更早的 settingCapture
    // 系统模块：带标记的回合，字段清单必须包含 setting_updates；没有标记的回合，文本与
    // 引入该功能之前逐字相同（无 prompt 差异）。
    // Changelog: 2026-04-11 CR-R12 / 反截断，2026-08-25 round-62 设定捕获。
    const captureActive = ctx.meta.settingCaptureActive === true;
    // The player's action-options switch (PO 2026-10-03): off, the last instruction the model reads must not ask
    // for them. On, the text is byte-identical to before.
    const optionsOff = ctx.meta.actionOptionsEnabled === false;
    const STEP2_FOLLOWUP_USER = buildStep2FollowupUser({ captureActive, optionsOff });
    // Sprint CoT-3: inject step1's thinking as context for step2 (PRINCIPLES §3.10, §13.7)
    // Step2 OUTPUT still forbids <thinking> (STEP2_FOLLOWUP_USER rule unchanged).
    // This is INPUT context only — CoT reasoning informs better action-option generation.
    const step2ThinkingContext: AIMessage[] = [];
    // In impulse mode Step 2 derives state from the accepted narrative, not
    // Step 1's tentative variable plan. Keep thinking in the raw/debug/save path.
    const narrativeOnly = ctx.meta.plotVectorPromptMode === true;
    if (!narrativeOnly && ctx.meta.cotInjectStep2 === true && parsedStep1.thinking) {
      step2ThinkingContext.push({
        role: 'system',
        content: `## Step 1 Reasoning Context (for reference only — do NOT include thinking tags in your output)\n\n${parsedStep1.thinking}`,
      });
    }

    // When thinking was injected as a separate system message, strip it from
    // rawStep1 to avoid sending COT content twice in the step2 request.
    const step1ContentForStep2 = narrativeOnly
      ? JSON.stringify({ text: parsedStep1.text })
      : step2ThinkingContext.length > 0
      ? this.responseParser.extractAndSanitize(rawStep1).sanitized
      : rawStep1;

    const step2Messages: AIMessage[] = [
      ...step2BaseMessages,
      ...step2ThinkingContext,
      { role: 'assistant', content: step1ContentForStep2 },
      { role: 'user', content: ctx.meta.splitStep2Followup ?? STEP2_FOLLOWUP_USER },
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
      // Context Compiler v1: what was projected / stripped from THIS call and why.
      compileTrace: ctx.meta.compileTrace,
    });

    ctx.meta.plotVectorGuard?.();
    ctx.meta.roundOwnership?.guard();
    const rawStep2 = await this.aiService.generate({
      messages: step2Messages,
      stream: false,
      usageType: 'main',
      generationId: ctx.generationId + '_step2',
      signal: ctx.abortSignal,
    });
    const parsedStep2 = this.responseParser.parse(rawStep2, { sidecars: ctx.meta.responseSidecars });
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
      // A feature's block appended after step2's JSON (lifted out before parsing).
      ...(parsedStep2.sidecars ? { sidecars: parsedStep2.sidecars } : {}),
      thinking: parsedStep1.thinking,
      raw: rawStep1,
      // The structured fields all come from step2, so step2's parse verdict is the
      // round's verdict. Round-62 incident (2026-08-25): this was omitted, the merged
      // response carried parseOk: undefined, and ResponseRepairStage's `parseOk !==
      // false` guard treated a shattered step2 JSON as healthy — commands, memory AND
      // the player's marked settings were silently dropped with no repair attempt.
      parseOk: parsedStep2.parseOk,
    };

    // Phase 1 (2026-04-19): persist step2 raw on ctx.meta so PostProcess can
    // attach it to the narrative entry as `_rawResponseStep2` for the raw viewer.
    // R1 prompt ledger P0 (2026-09-03): meter BOTH calls. step2 was ~1.6× step1 on real
    // saves and had never been recorded — `_metrics.inputTokens` only saw `ctx.messages`.
    const promptMetrics: PromptMetrics = {
      step1: buildStepMetrics(ctx.messages, ctx.messageSources, rawStep1),
      step2: buildStepMetrics(step2Messages, step2DebugSources, rawStep2),
    };
    return {
      ...ctx,
      rawResponse: rawStep1,
      parsedResponse,
      aiCallStartedAt,
      aiCallDurationMs,
      promptMetrics,
      meta: { ...ctx.meta, rawResponseStep2: rawStep2 },
    };
  }
}

/** A `<` held longer than this (the longest tag below, spaces and all) was the story's own. */
const COT_TAG_MAX = 16;
/** The CoT pseudo-tags and the thinking tags, the ones the parser knows (response-parser). */
const COT_TAG = new RegExp(`^<\\s*(\\/?)\\s*(${[...COT_PSEUDO_TAGS, ...THINKING_TAGS].join('|')})\\s*>$`, 'i');
const PROTOCOL_BLOCKS = new Set(COT_BLOCKS);
const THINKING_BLOCKS = new Set(THINKING_TAGS);
/** A thinking block or a protocol block opening before the story (the provider filters only <thinking>). */
const LEAD_OPEN_RE = new RegExp(`^\\s*<\\s*(${[...THINKING_TAGS, ...COT_BLOCKS].join('|')})\\s*>`, 'i');
/** Any thinking tag closes a thinking block, as the parser's pattern takes them. */
const THINKING_CLOSE_RE = new RegExp(`<\\s*\\/\\s*(?:${THINKING_TAGS.join('|')})\\s*>`, 'i');
/** Of a block before the story, only this much of its end is kept while it is waited for (a closing tag may arrive split). */
const LEAD_TAIL = 32;

/**
 * How the display reads what comes: `json` — the story is a JSON string whose escapes the envelope reads;
 * `tagged` — the story is written straight into `<正文>`; `raw` — no envelope was found.
 */
type DisplayMode = 'json' | 'tagged' | 'raw';

/**
 * What the player sees of a story while it streams, fed one character at a time.
 * - `json`: a second layer of escapes is decoded (a reply wrapped in `<正文>` may escape its story twice) and the
 *   CoT pseudo-tags are taken out, what they hold kept — as the parser reads a story.
 * - `tagged`: the same, and `</正文>` or the next protocol block ends what is shown (`closed`); a thinking block
 *   inside is hidden.
 * - `raw`: what comes is shown, but a protocol block or a thinking block is hidden whole, the pseudo-tags are taken
 *   out, and an opening `<正文>` makes the rest a tagged story — a reply that plans before its story, or prefaces
 *   it, shows its story (and the preface).
 * The second layer reads the two signs the parser's `escapedTwice` reads: a `\n` is a line break while the story
 * has shown no real line break of its own, a `\"` a quote while it has shown no plain quote; once one of them is read
 * the story is escaped twice and every escape in it is read (the parser then decodes them all). A `\` or `<` is held
 * until it is known what it starts; `end` shows what is still held.
 */
function storyDisplay(emit: (text: string) => void) {
  let escape = '';
  let tag = '';
  /** A real line break, a plain quote, has come of the story itself. */
  let sawBreak = false;
  let sawQuote = false;
  /** A second-layer `\n` or `\"` has been read: the story is escaped twice. */
  let twice = false;
  /** The block being hidden, until its closing tag. */
  let hidden: string | null = null;
  const show = (text: string) => { if (!hidden && text) emit(text); };
  const display = {
    mode: 'raw' as DisplayMode,
    closed: false,
    put(ch: string): void {
      if (display.closed) return;
      if (escape) {
        if (escape === '\\' && ((ch === 'n' && !sawBreak) || (ch === '"' && !sawQuote))) {
          escape = '';
          twice = true;
          toTag(RESIDUAL_ESCAPES[ch]);
          return;
        }
        if (escape === '\\' && twice && ch in RESIDUAL_ESCAPES) {
          escape = '';
          toTag(RESIDUAL_ESCAPES[ch]);
          return;
        }
        if (escape === '\\' && twice && ch === 'u') {
          escape = '\\u';
          return;
        }
        if (escape.startsWith('\\u') && /[0-9a-fA-F]/.test(ch)) {
          escape += ch;
          if (escape.length === 6) {
            const decoded = String.fromCharCode(parseInt(escape.slice(2), 16));
            escape = '';
            toTag(decoded);
          }
          return;
        }
        // Not an escape: the backslash (and what followed it) was the story's own.
        const held = escape;
        escape = '';
        for (const c of held) toTag(c);
      }
      if (display.mode !== 'raw' && ch === '\\') {
        escape = '\\';
        return;
      }
      if (ch === '\n') sawBreak = true;
      else if (ch === '"') sawQuote = true;
      toTag(ch);
    },
    end(): void {
      const held = tag + escape;
      escape = '';
      tag = '';
      if (!display.closed) show(held);
    },
  };
  function toTag(ch: string): void {
    if (display.closed) return;
    if (!tag) {
      if (ch === '<') tag = '<';
      else show(ch);
      return;
    }
    if (ch === '<') {
      show(tag);
      tag = '<';
      return;
    }
    tag += ch;
    if (ch === '>') {
      const held = tag;
      tag = '';
      readTag(held);
      return;
    }
    if (tag.length > COT_TAG_MAX || ch === '\n') {
      show(tag);
      tag = '';
    }
  }
  /** A complete `<…>`: a pseudo-tag or a thinking tag never shows, and may open, hide or close the story. */
  function readTag(held: string): void {
    const m = COT_TAG.exec(held);
    if (!m) {
      show(held);
      return;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (hidden) {
      // Any thinking tag closes a thinking block (as the parser's pattern takes them); a protocol block closes with
      // its own tag. A `<正文>` inside a thinking block is the model reciting the format, part of the block.
      if (closing && (name === hidden || (THINKING_BLOCKS.has(hidden) && THINKING_BLOCKS.has(name)))) hidden = null;
      return;
    }
    if (closing) {
      if (display.mode === 'tagged' && name === '正文') display.closed = true;
      return;
    }
    if (display.mode === 'json') return;
    if (THINKING_BLOCKS.has(name)) hidden = name;
    else if (PROTOCOL_BLOCKS.has(name)) {
      if (display.mode === 'tagged') display.closed = true;
      else hidden = name;
    } else if (name === '正文' && display.mode === 'raw') display.mode = 'tagged';
  }
  return display;
}

/** Where the stream's story starts: the reply object's `{"text":"` head, maybe behind `<正文>` and a code fence. */
export const PREFIX_RE = new RegExp('^\\s*(?:<正文>\\s*)?(?:```(?:json|JSON)?\\s*)?' + ENVELOPE_KEY_HEAD + '\\s*"');

/**
 * Character-level state machine that shows the story of streamed AI output without its envelope. Works for
 * single-call (`{"text":"...","commands":...}`), splitGen step1 (`{"text":"..."}`), and the CoT protocol's own shape
 * (`<正文>…</正文>` and its planning blocks after it).
 *
 * States: SEEKING → TEXT → (ESCAPE | QUOTE) → DONE · SEEKING → TAGGED → DONE · SEEKING → PASSTHROUGH
 *
 * - SEEKING: buffers chars until the `{"text":"` prefix is detected (also behind `<正文>`, which a CoT reply may wrap
 *   the whole JSON in, and inside a code fence), or a story written straight into `<正文>`
 * - TEXT: shows narrative chars, decodes JSON escapes (\n→newline, \"→")
 * - ESCAPE: just saw `\` inside the text value
 * - QUOTE: just saw a bare `"` — it closes the value only if `}` comes next, or `,` and then a `"` (the next
 *   key, most likely; the parser, which sees the whole reply, checks the key itself); otherwise it was a quote in
 *   the story the model forgot to escape, and the stream goes on (it used to stop there for the rest of the step).
 *   A story quote followed by `, "` can still end the live text early; the round's final text is the parser's.
 * - TAGGED: the story inside `<正文>` (2026-10-03 release check: the tags and the planning blocks after the story
 *   used to stream into the bubble and stay there through step 2) — shown until `</正文>` or the next protocol block
 * - DONE: the story is over — discards the rest
 * - PASSTHROUGH: no envelope after 48 chars — shows everything, the CoT pseudo-tags taken out
 *
 * What TEXT and TAGGED show goes through `storyDisplay`: a JSON escape still in the story decoded (a reply wrapped in
 * `<正文>` may escape its story twice) and the pseudo-tags taken out, as the parser reads the story in the end.
 */
export function createJsonTextStreamUnwrapper(
  onChunk: (chunk: string) => void,
): { onChunk: (chunk: string) => void; flush: () => void } {
  /** A story written straight into the tag: `<正文>`, then neither an object nor a fence. */
  const TAGGED_RE = /^\s*<正文>\s*[^\s{`]/;
  const TAG_HEAD_RE = /^\s*<正文>\s*/;
  const PREFIX_MAX = 48;

  let state: 'seeking' | 'text' | 'escape' | 'unicode' | 'quote' | 'quoteComma' | 'tagged' | 'done' | 'passthrough' = 'seeking';
  let seekBuf = '';
  /** The hex digits of a `\uXXXX` escape read so far. */
  let hex = '';
  /** What followed a bare quote while deciding whether it closes the value (whitespace, a comma). */
  let quoteBuf = '';
  /** What one incoming chunk shows, sent on as one chunk. */
  let shown = '';
  const display = storyDisplay((text) => { shown += text; });
  const send = () => {
    if (!shown) return;
    const text = shown;
    shown = '';
    onChunk(text);
  };
  const put = (text: string) => { for (const c of text) display.put(c); };
  /** The story inside `<正文>`, from what was buffered after the tag. */
  const startTagged = (buffered: string) => {
    state = 'tagged';
    display.mode = 'tagged';
    put(buffered.replace(TAG_HEAD_RE, ''));
    if (display.closed) state = 'done';
  };
  const passThrough = () => {
    state = 'passthrough';
    put(seekBuf);
    seekBuf = '';
  };
  /**
   * What has been buffered so far: a thinking or planning block before the story is skipped (waited for, then
   * dropped — any thinking tag closes a thinking block; a `<正文>` inside it is the model reciting the format), then
   * the envelope is looked for in what remains.
   */
  const seek = () => {
    for (;;) {
      const lead = LEAD_OPEN_RE.exec(seekBuf);
      if (lead) {
        const name = lead[1].toLowerCase();
        const rest = seekBuf.slice(lead[0].length);
        const closer = THINKING_BLOCKS.has(name) ? THINKING_CLOSE_RE : new RegExp(`<\\s*\\/\\s*${name}\\s*>`, 'i');
        const close = closer.exec(rest);
        if (close) {
          seekBuf = rest.slice(close.index + close[0].length);
          continue;
        }
        // The block's body is dropped anyway: keep its opening and a tail that can hold a closing tag arriving split,
        // so waiting for a long block costs nothing (code review round 4: rebuilding it per character took seconds).
        if (rest.length > LEAD_TAIL) seekBuf = lead[0] + rest.slice(-LEAD_TAIL);
        return;
      }
      if (PREFIX_RE.test(seekBuf)) {
        state = 'text';
        display.mode = 'json';
        seekBuf = '';
      } else if (TAGGED_RE.test(seekBuf) || (seekBuf.length > PREFIX_MAX && TAG_HEAD_RE.test(seekBuf))) {
        startTagged(seekBuf);
        seekBuf = '';
      } else if (seekBuf.length > PREFIX_MAX) {
        passThrough();
      }
      return;
    }
  };
  const finish = () => {
    state = 'done';
    display.end();
  };

  return {
    onChunk(chunk: string) {
      if (state === 'done') return;

      for (let i = 0; i < chunk.length && state !== 'done'; i++) {
        const ch = chunk[i];

        switch (state) {
          case 'seeking':
            seekBuf += ch;
            seek();
            break;

          case 'tagged':
          case 'passthrough':
            display.put(ch);
            if (display.closed) state = 'done';
            break;

          case 'text':
            if (ch === '\\') {
              state = 'escape';
            } else if (ch === '"') {
              state = 'quote';
              quoteBuf = '';
            } else {
              display.put(ch);
            }
            break;

          case 'quote':
            if (/\s/.test(ch)) {
              quoteBuf += ch;
            } else if (ch === '}') {
              finish();
            } else if (ch === ',') {
              quoteBuf += ch;
              state = 'quoteComma';
            } else {
              // A quote in the story: show it and what came after it, and read on.
              put('"' + quoteBuf);
              quoteBuf = '';
              state = 'text';
              i--;
            }
            break;

          case 'quoteComma':
            if (/\s/.test(ch)) {
              quoteBuf += ch;
            } else if (ch === '"') {
              finish();
            } else {
              // `"fine", then left`: the quote and the comma were the story's.
              put('"' + quoteBuf);
              quoteBuf = '';
              state = 'text';
              i--;
            }
            break;

          case 'escape': {
            if (ch === 'u') {
              state = 'unicode';
              hex = '';
              break;
            }
            put(RESIDUAL_ESCAPES[ch] ?? '\\' + ch);
            state = 'text';
            break;
          }

          case 'unicode':
            if (/[0-9a-fA-F]/.test(ch)) {
              hex += ch;
              if (hex.length === 4) {
                put(String.fromCharCode(parseInt(hex, 16)));
                state = 'text';
              }
            } else {
              // Not a \uXXXX after all: what was read shows as it was, and this character is read as text.
              put('\\u' + hex);
              state = 'text';
              i--;
            }
            break;
        }
      }
      send();
    },

    flush() {
      if (state === 'seeking' && seekBuf) {
        // (A block before the story still open here shows nothing: the display hides it whole.)
        if (TAG_HEAD_RE.test(seekBuf)) startTagged(seekBuf);
        else put(seekBuf);
        seekBuf = '';
      }
      display.end();
      send();
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

/**
 * Same estimator as the persisted `_metrics` (metrics-helpers) so the offline prompt
 * ledger, the debug panel and the save all agree on the numbers. `sources` is the parallel
 * provenance array from ContextAssembly (`builder:*`, `module:*`, `history:*`, …); a missing
 * tag is recorded as `unknown` rather than dropped so the breakdown always sums to the total.
 */
function buildStepMetrics(messages: AIMessage[], sources: string[] | undefined, raw: string): PromptStepMetrics {
  return {
    inputTokens: estimateMessagesTokens(messages),
    outputTokens: estimateTextTokens(raw),
    breakdown: messages.map((m, i) => ({
      source: sources?.[i] ?? 'unknown',
      tokens: estimateMessagesTokens([m]),
    })),
  };
}
