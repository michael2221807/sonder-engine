import { cloneDeep, set } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { eventBus } from '../../engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements } from './saved-elements';
import type { Layout } from '../../engine/plot-vector/core/types';
import { stable } from './genesis/post-save';
import { initialVectorState, type PreparedVector, type VectorState, type VectorOperation, type VectorResult } from './runtime';
import { VectorWorkerClient } from './worker-client';
import { guardedExecutor } from './result-guard';
import { projectNativeInput, type NativeRules } from './native-input';

export interface BoardView {
  state: VectorState;
  prepared: PreparedVector;
  preview(layout: Layout): Promise<PreparedVector>;
  save(layout: Layout): Promise<void>;
}
interface Executor { execute<T extends VectorResult>(op: VectorOperation): Promise<T>; cancelAll(): void }

/** Optional UI port. No model calls, no acceptance hooks, no writes before IDB commit. */
export class VectorBoardAccess {
  private revision = 0;
  private writing = false;
  get isSaving(): boolean { return this.writing; }
  private unsubs: Array<() => void>;
  /** Same host boundary as the main round: a preview never shows or saves an unchecked Worker result. */
  private readonly worker: Executor;
  constructor(private state: StateManager, private saves: Pick<SaveManager, 'assertCurrent' | 'saveGame'>,
    private slot: () => { profileId: string; slotId: string } | null, private busy: () => boolean,
    worker: Executor = new VectorWorkerClient(), private nativeRules?: NativeRules,
    private onSaveSettled: () => void = () => {}) {
    this.worker = guardedExecutor(worker);
    this.unsubs = [subscribePlotVectorControl(() => this.invalidate()),
      eventBus.on<{ type: string }>('engine:state-changed', e => {
        if (e.type === 'load' || e.type === 'rollback') this.invalidate();
      })];
  }
  private invalidate() { this.revision++; this.worker.cancelAll(); }
  dispose() { this.invalidate(); this.unsubs.forEach(fn => fn()); }
  async open(): Promise<BoardView> {
    const slot = this.slot(), control = readPlotVectorControl(), revision = this.revision;
    const snapshot = this.state.toSnapshot(), fingerprint = stable(snapshot);
    const state = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
    const entries = projectSavedElements(snapshot, { includeEnvironment: true }).entries;
    const native = projectNativeInput(snapshot, this.nativeRules);
    const guard = () => {
      const live = readPlotVectorControl();
      if (!slot || this.busy() || !live.enabled || control.epoch !== live.epoch || revision !== this.revision
        || stable(this.slot()) !== stable(slot) || stable(this.state.toSnapshot()) !== fingerprint)
        throw new Error('board-view-stale');
    };
    guard();
    await this.saves.assertCurrent(slot!.profileId, slot!.slotId);
    guard();
    const preview = async (layout?: Layout): Promise<PreparedVector> => {
      guard();
      const result = await this.worker.execute<PreparedVector>({ kind: 'prepare',
        state: { ...state, ...(layout ? { layout: cloneDeep(layout) } : {}) }, entries, native,
        id: `${slot!.profileId}/${slot!.slotId}/${(this.state.get<number>(P.roundNumber) ?? 0) + 1}` });
      guard(); return result;
    };
    const prepared = await preview();
    return { state, prepared, preview, save: async layout => {
      guard();
      if (this.writing) throw new Error('board-save-busy');
      this.writing = true;
      let committed = false, applied = false;
      try {
        const normalized = await preview(layout);
        guard();
        const next = { ...state, layout: normalized.layout };
        const data = cloneDeep(snapshot);
        set(data, P.plotVector, next);
        await this.saves.saveGame(slot!.profileId, slot!.slotId, data, undefined, {
          guard,
          committed: () => {
            committed = true;
            // IDB may finish after the user activates another save. Never copy
            // this old slot's layout into the newly active in-memory tree.
            guard();
            this.state.set(P.plotVector, next);
            applied = true;
            this.invalidate();
          },
        });
      } catch (error) {
        // A metadata failure after the atomic data write must not undo the layout.
        if (!committed || !applied) throw error;
      } finally { this.writing = false; this.onSaveSettled(); }
    } };
  }
}
