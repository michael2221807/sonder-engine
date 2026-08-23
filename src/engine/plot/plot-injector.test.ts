/**
 * Plot Threads — PlotInjector variables.
 * P1: Step 2 contract across 0 / 1 / N active threads (design §4.3, §8.4 ①④).
 * P2 extends this file with Step 1 focus/background blocks.
 */
import { describe, it, expect } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotInjector } from './plot-injector';
import type { PlotArc, PlotNode, PlotGauge, PlotDirectionState } from './types';

function node(id: string, arcId: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: `goal-${id}`, directive: `dir-${id}`, completionHint: `hint-${id}`,
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0, ...over,
  };
}
function gauge(name: string, aiUpdatable = true): PlotGauge {
  return { id: 'g_' + name, name, description: '', min: 0, max: 100, current: 40, initialValue: 0, unit: '%', showInMainPanel: false, aiUpdatable, maxDeltaPerRound: 25 };
}
function arc(id: string, title: string, over: Partial<PlotArc> = {}): PlotArc {
  return { id, title, synopsis: '', status: 'active', gauges: [], nodes: [node(id + '1', id, { status: 'active', activatedAtRound: 3 })], ...over };
}
function sm(state: PlotDirectionState): StateManager {
  const m = new StateManager();
  m.loadTree({ 元数据: { 剧情导向: state, 回合序号: 10 } });
  return m;
}

