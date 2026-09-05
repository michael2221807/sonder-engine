// App doc: docs/user-guide/pages/game-prompts.md §叙事契约 (contract tab · focal cast · prompt block)
// Design: docs/design/narrative-contract-positioning.md · docs/design/narrative-contract-v1-implementation-plan.md
/**
 * Narrative Contract (R2 of the textual-open-world research line, 2026-09-05).
 *
 * The player's sparse "melody" for one save: a handful of natural-language clauses
 * (a character's true colours, the main line, what only the player may change) plus
 * the focal cast. It answers the one question no other injected layer answers —
 * *which way should the world lean when it improvises, who counts as a main
 * character, what must it not touch* — and it outranks whatever the model infers
 * from state and memory.
 *
 * Evidence: P3 (docs/research/textual-open-world-p3-possibility-portfolio.md) — with
 * every existing context layer present the world still cast a protective NPC as a
 * predator and pulled peripheral characters into the lead; four player clauses moved
 * the same rounds onto directions the player "might have thought of".
 *
 * Positioning: coexists with memory / canon capture / plot arcs / action-option
 * prompt / extra prompt — replaces none, reorders none. Sent to BOTH split steps
 * (never deduplicated by the Context Compiler). An empty contract yields an empty
 * block, so saves that never use the feature produce byte-identical prompts.
 *
 * Engine/content separation: no game-specific text lives here. Every visible label
 * comes from `GamePack.engineFragments` (`narrativeContract*` keys); the NPC field
 * names and the "ordinary NPC" type value come from `EnginePathConfig`.
 */
import type { CompileTraceEntry, EnginePathConfig } from '../pipeline/types';
import { COMPILE_REASON } from './context-compiler';

// ─── State shape (stored at `paths.narrativeContract`) ───

export type NarrativeContractSource = 'player' | 'proposed' | 'accepted';

export interface NarrativeContractClause {
  id: string;
  /** One sentence in natural language. */
  text: string;
  enabled: boolean;
  /** `proposed` = suggested by the world and NOT yet accepted → never injected. */
  source: NarrativeContractSource;
  createdRound: number;
}

export interface NarrativeContractState {
  /** Master switch for this save (schema default `true`). */
  enabled: boolean;
  clauses: NarrativeContractClause[];
}

/** Fresh empty contract (the schema default). New object per call — never share a mutable default. */
export function emptyNarrativeContract(): NarrativeContractState {
  return { enabled: true, clauses: [] };
}

const SOURCES: readonly NarrativeContractSource[] = ['player', 'proposed', 'accepted'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce one stored clause; returns undefined when it cannot be a clause (no text). */
function normalizeClause(raw: unknown, index: number): NarrativeContractClause | undefined {
  if (!isRecord(raw)) return undefined;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return undefined;
  const source = SOURCES.includes(raw.source as NarrativeContractSource)
    ? (raw.source as NarrativeContractSource)
    : 'player';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `clause-${index}`,
    text,
    enabled: raw.enabled !== false,
    source,
    createdRound: typeof raw.createdRound === 'number' && Number.isFinite(raw.createdRound) ? raw.createdRound : 0,
  };
}

/** Minimal read port so the reader works with StateManager and the test mock alike. */
export interface NarrativeContractReadPort {
  get<T>(path: string): T | undefined;
}

/**
 * Read + normalise the contract from the state tree. Missing / malformed data
 * (old saves, hand-edited JSON) degrades to the empty contract, never throws.
 */
export function readNarrativeContract(
  state: NarrativeContractReadPort,
  paths: Pick<EnginePathConfig, 'narrativeContract'>,
): NarrativeContractState {
  const raw = state.get<unknown>(paths.narrativeContract);
  if (!isRecord(raw)) return emptyNarrativeContract();
  const clauses = Array.isArray(raw.clauses)
    ? raw.clauses.map(normalizeClause).filter((c): c is NarrativeContractClause => c !== undefined)
    : [];
  return { enabled: raw.enabled !== false, clauses };
}

/** Clauses the model is allowed to see: enabled and not merely proposed. */
export function activeClauses(contract: NarrativeContractState): NarrativeContractClause[] {
  return contract.clauses.filter((c) => c.enabled && c.source !== 'proposed');
}

// ─── Focal cast (PO decision Q5-D: reuse 「重点」 type ∪ 「关注」 flag) ───

/**
 * Derive the focal cast from the relationship list, every round, without storing it.
 *
 * An NPC is focal when its type is NOT the pack's "ordinary" value (the same rule the
 * Engram entity builder uses: an unmarked type counts as key) OR the player flagged it
 * with the attention toggle in the relationship panel. Order follows the list; names
 * are de-duplicated.
 */
