import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { StateManager } from '../../core/state-manager';
import { SAVE_FORMAT_VERSION, upgradeSaveFormat } from './save-format-migration';
import { restoreRollbackSnapshot } from './rollback-patch';
import { traceTrimCut, trimHistoryTraces } from './engram-read-trim';
import { compactHistoryDeltas, isCompactListChange } from './delta-compaction';
import { PathShapeError, readPath, writePath } from './path-copy';
import type { GameStateTree } from '../../types';

const PATHS = {
  narrativeHistory: '元数据.叙事历史',
  preRoundSnapshot: '元数据.上次对话前快照',
  rollbackPatch: '系统.扩展.rollbackPatch',
  roundNumber: '元数据.回合序号',
  saveFormat: '系统.扩展.saveFormat',
};
const trace = (round: number) => ({
  query: `问${round}`,
  candidates: [
    { text: `用上${round}`, outcome: 'injected' },
    { text: `落选${round}`, outcome: 'filtered-by-topK' },
    { text: `重复${round}`, outcome: 'filtered-as-redundant' },
  ],
});

/**
 * A save as the code before the upgrade wrote it, round by round: the round start snapshot set into the tree (without
 * the previous one), the round number increased, an event pushed, the round's entries with their trace and change
 * records. Returned as a save holds it (JSON).
 */
function legacySave(rounds: number): GameStateTree {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 回合序号: 0, 叙事历史: [] }, 社交: { 事件: { 事件记录: [] } }, 角色: { 背包: { 药水: 1 } }, 系统: { 扩展: {} } });
  for (let round = 1; round <= rounds; round++) {
    const snapshot = sm.toSnapshot();
    delete (snapshot.元数据 as Record<string, unknown>).上次对话前快照;
    sm.set(PATHS.preRoundSnapshot, snapshot, 'system');
    sm.set(PATHS.roundNumber, round, 'system');
    const push = sm.push('社交.事件.事件记录', { 事件名称: `事件${round}` }, 'command');
    const set = sm.set('角色.背包', { 药水: round }, 'command');
    sm.push(PATHS.narrativeHistory, { role: 'user', content: `输入${round}` }, 'system');
    sm.push(PATHS.narrativeHistory, {
      role: 'assistant', content: `正文${round}`, _delta: [{ ...push, source: 'main' }, { ...set, source: 'main' }], _engramRead: trace(round),
    }, 'system');
  }
  return JSON.parse(JSON.stringify(sm.toSnapshot())) as GameStateTree;
}

/** The old snapshot as the upgrade should rebuild it: its own history trimmed (the same window) and compacted, marked. */
function expectedSnapshot(save: GameStateTree, marker: unknown): GameStateTree {
  const snapshot = readPath(save, PATHS.preRoundSnapshot) as GameStateTree;
  const history = readPath(snapshot, PATHS.narrativeHistory) as unknown[];
  const next = compactHistoryDeltas(trimHistoryTraces(history, traceTrimCut(history)));
  return writePath(writePath(snapshot, PATHS.narrativeHistory, next), PATHS.saveFormat, marker);
}

