/**
 * One trip's card runtime (rebuild plan §2.4/§2.5, phase 2 decisions): relays between cards in every
 * variant, echo, environment cards at departure, round bursts at the next departure, and the five growth
 * scenarios the plan names — the diary, the growing talent, turning on every level, releasing when enough
 * is stored, and a worsening status — on their own and on the real six-cell board.
 */
import { describe, expect, it } from 'vitest';
import { compileBoard } from '../../../engine/plot-vector/core/policies';
import { run, SHUTTLE_ACCOUNT } from '../../../engine/plot-vector/core/runner';
import type { CardAction, CardDef, CardPassInput, ChannelId, RunDone } from '../../../engine/plot-vector/core/types';
import { buildSixCellBoard } from '../default-board';
import { POSITIVE_EXAMPLES } from '../genesis/test-fixtures';
import { growAtRound, initialGrowth } from './growth';
import { storeAccount, storeAccountId, TripCards, type TripCard } from './trip';
import type { CardSpec, GrowthSpec, GrowthState } from './types';

const ZERO: Record<ChannelId, number> = { 'S+': 0, 'S-': 0, Y: 0, J: 0 };
const spec = (onPass: string, growth?: GrowthSpec, type: CardSpec['type'] = 'item'): CardSpec => ({ for: 'x', type, summary: 's', onPass, ...(growth ? { growth } : {}) });
const trip = (cards: Record<string, CardSpec>, growth: Record<string, GrowthState> = {}, departing: string[] = []) =>
  new TripCards(Object.entries(cards).map(([id, s]): TripCard => ({ id, spec: s, departs: departing.includes(id) })), growth, 'seed');
let step = 0;
const input = (cardId: string, extra: Partial<CardPassInput> = {}): CardPassInput =>
  ({ cardId, cellId: '01', entryPort: 'L', pass: 1, step: ++step, shuttle: ZERO, stored: 0, ...extra });
/** Everything a list of actions adds to (or scales on) the shuttle, per channel, in order. */
const ops = (actions: CardAction[]) => actions.flatMap(a => a.operations.map(op => ({ owner: a.owner, ...op })));
const added = (actions: CardAction[], channel: ChannelId) => ops(actions).filter(o => o.op === 'add' && o.target === SHUTTLE_ACCOUNT && o.channel === channel).reduce((n, o) => n + (o.op === 'add' ? o.amount : 0), 0);

