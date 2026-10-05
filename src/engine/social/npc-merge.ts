/**
 * NPC record merging — resolves duplicate 名称 entries in the relationships
 * array by FUSING them into one record instead of dropping either side.
 *
 * Why merge instead of suppress: an AI that re-pushes an existing character
 * usually carries NEW information (a field-repair push has the complete
 * appearance fields the old entry was missing; a re-introduction push has the
 * character's current location/activity). Dropping the push loses that data;
 * keeping both entries corrupts the save (filter paths `[名称=X]` only ever
 * resolve the first match, so the copies drift apart). Merging keeps exactly
 * one entry and loses nothing.
 *
 * Merge policy (base = the live entry that filter-path updates have been
 * hitting; incoming = the newer push / later array duplicate):
 *
 * - VOLATILE fields (isPresent / location / currentActivity / innerThought /
 *   lastInteractionTime): incoming non-empty wins — they describe "current
 *   state", so the temporally newer value is the correct one.
 * - PROGRESSION fields (affinity / relationshipStatus / affinityBreakthrough /
 *   relationshipBreakthrough / isMajorRole): base non-empty wins — these
 *   accumulate through `set`/`add` commands over many rounds; a fresh push
 *   typically carries an AI-invented reset value that must not clobber them.
 * - IDENTITY fields (type / gender / age): base non-empty wins — identity is
 *   established at creation and only drifts through hallucination.
 * - ROUND STAMP (lastMainRoundUpdate): the later round wins — either copy was
 *   updated then, and keeping the earlier one would let the heartbeat forget
 *   an NPC the main round touched recently.
 * - DESCRIPTIVE text (description / appearance / bodyDescription /
 *   outfitStyle / background / corePersonality): the LONGER non-empty text
 *   wins (same precedent as location-dedup's 描述取更长) — richer prose is
 *   assumed to carry more information regardless of which side it came from.
 * - ARRAY fields: union. `memory` entries near-dup-filtered via the Dice
 *   guard (isDuplicateMemory); other known arrays (personalityTraits /
 *   memorySummaries / privateChatHistory / relationshipNetwork) deduped by
 *   deep-equality.
 * - `privacyProfile` object: fill-missing merge (base fields kept, incoming
 *   fills gaps) — unlocked private info is progression-like.
 * - UNKNOWN fields (pack-specific extras): fill-missing; array vs array →
 *   deep-equality union; scalar conflict → base wins (conservative — base is
 *   the entry that has been receiving updates).
 *
 * Engram compatibility: merging never removes or renames a 名称, so Engram
 * entities (upserted by name) and knowledge edges (referencing names) stay
 * valid; the fused entry simply carries the union of both records' data.
 *
 * Content-neutral: all field keys are read from `EngineNpcFieldNames`
 * (CLAUDE.md §4 engine/content separation) — no hardcoded Chinese literals.
 */
// App doc: docs/user-guide/pages/game-relationships.md §同名 NPC 自动融合
import type { EngineNpcFieldNames } from '../pipeline/types';
import { isDuplicateMemory } from './memory-dedup';

/** A raw NPC record from the relationships array */
export type NpcRecord = Record<string, unknown>;

export interface NpcArrayMergeResult {
  /** The deduplicated array (same reference as input when nothing changed) */
  result: NpcRecord[];
  /** How many duplicate entries were fused away */
  mergedCount: number;
  /** Normalized names that had duplicates */
  mergedNames: string[];
}

/**
 * Normalize an NPC name for duplicate comparison.
 *
 * NFKC folds full-width/half-width variants ("李明阳" vs "李明阳" with
 * full-width spaces), zero-width characters are stripped, and surrounding
 * whitespace trimmed. Deliberately NOT fuzzy: 林月 and 林玥 are distinct
 * characters and must stay distinct NPCs.
 */
export function normalizeNpcName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

/** Empty check for merge purposes: undefined/null/blank string/empty array */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-equality union of two arrays (order: base entries first).
 * Note: unions can temporarily exceed per-field caps (e.g. NpcChat's
 * maxChatHistory) — the owning subsystem's next trim pass self-heals this.
 */
function unionByDeepEquality(base: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set(base.map((e) => JSON.stringify(e)));
  const out = [...base];
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Union of memory arrays with near-duplicate filtering (Dice guard) */
function unionMemories(base: unknown[], incoming: unknown[]): unknown[] {
  const out = [...base];
  for (const entry of incoming) {
    if (!isDuplicateMemory(entry, out)) out.push(entry);
  }
  return out;
}

/** Fill-missing merge for objects: base fields kept, incoming fills gaps */
function fillMissingObject(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (isEmptyValue(v)) continue;
    if (isEmptyValue(out[k])) {
      out[k] = v;
    } else if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = fillMissingObject(out[k] as Record<string, unknown>, v);
    }
    // both non-empty scalars/arrays → base wins
  }
  return out;
}

type FieldPolicy = 'volatile' | 'progression' | 'identity' | 'longerText' | 'latestRound';

/** Policy maps memoized per field-name config object (static at runtime) */
const policyMapCache = new WeakMap<EngineNpcFieldNames, Map<string, FieldPolicy>>();

