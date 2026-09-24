/**
 * IndexedDB 底层适配器 — 通用 KV 存储
 *
 * 所有持久化模块（SaveManager, ProfileManager）都通过此适配器
 * 与 IndexedDB 交互，避免各模块分别管理 DB 连接。
 *
 * 对应 STEP-03 M1.6。
 * 参照 demo: indexedDBManager.ts（但简化为纯 KV 接口）。
 *
 * 连接生命周期加固（2026-06-21）：
 * - openDB 传入 `terminated` 回调：连接被浏览器单方面关闭（存储驱逐、
 *   另一标签页 deleteDatabase 等）时丢弃缓存句柄，下一次读写自动重开。
 * - 每个读写经 `withDB` 包裹：遇到「连接已关闭」类错误（InvalidStateError /
 *   NotFoundError）时丢弃缓存并重开一次，使调用方透明重连而非永久报错到刷新为止。
 * - `requestPersistentStorage`：启动时申请持久化存储，避免本源 IDB 在
 *   存储压力下被浏览器自动驱逐（best-effort → persistent）。
 */
// App doc: docs/user-guide/pages/game-save.md §3.2 (数据持久化与浏览器驱逐) · docs/user-guide/cloud-sync.md
import { openDB, type IDBPDatabase } from 'idb';
import { eventBus } from '../core/event-bus';
import { isEqual } from 'lodash-es';

const DB_NAME = 'aga-saves';
const DB_VERSION = 1;
const STORE_NAME = 'data';

/** 缓存的 DB 连接 Promise — 懒初始化，全应用共享 */
let dbPromise: Promise<IDBPDatabase> | null = null;

/** 获取（或首次打开）IndexedDB 连接 */
function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    const p = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
      terminated() {
        // 连接被浏览器异常关闭（存储驱逐 / 另一标签页 deleteDatabase / 致命错误）。
        // 丢弃缓存句柄，使下一次 getDB() 重新打开，而不是一直拿着死句柄报错。
        if (dbPromise === p) dbPromise = null;
      },
    });
    // open 自身失败时不要把 rejected promise 永久缓存，否则后续全部失败。
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    dbPromise = p;
  }
  return dbPromise;
}

/** 「连接已关闭/被删」类错误 — 这类错误重开连接后通常可恢复 */
function isConnectionClosedError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'InvalidStateError' || err.name === 'NotFoundError')
  );
}

/**
 * 在当前连接上执行一次操作；若因连接被关闭而失败，丢弃缓存并重开一次再试。
 * 仅对「连接关闭」类错误重试一次，其它错误（含 QuotaExceededError）原样抛出。
 */
async function withDB<T>(op: (db: IDBPDatabase) => Promise<T> | T): Promise<T> {
  try {
    return await op(await getDB());
  } catch (err) {
    if (!isConnectionClosedError(err)) throw err;
    dbPromise = null;
    return op(await getDB());
  }
}

/**
 * 申请持久化存储，避免本源 IDB 在磁盘紧张 / LRU 驱逐下被浏览器自动清空。
 *
 * - Chrome/Firefox：满足参与度启发式时静默授予，桶切到 persistent，免于自动驱逐。
 * - 被拒（如常规 Safari）：emit 可见 toast 提示用户及时云备份。
 *
 * 应在应用挂载后调用一次（main.ts bootstrap 末尾），返回是否已持久化。
 * 任何异常都吞掉并返回 false —— 申请失败绝不能阻断启动。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    const already = await navigator.storage.persisted();
    if (already) return true;
    const granted = await navigator.storage.persist();
    if (!granted) {
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.storageNotPersisted',
        message: '浏览器未授予持久化存储，存档可能在空间不足时被自动清除，请及时进行云备份',
        duration: 8000,
        id: 'storage-not-persisted',
      });
    }
    return granted;
  } catch {
    return false;
  }
}

/**
 * 通用 KV 适配器
 * key 命名约定：
 * - "storage_root" — 角色档案根
 * - "save_{profileId}_{slotId}" — 存档数据
 */
let _lastQuotaCheck = 0;
const QUOTA_CHECK_INTERVAL = 60_000;

export const idbAdapter = {
  /** Guard after opening the connection and await transaction completion, not just put. */
  async setGuarded(key: string, value: unknown, guard: () => void, expected?: { value: unknown }): Promise<void> {
    const cloned = structuredClone(value);
    await withDB(async db => {
      guard();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      try {
        if (expected && !isEqual(await tx.store.get(key), expected.value)) {
          throw new Error('存档已被其他窗口更新或删除，请重新读档后继续；未覆盖新存档。');
        }
        guard();
        await tx.store.put(cloned, key);
        guard();
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch { /* Already completed. */ }
        await tx.done.catch(() => {});
        throw error;
      }
    });
  },
  /** 按 key 读取 */
  async get<T>(key: string): Promise<T | undefined> {
    return withDB((db) => db.get(STORE_NAME, key) as Promise<T | undefined>);
  },

  /** 写入（structuredClone 避免 reactive proxy 问题） */
  async set(key: string, value: unknown): Promise<void> {
    // 先克隆一次，重试时复用同一份，避免重复克隆大对象。
    const cloned = structuredClone(value);
    try {
      await withDB((db) => db.put(STORE_NAME, cloned, key));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        console.error('[IDB] QuotaExceededError — storage full');
        // Acute failure — a write was rejected. Loudly warn: the browser is at its
        // storage ceiling and may evict IndexedDB (incl. the separate image cache),
        // which is exactly what silently wiped a user's images before an upload
        // overwrote the good cloud save (2026-07-10). Push them to back up NOW.
        eventBus.emit('ui:toast', {
          type: 'error',
          i18nKey: 'engine.toast.storageQuotaExceeded',
          message: '浏览器存储已满，写入失败！存档与图片可能随时被自动清除，请立即进行云备份/导出。',
          id: 'storage-quota-exceeded',
          duration: 0,
        });
      }
      throw err;
    }

    const now = Date.now();
    if (navigator.storage?.estimate && now - _lastQuotaCheck > QUOTA_CHECK_INTERVAL) {
      _lastQuotaCheck = now;
      navigator.storage.estimate().then(({ usage, quota }) => {
        if (usage && quota && usage > quota * 0.85) {
          const usedMB = Math.round(usage / 1024 / 1024);
          const quotaMB = Math.round(quota / 1024 / 1024);
          console.warn(`[IDB] Storage ${usedMB}MB / ${quotaMB}MB (>85%)`);
          // Early warning BEFORE eviction. Deduped by id so it doesn't spam.
          eventBus.emit('ui:toast', {
            type: 'warning',
            i18nKey: 'engine.toast.storagePressure',
            i18nParams: { usedMB, quotaMB },
            message: `本地存储已用 ${usedMB}MB / ${quotaMB}MB（>85%），空间不足时浏览器可能自动清除存档与图片，请及时云备份。`,
            id: 'storage-pressure',
            duration: 10000,
          });
        }
      }).catch(() => { /* estimate() unavailable */ });
    }
  },

  /** 删除 */
  async delete(key: string): Promise<void> {
    await withDB((db) => db.delete(STORE_NAME, key));
  },

  /** 列出所有 key */
  async keys(): Promise<string[]> {
    const allKeys = await withDB((db) => db.getAllKeys(STORE_NAME));
    return allKeys.map(String);
  },

  /** 清空整个 store — 慎用，仅测试/重置时使用 */
  async clear(): Promise<void> {
    await withDB((db) => db.clear(STORE_NAME));
  },
};
