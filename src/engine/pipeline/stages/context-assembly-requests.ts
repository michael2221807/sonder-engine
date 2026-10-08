/**
 * Context assembly — the request half of a round.
 *
 * `collectRoundInputs` / `buildFlowVariables` (context-assembly-inputs.ts) gather what the round needs; the functions
 * here turn it into the AI requests:
 * - `assembleStoryRequest`    the builder path (context-piece builder), plus its Step 2 request;
 * - `assembleStep2Request`    the split-gen Step 2 messages of the builder path;
 * - `assembleFlowRequests` the flow-based path (the pack's prompt flows);
 * - `finalizeRequests`        NSFW strip, debug emit, Step 2 follow-up and the returned context.
 *
 * Every function keeps the order, the in-place edits (message arrays, `ctx.meta`) and the event order of the code it
 * was cut from: the request matrix snapshots are the proof.
 */
import type { PipelineContext, EnginePathConfig } from '../types';
import type { AIMessage } from '../../ai/types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import { eventBus } from '../../core/event-bus';
import { emitPromptAssemblyDebug } from '../../core/prompt-debug';
import { stripTagFromMessages, NSFW_STRIP_TAG } from '../../memory/snapshot-sanitizer';
import {
  buildSentRegistry,
  compileStep2Context,
  historyTraceEntry,
  STEP2_FEW_SHOT_PAIRS,
} from '../../prompt/context-compiler';
import { estimateMessagesTokens, estimateTextTokens } from '../../core/metrics-helpers';
import { isColocatedLocation, type NpcRecord } from '../../social/npc-presence';
import { buildSystemPrompt } from '../../prompt/system-prompt-builder';
import { PIECE_ID } from '../../prompt/piece-ids';
import { activeClauses, narrativeContractTraceEntry } from '../../prompt/narrative-contract';
import { activeVectorEntries, characterVectorsTraceEntry } from '../../prompt/character-vectors';
import { SPLIT_STEP1_FORMAT_PROMPT_ID, SPLIT_STEP2_FOLLOWUP_PROMPT_ID } from '../../prompt/builtin-slots';
import { PlotInjector } from '../../plot/plot-injector';
import type { SystemPromptBuildResult } from '../../prompt/world-book';
import type { RawPromptTransform } from '../../prompt/raw-prompt-transform';
import type { RoundPromptInputs } from './context-assembly-inputs';
import { DEFAULT_ENGINE_PATHS } from '../types';

export interface RequestDeps {
  stateManager: StateManager;
  promptAssembler: PromptAssembler;
  pack: GamePack;
  paths: EnginePathConfig;
  getGproxyCacheEnabled?: () => boolean;
}

/** The messages (and their sources) of the round's requests, before the NSFW strip. */
export interface RequestDraft {
  messages: AIMessage[];
  messageSources: string[];
  splitStep2Messages?: AIMessage[];
  splitStep2Sources?: string[];
  /** Auto-captured world-book entries injected this round (hit-counter write-back list). */
  capturedHits: string[];
  worldBookSkipped?: SystemPromptBuildResult['worldBookSkipped'];
  worldBookBudget?: SystemPromptBuildResult['worldBookBudget'];
}

/**
 * Fills the `{{NAME}}` placeholders of a plot prompt (plotDirective, plotEvaluationStep2) from the round's variables.
 * A placeholder the round has no variable for becomes empty text; nothing else touches the text (no transform).
 */
function renderPlotTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => key in variables ? variables[key] : '');
}

/**
 * Append the current-round input as a `user` turn WITHOUT ever stacking two
 * consecutive `user` messages.
 *
 * When `chatHistory` is empty (round 1, or the `single_assistant_block`
 * short-term injection style) and every flow module is `system`, the
 * assembler's safety guard has already appended a placeholder user turn
 * ("请根据以上设定开始。", source `placeholder`). A blind push after it produces
 * user→user, which the Anthropic-native provider rejects with a 400 (strict
 * alternation, no merging — see `claude-provider.ts` and the CR-R12 note in
 * `ai-call.ts`). The real input REPLACES that placeholder — both exist for the
 * same reason (end the prefix on a user turn), and the real one does it better.
 * A trailing genuine user message (defensive case) gets the input merged into
 * it instead.
 */