describe('relays between cards', () => {
  it('a pass that only arms a relay acts and says so; a return a relay cancels to nothing does not act (PO 2026-10-10)', () => {
    const t = trip({ a: spec('return { relay: { xPush: 0 } };'), b: spec('return { push: 2 };') });
    expect(t.pass(input('a'))).toEqual({ actions: [], triggered: true, summary: ['armed relay'] });
    expect(t.pass(input('b'))).toEqual({ actions: [], triggered: false });
  });
  it('amounts add to what the next acting card produces; the relay is then used up', () => {
    const t = trip({ a: spec('return { relay: { push: 3 } };'), b: spec('return { social: 2 };') });
    expect(t.pass(input('a')).triggered).toBe(true); // arming a relay counts as triggering
    const first = t.pass(input('b'));
    expect([added(first.actions, 'S+'), added(first.actions, 'Y')]).toEqual([3, 2]);
    expect(added(t.pass(input('b')).actions, 'S+')).toBe(0);
  });
  it('a multiplier scales what the next card produces', () => {
    const t = trip({ a: spec('return { relay: { xSocial: 2 } };'), b: spec('return { social: 2 };') });
    t.pass(input('a'));
    expect(added(t.pass(input('b')).actions, 'Y')).toBe(4);
  });
  it('a convert moves between the next card\'s outputs, never more than it produced', () => {
    const t = trip({ a: spec('return { relay: { convert: { from: "social", to: "chance", amount: 5 } } };'), b: spec('return { social: 2 };') });
    t.pass(input('a'));
    const out = t.pass(input('b')).actions;
    expect([added(out, 'Y'), added(out, 'J')]).toEqual([0, 2]);
  });
  it('a store keeps part of the next card\'s output in the relaying card\'s own store', () => {
    const t = trip({ a: spec('return { relay: { store: { from: "social", amount: 1 } } };'), b: spec('return { social: 3 };') });
    t.pass(input('a'));
    const out = ops(t.pass(input('b')).actions);
    expect(out).toContainEqual(expect.objectContaining({ owner: 'a', op: 'add', target: storeAccountId('a'), channel: 'Y', amount: 1 }));
    expect(out.filter(o => o.op === 'add' && o.target === SHUTTLE_ACCOUNT)).toEqual([expect.objectContaining({ owner: 'b', channel: 'Y', amount: 2 })]);
  });
  it('a release empties the relaying card\'s store at the moment the next card acts', () => {
    const t = trip({ a: spec('return { relay: { release: 1 } };'), b: spec('return { chance: 1 };') });
    t.pass(input('a'));
    const out = ops(t.pass(input('b')).actions);
    expect(out.filter(o => o.owner === 'a' && o.op === 'transfer')).toHaveLength(4);
    expect(out.find(o => o.owner === 'a')).toMatchObject({ from: storeAccountId('a'), to: SHUTTLE_ACCOUNT, amount: { kind: 'all' }, gainAsExtra: 0.5 });
  });
  it('echo carries the next card\'s return out once more (再来一次), steps and turn included', () => {
    const t = trip({ a: spec('return { relay: { echo: 1 } };'), b: spec('return { chance: 2, steps: 1 };') });
    t.pass(input('a'));
    const out = t.pass(input('b')).actions;
    expect(added(out, 'J')).toBe(4);
    expect(ops(out).filter(o => o.op === 'addVisits')).toHaveLength(2);
  });
  it('steps, remaining-step factors and a turn add onto the next card', () => {
    const t = trip({ a: spec('return { relay: { steps: 2, xSteps: 2, turn: 1 } };'), b: spec('return { chance: 1, xSteps: 1.5 };') });
    t.pass(input('a'));
    const out = ops(t.pass(input('b')).actions);
    expect(out).toContainEqual(expect.objectContaining({ op: 'addVisits', amount: 2 }));
    expect(out).toContainEqual(expect.objectContaining({ op: 'scaleRemainingVisits', factor: 3 }));
    expect(out).toContainEqual(expect.objectContaining({ op: 'turnShuttle' }));
  });
  it('a card that only arms a relay, or does nothing, leaves waiting relays for the card after it', () => {
    const t = trip({ a: spec('return { relay: { push: 1 } };'), idle: spec('return {};'), c: spec('return { relay: { push: 2 } };'), b: spec('return { social: 1 };') });
    t.pass(input('a'));
    expect(t.pass(input('idle')).triggered).toBe(false);
    t.pass(input('c'));
    expect(added(t.pass(input('b')).actions, 'S+')).toBe(3);
  });
  it('a card\'s own relay waits for the card after it, even when the card itself acts', () => {
    const t = trip({ a: spec('return { chance: 1, relay: { chance: 5 } };'), b: spec('return { social: 1 };') });
    expect(added(t.pass(input('a')).actions, 'J')).toBe(1);
    expect(added(t.pass(input('b')).actions, 'J')).toBe(5);
  });
  it('a relay armed in one trip is gone in the next', () => {
    const cards = { a: spec('return { relay: { push: 3 } };'), b: spec('return { social: 2 };') };
    trip(cards).pass(input('a'));
    expect(added(trip(cards).pass(input('b')).actions, 'S+')).toBe(0);
  });
});

describe('what a card reads and what fails', () => {
  it('reads the live channels, pass, step, direction, level and store', () => {
    const read = (expr: string, extra: Partial<CardPassInput>, growth?: Record<string, GrowthState>) =>
      added(trip({ a: spec(`return { chance: ${expr} };`) }, growth).pass(input('a', extra)).actions, 'J');
    expect(read('ctx.push', { shuttle: { ...ZERO, 'S+': 3 } })).toBe(3);
    expect(read('ctx.drag', { shuttle: { ...ZERO, 'S-': 4 } })).toBe(4);
    expect(read('ctx.social', { shuttle: { ...ZERO, Y: 5 } })).toBe(5);
    expect(read('ctx.chance', { shuttle: { ...ZERO, J: 6 } })).toBe(6);
    expect(read('ctx.pass', { pass: 2 })).toBe(2);
    expect(read('ctx.step', { step: 7 })).toBe(7);
    expect(read('ctx.back ? 1 : 2', { entryPort: 'R' })).toBe(1);
    expect(read('ctx.back ? 1 : 2', { entryPort: 'L' })).toBe(2);
    expect(read('ctx.stored', { stored: 9 })).toBe(9);
    expect(read('ctx.level', {}, { a: { level: 3, progress: 0, pendingBursts: 0 } })).toBe(3);
    // Returns stay inside the safety limit of ±50.
    expect(read('ctx.step * 100', { step: 7 })).toBe(50);
  });
  it('code that throws drops this pass only and reports why', () => {
    const t = trip({ a: spec('if (ctx.pass === 1) return ctx.rng.push.push; return { chance: 1 };') });
    const first = t.pass(input('a'));
    expect(first).toMatchObject({ triggered: false, actions: [] });
    expect(first.error).toContain('push');
    expect(added(t.pass(input('a', { pass: 2 })).actions, 'J')).toBe(1);
  });
  it('the same seed and step give the same random draw', () => {
    const card = { a: spec('return { chance: ctx.rng() < 0.5 ? 1 : 2 };') };
    const draw = () => added(trip(card).pass(input('a', { step: 3 })).actions, 'J');
    expect(draw()).toBe(draw());
  });
});

