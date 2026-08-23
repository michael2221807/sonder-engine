// Design: docs/design/plot-direction-system.md
// Design (threads): docs/design/plot-parallel-threads-scheduler.md §4.2 / §8 (joint context · independent verdicts · deterministic sequencing)
// App doc: docs/user-guide/pages/game-plot.md
/**
 * Plot Direction System — Evaluation Sub-Pipeline
 *
 * Dispatched by GameOrchestrator after each main round. For EVERY active
 * thread it reads that thread's verdict from the AI's `plot_evaluation`
 * array, applies gauge updates, checks boundary events, evaluates completion
 * conditions and advances the node chain. Then it scans `scheduled` threads
 * and activates those whose triggers hold (design D3) — cross-thread
 * sequencing is decided here, never by the AI (§8.1).
 *
 * All mutations are performed on a deep-cloned working copy and written
 * back atomically at the end to avoid partial-state reactive emissions.
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type {
  PlotDirectionState,
  NormalizedPlotState,
  PlotArc,
  PlotNode,
  PlotGauge,
  PlotEvaluation,
  PlotEvalLog,
  PlotNodeEvent,
  GameTimeStamp,
  GaugeCondition,
} from './types';
import {
  evaluateGaugeCondition,
  normalizePlotState,
  coerceStoredEvaluations,
  resolveFocusArc,
  getActiveArcs,
  DEFAULT_MAX_ACTIVE_THREADS,
} from './types';
import { collectActiveGauges, evaluateThreadActivation } from './thread-trigger';
import { readGameTimeStamp } from './game-time-stamp';
import _cloneDeep from 'lodash-es/cloneDeep';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_OPPORTUNITY_MAX_TIER = 3;
const EVAL_LOG_MAX = 30;

interface PlotSettingsFromState {
  enabled?: boolean;
  criticalConfirmGate?: boolean;
  confidenceThreshold?: number;
  opportunityMaxTier?: number;
  autoAdvanceSkippable?: boolean;
  maxActiveThreads?: number;
}

/** Per-run working context shared by the private steps. */
interface RunCtx {
  state: NormalizedPlotState;
  round: number;
  time: GameTimeStamp | undefined;
  logs: PlotEvalLog[];
}

/** Lane order, array order as tie-break — the order threads are evaluated and reported. */
function byLane(arcs: PlotArc[]): PlotArc[] {
  return [...arcs].sort((p, q) => (p.lane ?? Infinity) - (q.lane ?? Infinity));
}

export class PlotEvaluationPipeline {
  constructor(
    private stateManager: StateManager,
    private paths: EnginePathConfig,
  ) {}

  private getSettings(): PlotSettingsFromState {
    return this.stateManager.get<PlotSettingsFromState>('系统.设置.plot') ?? {};
  }

