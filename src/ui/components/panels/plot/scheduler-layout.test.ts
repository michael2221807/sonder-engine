import { describe, it, expect } from 'vitest';
import type { PlotArc, PlotNode } from '@/engine/plot/types';
import { layoutThreads, orderThreads, collectDateSamples, samplePairs, dayOfRound, buildAxis } from './scheduler-layout';

function node(id: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId: 'x', title: id, narrativeGoal: '', directive: '', completionHint: '',
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0, ...over,
  };
}
function arc(id: string, status: PlotArc['status'], nodes: PlotNode[], over: Partial<PlotArc> = {}): PlotArc {
  return { id, title: id, synopsis: '', gauges: [], status, nodes, ...over };
}

describe('orderThreads', () => {
  it('active (focus first, then lane) → scheduled → draft → finished', () => {
    const arcs = [
      arc('done', 'completed', []),
      arc('b', 'active', [], { lane: 3 }),
      arc('d', 'draft', []),
      arc('s', 'scheduled', []),
      arc('a', 'active', [], { lane: 9 }),
    ];
    expect(orderThreads(arcs, 'a').map(x => x.id)).toEqual(['a', 'b', 's', 'd', 'done']);
    expect(orderThreads(arcs, null).map(x => x.id)).toEqual(['b', 'a', 's', 'd', 'done']);
  });
});

describe('layoutThreads', () => {
  it('real spans for finished/active nodes, projection for pending; active block reaches at least now+1', () => {
    const a = arc('a', 'active', [
      node('n1', { status: 'completed', activatedAtRound: 3, completedAtRound: 5 }),
      node('n2', { status: 'active', activatedAtRound: 6, maxRounds: 4 }),
      node('n3', { maxRounds: 3 }),
      node('n4'),
    ]);
    const { lanes, maxRound } = layoutThreads([a], 'a', 12);
    const [n1, n2, n3, n4] = lanes[0].nodes;
    expect([n1.start, n1.end]).toEqual([3, 6]);
    expect([n2.start, n2.end]).toEqual([6, 13]); // maxRounds would end at 10, but "now" is 12 → overtime
    expect(n2.progress).toBeCloseTo(6 / 4);
    expect([n3.start, n3.end]).toEqual([13, 16]);
    expect([n4.start, n4.end]).toEqual([16, 22]); // default 6
    expect(maxRound).toBe(22);
  });

  it('draft threads project from now+1; scheduled threads anchor on the trigger target end and carry a link', () => {
    const a = arc('a', 'active', [node('a1', { status: 'active', activatedAtRound: 10, maxRounds: 5 }), node('a2', { maxRounds: 4 })]);
    const s = arc('s', 'scheduled', [node('s1', { maxRounds: 2 })], { activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'a', nodeId: 'a2' }] } });
    const d = arc('d', 'draft', [node('d1')]);
    const { lanes } = layoutThreads([d, s, a], 'a', 12);
    const byId = Object.fromEntries(lanes.map(l => [l.arc.id, l]));
    expect(byId.d.nodes[0].start).toBe(13);
    expect(byId.s.nodes[0].start).toBe(19); // a1 ends 15, a2 15→19
    expect(byId.s.link).toEqual({ fromArcId: 'a', fromNodeId: 'a2' });
  });

  it('scheduled-on-scheduled and round_reached resolve; thread_completed links to the last node', () => {
    const a = arc('a', 'active', [node('a1', { status: 'active', activatedAtRound: 1, maxRounds: 3 })]);
    const s1 = arc('s1', 'scheduled', [node('x', { maxRounds: 2 })], { activation: { mode: 'auto', triggers: [{ type: 'thread_completed', arcId: 'a' }] } });
    const s2 = arc('s2', 'scheduled', [node('y')], { activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 's1', nodeId: 'x' }, { type: 'round_reached', round: 30 }] } });
    const { lanes } = layoutThreads([a, s2, s1], null, 2);
    const byId = Object.fromEntries(lanes.map(l => [l.arc.id, l]));
    expect(byId.s1.nodes[0].start).toBe(4);
    expect(byId.s1.link).toEqual({ fromArcId: 'a', fromNodeId: 'a1' });
    expect(byId.s2.nodes[0].start).toBe(30); // max(s1 end 6, round 30)
    expect(byId.s2.link).toEqual({ fromArcId: 's1', fromNodeId: 'x' });
  });
});

