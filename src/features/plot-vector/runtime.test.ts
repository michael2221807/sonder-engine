import { describe, it, expect } from 'vitest';
import vectorRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { parseSupplyRules } from './supply';
import { acceptVector, bindCard, initialVectorState, prepareVector, readVectorState, type VectorState } from './runtime';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { tasksAfterSave, type SavedElement } from './genesis/post-save';
import type { NativeInput } from './native-input';

const SUPPLY = parseSupplyRules(vectorRules)!;
const BASIC_SUPPLY_IDS = SUPPLY.starter;
const bindAll = (entries: SavedElement[], card: (i: number) => unknown) =>
  tasksAfterSave({ id: 'saved', success: true, before: [], after: entries }).map((task, i) => bindCard(task, card(i)));

describe('local AGA board assembly', () => {
  it('keeps new cards in the tray, preserves explicit empty cells, and previews without growing', () => {
    const entries = POSITIVE_EXAMPLES.map(s => s.entry);
    const cards = bindAll(entries, i => POSITIVE_EXAMPLES[i].card);
    const state: VectorState = { ...initialVectorState(), cards };
    const untouched = structuredClone(state);
    const first = prepareVector(state, entries, 'r1', undefined, SUPPLY);
    expect(Object.values(first.layout.placements).filter(Boolean)).toEqual([]);
    expect(first.layout.tray).toEqual([...entries.map(e => e.id), ...BASIC_SUPPLY_IDS]);
    // The same card twice keeps the first; an unknown card and a hand card in the status cell are dropped.
    const arranged: VectorState = { ...state, layout: { placements: { '01': entries[2].id, '02': null, '03': entries[2].id,
      '04': 'removed', '06': entries[0].id }, tray: [] } };
    const preview = prepareVector(arranged, entries, 'r1', undefined, SUPPLY);
    expect(preview.layout.placements).toEqual({ '01': entries[2].id, '02': null, '03': null, '04': null, '05': null, '06': null });
    expect(preview.layout.tray).toEqual([...entries.slice(0, 2).map(e => e.id), ...BASIC_SUPPLY_IDS]);
    expect(state).toEqual(untouched);
    const accepted = acceptVector(arranged, preview, SUPPLY);
    expect(accepted.session.round).toBe(2);
    expect(accepted.growth[entries[2].id]).toMatchObject({ level: 1 }); // the diary grew one page
  });
  it('places at most one status in its fixed slot; statuses and environment never enter the tray', () => {
    const entries: SavedElement[] = Array.from({ length: 3 }, (_, i) => ({ id: `${i === 2 ? 'environment' : 'effect'}:${i}`, kind: i === 2 ? 'environment' : 'effect', capability: { name: `状态${i}` } }));
    const cards = bindAll(entries, i => ({ for: `状态${i}`, type: 'status', summary: 's', onPass: 'return { drag: 1 };' }));
    const state: VectorState = { ...initialVectorState(), cards };
    const first = prepareVector(state, entries, 'round-1', undefined, SUPPLY);
    const again = prepareVector(state, entries, 'round-1', undefined, SUPPLY);
    expect(Object.values(first.layout.placements).filter(Boolean)).toHaveLength(1);
    expect(first.layout.placements['06']).toMatch(/^effect:/);
    expect(first.layout.tray).toEqual([...BASIC_SUPPLY_IDS]); expect(again.layout).toEqual(first.layout);
  });
  it('removed saved elements cannot retain active abilities or narrative injection', () => {
    const sample = POSITIVE_EXAMPLES[0];
    const [card] = bindAll([sample.entry], () => sample.card);
    const result = prepareVector({ ...initialVectorState(), cards: [card] }, [], 'round-2');
    expect(result.board.cards.filter(c => c.origin !== 'supply')).toEqual([]); expect(result.prompt).toBe('');
  });
  it('a talent whose content changed is not used for the new content; an item reworded keeps its card', () => {
    const own = (entry: SavedElement, card: unknown, now: SavedElement) =>
      prepareVector({ ...initialVectorState(), cards: bindAll([entry], () => card) }, [now], 'round-3').board.cards.filter(c => c.origin !== 'supply');
    const talent = POSITIVE_EXAMPLES[1], item = POSITIVE_EXAMPLES[0];
    const reword = (entry: SavedElement) => ({ ...entry, capability: { ...entry.capability, description: '换了一种说法' } });
    expect(own(talent.entry, talent.card, reword(talent.entry))).toEqual([]);
    expect(own(item.entry, item.card, reword(item.entry)).map(c => c.id)).toEqual([item.entry.id]);
  });
});

describe('the stored vector state', () => {
  it('a state from the retired card format, or a damaged one, starts over', () => {
    const fresh = initialVectorState();
    expect(readVectorState(undefined)).toEqual(fresh);
    expect(readVectorState({ version: 1, session: {}, cards: [{ ref: { hash: 'x' } }], tasks: [] })).toEqual(fresh);
    expect(readVectorState({ session: {}, cards: [], tasks: [] })).toEqual(fresh);
    expect(readVectorState({ version: 2, cards: [], tasks: [] })).toEqual(fresh);
    expect(readVectorState({ version: 2, session: fresh.session, cards: 'x', tasks: [] })).toEqual(fresh);
  });
  it('a current state is kept, with damaged growth records read as fresh', () => {
    const sample = POSITIVE_EXAMPLES[2];
    const [card] = bindAll([sample.entry], () => sample.card);
    const state = { ...initialVectorState(), cards: [card], growth: { a: { level: 3, progress: 1, pendingBursts: 0 }, b: { level: -1, progress: 'x' }, c: null } };
    const read = readVectorState(JSON.parse(JSON.stringify(state)));
    expect(read.cards).toEqual([card]);
    expect(read.growth).toEqual({ a: { level: 3, progress: 1, pendingBursts: 0 }, b: { level: 0, progress: 0, pendingBursts: 0 }, c: { level: 0, progress: 0, pendingBursts: 0 } });
  });
});

describe('step-buying cards stop at the trip limit instead of failing the round', () => {
  // Each card is valid alone; together on one board they buy past the 60-step safety ceiling.
  const stepCard = (id: string): { entry: SavedElement; card: unknown } => ({
    entry: { id, kind: 'item', capability: { name: id, description: id } },
    card: { for: id, type: 'item', summary: id, onPass: 'return { steps: 8 };' },
  });
  it('two +8-step cards on one board settle at the 60-visit limit and the round commits', () => {
    const cards = [stepCard('item:boots'), stepCard('item:map')];
    const bound = cards.flatMap(c => bindAll([c.entry], () => c.card));
    const state: VectorState = { ...initialVectorState(), cards: bound,
      layout: { placements: { '01': 'item:boots', '02': 'item:map', '03': null, '04': null, '05': null, '06': null }, tray: [] } };
    const native: NativeInput = { ruleId: 'test', payload: { 'S+': 1, 'S-': 0, Y: 0, J: 0 }, visitBudget: 8, contributions: [] };
    const prepared = prepareVector(state, cards.map(c => c.entry), 'r1', native);
    expect(prepared.result.visits).toBe(prepared.board.budget.maxVisits);
    const capped = prepared.result.trace.filter(e => e.reasonCode === 'capReached' && e.deltas.some(d => d.channelOrField === 'visitBudget'));
    expect(capped.length).toBeGreaterThan(0);
    expect(acceptVector(state, prepared).session.round).toBe(2);
  });
});
