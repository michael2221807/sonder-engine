import { describe, expect, it } from 'vitest';
import { BASIC_SUPPLY_IDS } from './basic-supply';
import { set } from 'lodash-es';
import rulesJSON from '../../../public/packs/tianming/rules/plot-vector.json';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { parseNativeRules, projectNativeInput } from './native-input';
import { acceptVector, bindCard, initialVectorState, prepareVector, readVectorState, type VectorState } from './runtime';
import type { NativeInput } from './native-input';
import { projectSavedElements } from './saved-elements';
import { tasksAfterSave, type SavedElement } from './genesis/post-save';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';

const NATIVE: NativeInput = { ruleId: 'test', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };

describe('native saved inputs', () => {
  it('uses pack attributes for real momentum even on an empty board, without inventing values', () => {
    const rules = parseNativeRules(rulesJSON)!;
    const snapshot = set({}, P.characterAttributes, { 体质: 10, 心性: 10, 魅力: 10, 直觉: 5, 气运: 15, 悟性: 15 });
    const native = projectNativeInput(snapshot, rules);
    expect(native.payload).toEqual({ 'S+': 2, 'S-': 0, Y: 2, J: 2 });
    expect(native.visitBudget).toBe(11);
    const prepared = prepareVector(initialVectorState(), [], 'r', native);
    expect(prepared.board.startPayload).toEqual(native.payload);
    expect(prepared.result.visits).toBe(11); expect(prepared.prompt).not.toBe('');
    const missing = projectNativeInput(set({}, P.characterAttributes, { 体质: '10', 心性: Infinity, 魅力: -8, 悟性: 300 }), rules);
    expect(missing.payload).toEqual({ 'S+': 0, 'S-': 0, Y: 0, J: 0 });
    expect(missing.visitBudget).toBe(12);
    expect(missing.contributions[0].value).toBeNull();
    expect(projectNativeInput({}, rules).visitBudget).toBe(8);
  });
  it('rejects invalid pack arithmetic and leaves a safe zero-input fallback', () => {
    expect(parseNativeRules({ ...rulesJSON, baseVisits: Infinity })).toBeUndefined();
    expect(parseNativeRules({ ...rulesJSON, attributes: [{ ...rulesJSON.attributes[0], divisor: 0 }] })).toBeUndefined();
    expect(projectNativeInput({}, undefined).payload).toEqual({ 'S+': 0, 'S-': 0, Y: 0, J: 0 });
  });
  it('projects environment only for opt-in callers, ignores equal re-emission; environment acts at departure, never from a cell', () => {
    const snapshot = set({}, P.environmentTags, [{ 名称: '微风', 描述: '风吹过街道', 效果: '舒适' }]);
    const before = projectSavedElements(snapshot, { includeEnvironment: true }).entries;
    expect(projectSavedElements(snapshot).entries).toEqual([]);
    const tasks = tasksAfterSave({ id: 'r', success: true, before: [], after: before });
    expect(tasks).toHaveLength(1); expect(tasks[0].entry.kind).toBe('environment');
    expect(tasksAfterSave({ id: 'r2', success: true, before, after: structuredClone(before) })).toEqual([]);
    const bound = bindCard(tasks[0], POSITIVE_EXAMPLES[0].card);
    expect(bound.spec.type).toBe('environment'); // the entry's place decides the type
    const state: VectorState = { ...initialVectorState(), cards: [bound], layout: { placements: { '01': bound.task.entry.id }, tray: [] } };
    const prepared = prepareVector(state, before, 'r2', { ...NATIVE, payload: { 'S+': 1, 'S-': 0, Y: 0, J: 0 } });
    expect(Object.values(prepared.layout.placements)).not.toContain(bound.task.entry.id);
    // The hand holds only the basic supply cards: a status/environment card is never placeable.
    expect(prepared.layout.tray).toEqual([...BASIC_SUPPLY_IDS]);
    expect(prepared.board.cards[0].origin).toBe('environment');
    const departure = prepared.result.trace.filter(e => e.eventType === 'effect' && e.visitId === 'departure');
    expect(departure.map(e => [e.owner?.id, e.status, e.cellId])).toEqual([[bound.task.entry.id, 'applied', undefined]]);
    expect(prepared.result.trace.findIndex(e => e.eventType === 'departure')).toBeLessThan(prepared.result.trace.findIndex(e => e.eventType === 'visit'));
    const removed = prepareVector(state, [], 'r3', NATIVE);
    expect(removed.board.cards.filter(c => c.origin !== 'supply')).toEqual([]);
  });
  it('the status cell takes at most one status card each round, chosen by the round', () => {
    const statuses: SavedElement[] = ['受伤', '疲惫', '振奋'].map((name, i) => ({ id: `effect:${i}`, kind: 'effect', capability: { name, description: name } }));
    const cards = tasksAfterSave({ id: 'r', success: true, before: [], after: statuses })
      .map(task => bindCard(task, { for: String(task.entry.capability.name), type: 'status', summary: 's', onPass: 'return { drag: 1 };' }));
    const state: VectorState = { ...initialVectorState(), cards };
    const chosen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => prepareVector(state, statuses, id, NATIVE).layout.placements['06']));
    expect([...chosen].every(id => statuses.some(s => s.id === id))).toBe(true);
    expect(chosen.size).toBeGreaterThan(1);
    const one = prepareVector(state, statuses, 'a', NATIVE);
    expect(Object.values(one.layout.placements).filter(id => id?.startsWith('effect:'))).toHaveLength(1);
    expect(prepareVector(state, statuses, 'a', NATIVE).layout.placements['06']).toBe(one.layout.placements['06']);
  });
  it('shows growth without accepting previews; an accepted round keeps it once, however often it is retried', () => {
    const sample = POSITIVE_EXAMPLES[2]; // the diary: grows every round, chance 1 + level
    const task = tasksAfterSave({ id: 'r', success: true, before: [], after: [sample.entry] })[0];
    const bound = bindCard(task, sample.card);
    const state: VectorState = { ...initialVectorState(), cards: [bound], layout: { placements: { '01': sample.entry.id }, tray: [] } };
    const prepared = prepareVector(state, [sample.entry], 'r2', NATIVE);
    expect(prepared.progress?.[0]).toMatchObject({ cardId: sample.entry.id, rows: [{ key: 'level', value: 0, max: 50 }] });
    prepareVector(state, [sample.entry], 'r2', NATIVE);
    expect(state.growth).toEqual({});
    const next = acceptVector(state, prepared);
    expect(next.growth[sample.entry.id].level).toBe(1);
    expect(next.last?.progress?.[0].rows).toEqual([{ key: 'level', value: 1, max: 50, delta: 1 }]);
    expect(acceptVector(next, prepared)).toBe(next);
    const second = prepareVector(next, [sample.entry], 'r3', NATIVE);
    expect(second.progress?.[0].rows[0].value).toBe(1);
    const applied = second.result.trace.filter(e => e.owner?.id === sample.entry.id && e.status === 'applied');
    expect(applied[0].deltas.reduce((n, d) => n + (d.channelOrField === 'J' ? d.after - d.before : 0), 0)).toBe(2);
    // Growth survives a save and reload of the vector state.
    expect(readVectorState(JSON.parse(JSON.stringify(next))).growth).toEqual(next.growth);
  });
  it('shows a card\'s own store after confirmation and carries it into the next round', () => {
    const entry: SavedElement = { id: 'cool-pack', kind: 'item', capability: { name: '冷敷包', description: '可用于短暂降温' } };
    const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
    const bound = bindCard(task, { for: '冷敷包', type: 'item', summary: '存下推力', onPass: 'return ctx.stored < 3 ? { store: { from: "push", amount: Math.min(3 - ctx.stored, ctx.push) } } : {};' });
    const state: VectorState = { ...initialVectorState(), cards: [bound], layout: { placements: { '02': entry.id }, tray: [] } };
    const native: NativeInput = { ruleId: 'test', payload: { 'S+': 2, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
    const first = prepareVector(state, [entry], 'store-1', native);
    expect(first.progress?.some(p => p.cardId === entry.id)).toBe(false);
    expect(state.session.carriedAccounts).toEqual({});
    const accepted = acceptVector(state, first);
    expect(accepted.last?.progress?.find(p => p.cardId === entry.id)?.rows).toEqual([{ key: 'stored', value: 2, max: 30, delta: 2 }]);
    expect(acceptVector(accepted, first)).toBe(accepted);
    const second = prepareVector(accepted, [entry], 'store-2', native);
    expect(second.progress?.find(p => p.cardId === entry.id)?.rows[0].value).toBe(2);
    const again = acceptVector(accepted, second);
    expect(again.last?.progress?.find(p => p.cardId === entry.id)?.rows[0]).toMatchObject({ value: 3, delta: 1 });
  });
});