describe('PlotInjector.buildStep1Variables (focus + background, P2)', () => {
  it('returns {} with no active thread; single thread emits an empty background block (template renders nothing)', () => {
    expect(PlotInjector.buildStep1Variables(sm({ arcs: [arc('a', 'A', { status: 'draft' })], activeArcIndex: null }), DEFAULT_ENGINE_PATHS)).toEqual({});
    const v = PlotInjector.buildStep1Variables(sm({ arcs: [arc('a', 'A')], activeArcIndex: 0 }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_BACKGROUND_THREADS).toBe('');
    expect(v.PLOT_FOCUS_TITLE).toBe('A');
    expect(v.PLOT_DIRECTIVE).toContain('【当前节点：a1】');
  });

  it('focus thread gets the full directive incl. 承接/改变; other active threads collapse to one line each with compact gauges', () => {
    const focus = arc('f', '高考冲刺篇', { lane: 0, gauges: [gauge('怀疑')] });
    focus.nodes = [
      node('f0', 'f', { status: 'completed', title: '发现禁药秘密', completionEvidence: '目睹好友服药' }),
      node('f1', 'f', { status: 'active', activatedAtRound: 3, title: '模拟考异常', premise: '承接禁药秘密', stakes: '怀疑公开化', emotionalTone: 'tension' }),
    ];
    const bg = arc('b', '社团风波', { lane: 1, gauges: [gauge('社长信任')] });
    bg.nodes[0].title = '匿名信';
    bg.nodes[0].narrativeGoal = '匿名信指向校长';
    const v = PlotInjector.buildStep1Variables(sm({ arcs: [bg, focus], activeArcIndex: 1, focusArcId: 'f' }), DEFAULT_ENGINE_PATHS);

    expect(v.PLOT_FOCUS_TITLE).toBe('高考冲刺篇');
    expect(v.PLOT_DIRECTIVE).toContain('已完成：发现禁药秘密：目睹好友服药');
    expect(v.PLOT_DIRECTIVE).toContain('承接：承接禁药秘密');
    expect(v.PLOT_DIRECTIVE).toContain('改变：怀疑公开化');
    expect(v.PLOT_DIRECTIVE).not.toContain('社团风波');
    expect(v.PLOT_BACKGROUND_THREADS).toContain('【并行中的其他剧情线】');
    expect(v.PLOT_BACKGROUND_THREADS).toContain('- 《社团风波》当前：匿名信 — 匿名信指向校长 · 度量：社长信任40%');
    expect(v.PLOT_BACKGROUND_THREADS).not.toContain('高考冲刺篇');
    // GAP-14 sub-variables
    expect(v.PLOT_NODE_PREMISE).toBe('承接禁药秘密');
    expect(v.PLOT_GAUGES).toBe('怀疑40%');
    expect(v.PLOT_COMPLETED_SUMMARY).toBe('发现禁药秘密：目睹好友服药');
    expect(v.PLOT_IS_FIRST_ROUND).toBe('');
  });

  it('three active threads: two background lines in lane order, focus excluded', () => {
    const a = arc('a', 'A', { lane: 0 });
    const b = arc('b', 'B', { lane: 2 });
    const c = arc('c', 'C', { lane: 1 });
    const v = PlotInjector.buildStep1Variables(sm({ arcs: [a, b, c], activeArcIndex: 0, focusArcId: 'a' }), DEFAULT_ENGINE_PATHS);
    const bg = v.PLOT_BACKGROUND_THREADS;
    expect(bg.startsWith('\n')).toBe(true); // separates from the template sentence
    const lines = bg.split('\n').filter(l => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('《C》');
    expect(lines[1]).toContain('《B》');
    expect(bg).not.toContain('《A》');
  });

  it('labels come from engineFragments (EN pack renders no Chinese scaffolding)', () => {
    const focus = arc('f', 'Exam Arc', { gauges: [gauge('Suspicion')] });
    focus.nodes[0].premise = 'after the pills';
    const bg = arc('b', 'Club Arc');
    const en = {
      plotCurrentNodeLabel: '[Current node: {title}]', plotPremiseLabel: 'Builds on: {text}', plotDirectiveLabel: 'Guidance: {text}',
      plotEventLabel: 'Event: {text}', plotGaugesHeader: '[Plot gauges]', plotGaugesHint: 'reflect them', plotGaugeLine: '- {name}: {current}/{max}{unit} ({range}){desc}',
      plotBackgroundHeader: '[Other threads]', plotBackgroundLine: '- "{title}" now at: {node}{goal}{gauges}', plotBackgroundHint: 'keep consistent',
      plotEvalThreadHeader: '[Thread {index}: {title}]', plotEvalNodeLabel: 'Current node: {title}', plotEvalEventLabel: 'Node event: {text}', plotEvalHintLabel: 'Criteria: "{text}"',
      plotGaugeInstrHeaderMulti: 'report per thread:', plotGaugeInstrThread: '[{title}]', plotGaugeInstrLine: '- "{name}": now {current}/{max}{unit}{desc}',
      plotGaugeInstrFormat: 'fmt', plotGaugeInstrNote: 'note', plotThreadTitleSep: ', ',
    };
    const s = sm({ arcs: [focus, bg], activeArcIndex: 0, focusArcId: 'f' });
    const v1 = PlotInjector.buildStep1Variables(s, DEFAULT_ENGINE_PATHS, en);
    const v2 = PlotInjector.buildStep2Variables(s, DEFAULT_ENGINE_PATHS, en);
    const all = v1.PLOT_DIRECTIVE + v1.PLOT_BACKGROUND_THREADS + v2.PLOT_EVAL_CONTEXT + v2.PLOT_GAUGE_INSTRUCTIONS + v2.PLOT_THREAD_TITLES;
    expect(all).toContain('[Current node: f1]');
    expect(all).toContain('Builds on: after the pills');
    expect(all).toContain('[Other threads]');
    expect(all).toContain('[Thread 1: Exam Arc]');
    expect(v2.PLOT_THREAD_TITLES).toBe('Exam Arc, Club Arc');
    expect(/[一-鿿]/.test(all)).toBe(false);
  });

  it('clips long completion evidence in the ledger line', () => {
    const a = arc('a', 'A');
    a.nodes = [node('a0', 'a', { status: 'completed', completionEvidence: 'x'.repeat(200) }), node('a1', 'a', { status: 'active', activatedAtRound: 3 })];
    const v = PlotInjector.buildStep1Variables(sm({ arcs: [a], activeArcIndex: 0 }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_COMPLETED_SUMMARY.length).toBeLessThan(100);
    expect(v.PLOT_COMPLETED_SUMMARY.endsWith('…')).toBe(true);
  });

  it('focus follows focusArcId, not array order', () => {
    const a = arc('a', 'A', { lane: 0 });
    const b = arc('b', 'B', { lane: 1 });
    const v = PlotInjector.buildStep1Variables(sm({ arcs: [a, b], activeArcIndex: 0, focusArcId: 'b' }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_FOCUS_TITLE).toBe('B');
    expect(v.PLOT_BACKGROUND_THREADS).toContain('《A》');
  });
});

describe('PlotInjector.buildStep2Variables', () => {
  it('returns {} when nothing is active (flow condition stays off)', () => {
    expect(PlotInjector.buildStep2Variables(sm({ arcs: [arc('a', 'A', { status: 'draft' })], activeArcIndex: null }), DEFAULT_ENGINE_PATHS)).toEqual({});
  });

  it('single thread keeps the legacy-readable shape: one block, the hint as PLOT_COMPLETION_HINT', () => {
    const v = PlotInjector.buildStep2Variables(sm({ arcs: [arc('a', '高考冲刺篇', { gauges: [gauge('怀疑')] })], activeArcIndex: 0 }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_THREAD_COUNT).toBe('1');
    expect(v.PLOT_THREAD_TITLES).toBe('高考冲刺篇');
    expect(v.PLOT_COMPLETION_HINT).toBe('hint-a1');
    expect(v.PLOT_EVAL_CONTEXT).toContain('弧线：高考冲刺篇');
    expect(v.PLOT_EVAL_CONTEXT).toContain('完成标志："hint-a1"');
    expect(v.PLOT_EVAL_CONTEXT).not.toContain('【剧情线 1');
    expect(v.PLOT_GAUGE_INSTRUCTIONS).not.toContain('〔');
  });

  it('several threads: one numbered block per thread in lane order, hints joined, gauges grouped per thread', () => {
    const v = PlotInjector.buildStep2Variables(sm({
      arcs: [
        arc('b', '社团风波', { lane: 2, gauges: [gauge('社长信任'), gauge('倒计时', false)] }),
        arc('a', '高考冲刺篇', { lane: 1, gauges: [gauge('怀疑')] }),
        arc('z', '已完成', { status: 'completed' }),
      ],
      activeArcIndex: 1,
    }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_THREAD_COUNT).toBe('2');
    expect(v.PLOT_THREAD_TITLES).toBe('高考冲刺篇、社团风波');
    expect(v.PLOT_COMPLETION_HINT).toBe('hint-a1 / hint-b1');
    const ctx = v.PLOT_EVAL_CONTEXT;
    expect(ctx.indexOf('【剧情线 1：高考冲刺篇】')).toBeGreaterThanOrEqual(0);
    expect(ctx.indexOf('【剧情线 2：社团风波】')).toBeGreaterThan(ctx.indexOf('【剧情线 1：高考冲刺篇】'));
    expect(ctx).toContain('节点事件：goal-b1');
    expect(ctx).not.toContain('已完成');
    const gi = v.PLOT_GAUGE_INSTRUCTIONS;
    expect(gi).toContain('对应剧情线条目');
    expect(gi.indexOf('〔高考冲刺篇〕')).toBeLessThan(gi.indexOf('〔社团风波〕'));
    expect(gi).toContain('"怀疑"');
    expect(gi).toContain('"社长信任"');
    expect(gi).toContain('由系统管理，请勿修改：倒计时');
  });

  it('a thread whose hint is blank still yields a non-empty PLOT_COMPLETION_HINT so the flow condition fires', () => {
    const a = arc('a', 'A');
    a.nodes[0].completionHint = '';
    const v = PlotInjector.buildStep2Variables(sm({ arcs: [a], activeArcIndex: 0 }), DEFAULT_ENGINE_PATHS);
    expect(v.PLOT_COMPLETION_HINT).toBe('a1');
  });
});
