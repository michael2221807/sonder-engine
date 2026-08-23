/**
 * Regression: cross-save evaluation-log leak (2026-07-22).
 *
 * The plot store is an app-lifetime Pinia singleton. Loading a different save
 * replaces the state tree (StateManager.loadTree) but nothing cleared the
 * in-memory evaluationLog / pendingConfirmation / mutex queue — so save B
 * showed save A's evaluation log until save B ran its own first evaluation.
 *
 * Fix: the store subscribes to `engine:state-changed {type:'load'}` (emitted
 * by StateManager.loadTree on every real save load) and clears all in-memory
 * cross-save state at that boundary.
 *
 * Scope note: when save B carries its own persisted `_evalLog`, PlotPanel's
 * async watcher re-syncs it into the store AFTER the synchronous clear below —
 * that panel-side interaction needs a mounted component and is not exercised
 * here; these tests cover the store-side boundary contract only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { usePlotStore } from './plot-store';
import { eventBus } from '../core/event-bus';
import { StateManager } from '../core/state-manager';
import type { PlotEvalLog } from './types';

function makeLogEntry(round: number): PlotEvalLog {
  return { round, nodeId: `node_${round}`, evaluation: null, opportunityTier: null, action: 'none' };
}

describe('plotStore save-load isolation', () => {
  let store: ReturnType<typeof usePlotStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = usePlotStore();
  });

  afterEach(() => {
    // Stops the store's effectScope → onScopeDispose unsubscribes the
    // engine:state-changed listener, so listeners don't pile up on the
    // module-level eventBus singleton across tests.
    store.$dispose();
  });

  it('clears evaluation log when a save is loaded', () => {
    store.pushEvalLog(makeLogEntry(1));
    store.pushEvalLog(makeLogEntry(2));
    expect(store.evaluationLog).toHaveLength(2);

    eventBus.emit('engine:state-changed', { type: 'load' });

    expect(store.evaluationLog).toHaveLength(0);
  });

  it('clears via the real StateManager.loadTree emit (integration)', () => {
    const sm = new StateManager();
    store.pushEvalLog(makeLogEntry(1));
    store.pendingConfirmations = [{ arcId: 'a1', nodeId: 'n1', evidence: 'e', round: 3 }];

    sm.loadTree({ 元数据: {} });

    expect(store.evaluationLog).toHaveLength(0);
    expect(store.pendingConfirmations).toEqual([]);
    expect(store.pendingConfirmation).toBeNull();
  });

  it('clears stale pendingConfirmation when a save is loaded', () => {
    store.pendingConfirmations = [{ arcId: 'a1', nodeId: 'n1', evidence: 'e', round: 3 }];

    eventBus.emit('engine:state-changed', { type: 'load' });

    expect(store.pendingConfirmations).toEqual([]);
    expect(store.pendingConfirmation).toBeNull();
  });

  it('drops (not flushes) mutex-queued ops from the previous save', () => {
    store.setEvaluating(true);
    // Queued while "evaluating" — targets the previous save's arcs
    store.createArc('t', 's');
    const arcId = store.arcs[0].id;
    // insertNode goes through _withMutex → queued, result null
    const queued = store.insertNode(arcId, -1, { title: 'stale' });
    expect(queued).toBeNull();

    eventBus.emit('engine:state-changed', { type: 'load' });

    // setEvaluating(false) after load must not replay the stale op
    store.setEvaluating(false);
    expect(store.arcs[0].nodes).toHaveLength(0);
  });

  it('does not clear the log on non-load state changes (persist round-trips)', () => {
    store.pushEvalLog(makeLogEntry(1));

    eventBus.emit('engine:state-changed', { change: {}, source: 'system' });
    eventBus.emit('engine:state-changed', { type: 'rollback' });

    expect(store.evaluationLog).toHaveLength(1);
  });

  it('loadFromState(undefined) clears pendingConfirmation', () => {
    store.pendingConfirmations = [{ arcId: 'a1', nodeId: 'n1', evidence: 'e', round: 3 }];

    store.loadFromState(undefined);

    expect(store.pendingConfirmations).toEqual([]);
    expect(store.pendingConfirmation).toBeNull();
  });

  it('$dispose unsubscribes the load listener (no zombie handlers)', () => {
    store.pushEvalLog(makeLogEntry(1));
    store.$dispose();

    eventBus.emit('engine:state-changed', { type: 'load' });

    // Disposed store's state must no longer react to the bus
    expect(store.evaluationLog).toHaveLength(1);
  });
});
