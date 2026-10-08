/**
 * The inputs of one round's prompt: everything read from the save, the settings and the memory, before any request is
 * assembled. Split out of `ContextAssemblyStage.execute()` (refactor R1 step 2). The order of the reads is the order
 * the round has always used; do not reorder them (the prompt transform runs before this, retrieval before the NPC
 * tiers, the behaviour hooks after the plot variables).
 */
import type {
  PipelineContext,
  IMemoryRetriever,
  IBehaviorRunner,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
  BookmarkedRound,
} from '../types';
import type { AIMessage } from '../../ai/types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import { storyLines, storyText } from '../../core/narrative-brackets';
import { stringifySnapshotForPrompt } from '../../memory/snapshot-sanitizer';
import { LEGACY_FEW_SHOT_PAIRS } from '../../prompt/context-compiler';
import { NpcPresenceService, type NpcRecord } from '../../social/npc-presence';
import { NpcContextRenderer } from '../../social/npc-context-renderer';
import { NpcRelevanceScorer, DEFAULT_NPC_RELEVANCE_CONFIG } from '../../social/npc-relevance-scorer';
import { buildNarrativeContractFromState } from '../../prompt/narrative-contract';
import { buildCharacterVectorsFromState, lastNarrativeText } from '../../prompt/character-vectors';
import { hasSettingTag, parseSettingTagNames } from '../../prompt/setting-tag-scanner';
import { DEFAULT_PROMPT_SETTINGS, actionOptionsOn, wordCountRangeOf } from '../../prompt/world-book';
import type { PromptSettings, WorldBook } from '../../prompt/world-book';
import { buildEnvironmentBlock } from '../../prompt/environment-block';
import { PlotInjector } from '../../plot/plot-injector';
import { plotGaugeNames, findGaugeShadowPaths } from '../../plot/gauge-shadow';
import { schemaDeclaresPath } from '../../core/command-executor';

/** 状态树中叙事历史条目的结构 — 从 "元数据.叙事历史" 读取 */
export interface NarrativeEntry {
  role: string;
  content: string;
}

/** What the input collection needs from the stage. */
export interface RoundInputDeps {
  readonly stateManager: StateManager;
  readonly memoryRetriever: IMemoryRetriever;
  readonly pack: GamePack;
  readonly paths: EnginePathConfig;
  readonly engramManager?: IEngramManager;
  readonly unifiedRetriever?: IUnifiedRetriever;
  readonly getWorldBooks?: () => WorldBook[];
}

/** What the flow-variable table needs from the stage. */
export interface FlowVariableDeps {
  readonly stateManager: StateManager;
  readonly pack: GamePack;
  readonly paths: EnginePathConfig;
  readonly behaviorRunner: IBehaviorRunner;
}

export interface RoundPromptInputs {
  readonly historyText: ((text: string) => string) | undefined;
  readonly stateSnapshot: ReturnType<StateManager['toSnapshot']>;
  readonly memoryBlock: string;
  readonly shortTermText: string;
  readonly nsfwMode: boolean;
  readonly presenceEnabled: boolean;
  readonly gameStateJson: string;
  readonly gaugeShadowPaths: string[];
  readonly actionMode: 'action' | 'story';
  readonly actionPace: 'fast' | 'slow';
  readonly customActionPrompt: string;
  readonly openingSetupHint: string;
  readonly paceHint: string;
  readonly npcPresentBlock: string;
  readonly npcAbsentBlock: string;
  readonly cotEnabled: boolean;
  readonly cotJudgeEnabled: boolean;
  readonly cotInjectStep2: boolean;
  readonly prevThinkingBlock: string;
  readonly prevStoryPlan: string;
  readonly environmentBlock: string;
  readonly bookmarkedRoundsBlock: string;
  readonly actionOptionsEnabled: boolean;
  readonly lengthAsked: ReturnType<typeof wordCountRangeOf>;
  readonly settingCaptureActive: boolean;
  readonly narrativeContract: ReturnType<typeof buildNarrativeContractFromState>['contract'];
  readonly focalCast: ReturnType<typeof buildNarrativeContractFromState>['cast'];
  readonly narrativeContractBlock: string;
  readonly characterVectors: ReturnType<typeof buildCharacterVectorsFromState>['vectors'];
  readonly vectorScope: ReturnType<typeof buildCharacterVectorsFromState>['scope'];
  readonly characterVectorsBlock: string;
  readonly narrativeHistory: NarrativeEntry[];
  readonly historyPairs: (pairs: number) => AIMessage[];
  readonly chatHistory: AIMessage[];
  readonly mergedWorldBooks: WorldBook[];
}

/**
 * Reads everything this round's prompt is built from. Writes `ctx.meta.npcRelevance` and `ctx.meta.engramRead` in
 * place, as the stage always did. Must run after the prompt transform (it reads `ctx.meta.historyStoryOnly`).
 */
