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
import { useEngineStateStore } from './engine/stores/engine-state';

import { requestPersistentStorage } from './engine/persistence/idb-adapter';
import { GitHubSyncService } from './engine/sync/github-sync';
import { LanSyncService } from './engine/sync/lan-sync';
import { AssistantService } from './engine/services/assistant/assistant-service';
import { PayloadApplier } from './engine/services/assistant/payload-applier';
import { PayloadValidator } from './engine/services/assistant/payload-validator';
import { WorldBuilderService } from './engine/services/world-builder/world-builder-service';
import { InMemoryConversationStore } from './engine/services/assistant/conversation-store';

import { useActionQueueStore } from './engine/stores/engine-action-queue';
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
import { createGameLoop } from './bootstrap/game-loop';

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

  // Assigned when the orchestrator is built; step-3 field repair asks it for environment-ability repairs.
  const plotVectorHolder: PlotVectorHolder = {};
  const { memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline } = createSubPipelines({ pack, aiService, responseParser, promptAssembler, stateManager, commandExecutor, memoryManager, memoryRetriever, engramManager, plotVectorHolder });

  const { imageService, ttsService, sttService } = createMediaServices({ pack, aiService, promptAssembler, stateManager });

  const { plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService } = await createGameLoop({ pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, behaviorRunner, engineStateStore, memoryManager, memoryRetriever, engramManager, unifiedRetriever, getActiveSlot, saveManager, profileManager, configStore, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, imageService, ttsService, memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotVectorHolder });

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
