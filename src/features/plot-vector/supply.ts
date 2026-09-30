/**
 * General supply (rebuild plan phase 6; charter C2, C3, C9, I8; PO 2026-09-27: 1C 2A 3A 4A 5A). Small filler
 * cards independent of the story, handed to the player to use freely. The pool is pack content; the engine
 * rates every card, and after each accepted round, while the hand holds fewer than its limit, draws one card
 * with the tier weights. Uses follow the tier (strong cards are one-shot, 4A); a card may declare a recharge
 * (5A). An exhausted card without recharge leaves the hand; one with recharge waits for its next use.
 */
import type { CardDef, CardStates, LocalizedLabel, RunDone } from '../../engine/plot-vector/core/types';
import { availableUses, grantConsumable, stateOf } from '../../engine/plot-vector/core/card-state';
import { storeAccount, type TripCard } from './contract/trip';
import { validateCard } from './contract/validate';
import type { CardSpec } from './contract/types';
import { CARD_TIERS, rateCard, type CardRating, type CardTier } from './rating';

/** When a supply card regains a use: every `every` accepted rounds, or every `every` passes it acted on. */
export interface RechargeSpec { on: 'round' | 'trigger'; every: number }
export interface SupplyCard { id: string; name: LocalizedLabel; summary: LocalizedLabel; spec: CardSpec; recharge?: RechargeSpec }
export interface SupplyRules {
  /** Most supply cards the hand holds. */
  hand: number;
  /** Cards drawn after one accepted round, while the hand has room. */
  perRound: number;
  tierWeights: Readonly<Record<CardTier, number>>;
  usesByTier: Readonly<Record<CardTier, number>>;
  /** The opening hand (ids from `cards`). */
  starter: string[];
  cards: SupplyCard[];
}
/** One card in the hand. `id` is the instance (the starter keeps the card id; a drawn card is `cardId#n`). */
export interface SupplyHandCard { id: string; cardId: string; recharge?: number }
export interface SupplyState {
  hand: SupplyHandCard[];
  /** Cards drawn so far; numbers the next instance. */
  drawn: number;
  /** Instances drawn by the last accepted round, for the notice after it is saved. */
  lastDrawn?: string[];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown): LocalizedLabel | undefined =>
  object(v) && typeof v.zh === 'string' && v.zh.trim() && typeof v.en === 'string' && v.en.trim() ? { zh: v.zh.trim(), en: v.en.trim() } : undefined;
const whole = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/**
 * The pack's supply section (`rules.plotVector.supply`). A card that does not pass the card check is left out
 * with a warning; a broken section disables the supply, never the game.
 */
export function parseSupplyRules(value: unknown): SupplyRules | undefined {
  const raw = object(value) ? value.supply : undefined;
  if (!object(raw)) return;
  const hand = whole(raw.hand, 1, 5), perRound = whole(raw.perRound, 0, 3);
  const weights = object(raw.tierWeights) ? raw.tierWeights : {}, uses = object(raw.usesByTier) ? raw.usesByTier : {};
  const tierWeights = Object.fromEntries(CARD_TIERS.map(t => [t, typeof weights[t] === 'number' && Number(weights[t]) >= 0 ? Number(weights[t]) : NaN]));
  const usesByTier = Object.fromEntries(CARD_TIERS.map(t => [t, whole(uses[t], 1, 9) ?? NaN]));
  if (hand === undefined || perRound === undefined || !Array.isArray(raw.cards) || raw.cards.length > 200
    || Object.values(tierWeights).some(Number.isNaN) || Object.values(tierWeights).every(w => w === 0)
    || Object.values(usesByTier).some(Number.isNaN)) return;
  const cards: SupplyCard[] = [];
  for (const row of raw.cards) {
    const id = object(row) && typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
    const name = object(row) ? label(row.name) : undefined, summary = object(row) ? label(row.summary) : undefined;
    if (!object(row) || !id || !name || !summary || typeof row.onPass !== 'string' || cards.some(c => c.id === id)) {
      console.warn('[PlotVector] A supply card is malformed and was left out:', row); continue;
    }
    const checked = validateCard({ for: name.zh, type: 'item', summary: summary.zh, onPass: row.onPass });
    if (!checked.ok) { console.warn(`[PlotVector] Supply card ${id} was left out: ${checked.reason}`); continue; }
    const recharge = object(row.recharge) && (row.recharge.on === 'round' || row.recharge.on === 'trigger') && whole(row.recharge.every, 1, 20)
      ? { on: row.recharge.on, every: row.recharge.every as number } as RechargeSpec : undefined;
    cards.push({ id, name, summary, spec: checked.spec, ...(recharge ? { recharge } : {}) });
  }
  if (!cards.length) return;
  const starter = Array.isArray(raw.starter) ? raw.starter.filter((s): s is string => typeof s === 'string' && cards.some(c => c.id === s)).slice(0, hand) : [];
  return { hand, perRound, tierWeights: tierWeights as Record<CardTier, number>, usesByTier: usesByTier as Record<CardTier, number>, starter, cards };
}

