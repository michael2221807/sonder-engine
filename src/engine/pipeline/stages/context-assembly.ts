// App doc: docs/user-guide/pages/game-prompt-assembly.md §5.3（上下文编译 · 分步第 2 步投影接线）· game-main.md §3.5（指标药丸）
/**
 * 上下文组装阶段 — 将游戏状态、记忆、行为模块输出组装为 AI 消息列表
 *
 * E.2 升级：
 * - 接收 engramManager 和 unifiedRetriever 依赖
 * - 当 engram.enabled && retrievalMode='hybrid' 时用 UnifiedRetriever 替换 legacy memoryRetriever
 * - legacy 路径：memoryRetriever.retrieve(stateManager)（传统关键词检索）
 *
 * 对应 STEP-03B M3.4 ContextAssemblyStage。
 */
import type {
  PipelineStage,
  PipelineContext,
  IMemoryRetriever,
  IBehaviorRunner,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
} from '../types';
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
import { activeClauses, narrativeContractTraceEntry } from '../../prompt/narrative-contract';
import { activeVectorEntries, characterVectorsTraceEntry } from '../../prompt/character-vectors';
import { SPLIT_STEP1_FORMAT_PROMPT_ID, SPLIT_STEP2_FOLLOWUP_PROMPT_ID } from '../../prompt/builtin-slots';
import { PlotInjector } from '../../plot/plot-injector';
import type { WorldBook, SystemPromptBuildResult } from '../../prompt/world-book';
import { collectRoundInputs, buildFlowVariables } from './context-assembly-inputs';

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

export class ContextAssemblyStage implements PipelineStage {
  name = 'ContextAssembly';

  constructor(
    private stateManager: StateManager,
    private promptAssembler: PromptAssembler,
    private memoryRetriever: IMemoryRetriever,
    private behaviorRunner: IBehaviorRunner,
    private pack: GamePack,
    private paths: EnginePathConfig,
    /** E.2: Engram 管理器，用于读取当前检索配置 */
    private engramManager?: IEngramManager,
    /** E.2: 统一检索器，hybrid 模式时使用 */
    private unifiedRetriever?: IUnifiedRetriever,
    /** World book getter: returns current world books (supports live updates) */
    private getWorldBooks?: () => WorldBook[],
    /** Whether to use the new context-piece builder (default: false for backward compat) */
    private useNewBuilder?: boolean,
    /**
     * gproxy prompt cache flag getter — reads the resolved main LLM config's
     * `gproxyPromptCache` at build time (live, so toggling it takes effect next
     * round). When true, buildSystemPrompt hoists the static prefix + embeds the
     * cache trigger. Absent/false = legacy output.
     */
    private getGproxyCacheEnabled?: () => boolean,
    private getPromptTransform?: (ctx: PipelineContext) => import('../../prompt/raw-prompt-transform').RawPromptTransform | undefined,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const transformPrompt = this.getPromptTransform?.(ctx);
    const assembler = this.promptAssembler.withTransform(transformPrompt);
    const inputs = await collectRoundInputs({
      stateManager: this.stateManager,
      memoryRetriever: this.memoryRetriever,
      pack: this.pack,
      paths: this.paths,
      engramManager: this.engramManager,
      unifiedRetriever: this.unifiedRetriever,
      getWorldBooks: this.getWorldBooks,
    }, ctx);
    const variables = buildFlowVariables({
      stateManager: this.stateManager,
      pack: this.pack,
      paths: this.paths,
      behaviorRunner: this.behaviorRunner,
    }, ctx, inputs);
    const {
      historyText,
      stateSnapshot,
      memoryBlock,
      shortTermText,
      nsfwMode,
      presenceEnabled,
      gaugeShadowPaths,
      actionMode,
      actionOptionsEnabled,
      cotEnabled,
      cotJudgeEnabled,
      cotInjectStep2,
      prevThinkingBlock,
      environmentBlock,
      bookmarkedRoundsBlock,
      settingCaptureActive,
      narrativeContract,
      focalCast,
      narrativeContractBlock,
      characterVectors,
      vectorScope,
      characterVectorsBlock,
      narrativeHistory,
      historyPairs,
      chatHistory,
      mergedWorldBooks,
    } = inputs;

    // ── 7. Prompt 组装 ──
    const splitGen = ctx.meta.splitGen === true;

    let messages: AIMessage[];
    let messageSources: string[];
    let splitStep2Messages: AIMessage[] | undefined;
    let splitStep2Sources: string[] | undefined;
    /** Auto-captured world-book entries injected this round (hit-counter write-back list). */
    let capturedHits: string[] = [];
    let worldBookSkipped: SystemPromptBuildResult['worldBookSkipped'];
    let worldBookBudget: SystemPromptBuildResult['worldBookBudget'];

    if (this.useNewBuilder) {
      // ═══ NEW PATH: SystemPromptBuilder (context-piece architecture) ═══
      // Produces ~26 individually named system messages + user input + masquerade
      // Read implicit mid-term for the builder
      const implicitMidRaw = this.stateManager.get<unknown[]>('记忆.隐式中期') ?? [];
      const implicitMidBlock = implicitMidRaw
        .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object' && !Array.isArray(e))
        .filter((e) => e['记忆主体'] && String(e['记忆主体']).trim())
        .map((e) => {
          const time = e['事件时间'] ? `[${e['事件时间']}] ` : '';
          return `${time}${e['记忆主体']}`;
        })
        .join('\n');

      // memoryBlock from retrieveMemory() — if hybrid mode, this is the unified retrieval result
      // We pass it as engramRetrievalBlock so the builder includes it
      const rawHistoryForCorpus = narrativeHistory.slice(-12).map((e) => ({
        content: typeof e.content === 'string' ? e.content : '',
      }));

      // The pack's prompts as this round sends them (the prompt page's edits and switches); the registry never
      // switches off what the round cannot do without (its formats, its length rule) or what a setting chooses.
      const roundPrompts = this.promptAssembler.effectivePrompts(this.pack.prompts ?? {});
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
        stateManager: this.stateManager,
        paths: this.paths,
        packPrompts: roundPrompts,
        bookmarkedRoundsBlock,
        hiddenStatePaths: gaugeShadowPaths,
        prevThinking: prevThinkingBlock,
        worldBooks: mergedWorldBooks,
        userInput: ctx.userInput,
        playerName: this.stateManager.get<string>(this.paths.playerName) ?? '',
        cotEnabled,
        cotJudgeEnabled,
        splitGen,
        cotPseudoEnabled: cotEnabled,
        engramRetrievalBlock: memoryBlock,
        implicitMidTermBlock: implicitMidBlock,
        narrativeHistoryForCorpus: rawHistoryForCorpus,
        gproxyCache: this.getGproxyCacheEnabled?.() ?? false,
        settingCaptureActive,
        narrativeContractBlock,
        characterVectorsBlock,
      });

