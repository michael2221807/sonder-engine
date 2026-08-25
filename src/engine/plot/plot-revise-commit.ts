// App doc: docs/user-guide/pages/game-plot.md §弹窗 7：续写 / 改写
// Design: docs/design/plot-arc-revise-extend.md §3.4 (commit rules 1-7)
/**
 * Plot Revise & Extend — commit a revision proposal into the store.
 *
 * Extracted from the panel so the rules are unit-testable without Vue:
 *  1. optional synopsis / active-node text update (D1: content only);
 *  2. the pending region is REPLACED; a proposal node whose title matches an
 *     existing pending node keeps that node's id (cross-thread `node_completed`
 *     triggers and card exports reference node ids) and its authored wiring
 *     (conditions / events / completionMode / tiers when the AI gave none);
 *  3. gauges are replaced by NAME with the same id-keeping rule; played-out
 *     `current` survives unless the model emitted one explicitly (D4);
 *  4. every reference a removal dangles is pruned AND reported, never silent;
 *  5. an empty node list is only legal on an active thread ("cut the future");
 *  6. an optimistic lock (pending-id snapshot) rejects a proposal generated
 *     against a pending region that has since changed.
 */
import type { usePlotStore } from './plot-store';
import type { PlotArc, PlotGauge, PlotNode } from './types';
import { generatePlotId, DEFAULT_GAUGE_MAX_DELTA } from './types';
import {
  pruneDanglingNodeTriggers,
  pruneDanglingGaugeRefs,
  type DanglingGaugeReport,
} from './thread-trigger';
import type { ReviseResult, ReviseGauge, ActiveNodeUpdate } from './plot-reviser';

export interface CommitReviseOptions {
  /** Pending-node ids (in order) captured when the proposal was generated (§3.5 optimistic lock). */
  expectedPendingIds?: string[];
}

export type CommitReviseError = 'not_found' | 'not_revisable' | 'stale' | 'empty_nodes' | 'busy';

export interface CommitReviseReport {
  ok: boolean;
  error?: CommitReviseError;
  keptNodeIds: string[];
  newNodeIds: string[];
  removedNodeIds: string[];
  updatedGaugeNames: string[];
  newGaugeNames: string[];
  removedGaugeNames: string[];
  danglingTriggers: Array<{ arcTitle: string; removed: number }>;
  danglingGaugeRefs: DanglingGaugeReport;
}