describe('save format upgrade (version 2)', () => {
  it('turns the old snapshot into a rollback record that rebuilds it, and trims and compacts both histories', () => {
    const save = legacySave(8);
    expect(readPath(save, PATHS.preRoundSnapshot)).toBeDefined();
    const upgrade = upgradeSaveFormat(save, PATHS);
    expect(upgrade).toMatchObject({ changed: true, snapshotToPatch: true, recordsCompacted: true, tracesTrimmed: 2 });
    const tree = upgrade.tree;
    const marker = { version: SAVE_FORMAT_VERSION, migratedAtRound: 8 };
    expect(readPath(tree, PATHS.saveFormat)).toEqual(marker);
    expect(readPath(tree, PATHS.preRoundSnapshot)).toBeUndefined();

    const history = readPath(tree, PATHS.narrativeHistory) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(16);
    // Rounds 1–3 sit before the window counted on the history round 8 started from (rounds 3–7 full): 1–2 trimmed in
    // both histories; round 3 is the snapshot's fifth-latest, kept whole.
    const trimmedRounds = history.filter((e) => e.role === 'assistant' && (e._engramRead as { trimmed?: unknown }).trimmed).map((e) => e.content);
    expect(trimmedRounds).toEqual(['正文1', '正文2']);
    for (const e of history.filter((x) => x.role === 'assistant')) {
      const [push, set] = e._delta as unknown[];
      expect(isCompactListChange(push)).toBe(true);
      expect(set).toHaveProperty('oldValue');
    }

    const rebuilt = restoreRollbackSnapshot(JSON.parse(JSON.stringify(tree)) as GameStateTree, PATHS);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(expectedSnapshot(save, marker)));
  });

  it('changes nothing it was given, and a second run returns the same tree', () => {
    const save = legacySave(8);
    const before = cloneDeep(save);
    const once = upgradeSaveFormat(save, PATHS);
    expect(save).toStrictEqual(before);
    const twice = upgradeSaveFormat(once.tree, PATHS);
    expect(twice.tree).toBe(once.tree);
    expect(twice.changed).toBe(false);
    const thrice = upgradeSaveFormat(JSON.parse(JSON.stringify(once.tree)) as GameStateTree, PATHS);
    expect(thrice.changed).toBe(false);
  });

  it('returns a tree with nothing in the old shape as it is, without a marker', () => {
    for (const tree of [{}, { data: true, nested: { legacy: 'kept' } }, { 元数据: { 叙事历史: [{ role: 'user', content: '一' }] } }]) {
      const upgrade = upgradeSaveFormat(tree, PATHS);
      expect(upgrade.tree).toBe(tree);
      expect(upgrade.changed).toBe(false);
    }
  });

  it('upgrades a tree without an old snapshot: histories only, no rollback record', () => {
    const save = legacySave(8);
    const noSnapshot = { ...save, 元数据: { ...(save.元数据 as object) } } as GameStateTree;
    delete (noSnapshot.元数据 as Record<string, unknown>).上次对话前快照;
    const upgrade = upgradeSaveFormat(noSnapshot, PATHS);
    expect(upgrade).toMatchObject({ changed: true, snapshotToPatch: false, recordsCompacted: true });
    expect(readPath(upgrade.tree, PATHS.rollbackPatch)).toBeUndefined();
    // The same window as with the snapshot: the history round 8 started from (rounds 3–7 full).
    expect(upgrade.tracesTrimmed).toBe(2);
  });

  it('lets an old snapshot written back by an older tab win over the record, keeping the first upgrade round', () => {
    const upgraded = upgradeSaveFormat(legacySave(6), PATHS).tree;
    const rewrittenByOldTab = writePath(writePath(upgraded, PATHS.preRoundSnapshot, readPath(legacySave(7), PATHS.preRoundSnapshot)), PATHS.roundNumber, 7);
    const again = upgradeSaveFormat(rewrittenByOldTab, PATHS);
    expect(again.changed).toBe(true);
    // The tree's own records were compacted the first time; the old tab's snapshot still holds whole lists.
    expect(again.recordsCompacted).toBe(true);
    expect(readPath(again.tree, PATHS.preRoundSnapshot)).toBeUndefined();
    expect(readPath(again.tree, PATHS.saveFormat)).toEqual({ version: SAVE_FORMAT_VERSION, migratedAtRound: 6 });
    expect(restoreRollbackSnapshot(again.tree, PATHS)).toBeDefined();
  });

  it('leaves alone an old snapshot path that does not hold a snapshot', () => {
    const tree = { 元数据: { 上次对话前快照: '坏掉', 回合序号: 2 } };
    expect(upgradeSaveFormat(tree, PATHS).tree).toBe(tree);
  });

  it('turns an old snapshot into a rollback record when there is nothing to trim or compact', () => {
    const snapshot = { 元数据: { 回合序号: 1, 叙事历史: [] }, 角色: { 背包: { 药水: 1 } } };
    const tree = { 元数据: { 回合序号: 2, 叙事历史: [{ role: 'user', content: '一' }], 上次对话前快照: snapshot }, 角色: { 背包: { 药水: 2 } } };
    const upgrade = upgradeSaveFormat(tree, PATHS);
    expect(upgrade).toMatchObject({ changed: true, snapshotToPatch: true, recordsCompacted: false, tracesTrimmed: 0 });
    const marker = { version: SAVE_FORMAT_VERSION, migratedAtRound: 2 };
    expect(readPath(upgrade.tree, PATHS.saveFormat)).toEqual(marker);
    expect(readPath(upgrade.tree, PATHS.preRoundSnapshot)).toBeUndefined();
    expect(restoreRollbackSnapshot(upgrade.tree, PATHS)).toEqual(writePath(snapshot, PATHS.saveFormat, marker));
  });

  it('trims a save closed mid-round with the window of its newest completed round, snapshot and tree alike', () => {
    // The round start of round 9 set the snapshot and the round number; the page closed before the round's entries.
    const save = legacySave(8);
    const atRoundStart = cloneDeep(save);
    delete (atRoundStart.元数据 as Record<string, unknown>).上次对话前快照;
    const midRound = writePath(writePath(save, PATHS.preRoundSnapshot, atRoundStart), PATHS.roundNumber, 9) as GameStateTree;

    const upgrade = upgradeSaveFormat(midRound, PATHS);
    const history = readPath(midRound, PATHS.narrativeHistory) as unknown[];
    const cut = traceTrimCut(history, 6);
    expect(upgrade.tracesTrimmed).toBe(2);
    expect(readPath(upgrade.tree, PATHS.narrativeHistory)).toEqual(compactHistoryDeltas(trimHistoryTraces(history, cut)));
    const marker = { version: SAVE_FORMAT_VERSION, migratedAtRound: 9 };
    const expected = writePath(writePath(atRoundStart, PATHS.narrativeHistory, compactHistoryDeltas(trimHistoryTraces(history, cut))), PATHS.saveFormat, marker);
    expect(JSON.stringify(restoreRollbackSnapshot(upgrade.tree, PATHS))).toBe(JSON.stringify(expected));
    expect(upgradeSaveFormat(upgrade.tree, PATHS).tree).toBe(upgrade.tree);
  });

  it('keeps every field of the marker an earlier upgrade left, in the tree and in the rebuilt snapshot', () => {
    const upgraded = upgradeSaveFormat(legacySave(6), PATHS).tree;
    const marker = { version: SAVE_FORMAT_VERSION, migratedAtRound: 6, vectorDimRepaired: true };
    const marked = writePath(upgraded, PATHS.saveFormat, marker);
    const rewrittenByOldTab = writePath(writePath(marked, PATHS.preRoundSnapshot, readPath(legacySave(7), PATHS.preRoundSnapshot)), PATHS.roundNumber, 7);
    const again = upgradeSaveFormat(rewrittenByOldTab, PATHS);
    expect(readPath(again.tree, PATHS.saveFormat)).toEqual(marker);
    expect(readPath(restoreRollbackSnapshot(again.tree, PATHS), PATHS.saveFormat)).toEqual(marker);
    const odd = writePath(rewrittenByOldTab, PATHS.saveFormat, { version: SAVE_FORMAT_VERSION, migratedAtRound: '六' });
    expect(readPath(upgradeSaveFormat(odd, PATHS).tree, PATHS.saveFormat)).toEqual({ version: SAVE_FORMAT_VERSION, migratedAtRound: null });
  });

  it('marks afresh a tree whose marker is of another version', () => {
    const otherVersion = writePath(legacySave(5), PATHS.saveFormat, { version: 1, migratedAtRound: 2, vectorDimRepaired: true });
    expect(readPath(upgradeSaveFormat(otherVersion, PATHS).tree, PATHS.saveFormat)).toEqual({ version: SAVE_FORMAT_VERSION, migratedAtRound: 5 });
  });

  it('fails, changing nothing, when a field on the way to a new path holds something other than an object', () => {
    for (const broken of [{ ...legacySave(4), 系统: '损坏' }, { ...legacySave(4), 系统: { 扩展: [] } }]) {
      const before = cloneDeep(broken);
      expect(() => upgradeSaveFormat(broken, PATHS)).toThrow(PathShapeError);
      expect(broken).toStrictEqual(before);
    }
  });
});
