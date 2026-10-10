/**
 * One trip's card runtime (rebuild plan §2, §3; phase 2 decisions): feeds each card the live values,
 * applies relays and echoes between cards, runs the growth machine and turns bounded returns into
 * engine operations. The engine only sees operations.
 */
import type { AccountDef, CardAction, CardPassInput, CardPassOutput, CardRuntime, ChannelId, OperationDef } from '../../../engine/plot-vector/core/types';
import { SHUTTLE_ACCOUNT } from '../../../engine/plot-vector/core/runner';
import { burstOf, passCard } from './pass';
import { acts, applyRelay, triggers } from './returns';
import { grow, initialGrowth } from './growth';
import { CHANNEL_NAMES, LIMITS, MULTIPLIER_OF, RELEASE_BONUS, type CardReturn, type CardSpec, type ChannelName, type GrowthState, type PassValues, type RelayReturn } from './types';

/** Domain names to the board's channels (推力 S+, 阻力 S−, 人际 Y, 机会 J). */
const CHANNEL_ID: Readonly<Record<ChannelName, ChannelId>> = { push: 'S+', drag: 'S-', social: 'Y', chance: 'J' };
/** The trace's word for a pass that armed a relay and did nothing else then. */
export const RELAY_ARMED = 'relay armed';

/** A card's own store: carried across rounds, at most LIMITS.stored in total, never expiring. */
export function storeAccountId(cardId: string): string {
  return `store:${cardId}`;
}
export function storeAccount(cardId: string): AccountDef {
  return { id: storeAccountId(cardId), owner: { kind: 'card', id: cardId }, encoding: 'channelVector', persist: 'acrossRounds', cap: LIMITS.stored, lifetimeRounds: 'unbounded' };
}

/**
 * The phases of a return, in the order the domain describes (add, multiply, move, store, release, steps, step
 * multiplier, turn): each is the part of a return one phase carries out.
 */
const RETURN_PHASES: ReadonlyArray<(ret: CardReturn) => CardReturn> = [
  ret => Object.fromEntries(CHANNEL_NAMES.flatMap(name => (ret[name] ? [[name, ret[name]]] : []))) as CardReturn,
  ret => Object.fromEntries(CHANNEL_NAMES.flatMap(name => (ret[MULTIPLIER_OF[name]] !== undefined ? [[MULTIPLIER_OF[name], ret[MULTIPLIER_OF[name]]]] : []))) as CardReturn,
  ret => (ret.convert ? { convert: ret.convert } : {}),
  ret => (ret.store ? { store: ret.store } : {}),
  ret => (ret.release ? { release: ret.release } : {}),
  ret => (ret.steps ? { steps: ret.steps } : {}),
  ret => (ret.xSteps !== undefined ? { xSteps: ret.xSteps } : {}),
  ret => (ret.turn ? { turn: ret.turn } : {}),
];

/** Operations for one bounded return, in the fixed order the domain describes. */
function operationsOf(owner: string, ret: CardReturn): { operations: OperationDef[]; summary: string[] } {
  const operations: OperationDef[] = [], summary: string[] = [];
  for (const name of CHANNEL_NAMES) {
    const amount = ret[name];
    if (amount) { operations.push({ op: 'add', target: SHUTTLE_ACCOUNT, channel: CHANNEL_ID[name], amount }); summary.push(`${name}${amount > 0 ? '+' : ''}${amount}`); }
  }
  for (const name of CHANNEL_NAMES) {
    const factor = ret[MULTIPLIER_OF[name]];
    if (factor !== undefined && factor !== 1) { operations.push({ op: 'scale', target: SHUTTLE_ACCOUNT, channel: CHANNEL_ID[name], factor }); summary.push(`${name}×${factor}`); }
  }
  if (ret.convert && ret.convert.amount > 0) {
    operations.push({ op: 'convert', target: SHUTTLE_ACCOUNT, from: CHANNEL_ID[ret.convert.from], to: CHANNEL_ID[ret.convert.to], amount: ret.convert.amount, efficiency: 1 });
    summary.push(`convert ${ret.convert.from}→${ret.convert.to} ${ret.convert.amount}`);
  }
  if (ret.store && ret.store.amount > 0) {
    const channel = CHANNEL_ID[ret.store.from];
    operations.push({ op: 'transfer', from: SHUTTLE_ACCOUNT, to: storeAccountId(owner), fromChannel: channel, toChannel: channel, amount: { kind: 'fixed', value: ret.store.amount } });
    summary.push(`store ${ret.store.from} ${ret.store.amount}`);
  }
  if (ret.release) { operations.push(...releaseOperations(owner)); summary.push('release'); }
  if (ret.steps) { operations.push({ op: 'addVisits', amount: ret.steps }); summary.push(`steps+${ret.steps}`); }
  if (ret.xSteps !== undefined && ret.xSteps !== 1) { operations.push({ op: 'scaleRemainingVisits', factor: ret.xSteps }); summary.push(`steps×${ret.xSteps}`); }
  if (ret.turn) { operations.push({ op: 'turnShuttle' }); summary.push('turn'); }
  return { operations, summary };
}

/** Everything in a card's store back onto the shuttle, with half again on top (C5). */
function releaseOperations(owner: string): OperationDef[] {
  return CHANNEL_NAMES.map(name => ({ op: 'transfer' as const, from: storeAccountId(owner), to: SHUTTLE_ACCOUNT,
    fromChannel: CHANNEL_ID[name], toChannel: CHANNEL_ID[name], amount: { kind: 'all' as const }, gainAsExtra: RELEASE_BONUS }));
}

