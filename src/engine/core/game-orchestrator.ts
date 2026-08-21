/**
 * 游戏编排器 — 接通 pipeline:user-input 事件到 PipelineRunner
 *
 * 职责：
 * 1. 组装 PipelineRunner 的 6 个 Stage（依赖注入）
 * 2. 订阅 pipeline:user-input 事件，构建 PipelineContext 并触发 runner.run()
 * 3. 订阅 pipeline:cancel 事件，通过 AbortController 取消当前 AI 生成
 * 4. 向 PostProcessStage 提供 getActiveSlot() — 在 Vue 上下文中读取 Pinia store
 *
 * 为什么用 Orchestrator 而非直接在 main.ts 拼装：
 * - main.ts 已经很长，Orchestrator 封装了"游戏主循环"的所有细节
 * - Orchestrator 是引擎核心的一部分，可以独立测试（mock 各 Stage）
 * - getActiveSlot 的闭包在此统一管理，避免多处读 Pinia store
 *
 * 对应 CODE_REVIEW P0 #1。
 */
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { SettingCaptureStage } from '../pipeline/stages/setting-capture';
import { parseSettingTagNames } from '../prompt/setting-tag-scanner';
import { parseAnchorStopwords } from '../prompt/captured-entry-mutations';
import { DEFAULT_PROMPT_SETTINGS } from '../prompt/world-book';
import { FALLBACK_CAPTURED_LABELS } from '../prompt/captured-entry-mutations';
import type { PromptSettings } from '../prompt/world-book';
import type { CapturedSettingLabels } from '../prompt/captured-entry-mutations';

/** 从 localStorage 读取 AI 生成设置（每回合调用，确保设置变更立即生效） */
function readAISettings(): { streaming: boolean; splitGen: boolean } {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return { streaming: true, splitGen: false };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      streaming: parsed.streaming !== false,
      splitGen: parsed.splitGen === true,
    };
  } catch {
    return { streaming: true, splitGen: false };
  }
}

/** UUID v4 — 兼容 HTTP 本地开发环境（crypto.randomUUID 需要 secure context） */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Polyfill: crypto.getRandomValues 在 http://localhost 也可用
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf)
      : Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
import { PreProcessStage } from '../pipeline/stages/pre-process';
import { ContextAssemblyStage } from '../pipeline/stages/context-assembly';
import { AICallStage } from '../pipeline/stages/ai-call';
import { ResponseRepairStage } from '../pipeline/stages/response-repair';
import { BodyPolishStage } from '../pipeline/stages/body-polish-stage';
import { ReasoningIngestStage } from '../pipeline/stages/reasoning-ingest';
import { CommandExecutionStage } from '../pipeline/stages/command-execution';
import { PostProcessStage } from '../pipeline/stages/post-process';
import { RenderStage } from '../pipeline/stages/render';
import { eventBus } from './event-bus';
import { useEngineStateStore } from '../stores/engine-state';
import { useActionQueueStore } from '../stores/engine-action-queue';
import { usePromptDebugStore } from '../stores/engine-prompt';
import type { AIMessage } from '../ai/types';
import type { StateManager } from './state-manager';
import type { CommandExecutor } from './command-executor';
import type { BehaviorRunner } from '../behaviors/behavior-runner';
import type { AIService } from '../ai/ai-service';
import { AI_SETTINGS_STORAGE_KEY } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { SaveManager } from '../persistence/save-manager';
import type {
  IMemoryManager,
  IMemoryRetriever,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
  PipelineContext,
} from '../pipeline/types';
import type { GamePack } from '../types';
import type { GameTime } from '../image/scene-context';
import type { ImageBackendType } from '../image/types';
import type { MemorySummaryPipeline } from '../pipeline/sub-pipelines/memory-summary';
import type { MidTermRefinePipeline } from '../pipeline/sub-pipelines/mid-term-refine';
import type { LongTermCompactPipeline } from '../pipeline/sub-pipelines/long-term-compact';
import type { WorldHeartbeatPipeline } from '../pipeline/sub-pipelines/world-heartbeat';
import type { NpcGenerationPipeline } from '../pipeline/sub-pipelines/npc-generation';
import type { PrivacyProfileRepairPipeline } from '../pipeline/sub-pipelines/privacy-profile-repair';
import type { FieldRepairPipeline } from '../pipeline/sub-pipelines/field-repair';
// Phase 4 (2026-04-19): BodyPolish was promoted from sub-pipeline to a
// proper pipeline stage. The sub-pipeline file has been removed.
import type { NpcMemorySummarizer } from '../social/npc-memory-summarizer';
import type { ImageService } from '../image/image-service';
import type { TtsService } from '../tts/tts-service';
import type { PrivacyIncompleteReport } from '../validators/privacy-profile-validator';
import type { OpeningStages } from '../pipeline/sub-pipelines/enhanced-opening';

/**
 * 子管线包 — 由 main.ts 在 bootstrap 期间构造并注入 GameOrchestrator。
 *
 * 分组传入而非散开参数的原因：
 * 1. 都是可选的（pack 缺失时不会构造）；包装后只需一个可选参数
 * 2. 未来增加新子管线时不会再改 Orchestrator 构造函数签名
 */
