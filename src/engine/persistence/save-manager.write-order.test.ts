import 'fake-indexeddb/auto';
/**
 * The first write of an upgraded save waits while the old record is copied aside (存档瘦身 P1 §2.1). A save or a delete
 * of the slot asked for meanwhile goes after it: a later write never lands under an earlier one (B2 review, round 2).
 * Runs on the real IndexedDB adapter (fake-indexeddb); the copy's read of the old record is held open, so the order
 * is the test's own, not the timers'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idbAdapter } from './idb-adapter';
import { formatBackupKey, SaveManager, saveKey } from './save-manager';
import type { GameStateTree, SaveSlotMeta } from '../types';
import type { ProfileManager } from './profile-manager';

const KEY = saveKey('p', 's');
const BACKUP = formatBackupKey('p', 's');

/** A save as the code before the upgrade wrote it: an old whole snapshot inside the tree. */
function legacy(round: number): GameStateTree {
  return {
    元数据: { 回合序号: round, 叙事历史: [], 上次对话前快照: { 元数据: { 回合序号: round - 1, 叙事历史: [] } } },
    系统: { 扩展: {} },
  };
}

const withRound = (tree: GameStateTree, round: number): GameStateTree => ({ ...tree, 元数据: { ...(tree.元数据 as object), 回合序号: round } });
const roundOf = (tree: unknown): unknown => ((tree as GameStateTree | undefined)?.元数据 as { 回合序号?: number } | undefined)?.回合序号;

function profileStub(): ProfileManager {
  const meta: Record<string, SaveSlotMeta> = {};
  return {
    updateSlotMeta: async (_p: string, s: string, update: Partial<SaveSlotMeta>) => { meta[s] = { ...meta[s], ...update } as SaveSlotMeta; },
    getSlotMeta: (_p: string, s: string) => meta[s],
  } as unknown as ProfileManager;
}

/** Holds the next read of the save record (the copy's read of the old record) until released. */
function holdTheCopy(): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = idbAdapter.get.bind(idbAdapter);
  let held = false;
  vi.spyOn(idbAdapter, 'get').mockImplementation(async <T>(key: string): Promise<T | undefined> => {
    if (key === KEY && !held) { held = true; await gate; }
    return read<T>(key);
  });
  return release;
}

async function upgradedInMemory(): Promise<{ manager: SaveManager; tree: GameStateTree }> {
  await idbAdapter.set(KEY, legacy(4));
  const manager = new SaveManager(profileStub());
  return { manager, tree: (await manager.loadGame('p', 's'))! };
}

describe('SaveManager · the order of a slot\'s writes while the old record is copied aside', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await idbAdapter.delete(KEY);
    await idbAdapter.delete(BACKUP);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a save asked for while the first write copies the old record lands after it', async () => {
    const { manager, tree } = await upgradedInMemory();
    const release = holdTheCopy();
    const first = manager.saveGame('p', 's', withRound(tree, 5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = manager.saveGame('p', 's', withRound(tree, 6));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    expect(roundOf(await idbAdapter.get(KEY))).toBe(6);
    expect(await idbAdapter.get(BACKUP)).toEqual(legacy(4));
  });

  it('two saves asked for at once: the old record is copied, and the later save wins', async () => {
    const { manager, tree } = await upgradedInMemory();
    await Promise.all([manager.saveGame('p', 's', withRound(tree, 5)), manager.saveGame('p', 's', withRound(tree, 6))]);
    expect(roundOf(await idbAdapter.get(KEY))).toBe(6);
    expect(await idbAdapter.get(BACKUP)).toEqual(legacy(4));
  });

  it('a delete asked for while the first write copies the old record is not undone by it', async () => {
    const { manager, tree } = await upgradedInMemory();
    const release = holdTheCopy();
    const save = manager.saveGame('p', 's', withRound(tree, 5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const remove = manager.deleteGame('p', 's');
    release();
    await Promise.all([save, remove]);
    expect(await idbAdapter.get(KEY)).toBeUndefined();
    expect(await idbAdapter.get(BACKUP)).toBeUndefined();
  });

  it('a save asked for while the queue drains still writes what it was handed at the call', async () => {
    const { manager, tree } = await upgradedInMemory();
    const release = holdTheCopy();
    const first = manager.saveGame('p', 's', withRound(tree, 5));
    const later = withRound(tree, 6);
    const second = manager.saveGame('p', 's', later);
    (later.元数据 as Record<string, unknown>).回合序号 = 99;
    release();
    await Promise.all([first, second]);
    expect(roundOf(await idbAdapter.get(KEY))).toBe(6);
  });
});
