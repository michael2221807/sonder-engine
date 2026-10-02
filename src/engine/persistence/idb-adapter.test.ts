/**
 * The database adapter's writes (P1 存档写入提速, docs/design/plot-vector-rebuild-plan.md §13.1): what is written is
 * the value as it is at the call — on an open connection the write starts at once (the browser copies the value
 * inside put), so the adapter makes no copy of its own; before the connection is open it copies at the call.
 * Run against a stand-in database whose put copies the value at the moment it is called, like IndexedDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTx { store: { put: (value: unknown, key: string) => Promise<string> }; done: Promise<void>; abort: () => void }
const disk = new Map<string, unknown>();
/** One-shot faults: `transaction()` throws, `put` throws, the put's request fails later, the commit fails later. */
const fault: { transaction?: DOMException; put?: DOMException; request?: DOMException; commit?: DOMException } = {};
let opens = 0;
/** Proxies the stand-in database refuses, like the browser does (functions too). */
const proxies = new WeakSet<object>();
function unclonable(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return proxies.has(value) || Object.values(value).some(v => unclonable(v, seen));
}
/** Copies like IndexedDB: at put, synchronously; a proxy or a function cannot be cloned. */
function serialize(value: unknown): unknown {
  if (unclonable(value)) throw new DOMException('could not be cloned', 'DataCloneError');
  return JSON.parse(JSON.stringify(value));
}
function take<K extends keyof typeof fault>(key: K): DOMException | undefined {
  const e = fault[key]; delete fault[key]; return e;
}
function fakeDb() {
  return {
    transaction(): FakeTx {
      const thrown = take('transaction');
      if (thrown) throw thrown;
      let aborted = false;
      let pending: Array<[string, unknown]> = [];
      let finish!: () => void, fail!: (e: unknown) => void;
      const done = new Promise<void>((res, rej) => { finish = res; fail = rej; });
      const tx: FakeTx = {
        store: {
          put(value: unknown, key: string) {
            const sync = take('put');
            if (sync) throw sync;
            pending.push([key, serialize(value)]);
            const request = take('request'), commit = take('commit');
            setTimeout(() => {
              if (aborted) return;
              if (request || commit) { fail(request ?? commit); return; }
              for (const [k, v] of pending) disk.set(k, v);
              pending = []; finish();
            }, 0);
            return request ? Promise.reject(request) : Promise.resolve(key);
          },
        },
        done,
        abort() { if (aborted) return; aborted = true; pending = []; fail(new DOMException('aborted', 'AbortError')); },
      };
      return tx;
    },
    get: async (_s: string, key: string) => disk.get(key),
  };
}
vi.mock('idb', () => ({ openDB: vi.fn(async () => { opens++; return fakeDb(); }) }));
vi.mock('../core/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('lodash-es', async importOriginal => {
  const actual = await importOriginal<typeof import('lodash-es')>();
  return { ...actual, cloneDeep: vi.fn(actual.cloneDeep) };
});

/** A fresh adapter (its connection cache is module state), with the module copies it sees. */
async function fresh() {
  vi.resetModules();
  const a = (await import('./idb-adapter')).idbAdapter;
  const { eventBus } = await import('../core/event-bus');
  const { cloneDeep } = await import('lodash-es');
  return { a, emit: vi.mocked(eventBus.emit), cloneDeep: vi.mocked(cloneDeep) };
}
/** Opens the connection with a first write, then clears the record of copies made. */
async function opened() {
  const f = await fresh();
  await f.a.set('warm', { ok: true });
  f.cloneDeep.mockClear();
  cloneSpy.mockClear();
  return f;
}

let cloneSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  disk.clear(); opens = 0;
  for (const key of Object.keys(fault) as Array<keyof typeof fault>) delete fault[key];
  cloneSpy = vi.spyOn(globalThis, 'structuredClone');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a write takes the value as it is at the call', () => {
  it('on an open connection: no copy of its own, and a change right after the call is not written', async () => {
    const { a, cloneDeep } = await opened();
    const tree = { 角色: { 名称: '甲' } };
    const write = a.set('save_p_s', tree);
    tree.角色.名称 = '乙';
    await write;
    expect(disk.get('save_p_s')).toEqual({ 角色: { 名称: '甲' } });
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(cloneDeep).not.toHaveBeenCalled();
  });
  it('before the connection is open: copied at the call, written once it opens', async () => {
    const { a } = await fresh();
    const tree = { x: 1 };
    const write = a.setGuarded('save_p_s', tree, () => {});
    tree.x = 2;
    await write;
    expect(disk.get('save_p_s')).toEqual({ x: 1 });
    expect(cloneSpy).toHaveBeenCalledTimes(1);
  });
  it('two writes asked for before the connection opens land in the order asked', async () => {
    const { a } = await fresh();
    const first = a.set('save_p_s', { v: 1 });
    const second = a.set('save_p_s', { v: 2 });
    await Promise.all([first, second]);
    expect(disk.get('save_p_s')).toEqual({ v: 2 });
  });
  it('a value the browser cannot clone (a reactive proxy left in it) is written as a plain deep copy', async () => {
    const { a, cloneDeep } = await opened();
    const inner = new Proxy({ b: [1, 2] }, {});
    proxies.add(inner);
    await a.set('save_p_s', { a: inner });
    expect(disk.get('save_p_s')).toEqual({ a: { b: [1, 2] } });
    expect(cloneDeep).toHaveBeenCalledTimes(1);
  });
  it('a value that cannot be copied either is refused cleanly: nothing written, the transaction aborted', async () => {
    const { a } = await opened();
    await expect(a.set('save_p_s', { f: () => 1 })).rejects.toMatchObject({ name: 'DataCloneError' });
    await new Promise(r => setTimeout(r, 5));
    expect(disk.has('save_p_s')).toBe(false);
  });
  it('another error from put aborts the transaction and is reported, with nothing written', async () => {
    const { a } = await opened();
    fault.put = new DOMException('bad key', 'DataError');
    await expect(a.set('save_p_s', { x: 1 })).rejects.toMatchObject({ name: 'DataError' });
    await new Promise(r => setTimeout(r, 5));
    expect(disk.has('save_p_s')).toBe(false);
  });
  it('a connection found closed is reopened once, and the value of the call is written', async () => {
    const { a } = await opened();
    fault.transaction = new DOMException('closing', 'InvalidStateError');
    const tree = { v: 'call' };
    const write = a.set('save_p_s', tree);
    tree.v = 'later';
    await write;
    expect(disk.get('save_p_s')).toEqual({ v: 'call' });
    expect(opens).toBe(2);
  });
  it('a connection that closes during the write is reopened and the write made again', async () => {
    const { a } = await opened();
    fault.request = new DOMException('closed', 'InvalidStateError');
    await a.set('save_p_s', { v: 1 });
    expect(disk.get('save_p_s')).toEqual({ v: 1 });
    expect(opens).toBe(2);
  });
  it('a full store: the write fails, the player is told to back up', async () => {
    const { a, emit } = await opened();
    fault.commit = new DOMException('full', 'QuotaExceededError');
    await expect(a.set('save_p_s', { v: 1 })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(emit).toHaveBeenCalledWith('ui:toast', expect.objectContaining({ i18nKey: 'engine.toast.storageQuotaExceeded' }));
    expect(disk.has('save_p_s')).toBe(false);
  });
});

describe('a guarded write', () => {
  it('a guard failing before the write writes nothing', async () => {
    const { a } = await opened();
    await expect(a.setGuarded('save_p_s', { x: 1 }, () => { throw new Error('stale'); })).rejects.toThrow('stale');
    expect(disk.has('save_p_s')).toBe(false);
  });
  it('a guard failing after the put aborts the transaction: nothing is written', async () => {
    const { a } = await opened();
    let calls = 0;
    await expect(a.setGuarded('save_p_s', { x: 1 }, () => { if (++calls === 2) throw new Error('switched'); })).rejects.toThrow('switched');
    await new Promise(r => setTimeout(r, 5));
    expect(disk.has('save_p_s')).toBe(false);
  });
  it('a passing guard writes and resolves once the transaction is done; on a reopened connection it runs again', async () => {
    const { a } = await opened();
    await a.setGuarded('save_p_s', { round: 3 }, () => {});
    expect(disk.get('save_p_s')).toEqual({ round: 3 });
    fault.transaction = new DOMException('closing', 'InvalidStateError');
    const guard = vi.fn();
    await a.setGuarded('save_p_s', { round: 4 }, guard);
    expect(disk.get('save_p_s')).toEqual({ round: 4 });
    expect(guard).toHaveBeenCalledTimes(3); // before the refused start, then before and after the reopened write
  });
});
