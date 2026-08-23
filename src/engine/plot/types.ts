/**
 * Plot Direction System — Type Definitions
 *
 * Data model for the Waypoint Narrative system: arcs, nodes, gauges,
 * conditions, and events. All game-specific content (directive text,
 * gauge descriptions) is opaque string data — the engine never interprets it.
 */

// ═══════════════════════════════════════════════════════════════
//  PlotArc — top-level container
// ═══════════════════════════════════════════════════════════════

/**
 * `scheduled` = waiting for its `activation.triggers` to be satisfied
 * (Plot Threads epic, docs/design/plot-parallel-threads-scheduler.md D3).
 */
export type PlotArcStatus = 'draft' | 'scheduled' | 'active' | 'completed' | 'abandoned';

/**
 * A thread (arc) may be activated automatically when ALL of its triggers hold.
 * Cross-thread sequencing lives here — never in the AI's judgement (§8).
 */
export type ThreadTrigger =
  | { type: 'thread_completed'; arcId: string }
  | { type: 'node_completed'; arcId: string; nodeId: string }
  | { type: 'round_reached'; round: number }
  | { type: 'gauge'; condition: GaugeCondition };

export interface ThreadActivation {
  /** `auto` = pipeline activates when triggers hold; `manual` = triggers are informational only. */
  mode: 'manual' | 'auto';
  /** AND semantics. An empty list never satisfies (UI must not save it). */
  triggers: ThreadTrigger[];
}

export interface PlotArc {
  id: string;
  title: string;
  synopsis: string;
  nodes: PlotNode[];
  gauges: PlotGauge[];
  status: PlotArcStatus;
  /** D3: when/how this thread starts on its own. */
  activation?: ThreadActivation;
  /** Scheduler row order (view only; defaults to array order). */
  lane?: number;
  /** Optional lane colour (CSS color) suggested at decomposition time. */
  color?: string;
}

/**
 * Snapshot of the pack's game-time object at a node transition, using engine
 * keys. Built ONLY via `readGameTimeStamp()` so the Chinese field names stay in
 * `EnginePathConfig.gameTimeFieldNames` (engine/content separation).
 */
export interface GameTimeStamp {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
}

// ═══════════════════════════════════════════════════════════════
//  PlotGauge — global progress bar / meter
// ═══════════════════════════════════════════════════════════════

export interface PlotGauge {
  id: string;
  name: string;
  description: string;

  min: number;
  max: number;
  current: number;
  initialValue: number;

  unit: string;
  color?: string;
  showInMainPanel: boolean;

  aiUpdatable: boolean;
  maxDeltaPerRound: number;
  autoDecrement?: number;
  lastAutoDecrementRound?: number;

  onMinReached?: PlotNodeEvent;
  onMaxReached?: PlotNodeEvent;
  boundaryFiredAtRound?: number;
}

export const DEFAULT_GAUGE_MAX_DELTA = 25;

/** Default for `系统.设置.plot.maxActiveThreads` when the setting is absent (design D2). */
export const DEFAULT_MAX_ACTIVE_THREADS = 3;

// ═══════════════════════════════════════════════════════════════
//  PlotNode — single story waypoint
// ═══════════════════════════════════════════════════════════════

export type PlotNodeStatus = 'pending' | 'active' | 'completed' | 'skipped';

export type CompletionMode = 'hint_only' | 'hint_and_gauges' | 'gauges_only';

export interface PlotNode {
  id: string;
  arcId: string;

  title: string;
  narrativeGoal: string;
  directive: string;

  completionHint: string;
  completionConditions: GaugeCondition[];
  completionMode: CompletionMode;

  activationConditions: GaugeCondition[];

  maxRounds?: number;
  importance: 'critical' | 'skippable';

  opportunityTiers: OpportunityTier[];

  emotionalTone?: string;

  /** Narrative-first authoring (§7.2): the existing fact this node builds on. */
  premise?: string;
  /** Narrative-first authoring (§7.2): what is different in the world once it happens. */
  stakes?: string;

  onComplete?: PlotNodeEvent;
  onActivate?: PlotNodeEvent;
  onSkip?: PlotNodeEvent;

  status: PlotNodeStatus;
  activatedAtRound?: number;
  completedAtRound?: number;
  /** Game-date snapshots for the scheduler's date axis (D4). */
  activatedAtTime?: GameTimeStamp;
  completedAtTime?: GameTimeStamp;
  /** The AI's `evidence` from the round that completed this node (feeds the plot ledger). */
  completionEvidence?: string;
  consecutiveReachedCount: number;
}

// ═══════════════════════════════════════════════════════════════
//  Condition & Opportunity types
// ═══════════════════════════════════════════════════════════════

export type GaugeOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

export interface GaugeCondition {
  gaugeId: string;
  operator: GaugeOperator;
  value: number;
}