export interface SubPipelineBundle {
  memorySummary?: MemorySummaryPipeline;
  midTermRefine?: MidTermRefinePipeline;
  /** 2026-04-11 新增：长期记忆二级精炼（长期溢出 cap 时触发） */
  longTermCompact?: LongTermCompactPipeline;
  worldHeartbeat?: WorldHeartbeatPipeline;
  npcGeneration?: NpcGenerationPipeline;
  /** §11.2 B: 私密信息修复子管线（NSFW 核心功能） */
  privacyRepair?: PrivacyProfileRepairPipeline;
  /** 通用字段补齐（2026-04-18）— 扫描 rules/required-fields.json 里声明的必填字段，缺失则用 step-2 context 补齐 */
  fieldRepair?: FieldRepairPipeline;
  /** Sprint Social-5: per-NPC 记忆总结器 */
  npcMemorySummarizer?: NpcMemorySummarizer;
  /** Image service — for auto scene generation post-round */
  imageService?: ImageService;
  /** TTS service — for auto narration (朗读回合正文) post-round */
  ttsService?: TtsService;
  /** World book data — loaded from WorldBookStorage at init */
  worldBooks?: import('../prompt/world-book').WorldBook[];
  /** Built-in prompt overrides — loaded from WorldBookStorage at init */
  builtinOverrides?: import('../prompt/world-book').BuiltinPromptEntry[];
  /**
   * 记忆管理器 — 供 runRound 在主回合结束后查询中期/长期记忆容量并触发对应子管线。
   *
   * 2026-04-11 CR M-06 修复：类型从具体类 `MemoryManager` 改为 `IMemoryManager` 接口。
   * 所有需要的方法（`shouldRefineMidTerm` / `shouldSummarizeLongTerm` /
   * `shouldCompactLongTerm` / `fallbackTrimLongTerm` / `getEffectiveConfig` /
   * `commitSummaryResult`）现在都在 IMemoryManager 上，可直接 mock。
   */
  memoryManager?: IMemoryManager;
  /** 引擎路径配置 — 供 runRound 识别玩家位置变更，判断是否触发 NPC 生成 */
  paths?: EnginePathConfig;
  /** Sprint Plot-1 P3: 剧情节点评估子管线 */
  plotEvaluation?: import('../plot/plot-evaluation-pipeline').PlotEvaluationPipeline;
}

export interface PreRoundSnapshotOptions {
  /**
   * The live round number captured immediately BEFORE `PipelineRunner.run()`.
   *
   * Correlation guard (code review 2026-08-21): the snapshot at
   * `paths.preRoundSnapshot` survives across rounds, so "a snapshot exists" is NOT
   * proof that *this* attempt dirtied anything. `PreProcessStage` writes the snapshot
   * and THEN increments the round number, so:
   *   - round unchanged  → PreProcess did not complete → nothing to roll back, and the
   *                        stored snapshot may belong to an EARLIER round; rolling back
   *                        to it would silently discard a completed round's state.
   *   - round advanced   → PreProcess completed this attempt → the stored snapshot is
   *                        definitionally the one it just wrote.
   * Omit to skip the guard (used by callers that already know a round was started).
   */
  roundBefore?: number;
  /** Fallback source for callers that genuinely hold a populated context. */
  ctx?: Pick<PipelineContext, 'preRoundSnapshot'> | null;
}

/**
 * Resolve the pre-round snapshot used by the pipeline's error auto-rollback.
 *
 * B0-1 (2026-08-20) — the invariant this encodes:
 * `PipelineRunner.run()` copies the context (`let ctx = { ...initialContext }`)
 * and every stage returns a NEW object, so the caller's `initialCtx` is never
 * written back. Reading `initialCtx.preRoundSnapshot` therefore always yielded
 * `undefined` and the auto-rollback branch never ran — a mid-pipeline throw left
 * the already-incremented round number behind as dirty state.
 *
 * `PreProcessStage` persists the snapshot into `paths.preRoundSnapshot` BEFORE it
 * increments the round number, so the state tree is the authoritative source.
 * The ctx fallback is kept only for callers that do hold a populated context
 * (e.g. future in-process reuse); it must never be the primary source.
 *
 * @returns the snapshot to roll back to, or `null` when this attempt left nothing
 *          dirty (see {@link PreRoundSnapshotOptions.roundBefore}).
 */
export function resolvePreRoundSnapshot(
  stateManager: Pick<StateManager, 'get'>,
  paths: EnginePathConfig,
  options?: PreRoundSnapshotOptions,
): Record<string, unknown> | null {
  if (typeof options?.roundBefore === 'number') {
    const roundNow = stateManager.get<number>(paths.roundNumber) ?? 0;
    if (roundNow === options.roundBefore) return null;
  }

  const fromState = stateManager.get<Record<string, unknown>>(paths.preRoundSnapshot);
  if (fromState && typeof fromState === 'object' && !Array.isArray(fromState)) return fromState;

  const fromCtx = options?.ctx?.preRoundSnapshot;
  if (fromCtx && typeof fromCtx === 'object' && !Array.isArray(fromCtx)) return fromCtx;
  return null;
}

export class GameOrchestrator {
  private runner: PipelineRunner;
  private abortController: AbortController | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  /**
   * 子管线包 — GAP_AUDIT §G2 wiring
   * PostProcessStage 在主回合末设置 pendingSummary/pendingHeartbeat 等 flag，
   * runRound() 在 runner.run() 之后根据这些 flag 触发对应子管线。
   * 缺失子管线时静默跳过（main.ts pack 未加载场景）。
   */
  private readonly subPipelines: SubPipelineBundle;
  private readonly engramManager: IEngramManager;
  private readonly memoryManager: IMemoryManager;
  /** R-01: 子管线运行中标记，防止 rollback 在子管线 async 飞行期间触发 */
  private _subPipelineActive = false;

  // ── deps stored for createStagesForOpening() factory method ──
  private readonly _stateManager: StateManager;
  private readonly _commandExecutor: CommandExecutor;
  private readonly _behaviorRunner: BehaviorRunner;
  private readonly _aiService: AIService;
  private readonly _responseParser: ResponseParser;
  private readonly _promptAssembler: PromptAssembler;
  private readonly _memoryRetriever: IMemoryRetriever;
  private readonly _saveManager: SaveManager;
  private readonly _pack: GamePack;
  private readonly _paths: EnginePathConfig;
  private readonly _unifiedRetriever?: IUnifiedRetriever;
  private readonly _getActiveSlot: () => { profileId: string; slotId: string } | null;

