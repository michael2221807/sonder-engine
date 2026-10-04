/**
 * GameCardImportService Stage 2 (assembleAndPersist) 单元测试 — Story 6 P5
 *
 * 用 mock deps 覆盖 OD-N 写序 / OD-I packVersion / SC-6 fixed 主角不回填默认 / SC-7 template
 * 编辑放行 / NSFW 门控前置 / 无 embedder 降级 / SC-13 回滚 / 全局 opt-in 门控 / 开场可选+非阻断。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get as _get, set as _set } from 'lodash-es';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import { gzipCompress, sha256String } from '../sync/chunked-bundle-packer';
import { CARD_FORMAT_VERSION } from './game-card-bundle.types';
import { GameCardImportService, type ImportServiceDeps } from './game-card-import-service';
import type { GamePack } from '../types/game-pack';

const mockPack = {
  manifest: { id: 'tianming', version: '1.0.0' },
  stateSchema: {
    properties: {
      角色: {
        type: 'object',
        properties: {
          基础信息: { type: 'object', properties: { 姓名: { type: 'string', default: '' } } },
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

function validBundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundleType: 'card',
    version: 1,
    exportedAt: '2026-06-03T00:00:00.000Z',
    engineVersion: '0.1.0',
    cardMeta: {
      formatVersion: 1,
      cardId: 'card_xyz',
      title: '测试卡',
      description: '',
      author: 't',
      tags: [],
      createdAt: 'x',
      updatedAt: 'x',
      packId: 'tianming',
      packVersion: '1.0.0',
    },
    protagonist: { mode: 'fixed', data: {} },
    // card sets 体质=7 (non-default) + 姓名; 法力 absent → schema default 5 must survive (SC-6)
    stateTree: { 角色: { 基础信息: { 姓名: '卡角色' }, 属性: { 体质: 7 } } },
    engram: { entities: [], knowledgeEdges: [] },
    ...over,
  };
}

async function makeCardBlob(bundle: Record<string, unknown>): Promise<Blob> {
  const checksum = await sha256String(JSON.stringify(bundle));
  return gzipCompress(JSON.stringify({ format: 'aga-card', formatVersion: CARD_FORMAT_VERSION, checksum, bundle }));
}

/** Minimal in-memory StateManager used by Stage 2. */
function makeStateManager() {
  let tree: Record<string, unknown> = {};
  return {
    get: <T>(path: string): T | undefined => _get(tree, path) as T | undefined,
    set: (path: string, val: unknown) => { _set(tree, path, val); },
    loadTree: (t: Record<string, unknown>) => { tree = t; },
    toSnapshot: () => structuredClone(tree),
    _tree: () => tree,
  };
}

