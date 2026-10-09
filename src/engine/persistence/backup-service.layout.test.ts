import 'fake-indexeddb/auto';
/**
 * Backup files are compact JSON from 存档瘦身 D9A on (about half the text); every backup written before (indented)
 * still imports, to the very same state. Real stores (backup-harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBackupHarness, stateTree } from '../__test-utils__/backup-harness';
import { dumpAllIdb } from '../__test-utils__/snapshot-lock';

vi.setConfig({ testTimeout: 120_000 });

const asBlob = (text: string) => new Blob([text], { type: 'application/json' });

async function exported(): Promise<string> {
  const h = await makeBackupHarness('empty');
  await h.addProfile('prof_l', 'Lin', ['slot_1', 'slot_2']);
  await h.saveSlot('prof_l', 'slot_1', stateTree('Lin', 4));
  await h.saveSlot('prof_l', 'slot_2', stateTree('Lin', 9));
  await h.vectors.save('prof_l', 'slot_1', {
    eventVectors: { e1: [0.5, -0.25] }, entityVectors: {}, edgeVectors: {}, model: 'm', dim: 2,
  });
  return (await h.backup.exportAll()).text();
}

/** The databases and settings after importing the text into an empty machine. */
async function importedState(text: string) {
  const t = await makeBackupHarness('empty');
  await t.backup.importAll(asBlob(text));
  const ls: Record<string, string | null> = {};
  for (let i = 0; i < t.storage.length; i++) {
    const key = t.storage.key(i)!;
    ls[key] = t.storage.getItem(key);
  }
  return { idb: await dumpAllIdb(), ls };
}

describe('backup files as compact JSON (存档瘦身 D9A)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exports compact JSON: the same bundle, without the indentation', async () => {
    const text = await exported();
    const bundle = JSON.parse(text) as unknown;
    expect(text).toBe(JSON.stringify(bundle));
    expect(text.length).toBeLessThan(JSON.stringify(bundle, null, 2).length * 0.8);
  });

  it('imports a backup written indented (every backup before D9A) to the same state as the same backup compact', async () => {
    const compact = await exported();
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    expect(pretty).not.toBe(compact);

    const fromCompact = await importedState(compact);
    const fromPretty = await importedState(pretty);

    expect(JSON.stringify(fromPretty)).toBe(JSON.stringify(fromCompact));
    // The import did write the saves and the vectors (the comparison is not of two empty machines).
    const keys = Object.values(fromCompact.idb['aga-saves'] ?? {}).flatMap((entries) => entries.map(([key]) => key));
    expect(keys).toEqual(expect.arrayContaining(['save_prof_l_slot_1', 'save_prof_l_slot_2', 'engram_vectors_prof_l_slot_1']));
  });
});
