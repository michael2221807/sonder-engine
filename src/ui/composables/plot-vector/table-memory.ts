/**
 * What the plot-vector table remembers on this device (R7 step 5): the two switches in "?",
 * which cards the player has already seen, and the ratings the table worked out for story
 * cards the runtime has not rated yet. Moved verbatim out of PlotVectorTable.vue; the
 * localStorage reads and writes all swallow storage errors, like before.
 */
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import { RATING_VERSION, readRating, type CardRating, type CardTier } from '@/features/plot-vector/rating';
import type { TableCard, TableCardKind, TableModel } from '@/features/plot-vector/table-model';

// ── Per-viewer conveniences (not game state): the two switches in "?", and which cards were already seen. ──
export const PREFS_KEY = 'aga:plotVector:table';
export function readPrefs(): { animate: boolean; exact: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return { animate: raw.animate !== false, exact: raw.exact === true };
  } catch { return { animate: true, exact: false }; }
}

/** What the player saw of each card the last time the table was open (per save, this device only). */
export interface SeenCard { kind: TableCardKind; name: LocalizedLabel; line?: LocalizedLabel; tier?: CardTier; level?: number; resting?: boolean }
export const seenKey = (slot: string) => `aga:plotVector:seen:${slot}`;
export function readSeen(slot: string): Record<string, Partial<SeenCard>> | null {
  try {
    const raw = localStorage.getItem(seenKey(slot));
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    // An older record kept only the ids.
    if (Array.isArray(data)) return Object.fromEntries(data.filter((id): id is string => typeof id === 'string').map(id => [id, {}]));
    const cards = data && typeof data === 'object' ? (data as { cards?: unknown }).cards : undefined;
    return cards && typeof cards === 'object' ? cards as Record<string, Partial<SeenCard>> : null;
  } catch { return null; }
}
export function writeSeen(slot: string, cards: Record<string, SeenCard>): void {
  try { localStorage.setItem(seenKey(slot), JSON.stringify({ v: 2, cards })); } catch { /* storage unavailable */ }
}

/**
 * Ratings the table worked out for story cards the runtime has not rated yet (their tier and what they do), kept
 * on this device so a slow phone works each one out once, not on every visit (the runtime's own rating replaces
 * them as rounds go by). The older tiers-only record is dropped.
 */
export const ratingsKey = (slot: string) => `aga:plotVector:ratings:${slot}`;

/**
 * The tiers-only record an earlier build kept, dropped once per slot. Each call makes a
 * dropper with its own "already dropped" set, so every table instance cleans up once.
 */
export function createTierCacheDropper(): (slot: string) => void {
  const droppedTierCache = new Set<string>();
  return function dropTierCache(slot: string): void {
    if (droppedTierCache.has(slot)) return;
    droppedTierCache.add(slot);
    try { localStorage.removeItem(`aga:plotVector:tiers:${slot}`); } catch { /* storage unavailable */ }
  };
}
export function readRatingCache(slot: string): Map<string, CardRating> {
  try {
    const data = JSON.parse(localStorage.getItem(ratingsKey(slot)) ?? 'null') as { v?: unknown; ratings?: unknown } | null;
    if (data?.v !== RATING_VERSION || !data.ratings || typeof data.ratings !== 'object') return new Map();
    return new Map(Object.entries(data.ratings as Record<string, unknown>).flatMap(([id, raw]) => {
      const rating = readRating(raw);
      return rating ? [[id, rating] as const] : [];
    }));
  } catch { return new Map(); }
}
export function writeRatingCache(slot: string, ratings: ReadonlyMap<string, CardRating>): void {
  try { localStorage.setItem(ratingsKey(slot), JSON.stringify({ v: RATING_VERSION, ratings: Object.fromEntries(ratings) })); } catch { /* storage unavailable */ }
}

export interface Arrivals { fresh: string[]; leveled: string[]; charged: string[]; departed: TableCard[] }

/**
 * Compare the table as it is now with what the player saw last time: new cards, growth, recharge,
 * and supply cards that were used up. Pure: returns the record to store and the arrivals; the caller
 * writes the record. Without a previous record (`before === null`) nothing has "arrived".
 */
export function compareSeen(
  now: Pick<TableModel, 'cards' | 'forming'>,
  before: Record<string, Partial<SeenCard>> | null,
): { record: Record<string, SeenCard>; arrivals: Arrivals } {
  const record: Record<string, SeenCard> = {};
  for (const card of Object.values(now.cards)) {
    record[card.id] = { kind: card.kind, name: card.name, ...(card.line ? { line: card.line } : {}), ...(card.tier ? { tier: card.tier } : {}),
      ...(card.level ? { level: card.level.value } : {}), ...(card.resting ? { resting: true } : {}) };
  }
  for (const f of now.forming) record[f.id] = { kind: f.kind, name: { zh: f.name, en: f.name } };
  const arrivals: Arrivals = { fresh: [], leveled: [], charged: [], departed: [] };
  if (!before) return { record, arrivals };
  for (const [id, card] of Object.entries(record)) {
    const was = before[id];
    if (!was) { arrivals.fresh.push(id); continue; }
    if (was.level !== undefined && (card.level ?? 0) > was.level) arrivals.leveled.push(id);
    if (was.resting && !card.resting) arrivals.charged.push(id);
  }
  for (const [id, was] of Object.entries(before)) {
    if (record[id] || was.kind !== 'supply' || !was.name) continue;
    arrivals.departed.push({ id, kind: 'supply', name: was.name, ...(was.line ? { line: was.line } : {}), ...(was.tier ? { tier: was.tier } : {}), resting: false });
  }
  return { record, arrivals };
}
