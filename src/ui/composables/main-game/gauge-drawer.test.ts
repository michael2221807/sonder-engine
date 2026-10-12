import { describe, expect, it } from 'vitest';
import type { PlotArc, PlotDirectionState, PlotGauge } from '@/engine/plot/types';
import { gaugeSnapshot, hasUnseenChange, mainPanelGaugeGroups, nextSeen } from './gauge-drawer';

function gauge(id: string, current: number, extra: Partial<PlotGauge> = {}): PlotGauge {
  return {
    id, name: id, description: '', min: 0, max: 100, current, initialValue: current, unit: '%',
    showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25, ...extra,
  } as PlotGauge;
}

function arc(id: string, gauges: PlotGauge[], extra: Partial<PlotArc> = {}): PlotArc {
  return { id, title: `线${id}`, synopsis: '', status: 'active', nodes: [], gauges, ...extra } as PlotArc;
}

function plot(arcs: PlotArc[], focusArcId: string | null = arcs[0]?.id ?? null): PlotDirectionState {
  return { activeArcIndex: null, focusArcId, pendingConfirmations: [], arcs } as unknown as PlotDirectionState;
}

describe('mainPanelGaugeGroups', () => {
  it('lists a thread\'s main-panel gauges with their share and their text', () => {
    const [group] = mainPanelGaugeGroups(plot([arc('a', [
      gauge('p', 82),
      gauge('money', 775, { max: 1000, unit: '万元' }),
      gauge('hidden', 5, { showInMainPanel: false }),
      gauge('neg', 0, { min: -50, max: 50, unit: '点' }),
    ])]), undefined, undefined);
    expect(group.gauges.map((g) => [g.gauge.id, g.pct, g.text, g.thread, g.arcId])).toEqual([
      ['p', 82, '82%', '线a', 'a'],
      ['money', 78, '775万元', '线a', 'a'],
      ['neg', 50, '0点', '线a', 'a'],
    ]);
  });

  it('shows every active thread, the focus thread first and marked, the others in lane order', () => {
    const groups = mainPanelGaugeGroups(plot([
      arc('a', [gauge('a1', 1)], { lane: 2 }),
      arc('b', [gauge('b1', 2)], { lane: 0, color: '#c08' }),
      arc('c', [gauge('c1', 3)], { lane: 1 }),
    ], 'c'), true, true);
    expect(groups.map((g) => [g.arcId, g.focus])).toEqual([['c', true], ['b', false], ['a', false]]);
    expect(groups[1].color).toBe('#c08');
  });

  it('threads without a lane keep their order in the list', () => {
    const groups = mainPanelGaugeGroups(plot([arc('a', [gauge('a1', 1)]), arc('b', [gauge('b1', 1)]), arc('c', [gauge('c1', 1)])], 'b'), true, true);
    expect(groups.map((g) => g.arcId)).toEqual(['b', 'a', 'c']);
  });

  it('a thread without a lane comes after those with one, as in the scheduler', () => {
    const groups = mainPanelGaugeGroups(plot([
      arc('u', [gauge('u1', 1)]),
      arc('l1', [gauge('x', 1)], { lane: 1 }),
      arc('f', [gauge('y', 1)], { lane: 5 }),
      arc('l0', [gauge('z', 1)], { lane: 0 }),
    ], 'f'), true, true);
    expect(groups.map((g) => g.arcId)).toEqual(['f', 'l0', 'l1', 'u']);
  });

  it('a gauge id repeated in one thread still gives every gauge its own key', () => {
    const [group] = mainPanelGaugeGroups(plot([arc('a', [gauge('dup', 1), gauge('dup', 2), gauge('one', 3)])]), true, true);
    const keys = group.gauges.map((g) => g.key);
    expect(new Set(keys).size).toBe(3);
    const snapshot = gaugeSnapshot([group]);
    expect(Object.values(snapshot)).toEqual([1, 2, 3]);
  });

  it('leaves out threads that are not active, and active ones with no main-panel gauge', () => {
    const groups = mainPanelGaugeGroups(plot([
      arc('done', [gauge('d1', 1)], { status: 'completed' }),
      arc('later', [gauge('l1', 1)], { status: 'scheduled' }),
      arc('quiet', [gauge('q1', 1, { showInMainPanel: false })]),
      arc('live', [gauge('v1', 1)]),
    ], 'live'), true, true);
    expect(groups.map((g) => g.arcId)).toEqual(['live']);
  });

  it('with the focus pointing at no active thread, the lane order decides who is first and the focus mark', () => {
    const groups = mainPanelGaugeGroups(plot([arc('a', [gauge('a1', 1)], { lane: 1 }), arc('b', [gauge('b1', 1)], { lane: 0 })], 'gone'), true, true);
    expect(groups.map((g) => [g.arcId, g.focus])).toEqual([['b', true], ['a', false]]);
  });

  it('shows nothing when the main-panel setting or plot direction is off, or there is no thread', () => {
    expect(mainPanelGaugeGroups(plot([arc('a', [gauge('p', 1)])]), false, true)).toEqual([]);
    expect(mainPanelGaugeGroups(plot([arc('a', [gauge('p', 1)])]), true, false)).toEqual([]);
    expect(mainPanelGaugeGroups(undefined, true, true)).toEqual([]);
    expect(mainPanelGaugeGroups(plot([]), true, true)).toEqual([]);
  });

  it('a gauge without range sits at 0%', () => {
    expect(mainPanelGaugeGroups(plot([arc('a', [gauge('flat', 3, { min: 3, max: 3 })])]), true, true)[0].gauges[0].pct).toBe(0);
  });
});

