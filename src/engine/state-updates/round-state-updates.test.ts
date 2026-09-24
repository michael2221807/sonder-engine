import { describe, it, expect, vi } from 'vitest';
import { RoundStateUpdates } from './round-state-updates';
import { StateManager } from '../core/state-manager';
import { CommandExecutor } from '../core/command-executor';
import { CommandExecutionStage } from '../pipeline/stages/command-execution';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../pipeline/types';

const contract = { inventoryPath: P.inventoryItems, quantityField: '数量', nameField: '名称',
  accounts: { cash: { path: '角色.背包.金钱.现金', decimals: 2 } } };
function context(): PipelineContext {
  return { userInput: '继续', originalUserInput: '继续', actionQueuePrompt: '', chatHistory: [],
    stateSnapshot: { 角色: { 背包: { 物品: { old: { 名称: '旧物', 数量: 3 } }, 金钱: { 现金: 10 } } } },
    messages: [{ role: 'user', content: '继续' }], worldEventTriggered: false, roundNumber: 9,
    generationId: 'round-9', meta: {} };
}
const reply = (actions: unknown[]) => ({ text: '本轮', parseOk: true, commands: [], customFields: { state_updates: { version: 1, actions } } });
const host = () => new RoundStateUpdates(() => ({ contract, prompt: 'existing protocol' }));

