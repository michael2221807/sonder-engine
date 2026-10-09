import 'fake-indexeddb/auto';
/**
 * Vectors in a backup bundle (存档瘦身 D4A): a version 2 export carries each vector as the base64 of its little-endian
 * float32 bytes; an import takes every form a vector has been exported in — the number lists of a version 1 bundle,
 * the base64 of version 2, the objects of indices an older tab writes for a Float32Array — and the vector store holds
 * them as Float32Arrays of the same values. Real stores (backup-harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBackupHarness, stateTree } from '../__test-utils__/backup-harness';
import { encodeVectorBase64 } from './save-format/vector-codec';

vi.setConfig({ testTimeout: 120_000 });

type Json = Record<string, unknown>;

// Float32 values exactly (every embedding is float32), signs mixed.
const E1 = [0.5, -0.25, 0.125, 1.5];
const E2 = [-0.75, 0.0625, 2, -1];
const ALICE = [0.25, 0.25, -0.5, 0.75];
const EDGE = [3, -0.125, 0.5, 0.25];

const asBlob = (text: string) => new Blob([text], { type: 'application/json' });
const indexObject = (values: number[]) => JSON.parse(JSON.stringify(Float32Array.from(values))) as Json;

/** A version 2 export of one profile with one slot holding the four vectors (stored as number lists, an older save). */
async function exportedBundle(kind: 'all' | 'profile'): Promise<Json> {
  const h = await makeBackupHarness('empty');
  await h.addProfile('prof_v', 'Vera', ['slot_1']);
  await h.saveSlot('prof_v', 'slot_1', stateTree('Vera', 3));
  await h.vectors.save('prof_v', 'slot_1', {
    eventVectors: { e1: E1, e2: E2 }, entityVectors: { Alice: ALICE }, edgeVectors: { g1: EDGE }, model: 'embed-1', dim: 4,
  });
  const blob = kind === 'all' ? await h.backup.exportAll() : await h.backup.exportProfile('prof_v');
  return JSON.parse(await blob.text()) as Json;
}

/** The slot's vectors in the target store after an import, as stored. */
async function importedVectors(bundle: Json, how: 'importAll' | 'importProfileReplace') {
  const t = await makeBackupHarness('empty');
  if (how === 'importAll') await t.backup.importAll(asBlob(JSON.stringify(bundle)));
  else await t.backup.importProfileReplace(asBlob(JSON.stringify(bundle)));
  return await t.vectors.loadStored('prof_v', 'slot_1') as {
    eventVectors: Record<string, unknown>; entityVectors: Record<string, unknown>; edgeVectors: Record<string, unknown>; model: string; dim: number;
  };
}

/** The values of a stored vector, which must be a Float32Array. */
function float32(vector: unknown): number[] {
  if (!(vector instanceof Float32Array)) throw new Error(`not a Float32Array: ${Object.prototype.toString.call(vector)}`);
  return Array.from(vector);
}

function vectorsOf(bundle: Json): Json {
  return (bundle.vectors as Record<string, Json>)['prof_v/slot_1'];
}

describe('vectors in a backup bundle (存档瘦身 D4A)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exports a version 2 bundle with each vector as the base64 of its float32 bytes', async () => {
    const bundle = await exportedBundle('all');
    expect(bundle.version).toBe(2);
    expect(vectorsOf(bundle)).toEqual({
      eventVectors: { e1: encodeVectorBase64(E1), e2: encodeVectorBase64(E2) },
      entityVectors: { Alice: encodeVectorBase64(ALICE) },
      edgeVectors: { g1: encodeVectorBase64(EDGE) },
      model: 'embed-1',
      dim: 4,
    });
  });

  it('a profile export (also the cloud slot upload) carries the vectors as base64 too', async () => {
    const bundle = await exportedBundle('profile');
    expect(bundle.version).toBe(2);
    expect(vectorsOf(bundle).eventVectors).toEqual({ e1: encodeVectorBase64(E1), e2: encodeVectorBase64(E2) });
    expect(vectorsOf(bundle).edgeVectors).toEqual({ g1: encodeVectorBase64(EDGE) });
  });

  it('imports it back as Float32Arrays of the same values', async () => {
    const stored = await importedVectors(await exportedBundle('all'), 'importAll');
    expect(float32(stored.eventVectors.e1)).toEqual(E1);
    expect(float32(stored.eventVectors.e2)).toEqual(E2);
    expect(float32(stored.entityVectors.Alice)).toEqual(ALICE);
    expect(float32(stored.edgeVectors.g1)).toEqual(EDGE);
    expect(stored.model).toBe('embed-1');
    expect(stored.dim).toBe(4);
  });

  it('imports a version 1 bundle: its number lists become Float32Arrays', async () => {
    const bundle = await exportedBundle('all');
    bundle.version = 1;
    (bundle.vectors as Record<string, Json>)['prof_v/slot_1'] = {
      eventVectors: { e1: E1, e2: E2 }, entityVectors: { Alice: ALICE }, edgeVectors: { g1: EDGE }, model: 'embed-1', dim: 4,
    };
    const stored = await importedVectors(bundle, 'importAll');
    expect(float32(stored.eventVectors.e1)).toEqual(E1);
    expect(float32(stored.entityVectors.Alice)).toEqual(ALICE);
    expect(float32(stored.edgeVectors.g1)).toEqual(EDGE);
  });

  it('imports the objects of indices an older tab exports for a Float32Array, and every form mixed in one bundle', async () => {
    const bundle = await exportedBundle('profile');
    (bundle.vectors as Record<string, Json>)['prof_v/slot_1'] = {
      eventVectors: { e1: indexObject(E1), e2: E2 },
      entityVectors: { Alice: encodeVectorBase64(ALICE) },
      edgeVectors: { g1: indexObject(EDGE) },
      model: 'embed-1',
      dim: 4,
    };
    const stored = await importedVectors(bundle, 'importProfileReplace');
    expect(float32(stored.eventVectors.e1)).toEqual(E1);
    expect(float32(stored.eventVectors.e2)).toEqual(E2);
    expect(float32(stored.entityVectors.Alice)).toEqual(ALICE);
    expect(float32(stored.edgeVectors.g1)).toEqual(EDGE);
  });

  it('leaves out an imported entry that is no vector, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bundle = await exportedBundle('all');
    (vectorsOf(bundle).eventVectors as Json).broken = 'not base64!!';
    const stored = await importedVectors(bundle, 'importAll');
    expect(Object.keys(stored.eventVectors).sort()).toEqual(['e1', 'e2']);
    expect(warn).toHaveBeenCalledWith('[VectorStore] eventVectors: 1 entry is not a vector; left out');
  });
});
