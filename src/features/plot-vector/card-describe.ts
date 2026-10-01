// App doc: docs/user-guide/pages/game-main.md §3.18.7 · Marks and colours (§3.18.5 growth sentence)
/**
 * What a card does and how it grows, as structured data the table turns into words (PO 2026-10-01; demo
 * docs/demo/plot-vector-effect-and-start.html). Everything here comes from the engine: the effect marks from the
 * card's measured profile (rating.ts), the growth from its declared GrowthSpec and the engine's growth record.
 * Nothing reads the model's own wording, so the explanation never depends on how the model formatted it. Pure;
 * the UI supplies the words from a fixed glossary.
 */
import { growthCap } from './contract/growth';
import { readReturn } from './contract/returns';
import { codeMentions } from './contract/code-words';
import { CHANNEL_NAMES, MULTIPLIER_OF, type CardReturn, type CardSpec, type ChannelName, type GrowthState, type GrowthTrigger } from './contract/types';
import type { EffectProfile } from './rating';

/**
 * The marks, by the direction of the three tendency bars: `up` leans the trip toward 顺 (more push or less drag),
 * `down` toward 逆 (more drag or less push); social and chance feed their bars; `route` turns the shuttle or
 * changes its steps; `store` keeps an amount for later.
 */
export type EffectMark = 'up' | 'down' | 'social' | 'chance' | 'route' | 'store';
export const EFFECT_MARKS: readonly EffectMark[] = ['up', 'down', 'social', 'chance', 'route', 'store'];

export interface CardEffect {
  mark: EffectMark;
  /** 1–3 by how much the card moves it over a trip, against the unit card; 0 for route and store, which have no size. */
  strength: 0 | 1 | 2 | 3;
  /** Social or chance going down (a card that costs it). */
  less?: boolean;
  /**
   * For exact numbers: the mean change each time the card acts, in the shuttle's own units, by quantity (a lean
   * shows push and drag apart). Empty for a card that acts only through the next card.
   */
  exact: Partial<Record<ChannelName, number>>;
}

/** A change smaller than this, over a trip in units of the unit card, is not shown as the card's own. */
export const SHOWN_FROM = 0.3;
/** Where a mark gets its second and third stroke (unit card = 1; calibrated on the pack pool, PO 2026-10-01). */
export const STRENGTH_STEPS = [1.5, 3.5] as const;
/** An exact number smaller than this is noise of the measurement, not something the card does. */
const EXACT_FROM = 0.05;

const strength = (size: number): 1 | 2 | 3 => (size >= STRENGTH_STEPS[1] ? 3 : size >= STRENGTH_STEPS[0] ? 2 : 1);
const exactOf = (perAct: EffectProfile['perAct'], ...names: ChannelName[]): Partial<Record<ChannelName, number>> =>
  Object.fromEntries(names.filter(n => Math.abs(perAct[n]) >= EXACT_FROM).map(n => [n, perAct[n]]));

/** The marks of a measured card, in the order of the bars (lean, social, chance), then route and store. */
export function effectMarks(profile: EffectProfile | undefined): CardEffect[] {
  // A profile from a damaged save shows no marks rather than breaking the table.
  if (!profile?.perTrip || !profile.perAct) return [];
  const { perTrip, perAct } = profile;
  const out: CardEffect[] = [];
  const lean = perTrip.push - perTrip.drag;
  if (Math.abs(lean) >= SHOWN_FROM) out.push({ mark: lean > 0 ? 'up' : 'down', strength: strength(Math.abs(lean)), exact: exactOf(perAct, 'push', 'drag') });
  for (const name of ['social', 'chance'] as const) {
    if (Math.abs(perTrip[name]) < SHOWN_FROM) continue;
    out.push({ mark: name, strength: strength(Math.abs(perTrip[name])), ...(perTrip[name] < 0 ? { less: true } : {}), exact: exactOf(perAct, name) });
  }
  if (profile.route) out.push({ mark: 'route', strength: 0, exact: {} });
  if (profile.store) out.push({ mark: 'store', strength: 0, exact: {} });
  return out;
}

