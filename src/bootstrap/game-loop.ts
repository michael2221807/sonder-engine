import type { PlotVectorHolder } from './sub-pipelines';
import type { AIService } from '../engine/ai/ai-service';
import type { ResponseParser } from '../engine/ai/response-parser';
import type { BehaviorRunner } from '../engine/behaviors/behavior-runner';
import type { CommandExecutor } from '../engine/core/command-executor';
import type { ConfigStore } from '../engine/core/config-system';
import { GameOrchestrator } from '../engine/core/game-orchestrator';
import type { RollbackSnapshot } from '../engine/core/rollback-snapshot';
import type { StateManager } from '../engine/core/state-manager';
import { GameCardImportService } from '../engine/export/game-card-import-service';
import type { ImageAssetCache } from '../engine/image/asset-cache';
import type { ImageService } from '../engine/image/image-service';
import type { EngramManager } from '../engine/memory/engram/engram-manager';
import type { UnifiedRetriever } from '../engine/memory/engram/unified-retriever';
import type { MemoryManager } from '../engine/memory/memory-manager';
import type { MemoryRetriever } from '../engine/memory/memory-retriever';
import type { CustomPresetStore } from '../engine/persistence/custom-preset-store';
import type { ProfileManager } from '../engine/persistence/profile-manager';
import type { SaveManager } from '../engine/persistence/save-manager';
import { CharacterInitPipeline } from '../engine/pipeline/sub-pipelines/character-init';
import type { CharacterVectorProposePipeline } from '../engine/pipeline/sub-pipelines/character-vector-propose';
import type { FieldRepairPipeline } from '../engine/pipeline/sub-pipelines/field-repair';
import type { LongTermCompactPipeline } from '../engine/pipeline/sub-pipelines/long-term-compact';
import type { MemorySummaryPipeline } from '../engine/pipeline/sub-pipelines/memory-summary';
import type { MidTermRefinePipeline } from '../engine/pipeline/sub-pipelines/mid-term-refine';
import type { NpcGenerationPipeline } from '../engine/pipeline/sub-pipelines/npc-generation';
import type { PrivacyProfileRepairPipeline } from '../engine/pipeline/sub-pipelines/privacy-profile-repair';
import type { WorldHeartbeatPipeline } from '../engine/pipeline/sub-pipelines/world-heartbeat';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import type { PlotEvaluationPipeline } from '../engine/plot/plot-evaluation-pipeline';
import type { PromptAssembler } from '../engine/prompt/prompt-assembler';
import type { PromptRegistry } from '../engine/prompt/prompt-registry';
import type { PromptStorage } from '../engine/prompt/prompt-storage';
import type { WorldBookStorage } from '../engine/prompt/world-book-storage';
import type { NpcMemorySummarizer } from '../engine/social/npc-memory-summarizer';
import { useActionQueueStore } from '../engine/stores/engine-action-queue';
import { usePromptDebugStore } from '../engine/stores/engine-prompt';
import { useEngineStateStore } from '../engine/stores/engine-state';
import type { TtsService } from '../engine/tts/tts-service';
import type { GamePack } from '../engine/types';
import { AgaPlotVectorAdapter } from '../features/plot-vector/aga-adapter';
import { VectorBoardAccess } from '../features/plot-vector/board-access';
import { parseNativeRules } from '../features/plot-vector/native-input';
import { parseVectorPromptPolicy } from '../features/plot-vector/prompt-policy';
import { parseSupplyRules, warmSupplyRatings } from '../features/plot-vector/supply';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export async function createGameLoop(deps: {
  pack: GamePack | null;
  aiService: AIService;
  responseParser: ResponseParser;
  promptAssembler: PromptAssembler;
  promptRegistry: PromptRegistry;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  behaviorRunner: BehaviorRunner;
  engineStateStore: ReturnType<typeof useEngineStateStore>;
  memoryManager: MemoryManager;
  memoryRetriever: MemoryRetriever;
  engramManager: EngramManager;
  unifiedRetriever: UnifiedRetriever;
  getActiveSlot: () => { profileId: string; slotId: string } | null;
  saveManager: SaveManager;
  profileManager: ProfileManager;
  configStore: ConfigStore;
  promptStorage: PromptStorage;
  customPresetStore: CustomPresetStore;
  imageAssetCacheForBackup: ImageAssetCache;
  worldBookStorage: WorldBookStorage;
  imageService: ImageService;
  ttsService: TtsService;
  memorySummaryPipeline: MemorySummaryPipeline | undefined;
  midTermRefinePipeline: MidTermRefinePipeline | undefined;
  characterVectorProposePipeline: CharacterVectorProposePipeline | undefined;
  longTermCompactPipeline: LongTermCompactPipeline | undefined;
  worldHeartbeatPipeline: WorldHeartbeatPipeline | undefined;
  npcGenerationPipeline: NpcGenerationPipeline | undefined;
  privacyRepairPipeline: PrivacyProfileRepairPipeline | undefined;
  fieldRepairPipeline: FieldRepairPipeline | undefined;
  npcMemSummarizer: NpcMemorySummarizer | undefined;
  plotEvaluationPipeline: PlotEvaluationPipeline | undefined;
  plotVectorHolder: PlotVectorHolder;
  rollbackSnapshot: RollbackSnapshot;
}) {
  const { pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, behaviorRunner, engineStateStore, memoryManager, memoryRetriever, engramManager, unifiedRetriever, getActiveSlot, saveManager, profileManager, configStore, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, imageService, ttsService, memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotVectorHolder, rollbackSnapshot } = deps;
  // 存档瘦身 D1A: every save stores, in place of the tree's rollback marker, the patch back to the held snapshot.
  saveManager.setTreeToSave((tree) => rollbackSnapshot.treeToSave(tree));
  // CharacterInitPipeline is created after GameOrchestrator (below) to enable
  // EnhancedOpeningPipeline injection which requires orchestrator.createStagesForOpening().
  let characterInitPipeline: CharacterInitPipeline | null = null;

  // ── #1: 创建 Orchestrator，接通 pipeline:user-input → PipelineRunner ──
  let orchestrator: GameOrchestrator | null = null;
  const vectorNativeRules = parseNativeRules(pack?.rules.plotVector);
  // The general supply pool is pack content; the engine rates and deals it (phase 6).
  const vectorSupplyRules = parseSupplyRules(pack?.rules.plotVector);
  // Rate the pool while the page is idle, so the first board opening or round does not wait for it.
  if (vectorSupplyRules) warmSupplyRatings(vectorSupplyRules, slice => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => slice(), { timeout: 5000 });
    else setTimeout(slice, 50);
  });
  const parsedVectorPolicy = parseVectorPromptPolicy(pack?.rules.plotVectorPrompts, pack?.prompts.plotVectorMode);
  // The mode prompt is read when a round sends it, as the player left it on the prompt page (edited, or '' when
  // switched off); the pack's text only decides whether the pack offers the mode at all.
  const vectorPromptPolicy = parsedVectorPolicy && {
    ...parsedVectorPolicy,
    get mode() { return promptRegistry.getEffectiveContent('plotVectorMode'); },
  };
  const plotVectorBoard = new VectorBoardAccess(stateManager, saveManager, getActiveSlot,
    () => !orchestrator || orchestrator.isBusy, vectorNativeRules,
    () => orchestrator?.onStateEditSettled(),
    // The player's ability retry runs through the round adapter (same repair and binding as Step 3).
    (entryId) => plotVectorHolder.adapter ? plotVectorHolder.adapter.regenerateAbility(entryId) : Promise.reject(new Error('ability-retry-unavailable')),
    vectorSupplyRules);
  if (pack) {
    orchestrator = new GameOrchestrator(
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
      DEFAULT_ENGINE_PATHS,
      unifiedRetriever, // E.2/E.3: hybrid 检索路径
      {                 // §G2 + §11.2 B: 子管线包
        memorySummary: memorySummaryPipeline,
        midTermRefine: midTermRefinePipeline,
        characterVectorPropose: characterVectorProposePipeline,
        longTermCompact: longTermCompactPipeline, // 2026-04-11 新增：长期二级精炼
        worldHeartbeat: worldHeartbeatPipeline,
        npcGeneration: npcGenerationPipeline,
        privacyRepair: privacyRepairPipeline,
        fieldRepair: fieldRepairPipeline,
        npcMemorySummarizer: npcMemSummarizer,
        imageService,
        ttsService,
        memoryManager,
        paths: DEFAULT_ENGINE_PATHS,
        plotEvaluation: plotEvaluationPipeline,
        plotVector: plotVectorHolder.adapter = new AgaPlotVectorAdapter(stateManager, aiService, saveManager, getActiveSlot, vectorNativeRules,
          vectorPromptPolicy, vectorSupplyRules),
        stateEditInProgress: () => plotVectorBoard.isSaving,
      },
      {
        // Closures moved verbatim from GameOrchestrator: each resolves its Pinia store at CALL time.
        // PostProcessStage 需要 profileId/slotId，通过闭包从 Pinia store 读取。
        // 这里读取是安全的：闭包只在 autoSave() 中被调用，
        // 彼时 Vue 应用已挂载、Pinia 已激活。
        getActiveSlot: (): { profileId: string; slotId: string } | null => {
          const store = useEngineStateStore();
          if (!store.activeProfileId || !store.activeSlotId) return null;
          return { profileId: store.activeProfileId, slotId: store.activeSlotId };
        },
        // PreProcessStage 消费 action queue；同理通过闭包延迟读取 Pinia store。
        actionQueue: {
          consumeActions: () => useActionQueueStore().consumeActions(),
        },
        promptDebug: {
          recordAssembly: (...args) => usePromptDebugStore().recordAssembly(...args),
          attachResponse: (...args) => usePromptDebugStore().attachResponse(...args),
        },
      },
      rollbackSnapshot,
    );
  }

  // ── CharacterInitPipeline + EnhancedOpeningPipeline (Story 0) ──
  // Created after GameOrchestrator so enhanced opening can access orchestrator.createStagesForOpening()
  let enhancedOpeningPipeline: import('../engine/pipeline/sub-pipelines/enhanced-opening').EnhancedOpeningPipeline | undefined;
  if (pack) {
    if (orchestrator) {
      const { EnhancedOpeningPipeline } = await import('../engine/pipeline/sub-pipelines/enhanced-opening');
      const openingStages = orchestrator.createStagesForOpening();
      enhancedOpeningPipeline = new EnhancedOpeningPipeline(
        stateManager,
        aiService,
        promptAssembler,
        pack,
        orchestrator,
        openingStages,
        DEFAULT_ENGINE_PATHS,
      );
    }
    characterInitPipeline = new CharacterInitPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      saveManager,
      profileManager,
      behaviorRunner,
      pack,
      DEFAULT_ENGINE_PATHS,
      memoryManager,
      enhancedOpeningPipeline,
    );
  }

  // Story 6: game-card import service — Stage-2 deps wired here (all stores now constructed).
  // getPack defaults to the bootstrap singleton; activateSave bridges to the Pinia engineState
  // (engine code must not import the store); runOpening reuses EnhancedOpeningPipeline Phase E–F–G.
  const { DEFAULT_ENHANCED_OPENING_SETTINGS } = await import('../engine/pipeline/sub-pipelines/enhanced-opening');
  const openingPipelineForImport = enhancedOpeningPipeline;
  const gameCardImportService = new GameCardImportService(undefined, {
    stateManager,
    saveManager,
    profileManager,
    imageAssetCache: imageAssetCacheForBackup,
    customPresetStore,
    worldBookStorage,
    configStore,
    promptStorage,
    engramManager,
    hasEmbedder: () => aiService.getConfigForUsage('embedding') !== undefined,
    activateSave: (tree, pkgId, profileId, slotId) =>
      engineStateStore.loadGame(tree, pkgId, profileId, slotId),
    runOpening: openingPipelineForImport
      ? (args) =>
          openingPipelineForImport.executeImportOpening({
            settings: DEFAULT_ENHANCED_OPENING_SETTINGS,
            nsfwMode: args.nsfwMode,
            choices: { selections: {} },
            // The UI's skip-opening button aborts args.abortSignal; the never-aborting fallback only covers callers that pass none.
            abortSignal: args.abortSignal ?? new AbortController().signal,
            onProgress: args.onProgress ?? (() => {}),
            firstRoundSetup: args.firstRoundSetup, // D7: author opening-style hint
          })
      : undefined,
  });

  return { plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService };
}