/** Every pool card with its rating, computed once per rules object (the rating is deterministic). */
const ratedPools = new WeakMap<SupplyRules, Map<string, CardRating>>();
function ratedPool(rules: SupplyRules): Map<string, CardRating> {
  let rated = ratedPools.get(rules);
  if (!rated) { rated = new Map(); ratedPools.set(rules, rated); }
  return rated;
}
export function supplyRatings(rules: SupplyRules): ReadonlyMap<string, CardRating> {
  const rated = ratedPool(rules);
  for (const card of rules.cards) if (!rated.has(card.id)) rated.set(card.id, rateCard(card.spec));
  return rated;
}
/**
 * Rate the pool one card per scheduled slice (the page passes an idle callback), so the first board opening
 * or round after a load does not pay for the whole pool at once. Cards already rated are skipped.
 */
export function warmSupplyRatings(rules: SupplyRules, schedule: (slice: () => void) => void): void {
  const rated = ratedPool(rules);
  const next = () => {
    const card = rules.cards.find(c => !rated.has(c.id));
    if (!card) return;
    rated.set(card.id, rateCard(card.spec));
    schedule(next);
  };
  schedule(next);
}
/** Uses a supply card holds: set by its tier (4A). */
export function usesOf(rules: SupplyRules, cardId: string): number {
  return rules.usesByTier[supplyRatings(rules).get(cardId)?.tier ?? 'common'];
}

export function initialSupply(rules: SupplyRules): SupplyState {
  return { hand: rules.starter.map(id => ({ id, cardId: id })), drawn: 0 };
}
/** A stored supply state, or undefined when absent or malformed (the opening hand is used then). */
export function readSupplyState(raw: unknown): SupplyState | undefined {
  if (!object(raw) || !Array.isArray(raw.hand) || typeof raw.drawn !== 'number') return;
  const hand = raw.hand.filter((c): c is SupplyHandCard => object(c) && typeof c.id === 'string' && typeof c.cardId === 'string')
    .map(c => ({ id: c.id, cardId: c.cardId, ...(typeof c.recharge === 'number' && c.recharge >= 0 ? { recharge: c.recharge } : {}) }));
  return { hand, drawn: Math.max(0, Math.floor(raw.drawn)) };
}

/** The hand's cards that the pack still knows, with their pool entry. */
function inHand(rules: SupplyRules, supply: SupplyState) {
  return supply.hand.flatMap(held => {
    const card = rules.cards.find(c => c.id === held.cardId);
    return card ? [{ held, card }] : [];
  });
}
/** Board definitions of the hand: consumable, uses by tier, their own store. */
export function supplyCardDefs(rules: SupplyRules, supply: SupplyState): CardDef[] {
  return inHand(rules, supply).map(({ held, card }) => {
    const uses = usesOf(rules, card.id);
    return { id: held.id, tags: [], source: 'Claude', origin: 'supply', usage: { kind: 'consumable', initialStock: uses, maxStock: uses },
      accounts: [storeAccount(held.id)], label: card.name, summary: card.summary };
  });
}
export function supplyTripCards(rules: SupplyRules, supply: SupplyState): TripCard[] {
  return inHand(rules, supply).map(({ held, card }) => ({ id: held.id, spec: card.spec, departs: false }));
}
/**
 * Uses above a card's current limit (after a tier or pack change) are clamped to the limit, so a save never
 * holds more uses than its card allows.
 */
export function clampSupplyStates(defs: readonly CardDef[], states: CardStates | undefined): CardStates {
  const next: CardStates = { ...(states ?? {}) };
  for (const def of defs) {
    const held = next[def.id];
    if (held && def.usage && held.stock > def.usage.maxStock) next[def.id] = { ...held, stock: def.usage.maxStock };
  }
  return next;
}
/** Hand cards the player can place now (at least one use left). */
export function placeableSupply(defs: readonly CardDef[], states: CardStates | undefined): string[] {
  return defs.filter(def => availableUses(def, stateOf(def, states)) > 0).map(def => def.id);
}

