// App doc: docs/user-guide/pages/game-image.md §自动任务设置 (auto scene/portrait consumption)
/**
 * 游戏编排器 — 接通 pipeline:user-input 事件到 PipelineRunner
 *
 * 职责：
 * 1. 组装 PipelineRunner 的 Stage（依赖注入；顺序与个数见 core/stage-assembly.ts）
 * 2. 订阅 pipeline:user-input 事件，构建 PipelineContext 并触发 runner.run()
 * 3. 订阅 pipeline:cancel 事件，通过 AbortController 取消当前 AI 生成
 * 4. 向 PostProcessStage 提供 getActiveSlot() — 在 Vue 上下文中读取 Pinia store
 *
 * 为什么用 Orchestrator 而非直接在 main.ts 拼装：
 * - main.ts 已经很长，Orchestrator 封装了"游戏主循环"的所有细节
 * - Orchestrator 是引擎核心的一部分；阶段在 stage-assembly 里构造，测试通过 ports 注入替身
 * - getActiveSlot 的闭包在此统一管理，避免多处读 Pinia store
 */
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { RoundOwnership, type RoundSlot } from './round-ownership';
import { runPostRound } from './post-round';
import { addRoundStages, buildOpeningStages } from './stage-assembly';
import { readAISettings, generateId } from './round-settings';

import { eventBus } from './event-bus';
import type { usePromptDebugStore } from '../stores/engine-prompt';
import type { AIMessage } from '../ai/types';
import type { StateManager } from './state-manager';
import type { CommandExecutor } from './command-executor';
import type { BehaviorRunner } from '../behaviors/behavior-runner';
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { SaveManager } from '../persistence/save-manager';
import type {
  IMemoryManager,
  IMemoryRetriever,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
  IActionQueueConsumer,
  PipelineContext,
  CompileTrace,
} from '../pipeline/types';
import { DEFAULT_ENGINE_PATHS, PREFERENCE_PATHS } from '../pipeline/types';
import type { GamePack } from '../types';
import type { MemorySummaryPipeline } from '../pipeline/sub-pipelines/memory-summary';
import type { MidTermRefinePipeline } from '../pipeline/sub-pipelines/mid-term-refine';
import { CharacterVectorProposePipeline } from '../pipeline/sub-pipelines/character-vector-propose';
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
import type { OpeningStages } from '../pipeline/sub-pipelines/enhanced-opening';

/**
 * Store access injected by main.ts (R5 step 4). Each port is a closure that resolves its Pinia
 * store at CALL time, so no store is created before the app has installed Pinia.
 */
export interface OrchestratorPorts {
  /** Active profile/slot from the engine-state store; null when none is selected. */
  getActiveSlot: () => { profileId: string; slotId: string } | null;
  /** Action-queue store: drained by PreProcessStage and on rollback. */
  actionQueue: IActionQueueConsumer;
  /** Prompt-debug store: receives assembly records and AI response backfill. */
  promptDebug: Pick<ReturnType<typeof usePromptDebugStore>, 'recordAssembly' | 'attachResponse'>;
}

/**
 * 子管线包 — 由 main.ts 在 bootstrap 期间构造并注入 GameOrchestrator。
 *
 * 分组传入而非散开参数的原因：
 * 1. 都是可选的（pack 缺失时不会构造）；包装后只需一个可选参数
 * 2. 未来增加新子管线时不会再改 Orchestrator 构造函数签名
 */
export interface SubPipelineBundle {
  plotVector?: import('../plot-vector/round-port').PlotVectorRoundPort;
  stateEditInProgress?: () => boolean;
  memorySummary?: MemorySummaryPipeline;
  midTermRefine?: MidTermRefinePipeline;
  /** R2 second half (2026-09-06): world-written character vectors (after refine / every N rounds) */
  characterVectorPropose?: CharacterVectorProposePipeline;
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
   * Live round number captured immediately BEFORE `PipelineRunner.run()`. The stored snapshot
   * survives across rounds, so it is only trusted when the round number advanced this attempt
   * (PreProcess writes the snapshot, then increments). Omit to skip the guard.
   */
  roundBefore?: number;
  /** Fallback source for callers that genuinely hold a populated context. */
  ctx?: Pick<PipelineContext, 'preRoundSnapshot'> | null;
}

