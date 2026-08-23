// App doc: docs/user-guide/pages/game-plot.md §数据流 (焦点节点"相关设定"语料)
// Design: docs/design/plot-parallel-threads-scheduler.md §7.3 ("相关设定"随焦点节点注入)
/**
 * Plot Threads — world-book corpus contribution.
 *
 * The focus thread's current node (title + premise + directive + narrative goal)
 * is fed into the world-book keyword corpora so Canon entries keyed on plot
 * nouns (places, factions, items, event names) auto-enter the prompt while
 * that node is active and drop out when it completes — no new prompt, no new
 * API call; budget stays under the selector's `capturedBudgetRatio`.
 *
 * Background threads are deliberately NOT included (they would compete for
 * the same budget every round).
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { PlotDirectionState } from './types';
import { resolveFocusArc } from './types';

/** Texts describing the focus thread's active node, or [] when there is none / plot is disabled. */
export function buildPlotFocusCorpusTexts(
  stateManager: Pick<StateManager, 'get'>,
  paths: Pick<EnginePathConfig, 'plotDirection'>,
): string[] {
  if (stateManager.get<boolean>('系统.设置.plot.enabled') === false) return [];
  const state = stateManager.get<PlotDirectionState>(paths.plotDirection);
  const arc = resolveFocusArc(state);
  if (!arc) return [];
  const node = arc.nodes.find(n => n.status === 'active');
  if (!node) return [];
  return [node.title, node.premise, node.narrativeGoal, node.directive]
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);
}
