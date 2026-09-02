/**
 * Image Asset Cache — Sprint Image-4
 *
 * Stores generated images in IndexedDB for offline access and fast retrieval.
 * Per user directive (R-S2-1): IndexedDB for MVP, no scale considerations.
 *
 * Schema: single object store `image-assets`, keyed by asset ID.
 * Each entry stores: { id, blob, metadata }.
 *
 * 连接生命周期加固（2026-06-21）：注册 onclose/onversionchange 在连接被浏览器
 * 异常关闭（存储驱逐 / 另一标签页 deleteDatabase）时丢弃句柄；所有操作经
 * `withRetry` 包裹，遇「连接已关闭」类错误自动重开一次再试，而非永久报错到刷新为止。
 */
// App doc: docs/user-guide/pages/game-save.md §3.2 (数据持久化与浏览器驱逐) · docs/user-guide/pages/image.md
import type { ImageAsset } from './types';
import { eventBus } from '../core/event-bus';

const DB_NAME = 'aga_image_cache';
const DB_VERSION = 1;
const STORE_NAME = 'image-assets';

/** 连接被关闭后用于触发 withRetry 一次重连的可重试错误 */
function closedConnectionError(): DOMException {
  return new DOMException('Image cache connection is closed', 'InvalidStateError');
}

export class ImageAssetCache {
  private db: IDBDatabase | null = null;
  /** in-flight open() 去重 —— 避免并发/重试时重复 indexedDB.open() 泄漏连接句柄 */
  private openingPromise: Promise<void> | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    if (this.openingPromise) return this.openingPromise;

    this.openingPromise = this.openOnce(false)
      .finally(() => { this.openingPromise = null; });

