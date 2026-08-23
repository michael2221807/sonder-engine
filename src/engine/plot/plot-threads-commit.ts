// App doc: docs/user-guide/pages/game-plot.md §拆解方式：一条线 / 多条线
// Design: docs/design/plot-parallel-threads-scheduler.md §7.4 (multi-thread decomposition → store)
/**
 * Plot Threads — commit a multi-thread decomposition proposal into the store.
 *
 * Extracted from the panel so the ordering rules are unit-testable without Vue:
 *  1. every thread → arc + nodes + gauges (+ colour);
 *  2. lanes continue AFTER the highest existing finite lane, so arcs created
 *     earlier (which may have no `lane`, i.e. sort last) are never demoted;
 *  3. title refs resolve against EXISTING arcs as well as this batch (the
 *     model was fed the ledger precisely so it can hang new threads off old ones);
 *  4. fully-resolved refs → `scheduled`; any unresolved/malformed ref → stays `draft`;
 *  5. immediate threads activate in proposal order up to `maxActiveThreads`
 *     (first one takes focus); the overflow is reported, not silently dropped.
 */
import type { usePlotStore } from './plot-store';
import type { GameTimeStamp, PlotArc } from './types';
import { DEFAULT_GAUGE_MAX_DELTA } from './types';
import { PlotDecomposer, type DecomposedThread, type MultiDecomposeResult } from './plot-decomposer';

export interface CommitThreadsOptions {
  round: number;
  time?: GameTimeStamp;
  maxActiveThreads: number;
}

export interface CommitThreadsResult {
  /** Created arc ids in proposal order. */
  createdIds: string[];
  /** Titles of immediate threads that could not activate because the cap was full (left as draft). */
  stranded: string[];
  /** Titles of threads left as draft because a start condition could not be resolved. */
  unresolved: Record<string, string[]>;
}

/** Refs in a proposal that name no thread/node in `existing` ∪ the proposal itself — preview + commit share this. */
export function unresolvedThreadRefs(
  thread: DecomposedThread,
  proposal: DecomposedThread[],
  existing: Array<Pick<PlotArc, 'title' | 'nodes'>>,
): string[] {
  const out: string[] = [...thread.malformedRefs];
  if (!thread.activation) return out;
  const threadExists = (title: string) =>
    proposal.some(x => x.title.trim() === title.trim()) || existing.some(a => a.title.trim() === title.trim());
  const nodeExists = (title: string, nodeTitle: string) =>
    proposal.some(x => x.title.trim() === title.trim() && x.nodes.some(n => n.title.trim() === nodeTitle))
    || existing.some(a => a.title.trim() === title.trim() && a.nodes.some(n => n.title.trim() === nodeTitle));
  for (const ref of thread.activation) {
    if ('at_round' in ref) continue;
    if ('after_thread' in ref) {
      if (ref.after_thread.trim() === thread.title.trim() || !threadExists(ref.after_thread)) out.push(ref.after_thread);
    } else {
      const [tt, nt] = ref.after_node.split('/').map(s => s.trim());
      if (tt === thread.title.trim() || !tt || !nt || !nodeExists(tt, nt)) out.push(ref.after_node);
    }
  }
  return out;
}

/** Immediate (activation === null) threads beyond the cap, in proposal order. */
export function overCapThreadTitles(proposal: DecomposedThread[], activeCount: number, maxActiveThreads: number): string[] {
  const free = Math.max(0, maxActiveThreads - activeCount);
  return proposal.filter(t => !t.activation && t.malformedRefs.length === 0).slice(free).map(t => t.title);
}

export function commitDecomposedThreads(
  store: ReturnType<typeof usePlotStore>,
  proposal: MultiDecomposeResult,
  opts: CommitThreadsOptions,
): CommitThreadsResult {
  const existingBefore = store.arcs.map(a => ({ id: a.id, title: a.title, nodes: a.nodes }));
  const laneBase = Math.max(-1, ...store.arcs.map(a => (typeof a.lane === 'number' ? a.lane : -1))) + 1;

  const created = proposal.threads.map((thread, i) => {
    const arc = store.createArc(thread.title, thread.synopsis);
    store.updateArc(arc.id, { lane: laneBase + i, ...(thread.color ? { color: thread.color } : {}) });
    for (const nodeData of thread.nodes) {
      store.addNode(arc.id, {
        ...nodeData,
        completionConditions: [],
        activationConditions: [],
        completionMode: nodeData.completionMode ?? 'hint_only',
        importance: nodeData.importance ?? 'critical',
        opportunityTiers: nodeData.opportunityTiers ?? [],
        maxRounds: nodeData.maxRounds ?? 6,
      });
    }
    for (const gaugeData of thread.suggestedGauges) {
      store.addGauge(arc.id, { ...gaugeData, maxDeltaPerRound: gaugeData.maxDeltaPerRound ?? DEFAULT_GAUGE_MAX_DELTA });
    }
    return { thread, arcId: arc.id };
  });

  // Resolve against existing + new (the store objects are live, nodes already added).
  const lookup = store.arcs.filter(a => existingBefore.some(e => e.id === a.id) || created.some(c => c.arcId === a.id));
  const result: CommitThreadsResult = { createdIds: created.map(c => c.arcId), stranded: [], unresolved: {} };
  let first = true;
  for (const { thread, arcId } of created) {
    const self = lookup.find(a => a.id === arcId);
    const others = lookup.filter(a => a.id !== arcId); // never let a thread wait on itself
    if (thread.malformedRefs.length > 0) {
      result.unresolved[thread.title] = [...thread.malformedRefs];
      continue;
    }
    if (thread.activation) {
      const { activation, unresolved } = PlotDecomposer.resolveThreadActivation(thread.activation, others);
      if (activation && unresolved.length === 0) store.scheduleArc(arcId, activation);
      else result.unresolved[thread.title] = unresolved.length ? unresolved : ['(empty)'];
      continue;
    }
    const ok = store.activateArc(arcId, { round: opts.round, time: opts.time, maxActiveThreads: opts.maxActiveThreads, takeFocus: first });
    if (ok) first = false;
    else result.stranded.push(self?.title ?? thread.title);
  }
  return result;
}
