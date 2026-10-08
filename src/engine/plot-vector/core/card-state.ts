import type { CardDef, CardState, CardStates } from './types';

export function stateOf(card: Pick<CardDef, 'id' | 'usage'>, states: CardStates = {}): CardState {
  return states[card.id] ?? { stock: card.usage ? card.usage.initialStock : 0 };
}

/** Uses left; a card without a usage limit is unlimited. */
export function availableUses(card: Pick<CardDef, 'usage'>, state: CardState): number {
  return card.usage ? state.stock : Number.POSITIVE_INFINITY;
}

/** Pure host-side grant: usable for round supply now and other explicit sources later. */
export function grantConsumable(card: Pick<CardDef, 'usage'>, before: CardState, amount: number): { state: CardState; granted: number } {
  if (!card.usage) return { state: before, granted: 0 };
  const stock = Math.min(card.usage.maxStock, before.stock + amount);
  return { state: { ...before, stock }, granted: stock - before.stock };
}

/** Pure end-of-trip proposal: a consumable card that acted spends one use. */
export function settleCards(cards: CardDef[], initial: CardStates, used: ReadonlySet<string>): CardStates {
  const next: CardStates = {};
  for (const card of cards) {
    const before = stateOf(card, initial);
    const stock = card.usage ? Math.max(0, before.stock - (used.has(card.id) ? 1 : 0)) : before.stock;
    if (!Number.isSafeInteger(stock) || stock < 0) throw new Error(`invalid card state: ${card.id}`);
    next[card.id] = { stock };
  }
  return next;
}
