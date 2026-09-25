import { RoundStateUpdates } from '../../engine/state-updates/round-state-updates';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { CommandExecutor } from '../../engine/core/command-executor';
import { ResponseParser } from '../../engine/ai/response-parser';
import { CommandExecutionStage } from '../../engine/pipeline/stages/command-execution';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import { AgaPlotVectorAdapter } from './aga-adapter';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorState, type VectorOperation, type VectorResult } from './runtime';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { tasksAfterSave, stable, type BoundCard } from './genesis/post-save';
import { GENESIS_VALIDATION_REVISION } from './genesis/generation-prompt';
import { projectSavedElements } from './saved-elements';
import rulesJSON from '../../../public/packs/tianming/rules/plot-vector.json';
import { parseNativeRules } from './native-input';
import { parseVectorPromptPolicy } from './prompt-policy';
import { RequestJournal, type RequestStore } from './request-journal';
import { FieldRepairPipeline } from '../../engine/pipeline/sub-pipelines/field-repair';
import type { AIService } from '../../engine/ai/ai-service';
import type { PromptAssembler } from '../../engine/prompt/prompt-assembler';
import type { GamePack } from '../../engine/types';
import type { AIMessage, APIConfig, GenerationCheckpoint } from '../../engine/ai/types';
import promptRules from '../../../public/packs/tianming/rules/plot-vector-prompts.json';

