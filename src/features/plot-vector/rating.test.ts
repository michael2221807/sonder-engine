/**
 * Card rating (phase 6, PO 2A; charter C1): strength measured on the board against the same trips without the
 * card, in units of one push per pass; six tiers (PO 2026-09-30); every bound story card carries its rating (recorded, not
 * shown), and cards saved before ratings existed get one when the next round is accepted.
 */
import { describe, expect, it } from 'vitest';
import { CARD_TIERS, rateCard, ratingIsCurrent, ratingPlaceOf, RATING_VERSION, tierForRatio, tierOf, TIER_THRESHOLDS } from './rating';
import { acceptVector, bindCard, initialVectorState, prepareVector, RATE_PER_ROUND, readVectorState, type VectorState } from './runtime';
import { tasksAfterSave, type SavedElement } from './genesis/post-save';
import type { CardSpec } from './contract/types';

const card = (onPass: string, type: CardSpec['type'] = 'item'): CardSpec => ({ for: 'x', type, summary: 's', onPass });

describe('rating a card', () => {
  it('measures in units of one push per pass, the same way every time', () => {
    expect(rateCard(card('return { push: 1 };')).ratio).toBe(1);
    expect(rateCard(card('return { social: 1 };')).ratio).toBe(1);
    expect(rateCard(card('return { xPush: 2 };'))).toEqual(rateCard(card('return { xPush: 2 };')));
  });
  it('a stronger card rates higher, and the tier follows the thresholds', () => {
    const one = rateCard(card('return { push: 1 };')).ratio;
    const three = rateCard(card('return { push: 3 };')).ratio;
    const all = rateCard(card('return { xPush: 2, xSocial: 2, xChance: 2 };'));
    expect(three).toBeGreaterThan(one);
    expect(all.ratio).toBeGreaterThan(three);
    expect(all.tier).toBe('mythic');
    expect(tierForRatio(TIER_THRESHOLDS.uncommon - 0.01)).toBe('common');
    // Each threshold starts its tier, and the thresholds climb with the tiers.
    for (const tier of CARD_TIERS.slice(1) as Array<keyof typeof TIER_THRESHOLDS>) {
      expect(tierForRatio(TIER_THRESHOLDS[tier])).toBe(tier);
      expect(tierForRatio(TIER_THRESHOLDS[tier] - 0.001)).toBe(CARD_TIERS[CARD_TIERS.indexOf(tier) - 1]);
    }
    expect(CARD_TIERS).toEqual(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);
  });
  it('a card that never acts rates near zero and counts as common; a status and an environment are rated where they act', () => {
    // An occupied cell changes the board a little on its own, so a silent card is near zero, not exactly zero.
    const never = rateCard(card('if (ctx.step > 999) return { push: 50 };\nreturn {};'));
    expect(never).toMatchObject({ tier: 'common', triggerRate: 0 });
    expect(never.ratio).toBeLessThan(0.1);
    expect(ratingPlaceOf('status')).toBe('status');
    expect(ratingPlaceOf('environment')).toBe('departs');
    expect(ratingPlaceOf('talent')).toBe('placed');
    const weather = rateCard(card('return { chance: 3 };', 'environment'), 'departs');
    expect(weather.ratio).toBeGreaterThan(0);
    expect(weather.triggerRate).toBe(1);
    expect(rateCard(card('return { drag: 2 };', 'status'), 'status').ratio).toBeGreaterThan(0);
  });
});

describe('rated on both board shapes (version 2)', () => {
  it('a card that acts only going back sits below one that always acts, and is current', () => {
    const back = rateCard(card('if (ctx.back) return { push: 2 };\nreturn {};'));
    const always = rateCard(card('return { push: 2 };'));
    // On a ring the shuttle only goes back when turned, so a going-back card is weaker than one that always acts.
    expect(back.ratio).toBeGreaterThan(0.1);
    expect(back.ratio).toBeLessThan(always.ratio);
    expect(back.version).toBe(RATING_VERSION);
    expect(ratingIsCurrent(back)).toBe(true);
    expect(ratingIsCurrent({ ...back, version: 1 })).toBe(false);
    expect(ratingIsCurrent(undefined)).toBe(false);
  });
  it('a rating from the two-shape method shows its tier by the current thresholds at once; a line-only one shows none', () => {
    const r = rateCard(card('return { xSocial: 2, social: 1 };'));
    expect(tierOf({ ...r, version: 2, tier: 'rare' })).toBe(tierForRatio(r.ratio));
    expect(tierOf({ ...r, version: 1 })).toBeUndefined();
    expect(tierOf(undefined)).toBeUndefined();
  });
});

