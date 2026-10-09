/**
 * 回退快照持有者 — 回合开始时的整棵树只放在内存里（存档瘦身 D1A，2026-10-09）
 *
 * The tree as it was at round start used to be written into the state tree itself (41% of a large save, and three
 * whole-tree copies at every round start). It now lives here, in memory only: every save stores the patch from the
 * tree being saved back to it (save-format/rollback-patch.ts), and loading a save rebuilds it from that patch.
 *
 * The tree says which snapshot it can go back to: while a rollback is available it carries, at `paths.rollbackPatch`,
 * the marker this holder gave the snapshot (`round-start:<n>`, numbered per page). A copy of the tree carries the same
 * marker, so a manual save, a save to another slot or a save of a copy still finds its snapshot here. A tree that
 * comes back from elsewhere (a private-chat or assistant undo, an older copy) carries its own marker or none: a marker
 * that does not name the held snapshot gives no rollback, so a tree never goes back to another tree's round start.
 *
 * Saved trees never keep a marker: the save writes the rollback record in its place, or takes it out (treeToSave).
 * Loading a save rebuilds the snapshot from the record and marks the tree again (restoreLoaded).
 *
 * The held snapshot is plain data without rollback data (no patch, no old whole snapshot) and is never changed: a
 * rollback copies it into the tree.
 */
import type { GameStateTree } from '../types';
import type { StateManager } from './state-manager';
import {
  buildRollbackPatch,
  restoreRollbackSnapshot,
  withoutRollbackData,
  type RollbackPatchRecord,
  type RollbackPaths,
} from '../persistence/save-format/rollback-patch';
import { readPath, removePath, writePath } from '../persistence/save-format/path-copy';

/** The start of the marker a held snapshot gets (the rest numbers the snapshots held in this page). */
export const ROLLBACK_MARKER_PREFIX = 'round-start:';

/** A held snapshot and the marker that names it. */
export interface HeldRollback {
  readonly marker: string;
  readonly snapshot: GameStateTree;
}

export class RollbackSnapshot {
  private held: HeldRollback | undefined;
  private count = 0;

  constructor(private readonly paths: RollbackPaths) {}

  /**
   * Hold a round-start snapshot (its rollback data is left out), replacing any held before. Returns the marker to put
   * in the tree at `paths.rollbackPatch`. The snapshot must not be changed afterwards (take it from toSnapshot()).
   */
  capture(snapshot: GameStateTree): string {
    this.count += 1;
    const marker = `${ROLLBACK_MARKER_PREFIX}${this.count}`;
    this.held = { marker, snapshot: withoutRollbackData(snapshot, this.paths) };
    return marker;
  }

  /** The held snapshot, when `marker` (what a tree holds at `paths.rollbackPatch`) names it. */
  get(marker: unknown): GameStateTree | undefined {
    return this.held !== undefined && marker === this.held.marker ? this.held.snapshot : undefined;
  }

  /** What is held now: kept by a flow that may later bring back a tree carrying this marker (the assistant's undo). */
  current(): HeldRollback | undefined {
    return this.held;
  }

  /** Hold again what `current()` gave, once the tree it belongs to is back. */
  hold(held: HeldRollback): void {
    this.held = held;
  }

  /** Let go of the held snapshot (after a rollback, or when another save is loaded). */
  clear(): void {
    this.held = undefined;
  }

  /** The rollback record for a tree, when the tree's marker names the held snapshot. */
  patchFor(tree: GameStateTree): RollbackPatchRecord | undefined {
    const snapshot = this.get(readPath(tree, this.paths.rollbackPatch));
    return snapshot === undefined ? undefined : buildRollbackPatch(tree, snapshot, this.paths);
  }

  /**
   * The tree as it goes into the database (SaveManager.saveGame, at the call): a marker naming the held snapshot is
   * replaced by the rollback record; any other marker is taken out (nothing to roll back to). A tree without a marker
   * — a new game, a record restored elsewhere — is written as it is. Only the objects on the way to the field are
   * copied; the rest is shared with the tree handed over, which the caller writes before it yields. Never throws: when
   * the record cannot be made the tree is written without one, and only the rollback is lost.
   */
  treeToSave(tree: GameStateTree): GameStateTree {
    const value = readPath(tree, this.paths.rollbackPatch);
    if (typeof value !== 'string') return tree;
    try {
      const record = this.patchFor(tree);
      return record === undefined ? removePath(tree, this.paths.rollbackPatch) : writePath(tree, this.paths.rollbackPatch, record);
    } catch (err) {
      console.warn('[RollbackSnapshot] Could not store the rollback record; saving without it:', err);
      return removePath(tree, this.paths.rollbackPatch);
    }
  }

  /**
   * Right after a save is loaded into the state: rebuild the snapshot its rollback record leads back to, hold it and
   * mark the tree. The snapshot is rebuilt from `loaded`, the save as it was handed to the state: the state emits
   * 'load' as the tree goes in, and a listener may change the tree at once (the private-chat trim, the image task
   * restore) — the record no longer fits that tree, and no repair ever reached the old whole snapshot either. A record
   * that cannot be used (made for another tree, damaged, or a marker a save should never hold) is taken out: there is
   * nothing to roll back to, and the button says so.
   */
  restoreLoaded(state: Pick<StateManager, 'liveTree' | 'set' | 'delete'>, loaded: GameStateTree = state.liveTree()): void {
    const stored = readPath(loaded, this.paths.rollbackPatch);
    const snapshot = restoreRollbackSnapshot(loaded, this.paths);
    if (snapshot !== undefined) {
      state.set(this.paths.rollbackPatch, this.capture(snapshot), 'system');
      return;
    }
    this.clear();
    if (stored !== undefined) {
      console.warn('[RollbackSnapshot] The save\'s rollback record does not fit it (made for another tree, or damaged): no rollback until the next round');
    }
    if (readPath(state.liveTree(), this.paths.rollbackPatch) !== undefined) state.delete(this.paths.rollbackPatch, 'system');
  }
}
