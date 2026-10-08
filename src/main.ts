// structuredClone polyfill — must run before any import that touches idb-adapter.
// Safe for AGA: persisted data is exclusively JSON-compatible (no Date/Map/Set/cycle).
// If a future module stores non-JSON-safe values, replace with a proper polyfill.
if (typeof globalThis.structuredClone !== 'function') {
  (globalThis as Record<string, unknown>).structuredClone = <T>(val: T): T =>
    JSON.parse(JSON.stringify(val)) as T;
}

/**
 * 应用入口 — 引擎初始化序列
 *
 * 启动流程（按依赖顺序）：
 * 1. Vue + Pinia + Router
 * 2. API 配置加载 → AIService
 * 3. 持久化层（ProfileManager → SaveManager）
 * 4. 配置系统（Registry + Store + Resolver）
 * 5. Game Pack 加载
 * 6. Prompt 引擎（PromptRegistry + TemplateEngine + PromptAssembler + ResponseParser）
 * 7. StateManager / CommandExecutor / BehaviorRunner / CharacterInitPipeline
 * 8. PromptStorage / VectorStore / BackupService（M5 备份与 Engram 持久化）
 * 9. Action Queue 恢复
 * 10. provide → 挂载
 */
import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './ui/router';
import { i18n, loadLocaleMessages } from './ui/i18n';
import './ui/styles/tokens.css';
import './ui/styles/forms.css';
import './ui/styles/mobile.css';

// Apply persisted font-size × ui-scale before any component renders so the
// user's preference survives page refresh regardless of which route they
// land on. SettingsPanel owns the source of truth; this is a cold-boot
// replay of what SettingsPanel.applyRootMetrics does.
(function applyPersistedRootMetrics(): void {
  try {
    const raw = localStorage.getItem('aga_user_settings');
    const scaleRaw = localStorage.getItem('aga_ui_scale');
    const parsed = raw ? (JSON.parse(raw) as { fontSize?: number; themeAccent?: string }) : {};
    const fontPx = typeof parsed.fontSize === 'number' ? parsed.fontSize : 14;
    const scalePct = scaleRaw ? Number(scaleRaw) : 100;
    const rootPx = (fontPx * scalePct) / 100;
    document.documentElement.style.fontSize = `${rootPx}px`;
    document.documentElement.style.setProperty('--base-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--narrative-font-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--ui-scale', `${scalePct}%`);
    if (typeof parsed.themeAccent === 'string') {
      document.documentElement.style.setProperty('--color-primary', parsed.themeAccent);
    }
  } catch { /* localStorage unavailable — skip silently */ }
})();

import { eventBus } from './engine/core/event-bus';
import { CharacterInitPipeline } from './engine/pipeline/sub-pipelines/character-init';
import { DEFAULT_ENGINE_PATHS } from './engine/pipeline/types';
import { GameOrchestrator } from './engine/core/game-orchestrator';
import { useEngineStateStore } from './engine/stores/engine-state';
import { AgaPlotVectorAdapter } from './features/plot-vector/aga-adapter';
import { VectorBoardAccess } from './features/plot-vector/board-access';
import { parseNativeRules } from './features/plot-vector/native-input';
import { parseSupplyRules, warmSupplyRatings } from './features/plot-vector/supply';
import { parseVectorPromptPolicy } from './features/plot-vector/prompt-policy';

import { requestPersistentStorage } from './engine/persistence/idb-adapter';
import { GameCardImportService } from './engine/export/game-card-import-service';
import { GitHubSyncService } from './engine/sync/github-sync';
import { LanSyncService } from './engine/sync/lan-sync';
import { AssistantService } from './engine/services/assistant/assistant-service';
import { PayloadApplier } from './engine/services/assistant/payload-applier';
import { PayloadValidator } from './engine/services/assistant/payload-validator';
import { WorldBuilderService } from './engine/services/world-builder/world-builder-service';
import { InMemoryConversationStore } from './engine/services/assistant/conversation-store';

import { useActionQueueStore } from './engine/stores/engine-action-queue';
import { usePromptDebugStore } from './engine/stores/engine-prompt';
import { createAiStack } from './bootstrap/ai-stack';
import { createPersistenceStack } from './bootstrap/persistence-stack';
import { loadPackAndMigrations } from './bootstrap/pack-and-migrations';
import { createPromptStack } from './bootstrap/prompt-stack';
import { createStateKernel } from './bootstrap/state-kernel';
import { createMemoryStack } from './bootstrap/memory-stack';
import { registerPackBehaviors } from './bootstrap/pack-behaviors';
import { createEngramStack } from './bootstrap/engram-stack';
import { createSubPipelines, type PlotVectorHolder } from './bootstrap/sub-pipelines';
import { createMediaServices } from './bootstrap/media-services';