    return this.openingPromise;
  }

  /**
   * 删库（用于「库在但 store 不在」的坏状态自愈）。
   *
   * **`onblocked` 必须按失败处理**：blocked 只说明删除请求排在别的未关闭连接后面，
   * 不代表删成功。若把它当成功继续往下 `open()`，那个 open 会一起排队等待，而平台
   * 对此没有超时——一旦阻塞方永不关闭（devtools 里遗留的连接、还在跑旧代码的标签页），
   * promise 永不 settle，`openingPromise` 又被所有调用方复用 → 整个图片缓存静默永久
   * 挂死，比它要修的 NotFoundError 更糟（review CRITICAL 2026-09-02）。
   * 这里明确 reject：调用方拿到响亮的错误，且 `openingPromise` 会被清空，
   * 阻塞方关闭后的下一次调用即可自行恢复。
   */
  private deleteDatabase(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new DOMException('deleteDatabase failed', 'UnknownError'));
      req.onblocked = () => reject(new DOMException(
        '图片缓存重建被另一个未关闭的连接阻塞（请关闭其他标签页后重试）', 'InvalidStateError',
      ));
    });
  }

  /**
   * 打开连接；`rebuilt` 标记是否已经为修坏状态重建过一次（防无限递归）。
   *
   * **坏状态自愈（2026-09-02）**：如果库以 DB_VERSION 存在却没有 object store，
   * 再怎么 `open(DB_NAME, DB_VERSION)` 都不会触发 `onupgradeneeded`（版本没变），
   * store 永远建不出来 → 之后每一次 transaction 都是 NotFoundError，应用**永久性**
   * 无法存取图片，且 `withRetry` 的重开对此无效（重开的还是同一个坏库）。
   * 这种坏状态的成因不止一种：外部工具/扩展用不带版本号的 `indexedDB.open(name)`
   * 建出过空库、升级过程被中断、存储驱逐半途失败等。既然此时库里本就没有数据可丢，
   * 直接删库重建是安全且唯一能恢复功能的做法。
   */
  private openOnce(rebuilt: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      // 版本升级被其它连接阻塞时，open 也可能永不 settle —— 同样按失败处理。
      request.onblocked = () => reject(new DOMException(
        '图片缓存打开被另一个未关闭的连接阻塞（请关闭其他标签页后重试）', 'InvalidStateError',
      ));

      request.onsuccess = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const otherStores = [...db.objectStoreNames];
          db.close();
          if (rebuilt) {
            reject(new DOMException(
              `Image cache store "${STORE_NAME}" missing after rebuild`, 'NotFoundError',
            ));
            return;
          }
          // 删库是整库操作。今天这个库只有 image-assets 一个 store，所以"没有数据可丢"
          // 成立；但将来若加了第二个 store，缺 image-assets 时盲删会连带毁掉兄弟 store
          // 的真实数据（review IMPORTANT 2026-09-02）。这里用代码而不是注释来守住。
          if (otherStores.length > 0) {
            reject(new DOMException(
              `Image cache store "${STORE_NAME}" missing, but the database holds other `
              + `stores (${otherStores.join(', ')}) — refusing to delete the whole database`,
              'NotFoundError',
            ));
            return;
          }
          console.warn(
            `[ImageAssetCache] 库存在但缺少 object store "${STORE_NAME}"，删库重建以恢复功能`,
          );
          // 存储健康事件必须让用户知道（沿用 idb-adapter 的先例）：本次重建虽然
          // 删的是空库，但用户可能正处在"本地图片确实丢了"的状态，需要去核对云备份。
          eventBus.emit('ui:toast', {
            type: 'warning',
            i18nKey: 'engine.toast.imageCacheRebuilt',
            message: '图片缓存异常，已自动重建。若发现图片缺失，请从云备份或存档重新导入。',
            id: 'image-cache-rebuilt',
            duration: 8000,
          });
          this.deleteDatabase().then(() => this.openOnce(true)).then(resolve, reject);
          return;
        }

        // 连接被浏览器异常关闭（存储驱逐 / 另一标签页 deleteDatabase）→ 丢弃句柄，下次重开。
        db.onclose = () => { if (this.db === db) this.db = null; };
        // 另一标签页要求升级/删库 → 主动关闭让出，并丢弃句柄，避免阻塞对方。
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        this.db = db;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /** 遇「连接已关闭/被删」类错误时丢弃句柄并重开一次再试 */
  private async withRetry<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    await this.open();
    try {
      // this.db 可能在 open() 之后、fn() 之前被 onversionchange 置空 —— 显式读出校验，
      // null 时抛可重试错误，而不是把 null 传进 .transaction()。
      const db = this.db;
      if (!db) throw closedConnectionError();
      return await fn(db);
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'InvalidStateError' || err.name === 'NotFoundError')
      ) {
        this.db = null;
        await this.open();
        const db = this.db;
        if (!db) throw closedConnectionError();
        return fn(db);
      }
      throw err;
    }
  }

  async store(asset: ImageAsset, blob: Blob): Promise<void> {
    return this.withRetry((db) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ id: asset.id, blob, metadata: asset });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  async retrieve(assetId: string): Promise<{ blob: Blob; metadata: ImageAsset } | null> {
    return this.withRetry((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(assetId);
      request.onsuccess = () => {
        const result = request.result as { id: string; blob: Blob; metadata: ImageAsset } | undefined;
        resolve(result ? { blob: result.blob, metadata: result.metadata } : null);
      };
      request.onerror = () => reject(request.error);
    }));
  }

  async delete(assetId: string): Promise<void> {
    return this.withRetry((db) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  async listAll(): Promise<ImageAsset[]> {
    return this.withRetry((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result as Array<{ metadata: ImageAsset }>;
        resolve(entries.map((e) => e.metadata));
      };
      request.onerror = () => reject(request.error);
    }));
  }

  async clear(): Promise<void> {
    return this.withRetry((db) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  /**
   * Export specific assets as base64-encoded entries for JSON backup.
   * Only exports assets whose IDs are in the provided set.
   */
  async exportByIds(assetIds: Set<string>): Promise<Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }>> {
    if (assetIds.size === 0) return [];
    return this.withRetry((db) => {
      // results 在 fn 内部声明 —— 重试时从空数组重新开始，避免重复累积。
      const results: Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }> = [];
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();
        const pending: Promise<void>[] = [];

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const entry = cursor.value as { id: string; blob: Blob; metadata: ImageAsset };
            if (assetIds.has(entry.id)) {
              pending.push(
                blobToBase64(entry.blob).then((base64) => {
                  results.push({ id: entry.id, metadata: entry.metadata, base64, mimeType: entry.blob.type || 'image/png' });
                }),
              );
            }
            cursor.continue();
          }
        };
        tx.oncomplete = () => { Promise.all(pending).then(() => resolve(results)).catch(reject); };
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  /**
   * Count how many of the given asset ids are actually present in the cache.
   *
   * Cheap keys-only existence check (no blob decode). Used by the export
   * integrity guard: if a save references N assets but only M<N are present,
   * the image cache was evicted/cleared and the export would silently drop
   * images — the sync layer must treat that as a degraded upload rather than
   * overwrite a healthy cloud backup. Distinguishes "cache is empty" from
   * "no images referenced", which {@link exportByIds} alone cannot.
   */
  async countPresent(assetIds: Set<string>): Promise<number> {
    if (assetIds.size === 0) return 0;
    return this.withRetry((db) => new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const keys = request.result as IDBValidKey[];
        let n = 0;
        for (const k of keys) if (typeof k === 'string' && assetIds.has(k)) n++;
        resolve(n);
      };
      request.onerror = () => reject(request.error);
    }));
  }

  /** Import base64-encoded assets back into the cache */
  async importEntries(entries: Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }>): Promise<void> {
    if (entries.length === 0) return;
    await this.open();
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        const blob = base64ToBlob(entry.base64, entry.mimeType);
        await this.store(entry.metadata, blob);
      } catch (err) {
        // 原来是空 catch —— 31 张图全导入失败时只留下 31 行「skipping」，
        // 完全无法诊断（2026-09-02 排查实录）。原因必须带出来。
        failures.push(entry.id);
        console.warn(
          `[ImageAssetCache] Failed to import asset "${entry.id}", skipping:`,
          err instanceof Error ? `${err.name}: ${err.message}` : err,
        );
      }
    }
    // 逐条 warn 淹没在日志里，看不出「全军覆没」和「个别损坏」的区别 —— 补一条汇总。
    if (failures.length > 0) {
      console.error(
        `[ImageAssetCache] ${failures.length}/${entries.length} 张图片资产导入失败`
        + (failures.length === entries.length ? '（全部失败，通常是缓存不可用而非图片本身损坏）' : ''),
      );
    }
  }
}

