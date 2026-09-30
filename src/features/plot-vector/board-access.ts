import { cloneDeep, set } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { eventBus } from '../../engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements } from './saved-elements';
import type { Layout } from '../../engine/plot-vector/core/types';
import { prepareVector, readVectorState, type PreparedVector, type VectorState } from './runtime';
import type { SupplyRules } from './supply';
import { projectNativeInput, type NativeRules } from './native-input';
import { abilityBacklog, type BacklogEntry } from './ability-backlog';
import type { BoardShape } from './vector-board';

export interface BoardView {
  state: VectorState;
  prepared: PreparedVector;
  /** Obtained entries whose ability is not usable yet (shown as text, never as a playable card). */
  backlog: BacklogEntry[];
  /** The saved arrangement could not be computed; the board opened with every card taken off (not saved yet). */
  cleared: boolean;
  /** Trip for an arrangement; `shape` tries the other board shape without saving it. */
  preview(layout: Layout, shape?: BoardShape): Promise<PreparedVector>;
  /** Saves the arrangement, and the board shape when given (kept for the next rounds). */
  save(layout: Layout, shape?: BoardShape): Promise<void>;
}

/** The only parts of the tree the board reads (the whole tree can be many megabytes). */
const BOARD_SOURCES = [P.inventoryItems, P.talents, P.statusEffects, P.environmentTags, P.characterAttributes];

/**
 * Optional UI port. No acceptance hooks, no writes before IDB commit. Its only model call is the player's
 * explicit ability retry, delegated to the round adapter and run like a board save (no round can start).
 * A view is current while nothing else changed the state since it was opened or since its own last save:
 * every state write emits `engine:state-changed`, so counting those replaces comparing whole-tree copies.
 */
export class VectorBoardAccess {
  private revision = 0;
  private changes = 0;
  private writing = false;
  get isSaving(): boolean { return this.writing; }
  private unsubs: Array<() => void>;
  constructor(private state: StateManager, private saves: Pick<SaveManager, 'saveGame'>,
    private slot: () => { profileId: string; slotId: string } | null, private busy: () => boolean,
    private nativeRules?: NativeRules,
    private onSaveSettled: () => void = () => {},
    private regenerateAbility?: (entryId: string) => Promise<{ bound: boolean; requested: boolean }>,
    private supplyRules?: SupplyRules) {
    this.unsubs = [subscribePlotVectorControl(() => this.invalidate()),
      eventBus.on('engine:state-changed', () => { this.changes++; })];
  }
  private invalidate() { this.revision++; }
  /** The player's retry for one entry's ability. Refused while a round, a save or another retry runs. */
  async regenerate(entryId: string): Promise<{ bound: boolean; requested: boolean }> {
    if (!this.regenerateAbility) throw new Error('ability-retry-unavailable');
    if (this.busy() || this.writing || !readPlotVectorControl().enabled) throw new Error('board-save-busy');
    this.writing = true;
    try {
      const result = await this.regenerateAbility(entryId);
      this.invalidate();
      return result;
    } finally { this.writing = false; this.onSaveSettled(); }
  }
  dispose() { this.invalidate(); this.unsubs.forEach(fn => fn()); }
  async open(): Promise<BoardView> {
    const slot = this.slot(), control = readPlotVectorControl(), revision = this.revision;
    let seen = this.changes;
    let state: VectorState = cloneDeep(readVectorState(this.state.get(P.plotVector)));
    const sources: Record<string, unknown> = {};
    for (const path of BOARD_SOURCES) {
      const value = this.state.get(path);
      if (value !== undefined) set(sources, path, cloneDeep(value));
    }
    const entries = projectSavedElements(sources, { includeEnvironment: true }).entries;
    const native = projectNativeInput(sources, this.nativeRules);
    const guard = () => {
      const live = readPlotVectorControl(), now = this.slot();
      if (!slot || this.busy() || !live.enabled || control.epoch !== live.epoch || revision !== this.revision
        || now?.profileId !== slot.profileId || now?.slotId !== slot.slotId || this.changes !== seen)
        throw new Error('board-view-stale');
    };
    guard();
    // Computed in the page, synchronously (rebuild plan §4).
    const preview = async (layout?: Layout, shape?: BoardShape): Promise<PreparedVector> => {
      guard();
      return prepareVector({ ...state, ...(layout ? { layout: cloneDeep(layout) } : {}), ...(shape ? { shape } : {}) }, entries,
        `${slot!.profileId}/${slot!.slotId}/${(this.state.get<number>(P.roundNumber) ?? 0) + 1}`, native, this.supplyRules);
    };
    let prepared: PreparedVector, cleared = false;
    try { prepared = await preview(); }
    catch (error) {
      guard();
      // A card that no longer computes must not lock the board: open it with every card taken off,
      // so the player can see it, arrange again and save.
      console.warn('[PlotVector] Saved arrangement could not be computed; opened with the board cleared:', error);
      prepared = await preview({ placements: {}, tray: [] });
      cleared = true;
    }
    return { state, prepared, cleared, backlog: abilityBacklog(state, entries), preview, save: async (layout, shape) => {
      guard();
      if (this.writing) throw new Error('board-save-busy');
      this.writing = true;
      let committed = false, applied = false;
      try {
        const normalized = await preview(layout, shape);
        guard();
        const next = { ...state, layout: normalized.layout, ...(shape ? { shape } : {}) };
        // Nothing changed since the view was current, so the live tree is what it was computed from;
        // saveGame copies this before its first await.
        const data = this.state.snapshotWith(P.plotVector, next);
        await this.saves.saveGame(slot!.profileId, slot!.slotId, data, undefined, {
          guard,
          committed: () => {
            committed = true;
            // IDB may finish after the user activates another save. Never copy
            // this old slot's layout into the newly active in-memory tree.
            guard();
            this.state.set(P.plotVector, next);
            // The view's own write keeps it current: the player goes on arranging without reopening.
            state = next;
            seen = this.changes;
            applied = true;
          },
        });
      } catch (error) {
        // A metadata failure after the atomic data write must not undo the layout.
        if (!committed || !applied) throw error;
      } finally { this.writing = false; this.onSaveSettled(); }
    } };
  }
}
