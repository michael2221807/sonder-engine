/**
 * Game-card import Stage 2 behaviour lock (refactor R6, step 10 - written BEFORE assembleAndPersist is split).
 *
 * Runs the real `GameCardImportService.importCard` (decode + validate + assemble + persist) against recording deps
 * and records, byte for byte, in `__snapshots__/card-import-stage2/<id>.json`: the ordered call log of every dep
 * (stores, activation, opening), the tree handed to `activateSave`, the saved snapshot and its meta, the result
 * (or failure code and detail) and the localStorage changes. Rollback, global-settings restore and the undo handle
 * are covered. A split of `assembleAndPersist` must leave every file unchanged; snapshots are never rewritten with
 * `-u` during the refactor.
 *
 * Determinism: only Date is faked (profile ids are `profile_<now>`); there is no randomness in Stage 2.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get as _get, set as _set } from 'lodash-es';
import { createMockLocalStorage } from '../__test-utils__/local-storage.mock';
import { serialize, dumpLocalStorage, diffLocalStorage } from '../__test-utils__/snapshot-lock';
import { gzipCompress, sha256String } from '../core/codec';
import { CARD_FORMAT_VERSION } from './game-card-bundle.types';
import { GameCardImportService, type ImportServiceDeps } from './game-card-import-service';
import type { GamePack } from '../types/game-pack';
import type { ImportOptions } from './game-card-import.types';

const SNAPSHOT_DIR = '__snapshots__/card-import-stage2';
const NOW = new Date('2026-10-08T00:00:00.000Z');

const mockPack = {
  manifest: { id: 'tianming', version: '1.0.0' },
  prompts: { storyCore: 'x', styleGuide: 'y' },
  stateSchema: {
    properties: {
      角色: {
        type: 'object',
        properties: {
          基础信息: { type: 'object', properties: { 姓名: { type: 'string', default: '' }, 头像: { type: 'string', default: '' } } },
          属性: {
            type: 'object',
            properties: {
              体质: { type: 'number', default: 5 },
              法力: { type: 'number', default: 5 },
            },
          },
        },
      },
      系统: { type: 'object', properties: { nsfwMode: { type: 'boolean', default: false } } },
    },
  },
} as unknown as GamePack;

type Json = Record<string, unknown>;

function validBundle(over: Json = {}): Json {
  return {
    bundleType: 'card',
    version: 1,
    exportedAt: '2026-06-03T00:00:00.000Z',
    engineVersion: '0.1.0',
    cardMeta: {
      formatVersion: 1, cardId: 'card_lock', title: '锁定卡', description: '', author: 't', tags: [],
      createdAt: 'x', updatedAt: 'x', packId: 'tianming', packVersion: '1.0.0',
    },
    protagonist: { mode: 'fixed', data: {} },
    stateTree: { 角色: { 基础信息: { 姓名: '卡角色', 头像: 'img_a' }, 属性: { 体质: 7 } } },
    engram: { entities: [], knowledgeEdges: [] },
    ...over,
  };
}

/** A card that carries every payload. */
function fullBundle(): Json {
  return validBundle({
    engram: {
      entities: [{ name: '卡角色', type: 'player', summary: '主角', attributes: {}, firstSeen: 0, lastSeen: 0, mentionCount: 1, is_embedded: false }],
      knowledgeEdges: [{
        id: 'a|b|f', sourceEntity: '卡角色', targetEntity: '林月', fact: '卡角色与林月是兄妹关系', episodes: [],
        is_embedded: false, createdAtRound: 0, lastSeenRound: 0, core: true,
      }],
    },
    imageAssets: [
      { id: 'img_a', metadata: { id: 'img_a', taskId: 't', storageKey: 'k', mimeType: 'image/png', width: 1, height: 1, sizeBytes: 3, backend: 'comfyui', createdAt: 1 }, base64: 'AAAA', mimeType: 'image/png' },
      { id: 'img_b', metadata: { id: 'img_b', taskId: 't', storageKey: 'k', mimeType: 'image/png', width: 1, height: 1, sizeBytes: 3, backend: 'comfyui', createdAt: 2 }, base64: 'BBBB', mimeType: 'image/png' },
    ],
    customPresets: { tianming: { 出身: [{ id: 'p1', name: '预设一' }] } },
    worldBooks: {
      version: 1, exportedAt: 'x',
      books: [{ id: 'wb1', name: '设定书', ownership: 'slot', origin: 'system-captured', builtin: true, entries: [{ id: 'e1', keys: ['k'], content: 'c', capturedSetting: { a: 1 } }] }],
    },
    configOverlays: [{ domainId: 'd', packId: 'tianming', patches: { a: 1 }, version: 1, updatedAt: 5 }],
    promptOverrides: [{ key: 'k1', value: { v: 1 } }],
    promptEdits: { version: 1, packId: 'tianming', entries: [{ id: 'storyCore', content: '卡作者的改动' }, { id: 'unknownPrompt', content: 'dropped' }] },
    settings: {
      aga_user_settings: '{"theme":"dark"}',
      aga_cot_settings: '{"enabled":true}',
      aga_heartbeat_settings: '{"enabled":false}',
      aga_nsfw_settings: '{"nsfwMode":true,"nsfwGenderFilter":"male"}',
    },
    opening: { firstRoundSetup: '悬疑基调' },
  });
}

