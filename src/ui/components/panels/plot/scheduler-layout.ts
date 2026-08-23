// App doc: docs/user-guide/pages/game-plot.md §时间线视图 (布局/坐标轴计算)
// Design: docs/design/plot-parallel-threads-scheduler.md §5 (scheduler view), D4 (axis)
/**
 * Pure layout for the plot scheduler: which row each thread sits on, where
 * each node block starts/ends in ROUND space, and how rounds map to pixels
 * on either the round axis or the game-date axis.
 *
 * No DOM, no Vue — unit-tested directly.
 */
import type { PlotArc, PlotNode, ThreadTrigger, GameTimeStamp } from '@/engine/plot/types';
import { gameTimeToDayOrdinal } from '@/engine/plot/game-time-stamp';

export const DEFAULT_PROJECTED_ROUNDS = 6;

export interface LayoutNode {
  node: PlotNode;
  /** First round the block covers (inclusive). */
  start: number;
  /** Round after the last one the block covers (exclusive) — width = end - start. */
  end: number;
  /** Elapsed/maxRounds for active nodes, 0..1+ (>1 = overtime). */
  progress: number;
}

export interface LayoutLane {
  arc: PlotArc;
  nodes: LayoutNode[];
  /** For `scheduled` threads: which block its first node is drawn after. */
  link?: { fromArcId: string; fromNodeId: string };
  /** Why a scheduled thread is still waiting (mirrors thread-trigger verdicts). */
  waitingOn?: string;
}

export interface SchedulerLayout {
  lanes: LayoutLane[];
  /** Last round any block reaches (exclusive end). */
  maxRound: number;
}

const RANK: Record<PlotArc['status'], number> = { active: 0, scheduled: 1, draft: 2, completed: 3, abandoned: 3 };

/** Display order: active (focus first), scheduled, draft, finished; lane, then array order within a group. */
export function orderThreads(arcs: PlotArc[], focusArcId: string | null): PlotArc[] {
  return arcs
    .map((arc, i) => ({ arc, i }))
    .sort((p, q) =>
      (RANK[p.arc.status] - RANK[q.arc.status])
      || ((q.arc.id === focusArcId ? 1 : 0) - (p.arc.id === focusArcId ? 1 : 0))
      || ((p.arc.lane ?? Infinity) - (q.arc.lane ?? Infinity))
      || (p.i - q.i))
    .map(x => x.arc);
}

function layoutNodes(arc: PlotArc, startAt: number, currentRound: number): LayoutNode[] {
  let cursor = startAt;
  return arc.nodes.map(node => {
    let start: number;
    let end: number;
    let progress = 0;
    const span = node.maxRounds ?? DEFAULT_PROJECTED_ROUNDS;
    // Recorded rounds are inclusive on both ends, so a node completed in round 5
    // and its successor activated in round 5 would share a column and the blocks
    // would overlap. Blocks are laid out monotonically: a recorded start never
    // sits before the previous block's end (the later block slides right ≤ 1 round).
    if ((node.status === 'completed' || node.status === 'skipped') && node.activatedAtRound != null) {
      start = Math.max(node.activatedAtRound, cursor);
      end = Math.max(start + 1, (node.completedAtRound ?? start) + 1);
    } else if (node.status === 'active' && node.activatedAtRound != null) {
      start = Math.max(node.activatedAtRound, cursor);
      const elapsed = currentRound - node.activatedAtRound;
      end = Math.max(currentRound + 1, start + span);
      progress = span > 0 ? elapsed / span : 0;
    } else {
      start = cursor;
      end = start + span;
    }
    cursor = end;
    return { node, start, end, progress };
  });
}

