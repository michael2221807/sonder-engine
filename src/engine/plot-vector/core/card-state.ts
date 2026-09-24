import type { CardDef, CardState, CardStates, CardSupplyRule } from './types';

export interface SupplyGrant {
  cardId: string;
  sourceId: string;
  label: CardSupplyRule['label'];
  granted: number;
  before: number;
  after: number;
  max: number;
}

export function stateOf(card: CardDef, states: CardStates = {}): CardState {
  return states[card.id] ?? {
    stacks: 0,
    stock: card.usage?.kind === 'consumable' ? card.usage.initialStock : 0,
    charges: card.usage?.kind === 'rechargeable' ? card.usage.initialCharges : 0,
  };
}

export function availableUses(card: CardDef, state: CardState): number {
  if (card.usage?.kind === 'consumable') return state.stock;
  if (card.usage?.kind === 'rechargeable') return state.charges;
  return Number.POSITIVE_INFINITY;
}

/** Pure host-side grant: usable for round supply now and other explicit sources later. */
export function grantConsumable(card: CardDef, before: CardState, amount: number): { state: CardState; granted: number } {
  if (card.usage?.kind !== 'consumable') return { state: before, granted: 0 };
  const stock = Math.min(card.usage.maxStock, before.stock + amount);
  return { state: { ...before, stock }, granted: stock - before.stock };
}

/** Apply only the supply rules declared by the owned card definitions. */
export function grantRoundSupplies(cards: CardDef[], initial: CardStates): { states: CardStates; grants: SupplyGrant[] } {
  const states: CardStates = { ...initial };
  const grants: SupplyGrant[] = [];
  for (const card of cards) {
    if (card.usage?.kind !== 'consumable' || card.usage.supply?.trigger !== 'roundAccepted') continue;
    const before = stateOf(card, states);
    const result = grantConsumable(card, before, card.usage.supply.amount);
    states[card.id] = result.state;
    if (result.granted > 0) grants.push({
      cardId: card.id,
      sourceId: card.usage.supply.sourceId,
      label: card.usage.supply.label,
      granted: result.granted,
      before: before.stock,
      after: result.state.stock,
      max: card.usage.maxStock,
    });
  }
  return { states, grants };
}

/** Pure end-of-round proposal. Growth and recharge never refill a consumable. */
export function settleCards(cards: CardDef[], initial: CardStates, used: Set<string>, grown: Set<string>, charged: Set<string>): CardStates {
  const next: CardStates = {};
  for (const card of cards) {
    const before = stateOf(card, initial);
    const stacks = before.stacks + (grown.has(card.id) ? card.growth?.amount ?? 0 : 0);
    let stock = before.stock;
    let charges = before.charges;
    if (card.usage?.kind === 'consumable') {
      stock = Math.max(0, stock - (used.has(card.id) ? 1 : 0));
    } else if (card.usage?.kind === 'rechargeable') {
      charges = Math.max(0, charges - (used.has(card.id) ? 1 : 0));
      if (charged.has(card.id)) charges = Math.min(card.usage.maxCharges, charges + (card.usage.recharge?.amount ?? 0));
    }
    if (![stacks, stock, charges].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error(`invalid card state: ${card.id}`);
    next[card.id] = { stacks, stock, charges };
  }
  return next;
}