let adapters: AgaPlotVectorAdapter[];
beforeEach(() => {
  adapters = [];
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { adapters.forEach(a => a.dispose()); vi.unstubAllGlobals(); });
function setup(journal?: RequestJournal) {
  const state = new StateManager(); state.loadTree({});
  let slot = { profileId: 'p', slotId: 's' };
  let disk: unknown;
  const ai = { generate: vi.fn(async () => JSON.stringify(POSITIVE_EXAMPLES[0].output)) };
  const saveGame = vi.fn(async (_p: string, _s: string, data: unknown, _meta?: unknown,
    commit?: { guard: () => void; committed: () => void }) => {
    commit?.guard(); disk = structuredClone(data); commit?.committed();
  });
  const worker = { execute: vi.fn(<T extends VectorResult>(op: VectorOperation) => executeVectorOperation(op) as Promise<T>), cancelAll: vi.fn() };
  const assertCurrent = vi.fn(async () => {});
  const adapter = new AgaPlotVectorAdapter(state, ai, { saveGame, assertCurrent }, () => slot, {
    execute: <T extends VectorResult>(op: VectorOperation) => worker.execute(op) as Promise<T>, cancelAll: worker.cancelAll,
  }, journal ?? new RequestJournal(new MemoryRequests()), parseNativeRules(rulesJSON), parseVectorPromptPolicy(promptRules, 'mode contract', 'state update contract')); adapters.push(adapter);
  const sync = new RoundStateUpdates(() => ({ contract: promptRules.stateUpdates, prompt: 'state update contract' }));
  const ctx = (): PipelineContext => ({ generationId: crypto.randomUUID(), roundNumber: 1, stateSnapshot: state.toSnapshot(),
    userInput: '继续', actionQueuePrompt: '', chatHistory: [], worldEventTriggered: false, messages: [{ role: 'user', content: '继续' }], meta: { plotVectorLifecycle: {} } });
  return { state, ai, saveGame, assertCurrent, worker, adapter, sync, ctx, changeSlot: () => { slot = { ...slot, slotId: 'other' }; },
    setSlot: (slotId: string) => { slot = { ...slot, slotId }; }, disk: () => disk };
}
describe('AGA opt-in integration (zero network)', () => {
  it('records a post-save generation transport error as failed without rolling back or automatically resending', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx());
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    h.ai.generate.mockRejectedValueOnce(new Error('API 错误 503'));
    await expect(h.adapter.afterSave(ctx)).resolves.toBeUndefined();
    expect(h.state.get<VectorState>(P.plotVector)!.tasks[0]).toMatchObject({ status: 'failed', error: 'Error: API 错误 503' });
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    const next = await h.adapter.prepare(h.ctx());
    await h.adapter.beforeSave(next); next.meta.plotVectorCommitted!(); await h.adapter.afterSave(next);
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
  });
  it('compiles parsed actions from a frozen baseline, blocks relocated raw writes, then creates tasks only at save', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set('角色.背包.金钱.现金', 100);
    h.state.set(P.inventoryItems, {});
    const start = h.ctx(); h.adapter.promptTransform(start);
    const prepared = await h.adapter.prepare(h.sync.prepare(start));
    h.state.set('角色.背包.金钱.现金', 99); // Never becomes the compilation baseline.
    const parsed = new ResponseParser().parse(JSON.stringify({ text: '买好本子。', commands: [
      { action: 'set', key: '金钱.现金', value: 1 },
      { action: 'set', key: '背包.物品.invented', value: { 名称: '不应出现' } },
    ], state_updates: { version: 1, actions: [
      { id: 'a', op: 'acquire', ref: '__new_1', item: { 名称: '本子', 数量: 1 } },
      { id: 'b', op: 'pay', account: 'cash', amount: 3.5 },
    ] } }));
    const ctx = h.adapter.beforeCommands(h.sync.beforeCommands({ ...prepared, parsedResponse: parsed }));
    const stage = new CommandExecutionStage(new CommandExecutor(h.state, ['角色']),
      { runAfterCommands: vi.fn() } as never, h.state, P);
    const executed = await stage.execute(ctx);
    expect(executed.commandResults?.results.filter(r => !r.success)).toHaveLength(2);
    expect(h.state.get('角色.背包.金钱.现金')).toBe(96.5);
    expect(h.state.get(`${P.inventoryItems}.invented`)).toBeUndefined();
    expect(h.state.get(`${P.inventoryItems}.pv_1_1.名称`)).toBe('本子');
    expect(() => h.sync.beforeCommands({ ...prepared, parsedResponse: parsed })).toThrow('重复执行');
    expect(h.ai.generate).not.toHaveBeenCalled();
    await h.adapter.beforeSave(executed);
    expect(h.state.get<VectorState>(P.plotVector)?.tasks).toHaveLength(1);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('requires an explicit action envelope in active mode; empty actions are valid', async () => {
    const h = setup(); writePlotVectorControl(true);
    const start = h.ctx(); h.adapter.promptTransform(start);
    const prepared = await h.adapter.prepare(h.sync.prepare(start));
    const missing = { ...prepared, parsedResponse: { text: '安静的一天', commands: [], parseOk: true } };
    expect(() => h.sync.beforeCommands(missing)).toThrow();
    expect(() => h.sync.beforeSave(missing)).toThrow('尚未处理');
    const valid = h.sync.beforeCommands({ ...missing, parsedResponse: { ...missing.parsedResponse,
      customFields: { state_updates: { version: 1, actions: [] } } } });
    await expect(h.adapter.beforeSave(valid)).resolves.toBeUndefined();
  });
  it('blocks rootless inventory writes even under the previous command protocol', async () => {
    const h = setup(); writePlotVectorControl(true); h.state.set(P.inventoryItems, {});
    const prepared = await h.adapter.prepare(h.ctx());
    const ctx = h.adapter.beforeCommands({ ...prepared, parsedResponse: { text: 'test', commands: [
      { action: 'set', key: '背包.物品.fake', value: { 名称: 'fake' } },
    ] } });
    const stage = new CommandExecutionStage(new CommandExecutor(h.state, ['角色']),
      { runAfterCommands: vi.fn() } as never, h.state, P);
    const out = await stage.execute(ctx);
    expect(out.commandResults?.hasErrors).toBe(true);
    expect(h.state.get(`${P.inventoryItems}.fake`)).toBeUndefined();
  });
  for (const commands of [undefined, []]) it(`blocks unrepaired structure before commands and before acceptance, commands=${String(commands)}`, async () => {
    const h = setup(); writePlotVectorControl(true);
    const prepared = await h.adapter.prepare(h.ctx());
    const before = h.state.toSnapshot();
    const broken = { ...prepared, parsedResponse: { text: '东西买好了。', commands, parseOk: false } };
    expect(() => h.adapter.beforeCommands(broken)).toThrow('未获得可保存的结果');
    await expect(h.adapter.beforeSave(broken)).rejects.toThrow('未获得可保存的结果');
    expect(h.state.toSnapshot()).toEqual(before);
    expect(h.worker.execute.mock.calls.filter(([op]) => op.kind === 'accept')).toHaveLength(0);
    expect(h.saveGame).not.toHaveBeenCalled();
    expect(h.ai.generate).not.toHaveBeenCalled();
    const repaired = { ...broken, parsedResponse: { ...broken.parsedResponse, commands: [], parseOk: true } };
    expect(() => h.adapter.beforeCommands(repaired)).not.toThrow();
    await expect(h.adapter.beforeSave(repaired)).resolves.toBeUndefined();
  });
  it('does not change legacy off-mode handling of an unsuccessful parse', async () => {
    const h = setup(); const ctx = { ...h.ctx(), parsedResponse: { text: 'raw', parseOk: false } };
    expect(h.adapter.beforeCommands(ctx)).toBe(ctx);
    await h.adapter.beforeSave(ctx);
    expect(h.worker.execute).not.toHaveBeenCalled();
  });
  for (const roles of [
    ['system', 'user'],
    ['system', 'user', 'assistant'],
    ['system', 'assistant', 'assistant', 'system', 'user', 'assistant'],
    ['system', 'user', 'assistant', 'user', 'assistant', 'assistant'],
    ['system', 'assistant'],
    [],
  ] as const) it(`inserts impulse before the final user without changing originals: ${roles.join('/')}`, async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 魅力: 10 });
    const c = h.ctx();
    c.messages = roles.map((role, i) => ({ role, content: `original-${i}` }));
    c.messageSources = roles.map((_, i) => `source-${i}`);
    const originals = structuredClone(c.messages), sources = [...c.messageSources];
    h.adapter.promptTransform(c);
    const out = await h.adapter.prepare(c);
    const added = out.messageSources!.flatMap((s, i) => s.startsWith('plot-vector') || s === 'environment-ability' ? [i] : []);
    expect(added).toHaveLength(3); // mode, impulse, and (single call writes environment) the environment-ability interface
    expect(String(out.messages[out.messageSources!.indexOf('environment-ability')].content)).toContain('onVisit');
    const user = out.messages.map(m => m.role).lastIndexOf('user');
    if (user >= 0) expect(added.every(i => i < user)).toBe(true);
    else expect(added).toEqual([0, 1, 2]);
    expect(out.messages.filter((_, i) => !added.includes(i))).toEqual(originals);
    expect(out.messageSources!.filter((_, i) => !added.includes(i))).toEqual(sources);
    expect(c.messages).toEqual(originals);
    expect(out.messages).toHaveLength(out.messageSources!.length);
  });
  it('keeps mode even with no impulse and gives Step2 the contracts (state updates, environment abilities), not the vector', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); c.meta.splitStep2Messages = [{ role: 'system', content: 'commands' }];
    expect(h.adapter.promptTransform(c)).toBeTypeOf('function');
    const result = await h.adapter.prepare(h.sync.prepare(c));
    expect(result.messageSources).toContain('plot-vector-mode');
    expect(result.messages.find(m => m.content === 'mode contract')).toBeDefined();
    expect(result.meta.splitStep2Messages!.slice(1)).toEqual([{ role: 'system', content: 'state update contract' }, { role: 'system', content: 'commands' }]);
    expect(result.meta.splitStep2Sources).toEqual(['environment-ability', 'state-update-protocol', 'unknown']);
    expect(String(result.meta.splitStep2Messages![0].content)).toContain('onVisit');
    // The vector itself (axes and values) stays out of Step2.
    expect(result.meta.splitStep2Messages!.some(m => typeof m.content === 'string' && m.content.includes('维度说明与数值'))).toBe(false);
    expect(result.messageSources).not.toContain('plot-vector');
  });
  it('rejects mode changes during context assembly in either direction', async () => {
    const h = setup();
    const off = h.ctx(); expect(h.adapter.promptTransform(off)).toBeUndefined();
    writePlotVectorControl(true);
    await expect(h.adapter.prepare(off)).rejects.toThrow('组装期间');
    const on = h.ctx(); h.adapter.promptTransform(on); writePlotVectorControl(false);
    await expect(h.adapter.prepare(on)).rejects.toThrow('组装期间');
    expect(h.worker.execute).not.toHaveBeenCalled();
  });
  it('invalidates a context assembled for a different loaded slot', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); h.adapter.promptTransform(c); h.changeSlot();
    await expect(h.adapter.prepare(c)).rejects.toThrow('存档已切换');
    expect(c.meta.plotVectorLifecycle?.invalidated).toBe(true);
    expect(h.worker.execute).not.toHaveBeenCalled();
  });
  it('does not adapt enhanced opening or mutate persisted CoT preferences', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set('系统.设置.cot', { enabled: true, judgeEnabled: true });
    const before = h.state.toSnapshot();
    const c = h.ctx(); c.meta.isEnhancedOpening = true;
    expect(h.adapter.promptTransform(c)).toBeUndefined();
    expect(await h.adapter.prepare(c)).toBe(c);
    expect(h.state.toSnapshot()).toEqual(before);
    expect(h.worker.execute).not.toHaveBeenCalled();
  });
  it('injects saved attributes with no cards; a new environment tag never queues a post-save generation', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 心性: 10, 悟性: 15 });
    const ctx = await h.adapter.prepare(h.ctx());
    expect(ctx.messageSources).toContain('plot-vector');
    expect(h.worker.execute.mock.calls[0][0]).toMatchObject({ native: { visitBudget: 11, payload: { 'S+': 2 } } });
    h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]);
    await h.adapter.beforeSave(ctx);
    expect(h.state.get<VectorState>(P.plotVector)?.tasks).toEqual([]);
    ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
    // Written without its ability: this round's Step3 gets one repair task for it.
    expect((await h.adapter.abilityRepairTask())?.block).toContain('微风');
  });
  it('rejects a stale loaded slot before executing cards or calling a model', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.assertCurrent.mockRejectedValue(new Error('stale'));
    await expect(h.adapter.prepare(h.ctx())).rejects.toThrow('stale');
    expect(h.worker.execute).not.toHaveBeenCalled(); expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('off means identical context, no worker, no generation, no component state writes', async () => {
    const h = setup(), ctx = h.ctx();
    expect(await h.adapter.prepare(ctx)).toBe(ctx);
    await h.adapter.beforeSave(ctx); await h.adapter.afterSave(ctx);
    expect(h.worker.execute).not.toHaveBeenCalled(); expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get(P.plotVector)).toBeUndefined();
    const withCommands = { ...ctx, parsedResponse: { text: '', commands: [
      { action: 'set' as const, key: `${P.inventoryItems}.old_style`, value: { 名称: '普通物品' } },
    ] } };
    expect(h.adapter.beforeCommands(withCommands)).toBe(withCommands);
  });
  it('resolves item references before real command execution and reports unknown IDs as failures', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { book: { 名称: '日记', 描述: '原记录' } });
    const prepared = await h.adapter.prepare(h.ctx());
    const commands = [
      { action: 'set' as const, key: `${P.inventoryItems}.invented`, value: { 名称: '日记' } },
      { action: 'set' as const, key: `${P.inventoryItems}.book.描述`, value: '新记录' },
      { action: 'set' as const, key: `${P.inventoryItems}.__new_1`, value: { 名称: '日记', 描述: '新买的另一本' } },
    ];
    const input = { ...prepared, parsedResponse: { text: '', commands } };
    const resolved = h.adapter.beforeCommands(input);
    const stage = new CommandExecutionStage(new CommandExecutor(h.state),
      { runAfterCommands: vi.fn() } as unknown as import('../../engine/pipeline/types').IBehaviorRunner, h.state, P);
    const executed = await stage.execute(resolved);
    expect(executed.commandResults?.hasErrors).toBe(true);
    expect(executed.commandResults?.results.filter(r => !r.success)).toHaveLength(1);
    expect(h.state.get(`${P.inventoryItems}.invented`)).toBeUndefined();
    expect(h.state.get(`${P.inventoryItems}.book.描述`)).toBe('新记录');
    expect(h.state.get(`${P.inventoryItems}.pv_1_1.名称`)).toBe('日记');
    expect(input.parsedResponse.commands).toBe(commands);
    await h.adapter.beforeSave(executed);
    expect(h.state.get<VectorState>(P.plotVector)!.tasks.map(r => r.task.entry.id)).toEqual(['item:pv_1_1']);
  });
  it('saved new entry generates once, board absent from prompt, repeated post-save does not repeat', async () => {
    const h = setup(); writePlotVectorControl(true);
    const prepared = await h.adapter.prepare(h.ctx());
    const ctx = { ...prepared, meta: { ...prepared.meta } }; // split Step2 copies metadata
    h.state.set(P.inventoryItems, { tea: { 名称: '随身热茶', 描述: '暖和的热茶', 数量: 2 } });
    await h.adapter.beforeSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get<VectorState>(P.plotVector)?.tasks).toHaveLength(1);
    ctx.meta.plotVectorCommitted!();
    await h.adapter.afterSave(ctx); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
    const options = h.ai.generate.mock.calls[0] as unknown as [{messages: Array<{content: string}>; usageType: string}];
    const input = JSON.parse(options[0].messages[1].content);
    expect(input.entry.id).toBe('item:tea'); expect(input).not.toHaveProperty('board');
    expect(options[0].usageType).toBe('main');
    expect(h.state.get<VectorState>(P.plotVector)?.tasks[0].status).toBe('bound');
    expect(h.disk()).toBeDefined();
  });
  it('no saved entry means no paid generation; quantity-only changes do not generate', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 2 } });
    const ctx = await h.adapter.prepare(h.ctx());
    h.state.set(`${P.inventoryItems}.tea.数量`, 1);
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('parsed inventory commands enqueue only surviving new entries and preserve custody in generation input', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, {
      tea: { 名称: '茶', 数量: 2 }, old: { 名称: '借来的笔', 描述: '用后归还', 数量: 1 },
    });
    const ctx = await h.adapter.prepare(h.ctx());
    // A transport fixture, not generated narrative or evidence of model compliance.
    const parsed = new ResponseParser().parse(JSON.stringify({ commands: [
      { action: 'set', path: `${P.inventoryItems}.tea.数量`, value: 1 },
      { action: 'delete', path: `${P.inventoryItems}.old` },
      { action: 'set', path: `${P.inventoryItems}.delivered`, value: { 名称: '代购物品', 数量: 1 } },
      { action: 'delete', path: `${P.inventoryItems}.delivered` },
      { action: 'set', path: `${P.inventoryItems}.map`, value: {
        名称: '借阅地图', 描述: '属于旅店，借给玩家辨路，离开时归还。', 数量: 1,
      } },
    ] }));
    expect(parsed.commands).toHaveLength(5);
    const result = new CommandExecutor(h.state).executeBatch(parsed.commands!);
    expect(result.results.every(r => r.success)).toBe(true);
    await h.adapter.beforeSave(ctx);
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    expect(h.state.get(`${P.inventoryItems}.old`)).toBeUndefined();
    const tasks = h.state.get<VectorState>(P.plotVector)!.tasks;
    expect(tasks.map(t => t.task.entry.id)).toEqual(['item:map']);
    await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled(); // No generation before save acknowledgement.
    ctx.meta.plotVectorCommitted!();
    await h.adapter.afterSave(ctx);
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
    const options = h.ai.generate.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }];
    const input = JSON.parse(options[0].messages[1].content);
    expect(input.entry.capability.description).toContain('离开时归还');
    expect(Object.keys(input).sort()).toEqual(['entry', 'version']);
    const disk = new StateManager(); disk.loadTree(h.disk() as Record<string, unknown>);
    expect(disk.get<VectorState>(P.plotVector)!.tasks[0].status).toBe('bound');
    expect(disk.get<VectorState>(P.plotVector)!.layout?.placements['01']).toBeNull();
  });
  it('off-on invalidates the old attempt and preserves saved cards', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.plotVector, initialVectorState()); const before = h.state.toSnapshot();
    const ctx = await h.adapter.prepare(h.ctx());
    writePlotVectorControl(false); writePlotVectorControl(true);
    expect(ctx.abortSignal?.aborted).toBe(true);
    await expect(h.adapter.beforeSave(ctx)).rejects.toThrow('取消');
    expect(h.state.toSnapshot()).toEqual(before);
  });
  it('switching slots refuses commit and prevents rollback onto the new slot', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx()); h.changeSlot();
    await expect(h.adapter.beforeSave(ctx)).rejects.toThrow();
    expect(ctx.meta.plotVectorLifecycle?.invalidated).toBe(true);
  });
  it('load/rollback rejects a late model response; original item stays saved', async () => {
    const h = setup(); writePlotVectorControl(true);
    let answer!: (value: string) => void;
    h.ai.generate.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const ctx = await h.adapter.prepare(h.ctx());
    h.state.set(P.inventoryItems, { tea: { 名称: '茶' } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    const pending = h.adapter.afterSave(ctx);
    await vi.waitFor(() => expect(h.ai.generate).toHaveBeenCalledTimes(1));
    h.state.loadTree({ unrelated: true }); answer(JSON.stringify(POSITIVE_EXAMPLES[0].output));
    await expect(pending).rejects.toThrow();
    expect(h.state.toSnapshot()).toEqual({ unrelated: true });
  });
  it('paid malformed output is retained and not automatically paid again', async () => {
    const h = setup(); writePlotVectorControl(true); h.ai.generate.mockResolvedValue('bad JSON');
    const ctx = await h.adapter.prepare(h.ctx()); h.state.set(P.inventoryItems, { tea: { 名称: '茶' } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.state.get<VectorState>(P.plotVector)?.tasks[0]).toMatchObject({ status: 'failed', raw: 'bad JSON' });
    const next = await h.adapter.prepare({ ...h.ctx(), roundNumber: 2 });
    await h.adapter.beforeSave(next); next.meta.plotVectorCommitted!(); await h.adapter.afterSave(next);
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
  });
  it('growth is accepted once, not per visit; component and story share the save snapshot', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { notebook: { 名称: '随身日记', 描述: '记录日常' } });
    const entries = projectSavedElements(h.state.toSnapshot()).entries;
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: entries })[0];
    const bound = await executeVectorOperation({ kind: 'validate', task, output: POSITIVE_EXAMPLES[2].output, attempts: 1 }) as BoundCard;
    h.state.set(P.plotVector, { ...initialVectorState(), cards: [bound], layout: { placements: { '01': bound.task.entry.id }, tray: [] } });
    const ctx = await h.adapter.prepare(h.ctx());
    expect(ctx.messages.some(m => typeof m.content === 'string' && m.content.includes('剧情'))).toBe(true);
    await h.adapter.beforeSave(ctx); const first = h.state.toSnapshot();
    await h.adapter.beforeSave(ctx); expect(h.state.toSnapshot()).toEqual(first);
    const values = Object.values(h.state.get<VectorState>(P.plotVector)!.session.scriptStates ?? {});
    expect(values.some(s => s.pages === 1)).toBe(true);
    ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    h.state.set(`${P.inventoryItems}.notebook.描述`, '今天又写下几行待办');
    const restored = h.state.toSnapshot(); h.state.loadTree(restored);
    const next = await h.adapter.prepare({ ...h.ctx(), roundNumber: 2 });
    await h.adapter.beforeSave(next); next.meta.plotVectorCommitted!(); await h.adapter.afterSave(next);
    const current = h.state.get<VectorState>(P.plotVector)!;
    expect(current.layout?.placements['01']).toBe(bound.task.entry.id);
    expect(Object.values(current.session.scriptStates ?? {}).some(s => s.pages === 2)).toBe(true);
    expect(current.cards[0].ref).toEqual(bound.ref);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('does not pay an old prose-only pending duplicate when the ability is already bound', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { notebook: { 名称: '日记', 描述: '第一页' } });
    const entry = projectSavedElements(h.state.toSnapshot()).entries[0];
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: [entry] })[0];
    task.key = stable(entry);
    const bound = await executeVectorOperation({ kind: 'validate', task, output: POSITIVE_EXAMPLES[2].output, attempts: 1 }) as BoundCard;
    const changed = { ...entry, capability: { ...entry.capability, description: '第二页' } };
    h.state.set(`${P.inventoryItems}.notebook.描述`, '第二页');
    h.state.set(P.plotVector, { ...initialVectorState(), cards: [bound], tasks: [
      { task: { ...task, entry: changed, key: stable(changed) }, status: 'pending' },
    ] });
    const ctx = await h.adapter.prepare(h.ctx());
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get<VectorState>(P.plotVector)!.cards[0].ref).toEqual(bound.ref);
  });
  it('failed task-checkpoint persistence prevents sending and retains the committed round', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx()); h.state.set(P.inventoryItems, { tea: { 名称: '茶' } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    const accepted = h.state.toSnapshot();
    h.saveGame.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.adapter.afterSave(ctx)).rejects.toThrow('disk full');
    expect(h.ai.generate).not.toHaveBeenCalled(); expect(h.state.toSnapshot()).toEqual(accepted);
    expect(ctx.meta.plotVectorLifecycle?.saved).toBe(true);
  });
  it('saved raw response resumes validation without another model call', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶' } });
    const entries = projectSavedElements(h.state.toSnapshot()).entries;
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: entries })[0];
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'sending', raw: JSON.stringify(POSITIVE_EXAMPLES[0].output) }] });
    h.state.set(`${P.inventoryItems}.tea.描述`, '新的日常记录');
    const ctx = await h.adapter.prepare(h.ctx());
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get<VectorState>(P.plotVector)?.tasks[0].status).toBe('bound');
  });
  it('binds a v3 production response to the saved item and reloads its executable card', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, {});
    const ctx = await h.adapter.prepare(h.ctx());
    h.state.set(P.inventoryItems, { tea: { 名称: '随身热茶', 描述: '忙碌时递来的一杯暖茶', 数量: 1 } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    const output = { version: 3, card: { name: '模型别名', description: '机械说明不可信',
      hooks: { onVisit: "return {effects:[{kind:'add',channel:'J',amount:2}]};", onRoundAccepted: null },
      initialPersistentState: {} } };
    h.ai.generate.mockResolvedValueOnce(JSON.stringify(output));
    await h.adapter.afterSave(ctx);
    const [request] = h.ai.generate.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }];
    const user = JSON.parse(request.messages[1].content);
    expect(user).toEqual({ version: 3, entry: {
      id: 'item:tea', kind: 'item', capability: { name: '随身热茶', description: '忙碌时递来的一杯暖茶' },
    } });
    const disk = structuredClone(h.disk()) as Record<string, unknown>;
    h.state.loadTree(disk);
    const stored = h.state.get<VectorState>(P.plotVector)!;
    expect(stored.tasks[0]).toMatchObject({ status: 'bound', raw: JSON.stringify(output) });
    expect(stored.cards[0].candidate.card).toMatchObject({ name: '随身热茶',
      description: '忙碌时递来的一杯暖茶', behaviorSummary: '以棋盘试走结果为准' });
    const preview = await executeVectorOperation({ kind: 'prepare',
      state: { ...stored, layout: { placements: { '01': 'item:tea' }, tray: [] } },
      entries: projectSavedElements(h.state.toSnapshot()).entries, id: 'next-turn',
      native: { ruleId: 'test', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 2, contributions: [] },
    }) as PreparedVector;
    expect(preview.result.trace.some(event => event.programHash === stored.cards[0].ref.hash && event.status === 'applied')).toBe(true);
    expect(preview.board.cards[0].originalText?.zh).toBe('忙碌时递来的一杯暖茶');
  });
  it('revalidates a legacy failed raw response once without paying or rewriting the raw', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶' } });
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
    const raw = JSON.stringify({ ...POSITIVE_EXAMPLES[0].output, stateDisplay: [] });
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'failed', error: 'old parser', raw }] });
    const ctx = await h.adapter.prepare(h.ctx());
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
    expect(h.ai.generate).not.toHaveBeenCalled();
    const row = h.state.get<VectorState>(P.plotVector)!.tasks[0];
    expect(row).toMatchObject({ status: 'bound', raw, validationRevision: GENESIS_VALIDATION_REVISION });
    expect(row.error).toBeUndefined();
  });
  it('disable after commit retains story, but changing slots still fences rendering', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx()); await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    writePlotVectorControl(false);
    expect(() => ctx.meta.plotVectorGuard!()).not.toThrow();
    h.changeSlot(); expect(() => ctx.meta.plotVectorGuard!()).toThrow();
    expect(ctx.meta.plotVectorLifecycle?.saved).toBe(true);
  });
});

