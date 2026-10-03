import type { SavedElement, BoundCard } from './genesis/post-save';
import { activeSavedCards } from './saved-elements';
import { readVectorState } from './runtime';
import { rateCard, ratingIsCurrent, ratingPlaceOf, tierOf, type CardRating, type CardTier } from './rating';

/** Ratings worked out for cards the runtime has not rated yet, by card (about 40 ms each, so once per session). */
const worked = new Map<string, CardRating>();
/** Cards already reported as skipped, so a broken card is noted once, not on every pass. */
const reported = new Set<string>();

export interface EntryTiers {
  /** The tier of each entry's card, by saved-element id (`item:<key>`). */
  tiers: Map<string, CardTier>;
  /** Cards left unrated because this pass's budget ran out: ask again to rate more. */
  unrated: number;
}

/**
 * The rarity each saved item or talent shows (PO 2026-10-03: an item's rarity is its card's — the card's strength
 * is the item's real strength). The same cards the board uses — active for the entry as it is saved now — and the
 * same rating the table shows: the saved one when current, else worked out (deterministic: what the runtime records
 * later). At most `rateBudget` cards are worked out per call, like the table rating one at a time, so a caller on
 * the page asks again for the rest instead of blocking it. Entries without an active card are absent, and a damaged
 * vector state or card only leaves its entries without a card tier. The save is never written: an item's own 品质
 * is part of what its card was made from, so changing it would retire the card.
 */
export function entryCardTiers(entries: readonly SavedElement[], rawVectorState: unknown, rateBudget = Infinity): EntryTiers {
  const tiers = new Map<string, CardTier>();
  let cards: BoundCard[];
  try {
    const stories = entries.filter(e => e.kind === 'item' || e.kind === 'talent');
    cards = activeSavedCards(stories, readVectorState(rawVectorState).cards.map(bound => ({ bound })));
  } catch {
    return { tiers, unrated: 0 };
  }
  let budget = rateBudget, unrated = 0;
  for (const card of cards) {
    try {
      const id = card.task.entry.id;
      let rating = ratingIsCurrent(card.rating) ? card.rating : undefined;
      if (!rating) {
        const key = `${id}\n${JSON.stringify(card.spec)}`;
        rating = worked.get(key);
        if (!rating) {
          if (budget <= 0) { unrated++; continue; }
          budget--;
          rating = rateCard(card.spec, ratingPlaceOf(card.spec.type));
          if (worked.size > 500) worked.clear();
          worked.set(key, rating);
        }
      }
      const tier = tierOf(rating);
      if (tier) tiers.set(id, tier);
    } catch (err) {
      // A damaged card: its entry shows its own rarity. Noted once, so a rating fault does not pass unseen.
      const id = (card as { task?: { entry?: { id?: unknown } } }).task?.entry?.id;
      const key = typeof id === 'string' ? id : JSON.stringify(card).slice(0, 80);
      if (!reported.has(key)) { reported.add(key); console.debug('[entryCardTiers] card skipped:', key, err); }
    }
  }
  return { tiers, unrated };
}
