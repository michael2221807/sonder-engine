// App doc: docs/user-guide/pages/game-main.md §3.8.2（被拒绝的指令 · 度量值影子）
/**
 * Plot gauges live in the plot state alone and change only through a verdict's `gauge_updates`, bounded per round.
 * Step 2 also wrote some of them as commands to other places in the save (`系统.<gauge>`, `角色.身体.<gauge>`, a root
 * `<gauge>` …): a shadow copy that drifted from the real value and that the model then read back, so the story's
 * numbers disagreed with the gauge bar (PO 2026-10-05; docs/research/numeric-status-lines-2026-10-05.md §1.3).
 *
 * A shadow is told apart from a real field by two facts the save itself holds: the key is the name of one of the
 * save's gauges, and the pack's state schema does not declare the path (a declared field that happens to share a
 * gauge's name, such as an NPC's affinity, is left alone). Nothing here names a game field.
 */
import type { StateManager } from '../core/state-manager';
import { splitPathSegments, segmentKey } from '../core/command-executor';
import type { PlotDirectionState } from './types';

/** Whether a state path is the plot state or inside it. */
function insidePlotState(path: string, plotDirectionPath: string): boolean {
  return path === plotDirectionPath || path.startsWith(`${plotDirectionPath}.`) || path.startsWith(`${plotDirectionPath}[`);
}

/** The names of every gauge of every plot thread in the save (blank names left out). */
export function plotGaugeNames(stateManager: Pick<StateManager, 'get'>, plotDirectionPath: string): Set<string> {
  const state = stateManager.get<PlotDirectionState>(plotDirectionPath);
  const names = new Set<string>();
  for (const arc of Array.isArray(state?.arcs) ? state.arcs : []) {
    for (const gauge of Array.isArray(arc?.gauges) ? arc.gauges : []) {
      const name = typeof gauge?.name === 'string' ? gauge.name.trim() : '';
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * A command path that writes a gauge outside the plot state: its last field is a gauge's name and the pack schema
 * does not declare the path.
 */
export function isGaugeShadowPath(
  path: string,
  gaugeNames: ReadonlySet<string>,
  declares: (path: string) => boolean,
  plotDirectionPath: string,
): boolean {
  if (gaugeNames.size === 0) return false;
  const key = path.trim();
  if (!key || insidePlotState(key, plotDirectionPath)) return false;
  const segments = splitPathSegments(key);
  const last = segments.length > 0 ? segmentKey(segments[segments.length - 1]) : '';
  return gaugeNames.has(last) && !declares(key);
}

/** How deep the search for shadows goes; the shadows seen sit two or three fields down. */
const MAX_SHADOW_DEPTH = 6;

/**
 * The shadow copies a state tree already holds: object fields named after a gauge, outside the plot state, at a
 * path the pack schema does not declare. Lists are not searched (no shadow was ever written into one). The paths
 * are plain dotted paths, the form the prompt snapshot's strip list takes.
 */
export function findGaugeShadowPaths(
  tree: Record<string, unknown>,
  gaugeNames: ReadonlySet<string>,
  declares: (path: string) => boolean,
  plotDirectionPath: string,
): string[] {
  const found: string[] = [];
  if (gaugeNames.size === 0) return found;
  const walk = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (insidePlotState(path, plotDirectionPath)) continue;
      if (gaugeNames.has(key) && !declares(path)) { found.push(path); continue; }
      if (depth < MAX_SHADOW_DEPTH && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path, depth + 1);
      }
    }
  };
  walk(tree, '', 1);
  return found;
}

/** A state value without the shadow paths under `basePath` (a copy when anything is left out; the value otherwise). */
export function withoutStatePaths(value: unknown, basePath: string, paths: readonly string[]): unknown {
  const under = paths.filter((p) => p.startsWith(`${basePath}.`));
  if (under.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  // A JSON copy: state values can be reactive proxies, which structuredClone refuses.
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const path of under) {
    const keys = path.slice(basePath.length + 1).split('.');
    let node: unknown = copy;
    for (const k of keys.slice(0, -1)) {
      node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined;
    }
    if (node !== null && typeof node === 'object') delete (node as Record<string, unknown>)[keys[keys.length - 1]];
  }
  return copy;
}