  constructor(
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    behaviorRunner: BehaviorRunner,
    aiService: AIService,
    responseParser: ResponseParser,
    promptAssembler: PromptAssembler,
    memoryManager: IMemoryManager,
    memoryRetriever: IMemoryRetriever,
    engramManager: IEngramManager,
    saveManager: SaveManager,
    pack: GamePack,
    paths: EnginePathConfig,
    /** E.2: 统一检索器（hybrid 模式时由 ContextAssemblyStage 使用；可选） */
    unifiedRetriever?: IUnifiedRetriever,
    /** §G2: 子管线包（记忆总结/精炼、世界心跳、NPC 生成） */
    subPipelines: SubPipelineBundle = {},
  ) {
    this.subPipelines = subPipelines;
    this.engramManager = engramManager;
    this.memoryManager = memoryManager;

    // Store deps for createStagesForOpening()
    this._stateManager = stateManager;
    this._commandExecutor = commandExecutor;
    this._behaviorRunner = behaviorRunner;
    this._aiService = aiService;
    this._responseParser = responseParser;
    this._promptAssembler = promptAssembler;
    this._memoryRetriever = memoryRetriever;
    this._saveManager = saveManager;
    this._pack = pack;
    this._paths = paths;
    this._unifiedRetriever = unifiedRetriever;

    // PostProcessStage 需要 profileId/slotId，通过闭包从 Pinia store 读取。
    // 这里读取是安全的：闭包只在 autoSave() 中被调用，
    // 彼时 Vue 应用已挂载、Pinia 已激活。
    const getActiveSlot = (): { profileId: string; slotId: string } | null => {
      const store = useEngineStateStore();
      if (!store.activeProfileId || !store.activeSlotId) return null;
      return { profileId: store.activeProfileId, slotId: store.activeSlotId };
    };
    this._getActiveSlot = getActiveSlot;

    // PreProcessStage 消费 action queue；同理通过闭包延迟读取 Pinia store。
    const actionQueue = {
      consumeActions: () => useActionQueueStore().consumeActions(),
    };

    this.runner = new PipelineRunner();
    this.runner.addStage(new PreProcessStage(stateManager, actionQueue, paths));
    this.runner.addStage(
      new ContextAssemblyStage(
        stateManager,
        promptAssembler,
        memoryRetriever,
        behaviorRunner,
        pack,
        paths,
        engramManager,    // E.2: 用于读取 retrievalMode
        unifiedRetriever, // E.2: hybrid 路径使用
        () => subPipelines.worldBooks ?? [],    // World book getter (supports live updates)
        () => subPipelines.builtinOverrides ?? [], // Built-in overrides getter
        true, // useNewBuilder — enable context-piece prompt assembly
        // gproxy cache flag — read live from the resolved main LLM config each round
        () => aiService.getConfigForUsage('main')?.gproxyPromptCache === true,
      ),
    );
    this.runner.addStage(new AICallStage(aiService, responseParser));
    // 2026-04-19 修复 \你 stutter：当 ResponseParser 三个 tryParseJson 策略 +
    // escape sanitizer 都救不回来时（JSON 被截断 / 缺闭合括号 等严重畸形），
    // 这里发一次修复调用把 commands / memory / options 抢回来，避免本回合
    // 状态变更全部丢失。no-op 当 parseOk=true。
    this.runner.addStage(new ResponseRepairStage(aiService, responseParser));
    // Phase 4 (2026-04-19): polish between AICall and ReasoningIngest so
    // `parsedResponse.text` is polished before PostProcess persists the
    // narrative entry. Previous sub-pipeline implementation ran AFTER the
    // pipeline — too late, the original text was already stored.
    this.runner.addStage(new BodyPolishStage(aiService, stateManager, promptAssembler));
    this.runner.addStage(new ReasoningIngestStage(stateManager, paths));
    this.runner.addStage(new CommandExecutionStage(commandExecutor, behaviorRunner, stateManager, paths));
    // Canon Capture — after commands are applied, before PostProcess persists history
    // and triggers the auto-save, so the captured settings are part of the SAME round
    // (and therefore the same rollback unit) as the narrative that introduced them.
    this.runner.addStage(
      new SettingCaptureStage(stateManager, paths, {
        isEnabled: () => {
          const settings: PromptSettings = {
            ...DEFAULT_PROMPT_SETTINGS,
            ...(stateManager.get<Partial<PromptSettings>>('系统.设置.prompt') ?? {}),
          };
          // The world-book master switch gates BOTH extraction and injection; the
          // feature switch gates extraction only (existing entries keep working).
          return settings.enableWorldBook !== false && settings.enableSettingCapture !== false;
        },
        getTagNames: () => parseSettingTagNames(pack.engineFragments?.settingTagNames),
        getAnchorStopwords: () => parseAnchorStopwords(pack.engineFragments?.settingAnchorStopwords),
        getLabels: (): CapturedSettingLabels => ({
          bookTitle: pack.engineFragments?.settingBookTitle ?? FALLBACK_CAPTURED_LABELS.bookTitle,
          kind: {
            character: pack.engineFragments?.settingKindCharacter ?? FALLBACK_CAPTURED_LABELS.kind.character,
            relationship: pack.engineFragments?.settingKindRelationship ?? FALLBACK_CAPTURED_LABELS.kind.relationship,
            world_fact: pack.engineFragments?.settingKindWorldFact ?? FALLBACK_CAPTURED_LABELS.kind.world_fact,
          },
        }),
      }),
    );
    this.runner.addStage(
      new PostProcessStage(
        stateManager,
        memoryManager,
        engramManager,
        behaviorRunner,
        saveManager,
        paths,
        getActiveSlot,
      ),
    );
    this.runner.addStage(new RenderStage());

    this.subscribeToEvents(stateManager, saveManager);
  }

