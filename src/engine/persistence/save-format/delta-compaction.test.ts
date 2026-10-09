import { describe, it, expect } from 'vitest';
import { StateManager } from '../../core/state-manager';
import type { StateChange } from '../../types';
import { compactChangeRecord, compactChangeRecords, compactHistoryDeltas, isCompactListChange } from './delta-compaction';

const event = (n: number) => ({ 事件名称: `事件${n}`, 事件描述: `描述${n}` });
const tagged = (change: StateChange) => ({ ...change, source: 'main' });

/** Change records exactly as StateManager writes them. */
function recorded(start: Record<string, unknown>, write: (sm: StateManager) => StateChange): ReturnType<typeof tagged> {
  const sm = new StateManager();
  sm.loadTree(start);
  return tagged(write(sm));
}

describe('delta compaction (D3A)', () => {
  it('keeps only the appended entry of a push', () => {
    const record = recorded({ 社交: { 事件: { 事件记录: [event(1), event(2)] } } }, (sm) => sm.push('社交.事件.事件记录', event(3)));
    expect(compactChangeRecord(record)).toEqual({ path: '社交.事件.事件记录', action: 'push', element: event(3), timestamp: record.timestamp, source: 'main' });
  });

  it('keeps only the entry of a push that started a list that was not there', () => {
    const record = recorded({ 社交: {} }, (sm) => sm.push('社交.标签', '甲'));
    expect(record.oldValue).toBeUndefined();
    expect(compactChangeRecord(record)).toEqual({ path: '社交.标签', action: 'push', element: '甲', timestamp: record.timestamp, source: 'main' });
    expect(compactChangeRecord({ path: 'a', action: 'push', oldValue: null, newValue: ['x'] })).toEqual({ path: 'a', action: 'push', element: 'x' });
  });

  it('keeps the removed entry and its position of a pull, wherever it was', () => {
    for (const [n, index] of [[1, 0], [2, 1], [3, 2]] as const) {
      const record = recorded({ 列表: [event(1), event(2), event(3)] }, (sm) => sm.pull('列表', event(n)));
      expect(compactChangeRecord(record)).toEqual({ path: '列表', action: 'pull', element: event(n), index, timestamp: record.timestamp, source: 'main' });
    }
    // With equal neighbours any of them gives the same list: the index is where the two lists first differ.
    const repeated = recorded({ 列表: ['甲', '甲', '乙'] }, (sm) => sm.pull('列表', '甲'));
    expect(compactChangeRecord(repeated)).toMatchObject({ element: '甲', index: 1 });
  });

  it('keeps as they are: set, delete, add, a push onto a value that was not a list, pushes and pulls that did not move exactly one entry', () => {
    const records = [
      recorded({ 列表: [event(1)] }, (sm) => sm.set('列表', event(9))),
      recorded({ 列表: [event(1)] }, (sm) => sm.set('列表', [event(1), event(2)])),
      recorded({ 列表: [event(1), event(2)] }, (sm) => sm.set('列表', [event(2)])),
      recorded({ 列表: [event(1)] }, (sm) => sm.delete('列表')),
      recorded({ 数: 1 }, (sm) => sm.add('数', 2)),
      recorded({ 列表: '一段文字' }, (sm) => sm.push('列表', '新的')),
      recorded({ 列表: [event(1)] }, (sm) => sm.pull('列表', event(9))),
      recorded({ 社交: { 关系: [] } }, (sm) => sm.push('社交.关系[名称=没有].记忆', 'x')),
      { path: '列表', action: 'push', oldValue: [1, 2], newValue: [9, 2, 3] },
      { path: '列表', action: 'push', oldValue: [1], newValue: [1, 2, 3] },
      { path: '列表', action: 'push', oldValue: [1, 2], newValue: [1, 9, 3] },
      { path: '列表', action: 'pull', oldValue: [1, 2, 3], newValue: [3] },
      { path: '列表', action: 'pull', oldValue: [1, 2, 3], newValue: [2, 1] },
      { action: 'push', oldValue: [], newValue: [1] },
      { path: '列表', action: 'push', oldValue: undefined, newValue: [1, 2] },
      { path: '列表', action: 'push', newValue: [1, 2] },
      'not a record',
    ];
    for (const record of records) expect(compactChangeRecord(record)).toBe(record);
  });

  it('is idempotent and keeps extra fields', () => {
    const record = { ...recorded({ 列表: [1] }, (sm) => sm.push('列表', 2)), extra: { a: 1 } };
    const once = compactChangeRecord(record);
    expect(compactChangeRecord(once)).toBe(once);
    expect(once).toMatchObject({ extra: { a: 1 }, element: 2 });
    expect(Object.keys(once as object)).not.toContain('oldValue');
    expect(Object.keys(once as object)).not.toContain('newValue');
  });

  it('compacts a whole round of records, each by its own rule, and tells a compacted record apart', () => {
    const sm = new StateManager();
    sm.loadTree({ 列表: [event(1)], 名字: '甲' });
    const round = [sm.push('列表', event(2)), sm.set('名字', '乙'), sm.pull('列表', event(1))].map(tagged);
    const stored = compactChangeRecords(round);
    expect(stored.map(isCompactListChange)).toEqual([true, false, true]);
    expect(stored[1]).toBe(round[1]);
    expect(round.map(isCompactListChange)).toEqual([false, false, false]);
    expect(isCompactListChange({ path: 'x', action: 'push', element: undefined })).toBe(true);
    expect(isCompactListChange({ path: 'x', action: 'set', element: 1 })).toBe(false);
    expect(isCompactListChange({ path: 'x', action: 'push' })).toBe(false);
    expect(isCompactListChange({ path: 'x', action: 'push', element: 1, oldValue: [] })).toBe(false);
    expect(isCompactListChange({ path: 'x', action: 'pull', element: 1, newValue: [] })).toBe(false);
    expect(isCompactListChange({ path: 'x', action: 'pull', element: 1, index: 0 })).toBe(true);
  });

  it('returns the same list when nothing compacts, so a caller can tell nothing changed', () => {
    const sm = new StateManager();
    sm.loadTree({ 列表: [1], 名字: '甲' });
    const sets = [sm.set('名字', '乙'), sm.set('名字', '丙')].map(tagged);
    expect(compactChangeRecords(sets)).toBe(sets);
    const withPush = [...sets, tagged(sm.push('列表', 2))];
    const stored = compactChangeRecords(withPush);
    expect(stored).not.toBe(withPush);
    expect(stored[0]).toBe(withPush[0]);
  });

  it('compacts the stored records of a whole history, keeping untouched entries and the list itself when nothing compacts', () => {
    const sm = new StateManager();
    sm.loadTree({ 列表: [1], 名字: '甲' });
    const user = { role: 'user', content: '一' };
    const setOnly = { role: 'assistant', content: '二', _delta: [tagged(sm.set('名字', '乙'))] };
    const withPush = { role: 'assistant', content: '三', _delta: [tagged(sm.push('列表', 2))] };
    const history = [user, setOnly, withPush];
    const stored = compactHistoryDeltas(history) as Array<Record<string, unknown>>;
    expect(stored).not.toBe(history);
    expect(stored[0]).toBe(user);
    expect(stored[1]).toBe(setOnly);
    expect(stored[2]).toEqual({ ...withPush, _delta: [expect.objectContaining({ action: 'push', element: 2 })] });
    expect(compactHistoryDeltas(stored)).toBe(stored);
    expect(compactHistoryDeltas([user, setOnly])).toEqual([user, setOnly]);
    const unchanged = [user, setOnly];
    expect(compactHistoryDeltas(unchanged)).toBe(unchanged);
    expect(withPush._delta[0]).toHaveProperty('oldValue');
  });
});