export async function collectRoundInputs(deps: RoundInputDeps, ctx: PipelineContext): Promise<RoundPromptInputs> {
    // The model's view of recent story, without system lines when the active component asks for it
    // (PipelineMeta.historyStoryOnly, set by the transform above). Player input is never changed.
    const storyOnly = ctx.meta.historyStoryOnly === true;
    // The save's plot gauges: their status lines are left out of that view (ModelStoryOptions), and copies of them
    // written elsewhere in the save are never shown (gauge shadows, below).
    const gaugeNames = plotGaugeNames(deps.stateManager, deps.paths.plotDirection);
    const modelStory = { dropBracketsAfterSystemLines: true, gaugeNames };
    const historyText = storyOnly ? (text: string): string => storyText(text, modelStory) : undefined;
    const story = (text: string): string => (historyText ? historyText(text) : text);
    // ── 1. 冻结状态树快照 ──
    const stateSnapshot = deps.stateManager.toSnapshot();

    // ── 3. 记忆检索（E.2：按 retrievalMode 选择检索路径） ──
    // 参照 ming: 短期记忆单独作为 assistant 消息注入 chat history (depth=2)
    // MEMORY_BLOCK 只包含中期/长期/隐式中期（避免重复注入短期）
    const retrieved = await retrieveMemory(deps, ctx.userInput, ctx);
    // The memory block quotes recent story too (the keyword retriever's short-term section; event snippets): the
    // same view applies to it, line by line, so a snippet cut inside a bracket never takes the next bullets along.
    const memoryBlock = storyOnly && retrieved ? storyLines(retrieved, modelStory) : retrieved;

    // 读取短期记忆用于单独注入（参照 ming: 短期记忆作为独立 assistant 消息注入 chat history 末端）
    // 路径来自 memoryPathConfig，默认 '记忆.短期'
    const shortTermEntries = deps.stateManager.get<Array<{ summary: string; round?: number }>>(
      '记忆.短期'
    ) ?? [];
    const shortTermJoined = shortTermEntries.map((e) => story(typeof e === 'string' ? e : (e.summary ?? ''))).join('\n');
    const shortTermTemplate = deps.pack.engineFragments?.shortTermMemoryHeader
      ?? '# 【最近事件】\n{entries}。根据这刚刚发生的文本事件，合理生成下一次文本信息，要保证衔接流畅、不断层，符合上文的文本信息';
    const shortTermText = shortTermEntries.length > 0
      ? shortTermTemplate.replace('{entries}', shortTermJoined)
      : '';

    // ── 4. 构建模板变量 ──
    // ── NSFW 脱敏 — §11.2 C ──
    // nsfwMode=false 时从发给 AI 的 JSON 快照剥离 私密信息 和 角色.身体，
    // 原始状态树保持不变（存档完整，UI 可继续显示）。
    const nsfwMode = deps.stateManager.get<boolean>('系统.nsfwMode') === true;
    const presenceEnabled = deps.stateManager.get<boolean>('系统.设置.social.presenceEnabled') === true;
    // 2026-04-11 token 节省：
    // 1. 去重：叙事历史 / 记忆 / engramMemory / 上次对话前快照 **无条件**从 JSON 剥离
    //    （它们通过 chatHistory + MEMORY_BLOCK 等专用渠道独立注入，不应再在
    //     GAME_STATE_JSON 里重复）
    // 2. 紧凑：indent=0 去掉 JSON 缩进空白，单回合 prompt 可节省数千 token
    // 见 `snapshot-sanitizer.ts` 的 `PROMPT_ALWAYS_STRIP_PATHS` 注释。
    // 2026-05-28: When presenceEnabled, NPC data is injected via presencePartition
    // template (tiered by relevance). Strip from GAME_STATE_JSON to avoid duplication.
    // Gauge shadows (gauge-shadow.ts): copies of a plot gauge an older round wrote elsewhere in the save drifted from
    // the real value; the model reads the gauge from the plot directive only. The save keeps them (PO 2026-10-05).
    const schema = deps.pack.stateSchema;
    const gaugeShadowPaths = schema
      ? findGaugeShadowPaths(stateSnapshot, gaugeNames, (path) => schemaDeclaresPath(schema, path), deps.paths.plotDirection)
      : [];
    const stateStripPaths = [...(presenceEnabled ? ['社交.关系'] : []), ...gaugeShadowPaths];
    const gameStateJson = stringifySnapshotForPrompt(
      stateSnapshot, nsfwMode, 0,
      stateStripPaths.length > 0 ? stateStripPaths : undefined,
    );

    // ── 4a. 行动选项模式 (bugfix 2026-04-11) ──
    //
    // User report：剧情导向和行为导向 prompt 应不一样，demo 有实现，但正式版里
    // `actionOptions.md` / `actionOptionsStory.md` 俩 prompt 存在却从未被任何 flow
    // 加载，且 SettingsPanel 的 mode/pace setting 只存 localStorage，pipeline 看不见。
    //
    // 修复策略：
    //   1. SettingsPanel 把 mode/pace/customPrompt 同步写到状态树 `系统.actionOptions.*`
    //   2. 此处读取后派生出条件变量 `ACTION_OPTIONS_MODE_IS_ACTION` / `_IS_STORY`
    //   3. main-round.json 和 split-gen-main-round-step2.json 用 `condition` 字段
    //      按模式动态加载 `actionOptions` 或 `actionOptionsStory` prompt 模块
    //   4. `ACTION_PACE_HINT` / `CUSTOM_ACTION_PROMPT` 作为模板变量供 prompt 内部引用
    //
    // Fallback：状态树未设置时默认 'action' + 'fast'（保持之前的行为导向行为）
    // Anything but the two known values (a damaged save, an imported card's typo) reads as the default, so the
    // options never go missing while the switch is on.
    const actionMode: 'action' | 'story' = deps.stateManager.get<unknown>('系统.actionOptions.mode') === 'story' ? 'story' : 'action';
    const actionPace: 'fast' | 'slow' = deps.stateManager.get<unknown>('系统.actionOptions.pace') === 'slow' ? 'slow' : 'fast';
    const customActionPrompt = deps.stateManager.get<string>('系统.actionOptions.customPrompt') ?? '';
    // D7: author opening-style hint (card import Phase E only; absent for every other call).
    const openingSetupHint = typeof ctx.meta['openingSetupHint'] === 'string'
      ? (ctx.meta['openingSetupHint'] as string).trim()
      : '';

    const defaultPaceSlow = '## 节奏提示\n\n当前节奏为**慢节奏**：倾向于生成更细腻、更思考性的选项，鼓励观察、对话、深度互动；避免催促性的推进动作。';
    const defaultPaceFast = '## 节奏提示\n\n当前节奏为**快节奏**：倾向于生成推进剧情的选项，鼓励明确的行动和决策；避免纯观察或等待。';
    const paceHint = actionPace === 'slow'
      ? (deps.pack.engineFragments?.paceSlow ?? defaultPaceSlow)
      : (deps.pack.engineFragments?.paceFast ?? defaultPaceFast);

    // ── NPC Presence + Relevance filtering ──
    // When Engram is active with knowledge edges, uses NpcRelevanceScorer to
    // tier NPCs by plot relevance, reducing token waste on irrelevant NPCs.
    // Falls back to flat present/absent split when Engram is unavailable.
    let npcPresentBlock = '';
    let npcAbsentBlock = '';
    if (presenceEnabled) {
      const presenceSvc = new NpcPresenceService(deps.stateManager, deps.paths);
      const renderer = new NpcContextRenderer(presenceSvc, deps.paths);

      const engramConfig = deps.engramManager?.getConfig();
      const useRelevanceFilter =
        engramConfig?.enabled === true &&
        engramConfig?.knowledgeEdgeMode === 'active' &&
        deps.unifiedRetriever?.lastReadSnapshot != null &&
        engramConfig?.npcRelevanceFilter?.enabled !== false;

      if (useRelevanceFilter) {
        const engramData = deps.stateManager.get<{
          entities?: Array<{ name: string; type: string; lastSeen?: number; firstSeen: number; mentionCount: number; summary: string; is_embedded: boolean; attributes: Record<string, unknown> }>;
          v2Edges?: import('../../memory/engram/knowledge-edge').EngramEdge[];
        }>(deps.paths.engramMemory);
        const allNpcs = deps.stateManager.get<NpcRecord[]>(deps.paths.relationships) ?? [];
        const nameField = deps.paths.npcFieldNames?.name ?? '名称';
        const playerName = deps.stateManager.get<string>(deps.paths.playerName) ?? '';

        const filterConfig = engramConfig?.npcRelevanceFilter;
        const scorer = new NpcRelevanceScorer(filterConfig ? {
          recentRoundWindow: filterConfig.recentRoundWindow,
          bfsHops: filterConfig.bfsHops,
          minNpcCountForFilter: filterConfig.minNpcCountForFilter,
          playerAliases: deps.pack.engineFragments?.playerAliases as string[] | undefined ?? ['玩家'],
        } : {
          ...DEFAULT_NPC_RELEVANCE_CONFIG,
          playerAliases: deps.pack.engineFragments?.playerAliases as string[] | undefined ?? ['玩家'],
        });
        const relevance = scorer.score({
          readSnapshot: deps.unifiedRetriever!.lastReadSnapshot ?? null,
          engramEntities: (engramData?.entities ?? []) as import('../../memory/engram/entity-builder').EngramEntity[],
          engramEdges: engramData?.v2Edges ?? [],
          currentRound: deps.stateManager.get<number>(deps.paths.roundNumber) ?? 0,
          allNpcNames: allNpcs.map(n => String(n[nameField] ?? '')).filter(Boolean),
          playerName,
        });

        if (!relevance.skipped) {
          const tiered = renderer.renderTiered(relevance.relevantNames, relevance.npcSignalCounts);
          npcPresentBlock = tiered.presentBlock;
          npcAbsentBlock = tiered.absentBlock;

          const { fromSnapshot, fromRecentActivity, fromBfsExpansion } = relevance.signals;
          const signalLookup = (name: string): string[] => {
            const s: string[] = [];
            if (fromSnapshot.includes(name)) s.push('snapshot');
            if (fromRecentActivity.includes(name)) s.push('recent');
            if (fromBfsExpansion.includes(name)) s.push('bfs');
            return s;
          };
          ctx.meta['npcRelevance'] = {
            ...tiered.stats,
            signals: relevance.signals,
            tiers: {
              tier1: tiered.tierNames.tier1.map(name => ({ name, signals: signalLookup(name) })),
              tier2Present: tiered.tierNames.tier2Present.map(name => ({ name })),
              tier2Absent: tiered.tierNames.tier2Absent.map(name => ({ name, signals: signalLookup(name) })),
              tier3: tiered.tierNames.tier3.map(name => ({ name })),
            },
          };
        } else {
          const split = renderer.renderSplit();
          npcPresentBlock = split.presentBlock;
          npcAbsentBlock = split.absentBlock;
        }
      } else {
        const split = renderer.renderSplit();
        npcPresentBlock = split.presentBlock;
        npcAbsentBlock = split.absentBlock;
      }
    }

    // ── CoT flags (Sprint CoT-2) — read once, freeze into ctx.meta ──
    const cotEnabled = deps.stateManager.get<boolean>('系统.设置.cot.enabled') === true;
    const cotJudgeEnabled = cotEnabled && deps.stateManager.get<boolean>('系统.设置.cot.judgeEnabled') === true;
    const cotInjectStep2 = cotEnabled && deps.stateManager.get<boolean>('系统.设置.cot.injectStep2') !== false;
    console.debug('[ContextAssembly] CoT flags:', { cotEnabled, cotJudgeEnabled, cotInjectStep2 });
    console.debug('[ContextAssembly] Short-term entries:', shortTermEntries.length, 'Memory block length:', memoryBlock.length);

    const reasoningHistory = cotEnabled
      ? (deps.stateManager.get<string[]>(deps.paths.reasoningHistory) ?? [])
      : [];
    const prevThinking = reasoningHistory.length > 0
      ? reasoningHistory[reasoningHistory.length - 1]
      : '';
    // The previous round's thinking for the CoT module's {{PREV_THINKING}} (CoT-2 design, connected 2026-10-05 4A),
    // framed by the pack so the model reads it as continuity, not a script to repeat; bare when a pack has no frame.
    // A feature-switch comment in the model's own words is defused, so no prompt filter acts on it (review M2).
    const prevThinkingBlock = typeof prevThinking === 'string' && prevThinking.trim()
      ? (deps.pack.engineFragments?.prevThinkingHeader ?? '{content}')
        .replace('{content}', () => prevThinking.trim().replace(/<!--(\s*)PROMPT_FEATURE/gi, '<!-$1PROMPT-FEATURE'))
      : '';

    const storyPlanRaw = cotEnabled
      ? (deps.stateManager.get<string>(deps.paths.storyPlan) ?? '')
      : '';
    const prevStoryPlan = storyPlanRaw;

    // ── Environment tags (P2 env-tags port, 2026-04-19) ──
    //
    // Build the `【当前环境】` block from 世界.天气 / 世界.节日 / 世界.环境.
    // The same data is already inside GAME_STATE_JSON (P0 sanitizer guards
    // them), but an explicit section with plain-language formatting raises
    // AI attention. Also forwarded to `ctx.meta.environmentBlock` so
    // BodyPolishStage can inject it into the polish user message as a
    // read-only reference (polish must not contradict active weather).
    const environmentBlock = buildEnvironmentBlock({
      weather: deps.stateManager.get<unknown>(deps.paths.weather),
      festival: deps.stateManager.get<unknown>(deps.paths.festival),
      environment: deps.stateManager.get<unknown>(deps.paths.environmentTags),
    });

    // ── Bookmarked rounds (收藏楼层) — one-shot injection block ──
    //
    // Player-curated important rounds. Only entries flagged `pending=true`
    // (selected by the player) are injected, ONCE, into this round's prompt.
    // PostProcessStage clears `pending` at round end so the same selection
    // does not leak into subsequent rounds (one-shot semantic, PM decision
    // 2026-07-18). Empty when nothing is selected → placeholder disappears.
    const bookmarkedRoundsBlock = buildBookmarkedRoundsBlock(
      deps.stateManager.get<BookmarkedRound[]>(deps.paths.bookmarkedRounds) ?? [],
      deps.pack.engineFragments?.bookmarkedRoundsHeader,
      deps.pack.engineFragments?.bookmarkedRoundsEntryFormat,
    );

    // ── 6b. Canon Capture: is this round carrying a <设定> tag? ──
    //
    // Evidence is validated against `originalUserInput` (PreProcess prepends the action
    // queue to `userInput`, and that text must never count as something the PLAYER
    // wrote). The same pristine string decides whether the capture prompts are injected
    // at all, so the prompt and the gate can never disagree about what round this is.
    const promptSettings: PromptSettings = {
      ...DEFAULT_PROMPT_SETTINGS,
      ...(deps.stateManager.get<Partial<PromptSettings>>('系统.设置.prompt') ?? {}),
    };
    const actionOptionsEnabled = actionOptionsOn(promptSettings);
    const lengthAsked = wordCountRangeOf(promptSettings);
    const settingTagNames = parseSettingTagNames(deps.pack.engineFragments?.settingTagNames);
    const settingCaptureActive =
      promptSettings.enableWorldBook !== false &&
      promptSettings.enableSettingCapture !== false &&
      hasSettingTag(ctx.originalUserInput ?? ctx.userInput ?? '', settingTagNames);

    // ── 6c. Narrative Contract (R2, 2026-09-05) ──
    //
    // The player's sparse "melody" for this save (clauses at `paths.narrativeContract`)
    // plus the focal cast derived every round from the relationship list (「重点」 type
    // ∪ 「关注」 flag — PO decision Q5-D, no stored list). Computed ONCE here and sent to
    // BOTH split steps via `NARRATIVE_CONTRACT_BLOCK`: step1 as a builder piece, step2
    // (and the legacy flows) as a flow module gated by `NARRATIVE_CONTRACT`. The Context
    // Compiler never deduplicates it. Empty contract → '' → nothing injected, so saves
    // that never use the feature keep byte-identical prompts.
    // Design: docs/design/narrative-contract-positioning.md §4.2.
    const {
      contract: narrativeContract,
      cast: focalCast,
      block: narrativeContractBlock,
    } = buildNarrativeContractFromState(deps.stateManager, deps.paths, deps.pack.engineFragments);

    // ── 6d. Character Vectors (R2 second half, 2026-09-06) ──
    //
    // Per-NPC "potential vectors" (`paths.characterVectors`), PROJECTED to this turn: only
    // NPCs present in the scene, named in the player input or named in the previous
    // narrative get a line; the protagonist never does. Sent to both split steps like the
    // contract (builder piece `character_vectors` / flow module `characterVectors`).
    // Empty scope → '' → byte-identical prompts. Design: character-vector-v1 plan §2.
    const {
      vectors: characterVectors,
      scope: vectorScope,
      block: characterVectorsBlock,
    } = buildCharacterVectorsFromState(deps.stateManager, deps.paths, deps.pack.engineFragments, {
      userInput: ctx.originalUserInput ?? ctx.userInput ?? '',
      lastNarrative: lastNarrativeText(deps.stateManager, deps.paths),
    });
    // ── 6. 从状态树读取叙事历史 → AIMessage[] ──
    //
    // 2026-04-11 强化：给每条 history 消息包一层 XML 标签。
    //
    // 原因：demo 的 chat history 里 assistant 消息存的是**完整 raw JSON 输出**
    // （包含 text + commands + mid_term_memory + action_options），模型看自己
    // 的历史能立即感知到"我之前一直是这个格式"—— few-shot 效应下新回合也会
    // 保持同样格式。
    //
    // AutoGameAgent 为了节省存档体积，只存 `parsedResponse.text`（纯叙事
    // 文本），这破坏了 few-shot 信号。模型看历史会怀疑"之前的 assistant 没
    // 输 JSON，我也不用输"，导致格式漂移。
    //
    // 之前已用 `historyFraming.md` 系统提示词**显式解释**这个现象，但那是
    // "软"信号 —— 模型可能被历史里的隐式格式盖过。此处再加一层 XML 包装
    // 作为**双重约束**：
    //   user:      <玩家输入>...</玩家输入>
    //   assistant: <叙事正文>...</叙事正文>
    //
    // 这样模型看到的 few-shot 模式是"user 发 <玩家输入> tag，assistant 回
    // <叙事正文> tag"—— 显而易见的结构。旧模式仍配合 historyFraming
    // 说明完整 JSON；新动能模式的 Step2 会跳过那段与分步格式冲突的说明。
    // 单步路径最终 AI 的输出：
    //   {
    //     "text": "<content matches previous 叙事正文 style>",
    //     "commands": [...], "action_options": [...], "mid_term_memory": ...
    //   }
    //
    // 存档里 narrativeHistory 仍然是纯文本，包装只在 prompt assembly 时发生，
    // 不影响 UI 展示和存档体积。
    const narrativeHistory =
      deps.stateManager.get<NarrativeEntry[]>(deps.paths.narrativeHistory) ?? [];

    // ── few-shot 历史对裁剪 ──
    //
    // 2026-09-04（Context Compiler v1，PO 决议 Q3）：`fewShotPairs` / `shortTermInjectionStyle`
    // 两个玩家设置已移除。历史对数改为常量：新路径 step2 在编译器开启时 2 对
    // （A/B：1 对出现 2/10 JSON 畸形，5 对 0/10；2 对是 schema 范例的最小充分量），
    // 编译器关闭与 legacy 路径沿用旧默认 3 对。新路径 step1 不消费 chatHistory
    // （builder 用短期记忆单块），所以这里只影响 step2 / legacy。
    const wrap = (m: NarrativeEntry): AIMessage => {
      const role = m.role as AIMessage['role'];
      let wrapped = m.content;
      if (role === 'user') {
        wrapped = `<玩家输入>\n${m.content}\n</玩家输入>`;
      } else if (role === 'assistant') {
        wrapped = `<叙事正文>\n${story(m.content)}\n</叙事正文>`;
      }
      return { role, content: wrapped };
    };
    // 假设历史中 user / assistant 严格交替：从尾部向前取 2N 条即可（超过起点则截断）
    const historyPairs = (pairs: number): AIMessage[] => narrativeHistory.slice(-(pairs * 2)).map(wrap);
    const chatHistory: AIMessage[] = historyPairs(LEGACY_FEW_SHOT_PAIRS);

    // ── 6c. Merge profile world books with this slot's auto-settings book ──
    //
    // Two storage homes, ONE runtime contract: profile books live in IndexedDB (shared
    // across slots), the captured book lives in the state tree (slot-scoped, rolls back
    // with the round). They go through the same selector, formatter and budget — Canon
    // Capture deliberately does not add a second injection path.
    const profileWorldBooks = deps.getWorldBooks?.() ?? [];
    const slotWorldBooks = deps.stateManager.get<WorldBook[]>(deps.paths.slotWorldBooks);
    const mergedWorldBooks = Array.isArray(slotWorldBooks) && slotWorldBooks.length > 0
      ? [...profileWorldBooks, ...slotWorldBooks]
      : profileWorldBooks;

  return {
    historyText,
    stateSnapshot,
    memoryBlock,
    shortTermText,
    nsfwMode,
    presenceEnabled,
    gameStateJson,
    gaugeShadowPaths,
    actionMode,
    actionPace,
    customActionPrompt,
    openingSetupHint,
    paceHint,
    npcPresentBlock,
    npcAbsentBlock,
    cotEnabled,
    cotJudgeEnabled,
    cotInjectStep2,
    prevThinkingBlock,
    prevStoryPlan,
    environmentBlock,
    bookmarkedRoundsBlock,
    actionOptionsEnabled,
    lengthAsked,
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
  };
}

