/**
 * backup-service 存档插槽原语测试（docs/design/github-save-slots-design.md Phase 1）
 *
 * 覆盖：
 * - exportProfileForSync：单档案包 + imageIntegrity + 档案级世界书
 * - exportGlobalForSync：global 包形状 + 设备本地键排除
 * - importGlobal：全局区替换 / 不触碰档案数据 / 失败回滚
 * - importProfileReplace：真替换（slot diff 删除）/ 跨档案键防线 /
 *   图片引用计数保护剪枝（共享图保护 + 退化包保护）/ 档案级回滚
 *
 * 服务级测试：真实 ProfileManager + SaveManager 跑在内存 idbAdapter mock 上，
 * 其余协作者用行为一致的轻量 fake（模式沿用 save-manager.test.ts）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const memStore = new Map<string, unknown>();
vi.mock('./idb-adapter', () => ({
  idbAdapter: {
    async get<T>(key: string): Promise<T | undefined> {
      return memStore.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      memStore.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      memStore.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...memStore.keys()];
    },
    async clear(): Promise<void> {
      memStore.clear();
    },
  },
}));

const emitted: Array<{ event: string; payload: unknown }> = [];
vi.mock('../core/event-bus', () => ({
  eventBus: {
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
  },
}));

import {
  BackupService,
  ProfileSaveIntegrityError,
  type BackupBundle,
} from './backup-service';
import { ProfileManager } from './profile-manager';
import { SaveManager } from './save-manager';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import type { ProfileMeta } from '../types';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import type { VectorStore } from '../memory/engram/vector-store';
import type { CustomPresetStore, CustomPresetEntry } from './custom-preset-store';
import type { ImageAssetCache } from '../image/asset-cache';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { ImageAsset } from '../image/types';

// ─── 轻量 fake 协作者 ───

class FakeVectorStore {
  data = new Map<string, { eventVectors: Record<string, number[]>; entityVectors: Record<string, number[]> }>();
  async load(pid: string, sid: string) {
    return structuredClone(this.data.get(`${pid}/${sid}`) ?? { eventVectors: {}, entityVectors: {} });
  }
  async save(pid: string, sid: string, d: { eventVectors: Record<string, number[]>; entityVectors: Record<string, number[]> }) {
    this.data.set(`${pid}/${sid}`, structuredClone(d));
  }
  async deleteForSlot(pid: string, sid: string) {
    this.data.delete(`${pid}/${sid}`);
  }
}

class FakeConfigStore {
  overlays: unknown[] = [];
  failImport = false;
  async exportAll() { return structuredClone(this.overlays); }
  async importAll(o: unknown[]) {
    if (this.failImport) throw new Error('config import boom');
    this.overlays = structuredClone(o);
  }
  async clear() { this.overlays = []; }
}

class FakePromptStorage {
  entries: Array<{ key: string; value: unknown }> = [];
  async exportAll() { return structuredClone(this.entries); }
  async importAll(e: Array<{ key: string; value: unknown }>) { this.entries = structuredClone(e); }
  async clear() { this.entries = []; }
}

class FakeCustomPresetStore {
  packs = new Map<string, Record<string, CustomPresetEntry[]>>();
  async listPackIds() { return [...this.packs.keys()]; }
  async load(pid: string) { return { packId: pid, presets: structuredClone(this.packs.get(pid) ?? {}) }; }
  async replaceAll(pid: string, presets: Record<string, CustomPresetEntry[]>) {
    this.packs.set(pid, structuredClone(presets));
  }
  async clear(pid: string) { this.packs.delete(pid); }
}

interface FakeImageEntry { id: string; metadata: ImageAsset; base64: string; mimeType: string }
class FakeImageCache {
  images = new Map<string, FakeImageEntry>();
  seed(id: string) {
    this.images.set(id, { id, metadata: { id } as unknown as ImageAsset, base64: 'QUJD', mimeType: 'image/png' });
  }
  async exportByIds(ids: Set<string>) {
    return [...ids].filter((id) => this.images.has(id)).map((id) => structuredClone(this.images.get(id)!));
  }
  async listAll() { return [...this.images.values()].map((v) => v.metadata); }
  async delete(id: string) { this.images.delete(id); }
  async importEntries(entries: FakeImageEntry[]) {
    for (const e of entries) {
      const id = (e.metadata as { id?: string })?.id ?? e.id;
      this.images.set(id, structuredClone(e));
    }
  }
}

interface FakeBook { id: string; name?: string }
class FakeWorldBookStorage {
  books = new Map<string, FakeBook[]>();
  overrides = new Map<string, unknown[]>();
  /** 仅对 id='boom' 的书抛错——让导入第 4 步失败，同时不妨碍回滚路径写回快照书。 */
  failSaveWorldBook = false;
  async loadWorldBooks(pid: string) { return structuredClone(this.books.get(pid) ?? []); }
  async saveWorldBook(pid: string, book: FakeBook) {
    if (this.failSaveWorldBook && book.id === 'boom') throw new Error('worldbook boom');
    const arr = this.books.get(pid) ?? [];
    const i = arr.findIndex((b) => b.id === book.id);
    if (i >= 0) arr[i] = structuredClone(book); else arr.push(structuredClone(book));
    this.books.set(pid, arr);
  }
  async deleteWorldBook(pid: string, id: string) {
    this.books.set(pid, (this.books.get(pid) ?? []).filter((b) => b.id !== id));
  }
  async clearAll() { this.books.clear(); this.overrides.clear(); }
  async loadAllBuiltinOverrides(pid: string) { return structuredClone(this.overrides.get(pid) ?? []); }
  async saveBuiltinOverride(pid: string, entry: unknown) {
    this.overrides.set(pid, [...(this.overrides.get(pid) ?? []), structuredClone(entry)]);
  }
  async replaceBuiltinOverrides(pid: string, data: { entries?: unknown[] }) {
    this.overrides.set(pid, structuredClone(data.entries ?? []));
  }
  async clearBuiltinOverrides(pid: string) { this.overrides.delete(pid); }
}