function appendUserTurn(messages: AIMessage[], sources: string[], content: string): void {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (last?.role === 'user' && sources[lastIdx] === 'placeholder') {
    messages[lastIdx] = { role: 'user', content };
    sources[lastIdx] = 'current_input';
    return;
  }
  if (last?.role === 'user') {
    messages[lastIdx] = { role: 'user', content: `${last.content}\n\n${content}` };
    sources[lastIdx] = `${sources[lastIdx]}+current_input`;
    return;
  }
  messages.push({ role: 'user', content });
  sources.push('current_input');
}

/**
 * The variables of the Step 2 flow: the round's variables plus the plot block of Step 2 and the history framing.
 * Key order matters (the debug panel and the snapshots show it): round variables first, then the plot ones, then
 * the framing flag.
 */
function step2Variables(deps: RequestDeps, variables: Record<string, string>, ctx: PipelineContext): Record<string, string> {
  return {
    ...variables,
    ...PlotInjector.buildStep2Variables(deps.stateManager, deps.paths, deps.pack.engineFragments),
    HISTORY_FRAMING_STEP2: ctx.meta.plotVectorPromptMode ? '' : '1',
  };
}

/**
 * Looks up the flow a split-gen step is assembled from: the override the caller named in `ctx.meta`, else the
 * default. A named override that the pack lacks stops an enhanced opening (it cannot proceed without its own
 * flows) and falls back to the default flow, with a warning, for every other round.
 */
function resolveFlowOverride(deps: RequestDeps, ctx: PipelineContext, step: 'step1' | 'step2', defaultFlowId: string) {
  const overrideId = (step === 'step1' ? ctx.meta.step1FlowOverride : ctx.meta.step2FlowOverride) as string | undefined;
  const flow = deps.pack.promptFlows[overrideId ?? defaultFlowId];
  if (overrideId && !deps.pack.promptFlows[overrideId]) {
    if (ctx.meta.isEnhancedOpening) {
      throw new Error(`[ContextAssembly] Required flow override '${overrideId}' not found — Enhanced Opening cannot proceed`);
    }
    console.warn(`[ContextAssembly] ${step}FlowOverride '${overrideId}' not found, falling back to default`);
  }
  return flow;
}

/** The implicit mid-term memory as the builder reads it: one line per entry, timestamped when it has a time. */
function buildImplicitMidBlock(stateManager: StateManager): string {
  const implicitMidRaw = stateManager.get<unknown[]>(DEFAULT_ENGINE_PATHS.implicitMidTermMemory) ?? [];
  return implicitMidRaw
    .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object' && !Array.isArray(e))
    .filter((e) => e['记忆主体'] && String(e['记忆主体']).trim())
    .map((e) => {
      const time = e['事件时间'] ? `[${e['事件时间']}] ` : '';
      return `${time}${e['记忆主体']}`;
    })
    .join('\n');
}

/**
 * GAP-08 fix: inject the plot directive (and, outside split-gen, the Step 2 evaluation prompt) as system messages
 * before the last two messages (player_input + start_task). Edits both arrays in place.
 */
function injectPlotMessages(
  messages: AIMessage[],
  messageSources: string[],
  roundPrompts: Record<string, string>,
  variables: Record<string, string>,
  splitGen: boolean,
): void {
  if (!variables['PLOT_DIRECTIVE']) return;
  const plotDirectivePrompt = roundPrompts['plotDirective'] ?? '';
  if (plotDirectivePrompt) {
    const rendered = renderPlotTemplate(plotDirectivePrompt, variables);
    if (rendered.trim()) {
      // Insert before the last 2 messages (player_input + start_task)
      const insertAt = Math.max(0, messages.length - 2);
      messages.splice(insertAt, 0, { role: 'system' as const, content: rendered });
      messageSources.splice(insertAt, 0, 'builder:plot_directive');
    }
  }
  // Also inject evaluation prompt in non-split-gen mode
  if (!splitGen && variables['PLOT_COMPLETION_HINT']) {
    const evalPrompt = roundPrompts['plotEvaluationStep2'] ?? '';
    if (evalPrompt) {
      const rendered = renderPlotTemplate(evalPrompt, variables);
      if (rendered.trim()) {
        const insertAt = Math.max(0, messages.length - 2);
        messages.splice(insertAt, 0, { role: 'system' as const, content: rendered });
        messageSources.splice(insertAt, 0, 'builder:plot_evaluation_step2');
      }
    }
  }
}

