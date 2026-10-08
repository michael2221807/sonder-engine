/**
 * Real-store harness for the R6 behaviour locks (backup round trip and GitHub request trace).
 *
 * Everything is the production implementation on a fake IndexedDB: ProfileManager, SaveManager, ConfigStore,
 * PromptStorage, VectorStore, CustomPresetStore, ImageAssetCache, WorldBookStorage, BackupService, the event bus. The
 * `idbAdapter` is a module singleton that caches its connection, so every harness resets the module registry, installs
 * a new `IDBFactory` and imports the modules again. Only Date is faked (fake-indexeddb needs the real timers),
 * `Math.random` is fixed, localStorage is the in-memory mock with the device id preset.
 *
 * A harness owns the globals while it is in use: build the next one only after the previous one has been fully used.
 */
import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createMockLocalStorage } from './local-storage.mock';
import { installFileReaderStub } from './file-reader.stub';
import type { ProfileMeta } from '../types';
import type { ImageAsset } from '../image/types';
import type { WorldBook, BuiltinPromptEntry } from '../prompt/world-book';
import type { ConfigOverlay } from '../types/config';

export const FIXED_NOW = new Date('2026-10-08T00:00:00.000Z');
export const FIXED_RANDOM = 0.123456;
export const DEVICE_ID = 'dev_0a0b0c0d';
export const GH_TOKEN = 'ghp_FAKE0000';

/** 'full' = the rich source machine, 'local' = a different small machine to import into, 'empty' = nothing. */
export type SeedKind = 'full' | 'local' | 'empty';

type Json = Record<string, unknown>;

/** The modules a harness imported after the registry reset. */
async function importModules() {
  const [backup, pm, sm, cfg, prompts, vec, presets, cache, books, bus, idb] = await Promise.all([
    import('../persistence/backup-service'),
    import('../persistence/profile-manager'),
    import('../persistence/save-manager'),
    import('../core/config-system'),
    import('../prompt/prompt-storage'),
    import('../memory/engram/vector-store'),
    import('../persistence/custom-preset-store'),
    import('../image/asset-cache'),
    import('../prompt/world-book-storage'),
    import('../core/event-bus'),
    import('../persistence/idb-adapter'),
  ]);
  return {
    BackupService: backup.BackupService,
    ProfileSaveIntegrityError: backup.ProfileSaveIntegrityError,
    ProfileManager: pm.ProfileManager,
    SaveManager: sm.SaveManager,
    ConfigStore: cfg.ConfigStore,
    PromptStorage: prompts.PromptStorage,
    VectorStore: vec.VectorStore,
    CustomPresetStore: presets.CustomPresetStore,
    ImageAssetCache: cache.ImageAssetCache,
    WorldBookStorage: books.WorldBookStorage,
    eventBus: bus.eventBus,
    idbAdapter: idb.idbAdapter,
  };
}

export type HarnessModules = Awaited<ReturnType<typeof importModules>>;

export interface Recorded { event: string; payload: unknown }

export interface BackupHarness {
  mods: HarnessModules;
  backup: InstanceType<HarnessModules['BackupService']>;
  profiles: InstanceType<HarnessModules['ProfileManager']>;
  saves: InstanceType<HarnessModules['SaveManager']>;
  config: InstanceType<HarnessModules['ConfigStore']>;
  prompts: InstanceType<HarnessModules['PromptStorage']>;
  vectors: InstanceType<HarnessModules['VectorStore']>;
  presets: InstanceType<HarnessModules['CustomPresetStore']>;
  images: InstanceType<HarnessModules['ImageAssetCache']>;
  books: InstanceType<HarnessModules['WorldBookStorage']>;
  storage: Storage;
  /** Every event emitted since `startRecording()` (the real bus still delivers them). */
  emits: Recorded[];
  startRecording(): void;
  // fixture builders (real store calls)
  addProfile(profileId: string, characterName: string, slotIds: string[]): Promise<void>;
  saveSlot(profileId: string, slotId: string, tree: Json): Promise<void>;
  storeImage(id: string, text?: string, sizeBytes?: number): Promise<void>;
  putBook(profileId: string, id: string, entryCount?: number): Promise<void>;
}

