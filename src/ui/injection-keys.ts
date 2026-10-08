import type { AIService } from '../engine/ai/ai-service';
import type { ResponseParser } from '../engine/ai/response-parser';
import type { ConfigRegistry, ConfigResolver } from '../engine/core/config-system';
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
import type { AssistantService } from '../engine/services/assistant/assistant-service';
import type { WorldBuilderService } from '../engine/services/world-builder/world-builder-service';
import type { SttService } from '../engine/stt/stt-service';
import type { GitHubSyncService } from '../engine/sync/github-sync';
import type { LanSyncService } from '../engine/sync/lan-sync';
import type { TtsService } from '../engine/tts/tts-service';
import type { GamePack } from '../engine/types';
import type { VectorBoardAccess } from '../features/plot-vector/board-access';
import type { eventBus } from '../engine/core/event-bus';
import { inject } from 'vue';
import type { App as VueApp } from 'vue';

/**
 * Every service main.ts hands to the UI through `app.provide`, keyed by the ORIGINAL string key
 * (e2e reads `_context.provides.gameOrchestrator` / `stateManager` by name, so the keys must not change).
 * Some are provided only when a pack is loaded; consumers that inject them must tolerate `undefined`.
 */
export interface AppServices {
  profileManager: ProfileManager;
  saveManager: SaveManager;
  plotVectorBoard: VectorBoardAccess;
  promptStorage: PromptStorage;
  plotDecomposer: PlotDecomposer;
  characterVectorPropose: CharacterVectorProposePipeline;
  plotReviser: PlotReviser;
  plotEvaluation: PlotEvaluationPipeline;
  imageService: ImageService;
  ttsService: TtsService;
  sttService: SttService;
  vectorStore: VectorStore;
  embedder: Embedder;
  backupService: BackupService;
  gameCardExportService: GameCardExportService;
  gameCardImportService: GameCardImportService;
  imageAssetCache: ImageAssetCache;
  customPresetStore: CustomPresetStore;
  worldBookStorage: WorldBookStorage;
  githubSync: GitHubSyncService;
  lanSync: LanSyncService;
  assistantService: AssistantService;
  worldBuilderService: WorldBuilderService;
  engramEditor: EngramEditor;
  engramManager: EngramManager;
  memoryRetriever: MemoryRetriever;
  configRegistry: ConfigRegistry;
  configResolver: ConfigResolver;
  eventBus: typeof eventBus;
  aiService: AIService;
  stateManager: StateManager;
  promptAssembler: PromptAssembler;
  promptRegistry: PromptRegistry;
  responseParser: ResponseParser;
  gamePack: GamePack;
  characterInitPipeline: CharacterInitPipeline;
  gameOrchestrator: GameOrchestrator;
  npcChatPipeline: NpcChatPipeline;
}

/** Typed `app.provide`: same key string, same value, but the value must match the declared service type. */
export function provideService<K extends keyof AppServices>(app: VueApp, key: K, value: AppServices[K]): void {
  app.provide(key as string, value);
}

/**
 * Typed `inject`. The extra arguments are forwarded as a rest tuple so the argument COUNT reaches Vue
 * unchanged: `inject(k)` (warns when missing) and `inject(k, undefined)` (silent) behave differently.
 */
export function injectService<K extends keyof AppServices>(key: K): AppServices[K] | undefined;
export function injectService<K extends keyof AppServices>(key: K, defaultValue: AppServices[K] | null): AppServices[K] | null;
export function injectService<K extends keyof AppServices>(key: K, defaultValue: undefined): AppServices[K] | undefined;
export function injectService<K extends keyof AppServices>(key: K, ...rest: unknown[]): unknown {
  // Vue's inject has overloads that cannot be spread directly; the cast keeps its runtime behavior.
  return (inject as unknown as (k: string, ...r: unknown[]) => unknown)(key, ...rest);
}
