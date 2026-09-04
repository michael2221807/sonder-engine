// App doc: docs/user-guide/pages/game-prompts.md（Context Compiler · 分步第二步上下文投影）· game-main.md §3.5（指标药丸）
/**
 * Context Compiler v1 — the "policy layer" between context collection and rendering.
 *
 * Design: docs/design/context-compiler-positioning.md (§2 what it is / is not) and
 * docs/design/context-compiler-v1-implementation-plan.md (§2 projection rules).
 * Evidence: docs/research/textual-open-world-r1b-ablation-ab.md (30 real replays).
 *
 * Scope of v1 is deliberately narrow: it only decides what the split-generation
 * SECOND call (commands / options / memory) receives. It never touches step1, never
 * adds an API call, never edits a prompt template. The two renderers
 * (`SystemPromptBuilder` for step1, `PromptAssembler` for step2) stay as they are;
 * this module only changes the VALUES of two template variables
 * (`GAME_STATE_JSON`, `MEMORY_BLOCK`) and how many history pairs step2 sees.
 *
 * Three moves, each backed by the A/B:
 *   1. Sent-registry dedup — step2 does not resend what step1 already carried
 *      (world description, Engram retrieval block).
 *   2. Projection instead of serialization — the location list becomes a
 *      neighbourhood view (full detail only for the current place, its parent,
 *      siblings and children; everything else is a name+parent skeleton), and the
 *      world-event log becomes "recent N + relevant M" instead of the whole ledger.
 *   3. Trace — every decision is recorded with before/after token estimates so the
 *      Prompt Assembly panel can explain what was omitted and why.
 *
 * Engine/content separation: no game-specific field names live here. Everything is
 * read through `EnginePathConfig` (`locationFieldNames.parent`, `worldEventFieldNames`,
 * `worldDescription`, `worldSelection`, `locationPathSeparator`). Trace reasons are
 * i18n keys, translated by the UI.
 */
import type { CompileTrace, CompileTraceEntry, EnginePathConfig } from '../pipeline/types';
import { stringifySnapshotForPrompt } from '../memory/snapshot-sanitizer';
import { estimateTextTokens } from '../core/metrics-helpers';

// ─── Constants (PO decisions 2026-09-04, positioning doc §8.2) ───

/** step2 few-shot history pairs when the compiler is ON. A/B: 1 pair → 2/10 malformed JSON; 5 pairs → 0/10. */
export const STEP2_FEW_SHOT_PAIRS = 2;
/** History pairs for step2 when the compiler is OFF (the former `fewShotPairs` default). */
export const LEGACY_FEW_SHOT_PAIRS = 3;
/** History pairs for the post-round sub-pipelines (field repair, Engram batch solidify). */
export const SUB_PIPELINE_HISTORY_PAIRS = 3;
/** World-event log projection: always keep the newest N entries… */
export const WORLD_EVENT_RECENT_COUNT = 5;
/** …plus at most M older entries relevant to the present NPCs / current location. */
export const WORLD_EVENT_RELEVANT_COUNT = 5;

/** step1 builder piece ids whose content step2 would otherwise duplicate. */
export const STEP1_PIECE_WORLD_PROMPT = 'world_prompt';
export const STEP1_PIECE_ENGRAM = 'memory_engram';

/** Trace reason keys (translated by the UI; see i18n `compiler.reason.*`). */
export const COMPILE_REASON = {
  sentInStep1: 'compiler.reason.sentInStep1',
  adjacency: 'compiler.reason.adjacency',
  /** Adjacency projection ran but the player's current location is not in the list (dirty data). */
  currentNotFound: 'compiler.reason.currentNotFound',
  recentAndRelevant: 'compiler.reason.recentAndRelevant',
  fewShotFixed: 'compiler.reason.fewShotFixed',
} as const;

/**
 * Whether explicit `连接` links count as adjacency (plan §2.2 "留口"). Off in v1: the
 * reference save has no connection data and the PO defined adjacency as same layer +
 * direct parent/child. Flip here (or make it a path-config option) when a pack uses links.
 */
