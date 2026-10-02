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
import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { cloneDeep } from 'lodash-es';
import { eventBus } from '../core/event-bus';

const DB_NAME = 'aga-saves';
const DB_VERSION = 1;
const STORE_NAME = 'data';

/** 缓存的 DB 连接 Promise — 懒初始化，全应用共享 */
let dbPromise: Promise<IDBPDatabase> | null = null;
/** The connection once it is open, so a write can start in the same moment it is asked for (see `startWrite`). */
let openDb: IDBPDatabase | null = null;

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
        if (dbPromise === p) { dbPromise = null; openDb = null; }
      },
    });
    // open 自身失败时不要把 rejected promise 永久缓存，否则后续全部失败。
    p.then(db => { if (dbPromise === p) openDb = db; }, () => { if (dbPromise === p) dbPromise = null; });
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
    openDb = null;
    return op(await getDB());
  }
}

type WriteTx = IDBPTransaction<unknown, [typeof STORE_NAME], 'readwrite'>;

/**
 * Puts a value, starting now: the browser serializes the value inside `put`, so what is written is the value as it
 * is at this call — no copy of our own is needed (P1 存档写入提速, docs/design/plot-vector-rebuild-plan.md §13.1).
 * A value the browser cannot clone (a reactive proxy left inside the tree) is written as a plain deep copy, as it
 * always was. `guard` runs right before the write starts. Throws synchronously when the connection is closed.
 */
function startWrite(db: IDBPDatabase, key: string, value: unknown, guard?: () => void): { tx: WriteTx; put: Promise<IDBValidKey> } {
  guard?.();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  try {
    try {
      return { tx, put: tx.store.put(value, key) };
    } catch (err) {
      if (!isDataCloneError(err)) throw err;
      // Nothing was written by the failed put; the transaction is still open for the plain copy.
      return { tx, put: tx.store.put(cloneDeep(value), key) };
    }
  } catch (err) {
    // Abort the unused transaction; its `done` then rejects, which nobody else waits for.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already finished */ }
    throw err;
  }
}

/** The browser could not clone the value (by name: test realms and older engines differ in the error's class). */
function isDataCloneError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'DataCloneError';
}

/** A copy taken now, for a write that has to wait for the connection first. Same fallback as `startWrite`. */
function copyNow(value: unknown): unknown {
  try { return structuredClone(value); }
  catch (err) {
    if (isDataCloneError(err)) return cloneDeep(value);
    throw err;
  }
}

/**
 * Writes waiting for the connection. While any wait, a new write waits behind them too, so writes reach the
 * database in the order they were asked for (a later write never lands under an earlier one).
 */
let waitingWrites = 0;

/** Waits for a started write; `guard` again before it commits. A failure aborts it. */
async function finishWrite({ tx, put }: { tx: WriteTx; put: Promise<IDBValidKey> }, guard?: () => void): Promise<void> {
  try {
    await put;
    guard?.();
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* Already completed. */ }
    await tx.done.catch(() => {});
    throw error;
  }
}

/**
 * One write of a whole value: on an open connection it starts at this call (no copy); otherwise the value is copied
 * now and written once the connection is open. A connection found closed is reopened once, as `withDB` does.
 */
async function writeValue(key: string, value: unknown, guard?: () => void): Promise<void> {
  const db = openDb;
  if (db && waitingWrites === 0) {
    let started: ReturnType<typeof startWrite> | null = null;
    try { started = startWrite(db, key, value, guard); }
    catch (err) {
      if (!isConnectionClosedError(err)) throw err;
      if (openDb === db) { dbPromise = null; openDb = null; }
    }
    if (started) {
      try { return await finishWrite(started, guard); }
      catch (err) {
        if (!isConnectionClosedError(err)) throw err;
        // The connection closed under the write, which wrote nothing: reopen and write once more, as withDB
        // always did. The value can only be taken as it is now (rare: the browser closed the connection).
        if (openDb === db) { dbPromise = null; openDb = null; }
        console.warn('[IDB] The connection closed during a write; writing again on a new connection.');
      }
    }
  }
  const copy = copyNow(value);
  waitingWrites++;
  let waiting = true;
  const stopWaiting = () => { if (waiting) { waiting = false; waitingWrites--; } };
  try {
    await withDB(async live => {
      const started = startWrite(live, key, copy, guard);
      stopWaiting();
      return finishWrite(started, guard);
    });
  } finally { stopWaiting(); }
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
  /**
   * Writes the value as it is at this call (see `writeValue`), checking `guard` right before the write starts and
   * again before it commits; resolves once the transaction is complete, not just the put.
   */
  async setGuarded(key: string, value: unknown, guard: () => void): Promise<void> {
    await writeValue(key, value, guard);
  },
  /** 按 key 读取 */
  async get<T>(key: string): Promise<T | undefined> {
    return withDB((db) => db.get(STORE_NAME, key) as Promise<T | undefined>);
  },

  /** 写入：写进去的是调用这一刻的值（见 `writeValue`；不可克隆的响应式代理退回深拷贝）。 */
  async set(key: string, value: unknown): Promise<void> {
    try {
      await writeValue(key, value);
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