class MemoryRequests implements RequestStore {
  rows = new Map<string, { fingerprint: string; owner: string; raw?: string }>();
  async claim(key: string, fingerprint: string, owner: string, guard: () => void) {
    guard(); const old = this.rows.get(key);
    if (!old) this.rows.set(key, { fingerprint, owner });
    return old;
  }
  async peek(key: string) { return this.rows.get(key); }
  async complete(key: string, owner: string, raw: string, guard: () => void) {
    guard(); const old = this.rows.get(key)!;
    if (old.owner !== owner) throw new Error('owner');
    this.rows.set(key, { ...old, raw });
  }
}
const apiConfig: APIConfig = { id: 'test', name: 'test', apiCategory: 'llm', provider: 'openai',
  url: 'https://test.invalid', apiKey: 'secret', model: 'test', temperature: 0.7, maxTokens: 100, enabled: true };
const modelRequest = { config: apiConfig, messages: [{ role: 'user' as const, content: 'story request' }], stream: false };
/** Wraps the real runtime; `bad` rewrites the result of one operation kind (the Worker is not trusted). */
function tamper<K extends VectorOperation['kind']>(h: ReturnType<typeof setup>, kind: K, bad: (result: never) => unknown, times = 1) {
  let left = times;
  h.worker.execute.mockImplementation((async (op: VectorOperation) => {
    const result = await executeVectorOperation(op);
    if (op.kind !== kind || left <= 0) return result;
    left -= 1;
    return bad(structuredClone(result) as never);
  }) as never);
}