/** A deterministic number in [0, 1) from a string (FNV-1a, then one xorshift round). */
function unitRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return (h >>> 0) / 4294967296;
}
/** One card from the pool: a tier by its weight (tiers without cards are skipped), then a card of that tier. */
export function drawSupplyCard(rules: SupplyRules, seed: string): SupplyCard | undefined {
  const ratings = supplyRatings(rules);
  const byTier = new Map(CARD_TIERS.map(t => [t, rules.cards.filter(c => ratings.get(c.id)?.tier === t)]));
  const tiers = CARD_TIERS.filter(t => byTier.get(t)!.length && rules.tierWeights[t] > 0);
  const total = tiers.reduce((sum, t) => sum + rules.tierWeights[t], 0);
  if (!total) return;
  let roll = unitRandom(`${seed}:tier`) * total;
  const tier = tiers.find(t => (roll -= rules.tierWeights[t]) < 0) ?? tiers[tiers.length - 1];
  const cards = byTier.get(tier)!;
  return cards[Math.floor(unitRandom(`${seed}:card`) * cards.length)];
}

/**
 * After an accepted round (uses already deducted by the engine): recharge, let exhausted cards without a
 * recharge leave, then draw while the hand has room. `seed` makes the draw reproducible for the round.
 */
export function settleSupply(rules: SupplyRules, supply: SupplyState, states: CardStates, result: RunDone, seed: string)
  : { supply: SupplyState; states: CardStates } {
  const next: CardStates = { ...states };
  const defs = new Map(supplyCardDefs(rules, supply).map(def => [def.id, def]));
  const hand: SupplyHandCard[] = [];
  for (const { held, card } of inHand(rules, supply)) {
    const def = defs.get(held.id)!;
    let state = stateOf(def, next);
    let progress = held.recharge ?? 0;
    if (card.recharge) {
      const events = card.recharge.on === 'round' ? 1
        : new Set(result.trace.filter(e => e.eventType === 'effect' && e.status === 'applied' && e.owner?.id === held.id).map(e => e.visitId)).size;
      progress += events;
      while (progress >= card.recharge.every) { progress -= card.recharge.every; state = grantConsumable(def, state, 1).state; }
      // A full card does not bank recharge.
      if (state.stock >= def.usage!.maxStock) progress = 0;
      next[held.id] = state;
    }
    if (state.stock <= 0 && !card.recharge) { delete next[held.id]; continue; }
    hand.push({ id: held.id, cardId: held.cardId, ...(card.recharge ? { recharge: progress } : {}) });
  }
  let drawn = supply.drawn;
  const lastDrawn: string[] = [];
  for (let i = 0; i < rules.perRound && hand.length < rules.hand; i++) {
    const card = drawSupplyCard(rules, `${seed}:${drawn}`);
    if (!card) break;
    drawn++;
    const id = `${card.id}#${drawn}`;
    hand.push({ id, cardId: card.id, ...(card.recharge ? { recharge: 0 } : {}) });
    lastDrawn.push(id);
  }
  return { supply: { hand, drawn, ...(lastDrawn.length ? { lastDrawn } : {}) }, states: next };
}

/** What the table shows of a hand card: its pool card, its tier and, for a card that recharges, how far it is. */
export interface SupplyCardInfo { cardId: string; tier: CardTier; recharge?: RechargeSpec & { progress: number } }
export function supplyHandInfo(rules: SupplyRules, supply: SupplyState): Record<string, SupplyCardInfo> {
  const ratings = supplyRatings(rules);
  return Object.fromEntries(inHand(rules, supply).map(({ held, card }) => [held.id, {
    cardId: card.id, tier: ratings.get(card.id)?.tier ?? 'common',
    ...(card.recharge ? { recharge: { ...card.recharge, progress: held.recharge ?? 0 } } : {}),
  }]));
}

/** Display names of hand instances (for the notice after a draw). */
export function supplyNames(rules: SupplyRules, supply: SupplyState, ids: readonly string[]): LocalizedLabel[] {
  return ids.flatMap(id => {
    const held = supply.hand.find(c => c.id === id);
    const card = held && rules.cards.find(c => c.id === held.cardId);
    return card ? [card.name] : [];
  });
}
