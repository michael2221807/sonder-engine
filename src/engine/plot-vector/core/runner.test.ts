/**
 * The PO's board rules on the six-cell board, with a stand-in card runtime (rebuild plan §1): the trip
 * folds at the ends of a line and goes round a ring, a turn sends the shuttle back, steps extend the trip
 * within the safety ceiling, the converter acts by direction, resonance scales a card's additions, the
 * status cell runs like any cell, departure actions act before the first step, a failing card drops only
 * its pass, consumable cards spend one use per trip, and stores carry across rounds.
 */
import { describe, expect, it } from 'vitest';
import { compileBoard } from './policies';
import { run, SHUTTLE_ACCOUNT } from './runner';
import { commitRun, COMMITTED_KEPT, createSession } from './session';
import type { AccountDef, BoardDef, CardAction, CardDef, CardPassInput, CardRuntime, OperationDef, RunDone, Settlement } from './types';
import { buildSixCellBoard } from '../../../features/plot-vector/default-board';

const STORE = (id: string): AccountDef => ({ id: `store:${id}`, owner: { kind: 'card', id }, encoding: 'channelVector', persist: 'acrossRounds', cap: 30, lifetimeRounds: 'unbounded' });
const card = (id: string, extra: Partial<CardDef> = {}): CardDef => ({ id, tags: [], label: { zh: id, en: id }, source: 'Model', accounts: [STORE(id)], ...extra });
const add = (channel: string, amount: number): OperationDef => ({ op: 'add', target: SHUTTLE_ACCOUNT, channel, amount });

