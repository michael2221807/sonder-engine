/**
 * SaveManager × save format 2 (存档瘦身 P1 §2.1): the upgrade on read never writes; the first write of an upgraded tree
 * copies the old record aside (a failed copy never stops the save); the copy goes once a later session has read the
 * new format back and a round has been played past the upgrade; a failed upgrade loads the save as it was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager } from '../core/state-manager';
import type { GameStateTree, SaveSlotMeta } from '../types';
import type { ProfileManager } from './profile-manager';

const memStore = new Map<string, unknown>();
const writes: string[] = [];
const reads: string[] = [];
const adapterHooks = vi.hoisted(() => ({
  onGet: undefined as ((key: string) => void) | undefined,
  failSet: undefined as ((key: string) => boolean) | undefined,
  failDelete: undefined as ((key: string) => boolean) | undefined,
}));
vi.mock('./idb-adapter', () => ({
  idbAdapter: {
    async get<T>(key: string): Promise<T | undefined> {
      reads.push(key);
      adapterHooks.onGet?.(key);
      return memStore.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (adapterHooks.failSet?.(key)) throw new DOMException('quota', 'QuotaExceededError');
      writes.push(`set ${key}`);
      memStore.set(key, JSON.parse(JSON.stringify(value)));
    },
    async setGuarded(key: string, value: unknown, guard: () => void): Promise<void> {
      guard();
      writes.push(`set ${key}`);
      memStore.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      if (adapterHooks.failDelete?.(key)) throw new Error('delete failed');
      writes.push(`delete ${key}`);
      memStore.delete(key);
    },
  },
}));

const toasts: Array<Record<string, unknown>> = [];
vi.mock('../core/event-bus', () => ({
  eventBus: {
    emit: (event: string, payload?: unknown) => {
      if (event === 'ui:toast') toasts.push(payload as Record<string, unknown>);
    },
  },
}));

const upgradeSpy = vi.hoisted(() => ({ fail: false }));
vi.mock('./save-format/save-format-migration', async (importOriginal) => {
  const original = await importOriginal<typeof import('./save-format/save-format-migration')>();
  return {
    ...original,
    upgradeSaveFormat: (...args: Parameters<typeof original.upgradeSaveFormat>) => {
      if (upgradeSpy.fail) throw new Error('boom');
      return original.upgradeSaveFormat(...args);
    },
  };
});

vi.mock('./migration-registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('./migration-registry')>();
  return { ...original, migrationRegistry: new original.MigrationRegistry() };
});

import { formatBackupKey, SaveManager } from './save-manager';
import { migrationRegistry } from './migration-registry';

const KEY = 'save_p1_s1';
const BACKUP = 'save_p1_s1:pre-format-2';
const FAILED_TOAST = 'engine.toast.saveFormatUpgradeFailed';

/** A save as the code before the upgrade wrote it (old whole snapshot, untrimmed traces, whole-list push records). */
function legacySave(rounds: number, options: { withRound?: boolean } = {}): GameStateTree {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 回合序号: 0, 叙事历史: [] }, 社交: { 事件: { 事件记录: [] } }, 系统: { 扩展: {} } });
  for (let round = 1; round <= rounds; round++) {
    const snapshot = sm.toSnapshot();
    delete (snapshot.元数据 as Record<string, unknown>).上次对话前快照;
    sm.set('元数据.上次对话前快照', snapshot, 'system');
    sm.set('元数据.回合序号', round, 'system');
    const push = sm.push('社交.事件.事件记录', { 事件名称: `事件${round}` }, 'command');
    sm.push('元数据.叙事历史', { role: 'user', content: `输入${round}` }, 'system');
    sm.push('元数据.叙事历史', {
      role: 'assistant', content: `正文${round}`, _delta: [{ ...push, source: 'main' }],
      _engramRead: { candidates: [{ outcome: 'injected' }, { outcome: 'filtered-by-topK' }] },
    }, 'system');
  }
  const tree = JSON.parse(JSON.stringify(sm.toSnapshot())) as GameStateTree;
  if (options.withRound === false) delete (tree.元数据 as Record<string, unknown>).回合序号;
  return tree;
}

