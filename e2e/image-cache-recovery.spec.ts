/**
 * 图片缓存 · 坏状态自愈（IndexedDB「库在但 store 不在」）
 *
 * Why this lives in the browser suite (iron law 2 self-check): the whole defect
 * and its fix live in real IndexedDB version semantics — a database that already
 * exists at DB_VERSION never fires `onupgradeneeded`, so a missing object store
 * can never be created by re-opening. `fake-indexeddb` in vitest does not
 * reproduce the browser's versioning/blocking behavior faithfully enough to
 * pin this, so only a real browser can prove the self-heal works.
 *
 * 背景（2026-09-02 排查实录）：真实存档下载时 31 张图片资产全部导入失败。根因是
 * 外部诊断工具用**不带版本号**的 `indexedDB.open(name)` 建出了一个 version 1 的
 * 空库（无 object store）——不是产品 bug。但它暴露了真实脆弱性：一旦落入这种坏
 * 状态（外部工具、扩展、升级中断、存储驱逐半途失败都可能造成），应用会**永久性**
 * 无法存取图片，`withRetry` 的重开对此无效（重开的还是同一个坏库）。此 spec 锁定
 * 自愈行为。
 *
 * Fully offline: 只操作本地 IndexedDB，不触发任何网络。
 */
import { test, expect } from './fixtures/base';

const DB = 'aga_image_cache';

test.describe('图片缓存 · 坏状态自愈 (offline: full)', () => {
  test('库存在但缺 object store 时：open() 删库重建，存取与导入恢复',
    { tag: ['@regression', '@image', '@persistence'] },
    async ({ page }) => {
      await page.goto('/');

      const result = await page.evaluate(async (dbName) => {
        // GIVEN 一个「version 1 但没有 object store」的坏库
        await new Promise((res) => {
          const d = indexedDB.deleteDatabase(dbName);
          d.onsuccess = d.onerror = d.onblocked = () => res(null);
        });
        const bad = await new Promise<IDBDatabase>((res, rej) => {
          const q = indexedDB.open(dbName);          // 不带版本号 = 建空库
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        const storesBefore = [...bad.objectStoreNames];
        bad.close();

        // WHEN 应用打开缓存
        // Variable specifier: resolved by the Vite dev server in the browser, not by tsc
        // (a literal '/src/...' specifier is TS2307 under typecheck:e2e — the cause of the
        // e2e-smoke CI lane being red since c977f48).
        const assetCacheUrl = '/src/engine/image/asset-cache.ts';
        const mod = (await import(/* @vite-ignore */ assetCacheUrl)) as {
          ImageAssetCache: new () => {
            open(): Promise<void>;
            store(meta: never, blob: Blob): Promise<unknown>;
            retrieve(id: string): Promise<unknown>;
            importEntries(entries: unknown[]): Promise<unknown>;
          };
        };
        const cache = new mod.ImageAssetCache();
        await cache.open();

        const meta = {
          id: 'heal1', taskId: '', storageKey: 'heal1', mimeType: 'image/png',
          width: 1, height: 1, sizeBytes: 3, backend: 'civitai',
          createdAt: Date.now(), origin: 'generated',
        };
        let stored = false, error = '';
        try {
          await cache.store(meta as never, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
          stored = !!(await cache.retrieve('heal1'));
        } catch (e) { error = `${(e as Error).name}: ${(e as Error).message}`; }

        // 并验证真实的备份导入路径也恢复
        await cache.importEntries([{
          id: 'imp1',
          metadata: { ...meta, id: 'imp1', storageKey: 'imp1' } as never,
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        }]);
        const imported = !!(await cache.retrieve('imp1'));

        return { storesBefore, stored, error, imported };
      }, DB);

      // 前置条件成立：确实先造出了坏状态
      expect(result.storesBefore).toEqual([]);
      // THEN 自愈后可正常存取，且导入路径恢复
      expect(result.error).toBe('');
      expect(result.stored).toBe(true);
      expect(result.imported).toBe(true);
    });
  test('库里还有其它 store 时：拒绝盲删整库（避免连带毁掉兄弟 store 的数据）',
    { tag: ['@regression', '@image', '@persistence'] },
    async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async (dbName) => {
        await new Promise((res) => {
          const d = indexedDB.deleteDatabase(dbName);
          d.onsuccess = d.onerror = d.onblocked = () => res(null);
        });
        // 造一个 version 1、只有「别的 store」的库：缺 image-assets，但有数据要保护
        const other = await new Promise<IDBDatabase>((res, rej) => {
          const q = indexedDB.open(dbName, 1);
          q.onupgradeneeded = () => { q.result.createObjectStore('some-other-store', { keyPath: 'id' }); };
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        other.close();

        // Variable specifier: resolved by the Vite dev server in the browser, not by tsc
        // (a literal '/src/...' specifier is TS2307 under typecheck:e2e — the cause of the
        // e2e-smoke CI lane being red since c977f48).
        const assetCacheUrl = '/src/engine/image/asset-cache.ts';
        const mod = (await import(/* @vite-ignore */ assetCacheUrl)) as {
          ImageAssetCache: new () => {
            open(): Promise<void>;
            store(meta: never, blob: Blob): Promise<unknown>;
            retrieve(id: string): Promise<unknown>;
            importEntries(entries: unknown[]): Promise<unknown>;
          };
        };
        const cache = new mod.ImageAssetCache();
        let error = '';
        try { await cache.open(); } catch (e) { error = `${(e as Error).name}: ${(e as Error).message}`; }

        // 兄弟 store 必须还在（没有被盲删）
        const after = await new Promise<IDBDatabase>((res, rej) => {
          const q = indexedDB.open(dbName);
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        const stores = [...after.objectStoreNames];
        after.close();
        return { error, stores };
      }, DB);

      // 明确失败而不是静默删库
      expect(result.error).toContain('NotFoundError');
      expect(result.error).toContain('refusing to delete');
      // 兄弟 store 完好
      expect(result.stores).toContain('some-other-store');
    });
});