async function makeCardBlob(bundle: Json): Promise<Blob> {
  const checksum = await sha256String(JSON.stringify(bundle));
  return gzipCompress(JSON.stringify({ format: 'aga-card', formatVersion: CARD_FORMAT_VERSION, checksum, bundle }));
}

type LogEntry = { call: string; args?: unknown; ls?: Record<string, string | null> };

function summarise(v: unknown): unknown {
  if (typeof v === 'function') return '<fn>';
  if (Array.isArray(v)) return v.map(summarise);
  if (v && typeof v === 'object') {
    const o: Json = {};
    for (const [k, x] of Object.entries(v as Json)) o[k] = summarise(x);
    return o;
  }
  return v;
}

/** Minimal in-memory StateManager (what Stage 2 uses). */
function makeStateManager() {
  let tree: Json = {};
  return {
    get: <T>(path: string): T | undefined => _get(tree, path) as T | undefined,
    set: (path: string, val: unknown) => { _set(tree, path, val); },
    loadTree: (t: Json) => { tree = t; },
    toSnapshot: () => structuredClone(tree),
  };
}

interface Failures {
  saveGame?: boolean;
  activateSave?: boolean;
  importWorldBooks?: boolean;
  createProfile?: boolean;
  vectorizePending?: boolean;
  runOpening?: boolean;
  deleteGame?: boolean;
  configReplaceAll?: boolean;
}

