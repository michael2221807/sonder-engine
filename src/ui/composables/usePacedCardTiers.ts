import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import type { SavedElement } from '@/features/plot-vector/genesis/post-save';
import { entryCardTiers, type EntryTiers } from '@/features/plot-vector/entry-tiers';
import type { CardTier } from '@/features/plot-vector/rating';

/** Cards worked out per pass (about 40 ms each) and the pause between passes — the pace the table rates at. */
export const CARD_TIER_RATE_PER_PASS = 1;
export const CARD_TIER_PAUSE_MS = 60;

export interface CardTierInput {
  entries: readonly SavedElement[];
  vectorState: unknown;
}

/**
 * The card tier of each saved entry (PO 2026-10-03: an item's rarity is its card's), for a page. A card the runtime
 * has not rated yet is worked out here, a few per pass with a pause between passes, so the page never waits on many
 * of them; passes go on until every card is rated, then stop. `input` returning null means no tiers (the feature is
 * off or nothing is loaded). Must be called inside a component setup or another effect scope.
 */
export function usePacedCardTiers(input: () => CardTierInput | null): ComputedRef<Map<string, CardTier>> {
  const pass = ref(0);
  const view = computed<EntryTiers>(() => {
    void pass.value;
    const current = input();
    return current
      ? entryCardTiers(current.entries, current.vectorState, CARD_TIER_RATE_PER_PASS)
      : { tiers: new Map(), unrated: 0 };
  });
  let next: ReturnType<typeof setTimeout> | undefined;
  // Immediate: the very first pass can already leave cards unrated (code review 2026-10-03 — without it, only
  // an unrelated change would ever rate the next one).
  watch(view, (current) => {
    clearTimeout(next);
    next = current.unrated > 0 ? setTimeout(() => { pass.value++; }, CARD_TIER_PAUSE_MS) : undefined;
  }, { immediate: true });
  onScopeDispose(() => clearTimeout(next));
  return computed(() => view.value.tiers);
}
