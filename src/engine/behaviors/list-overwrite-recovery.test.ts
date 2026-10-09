import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../core/state-manager';
import { eventBus } from '../core/event-bus';
import { CommandExecutor, schemaArrayItemTypes, schemaDeclaresArray } from '../core/command-executor';
import type { Command, StateChange } from '../types';
import { ListOverwriteRecoveryModule, type ListRecoveryMark } from './list-overwrite-recovery';

const NOW = 1_791_000_000_000;
const PATHS = { narrativeHistory: '元数据.叙事历史', shortTermMemory: '记忆.短期', implicitMidTermMemory: '记忆.隐式中期' };
const list = (items?: Record<string, unknown>) => ({ type: 'array', default: [], ...(items ? { items } : {}) });
const schema = { type: 'object', properties: {
  元数据: { type: 'object', properties: { 叙事历史: { type: 'array' } } },
  社交: { type: 'object', properties: {
    事件: { type: 'object', properties: { 事件记录: list({ type: 'object' }) } },
    关系: list({ type: 'object', properties: { 名称: { type: 'string' }, 记忆: list({ oneOf: [{ type: 'string' }, { type: 'object' }] }) } }),
    标签: list({ type: 'string' }),
    备忘: list({ oneOf: [{ type: 'string' }, { type: 'object' }] }),
  } },
  记忆: { type: 'object', properties: { 短期: list(), 隐式中期: list({ type: 'object' }) } },
  角色: { type: 'object', properties: { 名字: { type: 'string' } } },
  根列表: list(),
} };
const declaresArray = (path: string) => schemaDeclaresArray(schema, path);
const event = (n: number) => ({ 事件名称: `事件${n}`, 事件描述: `描述${n}` });
const memory = (n: number) => ({ 相关角色: ['林晚照'], 事件时间: `第${n}天`, 记忆主体: `隐式记忆${n}` });

/**
 * The round-end type repair as it was before the fix (HEAD 40c83a6), for one field: a top-level declared list holding
 * something else became its default, a missing or null one too; a list inside a list entry was never type-repaired,
 * only default-filled when missing.
 */
function repairBeforeFix(sm: StateManager, path: string): void {
  if (!declaresArray(path)) return;
  const value = sm.get<unknown>(path);
  if (path.includes('[')) {
    if (value === undefined) sm.set(path, []);
  } else if (!Array.isArray(value)) {
    sm.set(path, []);
  }
}

/**
 * A save as it was before the fix: each round's commands run as the executor of the time ran them (a set wrote any
 * value; a push repaired malformed data or refused), the round's changes go on the assistant entry's `_delta`, the
 * round-end type repair of the time runs on the fields the round wrote. Returns the tree as a save holds it (JSON, so
 * a missing value is gone).
 */
function playBeforeFix(start: Record<string, unknown>, rounds: Command[][]): Record<string, unknown> {
  const sm = new StateManager();
  sm.loadTree(start);
  const executor = new CommandExecutor(sm, null, undefined, undefined, declaresArray);
  const history: unknown[] = [];
  rounds.forEach((commands, i) => {
    const changes: StateChange[] = [];
    for (const command of commands) {
      const change = command.action === 'set'
        ? sm.set(command.key, typeof command.value === 'string' ? command.value.trim() : command.value, 'command')
        : executor.execute(command).change;
      if (change) changes.push(change);
    }
    for (const path of new Set(commands.map((c) => c.key))) repairBeforeFix(sm, path);
    history.push({ role: 'user', content: `输入${i}` });
    history.push({ role: 'assistant', content: `正文${i}`, _delta: changes.map((c) => ({ ...c, source: 'main' })) });
  });
  sm.set(PATHS.narrativeHistory, history);
  return JSON.parse(JSON.stringify(sm.toSnapshot())) as Record<string, unknown>;
}

function load(tree: Record<string, unknown>): StateManager {
  const sm = new StateManager();
  sm.loadTree(tree);
  return sm;
}

const recover = (sm: StateManager, withSchema = true) => new ListOverwriteRecoveryModule(
  PATHS,
  withSchema ? declaresArray : undefined,
  withSchema ? (path) => schemaArrayItemTypes(schema, path) : undefined,
).onGameLoad(sm);
/** The mark on round `round`'s record `record` (the assistant entry of round r is history entry 2r + 1). */
const markOf = (sm: StateManager, round: number, record = 0) =>
  sm.get<ListRecoveryMark>(`元数据.叙事历史.${round * 2 + 1}._delta.${record}._recovered`);
