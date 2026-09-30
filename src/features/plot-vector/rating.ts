/**
 * Card rating (rebuild plan phase 6, PO 2A; charter C1, I8): how strong a card is, measured the way the Balatro
 * lab does — run it on the board and compare with the same trips without it. The unit is a card that adds one
 * push on every pass. Tiers only steer how often a supply card is drawn, and are recorded for story cards; they
 * never weaken a card (C1).
 */
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import type { CardDef, ChannelId, Layout } from '../../engine/plot-vector/core/types';
import { TripCards, storeAccount, type TripCard } from './contract/trip';
import type { CardSpec } from './contract/types';
import { BOARD_SHAPES, VECTOR_RUN_OPTIONS, vectorBaseBoard, type BoardShape } from './vector-board';

/**
 * Six tiers, lowest first (PO 2026-09-30, 1A): 普通 white, 优良 green, 稀有 blue, 史诗 purple, 传说 orange,
 * 神话 red — the familiar ladder, so a rare find reads at a glance. The UI supplies names and colours.
 */
export type CardTier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
export const CARD_TIERS: readonly CardTier[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** Where the card acts: a cell the player fills, the status cell, or at departure (environment). */
export type RatingPlace = 'placed' | 'status' | 'departs';

export interface CardRating {
  /** Strength as a multiple of the unit card (one push per pass). */
  ratio: number;
  tier: CardTier;
  /** Share of the rating trips in which the card acted at all. */
  triggerRate: number;
  /** How the rating was measured; a rating from an older method is measured again (see RATING_VERSION). */
  version: number;
}

/**
 * 1: the line board only, four tiers. 2: the mean of both board shapes (PO 2026-09-29), four tiers.
 * 3: the same measurement as 2, six tiers (PO 2026-09-30).
 */
export const RATING_VERSION = 3;
export function ratingIsCurrent(rating: CardRating | undefined): boolean { return rating?.version === RATING_VERSION; }
/**
 * The tier to show for a stored rating. Ratings from version 2 on measure the same way, so their tier follows the
 * current thresholds straight away; a line-only rating (version 1) shows none until it is measured again.
 */
export function tierOf(rating: CardRating | undefined): CardTier | undefined {
  return rating && rating.version >= 2 && Number.isFinite(rating.ratio) ? tierForRatio(rating.ratio) : undefined;
}

/**
 * Tier boundaries on the ratio: at or above `uncommon` is uncommon, and so on. Calibrated on the same 63 cards as
 * before — the 24 pack supply cards and 39 story cards the real model wrote in the phase 5 runs — measured on both
 * board shapes. Six tiers (2026-09-30) cut at the 35th, 60th, 80th, 92nd and 98th percentile, so each step up is
 * rarer than the one below (docs/research/plot-vector-phase6-calibration-2026-09-27.md). Agent-set, to be tuned
 * with the PO (I25; PO 2026-09-30: tune after playtesting).
 */
export const TIER_THRESHOLDS: Readonly<Record<Exclude<CardTier, 'common'>, number>> =
  { uncommon: 1.27, rare: 1.76, epic: 2.56, legendary: 5.16, mythic: 8.05 };

export function tierForRatio(ratio: number): CardTier {
  for (let i = CARD_TIERS.length - 1; i > 0; i--) {
    const tier = CARD_TIERS[i] as Exclude<CardTier, 'common'>;
    if (ratio >= TIER_THRESHOLDS[tier]) return tier;
  }
  return 'common';
}

const CHANNELS: readonly ChannelId[] = ['S+', 'S-', 'Y', 'J'];
const RATED = 'rate:card';
const HELPER: CardSpec = { for: 'helper', type: 'item', summary: 'helper', onPass: 'return { push: 1 };' };
const UNIT: CardSpec = { for: 'unit', type: 'item', summary: 'unit', onPass: 'return { push: 1 };' };

/**
 * The fixed trips a card is rated on: four starting payloads (empty, typical, strong, and heavy resistance as a
 * fever or a harsh environment brings), two trip lengths, an empty and a busy board.
 */
const PAYLOADS: ReadonlyArray<Record<ChannelId, number>> = [
  { 'S+': 0, 'S-': 0, Y: 0, J: 0 },
  { 'S+': 2.5, 'S-': 1, Y: 2.4, J: 1.9 },
  { 'S+': 4, 'S-': 2, Y: 4, J: 4 },
  { 'S+': 2, 'S-': 6, Y: 2, J: 2 },
];
const BUDGETS = [8, 12];
const CELLS = ['01', '02', '03', '04', '05'];
const PLACES: Readonly<Record<RatingPlace, readonly (string | null)[]>> = { placed: ['01', '03', '05'], status: ['06'], departs: [null] };

function cardDef(id: string): CardDef {
  return { id, tags: [], source: 'Model', origin: 'item', accounts: [storeAccount(id)], label: { zh: id, en: id } };
}

/** Final shuttle of one trip, or null when the trip could not be run. */
function shuttleOf(shape: BoardShape, spec: CardSpec | null, place: RatingPlace, cell: string | null, payload: Record<ChannelId, number>, budget: number, busy: boolean, seed: string) {
  const placements: Record<string, string | null> = Object.fromEntries([...CELLS, '06'].map(c => [c, null]));
  const trip: TripCard[] = [];
  const defs: CardDef[] = [];
  if (busy) {
    // Two neighbours that act on every pass, so relays, echoes and conversions have something to work on.
    for (const [i, helperCell] of CELLS.filter(c => c !== cell).slice(0, 2).entries()) {
      const id = `rate:helper:${i}`;
      placements[helperCell] = id; trip.push({ id, spec: HELPER, departs: false }); defs.push(cardDef(id));
    }
  }
  if (spec) {
    trip.push({ id: RATED, spec, departs: place === 'departs' }); defs.push(cardDef(RATED));
    if (cell) placements[cell] = RATED;
  }
  const layout: Layout = { placements, tray: [] };
  const board = compileBoard({ ...vectorBaseBoard(shape), startPayload: payload, cards: defs });
  const result = run(board, { id: seed, round: 0, seed, layout, options: VECTOR_RUN_OPTIONS, cardStates: {}, carriedAccounts: {}, visitBudget: budget },
    { cards: new TripCards(trip, {}, seed) });
  // Relays and departures act without a shuttle operation of their own, so "acted" reads the trace.
  return result.status === 'done'
    ? { shuttle: result.finalState.shuttle, acted: result.trace.some(e => e.owner?.id === RATED && e.status === 'applied') }
    : null;
}

/**
 * Mean absolute change of the four channels the card causes, and how often it acted, over the rating trips on
 * both board shapes (the same trips on each, so the mean weighs the two shapes equally).
 */
function measure(spec: CardSpec, place: RatingPlace): { impact: number; triggerRate: number } {
  let impact = 0, acted = 0, trips = 0;
  for (const shape of BOARD_SHAPES) for (const cell of PLACES[place]) for (const [p, payload] of PAYLOADS.entries()) for (const budget of BUDGETS) for (const busy of [false, true]) {
    const seed = `rate:${cell ?? 'depart'}:${p}:${budget}:${busy ? 'busy' : 'empty'}`;
    const without = shuttleOf(shape, null, place, cell, payload, budget, busy, seed);
    const withCard = shuttleOf(shape, spec, place, cell, payload, budget, busy, seed);
    trips++;
    if (!without || !withCard) continue;
    impact += CHANNELS.reduce((sum, ch) => sum + Math.abs((withCard.shuttle[ch] ?? 0) - (without.shuttle[ch] ?? 0)), 0);
    if (withCard.acted) acted++;
  }
  return { impact: trips ? impact / trips : 0, triggerRate: trips ? acted / trips : 0 };
}

let unitImpact: number | undefined;
/** The unit card's impact on the placed trips (computed once). */
function unit(): number {
  unitImpact ??= measure(UNIT, 'placed').impact;
  return unitImpact;
}

/** Rate one card. Pure and deterministic: the same card always gets the same rating. */
export function rateCard(spec: CardSpec, place: RatingPlace = 'placed'): CardRating {
  const { impact, triggerRate } = measure(spec, place);
  const ratio = Math.round((impact / unit()) * 100) / 100;
  return { ratio, tier: tierForRatio(ratio), triggerRate: Math.round(triggerRate * 100) / 100, version: RATING_VERSION };
}

/** Where a card of this type acts, for rating it. */
export function ratingPlaceOf(type: CardSpec['type']): RatingPlace {
  return type === 'status' ? 'status' : type === 'environment' ? 'departs' : 'placed';
}