  /** 订阅 eventBus 事件，接通 UI → 管线的通信 */
  private subscribeToEvents(stateManager: StateManager, saveManager: SaveManager): void {
    this.unsubscribers.push(
      eventBus.on<{ text: string }>('pipeline:user-input', (payload) => {
        if (!payload?.text) return;
        void this.runRound(payload.text, stateManager);
      }),
    );

    this.unsubscribers.push(
      eventBus.on('pipeline:cancel', () => {
        this.abortController?.abort();
      }),
    );

    this.unsubscribers.push(
      eventBus.on<import('../prompt/world-book').WorldBook[]>('worldbook:updated', (books) => {
        this.subPipelines.worldBooks = books ?? [];
      }),
    );

    // ── Prompt 调试：将 ContextAssemblyStage 发出的组装事件桥接到 Pinia store ──
    // ContextAssemblyStage 和 CharacterInitPipeline 均只 emit 事件不直接写 store，
    // 避免 engine 层直接依赖 UI store；此处统一桥接是单一 sink 点。
    this.unsubscribers.push(
      eventBus.on<{
        flow: string;
        variables: Record<string, string>;
        messages: AIMessage[];
        /**
         * 2026-04-14 新增：平行数组，每条消息的出处标签。
         * 主回合（context-assembly）会填；子管线可能不填（向后兼容 undefined）。
         */
        messageSources?: string[];
        generationId?: string;
        roundNumber?: number;
      }>('ui:debug-prompt', (payload) => {
        if (!payload) return;
        try {
          usePromptDebugStore().recordAssembly(
            payload.flow,
            payload.messages ?? [],
            payload.variables ?? {},
            payload.roundNumber,
            payload.messageSources,
            payload.generationId,
          );
        } catch (err) {
          // Pinia 未就绪时（测试环境）静默忽略，不影响管线
          console.warn('[Orchestrator] promptDebug.recordAssembly skipped:', err);
        }
      }),
    );

    // ── Prompt 调试：AI 响应回填到对应 snapshot ──
    // 2026-04-19：CoT thinking 从全局 `元数据.推理历史` 迁移到 per-snapshot
    // 字段；每次 AI 调用结束后，发出者（AICallStage / ImageTokenizer / 子管线）
    // emit 此事件，store 按 generationId 或 flowId 匹配回填。
    this.unsubscribers.push(
      eventBus.on<{
        flow?: string;
        generationId?: string;
        thinking?: string;
        rawResponse?: string;
      }>('ui:debug-prompt-response', (payload) => {
        if (!payload) return;
        try {
          usePromptDebugStore().attachResponse(
            { generationId: payload.generationId, flowId: payload.flow },
            { thinking: payload.thinking, rawResponse: payload.rawResponse },
          );
        } catch (err) {
          console.warn('[Orchestrator] promptDebug.attachResponse skipped:', err);
        }
      }),
    );

    // ── Rollback：将状态树恢复到上一回合开始前的快照 ──
    // 快照由 PreProcessStage 捕获并存储在 paths.preRoundSnapshot。
    // 回滚后清空 action queue，并通知 UI 移除最后一条叙事条目。
    this.unsubscribers.push(
      eventBus.on('engine:rollback-requested', () => {
        if (this.abortController || this._subPipelineActive) return; // 生成中/子管线运行中禁止回滚

        const snapshotPath = '元数据.上次对话前快照';
        const snapshot = stateManager.get<Record<string, unknown>>(snapshotPath);
        if (!snapshot) {
          // R-05: 无快照时给用户明确反馈（连续第二次回退、或第一回合回退）
          eventBus.emit('ui:toast', {
            type: 'info',
            i18nKey: 'engine.toast.noRollbackSnapshot',
            message: '没有可回退的快照（每回合只能回退一次）',
            duration: 2500,
          });
          return;
        }

        stateManager.rollbackTo(snapshot);
        useActionQueueStore().consumeActions(); // 清空 action queue
        this.memoryManager.clearConfigCache(); // R-04: 清除记忆配置缓存

        // Engram 向量同步：状态树已回退，删除 IndexedDB 中被回退回合产生的孤立向量
        if (this.engramManager.isEnabled()) {
          this.engramManager.syncVectorsToState(stateManager).catch((e: unknown) =>
            console.warn('[Rollback] Engram vector sync failed (non-blocking):', e),
          );
        }

        eventBus.emit('engine:rollback-complete', undefined);
      }),
    );

    // ── UI 请求存档（配置变更、设置面板写入等触发）──
    // EventPanel / SettingsPanel 的配置写入 state 后 emit 此事件，
    // 在此处理实际的 IndexedDB 持久化，使 UI 不依赖对 saveManager 的直接注入。
    this.unsubscribers.push(
      eventBus.on('engine:request-save', () => {
        const slot = useEngineStateStore();
        const profileId = slot.activeProfileId;
        const slotId = slot.activeSlotId;
        if (!profileId || !slotId) return;
        const snapshot = slot.toSnapshot();
        void saveManager.saveGame(profileId, slotId, snapshot as import('../types').GameStateTree).catch((err) => {
          console.error('[Orchestrator] engine:request-save failed:', err);
          eventBus.emit('engine:save-error', { error: err instanceof Error ? err.message : String(err) });
        });
      }),
    );
  }

