/**
 * Basic supply cards through the product runtime (the same prepare/accept the round runs):
 * obtained on enabling, placed like any card, one use per accepted round however often the shuttle
 * passes, previews never deduct, exhausted cards leave the hand and return with the next top-up,
 * and the count survives a save/reload and a repeated or retried accept.
 */
import { describe, expect, it } from 'vitest';
import { acceptVector, initialVectorState, prepareVector, type PreparedVector, type VectorState } from './runtime';
import { BASIC_SUPPLY_IDS, BASIC_SUPPLY_USAGE } from './basic-supply';
import type { NativeInput } from './native-input';

const NATIVE: NativeInput = { ruleId: 'test', payload: { 'S+': 1, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
const EMPTY = { '01': null, '02': null, '03': null, '04': null, '05': null, '06': null };
const prepare = (state: VectorState, id: string) => prepareVector(state, [], id, NATIVE);
const accept = acceptVector;
const uses = (p: PreparedVector | VectorState['last'], id: string) => p?.progress?.find(c => c.cardId === id)?.rows.find(r => r.key === 'uses');
const stock = (s: VectorState, id: string) => s.session.cardStates?.[id]?.stock;

describe('basic supply cards', () => {
  it('are in the hand from the start, marked as local supply, with their starting count shown', () => {
    const first = prepare(initialVectorState(), 'r1');
    expect(first.layout.tray).toEqual([...BASIC_SUPPLY_IDS]);
    const cards = first.board.cards.filter(c => BASIC_SUPPLY_IDS.includes(c.id));
    expect(cards.map(c => c.origin)).toEqual(BASIC_SUPPLY_IDS.map(() => 'supply'));
    expect(cards.every(c => c.source !== 'Model' && c.usage?.kind === 'consumable')).toBe(true);
    expect(uses(first, 'basic:push')).toMatchObject({ value: 2, max: 3 });
  });

  it('a placed card fires on every pass but spends one use; every accepted round tops all of them up by one', () => {
    const state: VectorState = { ...initialVectorState(), layout: { placements: { ...EMPTY, '02': 'basic:push' }, tray: [] } };
    const prepared = prepare(state, 'r1');
    const fired = prepared.result.trace.filter(e => e.owner?.id === 'basic:push' && e.status === 'applied');
    expect(fired.length).toBeGreaterThan(1);
    expect(state.session.cardStates).toBeUndefined(); // a preview never deducts
    const accepted = accept(state, prepared);
    expect(stock(accepted, 'basic:push')).toBe(2);   // 2 − 1 use + 1 top-up
    expect(stock(accepted, 'basic:talk')).toBe(3);   // 2 + 1 top-up, capped at 3
    expect(uses(accepted.last, 'basic:push')).toMatchObject({ value: 2, delta: 0 });
    // A repeated accept (or a retried save from the same state) never grants twice.
    expect(accept(accepted, prepared)).toEqual(accepted);
    expect(accept(state, prepared)).toEqual(accepted);
  });

  it('an exhausted card leaves the hand and its cell, and returns with the next top-up', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 0 } } },
      layout: { placements: { ...EMPTY, '02': 'basic:push' }, tray: [] } };
    const empty = prepare(state, 'r1');
    expect(empty.layout.placements['02']).toBeNull();
    expect(empty.layout.tray).not.toContain('basic:push');
    expect(empty.result.trace.some(e => e.owner?.id === 'basic:push' && e.status === 'applied')).toBe(false);
    const accepted = accept(state, empty);
    expect(stock(accepted, 'basic:push')).toBe(1);
    const next = prepare(accepted, 'r2');
    expect(next.layout.tray).toContain('basic:push');
  });

  it('the count survives a save and reload of the vector state', () => {
    const state: VectorState = { ...initialVectorState(), layout: { placements: { ...EMPTY, '01': 'basic:notice' }, tray: [] } };
    const accepted = accept(state, prepare(state, 'r1'));
    const reloaded = JSON.parse(JSON.stringify(accepted)) as VectorState;
    const next = prepare(reloaded, 'r2');
    expect(uses(next, 'basic:notice')?.value).toBe(stock(accepted, 'basic:notice'));
    expect(stock(accepted, 'basic:notice')).toBeLessThanOrEqual(BASIC_SUPPLY_USAGE.kind === 'consumable' ? BASIC_SUPPLY_USAGE.maxStock : 0);
  });
});