      // Park the auto-captured hit list for SettingCaptureStage. The builder is a pure
      // read of state, so the `injectedCount` / `lastInjectedRound` bump must happen in
      // a stage that writes — and it has to be the SAME write as the rest of the round
      // so it rolls back together. Also carried: skip reasons + budget accounting for
      // the debug panel and the world-book settings UI.
      capturedHits = buildResult.capturedHits ?? [];
      worldBookSkipped = buildResult.worldBookSkipped;
      worldBookBudget = buildResult.worldBookBudget;

      // Surface the selection outcome so the world-book panel can explain a
      // "configured but never injected" entry instead of leaving it looking broken.
      eventBus.emit('worldbook:selection', {
        skipped: worldBookSkipped ?? [],
        budget: worldBookBudget,
        hits: buildResult.worldBookHits?.map((h) => h.entryId) ?? [],
      });

      // Convert MessageEntry[] → AIMessage[]
      messages = buildResult.messageEntries.map((e) => ({
        role: e.role as AIMessage['role'],
        content: e.content,
      }));
      messageSources = buildResult.messageEntries.map((e) => `builder:${e.id}`);

      // Inject short-term memory as separate assistant message (即时剧情回顾)
      // Insert before the tail block (player_input + start_task + optional cot_masquerade)
      if (buildResult.shortMemoryContext) {
        // Find player_input position (the assistant message with user's input)
        const playerInputIdx = messageSources.findIndex((s) => s === 'builder:player_input');
        const insertAt = playerInputIdx >= 0 ? playerInputIdx : Math.max(0, messages.length - 2);
        messages.splice(insertAt, 0, { role: 'assistant' as const, content: buildResult.shortMemoryContext });
        messageSources.splice(insertAt, 0, 'short_term_memory');
      }