describe('environment cards act like weather, once at departure', () => {
  it('several act phase by phase — every add, then every multiplier — whichever comes first (PO 2026-10-09, A)', () => {
    const cards = { double: spec('return { xDrag: 2, xPush: 0.7 };', undefined, 'environment'), heap: spec('return { drag: 3, chance: 8 };', undefined, 'environment') };
    for (const order of [['double', 'heap'], ['heap', 'double']]) {
      const t = new TripCards(order.map((id): TripCard => ({ id, spec: cards[id as keyof typeof cards], departs: true })), {}, 'seed');
      const done = ops(t.depart({ ...ZERO, 'S+': 1.3 }));
      expect(done.map(o => o.op)).toEqual(['add', 'add', 'scale', 'scale']);
      expect(done.map(o => o.owner)).toEqual(['heap', 'heap', 'double', 'double']);
    }
  });
  it('act on the starting payload with pass and step 0, and never from a cell', () => {
    const t = trip({ rain: spec('return ctx.pass === 0 && ctx.step === 0 ? { xPush: 0.8, steps: 1 } : { chance: 9 };', undefined, 'environment') }, {}, ['rain']);
    const out = ops(t.depart({ ...ZERO, 'S+': 10 }));
    expect(out).toEqual([expect.objectContaining({ op: 'scale', channel: 'S+', factor: 0.8 }), expect.objectContaining({ op: 'addVisits', amount: 1 })]);
  });
  it('on the board: rain takes a fifth of the starting push before the first step', () => {
    const r = tripOnBoard({ cards: { rain: spec('return { xPush: 0.8 };', undefined, 'environment') }, departing: ['rain'], placements: {}, visits: 1, start: { 'S+': 10 } });
    expect(r.result.finalState.shuttle['S+']).toBe(8);
  });
});