/** NPCs present with the player: flagged present, or colocated by the same hierarchical rule syncPresence uses. */
function collectPresentNpcNames(deps: RequestDeps): string[] {
  const { stateManager, paths } = deps;
  const npcNameKey = paths.npcFieldNames.name;
  const isPresentKey = paths.npcFieldNames.isPresent;
  const npcLocationKey = paths.npcFieldNames.location;
  const separator = paths.locationPathSeparator;
  const currentLocation = stateManager.get<string>(paths.playerLocation) ?? '';
  return (stateManager.get<NpcRecord[]>(paths.relationships) ?? [])
    .filter((npc) => npc[isPresentKey] === true
      || isColocatedLocation(typeof npc[npcLocationKey] === 'string' ? (npc[npcLocationKey] as string) : '', currentLocation, separator))
    .map((npc) => String(npc[npcNameKey] ?? ''))
    .filter(Boolean);
}

/**
 * Context Compiler v1 (2026-09-04) — Step 2 gets a projection, not the ledger. Returns the Step 2 variables and
 * history; writes the trace into `ctx.meta.compileTrace` in place.
 * Design: docs/design/context-compiler-positioning.md.
 */
function compileStep2Projection(
  deps: RequestDeps,
  ctx: PipelineContext,
  inputs: RoundPromptInputs,
  buildResult: SystemPromptBuildResult,
  step2VarsIn: Record<string, string>,
): { step2Vars: Record<string, string>; step2History: AIMessage[] } {
  const {
    stateSnapshot, nsfwMode, presenceEnabled, gaugeShadowPaths, memoryBlock, narrativeContract, focalCast,
    narrativeContractBlock, characterVectors, vectorScope, characterVectorsBlock, historyPairs, chatHistory,
  } = inputs;
  // "Present" NPCs feed the world-event relevance check. `是否在场` is only
  // deterministically synced when the presence system is on (PostProcess
  // syncPresence, default off), so also count NPCs colocated with the player.
  const presentNpcNames = collectPresentNpcNames(deps);
  const compiled = compileStep2Context({
    snapshot: stateSnapshot,
    nsfwMode,
    additionalStripPaths: presenceEnabled || gaugeShadowPaths.length > 0
      ? [...(presenceEnabled ? [deps.paths.relationships] : []), ...gaugeShadowPaths]
      : undefined,
    registry: buildSentRegistry(Object.keys(buildResult.contextPieces)),
    paths: deps.paths,
    presentNpcNames,
    memoryBlock: memoryBlock,
  });
  const step2Vars = {
    ...step2VarsIn,
    GAME_STATE_JSON: compiled.gameStateJson,
    ...(compiled.memoryBlock !== undefined ? { MEMORY_BLOCK: compiled.memoryBlock } : {}),
  };
  const step2History = historyPairs(STEP2_FEW_SHOT_PAIRS);
  const trace = compiled.trace;
  if (chatHistory.length !== step2History.length) {
    const entry = historyTraceEntry(
      estimateMessagesTokens(chatHistory),
      estimateMessagesTokens(step2History),
      Math.ceil(chatHistory.length / 2),
      Math.ceil(step2History.length / 2),
    );
    trace.entries.push(entry);
    trace.savedTokens += Math.max(0, entry.before - entry.after);
  }
  // The contract is the one block deliberately sent to both steps — record it so
  // the Prompt Assembly panel can answer "why is this in step2 as well?".
  if (narrativeContractBlock) {
    trace.entries.push(narrativeContractTraceEntry(
      estimateTextTokens(narrativeContractBlock),
      activeClauses(narrativeContract).length,
      focalCast.length,
    ));
  }
  if (characterVectorsBlock) {
    trace.entries.push(characterVectorsTraceEntry(
      estimateTextTokens(characterVectorsBlock),
      activeVectorEntries(characterVectors).length,
      vectorScope.length,
    ));
  }
  ctx.meta['compileTrace'] = trace;
  return { step2Vars, step2History };
}

