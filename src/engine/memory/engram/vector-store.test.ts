import 'fake-indexeddb/auto';
/**
 * VectorStore on the real IndexedDB adapter (fake-indexeddb) — 存档瘦身 D4A: vectors are kept as Float32Arrays; every
 * form a vector was ever stored or exported in reads back as one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { idbAdapter } from '../../persistence/idb-adapter';
import { encodeVectorBase64 } from '../../persistence/save-format/vector-codec';
import { VectorStore, vectorDataForBundle, vectorDataFromBundle } from './vector-store';

// Float32 values exactly (an embedding is float32), signs mixed.
const A = [0.5, -0.25, 0.125];
const B = [-1, 2.5, 0.0625];
const C = [0.75, 0.375, -3];

let next = 0;
/** A slot no other test touches (the adapter keeps its connection for the whole file). */
function freshSlot(): { profileId: string; slotId: string } {
  next++;
  return { profileId: `prof_vs${next}`, slotId: 'slot_1' };
}
const keyOf = (s: { profileId: string; slotId: string }) => `engram_vectors_${s.profileId}_${s.slotId}`;

/** What a Float32Array becomes in JSON (an object of indices): an older tab exporting a record of this version. */
const indexObject = (values: number[]) => JSON.parse(JSON.stringify(Float32Array.from(values))) as Record<string, number>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VectorStore (存档瘦身 D4A)', () => {
  it('reads every stored form as a Float32Array, in memory only', async () => {
    const s = freshSlot();
    const record = {
      eventVectors: { list: A, typed: Float32Array.from(B), base64: encodeVectorBase64(C), object: indexObject(A) },
      entityVectors: { Alice: B },
      model: 'embed-1',
      dim: 3,
    };
    await idbAdapter.set(keyOf(s), record);
    const set = vi.spyOn(idbAdapter, 'set');

    const data = await new VectorStore().load(s.profileId, s.slotId);

    for (const vector of [...Object.values(data.eventVectors), ...Object.values(data.entityVectors)]) {
      expect(vector).toBeInstanceOf(Float32Array);
    }
    expect(Array.from(data.eventVectors.list)).toEqual(A);
    expect(Array.from(data.eventVectors.typed)).toEqual(B);
    expect(Array.from(data.eventVectors.base64)).toEqual(C);
    expect(Array.from(data.eventVectors.object)).toEqual(A);
    expect(Array.from(data.entityVectors.Alice)).toEqual(B);
    expect(data.edgeVectors).toEqual({}); // a record from before edge vectors existed
    expect(data.model).toBe('embed-1');
    expect(data.dim).toBe(3);
    // Reading never writes: the export reads through load, and must not change the database.
    expect(set).not.toHaveBeenCalled();
    const stored = await idbAdapter.get<{ eventVectors: Record<string, unknown> }>(keyOf(s));
    expect(stored?.eventVectors.list).toEqual(A);
  });

  it('leaves out an entry that is no vector, and says so', async () => {
    const s = freshSlot();
    await idbAdapter.set(keyOf(s), { eventVectors: { good: A, notBase64: 'not base64!!', nothing: null, mixed: [1, 'x'] }, entityVectors: {}, model: 'm', dim: 3 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const data = await new VectorStore().load(s.profileId, s.slotId);

    expect(Object.keys(data.eventVectors)).toEqual(['good']);
    expect(warn).toHaveBeenCalledWith('[VectorStore] eventVectors: 3 entries are not vectors; left out');
  });

  it('an empty slot loads as empty tables', async () => {
    const s = freshSlot();
    expect(await new VectorStore().load(s.profileId, s.slotId)).toEqual({ eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: '', dim: 0 });
  });

  it('a merge stores the embedder\'s number lists as Float32Arrays, and the whole record takes the new form', async () => {
    const s = freshSlot();
    await idbAdapter.set(keyOf(s), { eventVectors: { old: A }, entityVectors: {}, edgeVectors: { edge_old: indexObject(C) }, model: 'm', dim: 3 });
    const store = new VectorStore();

    await store.mergeEntityVectors([{ name: 'Bob' }], [B], 'm', s);

    const stored = await store.loadStored(s.profileId, s.slotId) as { eventVectors: Record<string, unknown>; entityVectors: Record<string, unknown>; edgeVectors: Record<string, unknown>; dim: number };
    expect(stored.entityVectors.Bob).toBeInstanceOf(Float32Array);
    expect(stored.eventVectors.old).toBeInstanceOf(Float32Array);
    expect(stored.edgeVectors.edge_old).toBeInstanceOf(Float32Array);
    expect(Array.from(stored.entityVectors.Bob as Float32Array)).toEqual(B);
    expect(Array.from(stored.eventVectors.old as Float32Array)).toEqual(A);
    expect(Array.from(stored.edgeVectors.edge_old as Float32Array)).toEqual(C);
    expect(stored.dim).toBe(3);
  });

  it('a merge stores a Float32Array view with a buffer of its own', async () => {
    const s = freshSlot();
    const big = Float32Array.from([...A, ...B]);
    const view = big.subarray(3, 6);
    const store = new VectorStore();

    await store.mergeEventVectors([{ id: 'e1' }], [view], 'm', s);

    const stored = await store.loadStored(s.profileId, s.slotId) as { eventVectors: Record<string, Float32Array> };
    expect(stored.eventVectors.e1.buffer.byteLength).toBe(12);
    expect(Array.from(stored.eventVectors.e1)).toEqual(B);
  });

  it('removes the given vectors of each table in one write; keys a table does not hold are skipped', async () => {
    const s = freshSlot();
    await idbAdapter.set(keyOf(s), {
      eventVectors: { a: A, b: B }, entityVectors: { Alice: C }, edgeVectors: { g1: A }, model: 'm', dim: 3,
    });
    const store = new VectorStore();
    const set = vi.spyOn(idbAdapter, 'set');

    const removed = await store.removeVectors({ eventVectors: ['a', 'missing', 'toString'], edgeVectors: ['g1'] }, s.profileId, s.slotId);

    expect(removed).toBe(2);
    expect(set).toHaveBeenCalledTimes(1);
    const data = await store.load(s.profileId, s.slotId);
    expect(Object.keys(data.eventVectors)).toEqual(['b']);
    expect(Object.keys(data.entityVectors)).toEqual(['Alice']);
    expect(data.edgeVectors).toEqual({});
  });

  it('writes nothing when none of the vectors to remove is held', async () => {
    const s = freshSlot();
    await idbAdapter.set(keyOf(s), { eventVectors: { a: A }, entityVectors: {}, edgeVectors: {}, model: 'm', dim: 3 });
    const set = vi.spyOn(idbAdapter, 'set');

    expect(await new VectorStore().removeVectors({ entityVectors: ['nobody'], eventVectors: [] }, s.profileId, s.slotId)).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });

  it('loadStored and restoreStored give back a record exactly as it was stored', async () => {
    const s = freshSlot();
    const record = { eventVectors: { a: A, o: indexObject(B) }, entityVectors: {}, model: 'm', dim: 3, extra: 'kept' };
    await idbAdapter.set(keyOf(s), record);
    const store = new VectorStore();

    const stored = await store.loadStored(s.profileId, s.slotId);
    await idbAdapter.delete(keyOf(s));
    await store.restoreStored(s.profileId, s.slotId, stored);

    expect(await idbAdapter.get(keyOf(s))).toEqual(record);
    expect(await store.loadStored('prof_none', 'slot_none')).toBeUndefined();
  });

  it('a bundle carries each vector as the base64 of its float32 bytes and reads back the same values', () => {
    const data = vectorDataFromBundle({ eventVectors: { a: A }, entityVectors: { Bob: B }, edgeVectors: { g: C }, model: 'm', dim: 3 });
    const bundle = JSON.parse(JSON.stringify(vectorDataForBundle(data))) as Record<string, unknown>;

    expect(bundle).toEqual({
      eventVectors: { a: encodeVectorBase64(A) }, entityVectors: { Bob: encodeVectorBase64(B) }, edgeVectors: { g: encodeVectorBase64(C) },
      model: 'm', dim: 3,
    });
    const back = vectorDataFromBundle(bundle);
    expect(Array.from(back.eventVectors.a)).toEqual(A);
    expect(Array.from(back.entityVectors.Bob)).toEqual(B);
    expect(Array.from(back.edgeVectors.g)).toEqual(C);
  });

  it('a bundle without vector data reads as empty tables', () => {
    for (const raw of [null, undefined, [], 'x', { model: 3, dim: 'x' }]) {
      expect(vectorDataFromBundle(raw)).toEqual({ eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: '', dim: 0 });
    }
  });
});