const npc = (memories: unknown) => ({ 社交: { 关系: [{ 名称: '林晚照', 记忆: memories }] } });

describe('ListOverwriteRecoveryModule (E1)', () => {
  let emitted: Array<{ name: string; payload: unknown }>;
  const toasts = () => emitted.filter((e) => e.name === 'ui:toast').map((e) => e.payload);

  beforeEach(() => {
    emitted = [];
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(eventBus, 'emit').mockImplementation(((name: string, payload?: unknown) => {
      emitted.push({ name, payload });
    }) as typeof eventBus.emit);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('puts a world-event log back: the old list, the event that was set, then what came after (incident round 131)', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1), event(2)] } } }, [
      [{ action: 'push', key: '社交.事件.事件记录', value: event(3) }],
      [{ action: 'set', key: '社交.事件.事件记录', value: event(4) }],
      [{ action: 'push', key: '社交.事件.事件记录', value: event(5) }],
    ]));
    expect(sm.get('社交.事件.事件记录')).toEqual([event(5)]);
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([1, 2, 3, 4, 5].map(event));
    expect(markOf(sm, 1)).toEqual({ at: NOW, restored: 4 });
    expect(markOf(sm, 0)).toBeUndefined();
    // The result reaches the save with the next save; the load hook never asks for one.
    expect(emitted.map((e) => e.name).filter((name) => name !== 'engine:state-changed')).toEqual(['ui:toast']);
    expect(toasts()[0]).toMatchObject({
      type: 'success', i18nKey: 'engine.toast.listsRecovered', i18nParams: { count: 4, fields: '社交.事件.事件记录 ×4' } });
  });

  it('uses each record once: a second load changes nothing and says nothing', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(2) }],
    ]));
    recover(sm);
    const after = JSON.stringify(sm.toSnapshot());
    recover(load(JSON.parse(after) as Record<string, unknown>));
    recover(sm);
    expect(JSON.stringify(sm.toSnapshot())).toBe(after);
    expect(toasts()).toHaveLength(1);
  });

  it('puts the implicit mid-term memory back when it pairs with the short-term memory (incident round 75)', () => {
    const old = [1, 2, 3, 4, 5].map(memory);
    const sm = load(playBeforeFix({ 记忆: { 短期: ['s1', 's2', 's3', 's4', 's5'], 隐式中期: old } }, [
      [{ action: 'set', key: '记忆.隐式中期', value: '一段文字' }],
    ]));
    expect(sm.get('记忆.隐式中期')).toEqual([]);
    recover(sm);
    expect(sm.get('记忆.隐式中期')).toEqual(old);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 5 });
  });

  it('does not put the implicit mid-term memory back when the pairing would not hold: marked skipped, the player told once', () => {
    const sm = load(playBeforeFix({ 记忆: { 短期: ['s1', 's2', 's3', 's4'], 隐式中期: [1, 2, 3, 4, 5].map(memory) } }, [
      [{ action: 'set', key: '记忆.隐式中期', value: '一段文字' }],
    ]));
    recover(sm);
    expect(sm.get('记忆.隐式中期')).toEqual([]);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 0, skipped: 'pairing' });
    expect(toasts()).toEqual([expect.objectContaining({
      type: 'warning', i18nKey: 'engine.toast.listRecoverySkipped', i18nParams: { fields: '记忆.隐式中期' } })]);
    recover(sm);
    expect(toasts()).toHaveLength(1);
  });

  it('waits while the short-term memory is not a list, and checks nothing when there is nothing to put back', () => {
    const waiting = load(playBeforeFix({ 记忆: { 短期: ['s1'], 隐式中期: [memory(1)] } }, [
      [{ action: 'set', key: '记忆.隐式中期', value: '一段文字' }],
    ]));
    waiting.set('记忆.短期', '坏掉的短期记忆');
    recover(waiting);
    expect(waiting.get('记忆.隐式中期')).toEqual([]);
    expect(markOf(waiting, 0)).toBeUndefined();

    const nothingMissing = load(playBeforeFix({ 记忆: { 短期: ['s1', 's2'], 隐式中期: [memory(1)] } }, [
      [{ action: 'set', key: '记忆.隐式中期', value: '一段文字' }],
    ]));
    nothingMissing.set('记忆.隐式中期', [memory(1)]);
    recover(nothingMissing);
    expect(markOf(nothingMissing, 0)).toEqual({ at: NOW, restored: 0 });
    expect(toasts()).toHaveLength(0);
  });

  it('puts back a list inside a list entry, which the old repair left holding the text that was set', () => {
    const sm = load(playBeforeFix(npc(['第一句', '第二句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第三句' }],
    ]));
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toBe('第三句');
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['第一句', '第二句', '第三句']);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 2 });
    const after = JSON.stringify(sm.toSnapshot());
    recover(sm);
    expect(JSON.stringify(sm.toSnapshot())).toBe(after);
  });

  it('puts back a list inside a list entry left holding the record that was set (a later push onto it was refused)', () => {
    const sm = load(playBeforeFix(npc(['第一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: { 内容: '喂粥' } }],
      [{ action: 'push', key: '社交.关系[名称=林晚照].记忆', value: '第二句' }],
    ]));
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual({ 内容: '喂粥' });
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['第一句', { 内容: '喂粥' }]);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 1 });
  });

  it('puts back every value set onto a list inside a list entry, in order, when the slip was repeated', () => {
    const sm = load(playBeforeFix(npc(['第一句', '第二句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第三句' }],
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第四句' }],
    ]));
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['第一句', '第二句', '第三句', '第四句']);
    expect([0, 1].map((round) => markOf(sm, round))).toEqual([{ at: NOW, restored: 2 }, { at: NOW, restored: 1 }]);
  });

  it('puts back both records when a list was set to one record and then another in the same round', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } } }, [[
      { action: 'set', key: '社交.事件.事件记录', value: event(2) },
      { action: 'set', key: '社交.事件.事件记录', value: event(3) },
    ]]));
    expect(sm.get('社交.事件.事件记录')).toEqual([]);
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([1, 2, 3].map(event));
    expect([markOf(sm, 0, 0), markOf(sm, 0, 1)]).toEqual([{ at: NOW, restored: 1 }, { at: NOW, restored: 2 }]);
  });

  it('writes a list inside a list entry as a list again after it was cleared with {} and then set to a record', () => {
    const sm = load(playBeforeFix(npc(['第一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: {} }],
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: { 内容: '喂粥' } }],
    ]));
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual({ 内容: '喂粥' });
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual([{ 内容: '喂粥' }]);
    expect(markOf(sm, 1)).toEqual({ at: NOW, restored: 0 });
    expect(markOf(sm, 0)).toBeUndefined();
  });

  it('puts the list back where it is missing now: under a field that is there, and at the root', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } }, 根列表: ['甲'] }, [[
      { action: 'set', key: '社交.事件.事件记录', value: '一段文字' },
      { action: 'set', key: '根列表', value: '乙' },
    ]]));
    sm.delete('社交.事件.事件记录');
    sm.delete('根列表');
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([event(1)]);
    expect(sm.get('根列表')).toEqual(['甲']);
  });

  it('counts a set onto a list that was null as an overwrite (nothing to put back, but the record is used)', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } } }, [[
      { action: 'set', key: '社交.事件.事件记录', value: null },
      { action: 'set', key: '社交.事件.事件记录', value: '一段文字' },
    ]]));
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([]);
    expect(markOf(sm, 0, 1)).toEqual({ at: NOW, restored: 0 });
    expect(markOf(sm, 0, 0)).toBeUndefined();
  });

  it('ignores a record that changed nothing: a set or delete on an entry that is not there neither counts nor replaces', () => {
    const sm = load(playBeforeFix(npc(['第一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第二句' }],
      [{ action: 'pull', key: '社交.关系', value: { 名称: '林晚照', 记忆: '第二句' } }],
      [
        { action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第三句' },
        { action: 'delete', key: '社交.关系[名称=林晚照].记忆' },
      ],
    ]));
    const noops = ((sm.get<unknown[]>('元数据.叙事历史.5._delta')) ?? []) as Array<Record<string, unknown>>;
    expect(noops.map((r) => [r.action, r.oldValue, r.newValue])).toEqual([['set', undefined, undefined], ['delete', undefined, undefined]]);
    recover(sm);
    expect(markOf(sm, 0)).toBeUndefined();
    expect([markOf(sm, 2, 0), markOf(sm, 2, 1)]).toEqual([undefined, undefined]);
  });

  it('writes a list left holding a single value as a list even when nothing is missing from it', () => {
    const sm = load(playBeforeFix(npc(['同一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '同一句' }],
    ]));
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toBe('同一句');
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['同一句']);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 0 });
    expect(toasts()).toHaveLength(0);
  });

  it('does not add an entry twice when the list already holds it, and keeps entries the old list held twice', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1), event(1), event(2)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(3) }],
      [
        { action: 'push', key: '社交.事件.事件记录', value: event(1) },
        { action: 'push', key: '社交.事件.事件记录', value: event(3) },
        { action: 'push', key: '社交.事件.事件记录', value: event(4) },
      ],
    ]));
    recover(sm);
    // One of the two copies of 事件1 is there again; the other comes back. 事件3 is there already, so it is not added.
    expect(sm.get('社交.事件.事件记录')).toEqual([1, 2, 1, 3, 4].map(event));
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 2 });
  });

  it('puts a list overwritten more than once back in the order it was written, the repeats onto the emptied list included', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1), event(2)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(3) }],
      [{ action: 'set', key: '社交.事件.事件记录', value: event(4) }],
      [{ action: 'push', key: '社交.事件.事件记录', value: event(5) }],
      [{ action: 'set', key: '社交.事件.事件记录', value: event(6) }],
      [{ action: 'push', key: '社交.事件.事件记录', value: event(7) }],
    ]));
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([1, 2, 3, 4, 5, 6, 7].map(event));
    expect([0, 1, 3].map((round) => markOf(sm, round)?.restored)).toEqual([3, 1, 2]);
    expect(toasts()[0]).toMatchObject({ i18nParams: { count: 6, fields: '社交.事件.事件记录 ×6' } });
  });

  it('puts back the record set where the list was missing', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: {} } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(1) }],
    ]));
    expect(sm.get('社交.事件.事件记录')).toEqual([]);
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([event(1)]);
  });

  it('adds the record that was set only to a list of records: by the item types the schema allows, else by the old entries', () => {
    const tree = playBeforeFix({ 社交: { 标签: ['甲', '乙'], 备忘: ['一', '二'] } }, [[
      { action: 'set', key: '社交.标签', value: { 名称: '丙' } },
      { action: 'set', key: '社交.备忘', value: { 内容: '三' } },
    ]]);
    const sm = load(tree);
    recover(sm);
    expect(sm.get('社交.标签')).toEqual(['甲', '乙']);
    expect(sm.get('社交.备忘')).toEqual(['一', '二', { 内容: '三' }]);

    const withoutItemTypes = load(tree);
    new ListOverwriteRecoveryModule(PATHS, declaresArray).onGameLoad(withoutItemTypes);
    expect(withoutItemTypes.get('社交.备忘')).toEqual(['一', '二']);
  });

  it.each<[string, Command]>([
    ['a later set with a list', { action: 'set', key: '社交.事件.事件记录', value: [event(9)] }],
    ['a later set with null', { action: 'set', key: '社交.事件.事件记录', value: null }],
    ['a later set with an empty object', { action: 'set', key: '社交.事件.事件记录', value: {} }],
    ['a later set of a field holding it', { action: 'set', key: '社交.事件', value: { 事件记录: [event(9)] } }],
    ['a later delete', { action: 'delete', key: '社交.事件.事件记录' }],
  ])('does not put back a list rebuilt or removed afterwards: %s', (_, command) => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1), event(2)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(3) }],
      [command],
    ]));
    const before = sm.get<unknown>('社交.事件.事件记录');
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual(before);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 0, skipped: 'replaced' });
    expect(toasts()).toHaveLength(0);
  });

  it('does not put back a list inside a list entry when the whole outer list was set again afterwards', () => {
    const sm = load(playBeforeFix(npc(['第一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第二句' }],
      [{ action: 'set', key: '社交.关系', value: [{ 名称: '林晚照', 记忆: ['新的开始'] }] }],
    ]));
    recover(sm);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['新的开始']);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 0, skipped: 'replaced' });
  });

  it('treats a set with no value or blank text as an overwrite, as the list guard now refuses both', () => {
    const sm = load(playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] }, 关系: [{ 名称: '林晚照', 记忆: ['第一句'] }] } }, [
      [
        { action: 'set', key: '社交.事件.事件记录' },
        { action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '   ' },
      ],
    ]));
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([event(1)]);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['第一句']);
  });

  it('ignores what is not an overwrite: other actions, a list or a clearing value, a field not declared a list, the history itself', () => {
    const tree = playBeforeFix({
      社交: { 事件: { 事件记录: [event(1)] }, 未声明: [event(1)] },
      角色: { 名字: ['韩'] },
    }, [[
      { action: 'push', key: '社交.事件.事件记录', value: event(2) },
      { action: 'pull', key: '社交.事件.事件记录', value: event(2) },
      { action: 'set', key: '社交.事件.事件记录', value: [event(9)] },
      { action: 'set', key: '社交.事件.事件记录', value: null },
      { action: 'set', key: '社交.事件.事件记录', value: {} },
      { action: 'set', key: '社交.未声明', value: event(3) },
      { action: 'set', key: '角色.名字', value: { 姓: '韩' } },
    ]]);
    (tree.社交 as Record<string, unknown>).未声明 = [event(5)];
    const historyRecord = { path: PATHS.narrativeHistory, action: 'set', oldValue: [{ role: 'user', content: '旧' }], newValue: '坏掉', timestamp: 1 };
    ((tree.元数据 as { 叙事历史: Array<{ _delta?: unknown[] }> }).叙事历史[1]._delta ?? []).push(historyRecord);
    const sm = load(tree);
    const before = JSON.stringify(sm.toSnapshot());
    recover(sm);
    expect(JSON.stringify(sm.toSnapshot())).toBe(before);
    expect(toasts()).toHaveLength(0);
  });

  it('reads a list that is not a list yet as the type repair would make it, and puts it back at once', () => {
    const tree = playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(2) }],
    ]);
    (tree.社交 as { 事件: { 事件记录: unknown } }).事件.事件记录 = event(2);
    const sm = load(tree);
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([event(1), event(2)]);
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 1 });
  });

  it('waits while there is nowhere to put the list: it is null, or the entry holding it is gone', () => {
    const nulled = playBeforeFix({ 社交: { 事件: { 事件记录: [event(1)] } } }, [
      [{ action: 'set', key: '社交.事件.事件记录', value: event(2) }],
    ]);
    (nulled.社交 as { 事件: { 事件记录: unknown } }).事件.事件记录 = null;
    const a = load(nulled);
    recover(a);
    expect(a.get('社交.事件.事件记录')).toBeNull();
    expect(markOf(a, 0)).toBeUndefined();

    const gone = playBeforeFix(npc(['第一句']), [
      [{ action: 'set', key: '社交.关系[名称=林晚照].记忆', value: '第二句' }],
      [{ action: 'pull', key: '社交.关系', value: { 名称: '林晚照', 记忆: '第二句' } }],
    ]);
    const b = load(gone);
    expect(b.get('社交.关系')).toEqual([]);
    recover(b);
    expect(b.get('社交.关系')).toEqual([]);
    expect(markOf(b, 0)).toBeUndefined();
  });

  it('without a schema lookup, only a non-empty old list is evidence of a list', () => {
    const sm = load(playBeforeFix({ 社交: { 未声明: [event(1)], 也未声明: [] } }, [
      [
        { action: 'set', key: '社交.未声明', value: event(2) },
        { action: 'set', key: '社交.也未声明', value: event(3) },
      ],
    ]));
    sm.set('社交.未声明', []);
    sm.set('社交.也未声明', []);
    recover(sm, false);
    expect(sm.get('社交.未声明')).toEqual([event(1), event(2)]);
    expect(sm.get('社交.也未声明')).toEqual([]);
  });

  it('without a schema lookup, a later single value set onto the list is another slip, not a rebuild', () => {
    const sm = load(playBeforeFix({ 社交: { 未声明: [event(1)] } }, [
      [{ action: 'set', key: '社交.未声明', value: event(2) }],
      [{ action: 'set', key: '社交.未声明', value: event(3) }],
    ]));
    expect(sm.get('社交.未声明')).toEqual(event(3));
    recover(sm, false);
    expect(sm.get('社交.未声明')).toEqual([1, 2, 3].map(event));
    expect(markOf(sm, 0)).toEqual({ at: NOW, restored: 2 });
  });

  it('does nothing on a save without history', () => {
    const sm = load({ 社交: { 事件: { 事件记录: [] } } });
    recover(sm);
    expect(sm.get('社交.事件.事件记录')).toEqual([]);
    expect(toasts()).toHaveLength(0);
  });
});