function makeDeps(over: Partial<ImportServiceDeps> = {}) {
  const sm = makeStateManager();
  const spies = {
    saveGame: vi.fn(async () => {}),
    deleteGame: vi.fn(async () => {}),
    createProfile: vi.fn(async () => {}),
    deleteProfile: vi.fn(async () => {}),
    setActiveProfile: vi.fn(async () => {}),
    importEntries: vi.fn(async () => {}),
    vectorizePending: vi.fn(async () => ({ vectorized: 0 })),
    appendPreservingIds: vi.fn(async () => []),
    importWorldBooks: vi.fn(async () => 0),
    configImportAll: vi.fn(async () => {}),
    promptImportAll: vi.fn(async () => {}),
    // global-backup capture/restore primitives (方案A)
    configExportAll: vi.fn(async () => [] as unknown[]),
    configClear: vi.fn(async () => {}),
    configReplaceAll: vi.fn(async () => {}),
    promptExportAll: vi.fn(async () => [] as unknown[]),
    promptClear: vi.fn(async () => {}),
    promptReplaceAll: vi.fn(async () => {}),
    clearBuiltinOverrides: vi.fn(async () => {}),
    replaceBuiltinOverrides: vi.fn(async () => {}),
    activateSave: vi.fn((t: Record<string, unknown>) => sm.loadTree(t)),
    runOpening: vi.fn(async () => ({ success: true })),
  };
  const deps: ImportServiceDeps = {
    stateManager: sm as never,
    saveManager: { saveGame: spies.saveGame, deleteGame: spies.deleteGame } as never,
    profileManager: {
      createProfile: spies.createProfile,
      deleteProfile: spies.deleteProfile,
      setActiveProfile: spies.setActiveProfile,
    } as never,
    imageAssetCache: { importEntries: spies.importEntries } as never,
    customPresetStore: { appendPreservingIds: spies.appendPreservingIds } as never,
    worldBookStorage: {
      importWorldBooks: spies.importWorldBooks,
      clearBuiltinOverrides: spies.clearBuiltinOverrides,
      replaceBuiltinOverrides: spies.replaceBuiltinOverrides,
    } as never,
    configStore: { importAll: spies.configImportAll, exportAll: spies.configExportAll, clear: spies.configClear, replaceAll: spies.configReplaceAll } as never,
    promptStorage: { importAll: spies.promptImportAll, exportAll: spies.promptExportAll, clear: spies.promptClear, replaceAll: spies.promptReplaceAll } as never,
    engramManager: { vectorizePending: spies.vectorizePending } as never,
    hasEmbedder: () => true,
    activateSave: spies.activateSave,
    runOpening: spies.runOpening,
    ...over,
  };
  return { deps, sm, spies };
}

const baseOpts = { optInGlobals: new Set<never>(), enableNsfw: false };

let mockLs: ReturnType<typeof createMockLocalStorage>;
beforeEach(() => { mockLs = createMockLocalStorage(); mockLs.install(); });
afterEach(() => mockLs.restore());

// ─── happy path + 写序 (OD-N) ────────────────────────────────────

describe('assembleAndPersist — happy path + OD-N 写序', () => {
  it('有效 fixed 卡 → ok，返回新存档坐标', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.profileId).toMatch(/^profile_/);
    expect(res.slotId).toBe('auto');
    expect(res.cardTitle).toBe('测试卡');
  });

  it('OD-N：createProfile/saveGame 在 activate + vectorize + opening 之后（profile 最后建）', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0];
    expect(order(spies.activateSave)).toBeLessThan(order(spies.createProfile));
    expect(order(spies.vectorizePending)).toBeLessThan(order(spies.createProfile));
    expect(order(spies.runOpening)).toBeLessThan(order(spies.createProfile));
    expect(order(spies.createProfile)).toBeLessThan(order(spies.saveGame));
    expect(spies.setActiveProfile).toHaveBeenCalled();
  });
});

// ─── OD-I packVersion ────────────────────────────────────────────

describe('assembleAndPersist — OD-I packVersion 盖卡版本', () => {
  it('saveGame 戳卡的 packVersion', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle({ cardMeta: { ...(validBundle().cardMeta as object), packVersion: '0.9.0' } })), baseOpts);
    expect(spies.saveGame).toHaveBeenCalledWith('auto'.length ? expect.any(String) : '', 'auto', expect.anything(), expect.objectContaining({ packVersion: '0.9.0' }));
  });

  it('卡 packVersion 缺失 → 戳 "0"（触发 on-load 迁移）', async () => {
    const { deps, spies } = makeDeps();
    const meta = { ...(validBundle().cardMeta as Record<string, unknown>) };
    delete meta.packVersion;
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle({ cardMeta: meta })), baseOpts);
    expect(spies.saveGame).toHaveBeenCalledWith(expect.any(String), 'auto', expect.anything(), expect.objectContaining({ packVersion: '0' }));
  });
});

// ─── SC-6 fixed 主角不回填默认 ───────────────────────────────────

describe('assembleAndPersist — SC-6 fixed 主角', () => {
  it('卡的 角色.属性 权威（体质=7 胜出），缺失叶子用 schema 默认补齐（法力=5），非全默认5', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    const snapshot = (spies.saveGame.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(_get(snapshot, '角色.属性.体质')).toBe(7); // 卡值胜出（不被默认5覆盖）
    expect(_get(snapshot, '角色.属性.法力')).toBe(5); // schema 默认在场（叶子不缺）
    expect(_get(snapshot, '角色.基础信息.姓名')).toBe('卡角色');
  });
});

