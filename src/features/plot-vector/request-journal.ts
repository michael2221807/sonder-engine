import { openDB } from 'idb';
import type { GenerationCheckpoint } from '../../engine/ai/types';
import { randomId } from '../../engine/plot-vector/feature-control';
import { sha256String } from '../../engine/sync/chunked-bundle-packer';
import { stable } from './genesis/post-save';

export interface Receipt { fingerprint: string; owner: string; raw?: string; createdAt?: number; slotKey?: string; expired?: boolean }
export interface RequestStore {
  claim(key: string, fingerprint: string, owner: string, guard: () => void, slotKey?: string): Promise<Receipt | undefined>;
  complete(key: string, owner: string, raw: string, guard: () => void): Promise<void>;
  /** Read-only lookup. Never creates, claims or changes a record. */
  peek(key: string): Promise<Receipt | undefined>;
  maintain?(): Promise<void>;
}
/** Separate local recovery ledger: never part of a story prompt or a portable save. */
export class BrowserRequestStore implements RequestStore {
  private lastMaintenance = 0;
  constructor(private name = 'aga-vector-requests-v1') {}
  private open() { return openDB(this.name, 1, { upgrade(db) { db.createObjectStore('requests'); } }); }
  async claim(key: string, fingerprint: string, owner: string, guard: () => void, slotKey?: string): Promise<Receipt | undefined> {
    const db = await this.open();
    try {
      const tx = db.transaction('requests', 'readwrite');
      try {
        const old = await tx.store.get(key) as Receipt | undefined;
        guard();
        if (!old) await tx.store.put({ fingerprint, owner, slotKey, createdAt: Date.now() }, key);
        guard(); await tx.done; return old;
      } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
    } finally { db.close(); }
  }
  async complete(key: string, owner: string, raw: string, guard: () => void): Promise<void> {
    const db = await this.open();
    try {
      const tx = db.transaction('requests', 'readwrite');
      try {
        const old = await tx.store.get(key) as Receipt | undefined;
        guard();
        if (!old || old.owner !== owner || old.raw !== undefined) throw new Error('请求记录已改变，未覆盖');
        await tx.store.put({ ...old, raw, createdAt: old.createdAt ?? Date.now() }, key);
        guard(); await tx.done;
      } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
    } finally { db.close(); }
  }
  async peek(key: string): Promise<Receipt | undefined> {
    const db = await this.open();
    try { return await db.get('requests', key) as Receipt | undefined; } finally { db.close(); }
  }
  /** Expire only reply bodies. Tombstones continue preventing an accidental repeat request. */
  async maintain(): Promise<void> {
    if (Date.now() - this.lastMaintenance < 3600000) return;
    await this.summary(); this.lastMaintenance = Date.now();
  }
  async summary(): Promise<{ completed: number; unknown: number; expired: number }> {
    const counts = { completed: 0, unknown: 0, expired: 0 };
    await this.visit(row => {
      row.createdAt ??= Date.now(); // Legacy records start their retention window at first maintenance.
      if (row.raw !== undefined && row.createdAt !== undefined && row.createdAt < Date.now() - 30 * 86400000) {
        delete row.raw; row.expired = true;
      }
      counts[row.expired ? 'expired' : row.raw === undefined ? 'unknown' : 'completed']++;
      return row;
    });
    return counts;
  }
  async clear(guard: () => void): Promise<void> { await this.visit(() => null, guard); }
  async removeSlot(slot: { profileId: string; slotId: string }): Promise<void> {
    const slotKey = await digest(slot);
    await this.visit(row => row.slotKey === slotKey ? null : row);
  }
  private async visit(change: (row: Receipt) => Receipt | null, guard: () => void = () => {}): Promise<void> {
    const db = await this.open();
    try {
      const tx = db.transaction('requests', 'readwrite');
      try {
        let cursor = await tx.store.openCursor();
        while (cursor) {
          guard(); const next = change(cursor.value as Receipt);
          if (next) await cursor.update(next); else await cursor.delete();
          cursor = await cursor.continue();
        }
        guard(); await tx.done;
      } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
    } finally { db.close(); }
  }
}
/** SHA-256 hex of the canonical value; the same key with or without crypto.subtle (LAN HTTP pages lack it). */
function digest(value: unknown): Promise<string> {
  return sha256String(stable(value));
}