export function profileMeta(profileId: string, characterName: string, slotIds: string[]): ProfileMeta {
  const slots: ProfileMeta['slots'] = {};
  for (const slotId of slotIds) {
    slots[slotId] = { slotId, slotName: `Slot ${slotId}`, lastSavedAt: null, packId: 'tianming', packVersion: '1.0.0' };
  }
  return { profileId, createdAt: '2026-10-01T00:00:00.000Z', packId: 'tianming', characterName, slots, activeSlotId: slotIds[0] ?? null };
}

export function imageAsset(id: string, text: string, sizeBytes?: number): ImageAsset {
  return {
    id, taskId: `task_${id}`, storageKey: id, mimeType: 'image/png', width: 8, height: 8,
    sizeBytes: sizeBytes ?? text.length, backend: 'novelai', createdAt: 1, origin: 'generated',
  };
}

export function worldBook(id: string, entryCount = 2): WorldBook {
  const entries = [];
  for (let i = 1; i <= entryCount; i++) {
    entries.push({
      id: `${id}_e${i}`, title: `${id} entry ${i}`, content: `content of ${id} entry ${i}`, type: 'lore',
      scope: ['main'], injectionMode: 'always', enabled: true, createdAt: 1, updatedAt: 1,
    });
  }
  return { id, title: `Book ${id}`, enabled: true, entries, createdAt: 1, updatedAt: 1 } as unknown as WorldBook;
}

/** A state tree that references images the way the collector walks them. */
export function stateTree(label: string, round: number, extra: Json = {}): Json {
  return {
    元数据: { 回合序号: round },
    角色: { 基础信息: { 姓名: label, 当前位置: `${label} 的小院` } },
    社交: { 关系: [] },
    系统: { 扩展: {} },
    ...extra,
  };
}

/** The rich tree of the source machine's first slot: every image reference kind the collector knows. */
function richTree(): Json {
  return stateTree('Alice', 3, {
    角色: {
      基础信息: { 姓名: 'Alice', 当前位置: '青石镇' },
      图片档案: {
        已选头像图片ID: 'img_avatar_a', 已选立绘图片ID: 'img_portrait_a', 已选背景图片ID: '',
        生图历史: [{ id: 'img_hist_a1' }, { id: 'img_hist_a2' }], 最近生图结果: 'img_hist_a1',
        香闺秘档: { 胸部: { assetId: 'img_secret_a' } },
      },
    },
    社交: { 关系: [{ 名称: '林暖', 图片档案: { 已选头像图片ID: 'img_npc_1' } }] },
    系统: {
      扩展: {
        image: {
          sceneArchive: { 当前壁纸图片ID: 'img_wall_a', 生图历史: [{ id: 'img_scene_1' }] },
          tasks: [
            { providerMeta: { reference: { sourceAssetIds: ['img_ref_used', ''] } } },
            { providerMeta: { reference: { sourceAssetId: 'img_legacy_ref' } } },
          ],
          referenceLibrary: [{ assetId: 'img_lib_1' }, { assetId: 'img_lib_2' }],
        },
        storageHealth: { schemaVersion: 1, worldBookIds: ['wb_a1'], updatedRound: 3 },
      },
    },
  });
}