export interface TripCard {
  id: string;
  spec: CardSpec;
  /** Acts once at departure, on the starting payload, instead of from a cell (environment, like weather). */
  departs: boolean;
}

export class TripCards implements CardRuntime {
  private readonly cards: Map<string, TripCard>;
  private readonly growth: Map<string, GrowthState>;
  /** Relays armed this trip, waiting for the next card that triggers. */
  private pending: Array<{ owner: string; relay: RelayReturn }> = [];

  constructor(cards: readonly TripCard[], growth: Readonly<Record<string, GrowthState>>, private readonly seed: string) {
    this.cards = new Map(cards.map(card => [card.id, card]));
    this.growth = new Map(cards.map(card => [card.id, growth[card.id] ?? initialGrowth()]));
  }

  /** Growth after this trip (trigger levels gained, round bursts spent). Only an accepted round keeps it. */
  finalGrowth(): Record<string, GrowthState> {
    return Object.fromEntries(this.growth);
  }

  depart(shuttle: Readonly<Record<ChannelId, number>>): CardAction[] {
    const actions: CardAction[] = [];
    // Environment cards, like weather, all read the same starting values. What they return is then carried out
    // phase by phase across all of them — every add first, then every multiplier, … (PO 2026-10-09, A) — so which
    // environment happens to come first never changes the trip (a doubling no longer misses an add after it).
    const departing: Array<{ id: string; ret: CardReturn }> = [];
    for (const card of this.cards.values()) {
      if (!card.departs) continue;
      const result = passCard(card.spec, this.values(shuttle, { pass: 0, step: 0, back: false, level: 0, stored: 0 }), `${this.seed}:${card.id}:departure`);
      if (result.triggered) departing.push({ id: card.id, ret: result.ret });
    }
    for (const phase of RETURN_PHASES) {
      for (const { id, ret } of departing) this.carryOut(id, phase(ret), actions);
    }
    for (const { id, ret } of departing) if (ret.relay) this.pending.push({ owner: id, relay: ret.relay });
    // Bursts of levels gained by round growth fire at the first departure after them.
    for (const card of this.cards.values()) {
      const state = this.growth.get(card.id) ?? initialGrowth();
      if (!state.pendingBursts) continue;
      const burst = burstOf(card.spec);
      for (let i = 0; i < state.pendingBursts; i++) if (triggers(burst)) this.carryOut(card.id, burst, actions);
      this.growth.set(card.id, { ...state, pendingBursts: 0 });
    }
    return actions;
  }

  pass(input: CardPassInput): CardPassOutput {
    const card = this.cards.get(input.cardId);
    if (!card) return { actions: [], triggered: false };
    const state = this.growth.get(card.id) ?? initialGrowth();
    const result = passCard(card.spec, this.values(input.shuttle, { pass: input.pass, step: input.step, back: input.entryPort === 'R', level: state.level, stored: input.stored }),
      `${this.seed}:${card.id}:${input.step}`);
    if (!result.triggered) return { actions: [], triggered: false, ...(result.error ? { error: result.error } : {}) };
    const actions: CardAction[] = [];
    // Relays armed earlier in the trip act on the next card whose own return does something (its own relay
    // waits for the card after it); a card that only arms a relay leaves them waiting.
    const { relay: own, ...ret } = result.ret;
    let target: CardReturn = ret, echoes = 0;
    const armedRelays = acts(ret) ? this.pending : [];
    if (armedRelays.length) this.pending = [];
    for (const armed of armedRelays) {
      const outcome = applyRelay(target, armed.relay);
      target = outcome.target;
      if (outcome.echo) echoes++;
      if (outcome.storeIntoRelayCard) {
        const channel = CHANNEL_ID[outcome.storeIntoRelayCard.channel];
        actions.push({ owner: armed.owner, operations: [{ op: 'add', target: storeAccountId(armed.owner), channel, amount: outcome.storeIntoRelayCard.amount }], summary: ['relay store'] });
      }
      if (outcome.releaseRelayCard) actions.push({ owner: armed.owner, operations: releaseOperations(armed.owner), summary: ['relay release'] });
    }
    const { relay: _ignored, ...plain } = target;
    for (let i = 0; i <= echoes; i++) this.carryOut(card.id, plain, actions);
    if (own) this.pending.push({ owner: card.id, relay: own });
    const grown = grow(card.spec.growth, state, 'trigger');
    this.growth.set(card.id, grown.state);
    if (grown.gained) {
      const burst = burstOf(card.spec);
      if (triggers(burst)) this.carryOut(card.id, burst, actions);
    }
    // A pass that only armed a relay acted all the same: the trace says what it did.
    return { actions, triggered: true, ...(!actions.length && own ? { summary: [RELAY_ARMED] } : {}) };
  }

  /** Turn a return into an action; a relay in it is armed for the next triggering card. */
  private carryOut(owner: string, ret: CardReturn, actions: CardAction[]): void {
    const { relay, ...plain } = ret;
    const { operations, summary } = operationsOf(owner, plain);
    if (operations.length) actions.push({ owner, operations, summary });
    if (relay) this.pending.push({ owner, relay });
  }

  private values(shuttle: Readonly<Record<ChannelId, number>>, rest: Omit<PassValues, ChannelName>): PassValues {
    return { push: shuttle[CHANNEL_ID.push] ?? 0, drag: shuttle[CHANNEL_ID.drag] ?? 0, social: shuttle[CHANNEL_ID.social] ?? 0, chance: shuttle[CHANNEL_ID.chance] ?? 0, ...rest };
  }
}
