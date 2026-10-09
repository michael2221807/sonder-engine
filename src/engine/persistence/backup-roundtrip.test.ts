import 'fake-indexeddb/auto';
/**
 * Backup / restore behaviour lock (refactor R6, step 0, group A).
 *
 * The real stores (ProfileManager, SaveManager, ConfigStore, PromptStorage, VectorStore, CustomPresetStore,
 * ImageAssetCache, WorldBookStorage) run on a fake IndexedDB under the real BackupService. Every exporter's bundle is
 * written byte for byte to `__snapshots__/backup-roundtrip/<id>.json`; every importer is run against a different
 * "local" machine and the whole database, the localStorage, the events and the thrown or toasted text are recorded.
 *
 * A refactor of backup-service.ts must leave every file unchanged. Snapshots are never rewritten with `-u` during the
 * refactor; a changed snapshot is a failed step. See docs/status/code-audit-2026-10/plans/R6-memory-save-sync.md §3.
 *
 * Determinism: Date is faked and Math.random is fixed (so `exportedAt` and every timestamp are constants), the device
 * id is preset, every case builds its own modules and its own IDBFactory (the idbAdapter is a singleton). Only gzip
 * would be environment specific and nothing here compresses.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  makeBackupHarness, stateTree, type BackupHarness,
} from '../__test-utils__/backup-harness';
import {
  serialize, sha256Hex, errorInfo, dumpAllIdb, dumpLocalStorage, diffLocalStorage, type IdbDump,
} from '../__test-utils__/snapshot-lock';

// A case builds its own modules and database; the first one of a file also pays the module transform, which is slow
// under a parallel run. A timed-out case is NOT cancelled: it would keep running and swap the globals of the next case.
vi.setConfig({ testTimeout: 120_000 });

const SNAPSHOT_DIR = '__snapshots__/backup-roundtrip';

type Json = Record<string, unknown>;
type Outcome = { ok: unknown } | { threw: { name: string; message: string } };

async function snap(id: string, text: string): Promise<void> {
  await expect(text).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}
async function snapDoc(id: string, doc: unknown): Promise<void> {
  await snap(id, serialize(doc));
}

async function record(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { threw: errorInfo(err) };
  }
}

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

const asBlob = (text: string): Blob => new Blob([text], { type: 'application/json' });

interface State { idb: IdbDump; ls: Record<string, string | null> }
async function dumpState(h: BackupHarness): Promise<State> {
  return { idb: await dumpAllIdb(), ls: dumpLocalStorage(h.storage) };
}

/** Names of the databases whose content differs between two dumps (an exact rollback leaves this empty). */
function changedDatabases(before: IdbDump, after: IdbDump): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n])).sort();
}

let warnSpy: MockInstance<typeof console.warn>;
const warnings = (): unknown[] => warnSpy.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '<non-string>'));

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── the bundles every import case starts from (exported once by the rich source machine) ──

interface Sources {
  full: string;
  fullNoRef: string;
  sync: string;
  profileA: string;
  profileB: string;
  global: string;
}
let sources: Sources | null = null;

async function getSources(): Promise<Sources> {
  if (sources) return sources;
  const h = await makeBackupHarness('full');
  sources = {
    full: await (await h.backup.exportAll({ includeReferenceAssets: true })).text(),
    fullNoRef: await (await h.backup.exportAll()).text(),
    sync: await (await h.backup.exportForSync({ includeReferenceAssets: true })).blob.text(),
    profileA: await (await h.backup.exportProfile('prof_a', { includeReferenceAssets: true })).text(),
    profileB: await (await h.backup.exportProfile('prof_b')).text(),
    global: await (await h.backup.exportGlobalForSync()).blob.text(),
  };
  return sources;
}

function edited(text: string, edit: (bundle: Json) => void): string {
  const bundle = JSON.parse(text) as Json;
  edit(bundle);
  return JSON.stringify(bundle, null, 2);
}