export interface OpportunityTier {
  tier: 1 | 2 | 3;
  afterRounds: number;
  prompt: string;
}

// ═══════════════════════════════════════════════════════════════
//  PlotNodeEvent — side-effects on node lifecycle transitions
// ═══════════════════════════════════════════════════════════════

export interface PlotNodeEvent {
  worldEvent?: {
    title: string;
    description: string;
    type?: string;
  };
  gaugeEffects?: {
    gaugeId: string;
    action: 'set' | 'add';
    value: number;
  }[];
  flags?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
//  PlotEvaluation — AI response extension field
// ═══════════════════════════════════════════════════════════════

export interface PlotEvaluation {
  /** Thread title or id this verdict belongs to (absent in the legacy single-thread shape). */
  thread?: string;
  node_reached: boolean;
  confidence: number;
  evidence: string;
  gauge_updates?: {
    gauge_id: string;
    delta: number;
    reason: string;
  }[];
}

export type PlotEvalAction =
  | 'none' | 'count_increment' | 'count_reset' | 'advance' | 'skip' | 'timeout'
  | 'thread_activated' | 'thread_completed' | 'thread_blocked';

export interface PlotEvalLog {
  round: number;
  /** Owning thread — absent only in logs written before the Plot Threads epic. */
  arcId?: string;
  nodeId: string;
  evaluation: PlotEvaluation | null;
  opportunityTier: 1 | 2 | 3 | null;
  action: PlotEvalAction;
}

// ═══════════════════════════════════════════════════════════════
//  Plot state tree shape (stored at 元数据.剧情导向)
// ═══════════════════════════════════════════════════════════════

/**
 * Persisted shape at 元数据.剧情导向.
 *
 * Note: `_lastEvaluation` is a transient write-only field written directly to the
 * state tree path `元数据.剧情导向._lastEvaluation` by PostProcess and consumed
 * by PlotEvaluationPipeline. It is NOT managed by the store's load/snapshot cycle.
 */
export interface PlotDirectionState {
  arcs: PlotArc[];
  /**
   * @deprecated Since the Plot Threads epic "active" is derived from
   * `arc.status === 'active'` (several arcs may be active). Still WRITTEN on
   * every snapshot as the index of the focus thread so older builds that read
   * it keep working; never read it for logic — use `normalizePlotState()`.
   */
  activeArcIndex: number | null;
  /** D2: the thread injected in full; others are injected as one-line background. */
  focusArcId?: string | null;
  /** G7: one critical-node gate per thread. */
  pendingConfirmations?: PendingNodeConfirmation[];
  /** @deprecated Legacy single gate; migrated into `pendingConfirmations` by `normalizePlotState()`. */
  pendingConfirmation?: PendingNodeConfirmation | null;
}

export interface PendingNodeConfirmation {
  arcId: string;
  nodeId: string;
  evidence: string;
  round: number;
  confirmed?: boolean;
}

/** `PlotDirectionState` with the legacy fields already folded in. */
export interface NormalizedPlotState extends PlotDirectionState {
  focusArcId: string | null;
  pendingConfirmations: PendingNodeConfirmation[];
}

export function getActiveArcs(state: Pick<PlotDirectionState, 'arcs'> | undefined): PlotArc[] {
  return (state?.arcs ?? []).filter(a => a.status === 'active');
}

/**
 * D2 focus rule ④: when focus must be reassigned, the active thread with the
 * lowest `lane` wins (array order breaks ties; threads without a lane sort last).
 * The single implementation shared by store, pipeline and injector.
 */
export function pickFocusArc(arcs: PlotArc[]): PlotArc | null {
  const active = arcs.filter(a => a.status === 'active');
  if (active.length === 0) return null;
  return active.reduce((best, a) =>
    (a.lane ?? Infinity) < (best.lane ?? Infinity) ? a : best,
  );
}

/**
 * Resolve the focus thread: explicit `focusArcId` if it points at an active arc,
 * else the legacy `activeArcIndex` if that arc is active, else `pickFocusArc()`.
 */
export function resolveFocusArc(state: PlotDirectionState | undefined): PlotArc | null {
  if (!state) return null;
  const byId = state.focusArcId ? state.arcs.find(a => a.id === state.focusArcId) : undefined;
  if (byId && byId.status === 'active') return byId;
  const byIdx = state.activeArcIndex != null ? state.arcs[state.activeArcIndex] : undefined;
  if (byIdx && byIdx.status === 'active') return byIdx;
  return pickFocusArc(state.arcs);
}

/**
 * Fold the pre-epic single-thread fields into the multi-thread shape.
 * Pure: returns a shallow copy; `arcs` is shared (callers that mutate must clone).
 *
 * Migration rules (design §3.2):
 * - `pendingConfirmation` (single) → appended to `pendingConfirmations` unless a
 *   gate for the same arc already exists.
 * - `focusArcId` ← `resolveFocusArc()` so a save written by an older build
 *   (`activeArcIndex` only) keeps the same focus.
 */
export function normalizePlotState(state: PlotDirectionState | undefined): NormalizedPlotState {
  const arcs = state?.arcs ?? [];
  const gates: PendingNodeConfirmation[] = [...(state?.pendingConfirmations ?? [])];
  const legacy = state?.pendingConfirmation;
  if (legacy && !gates.some(g => g.arcId === legacy.arcId)) gates.push(legacy);
  const focus = resolveFocusArc(state ? { ...state, arcs } : undefined);
  return {
    ...(state ?? { activeArcIndex: null }),
    arcs,
    activeArcIndex: focus ? arcs.indexOf(focus) : null,
    focusArcId: focus?.id ?? null,
    pendingConfirmations: gates,
    pendingConfirmation: null,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════════════════

export function evaluateGaugeCondition(
  condition: GaugeCondition,
  gauges: PlotGauge[],
): boolean {
  const gauge = gauges.find(g => g.id === condition.gaugeId);
  if (!gauge) return false;

  switch (condition.operator) {
    case 'gt':  return gauge.current > condition.value;
    case 'gte': return gauge.current >= condition.value;
    case 'lt':  return gauge.current < condition.value;
    case 'lte': return gauge.current <= condition.value;
    case 'eq':  return gauge.current === condition.value;
    case 'neq': return gauge.current !== condition.value;
    default:    return false;
  }
}

function validateGaugeUpdates(
  raw: unknown,
): PlotEvaluation['gauge_updates'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: NonNullable<PlotEvaluation['gauge_updates']> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r['gauge_id'] !== 'string' || typeof r['delta'] !== 'number') continue;
    valid.push({
      gauge_id: r['gauge_id'],
      delta: r['delta'],
      reason: typeof r['reason'] === 'string' ? r['reason'] : '',
    });
  }
  return valid.length > 0 ? valid : undefined;
}

function parseEvaluationItem(
  raw: unknown,
  topLevelGaugeUpdates: unknown,
): PlotEvaluation | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['node_reached'] !== 'boolean') return null;
  if (typeof obj['confidence'] !== 'number') return null;
  // gauge_updates may be nested inside the item or (legacy single shape) at the top level
  const gaugeUpdates = validateGaugeUpdates(obj['gauge_updates'])
    ?? validateGaugeUpdates(topLevelGaugeUpdates);
  const thread = typeof obj['thread'] === 'string' && obj['thread'].trim()
    ? obj['thread'].trim()
    : undefined;
  return {
    ...(thread ? { thread } : {}),
    node_reached: obj['node_reached'],
    confidence: obj['confidence'],
    evidence: typeof obj['evidence'] === 'string' ? obj['evidence'] : '',
    gauge_updates: gaugeUpdates,
  };
}

