import { cloneDeep } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { eventBus } from '../../engine/core/event-bus';
import type { SaveReplacedEvent } from '../../engine/types/event-bus';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements, savedSources } from './saved-elements';
import type { Layout } from '../../engine/plot-vector/core/types';
import { prepareVector, readVectorState, type PreparedVector, type VectorState } from './runtime';
import { initialSupply, supplyHandInfo, type SupplyCardInfo, type SupplyRules } from './supply';
import { projectNativeInput, type NativeRules } from './native-input';
import { abilityBacklog, type BacklogEntry } from './ability-backlog';
import { readConverter, type BoardShape, type ConverterRule } from './vector-board';

export interface BoardView {
  state: VectorState;
  prepared: PreparedVector;
  /** Obtained entries whose ability is not usable yet (shown as text, never as a playable card). */
  backlog: BacklogEntry[];
  /** The saved arrangement could not be computed; the board opened with every card taken off (not saved yet). */
  cleared: boolean;
  /** Supply hand cards by instance id: tier and recharge (empty without a supply pool). */
  supply: Record<string, SupplyCardInfo>;
  /** Trip for an arrangement; `shape` and `converter` try another board shape or converter rule without saving them. */
  preview(layout: Layout, shape?: BoardShape, converter?: ConverterRule): Promise<PreparedVector>;
  /**
   * Keeps the arrangement, and the board shape and converter rule when given, in the live game state at once (the next round
   * uses it). It reaches the save file with `VectorBoardAccess.persist` — when the table closes — or with the
   * next round's own save.
   */
  commit(layout: Layout, shape?: BoardShape, converter?: ConverterRule): Promise<void>;
}

/**
 * An arrangement kept in the live state and not yet in its save file: the save it belongs to, the tree as it was
 * at that commit (a plain snapshot sharing unchanged branches with the live tree), and which loaded tree it was.
 */
interface PendingWrite { profileId: string; slotId: string; tree: Record<string, unknown>; generation: number }
/** A board write that gave way to a restore of its save. */
class BoardSaveReplaced extends Error { constructor() { super('board-save-replaced'); } }

/**
 * Optional UI port. No acceptance hooks. Its only model call is the player's explicit ability retry, delegated
 * to the round adapter and run like a board save (no round can start).
 * While the table is open, arrangements change only the live state; the save file is written once, when the
 * table closes (PO 2026-09-30, B): writing a large save holds the page for a moment, so it must not follow
 * every move. A round never starts from an unsaved move it does not see, because the round reads the live state.
 * If another save is loaded before an arrangement was written, it is written at that moment — from the tree it
 * was kept in, to its own save (unless that save was deleted) — and never later, so an old tree can never land
 * on a save that was restored or synced meanwhile. The same save loaded again, or rolled back, keeps its tree.
 * A view is current while nothing else changed the state since it was opened or since its own last commit:
 * every state write emits `engine:state-changed`, so counting those replaces comparing whole-tree copies.
 * Anything else that overwrites or removes saves — a backup restore, a cloud slot replace, a deleted slot, a wiped
 * store — announces itself first (`engine:save-replaced`; a restore brackets itself, rollback included): a waiting
 * arrangement of that profile is dropped (the restored save is the truth); no board write starts while a restore
 * runs; and one already under way gives up inside its transaction unless its transaction came first (then the
 * restore's write lands after it).
 */
