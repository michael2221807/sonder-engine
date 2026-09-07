// App doc: docs/user-guide/pages/game-relationships.md §人物向量 (per-NPC vector · prompt block)
// Design: docs/design/player-intent-modeling-positioning.md · docs/design/character-vector-v1-implementation-plan.md
/**
 * Character Vectors (R2 second half of the textual-open-world research line, 2026-09-06).
 *
 * A "potential vector" per main-cast NPC: which way the player hopes this character
 * develops *in the protagonist's story* — a tendency the world tries to move toward, never
 * a script (the outcome stays with the dice and the scene). Three short lines per NPC
 * (toward the protagonist / never / direction) plus an optional hidden truth the
 * protagonist does not know. Evidence: three replay rounds + three PO blind reads
 * (docs/research/textual-open-world-r2-contract-ab.md §3.4–§3.6) — the minimal form
 * without a protagonist line passed the PO's no-regression gate; six-dimension dumps
 * and preachy headers were harmful.
 *
 * Injection rules that came out of the experiments:
 *   - PROJECTION: only NPCs relevant to this turn get a line — present in the scene, named
 *     in the player input, or named in the previous narrative. The whole list is never sent.
 *   - NO PROTAGONIST LINE: the player writes her; a world-written "she is warming to him"
 *     made the model realise the player's hope early (round 2, 81 B).
 *   - HIDDEN TRUTHS ride in a separate line and may only steer world-side action and
 *     narrator irony — never the protagonist's cognition or dialogue, in any form.
 *   - Same guarantee as the contract: no entries in scope → '' → byte-identical prompts.
 *
 * Engine/content separation: every visible label comes from `GamePack.engineFragments`
 * (`characterVector*` keys); NPC field names come from `EnginePathConfig.npcFieldNames`.
 */
import type { CompileTraceEntry, EnginePathConfig } from '../pipeline/types';
import { COMPILE_REASON } from './context-compiler';

// ─── State shape (stored at `paths.characterVectors`) ───

export type CharacterVectorSource = 'player' | 'proposed' | 'accepted';

export interface CharacterVectorEntry {
  id: string;
  /** Matches `社交.关系[].名称` by name (the relationship list is re-ordered by the model). */
  name: string;
  /** How this character leans toward the protagonist. */
  toward: string;
  /** What this character will not do to the protagonist (evidenced boundaries only). */
  never: string;
  /** Where the relationship is heading — the hope, not the plan. */
  direction: string;
  /** A truth the protagonist does not know; world-side only. Empty when none. */
  hidden: string;
  enabled: boolean;
  /**
   * `proposed` = written by the world. Unlike contract clauses, proposed entries ARE
   * injected: the PO ruled out per-item acceptance ("delete or edit, never confirm").
   */
  source: CharacterVectorSource;
  updatedRound: number;
}

export interface CharacterVectorsState {
  /** Master switch for this save (schema default `true`). */
  enabled: boolean;
  entries: CharacterVectorEntry[];
}

/** Hard caps (also enforced by the UI composable). */
export const CHARACTER_VECTOR_LINE_MAX_CHARS = 60;
export const CHARACTER_VECTOR_HIDDEN_MAX_CHARS = 80;

/** Fresh empty state — a new object per call, never a shared mutable default. */
export function emptyCharacterVectors(): CharacterVectorsState {
  return { enabled: true, entries: [] };
}

const SOURCES: readonly CharacterVectorSource[] = ['player', 'proposed', 'accepted'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Coerce one stored entry; undefined when it cannot be an entry (no name). */
export function normalizeCharacterVectorEntry(raw: unknown, index: number): CharacterVectorEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return undefined;
  const source = SOURCES.includes(raw.source as CharacterVectorSource) ? (raw.source as CharacterVectorSource) : 'player';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `vector-${index}`,
    name,
    toward: str(raw.toward, CHARACTER_VECTOR_LINE_MAX_CHARS),
    never: str(raw.never, CHARACTER_VECTOR_LINE_MAX_CHARS),
    direction: str(raw.direction, CHARACTER_VECTOR_LINE_MAX_CHARS),
    hidden: str(raw.hidden, CHARACTER_VECTOR_HIDDEN_MAX_CHARS),
    enabled: raw.enabled !== false,
    source,
    updatedRound: typeof raw.updatedRound === 'number' && Number.isFinite(raw.updatedRound) ? raw.updatedRound : 0,
  };
}

