/**
 * 引擎存档格式升级（格式版本 2）— 读存档时在内存里把旧格式转成新格式（存档瘦身 P1，2026-10-09）
 *
 * SaveManager.loadGame runs this on every read of a save — opening the game, export, cloud upload, card export —
 * before the pack migrations. It never writes and never changes the tree it is given: the caller gets the upgraded
 * tree, and IndexedDB keeps the old record until an opened game saves (SaveManager first copies the old record aside).
 *
 * Each step changes only data still in the old shape, so the upgrade can run any number of times: a tree with nothing
 * left to upgrade comes back as the same object, and old-shaped data written back by a tab running older code is
 * upgraded on the next read.
 * 1. D2B trim the retrieval traces outside the latest five completed rounds — tree and old snapshot alike, counted on
 *    the history the newest round started from: the tree's history without its newest round (its sixth-latest assistant
 *    entry). That is the old snapshot's history, and what the round-start trim saw; it does not depend on whether the
 *    tree still holds the snapshot, so a second run trims nothing more (the rollback record stays true);
 * 2. D3A compact the stored push / pull change records (tree and old snapshot);
 * 3. D1A turn an old whole snapshot into the rollback record at the new path, and remove the old path;
 * 4. when anything changed, mark the format: version 2 and the round of the upgrade (when the copy of the old record
 *    may be dropped). The snapshot carries the same marker, so the patch leaves it alone.
 * Vectors are not in the tree: VectorStore.load converts them (D4A).
 */
import type { GameStateTree } from '../../types';
import { compactHistoryDeltas } from './delta-compaction';
import { FULL_TRACE_ROUNDS, traceTrimCut, trimHistoryTraces } from './engram-read-trim';
import { buildRollbackPatch, type RollbackPaths } from './rollback-patch';
import { readPath, removePath, writePath } from './path-copy';
import { isPlainRecord } from './plain-data';

/** The engine save format this code writes. */
export const SAVE_FORMAT_VERSION = 2;

/** The paths the upgrade reads and writes (from DEFAULT_ENGINE_PATHS). */
export interface SaveFormatPaths extends RollbackPaths {
  saveFormat: string;
}

/** The format marker an upgraded tree carries at `paths.saveFormat` (later steps may add fields of their own). */
export interface SaveFormatMarker {
  version: number;
  /** The tree's round when it was upgraded (null when it has no round number). */
  migratedAtRound: number | null;
  [field: string]: unknown;
}

/** What an upgrade did. */
export interface SaveFormatUpgrade {
  /** The upgraded tree; the given tree itself when there was nothing to upgrade. */
  tree: GameStateTree;
  changed: boolean;
  tracesTrimmed: number;
  recordsCompacted: boolean;
  snapshotToPatch: boolean;
}

/** The tree in save format 2, in memory (see the module comment). */
export function upgradeSaveFormat(raw: GameStateTree, paths: SaveFormatPaths): SaveFormatUpgrade {
  const legacy = readPath(raw, paths.preRoundSnapshot);
  const snapshot = isPlainRecord(legacy) ? legacy : undefined;

  const treeHistory = historyOf(raw, paths);
  const snapshotHistory = snapshot ? historyOf(snapshot, paths) : undefined;
  const cut = traceTrimCut(treeHistory ?? [], FULL_TRACE_ROUNDS + 1);

  const trimmedTree = treeHistory && trimHistoryTraces(treeHistory, cut);
  const trimmedSnapshot = snapshotHistory && trimHistoryTraces(snapshotHistory, cut);
  const nextTreeHistory = trimmedTree && compactHistoryDeltas(trimmedTree);
  const nextSnapshotHistory = trimmedSnapshot && compactHistoryDeltas(trimmedSnapshot);
  const tracesTrimmed = countReplaced(treeHistory, trimmedTree);
  const recordsCompacted = nextTreeHistory !== trimmedTree || nextSnapshotHistory !== trimmedSnapshot;

  const historyChanged = nextTreeHistory !== treeHistory || nextSnapshotHistory !== snapshotHistory;
  if (!historyChanged && !snapshot) return { tree: raw, changed: false, tracesTrimmed: 0, recordsCompacted: false, snapshotToPatch: false };

  const marker = existingMarker(raw, paths) ?? { version: SAVE_FORMAT_VERSION, migratedAtRound: roundOf(raw, paths) };
  let tree = writePath(raw, paths.saveFormat, marker);
  if (nextTreeHistory !== treeHistory) tree = writePath(tree, paths.narrativeHistory, nextTreeHistory);

  if (snapshot) {
    let rebuiltFrom = writePath(snapshot, paths.saveFormat, marker);
    if (nextSnapshotHistory !== snapshotHistory) rebuiltFrom = writePath(rebuiltFrom, paths.narrativeHistory, nextSnapshotHistory);
    tree = removePath(tree, paths.preRoundSnapshot);
    tree = writePath(tree, paths.rollbackPatch, buildRollbackPatch(tree, rebuiltFrom, paths));
  }

  return { tree, changed: true, tracesTrimmed, recordsCompacted, snapshotToPatch: snapshot !== undefined };
}

function historyOf(tree: GameStateTree, paths: SaveFormatPaths): readonly unknown[] | undefined {
  const history = readPath(tree, paths.narrativeHistory);
  return Array.isArray(history) ? history : undefined;
}

function roundOf(tree: GameStateTree, paths: SaveFormatPaths): number | null {
  const round = readPath(tree, paths.roundNumber);
  return typeof round === 'number' && Number.isFinite(round) ? round : null;
}

/**
 * A version-2 marker the tree already carries, with every field it holds (it records the first upgrade, and later
 * steps add their own fields to it).
 */
function existingMarker(tree: GameStateTree, paths: SaveFormatPaths): SaveFormatMarker | undefined {
  const marker = readPath(tree, paths.saveFormat);
  if (!isPlainRecord(marker) || marker.version !== SAVE_FORMAT_VERSION) return undefined;
  const round = marker.migratedAtRound;
  return { ...marker, version: SAVE_FORMAT_VERSION, migratedAtRound: typeof round === 'number' && Number.isFinite(round) ? round : null };
}

/** How many entries of a list were replaced by new objects. */
function countReplaced(before: readonly unknown[] | undefined, after: readonly unknown[] | undefined): number {
  if (!before || !after || before === after) return 0;
  return after.reduce<number>((n, entry, i) => (entry === before[i] ? n : n + 1), 0);
}