// ─── SC-7 template 编辑放行 ──────────────────────────────────────

describe('assembleAndPersist — SC-7 template 编辑', () => {
  it('放行白名单编辑、忽略黑名单编辑', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({
      protagonist: { mode: 'template', data: {}, editableFields: ['基础信息.姓名'] },
    });
    await svc.importCard(await makeCardBlob(bundle), {
      ...baseOpts,
      protagonistEdits: {
        '基础信息.姓名': '玩家改名', // 白名单 → 应用
        '属性.体质': 999,           // 黑名单 → 忽略
      },
    });
    const snapshot = (spies.saveGame.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(_get(snapshot, '角色.基础信息.姓名')).toBe('玩家改名'); // 应用
    expect(_get(snapshot, '角色.属性.体质')).toBe(7);            // 黑名单编辑被忽略，保留卡值
  });
});

// ─── NSFW 门控 (P0-2) ────────────────────────────────────────────

describe('assembleAndPersist — NSFW 门控', () => {
  it('enableNsfw → 激活前写 localStorage aga_nsfw_settings(nsfwMode:true)', async () => {
    const { deps, spies } = makeDeps();
    // 捕获 activate 时 localStorage 的状态（门控必须在激活前已写）
    let nsfwAtActivate: string | null = null;
    spies.activateSave.mockImplementation((t: Record<string, unknown>) => {
      nsfwAtActivate = localStorage.getItem('aga_nsfw_settings');
      deps.stateManager.loadTree(t);
    });
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), { ...baseOpts, enableNsfw: true });
    expect(nsfwAtActivate).not.toBeNull();
    expect(JSON.parse(nsfwAtActivate!).nsfwMode).toBe(true);
  });

  it('enableNsfw=false → 不写 aga_nsfw_settings', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), { ...baseOpts, enableNsfw: false });
    expect(localStorage.getItem('aga_nsfw_settings')).toBeNull();
  });
});

// ─── 无 embedder 降级 ────────────────────────────────────────────

describe('assembleAndPersist — 无 embedder 降级', () => {
  it('hasEmbedder=false → 不调 vectorizePending + retrievalDegraded=true', async () => {
    const { deps, spies } = makeDeps({ hasEmbedder: () => false });
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(spies.vectorizePending).not.toHaveBeenCalled();
    expect(res.ok && res.retrievalDegraded).toBe(true);
  });

  it('hasEmbedder=true → 调 vectorizePending + retrievalDegraded=false', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(spies.vectorizePending).toHaveBeenCalledTimes(1);
    expect(res.ok && res.retrievalDegraded).toBe(false);
  });
});

describe('assembleAndPersist — 开场降级（opening non-fatal）', () => {
  it('runOpening 抛错 → openingDegraded=true，导入仍成功（存档已建）', async () => {
    const { deps, spies } = makeDeps({ runOpening: vi.fn(async () => { throw new Error('未配置可用的 API'); }) });
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok).toBe(true);
    expect(res.ok && res.openingDegraded).toBe(true);
    expect(spies.saveGame).toHaveBeenCalled(); // 非致命：存档照常持久化
  });

  it('runOpening 成功 → openingDegraded=false', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok && res.openingDegraded).toBe(false);
  });

  // ─── D7: opening-style hint flows from bundle.opening to runOpening ───
  it('bundle.opening.firstRoundSetup 透传给 runOpening（D7）', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ opening: { firstRoundSetup: '以第一人称、悬疑基调展开' } });
    await svc.importCard(await makeCardBlob(bundle), baseOpts);
    expect(spies.runOpening).toHaveBeenCalledWith(
      expect.objectContaining({ firstRoundSetup: '以第一人称、悬疑基调展开' }),
    );
  });

  it('无 opening 字段时 runOpening 收到 firstRoundSetup=undefined（D7）', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(spies.runOpening).toHaveBeenCalledWith(
      expect.objectContaining({ firstRoundSetup: undefined }),
    );
  });
});