describe('gate 1 · the host never uses an unchecked Worker result', () => {
  it('a malformed prepare result never arms the round or reaches the prompt; the next round continues', async () => {
    const h = setup(); writePlotVectorControl(true);
    const before = stable(h.state.get(P.plotVector) ?? null);
    tamper(h, 'prepare', (p: PreparedVector) => ({ ...p, result: { ...p.result, finalState: { ...p.result.finalState, shuttle: { ...p.result.finalState.shuttle, Y: -5 } } } }));
    const ctx = h.ctx();
    await expect(h.adapter.prepare(ctx)).rejects.toThrow(/剧情动能计算结果无效（prepare）/);
    expect(ctx.meta.plotVectorCheckpoint).toBeUndefined();
    expect(stable(h.state.get(P.plotVector) ?? null)).toBe(before);
    const next = await h.adapter.prepare(h.ctx());
    expect(next.meta.plotVectorCheckpoint).toBeTypeOf('function');
  });
  it('a malformed accept result is never written to the state or saved', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx());
    const before = stable(h.state.get(P.plotVector) ?? null);
    tamper(h, 'accept', (s: VectorState) => ({ ...s, session: { ...s.session, round: s.session.round + 5 } }));
    await expect(h.adapter.beforeSave(ctx)).rejects.toThrow(/剧情动能计算结果无效（accept）/);
    expect(stable(h.state.get(P.plotVector) ?? null)).toBe(before);
    expect(h.saveGame).not.toHaveBeenCalled();
  });
  it('a malformed validate result never binds a card; the paid reply is kept and not resent', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx());
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    tamper(h, 'validate', (b: BoundCard) => ({ ...b, ref: { hash: 'f'.repeat(64), id: `plot-card-${'f'.repeat(12)}` } }));
    await h.adapter.afterSave(ctx);
    const saved = h.state.get<VectorState>(P.plotVector)!;
    expect(saved.cards).toEqual([]);
    expect(saved.tasks[0]).toMatchObject({ status: 'failed', raw: JSON.stringify(POSITIVE_EXAMPLES[0].output) });
    expect(saved.tasks[0].error).toMatch(/剧情动能计算结果无效（validate）/);
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
  });
});