const withRound = (tree: GameStateTree, round: number): GameStateTree =>
  ({ ...tree, 元数据: { ...(tree.元数据 as object), 回合序号: round } });

const extensionOf = (tree: unknown): Record<string, unknown> =>
  ((tree as GameStateTree).系统 as { 扩展: Record<string, unknown> }).扩展;

describe('SaveManager · save format 2', () => {
  let pm: ProfileManager;
  let slotMeta: Record<string, SaveSlotMeta>;
  const manager = () => new SaveManager(pm);

  /** A legacy save opened and saved in one session (the old record is copied aside); the next session's manager. */
  async function upgradedInEarlierSession(save: GameStateTree = legacySave(4)): Promise<SaveManager> {
    memStore.set(KEY, save);
    const first = manager();
    await first.saveGame('p1', 's1', (await first.loadGame('p1', 's1')) as GameStateTree);
    expect(memStore.has(BACKUP)).toBe(true);
    writes.length = 0;
    reads.length = 0;
    return manager();
  }

  beforeEach(() => {
    memStore.clear();
    writes.length = 0;
    reads.length = 0;
    toasts.length = 0;
    upgradeSpy.fail = false;
    adapterHooks.onGet = undefined;
    adapterHooks.failSet = undefined;
    adapterHooks.failDelete = undefined;
    migrationRegistry.clear();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    slotMeta = {};
    pm = {
      updateSlotMeta: vi.fn(async (_p: string, s: string, update: Partial<SaveSlotMeta>) => {
        slotMeta[s] = { ...slotMeta[s], ...update } as SaveSlotMeta;
      }),
      getSlotMeta: vi.fn((_p: string, s: string) => slotMeta[s]),
    } as unknown as ProfileManager;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('upgrades an old save in memory on every read and writes nothing (export and cloud upload read this way)', async () => {
    const stored = legacySave(4);
    memStore.set(KEY, stored);
    const sm = manager();
    const first = await sm.loadGame('p1', 's1');
    const second = await sm.loadGame('p1', 's1');
    expect(writes).toEqual([]);
    expect(memStore.get(KEY)).toBe(stored);
    expect(pm.updateSlotMeta).not.toHaveBeenCalled();
    for (const tree of [first, second]) {
      expect((tree?.元数据 as Record<string, unknown>).上次对话前快照).toBeUndefined();
      expect(extensionOf(tree).rollbackPatch).toBeDefined();
      expect(extensionOf(tree).saveFormat).toEqual({ version: 2, migratedAtRound: 4 });
    }
    expect(toasts).toEqual([]);
  });

  it('returns a save already in format 2 by reference, writing nothing', async () => {
    const later = await upgradedInEarlierSession();
    const stored = memStore.get(KEY);
    expect(await later.loadGame('p1', 's1')).toBe(stored);
    expect(writes).toEqual([]);
  });

  it('says so in the log when a tree already in format 2 needs upgrading again (old data written into it)', async () => {
    const later = await upgradedInEarlierSession();
    // An older tab, still open across the update, pushes a whole-list record into the new-format tree.
    const stored = memStore.get(KEY) as GameStateTree;
    const history = (stored.元数据 as { 叙事历史: Array<Record<string, unknown>> }).叙事历史;
    history.push({ role: 'user', content: '旧标签页' }, {
      role: 'assistant', content: '旧标签页的回复',
      _delta: [{ path: '社交.事件.事件记录', action: 'push', oldValue: [], newValue: [{ 事件名称: '旧' }], timestamp: 9, source: 'main' }],
    });
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    const tree = await later.loadGame('p1', 's1');

    expect(tree).not.toBe(stored);
    expect(warn).toHaveBeenCalledWith('[SaveManager] save_p1_s1 is in save format 2 yet needed upgrading again');
    // The tree it gave back needs nothing more: read again, it logs nothing.
    warn.mockClear();
    memStore.set(KEY, tree);
    expect(await manager().loadGame('p1', 's1')).toBe(tree);
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies the old record aside before the first write of the upgraded tree, and only then', async () => {
    const stored = legacySave(4);
    memStore.set(KEY, stored);
    const sm = manager();
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    await sm.saveGame('p1', 's1', tree);
    expect(writes).toEqual([`set ${BACKUP}`, `set ${KEY}`]);
    expect(memStore.get(BACKUP)).toEqual(stored);
    expect(extensionOf(memStore.get(KEY)).saveFormat).toEqual({ version: 2, migratedAtRound: 4 });
    writes.length = 0;
    await sm.saveGame('p1', 's1', withRound(tree, 9));
    expect(writes).toEqual([`set ${KEY}`]);
  });

  it('writes the tree as it was handed over, even when it changes while the old record is being copied', async () => {
    for (const commit of [undefined, { guard: () => {}, committed: () => {} }]) {
      memStore.clear();
      memStore.set(KEY, legacySave(4));
      const sm = manager();
      const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
      adapterHooks.onGet = (key) => { if (key === KEY) (tree.元数据 as Record<string, unknown>).改动 = '之后才写的'; };
      await sm.saveGame('p1', 's1', tree, undefined, commit);
      adapterHooks.onGet = undefined;
      expect(tree.元数据).toHaveProperty('改动');
      expect((memStore.get(KEY) as GameStateTree).元数据).not.toHaveProperty('改动');
    }
  });

  it('writes the tree the rollback hook gives, made at the call: before the copy of the old record waits', async () => {
    for (const legacy of [true, false]) {
      memStore.clear();
      memStore.set(KEY, legacy ? legacySave(4) : withRound(legacySave(0), 0));
      const sm = manager();
      sm.setTreeToSave((tree) => ({ ...tree, hooked: (tree.元数据 as Record<string, unknown>).改动 ?? 'at the call' }));
      const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
      adapterHooks.onGet = (key) => { if (key === KEY) (tree.元数据 as Record<string, unknown>).改动 = '之后才写的'; };
      await sm.saveGame('p1', 's1', tree);
      adapterHooks.onGet = undefined;
      const stored = memStore.get(KEY) as Record<string, unknown>;
      expect(stored.hooked).toBe('at the call');
      expect(stored.元数据).not.toHaveProperty('改动');
      expect(tree).not.toHaveProperty('hooked');
    }
  });

  it('takes a stored tree marked with another format version for an old one, and copies it aside', async () => {
    const stored = legacySave(4);
    extensionOf(stored).saveFormat = { version: 1, migratedAtRound: 2 };
    memStore.set(KEY, stored);
    const sm = manager();
    await sm.saveGame('p1', 's1', (await sm.loadGame('p1', 's1')) as GameStateTree);
    expect(memStore.get(BACKUP)).toEqual(stored);
  });

  it('saves on when the copy fails (storage full), says so in the log, and does not try the copy again', async () => {
    memStore.set(KEY, legacySave(4));
    const sm = manager();
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    adapterHooks.failSet = (key) => key === BACKUP;
    const committed = vi.fn();
    await sm.saveGame('p1', 's1', tree, undefined, { guard: () => {}, committed });
    expect(committed).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([`set ${KEY}`]);
    expect(extensionOf(memStore.get(KEY)).saveFormat).toEqual({ version: 2, migratedAtRound: 4 });
    expect(console.warn).toHaveBeenCalled();
    reads.length = 0;
    await sm.saveGame('p1', 's1', tree);
    expect(reads).toEqual([]);
    expect(writes).toEqual([`set ${KEY}`, `set ${KEY}`]);
  });

  it('saves on when reading the old record for the copy fails', async () => {
    memStore.set(KEY, legacySave(4));
    const sm = manager();
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    adapterHooks.onGet = () => { throw new DOMException('gone', 'UnknownError'); };
    await sm.saveGame('p1', 's1', tree);
    expect(writes).toEqual([`set ${KEY}`]);
  });

  it('keeps the copy for the rest of the session it was made in: rounds played, or the slot read again', async () => {
    memStore.set(KEY, legacySave(4));
    const sm = manager();
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    await sm.saveGame('p1', 's1', tree);
    await sm.saveGame('p1', 's1', withRound(tree, 5));
    // An export or cloud upload in the same session reads back what this session wrote: that proves nothing yet.
    await sm.loadGame('p1', 's1');
    await sm.saveGame('p1', 's1', withRound(tree, 6));
    expect(memStore.has(BACKUP)).toBe(true);
    expect(writes.filter((w) => w.startsWith('delete'))).toEqual([]);
  });

  it('drops the copy once a later session has read the new format back and a round is played past the upgrade', async () => {
    const later = await upgradedInEarlierSession();
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    await later.saveGame('p1', 's1', reread);
    expect(writes).toEqual([`set ${KEY}`]);
    await later.saveGame('p1', 's1', withRound(reread, 5));
    expect(writes).toEqual([`set ${KEY}`, `set ${KEY}`, `delete ${BACKUP}`]);
    expect(memStore.has(BACKUP)).toBe(false);
    writes.length = 0;
    await later.saveGame('p1', 's1', withRound(reread, 6));
    expect(writes).toEqual([`set ${KEY}`]);
  });

  it('keeps the copy when the tree written has no round number although the upgrade recorded one', async () => {
    const later = await upgradedInEarlierSession();
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    const roundless = { ...reread, 元数据: { ...(reread.元数据 as Record<string, unknown>) } } as GameStateTree;
    delete (roundless.元数据 as Record<string, unknown>).回合序号;
    await later.saveGame('p1', 's1', roundless);
    expect(memStore.has(BACKUP)).toBe(true);
  });

  it('decides on the tree as it was handed over: a marker taken out of it while the write runs changes nothing', async () => {
    const later = await upgradedInEarlierSession();
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    const saving = later.saveGame('p1', 's1', withRound(reread, 5));
    delete extensionOf(reread).saveFormat;
    await saving;
    expect(memStore.has(BACKUP)).toBe(false);
  });

  it('drops nothing on the strength of a written tree that is not in the new format', async () => {
    const later = await upgradedInEarlierSession();
    await later.loadGame('p1', 's1');
    // Another game written into the slot (no marker), at a round far past the upgrade.
    await later.saveGame('p1', 's1', withRound(legacySave(2), 9));
    expect(writes).toEqual([`set ${KEY}`]);
    expect(memStore.has(BACKUP)).toBe(true);
  });

  it('forgets on delete that the slot was read back: a save written there afterwards proves nothing', async () => {
    const later = await upgradedInEarlierSession();
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    await later.deleteGame('p1', 's1');
    writes.length = 0;
    await later.saveGame('p1', 's1', withRound(reread, 9));
    expect(writes).toEqual([`set ${KEY}`]);
  });

  it('keeps the copy in a later session that has not read the slot back', async () => {
    const later = await upgradedInEarlierSession();
    const tree = memStore.get(KEY) as GameStateTree;
    await later.saveGame('p1', 's1', withRound(tree, 7));
    expect(memStore.has(BACKUP)).toBe(true);
  });

  it('drops the copy of a save without a round number once a later session has read it back', async () => {
    const later = await upgradedInEarlierSession(legacySave(4, { withRound: false }));
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    expect(extensionOf(reread).saveFormat).toEqual({ version: 2, migratedAtRound: null });
    await later.saveGame('p1', 's1', reread);
    expect(memStore.has(BACKUP)).toBe(false);
  });

  it('tries dropping the copy again on the next save when the delete fails', async () => {
    const later = await upgradedInEarlierSession();
    const reread = (await later.loadGame('p1', 's1')) as GameStateTree;
    adapterHooks.failDelete = (key) => key === BACKUP;
    await later.saveGame('p1', 's1', withRound(reread, 5));
    expect(memStore.has(BACKUP)).toBe(true);
    expect(console.warn).toHaveBeenCalled();
    adapterHooks.failDelete = undefined;
    await later.saveGame('p1', 's1', withRound(reread, 6));
    expect(memStore.has(BACKUP)).toBe(false);
  });

  it('loads the save as it was when the upgrade fails, says so once, and writes nothing', async () => {
    const stored = legacySave(4);
    memStore.set(KEY, stored);
    upgradeSpy.fail = true;
    const sm = manager();
    expect(await sm.loadGame('p1', 's1')).toBe(stored);
    expect(await sm.loadGame('p1', 's1')).toBe(stored);
    expect(writes).toEqual([]);
    expect(toasts.filter((t) => t.i18nKey === FAILED_TOAST)).toHaveLength(1);
    await sm.saveGame('p1', 's1', stored);
    expect(writes).toEqual([`set ${KEY}`]);
  });

  it('loads the save as it was when a field on the way to a new path holds something else', async () => {
    const stored = { ...legacySave(4), 系统: '损坏' } as GameStateTree;
    memStore.set(KEY, stored);
    expect(await manager().loadGame('p1', 's1')).toBe(stored);
    expect(toasts.map((t) => t.i18nKey)).toEqual([FAILED_TOAST]);
    expect(writes).toEqual([]);
  });

  it('explains an upgrade that held the page for more than a second, once it is done; a quick one says nothing', async () => {
    memStore.set(KEY, legacySave(4));
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_500));
    await manager().loadGame('p1', 's1');
    expect(toasts.map((t) => [t.i18nKey, t.type])).toEqual([['engine.toast.saveFormatUpgradedSlow', 'info']]);
    toasts.length = 0;
    now.mockImplementation(() => (clock += 10));
    await manager().loadGame('p1', 's1');
    expect(toasts).toEqual([]);
  });

  it('deletes the copy with its save, and forgets the slot: a new save there starts over', async () => {
    const sm = manager();
    memStore.set(KEY, legacySave(4));
    await sm.loadGame('p1', 's1');
    await sm.deleteGame('p1', 's1');
    expect(memStore.has(KEY)).toBe(false);
    expect(formatBackupKey('p1', 's1')).toBe(BACKUP);
    // The upgrade loaded before the delete is not copied aside when a new game is saved in the slot.
    reads.length = 0;
    writes.length = 0;
    await sm.saveGame('p1', 's1', legacySave(2));
    expect(reads).toEqual([]);
    expect(writes).toEqual([`set ${KEY}`]);

    await sm.saveGame('p1', 's1', (await sm.loadGame('p1', 's1')) as GameStateTree);
    expect(memStore.has(BACKUP)).toBe(true);
    await sm.deleteGame('p1', 's1');
    expect(memStore.has(BACKUP)).toBe(false);
    expect(writes.slice(-2)).toEqual([`delete ${KEY}`, `delete ${BACKUP}`]);
  });

  it('reports an upgrade failure again for a new save in a deleted slot', async () => {
    const sm = manager();
    upgradeSpy.fail = true;
    memStore.set(KEY, legacySave(4));
    await sm.loadGame('p1', 's1');
    await sm.deleteGame('p1', 's1');
    memStore.set(KEY, legacySave(3));
    await sm.loadGame('p1', 's1');
    expect(toasts.filter((t) => t.i18nKey === FAILED_TOAST)).toHaveLength(2);
  });

  it('takes no copy when the stored record is no longer the old format by the first write', async () => {
    memStore.set(KEY, legacySave(4));
    const sm = manager();
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    memStore.set(KEY, tree);
    writes.length = 0;
    await sm.saveGame('p1', 's1', tree);
    expect(writes).toEqual([`set ${KEY}`]);
    expect(memStore.has(BACKUP)).toBe(false);
  });

  it('keeps the stored old record as the pack migration backup, and needs no format copy after that write', async () => {
    const stored = legacySave(4);
    migrationRegistry.register({ fromVersion: '0', toVersion: '0.5.0', description: 'mark', migrate: (data) => ({ ...data, migrated: true }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sm = manager();
    sm.setCurrentPackVersion('0.5.0');
    slotMeta['s1'] = { packVersion: '0' } as SaveSlotMeta;
    memStore.set(KEY, stored);
    const tree = (await sm.loadGame('p1', 's1')) as GameStateTree;
    expect(memStore.get(`${KEY}:pre-migration`)).toEqual(stored);
    expect((memStore.get(KEY) as Record<string, unknown>).migrated).toBe(true);
    expect(extensionOf(memStore.get(KEY)).saveFormat).toEqual({ version: 2, migratedAtRound: 4 });
    writes.length = 0;
    reads.length = 0;
    await sm.saveGame('p1', 's1', tree);
    expect(writes).toEqual([`set ${KEY}`]);
    // The pack migration already wrote the upgraded tree: no need to read the stored record again to decide.
    expect(reads).toEqual([]);
  });
});