describe('date axis', () => {
  const arcs = [arc('a', 'active', [
    node('n1', { status: 'completed', activatedAtRound: 1, activatedAtTime: { year: 1, month: 3, day: 1 }, completedAtRound: 5, completedAtTime: { year: 1, month: 3, day: 3 } }),
    node('n2', { status: 'active', activatedAtRound: 9, activatedAtTime: { year: 1, month: 3, day: 5 } }),
  ])];

  it('collects one sample per round, sorted', () => {
    const s = collectDateSamples(arcs);
    expect(s.map(x => x.round)).toEqual([1, 5, 9]);
    expect(s[1].day - s[0].day).toBe(2);
    expect(s[2].stamp).toEqual({ year: 1, month: 3, day: 5 });
  });

  it('interpolates inside and extrapolates with the last slope outside', () => {
    const s = samplePairs(collectDateSamples(arcs));
    expect(dayOfRound(s, 3) - dayOfRound(s, 1)).toBeCloseTo(1);
    expect(dayOfRound(s, 13) - dayOfRound(s, 9)).toBeCloseTo(2); // 0.5 day/round
    expect(dayOfRound([], 7)).toBe(7);
  });

  const labels = { stamp: (st: { month?: number; day?: number }) => `${st.month}/${st.day}`, day: (n: number) => `day${n}` };

  it('buildAxis: date mode — recorded days show REAL dates, others show day offsets; projected ticks flagged; degrades without samples', () => {
    const layout = layoutThreads(arcs, 'a', 9);
    const axis = buildAxis('date', layout, { pxPerRound: 40, pxPerDay: 80, samples: collectDateSamples(arcs), currentRound: 9, labels });
    expect(axis.mode).toBe('date');
    expect(axis.degraded).toBe(false);
    expect(axis.x(1)).toBe(0);
    expect(axis.x(5)).toBeCloseTo(160);
    expect(axis.ticks[0].label).toBe('3/1');   // recorded stamp → real date, never an invented calendar
    expect(axis.ticks[0].sub).toBe('R1');
    expect(axis.ticks[1].label).toBe('day1');  // no stamp that day → offset from the first stamp
    expect(axis.ticks[2].label).toBe('3/3');
    expect(axis.ticks.some(t => t.estimated)).toBe(true);
    expect(axis.ticks.filter(t => !t.estimated).length).toBeGreaterThanOrEqual(5);

    const noDates = buildAxis('date', layoutThreads([arc('z', 'draft', [node('q')])], null, 1), { pxPerRound: 40, pxPerDay: 80, samples: [], currentRound: 1, labels });
    expect(noDates.mode).toBe('round');
    expect(noDates.degraded).toBe(true);
    expect(noDates.ticks[0].label).toBe('R1');
  });

  it('round mode shows known dates under major ticks', () => {
    const layout = layoutThreads(arcs, 'a', 9);
    const axis = buildAxis('round', layout, { pxPerRound: 40, pxPerDay: 80, samples: collectDateSamples(arcs), currentRound: 9, labels });
    expect(axis.ticks.find(t => t.label === 'R5')?.sub).toBe('3/3');
    expect(axis.ticks.find(t => t.label === 'R2')?.major).toBe(false);
  });
});

describe('block overlap + inverse axis (2026-08-23 fixes)', () => {
  it('recorded rounds that touch or overlap are laid out monotonically — no two blocks share a column', () => {
    const a = arc('a', 'active', [
      node('n1', { status: 'completed', activatedAtRound: 3, completedAtRound: 5 }),
      node('n2', { status: 'completed', activatedAtRound: 5, completedAtRound: 5 }), // same round as n1's completion
      node('n3', { status: 'active', activatedAtRound: 4, maxRounds: 4 }),           // recorded before its predecessor ended
    ]);
    const { lanes } = layoutThreads([a], 'a', 7);
    const [n1, n2, n3] = lanes[0].nodes;
    expect([n1.start, n1.end]).toEqual([3, 6]);
    expect([n2.start, n2.end]).toEqual([6, 7]);
    expect(n3.start).toBe(7);
    expect(n3.progress).toBeCloseTo(3 / 4); // progress still measured from the REAL activation round
    for (let i = 1; i < lanes[0].nodes.length; i++) expect(lanes[0].nodes[i].start).toBeGreaterThanOrEqual(lanes[0].nodes[i - 1].end);
  });

  const labels = { stamp: () => 'd', day: (n: number) => `day${n}` };

  it('roundAt inverts x on the round axis and on the date axis', () => {
    const layout = layoutThreads([arc('z', 'draft', [node('q', { maxRounds: 10 })])], null, 5);
    const round = buildAxis('round', layout, { pxPerRound: 40, pxPerDay: 80, samples: [], currentRound: 5, labels });
    expect(round.roundAt(round.x(7))).toBe(7);
    expect(round.roundAt(round.x(7) + 15)).toBe(7);
    expect(round.roundAt(round.x(7) + 25)).toBe(8);
    expect(round.roundAt(-100)).toBe(1);

    const dated = [arc('a', 'active', [
      node('n1', { status: 'completed', activatedAtRound: 1, activatedAtTime: { year: 1, month: 3, day: 1 }, completedAtRound: 5, completedAtTime: { year: 1, month: 3, day: 3 } }),
    ])];
    const date = buildAxis('date', layoutThreads(dated, 'a', 5), { pxPerRound: 40, pxPerDay: 80, samples: collectDateSamples(dated), currentRound: 5, labels });
    expect(date.mode).toBe('date');
    for (const r of [1, 3, 5, 9]) expect(date.roundAt(date.x(r))).toBe(r);
  });
});
