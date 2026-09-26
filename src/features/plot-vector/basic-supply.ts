import type { CardDef, CardStates, CardUsage } from '../../engine/plot-vector/core/types';
import { availableUses, stateOf } from '../../engine/plot-vector/core/card-state';
import type { CardSpec } from './contract/types';
import { storeAccount } from './contract/trip';

/**
 * Basic supply (rebuild plan §3, C9): three engine-owned filler cards the player owns independently of
 * the story. They are written in the same card contract as every other card, but only they have uses:
 * one use per accepted round in which they acted (previews never deduct), topped up by
 * `grantRoundSupplies` after every accepted round.
 *
 * Parameters (agent-set, to be settled by the PO): each card starts with 2, gains 1 per accepted round,
 * holds at most 3. An exhausted card leaves the hand until the next top-up.
 */
export const BASIC_SUPPLY_SOURCE = 'basic-supply';
export const BASIC_SUPPLY_USAGE: CardUsage = {
  kind: 'consumable', initialStock: 2, maxStock: 3,
  supply: { trigger: 'roundAccepted', amount: 1, sourceId: BASIC_SUPPLY_SOURCE, label: { zh: '基础补给', en: 'Basic supply' } },
};

export const BASIC_SUPPLY: ReadonlyArray<{ id: string; spec: CardSpec }> = [
  { id: 'basic:push', spec: { for: '顺势', type: 'item', summary: '每次经过，推力 +1。', onPass: 'return { push: 1 };' } },
  { id: 'basic:talk', spec: { for: '搭话', type: 'item', summary: '每次经过，人际 +1。', onPass: 'return { social: 1 };' } },
  { id: 'basic:notice', spec: { for: '留心', type: 'item', summary: '每次经过，机会 +1。', onPass: 'return { chance: 1 };' } },
];
export const BASIC_SUPPLY_IDS: readonly string[] = BASIC_SUPPLY.map(card => card.id);

/** The basic cards' board definitions. */
export function basicSupplyCards(): CardDef[] {
  return BASIC_SUPPLY.map(({ id, spec }) => ({
    id, tags: [], source: 'Claude', origin: 'supply', usage: BASIC_SUPPLY_USAGE, accounts: [storeAccount(id)],
    label: { zh: spec.for, en: spec.for }, originalText: { zh: spec.summary, en: spec.summary },
  }));
}

/** A basic card is in the player's hand while it has at least one use left. */
export function hasUses(card: CardDef, states: CardStates | undefined): boolean {
  return availableUses(card, stateOf(card, states)) > 0;
}
