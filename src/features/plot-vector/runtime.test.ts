import { describe, it, expect } from 'vitest';
import { executeVectorOperation, initialVectorState, type PreparedVector } from './runtime';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { tasksAfterSave, type BoundCard, type SavedElement } from './genesis/post-save';

describe('local AGA board assembly', () => {
  it('keeps new cards in the tray, preserves explicit empty cells, and previews without growing', async () => {
    const entries = POSITIVE_EXAMPLES.map(s => s.entry);
    const tasks = tasksAfterSave({ id: 'saved', success: true, before: [], after: entries });
    const cards = await Promise.all(tasks.map((task, i) => executeVectorOperation({ kind: 'validate', task,
      output: POSITIVE_EXAMPLES[i].output, attempts: 1 }) as Promise<BoundCard>));
    const state = { ...initialVectorState(), cards };
    const untouched = structuredClone(state);
    const first = await executeVectorOperation({ kind: 'prepare', state, entries, id: 'r1' }) as PreparedVector;
    expect(Object.values(first.layout.placements).filter(Boolean)).toEqual([]);
    expect(first.layout.tray).toEqual(entries.map(e => e.id));
    const arranged = { ...state, layout: { placements: { '01': entries[2].id, '02': null, '03': entries[2].id,
      '04': 'removed', '06': entries[0].id }, tray: [] } };
    const preview = await executeVectorOperation({ kind: 'prepare', state: arranged, entries, id: 'r1' }) as PreparedVector;
    expect(preview.layout.placements).toEqual({ '01': entries[2].id, '02': null, '03': null, '04': null, '05': null, '06': null });
    expect(preview.layout.tray).toEqual(entries.slice(0, 2).map(e => e.id));
    expect(state).toEqual(untouched);
    const accepted = await executeVectorOperation({ kind: 'accept', state: arranged, prepared: preview });
    expect(accepted).toHaveProperty('session.round', 2);
    expect(Object.values((accepted as typeof state).session.scriptStates ?? {})).toContainEqual({ pages: 1 });
  });
  it('places at most one status in its fixed slot and never includes statuses in the tray', async () => {
    const entries: SavedElement[] = Array.from({ length: 3 }, (_, i) => ({ id: `${i === 2 ? 'environment' : 'effect'}:${i}`, kind: i === 2 ? 'environment' : 'effect', capability: { name: `状态${i}` } }));
    const tasks = tasksAfterSave({ id: 'saved', success: true, before: [], after: entries });
    const cards = await Promise.all(tasks.map(task => executeVectorOperation({ kind: 'validate', task, output: POSITIVE_EXAMPLES[0].output, attempts: 1 }) as Promise<BoundCard>));
    const op = { kind: 'prepare' as const, state: { ...initialVectorState(), cards }, entries, id: 'round-1' };
    const first = await executeVectorOperation(op) as PreparedVector;
    const again = await executeVectorOperation(op) as PreparedVector;
    expect(Object.values(first.layout.placements).filter(Boolean)).toHaveLength(1);
    expect(first.layout.placements['06']).toMatch(/^(effect|environment):/);
    expect(first.layout.tray).toEqual([]); expect(again.layout).toEqual(first.layout);
  });
  it('removed saved elements cannot retain active abilities or narrative injection', async () => {
    const sample = POSITIVE_EXAMPLES[0];
    const task = tasksAfterSave({ id: 'saved', success: true, before: [], after: [sample.entry] })[0];
    const card = await executeVectorOperation({ kind: 'validate', task, output: sample.output, attempts: 1 }) as BoundCard;
    const result = await executeVectorOperation({ kind: 'prepare', state: { ...initialVectorState(), cards: [card] }, entries: [], id: 'round-2' }) as PreparedVector;
    expect(result.board.cards).toEqual([]); expect(result.prompt).toBe('');
  });
});
