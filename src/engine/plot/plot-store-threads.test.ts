/**
 * Plot Threads epic — P0 store behaviour
 * (docs/design/plot-parallel-threads-scheduler.md §3.2 migration, §4.1 store, D2 focus rules).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { usePlotStore, DEFAULT_MAX_ACTIVE_THREADS } from './plot-store';
import type { PlotDirectionState, PlotArc, PlotNode } from './types';
import { normalizePlotState, resolveFocusArc } from './types';

type Store = ReturnType<typeof usePlotStore>;

function seedArc(store: Store, title: string, nodeTitles: string[] = ['n1', 'n2']): PlotArc {
  const arc = store.createArc(title, '');
  for (const t of nodeTitles) {
    store.addNode(arc.id, {
      title: t, narrativeGoal: '', directive: t, completionHint: t,
      completionConditions: [], completionMode: 'hint_only', activationConditions: [],
      importance: 'skippable', opportunityTiers: [],
    });
  }
  return arc;
}

function rawNode(id: string, arcId: string, status: PlotNode['status'] = 'pending'): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: '', directive: '', completionHint: '',
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'critical', opportunityTiers: [], status, consecutiveReachedCount: 0,
  };
}

describe('plotStore — multi-active threads (P0)', () => {
  let store: Store;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = usePlotStore();
  });

  it('allows several active threads up to maxActiveThreads and rejects beyond the cap', () => {
    const a = seedArc(store, 'A');
    const b = seedArc(store, 'B');
    const c = seedArc(store, 'C');
    const d = seedArc(store, 'D');
    expect(store.activateArc(a.id, { round: 1, maxActiveThreads: 3 })).toBe(true);
    expect(store.activateArc(b.id, { round: 1, maxActiveThreads: 3 })).toBe(true);
    expect(store.activateArc(c.id, { round: 1, maxActiveThreads: 3 })).toBe(true);
    expect(store.activateArc(d.id, { round: 1, maxActiveThreads: 3 })).toBe(false);
    expect(store.activeArcs.map(x => x.title)).toEqual(['A', 'B', 'C']);
    expect(store.activeNodes).toHaveLength(3);
    expect(store.activeNodes.every(({ node }) => node.status === 'active')).toBe(true);
  });

  it('uses DEFAULT_MAX_ACTIVE_THREADS when no cap is passed and keeps the legacy (id, round) signature', () => {
    const arcs = Array.from({ length: DEFAULT_MAX_ACTIVE_THREADS + 1 }, (_, i) => seedArc(store, `T${i}`));
    for (let i = 0; i < DEFAULT_MAX_ACTIVE_THREADS; i++) {
      expect(store.activateArc(arcs[i].id, 7)).toBe(true);
    }
    expect(store.activateArc(arcs[DEFAULT_MAX_ACTIVE_THREADS].id, 7)).toBe(false);
    expect(store.arcs[0].nodes[0].activatedAtRound).toBe(7);
  });

  it('stamps activatedAtTime on the first node when a time is supplied', () => {
    const a = seedArc(store, 'A');
    store.activateArc(a.id, { round: 3, time: { year: 1, month: 3, day: 9 } });
    expect(store.arcs[0].nodes[0].activatedAtTime).toEqual({ year: 1, month: 3, day: 9 });
  });

  describe('focus rules (D2)', () => {
    it('① user activation takes focus; ② automatic activation does not steal it', () => {
      const a = seedArc(store, 'A');
      const b = seedArc(store, 'B');
      const c = seedArc(store, 'C');
      store.activateArc(a.id, { takeFocus: true });
      expect(store.focusArcId).toBe(a.id);
      store.activateArc(b.id, { takeFocus: false });
      expect(store.focusArcId).toBe(a.id); // trigger-driven activation keeps focus on A
      store.activateArc(c.id, { takeFocus: true });
      expect(store.focusArcId).toBe(c.id); // user-driven activation moves focus
      expect(store.activeArc?.id).toBe(c.id);
    });

    it('② automatic activation becomes focus only when there is none', () => {
      const a = seedArc(store, 'A');
      store.activateArc(a.id, { takeFocus: false });
      expect(store.focusArcId).toBe(a.id);
    });

    it('③ setFocus only accepts active threads', () => {
      const a = seedArc(store, 'A');
      const b = seedArc(store, 'B');
      store.activateArc(a.id, {});
      expect(store.setFocus(b.id)).toBe(false);
      expect(store.focusArcId).toBe(a.id);
      store.activateArc(b.id, { takeFocus: false });
      expect(store.setFocus(b.id)).toBe(true);
      expect(store.activeArc?.id).toBe(b.id);
    });

    it('④ focus falls to the lowest-lane active thread when the focus thread ends; ⑤ null when none', () => {
      const a = seedArc(store, 'A');
      const b = seedArc(store, 'B');
      const c = seedArc(store, 'C');
      store.updateArc(b.id, { lane: 5 });
      store.updateArc(c.id, { lane: 2 });
      store.activateArc(a.id, {});
      store.activateArc(b.id, { takeFocus: false });
      store.activateArc(c.id, { takeFocus: false });
      expect(store.focusArcId).toBe(a.id);
      // abandonArc exercises the same _repairFocus path completion does
      // (store-level completeArc was removed as dead code, design §9).
      store.abandonArc(a.id);
      expect(store.focusArcId).toBe(c.id); // lane 2 < lane 5
      store.abandonArc(c.id);
      expect(store.focusArcId).toBe(b.id);
      store.abandonArc(b.id);
      expect(store.focusArcId).toBeNull();
      expect(store.activeArc).toBeNull();
    });
  });

  describe('scheduling (D3)', () => {
    it('scheduleArc moves draft → scheduled and rejects empty triggers; unscheduleArc keeps the triggers', () => {
      const a = seedArc(store, 'A');
      const s = seedArc(store, 'S');
      expect(store.scheduleArc(s.id, { mode: 'auto', triggers: [] })).toBe(false);
      expect(store.scheduleArc(s.id, { mode: 'auto', triggers: [{ type: 'thread_completed', arcId: a.id }] })).toBe(true);
      expect(store.arcs.find(x => x.id === s.id)?.status).toBe('scheduled');
      expect(store.unscheduleArc(s.id)).toBe(true);
      const back = store.arcs.find(x => x.id === s.id)!;
      expect(back.status).toBe('draft');
      expect(back.activation?.triggers).toHaveLength(1);
    });

    it('a scheduled thread can still be activated by hand', () => {
      const a = seedArc(store, 'A');
      const s = seedArc(store, 'S');
      store.scheduleArc(s.id, { mode: 'auto', triggers: [{ type: 'thread_completed', arcId: a.id }] });
      expect(store.activateArc(s.id, {})).toBe(true);
    });

    it('deleteArc prunes triggers on other threads that pointed at the deleted one', () => {
      const a = seedArc(store, 'A');
      const s = seedArc(store, 'S');
      store.scheduleArc(s.id, { mode: 'auto', triggers: [
        { type: 'node_completed', arcId: a.id, nodeId: a.nodes[0].id },
        { type: 'round_reached', round: 20 },
      ] });
      expect(store.deleteArc(a.id)).toBe(true);
      expect(store.arcs.find(x => x.id === s.id)?.activation?.triggers).toEqual([{ type: 'round_reached', round: 20 }]);
    });

    it('deleteArc allows deleting a scheduled thread but never an active one', () => {
      const a = seedArc(store, 'A');
      const s = seedArc(store, 'S');
      store.activateArc(a.id, {});
      store.scheduleArc(s.id, { mode: 'auto', triggers: [{ type: 'round_reached', round: 2 }] });
      expect(store.deleteArc(a.id)).toBe(false);
      expect(store.deleteArc(s.id)).toBe(true);
    });
  });

  describe('confirmation gates — one per thread (G7)', () => {
    it('confirm/reject operate on the named thread only', () => {
      store.pendingConfirmations = [
        { arcId: 'a', nodeId: 'n', evidence: 'e', round: 1 },
        { arcId: 'b', nodeId: 'm', evidence: 'e', round: 1 },
      ];
      expect(store.confirmNodeAdvancement('b')).toBe(true);
      expect(store.pendingConfirmations.find(g => g.arcId === 'b')?.confirmed).toBe(true);
      expect(store.pendingConfirmations.find(g => g.arcId === 'a')?.confirmed).toBeUndefined();
      store.rejectNodeAdvancement('a');
      expect(store.pendingConfirmations.map(g => g.arcId)).toEqual(['b']);
      expect(store.confirmNodeAdvancement('zzz')).toBe(false);
    });

    it('without an arcId falls back to the focus thread gate (legacy call sites)', () => {
      const a = seedArc(store, 'A');
      const b = seedArc(store, 'B');
      store.activateArc(a.id, {});
      store.activateArc(b.id, { takeFocus: true });
      store.pendingConfirmations = [
        { arcId: a.id, nodeId: 'x', evidence: '', round: 1 },
        { arcId: b.id, nodeId: 'y', evidence: '', round: 1 },
      ];
      expect(store.pendingConfirmation?.arcId).toBe(b.id);
      store.confirmNodeAdvancement();
      expect(store.pendingConfirmations.find(g => g.arcId === b.id)?.confirmed).toBe(true);
      expect(store.pendingConfirmations.find(g => g.arcId === a.id)?.confirmed).toBeUndefined();
    });

    it('abandoning / completing a thread drops its gate', () => {
      const a = seedArc(store, 'A');
      store.activateArc(a.id, {});
      store.pendingConfirmations = [{ arcId: a.id, nodeId: 'x', evidence: '', round: 1 }];
      store.abandonArc(a.id);
      expect(store.pendingConfirmations).toEqual([]);
    });
  });

  describe('state-tree round trip + legacy migration (§3.2)', () => {
    it('loads a pre-epic save (activeArcIndex + single pendingConfirmation) with identical behaviour', () => {
      const legacy: PlotDirectionState = {
        arcs: [
          { id: 'done', title: 'Done', synopsis: '', status: 'completed', gauges: [], nodes: [rawNode('d1', 'done', 'completed')] },
          { id: 'cur', title: 'Cur', synopsis: '', status: 'active', gauges: [], nodes: [rawNode('c1', 'cur', 'active'), rawNode('c2', 'cur')] },
        ],
        activeArcIndex: 1,
        pendingConfirmation: { arcId: 'cur', nodeId: 'c1', evidence: 'ev', round: 9 },
      };
      store.loadFromState(legacy);
      expect(store.focusArcId).toBe('cur');
      expect(store.activeArc?.id).toBe('cur');
      expect(store.activeNode?.id).toBe('c1');
      expect(store.pendingConfirmations).toEqual([{ arcId: 'cur', nodeId: 'c1', evidence: 'ev', round: 9 }]);
      expect(store.pendingConfirmation?.nodeId).toBe('c1');

      const snap = store.toStateSnapshot();
      expect(snap.activeArcIndex).toBe(1);           // mirrored for older builds
      expect(snap.focusArcId).toBe('cur');
      expect(snap.pendingConfirmation).toBeNull();  // legacy field folded away
      expect(snap.pendingConfirmations).toHaveLength(1);
    });

    it('a legacy activeArcIndex pointing at a non-active arc is ignored; first active wins', () => {
      const state: PlotDirectionState = {
        arcs: [
          { id: 'x', title: 'X', synopsis: '', status: 'draft', gauges: [], nodes: [] },
          { id: 'y', title: 'Y', synopsis: '', status: 'active', gauges: [], nodes: [rawNode('y1', 'y', 'active')] },
        ],
        activeArcIndex: 0,
      };
      expect(resolveFocusArc(state)?.id).toBe('y');
      const n = normalizePlotState(state);
      expect(n.focusArcId).toBe('y');
      expect(n.activeArcIndex).toBe(1);
    });

    it('does not duplicate a legacy gate that already exists in pendingConfirmations', () => {
      const n = normalizePlotState({
        arcs: [], activeArcIndex: null,
        pendingConfirmations: [{ arcId: 'a', nodeId: 'n', evidence: '', round: 1, confirmed: true }],
        pendingConfirmation: { arcId: 'a', nodeId: 'n', evidence: '', round: 1 },
      });
      expect(n.pendingConfirmations).toHaveLength(1);
      expect(n.pendingConfirmations[0].confirmed).toBe(true);
    });

    it('legacy-save focus fallback is lane-aware, same as the store repair (single shared picker)', () => {
      const state: PlotDirectionState = {
        arcs: [
          { id: 'p', title: 'P', synopsis: '', status: 'active', lane: 4, gauges: [], nodes: [rawNode('p1', 'p', 'active')] },
          { id: 'q', title: 'Q', synopsis: '', status: 'active', lane: 1, gauges: [], nodes: [rawNode('q1', 'q', 'active')] },
        ],
        activeArcIndex: null,
      };
      expect(resolveFocusArc(state)?.id).toBe('q');
      store.loadFromState(state);
      expect(store.focusArcId).toBe('q');
    });

    it('snapshot with no active thread writes activeArcIndex null and focusArcId null', () => {
      seedArc(store, 'A');
      const snap = store.toStateSnapshot();
      expect(snap.activeArcIndex).toBeNull();
      expect(snap.focusArcId).toBeNull();
    });
  });
});
