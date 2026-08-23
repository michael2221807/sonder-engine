// Design: docs/design/plot-direction-system.md
// Design (threads): docs/design/plot-parallel-threads-scheduler.md §4.1
// App doc: docs/user-guide/pages/game-plot.md §节点链 (Node Chain) — moveNode/insertNode back the drag-reorder + gap-insert UI
/**
 * Plot Direction System — Pinia Store
 *
 * Manages arc (thread) CRUD, the multi-active constraint (`maxActiveThreads`),
 * focus thread, scheduling via triggers, hot-swap operations, gauge management,
 * and the evaluation log ring buffer.
 *
 * Persistent state lives in the game state tree (元数据.剧情导向).
 * Evaluation logs are in-memory only (non-persisted).
 */
import { defineStore } from 'pinia';
import { ref, computed, onScopeDispose } from 'vue';
import type {
  PlotArc,
  PlotNode,
  PlotGauge,
  PlotEvalLog,
  PlotDirectionState,
  PendingNodeConfirmation,
  ThreadActivation,
  GameTimeStamp,
} from './types';
import { generatePlotId, DEFAULT_GAUGE_MAX_DELTA, DEFAULT_MAX_ACTIVE_THREADS, normalizePlotState, pickFocusArc } from './types';
import { pruneDanglingTriggers } from './thread-trigger';
import { eventBus } from '../core/event-bus';

const EVAL_LOG_MAX = 30;

export { DEFAULT_MAX_ACTIVE_THREADS };

export interface ActivateArcOptions {
  /** Current round — stamped onto the first node. */
  round?: number;
  /** Game-time snapshot from `readGameTimeStamp()` — stamped onto the first node. */
  time?: GameTimeStamp;
  /** Concurrency cap (`系统.设置.plot.maxActiveThreads`). */
  maxActiveThreads?: number;
  /**
   * Focus rule (D2 ①/②): a user-initiated activation takes focus; an
   * automatic (trigger) activation only becomes focus when there is none.
   */
  takeFocus?: boolean;
}