/**
 * Split-gen Step 2 of the builder path: assembles the Step 2 flow over the compiled projection (or the full
 * variables with the compiler off) and ends the base with the round's player input as a `user` turn.
 * Returns nothing when the pack has no Step 2 flow.
 */
export function assembleStep2Request(
  deps: RequestDeps,
  ctx: PipelineContext,
  inputs: RoundPromptInputs,
  variables: Record<string, string>,
  assembler: PromptAssembler,
  buildResult: SystemPromptBuildResult,
): { splitStep2Messages: AIMessage[]; splitStep2Sources: string[] } | undefined {
  let step2Vars: Record<string, string> = step2Variables(deps, variables, ctx);
  let step2History = inputs.chatHistory;

  // step1 and step2 were assembled by two renderers that never knew what the other sent (R1b: dedup + event
  // projection loses nothing; the short-term memory in step1 is load-bearing and is NOT touched). Off switch = old
  // behaviour.
  if (ctx.meta.contextCompiler !== false) {
    ({ step2Vars, step2History } = compileStep2Projection(deps, ctx, inputs, buildResult, step2Vars));
  }

  const step2Flow = resolveFlowOverride(deps, ctx, 'step2', 'splitGenMainRoundStep2');
  if (!step2Flow) return undefined;
  const s2 = assembler.assemble(step2Flow, step2Vars, step2History);
  const splitStep2Messages = s2.messages;
  const splitStep2Sources = s2.messageSources;
  // The current round's player input, verbatim. The legacy path always gave
  // step2 this message; the builder path dropped it, leaving step2 with only
  // step1's RETELLING of the input. Round-62 incident (2026-08-25): the
  // settingCapture protocol demands evidence quoted verbatim from the tagged
  // input — with the original nowhere in context, the model could only
  // paraphrase from step1's thinking, and every candidate died in the evidence
  // gate. Ends the base as a `user` turn so the final shape stays alternating:
  // user(input) → assistant(step1) → user(followup).
  //
  // `ctx.userInput` (action-queue-prefixed), not `originalUserInput`: step2 also
  // generates commands/action_options and needs the panel-action context. The
  // evidence gate matches against originalUserInput's tag segments only, and the
  // tag substring is byte-identical in both, so no forged-acceptance surface.
  appendUserTurn(splitStep2Messages, splitStep2Sources,
    `<玩家输入>\n${ctx.userInput}\n</玩家输入>`);
  return { splitStep2Messages, splitStep2Sources };
}

/**
 * The builder path (context-piece architecture): ~26 individually named system messages + user input + masquerade,
 * the short-term memory and plot messages spliced in, and (split-gen) the Step 2 request.
 */
