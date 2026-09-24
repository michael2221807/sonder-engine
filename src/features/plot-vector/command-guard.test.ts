import { expect, it } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { CommandExecutor } from '../../engine/core/command-executor';
import { compiledCommandGuard } from './command-guard';

it.each(['角色', '角色.背包', '角色.背包.物品', '角色.背包.物品.x', '角色.背包["物品"].x',
  '背包.物品.x', '金钱.现金', '角色.背包.金钱.现金'])('blocks unapproved protected write after relocation: %s', key => {
  const state = new StateManager();
  state.loadTree({ 角色: { 背包: { 物品: {}, 金钱: { 现金: 100 } } } });
  const before = state.toSnapshot();
  const out = new CommandExecutor(state, ['角色']).execute({ action: 'set', key, value: {} },
    compiledCommandGuard(['角色.背包.物品', '角色.背包.金钱.现金'], []));
  expect(out.success).toBe(false);
  expect(state.toSnapshot()).toEqual(before);
});

it('allows only the complete approved command while preserving unrelated state updates', () => {
  const command = { action: 'set' as const, key: '角色.背包.金钱.现金', value: 96.5 };
  const guard = compiledCommandGuard(['角色.背包.金钱.现金'], [command]);
  expect(guard(command)).toBeUndefined();
  expect(guard({ ...command, action: 'add' })).toBeDefined();
  expect(guard({ ...command, value: 1 })).toBeDefined();
  expect(guard({ action: 'set', key: '世界.天气', value: '晴' })).toBeUndefined();
});