export const usePlotStore = defineStore('plot-direction', () => {
  // ─── Reactive state ───
  const arcs = ref<PlotArc[]>([]);
  const focusArcId = ref<string | null>(null);
  const pendingConfirmations = ref<PendingNodeConfirmation[]>([]);
  const evaluationLog = ref<PlotEvalLog[]>([]);
  let _evaluating = false;
  let _pendingOps: Array<() => void> = [];

  // ─── Computed ───
  const activeArcs = computed<PlotArc[]>(() => arcs.value.filter(a => a.status === 'active'));

  /**
   * The focus thread (D2). Name kept from the single-thread era so existing
   * panel code keeps reading "the" arc — it is now the one injected in full.
   */
  const activeArc = computed<PlotArc | null>(() => {
    const byId = focusArcId.value ? arcs.value.find(a => a.id === focusArcId.value) : undefined;
    if (byId && byId.status === 'active') return byId;
    return pickFocusArc(arcs.value);
  });

  /** Active node of the focus thread. */
  const activeNode = computed<PlotNode | null>(() => {
    const arc = activeArc.value;
    if (!arc) return null;
    return arc.nodes.find(n => n.status === 'active') ?? null;
  });

  /** Every active thread's active node — one entry per thread. */
  const activeNodes = computed<Array<{ arc: PlotArc; node: PlotNode }>>(() =>
    activeArcs.value.flatMap(arc => {
      const node = arc.nodes.find(n => n.status === 'active');
      return node ? [{ arc, node }] : [];
    }),
  );

  const hasActiveArc = computed(() => activeArcs.value.length > 0);

  /**
   * @deprecated Single-gate accessor kept for the transition; returns the gate
   * of the focus thread (or the first gate). New code iterates `pendingConfirmations`.
   */
  const pendingConfirmation = computed<PendingNodeConfirmation | null>(() => {
    const focus = activeArc.value;
    return (focus && pendingConfirmations.value.find(g => g.arcId === focus.id))
      ?? pendingConfirmations.value[0]
      ?? null;
  });

  // ─── Focus helpers ───

  /** D2 rule ④/⑤: focus must be an active thread; fall back to the first active (lane order). */
  function _repairFocus(): void {
    const cur = focusArcId.value ? arcs.value.find(a => a.id === focusArcId.value) : undefined;
    if (cur && cur.status === 'active') return;
    focusArcId.value = pickFocusArc(arcs.value)?.id ?? null;
  }

  function setFocus(arcId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc || arc.status !== 'active') return false;
    focusArcId.value = arcId;
    return true;
  }

  // ─── State tree sync ───

  function loadFromState(state: PlotDirectionState | undefined): void {
    if (!state) {
      arcs.value = [];
      focusArcId.value = null;
      pendingConfirmations.value = [];
      return;
    }
    const n = normalizePlotState(state);
    arcs.value = n.arcs;
    focusArcId.value = n.focusArcId;
    pendingConfirmations.value = n.pendingConfirmations;
  }

  function toStateSnapshot(): PlotDirectionState {
    const focus = activeArc.value;
    return {
      arcs: arcs.value,
      // Written for older builds only (deprecated field) — index of the focus thread.
      activeArcIndex: focus ? arcs.value.indexOf(focus) : null,
      focusArcId: focus?.id ?? null,
      pendingConfirmations: pendingConfirmations.value,
      pendingConfirmation: null,
    };
  }

  // ─── Arc CRUD ───

  function createArc(title: string, synopsis: string): PlotArc {
    const arc: PlotArc = {
      id: generatePlotId('arc'),
      title,
      synopsis,
      nodes: [],
      gauges: [],
      status: 'draft',
    };
    arcs.value.push(arc);
    return arc;
  }

  function deleteArc(arcId: string): boolean {
    const idx = arcs.value.findIndex(a => a.id === arcId);
    if (idx === -1) return false;
    const arc = arcs.value[idx];
    if (arc.status === 'active') return false;
    arcs.value.splice(idx, 1);
    const pruned = pruneDanglingTriggers(arcs.value, arcId);
    if (pruned > 0) {
      console.warn(`[PlotStore] deleteArc "${arc.title}": removed ${pruned} trigger(s) on other threads that pointed at it`);
    }
    pendingConfirmations.value = pendingConfirmations.value.filter(g => g.arcId !== arcId);
    if (focusArcId.value === arcId) focusArcId.value = null;
    _repairFocus();
    return true;
  }

  /**
   * Activate a draft / scheduled / abandoned thread.
   * Returns false when the thread is not activatable, has no nodes, or the
   * concurrency cap is reached (callers surface the reason via `activeArcs.length`).
   */
  function activateArc(arcId: string, options: ActivateArcOptions | number = {}): boolean {
    // Legacy positional signature `activateArc(id, round)` → user-initiated.
    const opts: ActivateArcOptions = typeof options === 'number'
      ? { round: options, takeFocus: true }
      : options;
    const cap = opts.maxActiveThreads ?? DEFAULT_MAX_ACTIVE_THREADS;
    if (activeArcs.value.length >= cap) return false;
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    if (arc.status !== 'draft' && arc.status !== 'scheduled' && arc.status !== 'abandoned') return false;
    if (arc.nodes.length === 0) return false;

    // When reactivating an abandoned arc, restore skipped nodes to pending
    if (arc.status === 'abandoned') {
      for (const node of arc.nodes) {
        if (node.status === 'skipped') {
          node.status = 'pending';
          node.consecutiveReachedCount = 0;
        }
      }
    }

    // Evaluate "is there a focus thread right now" BEFORE this arc becomes
    // active — `activeArc` falls back to the first active thread, which would
    // be this very arc once its status flips.
    const hadFocus = !!focusArcId.value
      && arcs.value.some(a => a.id === focusArcId.value && a.status === 'active');

    arc.status = 'active';

    const first = arc.nodes.find(n => n.status === 'pending');
    if (first) {
      first.status = 'active';
      if (opts.round != null) first.activatedAtRound = opts.round;
      if (opts.time) first.activatedAtTime = opts.time;
    }

    const takeFocus = opts.takeFocus ?? true;
    if (takeFocus || !hadFocus) focusArcId.value = arc.id;
    return true;
  }

  /** D3: `draft → scheduled` with its triggers. Empty trigger lists are rejected. */
  function scheduleArc(arcId: string, activation: ThreadActivation): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    if (arc.status !== 'draft' && arc.status !== 'scheduled') return false;
    if (activation.triggers.length === 0) return false;
    arc.activation = { mode: activation.mode, triggers: [...activation.triggers] };
    arc.status = 'scheduled';
    return true;
  }

  /** `scheduled → draft`; the triggers are kept as authored content. */
  function unscheduleArc(arcId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc || arc.status !== 'scheduled') return false;
    arc.status = 'draft';
    return true;
  }

  function abandonArc(arcId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc || arc.status !== 'active') return false;
    arc.status = 'abandoned';
    arc.nodes.forEach(n => {
      if (n.status === 'active') n.status = 'skipped';
    });
    pendingConfirmations.value = pendingConfirmations.value.filter(g => g.arcId !== arcId);
    _repairFocus();
    return true;
  }

  function completeArc(arcId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc || arc.status !== 'active') return false;
    arc.status = 'completed';
    pendingConfirmations.value = pendingConfirmations.value.filter(g => g.arcId !== arcId);
    _repairFocus();
    return true;
  }

  function updateArc(
    arcId: string,
    updates: { title?: string; synopsis?: string; lane?: number; color?: string },
  ): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    if (updates.title !== undefined) arc.title = updates.title;
    if (updates.synopsis !== undefined) arc.synopsis = updates.synopsis;
    if (updates.lane !== undefined) arc.lane = updates.lane;
    if (updates.color !== undefined) arc.color = updates.color;
    return true;
  }

  function reviseArc(arcId: string, fromNodeIndex: number): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    for (let i = fromNodeIndex; i < arc.nodes.length; i++) {
      const node = arc.nodes[i];
      node.status = 'pending';
      node.activatedAtRound = undefined;
      node.completedAtRound = undefined;
      node.activatedAtTime = undefined;
      node.completedAtTime = undefined;
      node.completionEvidence = undefined;
      node.consecutiveReachedCount = 0;
    }
    // Re-activate first pending if arc is active and no active node
    if (arc.status === 'active' && !arc.nodes.some(n => n.status === 'active')) {
      const first = arc.nodes.find(n => n.status === 'pending');
      if (first) first.status = 'active';
    }
    return true;
  }

  // ─── Node CRUD + Hot-Swap ───

  function _withMutex(fn: () => void): void {
    if (_evaluating) {
      _pendingOps.push(fn);
    } else {
      fn();
    }
  }

  function flushPendingOps(): void {
    const ops = _pendingOps.splice(0);
    for (const op of ops) op();
  }

  function addNode(arcId: string, node: Omit<PlotNode, 'id' | 'arcId' | 'status' | 'consecutiveReachedCount'>): PlotNode | null {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return null;

    const full: PlotNode = {
      ...node,
      id: generatePlotId('node'),
      arcId,
      status: 'pending',
      consecutiveReachedCount: 0,
      completionConditions: node.completionConditions ?? [],
      activationConditions: node.activationConditions ?? [],
      completionMode: node.completionMode ?? 'hint_only',
      opportunityTiers: node.opportunityTiers ?? [],
      importance: node.importance ?? 'skippable',
    };
    arc.nodes.push(full);
    return full;
  }

  /**
   * Last index still occupied by a non-pending node (active/completed/skipped).
   * A pending node placed at or before this index is unreachable: the
   * evaluation pipeline's activateNextPending only scans forward from the
   * node that just completed, so it would never activate.
   */
  function _reachableFloor(nodes: PlotNode[]): number {
    return nodes.reduce((max, n, i) => (n.status !== 'pending' ? i : max), -1);
  }

  function insertNode(arcId: string, afterIndex: number, node: Partial<PlotNode>): PlotNode | null {
    let result: PlotNode | null = null;
    _withMutex(() => {
      const arc = arcs.value.find(a => a.id === arcId);
      if (!arc) return;

      const full: PlotNode = {
        id: generatePlotId('node'),
        arcId,
        title: node.title ?? '',
        narrativeGoal: node.narrativeGoal ?? '',
        directive: node.directive ?? '',
        completionHint: node.completionHint ?? '',
        completionConditions: node.completionConditions ?? [],
        completionMode: node.completionMode ?? 'hint_only',
        activationConditions: node.activationConditions ?? [],
        maxRounds: node.maxRounds,
        importance: node.importance ?? 'skippable',
        opportunityTiers: node.opportunityTiers ?? [],
        emotionalTone: node.emotionalTone,
        premise: node.premise,
        stakes: node.stakes,
        onComplete: node.onComplete,
        onActivate: node.onActivate,
        onSkip: node.onSkip,
        status: 'pending',
        consecutiveReachedCount: 0,
      };

      // Clamp into the reachable zone instead of rejecting — the caller has
      // already collected user-typed node content that must not be lost.
      const insertAt = Math.max(
        _reachableFloor(arc.nodes) + 1,
        Math.min(afterIndex + 1, arc.nodes.length),
      );
      arc.nodes.splice(insertAt, 0, full);
      result = full;
    });
    return result;
  }

  function removeNode(arcId: string, nodeId: string): boolean {
    let removed = false;
    _withMutex(() => {
      const arc = arcs.value.find(a => a.id === arcId);
      if (!arc) return;
      const idx = arc.nodes.findIndex(n => n.id === nodeId);
      if (idx === -1) return;
      if (arc.nodes[idx].status !== 'pending') return;
      arc.nodes.splice(idx, 1);
      removed = true;
    });
    return removed;
  }

  /**
   * Move a pending node so it ends up at `newIndex` in the resulting array
   * (final-resting-index semantics — callers do not need to compensate for
   * the removal shift when moving a node downward).
   *
   * Rejected when the node is not pending, or when the target position falls
   * inside the non-pending prefix (see _reachableFloor).
   */
  function moveNode(arcId: string, nodeId: string, newIndex: number): boolean {
    let moved = false;
    _withMutex(() => {
      const arc = arcs.value.find(a => a.id === arcId);
      if (!arc) return;
      const idx = arc.nodes.findIndex(n => n.id === nodeId);
      if (idx === -1 || arc.nodes[idx].status !== 'pending') return;

      const [node] = arc.nodes.splice(idx, 1);
      if (newIndex <= _reachableFloor(arc.nodes)) {
        arc.nodes.splice(idx, 0, node);
        return;
      }
      arc.nodes.splice(Math.min(newIndex, arc.nodes.length), 0, node);
      moved = true;
    });
    return moved;
  }

  function updateNode(arcId: string, nodeId: string, updates: Partial<PlotNode>): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    const node = arc.nodes.find(n => n.id === nodeId);
    if (!node) return false;
    const { id: _id, arcId: _arcId, status: _status, ...safe } = updates;
    Object.assign(node, safe);
    return true;
  }

  // ─── Gauge CRUD ───

  function addGauge(arcId: string, gauge: Omit<PlotGauge, 'id'>): PlotGauge | null {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return null;

    const full: PlotGauge = {
      ...gauge,
      id: generatePlotId('gauge'),
      maxDeltaPerRound: gauge.maxDeltaPerRound ?? DEFAULT_GAUGE_MAX_DELTA,
    };
    arc.gauges.push(full);
    return full;
  }

  function removeGauge(arcId: string, gaugeId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    const idx = arc.gauges.findIndex(g => g.id === gaugeId);
    if (idx === -1) return false;
    arc.gauges.splice(idx, 1);
    return true;
  }

  function updateGauge(arcId: string, gaugeId: string, updates: Partial<PlotGauge>): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    const gauge = arc.gauges.find(g => g.id === gaugeId);
    if (!gauge) return false;
    const { id: _id, ...safe } = updates;
    Object.assign(gauge, safe);
    return true;
  }

  function resetGauge(arcId: string, gaugeId: string): boolean {
    const arc = arcs.value.find(a => a.id === arcId);
    if (!arc) return false;
    const gauge = arc.gauges.find(g => g.id === gaugeId);
    if (!gauge) return false;
    gauge.current = gauge.initialValue;
    gauge.boundaryFiredAtRound = undefined;
    return true;
  }

  // ─── Confirmation gates (critical nodes, one per thread) ───

  function _resolveGateArcId(arcId?: string): string | null {
    if (arcId) return pendingConfirmations.value.some(g => g.arcId === arcId) ? arcId : null;
    return pendingConfirmation.value?.arcId ?? null;
  }

  /**
   * Player confirms critical node advancement for one thread.
   * Sets the gate's `confirmed` flag — the PlotEvaluationPipeline
   * (`applyConfirmedAdvancement` immediately, or `execute()` next round) performs
   * the actual advanceNode() with full side-effects.
   * @param arcId thread whose gate to confirm; defaults to the focus thread's gate.
   */
  function confirmNodeAdvancement(arcId?: string): boolean {
    const id = _resolveGateArcId(arcId);
    if (!id) return false;
    pendingConfirmations.value = pendingConfirmations.value.map(g =>
      g.arcId === id ? { ...g, confirmed: true } : g,
    );
    return true;
  }

  function rejectNodeAdvancement(arcId?: string): void {
    const id = _resolveGateArcId(arcId);
    if (!id) return;
    const gate = pendingConfirmations.value.find(g => g.arcId === id);
    const arc = arcs.value.find(a => a.id === id);
    if (arc && gate) {
      const node = arc.nodes.find(n => n.id === gate.nodeId);
      if (node) node.consecutiveReachedCount = 0;
    }
    pendingConfirmations.value = pendingConfirmations.value.filter(g => g.arcId !== id);
  }

  // ─── Evaluation log (in-memory only) ───

  function pushEvalLog(entry: PlotEvalLog): void {
    evaluationLog.value.push(entry);
    if (evaluationLog.value.length > EVAL_LOG_MAX) {
      evaluationLog.value.shift();
    }
  }

  function clearEvalLog(): void {
    evaluationLog.value = [];
  }

  // ─── Evaluation mutex ───

  function setEvaluating(v: boolean): void {
    _evaluating = v;
    if (!v) flushPendingOps();
  }

  // ─── Save-load boundary cleanup ───

  /**
   * The evaluation log is in-memory (this Pinia singleton outlives save
   * switches) and is deliberately NOT cleared by loadFromState — that runs on
   * every persist() round-trip and must not wipe logs mid-game. Without a
   * dedicated boundary hook, logs from save A stayed visible after loading
   * save B whose state tree has no `_evalLog` (PlotPanel's sync watcher skips
   * undefined). StateManager.loadTree emits `engine:state-changed {type:'load'}`
   * on every real save load (load game / import / new game), which is exactly
   * the boundary where cross-save state must die. Queued mutex ops are dropped,
   * not flushed — they reference the previous save's arcs.
   */
  const unsubscribeLoadListener = eventBus.on<{ type?: string }>('engine:state-changed', (payload) => {
    if (payload?.type !== 'load') return;
    evaluationLog.value = [];
    // Also cleared defensively here: loadFromState fully reassigns it too, but
    // that only runs while PlotPanel is mounted (its watcher owns the call).
    pendingConfirmations.value = [];
    _evaluating = false;
    _pendingOps = [];
  });
  // Pinia runs this setup inside the store's effectScope — tie the listener's
  // lifetime to it so $dispose() (fresh-pinia-per-test setups) unsubscribes.
  onScopeDispose(unsubscribeLoadListener);

  // ─── Reset ───

  function $reset(): void {
    arcs.value = [];
    focusArcId.value = null;
    pendingConfirmations.value = [];
    evaluationLog.value = [];
    _evaluating = false;
    _pendingOps = [];
  }

  return {
    arcs,
    focusArcId,
    pendingConfirmations,
    pendingConfirmation,
    evaluationLog,
    activeArcs,
    activeArc,
    activeNode,
    activeNodes,
    hasActiveArc,

    loadFromState,
    toStateSnapshot,

    createArc,
    deleteArc,
    activateArc,
    scheduleArc,
    unscheduleArc,
    setFocus,
    abandonArc,
    completeArc,
    reviseArc,
    updateArc,

    addNode,
    insertNode,
    removeNode,
    moveNode,
    updateNode,

    addGauge,
    removeGauge,
    updateGauge,
    resetGauge,

    confirmNodeAdvancement,
    rejectNodeAdvancement,

    pushEvalLog,
    clearEvalLog,
    setEvaluating,

    $reset,
  };
});