export class VectorBoardAccess {
  private revision = 0;
  private changes = 0;
  /** Bumped whenever the whole tree is replaced (a save loaded, a round rolled back). */
  private generation = 0;
  /** Writes and ability retries under way (a count: they can overlap when a save is switched mid-retry). */
  private writers = 0;
  private get writing(): boolean { return this.writers > 0; }
  private pending: PendingWrite | null = null;
  /** Announcements of replaced saves, counted per profile ('' stands for every save). */
  private replaced = new Map<string, number>();
  /** Restores under way, per profile ('' for every save). */
  private replacing = new Map<string, number>();
  private replacedFor(profileId: string): number { return (this.replaced.get(profileId) ?? 0) + (this.replaced.get('') ?? 0); }
  private replacingFor(profileId: string): boolean { return (this.replacing.get(profileId) ?? 0) + (this.replacing.get('') ?? 0) > 0; }
  /** The board's own write in progress, so a second one waits for it. */
  private boardWrite: Promise<unknown> | null = null;
  get isSaving(): boolean { return this.writing; }
  /** Arrangements are in the live state but not yet in the save file. */
  get hasUnsaved(): boolean { return this.pending !== null; }
  private unsubs: Array<() => void>;
  constructor(private state: StateManager, private saves: Pick<SaveManager, 'saveGame' | 'hasSave'> & Partial<Pick<SaveManager, 'prepareTree'>>,
    private slot: () => { profileId: string; slotId: string } | null, private busy: () => boolean,
    private nativeRules?: NativeRules,
    private onSaveSettled: () => void = () => {},
    private regenerateAbility?: (entryId: string) => Promise<{ bound: boolean; requested: boolean }>,
    private supplyRules?: SupplyRules) {
    this.unsubs = [subscribePlotVectorControl(() => this.invalidate()),
      eventBus.on<{ type?: string } | undefined>('engine:state-changed', change => {
        this.changes++;
        if (change?.type !== 'load' && change?.type !== 'rollback') return;
        this.generation++;
        // The tree an arrangement was kept in has just been replaced: settle it now. The loader names the newly
        // active save right after replacing the tree, so look once that has run.
        const pending = this.pending;
        if (pending && pending.generation === this.generation - 1) {
          // The kept tree takes its rollback record now, while the round start it names is still held (存档瘦身 D1A).
          const target = { ...pending, tree: this.saves.prepareTree?.(pending.tree) ?? pending.tree };
          this.pending = target;
          queueMicrotask(() => { void this.settleReplaced(target); });
        }
      }),
      eventBus.on<SaveReplacedEvent | undefined>('engine:save-replaced', change => {
        const profileId = change?.profileId ?? '';
        this.replaced.set(profileId, (this.replaced.get(profileId) ?? 0) + 1);
        if (change?.phase === 'begin') this.replacing.set(profileId, (this.replacing.get(profileId) ?? 0) + 1);
        if (change?.phase === 'end') this.replacing.set(profileId, Math.max(0, (this.replacing.get(profileId) ?? 0) - 1));
        // An arrangement kept during a restore was made on the tree from before it: dropped at its end too.
        if (this.pending && (!profileId || this.pending.profileId === profileId)) this.pending = null;
      }),
      // Any other save of the same slot (a round, a retry) already carried the arrangement, or superseded it.
      eventBus.on<{ profileId?: string; slotId?: string } | undefined>('engine:save-complete', saved => {
        const target = this.pending;
        if (!this.writing && target && saved?.profileId === target.profileId && saved.slotId === target.slotId) this.pending = null;
      })];
  }
  private invalidate() { this.revision++; }
  /** A round is running: the table cannot save now and keeps the player's move until the round ends. */
  roundRunning(): boolean { return this.busy(); }
  /** The player's retry for one entry's ability. Refused while a round, a save or another retry runs. */
  async regenerate(entryId: string): Promise<{ bound: boolean; requested: boolean }> {
    if (!this.regenerateAbility) throw new Error('ability-retry-unavailable');
    if (this.busy() || this.writing || !readPlotVectorControl().enabled) throw new Error('board-save-busy');
    this.writers++;
    try {
      const result = await this.regenerateAbility(entryId);
      this.invalidate();
      return result;
    } finally { this.writers--; this.onSaveSettled(); }
  }
  dispose() { this.invalidate(); this.unsubs.forEach(fn => fn()); }
  /**
   * Writes a waiting arrangement to its save file (the table closed or went away, or the page is hidden): the
   * live tree, in which only the board branch is new (saveGame copies the rest once, before it yields). While a
   * round runs in that save it waits: resolves false, and the round's own save carries the arrangement. A tree
   * that was replaced meanwhile was settled at that moment, so nothing old is written here.
   */
  async persist(): Promise<boolean> {
    while (this.boardWrite) await this.boardWrite.catch(() => {});
    const target = this.pending;
    if (!target) return true;
    // The tree was replaced (settled at that moment) or the game closed: an old tree is never written later.
    if (this.generation !== target.generation || !this.state.isLoaded()) { this.pending = null; return true; }
    const active = this.slot();
    if (active?.profileId === target.profileId && active?.slotId === target.slotId && this.busy()) return false;
    if (this.writing) return false; // the ability retry saves the live tree itself when it ends
    return this.runWrite(target, true);
  }
  /** Right after the tree an arrangement was kept in was replaced (see the constructor). */
  private async settleReplaced(target: PendingWrite): Promise<void> {
    while (this.boardWrite) await this.boardWrite.catch(() => {});
    if (this.pending !== target) return;
    const active = this.slot();
    // The same save loaded again or rolled back: that tree is the save's truth now.
    if (active?.profileId === target.profileId && active?.slotId === target.slotId) { this.pending = null; return; }
    try { await this.runWrite(target, false); }
    catch (error) {
      if (this.pending === target) this.pending = null;
      console.warn('[PlotVector] An arrangement of the previous save could not be written to it:', error);
    }
  }
  private async runWrite(target: PendingWrite, sameTree: boolean): Promise<boolean> {
    const run = this.write(target, sameTree);
    this.boardWrite = run;
    try { return await run; } finally { if (this.boardWrite === run) this.boardWrite = null; }
  }
  private async write(target: PendingWrite, sameTree: boolean): Promise<boolean> {
    this.writers++;
    let written = false;
    const replacedAtStart = this.replacedFor(target.profileId);
    const replacedSince = () => this.replacingFor(target.profileId) || this.replacedFor(target.profileId) !== replacedAtStart;
    try {
      // A restore of this profile is running: what it writes is the truth; nothing is written over it.
      if (this.replacingFor(target.profileId)) { if (this.pending === target) this.pending = null; return true; }
      if (!sameTree && !(await this.saves.hasSave(target.profileId, target.slotId))) {
        if (this.pending === target) this.pending = null;
        return true;
      }
      const data = sameTree ? this.state.snapshotWith(P.plotVector, this.state.get(P.plotVector)) : target.tree;
      // The data always goes to its own save. A kept tree no longer changes once it was replaced; the live tree is
      // taken by the write at the call (saveGame writes it before it yields), so nothing can cross slots.
      // The guard runs right before the database transaction starts and again before it commits.
      await this.saves.saveGame(target.profileId, target.slotId, data, undefined, {
        // A restore of this save meanwhile: the restored save wins, this write gives up.
        guard: () => { if (replacedSince()) throw new BoardSaveReplaced(); },
        // A commit made while this write ran leaves a new pending mark, written next time.
        committed: () => { written = true; if (this.pending === target) this.pending = null; },
      });
      return true;
    } catch (error) {
      // Its save was restored meanwhile: the arrangement was dropped with it, nothing to report.
      if (error instanceof BoardSaveReplaced) return true;
      // A metadata failure after the atomic data write does not undo it; it is still reported.
      if (!written) throw error;
      console.warn('[PlotVector] The arrangement was saved but the slot details were not updated:', error);
      return true;
    } finally { this.writers--; this.onSaveSettled(); }
  }
  async open(): Promise<BoardView> {
    const slot = this.slot(), control = readPlotVectorControl(), revision = this.revision, generation = this.generation;
    let seen = this.changes;
    let state: VectorState = cloneDeep(readVectorState(this.state.get(P.plotVector)));
    // Only the branches the board reads (the whole tree can be many megabytes).
    const sources = savedSources(path => this.state.get(path));
    const entries = projectSavedElements(sources, { includeEnvironment: true }).entries;
    const native = projectNativeInput(sources, this.nativeRules);
    const guard = () => {
      const live = readPlotVectorControl(), now = this.slot();
      // Another save or another tree: the view's arrangement must not be carried over (the table drops it).
      if (!slot || now?.profileId !== slot.profileId || now?.slotId !== slot.slotId || generation !== this.generation)
        throw new Error('board-view-switched');
      if (this.busy() || !live.enabled || control.epoch !== live.epoch || revision !== this.revision || this.changes !== seen)
        throw new Error('board-view-stale');
    };
    guard();
    // Computed in the page, synchronously (rebuild plan §4).
    const preview = async (layout?: Layout, shape?: BoardShape, converter?: ConverterRule): Promise<PreparedVector> => {
      guard();
      return prepareVector({ ...state, ...(layout ? { layout: cloneDeep(layout) } : {}), ...(shape ? { shape } : {}), ...(converter ? { converter } : {}) }, entries,
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
    const supply = this.supplyRules ? supplyHandInfo(this.supplyRules, state.supply ?? initialSupply(this.supplyRules)) : {};
    return { state, prepared, cleared, supply, backlog: abilityBacklog(state, entries), preview, commit: async (layout, shape, converter) => {
      guard();
      // The layout as the trip normalizes it (cards that are gone are dropped, the status cell is the engine's).
      const normalized = await preview(layout, shape, converter);
      guard();
      const next = { ...state, layout: normalized.layout, ...(shape ? { shape } : {}), ...(converter ? { converter: readConverter(converter) } : {}) };
      this.state.set(P.plotVector, next);
      // The view's own write keeps it current: the player goes on arranging without reopening.
      state = next;
      seen = this.changes;
      this.pending = { ...slot!, tree: this.state.snapshotWith(P.plotVector, next), generation };
    } };
  }
}