  /**
   * 执行一个完整的游戏回合
   *
   * 构建初始 PipelineContext 并启动 PipelineRunner。
   * abortController 在回合结束（正常或取消）后置 null，
   * 确保下一回合使用全新的取消信号。
   */
  private async runRound(userInput: string, stateManager: StateManager): Promise<void> {
    this.abortController = new AbortController();

    // 每回合读取设置，确保 APIPanel 的变更立即生效（无需重启）
    const { streaming, splitGen } = readAISettings();

    // 记录玩家进入本回合时的位置，用于检测位置变更 → 触发 NPC 生成子管线
    const paths = this.subPipelines.paths;
    const locationBefore = paths
      ? (stateManager.get<string>(paths.playerLocation) ?? null)
      : null;

    // B0-1 correlation guard: remember the round number BEFORE the pipeline starts, so
    // the error path can tell "PreProcess advanced the round this attempt" (roll back)
    // from "PreProcess never completed" (nothing dirty — a stale snapshot from an
    // earlier round must NOT be applied). See resolvePreRoundSnapshot().
    const roundBefore = stateManager.get<number>(this._paths.roundNumber) ?? 0;

    const initialCtx: PipelineContext = {
      userInput,
      // Pristine copy for Canon Capture's evidence gate — PreProcessStage will prepend
      // the action queue to `userInput`, and that text must never count as evidence.
      originalUserInput: userInput,
      actionQueuePrompt: '',
      stateSnapshot: {},
      chatHistory: [],
      messages: [],
      worldEventTriggered: false,
      roundNumber: 0,
      generationId: generateId(),
      meta: { splitGen },
      abortSignal: this.abortController.signal,
      // 流式关闭时不设置 onStreamChunk，AICallStage 据此传 stream: false
      onStreamChunk: streaming
        ? (chunk: string) => { eventBus.emit('ai:stream-chunk', { chunk }); }
        : undefined,
    };

    let finalCtx: PipelineContext | null = null;
    try {
      finalCtx = await this.runner.run(initialCtx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Pipeline aborted') {
        console.error('[Orchestrator] Pipeline error:', err);
      }
      // 无论是报错还是用户取消，都 emit ai:error 让 UI 恢复输入
      eventBus.emit('ai:error', { error: err });

      // 自动回滚：PreProcess 在 AI 调用前已递增 roundNumber，不回滚会留下脏状态。
      // preRoundSnapshot 在递增前捕获，回滚后 roundNumber 恢复到正确值。
      //
      // B0-1 修复（2026-08-20）：快照必须从**状态树**读，不能读 `initialCtx` —
      // 详见 `resolvePreRoundSnapshot()` 的注释（Runner 值传递 → initialCtx 恒为空 →
      // 这个分支此前从未执行过，报错回合会留下已递增的 `元数据.回合序号`）。
      const snapshot = resolvePreRoundSnapshot(stateManager, this._paths, {
        roundBefore,
        ctx: initialCtx,
      });
      if (snapshot) {
        stateManager.rollbackTo(snapshot);
        this.memoryManager.clearConfigCache();
        if (this.engramManager.isEnabled()) {
          this.engramManager.syncVectorsToState(stateManager).catch(() => {});
        }
        console.log('[Orchestrator] Auto-rolled back to pre-round snapshot after pipeline error');
      }
    } finally {
      this.abortController = null;
    }

    // Phase 4 (2026-04-19): the old post-pipeline BodyPolish block was removed.
    // Polish now runs INSIDE the pipeline as `BodyPolishStage` between AICall and
    // ReasoningIngest, so PostProcess sees the polished text and persists it
    // correctly. The previous post-pipeline block was silently broken — it
    // mutated `finalCtx.parsedResponse.text` in memory but the narrative entry
    // had already been pushed with the original text.

    // ── GAP_AUDIT §G2: 消费主管线设置的 pending 标记，触发对应子管线 ──
    if (finalCtx) {
      this._subPipelineActive = true;
      try {
        await this.runPostRoundSubPipelines(finalCtx, stateManager, locationBefore);
      } finally {
        this._subPipelineActive = false;
        // Sub-pipeline AI calls may emit ai:retrying which sets isGenerating=true
        // in the UI. Ensure the UI resets after all sub-pipelines finish.
        eventBus.emit('engine:sub-pipelines-done');
      }
    }
  }