// ─── SC-13 回滚 ──────────────────────────────────────────────────

describe('assembleAndPersist — SC-13 回滚', () => {
  it('saveGame 失败（profile 已建）→ deleteGame + deleteProfile 回滚 + write-failed', async () => {
    const { deps, spies } = makeDeps();
    spies.saveGame.mockRejectedValueOnce(new Error('disk full'));
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res).toMatchObject({ ok: false, code: 'write-failed' });
    expect(spies.deleteGame).toHaveBeenCalled();
    expect(spies.deleteProfile).toHaveBeenCalled();
  });

  it('createProfile 之前失败（activate 抛）→ 不调 deleteProfile + write-failed', async () => {
    const { deps, spies } = makeDeps();
    spies.activateSave.mockImplementationOnce(() => { throw new Error('activate boom'); });
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res).toMatchObject({ ok: false, code: 'write-failed' });
    expect(spies.createProfile).not.toHaveBeenCalled();
    expect(spies.deleteProfile).not.toHaveBeenCalled();
  });
});

// ─── 全局 opt-in 门控 ────────────────────────────────────────────

describe('assembleAndPersist — 全局 opt-in 门控', () => {
  it('未勾选 configOverlays → 不调 configStore.importAll', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle({ configOverlays: [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }] })), baseOpts);
    expect(spies.configImportAll).not.toHaveBeenCalled();
  });

  it('勾选 configOverlays → 调 configStore.importAll', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(
      await makeCardBlob(validBundle({ configOverlays: [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }] })),
      { ...baseOpts, optInGlobals: new Set(['configOverlays']) as never },
    );
    expect(spies.configImportAll).toHaveBeenCalledTimes(1);
  });
});

// ─── 开场可选 + 非阻断 ───────────────────────────────────────────

describe('assembleAndPersist — 开场', () => {
  it('runOpening 缺失 → 仍成功建档', async () => {
    const { deps } = makeDeps({ runOpening: undefined });
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok).toBe(true);
  });

  it('runOpening 抛错 → 非阻断，仍成功建档', async () => {
    const { deps, spies } = makeDeps();
    spies.runOpening.mockRejectedValueOnce(new Error('AI down'));
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok).toBe(true);
    expect(spies.saveGame).toHaveBeenCalled(); // 存档照建
  });
});

// ─── 安全：原型污染防护（engine review） ─────────────────────────