function makeRecordingDeps(fail: Failures = {}, over: Partial<ImportServiceDeps> = {}) {
  const log: LogEntry[] = [];
  const sm = makeStateManager();
  const rec = <A extends unknown[], R>(call: string, impl: (...a: A) => R, withLs = false) =>
    (...args: A): R => {
      const entry: LogEntry = { call, args: summarise(args) };
      if (withLs) entry.ls = dumpLocalStorage(localStorage);
      log.push(entry);
      return impl(...args);
    };
  const boom = (what: string) => { throw new Error(`${what} boom`); };

  const deps: ImportServiceDeps = {
    stateManager: sm as never,
    saveManager: {
      saveGame: rec('saveManager.saveGame', async (...a: unknown[]) => { if (fail.saveGame) boom('saveGame'); void a; }),
      deleteGame: rec('saveManager.deleteGame', async () => { if (fail.deleteGame) boom('deleteGame'); }),
    } as never,
    profileManager: {
      createProfile: rec('profileManager.createProfile', async () => { if (fail.createProfile) boom('createProfile'); }),
      deleteProfile: rec('profileManager.deleteProfile', async () => {}),
      setActiveProfile: rec('profileManager.setActiveProfile', async () => {}),
    } as never,
    imageAssetCache: { importEntries: rec('imageAssetCache.importEntries', async () => {}) } as never,
    customPresetStore: { appendPreservingIds: rec('customPresetStore.appendPreservingIds', async () => [{ id: 'p1' }]) } as never,
    worldBookStorage: {
      importWorldBooks: rec('worldBookStorage.importWorldBooks', async () => { if (fail.importWorldBooks) boom('importWorldBooks'); return 1; }),
      clearBuiltinOverrides: rec('worldBookStorage.clearBuiltinOverrides', async () => {}),
      replaceBuiltinOverrides: rec('worldBookStorage.replaceBuiltinOverrides', async () => {}),
    } as never,
    configStore: {
      importAll: rec('configStore.importAll', async () => {}),
      exportAll: rec('configStore.exportAll', async () => [{ domainId: 'old', packId: 'tianming', patches: {}, version: 1, updatedAt: 1 }]),
      clear: rec('configStore.clear', async () => {}),
      replaceAll: rec('configStore.replaceAll', async () => { if (fail.configReplaceAll) boom('configReplaceAll'); }),
    } as never,
    promptStorage: {
      importAll: rec('promptStorage.importAll', async () => {}),
      exportAll: rec('promptStorage.exportAll', async () => [{ key: 'old', value: 1 }]),
      clear: rec('promptStorage.clear', async () => {}),
      replaceAll: rec('promptStorage.replaceAll', async () => {}),
    } as never,
    engramManager: {
      vectorizePending: rec('engramManager.vectorizePending', async () => { if (fail.vectorizePending) boom('vectorizePending'); return { vectorized: 2 }; }),
    },
    hasEmbedder: rec('hasEmbedder', () => true),
    activateSave: rec('activateSave', (tree: Json) => {
      if (fail.activateSave) boom('activateSave');
      sm.loadTree(tree);
    }, true),
    runOpening: rec('runOpening', async () => { if (fail.runOpening) boom('runOpening'); return { success: true }; }),
    ...over,
  };
  return { deps, log, sm };
}

const baseOpts: ImportOptions = { optInGlobals: new Set(), enableNsfw: false } as ImportOptions;
const allOptIns = new Set([
  'configOverlays', 'promptOverrides', 'builtinPromptOverrides', 'settings', 'authorGameplaySettings',
]) as never;

let mockLs: ReturnType<typeof createMockLocalStorage>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockLs = createMockLocalStorage();
  mockLs.install();
});
afterEach(() => {
  mockLs.restore();
  vi.useRealTimers();
});