/** The local machine of the profile-level cases: a prof_a that differs from the bundle's prof_a. */
async function localWithOwnProfileA(): Promise<BackupHarness> {
  const t = await makeBackupHarness('local');
  await t.addProfile('prof_a', 'Alice (local)', ['slot_1', 'slot_2', 'slot_extra']);
  await t.saveSlot('prof_a', 'slot_1', stateTree('LocalAlice', 7, {
    角色: { 基础信息: { 姓名: 'LocalAlice' }, 图片档案: { 已选头像图片ID: 'img_avatar_a' } },
  }));
  await t.saveSlot('prof_a', 'slot_2', stateTree('LocalAlice', 4));
  // slot_extra: one image only this slot uses and one image another profile also uses
  await t.saveSlot('prof_a', 'slot_extra', stateTree('LocalAlice', 8, {
    角色: { 基础信息: { 姓名: 'LocalAlice' }, 图片档案: { 已选头像图片ID: 'img_old_only', 生图历史: [{ id: 'img_shared' }] } },
  }));
  await t.addProfile('prof_b', 'Bob (local)', ['slot_1']);
  await t.saveSlot('prof_b', 'slot_1', stateTree('LocalBob', 3, {
    角色: { 基础信息: { 姓名: 'LocalBob' }, 图片档案: { 已选头像图片ID: 'img_shared' } },
  }));
  await t.profiles.setActiveProfile('prof_a', 'slot_extra');
  for (const id of ['img_old_only', 'img_shared', 'img_avatar_a']) await t.storeImage(id, `local:${id}`);
  await t.putBook('prof_a', 'wb_old', 1);
  await t.putBook('prof_b', 'wb_b_local', 1);
  await t.vectors.save('prof_a', 'slot_2', {
    eventVectors: { evt_stale: [1, 0, 0] }, entityVectors: {}, edgeVectors: {}, model: 'old', dim: 3,
  });
  await t.vectors.save('prof_a', 'slot_extra', {
    eventVectors: { evt_extra: [0, 1, 0] }, entityVectors: {}, edgeVectors: {}, model: 'old', dim: 3,
  });
  return t;
}

describe('R6 step 0 · A · backup export', () => {
  it('X1 exportAll with and without the reference library', async () => {
    const h = await makeBackupHarness('full');
    const before = await dumpState(h);
    h.startRecording();
    const off = await (await h.backup.exportAll()).text();
    const on = await (await h.backup.exportAll({ includeReferenceAssets: true })).text();
    const after = await dumpState(h);
    await snap('X1-reference-off', off);
    await snap('X1-reference-on', on);
    await snapDoc('X1-side-effects', {
      emits: h.emits,
      databasesChanged: changedDatabases(before.idb, after.idb),
      lsChanged: diffLocalStorage(before.ls, after.ls),
    });
  });

  it('X2 exportForSync reports the integrity and carries the own-sync key', async () => {
    const h = await makeBackupHarness('full');
    h.startRecording();
    const plain = await h.backup.exportForSync();
    const withRef = await h.backup.exportForSync({ includeReferenceAssets: true });
    const text = await plain.blob.text();
    const refText = await withRef.blob.text();
    const parsed = JSON.parse(text) as Json;
    const exportAll = JSON.parse(await (await h.backup.exportAll()).text()) as Json;
    await snapDoc('X2', {
      imageIntegrity: plain.imageIntegrity,
      worldBookIntegrity: plain.worldBookIntegrity,
      bundleSha256: sha256Hex(text),
      bundleLength: text.length,
      topLevelKeys: Object.keys(parsed),
      engineSettings: parsed['engineSettings'],
      exportAllEngineSettingsKeys: Object.keys(exportAll['engineSettings'] as Json),
      imageAssetIds: (parsed['imageAssets'] as Array<{ id: string }>).map((a) => a.id),
      withReferenceAssets: {
        imageIntegrity: withRef.imageIntegrity,
        bundleSha256: sha256Hex(refText),
        imageAssetIds: (JSON.parse(refText).imageAssets as Array<{ id: string }>).map((a) => a.id),
      },
      emits: h.emits,
    });
  });

  it('X3 exportProfile and exportProfileForSync', async () => {
    const h = await makeBackupHarness('full');
    h.startRecording();
    const a = await (await h.backup.exportProfile('prof_a')).text();
    const aRef = await (await h.backup.exportProfile('prof_a', { includeReferenceAssets: true })).text();
    const b = await (await h.backup.exportProfile('prof_b')).text();
    const syncA = await h.backup.exportProfileForSync('prof_a');
    const syncB = await h.backup.exportProfileForSync('prof_b', { includeReferenceAssets: true });
    const missing = await record(() => h.backup.exportProfile('prof_nope'));
    await snap('X3-prof_a', a);
    await snap('X3-prof_a-reference', aRef);
    await snap('X3-prof_b', b);
    await snapDoc('X3-sync', {
      prof_a: {
        imageIntegrity: syncA.imageIntegrity, worldBookIntegrity: syncA.worldBookIntegrity,
        displayMeta: syncA.displayMeta, bundleSha256: sha256Hex(await syncA.blob.text()),
      },
      prof_b_reference: {
        imageIntegrity: syncB.imageIntegrity, worldBookIntegrity: syncB.worldBookIntegrity,
        displayMeta: syncB.displayMeta, bundleSha256: sha256Hex(await syncB.blob.text()),
      },
      sameBytesAsExportProfile: sha256Hex(await syncA.blob.text()) === sha256Hex(a),
      listProfileIds: h.backup.listProfileIds(),
      missingProfile: missing,
      emits: h.emits,
    });
  });

  it('X4 a profile whose slot has no save record is refused, the full export is not', async () => {
    const h = await makeBackupHarness('full');
    await h.mods.idbAdapter.delete('save_prof_a_slot_2');
    h.startRecording();
    const e1 = await thrown(() => h.backup.exportProfile('prof_a')) as { name: string; message: string; profileId: string; missingSlotIds: string[]; orphanSaveSlotIds: string[] };
    const e2 = await thrown(() => h.backup.exportProfileForSync('prof_a')) as { name: string; message: string };
    const full = JSON.parse(await (await h.backup.exportAll()).text()) as Json;
    await snapDoc('X4', {
      exportProfile: { ...errorInfo(e1), profileId: e1.profileId, missingSlotIds: e1.missingSlotIds, orphanSaveSlotIds: e1.orphanSaveSlotIds },
      exportProfileForSync: errorInfo(e2),
      exportAllSaveKeys: Object.keys(full['saves'] as Json),
      emits: h.emits,
    });
  });

  it('X5 exportGlobalForSync', async () => {
    const h = await makeBackupHarness('full');
    h.startRecording();
    const { blob } = await h.backup.exportGlobalForSync();
    await snap('X5-global', await blob.text());
    await snapDoc('X5-side-effects', { emits: h.emits });
  });

  it('X6 evicted cache images: referenced is larger than exported, and the oversize library warning', async () => {
    const h = await makeBackupHarness('full');
    for (const id of ['img_avatar_a', 'img_hist_a1', 'img_wall_a']) await h.images.delete(id);
    h.startRecording();
    const r = await h.backup.exportForSync();
    const text = await r.blob.text();
    await snapDoc('X6-evicted', {
      imageIntegrity: r.imageIntegrity,
      bundleSha256: sha256Hex(text),
      exportedIds: (JSON.parse(text).imageAssets as Array<{ id: string }>).map((a) => a.id),
      emits: h.emits,
    });

    const big = await makeBackupHarness('full');
    await big.storeImage('img_lib_1', 'bytes:img_lib_1', 250 * 1024 * 1024);
    big.startRecording();
    const off = await big.backup.exportForSync();
    const on = await big.backup.exportForSync({ includeReferenceAssets: true });
    await snapDoc('X6-library-large', {
      off: { imageIntegrity: off.imageIntegrity },
      on: { imageIntegrity: on.imageIntegrity },
      emits: big.emits,
    });
  });
});

