// App doc: docs/user-guide/pages/game-save.md §2.5.2
/**
 * Card state-tree stripper — Story 5 (P2).
 *
 * Pure functions: take a state-tree snapshot + an injected CardStripPaths config
 * + the export flags, return a NEW deep-cloned, trimmed tree. ZERO mutation of the
 * input, ZERO hardcoded field names (all paths injected, CLAUDE.md §4/§5).
 *
 * Contract for the importer (Story 6): the card stateTree is a SPARSE world-setup
 * overlay — stripped keys are DELETED, not emptied. Import must initialize a
 * schema-default save, then deep-merge the card's stateTree onto it.
 *
 * Path syntax: a "*" segment matches any object key / array index
 * (e.g. "社交.关系.*.记忆"). Mirrors snapshot-sanitizer's wildcard style.
 */
import type { CardStripPaths } from './card-export-paths';
import type { ExportFlags, ProtagonistMode } from './game-card-bundle.types';

// ─── Path helpers ────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Read a value by a plain dot-path (no wildcards). */
export function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Set a value by a plain dot-path (no wildcards); creates intermediate objects. */
function setByPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!isRecord(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/** Delete the leaf at a wildcard-aware path. "*" recurses into every child. */
function deleteByPath(root: unknown, segments: string[]): void {
  if (segments.length === 0 || root === null || typeof root !== 'object') return;
  const [head, ...rest] = segments;

  if (head === '*') {
    // Snapshot array children — a terminal splice in the recursion must not shift a live iteration.
    const children = Array.isArray(root) ? [...root] : Object.values(root as Record<string, unknown>);
    for (const child of children) deleteByPath(child, rest);
    return;
  }

  if (rest.length === 0) {
    if (Array.isArray(root)) {
      const idx = Number(head);
      if (Number.isInteger(idx) && idx >= 0 && idx < root.length) root.splice(idx, 1);
    } else {
      delete (root as Record<string, unknown>)[head];
    }
    return;
  }

  const next = Array.isArray(root) ? root[Number(head)] : (root as Record<string, unknown>)[head];
  deleteByPath(next, rest);
}

function deletePaths(tree: Record<string, unknown>, paths: readonly string[]): void {
  for (const p of paths) deleteByPath(tree, p.split('.'));
}

/** Recursively collect every string leaf within a value. */
function collectNestedStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNestedStrings(v, out);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) collectNestedStrings(v, out);
  }
}

/**
 * Collect all string leaves found at a wildcard-aware path (e.g. "社交.关系.*.私密信息").
 * Used to gather private/NSFW text for cross-checking the exported Engram graph (SC-9).
 */
export function collectStringsAtPath(root: unknown, segments: string[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown, segs: string[]): void => {
    // Terminal check FIRST: a string sitting exactly at the target path must be collected
    // (collectNestedStrings handles the string case). Ordering this after the non-object
    // guard would silently drop string leaves — a real NSFW-redaction miss (SC-9).
    if (segs.length === 0) { collectNestedStrings(node, out); return; }
    if (node === null || typeof node !== 'object') return;
    const [head, ...rest] = segs;
    if (head === '*') {
      const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
      for (const child of children) walk(child, rest);
      return;
    }
    const next = Array.isArray(node) ? node[Number(head)] : (node as Record<string, unknown>)[head];
    walk(next, rest);
  };
  walk(root, segments);
  return out;
}

// ─── Resets ──────────────────────────────────────────────────────

/**
 * Reset plot arcs/nodes/gauges to their authored baseline (progress → not-started).
 *
 * Plot Threads epic: every thread goes back to `draft` — including `scheduled`
 * ones — but its `activation` triggers are AUTHORED content and are kept. Ids
 * are never regenerated here, so `node_completed` / `thread_completed`
 * triggers still resolve after import (design §3.2 / §9.5).
 */
function resetPlotProgress(plot: unknown): void {
  if (!isRecord(plot)) return;
  plot['activeArcIndex'] = null;
  if ('pendingConfirmation' in plot) plot['pendingConfirmation'] = null;
  if ('focusArcId' in plot) plot['focusArcId'] = null;
  if ('pendingConfirmations' in plot) plot['pendingConfirmations'] = [];

  const arcs = plot['arcs'];
  if (!Array.isArray(arcs)) return;
  for (const arc of arcs) {
    if (!isRecord(arc)) continue;
    arc['status'] = 'draft';

    const nodes = arc['nodes'];
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (!isRecord(node)) continue;
        node['status'] = 'pending';
        delete node['activatedAtRound'];
        delete node['completedAtRound'];
        delete node['activatedAtTime'];
        delete node['completedAtTime'];
        delete node['completionEvidence'];
        node['consecutiveReachedCount'] = 0;
      }
    }

    const gauges = arc['gauges'];
    if (Array.isArray(gauges)) {
      for (const g of gauges) {
        if (!isRecord(g)) continue;
        if (typeof g['initialValue'] !== 'undefined') g['current'] = g['initialValue'];
        delete g['boundaryFiredAtRound'];
        delete g['lastAutoDecrementRound'];
      }
    }
  }
}