/**
 * The variable table of the flow templates: the round's variables, then the plot ones, then whatever the behaviour
 * hooks change. The hooks edit this same object in place, so the order of the keys and every later use of the table
 * (the debug panel, Step 2, the plot directive) see their result.
 */
export function buildFlowVariables(deps: FlowVariableDeps, ctx: PipelineContext, inputs: RoundPromptInputs): Record<string, string> {
  const {
    gameStateJson,
    memoryBlock,
    lengthAsked,
    settingCaptureActive,
    narrativeContractBlock,
    characterVectorsBlock,
    actionOptionsEnabled,
    actionMode,
    actionPace,
    paceHint,
    customActionPrompt,
    openingSetupHint,
    cotEnabled,
    cotJudgeEnabled,
    cotInjectStep2,
    prevThinkingBlock,
    prevStoryPlan,
    presenceEnabled,
    npcPresentBlock,
    npcAbsentBlock,
    environmentBlock,
    bookmarkedRoundsBlock,
  } = inputs;

    const variables: Record<string, string> = {
      PLAYER_NAME: deps.stateManager.get<string>(deps.paths.playerName) ?? '',
      CURRENT_LOCATION: deps.stateManager.get<string>(deps.paths.playerLocation) ?? '',
      GAME_STATE_JSON: gameStateJson,
      MEMORY_BLOCK: memoryBlock,
      USER_INPUT: ctx.userInput,
      // The player's target length and its band, which the length module and the format prompts state (the builder
      // fills the same names).
      wordCount: String(lengthAsked.target),
      wordCountMin: String(lengthAsked.min),
      wordCountMax: String(lengthAsked.max),

      // Canon Capture: drives the `settingCapture` module in the split-gen step2 flow.
      // It MUST be a flow `condition` rather than a `PROMPT_FEATURE` block — the
      // PromptAssembler only does template rendering and never strips feature comments,
      // so an HTML-comment block would be shipped to the model verbatim.
      SETTING_CAPTURE_ACTIVE: settingCaptureActive ? '1' : '',

      // Narrative Contract: flow-module condition + the rendered block (see 6c above).
      NARRATIVE_CONTRACT: narrativeContractBlock ? '1' : '',
      NARRATIVE_CONTRACT_BLOCK: narrativeContractBlock,
      // Character Vectors: flow-module condition + the projected block (see 6d above).
      CHARACTER_VECTORS: characterVectorsBlock ? '1' : '',
      CHARACTER_VECTORS_BLOCK: characterVectorsBlock,

      // Action options wiring — 条件变量 + 内容注入. The player's switch decides first: off, neither options module
      // loads and the "off" module says so after everything that asks for options (PO 2026-10-03).
      ACTION_OPTIONS_MODE: actionMode,
      ACTION_OPTIONS_MODE_IS_ACTION: actionOptionsEnabled && actionMode === 'action' ? '1' : '',
      ACTION_OPTIONS_MODE_IS_STORY: actionOptionsEnabled && actionMode === 'story' ? '1' : '',
      ACTION_OPTIONS_OFF: actionOptionsEnabled ? '' : '1',
      ACTION_OPTIONS_PACE: actionPace,
      ACTION_PACE_HINT: paceHint,
      CUSTOM_ACTION_PROMPT: customActionPrompt
        ? (deps.pack.engineFragments?.customActionHeader ?? '## 自定义附加要求\n\n{content}').replace('{content}', customActionPrompt)
        : '',

      // D7: author opening-style hint (card import only). Framed block when present, empty otherwise
      // (mirrors CUSTOM_ACTION_PROMPT). Surfaced to the Phase E1 prompt via {{OPENING_SETUP_HINT}}.
      OPENING_SETUP_HINT: openingSetupHint
        ? (deps.pack.engineFragments?.openingSetupHintHeader ?? '## 作者开场提示（请据此把握开场叙事的风格与基调）\n\n{content}').replace('{content}', openingSetupHint)
        : '',

      // ── CoT plugin variables (Sprint CoT-2) ──
      // Flag frozen at context-assembly time → downstream stages read from ctx.meta
      COT_ENABLED: cotEnabled ? '1' : '',
      COT_DISABLED: cotEnabled ? '' : '1',
      COT_JUDGE_ENABLED: cotJudgeEnabled ? '1' : '',
      COT_INJECT_STEP2_ENABLED: cotInjectStep2 ? '1' : '',
      PREV_THINKING: prevThinkingBlock,
      PREV_STORY_PLAN: prevStoryPlan,

      // ── NPC Presence plugin variables (Sprint Social-2) ──
      NPC_PRESENCE_ENABLED: presenceEnabled ? '1' : '',
      NPC_PRESENT_BLOCK: npcPresentBlock,
      NPC_ABSENT_BLOCK: npcAbsentBlock,

      // ── Environment tags plugin variable (P2 env-tags port 2026-04-19) ──
      ENVIRONMENT_BLOCK: environmentBlock,

      // ── Bookmarked rounds one-shot injection (收藏楼层 2026-07-18) ──
      BOOKMARKED_ROUNDS_BLOCK: bookmarkedRoundsBlock,
    };

    // ── 4.5 Plot Direction System variables (Sprint Plot-1 P2) ──
    {
      const plotEnabled = deps.stateManager.get<boolean>('系统.设置.plot.enabled');
      if (plotEnabled !== false) {
        const splitGen = ctx.meta['splitGen'] === true;
        const plotVars = splitGen
          ? PlotInjector.buildStep1Variables(deps.stateManager, deps.paths, deps.pack.engineFragments)
          : PlotInjector.buildAllVariables(deps.stateManager, deps.paths, deps.pack.engineFragments);
        Object.assign(variables, plotVars);
      }
    }

    // ── 5. 行为模块：上下文组装阶段钩子 ──
    deps.behaviorRunner.runOnContextAssembly(deps.stateManager, variables);

  return variables;
}