export function resolveFocalCast(
  relationships: unknown,
  paths: Pick<EnginePathConfig, 'npcFieldNames' | 'npcTypeExclude'>,
): string[] {
  if (!Array.isArray(relationships)) return [];
  const { name: nameField, type: typeField, attention: attentionField } = paths.npcFieldNames;
  const seen = new Set<string>();
  const cast: string[] = [];
  for (const npc of relationships) {
    if (!isRecord(npc)) continue;
    const name = String(npc[nameField] ?? '').trim();
    if (!name || seen.has(name)) continue;
    // Anything but the pack's "ordinary" value counts as key — including an unmarked type,
    // the same rule the Engram entity builder applies.
    const isKeyType = npc[typeField] !== paths.npcTypeExclude;
    const isWatched = npc[attentionField] === true;
    if (!isKeyType && !isWatched) continue;
    seen.add(name);
    cast.push(name);
  }
  return cast;
}

// ─── Prompt block ───

/** Visible labels; all pack-provided (`engineFragments.narrativeContract*`). */
export interface NarrativeContractFragments {
  /** Block heading line. */
  title: string;
  /** "Declared by the player, outranks your inference…" sentence. */
  authority: string;
  /** Label prefixed to the cast line. */
  castLabel: string;
  /** Rule for names not on the list (peripheral characters stay background). */
  peripheralRule: string;
  /** Joins cast names (defaults to a plain comma when the pack gives none). */
  castSeparator: string;
}

export const NARRATIVE_CONTRACT_FRAGMENT_KEYS = {
  title: 'narrativeContractTitle',
  authority: 'narrativeContractAuthority',
  castLabel: 'narrativeContractCastLabel',
  peripheralRule: 'narrativeContractPeripheralRule',
  castSeparator: 'narrativeContractCastSeparator',
} as const;

/** Pull the labels out of the pack fragments; absent keys become empty strings (line omitted). */
export function resolveNarrativeContractFragments(fragments?: Record<string, unknown>): NarrativeContractFragments {
  const pick = (key: string): string => {
    const v = fragments?.[key];
    return typeof v === 'string' ? v : '';
  };
  return {
    title: pick(NARRATIVE_CONTRACT_FRAGMENT_KEYS.title),
    authority: pick(NARRATIVE_CONTRACT_FRAGMENT_KEYS.authority),
    castLabel: pick(NARRATIVE_CONTRACT_FRAGMENT_KEYS.castLabel),
    peripheralRule: pick(NARRATIVE_CONTRACT_FRAGMENT_KEYS.peripheralRule),
    castSeparator: pick(NARRATIVE_CONTRACT_FRAGMENT_KEYS.castSeparator) || ', ',
  };
}

export interface BuildNarrativeContractBlockParams {
  contract: NarrativeContractState;
  cast: readonly string[];
  fragments: NarrativeContractFragments;
}

/**
 * Render the block the model sees. Returns `''` (nothing injected) when the master
 * switch is off or when the player has not written a single active clause. The cast
 * line rides along with the clauses and never injects on its own: nearly every NPC in
 * an existing save is 「重点」, so a cast-only block would silently change the prompt
 * of every save that never opened the feature (the byte-identical guarantee, plan §5).
 */
export function buildNarrativeContractBlock(params: BuildNarrativeContractBlockParams): string {
  const { contract, cast, fragments } = params;
  if (!contract.enabled) return '';
  const clauses = activeClauses(contract);
  if (clauses.length === 0) return '';

  const lines: string[] = [];
  if (fragments.title) lines.push(fragments.title);
  if (fragments.authority) lines.push(fragments.authority);
  clauses.forEach((c, i) => lines.push(`${i + 1}. ${c.text}`));
  if (cast.length > 0) {
    lines.push(`${fragments.castLabel}${cast.join(fragments.castSeparator)}`);
    if (fragments.peripheralRule) lines.push(fragments.peripheralRule);
  }
  return lines.join('\n');
}

/** Compile-trace entry: the contract is kept verbatim in both steps (never deduplicated). */
export function narrativeContractTraceEntry(tokens: number, clauseCount: number, castCount: number): CompileTraceEntry {
  return {
    target: 'contract',
    action: 'keep',
    reason: COMPILE_REASON.sentInBothSteps,
    before: tokens,
    after: tokens,
    detail: { clauses: clauseCount, cast: castCount },
  };
}