/**
 * Reset reputation→0 and each vital's current→cap (gameplay progress, not world setup).
 * Operates IN-PLACE on `tree` — only ever called on the already-`structuredClone`d copy
 * inside `stripStateTreeForCard`, so the live save is never touched (SC-8).
 */
function resetVariableAttributes(tree: Record<string, unknown>, cfg: CardStripPaths['variableReset']): void {
  const rep = getByPath(tree, cfg.reputationPath);
  if (typeof rep === 'number') {
    // reputationPath points at the value itself; rewrite via its parent.
    const segs = cfg.reputationPath.split('.');
    const parent = getByPath(tree, segs.slice(0, -1).join('.'));
    if (isRecord(parent)) parent[segs[segs.length - 1]] = 0;
  }
  for (const vitalPath of cfg.vitalPaths) {
    const vital = getByPath(tree, vitalPath);
    if (isRecord(vital) && typeof vital[cfg.vitalCapField] === 'number') {
      vital[cfg.vitalCurrentField] = vital[cfg.vitalCapField];
    }
  }
}

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Produce a deep-cloned, card-trimmed copy of `tree`.
 * NOTE: the caller (GameCardExportService) extracts engram entities/edges from the
 * ORIGINAL tree BEFORE calling this — this clears engramMemory to avoid double-carry.
 */
export function stripStateTreeForCard(
  tree: Record<string, unknown>,
  paths: CardStripPaths,
  flags: ExportFlags,
  protagonistMode: ProtagonistMode,
): Record<string, unknown> {
  const t = structuredClone(tree);

  // 0. blank protagonist: the player creates the character on import → drop 角色 entirely.
  //    fixed/template keep the (trimmed) 角色 in stateTree as the single source.
  if (protagonistMode === 'blank') deleteByPath(t, paths.characterRoot.split('.'));

  // 1. Always-strip: gameplay history, secrets, engram graph (extracted separately).
  deletePaths(t, paths.gameplayHistory);
  deletePaths(t, paths.secrets);
  deleteByPath(t, paths.engramMemory.split('.'));
  // Canon Capture: ALWAYS leaves the state tree. When the author opted into world books
  // the service re-adds it to the `worldBooks` payload (converted to a profile book);
  // leaving it here as well would ship the same content twice AND smuggle it past the
  // author's own "include world books" decision.
  deleteByPath(t, paths.capturedSettings.split('.'));

  // 2. UI settings: capture promptSettings (游戏设定) if kept, strip 系统.设置 wholesale, restore.
  let keptPromptSettings: unknown;
  if (flags.includedPromptSettings) keptPromptSettings = getByPath(t, paths.promptSettings);
  deleteByPath(t, paths.systemSettings.split('.'));
  if (flags.includedPromptSettings && keptPromptSettings !== undefined) {
    setByPath(t, paths.promptSettings, keptPromptSettings);
  }

  // 3. Heroine plan (剧情规划·女主线): strip unless kept.
  if (!flags.includedHeroinePlan) deleteByPath(t, paths.heroinePlan.split('.'));

  // 4. Plot direction (剧情走向): strip unless kept; if kept, reset progress to baseline.
  if (!flags.includedPlotDirection) {
    deleteByPath(t, paths.plotDirection.split('.'));
  } else {
    resetPlotProgress(getByPath(t, paths.plotDirection));
  }

  // 5. NSFW: strip body / private profiles / secret-part images unless the card includes adult content.
  if (!flags.containsNsfw) deletePaths(t, paths.nsfw);

  // 6. Image generation history: strip unless opted in (selected portraits/wallpaper ids survive).
  if (!flags.includedGenerationHistory) deletePaths(t, paths.generationHistory);

  // 7. Reference gallery: strip unless opted in.
  if (!flags.includedReferenceGallery) deletePaths(t, paths.referenceGallery);

  // 8. Reset variable attributes (reputation/vitals) to baseline.
  resetVariableAttributes(t, paths.variableReset);

  return t;
}