export async function makeBackupHarness(seed: SeedKind): Promise<BackupHarness> {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
  installFileReaderStub();

  const ls = createMockLocalStorage({ aga_device_id: DEVICE_ID });
  vi.stubGlobal('localStorage', ls.storage);

  const mods = await importModules();
  const profiles = new mods.ProfileManager();
  await profiles.initialize();
  const saves = new mods.SaveManager(profiles);
  const config = new mods.ConfigStore();
  const prompts = new mods.PromptStorage();
  const vectors = new mods.VectorStore();
  const presets = new mods.CustomPresetStore();
  const images = new mods.ImageAssetCache();
  const books = new mods.WorldBookStorage();
  const backup = new mods.BackupService(profiles, saves, config, prompts, vectors, presets, images, books);

  const emits: Recorded[] = [];
  const h: BackupHarness = {
    mods, backup, profiles, saves, config, prompts, vectors, presets, images, books, storage: ls.storage, emits,
    startRecording() {
      const emit = mods.eventBus.emit.bind(mods.eventBus);
      vi.spyOn(mods.eventBus, 'emit').mockImplementation((event: string, payload?: unknown) => {
        emits.push({ event, payload: payload === undefined ? undefined : structuredClone(payload) });
        return (emit as (e: string, p?: unknown) => void)(event, payload);
      });
    },
    async addProfile(profileId, characterName, slotIds) {
      await profiles.createProfile(profileMeta(profileId, characterName, slotIds));
    },
    async saveSlot(profileId, slotId, tree) {
      await saves.saveGame(profileId, slotId, tree as never);
    },
    async storeImage(id, text = `bytes:${id}`, sizeBytes) {
      await images.store(imageAsset(id, text, sizeBytes), new Blob([text], { type: 'image/png' }));
    },
    async putBook(profileId, id, entryCount = 2) {
      await books.saveWorldBook(profileId, worldBook(id, entryCount));
    },
  };

  if (seed === 'full') await seedFull(h);
  if (seed === 'local') await seedLocal(h);
  return h;
}

async function seedFull(h: BackupHarness): Promise<void> {
  // two profiles, two slots each
  await h.addProfile('prof_a', 'Alice', ['slot_1', 'slot_2']);
  await h.addProfile('prof_b', 'Bob', ['slot_1', 'slot_2']);
  await h.saveSlot('prof_a', 'slot_1', richTree());
  await h.saveSlot('prof_a', 'slot_2', stateTree('Alice', 1, {
    角色: { 基础信息: { 姓名: 'Alice' }, 图片档案: { 已选头像图片ID: 'img_avatar_a' } },
  }));
  await h.saveSlot('prof_b', 'slot_1', stateTree('Bob', 5, {
    角色: { 基础信息: { 姓名: 'Bob' }, 图片档案: { 已选头像图片ID: 'img_avatar_b', 生图历史: [{ id: 'img_shared' }] } },
  }));
  await h.saveSlot('prof_b', 'slot_2', stateTree('Bob', 2, {
    角色: { 基础信息: { 姓名: 'Bob' }, 图片档案: { 最近生图结果: 'img_shared' } },
  }));
  await h.profiles.setActiveProfile('prof_a', 'slot_1');

  // vectors: slot_1 of A has all three kinds, B/slot_1 has ONLY edgeVectors (skipped by the export), B/slot_2 events
  await h.vectors.save('prof_a', 'slot_1', {
    eventVectors: { evt_a1: [0.1, 0.2, 0.3], evt_a2: [0.3, 0.2, 0.1] },
    entityVectors: { Alice: [0.5, 0.5, 0.5] },
    edgeVectors: { edge_a1: [0.9, 0.1, 0.0] },
    model: 'embed-test', dim: 3,
  });
  await h.vectors.save('prof_b', 'slot_1', {
    eventVectors: {}, entityVectors: {}, edgeVectors: { edge_b1: [0.4, 0.4, 0.2] }, model: 'embed-test', dim: 3,
  });
  await h.vectors.save('prof_b', 'slot_2', {
    eventVectors: { evt_b1: [0.7, 0.1, 0.2] }, entityVectors: {}, edgeVectors: {}, model: 'embed-test', dim: 3,
  });

  // images: every referenced one, plus an orphan and two reference-library entries
  for (const id of [
    'img_avatar_a', 'img_portrait_a', 'img_hist_a1', 'img_hist_a2', 'img_secret_a', 'img_npc_1', 'img_wall_a',
    'img_scene_1', 'img_ref_used', 'img_legacy_ref', 'img_lib_1', 'img_lib_2', 'img_avatar_b', 'img_shared', 'img_orphan',
  ]) await h.storeImage(id);

  // world books for both profiles
  await h.putBook('prof_a', 'wb_a1', 2);
  await h.putBook('prof_b', 'wb_b1', 1);
  await h.putBook('prof_b', 'wb_b2', 3);

  // two preset packs and the built-in prompt overrides
  await h.presets.replaceAll('tianming', {
    worlds: [{ id: 'user_w1', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'World One' }],
    origins: [{ id: 'user_o1', source: 'user', createdAt: 2, generatedBy: 'ai', name: 'Origin One' }],
  });
  await h.presets.replaceAll('other_pack', {
    worlds: [{ id: 'user_w9', source: 'user', createdAt: 3, generatedBy: 'manual', name: 'Other World' }],
  });
  const override: BuiltinPromptEntry = {
    id: 'bo1', slotId: 'main_round', title: 'Main round', category: '主剧情', content: 'default', userContent: 'edited', enabled: true,
    createdAt: 1, updatedAt: 1,
  };
  await h.books.saveBuiltinOverride('tianming', override);

  // global stores
  const overlays: ConfigOverlay[] = [
    { domainId: 'ui' as never, packId: 'tianming', patches: { theme: 'dark' }, version: 1, updatedAt: 10 },
    { domainId: 'ai' as never, packId: 'tianming', patches: { temperature: 0.7 }, version: 1, updatedAt: 11 },
  ];
  await h.config.importAll(overlays);
  await h.prompts.save('tianming', 'main_round', 'custom prompt text', true);
  await h.prompts.save('tianming', 'opening', 'custom opening', false);

  // localStorage: both prefixes, the device-local keys, the own-sync key and a foreign key
  const ls = h.storage;
  ls.setItem('aga_api_management', '{"configs":[{"name":"main"}]}');
  ls.setItem('aga_engram_config', '{"enabled":true}');
  ls.setItem('aga-ui-theme', 'dark');
  ls.setItem('aga_pending_input', 'draft text');
  ls.setItem('aga_github_sync_token', GH_TOKEN);
  ls.setItem('aga_github_sync_owner', 'octo');
  ls.setItem('aga_github_sync_repo', 'aga-cloud-save');
  ls.setItem('aga_github_sync_baseline', 'SRC-BASELINE');
  ls.setItem('aga_github_sync_pending', '1');
  ls.setItem('aga_github_sync_baselines', '{"prof_a":"SRC-SLOT-BASELINE"}');
  ls.setItem('aga_github_sync_pending_map', '{"prof_a":true}');
  ls.setItem('aga_plot_vector_control', '{"enabled":true}');
  ls.setItem('other_app_key', 'not ours');
}

