import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { set } from 'lodash-es';
import { DEFAULT_ENGINE_PATHS as P } from '@/engine/pipeline/types';
import { projectSavedElements } from '@/features/plot-vector/saved-elements';
import { tasksAfterSave } from '@/features/plot-vector/genesis/post-save';
import { POSITIVE_EXAMPLES } from '@/features/plot-vector/genesis/test-fixtures';
import { bindCard, initialVectorState } from '@/features/plot-vector/runtime';
import { usePacedCardTiers, CARD_TIER_PAUSE_MS, type CardTierInput } from './usePacedCardTiers';

const NAMES = ['随身日记', '旧信', '铜钥匙', '纸伞'];
/** A backpack of `n` items whose cards were bound before ratings existed: each must be worked out. */
function unratedSave(n: number, tag: string): CardTierInput {
  const items = Object.fromEntries(NAMES.slice(0, n).map((名称, i) => [`item${i}`, { 名称, 描述: '记录', 数量: 1 }]));
  const entries = projectSavedElements(set({}, P.inventoryItems, items)).entries;
  const cards = entries.map((entry, i) => {
    const task = tasksAfterSave({ id: `${tag}-${i}`, success: true, before: [], after: [entry] })[0];
    const card = bindCard(task, POSITIVE_EXAMPLES[2].card);
    // A spec no other test rated, so the session cache does not answer for it.
    return { ...card, spec: { ...card.spec, summary: `${card.spec.summary} #${tag}-${i}` }, rating: undefined };
  });
  return { entries, vectorState: { ...initialVectorState(), cards } };
}

afterEach(() => { vi.useRealTimers(); });

// PO 2026-10-03: the backpack shows each item's card tier; unrated cards are worked out a few at a time.
describe('usePacedCardTiers', () => {
  it('works out every unrated card, one per pause, starting at once — not only the first', async () => {
    vi.useFakeTimers();
    const input = unratedSave(3, 'all');
    const scope = effectScope();
    const tiers = scope.run(() => usePacedCardTiers(() => input))!;
    expect(tiers.value.size).toBe(1);
    await vi.advanceTimersByTimeAsync(CARD_TIER_PAUSE_MS);
    expect(tiers.value.size).toBe(2);
    await vi.advanceTimersByTimeAsync(CARD_TIER_PAUSE_MS);
    expect(tiers.value.size).toBe(3);
    // Every card rated: no pass is waiting any more.
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it('stops when the page goes away, and has nothing to do with the feature off', async () => {
    vi.useFakeTimers();
    const input = unratedSave(3, 'stop');
    const scope = effectScope();
    const tiers = scope.run(() => usePacedCardTiers(() => input))!;
    expect(tiers.value.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);

    const off = effectScope();
    const none = off.run(() => usePacedCardTiers(() => null))!;
    expect(none.value.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    off.stop();
  });
});