export const LOCATION_ADJACENCY_INCLUDE_CONNECTIONS = false;

// ─── Sent registry ───

/** What step1 already carried this round, derived from the builder's emitted piece ids. */
export interface SentRegistry {
  /** `world_prompt` was emitted → `世界.描述` / world selection are already in step1. */
  worldDescriptionSent: boolean;
  /** `memory_engram` was emitted → the Engram retrieval block is already in step1. */
  engramBlockSent: boolean;
}

export function buildSentRegistry(emittedPieceIds: Iterable<string>): SentRegistry {
  const ids = new Set(emittedPieceIds);
  return {
    worldDescriptionSent: ids.has(STEP1_PIECE_WORLD_PROMPT),
    engramBlockSent: ids.has(STEP1_PIECE_ENGRAM),
  };
}

// ─── Location adjacency projection ───

export interface LocationProjectionResult {
  projected: unknown[];
  /** Entries kept with every field (current + parent + siblings + children). */
  detailCount: number;
  /** Entries reduced to `{ name, parent }`. */
  skeletonCount: number;
  /** The current location was not found in the list (dirty data) — siblings/parent unavailable. */
  currentNotFound: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringField(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Neighbourhood view of the location list (PO decision Q4, 2026-09-04).
 *
 * adjacent = {current} ∪ {parent(current)} ∪ {x | parent(x) == parent(current)} ∪ {x | parent(x) == current}
 *            (∪ current's explicit `connections` when `includeConnections`)
 * Adjacent entries keep every field; the rest keep only name (+ parent when present) so the
 * model can still validate paths, avoid duplicate pushes and build parent chains, but has no
 * detail to elaborate on for places the player is not near.
 *
 * Matching is by NAME, like every other consumer of the location list (map panel, dedup
 * behaviour, name inserter): the engine's location model is name-keyed. If two entries share a
 * name before post-round dedup merges them, both get the same treatment.
 */
export function projectLocations(
  locations: readonly unknown[],
  currentLocationName: string,
  fieldNames: { name: string; parent: string; connections?: string },
  options: { includeConnections?: boolean } = {},
): LocationProjectionResult {
  const records = locations.map(asRecord);
  const current = records.find((r) => r !== null && stringField(r, fieldNames.name) === currentLocationName) ?? null;
  const currentParent = current ? stringField(current, fieldNames.parent) : '';

  const adjacent = new Set<string>();
  if (currentLocationName) adjacent.add(currentLocationName);
  if (currentParent) adjacent.add(currentParent);
  if (options.includeConnections && current && fieldNames.connections) {
    const links = current[fieldNames.connections];
    if (Array.isArray(links)) for (const l of links) if (typeof l === 'string' && l) adjacent.add(l);
  }
  for (const r of records) {
    if (!r) continue;
    const name = stringField(r, fieldNames.name);
    const parent = stringField(r, fieldNames.parent);
    if (!name) continue;
    // Children of the current place — computable even when the current entry itself is missing.
    if (currentLocationName && parent === currentLocationName) adjacent.add(name);
    // Siblings — only when we know the current place's parent.
    if (current && currentParent && parent === currentParent) adjacent.add(name);
  }

  let detailCount = 0;
  let skeletonCount = 0;
  const projected = locations.map((raw, i) => {
    const r = records[i];
    if (!r) return raw; // non-object entries pass through untouched
    const name = stringField(r, fieldNames.name);
    if (name && adjacent.has(name)) {
      detailCount++;
      return raw;
    }
    skeletonCount++;
    const parent = stringField(r, fieldNames.parent);
    const skeleton: Record<string, unknown> = { [fieldNames.name]: r[fieldNames.name] };
    if (parent) skeleton[fieldNames.parent] = parent;
    return skeleton;
  });

  return { projected, detailCount, skeletonCount, currentNotFound: current === null };
}

// ─── World-event log projection ───

export interface WorldEventProjectionOptions {
  /** Names of NPCs present in the scene — an event naming one of them is relevant. */
  presentNpcNames: readonly string[];
  /** Strings that identify the current place (full path and its leaf) — an event mentioning one is relevant. */
  locationKeys: readonly string[];
  fieldNames: { participants: string; scope: string; description: string };
  recent?: number;
  relevant?: number;
}

export interface WorldEventProjectionResult {
  projected: unknown[];
  keptRecent: number;
  keptRelevant: number;
  dropped: number;
}

function eventIsRelevant(rec: Record<string, unknown>, opts: WorldEventProjectionOptions): boolean {
  const participants = rec[opts.fieldNames.participants];
  if (Array.isArray(participants) && opts.presentNpcNames.length > 0) {
    for (const p of participants) {
      if (typeof p === 'string' && opts.presentNpcNames.includes(p)) return true;
    }
  }
  if (opts.locationKeys.length === 0) return false;
  const haystack = `${stringField(rec, opts.fieldNames.scope)}\n${stringField(rec, opts.fieldNames.description)}`;
  return opts.locationKeys.some((k) => k.length > 0 && haystack.includes(k));
}

/**
 * "Recent N + relevant M" view of the world-event ledger (R1b cut A + plan §2.3 cap).
 * Output preserves the original order. Relevance is scanned newest-first so the M
 * relevant slots go to the most recent matches.
 */
export function projectWorldEvents(
  events: readonly unknown[],
  opts: WorldEventProjectionOptions,
): WorldEventProjectionResult {
  const recent = opts.recent ?? WORLD_EVENT_RECENT_COUNT;
  const relevant = opts.relevant ?? WORLD_EVENT_RELEVANT_COUNT;
  const n = events.length;
  const recentStart = Math.max(0, n - recent);
  const keep = new Set<number>();
  for (let i = recentStart; i < n; i++) keep.add(i);

  let keptRelevant = 0;
  for (let i = recentStart - 1; i >= 0 && keptRelevant < relevant; i--) {
    const rec = asRecord(events[i]);
    if (rec && eventIsRelevant(rec, opts)) {
      keep.add(i);
      keptRelevant++;
    }
  }

  const projected: unknown[] = [];
  for (let i = 0; i < n; i++) if (keep.has(i)) projected.push(events[i]);
  return { projected, keptRecent: n - recentStart, keptRelevant, dropped: n - projected.length };
}

// ─── Dot-path helpers (immutable) ───

function readPath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[seg];
  }
  return cur;
}

/** Returns a copy of `root` with `path` set to `value`; intermediate objects are shallow-cloned. */
function withPath(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segs = path.split('.');
  const clone = { ...root };
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = asRecord(cur[segs[i]]);
    if (!next) return root; // path does not exist → nothing to project
    const copied = { ...next };
    cur[segs[i]] = copied;
    cur = copied;
  }
  cur[segs[segs.length - 1]] = value;
  return clone;
}