async function bootstrap(): Promise<void> {
  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  app.use(i18n);

  // Pre-load non-default locale messages before first render
  try {
    await loadLocaleMessages(i18n.global.locale.value);
  } catch (err) {
    console.warn('[Bootstrap] Locale load failed, falling back to zh-CN:', err);
    i18n.global.locale.value = 'zh-CN';
  }

  const { aiService } = createAiStack();

  const { profileManager, saveManager, configRegistry, configStore, configResolver, promptStorage, vectorStore, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService } = await createPersistenceStack();

  const pack = await loadPackAndMigrations({ saveManager, customPresetStore });

  const { promptRegistry, responseParser, promptAssembler } = createPromptStack({ pack, worldBookStorage });

  const { stateManager, commandExecutor, behaviorRunner, calendar, engineStateStore } = createStateKernel({ pack });

  const { memoryManager, memoryRetriever } = createMemoryStack({ stateManager, behaviorRunner });

  registerPackBehaviors({ pack, stateManager, commandExecutor, behaviorRunner, calendar });

  const { getActiveSlot, engramManager, engramEditor, embedder, unifiedRetriever } = createEngramStack({ aiService, stateManager, engineStateStore, vectorStore });

  // CharacterInitPipeline is created after GameOrchestrator (below) to enable
  // EnhancedOpeningPipeline injection which requires orchestrator.createStagesForOpening().
  let characterInitPipeline: CharacterInitPipeline | null = null;

  // Assigned when the orchestrator is built; step-3 field repair asks it for environment-ability repairs.
  const plotVectorHolder: PlotVectorHolder = {};
  const { memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline } = createSubPipelines({ pack, aiService, responseParser, promptAssembler, stateManager, commandExecutor, memoryManager, memoryRetriever, engramManager, plotVectorHolder });

  const { imageService, ttsService, sttService } = createMediaServices({ pack, aiService, promptAssembler, stateManager });

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
    );
  }

  // ── CharacterInitPipeline + EnhancedOpeningPipeline (Story 0) ──
  // Created after GameOrchestrator so enhanced opening can access orchestrator.createStagesForOpening()
  let enhancedOpeningPipeline: import('./engine/pipeline/sub-pipelines/enhanced-opening').EnhancedOpeningPipeline | undefined;
  if (pack) {
    if (orchestrator) {
      const { EnhancedOpeningPipeline } = await import('./engine/pipeline/sub-pipelines/enhanced-opening');
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
  const { DEFAULT_ENHANCED_OPENING_SETTINGS } = await import('./engine/pipeline/sub-pipelines/enhanced-opening');
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
            // No abort: ⑦ is non-cancelable in the UI, so a never-aborting signal is intentional.
            abortSignal: args.abortSignal ?? new AbortController().signal,
            onProgress: args.onProgress ?? (() => {}),
            firstRoundSetup: args.firstRoundSetup, // D7: author opening-style hint
          })
      : undefined,
  });

  const actionQueueStore = useActionQueueStore();
  actionQueueStore.loadFromLocalStorage();

  app.provide('profileManager', profileManager);
  app.provide('saveManager', saveManager);
  app.provide('plotVectorBoard', plotVectorBoard);
  app.provide('promptStorage', promptStorage);
  if (plotDecomposer) app.provide('plotDecomposer', plotDecomposer);
  if (characterVectorProposePipeline) app.provide('characterVectorPropose', characterVectorProposePipeline);
  if (plotReviser) app.provide('plotReviser', plotReviser);
  // Lets the PlotPanel confirmation gate advance a confirmed critical node
  // immediately, instead of waiting for the next main round's evaluation pass.
  if (plotEvaluationPipeline) app.provide('plotEvaluation', plotEvaluationPipeline);
  app.provide('imageService', imageService);
  app.provide('ttsService', ttsService);
  app.provide('sttService', sttService);
  app.provide('vectorStore', vectorStore);
  app.provide('embedder', embedder);
  app.provide('backupService', backupService);
  app.provide('gameCardExportService', gameCardExportService);
  app.provide('gameCardImportService', gameCardImportService);
  // Story 7: card-export preview checks referenced images against the global cache (missing-image warning).
  app.provide('imageAssetCache', imageAssetCacheForBackup);
  app.provide('customPresetStore', customPresetStore);
  app.provide('worldBookStorage', worldBookStorage);

  const githubSync = new GitHubSyncService(backupService);
  app.provide('githubSync', githubSync);

  const lanSync = new LanSyncService(backupService);
  app.provide('lanSync', lanSync);

  // ── 2026-04-14：AI 助手 service ──
  // 复用现有 aiService（按 usageType='assistant' 路由 API 配置）。
  // 启动时 setSettings 从 localStorage 读 maxHistoryTurns 等。
  let assistantSettings = {
    maxHistoryTurns: 5,
    confirmBeforeInject: true,
    confirmBeforeClear: true,
    worldBuilderMode: false,
  };
  try {
    const raw = localStorage.getItem('aga_assistant_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.maxHistoryTurns === 'number') assistantSettings.maxHistoryTurns = parsed.maxHistoryTurns;
      if (typeof parsed.confirmBeforeInject === 'boolean') assistantSettings.confirmBeforeInject = parsed.confirmBeforeInject;
      if (typeof parsed.confirmBeforeClear === 'boolean') assistantSettings.confirmBeforeClear = parsed.confirmBeforeClear;
      if (typeof parsed.worldBuilderMode === 'boolean') assistantSettings.worldBuilderMode = parsed.worldBuilderMode;
    }
  } catch { /* ignore */ }
  const payloadApplier = new PayloadApplier({
    stateManager,
    commandExecutor,
  });
  const payloadValidator = new PayloadValidator({
    stateManager,
    gamePack: pack,
  });
  const assistantConversationStore = new InMemoryConversationStore();
  const assistantService = new AssistantService({
    aiService,
    stateManager,
    commandExecutor,
    gamePack: pack,
    prompts: promptAssembler,
    settings: assistantSettings,
    locale: i18n.global.locale.value,
    engramManager,
    payloadApplier,
    payloadValidator,
    conversationStore: assistantConversationStore,
  });
  const worldBuilderService = new WorldBuilderService({
    aiService,
    stateManager,
    gamePack: pack,
    prompts: promptAssembler,
    payloadValidator,
    engramManager,
    conversationStore: assistantConversationStore,
    locale: i18n.global.locale.value,
    maxHistoryTurns: assistantSettings.maxHistoryTurns,
  });
  app.provide('assistantService', assistantService);
  app.provide('worldBuilderService', worldBuilderService);
  app.provide('engramEditor', engramEditor);
  app.provide('engramManager', engramManager);
  app.provide('memoryRetriever', memoryRetriever);
  app.provide('configRegistry', configRegistry);
  app.provide('configResolver', configResolver);
  app.provide('eventBus', eventBus);
  app.provide('aiService', aiService);
  app.provide('stateManager', stateManager);
  app.provide('promptAssembler', promptAssembler);
  app.provide('promptRegistry', promptRegistry);
  app.provide('responseParser', responseParser);

  if (pack) {
    app.provide('gamePack', pack);
  }
  if (characterInitPipeline) {
    app.provide('characterInitPipeline', characterInitPipeline);
  }
  if (orchestrator) {
    app.provide('gameOrchestrator', orchestrator);
  }
  if (npcChatPipeline) {
    // §7.2: 注入 NPC 私聊管线，供 RelationshipPanel / NpcChatModal 使用
    app.provide('npcChatPipeline', npcChatPipeline);

    // ── CR-R7: 读档/创角完成后对所有 NPC 的 `私聊历史` 做一次性回溯性 trim ──
    // 场景：旧存档里 `私聊历史` 数组可能超过当前 maxChatHistory（例如 pack 调低了上限，
    // 或从未 trim 过的历史积累）。StateManager.loadTree 完成时 emit 'engine:state-changed'
    // type='load'，此时一次性收敛。运行时的增量 trim 已在 NpcChatPipeline.execute 内处理。
    const pipelineForTrim = npcChatPipeline;
    eventBus.on<{ type?: string }>('engine:state-changed', (payload) => {
      if (payload?.type === 'load') {
        pipelineForTrim.trimAllChatHistories();
      }
    });
  }

  app.mount('#app');
  eventBus.emit('engine:initialized', { packId: pack?.manifest.id ?? null });

  // 申请持久化存储：避免本源 IndexedDB 在磁盘紧张 / LRU 驱逐下被浏览器自动清空。
  // 放在 mount 之后，保证授予被拒时的警告 toast 能被已挂载的 Toast 组件显示。
  // 不 await —— 申请结果不阻断后续启动逻辑。
  void requestPersistentStorage();

  // Load world books when a game profile becomes active (fixes: first round with empty books)
  const engineState = useEngineStateStore();
  let lastWorldBookPid: string | null = null;
  // Watch only the profile id: `$subscribe` deep-watches the whole store state, which holds the game tree,
  // so every state change walked the entire tree (0.6 s per write on a large save).
  watch(() => engineState.activeProfileId, async (pid) => {
    if (!pid || pid === lastWorldBookPid) return;
    lastWorldBookPid = pid;
    try {
      const loadedBooks = await worldBookStorage.loadWorldBooks(pid);
      eventBus.emit('worldbook:updated', loadedBooks.filter((b) => b.enabled !== false));
    } catch { /* best-effort */ }
  }, { immediate: true });
}

bootstrap().catch(console.error);