describe('the five growth scenarios', () => {
  it('日记本 — grows every round whether or not it is placed; each page adds a chance', () => {
    const notebook = POSITIVE_EXAMPLES[2].card;
    let state = initialGrowth();
    for (let round = 0; round < 3; round++) state = growAtRound(notebook.growth, state, round === 1);
    expect(state.level).toBe(3);
    // `ctx.level` feeds its own code (1 + level) — there is no `add`, so the level counts once.
    const out = trip({ notebook }, { notebook: { ...state, pendingBursts: 0 } }).pass(input('notebook'));
    expect(added(out.actions, 'J')).toBe(4);
  });
  it('成长天赋 — every second trigger is a level; each level adds 1 push, up to its max', () => {
    const talent = spec('return { push: 2 };', { on: 'trigger', every: 2, max: 2, add: { push: 1 } }, 'talent');
    const t = trip({ talent });
    const pushes = Array.from({ length: 6 }, (_, i) => added(t.pass(input('talent', { pass: i + 1 })).actions, 'S+'));
    expect(pushes).toEqual([2, 2, 3, 3, 4, 4]);
    expect(t.finalGrowth().talent).toMatchObject({ level: 2 });
  });
  it('每成长一次调头 — the pass that gains a level also turns the shuttle', () => {
    const compass = spec('return { chance: 1 };', { on: 'trigger', every: 2, max: 10, burst: { turn: 1 } });
    const t = trip({ compass });
    expect(ops(t.pass(input('compass')).actions).some(o => o.op === 'turnShuttle')).toBe(false);
    expect(ops(t.pass(input('compass')).actions).some(o => o.op === 'turnShuttle')).toBe(true);
    // On the ring the card at 02 is passed on steps 2 and 8; the second pass levels up and turns back.
    const r = tripOnBoard({ cards: { compass }, placements: { '02': 'compass' }, visits: 10, topology: 'ring' });
    expect(r.path).toBe('01 02 03 04 05 06 01 02 01 06');
  });
  it('攒够自动放 — stores 5 push each pass; every third pass levels up and releases it all with half again', () => {
    const jar = spec('return { store: { from: "push", amount: 5 } };', { on: 'trigger', every: 3, max: 50, burst: { release: 1 } });
    const r = tripOnBoard({ cards: { jar }, placements: { '01': 'jar' }, visits: 13, topology: 'ring', start: { 'S+': 20 } });
    expect(r.result.finalState.accounts[storeAccountId('jar')].total).toBe(0);
    expect(r.result.finalState.shuttle['S+']).toBe(27.5); // 20 − 15 stored + 15 × 1.5 released
    expect(r.growth.jar).toMatchObject({ level: 1, progress: 0 });
  });
  it('攒够自动放 (written in code) — reads its own store and releases once it holds enough', () => {
    const jar = spec('return ctx.stored >= 10 ? { release: 1 } : { store: { from: "push", amount: 5 } };');
    const r = tripOnBoard({ cards: { jar }, placements: { '01': 'jar' }, visits: 13, topology: 'ring', start: { 'S+': 20 } });
    expect(r.result.finalState.shuttle['S+']).toBe(25); // 20 − 10 stored + 10 × 1.5 released
  });
  it('状态恶化 — a status grows only in rounds it is on the board; the drag it adds grows with it', () => {
    const wound = spec('return { drag: 2 };', { on: 'placedRound', every: 1, max: 5, add: { drag: 1 } }, 'status');
    let state = initialGrowth();
    state = growAtRound(wound.growth, state, true);
    state = growAtRound(wound.growth, state, false);
    state = growAtRound(wound.growth, state, true);
    expect(state.level).toBe(2);
    const r = tripOnBoard({ cards: { wound }, placements: { '06': 'wound' }, visits: 6, growth: { wound: { ...state, pendingBursts: 0 } } });
    expect(r.result.finalState.shuttle['S-']).toBe(4);
    for (let i = 0; i < 10; i++) state = growAtRound(wound.growth, state, true);
    expect(state.level).toBe(5);
  });
});

describe('round growth bursts wait for the next departure', () => {
  it('fire once per level gained at departure, then are spent', () => {
    const bell = spec('return {};', { on: 'round', every: 1, max: 10, burst: { chance: 2 } });
    const state = growAtRound(bell.growth, growAtRound(bell.growth, initialGrowth(), false), false);
    expect(state.pendingBursts).toBe(2);
    const t = trip({ bell }, { bell: state });
    expect(added(t.depart(ZERO), 'J')).toBe(4);
    expect(t.finalGrowth().bell.pendingBursts).toBe(0);
    expect(added(t.depart(ZERO), 'J')).toBe(0);
  });
});

function tripOnBoard(opts: { cards: Record<string, CardSpec>; placements: Record<string, string>; visits: number; departing?: string[];
  topology?: 'line' | 'ring'; start?: Partial<Record<ChannelId, number>>; growth?: Record<string, GrowthState> }) {
  const base = buildSixCellBoard({ topology: opts.topology ?? 'line' });
  const defs: CardDef[] = Object.keys(opts.cards).map(id => ({ id, tags: [], label: { zh: id, en: id }, source: 'Model', accounts: [storeAccount(id)] }));
  const board = compileBoard({ ...base, cells: base.cells.map(c => ({ ...c, effects: [] })), cards: defs, startPayload: { ...ZERO, ...opts.start } as Record<ChannelId, number> });
  const cards = trip(opts.cards, opts.growth, opts.departing);
  const result = run(board, { id: 't', round: 1, seed: 't', layout: { placements: opts.placements, tray: [] }, options: { readout: { kind: 'N1', kappa: 10 } }, carriedAccounts: {}, visitBudget: opts.visits }, { cards });
  if (result.status !== 'done') throw new Error(result.reason);
  const done: RunDone = result;
  return { result: done, growth: cards.finalGrowth(), path: done.trace.filter(e => e.eventType === 'visit').map(e => e.cellId).join(' ') };
}