async function snapDoc(id: string, doc: unknown): Promise<void> {
  await expect(serialize(doc)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}

/** One import run: the result, the ordered call log and the localStorage change. */
async function runImport(
  bundle: Json,
  options: Partial<ImportOptions>,
  fail: Failures = {},
  seedLs: Record<string, string> = {},
  over: Partial<ImportServiceDeps> = {},
) {
  for (const [k, v] of Object.entries(seedLs)) localStorage.setItem(k, v);
  const { deps, log } = makeRecordingDeps(fail, over);
  const svc = new GameCardImportService(() => mockPack, deps);
  const before = dumpLocalStorage(localStorage);
  const result = await svc.importCard(await makeCardBlob(bundle), { ...baseOpts, ...options } as ImportOptions);
  const after = dumpLocalStorage(localStorage);
  return { svc, deps, result, log, lsDiff: diffLocalStorage(before, after) };
}

describe('GameCardImportService Stage 2 lock', () => {
  it('S1 every payload and every opt-in', async () => {
    const { result, log, lsDiff } = await runImport(fullBundle(), {
      optInGlobals: allOptIns, enableNsfw: true,
      onOpeningProgress: () => {}, protagonistEdits: { '基础信息.姓名': '忽略(固定主角)' },
    }, {}, { aga_user_settings: '{"theme":"light"}', aga_cot_settings: '{"enabled":false}' });
    await snapDoc('S1-all-opt-ins', { result, log, lsDiff });
    expect(result.ok).toBe(true);
  });

  it('S2 template protagonist edits (allowed / undeclared / blacklisted / prototype pollution)', async () => {
    const bundle = validBundle({ protagonist: { mode: 'template', data: {}, editableFields: ['基础信息.姓名', '属性.法力'] } });
    const { result, log, lsDiff } = await runImport(bundle, {
      protagonistEdits: {
        '基础信息.姓名': '玩家改名',
        '属性.体质': 999,
        '属性.法力': 11,
        '基础信息.头像': 'img_other',
        '__proto__.polluted': 'yes',
      },
    });
    await snapDoc('S2-template-edits', { result, log, lsDiff, polluted: ({} as Json).polluted ?? null });
    expect(({} as Json).polluted).toBeUndefined();
  });

  it('S3 degraded paths (no embedder / embedding failure / opening failure / no opening)', async () => {
    const a = await runImport(validBundle(), {}, { runOpening: true }, {}, { hasEmbedder: () => false });
    const b = await runImport(validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_b', packVersion: '' } }), {}, { vectorizePending: true });
    const c = await runImport(validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_c' } }), {}, {}, {}, { runOpening: undefined });
    await snapDoc('S3-degraded', {
      noEmbedderOpeningFails: { result: a.result, log: a.log },
      embeddingFails: { result: b.result, log: b.log },
      noOpeningCallback: { result: c.result, log: c.log },
    });
    expect(a.result.ok && a.result.retrievalDegraded && a.result.openingDegraded).toBe(true);
  });

  it('S4 rollback after the profile exists (saveGame fails; also deleteGame failing)', async () => {
    const seed = { aga_user_settings: '{"theme":"light"}', aga_nsfw_settings: '{"nsfwMode":false}' };
    const a = await runImport(fullBundle(), { optInGlobals: allOptIns, enableNsfw: true }, { saveGame: true }, seed);
    const b = await runImport(
      validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_d' } }),
      {}, { saveGame: true, deleteGame: true },
    );
    await snapDoc('S4-rollback-after-profile', {
      saveGameFails: { result: a.result, log: a.log, lsDiff: a.lsDiff },
      saveGameAndDeleteGameFail: { result: b.result, log: b.log },
    });
    expect(a.result.ok).toBe(false);
  });

  it('S5 failures before the profile exists (activate / world books / profile creation / global restore failing)', async () => {
    const seed = { aga_user_settings: '{"theme":"light"}' };
    const act = await runImport(fullBundle(), { optInGlobals: allOptIns, enableNsfw: true }, { activateSave: true }, seed);
    const wb = await runImport(
      validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_e' }, worldBooks: (fullBundle() as Json).worldBooks }),
      { optInGlobals: allOptIns }, { importWorldBooks: true },
    );
    const prof = await runImport(
      validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_f' } }),
      { optInGlobals: allOptIns }, { createProfile: true },
    );
    const restore = await runImport(
      validBundle({ cardMeta: { ...(validBundle().cardMeta as Json), cardId: 'card_g' }, configOverlays: (fullBundle() as Json).configOverlays }),
      { optInGlobals: new Set(['configOverlays']) as never }, { saveGame: true, configReplaceAll: true },
    );
    await snapDoc('S5-failures-before-profile', {
      activateFails: { result: act.result, log: act.log, lsDiff: act.lsDiff },
      worldBooksFail: { result: wb.result, log: wb.log },
      createProfileFails: { result: prof.result, log: prof.log },
      globalRestoreFails: { result: restore.result, log: restore.log },
    });
    expect(act.result.ok).toBe(false);
  });

  it('S6 undo handle, import ledger and the not-wired failure', async () => {
    const seed = { aga_user_settings: '{"theme":"light"}' };
    const first = await runImport(fullBundle(), { optInGlobals: allOptIns, enableNsfw: true }, {}, seed);
    const lsAfterImport = dumpLocalStorage(localStorage);
    const undo1 = await first.svc.undoGlobalChanges();
    const lsAfterUndo = dumpLocalStorage(localStorage);
    const undo2 = await first.svc.undoGlobalChanges();
    const undoLog = first.log.slice();
    // same card again: the ledger must not duplicate
    const again = await runImport(fullBundle(), {}, {});
    // a service without deps
    const bare = new GameCardImportService(() => mockPack);
    const bareResult = await bare.importCard(await makeCardBlob(validBundle()), baseOpts);
    await snapDoc('S6-undo-ledger-unwired', {
      undo: { undo1, undo2, lsAfterImport, lsAfterUndo, log: undoLog },
      again: { result: again.result, ledger: localStorage.getItem('aga_imported_card_ids') },
      unwired: bareResult,
    });
    expect(undo1).toBe(true);
  });
});
