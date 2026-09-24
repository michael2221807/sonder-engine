import { describe, expect, it } from 'vitest';
import { CommandExecutor } from '../../engine/core/command-executor';
import { StateManager } from '../../engine/core/state-manager';
import { compileStateUpdates, type StateUpdateBaseline, type StateUpdateContract } from './state-update-compiler';

const root = '角色.背包.物品';
const contract: StateUpdateContract = {
  inventoryPath: root, quantityField: '数量',
  accounts: { cash: { path: '角色.背包.金钱.现金', decimals: 2 } },
};
const baseline = (): StateUpdateBaseline => ({
  round: 88, items: { tea: { 名称: '茶', 数量: 3 }, book: { 名称: '日记', 数量: 1, 描述: '第一页' } },
  balances: { cash: 100 },
});
function compile(actions: unknown[], base = baseline()) {
  return compileStateUpdates({ version: 1, actions }, base, contract);
}
function apply(actions: unknown[], base = baseline()) {
  const out = compile(actions, base), state = new StateManager();
  state.loadTree({}); state.set(root, structuredClone(base.items)); state.set(contract.accounts.cash.path, base.balances.cash);
  const executor = new CommandExecutor(state), result = executor.executeBatch(out.commands);
  expect(result.hasErrors).toBe(false);
  return { out, state, executor };
}
describe('offline action compiler, synthetic cases (not model-quality evidence)', () => {
  it('accepts an unambiguous decimal amount string without rounding or accepting prose', () => {
    expect(apply([{ id: 'a', op: 'pay', account: 'cash', amount: '3.50' }]).state.get(contract.accounts.cash.path)).toBe(96.5);
    expect(() => compile([{ id: 'a', op: 'pay', account: 'cash', amount: '约3.5元' }])).toThrow();
    expect(compile([{ id: 'a', op: 'pay', account: 'cash', amount: '3.501' }]).notices[0].reason).toBe('money-unsettled');
  });
  it('does not inspect untouched legacy entries and supports consume-then-replenish', () => {
    const base = baseline();
    base.items.broken = 'old'; base.items.odd = { 'old.field[0]': true };
    const { state } = apply([
      { id: 'a', op: 'consume', ref: 'tea', amount: 3 },
      { id: 'b', op: 'replenish', ref: 'tea', amount: 2 },
    ], base);
    expect(state.get(`${root}.tea.数量`)).toBe(2);
    expect(state.get(`${root}.broken`)).toBe('old');
  });
  it('supports zero-quantity replenishment, income and partial transfer', () => {
    const base = baseline(); base.items.tea = { 数量: 0 };
    const { state } = apply([
      { id: 'a', op: 'replenish', ref: 'tea', amount: 3 },
      { id: 'b', op: 'transfer', ref: 'tea', amount: 1 },
      { id: 'c', op: 'receive', account: 'cash', amount: 0.5 },
    ], base);
    expect(state.get(`${root}.tea.数量`)).toBe(2);
    expect(state.get(contract.accounts.cash.path)).toBe(100.5);
  });
  it('does not delete a legacy zero-count entry when only updating its description', () => {
    const base = baseline(); base.items.tea = { 数量: 0, 名称: '茶' };
    expect(apply([{ id: 'a', op: 'update', ref: 'tea', fields: { 描述: '空盒' } }], base)
      .state.get(`${root}.tea`)).toEqual({ 数量: 0, 名称: '茶', 描述: '空盒' });
  });
  it('leaves unclear legacy quantities and balances alone without blocking valid actions', () => {
    const base = baseline(); base.items.tea = { 名称: '茶' }; base.balances.cash = undefined;
    const { out, state } = apply([
      { id: 'a', op: 'consume', ref: 'tea', amount: 1 },
      { id: 'b', op: 'pay', account: 'cash', amount: 2 },
      { id: 'c', op: 'update', ref: 'book', fields: { 描述: '新页' } },
    ], base);
    expect(out.notices.map(n => n.reason)).toEqual(['unknown-quantity', 'money-unsettled']);
    expect(state.get(`${root}.tea.数量`)).toBeUndefined();
    expect(state.get(`${root}.book.描述`)).toBe('新页');
  });
  it('refuses unnamed new entries when the host declares a name field', () => {
    expect(() => compileStateUpdates({ version: 1, actions: [{ id: 'a', op: 'acquire', ref: '__new_1', item: { 数量: 1 } }] },
      baseline(), { ...contract, nameField: '名称' })).toThrow('name');
  });
  it.each(['acquire', 'register_held'])('%s creates a distinct held entry without inferring payment', op => {
    const { state } = apply([{ id: 'a', op, ref: '__new_1', item: { 名称: '日记', 数量: 1 } }]);
    expect(state.get(`${root}.pv_88_1.名称`)).toBe('日记');
    expect(state.get(`${root}.book.描述`)).toBe('第一页');
    expect(state.get(contract.accounts.cash.path)).toBe(100);
  });
  it('transfer without a tracked item cannot create one', () => {
    expect(compile([{ id: 'a', op: 'transfer', ref: null }])).toEqual({
      commands: [], notices: [{ index: 0, reason: 'untracked-transfer' }],
    });
  });
  it('returning a tracked borrowed item removes it', () => {
    expect(apply([{ id: 'a', op: 'transfer', ref: 'book' }]).state.get(`${root}.book`)).toBeUndefined();
  });
  it('accepts the unnumbered whole-item transfer shape returned in D180', () => {
    const { out, state } = apply([{ op: 'transfer', ref: 'book' }]);
    expect(out).toEqual({ commands: [{ action: 'delete', key: `${root}.book` }], notices: [] });
    expect(state.get(`${root}.book`)).toBeUndefined();
    expect(state.get(contract.accounts.cash.path)).toBe(100);
  });
  it('creation then handoff in the same round emits no transient item', () => {
    expect(compile([
      { op: 'acquire', ref: '__new_1', item: { 名称: '药袋', 数量: 1 } },
      { op: 'transfer', ref: '__new_1' },
    ]).commands).toEqual([]);
  });
  it('computes consumption and replenishment in sequence', () => {
    const { state } = apply([
      { id: 'a', op: 'consume', ref: 'tea', amount: 2 },
      { id: 'b', op: 'replenish', ref: 'tea', amount: 5 },
    ]);
    expect(state.get(`${root}.tea.数量`)).toBe(6);
  });
  it('deletes a fully consumed item', () => {
    expect(apply([{ id: 'a', op: 'consume', ref: 'tea', amount: 3 }]).state.get(`${root}.tea`)).toBeUndefined();
  });
  it('preserves fractional current payments using minor units', () => {
    const { state } = apply([
      { id: 'a', op: 'pay', account: 'cash', amount: 3.5 },
      { id: 'b', op: 'pay', account: 'cash', amount: 0.1 },
      { id: 'c', op: 'pay', account: 'cash', amount: 0.2 },
    ]);
    expect(state.get(contract.accounts.cash.path)).toBe(96.2);
  });
  it('unknown account is diagnostic only and never defaults to cash', () => {
    const { state, out } = apply([{ id: 'a', op: 'pay', account: null, amount: 3.5 }]);
    expect(state.get(contract.accounts.cash.path)).toBe(100);
    expect(out.notices).toEqual([{ index: 0, reason: 'unknown-account' }]);
  });
  it('historical recollections require no operation; registration cannot carry a payment', () => {
    expect(compile([]).commands).toEqual([]);
    expect(() => compile([{ id: 'a', op: 'register_held', ref: '__new_1', item: { 数量: 1 }, payment: 700 }])).toThrow('unexpected field');
  });
  it('patches fields while preserving identity and untouched data', () => {
    const { state } = apply([{ id: 'a', op: 'update', ref: 'book', fields: { 描述: '第二页' } }]);
    expect(state.get(`${root}.book`)).toEqual({ 名称: '日记', 数量: 1, 描述: '第二页' });
  });
  it('compiles deterministically against the same baseline; applying its absolute commands twice does not double-debit', () => {
    const actions = [{ id: 'a', op: 'pay', account: 'cash', amount: 3.5 }, { id: 'b', op: 'consume', ref: 'tea', amount: 1 }];
    const base = baseline(), copy = structuredClone(base);
    const { out, state, executor } = apply(actions, base);
    expect(compile(actions, base)).toEqual(out); expect(base).toEqual(copy);
    executor.executeBatch(out.commands);
    expect(state.get(contract.accounts.cash.path)).toBe(96.5);
    expect(state.get(`${root}.tea.数量`)).toBe(2);
  });
  it('does not reuse an existing generated ID', () => {
    const base = baseline(); base.items.pv_88_1 = { 数量: 1 };
    expect(compile([{ id: 'a', op: 'acquire', ref: '__new_1', item: { 数量: 1 } }], base).commands[0].key).toBe(`${root}.pv_88_1_1`);
  });
  it.each([
    { id: 'a', op: 'consume', ref: 'tea', amount: -1 },
    { id: 'a', op: 'consume', ref: 'tea', amount: 0.5 },
    { id: 'a', op: 'consume', ref: 'missing', amount: 1 },
    { id: 'a', op: 'pay', account: 'qr', amount: 1 },
    { id: 'a', op: 'pay', account: 'cash', amount: NaN },
    { id: 'a', op: 'update', ref: 'book', fields: { 数量: 9 } },
    { id: 'a', op: 'update', ref: 'book', fields: JSON.parse('{"__proto__":{}}') },
    { id: 'a', op: 'update', ref: 'book.描述', fields: {} },
    { id: 'a', op: 'register_held', ref: 'invented', item: { 数量: 1 } },
  ])('rejects invalid actions without touching the baseline: %j', action => {
    const base = baseline(), before = structuredClone(base);
    expect(() => compile([{ id: 'first', op: 'consume', ref: 'tea', amount: 1 }, action], base)).toThrow();
    expect(base).toEqual(before);
  });
  it('rejects duplicate action IDs rather than charging twice', () => {
    const action = { id: 'a', op: 'pay', account: 'cash', amount: 1 };
    expect(() => compile([action, action])).toThrow('duplicate action ID');
  });
  it('uses action order for unnumbered actions while validating any explicit IDs', () => {
    const { state } = apply([
      { op: 'pay', account: 'cash', amount: 1 },
      { id: 'numbered', op: 'pay', account: 'cash', amount: 1 },
      { op: 'pay', account: 'cash', amount: 1 },
    ]);
    expect(state.get(contract.accounts.cash.path)).toBe(97);
    expect(() => compile([{ op: 'pay', account: 'cash', amount: 1 },
      { id: 'numbered', op: 'pay', account: 'cash', amount: 1 },
      { id: 'numbered', op: 'receive', account: 'cash', amount: 1 }])).toThrow('duplicate action ID');
    expect(() => compile([{ id: null, op: 'pay', account: 'cash', amount: 1 }])).toThrow('invalid reference');
  });
  it('rejects overlapping account paths', () => {
    expect(() => compileStateUpdates({ version: 1, actions: [] }, baseline(), {
      ...contract, accounts: { one: { path: root, decimals: 2 } },
    })).toThrow('overlapping');
  });
  it('rejects a resulting balance the host would silently clamp', () => {
    const base = baseline(); base.balances.cash = 1_000_001;
    expect(compile([{ id: 'a', op: 'pay', account: 'cash', amount: 1 }], base)).toEqual({ commands: [], notices: [{ index: 0, reason: 'money-unsettled' }] });
  });
  it('rejects missing version, missing actions, unknown fields and excessive actions', () => {
    for (const raw of [{}, { version: 1 }, { version: 2, actions: [] }, { version: 1, actions: [], commands: [] },
      { version: 1, actions: Array.from({ length: 101 }, () => ({})) }]) {
      expect(() => compileStateUpdates(raw, baseline(), contract)).toThrow();
    }
  });
  it('rejects reusing a creation alias even after its item has left', () => {
    expect(() => compile([
      { id: 'a', op: 'acquire', ref: '__new_1', item: { 数量: 1 } },
      { id: 'b', op: 'transfer', ref: '__new_1' },
      { id: 'c', op: 'acquire', ref: '__new_1', item: { 数量: 1 } },
    ])).toThrow('fresh');
  });
});