describe('gate 1 · R3 one-off accept failure recovers without another paid request', () => {
  const failAccepts = (h: ReturnType<typeof setup>, times: number) => {
    let left = times;
    h.worker.execute.mockImplementation((async (op: VectorOperation) => {
      if (op.kind === 'accept' && left > 0) { left -= 1; throw new Error('能力计算超时；保留上一步'); }
      return executeVectorOperation(op);
    }) as never);
  };
  const attempt = async (h: ReturnType<typeof setup>, send: () => Promise<string>) => {
    const ctx = await h.adapter.prepare(h.ctx());
    const raw = await ctx.meta.plotVectorCheckpoint!('single').run(modelRequest, send);
    return { ctx, raw, save: () => h.adapter.beforeSave(ctx) };
  };
  it('the retry with the same input reuses the journaled reply and commits exactly once', async () => {
    const h = setup(new RequestJournal(new MemoryRequests())); writePlotVectorControl(true);
    const send = vi.fn(async () => 'model reply');
    failAccepts(h, 1);
    const first = await attempt(h, send);
    await expect(first.save()).rejects.toThrow('超时');
    expect(h.state.get<VectorState>(P.plotVector)).toBeUndefined();
    const second = await attempt(h, send);
    expect(second.raw).toBe('model reply');
    expect(second.ctx.meta.plotVectorRecovered).toEqual(['single']);
    await second.save();
    await second.save(); // a repeated save of the same attempt is a no-op
    const saved = h.state.get<VectorState>(P.plotVector)!;
    expect(send).toHaveBeenCalledTimes(1);
    expect(saved.session.round).toBe(2);
    expect(saved.session.committed).toEqual(['p/s/1']);
    expect(h.worker.execute.mock.calls.filter(([op]) => op.kind === 'accept')).toHaveLength(2);
  });
  it('a persistent accept failure never commits, never resends and never advances the round', async () => {
    const h = setup(new RequestJournal(new MemoryRequests())); writePlotVectorControl(true);
    const send = vi.fn(async () => 'model reply');
    failAccepts(h, 99);
    for (let i = 0; i < 3; i++) {
      const next = await attempt(h, send);
      expect(next.raw).toBe('model reply');
      await expect(next.save()).rejects.toThrow('超时');
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.state.get<VectorState>(P.plotVector)).toBeUndefined();
    expect(h.worker.execute.mock.calls.filter(([op]) => op.kind === 'accept')).toHaveLength(3);
  });
});

