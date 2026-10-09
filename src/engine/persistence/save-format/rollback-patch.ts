/**
 * 回退差异的存放形式 — 生成、校验、还原（存档瘦身 D1A，2026-10-09）
 *
 * The save keeps, at `paths.rollbackPatch`, the reverse patch from the tree as saved to the snapshot taken at round
 * start, with the round number and narrative-history length of the tree it was made for. Every save makes it anew (the
 * tree keeps changing after a round: image tasks, panel edits), so on load it always belongs to the tree it is stored
 * in; the base check only catches a tree something else changed since (a tab still running older code that kept the
 * stale patch while writing a later round).
 *
 * Neither side of the patch holds rollback data: the patch path and the old snapshot path are taken out of the tree and
 * of the snapshot before diffing — the previous round's patch would otherwise be nested into this one, round after
 * round — and a rebuilt snapshot has neither (after a rollback there is nothing to roll back to, as before).
 */
import type { GameStateTree } from '../../types';
import { applyTreePatch, diffTree, isTreePatch, type TreePatch } from './tree-patch';
import { readPath, removePath } from './path-copy';
import { isPlainRecord } from './plain-data';

/** The paths the rollback data lives at and the base is read from (from DEFAULT_ENGINE_PATHS). */
export interface RollbackPaths {
  rollbackPatch: string;
  preRoundSnapshot: string;
  roundNumber: string;
  narrativeHistory: string;
}

/** Which tree a patch was made for. */
export interface RollbackBase {
  round: number | null;
  historyLength: number;
}

/** The rollback data as stored at `paths.rollbackPatch`. */
export interface RollbackPatchRecord {
  format: 1;
  ops: TreePatch;
  base: RollbackBase;
}

/** The round number and narrative-history length of a tree. */
export function rollbackBaseOf(tree: unknown, paths: RollbackPaths): RollbackBase {
  const round = readPath(tree, paths.roundNumber);
  const history = readPath(tree, paths.narrativeHistory);
  return {
    round: typeof round === 'number' && Number.isFinite(round) ? round : null,
    historyLength: Array.isArray(history) ? history.length : 0,
  };
}

/** The tree without its rollback data (the patch path and the old snapshot path); the same object when it has none. */
export function withoutRollbackData(tree: GameStateTree, paths: RollbackPaths): GameStateTree {
  return removePath(removePath(tree, paths.rollbackPatch), paths.preRoundSnapshot);
}

/** The record that turns `tree` (as it is being saved) back into `snapshot` (taken at round start). */
export function buildRollbackPatch(tree: GameStateTree, snapshot: GameStateTree, paths: RollbackPaths): RollbackPatchRecord {
  return {
    format: 1,
    ops: diffTree(withoutRollbackData(tree, paths), withoutRollbackData(snapshot, paths)),
    base: rollbackBaseOf(tree, paths),
  };
}

/** Whether a stored value is a rollback record (data read back from a save is not trusted). */
export function isRollbackPatchRecord(value: unknown): value is RollbackPatchRecord {
  if (!isPlainRecord(value) || value.format !== 1 || !isTreePatch(value.ops) || !isPlainRecord(value.base)) return false;
  const { round, historyLength } = value.base;
  return (round === null || (typeof round === 'number' && Number.isFinite(round)))
    && typeof historyLength === 'number' && Number.isSafeInteger(historyLength) && historyLength >= 0;
}

/**
 * The snapshot the tree's rollback record rebuilds, or undefined when there is none to rebuild: no record, not a
 * record, made for another tree (base mismatch), or one that does not fit. Never throws.
 */
export function restoreRollbackSnapshot(tree: GameStateTree, paths: RollbackPaths): GameStateTree | undefined {
  const record = readPath(tree, paths.rollbackPatch);
  if (!isRollbackPatchRecord(record)) return undefined;
  const base = rollbackBaseOf(tree, paths);
  if (base.round !== record.base.round || base.historyLength !== record.base.historyLength) return undefined;
  try {
    const snapshot = applyTreePatch(withoutRollbackData(tree, paths), record.ops);
    return isPlainRecord(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}