// ─── 测试数据构造 ───

function makeMeta(profileId: string, slotIds: string[]): ProfileMeta {
  const slots: ProfileMeta['slots'] = {};
  for (const s of slotIds) {
    slots[s] = { slotId: s, slotName: s, lastSavedAt: null, packId: 'tianming', packVersion: '1.0.0' };
  }
  return { profileId, createdAt: '2026-07-23T00:00:00Z', packId: 'tianming', characterName: profileId, slots, activeSlotId: slotIds[0] ?? null };
}

/** 最小可采图存档树：已选头像引用 assetIds（collectAssetIdsFromTree 扫描路径之一） */
function makeSaveTree(avatarId?: string, portraitId?: string): Record<string, unknown> {
  return {
    角色: { 图片档案: { 已选头像图片ID: avatarId ?? '', 已选立绘图片ID: portraitId ?? '' } },
    回合: 1,
  };
}

function bundleBase(): Omit<BackupBundle, 'bundleType'> {
  return {
    version: 1,
    exportedAt: '2026-07-23T00:00:00Z',
    engineVersion: '0.1.0',
    activeProfile: null,
    profiles: {},
    saves: {},
    vectors: {},
    configs: {},
    prompts: {},
    engineSettings: {},
  };
}

function toBlob(bundle: BackupBundle): Blob {
  return new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
}

// ─── 测试主体 ───