describe('gate 1 · R4 ability-generation receipts: free recovery, never a second paid request', () => {
  const SLOT = { profileId: 'p', slotId: 's' };
  const reply = JSON.stringify(POSITIVE_EXAMPLES[0].output);
  /** Mirrors AIService: with a checkpoint, the checkpoint decides whether `send` (the paid call) runs. */
  function network(h: ReturnType<typeof setup>, send: () => Promise<string>) {
    const sends = vi.fn(send);
    h.ai.generate.mockImplementation((async (opts: { messages: AIMessage[]; checkpoint?: GenerationCheckpoint }) =>
      opts.checkpoint ? opts.checkpoint.run({ config: apiConfig, messages: opts.messages, stream: false }, sends) : sends()) as never);
    return sends;
  }
  async function round(h: ReturnType<typeof setup>, roundNumber: number, during?: () => void): Promise<unknown> {
    const ctx = await h.adapter.prepare({ ...h.ctx(), roundNumber });
    during?.(); // story changes land between prepare and save, like a real round
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!();
    return h.adapter.afterSave(ctx).then(() => null, (error: unknown) => error);
  }
  const rows = (h: ReturnType<typeof setup>) => h.state.get<VectorState>(P.plotVector)!.tasks;
  const teaTask = (h: ReturnType<typeof setup>) => tasksAfterSave({ id: 'x', success: true, before: [],
    after: projectSavedElements(h.state.toSnapshot(), { includeEnvironment: true }).entries })[0];

  it('a reply received after a slot switch is recorded, never written into the other slot, and binds free next round despite a toggle', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    const sends = network(h, async () => { h.changeSlot(); return reply; }); // the player switches slots mid-request
    await round(h, 1, () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } }));
    expect(sends).toHaveBeenCalledTimes(1);
    const key = rows(h)[0].task.key;
    expect(rows(h)[0]).toMatchObject({ status: 'sending' });
    expect(rows(h)[0].raw).toBeUndefined();
    expect(h.saveGame.mock.calls.every(call => call[1] === 's')).toBe(true); // nothing reached slot "other"
    expect(await new RequestJournal(store).genesis(SLOT, key).lookup()).toEqual({ kind: 'raw', raw: reply });
    h.setSlot('s'); writePlotVectorControl(false); writePlotVectorControl(true); // back, with a new feature epoch
    const saves = h.saveGame.mock.calls.length;
    expect(await round(h, 2)).toBeNull();
    expect(sends).toHaveBeenCalledTimes(1);
    expect(rows(h)[0]).toMatchObject({ status: 'bound', raw: reply });
    expect(h.state.get<VectorState>(P.plotVector)!.cards.map(c => c.task.entry.id)).toEqual(['item:tea']);
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    expect(h.saveGame.mock.calls.slice(saves).every(call => call[1] === 's')).toBe(true);
  });

  it('an unknown outcome is never re-sent or failed across rounds and toggles; a reply that lands later is adopted free', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = teaTask(h);
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'sending' }] });
    // Another tab owns the request and is still waiting for it.
    let land!: (raw: string) => void;
    const elsewhere = new RequestJournal(store).genesis(SLOT, task.key).checkpoint(() => {})
      .run({ config: apiConfig, messages: [], stream: false }, () => new Promise<string>(resolve => { land = resolve; }));
    await vi.waitFor(() => expect(land).toBeTypeOf('function'));
    const sends = network(h, async () => reply);
    await round(h, 1);
    writePlotVectorControl(false); writePlotVectorControl(true);
    await round(h, 2);
    expect(sends).not.toHaveBeenCalled();
    expect(rows(h)[0]).toEqual({ task, status: 'sending' });
    land(reply); await elsewhere;
    await round(h, 3);
    expect(sends).not.toHaveBeenCalled();
    expect(rows(h)[0]).toMatchObject({ status: 'bound', raw: reply });
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
  });

  it('a pending task already claimed elsewhere is not sent here; it is adopted when that reply lands', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = teaTask(h);
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'pending' }] });
    let land!: (raw: string) => void;
    const elsewhere = new RequestJournal(store).genesis(SLOT, task.key).checkpoint(() => {})
      .run({ config: apiConfig, messages: [], stream: false }, () => new Promise<string>(resolve => { land = resolve; }));
    await vi.waitFor(() => expect(land).toBeTypeOf('function'));
    const sends = network(h, async () => reply);
    await round(h, 1);
    expect(sends).not.toHaveBeenCalled();
    expect(rows(h)[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/尚不明确/) });
    land(reply); await elsewhere;
    await round(h, 2);
    expect(sends).not.toHaveBeenCalled();
    expect(rows(h)[0]).toMatchObject({ status: 'bound', raw: reply });
  });

  it('with no record at all nothing is sent, and the read-only lookup creates no record', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = teaTask(h);
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'sending' }] });
    const sends = network(h, async () => reply);
    await round(h, 1); await round(h, 2);
    expect(sends).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect(rows(h)[0]).toEqual({ task, status: 'sending' });
  });

  it('a reply whose save write failed is recovered from the ledger next round without paying again', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    const sends = network(h, async () => reply);
    let failWrite = false;
    const honestSave = h.saveGame.getMockImplementation()!;
    h.saveGame.mockImplementation((async (...args: Parameters<typeof honestSave>) => {
      if (failWrite) throw new Error('disk full');
      return honestSave(...args);
    }) as never);
    const original = h.worker.execute.getMockImplementation()!;
    // The raw write happens right after the reply: fail exactly that save.
    h.ai.generate.mockImplementationOnce((async (opts: { messages: AIMessage[]; checkpoint?: GenerationCheckpoint }) => {
      const raw = await opts.checkpoint!.run({ config: apiConfig, messages: opts.messages, stream: false }, sends);
      failWrite = true; return raw;
    }) as never);
    await round(h, 1, () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } }));
    expect(sends).toHaveBeenCalledTimes(1);
    expect(rows(h)[0].raw).toBeUndefined();
    failWrite = false; h.worker.execute.mockImplementation(original);
    await round(h, 2);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(rows(h)[0]).toMatchObject({ status: 'bound', raw: reply });
  });
});

