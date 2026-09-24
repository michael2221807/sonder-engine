import { describe, expect, it } from 'vitest';
import { cardTripReceipt } from './card-trip-receipt';
import { executeVectorOperation, initialVectorState, type PreparedVector } from './runtime';
import { tasksAfterSave, type BoundCard, type GenesisOutputV2, type SavedElement } from './genesis/post-save';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import type { NativeInput } from './native-input';

const native = (resistance: number, visitBudget = 2): NativeInput => ({
  ruleId: 'receipt-test', payload: { 'S+': 0, 'S-': resistance, Y: 0, J: 0 },
  visitBudget, contributions: [],
});

async function preview(entry: SavedElement, output: GenesisOutputV2, resistance = 0,
  cell = '01', visits = 2): Promise<PreparedVector> {
  const task = tasksAfterSave({ id: 'saved', success: true, before: [], after: [entry] })[0];
  const card = await executeVectorOperation({ kind: 'validate', task, output, attempts: 1 }) as BoundCard;
  const state = { ...initialVectorState(), cards: [card],
    layout: { placements: { [cell]: entry.id }, tray: [] } };
  const before = structuredClone(state);
  const result = await executeVectorOperation({ kind: 'prepare', state, entries: [entry],
    native: native(resistance, visits), id: 'preview' }) as PreparedVector;
  expect(state).toEqual(before);
  return result;
}

describe('card trip receipt from the real runner trace', () => {
  it('shows actual channel changes rather than a conflicting generated description', async () => {
    const entry: SavedElement = { id: 'item:daily', kind: 'item', capability: {
      name: '日常物品', description: '来自存档的物品故事描述',
    } };
    const output: GenesisOutputV2 = { version: 2, card: {
      name: '日常物品', description: '只换得1点人际', behaviorSummary: '2点阻力换1点人际',
      hooks: { onVisit: "return {effects:ctx.runState.used?[]:[{kind:'convert',from:'S-',to:'Y',amount:2,efficiency:0.5},{kind:'add',channel:'Y',amount:1}],runState:{used:true}};", onRoundAccepted: null },
      initialPersistentState: {},
    } };
    const empty = await preview(entry, output, 0);
    expect(empty.board.cards[0].originalText?.zh).toBe('来自存档的物品故事描述');
    expect(cardTripReceipt(empty.result.trace, entry.id)).toMatchObject({
      activations: 1, shuttleChanges: { 'S-': 0, Y: 1 },
    });
    const resisted = await preview(entry, output, 2);
    expect(cardTripReceipt(resisted.result.trace, entry.id)).toMatchObject({
      activations: 1, shuttleChanges: { 'S-': -2, Y: 2 },
    });
  });

  it('reports a route effect from a generated add-steps card without pretending it is a channel gain', async () => {
    const sample = POSITIVE_EXAMPLES[1];
    const result = await preview(sample.entry, sample.output);
    expect(result.result.visits).toBe(4);
    expect(cardTripReceipt(result.result.trace, sample.entry.id)).toMatchObject({
      activations: 1, otherEffects: ['route'], shuttleChanges: {},
    });
  });

  it('keeps direction changes and growth separate from the numeric trip receipt', async () => {
    const entry: SavedElement = { id: 'item:turn', kind: 'item', capability: { name: '返程物', description: '返程所用' } };
    const output: GenesisOutputV2 = { version: 2, card: {
      name: '返程物', description: '换方向', behaviorSummary: '首次经过掉头',
      hooks: { onVisit: "return {effects:ctx.runState.used?[]:[{kind:'turnShuttle'}],runState:{used:true}};", onRoundAccepted: null },
      initialPersistentState: {},
    } };
    const turning = await preview(entry, output, 0, '02', 4);
    expect(cardTripReceipt(turning.result.trace, entry.id)).toMatchObject({
      activations: 1, otherEffects: ['route'], shuttleChanges: {},
    });

    const diary = POSITIVE_EXAMPLES[2];
    const growing = await preview(diary.entry, diary.output);
    expect(cardTripReceipt(growing.result.trace, diary.entry.id)).toMatchObject({
      activations: 1, shuttleChanges: { J: 1 }, otherEffects: [],
    });
  });
});
