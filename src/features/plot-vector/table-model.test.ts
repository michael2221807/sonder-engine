/**
 * The card table's model (phase 7): hand, cells, marks, weather, forming entries, moves, and a trip read as the
 * shuttle's steps. Built from real prepared trips, no UI.
 */
import { describe, expect, it } from 'vitest';
import vectorRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { bindCard, initialVectorState, prepareVector, type VectorState } from './runtime';
import { initialSupply, parseSupplyRules, supplyHandInfo } from './supply';
import { tasksAfterSave, type SavedElement } from './genesis/post-save';
import { abilityBacklog } from './ability-backlog';
import type { BoardView } from './board-access';
import type { NativeInput } from './native-input';
import { arrange, sweep, tableModel, tripWalk } from './table-model';

const SUPPLY = parseSupplyRules(vectorRules)!;
const NATIVE: NativeInput = { ruleId: 't', payload: { 'S+': 2, 'S-': 0, Y: 1, J: 1 }, visitBudget: 10, contributions: [] };
const entries: SavedElement[] = [
  { id: 'item:tea', kind: 'item', capability: { name: '热茶', description: '一壶暖手的热茶' } },
  { id: 'effect:name:发烧', kind: 'effect', capability: { name: '发烧', description: '头重脚轻' } },
  { id: 'environment:name:细雨', kind: 'environment', capability: { name: '细雨', description: '路滑' } },
  { id: 'talent:name:口才', kind: 'talent', capability: { name: '口才', description: '能说会道' } },
];
const specs: Record<string, unknown> = {
  'item:tea': { for: '热茶', type: 'item', summary: '每次经过推力 +1。', onPass: 'return { push: 1 };' },
  'effect:name:发烧': { for: '发烧', type: 'status', summary: '越拖越沉。', onPass: 'return { drag: 1 };' },
  'environment:name:细雨': { for: '细雨', type: 'environment', summary: '出发时机会 +2。', onPass: 'return { chance: 2 };' },
};
// 口才 has no card yet: it is still forming.
const cards = tasksAfterSave({ id: 's', success: true, before: [], after: entries }).filter(t => specs[t.entry.id]).map(t => bindCard(t, specs[t.entry.id]));

function viewOf(state: VectorState, layout?: VectorState['layout']): BoardView {
  const withLayout = layout ? { ...state, layout } : state;
  const prepared = prepareVector(withLayout, entries, 'p/s/2', NATIVE, SUPPLY);
  return { state: withLayout, prepared, cleared: false, backlog: abilityBacklog(withLayout, entries),
    supply: supplyHandInfo(SUPPLY, withLayout.supply ?? initialSupply(SUPPLY)),
    preview: async () => prepared, save: async () => {} };
}
const base: VectorState = { ...initialVectorState(), cards };

describe('the table', () => {
  it('shows the hand, the status in its cell, the weather and the entries still forming', () => {
    const view = viewOf(base);
    const model = tableModel(view, view.prepared, view.prepared.layout, 'line');
    expect(model.hand).toEqual(['item:tea', ...SUPPLY.starter]);
    expect(model.cells.map(c => [c.id, c.role])).toEqual([['01', 'resonance'], ['02', 'resonance'], ['03', 'converter'], ['04', 'effect'], ['05', 'effect'], ['06', 'status']]);
    expect(model.cells.find(c => c.id === '06')!.card).toBe('effect:name:发烧');
    expect(model.weather).toEqual(['environment:name:细雨']);
    expect(model.forming).toEqual([{ id: 'talent:name:口才', kind: 'talent', name: '口才', failed: false }]);
    const push = model.cards['basic:push'];
    expect(push).toMatchObject({ kind: 'supply', tier: 'common', uses: { left: 3, max: 3 }, resting: false });
    expect(model.cards['item:tea']).toMatchObject({ kind: 'item', name: { zh: '热茶' }, line: { zh: '每次经过推力 +1。' }, story: { zh: '一壶暖手的热茶' } });
    expect(model.cards['item:tea'].tier).toBeUndefined(); // rarity is shown for supply cards only
  });
  it('a card placed leaves the hand; a recharging supply card with no use left rests at the end, not placeable', () => {
    const drawn = { hand: [...initialSupply(SUPPLY).hand, { id: 'supply:habit#1', cardId: 'supply:habit', recharge: 2 }], drawn: 1 };
    const state: VectorState = { ...base, supply: drawn, session: { ...base.session, cardStates: { 'supply:habit#1': { stock: 0 } } } };
    const view = viewOf(state, { placements: { '01': 'item:tea' }, tray: [] });
    const model = tableModel(view, view.prepared, view.prepared.layout, 'ring');
    expect(model.shape).toBe('ring');
    expect(model.cells[0].card).toBe('item:tea');
    expect(model.hand).toEqual([...SUPPLY.starter, 'supply:habit#1']);
    expect(model.cards['supply:habit#1']).toMatchObject({ resting: true, uses: { left: 0 }, charge: { progress: 2, every: 4, on: 'trigger' } });
  });
});

describe('moving cards', () => {
  const empty = { placements: { '01': null, '02': null, '03': null, '04': null, '05': null, '06': 'effect:name:发烧' }, tray: [] };
  it('places, swaps, moves back to the hand, and never touches the status cell', () => {
    let layout = arrange(empty, 'a', '01');
    layout = arrange(layout, 'b', '02');
    expect(layout.placements).toMatchObject({ '01': 'a', '02': 'b' });
    layout = arrange(layout, 'a', '02'); // onto an occupied cell: the two swap
    expect(layout.placements).toMatchObject({ '01': 'b', '02': 'a' });
    layout = arrange(layout, 'c', '01'); // from the hand onto an occupied cell: the occupant goes back to the hand
    expect(layout.placements).toMatchObject({ '01': 'c', '02': 'a' });
    layout = arrange(layout, 'a', null);
    expect(layout.placements['02']).toBeNull();
    expect(arrange(layout, 'x', '06')).toBe(layout);
    expect(arrange(layout, 'effect:name:发烧', '01')).toBe(layout);
    expect(sweep(layout).placements).toEqual({ '01': null, '02': null, '03': null, '04': null, '05': null, '06': 'effect:name:发烧' });
  });
});

describe('a trip as the shuttle walks it', () => {
  it('lists every step with its direction and the sign each card left, and the departure', () => {
    const view = viewOf(base, { placements: { '01': 'item:tea' }, tray: [] });
    const walk = tripWalk(view.prepared.result);
    expect(walk.steps.map(s => s.cell)).toEqual(['01', '02', '03', '04', '05', '06', '05', '04', '03', '02']);
    expect(walk.steps.map(s => s.back)).toEqual([false, false, false, false, false, false, true, true, true, true]);
    expect(walk.steps[0].acted).toEqual([{ card: 'item:tea', sign: 'push' }]);
    expect(walk.steps[5].acted).toEqual([{ card: 'effect:name:发烧', sign: 'drag' }]);
    expect(walk.departure).toEqual([{ card: 'environment:name:细雨', sign: 'chance' }]);
    const d = view.prepared.result.vectorPacket.dimensions;
    expect(walk.tendency).toEqual({ s: d.S, y: d.Y, j: d.J });
  });
  it('on the ring the shuttle keeps going forward', () => {
    const view = viewOf({ ...base, shape: 'ring' });
    expect(tripWalk(view.prepared.result).steps.map(s => `${s.cell}${s.back ? '<' : ''}`)).toEqual(['01', '02', '03', '04', '05', '06', '01', '02', '03', '04']);
  });
});