describe('sources and environment abilities (PO correction)', () => {
  const ability = (channel: string) => ({ hooks: { onVisit: `return { effects: [{ kind: 'add', channel: '${channel}', amount: 1 }] };`, onRoundAccepted: null } });
  async function round(h: ReturnType<typeof setup>, roundNumber: number, during?: () => void) {
    const ctx = await h.adapter.prepare({ ...h.ctx(), roundNumber });
    during?.();
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
  }
  const vector = (h: ReturnType<typeof setup>) => h.state.get<VectorState>(P.plotVector)!;
  const environmentCards = (h: ReturnType<typeof setup>) => vector(h).cards.filter(c => c.task.entry.kind === 'environment');

  it('a saved item card on the board is not consumed: the item stays in the inventory round after round', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 2 } }));
    expect(vector(h).cards.map(c => c.task.entry.id)).toEqual(['item:tea']);
    h.state.set(P.plotVector, { ...vector(h), layout: { placements: { '01': 'item:tea', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
    for (const n of [2, 3]) {
      await round(h, n);
      expect(vector(h).last!.result.trace.some(e => e.owner?.id === 'item:tea' && e.status === 'applied')).toBe(true);
      expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(2);
    }
    expect(h.ai.generate).toHaveBeenCalledTimes(1);
  });

  it('Step2 environment abilities: bound after the save, used next round, kept when not rewritten, replaced, then removed', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑', 能力: ability('Y') }]));
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:细雨']);
    // The snippet travelled once, through Step2's own command; it does not stay in the story state or later prompts.
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑' }]);
    const bound = environmentCards(h)[0].ref.hash;
    // Next round: the card takes part automatically; Step2 re-emits the same tag unchanged, without an ability → kept.
    await round(h, 2, () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑' }]));
    expect(vector(h).last!.layout.placements['06']).toBe('environment:name:细雨');
    expect(vector(h).last!.result.trace.some(e => e.owner?.id === 'environment:name:细雨' && e.status === 'applied')).toBe(true);
    expect(environmentCards(h).map(c => c.ref.hash)).toEqual([bound]);
    // The environment changes: the new tag's ability replaces the old card.
    await round(h, 3, () => h.state.set(P.environmentTags, [{ 名称: '放晴', 描述: '云开日出', 效果: '', 能力: ability('J') }]));
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:放晴']);
    // The environment clears: its card goes with it.
    await round(h, 4, () => h.state.set(P.environmentTags, []));
    expect(environmentCards(h)).toEqual([]);
    expect(h.ai.generate).not.toHaveBeenCalled(); // no post-save generation for environment
  });

  it('a same-name environment updated without a new ability stops using the old one; Step3 fills it and later rounds use the new ability', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '湿滑', 能力: ability('S-') }]));
    const wet = environmentCards(h)[0].ref.hash;
    // Same name, effect updated from 湿滑 to 干燥, but Step2 left out the ability.
    await round(h, 2, () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '干燥' }]));
    expect(environmentCards(h)).toEqual([]); // the old wet-road ability no longer takes part
    const repair = await h.adapter.abilityRepairTask();
    expect(repair?.block).toContain('路面');
    expect(repair?.block).toContain('内容已更新但缺少新能力');
    const generate = vi.fn(async () => JSON.stringify({ commands: [{ action: 'set', key: P.environmentTags,
      value: [{ 名称: '路面', 描述: '石板路', 效果: '干燥', 能力: ability('S+') }] }] }));
    await new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
      {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask()).execute();
    const dry = environmentCards(h).map(c => c.ref.hash);
    expect(dry).toHaveLength(1); expect(dry[0]).not.toBe(wet);
    // Next round, unchanged: the repaired ability is the one that runs.
    await round(h, 3, () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '干燥' }]));
    const ran = vector(h).last!.result.trace.filter(e => e.owner?.id === 'environment:name:路面' && e.status === 'applied');
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every(e => e.programHash === dry[0])).toBe(true);
    expect(environmentCards(h).map(c => c.ref.hash)).toEqual(dry);
  });

  it('an invalid environment ability rides the existing Step3 repair and loads once fixed', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '浓雾', 描述: '看不清路', 效果: '', 能力: { hooks: { onVisit: 'return {', onRoundAccepted: null } } }]));
    expect(environmentCards(h)).toEqual([]);
    const repaired = [{ 名称: '浓雾', 描述: '看不清路', 效果: '', 能力: ability('S-') }];
    const generate = vi.fn(async () => JSON.stringify({ commands: [{ action: 'set', key: P.environmentTags, value: repaired }] }));
    const step3 = new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
      {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
    await step3.execute();
    expect(generate).toHaveBeenCalledTimes(1);
    const request = String((generate.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }])[0].messages.at(-1)!.content);
    expect(request).toContain('<环境能力修复>');
    expect(request).toContain('浓雾');
    expect(request).toContain('does not compile'); // the concrete diagnostic, not a request to judge
    expect(request).toContain('onVisit');           // the same interface Step2 uses
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:浓雾']);
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '浓雾', 描述: '看不清路', 效果: '' }]);
    expect(await h.adapter.abilityRepairTask()).toBeNull(); // nothing left to repair; Step3 is not a per-card pass
  });

  it('a repair that never validates stays bounded, keeps the round, and is reported as unresolved (not as field success)', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '浓雾', 描述: '看不清路', 效果: '', 能力: { hooks: { onVisit: 'return {', onRoundAccepted: null } } }]));
    const still = [{ 名称: '浓雾', 描述: '看不清路', 效果: '', 能力: { hooks: { onVisit: 'return {', onRoundAccepted: null } } }];
    const generate = vi.fn(async () => JSON.stringify({ commands: [{ action: 'set', key: P.environmentTags, value: still }] }));
    const step3 = new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
      {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
    const result = await step3.execute();
    expect(result.extra).toEqual({ resolved: false });
    expect(result.fieldsNeeded).toBe(false);
    expect(generate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(generate.mock.calls.length).toBeLessThanOrEqual(result.attempts);
    expect(environmentCards(h)).toEqual([]);
    expect(vector(h).session.round).toBe(2); // the round itself stays committed
  });

  it('a duplicated environment tag name does not silently drop the card of a tag that is still there', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '', 能力: ability('Y') }]));
    const bound = environmentCards(h).map(c => c.ref.hash);
    await round(h, 2, () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '' }, { 名称: '细雨', 描述: '又下起来', 效果: '' }]));
    expect(environmentCards(h).map(c => c.ref.hash)).toEqual(bound);
    await round(h, 3, () => h.state.set(P.environmentTags, []));
    expect(environmentCards(h)).toEqual([]);
  });
});

