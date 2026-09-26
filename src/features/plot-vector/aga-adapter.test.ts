import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { CommandExecutor } from '../../engine/core/command-executor';
import { ResponseParser } from '../../engine/ai/response-parser';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import { AgaPlotVectorAdapter } from './aga-adapter';
import { eventBus } from '../../engine/core/event-bus';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorState, type VectorOperation, type VectorResult } from './runtime';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { tasksAfterSave, stable, type BoundCard } from './genesis/post-save';
import { GENESIS_VALIDATION_REVISION, SNIPPET_API } from './genesis/generation-prompt';
import { projectSavedElements } from './saved-elements';
import rulesJSON from '../../../public/packs/tianming/rules/plot-vector.json';
import { parseNativeRules } from './native-input';
import { parseVectorPromptPolicy } from './prompt-policy';
import { FieldRepairPipeline } from '../../engine/pipeline/sub-pipelines/field-repair';
import type { AIService } from '../../engine/ai/ai-service';
import type { PromptAssembler } from '../../engine/prompt/prompt-assembler';
import type { GamePack } from '../../engine/types';
import type { AIMessage } from '../../engine/ai/types';
import promptRules from '../../../public/packs/tianming/rules/plot-vector-prompts.json';

let adapters: AgaPlotVectorAdapter[];
beforeEach(() => {
  adapters = [];
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { adapters.forEach(a => a.dispose()); vi.unstubAllGlobals(); });
function setup() {
  const state = new StateManager(); state.loadTree({});
  let slot = { profileId: 'p', slotId: 's' };
  let disk: unknown;
  const ai = { generate: vi.fn(async () => JSON.stringify(POSITIVE_EXAMPLES[0].output)) };
  const saveGame = vi.fn(async (_p: string, _s: string, data: unknown, _meta?: unknown,
    commit?: { guard: () => void; committed: () => void }) => {
    commit?.guard(); disk = structuredClone(data); commit?.committed();
  });
  const worker = { execute: vi.fn(<T extends VectorResult>(op: VectorOperation) => executeVectorOperation(op) as Promise<T>), cancelAll: vi.fn() };
  const adapter = new AgaPlotVectorAdapter(state, ai, { saveGame }, () => slot, {
    execute: <T extends VectorResult>(op: VectorOperation) => worker.execute(op) as Promise<T>, cancelAll: worker.cancelAll,
  }, parseNativeRules(rulesJSON), parseVectorPromptPolicy(promptRules, 'mode contract')); adapters.push(adapter);
  const ctx = (): PipelineContext => ({ generationId: crypto.randomUUID(), roundNumber: 1, stateSnapshot: state.toSnapshot(),
    userInput: '继续', actionQueuePrompt: '', chatHistory: [], worldEventTriggered: false, messages: [{ role: 'user', content: '继续' }], meta: { plotVectorLifecycle: {} } });
  return { state, ai, saveGame, worker, adapter, ctx, changeSlot: () => { slot = { ...slot, slotId: 'other' }; },
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
  for (const commands of [undefined, []]) it(`an unsuccessful parse in active mode keeps the story like the original flow, commands=${String(commands)}`, async () => {
    const h = setup(); writePlotVectorControl(true);
    const prepared = await h.adapter.prepare(h.ctx());
    const broken = { ...prepared, parsedResponse: { text: '东西买好了。', commands, parseOk: false } };
    await expect(h.adapter.beforeSave(broken)).resolves.toBeUndefined();
    expect(h.worker.execute.mock.calls.filter(([op]) => op.kind === 'accept')).toHaveLength(1);
    expect(h.state.get<VectorState>(P.plotVector)?.session.round).toBe(2);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('does not change legacy off-mode handling of an unsuccessful parse', async () => {
    const h = setup(); const ctx = { ...h.ctx(), parsedResponse: { text: 'raw', parseOk: false } };
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
  it('keeps mode even with no impulse and gives Step2 the environment-ability interface, not the vector', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); c.meta.splitStep2Messages = [{ role: 'system', content: 'commands' }];
    expect(h.adapter.promptTransform(c)).toBeTypeOf('function');
    const result = await h.adapter.prepare(c);
    expect(result.messageSources).toContain('plot-vector-mode');
    expect(result.messages.find(m => m.content === 'mode contract')).toBeDefined();
    expect(result.meta.splitStep2Messages!.slice(1)).toEqual([{ role: 'system', content: 'commands' }]);
    expect(result.meta.splitStep2Sources).toEqual(['environment-ability', 'unknown']);
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
  it('off means identical context, no worker, no generation, no component state writes', async () => {
    const h = setup(), ctx = h.ctx();
    expect(await h.adapter.prepare(ctx)).toBe(ctx);
    await h.adapter.beforeSave(ctx); await h.adapter.afterSave(ctx);
    expect(h.worker.execute).not.toHaveBeenCalled(); expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get(P.plotVector)).toBeUndefined();
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

/** Toasts the component emits while the story goes on without it. */
function toasts() {
  const seen: string[] = [];
  const off = eventBus.on<{ i18nKey?: string }>('ui:toast', t => { if (t?.i18nKey) seen.push(t.i18nKey); });
  return { seen, off };
}

describe('the component only degrades: the story always goes on (rebuild plan §7)', () => {
  for (const [label, fail] of [
    ['a malformed prepare result', (h: ReturnType<typeof setup>) => tamper(h, 'prepare', (p: PreparedVector) =>
      ({ ...p, result: { ...p.result, finalState: { ...p.result.finalState, shuttle: { ...p.result.finalState.shuttle, Y: -5 } } } }))],
    ['a failed trip computation', (h: ReturnType<typeof setup>) => h.worker.execute.mockImplementationOnce((async () => {
      throw new Error('剧情动能这回合算不出来（test）'); }) as never)],
  ] as const) it(`${label}: no momentum this round, the round is saved and new entries still queue`, async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 魅力: 10 });
    const before = h.state.get<VectorState>(P.plotVector);
    fail(h);
    const note = toasts();
    try {
      const c = h.ctx(); h.adapter.promptTransform(c);
      const ctx = await h.adapter.prepare(c);
      expect(ctx.messageSources).toContain('plot-vector-mode');   // the judgment stays replaced
      expect(ctx.messageSources).not.toContain('plot-vector');     // but no momentum is injected
      expect(note.seen).toEqual(['mainGame.toast.vectorNotComputed']);
      h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
      await expect(h.adapter.beforeSave(ctx)).resolves.toBeUndefined();
      expect(h.worker.execute.mock.calls.filter(([op]) => op.kind === 'accept')).toHaveLength(0);
      const saved = h.state.get<VectorState>(P.plotVector)!;
      expect(saved.session).toEqual((before ?? initialVectorState()).session); // nothing advanced
      expect(saved.tasks.map(t => t.task.entry.id)).toEqual(['item:tea']);
      ctx.meta.plotVectorCommitted!(); await h.adapter.afterSave(ctx);
      expect(h.state.get<VectorState>(P.plotVector)!.cards.map(c => c.task.entry.id)).toEqual(['item:tea']);
      // The next round computes again.
      const next = await h.adapter.prepare(h.ctx());
      expect(next.messageSources).toContain('plot-vector');
    } finally { note.off(); }
  });
  it('a cancelled or switched round still stops, as before', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.worker.execute.mockImplementationOnce((async () => { h.changeSlot(); throw new Error('cancelled'); }) as never);
    const c = h.ctx();
    await expect(h.adapter.prepare(c)).rejects.toThrow('存档已切换');
    expect(c.meta.plotVectorLifecycle?.invalidated).toBe(true);
  });
  it('a failed settlement saves the story and items; this round\'s momentum and growth do not advance', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx());
    const before = h.state.get<VectorState>(P.plotVector) ?? initialVectorState();
    tamper(h, 'accept', (s: VectorState) => ({ ...s, session: { ...s.session, round: s.session.round + 5 } }));
    const note = toasts();
    try {
      h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
      await expect(h.adapter.beforeSave(ctx)).resolves.toBeUndefined();
      expect(note.seen).toEqual(['mainGame.toast.vectorNotSettled']);
    } finally { note.off(); }
    const saved = h.state.get<VectorState>(P.plotVector)!;
    expect(saved.session).toEqual(before.session);
    expect(saved.last).toEqual(before.last);
    expect(saved.tasks.map(t => t.task.entry.id)).toEqual(['item:tea']);
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
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
  /** A page reload: a new adapter over the saved tree. */
  function reload(h: ReturnType<typeof setup>) {
    const next = setup();
    next.state.loadTree(structuredClone(h.state.toSnapshot()));
    return next;
  }
  /** The model call behind a player retry. */
  function network(h: ReturnType<typeof setup>, send: () => Promise<string>) {
    const sends = vi.fn(send);
    h.ai.generate.mockImplementation(sends as never);
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
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    // Round 1's Step3 reply forgot the ability: bounded retries inside the round, counted as one round.
    const first = step3(h, () => ({ commands: [] }));
    expect((await first.run()).extra).toEqual({ resolved: false });
    expect(row(h, 'item:ointment').retry).toMatchObject({ autoRounds: 1, lastAutoRound: 1 });
    const h2 = reload(h);
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

  it('otherwise the player retry is a new request, counted before it leaves; the first failure stays on record', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const firstError = row(h, 'item:ointment').error;
    const saves = h.saveGame.mock.calls.length;
    const sends = network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
    expect(sends).toHaveBeenCalledTimes(1);
    const input = JSON.parse(String((h.ai.generate.mock.calls.at(-1) as unknown as [{ messages: AIMessage[] }])[0].messages[1].content));
    expect(input).toMatchObject({ entry: { id: 'item:ointment' }, problem: firstError });
    // Counted and saved before the request left, then saved again with the result.
    const beforeSend = (h.saveGame.mock.calls[saves] as unknown as [string, string, Record<string, unknown>])[2];
    expect(((beforeSend as { 系统: { 扩展: { plotVector: VectorState } } }).系统.扩展.plotVector.tasks[0].retry)).toMatchObject({ attempts: 1, source: 'manual' });
    expect(row(h, 'item:ointment')).toMatchObject({ status: 'bound', raw: broken, error: firstError, retry: { attempts: 1, source: 'manual' } });
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('a request that failed without a reply counts as failed: Step3 fills it, and the player can retry it too', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => { throw new Error('network down'); });
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    expect(row(h, 'item:ointment')).toMatchObject({ status: 'failed', error: 'Error: network down' });
    expect(row(h, 'item:ointment').raw).toBeUndefined();
    expect(h.adapter.abilityBacklog().map(b => b.state)).toEqual(['failed']);
    expect((await h.adapter.abilityRepairTask())?.block).toContain('修复药膏');
    // The player's retry fails the same way: the entry stays, still failed, still Step3's to fill.
    const failing = network(h, async () => { throw new Error('still down'); });
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: false, requested: true });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(row(h, 'item:ointment').retry).toMatchObject({ attempts: 1, source: 'manual', error: 'still down' });
    expect(h.adapter.abilityBacklog().map(b => b.state)).toEqual(['failed']);
    expect(await h.adapter.abilityRepairTask()).not.toBeNull();
    // A later explicit retry that gets a reply binds it.
    network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
    expect(row(h, 'item:ointment').retry).toMatchObject({ attempts: 2, source: 'manual' });
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('Step3 requests that fail without a reply still use up the automatic rounds; the entry stays and the player can retry', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const down = () => new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate: vi.fn(async () => { throw new Error('502'); }) } as unknown as AIService,
      new ResponseParser(), {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
    await down().execute();
    expect(row(h, 'item:ointment').retry).toMatchObject({ autoRounds: 1, lastAutoRound: 1, source: 'step3' });
    await round(h, 2);
    await down().execute();
    expect(row(h, 'item:ointment').retry?.autoRounds).toBe(2);
    await round(h, 3);
    expect(await h.adapter.abilityRepairTask()).toBeNull();
    expect(h.adapter.abilityBacklog().map(b => b.id)).toEqual(['item:ointment']);
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
    network(h, async () => JSON.stringify({ version: 3, card: ability('J') }));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
  });

  it('a Step3 task whose game changed right before sending is withdrawn: nothing is sent for it alone and nothing is counted', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => h.state.set(P.inventoryItems, { ointment }));
    const tasksBefore = JSON.stringify(vector(h).tasks);
    const generate = vi.fn(async () => '{}');
    // Built while the feature is on, then the feature is switched off before the request leaves.
    const stale = async () => { const task = await h.adapter.abilityRepairTask(); writePlotVectorControl(false); return task; };
    const result = await new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
      {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, stale).execute();
    expect(generate).not.toHaveBeenCalled();
    expect(result.extra).toEqual({ resolved: false });
    expect(JSON.stringify(vector(h).tasks)).toBe(tasksBefore);
  });

  it('a Step3 request carrying both an environment and an item task sends the shared snippet contract once', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.ai.generate.mockImplementation(async () => broken);
    await round(h, 1, () => {
      h.state.set(P.inventoryItems, { ointment });
      h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]);
    });
    const { generate, run } = step3(h, () => ({
      commands: [{ action: 'set', key: P.environmentTags, value: [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适', 能力: ability('Y') }] }],
      abilities: [{ id: 'item:ointment', card: ability('J') }],
    }));
    expect((await run()).extra).toEqual({ resolved: true });
    const request = lastRequest(generate);
    expect(request).toContain('<环境能力修复>');
    expect(request).toContain('<能力补生>');
    expect(request.split(SNIPPET_API).length - 1).toBe(1);
    expect(vector(h).cards.map(c => c.task.entry.id).sort()).toEqual(['environment:name:微风', 'item:ointment']);
  });

  it('a request left when the page closed counts as failed: Step3 fills it in this round', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.roundNumber, 1);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
    h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'sending' }] });
    expect(h.adapter.abilityBacklog().map(b => b.state)).toEqual(['failed']);
    const { run } = step3(h, () => ({ commands: [], abilities: [{ id: 'item:tea', card: ability('J') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(row(h, 'item:tea')).toMatchObject({ status: 'bound', retry: { attempts: 1, source: 'step3' } });
  });

  it('an environment tag waiting for its ability survives a reload; a later Step3 fills it and the card carries on', async () => {
    const h = setup(); writePlotVectorControl(true);
    await round(h, 1, () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]));
    expect(row(h, 'environment:name:微风')).toMatchObject({ status: 'failed', error: '缺少能力' });
    const h2 = reload(h);
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