  /**
   * 主回合完成后的子管线调度
   *
   * 四个触发源：
   * 1. ctx.meta.pendingSummary — 短期记忆满 → MemorySummaryPipeline
   * 2. (记忆总结后) 中期记忆满 → MidTermRefinePipeline
   * 3. ctx.meta.pendingHeartbeat — 到达心跳周期 → WorldHeartbeatPipeline
   * 4. 玩家位置变更 + 新地点无 NPC → NpcGenerationPipeline
   *
   * 所有子管线都包在独立 try/catch 中，避免一个失败污染其他子管线。
   */
  private async runPostRoundSubPipelines(
    ctx: PipelineContext,
    stateManager: StateManager,
    locationBefore: string | null,
  ): Promise<void> {
    // ── 1. 记忆层级触发（2026-04-11 重构） ──
    //
    // 四层记忆系统（short/implicit mid / mid / long），参照 demo + design note。
    //
    // 短→中的升级是**同步**完成的（`PostProcessStage` 调
    // `MemoryManager.shiftAndPromoteOldest()`，无 AI 调用）。所以这里不再
    // 检查 `pendingSummary` 标记，而是直接按**中期记忆当前条数**判断是否
    // 触发 AI 子管线。
    //
    // If-else 二选一（优先级：长期汇总 > in-place 精炼）：
    //   - mid >= 50 (longTermSummaryThreshold) → MemorySummaryPipeline
    //     执行 "worldview evolution" 产出 1-3 条长期记忆 + 消费掉旧中期
    //   - 否则 mid >= 25 (midTermRefineThreshold) → MidTermRefinePipeline
    //     执行 in-place 精炼（去重合并，标记 `已精炼`，不删减记忆点）
    //   - 否则 no-op
    //
    // 之所以 if-else：如果同时达到两个阈值（比如 mid=50 → 先 summary 消费
    // 到 mid=20），refine 就没必要再跑了。优先长期汇总让系统减负最多。
    //
    // 详见 `memory-manager.ts` 顶部 JSDoc 的"四层设计"。
    const memMgr = this.subPipelines.memoryManager;
    if (memMgr) {
      if (memMgr.shouldSummarizeLongTerm() && this.subPipelines.memorySummary) {
        try {
          const ok = await this.subPipelines.memorySummary.execute();
          if (ok) console.log('[Orchestrator] MemorySummaryPipeline (worldview evolution) completed');
        } catch (err) {
          console.error('[Orchestrator] MemorySummaryPipeline failed:', err);
        }
      } else if (memMgr.shouldRefineMidTerm() && this.subPipelines.midTermRefine) {
        try {
          const ok = await this.subPipelines.midTermRefine.execute();
          if (ok) console.log('[Orchestrator] MidTermRefinePipeline (in-place compress) completed');
        } catch (err) {
          console.error('[Orchestrator] MidTermRefinePipeline failed:', err);
        }
      }

      // ── 长期记忆溢出 → 二级精炼 → fallback FIFO ──
      //
      // 2026-04-11 新增（Feature B）：上一步 memorySummary 可能把新长期记忆
      // push 进来，如果导致长期记忆超过 cap，触发 LongTermCompactPipeline。
      // Compact 成功则 old entries 被合并为"主题存档"，否则 fallback 到 FIFO。
      //
      // 这里独立于上面的 if-else —— 因为 memorySummary 执行成功后可能新条目
      // 使长期记忆恰好溢出，需要**同轮**紧接着处理，不等下一回合。
      if (memMgr.shouldCompactLongTerm()) {
        let compacted = false;
        if (this.subPipelines.longTermCompact) {
          try {
            compacted = await this.subPipelines.longTermCompact.execute();
            if (compacted) console.log('[Orchestrator] LongTermCompactPipeline (theme archive) completed');
          } catch (err) {
            console.error('[Orchestrator] LongTermCompactPipeline failed:', err);
          }
        }
        // AI compact 失败或不可用 → fallback FIFO 兜底
        if (!compacted) {
          const trimmed = memMgr.fallbackTrimLongTerm();
          if (trimmed > 0) {
            console.log(`[Orchestrator] Long-term FIFO fallback trimmed ${trimmed} oldest entries`);
          }
        }
      }
    }

    // ── 3. 世界心跳 ──
    if (ctx.meta['pendingHeartbeat'] === true && this.subPipelines.worldHeartbeat) {
      try {
        const ok = await this.subPipelines.worldHeartbeat.execute();
        if (ok && this.subPipelines.paths) {
          // 心跳成功 → 记录本回合为最新心跳回合（供下次周期判断）
          stateManager.set(
            this.subPipelines.paths.lastHeartbeatRound,
            ctx.roundNumber,
            'system',
          );
        }
      } catch (err) {
        console.error('[Orchestrator] WorldHeartbeatPipeline failed:', err);
      }
    }

    // ── 3.5. Plot evaluation (Sprint Plot-1 P3, GAP-02 fix) ──
    if (ctx.meta['pendingPlotEval'] === true && this.subPipelines.plotEvaluation) {
      // Set evaluating flag on state tree so PlotPanel's store watch can block hot-swap
      if (this.subPipelines.paths) {
        stateManager.set(this.subPipelines.paths.plotDirection + '._evaluating', true, 'system');
      }
      try {
        const ok = await this.subPipelines.plotEvaluation.execute();
        if (ok) {
          console.debug('[Orchestrator] PlotEvaluationPipeline completed');
        } else {
          console.debug('[Orchestrator] PlotEvaluationPipeline skipped (no active arc/node)');
        }
      } catch (err) {
        console.error('[Orchestrator] PlotEvaluationPipeline failed:', err);
      } finally {
        if (this.subPipelines.paths) {
          stateManager.set(this.subPipelines.paths.plotDirection + '._evaluating', false, 'system');
        }
      }
    }

    // ── 4. NPC 自动生成（玩家移动到新地点时触发） ──
    if (
      this.subPipelines.npcGeneration &&
      this.subPipelines.paths
    ) {
      const locationAfter = stateManager.get<string>(this.subPipelines.paths.playerLocation) ?? null;
      if (locationAfter && locationAfter !== locationBefore) {
        try {
          const ok = await this.subPipelines.npcGeneration.execute(locationAfter);
          if (ok) console.log(`[Orchestrator] NpcGenerationPipeline generated NPCs for "${locationAfter}"`);
        } catch (err) {
          console.error('[Orchestrator] NpcGenerationPipeline failed:', err);
        }
      }
    }

    // ── 5. §11.2 B: 私密信息修复（NSFW 核心） ──
    // CommandExecutionStage 在 nsfwMode=true 时扫描并写 ctx.meta.pendingPrivacyRepair。
    // 这里消费该 flag，通过 PrivacyProfileRepairPipeline 补齐缺失字段（带 retry）。
    //
    // 放在 npcGeneration 之后的原因：新生成的 NPC 也需要被扫描和补齐。
    // 但 npcGeneration 本身不触发 validator（那是下一回合 CommandExecutionStage 的事）。
    // 所以本回合的 privacy repair 只针对主管线 AI 生成/修改的 NPC。
    const pendingPrivacy = ctx.meta['pendingPrivacyRepair'] as PrivacyIncompleteReport | undefined;
    if (pendingPrivacy && this.subPipelines.privacyRepair) {
      try {
        const result = await this.subPipelines.privacyRepair.execute(pendingPrivacy);
        if (result.success) {
          console.log(`[Orchestrator] PrivacyProfileRepairPipeline completed in ${result.attempts} attempt(s)`);
          eventBus.emit('ui:toast', {
            type: 'success',
            i18nKey: 'engine.toast.privacyFieldsRepaired',
            message: '扩展字段已自动补齐',
            duration: 1500,
          });
        } else {
          console.warn(
            `[Orchestrator] PrivacyProfileRepairPipeline finished with ${result.remaining.total} remaining after ${result.attempts} attempts`,
          );
          eventBus.emit('ui:toast', {
            type: 'warning',
            i18nKey: 'engine.toast.privacyFieldsIncomplete',
            i18nParams: { count: result.remaining.total },
            message: `仍有 ${result.remaining.total} 项扩展字段未补齐（已达重试上限）`,
            duration: 3000,
          });
        }
      } catch (err) {
        console.error('[Orchestrator] PrivacyProfileRepairPipeline failed:', err);
      }
    }

    // ── 6. 通用字段补齐（2026-04-18） ──
    // Runs AFTER privacy repair so newly-populated 私密信息 (and its 4 required
    // body parts, 初夜 fields etc.) don't get flagged as missing by the
    // generic validator. Scans `rules/required-fields.json` against current
    // state; fires repair pipeline only when at least one entity has gaps.
    if (this.subPipelines.fieldRepair) {
      try {
        const result = await this.subPipelines.fieldRepair.execute();
        if (result.attempts > 0) {
          if (result.success) {
            console.log(`[Orchestrator] FieldRepairPipeline completed in ${result.attempts} attempt(s)`);
            eventBus.emit('ui:toast', {
              type: 'success',
              i18nKey: 'engine.toast.basicFieldsRepaired',
              message: '基础字段已自动补齐',
              duration: 1500,
            });
          } else {
            console.warn(
              `[Orchestrator] FieldRepairPipeline finished with ${result.remaining.total} remaining after ${result.attempts} attempts`,
            );
            eventBus.emit('ui:toast', {
              type: 'warning',
              i18nKey: 'engine.toast.basicFieldsIncomplete',
              i18nParams: { count: result.remaining.total },
              message: `仍有 ${result.remaining.total} 项字段未补齐（已达重试上限）`,
              duration: 3000,
            });
          }
        }
        if (result.entityEnrichResult && result.entityEnrichResult.enriched > 0) {
          console.log(
            `[Orchestrator] EntityEnrich: ${result.entityEnrichResult.enriched} entity(s) enriched (${result.entityEnrichResult.remaining} still pending)`,
          );
        }
        if (result.edgeReviewResult) {
          if (result.edgeReviewResult.invalidated > 0) {
            console.log(
              `[Orchestrator] EdgeReview: ${result.edgeReviewResult.invalidated} edge(s) invalidated out of ${result.edgeReviewResult.reviewed} reviewed`,
            );
          }
          const p = this.subPipelines.paths;
          if (p) {
            const history = stateManager.get<Array<Record<string, unknown>>>(p.narrativeHistory) ?? [];
            for (let i = history.length - 1; i >= 0; i--) {
              const entry = history[i];
              if (entry._engramWrite) {
                (entry._engramWrite as Record<string, unknown>).reviewResult = result.edgeReviewResult;
                stateManager.set(p.narrativeHistory, history, 'system');
                break;
              }
            }
          }
        }
      } catch (err) {
        console.error('[Orchestrator] FieldRepairPipeline failed:', err);
      }
    }

    // ── Auto scene generation (post-round) ──
    // D27: Skip ImageService during enhanced opening
    if (this.subPipelines.imageService && !ctx.meta?.isEnhancedOpening) {
      const autoScene = stateManager.get<boolean>('系统.扩展.image.config.autoSceneOnRound') === true;
      const imageEnabled = stateManager.get<boolean>('系统.扩展.image.enabled') === true;
      if (autoScene && imageEnabled && ctx.parsedResponse?.text) {
        try {
          const paths = this.subPipelines.paths;
          const location = stateManager.get<string>(paths?.playerLocation ?? '角色.基础信息.当前位置') ?? '';
          const defaultBackend = (stateManager.get<string>('系统.扩展.image.config.defaultBackend') ?? 'novelai') as ImageBackendType;
          eventBus.emit('ui:toast', { type: 'info', i18nKey: 'engine.toast.autoSceneGenStart', message: '正在自动生成场景图…', duration: 2000 });
          // P3 env-tags port (2026-04-19): forward env state so auto-gen scene
          // images reflect current weather/festival/environment (same plumbing
          // as ImagePanel.vue manual generation).
          const sceneAnchors = this.subPipelines.imageService.collectSceneRoleAnchors();
          this.subPipelines.imageService.generateSceneImage({
            sceneDescription: ctx.parsedResponse.text.slice(0, 800),
            location,
            gameTime: paths ? stateManager.get<GameTime | null>(paths.gameTime) ?? undefined : undefined,
            weather: paths ? stateManager.get<string>(paths.weather) : undefined,
            festival: paths ? stateManager.get<unknown>(paths.festival) : undefined,
            environment: paths ? stateManager.get<unknown>(paths.environmentTags) : undefined,
            backend: defaultBackend,
            compositionMode: 'auto',
            presentNpcs: sceneAnchors.presentNpcs,
            roleAnchors: sceneAnchors.roleAnchors.length > 0 ? sceneAnchors.roleAnchors : undefined,
          }).then(() => {
            eventBus.emit('ui:toast', { type: 'success', i18nKey: 'engine.toast.autoSceneGenComplete', message: '场景图已生成', duration: 2000 });
          }).catch((err) => console.debug('[Orchestrator] Auto scene gen failed:', err));
        } catch (err) {
          console.debug('[Orchestrator] Auto scene trigger error:', err);
        }
      }
    }

    // ── Auto NPC portrait (first appearance) ──
    // D27: Skip ImageService during enhanced opening (same guard as auto scene above)
    if (this.subPipelines.imageService && !ctx.meta?.isEnhancedOpening) {
      const autoPortrait = stateManager.get<boolean>('系统.扩展.image.config.autoPortraitForMajorNpcs') === true;
      const imageEnabled = stateManager.get<boolean>('系统.扩展.image.enabled') === true;
      if (autoPortrait && imageEnabled) {
        try {
          const relations = stateManager.get<Array<Record<string, unknown>>>(this.subPipelines.paths?.relationships ?? '社交.关系') ?? [];
          const genderFilter = stateManager.get<string>('系统.扩展.image.config.auto.genderFilter') ?? 'all';
          const importanceFilter = stateManager.get<string>('系统.扩展.image.config.auto.importanceFilter') ?? 'major';
          const defaultBackend = (stateManager.get<string>('系统.扩展.image.config.defaultBackend') ?? 'novelai') as ImageBackendType;

          for (const npc of relations) {
            const name = String(npc['名称'] ?? '');
            if (!name) continue;
            const isMajor = npc['是否主要角色'] === true;
            if (importanceFilter === 'major' && !isMajor) continue;
            const gender = String(npc['性别'] ?? '');
            if (genderFilter === 'male' && gender !== '男') continue;
            if (genderFilter === 'female' && gender !== '女') continue;

            const archive = npc['图片档案'] as Record<string, unknown> | undefined;
            const hasAvatar = !!archive?.['已选头像图片ID'];
            if (hasAvatar) continue;

            // No avatar yet — auto-generate
            this.subPipelines.imageService.generateCharacterImage({
              characterName: name,
              description: String(npc['描述'] ?? ''),
              appearance: String(npc['外貌描写'] ?? npc['描述'] ?? ''),
              backend: defaultBackend,
            }).then(() => {
              eventBus.emit('ui:toast', { type: 'success', i18nKey: 'engine.toast.autoPortraitComplete', i18nParams: { name }, message: `${name} 自动肖像已生成`, duration: 2000 });
            }).catch((err) => console.debug(`[Orchestrator] Auto portrait for ${name} failed:`, err));
          }
        } catch (err) {
          console.debug('[Orchestrator] Auto portrait trigger error:', err);
        }
      }
    }

    // ── Auto narration (post-round TTS) ──
    // Global preference (aga_tts_settings, held on TtsService). Fire-and-forget:
    // TtsService.speak() is self-contained (splits/strips markers, plays via
    // audio queue, swallows errors → toast). Skip during enhanced opening.
    if (this.subPipelines.ttsService && !ctx.meta?.isEnhancedOpening) {
      try {
        // 下回合生成完毕 → 删除上一回合的全配音缓存(内存卫生 + 用户要求)。
        // 若随后自动配音,speak() 会重新捕获本回合;否则缓存归零、下载入口隐藏。
        this.subPipelines.ttsService.clearRoundAudio();
        const ttsSettings = this.subPipelines.ttsService.getSettings();
        if (ttsSettings.enabled && ttsSettings.autoNarrateOnRound && ctx.parsedResponse?.text) {
          const roundNo = stateManager.get<number>(this.subPipelines.paths?.roundNumber ?? '元数据.回合序号') ?? 0;
          // fire-and-forget — do NOT await (post-round pipeline must not block on TTS)
          void this.subPipelines.ttsService.speak(ctx.parsedResponse.text, `round-${roundNo}`);
        }
      } catch (err) {
        console.debug('[Orchestrator] Auto narration trigger error:', err);
      }
    }

    // ── Sprint Social-5: per-NPC memory summarizer ──
    if (this.subPipelines.npcMemorySummarizer) {
      try {
        const candidates = this.subPipelines.npcMemorySummarizer.findCandidates();
        for (const npcName of candidates) {
          await this.subPipelines.npcMemorySummarizer.summarize(npcName);
          console.debug(`[Orchestrator] NpcMemorySummarizer completed for "${npcName}"`);
        }
      } catch (err) {
        console.debug('[Orchestrator] NpcMemorySummarizer failed:', err);
      }
    }

    // R-03: 子管线可能修改了记忆（refine/summary/compact）、NPC 列表、心跳状态等。
    eventBus.emit('engine:request-save', undefined);
  }

