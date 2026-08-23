/**
 * Plot Threads P5 — committing a multi-thread proposal into the store
 * (the ordering rules a UI-only implementation got wrong in review: lane demotion,
 * silent cap overflow, cross-batch refs, self references, malformed refs).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { usePlotStore } from './plot-store';
import { commitDecomposedThreads, unresolvedThreadRefs, overCapThreadTitles } from './plot-threads-commit';
import type { DecomposedThread, MultiDecomposeResult } from './plot-decomposer';

type Store = ReturnType<typeof usePlotStore>;

function thread(title: string, over: Partial<DecomposedThread> = {}): DecomposedThread {
  return {
    title, synopsis: '', activation: null, malformedRefs: [],
    nodes: [{ title: `${title}-1`, narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'critical', opportunityTiers: [], maxRounds: 6 },
      { title: `${title}-2`, narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [], maxRounds: 4 }],
    suggestedGauges: [{ name: `${title}度量`, description: '', min: 0, max: 100, current: 10, initialValue: 10, unit: '%', showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25 }],
    ...over,
  };
}
function legacyArc(store: Store, title: string): string {
  const arc = store.createArc(title, '');
  store.addNode(arc.id, { title: `${title}-node`, narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
  return arc.id;
}

describe('commitDecomposedThreads', () => {
  let store: Store;
  beforeEach(() => { setActivePinia(createPinia()); store = usePlotStore(); });

  it('creates arcs with nodes/gauges/colour in proposal order and lanes AFTER existing finite lanes (no demotion of legacy arcs)', () => {
    const legacy = legacyArc(store, '旧线');           // lane undefined (sorts last)
    const laned = legacyArc(store, '有 lane 的线');
    store.updateArc(laned, { lane: 4 });
    const proposal: MultiDecomposeResult = { threads: [thread('A', { color: '#abc' }), thread('B')] };
    const res = commitDecomposedThreads(store, proposal, { round: 3, maxActiveThreads: 3 });
    expect(res.createdIds).toHaveLength(2);
    const a = store.arcs.find(x => x.id === res.createdIds[0])!;
    const b = store.arcs.find(x => x.id === res.createdIds[1])!;
    expect(a.nodes.map(n => n.title)).toEqual(['A-1', 'A-2']);
    expect(a.gauges[0].name).toBe('A度量');
    expect(a.color).toBe('#abc');
    expect([a.lane, b.lane]).toEqual([5, 6]);        // after max(4) → never below a legacy arc's explicit lane
    expect(store.arcs.find(x => x.id === legacy)!.lane).toBeUndefined();
  });

  it('immediate threads activate up to the cap (first takes focus); the overflow is reported, not silently dropped', () => {
    const existing = legacyArc(store, '已活跃');
    store.activateArc(existing, { round: 1, maxActiveThreads: 2 });
    const res = commitDecomposedThreads(store, { threads: [thread('A'), thread('B'), thread('C')] }, { round: 5, maxActiveThreads: 2 });
    const byTitle = (t: string) => store.arcs.find(x => x.title === t)!;
    expect(byTitle('A').status).toBe('active');
    expect(byTitle('B').status).toBe('draft');
    expect(byTitle('C').status).toBe('draft');
    expect(res.stranded).toEqual(['B', 'C']);
    expect(store.focusArcId).toBe(byTitle('A').id);   // user-initiated batch → first immediate thread takes focus
    expect(byTitle('A').nodes[0].activatedAtRound).toBe(5);
    expect(overCapThreadTitles([thread('A'), thread('B'), thread('C')], 1, 2)).toEqual(['B', 'C']);
  });

  it('after_thread / after_node may reference PRE-EXISTING arcs (the ledger the model was shown), not only the batch', () => {
    const old = legacyArc(store, '旧线');
    const oldNodeId = store.arcs.find(a => a.id === old)!.nodes[0].id;
    const res = commitDecomposedThreads(store, { threads: [
      thread('S1', { activation: [{ after_thread: '旧线' }] }),
      thread('S2', { activation: [{ after_node: '旧线/旧线-node' }, { at_round: 20 }] }),
      thread('S3', { activation: [{ after_node: 'S1/S1-2' }] }),   // same batch
    ] }, { round: 1, maxActiveThreads: 3 });
    expect(res.unresolved).toEqual({});
    const s1 = store.arcs.find(a => a.title === 'S1')!;
    const s2 = store.arcs.find(a => a.title === 'S2')!;
    const s3 = store.arcs.find(a => a.title === 'S3')!;
    expect(s1.status).toBe('scheduled');
    expect(s1.activation?.triggers).toEqual([{ type: 'thread_completed', arcId: old }]);
    expect(s2.activation?.triggers).toEqual([{ type: 'node_completed', arcId: old, nodeId: oldNodeId }, { type: 'round_reached', round: 20 }]);
    expect(s3.activation?.triggers).toEqual([{ type: 'node_completed', arcId: s1.id, nodeId: s1.nodes[1].id }]);
  });

  it('unresolved, self-referencing or malformed refs leave the thread as draft and are reported', () => {
    const res = commitDecomposedThreads(store, { threads: [
      thread('X', { activation: [{ after_thread: '不存在' }] }),
      thread('Y', { activation: [{ after_thread: 'Y' }] }),
      thread('Z', { malformedRefs: ['{"at_round":"abc"}'] }),
    ] }, { round: 1, maxActiveThreads: 3 });
    expect(store.arcs.map(a => a.status)).toEqual(['draft', 'draft', 'draft']);
    expect(res.unresolved).toEqual({ X: ['不存在'], Y: ['Y'], Z: ['{"at_round":"abc"}'] });
    expect(res.stranded).toEqual([]);
  });

  it('persists through the store snapshot (activeArcIndex mirrors the focus thread)', () => {
    commitDecomposedThreads(store, { threads: [thread('A')] }, { round: 1, maxActiveThreads: 3 });
    const snap = store.toStateSnapshot();
    expect(snap.focusArcId).toBe(store.arcs[0].id);
    expect(snap.activeArcIndex).toBe(0);
  });
});

describe('unresolvedThreadRefs (preview parity with commit)', () => {
  it('accepts refs into the batch or existing arcs; flags missing, self and malformed', () => {
    const batch = [thread('A'), thread('B', { activation: [{ after_node: 'A/A-1' }] })];
    const existing = [{ title: '旧线', nodes: [{ title: '旧节点' }] }] as unknown as Array<{ title: string; nodes: Array<{ title: string }> }>;
    const cast = existing as unknown as Parameters<typeof unresolvedThreadRefs>[2];
    expect(unresolvedThreadRefs(batch[1], batch, cast)).toEqual([]);
    expect(unresolvedThreadRefs(thread('C', { activation: [{ after_node: '旧线/旧节点' }] }), batch, cast)).toEqual([]);
    expect(unresolvedThreadRefs(thread('C', { activation: [{ after_thread: 'C' }] }), batch, cast)).toEqual(['C']);
    expect(unresolvedThreadRefs(thread('C', { activation: [{ after_node: 'A/没有' }, { at_round: 9 }] }), batch, cast)).toEqual(['A/没有']);
    expect(unresolvedThreadRefs(thread('C', { malformedRefs: ['bad'] }), batch, cast)).toEqual(['bad']);
  });
});
