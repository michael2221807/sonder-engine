import { describe, expect, it } from 'vitest';
import { set } from 'lodash-es';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { projectSavedElements } from './saved-elements';
import { tasksAfterSave } from './genesis/post-save';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { bindCard, initialVectorState } from './runtime';
import { RATING_VERSION, rateCard, ratingPlaceOf, tierForRatio, tierOf, type CardRating } from './rating';
import { entryCardTiers } from './entry-tiers';

const NOTEBOOK = { 名称: '随身日记', 描述: '记录日常', 数量: 1, 品质: '神话' };
const entriesOf = (items: Record<string, unknown>) => projectSavedElements(set({}, P.inventoryItems, items)).entries;
/** A save with the notebook bound to its card, as the post-save genesis binds it. */
function boundNotebook(rating?: CardRating) {
  const entry = entriesOf({ notebook: NOTEBOOK }).find(e => e.id === 'item:notebook')!;
  const task = tasksAfterSave({ id: 'fixture', success: true, before: [], after: [entry] })[0];
  const card = bindCard(task, POSITIVE_EXAMPLES[2].card);
  return { ...initialVectorState(), cards: [rating === undefined ? card : { ...card, rating }] };
}

// PO 2026-10-03: an item's rarity is its card's — the backpack shows the tier the table shows.
describe('entryCardTiers', () => {
  const tierFor = (items: Record<string, unknown>, state: unknown, budget?: number) =>
    entryCardTiers(entriesOf(items), state, budget).tiers.get('item:notebook');

  it("an item with a card shows the card's tier, whatever its own 品质 says", () => {
    const state = boundNotebook();
    const expected = tierOf(rateCard(state.cards[0].spec, ratingPlaceOf(state.cards[0].spec.type)));
    expect(expected).toBeDefined();
    expect(tierFor({ notebook: NOTEBOOK }, state)).toBe(expected);
  });
  it('a saved current rating wins; an old one is worked out again, as the table does', () => {
    const current: CardRating = { ratio: 9, tier: tierForRatio(9), triggerRate: 1, version: RATING_VERSION };
    expect(tierFor({ notebook: NOTEBOOK }, boundNotebook(current))).toBe('mythic');
    const old: CardRating = { ratio: 9, tier: 'mythic', triggerRate: 1, version: RATING_VERSION - 1 };
    const fresh = boundNotebook();
    expect(tierFor({ notebook: NOTEBOOK }, boundNotebook(old)))
      .toBe(tierOf(rateCard(fresh.cards[0].spec, ratingPlaceOf(fresh.cards[0].spec.type))));
  });
  it('only an active card counts: prose edits keep it, a changed 品质 or a removed item does not', () => {
    const state = boundNotebook();
    expect(tierFor({ notebook: { ...NOTEBOOK, 描述: '换了个说法' } }, state)).toBeDefined();
    expect(tierFor({ notebook: { ...NOTEBOOK, 品质: '普通' } }, state)).toBeUndefined();
    expect(entryCardTiers(entriesOf({}), state).tiers.size).toBe(0);
  });
  it('no vector state, no tiers', () => {
    expect(entryCardTiers(entriesOf({ notebook: NOTEBOOK }), undefined)).toEqual({ tiers: new Map(), unrated: 0 });
  });
  it('works out at most the budget per call and says how many are left; the next call goes on', () => {
    // Two unrated cards with specs no other test rated, so neither is in the session cache yet.
    const base = boundNotebook();
    const second = entriesOf({ diary: { ...NOTEBOOK, 名称: '旧信' } }).find(e => e.id === 'item:diary')!;
    const task = tasksAfterSave({ id: 'fixture-2', success: true, before: [], after: [second] })[0];
    const tweak = (spec: typeof base.cards[0]['spec'], n: number) => ({ ...spec, summary: `${spec.summary} #budget-${n}` });
    // Bound before ratings existed (no saved rating), so both need working out.
    const cards = [{ ...base.cards[0], spec: tweak(base.cards[0].spec, 1), rating: undefined },
      { ...bindCard(task, POSITIVE_EXAMPLES[2].card), spec: tweak(base.cards[0].spec, 2), rating: undefined }];
    const state = { ...base, cards };
    const entries = entriesOf({ notebook: NOTEBOOK, diary: { ...NOTEBOOK, 名称: '旧信' } });
    const first = entryCardTiers(entries, state, 1);
    expect(first.tiers.size).toBe(1);
    expect(first.unrated).toBe(1);
    const next = entryCardTiers(entries, state, 1);
    expect(next.tiers.size).toBe(2);
    expect(next.unrated).toBe(0);
    // Nothing left to work out: a zero budget still shows both, from the saved or worked-out ratings.
    expect(entryCardTiers(entries, state, 0)).toMatchObject({ unrated: 0 });
    expect(entryCardTiers(entries, state, 0).tiers.size).toBe(2);
  });
  it('a damaged vector state or card leaves the entry without a card tier instead of failing', () => {
    expect(entryCardTiers(entriesOf({ notebook: NOTEBOOK }), { cards: [null, { task: {} }] })).toEqual({ tiers: new Map(), unrated: 0 });
    const state = boundNotebook();
    const broken = { ...state, cards: [{ ...state.cards[0], spec: null }] };
    expect(() => entryCardTiers(entriesOf({ notebook: NOTEBOOK }), broken)).not.toThrow();
  });
});
