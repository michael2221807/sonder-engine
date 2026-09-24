import { it, expect } from 'vitest';
import { resolveInventoryCommands } from './inventory-commands';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { StateManager } from '../../engine/core/state-manager';
import { CommandExecutor } from '../../engine/core/command-executor';

it('rejects invented update IDs without guessing identities or changing non-inventory commands', () => {
  const input = [
    { action: 'set' as const, key: `${P.inventoryItems}.deep_blue_notebook`, value: { 名称: '本子' } },
    { action: 'set' as const, key: `${P.inventoryItems}.notebook_daily.描述`, value: '第一页' },
    { action: 'set' as const, key: P.weather, value: '晴' },
  ];
  const out = resolveInventoryCommands(input, ['notebook_daily'], 89);
  expect(out.rejected).toHaveLength(1);
  expect(out.commands).toEqual(input.slice(1));
});
it('allocates repeatable collision-free identities for explicitly new same-name items', () => {
  const commands = [
    { action: 'set' as const, key: `${P.inventoryItems}.__new_1`, value: { 名称: '本子', 数量: 1 } },
    { action: 'set' as const, key: `${P.inventoryItems}.__new_2`, value: { 名称: '本子', 数量: 1 } },
    { action: 'set' as const, key: `${P.inventoryItems}.__new_1.描述`, value: '随身携带' },
  ];
  const result = resolveInventoryCommands(commands, ['pv_89_1'], 89);
  expect(result).toEqual(resolveInventoryCommands(commands, ['pv_89_1'], 89));
  expect(result.rejected).toEqual([]);
  const state = new StateManager(); state.loadTree({});
  new CommandExecutor(state).executeBatch(result.commands);
  expect(state.get(`${P.inventoryItems}.pv_89_1_1.描述`)).toBe('随身携带');
  expect(state.get(`${P.inventoryItems}.pv_89_2.名称`)).toBe('本子');
});
it('blocks collection replacement and malformed or uninitialized aliases', () => {
  const paths = [P.inventoryItems, P.inventoryItems.split('.').slice(0, -1).join('.'),
    `${P.inventoryItems}[名称=本子]`, `${P.inventoryItems}.__new_0`, `${P.inventoryItems}.__new_1.描述`];
  const out = resolveInventoryCommands(paths.map(key => ({ action: 'set', key, value: {} })), [], 90);
  expect(out.commands).toEqual([]); expect(out.rejected).toHaveLength(paths.length);
});