type Behaviour = (input: CardPassInput) => OperationDef[] | 'throw';
function runtime(behaviours: Record<string, Behaviour>, departure: CardAction[] = []): { cards: CardRuntime; inputs: CardPassInput[] } {
  const inputs: CardPassInput[] = [];
  return { inputs, cards: {
    depart: () => departure,
    pass(input) {
      inputs.push(input);
      const out = behaviours[input.cardId]?.(input) ?? [];
      if (out === 'throw') return { actions: [], triggered: false, error: 'boom' };
      return out.length ? { actions: [{ owner: input.cardId, operations: out, summary: ['x'] }], triggered: true } : { actions: [], triggered: false };
    },
  } };
}
function board(opts: { topology?: 'line' | 'ring'; cards?: CardDef[]; start?: Record<string, number>; noCellRules?: boolean } = {}) {
  const base: BoardDef = buildSixCellBoard({ topology: opts.topology ?? 'line' });
  return compileBoard({ ...base, startPayload: opts.start ?? { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, cards: opts.cards ?? [],
    ...(opts.noCellRules ? { cells: base.cells.map(c => ({ ...c, effects: [] })) } : {}) });
}
function settle(placements: Record<string, string | null>, visitBudget: number, extra: Partial<Settlement> = {}): Settlement {
  return { id: 'r1', round: 1, seed: 'r1', layout: { placements, tray: [] }, options: { readout: { kind: 'N1', kappa: 10 } }, carriedAccounts: {}, visitBudget, ...extra };
}
function done(result: ReturnType<typeof run>): RunDone {
  if (result.status !== 'done') throw new Error(result.reason);
  return result;
}
const path = (r: RunDone) => r.trace.filter(e => e.eventType === 'visit').map(e => e.cellId).join(' ');
const shuttle = (r: RunDone) => r.finalState.shuttle;

describe('the trip over the six-cell board', () => {
  it('a line folds at both ends; a ring goes round', () => {
    expect(path(done(run(board(), settle({}, 9))))).toBe('01 02 03 04 05 06 05 04 03');
    expect(path(done(run(board({ topology: 'ring' }), settle({}, 8))))).toBe('01 02 03 04 05 06 01 02');
    const fold = done(run(board(), settle({}, 7))).trace.find(e => e.eventType === 'route' && e.cellId === '06');
    expect(fold?.reasonCode).toBe('foldedAtEndpoint');
  });
  it('a turn sends the shuttle back the way it came; at the start there is no way back', () => {
    const cards = [card('c')];
    expect(path(done(run(board({ cards }), settle({ '03': 'c' }, 6), runtime({ c: () => [{ op: 'turnShuttle' }] }))))).toBe('01 02 03 02 01 02');
    const atStart = done(run(board({ cards }), settle({ '01': 'c' }, 3), runtime({ c: i => (i.pass === 1 ? [{ op: 'turnShuttle' }] : []) })));
    expect(path(atStart)).toBe('01 02 03');
    expect(atStart.trace.find(e => e.eventType === 'route')?.reasonCode).toBe('turnImpossibleHere');
  });
  it('steps extend the trip, within the safety ceiling; remaining steps can be multiplied', () => {
    const cards = [card('c')];
    const plus = done(run(board({ cards }), settle({ '01': 'c' }, 2), runtime({ c: i => (i.pass === 1 ? [{ op: 'addVisits', amount: 3 }] : []) })));
    expect(plus.visits).toBe(5);
    const ceiling = done(run(board({ cards }), settle({ '01': 'c' }, 2), runtime({ c: () => [{ op: 'addVisits', amount: 50 }] })));
    expect(ceiling.visits).toBe(60);
    const doubled = done(run(board({ cards }), settle({ '02': 'c' }, 4), runtime({ c: i => (i.pass === 1 ? [{ op: 'scaleRemainingVisits', factor: 2 }] : []) })));
    expect(doubled.visits).toBe(6); // two steps were left when it acted on step 2
  });
  it('the converter cell turns half the push into relations going forward, half the relations into chances going back', () => {
    const forward = done(run(board({ start: { 'S+': 8, 'S-': 0, Y: 0, J: 0 } }), settle({}, 3)));
    expect(shuttle(forward)).toMatchObject({ 'S+': 4, Y: 4, J: 0 });
    const back = done(run(board({ start: { 'S+': 8, 'S-': 0, Y: 0, J: 0 } }), settle({}, 9)));
    expect(back.trace.filter(e => e.effectId === '03:convert-reverse' && e.status === 'applied')).toHaveLength(1);
    expect(shuttle(back)).toMatchObject({ 'S+': 4, Y: 2, J: 2 });
  });
  it('resonance: a card adds 25% more for the neighbouring resonance cell that also holds a card', () => {
    const cards = [card('a'), card('b')];
    const both = done(run(board({ cards, noCellRules: false }), settle({ '01': 'a', '02': 'b' }, 1), runtime({ a: () => [add('J', 4)] })));
    expect(shuttle(both).J).toBe(5);
    const alone = done(run(board({ cards }), settle({ '01': 'a' }, 1), runtime({ a: () => [add('J', 4)] })));
    expect(shuttle(alone).J).toBe(4);
  });
  it('feeds each card its pass number, the trip step, the direction and the live shuttle', () => {
    const rt = runtime({ c: () => [add('Y', 1)] });
    done(run(board({ cards: [card('c')] }), settle({ '05': 'c' }, 9), rt));
    expect(rt.inputs.map(i => [i.pass, i.step, i.entryPort])).toEqual([[1, 5, 'L'], [2, 7, 'R']]);
    expect(rt.inputs[1].shuttle.Y).toBe(1);
  });
  it('the status cell runs its card like any other cell', () => {
    const r = done(run(board({ cards: [card('s')] }), settle({ '06': 's' }, 6), runtime({ s: () => [add('S-', 2)] })));
    expect(shuttle(r)['S-']).toBe(2);
  });
  it('departure actions act on the starting payload and trip before the first step; a turn there is ignored', () => {
    const r = done(run(board({ cards: [card('rain')], noCellRules: true, start: { 'S+': 10, 'S-': 0, Y: 0, J: 0 } }), settle({}, 2),
      runtime({}, [{ owner: 'rain', operations: [{ op: 'scale', target: SHUTTLE_ACCOUNT, channel: 'S+', factor: 0.8 }, { op: 'addVisits', amount: 1 }, { op: 'turnShuttle' }], summary: ['rain'] }])));
    expect(shuttle(r)['S+']).toBe(8);
    expect(r.visits).toBe(3);
    expect(path(r)).toBe('01 02 03');
    expect(r.trace[0].eventType).toBe('departure');
  });
  it('a card whose code fails drops only that pass; the trip goes on', () => {
    const r = done(run(board({ cards: [card('bad'), card('good')], noCellRules: true }), settle({ '01': 'bad', '02': 'good' }, 2),
      runtime({ bad: () => 'throw', good: () => [add('J', 1)] })));
    expect(r.trace.find(e => e.owner?.id === 'bad')).toMatchObject({ status: 'notTriggered', reasonCode: 'cardError' });
    expect(shuttle(r).J).toBe(1);
  });
  it('a consumable card spends one use per trip however often it acts, and does not run without uses', () => {
    const supply = card('supply', { usage: { kind: 'consumable', initialStock: 2, maxStock: 3 } });
    const r = done(run(board({ topology: 'ring', cards: [supply], noCellRules: true }), settle({ '01': 'supply' }, 13), runtime({ supply: () => [add('J', 1)] })));
    expect(shuttle(r).J).toBe(3);
    expect(r.pendingCardStates.supply.stock).toBe(1);
    const empty = done(run(board({ topology: 'ring', cards: [supply], noCellRules: true }), settle({ '01': 'supply' }, 7, { cardStates: { supply: { stock: 0 } } }), runtime({ supply: () => [add('J', 1)] })));
    expect(shuttle(empty).J).toBe(0);
    expect(empty.trace.find(e => e.owner?.id === 'supply')?.reasonCode).toBe('noUses');
  });
  it('a store keeps what fits (the rest stays on the shuttle), carries across rounds and releases with half again on top', () => {
    const b = board({ cards: [card('jar')], noCellRules: true, start: { 'S+': 40, 'S-': 0, Y: 0, J: 0 } });
    const storeAll: OperationDef = { op: 'transfer', from: SHUTTLE_ACCOUNT, to: 'store:jar', fromChannel: 'S+', toChannel: 'S+', amount: { kind: 'fixed', value: 40 } };
    const first = done(run(b, settle({ '01': 'jar' }, 1), runtime({ jar: () => [storeAll] })));
    expect(first.finalState.accounts['store:jar'].total).toBe(30);
    expect(shuttle(first)['S+']).toBe(10);
    const session = commitRun(createSession(), b, first);
    const release: OperationDef = { op: 'transfer', from: 'store:jar', to: SHUTTLE_ACCOUNT, fromChannel: 'S+', toChannel: 'S+', amount: { kind: 'all' }, gainAsExtra: 0.5 };
    const second = done(run(compileBoard({ ...b, startPayload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 } }),
      settle({ '01': 'jar' }, 1, { id: 'r2', round: session.round, carriedAccounts: session.carriedAccounts }), runtime({ jar: () => [release] })));
    expect(shuttle(second)['S+']).toBe(45);
    expect(second.finalState.accounts['store:jar'].total).toBe(0);
  });
  it('an operation on an account the board does not have is skipped, never failing the trip', () => {
    const r = done(run(board({ cards: [card('c')] }), settle({ '01': 'c' }, 1), runtime({ c: () => [{ op: 'add', target: 'nowhere', channel: 'J', amount: 1 }, add('J', 2)] })));
    expect(shuttle(r).J).toBe(2);
  });
  it('the N1 readout is tanh(net / κ) of the final payload, per dimension', () => {
    const r = done(run(board({ start: { 'S+': 10, 'S-': 5, Y: 3, J: 0 }, noCellRules: true }), settle({}, 0)));
    expect(r.visits).toBe(0);
    expect(r.vectorPacket.dimensions.S).toBeCloseTo(Math.tanh(5 / 10));
    expect(r.vectorPacket.dimensions.Y).toBeCloseTo(Math.tanh(3 / 10));
    expect(r.vectorPacket.dimensions.J).toBe(0);
  });
  it('a repeated commit of the same trip changes nothing', () => {
    const b = board();
    const r = done(run(b, settle({}, 3)));
    const once = commitRun(createSession(), b, r);
    expect(commitRun(once, b, r)).toBe(once);
    expect(once.round).toBe(2);
  });
  it('keeps only the most recent committed ids, and a retry of a recent round is still a no-op', () => {
    const b = board();
    let session = createSession();
    for (let i = 0; i < COMMITTED_KEPT + 6; i++) session = commitRun(session, b, done(run(b, settle({}, 1, { id: `r${i}` }))));
    expect(session.committed).toHaveLength(COMMITTED_KEPT);
    expect(session.round).toBe(COMMITTED_KEPT + 7);
    const recent = done(run(b, settle({}, 1, { id: `r${COMMITTED_KEPT + 5}` })));
    expect(commitRun(session, b, recent)).toBe(session);
  });
});