describe('R6 step 0 · A · backup import', () => {
  it('I1 full export, wipe, importAll, then the second export is the same bytes', async () => {
    const src = await getSources();
    const t = await makeBackupHarness('local');
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(src.full)));
    const after = await dumpState(t);
    const again = await (await t.backup.exportAll({ includeReferenceAssets: true })).text();
    await snapDoc('I1', {
      outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), state: after, warnings: warnings(),
      reexportIdenticalToSource: again === src.full,
    });
    await snap('I1-reexport', again);
  });

  it('I2 a profile bundle merges into the profile of the same id', async () => {
    const src = await getSources();
    const t = await localWithOwnProfileA();
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(src.profileA)));
    const after = await dumpState(t);
    await snapDoc('I2', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after });
  });

  it('I3a a v1 bundle without bundleType but with global data is a full replace', async () => {
    const src = await getSources();
    const text = edited(src.fullNoRef, (b) => { delete b['bundleType']; delete b['activeProfile']; });
    const t = await makeBackupHarness('local');
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(text)));
    const after = await dumpState(t);
    await snapDoc('I3a-v1-with-global', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), state: after });
  });

  it('I3b a v1 bundle without bundleType and without global data is a profile merge', async () => {
    const src = await getSources();
    const text = edited(src.profileB, (b) => { delete b['bundleType']; });
    const t = await makeBackupHarness('local');
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(text)));
    const after = await dumpState(t);
    await snapDoc('I3b-v1-without-global', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after });
  });

  it('I4 a global bundle replaces only the global area', async () => {
    const src = await getSources();
    const t = await makeBackupHarness('local');
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(src.global)));
    const after = await dumpState(t);
    await snapDoc('I4', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after });
  });

  it('I5a importProfileReplace: slot diff deletion, shared image kept, profile world books replaced, pointer healed', async () => {
    const src = await getSources();
    const t = await localWithOwnProfileA();
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importProfileReplace(asBlob(src.profileA)));
    const after = await dumpState(t);
    await snapDoc('I5a', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after, warnings: warnings() });
  });

  it('I5b importProfileReplace with a degraded bundle (images referenced, none carried) keeps the local images', async () => {
    const src = await getSources();
    const text = edited(src.profileA, (b) => { b['imageAssets'] = []; });
    const t = await localWithOwnProfileA();
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importProfileReplace(asBlob(text)));
    const after = await dumpState(t);
    await snapDoc('I5b', { outcome, emits: t.emits, changed: changedDatabases(before.idb, after.idb), state: after });
  });

  it('I6 full replace failing in ConfigStore.importAll rolls back', async () => {
    const src = await getSources();
    const t = await makeBackupHarness('local');
    vi.spyOn(t.mods.ConfigStore.prototype, 'importAll').mockRejectedValueOnce(new Error('config import boom'));
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(src.full)));
    const after = await dumpState(t);
    await snapDoc('I6', { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after, warnings: warnings() });
  });

  it('I7 global import failing in ConfigStore.importAll rolls back, and a failing rollback is reported', async () => {
    const src = await getSources();
    const t = await makeBackupHarness('local');
    vi.spyOn(t.mods.ConfigStore.prototype, 'importAll').mockRejectedValueOnce(new Error('config import boom'));
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importAll(asBlob(src.global)));
    const after = await dumpState(t);

    const t2 = await makeBackupHarness('local');
    vi.spyOn(t2.mods.CustomPresetStore.prototype, 'listPackIds').mockRejectedValue(new Error('list boom'));
    t2.startRecording();
    const rollbackFails = await record(() => t2.backup.importAll(asBlob(src.global)));
    await snapDoc('I7', {
      rollbackOk: { outcome, emits: t.emits, lsDiff: diffLocalStorage(before.ls, after.ls), changed: changedDatabases(before.idb, after.idb), state: after },
      rollbackFails: { outcome: rollbackFails, emits: t2.emits },
      warnings: warnings(),
    });
  });

  it('I8 profile replace failing while writing world books rolls the profile back', async () => {
    const src = await getSources();
    const t = await localWithOwnProfileA();
    vi.spyOn(t.mods.WorldBookStorage.prototype, 'saveWorldBook').mockRejectedValueOnce(new Error('world book boom'));
    const before = await dumpState(t);
    t.startRecording();
    const outcome = await record(() => t.backup.importProfileReplace(asBlob(src.profileA)));
    const after = await dumpState(t);
    await snapDoc('I8', { outcome, emits: t.emits, changed: changedDatabases(before.idb, after.idb), state: after });
  });

  it('I9 invalid bundles are refused before anything is written', async () => {
    const src = await getSources();
    const t = await localWithOwnProfileA();
    const before = await dumpState(t);
    t.startRecording();
    const twoProfiles = edited(src.full, (b) => { b['bundleType'] = 'profile'; });
    const missingSave = edited(src.profileA, (b) => { delete (b['saves'] as Json)['prof_a/slot_2']; });
    const orphanSave = edited(src.profileA, (b) => { (b['saves'] as Json)['prof_a/slot_ghost'] = {}; });
    const foreignKeys = edited(src.profileA, (b) => { (b['saves'] as Json)['prof_b/slot_1'] = { 角色: { 基础信息: { 姓名: 'Intruder' } } }; });
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['importAll not json', () => t.backup.importAll(asBlob('not json at all'))],
      ['importAll wrong shape', () => t.backup.importAll(asBlob('{"version":1}'))],
      ['importAll future version', () => t.backup.importAll(asBlob(edited(src.fullNoRef, (b) => { b['version'] = 3; })))],
      ['importProfileReplace wrong shape', () => t.backup.importProfileReplace(asBlob('[]'))],
      ['importProfileReplace future version', () => t.backup.importProfileReplace(asBlob(edited(src.profileA, (b) => { b['version'] = 9; })))],
      ['importProfileReplace full bundle', () => t.backup.importProfileReplace(asBlob(src.fullNoRef))],
      ['importProfileReplace no bundleType', () => t.backup.importProfileReplace(asBlob(edited(src.profileA, (b) => { delete b['bundleType']; })))],
      ['importProfileReplace two profiles', () => t.backup.importProfileReplace(asBlob(twoProfiles))],
      ['importProfileReplace missing save', () => t.backup.importProfileReplace(asBlob(missingSave))],
      ['importProfileReplace orphan save', () => t.backup.importProfileReplace(asBlob(orphanSave))],
      ['importGlobal full bundle', () => t.backup.importGlobal(JSON.parse(src.fullNoRef))],
      ['importGlobal no bundleType', () => t.backup.importGlobal(JSON.parse(edited(src.global, (b) => { delete b['bundleType']; })))],
    ];
    const outcomes: Array<{ label: string; outcome: Outcome }> = [];
    for (const [label, run] of cases) outcomes.push({ label, outcome: await record(run) });
    const afterRefused = await dumpState(t);
    // a profile bundle that smuggles another profile's save key: the foreign key is dropped, never written
    const smuggle = await record(() => t.backup.importProfileReplace(asBlob(foreignKeys)));
    const afterSmuggle = await dumpState(t);
    await snapDoc('I9', {
      outcomes,
      nothingWrittenByRefusals: changedDatabases(before.idb, afterRefused.idb).length === 0 && JSON.stringify(before.ls) === JSON.stringify(afterRefused.ls),
      smuggle: {
        outcome: smuggle,
        intruderWritten: JSON.stringify(afterSmuggle.idb).includes('Intruder'),
      },
      emits: t.emits,
    });
  });

  it('I10 own-sync keys: only a download from the own sync writes them, a failed one puts them back', async () => {
    const src = await getSources();
    const run = async (label: string, bundle: string, source: { fromOwnSync?: boolean } | undefined, failConfig = false): Promise<unknown> => {
      const t = await makeBackupHarness('local');
      if (failConfig) vi.spyOn(t.mods.ConfigStore.prototype, 'importAll').mockRejectedValueOnce(new Error('config import boom'));
      const before = dumpLocalStorage(t.storage);
      t.startRecording();
      const outcome = await record(() => t.backup.importAll(asBlob(bundle), source));
      return { label, outcome, lsDiff: diffLocalStorage(before, dumpLocalStorage(t.storage)), emits: t.emits };
    };
    await snapDoc('I10', {
      syncBundleFile: await run('sync bundle, imported as a file', src.sync, undefined),
      syncBundleOwn: await run('sync bundle, own sync', src.sync, { fromOwnSync: true }),
      syncBundleOwnFails: await run('sync bundle, own sync, config import fails', src.sync, { fromOwnSync: true }, true),
      syncBundleFileFails: await run('sync bundle, file, config import fails', src.sync, undefined, true),
      globalOwn: await run('global bundle, own sync', src.global, { fromOwnSync: true }),
      globalFile: await run('global bundle, file', src.global, undefined),
      manualBackupOwn: await run('manual backup (no own-sync key inside), own sync', src.full, { fromOwnSync: true }),
    });
  });

  it('I11 a bundle without a world book section keeps the local books, an explicit empty list clears them', async () => {
    const src = await getSources();
    const noSection = edited(src.full, (b) => { delete b['worldBooks']; });
    const emptySection = edited(src.full, (b) => { b['worldBooks'] = { version: 1, exportedAt: 'x', books: [] }; });
    const profileNoSection = edited(src.profileA, (b) => { delete b['worldBooks']; });
    const worldBookRows = (state: State): unknown => state.idb['aga-worldbook']?.['worldbooks']?.map(([k]) => k);

    const t1 = await makeBackupHarness('local');
    t1.startRecording();
    const o1 = await record(() => t1.backup.importAll(asBlob(noSection)));
    const s1 = await dumpState(t1);

    const t2 = await makeBackupHarness('local');
    t2.startRecording();
    const o2 = await record(() => t2.backup.importAll(asBlob(emptySection)));
    const s2 = await dumpState(t2);

    const t3 = await localWithOwnProfileA();
    t3.startRecording();
    const o3 = await record(() => t3.backup.importProfileReplace(asBlob(profileNoSection)));
    const s3 = await dumpState(t3);

    await snapDoc('I11', {
      fullWithoutSection: { outcome: o1, emits: t1.emits, worldBookKeys: worldBookRows(s1) },
      fullWithEmptyList: { outcome: o2, emits: t2.emits, worldBookKeys: worldBookRows(s2) },
      profileWithoutSection: { outcome: o3, emits: t3.emits, worldBookKeys: worldBookRows(s3) },
    });
  });
});
