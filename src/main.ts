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
 * 启动流程（按依赖顺序，每一步的细节在 src/bootstrap/ 对应文件里；boot-trace.test.ts 锁定了
 * provide 键与顺序）：
 * 1. Vue + Pinia + Router + i18n（预加载当前语言包）
 * 2. AI 栈（createAiStack）
 * 3. 持久化层（createPersistenceStack：档案/存档/配置/备份等）
 * 4. Game Pack 加载 + 存档迁移注册（loadPackAndMigrations）
 * 5. Prompt 栈（createPromptStack）
 * 6. 状态内核（createStateKernel：StateManager / CommandExecutor / BehaviorRunner）
 * 7. 记忆栈、pack 行为模块、Engram 栈
 * 8. 子管线（createSubPipelines）、媒体服务（生图/配音/听写）
 * 9. 游戏主循环（createGameLoop：编排器、创角管线、卡片服务）
 * 10. provide → 挂载（provideServices、mountAndFollowUp）
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

  const { stateManager, commandExecutor, behaviorRunner, calendar, engineStateStore, rollbackSnapshot } = createStateKernel({ pack });

  const { memoryManager, memoryRetriever } = createMemoryStack({ stateManager, behaviorRunner });

  registerPackBehaviors({ pack, stateManager, commandExecutor, behaviorRunner, calendar });

  const { getActiveSlot, engramManager, engramEditor, embedder, unifiedRetriever } = createEngramStack({ aiService, stateManager, engineStateStore, vectorStore, rollbackSnapshot });

  // Assigned when the orchestrator is built; step-3 field repair asks it for environment-ability repairs.
  const plotVectorHolder: PlotVectorHolder = {};
  const { memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline } = createSubPipelines({ pack, aiService, responseParser, promptAssembler, stateManager, commandExecutor, memoryManager, memoryRetriever, engramManager, plotVectorHolder });

  const { imageService, ttsService, sttService } = createMediaServices({ pack, aiService, promptAssembler, stateManager });

  const { plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService } = await createGameLoop({ pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, behaviorRunner, engineStateStore, memoryManager, memoryRetriever, engramManager, unifiedRetriever, getActiveSlot, saveManager, profileManager, configStore, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, imageService, ttsService, memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotVectorHolder, rollbackSnapshot });

  provideServices({ app, pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, memoryRetriever, engramManager, engramEditor, embedder, vectorStore, saveManager, profileManager, configRegistry, configResolver, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService, imageService, ttsService, sttService, characterVectorProposePipeline, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline, plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService, rollbackSnapshot });

  mountAndFollowUp({ app, pack, worldBookStorage });
}

bootstrap().catch(console.error);