function tokensOf(value: unknown): number {
  if (value === undefined) return 0;
  return estimateTextTokens(typeof value === 'string' ? value : JSON.stringify(value));
}

// ─── step2 compilation ───

export interface CompileStep2Params {
  /** Frozen state snapshot for this round (`stateManager.toSnapshot()`). */
  snapshot: Record<string, unknown>;
  nsfwMode: boolean;
  /** Strip paths the caller already applies (e.g. `社交.关系` when presence partition is on). */
  additionalStripPaths?: readonly string[];
  registry: SentRegistry;
  paths: EnginePathConfig;
  presentNpcNames: readonly string[];
  /** The current `MEMORY_BLOCK` value (Engram retrieval result) — blanked when step1 already sent it. */
  memoryBlock: string;
}

export interface CompileStep2Result {
  gameStateJson: string;
  /** New `MEMORY_BLOCK` value, or `undefined` to keep the caller's. */
  memoryBlock?: string;
  trace: CompileTrace;
}

function locationKeysFor(currentLocation: string, separator: string): string[] {
  if (!currentLocation) return [];
  const keys = [currentLocation];
  if (separator) {
    const leaf = currentLocation.split(separator).filter(Boolean).pop();
    if (leaf && leaf !== currentLocation) keys.push(leaf);
  }
  return keys;
}

