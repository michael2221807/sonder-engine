import { describe, it, expect } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { buildPlotFocusCorpusTexts } from './plot-corpus';
import type { PlotDirectionState, PlotNode } from './types';

function node(id: string, arcId: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: '', directive: '', completionHint: '',
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0, ...over,
  };
}
function sm(state: PlotDirectionState | undefined, enabled?: boolean): StateManager {
  const m = new StateManager();
  m.loadTree({ 元数据: { 剧情导向: state }, 系统: { 设置: { plot: { enabled } } } });
  return m;
}

describe('buildPlotFocusCorpusTexts', () => {
  const state: PlotDirectionState = {
    arcs: [
      { id: 'bg', title: '背景线', synopsis: '', status: 'active', lane: 1, gauges: [],
        nodes: [node('b1', 'bg', { status: 'active', title: '社团风波', directive: '匿名信' })] },
      { id: 'fg', title: '焦点线', synopsis: '', status: 'active', lane: 0, gauges: [],
        nodes: [node('f0', 'fg', { status: 'completed', title: '旧节点' }),
          node('f1', 'fg', { status: 'active', title: '模拟考异常', premise: ' 承接禁药秘密 ', narrativeGoal: '好友成绩异常', directive: '推进到对峙' })] },
    ],
    activeArcIndex: 1, focusArcId: 'fg',
  };

  it('returns the focus thread active node texts only (not background threads, not completed nodes)', () => {
    expect(buildPlotFocusCorpusTexts(sm(state), DEFAULT_ENGINE_PATHS))
      .toEqual(['模拟考异常', '承接禁药秘密', '好友成绩异常', '推进到对峙']);
  });

  it('returns [] when plot is disabled, when there is no plot state, or when nothing is active', () => {
    expect(buildPlotFocusCorpusTexts(sm(state, false), DEFAULT_ENGINE_PATHS)).toEqual([]);
    expect(buildPlotFocusCorpusTexts(sm(undefined), DEFAULT_ENGINE_PATHS)).toEqual([]);
    expect(buildPlotFocusCorpusTexts(sm({ arcs: [{ ...state.arcs[1], status: 'completed' }], activeArcIndex: null }), DEFAULT_ENGINE_PATHS)).toEqual([]);
  });
});