/** Delimiter between an import namespace and the original asset id. */
const ASSET_NAMESPACE_DELIM = '::';

/**
 * Namespace an asset id under an import namespace (the new profile id, or card id) so
 * an imported card's images cannot silently overwrite the player's existing assets.
 *
 * `ImageAssetCache.store` keys by `asset.id`, and `importEntries` re-keys via the
 * entry's `metadata.id` (it calls `store(entry.metadata, blob)`), so a card whose
 * asset id collides with a player's asset would clobber it on a global `put`. Importing
 * under a namespaced id avoids that.
 *
 * Pure, and idempotent FOR THE SAME namespace: re-namespacing an id already prefixed
 * with `<namespace>::` is a no-op. Calling with a DIFFERENT namespace NESTS a second
 * prefix (`ns2::ns1::id`) — so P4 `rewriteAssetRefs` must use one stable namespace per import.
 *
 * NOTE for callers (Story 6 P4 `rewriteAssetRefs`): when you namespace an imported asset
 * you MUST rewrite BOTH `entry.id` AND `entry.metadata.id` (the latter is the actual IDB
 * put key) AND every reference to the original id inside the merged state tree.
 *
 * @param namespace   Stable per-import namespace (new profile id or card id). Required.
 * @param originalId  The card's original asset id.
 * @returns `"<namespace>::<originalId>"`, or `originalId` unchanged if already namespaced.
 */
export function namespacedAssetId(namespace: string, originalId: string): string {
  const prefix = `${namespace}${ASSET_NAMESPACE_DELIM}`;
  if (originalId.startsWith(prefix)) return originalId;
  return `${prefix}${originalId}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}