/** Minimal read port so the reader works with StateManager and test mocks alike. */
export interface CharacterVectorsReadPort {
  get<T>(path: string): T | undefined;
}

/** Read + normalise; missing / malformed data degrades to the empty state, never throws. */
export function readCharacterVectors(
  state: CharacterVectorsReadPort,
  paths: Pick<EnginePathConfig, 'characterVectors'>,
): CharacterVectorsState {
  const raw = state.get<unknown>(paths.characterVectors);
  if (!isRecord(raw)) return emptyCharacterVectors();
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(normalizeCharacterVectorEntry).filter((e): e is CharacterVectorEntry => e !== undefined)
    : [];
  return { enabled: raw.enabled !== false, entries };
}

/** An entry says something only when at least one of its lines is non-empty. */
export function hasVectorContent(e: CharacterVectorEntry): boolean {
  return Boolean(e.toward || e.never || e.direction || e.hidden);
}

/** Entries the model may see: enabled and non-empty (proposed ones included — see `source`). */
export function activeVectorEntries(state: CharacterVectorsState): CharacterVectorEntry[] {
  return state.entries.filter((e) => e.enabled && hasVectorContent(e));
}

// ─── Scope (projection) ───

export interface ResolveVectorScopeParams {
  /** The relationship list (`paths.relationships`), any shape — non-arrays yield no presence. */
  relationships: unknown;
  /** Names that may be injected (normally the active entries' names). */
  candidates: readonly string[];
  /** This turn's player input (raw). */
  userInput?: string;
  /** The previous turn's narrative text. */
  lastNarrative?: string;
  paths: Pick<EnginePathConfig, 'npcFieldNames'>;
}

/**
 * Which candidates are relevant to this turn: present in the scene (`是否在场`), named
 * in the player input, or named in the previous narrative. Order follows `candidates`.
 */
export function resolveVectorScope(params: ResolveVectorScopeParams): string[] {
  const { relationships, candidates, userInput = '', lastNarrative = '', paths } = params;
  const { name: nameField, isPresent: presentField } = paths.npcFieldNames;
  const present = new Set<string>();
  if (Array.isArray(relationships)) {
    for (const npc of relationships) {
      if (!isRecord(npc)) continue;
      const name = String(npc[nameField] ?? '').trim();
      if (name && npc[presentField] === true) present.add(name);
    }
  }
  const haystack = `${userInput}\n${lastNarrative}`;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of candidates) {
    if (!name || seen.has(name)) continue;
    if (present.has(name) || haystack.includes(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// ─── Prompt block ───

/** Visible labels; all pack-provided (`engineFragments.characterVector*`). */
export interface CharacterVectorFragments {
  /** Block heading + the two-sentence framing (tendency, not ending; current, not permanent). */
  header: string;
  towardLabel: string;
  neverLabel: string;
  directionLabel: string;
  /** Prefix of the hidden-truth line (includes the "never reaches the protagonist" rule). */
  hiddenLabel: string;
  /** Between the fields of one entry line. */
  fieldSeparator: string;
  /** Between hidden truths of different characters. */
  hiddenSeparator: string;
}

export const CHARACTER_VECTOR_FRAGMENT_KEYS = {
  header: 'characterVectorHeader',
  towardLabel: 'characterVectorTowardLabel',
  neverLabel: 'characterVectorNeverLabel',
  directionLabel: 'characterVectorDirectionLabel',
  hiddenLabel: 'characterVectorHiddenLabel',
  fieldSeparator: 'characterVectorFieldSeparator',
  hiddenSeparator: 'characterVectorHiddenSeparator',
} as const;

export function resolveCharacterVectorFragments(fragments?: Record<string, unknown>): CharacterVectorFragments {
  const pick = (key: string): string => {
    const v = fragments?.[key];
    return typeof v === 'string' ? v : '';
  };
  return {
    header: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.header),
    towardLabel: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.towardLabel),
    neverLabel: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.neverLabel),
    directionLabel: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.directionLabel),
    hiddenLabel: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.hiddenLabel),
    fieldSeparator: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.fieldSeparator) || ' ',
    hiddenSeparator: pick(CHARACTER_VECTOR_FRAGMENT_KEYS.hiddenSeparator) || '; ',
  };
}

export interface BuildCharacterVectorBlockParams {
  vectors: CharacterVectorsState;
  /** Names to render, in order (from `resolveVectorScope` or a single NPC for private chat). */
  scope: readonly string[];
  /** The protagonist's name — never rendered even if an entry carries it. */
  protagonistName: string;
  fragments: CharacterVectorFragments;
}

