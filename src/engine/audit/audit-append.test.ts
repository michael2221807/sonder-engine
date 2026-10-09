/**
 * Tests for appendChangesToLastNarrative — the helper that funnels
 * sub-pipeline change logs into the most recent assistant narrative entry's
 * `_delta` array so DeltaViewer shows a unified audit trail.
 */
import { describe, expect, it, vi } from 'vitest';

import { appendChangesToLastNarrative } from './audit-append';
import { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { StateChange } from '../types/state';

type NarrativeEntry = Record<string, unknown>;

function makeStateManager(history: NarrativeEntry[]): { sm: StateManager; read: () => NarrativeEntry[] } {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 叙事历史: history } });
  return { sm, read: () => JSON.parse(JSON.stringify(sm.get(DEFAULT_ENGINE_PATHS.narrativeHistory))) as NarrativeEntry[] };
}

function change(path: string, action: StateChange['action'] = 'set'): StateChange {
  return { path, action, oldValue: 'old', newValue: 'new', timestamp: 0 };
}

const PATHS: EnginePathConfig = DEFAULT_ENGINE_PATHS;

describe('appendChangesToLastNarrative', () => {
  it('is a no-op when changes[] is empty', () => {
    const { sm, read } = makeStateManager([
      { role: 'assistant', content: 'x' },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', []);
    expect(read()[0]._delta).toBeUndefined();
  });

  it('is a no-op when narrative history is missing or empty', () => {
    const { sm, read } = makeStateManager([]);
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', [change('社交.关系[0].外貌描述')]);
    expect(read()).toEqual([]);
  });

  it('is a no-op when no assistant entry exists yet', () => {
    const { sm, read } = makeStateManager([
      { role: 'user', content: 'hi' },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', [change('社交.关系[0].外貌描述')]);
    expect(read()[0]._delta).toBeUndefined();
  });

  it('appends to the last assistant entry with source tag', () => {
    const { sm, read } = makeStateManager([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', [change('社交.关系[0].外貌描述')]);
    const entry = read()[1];
    expect(Array.isArray(entry._delta)).toBe(true);
    const delta = entry._delta as Array<{ source?: string; path: string }>;
    expect(delta[0].source).toBe('fieldRepair');
    expect(delta[0].path).toBe('社交.关系[0].外貌描述');
  });

  it('preserves existing _delta entries (multiple sub-pipelines share the array)', () => {
    const prior: StateChange & { source?: string } = { ...change('主线路径'), source: 'main' };
    const { sm, read } = makeStateManager([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a', _delta: [prior] },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'worldHeartbeat', [
      change('社交.关系[0].位置'),
      change('社交.关系[0].在做事项'),
    ]);
    const delta = read()[1]._delta as Array<{ source?: string; path: string }>;
    expect(delta).toHaveLength(3);
    expect(delta.map((d) => d.source)).toEqual(['main', 'worldHeartbeat', 'worldHeartbeat']);
  });

  it('attaches source to every change in the batch', () => {
    const { sm, read } = makeStateManager([
      { role: 'assistant', content: 'a' },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'privacyRepair', [
      change('社交.关系[0].私密信息.是否为处女/处男'),
      change('社交.关系[0].私密信息.性格倾向'),
    ]);
    const delta = read()[0]._delta as Array<{ source?: string }>;
    expect(delta.every((d) => d.source === 'privacyRepair')).toBe(true);
  });

  // 存档瘦身 D3A: a push or pull is stored with its one entry; only that entry's _delta is written.
  it('stores a push or pull with the one entry it added or removed, next to records already stored either way', () => {
    const before = [{ 事件名称: '甲' }];
    const push: StateChange = { path: '社交.事件.事件记录', action: 'push', oldValue: before, newValue: [...before, { 事件名称: '乙' }], timestamp: 2 };
    const pull: StateChange = { path: '角色.效果', action: 'pull', oldValue: ['中毒', '疲惫'], newValue: ['中毒'], timestamp: 3 };
    const oldForm = { path: '社交.事件.事件记录', action: 'push', oldValue: [], newValue: before, timestamp: 1, source: 'main' };
    const compactForm = { path: '角色.背包', action: 'push', element: '药', timestamp: 1, source: 'main' };
    const { sm, read } = makeStateManager([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a', _delta: [oldForm, compactForm] },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'worldHeartbeat', [push, pull, change('角色.姓名')]);
    expect(read()[1]._delta).toEqual([
      oldForm,
      compactForm,
      { path: '社交.事件.事件记录', action: 'push', element: { 事件名称: '乙' }, timestamp: 2, source: 'worldHeartbeat' },
      { path: '角色.效果', action: 'pull', element: '疲惫', index: 1, timestamp: 3, source: 'worldHeartbeat' },
      { ...change('角色.姓名'), source: 'worldHeartbeat' },
    ]);
  });

  it('writes only that entry\'s _delta, not the whole history', () => {
    const { sm } = makeStateManager([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ]);
    const set = vi.spyOn(sm, 'set');
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', [change('x')]);
    expect(set.mock.calls.map((call) => call[0])).toEqual([`${DEFAULT_ENGINE_PATHS.narrativeHistory}.1._delta`]);
  });

  it('finds the MOST RECENT assistant entry when multiple exist', () => {
    const { sm, read } = makeStateManager([
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a2' },
    ]);
    appendChangesToLastNarrative(sm, PATHS, 'fieldRepair', [change('x')]);
    expect((read()[0] as NarrativeEntry)._delta).toBeUndefined();
    expect(Array.isArray((read()[2] as NarrativeEntry)._delta)).toBe(true);
  });
});
