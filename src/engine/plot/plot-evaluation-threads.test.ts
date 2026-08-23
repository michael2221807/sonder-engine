/**
 * Plot Threads P1 — multi-thread evaluation pipeline
 * (docs/design/plot-parallel-threads-scheduler.md §4.2 loop, §8.3 counter-examples, D3 scheduled scan).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotEvaluationPipeline } from './plot-evaluation-pipeline';
import type { PlotArc, PlotNode, PlotDirectionState, PlotEvaluation, PlotEvalLog, PlotGauge } from './types';

const PLOT = DEFAULT_ENGINE_PATHS.plotDirection;

function node(id: string, arcId: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: '', directive: '', completionHint: `hint-${id}`,
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0,
    ...over,
  };
}
function gauge(id: string, name: string, current = 0, over: Partial<PlotGauge> = {}): PlotGauge {
  return { id, name, description: '', min: 0, max: 100, current, initialValue: 0, unit: '%', showInMainPanel: false, aiUpdatable: true, maxDeltaPerRound: 25, ...over };
}
function arc(id: string, title: string, nodes: PlotNode[], over: Partial<PlotArc> = {}): PlotArc {
  return { id, title, synopsis: '', nodes, gauges: [], status: 'active', ...over };
}
function seed(sm: StateManager, state: PlotDirectionState, round = 10, evals?: PlotEvaluation[] | PlotEvaluation, time?: Record<string, number>): void {
  sm.loadTree({
    元数据: { 剧情导向: { ...state, _lastEvaluation: evals ?? null }, 回合序号: round },
    世界: { 时间: time ?? { 年: 1, 月: 3, 日: 9 } },
    系统: { 设置: { plot: { criticalConfirmGate: true } } },
  });
}
const read = (sm: StateManager) => sm.get<PlotDirectionState>(PLOT)!;
const logs = (sm: StateManager) => sm.get<PlotEvalLog[]>(PLOT + '._evalLog') ?? [];
const hit = (thread: string, evidence = 'e'): PlotEvaluation => ({ thread, node_reached: true, confidence: 0.9, evidence });
const miss = (thread: string): PlotEvaluation => ({ thread, node_reached: false, confidence: 0.1, evidence: '' });

describe('PlotEvaluationPipeline — multi-thread loop', () => {
  let sm: StateManager;
  let p: PlotEvaluationPipeline;
  beforeEach(() => { sm = new StateManager(); p = new PlotEvaluationPipeline(sm, DEFAULT_ENGINE_PATHS); });

  it('§8.3 ex.1 — one scene advances thread A and leaves thread B untouched (independent verdicts)', async () => {
    seed(sm, {
      arcs: [
        arc('A', '高考冲刺篇', [node('a1', 'A', { status: 'active', activatedAtRound: 5 }), node('a2', 'A')]),
        arc('B', '社团风波', [node('b1', 'B', { status: 'active', activatedAtRound: 7 }), node('b2', 'B')]),
      ],
      activeArcIndex: 0, focusArcId: 'A',
    }, 10, [hit('高考冲刺篇', '主角当众宣布举报'), miss('社团风波')]);

    expect(await p.execute()).toBe(true);
    const s = read(sm);
    const A = s.arcs[0], B = s.arcs[1];
    expect(A.nodes[0].status).toBe('completed');
    expect(A.nodes[0].completionEvidence).toBe('主角当众宣布举报');
    expect(A.nodes[0].completedAtTime).toEqual({ year: 1, month: 3, day: 9 });
    expect(A.nodes[1].status).toBe('active');
    expect(A.nodes[1].activatedAtTime).toEqual({ year: 1, month: 3, day: 9 });
    expect(B.nodes[0].status).toBe('active');
    expect(B.nodes[0].consecutiveReachedCount).toBe(0);
    expect(logs(sm).map(l => [l.arcId, l.action])).toEqual([['A', 'advance'], ['B', 'none']]);
    expect(s.focusArcId).toBe('A');
  });

  it('§8.3 ex.2 — a verdict attributed to thread B is never applied to thread A', async () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5 }), node('b2', 'B')]),
      ],
      activeArcIndex: 0,
    }, 10, [hit('B线', '好友坦白信是他写的')]);

    await p.execute();
    const s = read(sm);
    expect(s.arcs[0].nodes[0].status).toBe('active');           // A untouched
    expect(s.arcs[0].nodes[0].consecutiveReachedCount).toBe(0);
    expect(s.arcs[1].nodes[0].status).toBe('completed');        // B advanced
  });

  it('with several active threads an unattributed (legacy) verdict is dropped, not guessed', async () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5 })]),
      ],
      activeArcIndex: 0,
    }, 10, { node_reached: true, confidence: 0.95, evidence: 'ambiguous' });
    await p.execute();
    const s = read(sm);
    expect(s.arcs[0].nodes[0].status).toBe('active');
    expect(s.arcs[1].nodes[0].status).toBe('active');
  });

  it('a verdict whose thread matches nothing (AI typo) is dropped AND surfaced in the eval log', async () => {
    seed(sm, {
      arcs: [
        arc('A', '高考冲刺篇', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', '社团风波', [node('b1', 'B', { status: 'active', activatedAtRound: 5 })]),
      ],
      activeArcIndex: 0,
    }, 10, [hit('高考冲刺', 'typo'), miss('社团风波')]);
    await p.execute();
    const s = read(sm);
    expect(s.arcs[0].nodes[0].status).toBe('active');
    const orphan = logs(sm).find(l => l.arcId === undefined && l.evaluation?.thread === '高考冲刺');
    expect(orphan).toBeDefined();
    expect(orphan!.action).toBe('none');
    expect(orphan!.evaluation?.evidence).toBe('typo');
  });

  it('duplicate titles among active threads: verdicts match by id only and are never applied twice', async () => {
    seed(sm, {
      arcs: [
        arc('A', '同名', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', '同名', [node('b1', 'B', { status: 'active', activatedAtRound: 5 })]),
      ],
      activeArcIndex: 0,
    }, 10, [hit('同名', 'by-title'), hit('B', 'by-id')]);
    await p.execute();
    const s = read(sm);
    expect(s.arcs[0].nodes[0].status).toBe('active');        // title match refused (ambiguous)
    expect(s.arcs[1].nodes[0].status).toBe('completed');     // id match applied
    expect(s.arcs[1].nodes[0].completionEvidence).toBe('by-id');
    expect(logs(sm).filter(l => l.arcId === undefined)).toHaveLength(1); // the by-title item is an orphan
  });

  it('with exactly one active thread the legacy single-object verdict still applies (backward compat)', async () => {
    seed(sm, { arcs: [arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })])], activeArcIndex: 0 },
      10, { node_reached: true, confidence: 0.95, evidence: 'old shape' });
    await p.execute();
    expect(read(sm).arcs[0].nodes[0].status).toBe('completed');
    expect(read(sm).arcs[0].status).toBe('completed');
    expect(logs(sm).map(l => l.action)).toEqual(['thread_completed', 'advance']);
  });

  it('§8.3 ex.3 — two critical nodes reached in the same round → two independent gates', async () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5, importance: 'critical', consecutiveReachedCount: 1 })]),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5, importance: 'critical', consecutiveReachedCount: 1 })]),
      ],
      activeArcIndex: 0,
    }, 10, [hit('A线', 'evA'), hit('B线', 'evB')]);
    await p.execute();
    const s = read(sm);
    expect(s.pendingConfirmations).toEqual([
      { arcId: 'A', nodeId: 'a1', evidence: 'evA', round: 10 },
      { arcId: 'B', nodeId: 'b1', evidence: 'evB', round: 10 },
    ]);
    expect(s.arcs[0].nodes[0].status).toBe('active');
    expect(s.arcs[1].nodes[0].status).toBe('active');

    // Confirming only B advances only B (immediate UI path)
    sm.set(PLOT + '.pendingConfirmations', [
      { arcId: 'A', nodeId: 'a1', evidence: 'evA', round: 10 },
      { arcId: 'B', nodeId: 'b1', evidence: 'evB', round: 10, confirmed: true },
    ], 'system');
    expect(p.applyConfirmedAdvancement('B')).toBe(true);
    const s2 = read(sm);
    expect(s2.arcs[1].nodes[0].status).toBe('completed');
    expect(s2.arcs[1].nodes[0].completionEvidence).toBe('evB');
    expect(s2.arcs[0].nodes[0].status).toBe('active');
    expect(s2.pendingConfirmations?.map(g => g.arcId)).toEqual(['A']);
  });

  it('a confirmed gate on a NON-focus thread is consumed by the next execute() (deferred path)', async () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5, importance: 'critical' }), node('b2', 'B')]),
      ],
      activeArcIndex: 0, focusArcId: 'A',
      pendingConfirmations: [{ arcId: 'B', nodeId: 'b1', evidence: 'ev', round: 9, confirmed: true }],
    }, 10, []);
    await p.execute();
    const s = read(sm);
    expect(s.arcs[1].nodes[0].status).toBe('completed');
    expect(s.arcs[1].nodes[1].status).toBe('active');
    expect(s.pendingConfirmations).toEqual([]);
    expect(s.focusArcId).toBe('A');
  });

  describe('cross-thread gauges (G13 / §8.4 ④⑤)', () => {
    it('gauge_updates resolve in-thread first, then a uniquely-named gauge on another active thread; ambiguous names are dropped', async () => {
      seed(sm, {
        arcs: [
          arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })], { gauges: [gauge('gA', '怀疑', 10), gauge('gShared', '压力', 10)] }),
          arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5 })], { gauges: [gauge('gB', '信任', 10), gauge('gShared2', '压力', 10)] }),
        ],
        activeArcIndex: 0,
      }, 10, [
        { ...miss('A线'), gauge_updates: [
          { gauge_id: '怀疑', delta: 5, reason: '' },   // own
          { gauge_id: '信任', delta: 7, reason: '' },   // other thread, unique name
          { gauge_id: '压力', delta: 9, reason: '' },   // own wins over the same-named gauge on B
        ] },
        { ...miss('B线'), gauge_updates: [{ gauge_id: '压力', delta: 3, reason: '' }] }, // own on B
      ]);
      await p.execute();
      const s = read(sm);
      const g = (a: number, id: string) => s.arcs[a].gauges.find(x => x.id === id)!.current;
      expect(g(0, 'gA')).toBe(15);
      expect(g(1, 'gB')).toBe(17);
      expect(g(0, 'gShared')).toBe(19);
      expect(g(1, 'gShared2')).toBe(13);
    });

    it('activationConditions may reference another active thread\'s gauge', async () => {
      seed(sm, {
        arcs: [
          arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })], { gauges: [gauge('gA', '怀疑', 80)] }),
          arc('B', 'B线', [
            node('b1', 'B', { status: 'active', activatedAtRound: 5 }),
            node('b2', 'B', { activationConditions: [{ gaugeId: 'gA', operator: 'gte', value: 80 }] }),
          ]),
        ],
        activeArcIndex: 0,
      }, 10, [miss('A线'), hit('B线')]);
      await p.execute();
      expect(read(sm).arcs[1].nodes[1].status).toBe('active');
    });
  });

  describe('scheduled threads (D3)', () => {
    it('activates a scheduled thread when its node_completed trigger fires this round, without stealing focus', async () => {
      seed(sm, {
        arcs: [
          arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 }), node('a2', 'A')]),
          arc('S', 'S线', [node('s1', 'S', { onActivate: { worldEvent: { title: '修罗场开始', description: 'd' } } }), node('s2', 'S')],
            { status: 'scheduled', activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'A', nodeId: 'a1' }] } }),
        ],
        activeArcIndex: 0, focusArcId: 'A',
      }, 10, [hit('A线')]);
      await p.execute();
      const s = read(sm);
      expect(s.arcs[1].status).toBe('active');
      expect(s.arcs[1].nodes[0].status).toBe('active');
      expect(s.arcs[1].nodes[0].activatedAtRound).toBe(10);
      expect(s.arcs[1].nodes[0].activatedAtTime).toEqual({ year: 1, month: 3, day: 9 });
      expect(s.focusArcId).toBe('A');
      expect(logs(sm).some(l => l.arcId === 'S' && l.action === 'thread_activated')).toBe(true);
      const events = sm.get<Array<Record<string, unknown>>>(DEFAULT_ENGINE_PATHS.worldEvents) ?? [];
      expect(events.some(e => e['事件名称'] === '修罗场开始')).toBe(true);
    });

    it('runs with zero active threads so round_reached can fire; the first auto-activated thread becomes focus', async () => {
      seed(sm, {
        arcs: [arc('S', 'S线', [node('s1', 'S')], { status: 'scheduled', activation: { mode: 'auto', triggers: [{ type: 'round_reached', round: 24 }] } })],
        activeArcIndex: null,
      }, 23, []);
      expect(await p.execute()).toBe(true);
      expect(read(sm).arcs[0].status).toBe('scheduled');

      seed(sm, {
        arcs: [arc('S', 'S线', [node('s1', 'S')], { status: 'scheduled', activation: { mode: 'auto', triggers: [{ type: 'round_reached', round: 24 }] } })],
        activeArcIndex: null,
      }, 24, []);
      await p.execute();
      const s = read(sm);
      expect(s.arcs[0].status).toBe('active');
      expect(s.focusArcId).toBe('S');
      expect(s.activeArcIndex).toBe(0);
    });

    it('respects maxActiveThreads: satisfied triggers stay scheduled with a thread_blocked log', async () => {
      seed(sm, {
        arcs: [
          arc('A', 'A', [node('a1', 'A', { status: 'active', activatedAtRound: 1 })]),
          arc('B', 'B', [node('b1', 'B', { status: 'active', activatedAtRound: 1 })]),
          arc('S', 'S', [node('s1', 'S')], { status: 'scheduled', activation: { mode: 'auto', triggers: [{ type: 'round_reached', round: 1 }] } }),
        ],
        activeArcIndex: 0,
      }, 10, []);
      sm.set('系统.设置.plot.maxActiveThreads', 2, 'system');
      await p.execute();
      expect(read(sm).arcs[2].status).toBe('scheduled');
      expect(logs(sm).some(l => l.arcId === 'S' && l.action === 'thread_blocked')).toBe(true);
    });

    it('manual-mode activation is informational only — never auto-activates', async () => {
      seed(sm, {
        arcs: [arc('S', 'S', [node('s1', 'S')], { status: 'scheduled', activation: { mode: 'manual', triggers: [{ type: 'round_reached', round: 1 }] } })],
        activeArcIndex: null,
      }, 10, []);
      await p.execute();
      expect(read(sm).arcs[0].status).toBe('scheduled');
    });

    it('abandoned predecessor does not satisfy thread_completed', async () => {
      seed(sm, {
        arcs: [
          arc('A', 'A', [node('a1', 'A', { status: 'skipped' })], { status: 'abandoned' }),
          arc('S', 'S', [node('s1', 'S')], { status: 'scheduled', activation: { mode: 'auto', triggers: [{ type: 'thread_completed', arcId: 'A' }] } }),
        ],
        activeArcIndex: null,
      }, 10, []);
      await p.execute();
      expect(read(sm).arcs[1].status).toBe('scheduled');
    });
  });

  it('focus falls to the lowest-lane remaining thread when the focus thread completes inside the pipeline', async () => {
    seed(sm, {
      arcs: [
        arc('A', 'A', [node('a1', 'A', { status: 'active', activatedAtRound: 1 })], { lane: 0 }),
        arc('B', 'B', [node('b1', 'B', { status: 'active', activatedAtRound: 1 })], { lane: 5 }),
        arc('C', 'C', [node('c1', 'C', { status: 'active', activatedAtRound: 1 })], { lane: 2 }),
      ],
      activeArcIndex: 0, focusArcId: 'A',
    }, 10, [hit('A'), miss('B'), miss('C')]);
    await p.execute();
    const s = read(sm);
    expect(s.arcs[0].status).toBe('completed');
    expect(s.focusArcId).toBe('C');
    expect(s.activeArcIndex).toBe(2);
    expect(s.pendingConfirmation).toBeNull();
  });
});