/**
 * Render the block the model sees. `''` when the switch is off, when nothing in scope
 * has content, or when the pack gives no header (a pack that does not know the feature
 * must not receive an unlabelled block).
 */
export function buildCharacterVectorBlock(params: BuildCharacterVectorBlockParams): string {
  const { vectors, scope, protagonistName, fragments } = params;
  if (!vectors.enabled || !fragments.header) return '';
  const byName = new Map(activeVectorEntries(vectors).map((e) => [e.name, e] as const));
  const chosen: CharacterVectorEntry[] = [];
  const seen = new Set<string>();
  for (const name of scope) {
    if (seen.has(name) || name === protagonistName) continue;
    const e = byName.get(name);
    if (!e) continue;
    seen.add(name);
    chosen.push(e);
  }
  if (chosen.length === 0) return '';

  const lines: string[] = [fragments.header];
  for (const e of chosen) {
    const fields = [
      e.toward ? `${fragments.towardLabel}${e.toward}` : '',
      e.never ? `${fragments.neverLabel}${e.never}` : '',
      e.direction ? `${fragments.directionLabel}${e.direction}` : '',
    ].filter(Boolean);
    if (fields.length > 0) lines.push(`- ${e.name}：${fields.join(fragments.fieldSeparator)}`);
  }
  const hidden = chosen.map((e) => e.hidden).filter(Boolean);
  if (hidden.length > 0 && fragments.hiddenLabel) lines.push(`${fragments.hiddenLabel}${hidden.join(fragments.hiddenSeparator)}`);
  // A block that carries nothing but the header says nothing — inject nothing.
  return lines.length > 1 ? lines.join('\n') : '';
}

export interface CharacterVectorsFromState {
  vectors: CharacterVectorsState;
  scope: string[];
  /** Rendered block, `''` when nothing is to be injected. */
  block: string;
}

export interface BuildCharacterVectorsOptions {
  userInput?: string;
  lastNarrative?: string;
  /** Private chat: restrict the scope to this one NPC regardless of presence. */
  only?: string;
  /** Plot decomposition: every active entry (an arc spans many scenes, so no projection). */
  all?: boolean;
}

/**
 * One-call convenience for every flow that injects vectors (main round, NPC private chat,
 * plot decomposition): read the state, project the scope, render with the pack fragments.
 */
export function buildCharacterVectorsFromState(
  state: CharacterVectorsReadPort,
  paths: Pick<EnginePathConfig, 'characterVectors' | 'relationships' | 'npcFieldNames' | 'playerName'>,
  engineFragments: Record<string, unknown> | undefined,
  options: BuildCharacterVectorsOptions = {},
): CharacterVectorsFromState {
  const vectors = readCharacterVectors(state, paths);
  const candidates = activeVectorEntries(vectors).map((e) => e.name);
  const scope = options.only !== undefined
    ? candidates.filter((n) => n === options.only)
    : options.all
    ? [...candidates]
    : resolveVectorScope({
        relationships: state.get<unknown>(paths.relationships),
        candidates,
        userInput: options.userInput,
        lastNarrative: options.lastNarrative,
        paths,
      });
  const protagonistName = state.get<string>(paths.playerName) ?? '';
  const block = buildCharacterVectorBlock({ vectors, scope, protagonistName, fragments: resolveCharacterVectorFragments(engineFragments) });
  return { vectors, scope, block };
}

/** Compile-trace entry: like the contract, the block is kept verbatim in both steps. */
export function characterVectorsTraceEntry(tokens: number, entryCount: number, scopeCount: number): CompileTraceEntry {
  return {
    target: 'vectors',
    action: 'keep',
    reason: COMPILE_REASON.sentInBothSteps,
    before: tokens,
    after: tokens,
    detail: { entries: entryCount, scope: scopeCount },
  };
}

/**
 * The previous turn's narrative text from the history list (`paths.narrativeHistory`):
 * the last assistant entry, or '' when the save has none. Shared by the flows that
 * project the scope so they all mean the same thing by "the previous narrative".
 */
export function lastNarrativeText(state: CharacterVectorsReadPort, paths: Pick<EnginePathConfig, 'narrativeHistory'>): string {
  const history = state.get<unknown>(paths.narrativeHistory);
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (isRecord(h) && h.role === 'assistant' && typeof h.content === 'string') return h.content;
  }
  return '';
}
