import type { CardDef, CardStates, CardUsage } from '../../engine/plot-vector/core/types';
import { availableUses, stateOf } from '../../engine/plot-vector/core/card-state';
import type { CardGenesisCandidateV1 } from './genesis/types';
import { createScriptCardDef, programHash, type ScriptProgramRegistry } from './genesis/script-runtime';

/**
 * Basic supply: a few ordinary-strength small cards the player owns independently of the story.
 * They are local definitions (source 'Codex', origin 'supply'), not model-generated abilities and
 * not inventory items. They run through the same snippet runtime as every other card, use the
 * engine's consumable rules (one use per accepted round in which they took effect; previews never
 * deduct) and are topped up by `grantRoundSupplies` after every accepted main round.
 *
 * Parameters (candidate, not a PO-settled economy): each card starts with 2, gains 1 per accepted
 * round, holds at most 3. An exhausted card leaves the hand until the next top-up.
 */
export const BASIC_SUPPLY_SOURCE = 'basic-supply';
export const BASIC_SUPPLY_USAGE: CardUsage = {
  kind: 'consumable', initialStock: 2, maxStock: 3,
  supply: { trigger: 'roundAccepted', amount: 1, sourceId: BASIC_SUPPLY_SOURCE, label: { zh: '基础补给', en: 'Basic supply' } },
};

interface BasicCardSpec { id: string; name: string; description: string; onVisit: string }
const SPECS: readonly BasicCardSpec[] = [
  { id: 'basic:push', name: '顺势', description: '每次经过，推力 +1。', onVisit: "return { effects: [{ kind: 'add', channel: 'S+', amount: 1 }] };" },
  { id: 'basic:talk', name: '搭话', description: '每次经过，人际 +1。', onVisit: "return { effects: [{ kind: 'add', channel: 'Y', amount: 1 }] };" },
  { id: 'basic:notice', name: '留心', description: '每次经过，机会 +1。', onVisit: "return { effects: [{ kind: 'add', channel: 'J', amount: 1 }] };" },
];

const candidateOf = (spec: BasicCardSpec): CardGenesisCandidateV1 => ({
  version: 1,
  anchor: { commandIndex: 0, entrySelector: BASIC_SUPPLY_SOURCE, entryKind: 'other', entryLabel: spec.name, storyEvidence: '' },
  card: { name: spec.name, description: spec.description, behaviorSummary: spec.description,
    hooks: { onVisit: spec.onVisit, onRoundAccepted: null }, initialPersistentState: {} },
});

export const BASIC_SUPPLY_IDS: readonly string[] = SPECS.map(spec => spec.id);

/** Register the basic cards in a runtime registry and return their board definitions. */
export async function basicSupplyCards(registry: ScriptProgramRegistry): Promise<CardDef[]> {
  const cards: CardDef[] = [];
  for (const spec of SPECS) {
    const candidate = candidateOf(spec);
    const ref = await registry.register(candidate);
    cards.push(createScriptCardDef(candidate, ref, { id: spec.id, tags: [], source: 'Codex', origin: 'supply', usage: BASIC_SUPPLY_USAGE }));
  }
  return cards;
}

/** Program hashes by card id, for hosts that must recognize these cards without running them. */
let hashes: Promise<ReadonlyMap<string, string>> | undefined;
export function basicSupplyHashes(): Promise<ReadonlyMap<string, string>> {
  hashes ??= Promise.all(SPECS.map(async spec => [spec.id, await programHash(candidateOf(spec))] as const)).then(entries => new Map(entries));
  return hashes;
}

/** A basic card is in the player's hand while it has at least one use left. */
export function hasUses(card: CardDef, states: CardStates | undefined): boolean {
  return availableUses(card, stateOf(card, states)) > 0;
}
