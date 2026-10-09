import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { buildRollbackPatch, isRollbackPatchRecord, restoreRollbackSnapshot, rollbackBaseOf, withoutRollbackData } from './rollback-patch';
import { writePath } from './path-copy';

const PATHS = { rollbackPatch: '系统.扩展.rollbackPatch', preRoundSnapshot: '元数据.上次对话前快照', roundNumber: '元数据.回合序号', narrativeHistory: '元数据.叙事历史' };
const entry = (role: string, n: number) => ({ role, content: `${role}${n}` });

/** A round start (snapshot) and the tree after the round, as saved. */
function roundPair() {
  const snapshot = {
    元数据: { 回合序号: 4, 叙事历史: [entry('user', 1), entry('assistant', 1)] },
    角色: { 背包: { 宝剑: 1, 药水: 2 }, 体力: 80 },
    系统: { 扩展: {} },
  };
  const tree = {
    元数据: { 回合序号: 5, 叙事历史: [entry('user', 1), entry('assistant', 1), entry('user', 2), entry('assistant', 2)] },
    角色: { 背包: { 药水: 2, 地图: 1 }, 体力: 60 },
    系统: { 扩展: {} },
  };
  return { snapshot, tree };
}

describe('rollback patch record (D1A)', () => {
  it('rebuilds the round-start snapshot from the tree as saved, key order included', () => {
    const { snapshot, tree } = roundPair();
    const record = buildRollbackPatch(tree, snapshot, PATHS);
    expect(record.base).toEqual({ round: 5, historyLength: 4 });
    const saved = writePath(tree, PATHS.rollbackPatch, record);
    const rebuilt = restoreRollbackSnapshot(JSON.parse(JSON.stringify(saved)), PATHS);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(snapshot));
  });

  it('keeps rollback data out of both sides: no patch nested in a patch, none in a rebuilt snapshot', () => {
    const { snapshot, tree } = roundPair();
    // Each side holds rollback data of its own (the round before's record, an old snapshot): none of it may enter the patch.
    const older = { format: 1, ops: [{ op: 'del', path: ['x'] }], base: { round: 3, historyLength: 0 } };
    const newer = { format: 1, ops: [{ op: 'del', path: ['y'] }], base: { round: 4, historyLength: 2 } };
    const snapshotWithStale = writePath(writePath(snapshot, PATHS.rollbackPatch, older), PATHS.preRoundSnapshot, { old: 1 });
    const treeWithStale = writePath(writePath(tree, PATHS.rollbackPatch, newer), PATHS.preRoundSnapshot, { old: 2 });
    const record = buildRollbackPatch(treeWithStale, snapshotWithStale, PATHS);
    expect(record.ops.some((op) => op.path[0] === '系统' && op.path[2] === 'rollbackPatch')).toBe(false);
    expect(record.ops.some((op) => op.path[1] === '上次对话前快照')).toBe(false);
    const rebuilt = restoreRollbackSnapshot(writePath(treeWithStale, PATHS.rollbackPatch, record), PATHS);
    expect(rebuilt).toEqual(snapshot);
  });

  it('rebuilds nothing for a tree something else changed since: another round or history length', () => {
    const { snapshot, tree } = roundPair();
    const saved = writePath(tree, PATHS.rollbackPatch, buildRollbackPatch(tree, snapshot, PATHS));
    expect(restoreRollbackSnapshot(writePath(saved, PATHS.roundNumber, 6), PATHS)).toBeUndefined();
    const longer = writePath(saved, PATHS.narrativeHistory, [...tree.元数据.叙事历史, entry('user', 3)]);
    expect(restoreRollbackSnapshot(longer, PATHS)).toBeUndefined();
  });

  it('rebuilds nothing, and never throws, for a missing, malformed or ill-fitting record', () => {
    const { tree } = roundPair();
    expect(restoreRollbackSnapshot(tree, PATHS)).toBeUndefined();
    const base = rollbackBaseOf(tree, PATHS);
    for (const bad of [
      'patch', { format: 2, ops: [], base }, { format: 1, ops: 'x', base }, { format: 1, ops: [], base: { round: '5', historyLength: 4 } },
      { format: 1, ops: [{ op: 'set', path: ['missing', 'deep'], value: 1 }], base },
      { format: 1, ops: [{ op: 'set', path: ['角色', '__proto__', 'polluted'], value: true }], base },
    ]) {
      expect(restoreRollbackSnapshot(writePath(tree, PATHS.rollbackPatch, bad), PATHS)).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('tells a stored record from anything else', () => {
    expect(isRollbackPatchRecord({ format: 1, ops: [], base: { round: null, historyLength: 0 } })).toBe(true);
    for (const bad of [null, [], { format: 1, ops: [] }, { format: 1, ops: [], base: { round: 1, historyLength: -1 } },
      { format: 1, ops: [], base: { round: Number.NaN, historyLength: 0 } }, { format: 1, ops: [{ op: 'x', path: [] }], base: { round: 1, historyLength: 0 } }]) {
      expect(isRollbackPatchRecord(bad)).toBe(false);
    }
  });

  it('reads the base of a tree without a round number or history, and leaves a tree without rollback data alone', () => {
    expect(rollbackBaseOf({}, PATHS)).toEqual({ round: null, historyLength: 0 });
    const { tree } = roundPair();
    expect(withoutRollbackData(tree, PATHS)).toBe(tree);
    const before = cloneDeep(tree);
    buildRollbackPatch(tree, roundPair().snapshot, PATHS);
    expect(tree).toStrictEqual(before);
  });
});
