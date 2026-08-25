/**
 * Node force resolution — PlotEvaluationPipeline.forceNodeResolution()
 * (docs/design/plot-arc-revise-extend.md §4.1, decision D2: node-level, not arc-level).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotEvaluationPipeline } from './plot-evaluation-pipeline';
import { evaluateThreadTrigger } from './thread-trigger';
import type { PlotArc, PlotNode, PlotDirectionState, PlotEvalLog, PlotGauge } from './types';

const PLOT = DEFAULT_ENGINE_PATHS.plotDirection;

function node(id: string, arcId: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: `goal-${id}`, directive: '', completionHint: `hint-${id}`,
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
function seed(sm: StateManager, state: PlotDirectionState, round = 10): void {
  sm.loadTree({
    元数据: { 剧情导向: state, 回合序号: round },
    世界: { 时间: { 年: 1, 月: 3, 日: 9 } },
    社交: { 事件: { 事件记录: [] } },
    系统: { 设置: { plot: { criticalConfirmGate: true } } },
  });
}
const read = (sm: StateManager) => sm.get<PlotDirectionState>(PLOT)!;
const logs = (sm: StateManager) => sm.get<PlotEvalLog[]>(PLOT + '._evalLog') ?? [];
const events = (sm: StateManager) => sm.get<Array<Record<string, unknown>>>(DEFAULT_ENGINE_PATHS.worldEvents) ?? [];

describe('PlotEvaluationPipeline.forceNodeResolution', () => {
  let sm: StateManager;
  let p: PlotEvaluationPipeline;
  beforeEach(() => { sm = new StateManager(); p = new PlotEvaluationPipeline(sm, DEFAULT_ENGINE_PATHS); });

  it('complete: stamps, fires onComplete, activates the next node (with onActivate), logs advance — no evidence written', () => {
    seed(sm, {
      arcs: [arc('A', 'A线', [
        node('a1', 'A', {
          status: 'active', activatedAtRound: 5,
          onComplete: { worldEvent: { title: '完成事件', description: 'd' }, gaugeEffects: [{ gaugeId: 'g1', action: 'add', value: 10 }] },
        }),
        node('a2', 'A', { onActivate: { worldEvent: { title: '激活事件', description: 'd' } } }),
      ], { gauges: [gauge('g1', '进度', 40)] })],
      activeArcIndex: 0, focusArcId: 'A',
    });

    expect(p.forceNodeResolution('A', 'complete')).toBe(true);
    const s = read(sm);
    const [a1, a2] = s.arcs[0].nodes;
    expect(a1.status).toBe('completed');
    expect(a1.completedAtRound).toBe(10);
    expect(a1.completedAtTime).toEqual({ year: 1, month: 3, day: 9 });
    expect(a1.completionEvidence).toBeUndefined();
    expect(a2.status).toBe('active');
    expect(a2.activatedAtRound).toBe(10);
    expect(s.arcs[0].gauges[0].current).toBe(50);
    expect(events(sm).map(e => e['事件名称'])).toEqual(['完成事件', '激活事件']);
    expect(logs(sm).map(l => [l.arcId, l.action])).toEqual([['A', 'advance']]);
  });

  it('skip: marks skipped, fires onSkip (not onComplete), activates the next node, logs skip', () => {
    seed(sm, {
      arcs: [arc('A', 'A线', [
        node('a1', 'A', {
          status: 'active', activatedAtRound: 5,
          onComplete: { worldEvent: { title: '不该发生', description: 'd' } },
          onSkip: { worldEvent: { title: '跳过事件', description: 'd' } },
        }),
        node('a2', 'A'),
      ])],
      activeArcIndex: 0,
    });

    expect(p.forceNodeResolution('A', 'skip')).toBe(true);
    const s = read(sm);
    expect(s.arcs[0].nodes[0].status).toBe('skipped');
    expect(s.arcs[0].nodes[1].status).toBe('active');
    expect(events(sm).map(e => e['事件名称'])).toEqual(['跳过事件']);
    expect(logs(sm).map(l => [l.arcId, l.action])).toEqual([['A', 'skip']]);
  });

  it('last node complete: thread completes, thread_completed logged, focus falls to the other active thread', () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'completed' }), node('a2', 'A', { status: 'active', activatedAtRound: 8 })], { lane: 0 }),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 8 })], { lane: 1 }),
      ],
      activeArcIndex: 0, focusArcId: 'A',
    });

    expect(p.forceNodeResolution('A', 'complete')).toBe(true);
    const s = read(sm);
    expect(s.arcs[0].status).toBe('completed');
    expect(s.focusArcId).toBe('B');
    expect(logs(sm).map(l => l.action)).toEqual(['thread_completed', 'advance']);
  });

  it('supersedes a pending confirmation gate for the same thread', () => {
    seed(sm, {
      arcs: [arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5, importance: 'critical' }), node('a2', 'A')])],
      activeArcIndex: 0,
      pendingConfirmations: [{ arcId: 'A', nodeId: 'a1', evidence: 'AI说完成了', round: 9 }],
    });

    expect(p.forceNodeResolution('A', 'skip')).toBe(true);
    const s = read(sm);
    expect(s.pendingConfirmations).toEqual([]);
    expect(s.arcs[0].nodes[0].status).toBe('skipped');
  });

  it('rejects a non-active thread and a thread with no active node; state is untouched', () => {
    seed(sm, {
      arcs: [
        arc('D', '草稿线', [node('d1', 'D')], { status: 'draft' }),
        arc('A', '无活跃节点', [node('a1', 'A', { status: 'completed' }), node('a2', 'A')]),
      ],
      activeArcIndex: null,
    });
    const before = JSON.stringify(read(sm));
    expect(p.forceNodeResolution('D', 'complete')).toBe(false);
    expect(p.forceNodeResolution('A', 'complete')).toBe(false);
    expect(p.forceNodeResolution('missing', 'complete')).toBe(false);
    expect(JSON.stringify(read(sm))).toBe(before);
    expect(logs(sm)).toEqual([]);
  });

  it('nodeId identity check: a stale confirm (node already advanced past) is rejected, state untouched', () => {
    seed(sm, {
      arcs: [arc('A', 'A线', [node('a1', 'A', { status: 'completed' }), node('a2', 'A', { status: 'active', activatedAtRound: 9 }), node('a3', 'A')])],
      activeArcIndex: 0,
    });
    // The confirm dialog was opened for a1, but a2 is the active node now.
    expect(p.forceNodeResolution('A', 'complete', 'a1')).toBe(false);
    expect(read(sm).arcs[0].nodes[1].status).toBe('active');
    // Matching id still works.
    expect(p.forceNodeResolution('A', 'complete', 'a2')).toBe(true);
    expect(read(sm).arcs[0].nodes[1].status).toBe('completed');
  });

  it('applyConfirmedAdvancement writes its eval-log entry (advance, and thread_completed on the last node)', () => {
    seed(sm, {
      arcs: [arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5, importance: 'critical' })])],
      activeArcIndex: 0,
      pendingConfirmations: [{ arcId: 'A', nodeId: 'a1', evidence: 'ev', round: 9, confirmed: true }],
    });
    expect(p.applyConfirmedAdvancement('A')).toBe(true);
    expect(read(sm).arcs[0].status).toBe('completed');
    expect(logs(sm).map(l => l.action)).toEqual(['thread_completed', 'advance']);
  });

  it('downstream triggers: forced complete AND forced skip both satisfy node_completed; a force-finished thread satisfies thread_completed', () => {
    seed(sm, {
      arcs: [
        arc('A', 'A线', [node('a1', 'A', { status: 'active', activatedAtRound: 5 })]),
        arc('B', 'B线', [node('b1', 'B', { status: 'active', activatedAtRound: 5 }), node('b2', 'B')]),
      ],
      activeArcIndex: 0,
    });

    expect(p.forceNodeResolution('A', 'complete')).toBe(true);
    expect(p.forceNodeResolution('B', 'skip')).toBe(true);
    const ctx = { arcs: read(sm).arcs, currentRound: 10 };
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'A', nodeId: 'a1' }, ctx)).toEqual({ satisfied: true });
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'B', nodeId: 'b1' }, ctx)).toEqual({ satisfied: true });
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'A' }, ctx)).toEqual({ satisfied: true });
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'B' }, ctx)).toEqual({ satisfied: false, reason: 'waiting' });
  });
});
