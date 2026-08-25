/**
 * Plot Revise & Extend — commitRevise rules (docs/design/plot-arc-revise-extend.md §3.4).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { usePlotStore } from './plot-store';
import { commitRevise, previewRevise } from './plot-revise-commit';
import { evaluateThreadTrigger } from './thread-trigger';
import type { ReviseResult } from './plot-reviser';
import type { PlotNode } from './types';

type Store = ReturnType<typeof usePlotStore>;

function protoNode(title: string, over: Partial<ReviseResult['nodes'][number]> = {}): ReviseResult['nodes'][number] {
  return {
    title, narrativeGoal: `g-${title}`, directive: `d-${title}`, completionHint: `h-${title}`,
    premise: `p-${title}`, stakes: `s-${title}`,
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'critical', opportunityTiers: [], maxRounds: 6, emotionalTone: undefined,
    ...over,
  };
}

function seedArc(store: Store): string {
  const arc = store.createArc('高考冲刺篇', '旧概要');
  const add = (title: string, over: Partial<PlotNode> = {}) => {
    const n = store.addNode(arc.id, {
      title, narrativeGoal: `goal-${title}`, directive: '', completionHint: '',
      completionConditions: [], completionMode: 'hint_only', activationConditions: [],
      importance: 'skippable',
      opportunityTiers: [{ tier: 1, afterRounds: 3, prompt: 'authored-tier' }],
      onComplete: { flags: { authored: true } },
    })!;
    Object.assign(n, over);
    return n;
  };
  add('发现秘密', { status: 'completed', completedAtRound: 5 });
  add('模拟考异常', { status: 'active', activatedAtRound: 6 });
  add('道德抉择');
  add('全市模拟考');
  arc.status = 'active';
  store.addGauge(arc.id, { name: '怀疑', description: '旧描述', min: 0, max: 100, current: 45, initialValue: 0, unit: '%', showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25 });
  return arc.id;
}

const revise = (nodes: ReviseResult['nodes'], over: Partial<ReviseResult> = {}): ReviseResult =>
  ({ nodes, gauges: [], ...over });

describe('commitRevise', () => {
  let store: Store;
  let arcId: string;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = usePlotStore();
    arcId = seedArc(store);
  });
  const arc = () => store.arcs.find(a => a.id === arcId)!;

  it('title-matched pending nodes keep their id and authored wiring; content comes from the proposal; new/removed handled', () => {
    const keptId = arc().nodes[2].id;
    const removedId = arc().nodes[3].id;
    const rep = commitRevise(store, arcId, revise([
      protoNode('主动退赛'),
      protoNode('道德抉择', { opportunityTiers: [] }),
    ]));
    expect(rep.ok).toBe(true);
    expect(rep.keptNodeIds).toEqual([keptId]);
    expect(rep.newNodeIds).toHaveLength(1);
    expect(rep.removedNodeIds).toEqual([removedId]);

    const titles = arc().nodes.map(n => n.title);
    expect(titles).toEqual(['发现秘密', '模拟考异常', '主动退赛', '道德抉择']);
    const kept = arc().nodes[3];
    expect(kept.id).toBe(keptId);
    expect(kept.narrativeGoal).toBe('g-道德抉择');       // content replaced
    expect(kept.premise).toBe('p-道德抉择');
    expect(kept.opportunityTiers[0]?.prompt).toBe('authored-tier'); // wiring survives when AI gave none
    expect(kept.onComplete).toEqual({ flags: { authored: true } });
    // completed/active prefix untouched
    expect(arc().nodes[0].status).toBe('completed');
    expect(arc().nodes[1].status).toBe('active');
  });

  it('synopsis and whitelisted active-node update apply; progress fields survive', () => {
    const rep = commitRevise(store, arcId, revise([protoNode('道德抉择')], {
      synopsis: '新概要',
      activeNodeUpdate: { directive: '指向新未来', completionHint: '新标志' },
    }));
    expect(rep.ok).toBe(true);
    expect(arc().synopsis).toBe('新概要');
    const active = arc().nodes[1];
    expect(active.directive).toBe('指向新未来');
    expect(active.completionHint).toBe('新标志');
    expect(active.status).toBe('active');
    expect(active.activatedAtRound).toBe(6);
  });

  it('gauges: name-matched keeps id + played-out current (unless explicit), new added, removed pruned with dangling refs reported', () => {
    const g1 = arc().gauges[0].id;
    // another thread waits on this gauge + a pending node references it
    const other = store.createArc('等待线', '');
    store.addNode(other.id, { title: 'w1', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    store.scheduleArc(other.id, { mode: 'auto', triggers: [{ type: 'gauge', condition: { gaugeId: g1, operator: 'gte', value: 80 } }] });
    arc().nodes[3].completionConditions = [{ gaugeId: g1, operator: 'gte', value: 50 }];

    const rep = commitRevise(store, arcId, revise([protoNode('道德抉择'), protoNode('全市模拟考')], {
      gauges: [{ name: '决心', min: 0, max: 10, unit: '点' }],   // 怀疑 not kept → removed
    }));
    expect(rep.ok).toBe(true);
    expect(rep.removedGaugeNames).toEqual(['怀疑']);
    expect(rep.newGaugeNames).toEqual(['决心']);
    expect(arc().gauges.map(g => g.name)).toEqual(['决心']);
    expect(rep.danglingGaugeRefs.triggers).toBe(1);
    expect(rep.danglingGaugeRefs.conditions).toBe(1);
    expect(store.arcs.find(a => a.id === other.id)!.activation!.triggers).toEqual([]);

    // kept-gauge branch: fresh store state
    const rep2 = commitRevise(store, arcId, revise([protoNode('道德抉择'), protoNode('全市模拟考')], {
      gauges: [{ name: '决心', description: '新描述', max: 20 }],
    }));
    expect(rep2.updatedGaugeNames).toEqual(['决心']);
    expect(arc().gauges[0].description).toBe('新描述');
    expect(arc().gauges[0].max).toBe(20);
  });

  it('an explicit current overrides and clamps; an empty gauges list leaves gauges untouched', () => {
    commitRevise(store, arcId, revise([protoNode('道德抉择')], {
      gauges: [{ name: '怀疑', current: 999 }],
    }));
    expect(arc().gauges[0].current).toBe(100);
    const before = arc().gauges.map(g => g.id);
    const rep = commitRevise(store, arcId, revise([protoNode('道德抉择')]));
    expect(rep.ok).toBe(true);
    expect(arc().gauges.map(g => g.id)).toEqual(before);
  });

  it('removed node ids prune node_completed triggers on other threads — reported, and kept ids stay valid', () => {
    const keptId = arc().nodes[2].id;      // 道德抉择 (kept)
    const removedId = arc().nodes[3].id;   // 全市模拟考 (removed)
    const waiterKept = store.createArc('等待保留节点', '');
    store.addNode(waiterKept.id, { title: 'w', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    store.scheduleArc(waiterKept.id, { mode: 'auto', triggers: [{ type: 'node_completed', arcId, nodeId: keptId }] });
    const waiterGone = store.createArc('等待被删节点', '');
    store.addNode(waiterGone.id, { title: 'w', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    store.scheduleArc(waiterGone.id, { mode: 'auto', triggers: [{ type: 'node_completed', arcId, nodeId: removedId }] });

    const rep = commitRevise(store, arcId, revise([protoNode('道德抉择')]));
    expect(rep.ok).toBe(true);
    expect(rep.danglingTriggers).toEqual([{ arcTitle: '等待被删节点', removed: 1 }]);
    expect(store.arcs.find(a => a.id === waiterGone.id)!.activation!.triggers).toEqual([]);
    const keptTrigger = store.arcs.find(a => a.id === waiterKept.id)!.activation!.triggers[0];
    expect(evaluateThreadTrigger(keptTrigger, { arcs: store.arcs, currentRound: 10 }))
      .toEqual({ satisfied: false, reason: 'waiting' });
  });

  it('rejects: unknown arc, completed thread, empty nodes on a non-active thread, stale pending snapshot', () => {
    expect(commitRevise(store, arcId + 'x', revise([])).error).toBe('not_found');

    const done = store.createArc('完结线', '');
    store.addNode(done.id, { title: 'd', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    done.status = 'completed';
    expect(commitRevise(store, done.id, revise([protoNode('x')])).error).toBe('not_revisable');

    const draft = store.createArc('草稿线', '');
    store.addNode(draft.id, { title: 'd1', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    expect(commitRevise(store, draft.id, revise([])).error).toBe('empty_nodes');

    // stale: proposal was made when 道德抉择+全市模拟考 were pending, but one got removed since
    const snapshot = arc().nodes.filter(n => n.status === 'pending').map(n => n.id);
    store.removeNode(arcId, snapshot[1]);
    const rep = commitRevise(store, arcId, revise([protoNode('道德抉择')]), { expectedPendingIds: snapshot });
    expect(rep.error).toBe('stale');
    // matching snapshot passes
    const fresh = arc().nodes.filter(n => n.status === 'pending').map(n => n.id);
    expect(commitRevise(store, arcId, revise([protoNode('道德抉择')]), { expectedPendingIds: fresh }).ok).toBe(true);
  });

  it('empty nodes on an ACTIVE thread cuts the future: pending gone, prefix intact', () => {
    const rep = commitRevise(store, arcId, revise([]));
    expect(rep.ok).toBe(true);
    expect(rep.removedNodeIds).toHaveLength(2);
    expect(arc().nodes.map(n => n.status)).toEqual(['completed', 'active']);
  });

  it('previewRevise: all four badge kinds, gauge groups with sequential consumption, both dangling warnings — and never mutates', () => {
    const g1 = arc().gauges[0].id;
    // waiters that will show up as dangling warnings
    const trigWaiter = store.createArc('等待被删节点', '');
    store.addNode(trigWaiter.id, { title: 'w', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    store.scheduleArc(trigWaiter.id, { mode: 'auto', triggers: [{ type: 'node_completed', arcId, nodeId: arc().nodes[3].id }] });
    const gaugeWaiter = store.createArc('等待度量', '');
    store.addNode(gaugeWaiter.id, { title: 'w', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [] });
    store.scheduleArc(gaugeWaiter.id, { mode: 'auto', triggers: [{ type: 'gauge', condition: { gaugeId: g1, operator: 'gte', value: 80 } }] });

    const before = JSON.stringify(store.arcs);
    // kept = unchanged content requires echoing every content field of the original
    const original = arc().nodes[2];
    const keptEcho = protoNode('道德抉择', {
      narrativeGoal: original.narrativeGoal, directive: original.directive, completionHint: original.completionHint,
      premise: original.premise, stakes: original.stakes, importance: original.importance,
      maxRounds: original.maxRounds, opportunityTiers: [],
    });
    const p = previewRevise(store.arcs, arc(), revise([
      keptEcho,                                  // kept
      protoNode('主动退赛'),                      // added
    ], {
      gauges: [{ name: '怀疑', current: 80 }, { name: '怀疑' }, { name: '决心' }],
    }));
    expect(p.rows.map(r => ({ kind: r.kind, title: r.title }))).toEqual([
      { kind: 'kept', title: '道德抉择' },
      { kind: 'added', title: '主动退赛' },
    ]);
    // details: kept rows have none; added rows expose every non-empty field's content
    expect(p.rows[0].details).toEqual([]);
    expect(p.rows[1].details).toEqual(expect.arrayContaining([
      { field: 'narrativeGoal', after: 'g-主动退赛' },
      { field: 'directive', after: 'd-主动退赛' },
      { field: 'premise', after: 'p-主动退赛' },
      { field: 'importance', after: 'critical' },
    ]));
    expect(p.removedTitles).toEqual(['全市模拟考']);
    // sequential consumption: the SECOND 怀疑 previews as added (mirrors commitRevise/addGauge)
    expect(p.gaugeUpdated).toEqual(['怀疑']);
    expect(p.gaugeAdded).toEqual(['怀疑', '决心']);
    expect(p.gaugeRemoved).toEqual([]);
    expect(p.danglingTriggerArcs).toEqual(['等待被删节点']);
    expect(p.danglingGaugeArcs).toEqual([]);      // 怀疑 is kept → no gauge warning
    expect(JSON.stringify(store.arcs)).toBe(before); // pure

    // modified badge + per-field old→new details + gauge removal warning
    const p2 = previewRevise(store.arcs, arc(), revise([protoNode('道德抉择')], {
      gauges: [{ name: '决心' }],
    }));
    expect(p2.rows.map(r => ({ kind: r.kind, title: r.title }))).toEqual([{ kind: 'modified', title: '道德抉择' }]);
    expect(p2.rows[0].details).toEqual(expect.arrayContaining([
      { field: 'narrativeGoal', before: 'goal-道德抉择', after: 'g-道德抉择' },
      { field: 'importance', before: 'skippable', after: 'critical' },
    ]));
    // in-progress node diff for the preview's "guidance updated" expansion
    const p2b = previewRevise(store.arcs, arc(), revise([protoNode('道德抉择')], {
      activeNodeUpdate: { directive: '指向新未来' },
    }));
    expect(p2b.activeNodeDetails).toEqual([{ field: 'directive', after: '指向新未来' }]);
    expect(p2.activeNodeDetails).toEqual([]);
    expect(p2.gaugeRemoved).toEqual(['怀疑']);
    expect(p2.danglingGaugeArcs).toEqual(['等待度量']);
    // empty gauges list → untouched, no removal previewed
    const p3 = previewRevise(store.arcs, arc(), revise([protoNode('道德抉择')]));
    expect(p3.gaugeRemoved).toEqual([]);
    expect(p3.danglingGaugeArcs).toEqual([]);
  });

  it('busy during evaluation is a TRUE no-op: nothing applies now, and nothing fires later when the mutex flushes (review C1)', () => {
    store.setEvaluating(true);
    const rep = commitRevise(store, arcId, revise([protoNode('新节点')], { synopsis: '不应写入' }));
    expect(rep.error).toBe('busy');
    expect(arc().synopsis).toBe('旧概要');
    expect(arc().nodes.map(n => n.title)).toContain('全市模拟考');
    // The critical part: ending the evaluation must NOT ghost-apply the region.
    store.setEvaluating(false);
    expect(arc().nodes.map(n => n.title)).toEqual(['发现秘密', '模拟考异常', '道德抉择', '全市模拟考']);
    expect(arc().synopsis).toBe('旧概要');
  });
});
