/**
 * Shared helpers of the R6 behaviour locks (backup round trip, GitHub request trace, memory writes).
 *
 * What a case did is written byte for byte to a `__snapshots__/<group>/<id>.json` file, so everything in here is about
 * making the text deterministic: key order is kept, `undefined` is written as a mark, Blobs become a size and a hash,
 * and gzip bytes never appear (only plain-text hashes do).
 */
import { createHash } from 'node:crypto';
import { openDB } from 'idb';

export const UNDEFINED_MARK = '__undefined__';

/** Same writing as the R2/R3 corpora: key order kept, undefined written as a mark, trailing newline. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Error as the lock records it: the name and the message. A JSON.parse SyntaxError carries a V8 wording that changes
 * between Node versions, so its message is replaced by a mark (the kind of failure is what is locked).
 */
export function errorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof SyntaxError) return { name: err.name, message: '<json parse message>' };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'NonError', message: String(err) };
}

/** Deep copy for recording, with Blobs turned into `{blob, type, size, sha256}` and typed arrays into a hash. */
export async function plainify(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    return { blob: true, type: value.type, size: value.size, sha256: sha256Hex(bytes) };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return { typedArray: view.constructor.name, byteLength: view.byteLength, sha256: sha256Hex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await plainify(item));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await plainify(v);
    return out;
  }
  return value;
}

export type IdbDump = Record<string, Record<string, Array<[string, unknown]>>>;

/**
 * Every database of the current fake IndexedDB, store by store, entries in key order as `[key, value]`.
 * Databases and stores are sorted by name so the dump does not depend on which one was opened first.
 */
export async function dumpAllIdb(): Promise<IdbDump> {
  const names = (await indexedDB.databases()).map((d) => d.name ?? '').filter(Boolean).sort();
  const dump: IdbDump = {};
  for (const name of names) {
    const db = await openDB(name);
    const stores: Record<string, Array<[string, unknown]>> = {};
    for (const store of [...db.objectStoreNames].sort()) {
      const keys = await db.getAllKeys(store);
      const values = await db.getAll(store);
      const rows: Array<[string, unknown]> = [];
      for (let i = 0; i < keys.length; i++) rows.push([String(keys[i]), await plainify(values[i])]);
      stores[store] = rows;
    }
    db.close();
    dump[name] = stores;
  }
  return dump;
}

/** localStorage as a plain object with the keys sorted. */
export function dumpLocalStorage(storage: Storage): Record<string, string | null> {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k) keys.push(k);
  }
  keys.sort();
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = storage.getItem(k);
  return out;
}

/** Which keys were added, removed or changed between two localStorage dumps. */
export function diffLocalStorage(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): { added: Record<string, string | null>; removed: string[]; changed: Record<string, { from: string | null; to: string | null }> } {
  const added: Record<string, string | null> = {};
  const removed: string[] = [];
  const changed: Record<string, { from: string | null; to: string | null }> = {};
  for (const k of Object.keys(after)) {
    if (!(k in before)) added[k] = after[k];
    else if (before[k] !== after[k]) changed[k] = { from: before[k], to: after[k] };
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  return { added, removed, changed };
}

/** Lets fire-and-forget IndexedDB work land. Timers other than Date stay real (fake-indexeddb needs them). */
export async function settle(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
