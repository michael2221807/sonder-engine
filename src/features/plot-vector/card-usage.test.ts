/**
 * Engine card-use rules (charter C3, rebuild plan §3) with a real contract card run by the trip runtime:
 * a card with uses fires on every pass but spends one use per trip, the deduction lands only on commit,
 * a repeated commit changes nothing, and a card with no uses left does not fire.
 */
import { describe, expect, it } from 'vitest';
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../engine/plot-vector/core/session';
import type { RunDone } from '../../engine/plot-vector/core/types';
import { buildSixCellBoard } from './default-board';
import { storeAccount, TripCards } from './contract/trip';
import type { CardSpec } from './contract/types';

const tea: CardSpec = { for: '茶', type: 'item', summary: '每次经过加 1 点机会', onPass: 'return { chance: 1 };' };

function setup(stock: number) {
  const card = { id: 'item:tea', tags: [], label: { zh: '茶', en: 'tea' }, source: 'Model' as const,
    usage: { kind: 'consumable' as const, initialStock: 3, maxStock: 3 }, accounts: [storeAccount('item:tea')] };
  const base = buildSixCellBoard({ topology: 'ring' });
  const board = compileBoard({ ...base, startPayload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, cards: [card],
    cells: base.cells.map(c => ({ ...c, effects: [] })) });
  const session: VectorSession = { ...createSession(), cardStates: { 'item:tea': { stock } } };
  const trip = (s: VectorSession, id: string) => {
    const result = run(board, { id, round: s.round, seed: id, layout: { placements: { '02': 'item:tea' }, tray: [] },
      options: { readout: { kind: 'N1', kappa: 10 } }, cardStates: s.cardStates, carriedAccounts: s.carriedAccounts, visitBudget: 14 },
    { cards: new TripCards([{ id: 'item:tea', spec: tea, departs: false }], {}, id) });
    if (result.status !== 'done') throw new Error(JSON.stringify(result));
    return result as RunDone;
  };
  return { board, session, trip };
}

describe('card use: once per accepted round, never on preview', () => {
  it('several passes over the card in one trip deduct one use; the deduction lands only on commit', () => {
    const h = setup(3);
    const result = h.trip(h.session, 'r1');
    expect(result.visitCounts['02']).toBeGreaterThan(1);
    const applied = result.trace.filter(e => e.owner?.id === 'item:tea' && e.status === 'applied');
    expect(applied.length).toBe(result.visitCounts['02']); // the card acts on every pass
    expect(result.finalState.shuttle.J).toBe(result.visitCounts['02']);
    expect(result.pendingCardStates['item:tea']?.stock).toBe(2);
    expect(h.session.cardStates?.['item:tea']?.stock).toBe(3); // a preview changes nothing
    const committed = commitRun(h.session, h.board, result);
    expect(committed.cardStates?.['item:tea']?.stock).toBe(2);
    expect(commitRun(committed, h.board, result)).toBe(committed); // a repeated commit is a no-op
  });
  it('with no uses left the card does not fire and nothing is deducted', () => {
    const h = setup(0);
    const result = h.trip(h.session, 'r1');
    expect(result.trace.some(e => e.owner?.id === 'item:tea' && e.status === 'applied')).toBe(false);
    expect(result.pendingCardStates['item:tea']?.stock).toBe(0);
  });
});
