import { describe, expect, it } from 'vitest';
import { cardTripReceipt } from './card-trip-receipt';
import { bindCard, initialVectorState, prepareVector, type PreparedVector, type VectorState } from './runtime';
import { tasksAfterSave, type SavedElement } from './genesis/post-save';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import type { NativeInput } from './native-input';

const native = (resistance: number, visitBudget = 2, push = 0): NativeInput => ({
  ruleId: 'receipt-test', payload: { 'S+': push, 'S-': resistance, Y: 0, J: 0 },
  visitBudget, contributions: [],
});

function preview(entry: SavedElement, card: unknown, opts: { resistance?: number; cell?: string; visits?: number; push?: number } = {}): PreparedVector {
  const task = tasksAfterSave({ id: 'saved', success: true, before: [], after: [entry] })[0];
  const state: VectorState = { ...initialVectorState(), cards: [bindCard(task, card)],
    layout: { placements: { [opts.cell ?? '01']: entry.id }, tray: [] } };
  const before = structuredClone(state);
  const result = prepareVector(state, [entry], 'preview', native(opts.resistance ?? 0, opts.visits, opts.push));
  expect(state).toEqual(before); // a preview never changes the saved state
  return result;
}

describe('card trip receipt from the real runner trace', () => {
  it('shows actual channel changes rather than a conflicting generated description', () => {
    const entry: SavedElement = { id: 'item:daily', kind: 'item', capability: {
      name: '日常物品', description: '来自存档的物品故事描述',
    } };
    const card = { for: '日常物品', type: 'item', summary: '只换得1点人际',
      onPass: 'return ctx.pass === 1 ? { social: 1, convert: { from: "drag", to: "social", amount: 2 } } : {};' };
    const empty = preview(entry, card);
    expect(empty.board.cards[0].originalText?.zh).toBe('来自存档的物品故事描述');
    expect(empty.board.cards[0].summary?.zh).toBe('只换得1点人际');
    const idle = cardTripReceipt(empty.result.trace, entry.id);
    expect(idle).toMatchObject({ activations: 1 });
    expect([idle.shuttleChanges.Y, idle.shuttleChanges['S-'] ?? 0]).toEqual([1, 0]);
    const resisted = preview(entry, card, { resistance: 2 });
    expect(cardTripReceipt(resisted.result.trace, entry.id)).toMatchObject({
      activations: 1, shuttleChanges: { 'S-': -2, Y: 3 },
    });
  });

  it('reports a route effect from an add-steps card without pretending it is a channel gain', () => {
    const sample = POSITIVE_EXAMPLES[1];
    const result = preview(sample.entry, sample.card);
    expect(result.result.visits).toBe(4);
    expect(cardTripReceipt(result.result.trace, sample.entry.id)).toMatchObject({
      activations: 1, otherEffects: ['route'], shuttleChanges: {},
    });
  });

  it('keeps direction changes separate from the numeric trip receipt', () => {
    const entry: SavedElement = { id: 'item:turn', kind: 'item', capability: { name: '返程物', description: '返程所用' } };
    const turning = preview(entry, { for: '返程物', type: 'item', summary: '首次经过掉头', onPass: 'return ctx.pass === 1 ? { turn: 1 } : {};' },
      { cell: '02', visits: 4 });
    expect(cardTripReceipt(turning.result.trace, entry.id)).toMatchObject({
      activations: 1, otherEffects: ['route'], shuttleChanges: {},
    });

    const diary = POSITIVE_EXAMPLES[2];
    const growing = preview(diary.entry, diary.card);
    expect(cardTripReceipt(growing.result.trace, diary.entry.id)).toMatchObject({
      activations: 1, shuttleChanges: { J: 1 }, otherEffects: [],
    });
  });

  it('counts what a card stores and releases, and the half again a release brings back', () => {
    const entry: SavedElement = { id: 'item:jar', kind: 'item', capability: { name: '储物罐', description: '存起来' } };
    // The line board passes cell 01 on steps 1 and 11: store 3 push, then release it all.
    const jar = preview(entry, { for: '储物罐', type: 'item', summary: '先存后放', onPass: 'return ctx.pass === 1 ? { store: { from: "push", amount: 3 } } : { release: 1 };' },
      { visits: 11, push: 5 });
    expect(cardTripReceipt(jar.result.trace, entry.id)).toMatchObject({
      activations: 2, stored: 3, released: 3, shuttleChanges: { 'S+': 1.5 },
    });
  });
});
