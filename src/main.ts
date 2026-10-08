// structuredClone polyfill. ES imports are hoisted, so this runs AFTER every imported module has been
// evaluated and BEFORE bootstrap() starts; nothing evaluated at import time may depend on it
// (idb-adapter only calls structuredClone lazily).
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
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './ui/router';
import { i18n, loadLocaleMessages } from './ui/i18n';
import './ui/styles/tokens.css';
import './ui/styles/forms.css';
import './ui/styles/mobile.css';

import { applyPersistedRootMetrics } from './bootstrap/root-metrics';
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
import { provideServices } from './bootstrap/provide-services';
import { mountAndFollowUp } from './bootstrap/post-mount';

// Cold-boot replay of the persisted font-size x ui-scale (see bootstrap/root-metrics.ts); runs before
// bootstrap() mounts anything, after all imports are evaluated.
applyPersistedRootMetrics();

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

  provideServices({ app, pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, memoryRetriever, engramManager, engramEditor, embedder, vectorStore, saveManager, profileManager, configRegistry, configResolver, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService, imageService, ttsService, sttService, characterVectorProposePipeline, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline, plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService });

  mountAndFollowUp({ app, pack, worldBookStorage });
}

bootstrap().catch(console.error);
