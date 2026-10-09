import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { FULL_TRACE_ROUNDS, traceTrimCut, traceTrims, trimHistoryTraces, trimmedTrace } from './engram-read-trim';

const candidate = (outcome: string, n: number) => ({ text: `记忆${n}`, finalScore: n / 10, source: 'event', components: [], outcome });
const trace = (...outcomes: string[]) => ({
  query: '问',
  capturedAt: 1,
  totalDurationMs: 2,
  candidates: outcomes.map((o, i) => candidate(o, i)),
  pipeline: { vectorEventCount: 1, vectorEntityCount: 0, graphCount: 0, afterMerge: 1, afterRerank: 1, injectedCount: 1 },
  config: { minScore: 0.3, topK: 5 },
});
/** A history of `rounds` completed rounds, each assistant entry with a trace of one injected and two filtered candidates. */
const history = (rounds: number) => Array.from({ length: rounds }, (_, r) => [
  { role: 'user', content: `输入${r}` },
  { role: 'assistant', content: `正文${r}`, _engramRead: trace('injected', 'filtered-by-topK', 'filtered-by-rerank') },
]).flat();

describe('engram read trim (D2B)', () => {
  it('keeps the latest five completed rounds whole: the cut is the fifth-latest assistant entry', () => {
    expect(FULL_TRACE_ROUNDS).toBe(5);
    expect(traceTrimCut(history(3))).toBe(0);
    expect(traceTrimCut(history(5))).toBe(0);
    expect(traceTrimCut(history(6))).toBe(3);
    expect(traceTrimCut(history(8))).toBe(7);
    expect(traceTrimCut([{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }], 1)).toBe(2);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => traceTrimCut(history(8), bad)).toThrow(RangeError);
  });

  it('keeps the injected candidates and counts every outcome', () => {
    const t = trace('injected', 'filtered-by-topK', 'filtered-by-topK', 'filtered-as-redundant', 'injected');
    const out = trimmedTrace(t);
    expect(out?.candidates).toEqual([candidate('injected', 0), candidate('injected', 4)]);
    expect(out?.trimmed).toEqual({ counts: { injected: 2, 'filtered-by-topK': 2, 'filtered-as-redundant': 1 } });
    expect(out?.query).toBe('问');
    expect(out?.pipeline).toBe(t.pipeline);
    expect(t.candidates).toHaveLength(5);
  });

  it('leaves alone what has nothing to trim: no filtered candidate, already trimmed, not a trace', () => {
    expect(trimmedTrace(trace('injected', 'injected'))).toBeUndefined();
    expect(trimmedTrace(trace())).toBeUndefined();
    const once = trimmedTrace(trace('injected', 'filtered-by-topK'));
    expect(trimmedTrace(once)).toBeUndefined();
    expect(trimmedTrace({ ...trace('filtered-by-topK'), trimmed: { counts: {} } })).toBeUndefined();
    for (const notATrace of [undefined, null, 'x', [], { candidates: 'no' }]) expect(trimmedTrace(notATrace)).toBeUndefined();
  });

  it('counts outcomes named like object keys as plain counts', () => {
    const t = { candidates: [candidate('injected', 0), candidate('constructor', 1), candidate('__proto__', 2), candidate('toString', 3), candidate('toString', 4)] };
    const counts = (trimmedTrace(t)?.trimmed as { counts: Record<string, number> }).counts;
    expect(Object.keys(counts)).toEqual(['injected', 'constructor', '__proto__', 'toString']);
    expect(Object.values(counts)).toEqual([1, 1, 1, 2]);
    expect(Object.getPrototypeOf(counts)).toBe(Object.prototype);
  });

  it('counts a candidate without a readable outcome as unknown and drops it', () => {
    const t = { candidates: [candidate('injected', 0), { text: '坏' }, 'not a candidate'] };
    expect(trimmedTrace(t)).toEqual({ candidates: [candidate('injected', 0)], trimmed: { counts: { injected: 1, unknown: 2 } } });
  });

  it('lists only the entries before the cut that still have something to trim', () => {
    const h = history(7);
    const cut = traceTrimCut(h);
    expect(cut).toBe(5);
    expect(traceTrims(h, cut).map((t) => t.index)).toEqual([1, 3]);
    const once = trimHistoryTraces(h, cut);
    expect(traceTrims(once, cut)).toEqual([]);
    expect(trimHistoryTraces(once, cut)).toBe(once);
    const short = history(3);
    expect(trimHistoryTraces(short, traceTrimCut(short))).toBe(short);
    expect(traceTrims(h, 0)).toEqual([]);
    expect(traceTrims(h, 99).map((t) => t.index)).toEqual([1, 3, 5, 7, 9, 11, 13]);
  });

  it('builds a new history and new entries, changing nothing it was given', () => {
    const h = history(7);
    const before = cloneDeep(h);
    const next = trimHistoryTraces(h, traceTrimCut(h));
    expect(h).toEqual(before);
    expect(next).not.toBe(h);
    expect(next[1]).not.toBe(h[1]);
    expect(next[0]).toBe(h[0]);
    expect(next[5]).toBe(h[5]);
    expect((next[1] as { _engramRead: { candidates: unknown[] } })._engramRead.candidates).toHaveLength(1);
    expect((next[1] as { content: string }).content).toBe('正文0');
  });

  it('applies the window of the history a round starts from to the history after it, trimming the same entries', () => {
    const atRoundStart = history(7);
    const afterRound = [...cloneDeep(atRoundStart), ...history(1)];
    const cut = traceTrimCut(atRoundStart);
    expect(traceTrims(afterRound, cut).map((t) => t.index)).toEqual(traceTrims(atRoundStart, cut).map((t) => t.index));
    expect(traceTrimCut(afterRound)).toBeGreaterThan(cut);
  });
});
