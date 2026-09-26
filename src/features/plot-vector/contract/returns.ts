/**
 * Reading and bounding what a card returns (rebuild plan §2.4/§2.6), growth `add` over a return
 * (§2.5) and relays applied to another card's return (§2.4, charter I17).
 */
import { CHANNEL_NAMES, LIMITS, MULTIPLIER_OF, type CardReturn, type ChannelName, type RelayReturn } from './types';

type Plain = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isChannel = (value: unknown): value is ChannelName => typeof value === 'string' && (CHANNEL_NAMES as readonly string[]).includes(value);
/** Read one property once; a throwing getter reads as absent. */
function read(record: Plain, key: string): unknown {
  try { return record[key]; } catch { return undefined; }
}
/** A switch is on when it is `true` or a number of at least 1. */
const switchedOn = (value: unknown) => value === true || (finite(value) ?? 0) >= 1;

/** Bound the operations shared by a return and a relay; unknown keys and non-finite numbers are ignored. */
function readOperations(record: Plain): RelayReturn {
  const out: RelayReturn = {};
  for (const channel of CHANNEL_NAMES) {
    const amount = finite(read(record, channel));
    if (amount !== undefined) out[channel] = clamp(amount, -LIMITS.amount, LIMITS.amount);
    const factor = finite(read(record, MULTIPLIER_OF[channel]));
    if (factor !== undefined) out[MULTIPLIER_OF[channel]] = clamp(factor, LIMITS.multiplier.min, LIMITS.multiplier.max);
  }
  const convert = read(record, 'convert');
  if (isRecord(convert)) {
    const from = read(convert, 'from'), to = read(convert, 'to'), amount = finite(read(convert, 'amount'));
    if (isChannel(from) && isChannel(to) && from !== to && amount !== undefined)
      out.convert = { from, to, amount: clamp(amount, 0, LIMITS.amount) };
  }
  // A step count of 0 and a remaining-steps factor of 1 do nothing, so they are not kept.
  const steps = finite(read(record, 'steps'));
  if (steps !== undefined && clamp(Math.floor(steps), LIMITS.steps.min, LIMITS.steps.max) > 0)
    out.steps = clamp(Math.floor(steps), LIMITS.steps.min, LIMITS.steps.max);
  const xSteps = finite(read(record, 'xSteps'));
  if (xSteps !== undefined && clamp(xSteps, LIMITS.xSteps.min, LIMITS.xSteps.max) !== 1)
    out.xSteps = clamp(xSteps, LIMITS.xSteps.min, LIMITS.xSteps.max);
  if (switchedOn(read(record, 'turn'))) out.turn = true;
  const store = read(record, 'store');
  if (isRecord(store)) {
    const from = read(store, 'from'), amount = finite(read(store, 'amount'));
    if (isChannel(from) && amount !== undefined) out.store = { from, amount: clamp(amount, 0, LIMITS.amount) };
  }
  if (switchedOn(read(record, 'release'))) out.release = true;
  return out;
}

/** What `onPass` returned, read once and bounded. A non-object means "did not act this time". */
export function readReturn(raw: unknown): CardReturn {
  if (!isRecord(raw)) return {};
  const out: CardReturn = readOperations(raw);
  const relay = read(raw, 'relay');
  if (isRecord(relay)) {
    const inner: RelayReturn = readOperations(relay);
    if (switchedOn(read(relay, 'echo'))) inner.echo = true;
    if (acts(inner)) out.relay = inner;
  }
  return out;
}

/** Whether a set of operations changes anything (a card that returns nothing effective did not trigger). */
export function acts(ops: RelayReturn): boolean {
  for (const channel of CHANNEL_NAMES) {
    if ((ops[channel] ?? 0) !== 0) return true;
    const factor = ops[MULTIPLIER_OF[channel]];
    if (factor !== undefined && factor !== 1) return true;
  }
  return (ops.convert?.amount ?? 0) > 0 || (ops.steps ?? 0) > 0 || (ops.xSteps ?? 1) !== 1 || !!ops.turn
    || (ops.store?.amount ?? 0) > 0 || !!ops.release || !!ops.echo;
}

/** A card triggers when its (bounded) return does something, including arming a relay. */
export function triggers(ret: CardReturn): boolean {
  return acts(ret) || (ret.relay !== undefined && acts(ret.relay));
}