export function assembleStoryRequest(
  deps: RequestDeps,
  ctx: PipelineContext,
  inputs: RoundPromptInputs,
  variables: Record<string, string>,
  assembler: PromptAssembler,
  transformPrompt: RawPromptTransform | undefined,
): RequestDraft {
  const {
    historyText, memoryBlock, gaugeShadowPaths, actionMode, actionOptionsEnabled,
    cotEnabled, cotJudgeEnabled, prevThinkingBlock, bookmarkedRoundsBlock, settingCaptureActive,
    narrativeContractBlock, characterVectorsBlock, narrativeHistory, mergedWorldBooks,
  } = inputs;
  const splitGen = ctx.meta.splitGen === true;
  const implicitMidBlock = buildImplicitMidBlock(deps.stateManager);

  // memoryBlock from retrieveMemory() — if hybrid mode, this is the unified retrieval result
  // We pass it as engramRetrievalBlock so the builder includes it
  const rawHistoryForCorpus = narrativeHistory.slice(-12).map((e) => ({
    content: typeof e.content === 'string' ? e.content : '',
  }));

  // The pack's prompts as this round sends them (the prompt page's edits and switches); the registry never
  // switches off what the round cannot do without (its formats, its length rule) or what a setting chooses.
  const roundPrompts = deps.promptAssembler.effectivePrompts(deps.pack.prompts ?? {});
  const buildResult = buildSystemPrompt({
    transformPrompt,
    historyText,
    // A single call writes the options itself: the options module for the player's mode, pace and request
    // (split Step 2 loads it from its flow instead).
    actionOptionsBlock: !splitGen && actionOptionsEnabled
      ? assembler.renderSingle(actionMode === 'story' ? 'actionOptionsStory' : 'actionOptions', variables) ?? undefined
      : undefined,
    // Split Step 1 writes the story only, with plot momentum on or off: the pack's story-only format. Off used to
    // send the single call's format, which asks for commands, options and memory: Step 1 wrote them without the
    // command rules, the merge kept only Step 2's, and Step 2 read Step 1's draft as already done (item 3, PO
    // 2026-10-05). The enhanced opening keeps its own Step 1 flow. A pack without that format keeps the single
    // call's with plot momentum off; plot momentum requires it (the builder stops the round).
    formatPromptId: splitGen && !ctx.meta.isEnhancedOpening && !ctx.meta.step1FlowOverride
      && (ctx.meta.plotVectorPromptMode || !!roundPrompts[SPLIT_STEP1_FORMAT_PROMPT_ID]?.trim())
      ? SPLIT_STEP1_FORMAT_PROMPT_ID : undefined,
    stateManager: deps.stateManager,
    paths: deps.paths,
    packPrompts: roundPrompts,
    bookmarkedRoundsBlock,
    hiddenStatePaths: gaugeShadowPaths,
    prevThinking: prevThinkingBlock,
    worldBooks: mergedWorldBooks,
    userInput: ctx.userInput,
    playerName: deps.stateManager.get<string>(deps.paths.playerName) ?? '',
    cotEnabled,
    cotJudgeEnabled,
    splitGen,
    cotPseudoEnabled: cotEnabled,
    engramRetrievalBlock: memoryBlock,
    implicitMidTermBlock: implicitMidBlock,
    narrativeHistoryForCorpus: rawHistoryForCorpus,
    gproxyCache: deps.getGproxyCacheEnabled?.() ?? false,
    settingCaptureActive,
    narrativeContractBlock,
    characterVectorsBlock,
  });

  // Park the auto-captured hit list for SettingCaptureStage. The builder is a pure
  // read of state, so the `injectedCount` / `lastInjectedRound` bump must happen in
  // a stage that writes — and it has to be the SAME write as the rest of the round
  // so it rolls back together. Also carried: skip reasons + budget accounting for
  // the debug panel and the world-book settings UI.
  const capturedHits = buildResult.capturedHits ?? [];
  const worldBookSkipped = buildResult.worldBookSkipped;
  const worldBookBudget = buildResult.worldBookBudget;

  // Surface the selection outcome so the world-book panel can explain a
  // "configured but never injected" entry instead of leaving it looking broken.
  eventBus.emit('worldbook:selection', {
    skipped: worldBookSkipped ?? [],
    budget: worldBookBudget,
    hits: buildResult.worldBookHits?.map((h) => h.entryId) ?? [],
  });

  // Convert MessageEntry[] → AIMessage[]
  const messages: AIMessage[] = buildResult.messageEntries.map((e) => ({
    role: e.role as AIMessage['role'],
    content: e.content,
  }));
  const messageSources = buildResult.messageEntries.map((e) => `builder:${e.id}`);

  // Inject short-term memory as separate assistant message (即时剧情回顾)
  // Insert before the tail block (player_input + start_task + optional cot_masquerade)
  if (buildResult.shortMemoryContext) {
    // Find player_input position (the assistant message with user's input)
    const playerInputIdx = messageSources.findIndex((s) => s === `builder:${PIECE_ID.PLAYER_INPUT}`);
    const insertAt = playerInputIdx >= 0 ? playerInputIdx : Math.max(0, messages.length - 2);
    messages.splice(insertAt, 0, { role: 'assistant' as const, content: buildResult.shortMemoryContext });
    messageSources.splice(insertAt, 0, 'short_term_memory');
  }

  injectPlotMessages(messages, messageSources, roundPrompts, variables, splitGen);

  // For split-gen step2, use the old assembler
  const step2 = splitGen ? assembleStep2Request(deps, ctx, inputs, variables, assembler, buildResult) : undefined;

  console.debug('[ContextAssembly][NewBuilder] Messages:', messages.length, 'pieces:', Object.keys(buildResult.contextPieces).length);
  console.debug('[ContextAssembly][NewBuilder] Message roles:', messages.map((m) => m.role));
  console.debug('[ContextAssembly][NewBuilder] Context pieces:', Object.keys(buildResult.contextPieces));

  return {
    messages,
    messageSources,
    splitStep2Messages: step2?.splitStep2Messages,
    splitStep2Sources: step2?.splitStep2Sources,
    capturedHits,
    worldBookSkipped,
    worldBookBudget,
  };
}