/**
 * 根据 Engram 配置选择检索路径（E.2 新增）
 *
 * - engram.enabled && retrievalMode='hybrid' → UnifiedRetriever（向量+图+三元组+NPC规则）
 * - 其他情况 → legacy MemoryRetriever（传统关键词+时间衰减）
 */
async function retrieveMemory(deps: RoundInputDeps, userInput: string, ctx?: PipelineContext): Promise<string> {
  const engramConfig = deps.engramManager?.getConfig();

  const useHybrid =
    engramConfig?.enabled === true &&
    engramConfig?.retrievalMode === 'hybrid' &&
    deps.unifiedRetriever != null;

  if (useHybrid && deps.unifiedRetriever) {
    const playerName = deps.stateManager.get<string>(deps.paths.playerName) ?? '';
    const locationDesc = deps.stateManager.get<string>(deps.paths.playerLocation) ?? '';

    try {
      const result = await deps.unifiedRetriever.retrieve(
        userInput,
        {
          playerName,
          locationDesc,
          recentNpcNames: extractRecentNpcNames(deps),
        },
        deps.stateManager,
      );
      if (ctx && deps.unifiedRetriever.lastReadSnapshot) {
        ctx.meta['engramRead'] = deps.unifiedRetriever.lastReadSnapshot;
      }
      return result;
    } catch (err) {
      console.warn('[ContextAssembly] UnifiedRetriever failed, falling back to legacy:', err);
    }
  }

  const playerName = deps.stateManager.get<string>(deps.paths.playerName) ?? '';
  return deps.memoryRetriever.retrieve(deps.stateManager, {
    playerName,
    recentNpcNames: extractRecentNpcNames(deps),
  });
}

