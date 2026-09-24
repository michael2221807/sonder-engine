import { describe, expect, it } from 'vitest';
import { set } from 'lodash-es';
import rulesJSON from '../../../public/packs/tianming/rules/plot-vector.json';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { parseNativeRules, projectNativeInput } from './native-input';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorState } from './runtime';
import { projectSavedElements } from './saved-elements';
import { tasksAfterSave, type BoundCard } from './genesis/post-save';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { readCardProgress } from './card-progress';

describe('native saved inputs', () => {
  it('uses pack attributes for real momentum even on an empty board, without inventing values', async () => {
    const rules = parseNativeRules(rulesJSON)!;
    const snapshot = set({}, P.characterAttributes, { 体质: 10, 心性: 10, 魅力: 10, 直觉: 5, 气运: 15, 悟性: 15 });
    const native = projectNativeInput(snapshot, rules);
    expect(native.payload).toEqual({ 'S+': 2, 'S-': 0, Y: 2, J: 2 });
    expect(native.visitBudget).toBe(11);
    const prepared = await executeVectorOperation({ kind: 'prepare', state: initialVectorState(), entries: [], id: 'r', native }) as PreparedVector;
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
  it('projects environment only for opt-in callers, ignores equal re-emission and drops removed abilities', async () => {
    const snapshot = set({}, P.environmentTags, [{ 名称: '微风', 描述: '风吹过街道', 效果: '舒适' }]);
    const before = projectSavedElements(snapshot, { includeEnvironment: true }).entries;
    expect(projectSavedElements(snapshot).entries).toEqual([]);
    const tasks = tasksAfterSave({ id: 'r', success: true, before: [], after: before });
    expect(tasks).toHaveLength(1); expect(tasks[0].entry.kind).toBe('environment');
    expect(tasksAfterSave({ id: 'r2', success: true, before, after: structuredClone(before) })).toEqual([]);
    const bound = await executeVectorOperation({ kind: 'validate', task: tasks[0], output: POSITIVE_EXAMPLES[0].output, attempts: 1 }) as BoundCard;
    const state = { ...initialVectorState(), cards: [bound], layout: { placements: { '01': bound.task.entry.id }, tray: [] } };
    const prepared = await executeVectorOperation({ kind: 'prepare', state, entries: before, id: 'r2' }) as PreparedVector;
    expect(prepared.layout.placements['01']).toBeNull();
    expect(prepared.layout.placements['06']).toBe(bound.task.entry.id); expect(prepared.layout.tray).toEqual([]);
    expect(prepared.board.cards[0].origin).toBe('environment');
    const removed = await executeVectorOperation({ kind: 'prepare', state, entries: [], id: 'r3' }) as PreparedVector;
    expect(removed.board.cards).toEqual([]);
  });
  it('shows persistent growth and charge without accepting previews; preserves accepted deltas on retry', async () => {
    const sample = POSITIVE_EXAMPLES[2];
    const output = structuredClone(sample.output);
    output.card.initialPersistentState = { pages: 0, charge: 1 };
    output.card.hooks.onRoundAccepted = 'return {persistentState:{pages:ctx.persistentState.pages+1,charge:Math.min(3,ctx.persistentState.charge+1)}};';
    output.card.stateDisplay = [{ key: 'pages', label: '已记页数' }, { key: 'charge', label: '当前充能', max: 3 }];
    const task = tasksAfterSave({ id: 'r', success: true, before: [], after: [sample.entry] })[0];
    const bound = await executeVectorOperation({ kind: 'validate', task, output, attempts: 1 }) as BoundCard;
    const state = { ...initialVectorState(), cards: [bound] };
    const op = { kind: 'prepare' as const, state, entries: [sample.entry], id: 'r2' };
    const prepared = await executeVectorOperation(op) as PreparedVector;
    expect(prepared.progress?.[0].rows.map(r => r.value)).toEqual([0, 1]);
    await executeVectorOperation(op);
    expect(state.session.scriptStates).toEqual({});
    const next = await executeVectorOperation({ kind: 'accept', state, prepared }) as VectorState;
    expect(next.last?.progress?.[0].rows.map(r => [r.value, r.delta])).toEqual([[1, 1], [2, 1]]);
    expect(await executeVectorOperation({ kind: 'accept', state: next, prepared })).toEqual(next);
    expect((await executeVectorOperation({ ...op, state: next, id: 'r3' }) as PreparedVector).progress?.[0].rows.map(r => r.value)).toEqual([1, 2]);
    const legacy = structuredClone(bound); delete legacy.candidate.card.stateDisplay;
    expect(readCardProgress([legacy], next.session)).toEqual([]);
    expect(readCardProgress([bound], { ...state.session, scriptStates: { [bound.ref.hash]: { pages: 7, charge: 2 } } })[0].rows.map(r => r.value)).toEqual([7, 2]);
    const malformed = structuredClone(output);
    malformed.card.stateDisplay = [{ key: 'missing', label: '未知' }, { key: 'pages', label: '' }];
    const stillValid = await executeVectorOperation({ kind: 'validate', task, output: malformed, attempts: 1 }) as BoundCard;
    expect(readCardProgress([stillValid], state.session)).toEqual([]);
  });
  it('shows engine-owned private storage after confirmation without asking the script for a progress counter', async () => {
    const entry = { id: 'cool-pack', kind: 'item' as const, capability: { name: '冷敷包', description: '可用于短暂降温' } };
    const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
    const bound = await executeVectorOperation({ kind: 'validate', task, attempts: 1, output: {
      version: 3,
      card: { hooks: { onVisit: `
        const room=3-(ctx.selfStore['S+']||0);
        const available=ctx.shuttle['S+']||0;
        return {effects:room>0&&available>0?[{kind:'store',store:'self',channel:'S+',amount:Math.min(room,available)}]:[]};
      `, onRoundAccepted: null }, selfStore: { cap: 3, lifetimeRounds: 3, allowedIn: ['S+'], allowedOut: ['S+'] }, initialPersistentState: {} },
    } }) as BoundCard;
    const state = { ...initialVectorState(), cards: [bound], layout: { placements: { '02': entry.id }, tray: [] } };
    const native = { ruleId: 'test', payload: { 'S+': 2, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
    const first = await executeVectorOperation({ kind: 'prepare', state, entries: [entry], id: 'store-1', native }) as PreparedVector;
    expect(first.progress?.[0].rows).toEqual([{ key: 'store:S+', label: 'S+', channel: 'S+', value: 0, max: 3 }]);
    expect(state.session.carriedAccounts).toEqual({});
    const accepted = await executeVectorOperation({ kind: 'accept', state, prepared: first }) as VectorState;
    expect(accepted.last?.progress?.[0].rows[0]).toMatchObject({ value: 2, delta: 2 });
    expect(Object.values(accepted.session.scriptStates ?? {})).toEqual([{}]);
    expect(await executeVectorOperation({ kind: 'accept', state: accepted, prepared: first })).toEqual(accepted);
    const second = await executeVectorOperation({ kind: 'prepare', state: accepted, entries: [entry], id: 'store-2', native }) as PreparedVector;
    expect(second.progress?.[0].rows[0].value).toBe(2);
    const again = await executeVectorOperation({ kind: 'accept', state: accepted, prepared: second }) as VectorState;
    expect(again.last?.progress?.[0].rows[0]).toMatchObject({ value: 3, delta: 1 });
  });
});