describe('what a card does (the effect profile, version 4)', () => {
  const profile = (onPass: string) => rateCard(card(onPass)).profile!;
  it("counts the card's own change, in units of the unit card, not what the cells make of it", () => {
    expect(profile('return { push: 1 };').perTrip).toEqual({ push: 1, drag: 0, social: 0, chance: 0 });
    expect(profile('return { social: 2 };').perTrip.social).toBeCloseTo(2, 1);
    expect(profile('return { drag: -1 };').perTrip.drag).toBeLessThan(0);
    const turned = profile('return { convert: { from: "drag", to: "social", amount: 1 } };').perTrip;
    expect(turned.drag).toBeLessThan(0);
    expect(turned.social).toBeGreaterThan(0);
    expect(profile('return { push: 2 };')).toEqual(profile('return { push: 2 };'));
  });
  it("per act it is in the shuttle's own units", () => {
    expect(profile('if (ctx.pass === 1) return { chance: 3 };\nreturn {};').perAct.chance).toBeGreaterThan(2.5);
  });
  it('a turn or a step change marks the route; storing and releasing mark the store and move nothing on their own', () => {
    expect(profile('return { turn: true };')).toMatchObject({ route: true, store: false, perTrip: { push: 0, drag: 0, social: 0, chance: 0 } });
    expect(profile('return { steps: 1 };').route).toBe(true);
    const pocket = profile('if (ctx.stored >= 3) return { release: true };\nreturn { store: { from: "push", amount: 1 } };');
    expect(pocket).toMatchObject({ store: true, route: false });
    expect(pocket.perTrip.push).toBeGreaterThanOrEqual(0);
  });
  it("a relay acts through the next card, so it shows the trip's change with it", () => {
    const relay = profile('return { relay: { echo: true } };');
    expect(relay.perAct).toEqual({ push: 0, drag: 0, social: 0, chance: 0 });
    expect(relay.perTrip.push).toBeGreaterThan(0);
  });
  it('a relay that turns or steps the next card changes the route; a relay that stores is shown by the trip\'s change', () => {
    expect(profile('return { relay: { turn: true } };').route).toBe(true);
    expect(profile('return { relay: { steps: 2 } };').route).toBe(true);
    const keeper = profile('if (ctx.stored >= 2) return { relay: { release: true } };\nreturn { relay: { store: { from: "push", amount: 1 } } };');
    expect(keeper.store).toBe(true);
    // A card of its own with a relay: the trip's change, not only its own part.
    const both = profile('return { push: 1, relay: { echo: true } };');
    expect(both.perTrip.push).toBeGreaterThan(profile('return { push: 1 };').perTrip.push * 0.9);
    expect(both.perAct.push).toBeGreaterThan(0.9);
  });
  it('a rating from before version 4 has no profile and is not current', () => {
    const r = rateCard(card('return { push: 1 };'));
    expect(r.version).toBe(4);
    const { profile: _dropped, ...old } = r;
    expect(ratingIsCurrent({ ...old, version: 3 })).toBe(false);
  });
});

describe('story cards carry their rating (recorded, not shown)', () => {
  const entry: SavedElement = { id: 'item:tea', kind: 'item', capability: { name: '热茶', description: '一杯热茶' } };
  const task = tasksAfterSave({ id: 'r', success: true, before: [], after: [entry] })[0];
  it('every bound card is rated where it acts', () => {
    const bound = bindCard(task, card('return { push: 2 };'));
    expect(bound.rating).toEqual(rateCard(bound.spec, 'placed'));
    const status = bindCard({ ...task, entry: { ...entry, id: 'effect:name:发烧', kind: 'effect' } }, card('return { drag: 2 };', 'status'));
    expect(status.rating).toEqual(rateCard(status.spec, 'status'));
  });
  it('the rating with its effect profile is kept through the save as written (no re-rating after a reload)', () => {
    const bound = bindCard(task, card('return { push: 2, social: 1 };'));
    const saved = readVectorState(JSON.parse(JSON.stringify({ ...initialVectorState(), cards: [bound] })));
    expect(saved.cards[0].rating).toEqual(bound.rating);
    expect(saved.cards[0].rating?.profile?.perTrip.push).toBeGreaterThan(0);
    expect(ratingIsCurrent(saved.cards[0].rating)).toBe(true);
  });
  it('an old save with many unrated cards is rated a few per round, never all in one round', () => {
    const entries: SavedElement[] = Array.from({ length: RATE_PER_ROUND + 2 }, (_, i) => ({ id: `item:${i}`, kind: 'item', capability: { name: `物${i}`, description: '' } }));
    const tasks = tasksAfterSave({ id: 'r', success: true, before: [], after: entries });
    const old = tasks.map(t => { const { rating: _r, ...c } = bindCard(t, card(`return { push: ${1 + Number(t.entry.id.split(':')[1])} };`)); return c; });
    let state: VectorState = { ...initialVectorState(), cards: old };
    state = acceptVector(state, prepareVector(state, entries, 'r1'));
    expect(state.cards.filter(c => c.rating)).toHaveLength(RATE_PER_ROUND);
    state = acceptVector(state, prepareVector(state, entries, 'r2'));
    expect(state.cards.every(c => c.rating)).toBe(true);
  });
  it('a card rated by the older line-only method is rated again when the next round is accepted', () => {
    const bound = bindCard(task, card('return { push: 2 };'));
    const old = { ...bound, rating: { ...bound.rating!, ratio: 9, tier: 'legendary' as const, version: 1 } };
    const state: VectorState = { ...initialVectorState(), cards: [old] };
    const accepted = acceptVector(state, prepareVector(state, [entry], 'r1'));
    expect(accepted.cards[0].rating).toEqual(rateCard(old.spec, 'placed'));
  });
  it('a card saved before ratings existed is rated when the next round is accepted', () => {
    const { rating: _dropped, ...old } = bindCard(task, card('return { push: 2 };'));
    const state: VectorState = { ...initialVectorState(), cards: [old] };
    const accepted = acceptVector(state, prepareVector(state, [entry], 'r1'));
    expect(accepted.cards[0].rating).toEqual(rateCard(old.spec, 'placed'));
  });
});