describe('backup-service save-slot primitives', () => {
  let pm: ProfileManager;
  let sm: SaveManager;
  let vectors: FakeVectorStore;
  let configs: FakeConfigStore;
  let prompts: FakePromptStorage;
  let presets: FakeCustomPresetStore;
  let images: FakeImageCache;
  let worldBooks: FakeWorldBookStorage;
  let service: BackupService;
  let ls: ReturnType<typeof createMockLocalStorage>;

  beforeEach(async () => {
    memStore.clear();
    emitted.length = 0;
    ls = createMockLocalStorage();
    ls.install();

    pm = new ProfileManager();
    await pm.initialize();
    sm = new SaveManager(pm);
    vectors = new FakeVectorStore();
    configs = new FakeConfigStore();
    prompts = new FakePromptStorage();
    presets = new FakeCustomPresetStore();
    images = new FakeImageCache();
    worldBooks = new FakeWorldBookStorage();

    service = new BackupService(
      pm,
      sm,
      configs as unknown as ConfigStore,
      prompts as unknown as PromptStorage,
      vectors as unknown as VectorStore,
      presets as unknown as CustomPresetStore,
      images as unknown as ImageAssetCache,
      worldBooks as unknown as WorldBookStorage,
    );
  });

  afterEach(() => {
    ls.restore();
  });

  /** 造一个双档案环境：p1(s1,s2) + p2(s1)，各带存档 */
  async function seedTwoProfiles() {
    await pm.createProfile(makeMeta('p1', ['s1', 's2']));
    await pm.createProfile(makeMeta('p2', ['s1']));
    const { idbAdapter } = await import('./idb-adapter');
    await idbAdapter.set('save_p1_s1', makeSaveTree('imgA', 'imgB'));
    await idbAdapter.set('save_p1_s2', makeSaveTree());
    await idbAdapter.set('save_p2_s1', makeSaveTree('imgA'));
    await pm.setActiveProfile('p1', 's1');
  }

  // ── exportProfileForSync ──

  describe('exportProfileForSync', () => {
    it('exports only the target profile with its world books and honest imageIntegrity', async () => {
      await seedTwoProfiles();
      images.seed('imgA'); // imgB 缺失 → integrity 应反映 2 引用 1 导出
      worldBooks.books.set('p1', [{ id: 'wb1', name: 'p1book' }]);
      worldBooks.books.set('p2', [{ id: 'wb2', name: 'p2book' }]);

      const { blob, imageIntegrity } = await service.exportProfileForSync('p1');
      const bundle = JSON.parse(await blob.text()) as BackupBundle;

      expect(bundle.bundleType).toBe('profile');
      expect(Object.keys(bundle.profiles)).toEqual(['p1']);
      expect(Object.keys(bundle.saves).sort()).toEqual(['p1/s1', 'p1/s2']);
      expect(bundle.worldBooks?.books.map((b) => (b as unknown as FakeBook).id)).toEqual(['wb1']);
      expect(imageIntegrity).toEqual({ referencedAssets: 2, exportedAssets: 1 });
      // p2 的数据一概不出现
      expect(JSON.stringify(bundle)).not.toContain('save_p2');
      expect(bundle.saves['p2/s1']).toBeUndefined();
    });

    it('throws for a nonexistent profile', async () => {
      await expect(service.exportProfileForSync('ghost')).rejects.toThrow('does not exist');
    });

    it('blocks export when profile metadata references a missing save record', async () => {
      await pm.createProfile(makeMeta('p1', ['healthy', 'missing']));
      const { idbAdapter } = await import('./idb-adapter');
      await idbAdapter.set('save_p1_healthy', makeSaveTree('imgA'));

      const error = await service.exportProfileForSync('p1').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProfileSaveIntegrityError);
      expect(error).toMatchObject({
        profileId: 'p1',
        missingSlotIds: ['missing'],
      });
      expect((error as Error).message).toContain('已阻止导出/上传/导入');
    });
  });

  // ── exportGlobalForSync ──

  describe('exportGlobalForSync', () => {
    it('produces a valid global bundle: empty profile sections, populated globals, device-local keys excluded', async () => {
      await seedTwoProfiles();
      configs.overlays = [{ id: 'ov1' }];
      prompts.entries = [{ key: 'k', value: 'v' }];
      presets.packs.set('tianming', { worlds: [{ id: 'w1' } as unknown as CustomPresetEntry] });
      localStorage.setItem('aga_user_settings', '{"theme":"dark"}');
      localStorage.setItem('aga_github_sync_baseline', 'never-travel');
      localStorage.setItem('aga_github_sync_pending', '1');

      const { blob } = await service.exportGlobalForSync();
      const bundle = JSON.parse(await blob.text()) as BackupBundle;

      expect(bundle.bundleType).toBe('global');
      expect(bundle.profiles).toEqual({});
      expect(bundle.saves).toEqual({});
      expect(bundle.vectors).toEqual({});
      expect(bundle.activeProfile).toBeNull();
      expect((bundle.configs as { overlays: unknown[] }).overlays).toHaveLength(1);
      expect((bundle.prompts as { entries: unknown[] }).entries).toHaveLength(1);
      expect(bundle.customPresets?.['tianming']).toBeDefined();
      expect(bundle.engineSettings['aga_user_settings']).toBe('{"theme":"dark"}');
      expect(bundle.engineSettings).not.toHaveProperty('aga_github_sync_baseline');
      expect(bundle.engineSettings).not.toHaveProperty('aga_github_sync_pending');
      expect(bundle.imageAssets).toBeUndefined();
      expect(bundle.worldBooks).toBeUndefined();
    });
  });

  // ── importGlobal ──

  describe('importGlobal', () => {
    it('replaces global region, clears packs absent from bundle, never touches profile data', async () => {
      await seedTwoProfiles();
      configs.overlays = [{ id: 'local-old' }];
      presets.packs.set('tianming', { worlds: [] });
      presets.packs.set('legacy-pack', { worlds: [] });
      localStorage.setItem('aga_old_setting', 'stale');
      localStorage.setItem('aga_github_sync_baseline', 'keep-me');
      localStorage.setItem('aga_github_sync_baselines', '{"p1":"keep-map"}');
      localStorage.setItem('aga_github_sync_pending_map', '{"p1":true}');
      images.seed('imgA');

      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'global',
        configs: { overlays: [{ id: 'cloud-new' }] },
        prompts: { entries: [{ key: 'pk', value: 'pv' }] },
        // 恶意/污染包试图写设备本地键 → restore 必须拒绝
        engineSettings: { aga_new_setting: 'fresh', aga_github_sync_baselines: '{"evil":"x"}' },
        customPresets: { tianming: { worlds: [{ id: 'w-cloud' } as unknown as CustomPresetEntry] } },
      };
      await service.importGlobal(bundle);

      expect(configs.overlays).toEqual([{ id: 'cloud-new' }]);
      expect(prompts.entries).toEqual([{ key: 'pk', value: 'pv' }]);
      expect(localStorage.getItem('aga_new_setting')).toBe('fresh');
      expect(localStorage.getItem('aga_old_setting')).toBeNull(); // 真替换
      expect(localStorage.getItem('aga_github_sync_baseline')).toBe('keep-me'); // 设备本地键不动
      // 新 map 键：wipe 不擦、restore 不写（来包里的同名键被拒绝）
      expect(localStorage.getItem('aga_github_sync_baselines')).toBe('{"p1":"keep-map"}');
      expect(localStorage.getItem('aga_github_sync_pending_map')).toBe('{"p1":true}');
      expect(presets.packs.has('legacy-pack')).toBe(false); // 来包没有 → 清空
      expect(presets.packs.get('tianming')?.worlds?.[0]).toMatchObject({ id: 'w-cloud' });
      // 档案数据零触碰
      expect(pm.getProfile('p1')).toBeDefined();
      expect(memStore.get('save_p1_s1')).toBeDefined();
      expect(images.images.has('imgA')).toBe(true);
    });

    it('rejects a non-global bundle', async () => {
      await expect(
        service.importGlobal({ ...bundleBase(), bundleType: 'full' }),
      ).rejects.toThrow("bundleType='global'");
    });

    it('rolls back the global region when a restore step fails', async () => {
      configs.overlays = [{ id: 'pre' }];
      prompts.entries = [{ key: 'pre-k', value: 1 }];
      presets.packs.set('tianming', { worlds: [{ id: 'pre-w' } as unknown as CustomPresetEntry] });
      localStorage.setItem('aga_pre', 'pre-value');

      configs.failImport = true;
      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'global',
        configs: { overlays: [{ id: 'incoming' }] },
        engineSettings: { aga_incoming: 'x' },
      };
      await expect(service.importGlobal(bundle)).rejects.toThrow('已回滚');

      // configs 回滚会因 failImport 尽力而为地失败（可容忍），但 LS 与预设必须还原
      expect(localStorage.getItem('aga_pre')).toBe('pre-value');
      expect(localStorage.getItem('aga_incoming')).toBeNull();
      expect(presets.packs.get('tianming')?.worlds?.[0]).toMatchObject({ id: 'pre-w' });
      expect(prompts.entries).toEqual([{ key: 'pre-k', value: 1 }]);
    });

    it('replaces builtin prompt overrides for the bundle pack and clears stale packs', async () => {
      presets.packs.set('tianming', { worlds: [] });
      presets.packs.set('stale-pack', { worlds: [] });
      worldBooks.overrides.set('tianming', [{ slotId: 'old' }]);
      worldBooks.overrides.set('stale-pack', [{ slotId: 'x' }]);
      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'global',
        customPresets: { tianming: { worlds: [] } },
        builtinPromptOverrides: { version: 1, exportedAt: 'x', entries: [{ slotId: 'new' } as never], packId: 'tianming' },
      };
      await service.importGlobal(bundle);
      expect(worldBooks.overrides.get('tianming')).toEqual([{ slotId: 'new' }]);
      expect(worldBooks.overrides.has('stale-pack')).toBe(false);
    });

    it('malformed overrides (no packId, no customPresets) land under default instead of being silently dropped', async () => {
      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'global',
        builtinPromptOverrides: { version: 1, exportedAt: 'x', entries: [{ slotId: 'rescued' } as never] },
      };
      await service.importGlobal(bundle);
      expect(worldBooks.overrides.get('default')).toEqual([{ slotId: 'rescued' }]);
    });

    it('importAll routes a global blob to importGlobal', async () => {
      localStorage.setItem('aga_before', 'b');
      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'global',
        engineSettings: { aga_routed: 'yes' },
      };
      await service.importAll(toBlob(bundle));
      expect(localStorage.getItem('aga_routed')).toBe('yes');
      expect(localStorage.getItem('aga_before')).toBeNull();
    });
  });

  // ── importProfileReplace ──

  describe('importProfileReplace', () => {
    /** p1 的替换包：仅 s1（s2 被删）、新存档树、可注入图片/世界书 */
    function p1ReplaceBundle(opts?: {
      avatarId?: string;
      imageAssets?: BackupBundle['imageAssets'];
      worldBooks?: BackupBundle['worldBooks'];
      extraSaves?: Record<string, unknown>;
      vectors?: Record<string, unknown>;
    }): BackupBundle {
      return {
        ...bundleBase(),
        bundleType: 'profile',
        profiles: { p1: makeMeta('p1', ['s1']) },
        saves: { 'p1/s1': makeSaveTree(opts?.avatarId ?? 'imgC'), ...(opts?.extraSaves ?? {}) },
        vectors: opts?.vectors ?? {},
        imageAssets: opts?.imageAssets,
        worldBooks: opts?.worldBooks,
      };
    }

    it('replaces the target profile, deletes slots absent from the bundle, leaves the other profile untouched', async () => {
      await seedTwoProfiles();
      vectors.data.set('p1/s2', { eventVectors: { e: [1] }, entityVectors: {} });

      await service.importProfileReplace(toBlob(p1ReplaceBundle()));

      // p1: s1 被新树覆盖，s2 连同向量被删
      const s1 = memStore.get('save_p1_s1') as Record<string, unknown>;
      expect((s1['角色'] as Record<string, Record<string, unknown>>)['图片档案']['已选头像图片ID']).toBe('imgC');
      expect(memStore.get('save_p1_s2')).toBeUndefined();
      expect(vectors.data.has('p1/s2')).toBe(false);
      expect(Object.keys(pm.getProfile('p1')!.slots)).toEqual(['s1']);
      // p2 毫发无损
      expect(memStore.get('save_p2_s1')).toBeDefined();
      expect(pm.getProfile('p2')).toBeDefined();
    });

    it('drops cross-profile composite keys — a profile bundle can never write another profile', async () => {
      await seedTwoProfiles();
      const evil = p1ReplaceBundle({ extraSaves: { 'p2/s1': makeSaveTree('hacked') } });
      await service.importProfileReplace(toBlob(evil));
      const p2save = memStore.get('save_p2_s1') as Record<string, unknown>;
      expect((p2save['角色'] as Record<string, Record<string, unknown>>)['图片档案']['已选头像图片ID']).toBe('imgA');
    });

    it("replaces only the profile's world books", async () => {
      await seedTwoProfiles();
      worldBooks.books.set('p1', [{ id: 'old1' }, { id: 'old2' }]);
      worldBooks.books.set('p2', [{ id: 'other' }]);
      const bundle = p1ReplaceBundle({
        worldBooks: { version: 1, exportedAt: 'x', books: [{ id: 'new1' } as never] },
      });
      await service.importProfileReplace(toBlob(bundle));
      expect((await worldBooks.loadWorldBooks('p1')).map((b) => b.id)).toEqual(['new1']);
      expect((await worldBooks.loadWorldBooks('p2')).map((b) => b.id)).toEqual(['other']);
    });

    it('clears stale local vectors for slots the bundle carries no vectors for', async () => {
      await seedTwoProfiles();
      vectors.data.set('p1/s1', { eventVectors: { stale: [1] }, entityVectors: {} });
      await service.importProfileReplace(toBlob(p1ReplaceBundle()));
      expect(vectors.data.has('p1/s1')).toBe(false);
    });

    it('image prune: deletes old-exclusive dropped images, protects images shared with another profile', async () => {
      await seedTwoProfiles(); // p1/s1 引用 imgA+imgB；p2/s1 引用 imgA
      images.seed('imgA');
      images.seed('imgB');
      const bundle = p1ReplaceBundle({
        avatarId: 'imgC',
        imageAssets: [{ id: 'imgC', metadata: { id: 'imgC' } as unknown as ImageAsset, base64: 'QUJD', mimeType: 'image/png' }],
      });
      await service.importProfileReplace(toBlob(bundle));
      expect(images.images.has('imgB')).toBe(false); // p1 独占、新版不引用 → 删
      expect(images.images.has('imgA')).toBe(true);  // p2 仍引用 → 保护
      expect(images.images.has('imgC')).toBe(true);  // 携带 → merge 入库
    });

    it('degraded bundle (references images, carries none): deletes nothing and warns', async () => {
      await seedTwoProfiles();
      images.seed('imgA');
      images.seed('imgB');
      // 新版引用 imgZ（本地没有），且不携带任何图片 → 退化指纹
      const bundle = p1ReplaceBundle({ avatarId: 'imgZ', imageAssets: undefined });
      await service.importProfileReplace(toBlob(bundle));
      expect(images.images.has('imgA')).toBe(true);
      expect(images.images.has('imgB')).toBe(true); // 退化包绝不删图
      expect(emitted.some((e) => e.event === 'ui:toast'
        && (e.payload as { id?: string }).id === 'import-preserved-images')).toBe(true);
    });

    it('rejects a profile bundle whose metadata slot has no save payload, before pruning images', async () => {
      await seedTwoProfiles();
      images.seed('imgA');
      images.seed('imgB');
      const malformed = p1ReplaceBundle();
      malformed.saves = {};

      const error = await service.importProfileReplace(toBlob(malformed)).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProfileSaveIntegrityError);
      expect(error).toMatchObject({ profileId: 'p1', missingSlotIds: ['s1'] });
      expect(memStore.get('save_p1_s1')).toBeDefined();
      expect(memStore.get('save_p1_s2')).toBeDefined();
      expect(images.images.has('imgA')).toBe(true);
      expect(images.images.has('imgB')).toBe(true);
    });

    it('rolls back the profile on failure and leaves other profiles untouched', async () => {
      await seedTwoProfiles();
      worldBooks.books.set('p1', [{ id: 'keep-book' }]);
      worldBooks.failSaveWorldBook = true; // 第 4 步爆炸
      const bundle = p1ReplaceBundle({
        worldBooks: { version: 1, exportedAt: 'x', books: [{ id: 'boom' } as never] },
      });
      await expect(service.importProfileReplace(toBlob(bundle))).rejects.toThrow('已回滚');

      // p1 恢复原状：s1 旧树、s2 还在、世界书还在
      const s1 = memStore.get('save_p1_s1') as Record<string, unknown>;
      expect((s1['角色'] as Record<string, Record<string, unknown>>)['图片档案']['已选头像图片ID']).toBe('imgA');
      expect(memStore.get('save_p1_s2')).toBeDefined();
      expect(Object.keys(pm.getProfile('p1')!.slots).sort()).toEqual(['s1', 's2']);
      // fake 只对 id='boom' 抛错，回滚写回 'keep-book' 不受影响
      expect((await worldBooks.loadWorldBooks('p1')).map((b) => b.id)).toEqual(['keep-book']);
      // p2 未受波及
      expect(memStore.get('save_p2_s1')).toBeDefined();
    });

    it('rollback of a previously-nonexistent profile removes it entirely', async () => {
      await pm.createProfile(makeMeta('p2', ['s1']));
      worldBooks.failSaveWorldBook = true;
      const bundle = p1ReplaceBundle({
        worldBooks: { version: 1, exportedAt: 'x', books: [{ id: 'boom' } as never] },
      });
      await expect(service.importProfileReplace(toBlob(bundle))).rejects.toThrow('已回滚');
      expect(pm.getProfile('p1')).toBeUndefined();
      expect(memStore.get('save_p1_s1')).toBeUndefined();
    });

    it('heals the activeProfile pointer when its slot disappears', async () => {
      await seedTwoProfiles();
      await pm.setActiveProfile('p1', 's2'); // 指向即将被删的槽
      await service.importProfileReplace(toBlob(p1ReplaceBundle()));
      expect(pm.getRoot().activeProfile).toEqual({ profileId: 'p1', slotId: 's1' });
    });

    it("rejects a non-profile bundle even if it happens to contain exactly one profile", async () => {
      await seedTwoProfiles();
      const full = { ...p1ReplaceBundle(), bundleType: 'full' } as BackupBundle;
      await expect(service.importProfileReplace(toBlob(full))).rejects.toThrow("bundleType='profile'");
      // 一个字节都没动
      expect(memStore.get('save_p1_s2')).toBeDefined();
    });

    it('clears the activeProfile pointer when the incoming profile has zero slots', async () => {
      await seedTwoProfiles(); // active = p1/s1
      const empty: BackupBundle = {
        ...bundleBase(),
        bundleType: 'profile',
        profiles: { p1: makeMeta('p1', []) },
      };
      await service.importProfileReplace(toBlob(empty));
      expect(pm.getRoot().activeProfile).toBeNull();
      expect(memStore.get('save_p1_s1')).toBeUndefined();
      expect(memStore.get('save_p2_s1')).toBeDefined();
    });

    it('rollback removes slots the bundle newly ADDED (partial-write cleanup)', async () => {
      await pm.createProfile(makeMeta('p1', ['s1']));
      const { idbAdapter } = await import('./idb-adapter');
      await idbAdapter.set('save_p1_s1', makeSaveTree('imgA'));
      worldBooks.failSaveWorldBook = true; // 第 4 步爆炸（仅 id='boom'）
      const bundle: BackupBundle = {
        ...bundleBase(),
        bundleType: 'profile',
        profiles: { p1: makeMeta('p1', ['s1', 's9']) }, // s9 是新增槽
        saves: { 'p1/s1': makeSaveTree('imgC'), 'p1/s9': makeSaveTree('imgD') },
        vectors: { 'p1/s9': { eventVectors: { v: [1] }, entityVectors: {} } },
        worldBooks: { version: 1, exportedAt: 'x', books: [{ id: 'boom' } as never] },
      };
      await expect(service.importProfileReplace(toBlob(bundle))).rejects.toThrow('已回滚');
      // 新增槽的半成品数据被清干净，旧状态完整还原
      expect(memStore.get('save_p1_s9')).toBeUndefined();
      expect(vectors.data.has('p1/s9')).toBe(false);
      expect(Object.keys(pm.getProfile('p1')!.slots)).toEqual(['s1']);
      const s1 = memStore.get('save_p1_s1') as Record<string, unknown>;
      expect((s1['角色'] as Record<string, Record<string, unknown>>)['图片档案']['已选头像图片ID']).toBe('imgA');
    });

    it('rejects a bundle that does not contain exactly one profile', async () => {
      const multi: BackupBundle = {
        ...bundleBase(),
        bundleType: 'profile',
        profiles: { p1: makeMeta('p1', ['s1']), p2: makeMeta('p2', ['s1']) },
      };
      await expect(service.importProfileReplace(toBlob(multi))).rejects.toThrow('恰好一个档案');
    });
  });
});