/**
 * Extract every per-thread verdict from the AI's custom fields.
 *
 * Accepts the multi-thread array contract (`plot_evaluation: [{thread, …}]`)
 * AND the legacy single object (`plot_evaluation: {…}`, no `thread`), which is
 * returned as a one-element array. Invalid items are dropped, never coerced.
 * Top-level `gauge_updates` is only honoured for the legacy single shape —
 * in the array shape it is ambiguous which thread it belongs to.
 */
export function extractPlotEvaluations(
  customFields: Record<string, unknown> | undefined,
): PlotEvaluation[] {
  if (!customFields) return [];
  const raw = customFields['plot_evaluation'];
  if (Array.isArray(raw)) {
    return raw
      .map(item => parseEvaluationItem(item, undefined))
      .filter((e): e is PlotEvaluation => e !== null);
  }
  const single = parseEvaluationItem(raw, customFields['gauge_updates']);
  return single ? [single] : [];
}

/**
 * Legacy single-verdict accessor — first verdict or null.
 * @deprecated Use `extractPlotEvaluations()`; kept for callers that predate threads.
 */
export function extractPlotEvaluation(
  customFields: Record<string, unknown> | undefined,
): PlotEvaluation | null {
  return extractPlotEvaluations(customFields)[0] ?? null;
}

/**
 * Normalise whatever is stored at `<plotDirection>._lastEvaluation`:
 * post-process now writes an array, older saves/mid-round rollbacks may hold
 * a single object or null.
 */
export function coerceStoredEvaluations(raw: unknown): PlotEvaluation[] {
  if (Array.isArray(raw)) return raw.filter((e): e is PlotEvaluation => !!e && typeof e === 'object');
  if (raw && typeof raw === 'object') return [raw as PlotEvaluation];
  return [];
}

export function generatePlotId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
