/**
 * Card rating (rebuild plan phase 6, PO 2A; charter C1, I8): how strong a card is, measured the way the Balatro
 * lab does — run it on the board and compare with the same trips without it. The unit is a card that adds one
 * push on every pass. Tiers only steer how often a supply card is drawn, and are recorded for story cards; they
 * never weaken a card (C1).
 */
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { codeMentions } from './contract/code-words';
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

/** The four quantities by their domain names (push, drag, social, chance). */
export interface ChannelValues { push: number; drag: number; social: number; chance: number }

/**
 * What a card does, measured on the same trips as its rating (PO 2026-10-01: the table explains a card from the
 * engine, never from the model's words). The change is the card's own: what its actions moved on the shuttle,
 * with stored amounts counted as kept (storing and releasing move nothing but the release bonus), so a cell
 * that turns one quantity into another does not show up as the card's doing. What a relay does lands on the next
 * card's actions, so a card whose code returns a relay (or that never acts itself) shows the trip's change with it
 * against without it, and changes the route when the trip with it turns or steps differently.
 * `perTrip` is the mean signed change of each quantity over a trip, in multiples of the unit card's (one push
 * per pass); `perAct` the mean signed change each time it acts, in the shuttle's own units (shown only with
 * exact numbers). `route`: it turned the shuttle or changed its steps; `store`: it stored or released something.
 */
export interface EffectProfile {
  perTrip: ChannelValues;
  perAct: ChannelValues;
  route: boolean;
  store: boolean;
}

export interface CardRating {
  /** Strength as a multiple of the unit card (one push per pass). */
  ratio: number;
  tier: CardTier;
  /** Share of the rating trips in which the card acted at all. */
  triggerRate: number;
  /** How the rating was measured; a rating from an older method is measured again (see RATING_VERSION). */
  version: number;
  /** From version 4 on. */
  profile?: EffectProfile;
}

/**
 * 1: the line board only, four tiers. 2: the mean of both board shapes (PO 2026-09-29), four tiers.
 * 3: the same measurement as 2, six tiers (PO 2026-09-30). 4: the same as 3, with the effect profile (PO 2026-10-01).
 */
export const RATING_VERSION = 4;
export function ratingIsCurrent(rating: CardRating | undefined): boolean { return rating?.version === RATING_VERSION; }
/** A current rating read from outside the save (a device cache), or undefined when it is not one. */
export function readRating(value: unknown): CardRating | undefined {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const channels = (v: unknown): v is ChannelValues => record(v) && num(v.push) && num(v.drag) && num(v.social) && num(v.chance);
  if (!record(value) || value.version !== RATING_VERSION || !num(value.ratio) || !num(value.triggerRate)) return;
  const p = value.profile;
  if (!record(p) || !channels(p.perTrip) || !channels(p.perAct) || typeof p.route !== 'boolean' || typeof p.store !== 'boolean') return;
  const pick = (c: ChannelValues): ChannelValues => ({ push: c.push, drag: c.drag, social: c.social, chance: c.chance });
  return { ratio: value.ratio, tier: tierForRatio(value.ratio), triggerRate: value.triggerRate, version: RATING_VERSION,
    profile: { perTrip: pick(p.perTrip), perAct: pick(p.perAct), route: p.route, store: p.store } };
}
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
/** Each shuttle channel by its domain name. */
const NAMED: ReadonlyArray<[keyof ChannelValues, ChannelId]> = [['push', 'S+'], ['drag', 'S-'], ['social', 'Y'], ['chance', 'J']];
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
  if (result.status !== 'done') return null;
  // Relays and departures act without a shuttle operation of their own, so "acted" reads the trace.
  const own = result.trace.filter(e => e.owner?.id === RATED && e.status === 'applied');
  const effects = own.filter(e => e.eventType === 'effect');
  // A relay storing into itself or letting its store out is the relay at work, not the card's own act.
  const relayed = (e: (typeof own)[number]) => !!e.cardEffects?.length && e.cardEffects.every(effect => effect.startsWith('relay '));
  const acts = effects.filter(e => !relayed(e));
  const routes = (e: (typeof own)[number]) => !!e.cardEffects?.some(effect => effect === 'turn' || effect.startsWith('steps'));
  // A channel's deltas on every account: a transfer between the shuttle and the card's store sums to its bonus.
  // What a relay stores into itself was taken from the next card's return, so it is not the relay's own change.
  const direct: Partial<Record<ChannelId, number>> = {};
  for (const event of effects) {
    if (event.cardEffects?.includes('relay store')) continue;
    for (const d of event.deltas) if ((CHANNELS as readonly string[]).includes(d.channelOrField)) {
      const ch = d.channelOrField as ChannelId;
      direct[ch] = (direct[ch] ?? 0) + d.after - d.before;
    }
  }
  return {
    shuttle: result.finalState.shuttle,
    acted: own.length > 0,
    acts: acts.length,
    direct,
    route: acts.some(routes),
    store: effects.some(e => e.cardEffects?.some(effect => effect.startsWith('store') || effect === 'release' || effect.startsWith('relay '))),
    /** Turns and step changes in the whole trip, whoever made them (a relay's land on the next card). */
    routeAll: result.trace.filter(e => e.eventType === 'effect' && e.status === 'applied' && routes(e)).length,
  };
}