  /**
   * NEW-C1: Public wrapper for runPostRoundSubPipelines — used by EnhancedOpeningPipeline (Phase G).
   *
   * Reads the player's current location and passes it as locationBefore so that
   * locationAfter === locationBefore → NpcGeneration no-op.
   */
  public async runPostRoundForOpening(
    ctx: PipelineContext,
    stateManager: StateManager,
  ): Promise<void> {
    const location = stateManager.get<string>(this._paths.playerLocation) ?? null;
    this._subPipelineActive = true;
    try {
      await this.runPostRoundSubPipelines(ctx, stateManager, location);
    } finally {
      this._subPipelineActive = false;
      eventBus.emit('engine:sub-pipelines-done');
    }
  }

  /**
   * NEW-I1 + NEW-C3: Factory method creating stage instances for the enhanced opening pipeline.
   *
   * Uses the same dependency instances as the main pipeline, ensuring consistent behavior.
   * The opening pipeline calls stage.execute() manually instead of going through PipelineRunner.
   */
  public createStagesForOpening(): OpeningStages {
    return {
      contextAssembly: new ContextAssemblyStage(
        this._stateManager,
        this._promptAssembler,
        this._memoryRetriever,
        this._behaviorRunner,
        this._pack,
        this._paths,
        this.engramManager,
        this._unifiedRetriever,
        () => this.subPipelines.worldBooks ?? [],
        () => this.subPipelines.builtinOverrides ?? [],
        // Use legacy flow-based path so step1/step2FlowOverride works
        false,
      ),
      aiCall: new AICallStage(this._aiService, this._responseParser),
      bodyPolish: new BodyPolishStage(this._aiService, this._stateManager, this._promptAssembler),
      commandExecution: new CommandExecutionStage(
        this._commandExecutor,
        this._behaviorRunner,
        this._stateManager,
        this._paths,
      ),
      postProcess: new PostProcessStage(
        this._stateManager,
        this.memoryManager,
        this.engramManager,
        this._behaviorRunner,
        this._saveManager,
        this._paths,
        this._getActiveSlot,
      ),
    };
  }

  /** 销毁 Orchestrator — 应在 app 卸载时调用（防止内存泄漏） */
  destroy(): void {
    this.abortController?.abort();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