/**
 * Build the step2 `GAME_STATE_JSON` / `MEMORY_BLOCK` values from the frozen snapshot.
 * Pure: the snapshot is never mutated. Same sanitizer as production (`stringifySnapshotForPrompt`),
 * so the NSFW and always-strip rules keep applying to the projected tree.
 */
export function compileStep2Context(params: CompileStep2Params): CompileStep2Result {
  const { snapshot, nsfwMode, registry, paths, presentNpcNames, memoryBlock } = params;
  const entries: CompileTraceEntry[] = [];
  let projected = snapshot;
  const rawLocation = readPath(snapshot, paths.playerLocation);
  const currentLocation = typeof rawLocation === 'string' ? rawLocation : '';

  // 1. Locations → neighbourhood view.
  const locations = readPath(snapshot, paths.locations);
  if (Array.isArray(locations) && locations.length > 0) {
    const r = projectLocations(
      locations,
      currentLocation,
      {
        name: paths.locationFieldNames.name,
        parent: paths.locationFieldNames.parent,
        connections: paths.locationFieldNames.connections,
      },
      { includeConnections: LOCATION_ADJACENCY_INCLUDE_CONNECTIONS },
    );
    projected = withPath(projected, paths.locations, r.projected);
    entries.push({
      target: paths.locations,
      action: 'project',
      reason: r.currentNotFound ? COMPILE_REASON.currentNotFound : COMPILE_REASON.adjacency,
      before: tokensOf(locations),
      after: tokensOf(r.projected),
      detail: { detail: r.detailCount, skeleton: r.skeletonCount, currentNotFound: r.currentNotFound },
    });
  }

  // 2. World-event ledger → recent + relevant.
  const events = readPath(snapshot, paths.worldEvents);
  if (Array.isArray(events) && events.length > WORLD_EVENT_RECENT_COUNT) {
    const r = projectWorldEvents(events, {
      presentNpcNames,
      locationKeys: locationKeysFor(currentLocation, paths.locationPathSeparator),
      fieldNames: paths.worldEventFieldNames,
    });
    projected = withPath(projected, paths.worldEvents, r.projected);
    entries.push({
      target: paths.worldEvents,
      action: 'project',
      reason: COMPILE_REASON.recentAndRelevant,
      before: tokensOf(events),
      after: tokensOf(r.projected),
      detail: { recent: r.keptRecent, relevant: r.keptRelevant, dropped: r.dropped },
    });
  }

  // 3. Dedup against step1 — world description lives in `world_prompt` already.
  const stripPaths: string[] = [...(params.additionalStripPaths ?? [])];
  if (registry.worldDescriptionSent) {
    for (const p of [paths.worldDescription, paths.worldSelection]) {
      const before = tokensOf(readPath(snapshot, p));
      if (before === 0) continue;
      stripPaths.push(p);
      entries.push({ target: p, action: 'strip', reason: COMPILE_REASON.sentInStep1, before, after: 0 });
    }
  }

  // 4. Dedup against step1 — Engram block lives in `memory_engram` already.
  let memoryBlockOut: string | undefined;
  if (registry.engramBlockSent && memoryBlock.trim().length > 0) {
    memoryBlockOut = '';
    entries.push({
      target: 'MEMORY_BLOCK',
      action: 'strip',
      reason: COMPILE_REASON.sentInStep1,
      before: tokensOf(memoryBlock),
      after: 0,
    });
  }

  const gameStateJson = stringifySnapshotForPrompt(projected, nsfwMode, 0, stripPaths);
  const savedTokens = entries.reduce((sum, e) => sum + Math.max(0, e.before - e.after), 0);
  return { gameStateJson, memoryBlock: memoryBlockOut, trace: { entries, savedTokens } };
}

/** Trace entry for the history truncation (computed by the caller, which owns the wrapped messages). */
export function historyTraceEntry(beforeTokens: number, afterTokens: number, pairsBefore: number, pairsAfter: number): CompileTraceEntry {
  return {
    target: 'history',
    action: 'truncate',
    reason: COMPILE_REASON.fewShotFixed,
    before: beforeTokens,
    after: afterTokens,
    detail: { pairsBefore, pairsAfter },
  };
}