/**
 * What the local recovery ledger knows about one ability generation request:
 * `none` = no record (never claimed here, or records were cleared); `unknown` = claimed, no reply
 * recorded (in flight elsewhere, cancelled or lost); `raw` = a reply was received; `expired` = the
 * reply body passed its retention window. Only `raw` allows anything to happen, and it is free.
 */
export type GenesisReceipt = { kind: 'none' } | { kind: 'unknown' } | { kind: 'expired' } | { kind: 'raw'; raw: string };
export class GenesisReceiptUnknownError extends Error {
  constructor(message: string) { super(message); this.name = 'GenesisReceiptUnknownError'; }
}

export class RequestJournal {
  constructor(private store: RequestStore = new BrowserRequestStore()) {}
  /**
   * One saved ability's generation request. Identity is the save slot plus the capability task key,
   * nothing else: no feature epoch, no story round, no model or prompt configuration. The same
   * request therefore keeps one record across refreshes, toggles, later rounds and config changes,
   * and a request whose outcome is unknown can never be re-sent under a new identity.
   */
  genesis(slot: { profileId: string; slotId: string }, taskKey: string) {
    const scope = { slot: { profileId: slot.profileId, slotId: slot.slotId }, step: 'genesis', task: taskKey };
    return {
      /** Read-only: never sends, never claims. A missing record is reported as `none`, not as permission. */
      lookup: async (): Promise<GenesisReceipt> => {
        const row = await this.store.peek(await digest(scope));
        if (!row) return { kind: 'none' };
        if (row.raw !== undefined) return { kind: 'raw', raw: row.raw };
        return row.expired ? { kind: 'expired' } : { kind: 'unknown' };
      },
      /**
       * `guard` protects claiming and the caller's later write to the ACTIVE save. A reply that does
       * arrive is first recorded under the original request's owner without that guard (switching
       * slots or toggling the feature must not throw a paid reply away); only then is `guard` checked.
       * Ownership is still enforced: a cleared or deleted record refuses the late reply.
       */
      checkpoint: (guard: () => void): GenerationCheckpoint => ({
        run: async (_request, send) => {
          guard();
          await this.store.maintain?.();
          const key = await digest(scope), fingerprint = await digest({ step: 'genesis', task: taskKey });
          guard();
          const owner = randomId();
          const old = await this.store.claim(key, fingerprint, owner, guard, await digest(scope.slot));
          guard();
          if (old) {
            if (old.fingerprint === fingerprint && old.raw !== undefined) return old.raw;
            throw new GenesisReceiptUnknownError(old.expired
              ? '能力生成的旧回复已超过本机保留期限，未自动重新生成。'
              : '上次能力生成的结果尚不明确，未自动重复调用模型。');
          }
          const raw = await send();
          await this.store.complete(key, owner, raw, () => {});
          guard();
          return raw;
        },
      }),
    };
  }
  checkpoint(scope: unknown, baseline: unknown, guard: () => void, reused: () => void): GenerationCheckpoint {
    return {
      run: async (request, send) => {
        guard();
        await this.store.maintain?.();
        // Credentials affect identity but only a digest is stored, never the credentials or prompt.
        const key = await digest(scope), fingerprint = await digest({ baseline, request });
        guard();
        const owner = randomId();
        const slot = scope && typeof scope === 'object' && 'slot' in scope ? scope.slot : undefined;
        const old = await this.store.claim(key, fingerprint, owner, guard, slot ? await digest(slot) : undefined);
        guard();
        if (old) {
          if (old.fingerprint !== fingerprint) throw new Error('上次请求与当前存档或模型配置不同，未自动重新生成。可关闭剧情动能使用原流程。');
          if (old.expired) throw new Error('旧回复已超过本机保留期限，未自动重新生成。可在设置中管理恢复记录。');
          if (old.raw === undefined) throw new Error('上次请求结果尚不明确，未自动重复调用模型。可关闭剧情动能使用原流程。');
          reused(); return old.raw;
        }
        const raw = await send();
        guard();
        await this.store.complete(key, owner, raw, guard);
        guard(); return raw;
      },
    };
  }
}