/** The flow-based path: the pack's prompt flows (mainRound, or the split-gen Step 1 / Step 2 pair). */
export function assembleFlowRequests(
  deps: RequestDeps,
  ctx: PipelineContext,
  inputs: RoundPromptInputs,
  variables: Record<string, string>,
  assembler: PromptAssembler,
): RequestDraft {
  const { shortTermText, chatHistory } = inputs;
  const splitGen = ctx.meta.splitGen === true;
  const step1Resolved = resolveFlowOverride(deps, ctx, 'step1', 'splitGenMainRoundStep1');
  const step2Resolved = resolveFlowOverride(deps, ctx, 'step2', 'splitGenMainRoundStep2');
  const step1Flow = splitGen ? step1Resolved ?? null : null;
  const step2Flow = splitGen ? step2Resolved ?? null : null;

  let messages: AIMessage[];
  let messageSources: string[];
  let splitStep2Messages: AIMessage[] | undefined;
  let splitStep2Sources: string[] | undefined;

  if (splitGen && step1Flow && step2Flow) {
    const s1 = assembler.assemble(step1Flow, variables, chatHistory);
    const step2Vars = step2Variables(deps, variables, ctx);
    const s2 = assembler.assemble(step2Flow, step2Vars, chatHistory);
    messages = s1.messages;
    messageSources = s1.messageSources;
    splitStep2Messages = s2.messages;
    splitStep2Sources = s2.messageSources;
  } else {
    const flow = deps.pack.promptFlows['mainRound'];
    if (!flow) {
      throw new Error('Missing required prompt flow "mainRound" in Game Pack.');
    }
    const r = assembler.assemble(flow, variables, chatHistory);
    messages = r.messages;
    messageSources = r.messageSources;
  }

  // Legacy: short-term memory injection
  if (shortTermText) {
    messages.push({ role: 'assistant', content: shortTermText });
    messageSources.push('short_term_memory');
    if (splitStep2Messages) {
      splitStep2Messages.push({ role: 'assistant', content: shortTermText });
      splitStep2Sources?.push('short_term_memory');
    }
  }

  // Legacy: enforcement + user input
  const enforcement = assembler.renderSingle('narratorEnforcement', variables);
  const userTurnContent = enforcement
    ? `${enforcement}\n\n<玩家输入>\n${ctx.userInput}\n</玩家输入>`
    : ctx.userInput;
  appendUserTurn(messages, messageSources, userTurnContent);
  if (splitStep2Messages && splitStep2Sources) {
    appendUserTurn(splitStep2Messages, splitStep2Sources, userTurnContent);
  }

  console.debug('[ContextAssembly][Legacy] Messages:', messages.length);
  return { messages, messageSources, splitStep2Messages, splitStep2Sources, capturedHits: [] };
}