/** Round a scheduled thread is expected to begin, from its first decisive trigger. */
function scheduledStart(arc: PlotArc, laid: Map<string, LayoutLane>, currentRound: number): { start: number; link?: LayoutLane['link'] } {
  const triggers: ThreadTrigger[] = arc.activation?.triggers ?? [];
  let start = currentRound + 1;
  let link: LayoutLane['link'] | undefined;
  for (const t of triggers) {
    if (t.type === 'node_completed') {
      const lane = laid.get(t.arcId);
      const ln = lane?.nodes.find(n => n.node.id === t.nodeId);
      if (ln) { start = Math.max(start, ln.end); link = link ?? { fromArcId: t.arcId, fromNodeId: t.nodeId }; }
    } else if (t.type === 'thread_completed') {
      const lane = laid.get(t.arcId);
      const last = lane?.nodes[lane.nodes.length - 1];
      if (last) { start = Math.max(start, last.end); link = link ?? { fromArcId: t.arcId, fromNodeId: last.node.id }; }
    } else if (t.type === 'round_reached') {
      start = Math.max(start, t.round);
    }
  }
  return { start, link };
}

export function layoutThreads(arcs: PlotArc[], focusArcId: string | null, currentRound: number): SchedulerLayout {
  const ordered = orderThreads(arcs, focusArcId);
  const laid = new Map<string, LayoutLane>();
  // Non-scheduled first so scheduled threads can anchor on projected ends.
  for (const arc of ordered) {
    if (arc.status === 'scheduled') continue;
    const startAt = arc.status === 'draft' ? currentRound + 1 : 1;
    laid.set(arc.id, { arc, nodes: layoutNodes(arc, startAt, currentRound) });
  }
  return finishLayout(ordered, laid, currentRound);
}

function finishLayout(ordered: PlotArc[], laid: Map<string, LayoutLane>, currentRound: number): SchedulerLayout {
  // Scheduled threads may chain on each other — resolve in order, twice, so a
  // scheduled thread waiting on another scheduled thread still anchors correctly.
  for (let pass = 0; pass < 2; pass++) {
    for (const arc of ordered) {
      if (arc.status !== 'scheduled') continue;
      const { start, link } = scheduledStart(arc, laid, currentRound);
      laid.set(arc.id, { arc, nodes: layoutNodes(arc, start, currentRound), link });
    }
  }
  const lanes = ordered.map(a => laid.get(a.id)!);
  const maxRound = Math.max(currentRound + 1, ...lanes.flatMap(l => l.nodes.map(n => n.end)));
  return { lanes, maxRound };
}

// ─── Axis ───────────────────────────────────────────────────────

export type AxisMode = 'round' | 'date';

export interface AxisTick {
  /** Pixel x. */
  x: number;
  /** Primary label: `R12` on the round axis, date on the date axis. */
  label: string;
  /** Secondary label (known date under a round tick / round under a date tick). */
  sub?: string;
  /** Beyond the last recorded sample → projected. */
  estimated?: boolean;
  major: boolean;
}

export interface SchedulerAxis {
  mode: AxisMode;
  /** Falls back to rounds when the save has no usable date samples. */
  degraded: boolean;
  x(round: number): number;
  /** Inverse of `x`: the nearest round (≥ 1) for a pixel offset — used when a block is dragged to a round. */
  roundAt(px: number): number;
  width: number;
  ticks: AxisTick[];
}

/** Nearest round to a pixel x for any monotonic `x(round)` (binary search over 1..maxRound). */
function inverseAxis(x: (r: number) => number, maxRound: number): (px: number) => number {
  return (px: number): number => {
    let lo = 1;
    let hi = Math.max(1, maxRound);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x(mid) <= px) lo = mid; else hi = mid;
    }
    return Math.abs(x(hi) - px) < Math.abs(x(lo) - px) ? hi : lo;
  };
}

export interface DateLabelers {
  /** A RECORDED stamp → its real date label (e.g. "3月9日"). Never invents dates. */
  stamp(stamp: GameTimeStamp): string;
  /** Days since the first recorded stamp, for ticks with no recorded date (e.g. "第 3 天"). */
  day(offset: number): string;
}

export interface DateSample {
  round: number;
  day: number;
  stamp: GameTimeStamp;
}

/** One sample per round gathered from every node stamp, sorted by round. */
export function collectDateSamples(arcs: PlotArc[]): DateSample[] {
  const map = new Map<number, DateSample>();
  for (const arc of arcs) {
    for (const n of arc.nodes) {
      const a = gameTimeToDayOrdinal(n.activatedAtTime);
      if (n.activatedAtRound != null && a != null && n.activatedAtTime && !map.has(n.activatedAtRound)) {
        map.set(n.activatedAtRound, { round: n.activatedAtRound, day: a, stamp: n.activatedAtTime });
      }
      const c = gameTimeToDayOrdinal(n.completedAtTime);
      if (n.completedAtRound != null && c != null && n.completedAtTime && !map.has(n.completedAtRound)) {
        map.set(n.completedAtRound, { round: n.completedAtRound, day: c, stamp: n.completedAtTime });
      }
    }
  }
  return [...map.values()].sort((p, q) => p.round - q.round);
}

