/**
 * 检索记录裁剪 — 最近 5 个已完成回合之外，检索记录只留用上的记忆（存档瘦身 D2B，2026-10-09）
 *
 * Each assistant entry carries its round's retrieval trace (`_engramRead`): every scored candidate, injected or
 * filtered. On the PO save these traces were 12.7M characters and grew every round. Outside the latest five completed
 * rounds a trace keeps only its injected candidates, plus how many candidates each outcome had (`trimmed.counts`); a
 * trace already trimmed, or with nothing filtered, is left as it is.
 *
 * Trimming builds new objects and never changes a trace in place: the retriever keeps the latest trace by reference,
 * and the round's context reads the same object. A history with nothing to trim comes back as the same list, so a
 * caller can tell "nothing changed" by identity.
 *
 * The window is counted on the history the round starts from: the round-start trim and the snapshot taken right after
 * it see the same entries trimmed, and a migration applies the window of the old snapshot's history to the tree too.
 */
import type { EngramReadSnapshot, ScoredCandidateTrace } from '../../memory/engram/engram-types';
import { isPlainRecord } from './plain-data';

/** How many of the latest completed rounds keep their full trace. */
export const FULL_TRACE_ROUNDS = 5;

/** What a trimmed trace records about the candidates it no longer lists: candidates per outcome before the trim. */
export type TrimmedTraceInfo = NonNullable<EngramReadSnapshot['trimmed']>;

/** The narrative-entry field holding a round's retrieval trace. */
export const TRACE_FIELD = '_engramRead';

const INJECTED: ScoredCandidateTrace['outcome'] = 'injected';

/**
 * The history index before which traces are trimmed: the index of the `keepRounds`-th latest assistant entry, or 0
 * when the history holds no more than `keepRounds` of them (nothing is trimmed). `keepRounds` must be a whole number
 * of at least 1.
 */
export function traceTrimCut(history: readonly unknown[], keepRounds: number = FULL_TRACE_ROUNDS): number {
  if (!Number.isSafeInteger(keepRounds) || keepRounds < 1) throw new RangeError(`keepRounds must be a whole number ≥ 1, got ${keepRounds}`);
  const assistantIndices: number[] = [];
  history.forEach((entry, i) => {
    if (isPlainRecord(entry) && entry.role === 'assistant') assistantIndices.push(i);
  });
  return assistantIndices.length > keepRounds ? assistantIndices[assistantIndices.length - keepRounds] : 0;
}

/**
 * The trace with only its injected candidates and the count of every outcome, or undefined when there is nothing to
 * trim (not a trace, already trimmed, or no filtered candidate).
 */
export function trimmedTrace(trace: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(trace) || !Array.isArray(trace.candidates) || trace.trimmed !== undefined) return undefined;
  const candidates: unknown[] = trace.candidates;
  const kept = candidates.filter((candidate) => isPlainRecord(candidate) && candidate.outcome === INJECTED);
  if (kept.length === candidates.length) return undefined;
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const outcome = isPlainRecord(candidate) && typeof candidate.outcome === 'string' ? candidate.outcome : 'unknown';
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const trimmed: TrimmedTraceInfo = { counts: Object.fromEntries(counts) };
  return { ...trace, candidates: kept, trimmed };
}

/** Every trace before `cut` that has something to trim: its history index and the trimmed trace. */
export function traceTrims(history: readonly unknown[], cut: number): Array<{ index: number; trace: Record<string, unknown> }> {
  const trims: Array<{ index: number; trace: Record<string, unknown> }> = [];
  for (let i = 0; i < Math.min(cut, history.length); i++) {
    const entry = history[i];
    if (!isPlainRecord(entry)) continue;
    const trace = trimmedTrace(entry[TRACE_FIELD]);
    if (trace) trims.push({ index: i, trace });
  }
  return trims;
}

/**
 * The history with the traces before `cut` trimmed: a new list whose untouched entries are the same objects, or the
 * given list itself when there is nothing to trim.
 */
export function trimHistoryTraces(history: readonly unknown[], cut: number): readonly unknown[] {
  const trims = traceTrims(history, cut);
  if (trims.length === 0) return history;
  const next = [...history];
  for (const { index, trace } of trims) {
    next[index] = { ...(history[index] as Record<string, unknown>), [TRACE_FIELD]: trace };
  }
  return next;
}