/**
 * One part of a return, for words. `amount` adds to a quantity; `factor` multiplies it; `convert` turns one into
 * another; `steps` adds steps; `xSteps` multiplies the steps left; `turn`, `release` and `echo` are switches
 * (in a growth add, on from level `fromLevel`); `store` keeps an amount; `relay` is what the card does to the next
 * card that acts; `other` is a change the words cannot say.
 */
export type ReturnPhrase =
  | { kind: 'amount'; channel: ChannelName; value: number }
  | { kind: 'factor'; channel: ChannelName; value: number }
  | { kind: 'convert'; from?: ChannelName; to?: ChannelName; amount: number }
  | { kind: 'steps'; value: number }
  | { kind: 'xSteps'; value: number }
  | { kind: 'turn'; fromLevel?: number }
  | { kind: 'store'; from?: ChannelName; amount: number }
  | { kind: 'release'; fromLevel?: number }
  | { kind: 'echo'; fromLevel?: number }
  | { kind: 'relay'; parts: ReturnPhrase[] }
  | { kind: 'other' };

/**
 * A growth `add` read for words: what one level adds to every triggered return, mirroring the engine's merge
 * (contract/returns.ts mergeScaled), which scales the add by the level and bounds only the sum. So the add is read
 * unbounded: amounts, steps (also fractional or negative) and multiplier rises per level as written; a switch is a
 * number and turns on once level × number reaches 1, from level ⌈1/number⌉; a convert or store amount grows the
 * card's own convert or store when its code returns one (then its channels are the card's), otherwise the add's.
 * `code` is the card's `onPass`.
 */
export function describeAdd(add: Readonly<Record<string, unknown>> | undefined, code = ''): ReturnPhrase[] {
  if (!add) return [];
  const out = addPhrases(add, code);
  const relay = get(add, 'relay');
  if (isRecord(relay)) {
    const parts = addPhrases(relay, code);
    if (switchFrom(get(relay, 'echo')) !== undefined) parts.push({ kind: 'echo', fromLevel: switchFrom(get(relay, 'echo'))! });
    if (parts.length) out.push({ kind: 'relay', parts });
  }
  return out;
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => !!v && typeof v === 'object' && !Array.isArray(v);
const isChannel = (v: unknown): v is ChannelName => typeof v === 'string' && (CHANNEL_NAMES as readonly string[]).includes(v);
/** Read one property once; a throwing getter reads as absent. */
function get(record: Readonly<Record<string, unknown>>, key: string): unknown {
  try { return record[key]; } catch { return undefined; }
}
/** The level a switch in an add turns on from (the first level × number ≥ 1, as the engine checks), or undefined. */
function switchFrom(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined || n <= 0) return undefined;
  let level = Math.max(1, Math.floor(1 / n));
  while (level * n < 1) level++;
  return level;
}

function addPhrases(add: Readonly<Record<string, unknown>>, code: string): ReturnPhrase[] {
  const out: ReturnPhrase[] = [];
  for (const channel of CHANNEL_NAMES) {
    const amount = finite(get(add, channel));
    if (amount) out.push({ kind: 'amount', channel, value: amount });
    const rise = finite(get(add, MULTIPLIER_OF[channel]));
    if (rise) out.push({ kind: 'factor', channel, value: rise });
  }
  const convert = get(add, 'convert');
  if (isRecord(convert)) {
    const amount = finite(get(convert, 'amount')) ?? 0, from = get(convert, 'from'), to = get(convert, 'to');
    const own = codeMentions(code, 'convert');
    // Without channels of its own or in the add, the engine drops the convert.
    if (amount < 0) out.push({ kind: 'other' });
    else if (amount > 0 && own) out.push({ kind: 'convert', amount });
    else if (amount > 0 && isChannel(from) && isChannel(to) && from !== to) out.push({ kind: 'convert', from, to, amount });
  }
  const steps = finite(get(add, 'steps'));
  if (steps) out.push({ kind: 'steps', value: steps });
  const xSteps = finite(get(add, 'xSteps'));
  if (xSteps) out.push({ kind: 'xSteps', value: xSteps });
  const turn = switchFrom(get(add, 'turn'));
  if (turn !== undefined) out.push({ kind: 'turn', fromLevel: turn });
  const store = get(add, 'store');
  if (isRecord(store)) {
    const amount = finite(get(store, 'amount')) ?? 0, from = get(store, 'from');
    const own = codeMentions(code, 'store');
    if (amount < 0) out.push({ kind: 'other' });
    else if (amount > 0 && own) out.push({ kind: 'store', amount });
    else if (amount > 0 && isChannel(from)) out.push({ kind: 'store', from, amount });
  }
  const release = switchFrom(get(add, 'release'));
  if (release !== undefined) out.push({ kind: 'release', fromLevel: release });
  return out;
}