  async execute(): Promise<boolean> {
    const settings = this.getSettings();

    // Kill switch: if plot system is disabled, skip entirely
    if (settings.enabled === false) return false;

    const rawState = this.stateManager.get<PlotDirectionState>(this.paths.plotDirection);
    if (!rawState) return false;

    // Deep clone to avoid partial-state reactive emissions (R-Issue2); fold
    // legacy single-thread fields into the multi-thread shape.
    const state: NormalizedPlotState = normalizePlotState(_cloneDeep(rawState));
    const activeArcs = byLane(getActiveArcs(state));
    const hasScheduled = state.arcs.some(a => a.status === 'scheduled');
    if (activeArcs.length === 0 && !hasScheduled) return false;

    const ctx: RunCtx = {
      state,
      round: this.stateManager.get<number>(this.paths.roundNumber) ?? 0,
      time: readGameTimeStamp(this.stateManager, this.paths),
      logs: [],
    };

    // Verdicts written by post-process (array; legacy saves may hold one object).
    const storedEvals = coerceStoredEvaluations(
      this.stateManager.get<unknown>(this.paths.plotDirection + '._lastEvaluation'),
    );

    // ── Per-thread evaluation: joint context, independent verdicts (§8) ──
    // Note on order: threads are evaluated sequentially in lane order. A later
    // thread's gaugeEffects may push an EARLIER thread's gauge past a boundary;
    // that boundary event then fires on the next round (single pass, accepted
    // by design — do not add a second pass without revisiting §4.2).
    const consumed = new Set<PlotEvaluation>();
    for (const arc of activeArcs) {
      this.evaluateThread(ctx, arc, storedEvals, activeArcs, consumed, settings);
    }

    // §8.4 ② / §9 risk 1: verdicts that matched no active thread (AI typo'd a
    // title, or a duplicate title shadowed them) are dropped — visibly.
    for (const orphan of storedEvals) {
      if (consumed.has(orphan)) continue;
      console.warn(`[PlotEval] dropped plot_evaluation item for unknown thread "${orphan.thread ?? '(none)'}": ${orphan.evidence.slice(0, 60)}`);
      ctx.logs.push({ round: ctx.round, nodeId: '', evaluation: orphan, opportunityTier: null, action: 'none' });
    }

    // ── 9. Scheduled threads: deterministic triggers (D3) ──
    // Runs even when no thread is active so `round_reached` can fire.
    this.activateScheduledThreads(ctx, settings.maxActiveThreads ?? DEFAULT_MAX_ACTIVE_THREADS);

    // ── 10/11. Focus repair + atomic write-back ──
    this.writeBack(state);

    // Transient fields via sub-paths (outside the persisted PlotDirectionState type)
    this.stateManager.set(this.paths.plotDirection + '._lastEvaluation', null, 'system');

    if (ctx.logs.length > 0) {
      const logPath = this.paths.plotDirection + '._evalLog';
      const existingLog = this.stateManager.get<PlotEvalLog[]>(logPath) ?? [];
      const newLog = [...existingLog, ...ctx.logs];
      if (newLog.length > EVAL_LOG_MAX) newLog.splice(0, newLog.length - EVAL_LOG_MAX);
      this.stateManager.set(logPath, newLog, 'system');
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  One thread
  // ═══════════════════════════════════════════════════════════════

  /**
   * Pick this thread's verdict. Id match first, then title — but a title that
   * several ACTIVE threads share is ambiguous and is not trusted (warned once
   * per thread). Each stored item is consumed at most once, so two threads can
   * never apply the same verdict. An item WITHOUT a `thread` key (legacy
   * single-object contract) is only accepted when exactly one thread is active
   * — with several, an unattributed verdict is dropped rather than guessed (§8.4 ②).
   */
  private pickVerdict(
    storedEvals: PlotEvaluation[],
    arc: PlotArc,
    activeArcs: PlotArc[],
    consumed: Set<PlotEvaluation>,
  ): PlotEvaluation | null {
    const free = storedEvals.filter(e => !consumed.has(e));
    let hit = free.find(e => e.thread === arc.id);
    if (!hit) {
      const titleShared = activeArcs.filter(a => a.title === arc.title).length > 1;
      if (titleShared) {
        console.warn(`[PlotEval] thread title "${arc.title}" is shared by several active threads — verdicts for it are matched by id only`);
      } else {
        hit = free.find(e => e.thread === arc.title);
      }
    }
    if (!hit && activeArcs.length === 1) hit = free.find(e => e.thread === undefined);
    if (hit) consumed.add(hit);
    return hit ?? null;
  }

  private evaluateThread(
    ctx: RunCtx,
    arc: PlotArc,
    storedEvals: PlotEvaluation[],
    activeArcs: PlotArc[],
    consumed: Set<PlotEvaluation>,
    settings: PlotSettingsFromState,
  ): void {
    const { state, round } = ctx;
    const node = arc.nodes.find((n: PlotNode) => n.status === 'active');
    if (!node) return;

    if (node.activatedAtRound == null) {
      node.activatedAtRound = round;
    }

    // ── 0. Pending player confirmation for THIS thread (GAP-03 review fix) ──
    // Shared with the immediate UI path (applyConfirmedAdvancement) so both
    // advance identically. A confirmed-and-matched node consumes this round's
    // evaluation; a stale confirmation is discarded and normal evaluation runs.
    if (state.pendingConfirmations.some(g => g.arcId === arc.id && g.confirmed)) {
      const gate = state.pendingConfirmations.find(g => g.arcId === arc.id);
      if (this.consumeConfirmation(ctx, arc, node, gate?.evidence)) {
        ctx.logs.push({ round, arcId: arc.id, nodeId: node.id, evaluation: null, opportunityTier: null, action: 'advance' });
        return;
      }
    }

    const lastEval = this.pickVerdict(storedEvals, arc, activeArcs, consumed);

    // ── 1. Apply gauge updates from AI ──
    if (lastEval?.gauge_updates) {
      this.applyGaugeUpdates(state, arc, lastEval.gauge_updates);
    }

    // ── 2. Apply autoDecrement ──
    this.applyAutoDecrements(arc, round);

    // ── 3. Evaluate node completion ──
    let action: PlotEvalLog['action'] = 'none';
    const elapsed = round - (node.activatedAtRound ?? round);

    const confidenceThreshold = settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    // Reset on null eval too — "consecutive" means no gaps (R-Issue3)
    if (lastEval && lastEval.node_reached && lastEval.confidence >= confidenceThreshold) {
      node.consecutiveReachedCount++;
      action = 'count_increment';
    } else {
      if (node.consecutiveReachedCount > 0) {
        node.consecutiveReachedCount = 0;
        action = 'count_reset';
      }
    }

    // ── 4. Check advancement conditions (gauge conditions may reference any active thread, G13) ──
    const allGauges = collectActiveGauges(state.arcs);
    const gaugesMet = node.completionConditions.length === 0 ||
      node.completionConditions.every((c: GaugeCondition) => evaluateGaugeCondition(c, allGauges));

    const hintMet = node.completionMode === 'gauges_only'
      ? true
      : node.consecutiveReachedCount >= (node.importance === 'critical' ? 2 : 1);

    const shouldAdvance =
      (node.completionMode === 'hint_only' && hintMet) ||
      (node.completionMode === 'hint_and_gauges' && hintMet && gaugesMet) ||
      (node.completionMode === 'gauges_only' && gaugesMet);

    if (shouldAdvance) {
      const autoAdvanceSkippable = settings.autoAdvanceSkippable !== false;
      if (node.importance === 'skippable' && !autoAdvanceSkippable) {
        // User disabled auto-advance for skippable nodes — treat like critical
        action = 'none';
      } else if (node.importance === 'critical' && (settings.criticalConfirmGate !== false)) {
        // One gate per thread (G7): replace any stale gate for this arc.
        state.pendingConfirmations = [
          ...state.pendingConfirmations.filter(g => g.arcId !== arc.id),
          { arcId: arc.id, nodeId: node.id, evidence: lastEval?.evidence ?? '', round },
        ];
        action = 'advance';
      } else {
        this.advanceNode(ctx, arc, node, lastEval?.evidence);
        action = 'advance';
      }
    }

    // ── 5. Check maxRounds timeout ──
    if (action === 'none' && node.maxRounds && elapsed >= node.maxRounds) {
      if (node.importance === 'skippable') {
        this.skipNode(ctx, arc, node);
        action = 'skip';
      } else {
        action = 'timeout';
      }
    }

    // ── 6. Check gauge boundary events (after all gauge mutations including onComplete effects) ──
    this.checkBoundaryEvents(ctx, arc);

    // ── 7. Determine current opportunity tier ──
    const maxTier = (settings.opportunityMaxTier ?? DEFAULT_OPPORTUNITY_MAX_TIER) as 1 | 2 | 3;
    const activeNode = arc.nodes.find((n: PlotNode) => n.status === 'active');
    const activeElapsed = activeNode?.activatedAtRound != null ? round - activeNode.activatedAtRound : 0;
    const opportunityTier = activeNode ? this.getCurrentTier(activeNode, activeElapsed, maxTier) : null;

    // ── 8. Log entry ──
    ctx.logs.push({ round, arcId: arc.id, nodeId: node.id, evaluation: lastEval, opportunityTier, action });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Scheduled threads (D3)
  // ═══════════════════════════════════════════════════════════════

  private activateScheduledThreads(ctx: RunCtx, maxActiveThreads: number): void {
    const { state, round } = ctx;
    const scheduled = byLane(state.arcs.filter(a => a.status === 'scheduled'));
    for (const arc of scheduled) {
      if (arc.activation?.mode !== 'auto') continue;
      const verdict = evaluateThreadActivation(arc.activation, { arcs: state.arcs, currentRound: round });
      if (!verdict.satisfied) continue;
      if (arc.nodes.length === 0) continue;

      const firstPending = arc.nodes.find(n => n.status === 'pending');
      if (getActiveArcs(state).length >= maxActiveThreads) {
        // Triggers hold but the cap is full — stay scheduled, retry next round.
        ctx.logs.push({ round, arcId: arc.id, nodeId: firstPending?.id ?? '', evaluation: null, opportunityTier: null, action: 'thread_blocked' });
        continue;
      }

      arc.status = 'active';
      if (firstPending) {
        firstPending.status = 'active';
        firstPending.activatedAtRound = round;
        if (ctx.time) firstPending.activatedAtTime = ctx.time;
        if (firstPending.onActivate) this.fireNodeEvent(ctx, arc, firstPending.onActivate);
      }
      // D2 rule ②: automatic activation never steals focus; writeBack() assigns
      // one only if there is none.
      ctx.logs.push({ round, arcId: arc.id, nodeId: firstPending?.id ?? '', evaluation: null, opportunityTier: null, action: 'thread_activated' });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Gauges
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resolve a gauge reference for a thread: this thread's gauges first (by
   * name or id); otherwise another active thread's — but only when the name
   * is unique across all active threads (§4.2 step 1 / §8.4 ④).
   */
  private resolveGauge(state: NormalizedPlotState, arc: PlotArc, ref: string): PlotGauge | null {
    const own = arc.gauges.find(g => g.name === ref || g.id === ref);
    if (own) return own;
    const others = collectActiveGauges(state.arcs).filter(g => g.name === ref || g.id === ref);
    if (others.length === 1) return others[0];
    if (others.length > 1) {
      console.warn(`[PlotEval] gauge "${ref}" is ambiguous across active threads — update dropped`);
    } else {
      console.debug(`[PlotEval] gauge "${ref}" not found on any active thread (thread "${arc.title}") — update dropped`);
    }
    return null;
  }

  private applyGaugeUpdates(
    state: NormalizedPlotState,
    arc: PlotArc,
    updates: NonNullable<PlotEvaluation['gauge_updates']>,
  ): void {
    for (const update of updates) {
      const gauge = this.resolveGauge(state, arc, update.gauge_id);
      if (!gauge || !gauge.aiUpdatable) continue;

      const clampedDelta = Math.max(
        -gauge.maxDeltaPerRound,
        Math.min(gauge.maxDeltaPerRound, update.delta),
      );
      if (clampedDelta !== update.delta) {
        console.debug(`[PlotEval] gauge "${gauge.id}" delta clamped: ${update.delta} → ${clampedDelta}`);
      }
      gauge.current = Math.max(gauge.min, Math.min(gauge.max, gauge.current + clampedDelta));
    }
  }

  private applyAutoDecrements(arc: PlotArc, round: number): void {
    for (const gauge of arc.gauges) {
      if (gauge.autoDecrement == null) continue;
      if (gauge.lastAutoDecrementRound != null && gauge.lastAutoDecrementRound >= round) continue;

      const before = gauge.current;
      gauge.current = Math.max(gauge.min, Math.min(gauge.max, gauge.current - gauge.autoDecrement));
      gauge.lastAutoDecrementRound = round;
      if (gauge.current !== before) {
        console.debug(`[PlotEval] gauge "${gauge.id}" auto-decrement: ${before} → ${gauge.current}`);
      }
    }
  }

  private checkBoundaryEvents(ctx: RunCtx, arc: PlotArc): void {
    const { round } = ctx;
    for (const gauge of arc.gauges) {
      if (gauge.boundaryFiredAtRound != null && gauge.boundaryFiredAtRound >= round) continue;

      if (gauge.current <= gauge.min && gauge.onMinReached) {
        this.fireNodeEvent(ctx, arc, gauge.onMinReached);
        gauge.boundaryFiredAtRound = round;
      } else if (gauge.current >= gauge.max && gauge.onMaxReached) {
        this.fireNodeEvent(ctx, arc, gauge.onMaxReached);
        gauge.boundaryFiredAtRound = round;
      }
    }
  }

  /**
   * Fires a PlotNodeEvent: applies gauge effects (own thread first, then any
   * active thread by unique id — §8.4 ⑤) and writes world events.
   */
  private fireNodeEvent(ctx: RunCtx, arc: PlotArc, event: PlotNodeEvent): void {
    const { state, round } = ctx;
    if (event.gaugeEffects) {
      for (const effect of event.gaugeEffects) {
        const gauge = arc.gauges.find(g => g.id === effect.gaugeId)
          ?? collectActiveGauges(state.arcs).find(g => g.id === effect.gaugeId);
        if (!gauge) continue;
        if (effect.action === 'set') {
          gauge.current = Math.max(gauge.min, Math.min(gauge.max, effect.value));
        } else {
          gauge.current = Math.max(gauge.min, Math.min(gauge.max, gauge.current + effect.value));
        }
      }
    }

    if (event.worldEvent) {
      // GAP-13 fix: field names match EventPanel.normalizeEvent(); the date
      // text is built from the pack's configured time keys.
      const f = this.paths.gameTimeFieldNames;
      const gameTime = this.stateManager.get<Record<string, unknown>>(this.paths.gameTime);
      const timeStr = gameTime
        ? `${gameTime[f.year] ?? ''}年${gameTime[f.month] ?? ''}月${gameTime[f.day] ?? ''}日`
        : '';
      this.stateManager.push(this.paths.worldEvents, {
        id: `plot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        事件名称: event.worldEvent.title,
        事件描述: event.worldEvent.description,
        事件类型: event.worldEvent.type ?? '剧情',
        回合: round,
        发生时间: timeStr,
      }, 'system');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Confirmation gate
  // ═══════════════════════════════════════════════════════════════

  /**
   * Consume a confirmed player confirmation for `arc` against the working state.
   *
   * Returns true and advances the node when the gate is both `confirmed` and
   * still points at the active node; otherwise discards a stale/mismatched
   * gate and returns false. Always mutates `ctx.state` in place — the caller
   * is responsible for writing it back.
   *
   * Shared by both the per-round `execute()` step-0 and the immediate UI path
   * (`applyConfirmedAdvancement`) so the two never diverge.
   */
  private consumeConfirmation(ctx: RunCtx, arc: PlotArc, node: PlotNode | null, evidence?: string): boolean {
    const { state } = ctx;
    const pc = state.pendingConfirmations.find(g => g.arcId === arc.id);
    if (!pc?.confirmed) return false;
    // Either way this thread's gate is consumed — a stale/mismatched one is
    // discarded so the gate cannot re-stick.
    state.pendingConfirmations = state.pendingConfirmations.filter(g => g.arcId !== arc.id);
    if (node && pc.nodeId === node.id) {
      this.advanceNode(ctx, arc, node, evidence ?? pc.evidence);
      return true;
    }
    return false;
  }

  /**
   * D2 focus rule ④/⑤ + deprecated `activeArcIndex` mirror, then one atomic set.
   * Always writes the normalized shape (`pendingConfirmation: null`).
   */
  private writeBack(state: NormalizedPlotState): void {
    const focus = resolveFocusArc(state);
    state.focusArcId = focus?.id ?? null;
    state.activeArcIndex = focus ? state.arcs.indexOf(focus) : null;
    state.pendingConfirmation = null;
    this.stateManager.set(this.paths.plotDirection, state, 'system');
  }

  /**
   * Immediately apply a player-confirmed critical-node advancement.
   *
   * Called from the UI (PlotPanel confirmation gate) the instant the player
   * clicks "确认完成", so the node completes and the next node activates
   * right away — instead of silently waiting for the next main round's
   * `execute()` to consume the `confirmed` flag (which looked like the button
   * did nothing). Reuses `consumeConfirmation`/`advanceNode`, so onComplete /
   * onActivate side-effects and next-node activation are identical to the
   * deferred path. Idempotent: a stale confirmation is cleared, not advanced.
   *
   * @param arcId thread whose gate to apply; defaults to the first confirmed gate.
   * @returns true if a node was advanced, false otherwise.
   */
  applyConfirmedAdvancement(arcId?: string): boolean {
    const rawState = this.stateManager.get<PlotDirectionState>(this.paths.plotDirection);
    if (!rawState) return false;

    const state = normalizePlotState(_cloneDeep(rawState));
    const gate = arcId
      ? state.pendingConfirmations.find(g => g.arcId === arcId)
      : state.pendingConfirmations.find(g => g.confirmed);
    if (!gate?.confirmed) return false;
    const arc = state.arcs.find(a => a.id === gate.arcId);
    if (!arc || arc.status !== 'active') return false;

    const node = arc.nodes.find((n: PlotNode) => n.status === 'active') ?? null;
    const ctx: RunCtx = {
      state,
      round: this.stateManager.get<number>(this.paths.roundNumber) ?? 0,
      time: readGameTimeStamp(this.stateManager, this.paths),
      logs: [],
    };

    const advanced = this.consumeConfirmation(ctx, arc, node);
    // Write back whether we advanced or just cleared a stale confirmation,
    // so the gate closes and the UI store re-syncs from the state tree.
    this.writeBack(state);
    return advanced;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Node transitions
  // ═══════════════════════════════════════════════════════════════

  private advanceNode(ctx: RunCtx, arc: PlotArc, node: PlotNode, evidence?: string): void {
    node.status = 'completed';
    node.completedAtRound = ctx.round;
    if (ctx.time) node.completedAtTime = ctx.time;
    if (evidence) node.completionEvidence = evidence;

    // Fire onComplete event (R-Issue6)
    if (node.onComplete) {
      this.fireNodeEvent(ctx, arc, node.onComplete);
    }

    this.activateNextPending(ctx, arc, node);
  }

  private skipNode(ctx: RunCtx, arc: PlotArc, node: PlotNode): void {
    node.status = 'skipped';
    node.completedAtRound = ctx.round;
    if (ctx.time) node.completedAtTime = ctx.time;

    // Fire onSkip event (R-Issue6)
    if (node.onSkip) {
      this.fireNodeEvent(ctx, arc, node.onSkip);
    }

    this.activateNextPending(ctx, arc, node);
  }

  private activateNextPending(ctx: RunCtx, arc: PlotArc, currentNode: PlotNode): void {
    const { state, round } = ctx;
    const nextIdx = arc.nodes.indexOf(currentNode) + 1;
    const allGauges = collectActiveGauges(state.arcs);
    let activated = false;
    for (let i = nextIdx; i < arc.nodes.length; i++) {
      const next = arc.nodes[i];
      if (next.status !== 'pending') continue;

      const condsMet = next.activationConditions.length === 0 ||
        next.activationConditions.every((c: GaugeCondition) => evaluateGaugeCondition(c, allGauges));

      if (condsMet) {
        next.status = 'active';
        next.activatedAtRound = round;
        if (ctx.time) next.activatedAtTime = ctx.time;

        // Fire onActivate event
        if (next.onActivate) {
          this.fireNodeEvent(ctx, arc, next.onActivate);
        }

        activated = true;
        break;
      }
    }

    // Check if all nodes are done → complete thread (R-Issue4: use state param).
    // Focus / deprecated activeArcIndex are repaired in writeBack().
    if (!activated) {
      const allDone = arc.nodes.every((n: PlotNode) => n.status === 'completed' || n.status === 'skipped');
      if (allDone) {
        arc.status = 'completed';
        state.pendingConfirmations = state.pendingConfirmations.filter(g => g.arcId !== arc.id);
        ctx.logs.push({ round, arcId: arc.id, nodeId: currentNode.id, evaluation: null, opportunityTier: null, action: 'thread_completed' });
      }
    }
  }

  private getCurrentTier(node: PlotNode, elapsed: number, maxTier: 1 | 2 | 3 = 3): 1 | 2 | 3 | null {
    if (node.opportunityTiers.length === 0) return null;
    let best: 1 | 2 | 3 | null = null;
    for (const t of node.opportunityTiers) {
      if (elapsed >= t.afterRounds && t.tier <= maxTier) best = t.tier;
    }
    return best;
  }
}