/**
 * Resolve the snapshot used by the pipeline's error auto-rollback (B0-1).
 * The runner copies the context, so `initialCtx.preRoundSnapshot` is always empty: the state tree
 * (`paths.preRoundSnapshot`, written by PreProcess before the round increment) is the primary source.
 *
 * @returns the snapshot to roll back to, or `null` when this attempt left nothing dirty.
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
  private stateRevision = 0;
  private pendingSave: RoundSlot | null = null;
  private requestedSaveActive = false;
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
  /** Optional editors must not write over a live main/sub-pipeline snapshot. */
  get isBusy(): boolean { return !!this.abortController || this._subPipelineActive || this.requestedSaveActive; }

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
  private readonly ports: OrchestratorPorts;
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
    unifiedRetriever: IUnifiedRetriever | undefined,
    /** §G2: 子管线包（记忆总结/精炼、世界心跳、NPC 生成） */
    subPipelines: SubPipelineBundle = {},
    /** R5 step 4: store access injected by main.ts */
    ports: OrchestratorPorts,
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

    // PostProcessStage needs profileId/slotId; the port reads the Pinia store lazily (see OrchestratorPorts).
    const getActiveSlot = ports.getActiveSlot;
    this._getActiveSlot = getActiveSlot;
    this.ports = ports;

    // PreProcessStage consumes the action queue through the port.
    const actionQueue = ports.actionQueue;

    this.runner = new PipelineRunner();
    addRoundStages(this.runner, {
      stateManager,
      commandExecutor,
      behaviorRunner,
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      memoryRetriever,
      engramManager,
      saveManager,
      pack,
      paths,
      unifiedRetriever,
      subPipelines,
      getActiveSlot,
      actionQueue,
    });

    this.subscribeToEvents(stateManager);
  }

  /** 订阅 eventBus 事件，接通 UI → 管线的通信 */
  private subscribeToEvents(stateManager: StateManager): void {
    this.unsubscribers.push(eventBus.on<{ type?: string }>('engine:state-changed', event => {
      if (event.type === 'load' || event.type === 'rollback') this.stateRevision++;
      // A request from the old loaded tree must not be applied to a new one.
      if (event.type === 'load') this.pendingSave = null;
    }));
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
        compileTrace?: CompileTrace;
      }>('ui:debug-prompt', (payload) => {
        if (!payload) return;
        try {
          this.ports.promptDebug.recordAssembly(
            payload.flow,
            payload.messages ?? [],
            payload.variables ?? {},
            payload.roundNumber,
            payload.messageSources,
            payload.generationId,
            payload.compileTrace,
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
          this.ports.promptDebug.attachResponse(
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
      eventBus.on('engine:rollback-requested', () => { this.rollbackLastRound(stateManager); }),
    );

    // ── UI 请求存档（配置变更、设置面板写入等触发）──
    // EventPanel / SettingsPanel 的配置写入 state 后 emit 此事件，
    // 在此处理实际的 IndexedDB 持久化，使 UI 不依赖对 saveManager 的直接注入。
    this.unsubscribers.push(
      eventBus.on('engine:request-save', () => { this.queueSave(); }),
    );
  }

  /**
   * The player's rollback: restore the tree to the snapshot taken before the last round, then save it, so a
   * reload does not bring the undone round back (2026-09-26, PO D6).
   */
  private rollbackLastRound(stateManager: StateManager): void {
    if (this.abortController || this._subPipelineActive || this.subPipelines.stateEditInProgress?.()) return; // Do not race an editor's atomic save.

    const snapshotPath = DEFAULT_ENGINE_PATHS.preRoundSnapshot;
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

    // The story goes back; the player's settings stay as they are now (PO 2026-10-03).
    stateManager.rollbackTo(snapshot, PREFERENCE_PATHS);
    this.ports.actionQueue.consumeActions(); // 清空 action queue
    this.memoryManager.clearConfigCache(); // R-04: 清除记忆配置缓存

    // Engram 向量同步：状态树已回退，删除 IndexedDB 中被回退回合产生的孤立向量
    if (this.engramManager.isEnabled()) {
      this.engramManager.syncVectorsToState(stateManager).catch((e: unknown) =>
        console.warn('[Rollback] Engram vector sync failed (non-blocking):', e),
      );
    }

    eventBus.emit('engine:rollback-complete', undefined);
    // The UI updates at once; the write follows on the same coalesced path as every other save, so the only
    // window left is the IndexedDB write itself, as for an ordinary round.
    this.queueSave();
  }

  /** Save the active slot through the coalesced path (waits for a running round or edit; never crosses slots). */
  private queueSave(): void {
    const slot = this._getActiveSlot();
    if (!slot) return;
    this.pendingSave = { ...slot };
    void this.flushRequestedSave();
  }

  /** Coalesce UI saves; take the snapshot only after a round commits or rolls back. */
  public onStateEditSettled(): void { void this.flushRequestedSave(); }

  private async flushRequestedSave(): Promise<void> {
    if (this.isBusy || this.subPipelines.stateEditInProgress?.()) return;
    this.requestedSaveActive = true;
    try {
      while (this.pendingSave) {
        const slot = this.pendingSave; this.pendingSave = null;
        const current = this._getActiveSlot();
        if (slot.profileId !== current?.profileId || slot.slotId !== current?.slotId) continue;
        const revision = this.stateRevision;
        // The live tree, not a copy: saveGame writes it as it is at this call (P1 存档写入提速).
        await this._saveManager.saveGame(slot.profileId, slot.slotId, this._stateManager.liveTree(), undefined, {
          guard: () => {
            const live = this._getActiveSlot();
            if (revision !== this.stateRevision || live?.profileId !== slot.profileId || live?.slotId !== slot.slotId)
              throw new Error('存档已切换，取消旧保存请求');
          },
          committed: () => {},
        });
      }
    } catch (err) {
      console.error('[Orchestrator] engine:request-save failed:', err);
      eventBus.emit('engine:save-error', { error: err instanceof Error ? err.message : String(err) });
    } finally { this.requestedSaveActive = false; }
  }

  /**
   * 执行一个完整的游戏回合
   *
   * 构建初始 PipelineContext 并启动 PipelineRunner。
   * abortController 在回合结束（正常或取消）后置 null，
   * 确保下一回合使用全新的取消信号。
   */
  private async runRound(userInput: string, stateManager: StateManager): Promise<void> {
    // UI events can be delivered twice before rendering disables the composer.
    // Keep one owner for the live state and optional post-save ability task.
    if (this.isBusy || this.subPipelines.stateEditInProgress?.()) {
      eventBus.emit('pipeline:input-rejected', { text: userInput });
      eventBus.emit('ui:toast', { type: 'info', i18nKey: 'mainGame.toast.roundBusy',
        message: '上一项操作仍在收尾，输入已保留，请稍后发送。', duration: 3000 });
      return;
    }
    this.abortController = new AbortController();
    const ownership = new RoundOwnership(this._getActiveSlot, () => this.stateRevision, this.abortController.signal);

    // 每回合读取设置，确保 APIPanel 的变更立即生效（无需重启）
    const { streaming, splitGen, contextCompiler } = readAISettings();

    // 记录玩家进入本回合时的位置，用于检测位置变更 → 触发 NPC 生成子管线
    const paths = this.subPipelines.paths;
    const locationBefore = paths
      ? (stateManager.get<string>(paths.playerLocation) ?? null)
      : null;

    // B0-1 guard: round number before the run, so a stale snapshot is never applied (see resolvePreRoundSnapshot).
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
      roundNumber: 0,
      generationId: generateId(),
      meta: { splitGen, contextCompiler, roundOwnership: ownership },
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

      // 自动回滚：PreProcess 在 AI 调用前已递增 roundNumber，不回滚会留下脏状态。
      // preRoundSnapshot 在递增前捕获，回滚后 roundNumber 恢复到正确值。
      //
      // 快照必须从状态树读，不能读 `initialCtx`（见 resolvePreRoundSnapshot）。
      const recoveryAllowed = !ownership.saved && ownership.isCurrent();
      const snapshot = resolvePreRoundSnapshot(stateManager, this._paths, {
        roundBefore,
        ctx: initialCtx,
      });
      if (snapshot && recoveryAllowed) {
        // Settings changed while the round ran stay (PO 2026-10-03).
        stateManager.rollbackTo(snapshot, PREFERENCE_PATHS);
        this.memoryManager.clearConfigCache();
        if (this.engramManager.isEnabled()) {
          this.engramManager.syncVectorsToState(stateManager).catch(() => {});
        }
        console.log('[Orchestrator] Auto-rolled back to pre-round snapshot after pipeline error');
      }
      eventBus.emit('ai:error', { error: err });
    } finally {
      this.abortController = null;
      if (!finalCtx) await this.flushRequestedSave();
    }

    // Body polish runs inside the pipeline (BodyPolishStage), not here.

    // ── GAP_AUDIT §G2: 消费主管线设置的 pending 标记，触发对应子管线 ──
    if (finalCtx) {
      this._subPipelineActive = true;
      try {
        await this.runPostRoundSubPipelines(finalCtx, stateManager, locationBefore);
      } finally {
        this._subPipelineActive = false;
        await this.flushRequestedSave();
        // Sub-pipeline AI calls may emit ai:retrying which sets isGenerating=true
        // in the UI. Ensure the UI resets after all sub-pipelines finish.
        eventBus.emit('engine:sub-pipelines-done');
      }
    }
  }

  /**
   * 主回合完成后的子管线调度。
   *
   * 触发源、调度顺序和失败隔离的实际规则以 core/post-round/index.ts 的 runPostRound 为准。
   */
  private runPostRoundSubPipelines(
    ctx: PipelineContext,
    stateManager: StateManager,
    locationBefore: string | null,
  ): Promise<void> {
    // Plain delegation (not `async`/`await`): the caller's continuation must resume in the
    // same microtask as the original inline body's return.
    return runPostRound(
      { sub: this.subPipelines, stateManager, paths: this._paths },
      ctx,
      locationBefore,
    );
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
      await this.flushRequestedSave();
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
    return buildOpeningStages({
      stateManager: this._stateManager,
      commandExecutor: this._commandExecutor,
      behaviorRunner: this._behaviorRunner,
      aiService: this._aiService,
      responseParser: this._responseParser,
      promptAssembler: this._promptAssembler,
      memoryManager: this.memoryManager,
      memoryRetriever: this._memoryRetriever,
      engramManager: this.engramManager,
      saveManager: this._saveManager,
      pack: this._pack,
      paths: this._paths,
      unifiedRetriever: this._unifiedRetriever,
      subPipelines: this.subPipelines,
      getActiveSlot: this._getActiveSlot,
    });
  }

  /** 销毁 Orchestrator — 应在 app 卸载时调用（防止内存泄漏） */
  destroy(): void {
    this.stateRevision++;
    this.pendingSave = null;
    this.abortController?.abort();
    this.subPipelines.plotVector?.dispose();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
