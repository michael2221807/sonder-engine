import type { AIService } from '../engine/ai/ai-service';
import type { ResponseParser } from '../engine/ai/response-parser';
import type { CommandExecutor } from '../engine/core/command-executor';
import type { ConfigRegistry, ConfigResolver } from '../engine/core/config-system';
import { eventBus } from '../engine/core/event-bus';
import type { GameOrchestrator } from '../engine/core/game-orchestrator';
import type { StateManager } from '../engine/core/state-manager';
import type { GameCardExportService } from '../engine/export/game-card-export-service';
import type { GameCardImportService } from '../engine/export/game-card-import-service';
import type { ImageAssetCache } from '../engine/image/asset-cache';
import type { ImageService } from '../engine/image/image-service';
import type { Embedder } from '../engine/memory/engram/embedder';
import type { EngramEditor } from '../engine/memory/engram/engram-editor';
import type { EngramManager } from '../engine/memory/engram/engram-manager';
import type { VectorStore } from '../engine/memory/engram/vector-store';
import type { MemoryRetriever } from '../engine/memory/memory-retriever';
import type { BackupService } from '../engine/persistence/backup-service';
import type { CustomPresetStore } from '../engine/persistence/custom-preset-store';
import type { ProfileManager } from '../engine/persistence/profile-manager';
import type { SaveManager } from '../engine/persistence/save-manager';
import type { CharacterInitPipeline } from '../engine/pipeline/sub-pipelines/character-init';
import type { CharacterVectorProposePipeline } from '../engine/pipeline/sub-pipelines/character-vector-propose';
import type { NpcChatPipeline } from '../engine/pipeline/sub-pipelines/npc-chat';
import type { PlotDecomposer } from '../engine/plot/plot-decomposer';
import type { PlotEvaluationPipeline } from '../engine/plot/plot-evaluation-pipeline';
import type { PlotReviser } from '../engine/plot/plot-reviser';
import type { PromptAssembler } from '../engine/prompt/prompt-assembler';
import type { PromptRegistry } from '../engine/prompt/prompt-registry';
import type { PromptStorage } from '../engine/prompt/prompt-storage';
import type { WorldBookStorage } from '../engine/prompt/world-book-storage';
import { AssistantService } from '../engine/services/assistant/assistant-service';
import { InMemoryConversationStore } from '../engine/services/assistant/conversation-store';
import { PayloadApplier } from '../engine/services/assistant/payload-applier';
import { PayloadValidator } from '../engine/services/assistant/payload-validator';
import { WorldBuilderService } from '../engine/services/world-builder/world-builder-service';
import { useActionQueueStore } from '../engine/stores/engine-action-queue';
import type { SttService } from '../engine/stt/stt-service';
import { GitHubSyncService } from '../engine/sync/github-sync';
import { LanSyncService } from '../engine/sync/lan-sync';
import type { TtsService } from '../engine/tts/tts-service';
import type { GamePack } from '../engine/types';
import type { VectorBoardAccess } from '../features/plot-vector/board-access';
import { i18n } from '../ui/i18n';
import type { App as VueApp } from 'vue';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function provideServices(deps: {
  app: VueApp;
  pack: GamePack | null;
  aiService: AIService;
  responseParser: ResponseParser;
  promptAssembler: PromptAssembler;
  promptRegistry: PromptRegistry;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  memoryRetriever: MemoryRetriever;
  engramManager: EngramManager;
  engramEditor: EngramEditor;
  embedder: Embedder;
  vectorStore: VectorStore;
  saveManager: SaveManager;
  profileManager: ProfileManager;
  configRegistry: ConfigRegistry;
  configResolver: ConfigResolver;
  promptStorage: PromptStorage;
  customPresetStore: CustomPresetStore;
  imageAssetCacheForBackup: ImageAssetCache;
  worldBookStorage: WorldBookStorage;
  backupService: BackupService;
  gameCardExportService: GameCardExportService;
  imageService: ImageService;
  ttsService: TtsService;
  sttService: SttService;
  characterVectorProposePipeline: CharacterVectorProposePipeline | undefined;
  plotEvaluationPipeline: PlotEvaluationPipeline | undefined;
  plotDecomposer: PlotDecomposer | undefined;
  plotReviser: PlotReviser | undefined;
  npcChatPipeline: NpcChatPipeline | null;
  plotVectorBoard: VectorBoardAccess;
  orchestrator: GameOrchestrator | null;
  characterInitPipeline: CharacterInitPipeline | null;
  gameCardImportService: GameCardImportService;
}) {
  const { app, pack, aiService, responseParser, promptAssembler, promptRegistry, stateManager, commandExecutor, memoryRetriever, engramManager, engramEditor, embedder, vectorStore, saveManager, profileManager, configRegistry, configResolver, promptStorage, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService, imageService, ttsService, sttService, characterVectorProposePipeline, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline, plotVectorBoard, orchestrator, characterInitPipeline, gameCardImportService } = deps;
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
}
