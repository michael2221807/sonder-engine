import { ConfigRegistry, ConfigResolver, ConfigStore } from '../engine/core/config-system';
import { GameCardExportService } from '../engine/export/game-card-export-service';
import { ImageAssetCache } from '../engine/image/asset-cache';
import { VectorStore } from '../engine/memory/engram/vector-store';
import { BackupService } from '../engine/persistence/backup-service';
import { CustomPresetStore } from '../engine/persistence/custom-preset-store';
import { ProfileManager } from '../engine/persistence/profile-manager';
import { SaveManager } from '../engine/persistence/save-manager';
import { PromptStorage } from '../engine/prompt/prompt-storage';
import { WorldBookStorage } from '../engine/prompt/world-book-storage';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export async function createPersistenceStack() {
  const profileManager = new ProfileManager();
  await profileManager.initialize();
  const saveManager = new SaveManager(profileManager);

  const configRegistry = new ConfigRegistry();
  const configStore = new ConfigStore();
  const configResolver = new ConfigResolver(configRegistry, configStore);

  configRegistry.register({
    id: 'enhancedOpening',
    name: 'Enhanced Opening Settings',
    description: 'Story 0 enhanced opening pipeline user preferences',
    schema: {},
    version: 1,
    defaultSource: 'ui/creation',
  });

  const promptStorage = new PromptStorage();
  const vectorStore = new VectorStore();
  // 2026-04-14：用户自定义创角预设仓库（按 packId 隔离）
  const customPresetStore = new CustomPresetStore();
  const imageAssetCacheForBackup = new ImageAssetCache();
  const worldBookStorage = new WorldBookStorage();
  const backupService = new BackupService(
    profileManager,
    saveManager,
    configStore,
    promptStorage,
    vectorStore,
    customPresetStore,
    imageAssetCacheForBackup,
    worldBookStorage,
  );

  // Story 5: game-card export service (shares backup's stores; default strip paths from DEFAULT_ENGINE_PATHS).
  const gameCardExportService = new GameCardExportService(
    saveManager,
    configStore,
    promptStorage,
    worldBookStorage,
    customPresetStore,
    imageAssetCacheForBackup,
  );

  return { profileManager, saveManager, configRegistry, configStore, configResolver, promptStorage, vectorStore, customPresetStore, imageAssetCacheForBackup, worldBookStorage, backupService, gameCardExportService };
}