describe('seen values and the toggle\'s dot', () => {
  const snap = (arcs: PlotArc[]) => gaugeSnapshot(mainPanelGaugeGroups(plot(arcs), true, true));
  const A = snap([arc('x', [gauge('g1', 1), gauge('g2', 2)])]);
  const A2 = snap([arc('x', [gauge('g1', 1), gauge('g2', 3)])]);

  it('keys values by thread and gauge, so two threads may share a gauge id', () => {
    expect(snap([arc('x', [gauge('g', 1)]), arc('y', [gauge('g', 2)])])).toEqual({ 'x\u0001g': 1, 'y\u0001g': 2 });
  });

  it('the first values shown are taken as seen: no dot on loading a save', () => {
    const seen = nextSeen(null, A, false);
    expect(seen).toEqual(A);
    expect(hasUnseenChange(seen, A, false)).toBe(false);
  });

  it('a value changing while closed lights the dot; opening sees it', () => {
    const seen = nextSeen(A, A2, false);
    expect(seen).toEqual(A);
    expect(hasUnseenChange(seen, A2, false)).toBe(true);
    expect(hasUnseenChange(seen, A2, true)).toBe(false);
    expect(nextSeen(seen, A2, true)).toEqual(A2);
  });

  it('while open every change is seen as it happens', () => {
    expect(nextSeen(A, A2, true)).toEqual(A2);
  });

  it('a thread activated while closed is no change, and a change on another thread in the same round still is', () => {
    const withNew = snap([arc('x', [gauge('g1', 1), gauge('g2', 2)]), arc('y', [gauge('h1', 50)])]);
    const seen = nextSeen(A, withNew, false);
    expect(hasUnseenChange(seen, withNew, false)).toBe(false);
    const both = snap([arc('x', [gauge('g1', 1), gauge('g2', 9)]), arc('y', [gauge('h1', 50)])]);
    expect(hasUnseenChange(nextSeen(A, both, false), both, false)).toBe(true);
  });

  it('a thread ending while closed is no change, and is forgotten', () => {
    const two = snap([arc('x', [gauge('g1', 1)]), arc('y', [gauge('h1', 5)])]);
    const one = snap([arc('x', [gauge('g1', 1)])]);
    const seen = nextSeen(two, one, false);
    expect(seen).toEqual(one);
    expect(hasUnseenChange(seen, one, false)).toBe(false);
  });

  it('a value that comes back to what was seen puts the dot out again', () => {
    expect(hasUnseenChange(A, A, false)).toBe(false);
  });
});
