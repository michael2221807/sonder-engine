import { describe, it, expect } from 'vitest';
import type { PlotArc, PlotNode } from './types';
import {
  evaluateThreadTrigger,
  evaluateThreadActivation,
  pruneDanglingTriggers,
  collectActiveGauges,
} from './thread-trigger';

function node(id: string, status: PlotNode['status']): PlotNode {
  return {
    id, arcId: 'x', title: id, narrativeGoal: '', directive: '', completionHint: '',
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status, consecutiveReachedCount: 0,
  };
}
function arc(id: string, status: PlotArc['status'], nodes: PlotNode[] = [], gauges: PlotArc['gauges'] = []): PlotArc {
  return { id, title: id, synopsis: '', nodes, gauges, status };
}
const gauge = (id: string, current: number) => ({
  id, name: id, description: '', min: 0, max: 100, current, initialValue: 0,
  unit: '%', showInMainPanel: false, aiUpdatable: true, maxDeltaPerRound: 25,
});

describe('evaluateThreadTrigger', () => {
  it('thread_completed: completed satisfies, active waits, abandoned is reported, missing is reported', () => {
    const ctx = { currentRound: 10, arcs: [arc('a', 'completed'), arc('b', 'active'), arc('c', 'abandoned')] };
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'a' }, ctx)).toEqual({ satisfied: true });
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'b' }, ctx)).toEqual({ satisfied: false, reason: 'waiting' });
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'c' }, ctx)).toEqual({ satisfied: false, reason: 'target_abandoned' });
    expect(evaluateThreadTrigger({ type: 'thread_completed', arcId: 'zz' }, ctx)).toEqual({ satisfied: false, reason: 'target_missing' });
  });

  it('node_completed: completed OR skipped satisfies; pending waits; abandoned owner is reported', () => {
    const ctx = {
      currentRound: 1,
      arcs: [
        arc('a', 'active', [node('n1', 'completed'), node('n2', 'skipped'), node('n3', 'pending')]),
        arc('b', 'abandoned', [node('m1', 'pending')]),
      ],
    };
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'a', nodeId: 'n1' }, ctx).satisfied).toBe(true);
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'a', nodeId: 'n2' }, ctx).satisfied).toBe(true);
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'a', nodeId: 'n3' }, ctx)).toEqual({ satisfied: false, reason: 'waiting' });
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'b', nodeId: 'm1' }, ctx)).toEqual({ satisfied: false, reason: 'target_abandoned' });
    expect(evaluateThreadTrigger({ type: 'node_completed', arcId: 'a', nodeId: 'nope' }, ctx)).toEqual({ satisfied: false, reason: 'target_missing' });
  });

  it('round_reached compares >=', () => {
    expect(evaluateThreadTrigger({ type: 'round_reached', round: 24 }, { currentRound: 23, arcs: [] }).satisfied).toBe(false);
    expect(evaluateThreadTrigger({ type: 'round_reached', round: 24 }, { currentRound: 24, arcs: [] }).satisfied).toBe(true);
  });

  it('gauge: evaluates against the union of ACTIVE threads only', () => {
    const ctx = {
      currentRound: 1,
      arcs: [arc('a', 'active', [], [gauge('g1', 80)]), arc('b', 'draft', [], [gauge('g2', 99)])],
    };
    expect(evaluateThreadTrigger({ type: 'gauge', condition: { gaugeId: 'g1', operator: 'gte', value: 80 } }, ctx).satisfied).toBe(true);
    expect(evaluateThreadTrigger({ type: 'gauge', condition: { gaugeId: 'g1', operator: 'gt', value: 80 } }, ctx)).toEqual({ satisfied: false, reason: 'waiting' });
    // g2 lives on a draft thread → not visible
    expect(evaluateThreadTrigger({ type: 'gauge', condition: { gaugeId: 'g2', operator: 'gte', value: 1 } }, ctx)).toEqual({ satisfied: false, reason: 'target_missing' });
    expect(collectActiveGauges(ctx.arcs).map(g => g.id)).toEqual(['g1']);
  });
});

describe('evaluateThreadActivation', () => {
  const ctx = { currentRound: 30, arcs: [arc('a', 'completed'), arc('b', 'active')] };

  it('empty / missing activation never satisfies', () => {
    expect(evaluateThreadActivation(undefined, ctx)).toEqual({ satisfied: false, reason: 'empty' });
    expect(evaluateThreadActivation({ mode: 'auto', triggers: [] }, ctx)).toEqual({ satisfied: false, reason: 'empty' });
  });

  it('AND semantics — first failing trigger explains the wait', () => {
    expect(evaluateThreadActivation({ mode: 'auto', triggers: [
      { type: 'thread_completed', arcId: 'a' }, { type: 'round_reached', round: 10 },
    ] }, ctx)).toEqual({ satisfied: true });
    expect(evaluateThreadActivation({ mode: 'auto', triggers: [
      { type: 'thread_completed', arcId: 'a' }, { type: 'thread_completed', arcId: 'b' },
    ] }, ctx)).toEqual({ satisfied: false, reason: 'waiting' });
  });
});

describe('pruneDanglingTriggers', () => {
  it('removes only triggers pointing at the deleted thread and reports the count', () => {
    const arcs = [
      arc('s', 'scheduled'),
      arc('t', 'scheduled'),
    ];
    arcs[0].activation = { mode: 'auto', triggers: [
      { type: 'thread_completed', arcId: 'gone' },
      { type: 'node_completed', arcId: 'gone', nodeId: 'n' },
      { type: 'round_reached', round: 5 },
      { type: 'thread_completed', arcId: 'keep' },
    ] };
    arcs[1].activation = { mode: 'manual', triggers: [{ type: 'gauge', condition: { gaugeId: 'g', operator: 'gt', value: 1 } }] };
    expect(pruneDanglingTriggers(arcs, 'gone')).toBe(2);
    expect(arcs[0].activation!.triggers).toEqual([
      { type: 'round_reached', round: 5 },
      { type: 'thread_completed', arcId: 'keep' },
    ]);
    expect(arcs[1].activation!.triggers).toHaveLength(1);
  });
});