/**
 * Add `level` times a growth `add` onto a triggered return: amounts, steps and switches add up from 0,
 * multipliers from 1; a convert/store the card did not return is created from the add's own from/to.
 * The result is bounded again, so growth can never leave the safety limits.
 */
export function withGrowth(ret: CardReturn, add: Plain | undefined, level: number): CardReturn {
  if (!add || level <= 0) return ret;
  const merged = mergeScaled(ret, add, level) as CardReturn;
  const relayAdd = read(add, 'relay');
  if (isRecord(relayAdd)) merged.relay = mergeScaled(ret.relay ?? {}, relayAdd, level) as RelayReturn;
  return readReturn(merged);
}

function mergeScaled(base: RelayReturn, add: Plain, level: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const scaled = (key: string) => (finite(read(add, key)) ?? 0) * level;
  for (const channel of CHANNEL_NAMES) {
    if (finite(read(add, channel)) !== undefined) out[channel] = (base[channel] ?? 0) + scaled(channel);
    const x = MULTIPLIER_OF[channel];
    if (finite(read(add, x)) !== undefined) out[x] = (base[x] ?? 1) + scaled(x);
  }
  if (finite(read(add, 'steps')) !== undefined) out.steps = (base.steps ?? 0) + scaled('steps');
  if (finite(read(add, 'xSteps')) !== undefined) out.xSteps = (base.xSteps ?? 1) + scaled('xSteps');
  for (const flag of ['turn', 'release', 'echo'] as const) {
    if (finite(read(add, flag)) !== undefined && (base[flag] || scaled(flag) >= 1)) out[flag] = true;
  }
  for (const key of ['convert', 'store'] as const) {
    const extra = read(add, key);
    if (!isRecord(extra)) continue;
    const own = base[key] as Plain | undefined;
    out[key] = { ...extra, ...(own ?? {}), amount: (finite(own?.amount) ?? 0) + (finite(read(extra, 'amount')) ?? 0) * level };
  }
  return out;
}

/** What applying a relay to another card's return asks of the relaying card itself. */
export interface RelayOutcome {
  target: CardReturn;
  /** The target's return is carried out once more. */
  echo: boolean;
  /** Part of the target's output that goes into the relaying card's own store. */
  storeIntoRelayCard?: { channel: ChannelName; amount: number };
  /** The relaying card releases its own store at this moment. */
  releaseRelayCard: boolean;
}

/**
 * Apply a relay to the return of the next card that triggers (§2.4): amounts add to what it produces,
 * multipliers scale what it produces, a convert moves between its outputs, steps/turn add on, a store
 * keeps part of its output in the relaying card, a release empties the relaying card's store now, and
 * `echo` carries the target's return out once more. The target is bounded again afterwards.
 */
export function applyRelay(target: CardReturn, relay: RelayReturn): RelayOutcome {
  const out: Record<string, unknown> = { ...target };
  const produced = (channel: ChannelName) => (out[channel] as number | undefined) ?? 0;
  for (const channel of CHANNEL_NAMES) {
    if (relay[channel] !== undefined) out[channel] = produced(channel) + relay[channel]!;
    const factor = relay[MULTIPLIER_OF[channel]];
    if (factor !== undefined) out[channel] = produced(channel) * factor;
  }
  if (relay.convert) {
    const moved = Math.min(relay.convert.amount, Math.max(0, produced(relay.convert.from)));
    out[relay.convert.from] = produced(relay.convert.from) - moved;
    out[relay.convert.to] = produced(relay.convert.to) + moved;
  }
  let storeIntoRelayCard: RelayOutcome['storeIntoRelayCard'];
  if (relay.store) {
    const kept = Math.min(relay.store.amount, Math.max(0, produced(relay.store.from)));
    if (kept > 0) {
      out[relay.store.from] = produced(relay.store.from) - kept;
      storeIntoRelayCard = { channel: relay.store.from, amount: kept };
    }
  }
  if (relay.steps !== undefined) out.steps = ((out.steps as number | undefined) ?? 0) + relay.steps;
  if (relay.xSteps !== undefined) out.xSteps = ((out.xSteps as number | undefined) ?? 1) * relay.xSteps;
  if (relay.turn) out.turn = true;
  return { target: readReturn(out), echo: !!relay.echo, storeIntoRelayCard, releaseRelayCard: !!relay.release };
}