      // GAP-08 fix: inject plot directive as system message for new builder path
      if (variables['PLOT_DIRECTIVE']) {
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

      // For split-gen step2, use the old assembler (step2后面再做)
      if (splitGen) {
        let step2Vars: Record<string, string> = this.step2Variables(variables, ctx);
        let step2History = chatHistory;

        // ── Context Compiler v1 (2026-09-04) — step2 gets a projection, not the ledger ──
        //
        // step1 and step2 were assembled by two renderers that never knew what the other
        // sent: the world description, the 50-entry location list, the Engram block and the
        // last five rounds of narrative all went out twice, and the whole world-event ledger
        // (the only linearly growing item) rode along "so the model can write valid paths".
        // R1b (30 real replays) showed dedup + event projection loses nothing; the short-term
        // memory in step1 is load-bearing and is NOT touched here. Off switch = old behaviour.
        // Design: docs/design/context-compiler-positioning.md; plan: context-compiler-v1-implementation-plan.md.
        if (ctx.meta.contextCompiler !== false) {
          // "Present" NPCs feed the world-event relevance check. `是否在场` is only
          // deterministically synced when the presence system is on (PostProcess
          // syncPresence, default off), so also count NPCs colocated with the player by
          // the SAME hierarchical rule syncPresence uses (`isColocatedLocation`: exact
          // match or parent/child by the location separator).
          const npcNameKey = this.paths.npcFieldNames.name;
          const isPresentKey = this.paths.npcFieldNames.isPresent;
          const npcLocationKey = this.paths.npcFieldNames.location;
          const separator = this.paths.locationPathSeparator;
          const currentLocation = this.stateManager.get<string>(this.paths.playerLocation) ?? '';
          const presentNpcNames = (this.stateManager.get<NpcRecord[]>(this.paths.relationships) ?? [])
            .filter((npc) => npc[isPresentKey] === true
              || isColocatedLocation(typeof npc[npcLocationKey] === 'string' ? (npc[npcLocationKey] as string) : '', currentLocation, separator))
            .map((npc) => String(npc[npcNameKey] ?? ''))
            .filter(Boolean);
          const compiled = compileStep2Context({
            snapshot: stateSnapshot,
            nsfwMode,
            additionalStripPaths: presenceEnabled || gaugeShadowPaths.length > 0
              ? [...(presenceEnabled ? [this.paths.relationships] : []), ...gaugeShadowPaths]
              : undefined,
            registry: buildSentRegistry(Object.keys(buildResult.contextPieces)),
            paths: this.paths,
            presentNpcNames,
            memoryBlock: memoryBlock,
          });
          step2Vars = {
            ...step2Vars,
            GAME_STATE_JSON: compiled.gameStateJson,
            ...(compiled.memoryBlock !== undefined ? { MEMORY_BLOCK: compiled.memoryBlock } : {}),
          };
          step2History = historyPairs(STEP2_FEW_SHOT_PAIRS);
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
        }

        const step2Flow = this.resolveFlowOverride(ctx, 'step2', 'splitGenMainRoundStep2');
        if (step2Flow) {
          const s2 = assembler.assemble(step2Flow, step2Vars, step2History);
          splitStep2Messages = s2.messages;
          splitStep2Sources = s2.messageSources;
          // The current round's player input, verbatim. The legacy path always gave
          // step2 this message; the builder path dropped it, leaving step2 with only
          // step1's RETELLING of the input. Round-62 incident (2026-08-25): the
          // settingCapture protocol demands evidence quoted verbatim from the tagged
          // input — with the original nowhere in context, the model could only
          // paraphrase from step1's thinking, and every candidate died in the evidence
          // gate ("引文与标记原文对不上×6"). Ends the base as a `user` turn so the
          // final shape stays alternating: user(input) → assistant(step1) → user(followup).
          //
          // `ctx.userInput` (action-queue-prefixed), not `originalUserInput`: step2 also
          // generates commands/action_options and needs the panel-action context. The
          // evidence gate matches against originalUserInput's tag segments only, and the
          // tag substring is byte-identical in both, so no forged-acceptance surface.
          appendUserTurn(splitStep2Messages, splitStep2Sources,
            `<玩家输入>\n${ctx.userInput}\n</玩家输入>`);
        }
      }

      console.debug('[ContextAssembly][NewBuilder] Messages:', messages.length, 'pieces:', Object.keys(buildResult.contextPieces).length);
      console.debug('[ContextAssembly][NewBuilder] Message roles:', messages.map((m) => m.role));
      console.debug('[ContextAssembly][NewBuilder] Context pieces:', Object.keys(buildResult.contextPieces));

    } else {
      // ═══ LEGACY PATH: flow-based PromptAssembler ═══
      const step1Resolved = this.resolveFlowOverride(ctx, 'step1', 'splitGenMainRoundStep1');
      const step2Resolved = this.resolveFlowOverride(ctx, 'step2', 'splitGenMainRoundStep2');
      const step1Flow = splitGen ? step1Resolved ?? null : null;
      const step2Flow = splitGen ? step2Resolved ?? null : null;

      if (splitGen && step1Flow && step2Flow) {
        const s1 = assembler.assemble(step1Flow, variables, chatHistory);
        const step2Vars = this.step2Variables(variables, ctx);
        const s2 = assembler.assemble(step2Flow, step2Vars, chatHistory);
        messages = s1.messages;
        messageSources = s1.messageSources;
        splitStep2Messages = s2.messages;
        splitStep2Sources = s2.messageSources;
      } else {
        const flow = this.pack.promptFlows['mainRound'];
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
    }

    // ── §11.2 A: NSFW tag 剥离 ──
    //
    // PromptAssembler 把 raw prompt 内容（带 [私密]...[/私密]）
    // 经过变量替换后放入 messages[].content。根据 nsfwMode 决定是否剥离。
    //
    // CR-R5 修复（2026-04-11）：剥离在 debug 事件发射之前执行。
    // 之前的版本在 debug 事件之后剥离 — 调试面板看到的是"未过滤"的 prompt，
    // 而 AI 实际收到的是"已过滤"的 prompt，两者不一致让开发者调试 NSFW 关闭
    // 场景时很困惑（"为什么 AI 不生成 X"— 因为 AI 根本没看到 X 的指令）。
    // 新顺序：strip → debug emit → send to AI，三者看到的是同一份内容。
    if (!nsfwMode) {
      messages = stripTagFromMessages(messages, NSFW_STRIP_TAG);
      if (splitStep2Messages) {
        splitStep2Messages = stripTagFromMessages(splitStep2Messages, NSFW_STRIP_TAG);
      }
    }

    // ── 发射 ui:debug-prompt 供 PromptAssemblyPanel 调试展示 ──
    // 此处 messages 已经是 strip 后的最终版本（即 AI 实际接收的内容）
    // 2026-04-14：同时携带 messageSources 并行数组，让 PromptAssemblyPanel
    // 能标注每条消息的出处（prompt 模块 / narrative 历史 / 当前输入）。
    //
    // 2026-04-19：split-gen 必须用不同的 generationId 区分 step1/step2，否则
    // `attachResponse` 的 "generationId 匹配" 会错把两次 response 都挂到同一条
    // snapshot 上（由于 unshift，step2 snapshot 永远在前面，step1 永远拿不到）。
    //
    // 2026-04-19 (round 2)：step2 的最终消息在 ai-call.ts 才被拼完整
    // （追加 `step1 thinking 注入` + `{role:assistant, content: rawStep1}` +
    // `{role:user, content: STEP2_FOLLOWUP_USER}`），此处 splitStep2Messages
    // 只是 flow-assembled 部分。如果现在就 emit step2 snapshot，面板看到的
    // 永远是**不完整**的 prompt —— 缺最后 2-3 条关键消息，调试价值大减。
    // 改为只 emit step1；step2 由 ai-call 在拼完整后自己 emit。
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

  /**
   * The variables of the Step 2 flow: the round's variables plus the plot block of Step 2 and the history framing.
   * Key order matters (the debug panel and the snapshots show it): round variables first, then the plot ones, then
   * the framing flag.
   */
  private step2Variables(variables: Record<string, string>, ctx: PipelineContext): Record<string, string> {
    return {
      ...variables,
      ...PlotInjector.buildStep2Variables(this.stateManager, this.paths, this.pack.engineFragments),
      HISTORY_FRAMING_STEP2: ctx.meta.plotVectorPromptMode ? '' : '1',
    };
  }

  /**
   * Looks up the flow a split-gen step is assembled from: the override the caller named in `ctx.meta`, else the
   * default. A named override that the pack lacks stops an enhanced opening (it cannot proceed without its own
   * flows) and falls back to the default flow, with a warning, for every other round.
   */
  private resolveFlowOverride(ctx: PipelineContext, step: 'step1' | 'step2', defaultFlowId: string) {
    const overrideId = (step === 'step1' ? ctx.meta.step1FlowOverride : ctx.meta.step2FlowOverride) as string | undefined;
    const flow = this.pack.promptFlows[overrideId ?? defaultFlowId];
    if (overrideId && !this.pack.promptFlows[overrideId]) {
      if (ctx.meta.isEnhancedOpening) {
        throw new Error(`[ContextAssembly] Required flow override '${overrideId}' not found — Enhanced Opening cannot proceed`);
      }
      console.warn(`[ContextAssembly] ${step}FlowOverride '${overrideId}' not found, falling back to default`);
    }
    return flow;
  }
}

export { buildBookmarkedRoundsBlock } from './context-assembly-inputs';