/** Build the per-field policy map from the engine field-name config */
function buildPolicyMap(f: EngineNpcFieldNames): Map<string, FieldPolicy> {
  const cached = policyMapCache.get(f);
  if (cached) return cached;
  const m = new Map<string, FieldPolicy>();
  for (const key of [f.isPresent, f.location, f.currentActivity, f.innerThought, f.lastInteractionTime]) {
    m.set(key, 'volatile');
  }
  for (const key of [
    f.affinity, f.relationshipStatus, f.affinityBreakthrough,
    f.relationshipBreakthrough, f.isMajorRole,
  ]) {
    m.set(key, 'progression');
  }
  for (const key of [f.type, f.gender, f.age]) {
    m.set(key, 'identity');
  }
  m.set(f.lastMainRoundUpdate, 'latestRound');
  for (const key of [
    f.description, f.appearance, f.bodyDescription,
    f.outfitStyle, f.background, f.corePersonality,
  ]) {
    m.set(key, 'longerText');
  }
  policyMapCache.set(f, m);
  return m;
}

/**
 * Fuse `incoming` into `base` per the policy documented in the file header.
 * Returns a NEW object; neither input is mutated.
 */
export function mergeNpcRecords(
  base: NpcRecord,
  incoming: NpcRecord,
  fields: EngineNpcFieldNames,
): NpcRecord {
  const policy = buildPolicyMap(fields);
  const arrayUnionFields = new Set([
    fields.personalityTraits, fields.memorySummaries,
    fields.privateChatHistory, fields.relationshipNetwork,
  ]);
  const out: NpcRecord = { ...base };

  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (key === fields.name) continue; // identity of the merge — keep base's exact spelling
    if (isEmptyValue(incomingValue)) continue;

    const baseValue = out[key];

    // Any field missing on base → adopt incoming, regardless of policy
    if (isEmptyValue(baseValue)) {
      out[key] = incomingValue;
      continue;
    }

    if (key === fields.memory && Array.isArray(baseValue) && Array.isArray(incomingValue)) {
      out[key] = unionMemories(baseValue, incomingValue);
      continue;
    }
    if (key === fields.privacyProfile && isPlainObject(baseValue) && isPlainObject(incomingValue)) {
      out[key] = fillMissingObject(baseValue, incomingValue);
      continue;
    }
    if (arrayUnionFields.has(key) && Array.isArray(baseValue) && Array.isArray(incomingValue)) {
      out[key] = unionByDeepEquality(baseValue, incomingValue);
      continue;
    }

    switch (policy.get(key)) {
      case 'volatile':
        out[key] = incomingValue;
        break;
      case 'progression':
      case 'identity':
        // base wins (already non-empty)
        break;
      case 'latestRound':
        if (typeof baseValue === 'number' && typeof incomingValue === 'number' && incomingValue > baseValue) {
          out[key] = incomingValue;
        }
        break;
      case 'longerText': {
        if (typeof baseValue === 'string' && typeof incomingValue === 'string') {
          if (incomingValue.trim().length > baseValue.trim().length) out[key] = incomingValue;
        }
        // non-string collision on a text field → keep base
        break;
      }
      default: {
        // Unknown field, both sides non-empty
        if (Array.isArray(baseValue) && Array.isArray(incomingValue)) {
          out[key] = unionByDeepEquality(baseValue, incomingValue);
        } else if (isPlainObject(baseValue) && isPlainObject(incomingValue)) {
          out[key] = fillMissingObject(baseValue, incomingValue);
        }
        // scalar conflict → base wins (conservative)
        break;
      }
    }
  }

  return out;
}

/**
 * Sweep a relationships array, fusing every later duplicate (same normalized
 * 名称) into the FIRST occurrence. First occurrence position is preserved
 * (it is the entry all `[名称=X]` filter-path updates have been landing on).
 * Entries without a usable name are kept as-is and never merged.
 *
 * Returns the input array reference unchanged when there are no duplicates,
 * so callers can cheaply detect "nothing to write back".
 */
export function mergeDuplicateNpcArray(
  arr: readonly NpcRecord[],
  fields: EngineNpcFieldNames,
): NpcArrayMergeResult {
  if (!Array.isArray(arr) || arr.length <= 1) {
    return { result: arr as NpcRecord[], mergedCount: 0, mergedNames: [] };
  }

  const firstIndexByName = new Map<string, number>();
  const out: NpcRecord[] = [];
  const mergedNames = new Set<string>();
  let mergedCount = 0;

  for (const entry of arr) {
    if (!isPlainObject(entry)) {
      out.push(entry as NpcRecord);
      continue;
    }
    const name = normalizeNpcName(entry[fields.name]);
    if (!name) {
      out.push(entry);
      continue;
    }
    const firstIdx = firstIndexByName.get(name);
    if (firstIdx === undefined) {
      firstIndexByName.set(name, out.length);
      out.push(entry);
      continue;
    }
    // Later duplicate: the earlier entry is the live base, the later one is
    // the (temporally newer) re-push — same roles as the push-time guard.
    out[firstIdx] = mergeNpcRecords(out[firstIdx], entry, fields);
    mergedNames.add(name);
    mergedCount++;
  }

  if (mergedCount === 0) {
    return { result: arr as NpcRecord[], mergedCount: 0, mergedNames: [] };
  }
  return { result: out, mergedCount, mergedNames: [...mergedNames] };
}