/** A return (a growth burst) read for words, as the engine carries it out. */
export function describeReturn(raw: unknown): ReturnPhrase[] {
  return phrases(readReturn(raw));
}

/** A bounded return, part by part. */
function phrases(ret: Omit<CardReturn, 'relay'> & { relay?: CardReturn['relay']; echo?: boolean }): ReturnPhrase[] {
  const out: ReturnPhrase[] = [];
  for (const channel of CHANNEL_NAMES) {
    const amount = ret[channel];
    if (amount) out.push({ kind: 'amount', channel, value: amount });
    const factor = ret[MULTIPLIER_OF[channel]];
    if (factor !== undefined && factor !== 1) out.push({ kind: 'factor', channel, value: factor });
  }
  if (ret.convert && ret.convert.amount > 0) out.push({ kind: 'convert', ...ret.convert });
  if (ret.steps) out.push({ kind: 'steps', value: ret.steps });
  if (ret.xSteps !== undefined && ret.xSteps !== 1) out.push({ kind: 'xSteps', value: ret.xSteps });
  if (ret.turn) out.push({ kind: 'turn' });
  if (ret.store && ret.store.amount > 0) out.push({ kind: 'store', ...ret.store });
  if (ret.release) out.push({ kind: 'release' });
  if (ret.echo) out.push({ kind: 'echo' });
  if (ret.relay) {
    const parts = phrases(ret.relay);
    if (parts.length) out.push({ kind: 'relay', parts });
  }
  return out;
}

/** How a card grows and where it stands, for the detail's growth block. */
export interface GrowthView {
  on: GrowthTrigger;
  /** Events of its kind per level. */
  every: number;
  /** The highest level it can reach. */
  max: number;
  level: number;
  /** Events counted toward the next level. */
  progress: number;
  /** Events still needed for the next level (0 at the highest level). */
  toNext: number;
  /** What each level adds to every time it acts. */
  add: ReturnPhrase[];
  /** What it does once for each level gained (at that moment for trigger growth, at the next departure otherwise). */
  burst: ReturnPhrase[];
  /** Its own rule reads its level too, so it changes with the level in a way only its code says. */
  readsLevel: boolean;
}


function reachable(phrases: ReturnPhrase[], max: number): ReturnPhrase[] {
  return phrases.flatMap((p): ReturnPhrase[] => {
    if ((p.kind === 'turn' || p.kind === 'release' || p.kind === 'echo') && (p.fromLevel ?? 1) > max) return [];
    if (p.kind !== 'relay') return [p];
    const parts = reachable(p.parts, max);
    return parts.length ? [{ kind: 'relay', parts }] : [];
  });
}

export function growthView(spec: CardSpec, state: GrowthState | undefined): GrowthView | undefined {
  const growth = spec.growth;
  if (!growth) return;
  const max = growthCap(growth), every = Math.max(1, Math.floor(growth.every));
  const level = Math.min(max, state?.level ?? 0), progress = level >= max ? 0 : Math.min(every - 1, state?.progress ?? 0);
  return {
    on: growth.on, every, max, level, progress,
    toNext: level >= max ? 0 : every - progress,
    // A switch that would turn on only beyond the highest level never does: it is not said.
    add: reachable(describeAdd(growth.add, spec.onPass), max),
    burst: describeReturn(growth.burst),
    // `ctx.level` (or a destructured `level`) in its code, not in a comment or a text.
    readsLevel: codeMentions(spec.onPass, 'level'),
  };
}
