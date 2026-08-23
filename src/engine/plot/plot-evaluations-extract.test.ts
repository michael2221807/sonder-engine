/**
 * Plot Threads P0 — AI contract extraction (design §4.3 / §8.4 ②).
 * `plot_evaluation` may be the new per-thread array or the legacy single object.
 */
import { describe, it, expect } from 'vitest';
import { extractPlotEvaluations, extractPlotEvaluation, coerceStoredEvaluations } from './types';

describe('extractPlotEvaluations', () => {
  it('parses the multi-thread array, keeping per-item gauge_updates and dropping invalid items', () => {
    const out = extractPlotEvaluations({
      plot_evaluation: [
        { thread: '高考冲刺篇', node_reached: false, confidence: 0.2, evidence: 'a' },
        { thread: '社团风波', node_reached: true, confidence: 0.8, evidence: 'b',
          gauge_updates: [{ gauge_id: '社长信任', delta: 10, reason: 'r' }] },
        { thread: 'broken', node_reached: 'yes', confidence: 0.5 },
        null,
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ thread: '高考冲刺篇', node_reached: false, confidence: 0.2, evidence: 'a', gauge_updates: undefined });
    expect(out[1].thread).toBe('社团风波');
    expect(out[1].gauge_updates).toEqual([{ gauge_id: '社长信任', delta: 10, reason: 'r' }]);
  });

  it('ignores top-level gauge_updates in the array shape (ambiguous owner) but honours it for the legacy single shape', () => {
    const arr = extractPlotEvaluations({
      plot_evaluation: [{ thread: 'A', node_reached: false, confidence: 0.1, evidence: '' }],
      gauge_updates: [{ gauge_id: 'g', delta: 5, reason: '' }],
    });
    expect(arr[0].gauge_updates).toBeUndefined();

    const single = extractPlotEvaluations({
      plot_evaluation: { node_reached: true, confidence: 0.9, evidence: 'e' },
      gauge_updates: [{ gauge_id: 'g', delta: 5, reason: '' }],
    });
    expect(single).toHaveLength(1);
    expect(single[0].thread).toBeUndefined();
    expect(single[0].gauge_updates).toEqual([{ gauge_id: 'g', delta: 5, reason: '' }]);
  });

  it('returns [] for missing / malformed input and the legacy accessor returns the first verdict', () => {
    expect(extractPlotEvaluations(undefined)).toEqual([]);
    expect(extractPlotEvaluations({})).toEqual([]);
    expect(extractPlotEvaluations({ plot_evaluation: 'nope' })).toEqual([]);
    expect(extractPlotEvaluation({ plot_evaluation: { node_reached: true, confidence: 1, evidence: 'x' } })?.evidence).toBe('x');
    expect(extractPlotEvaluation({})).toBeNull();
  });

  it('blank thread strings are treated as absent', () => {
    const out = extractPlotEvaluations({ plot_evaluation: [{ thread: '  ', node_reached: false, confidence: 0, evidence: '' }] });
    expect(out[0].thread).toBeUndefined();
  });
});

describe('coerceStoredEvaluations', () => {
  it('accepts array, single object, or nothing', () => {
    const e = { node_reached: true, confidence: 1, evidence: '' };
    expect(coerceStoredEvaluations([e, null])).toEqual([e]);
    expect(coerceStoredEvaluations(e)).toEqual([e]);
    expect(coerceStoredEvaluations(null)).toEqual([]);
    expect(coerceStoredEvaluations(undefined)).toEqual([]);
  });
});