function emptyReport(): CommitReviseReport {
  return {
    ok: false,
    keptNodeIds: [], newNodeIds: [], removedNodeIds: [],
    updatedGaugeNames: [], newGaugeNames: [], removedGaugeNames: [],
    danglingTriggers: [],
    danglingGaugeRefs: { triggers: 0, conditions: 0, effects: 0, affected: [] },
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Build the replacement pending region, pairing proposal nodes with existing pending nodes by title. */
function buildRegion(
  arc: PlotArc,
  proposal: ReviseResult['nodes'],
): { region: PlotNode[]; keptIds: string[]; newIds: string[]; removedIds: string[] } {
  const pending = arc.nodes.filter(n => n.status === 'pending');
  const consumed = new Set<string>();
  const region: PlotNode[] = [];
  const keptIds: string[] = [];
  const newIds: string[] = [];

  for (const p of proposal) {
    const match = pending.find(n => !consumed.has(n.id) && n.title.trim() === p.title.trim());
    if (match) {
      consumed.add(match.id);
      keptIds.push(match.id);
      region.push({
        ...match,
        // Content comes from the proposal (the AI saw every content field, §3.2)…
        title: p.title,
        premise: p.premise,
        narrativeGoal: p.narrativeGoal,
        directive: p.directive,
        stakes: p.stakes,
        completionHint: p.completionHint,
        emotionalTone: p.emotionalTone,
        importance: p.importance,
        maxRounds: p.maxRounds,
        // …authored wiring the AI never sees survives; tiers only when it gave none.
        opportunityTiers: p.opportunityTiers.length > 0 ? p.opportunityTiers : match.opportunityTiers,
        status: 'pending',
        consecutiveReachedCount: 0,
      });
    } else {
      const id = generatePlotId('node');
      newIds.push(id);
      region.push({
        ...p,
        id,
        arcId: arc.id,
        status: 'pending',
        consecutiveReachedCount: 0,
      });
    }
  }
  const removedIds = pending.filter(n => !consumed.has(n.id)).map(n => n.id);
  return { region, keptIds, newIds, removedIds };
}

/** Merge one proposal gauge onto an existing one (id + runtime state survive). */
function mergeGauge(existing: PlotGauge, p: ReviseGauge): Partial<PlotGauge> {
  const min = p.min ?? existing.min;
  const max = p.max ?? existing.max;
  return {
    description: p.description ?? existing.description,
    min, max,
    unit: p.unit ?? existing.unit,
    color: p.color ?? existing.color,
    showInMainPanel: p.showInMainPanel ?? existing.showInMainPanel,
    aiUpdatable: p.aiUpdatable ?? existing.aiUpdatable,
    maxDeltaPerRound: p.maxDeltaPerRound ?? existing.maxDeltaPerRound,
    autoDecrement: p.autoDecrement ?? existing.autoDecrement,
    initialValue: p.initialValue ?? existing.initialValue,
    // Played-out current survives unless the model asked for a change (D4).
    current: clamp(p.current ?? existing.current, min, max),
  };
}

function newGauge(p: ReviseGauge): Omit<PlotGauge, 'id'> {
  const min = p.min ?? 0;
  const max = p.max ?? 100;
  const initial = p.initialValue ?? 0;
  return {
    name: p.name,
    description: p.description ?? '',
    min, max,
    initialValue: initial,
    current: clamp(p.current ?? initial, min, max),
    unit: p.unit ?? '%',
    color: p.color,
    showInMainPanel: p.showInMainPanel ?? true,
    aiUpdatable: p.aiUpdatable ?? true,
    maxDeltaPerRound: p.maxDeltaPerRound ?? DEFAULT_GAUGE_MAX_DELTA,
    autoDecrement: p.autoDecrement,
  };
}

/** One field-level change for the preview's expandable rows. `before` absent = brand-new value. */
export interface ReviseFieldDiff {
  field: string;
  before?: string;
  after: string;
}

export interface RevisePreview {
  /**
   * Proposal rows in order: kept (title matched, content identical), modified,
   * or added. `details` lets the UI show the actual content before applying —
   * per-field old→new for modified rows, every non-empty field for added rows.
   */
  rows: Array<{ kind: 'kept' | 'modified' | 'added'; title: string; details: ReviseFieldDiff[] }>;
  /** Field-level old→new for the in-progress node's text update (empty = none). */
  activeNodeDetails: ReviseFieldDiff[];
  removedTitles: string[];
  gaugeAdded: string[];
  gaugeUpdated: string[];
  gaugeRemoved: string[];
  /** Threads whose start triggers reference nodes this apply would remove. */
  danglingTriggerArcs: string[];
  /** Threads whose triggers/conditions reference gauges this apply would remove. */
  danglingGaugeArcs: string[];
}

const CONTENT_FIELDS = ['premise', 'narrativeGoal', 'directive', 'stakes', 'completionHint', 'emotionalTone', 'importance', 'maxRounds'] as const;

const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Field diffs between an existing node and a proposal node (both directions of emptiness skipped). */
function fieldDiffs(
  oldNode: Partial<Record<(typeof CONTENT_FIELDS)[number], unknown>>,
  newNode: Partial<Record<(typeof CONTENT_FIELDS)[number], unknown>>,
): ReviseFieldDiff[] {
  const out: ReviseFieldDiff[] = [];
  for (const f of CONTENT_FIELDS) {
    const before = asText(oldNode[f]);
    const after = asText(newNode[f]);
    if (before === after || (!before && !after)) continue;
    out.push({ field: f, ...(before ? { before } : {}), after });
  }
  return out;
}

/**
 * Pure preview of what `commitRevise` would do — the confirm UI shows badges,
 * per-row content details, and dangling warnings BEFORE anything is applied
 * (§3.5). Never mutates.
 */
export function previewRevise(allArcs: PlotArc[], arc: PlotArc, result: ReviseResult): RevisePreview {
  const pending = arc.nodes.filter(n => n.status === 'pending');
  const consumed = new Set<string>();
  const rows: RevisePreview['rows'] = [];
  const removedNodeIds: string[] = [];

  for (const p of result.nodes) {
    const match = pending.find(n => !consumed.has(n.id) && n.title.trim() === p.title.trim());
    if (!match) {
      rows.push({
        kind: 'added',
        title: p.title,
        details: CONTENT_FIELDS
          .filter(f => asText(p[f]))
          .map(f => ({ field: f, after: asText(p[f]) })),
      });
      continue;
    }
    consumed.add(match.id);
    const details = fieldDiffs(match, p);
    // Matching trims, but the commit writes the proposal title verbatim — a
    // literal difference is a change the "kept" badge must not hide.
    if (match.title !== p.title) {
      details.unshift({ field: 'title', before: match.title, after: p.title });
    }
    const tiersChanged = p.opportunityTiers.length > 0
      && JSON.stringify(p.opportunityTiers) !== JSON.stringify(match.opportunityTiers);
    if (tiersChanged) {
      details.push({
        field: 'opportunityTiers',
        before: String(match.opportunityTiers.length),
        after: String(p.opportunityTiers.length),
      });
    }
    rows.push({ kind: details.length === 0 ? 'kept' : 'modified', title: p.title, details });
  }
  const removed = pending.filter(n => !consumed.has(n.id));
  removed.forEach(n => removedNodeIds.push(n.id));

  // The active-node update MERGES (only present fields apply, D1) — diff only
  // the fields it actually carries, or absent ones would fake "cleared" rows.
  const active = arc.nodes.find(n => n.status === 'active');
  const activeNodeDetails: ReviseFieldDiff[] = [];
  if (result.activeNodeUpdate && active) {
    for (const f of Object.keys(result.activeNodeUpdate) as Array<keyof ActiveNodeUpdate>) {
      const after = asText(result.activeNodeUpdate[f]);
      const before = asText(active[f]);
      if (!after || after === before) continue;
      activeNodeDetails.push({ field: f, ...(before ? { before } : {}), after });
    }
  }

  const preview: RevisePreview = {
    rows,
    activeNodeDetails,
    removedTitles: removed.map(n => n.title),
    gaugeAdded: [], gaugeUpdated: [], gaugeRemoved: [],
    danglingTriggerArcs: [], danglingGaugeArcs: [],
  };

  // Same sequential match-consumption as commitRevise's gauge loop: a second
  // proposal entry with an already-claimed name previews as ADDED, exactly
  // what addGauge would do on apply.
  const removedGaugeIds: string[] = [];
  if (result.gauges.length > 0) {
    const consumedGauges = new Set<string>();
    for (const p of result.gauges) {
      const match = arc.gauges.find(g => !consumedGauges.has(g.id) && g.name.trim() === p.name.trim());
      if (match) {
        consumedGauges.add(match.id);
        preview.gaugeUpdated.push(p.name);
      } else {
        preview.gaugeAdded.push(p.name);
      }
    }
    for (const g of arc.gauges) {
      if (!consumedGauges.has(g.id)) {
        preview.gaugeRemoved.push(g.name);
        removedGaugeIds.push(g.id);
      }
    }
  }

  const goneNodes = new Set(removedNodeIds);
  const goneGauges = new Set(removedGaugeIds);
  for (const other of allArcs) {
    const triggers = other.activation?.triggers ?? [];
    if (triggers.some(t => t.type === 'node_completed' && t.arcId === arc.id && goneNodes.has(t.nodeId))) {
      preview.danglingTriggerArcs.push(other.title);
    }
    const gaugeHit = triggers.some(t => t.type === 'gauge' && goneGauges.has(t.condition.gaugeId))
      || other.nodes.some(n =>
        n.activationConditions.some(c => goneGauges.has(c.gaugeId))
        || n.completionConditions.some(c => goneGauges.has(c.gaugeId)));
    if (gaugeHit) preview.danglingGaugeArcs.push(other.title);
  }
  return preview;
}

export function commitRevise(
  store: ReturnType<typeof usePlotStore>,
  arcId: string,
  result: ReviseResult,
  opts: CommitReviseOptions = {},
): CommitReviseReport {
  const report = emptyReport();
  const arc = store.arcs.find(a => a.id === arcId);
  if (!arc) return { ...report, error: 'not_found' };
  if (arc.status !== 'draft' && arc.status !== 'scheduled' && arc.status !== 'active') {
    return { ...report, error: 'not_revisable' };
  }

  // §3.4-6 optimistic lock: the proposal was generated against this exact pending region.
  if (opts.expectedPendingIds) {
    const nowPending = arc.nodes.filter(n => n.status === 'pending').map(n => n.id);
    const same = nowPending.length === opts.expectedPendingIds.length
      && nowPending.every((id, i) => id === opts.expectedPendingIds![i]);
    if (!same) return { ...report, error: 'stale' };
  }

  // §3.4-7: draft/scheduled threads must keep at least one node (activateArc requires it).
  if (result.nodes.length === 0 && arc.status !== 'active') {
    return { ...report, error: 'empty_nodes' };
  }

  // Structural step first — if the mutex queues it (evaluation running), nothing else is touched.
  const { region, keptIds, newIds, removedIds } = buildRegion(arc, result.nodes);
  if (!store.replacePendingRegion(arcId, region)) return { ...report, error: 'busy' };
  report.keptNodeIds = keptIds;
  report.newNodeIds = newIds;
  report.removedNodeIds = removedIds;

  if (result.synopsis !== undefined) store.updateArc(arcId, { synopsis: result.synopsis });

  if (result.activeNodeUpdate) {
    const active = arc.nodes.find(n => n.status === 'active');
    if (active) {
      // Invariant shared with previewRevise: empty-string entries are "no
      // change", never "clear the field" — PlotReviser already drops them, but
      // this function is independently callable and must not diverge.
      const update: Partial<PlotNode> = {};
      for (const f of Object.keys(result.activeNodeUpdate) as Array<keyof ActiveNodeUpdate>) {
        const v = result.activeNodeUpdate[f];
        if (typeof v === 'string' && v.trim()) update[f] = v;
      }
      if (Object.keys(update).length > 0) store.updateNode(arcId, active.id, update);
    }
  }

  // Gauge full replacement by name (D4). An EMPTY/absent list means "gauges
  // untouched": a lazily-omitted key must never wipe played-out gauges, so
  // deleting every gauge cannot be expressed by the AI (manual edit can).
  const removedGaugeIds: string[] = [];
  if (result.gauges.length > 0) {
    const consumedGauges = new Set<string>();
    for (const p of result.gauges) {
      const match = arc.gauges.find(g => !consumedGauges.has(g.id) && g.name.trim() === p.name.trim());
      if (match) {
        consumedGauges.add(match.id);
        store.updateGauge(arcId, match.id, mergeGauge(match, p));
        report.updatedGaugeNames.push(p.name);
      } else {
        store.addGauge(arcId, newGauge(p));
        report.newGaugeNames.push(p.name);
      }
    }
    // Name-based exclusion of just-added gauges assumes per-arc name
    // uniqueness — the same assumption the whole name-keyed contract rests on
    // (prompt: "名称在整个存档内唯一").
    const removedGauges = arc.gauges.filter(g => !consumedGauges.has(g.id) && !report.newGaugeNames.includes(g.name));
    for (const g of removedGauges) {
      report.removedGaugeNames.push(g.name);
      removedGaugeIds.push(g.id);
      store.removeGauge(arcId, g.id);
    }
  }

  // §3.4-4/5: dangling references are pruned and REPORTED, never left to deadlock.
  report.danglingTriggers = pruneDanglingNodeTriggers(store.arcs, arcId, removedIds);
  report.danglingGaugeRefs = pruneDanglingGaugeRefs(store.arcs, removedGaugeIds);

  report.ok = true;
  return report;
}