describe('ability failure lifecycle: the obtained entry stays, only the snippet is dropped and can be regenerated (PO D8)', () => {
  const ability = (channel: string) => ({ hooks: { onVisit: `return { effects: [{ kind: 'add', channel: '${channel}', amount: 1 }] };`, onRoundAccepted: null } });
  const broken = JSON.stringify({ version: 3, card: { hooks: { onVisit: 'const x = null; return x.y;', onRoundAccepted: null } } });
  const ointment = { 名称: '修复药膏', 数量: 1, 描述: '术后用' };
  const vector = (h: ReturnType<typeof setup>) => h.state.get<VectorState>(P.plotVector)!;
  const row = (h: ReturnType<typeof setup>, id: string) => vector(h).tasks.find(t => t.task.entry.id === id)!;
  async function round(h: ReturnType<typeof setup>, roundNumber: number, during?: () => void) {
    h.state.set(P.roundNumber, roundNumber);
    const ctx = await h.adapter.prepare({ ...h.ctx(), roundNumber });
    during?.();
    await h.adapter.beforeSave(ctx); ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
  }
  /** The real Step3 pipeline with a stand-in model. */
  function step3(h: ReturnType<typeof setup>, reply: () => unknown) {
    const generate = vi.fn(async () => JSON.stringify(reply()));
    const pipeline = new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
      {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
    return { generate, run: () => pipeline.execute() };
  }
  const lastRequest = (generate: ReturnType<typeof vi.fn>) =>
    String((generate.mock.calls.at(-1) as unknown as [{ messages: Array<{ content: string }> }])[0].messages.at(-1)!.content);
  /** A page reload: a new adapter over the saved tree, sharing the local receipt ledger. */
  function reload(h: ReturnType<typeof setup>, store: MemoryRequests) {
    const next = setup(new RequestJournal(store));
    next.state.loadTree(structuredClone(h.state.toSnapshot()));
    return next;
  }
  /** Mirrors AIService: with a checkpoint, the checkpoint decides whether `send` (the paid call) runs. */
  function network(h: ReturnType<typeof setup>, send: () => Promise<string>) {
    const sends = vi.fn(send);
    h.ai.generate.mockImplementation((async (opts: { messages: AIMessage[]; checkpoint?: GenerationCheckpoint }) =>
      opts.checkpoint ? opts.checkpoint.run({ config: apiConfig, messages: opts.messages, stream: false }, sends) : sends()) as never);
    return sends;
  }

  it('a failed ability keeps the item, its name, description and quantity; no card is faked and the board lists it as not ready', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    expect(row(h, 'item:ointment')).toMatchObject({ status: 'failed', raw: broken });
    expect(vector(h).cards).toEqual([]);
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
    expect(h.adapter.abilityBacklog().map(b => [b.id, b.name, b.state])).toEqual([['item:ointment', '修复药膏', 'failed']]);
  });

  it("this round's Step3 regenerates it in the task's own reply field and binds it without writing to the item", async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const { generate, run } = step3(h, () => ({ commands: [], abilities: [{ id: 'item:ointment', card: ability('Y') }] }));
    const result = await run();
    expect(result.extra).toEqual({ resolved: true });
    const request = lastRequest(generate);
    expect(request).toContain('<能力补生>');
    expect(request).toContain('修复药膏');
    expect(request).toContain('x.y');       // the previous ability, so the new one can avoid the same failure
    expect(request).toContain('"abilities"'); // the reply field, next to commands
    expect(request).toContain('onVisit');     // the same snippet contract post-save genesis uses
    expect(vector(h).cards.map(c => c.task.entry.id)).toEqual(['item:ointment']);
    expect(row(h, 'item:ointment')).toMatchObject({ status: 'bound', raw: broken, retry: { attempts: 1, autoRounds: 1, source: 'step3' } });
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
    expect(await h.adapter.abilityRepairTask()).toBeNull(); // bound cards are never re-examined
  });

  it('an item-only regeneration asks for no commands and never applies commands from its reply', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const { generate, run } = step3(h, () => ({
      commands: [{ action: 'set', key: `${P.inventoryItems}.ointment.能力`, value: 'smuggled' }],
      abilities: [{ id: 'item:ointment', card: ability('Y') }],
    }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(lastRequest(generate)).not.toContain('"commands"');
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('after a reload a later Step3 still finds the waiting entry; automatic tries stop after two rounds; the story keeps going', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    // Round 1's Step3 reply forgot the ability: bounded retries inside the round, counted as one round.
    const first = step3(h, () => ({ commands: [] }));
    expect((await first.run()).extra).toEqual({ resolved: false });
    expect(row(h, 'item:ointment').retry).toMatchObject({ autoRounds: 1, lastAutoRound: 1 });
    const h2 = reload(h, store);
    await round(h2, 2);
    const second = step3(h2, () => ({ commands: [], abilities: [{ id: 'item:ointment', card: JSON.parse(broken).card }] }));
    expect((await second.run()).extra).toEqual({ resolved: false });
    expect(row(h2, 'item:ointment')).toMatchObject({ status: 'failed', raw: broken, retry: { autoRounds: 2, source: 'step3' } });
    expect(row(h2, 'item:ointment').retry?.error).toBeTruthy();
    await round(h2, 3);
    expect(await h2.adapter.abilityRepairTask()).toBeNull();                            // no third automatic round
    expect(h2.adapter.abilityBacklog().map(b => b.id)).toEqual(['item:ointment']);        // still offered to the player
    expect(vector(h2).last?.id).toBe('p/s/3');                                            // the story went on
    expect(h2.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('a player retry checks an already received reply for free first', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
    // Rejected under older validation rules; valid under the current ones.
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'failed', error: 'nothing to transfer',
      raw: JSON.stringify(POSITIVE_EXAMPLES[0].output), validationRevision: 1 }] });
    expect(await h.adapter.regenerateAbility('item:tea')).toEqual({ bound: true, requested: false });
    expect(h.ai.generate).not.toHaveBeenCalled();
    expect(vector(h).cards.map(c => c.task.entry.id)).toEqual(['item:tea']);
    expect(h.saveGame).toHaveBeenCalled();
  });

  it('otherwise the player retry is a new recorded request with its own receipt; the first failure stays on record', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const firstError = row(h, 'item:ointment').error;
    const saves = h.saveGame.mock.calls.length;
    const sends = network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
    expect(sends).toHaveBeenCalledTimes(1);
    const input = JSON.parse(String((h.ai.generate.mock.calls.at(-1) as unknown as [{ messages: AIMessage[] }])[0].messages[1].content));
    expect(input).toMatchObject({ entry: { id: 'item:ointment' }, problem: firstError });
    // Recorded as sending and saved before the request left, then saved again with the result.
    const beforeSend = (h.saveGame.mock.calls[saves] as unknown as [string, string, Record<string, unknown>])[2];
    expect(((beforeSend as { 系统: { 扩展: { plotVector: VectorState } } }).系统.扩展.plotVector.tasks[0].retry)).toMatchObject({ sending: true, attempts: 1 });
    expect(row(h, 'item:ointment')).toMatchObject({ status: 'bound', raw: broken, error: firstError, retry: { attempts: 1, source: 'manual', sending: false } });
    const key = row(h, 'item:ointment').task.key;
    expect(await new RequestJournal(store).genesis({ profileId: 'p', slotId: 's' }, `${key}#retry-1`).lookup()).toMatchObject({ kind: 'raw' });
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('an unknown outcome is never retried by Step3, but the player can retry it explicitly', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.roundNumber, 1);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'sending' }] });
    expect(h.adapter.abilityBacklog().map(b => b.state)).toEqual(['unknown']);
    expect(await h.adapter.abilityRepairTask()).toBeNull();
    network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('item:tea')).toEqual({ bound: true, requested: true });
    expect(row(h, 'item:tea')).toMatchObject({ status: 'bound', retry: { attempts: 1, source: 'manual' } });
  });

  it('an environment tag waiting for its ability survives a reload; a later Step3 fills it and the card carries on', async () => {
    const store = new MemoryRequests();
    const h = setup(new RequestJournal(store)); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    expect(row(h, 'environment:name:微风')).toMatchObject({ status: 'failed', error: '缺少能力' });
    const h2 = reload(h, store);
    await round(h2, 2, () => h2.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    expect(row(h2, 'environment:name:微风')).toMatchObject({ status: 'failed' }); // unchanged, still waiting
    const { run } = step3(h2, () => ({ commands: [{ action: 'set', key: P.environmentTags,
      value: [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适', 能力: ability('Y') }] }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(vector(h2).cards.map(c => c.task.entry.id)).toEqual(['environment:name:微风']);
    expect(vector(h2).tasks.filter(t => t.task.entry.kind === 'environment')).toEqual([]);
    await round(h2, 3, () => h2.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    expect(vector(h2).last!.layout.placements['06']).toBe('environment:name:微风');
  });

  it('the player can regenerate an environment ability too; the tag itself is not rewritten', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('environment:name:微风')).toEqual({ bound: true, requested: true });
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]);
    await round(h, 2, () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    expect(vector(h).last!.layout.placements['06']).toBe('environment:name:微风');
    expect(h.adapter.abilityBacklog()).toEqual([]);
  });
});