/** A different, small machine: the state a full import replaces. */
async function seedLocal(h: BackupHarness): Promise<void> {
  await h.addProfile('prof_local', 'Local', ['slot_1']);
  await h.saveSlot('prof_local', 'slot_1', stateTree('Local', 9, {
    角色: { 基础信息: { 姓名: 'Local' }, 图片档案: { 已选头像图片ID: 'img_local' } },
  }));
  await h.profiles.setActiveProfile('prof_local', 'slot_1');
  await h.storeImage('img_local');
  await h.storeImage('img_orphan_local');
  await h.putBook('prof_local', 'wb_local', 1);
  await h.presets.replaceAll('local_pack', {
    worlds: [{ id: 'user_lw', source: 'user', createdAt: 5, generatedBy: 'manual', name: 'Local World' }],
  });
  await h.books.saveBuiltinOverride('local_pack', {
    id: 'bo_local', slotId: 'local_slot', title: 'Local', category: '常驻', content: 'c', enabled: true, createdAt: 1, updatedAt: 1,
  });
  await h.config.importAll([{ domainId: 'ui' as never, packId: 'local_pack', patches: { theme: 'light' }, version: 1, updatedAt: 20 }]);
  await h.prompts.save('local_pack', 'main_round', 'local prompt', true);
  const ls = h.storage;
  ls.setItem('aga_local_setting', 'keep me?');
  ls.setItem('aga-local-legacy', 'legacy');
  ls.setItem('aga_github_sync_baseline', 'LOCAL-BASELINE');
  ls.setItem('aga_github_sync_pending_map', '{"prof_local":true}');
  ls.setItem('aga_plot_vector_control', '{"enabled":false}');
  ls.setItem('other_app_key', 'local foreign');
}