/**
 * 从 Engram 实体列表中提取最近活跃的 NPC 名称。
 *
 * 读取状态树中 `系统.扩展.engramMemory.entities`，筛选 type='npc' 的节点，
 * 按 lastSeen 降序排列，取最近 10 个名称，供 UnifiedRetriever 的 NPC 规则分支使用。
 *
 * 此处不依赖 EngramManager 接口（避免循环依赖），直接从 StateManager 读取已持久化的数据。
 */
function extractRecentNpcNames(deps: RoundInputDeps): string[] {
  try {
    const engramData = deps.stateManager.get<{
      entities?: Array<{ name: string; type: string; lastSeen?: number }>;
    }>(deps.paths.engramMemory);
    if (!engramData?.entities) return [];

    return engramData.entities
      .filter((e) => e.type === 'npc')
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .slice(0, 10)
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 每条收藏正文的注入截断上限（字符）。收藏是玩家手选、数量少，但单条正文可能很长，
 * 为防 token 失控做保守截断。超出加省略号。
 */
const BOOKMARK_CONTENT_INJECT_CAP = 600;

/**
 * 组装"收藏楼层"一次性注入块。
 *
 * 只纳入 `pending=true` 的收藏（玩家已勾选、要求本回合参考）。空 → 返回空字符串，
 * 使 prompt 里的 `{{BOOKMARKED_ROUNDS_BLOCK}}` 占位符自然消失。
 *
 * 引擎/内容分离：**外层模板**与**每条格式**都可由 pack 覆写，引擎只提供中文默认
 * 作为兜底（与 `shortTermMemoryHeader` 等既有 engineFragments 同一约定）：
 * - `engineFragments.bookmarkedRoundsHeader` —— 外层，`{entries}` 占位符。
 * - `engineFragments.bookmarkedRoundsEntryFormat` —— 单条，占位符 `{name}` `{round}` `{content}`。
 *
 * 纯函数 —— 供单元测试直接调用（无需 StateManager）。
 */
export function buildBookmarkedRoundsBlock(
  bookmarks: readonly BookmarkedRound[],
  headerTemplate?: string,
  entryFormat?: string,
): string {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return '';
  const selected = bookmarks.filter((b) => b && b.pending === true);
  if (selected.length === 0) return '';

  const fmt = entryFormat ?? '〔收藏·第{round}回合·{name}〕{content}';
  const entries = selected
    .map((b) => {
      const content = typeof b.content === 'string' ? b.content : '';
      const clipped = content.length > BOOKMARK_CONTENT_INJECT_CAP
        ? content.slice(0, BOOKMARK_CONTENT_INJECT_CAP) + '…'
        : content;
      const label = (b.name && b.name.trim()) ? b.name.trim() : String(b.round);
      return fmt
        .replace('{name}', label)
        .replace('{round}', String(b.round))
        .replace('{content}', clipped);
    })
    .join('\n');

  const template = headerTemplate
    ?? '## 玩家收藏的历史片段（仅供参考，非当前场景）\n以下是玩家从过往回合中手动收藏、希望你本回合创作时记住的关键片段。它们可能来自较早的剧情，仅作背景参考——切勿将其误当作刚刚发生的最新事件或当前所在场景；每条开头的「第N回合」标明它发生的时间点。\n{entries}';
  return template.replace('{entries}', entries);
}