describe('assembleAndPersist — 原型污染防护', () => {
  it('卡 stateTree 含 __proto__ → 合并不污染原型', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const malicious = validBundle({
      stateTree: JSON.parse('{"__proto__":{"polluted":"yes"},"角色":{"属性":{"体质":7}}}'),
    });
    const res = await svc.importCard(await makeCardBlob(malicious), baseOpts);
    expect(res.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // 原型未被污染
  });

  it('template 编辑 __proto__ 路径被忽略，不污染原型', async () => {
    const { deps, spies } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ protagonist: { mode: 'template', data: {}, editableFields: ['基础信息.姓名'] } });
    await svc.importCard(await makeCardBlob(bundle), {
      ...baseOpts,
      protagonistEdits: { '__proto__.polluted': 'yes', '基础信息.姓名': 'ok' },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const snapshot = (spies.saveGame.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(_get(snapshot, '角色.基础信息.姓名')).toBe('ok'); // 合法编辑仍生效
  });
});

// ─── 方案A：全局设置可反悔（快照 + 失败自动还原 + 一键撤销） ──────

describe('assembleAndPersist — 方案A 全局可反悔', () => {
  it('settings opt-in 成功 → globalChangesApplied=true 且已应用', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ settings: { aga_user_settings: '{"theme":"dark"}' } });
    const res = await svc.importCard(await makeCardBlob(bundle), { ...baseOpts, optInGlobals: new Set(['settings']) as never });
    expect(res.ok).toBe(true);
    expect(res.ok && res.globalChangesApplied).toBe(true);
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"dark"}');
  });

  it('无 opt-in + 无 nsfw → globalChangesApplied=false', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok && res.globalChangesApplied).toBe(false);
  });

  it('★导入失败 → 自动还原被覆盖的全局设置（修复"失败不还原"bug）', async () => {
    const { deps, spies } = makeDeps();
    localStorage.setItem('aga_user_settings', '{"theme":"light"}'); // 玩家原值
    spies.saveGame.mockRejectedValueOnce(new Error('disk full'));
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ settings: { aga_user_settings: '{"theme":"dark"}' } });
    const res = await svc.importCard(await makeCardBlob(bundle), { ...baseOpts, optInGlobals: new Set(['settings']) as never });
    expect(res).toMatchObject({ ok: false, code: 'write-failed' });
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"light"}'); // 还原到玩家原值
  });

  it('★成功后 undoGlobalChanges() → 还原全局设置，存档保留', async () => {
    const { deps, spies } = makeDeps();
    localStorage.setItem('aga_user_settings', '{"theme":"light"}');
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ settings: { aga_user_settings: '{"theme":"dark"}' } });
    await svc.importCard(await makeCardBlob(bundle), { ...baseOpts, optInGlobals: new Set(['settings']) as never });
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"dark"}'); // 应用
    const ok = await svc.undoGlobalChanges();
    expect(ok).toBe(true);
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"light"}'); // 撤销→还原
    expect(spies.saveGame).toHaveBeenCalled(); // 新存档仍建（保留）
    expect(await svc.undoGlobalChanges()).toBe(false); // 已撤销，再调无备份
  });

  it('undoGlobalChanges() 无备份时返回 false', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    expect(await svc.undoGlobalChanges()).toBe(false);
  });

  it('configOverlays opt-in 失败 → 快照(exportAll) + 原子还原(replaceAll)', async () => {
    const { deps, spies } = makeDeps();
    spies.saveGame.mockRejectedValueOnce(new Error('boom'));
    const svc = new GameCardImportService(() => mockPack, deps);
    const bundle = validBundle({ configOverlays: [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }] });
    await svc.importCard(await makeCardBlob(bundle), { ...baseOpts, optInGlobals: new Set(['configOverlays']) as never });
    expect(spies.configExportAll).toHaveBeenCalled();   // 导入前快照
    expect(spies.configReplaceAll).toHaveBeenCalled();  // 失败还原: 单事务 replaceAll(snapshot)
  });

  it('nsfw 门控也纳入快照：失败还原 aga_nsfw_settings', async () => {
    const { deps, spies } = makeDeps();
    localStorage.setItem('aga_nsfw_settings', '{"nsfwMode":false}'); // 玩家原值
    spies.saveGame.mockRejectedValueOnce(new Error('boom'));
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), { ...baseOpts, enableNsfw: true });
    expect(res.ok).toBe(false);
    expect(JSON.parse(localStorage.getItem('aga_nsfw_settings')!).nsfwMode).toBe(false); // 还原
  });
});

// ─── OD-L 导入 ledger 写接通（FIX#2 死控件修复） ─────────────────

describe('assembleAndPersist — OD-L 导入 ledger', () => {
  it('★成功导入后 cardId 写入 aga_imported_card_ids（之前是死写、永不调用）', async () => {
    const { deps } = makeDeps();
    const svc = new GameCardImportService(() => mockPack, deps);
    const res = await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(res.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('aga_imported_card_ids')!)).toContain('card_xyz');
  });

  it('导入失败 → 不写 ledger（仅成功路记录）', async () => {
    const { deps, spies } = makeDeps();
    spies.saveGame.mockRejectedValueOnce(new Error('boom'));
    const svc = new GameCardImportService(() => mockPack, deps);
    await svc.importCard(await makeCardBlob(validBundle()), baseOpts);
    expect(localStorage.getItem('aga_imported_card_ids')).toBeNull();
  });
});
