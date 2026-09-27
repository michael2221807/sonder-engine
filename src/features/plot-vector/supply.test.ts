/**
 * General supply through the product runtime (the same prepare/accept the round runs; phase 6, PO 1C 2A 3A 4A
 * 5A): the pack pool is rated into four tiers, the opening hand is the pack's starter, a placed card spends one
 * use per accepted round, an exhausted card leaves and the hand draws one card while it has room, strong cards
 * are one-shot, recharge cards wait for their next use, and older saves keep their counts.
 */
import { describe, expect, it } from 'vitest';
import vectorRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { acceptVector, initialVectorState, prepareVector, readVectorState, type PreparedVector, type VectorState } from './runtime';
import { drawSupplyCard, parseSupplyRules, supplyRatings, usesOf, type SupplyRules } from './supply';
import { CARD_TIERS, type CardTier } from './rating';
import type { NativeInput } from './native-input';

const SUPPLY = parseSupplyRules(vectorRules)!;
const NATIVE: NativeInput = { ruleId: 'test', payload: { 'S+': 1, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
const EMPTY = { '01': null, '02': null, '03': null, '04': null, '05': null, '06': null };
const prepare = (state: VectorState, id: string, rules: SupplyRules = SUPPLY) => prepareVector(state, [], id, NATIVE, rules);
const accept = (state: VectorState, prepared: PreparedVector, rules: SupplyRules = SUPPLY) => acceptVector(state, prepared, rules);
const uses = (p: PreparedVector | VectorState['last'], id: string) => p?.progress?.find(c => c.cardId === id)?.rows.find(r => r.key === 'uses');
const stock = (s: VectorState, id: string) => s.session.cardStates?.[id]?.stock;
const handIds = (s: VectorState) => s.supply?.hand.map(c => c.id) ?? [];

describe('the pack pool', () => {
  it('parses every card, keeps the starter, and leaves out a broken card or section', () => {
    expect(SUPPLY.cards.length).toBe(vectorRules.supply.cards.length);
    expect(SUPPLY.starter).toEqual(['basic:push', 'basic:talk', 'basic:notice']);
    const bad = { id: 'bad', name: { zh: '坏', en: 'Bad' }, summary: { zh: 's', en: 's' }, onPass: 'return ctx["x"];' };
    expect(parseSupplyRules({ supply: { ...vectorRules.supply, cards: [...vectorRules.supply.cards, bad] } })!.cards.map(c => c.id)).not.toContain('bad');
    expect(parseSupplyRules({ supply: { ...vectorRules.supply, hand: 0 } })).toBeUndefined();
    expect(parseSupplyRules({})).toBeUndefined();
  });
  it('is rated into all four tiers; strong cards are one-shot and uses follow the tier (4A)', () => {
    const ratings = supplyRatings(SUPPLY);
    const tiers = new Set([...ratings.values()].map(r => r.tier));
    expect([...CARD_TIERS].every(t => tiers.has(t))).toBe(true);
    for (const card of SUPPLY.cards) {
      const tier = ratings.get(card.id)!.tier;
      expect(usesOf(SUPPLY, card.id)).toBe(SUPPLY.usesByTier[tier]);
      if (tier === 'rare' || tier === 'legendary') expect(usesOf(SUPPLY, card.id)).toBe(1);
    }
  });
  it('draws are reproducible and follow the tier weights (3A)', () => {
    expect(drawSupplyCard(SUPPLY, 'seed-1')?.id).toBe(drawSupplyCard(SUPPLY, 'seed-1')?.id);
    const ratings = supplyRatings(SUPPLY);
    const counts: Record<CardTier, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    const n = 4000;
    for (let i = 0; i < n; i++) counts[ratings.get(drawSupplyCard(SUPPLY, `s${i}`)!.id)!.tier]++;
    const total = Object.values(SUPPLY.tierWeights).reduce((a, b) => a + b, 0);
    for (const tier of CARD_TIERS) expect(Math.abs(counts[tier] / n - SUPPLY.tierWeights[tier] / total)).toBeLessThan(0.03);
  });
});

describe('the supply hand', () => {
  it('opens with the pack starter, marked as supply, with its uses shown', () => {
    const first = prepare(initialVectorState(), 'r1');
    expect(first.layout.tray).toEqual(SUPPLY.starter);
    const cards = first.board.cards.filter(c => SUPPLY.starter.includes(c.id));
    expect(cards.every(c => c.origin === 'supply' && c.source !== 'Model' && c.usage?.kind === 'consumable')).toBe(true);
    expect(uses(first, 'basic:push')).toMatchObject({ value: 3, max: 3 });
  });

  it('a placed card fires on every pass but spends one use per accepted round; nothing is topped up', () => {
    const state: VectorState = { ...initialVectorState(), layout: { placements: { ...EMPTY, '02': 'basic:push' }, tray: [] } };
    const prepared = prepare(state, 'r1');
    expect(prepared.result.trace.filter(e => e.owner?.id === 'basic:push' && e.status === 'applied').length).toBeGreaterThan(1);
    expect(state.session.cardStates).toBeUndefined(); // a preview never deducts
    const accepted = accept(state, prepared);
    expect(stock(accepted, 'basic:push')).toBe(2);
    expect(stock(accepted, 'basic:talk') ?? 3).toBe(3);
    expect(uses(accepted.last, 'basic:push')).toMatchObject({ value: 2, delta: -1 });
    expect(handIds(accepted)).toEqual(SUPPLY.starter);   // a full hand draws nothing
    // A repeated accept (or a retried save from the same state) changes nothing.
    expect(accept(accepted, prepared)).toEqual(accepted);
    expect(accept(state, prepared)).toEqual(accepted);
  });

  it('an exhausted card leaves the hand, and the hand draws one card to fill its place', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 } } },
      layout: { placements: { ...EMPTY, '02': 'basic:push' }, tray: [] } };
    const accepted = accept(state, prepare(state, 'r1'));
    expect(handIds(accepted)).not.toContain('basic:push');
    expect(accepted.session.cardStates?.['basic:push']).toBeUndefined();
    expect(accepted.supply?.hand).toHaveLength(3);
    const drawn = accepted.supply!.lastDrawn!;
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatch(/#1$/);
    const next = prepare(accepted, 'r2');
    expect(next.layout.tray).toContain(drawn[0]);
    expect(uses(next, drawn[0])?.value).toBe(usesOf(SUPPLY, accepted.supply!.hand.find(c => c.id === drawn[0])!.cardId));
    // Nothing is placed for the player: the new card waits in the tray.
    expect(Object.values(next.layout.placements)).not.toContain(drawn[0]);
  });

  it('draws at most one card per round and never beyond the hand limit', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 }, 'basic:talk': { stock: 1 } } },
      layout: { placements: { ...EMPTY, '01': 'basic:push', '03': 'basic:talk' }, tray: [] } };
    const once = accept(state, prepare(state, 'r1'));
    expect(once.supply?.hand).toHaveLength(2);   // two left, one drawn
    const twice = accept(once, prepare(once, 'r2'));
    expect(twice.supply?.hand).toHaveLength(3);
    const thrice = accept(twice, prepare(twice, 'r3'));
    expect(thrice.supply?.hand).toHaveLength(3);
  });

  it('a recharge card waits at no uses and regains one every two rounds, never above its uses (5A)', () => {
    const rhythm = SUPPLY.cards.find(c => c.id === 'supply:rhythm')!;
    expect(rhythm.recharge).toEqual({ on: 'round', every: 2 });
    const max = usesOf(SUPPLY, rhythm.id);
    let state: VectorState = { ...initialVectorState(), supply: { hand: [{ id: 'supply:rhythm#1', cardId: 'supply:rhythm', recharge: 0 }], drawn: 1 },
      session: { ...initialVectorState().session, cardStates: { 'supply:rhythm#1': { stock: 0 } } } };
    const idle = prepare(state, 'r1');
    expect(idle.layout.tray).not.toContain('supply:rhythm#1');   // no use left: not placeable
    state = accept(state, idle);
    expect(handIds(state)).toContain('supply:rhythm#1');         // but it stays in the hand
    expect(stock(state, 'supply:rhythm#1')).toBe(0);
    state = accept(state, prepare(state, 'r2'));
    expect(stock(state, 'supply:rhythm#1')).toBe(1);
    for (let r = 3; r < 12; r++) state = accept(state, prepare(state, `r${r}`));
    expect(stock(state, 'supply:rhythm#1')).toBe(max);
  });

  it('a trigger recharge counts the passes it acted on', () => {
    const habit = SUPPLY.cards.find(c => c.id === 'supply:habit')!;
    expect(habit.recharge).toEqual({ on: 'trigger', every: 4 });
    // Three passes already counted from earlier rounds; this round adds its own.
    const state: VectorState = { ...initialVectorState(), supply: { hand: [{ id: 'supply:habit#1', cardId: 'supply:habit', recharge: 3 }], drawn: 1 },
      session: { ...initialVectorState().session, cardStates: { 'supply:habit#1': { stock: 1 } } },
      layout: { placements: { ...EMPTY, '03': 'supply:habit#1' }, tray: [] } };
    const prepared = prepare(state, 'r1');
    const passes = new Set(prepared.result.trace.filter(e => e.owner?.id === 'supply:habit#1' && e.status === 'applied').map(e => e.visitId)).size;
    expect(passes).toBeGreaterThan(0);
    const accepted = accept(state, prepared);
    // One use spent this round, and one regained for every four passes counted (never above its uses): 1 − 1 + 1.
    const progress = 3 + passes;
    expect(stock(accepted, 'supply:habit#1')).toBe(Math.min(usesOf(SUPPLY, 'supply:habit'), Math.floor(progress / 4)));
    expect(handIds(accepted)).toContain('supply:habit#1');
    expect(accepted.supply?.hand.find(c => c.id === 'supply:habit#1')?.recharge).toBe(progress % 4);
  });

  it('an older save keeps its counts: no supply state means the starter hand with the saved uses', () => {
    const old = readVectorState({ ...initialVectorState(), session: { ...initialVectorState().session, cardStates: { 'basic:talk': { stock: 1 } } } });
    expect(old.supply).toBeUndefined();
    const first = prepare(old, 'r1');
    expect(first.layout.tray).toEqual(SUPPLY.starter);
    expect(uses(first, 'basic:talk')?.value).toBe(1);
  });

  it('a reload never brings back the last draw (its notice is not repeated)', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 } } },
      layout: { placements: { ...EMPTY, '01': 'basic:push' }, tray: [] } };
    const accepted = accept(state, prepare(state, 'r1'));
    expect(accepted.supply?.lastDrawn).toHaveLength(1);
    expect(readVectorState(JSON.parse(JSON.stringify(accepted))).supply?.lastDrawn).toBeUndefined();
  });

  it('uses saved above the current limit of a card (after a pack or tier change) are clamped to the limit', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 7 } } },
      layout: { placements: { ...EMPTY, '01': 'basic:push' }, tray: [] } };
    const prepared = prepare(state, 'r1');
    expect(uses(prepared, 'basic:push')).toMatchObject({ value: 3, max: 3 });
    expect(stock(accept(state, prepared), 'basic:push')).toBe(2);
  });

  it('the hand survives a save and reload of the vector state', () => {
    const state: VectorState = { ...initialVectorState(),
      session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 } } },
      layout: { placements: { ...EMPTY, '01': 'basic:push' }, tray: [] } };
    const accepted = accept(state, prepare(state, 'r1'));
    const reloaded = readVectorState(JSON.parse(JSON.stringify(accepted)));
    expect(reloaded.supply?.hand).toEqual(accepted.supply?.hand);
    expect(prepare(reloaded, 'r2').layout.tray).toEqual(prepare(accepted, 'r2').layout.tray);
  });
});