/** Round→day pairs for the interpolator. */
export function samplePairs(samples: DateSample[]): Array<[number, number]> {
  return samples.map(s => [s.round, s.day]);
}

/** Piecewise-linear round → day; extrapolates with the last two samples (or 1 day/round with one sample). */
export function dayOfRound(samples: Array<[number, number]>, round: number): number {
  if (samples.length === 0) return round;
  if (round <= samples[0][0]) return samples[0][1] - (samples[0][0] - round) * slopeAt(samples, 0);
  for (let i = 1; i < samples.length; i++) {
    if (round <= samples[i][0]) {
      const [r0, d0] = samples[i - 1];
      const [r1, d1] = samples[i];
      return r1 === r0 ? d0 : d0 + (d1 - d0) * (round - r0) / (r1 - r0);
    }
  }
  const last = samples[samples.length - 1];
  return last[1] + (round - last[0]) * slopeAt(samples, samples.length - 1);
}

function slopeAt(samples: Array<[number, number]>, idx: number): number {
  if (samples.length < 2) return 1;
  const a = samples[Math.max(0, idx - 1)];
  const b = samples[Math.min(samples.length - 1, idx === 0 ? 1 : idx)];
  const dr = b[0] - a[0];
  return dr > 0 ? Math.max(0.05, (b[1] - a[1]) / dr) : 1;
}

export function buildAxis(
  mode: AxisMode,
  layout: SchedulerLayout,
  opts: { pxPerRound: number; pxPerDay: number; samples: DateSample[]; currentRound: number; labels: DateLabelers },
): SchedulerAxis {
  const maxRound = layout.maxRound + 2;
  const pairs = samplePairs(opts.samples);
  if (mode === 'date' && opts.samples.length >= 1) {
    const origin = dayOfRound(pairs, 1);
    const firstSampleDay = opts.samples[0].day;
    const x = (r: number): number => (dayOfRound(pairs, r) - origin) * opts.pxPerDay;
    const lastSampleDay = opts.samples[opts.samples.length - 1].day;
    const lastDay = Math.ceil(dayOfRound(pairs, maxRound) - origin);
    const ticks: AxisTick[] = [];
    for (let d = 0; d <= lastDay; d++) {
      const dayOrd = origin + d;
      const sample = opts.samples.find(s => Math.abs(s.day - dayOrd) < 1e-9);
      ticks.push({
        x: d * opts.pxPerDay,
        // Real date only where the save actually recorded one; a day offset after
        // the first stamp; nothing at all before it (no fabricated dates, no negative days).
        label: sample
          ? opts.labels.stamp(sample.stamp)
          : (dayOrd - firstSampleDay > 1e-9 ? opts.labels.day(Math.round(dayOrd - firstSampleDay)) : ''),
        sub: sample ? `R${sample.round}` : undefined,
        estimated: dayOrd > lastSampleDay + 1e-9,
        major: true,
      });
    }
    return { mode: 'date', degraded: false, x, roundAt: inverseAxis(x, maxRound + 40), width: x(maxRound) + 40, ticks };
  }
  const x = (r: number): number => (r - 1) * opts.pxPerRound;
  const ticks: AxisTick[] = [];
  for (let r = 1; r <= maxRound; r++) {
    const major = r === 1 || r % 5 === 0;
    const sample = opts.samples.find(s => s.round === r);
    ticks.push({ x: x(r), label: `R${r}`, sub: major && sample ? opts.labels.stamp(sample.stamp) : undefined, major });
  }
  const roundAt = (px: number): number => Math.max(1, Math.round(px / opts.pxPerRound) + 1);
  return { mode: 'round', degraded: mode === 'date', x, roundAt, width: x(maxRound) + 40, ticks };
}