describe('host state synchronization without any board or card adapter', () => {
  it('checks the captured rollout identity before compilation and at save', () => {
    let epoch = 1;
    const sync = new RoundStateUpdates(() => {
      const start = epoch;
      return { contract, prompt: 'existing protocol', guard: () => { if (epoch !== start) throw new Error('mode changed'); } };
    });
    const ctx = sync.prepare(context());
    const out = sync.beforeCommands({ ...ctx, parsedResponse: reply([]) });
    epoch++;
    expect(() => sync.beforeSave(out)).toThrow('mode changed');
    expect(() => sync.beforeCommands(ctx)).toThrow('mode changed');
  });
  it('runs the real pipeline and command executor, keeps old IDs, assigns new IDs and guards raw writes', async () => {
    const sync = host(), ctx = context(), state = new StateManager(); state.loadTree(ctx.stateSnapshot);
    const runner = new PipelineRunner();
    runner.addStage({ name: 'prepare', execute: async c => sync.prepare(c) });
    runner.addStage({ name: 'offline reply', execute: async c => ({ ...c, parsedResponse: {
      ...reply([{ id: 'a', op: 'acquire', ref: '__new_1', item: { 名称: '新物', 数量: 1 } },
        { id: 'b', op: 'consume', ref: 'old', amount: 1 }, { id: 'c', op: 'pay', account: 'cash', amount: 2.5 }]),
      commands: [{ action: 'set', key: '金钱.现金', value: 0 }],
    } }) });
    runner.addStage({ name: 'compile', execute: async c => sync.beforeCommands(c) });
    runner.addStage(new CommandExecutionStage(new CommandExecutor(state, ['角色']), { runAfterCommands: vi.fn() } as never, state, P));
    let saved: unknown;
    runner.addStage({ name: 'save boundary', execute: async c => { sync.beforeSave(c); saved = state.toSnapshot(); return c; } });
    const out = await runner.run(ctx);
    expect(state.get(P.inventoryItems)).toEqual({ old: { 名称: '旧物', 数量: 2 }, pv_9_1: { 名称: '新物', 数量: 1 } });
    expect(state.get(contract.accounts.cash.path)).toBe(7.5);
    expect(out.rejectedCommands).toHaveLength(1);
    expect(saved).toEqual(state.toSnapshot());
    expect(state.get(P.plotVector)).toBeUndefined();
  });

  it('uses frozen baseline, not changes made after prepare', () => {
    const sync = host(), ctx = sync.prepare(context());
    (ctx.stateSnapshot as { 角色: { 背包: { 金钱: { 现金: number } } } }).角色.背包.金钱.现金 = 100;
    const out = sync.beforeCommands({ ...ctx, parsedResponse: reply([{ id: 'a', op: 'pay', account: 'cash', amount: 2 }]) });
    expect(out.parsedResponse?.commands).toContainEqual({ action: 'set', key: contract.accounts.cash.path, value: 8 });
  });

  it('compiles a real-shaped unnumbered transfer before the save boundary', () => {
    const sync = host(), ctx = sync.prepare(context());
    const out = sync.beforeCommands({ ...ctx, parsedResponse: reply([{ op: 'transfer', ref: 'old' }]) });
    expect(out.parsedResponse?.commands).toEqual([{ action: 'delete', key: `${P.inventoryItems}.old` }]);
    expect(() => sync.beforeSave(out)).not.toThrow();
  });

  it('in separate mode reads only the dedicated reply and rejects even an identical direct Step2 item command', async () => {
    const sync = new RoundStateUpdates(() => ({ contract, prompt: 'protocol', source: 'settlement',
      settlementTemplate: 'Narrative: {{NARRATIVE}}' }));
    const start = context(); start.meta.splitGen = true;
    const prepared = sync.prepare(start);
    expect(prepared.meta.stateUpdateSource).toBe('settlement');
    expect(prepared.meta.splitStep2Sources).toBeUndefined();
    expect(prepared.messages).toHaveLength(1);
    expect(sync.settlementInput(prepared)?.baseline.items).toHaveProperty('old');
    prepared.meta.stateSettlementUpdates = { version: 1, actions: [{ op: 'transfer', ref: 'old' }] };
    const direct = { action: 'delete' as const, key: `${P.inventoryItems}.old` };
    const compiled = sync.beforeCommands({ ...prepared, parsedResponse: {
      ...reply([{ op: 'pay', account: 'cash', amount: 10 }]), commands: [direct],
    } });
    expect(compiled.parsedResponse?.commands).toEqual([direct]);
    expect(compiled.rejectedCommands).toMatchObject([{ command: direct, success: false }]);
    const state = new StateManager(); state.loadTree(prepared.stateSnapshot);
    await new CommandExecutionStage(new CommandExecutor(state, ['角色']),
      { runAfterCommands: vi.fn() } as never, state, P).execute(compiled);
    expect(state.get(P.inventoryItems)).toEqual({});
    expect(state.get(contract.accounts.cash.path)).toBe(10);
    expect(() => sync.beforeSave(compiled)).not.toThrow();
  });

  it('rejects a Step2 item write with an omitted root before path relocation', async () => {
    const sync = new RoundStateUpdates(() => ({ contract, prompt: 'protocol', source: 'settlement',
      settlementTemplate: 'Narrative: {{NARRATIVE}}' }));
    const start = context(); start.meta.splitGen = true;
    const prepared = sync.prepare(start);
    prepared.meta.stateSettlementUpdates = { version: 1, actions: [] };
    const direct = { action: 'push' as const, key: '背包.物品.item_missing.名称', value: '纸巾' };
    const compiled = sync.beforeCommands({ ...prepared, parsedResponse: { ...reply([]), commands: [direct] } });
    expect(compiled.parsedResponse?.commands).toEqual([]);
    expect(compiled.rejectedCommands).toMatchObject([{ command: direct, success: false }]);
    const state = new StateManager();
    state.loadTree({ ...prepared.stateSnapshot, 世界: { 节日: { 名称: '平日', 描述: '', 效果: '' } } });
    await new CommandExecutionStage(new CommandExecutor(state, ['角色', '世界']),
      { runAfterCommands: vi.fn() } as never, state, P).execute(compiled);
    expect(state.get(`${P.festival}.名称`)).toBe('平日');
    expect(state.get(P.inventoryItems)).toEqual({ old: { 名称: '旧物', 数量: 3 } });
  });

  it('rejects missing, malformed and uncompiled responses; explicit empty is valid and cannot compile twice', () => {
    const sync = host(), ctx = sync.prepare(context());
    expect(() => sync.beforeSave(ctx)).toThrow('尚未处理');
    expect(() => sync.beforeCommands({ ...ctx, parsedResponse: { text: '', commands: [] } })).toThrow('缺少');
    expect(() => sync.beforeCommands({ ...ctx, parsedResponse: { ...reply([]), parseOk: false } })).toThrow('格式');
    expect(() => sync.beforeCommands({ ...ctx, parsedResponse: reply([{ id: 'bad', op: 'unknown' }]) })).toThrow('unknown operation');
    const out = sync.beforeCommands({ ...ctx, parsedResponse: reply([]) });
    expect(() => sync.beforeSave(out)).not.toThrow();
    expect(() => sync.beforeCommands(out)).toThrow('已处理');
    expect(() => sync.beforeSave({ ...out, parsedResponse: { ...reply([]), parseOk: false } })).toThrow('格式');
  });

  it('does not accept missing sessions, foreign rounds or duplicate preparation', () => {
    const sync = host(), ctx = sync.prepare(context());
    expect(() => sync.prepare(ctx)).toThrow('already prepared');
    expect(() => sync.beforeCommands({ ...ctx, generationId: 'other' })).toThrow('another round');
    expect(() => sync.beforeSave({ ...ctx, roundNumber: 10 })).toThrow('another round');
    expect(() => sync.beforeSave({ ...ctx, meta: { stateUpdatesRequired: true } })).toThrow('session is missing');
  });

  it('leaves disabled and opening paths unchanged', () => {
    const sync = new RoundStateUpdates(() => undefined), ctx = context();
    expect(sync.prepare(ctx)).toBe(ctx); expect(sync.beforeCommands(ctx)).toBe(ctx); sync.beforeSave(ctx);
    expect(ctx.meta).toEqual({});
    const opening = context(); opening.meta.isEnhancedOpening = true;
    expect(host().prepare(opening)).toBe(opening);
    expect(opening.meta.stateUpdatesRequired).toBeUndefined();
  });
});