/**
 * Last step of the stage: the NSFW strip, the `ui:debug-prompt` emit (after the strip, so the panel shows what the
 * AI receives; the emitted array is the one returned in the context), the Step 2 follow-up and the returned context.
 */
export function finalizeRequests(
  ctx: PipelineContext,
  inputs: RoundPromptInputs,
  variables: Record<string, string>,
  assembler: PromptAssembler,
  draft: RequestDraft,
): PipelineContext {
  const {
    stateSnapshot, chatHistory, nsfwMode, cotEnabled, cotJudgeEnabled, cotInjectStep2, actionOptionsEnabled,
    environmentBlock, settingCaptureActive,
  } = inputs;
  const { messageSources, splitStep2Sources, capturedHits, worldBookSkipped, worldBookBudget } = draft;
  let { messages, splitStep2Messages } = draft;
  const splitGen = ctx.meta.splitGen === true;

  // ── §11.2 A: NSFW tag 剥离 ──
  // CR-R5 修复（2026-04-11）：剥离在 debug 事件发射之前执行，strip → debug emit → send to AI
  // 三者看到的是同一份内容。
  if (!nsfwMode) {
    messages = stripTagFromMessages(messages, NSFW_STRIP_TAG);
    if (splitStep2Messages) {
      splitStep2Messages = stripTagFromMessages(splitStep2Messages, NSFW_STRIP_TAG);
    }
  }

  // ── 发射 ui:debug-prompt 供 PromptAssemblyPanel 调试展示 ──
  // messages 已经是 strip 后的最终版本；同时携带 messageSources 并行数组标注出处。
  // split-gen 用不同的 generationId 区分 step1/step2（否则 attachResponse 会把两次 response 挂到同一条
  // snapshot）。step2 的最终消息在 ai-call.ts 才拼完整，所以这里只 emit step1；step2 由 ai-call 自己 emit。
  if (!ctx.meta.plotVectorPromptMode && splitGen && splitStep2Messages) {
    emitPromptAssemblyDebug({
      flow: 'splitGenMainRoundStep1',
      variables,
      messages,
      messageSources,
      generationId: `${ctx.generationId ?? ''}_step1`,
      roundNumber: ctx.roundNumber,
    });
    // step2 emit 延后到 ai-call.ts，见 `executeSplitGen`
  } else if (!ctx.meta.plotVectorPromptMode) {
    emitPromptAssemblyDebug({
      flow: 'mainRound',
      variables,
      messages,
      messageSources,
      generationId: ctx.generationId,
      roundNumber: ctx.roundNumber,
    });
  }

  let splitStep2Followup: string | undefined;
  if (ctx.meta.plotVectorPromptMode && splitStep2Messages && !ctx.meta.isEnhancedOpening) {
    splitStep2Followup = assembler.renderSingle(SPLIT_STEP2_FOLLOWUP_PROMPT_ID, variables)?.trim();
    if (!splitStep2Followup) throw new Error('Missing splitGenStep2Followup prompt');
  }
  return {
    ...ctx,
    stateSnapshot,
    chatHistory,
    messages,
    messageSources,
    meta: {
      ...ctx.meta,
      splitStep2Followup,
      ...(ctx.meta.plotVectorPromptMode ? { debugVariables: variables, debugRoundNumber: ctx.roundNumber } : {}),
      ...(splitStep2Messages
        ? {
            splitStep2Messages,
            // ai-call 需要这些字段才能 emit 完整的 step2 snapshot
            splitStep2Sources,
            debugVariables: variables,
            debugRoundNumber: ctx.roundNumber,
          }
        : {}),
      cotEnabled,
      cotJudgeEnabled,
      cotInjectStep2,
      actionOptionsEnabled,
      // P2 env-tags port: forward to BodyPolishStage so it can prepend the
      // same context block as a read-only reference when polishing narrative.
      environmentBlock,
      // Canon Capture: auto-captured world-book entries injected this round.
      // SettingCaptureStage folds the hit-counter bump into the round's single
      // state write so it rolls back with everything else.
      capturedHits,
      settingCaptureActive,
      worldBookSkipped,
      worldBookBudget,
    },
  };
}