interface Measured {
  impact: number; triggerRate: number; direct: ChannelValues; net: ChannelValues; acts: number;
  /** Trips that ran both with and without the card (the profile's measure). */
  ran: number;
  route: boolean; store: boolean;
  /** Some trip turned or stepped differently with the card than without it. */
  routeNet: boolean;
}
/**
 * Mean absolute change of the four channels the card causes, and how often it acted, over the rating trips on
 * both board shapes (the same trips on each, so the mean weighs the two shapes equally). The signed change of
 * each channel, the number of times it acted, and whether it ever changed the route or stored something are
 * gathered on the same trips (the effect profile).
 */
function measure(spec: CardSpec, place: RatingPlace): Measured {
  let impact = 0, acted = 0, trips = 0, ran = 0, acts = 0, route = false, store = false, routeNet = false;
  const direct: ChannelValues = { push: 0, drag: 0, social: 0, chance: 0 }, net: ChannelValues = { push: 0, drag: 0, social: 0, chance: 0 };
  for (const shape of BOARD_SHAPES) for (const cell of PLACES[place]) for (const [p, payload] of PAYLOADS.entries()) for (const budget of BUDGETS) for (const busy of [false, true]) {
    const seed = `rate:${cell ?? 'depart'}:${p}:${budget}:${busy ? 'busy' : 'empty'}`;
    const without = shuttleOf(shape, null, place, cell, payload, budget, busy, seed);
    const withCard = shuttleOf(shape, spec, place, cell, payload, budget, busy, seed);
    trips++;
    if (!without || !withCard) continue;
    ran++;
    impact += CHANNELS.reduce((sum, ch) => sum + Math.abs((withCard.shuttle[ch] ?? 0) - (without.shuttle[ch] ?? 0)), 0);
    for (const [name, ch] of NAMED) {
      direct[name] += withCard.direct[ch] ?? 0;
      net[name] += (withCard.shuttle[ch] ?? 0) - (without.shuttle[ch] ?? 0);
    }
    if (withCard.acted) acted++;
    acts += withCard.acts;
    route ||= withCard.route;
    store ||= withCard.store;
    routeNet ||= withCard.routeAll !== without.routeAll;
  }
  return { impact: trips ? impact / trips : 0, triggerRate: trips ? acted / trips : 0, direct, net, acts, ran, route, store, routeNet };
}
const round2 = (value: number) => Math.round(value * 100) / 100 || 0;
const scaled = (values: ChannelValues, by: number): ChannelValues => ({
  push: round2(by ? values.push / by : 0), drag: round2(by ? values.drag / by : 0),
  social: round2(by ? values.social / by : 0), chance: round2(by ? values.chance / by : 0),
});

/** The unit card on the placed trips (measured once): its impact, and its own push over a trip. */
let unitMemo: { impact: number; push: number } | undefined;
function unitMeasure(): { impact: number; push: number } {
  if (!unitMemo) {
    const m = measure(UNIT, 'placed');
    unitMemo = { impact: m.impact, push: m.ran ? m.direct.push / m.ran : 0 };
  }
  return unitMemo;
}
const unit = () => unitMeasure().impact;
const unitPush = () => unitMeasure().push;

/** Rate one card. Pure and deterministic: the same card always gets the same rating. */
export function rateCard(spec: CardSpec, place: RatingPlace = 'placed'): CardRating {
  const m = measure(spec, place);
  const ratio = Math.round((m.impact / unit()) * 100) / 100;
  // A relay works through the next card, so a card that returns one (or never acts itself) is shown by the trip's
  // change; a card that turns, steps or stores acts by that, which its route and store flags say.
  const relays = codeMentions(spec.onPass, 'relay') || m.acts === 0;
  const profile: EffectProfile = {
    perTrip: scaled(relays ? m.net : m.direct, m.ran * unitPush()),
    perAct: scaled(m.direct, m.acts),
    route: m.route || (relays && m.routeNet), store: m.store,
  };
  return { ratio, tier: tierForRatio(ratio), triggerRate: Math.round(m.triggerRate * 100) / 100, version: RATING_VERSION, profile };
}

/** Where a card of this type acts, for rating it. */
export function ratingPlaceOf(type: CardSpec['type']): RatingPlace {
  return type === 'status' ? 'status' : type === 'environment' ? 'departs' : 'placed';
}
