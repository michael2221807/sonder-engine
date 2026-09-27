import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { RoundOwnership } from '../../engine/core/round-ownership';
import { CommandExecutor } from '../../engine/core/command-executor';
import { ResponseParser } from '../../engine/ai/response-parser';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import { AgaPlotVectorAdapter, REPAIR_BATCH } from './aga-adapter';
import { eventBus } from '../../engine/core/event-bus';
import { bindCard, initialVectorState, prepareVector, type VectorState } from './runtime';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { POSITIVE_EXAMPLES } from './genesis/test-fixtures';
import { tasksAfterSave, stable } from './genesis/post-save';
import { CARD_API } from './genesis/generation-prompt';
import { ROUND_PROBLEMS } from './round-abilities';
import { projectSavedElements } from './saved-elements';
import rulesJSON from '../../../public/packs/tianming/rules/plot-vector.json';
import { parseNativeRules } from './native-input';
import { parseSupplyRules } from './supply';
import { parseVectorPromptPolicy } from './prompt-policy';
import { FieldRepairPipeline } from '../../engine/pipeline/sub-pipelines/field-repair';
import type { AIService } from '../../engine/ai/ai-service';
import type { PromptAssembler } from '../../engine/prompt/prompt-assembler';
import type { GamePack } from '../../engine/types';
import type { AIMessage } from '../../engine/ai/types';
import promptRules from '../../../public/packs/tianming/rules/plot-vector-prompts.json';

// The trip runs in the page; tests watch (and can fail) the two runtime calls the adapter makes.
const runtimeCalls = vi.hoisted(() => ({ prepare: vi.fn(), accept: vi.fn() }));
vi.mock('./runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtime')>();
  return { ...actual,
    prepareVector: (...args: Parameters<typeof actual.prepareVector>) => { runtimeCalls.prepare(...args); return actual.prepareVector(...args); },
    acceptVector: (...args: Parameters<typeof actual.acceptVector>) => { runtimeCalls.accept(...args); return actual.acceptVector(...args); } };
});
/** A card in the contract format (rebuild plan §2.2) for one entry, adding 1 on one channel each pass. */
const card = (name: string, type: string, channel: 'push' | 'drag' | 'social' | 'chance' = 'push') =>
  ({ for: name, type, summary: `${name}的一句话`, onPass: `return { ${channel}: 1 };` });
const departed = (v: VectorState, id: string) => v.last!.result.trace.some(e => e.owner?.id === id && e.visitId === 'departure' && e.status === 'applied');

let adapters: AgaPlotVectorAdapter[];
let cleanups: Array<() => void>;
beforeEach(() => {
  adapters = []; cleanups = [];
  runtimeCalls.prepare.mockReset(); runtimeCalls.accept.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { adapters.forEach(a => a.dispose()); cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
function setup(opts: { supply?: boolean } = {}) {
  const state = new StateManager(); state.loadTree({});
  let slot = { profileId: 'p', slotId: 's' };
  let disk: unknown;
  const ai = { generate: vi.fn(async (): Promise<string> => { throw new Error('no model call expected'); }) };
  const saveGame = vi.fn(async (_p: string, _s: string, data: unknown, _meta?: unknown,
    commit?: { guard: () => void; committed: () => void }) => {
    commit?.guard(); disk = structuredClone(data); commit?.committed();
  });
  const adapter = new AgaPlotVectorAdapter(state, ai, { saveGame }, () => slot,
    parseNativeRules(rulesJSON), parseVectorPromptPolicy(promptRules, 'mode contract'), opts.supply ? parseSupplyRules(rulesJSON) : undefined); adapters.push(adapter);
  // Like the orchestrator: a load or rollback makes an unfinished round stale.
  let revision = 0;
  cleanups.push(eventBus.on<{ type?: string }>('engine:state-changed', e => { if (e.type === 'load' || e.type === 'rollback') revision++; }));
  const ctx = (): PipelineContext => ({ generationId: crypto.randomUUID(), roundNumber: 1, stateSnapshot: state.toSnapshot(),
    userInput: '继续', actionQueuePrompt: '', chatHistory: [], worldEventTriggered: false, messages: [{ role: 'user', content: '继续' }],
    meta: { roundOwnership: new RoundOwnership(() => slot, () => revision, new AbortController().signal) } });
  return { state, ai, saveGame, adapter, ctx, changeSlot: () => { slot = { ...slot, slotId: 'other' }; },
    setSlot: (slotId: string) => { slot = { ...slot, slotId }; }, disk: () => disk };
}
type Harness = ReturnType<typeof setup>;
const vector = (h: Harness) => h.state.get<VectorState>(P.plotVector)!;
const row = (h: Harness, id: string) => vector(h).tasks.find(t => t.task.entry.id === id);
const cardIds = (h: Harness) => vector(h).cards.map(c => c.task.entry.id).sort();
/**
 * One story round as the host runs it: assembly with the feature's prompt mode, the trip, the reply (with the
 * round's ability block when given), the save. `during` changes the state the way the reply's commands would.
 */
async function playRound(h: Harness, roundNumber: number, opts: { during?: () => void; cards?: unknown[]; block?: string } = {}) {
  h.state.set(P.roundNumber, roundNumber);
  const c = { ...h.ctx(), roundNumber };
  h.adapter.promptTransform(c);
  const ctx = await h.adapter.prepare(c);
  opts.during?.();
  const block = opts.block ?? (opts.cards ? JSON.stringify(opts.cards) : undefined);
  ctx.parsedResponse = { text: '正文', ...(block !== undefined ? { sidecars: { 能力: block } } : {}) };
  await h.adapter.beforeSave(ctx); ctx.meta.roundOwnership!.saved = true; await h.adapter.afterSave(ctx);
  return ctx;
}
/** The real Step3 pipeline with a stand-in model (`reply` sees the request's task text). */
function step3(h: Harness, reply: (request: string) => unknown) {
  const generate = vi.fn(async (o: { messages: AIMessage[] }) => JSON.stringify(reply(String(o.messages.at(-1)?.content ?? ''))));
  const pipeline = new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate } as unknown as AIService, new ResponseParser(),
    {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
  return { generate, run: () => pipeline.execute() };
}
const lastRequest = (generate: ReturnType<typeof vi.fn>) =>
  String((generate.mock.calls.at(-1) as unknown as [{ messages: Array<{ content: string }> }])[0].messages.at(-1)!.content);
/** Toasts the component emits. */
function toasts() {
  const seen: Array<{ i18nKey?: string; message?: string }> = [];
  const off = eventBus.on<{ i18nKey?: string; message?: string }>('ui:toast', t => { if (t?.i18nKey) seen.push(t); });
  return { seen, off };
}

describe('AGA opt-in integration (zero network)', () => {
  for (const commands of [undefined, []]) it(`an unsuccessful parse in active mode keeps the story like the original flow, commands=${String(commands)}`, async () => {
    const h = setup(); writePlotVectorControl(true);
    const prepared = await h.adapter.prepare(h.ctx());
    const broken = { ...prepared, parsedResponse: { text: '东西买好了。', commands, parseOk: false } };
    await expect(h.adapter.beforeSave(broken)).resolves.toBeUndefined();
    expect(runtimeCalls.accept).toHaveBeenCalledTimes(1);
    expect(vector(h).session.round).toBe(2);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('does not change legacy off-mode handling of an unsuccessful parse', async () => {
    const h = setup(); const ctx = { ...h.ctx(), parsedResponse: { text: 'raw', parseOk: false } };
    await h.adapter.beforeSave(ctx);
    expect(runtimeCalls.prepare).not.toHaveBeenCalled(); expect(runtimeCalls.accept).not.toHaveBeenCalled();
  });
  for (const roles of [
    ['system', 'user'],
    ['system', 'user', 'assistant'],
    ['system', 'assistant', 'assistant', 'system', 'user', 'assistant'],
    ['system', 'user', 'assistant', 'user', 'assistant', 'assistant'],
    ['system', 'assistant'],
    [],
  ] as const) it(`inserts impulse and the ability block before the final user without changing originals: ${roles.join('/')}`, async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 魅力: 10 });
    const c = h.ctx();
    c.messages = roles.map((role, i) => ({ role, content: `original-${i}` }));
    c.messageSources = roles.map((_, i) => `source-${i}`);
    const originals = structuredClone(c.messages), sources = [...c.messageSources];
    h.adapter.promptTransform(c);
    const out = await h.adapter.prepare(c);
    const added = out.messageSources!.flatMap((s, i) => s.startsWith('plot-vector') || s === 'ability-block' ? [i] : []);
    expect(added).toHaveLength(3); // mode, impulse, and (a single call writes the entries) the ability block
    expect(String(out.messages[out.messageSources!.indexOf('ability-block')].content)).toContain('onPass');
    expect(out.meta.responseSidecars).toEqual(['能力']);
    const user = out.messages.map(m => m.role).lastIndexOf('user');
    if (user >= 0) expect(added.every(i => i < user)).toBe(true);
    else expect(added).toEqual([0, 1, 2]);
    expect(out.messages.filter((_, i) => !added.includes(i))).toEqual(originals);
    expect(out.messageSources!.filter((_, i) => !added.includes(i))).toEqual(sources);
    expect(c.messages).toEqual(originals);
    expect(out.messages).toHaveLength(out.messageSources!.length);
  });
  it('keeps mode even with no impulse and gives Step2 the ability block, late and not the vector', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); c.meta.splitStep2Messages = [{ role: 'system', content: 'commands' }, { role: 'user', content: 'player input' }];
    expect(h.adapter.promptTransform(c)).toBeTypeOf('function');
    const result = await h.adapter.prepare(c);
    expect(result.messageSources).toContain('plot-vector-mode');
    expect(result.messages.find(m => m.content === 'mode contract')).toBeDefined();
    // After every Step2 module, right before the player's turn (I22).
    expect(result.meta.splitStep2Sources).toEqual(['unknown', 'ability-block', 'unknown']);
    expect(String(result.meta.splitStep2Messages![1].content)).toContain('onPass');
    expect(result.meta.splitStep2Messages!.filter((_, i) => i !== 1)).toEqual([{ role: 'system', content: 'commands' }, { role: 'user', content: 'player input' }]);
    expect(result.meta.responseSidecars).toEqual(['能力']);
    // The vector itself (axes and values) stays out of Step2.
    expect(result.meta.splitStep2Messages!.some(m => typeof m.content === 'string' && m.content.includes('维度说明与数值'))).toBe(false);
    expect(result.messageSources).not.toContain('plot-vector');
    expect(result.messageSources).not.toContain('ability-block');
  });
  it('rejects mode changes during context assembly in either direction', async () => {
    const h = setup();
    const off = h.ctx(); expect(h.adapter.promptTransform(off)).toBeUndefined();
    writePlotVectorControl(true);
    await expect(h.adapter.prepare(off)).rejects.toThrow('组装期间');
    const on = h.ctx(); h.adapter.promptTransform(on); writePlotVectorControl(false);
    await expect(h.adapter.prepare(on)).rejects.toThrow('组装期间');
    expect(runtimeCalls.prepare).not.toHaveBeenCalled();
  });
  it('invalidates a context assembled for a different loaded slot', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); h.adapter.promptTransform(c); h.changeSlot();
    await expect(h.adapter.prepare(c)).rejects.toThrow('存档已切换');
    expect(c.meta.roundOwnership?.invalidated).toBe(true);
    expect(runtimeCalls.prepare).not.toHaveBeenCalled();
  });
  it('does not adapt enhanced opening or mutate persisted CoT preferences', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set('系统.设置.cot', { enabled: true, judgeEnabled: true });
    const before = h.state.toSnapshot();
    const c = h.ctx(); c.meta.isEnhancedOpening = true;
    expect(h.adapter.promptTransform(c)).toBeUndefined();
    expect(await h.adapter.prepare(c)).toBe(c);
    expect(h.state.toSnapshot()).toEqual(before);
    expect(runtimeCalls.prepare).not.toHaveBeenCalled();
  });
  it('injects saved attributes with no cards; a new entry without an ability waits for Step3, and nothing is requested', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 心性: 10, 悟性: 15 });
    const ctx = await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    expect(ctx.messageSources).toContain('plot-vector');
    expect(runtimeCalls.prepare.mock.calls[0][3]).toMatchObject({ visitBudget: 11, payload: { 'S+': 2 } });
    expect(row(h, 'environment:name:微风')).toMatchObject({ error: ROUND_PROBLEMS.noBlock });
    expect(h.ai.generate).not.toHaveBeenCalled();
    // This round's Step3 gets it.
    expect((await h.adapter.abilityRepairTask())?.block).toContain('微风');
  });
  it('a context outside a host-owned round is left untouched (the round owner is the only identity check)', async () => {
    const h = setup(); writePlotVectorControl(true);
    const c = h.ctx(); delete c.meta.roundOwnership;
    expect(h.adapter.promptTransform(c)).toBeUndefined();
    expect(await h.adapter.prepare(c)).toBe(c);
    expect(runtimeCalls.prepare).not.toHaveBeenCalled();
  });
  it('off means identical context, no trip, no generation, no component state writes', async () => {
    const h = setup(), ctx = h.ctx();
    expect(await h.adapter.prepare(ctx)).toBe(ctx);
    await h.adapter.beforeSave(ctx); await h.adapter.afterSave(ctx);
    expect(runtimeCalls.prepare).not.toHaveBeenCalled(); expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.get(P.plotVector)).toBeUndefined();
  });
  it('the round block binds the new item with the round itself: no separate request, and the card is in the state being saved', async () => {
    const h = setup(); writePlotVectorControl(true);
    const note = toasts();
    try {
      await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '随身热茶', 描述: '暖和的热茶', 数量: 2 } }),
        cards: [POSITIVE_EXAMPLES[0].card] });
      expect(cardIds(h)).toEqual(['item:tea']);
      expect(vector(h).tasks).toEqual([]);
      expect(h.ai.generate).not.toHaveBeenCalled();
      expect(h.saveGame).not.toHaveBeenCalled(); // written by the round's own save, not a second one
      expect(note.seen).toEqual([expect.objectContaining({ i18nKey: 'mainGame.toast.vectorNewCards', message: '获得新卡：随身热茶' })]);
    } finally { note.off(); }
  });
  // Phase 6 (PO 3A): an exhausted supply card leaves, the hand draws one, and the player hears about it after the save.
  it('a round that uses up a supply card draws one in its place and announces it after the save', async () => {
    const h = setup({ supply: true }); writePlotVectorControl(true);
    h.state.set(P.plotVector, { ...initialVectorState(), session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 } } },
      layout: { placements: { '01': 'basic:push', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
    const note = toasts();
    const gained: string[][] = [];
    cleanups.push(eventBus.on<{ names?: string[] }>('plotVector:cards-gained', e => { gained.push(e?.names ?? []); }));
    try {
      await playRound(h, 1);
      const supply = parseSupplyRules(rulesJSON)!;
      expect(runtimeCalls.prepare.mock.calls[0][4]).toEqual(supply);
      expect(runtimeCalls.accept.mock.calls[0][2]).toEqual(supply);
      const hand = vector(h).supply!.hand;
      expect(hand.map(c => c.id)).not.toContain('basic:push');
      expect(hand).toHaveLength(3);
      const drawn = hand.find(c => c.id === vector(h).supply!.lastDrawn![0])!;
      const name = supply.cards.find(c => c.id === drawn.cardId)!.name.zh;
      const en = supply.cards.find(c => c.id === drawn.cardId)!.name.en;
      expect(note.seen).toEqual([expect.objectContaining({ i18nKey: 'mainGame.toast.vectorSupplyDrawn', message: `补给送来新卡：${name}`,
        i18nParams: expect.objectContaining({ names: name, namesEn: en }) })]);
      expect(gained).toEqual([[name]]);
    } finally { note.off(); }
  });
  it('a retried save of the same round draws and announces once', async () => {
    const h = setup({ supply: true }); writePlotVectorControl(true);
    h.state.set(P.plotVector, { ...initialVectorState(), session: { ...initialVectorState().session, cardStates: { 'basic:push': { stock: 1 } } },
      layout: { placements: { '01': 'basic:push', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
    const note = toasts();
    try {
      const c = { ...h.ctx(), roundNumber: 1 }; h.state.set(P.roundNumber, 1);
      h.adapter.promptTransform(c);
      const ctx = await h.adapter.prepare(c);
      ctx.parsedResponse = { text: '正文' };
      await h.adapter.beforeSave(ctx);
      const hand = vector(h).supply!.hand.map(x => x.id);
      await h.adapter.beforeSave(ctx);   // the host retries the save
      expect(vector(h).supply!.hand.map(x => x.id)).toEqual(hand);
      expect(vector(h).supply!.drawn).toBe(1);
      ctx.meta.roundOwnership!.saved = true; await h.adapter.afterSave(ctx);
      expect(note.seen.filter(t => t.i18nKey === 'mainGame.toast.vectorSupplyDrawn')).toHaveLength(1);
    } finally { note.off(); }
  });
  it('the notice waits for the save: a round that is not saved announces nothing', async () => {
    const h = setup(); writePlotVectorControl(true);
    const note = toasts();
    try {
      const c = h.ctx(); h.adapter.promptTransform(c);
      const ctx = await h.adapter.prepare(c);
      h.state.set(P.inventoryItems, { tea: { 名称: '随身热茶' } });
      ctx.parsedResponse = { text: '', sidecars: { 能力: JSON.stringify([POSITIVE_EXAMPLES[0].card]) } };
      await h.adapter.beforeSave(ctx);
      await h.adapter.afterSave(ctx); // not saved
      expect(note.seen).toEqual([]);
    } finally { note.off(); }
  });
  it('no new entry means nothing to bind; quantity-only changes are not new entries', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 2 } });
    await playRound(h, 1, { during: () => h.state.set(`${P.inventoryItems}.tea.数量`, 1), cards: [card('茶', 'item')] });
    expect(vector(h).cards).toEqual([]);
    expect(vector(h).tasks).toEqual([]);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('parsed inventory commands: only entries that survive into the save are bound; custody text reaches Step3 as data', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 2 }, old: { 名称: '借来的笔', 描述: '用后归还', 数量: 1 } });
    // A transport fixture, not generated narrative or evidence of model compliance.
    const parsed = new ResponseParser().parse(JSON.stringify({ commands: [
      { action: 'set', path: `${P.inventoryItems}.tea.数量`, value: 1 },
      { action: 'delete', path: `${P.inventoryItems}.old` },
      { action: 'set', path: `${P.inventoryItems}.delivered`, value: { 名称: '代购物品', 数量: 1 } },
      { action: 'delete', path: `${P.inventoryItems}.delivered` },
      { action: 'set', path: `${P.inventoryItems}.map`, value: { 名称: '借阅地图', 描述: '属于旅店，借给玩家辨路，离开时归还。', 数量: 1 } },
    ] }));
    expect(parsed.commands).toHaveLength(5);
    await playRound(h, 1, { during: () => {
      expect(new CommandExecutor(h.state).executeBatch(parsed.commands!).results.every(r => r.success)).toBe(true);
    }, cards: [card('代购物品', 'item'), card('借来的笔', 'item')] });
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    expect(h.state.get(`${P.inventoryItems}.old`)).toBeUndefined();
    expect(vector(h).cards).toEqual([]); // neither card belongs to an entry that entered the save
    expect(vector(h).tasks.map(t => [t.task.entry.id, t.error])).toEqual([['item:map', ROUND_PROBLEMS.missing]]);
    const task = await h.adapter.abilityRepairTask();
    const listed = JSON.parse(task!.block.slice(task!.block.indexOf('['), task!.block.indexOf(']\n') + 1)) as Array<Record<string, unknown>>;
    expect(listed.find(e => e.id === 'item:map')).toMatchObject({ type: 'item', name: '借阅地图', description: expect.stringContaining('离开时归还'), problem: ROUND_PROBLEMS.missing });
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
    expect(ctx.meta.roundOwnership?.invalidated).toBe(true);
  });
  it('a load during a player retry rejects its late reply; the loaded save is left alone', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '茶' } }) });
    let answer!: (value: string) => void;
    h.ai.generate.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.adapter.regenerateAbility('item:tea');
    await vi.waitFor(() => expect(h.ai.generate).toHaveBeenCalledTimes(1));
    h.state.loadTree({ unrelated: true }); answer(JSON.stringify(card('茶', 'item')));
    await expect(pending).rejects.toThrow();
    expect(h.state.toSnapshot()).toEqual({ unrelated: true });
  });
  it('growth is accepted once, not per visit; component and story share the save snapshot', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { notebook: { 名称: '随身日记', 描述: '记录日常' } });
    const entries = projectSavedElements(h.state.toSnapshot()).entries;
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: entries })[0];
    const bound = bindCard(task, POSITIVE_EXAMPLES[2].card);
    h.state.set(P.plotVector, { ...initialVectorState(), cards: [bound], layout: { placements: { '01': bound.task.entry.id }, tray: [] } });
    const ctx = await h.adapter.prepare(h.ctx());
    expect(ctx.messages.some(m => typeof m.content === 'string' && m.content.includes('剧情'))).toBe(true);
    await h.adapter.beforeSave(ctx); const first = h.state.toSnapshot();
    await h.adapter.beforeSave(ctx); expect(h.state.toSnapshot()).toEqual(first);
    expect(vector(h).growth[bound.task.entry.id]).toMatchObject({ level: 1 });
    ctx.meta.roundOwnership!.saved = true; await h.adapter.afterSave(ctx);
    h.state.set(`${P.inventoryItems}.notebook.描述`, '今天又写下几行待办');
    const restored = h.state.toSnapshot(); h.state.loadTree(restored);
    await playRound(h, 2);
    const current = vector(h);
    expect(current.layout?.placements['01']).toBe(bound.task.entry.id);
    expect(current.growth[bound.task.entry.id]).toMatchObject({ level: 2 });
    // Reworded, the item keeps its card (only its mechanics would call for a new one).
    expect(current.cards[0].spec).toEqual(bound.spec);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('an entry that already has its card is never regenerated, whatever stale rows say', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.inventoryItems, { notebook: { 名称: '日记', 描述: '第一页' } });
    const entry = projectSavedElements(h.state.toSnapshot()).entries[0];
    const task = tasksAfterSave({ id: 'old', success: true, before: [], after: [entry] })[0];
    const bound = bindCard(task, POSITIVE_EXAMPLES[2].card);
    const changed = { ...entry, capability: { ...entry.capability, description: '第二页' } };
    h.state.set(`${P.inventoryItems}.notebook.描述`, '第二页');
    h.state.set(P.plotVector, { ...initialVectorState(), cards: [bound], tasks: [{ task: { ...task, entry: changed, key: stable(changed) }, error: 'stale' }] });
    await playRound(h, 1);
    expect(h.adapter.abilityBacklog()).toEqual([]);
    expect(await h.adapter.abilityRepairTask()).toBeNull();
    expect(vector(h).cards[0].spec).toEqual(bound.spec);
    expect(vector(h).tasks).toEqual([]);
  });
  it('a player retry whose count cannot be saved sends nothing and leaves the state as it was', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '茶' } }) });
    const before = h.state.toSnapshot();
    h.saveGame.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.adapter.regenerateAbility('item:tea')).rejects.toThrow('disk full');
    expect(h.ai.generate).not.toHaveBeenCalled();
    expect(h.state.toSnapshot()).toEqual(before);
  });
  it('binds a round card to the saved item and reloads it as an executable card; the entry decides the type', async () => {
    const h = setup(); writePlotVectorControl(true);
    // The model declares a type; the entry's own place wins. A fenced block is read too.
    const output = { for: '随身热茶', type: 'talent', summary: '每次经过，机会 +2。', onPass: 'return { chance: 2 };' };
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '随身热茶', 描述: '忙碌时递来的一杯暖茶', 数量: 1 } }),
      block: '```json\n' + JSON.stringify([output]) + '\n```' });
    const reloaded = new StateManager(); reloaded.loadTree(structuredClone(h.state.toSnapshot()));
    const stored = reloaded.get<VectorState>(P.plotVector)!;
    expect(stored.cards[0].spec).toMatchObject({ type: 'item', summary: output.summary, onPass: output.onPass });
    const preview = prepareVector({ ...stored, layout: { placements: { '01': 'item:tea' }, tray: [] } },
      projectSavedElements(reloaded.toSnapshot()).entries, 'next-turn',
      { ruleId: 'test', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 2, contributions: [] });
    expect(preview.result.trace.filter(e => e.owner?.id === 'item:tea' && e.status === 'applied')).toHaveLength(1);
    expect(preview.result.finalState.shuttle.J).toBeGreaterThanOrEqual(2);
    expect(preview.board.cards[0]).toMatchObject({ label: { zh: '随身热茶' }, originalText: { zh: '忙碌时递来的一杯暖茶' }, summary: { zh: output.summary } });
  });
  it('disable after commit retains story, but changing slots still fences rendering', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx()); await h.adapter.beforeSave(ctx); ctx.meta.roundOwnership!.saved = true;
    writePlotVectorControl(false);
    expect(() => ctx.meta.plotVectorGuard!()).not.toThrow();
    h.changeSlot(); expect(() => ctx.meta.plotVectorGuard!()).toThrow();
    expect(ctx.meta.roundOwnership?.saved).toBe(true);
  });
});

describe('the component only degrades: the story always goes on (rebuild plan §7)', () => {
  it('a failed trip computation: no momentum this round, the round is saved and its new entries still get their cards', async () => {
    const h = setup(); writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 10, 魅力: 10 });
    const before = h.state.get<VectorState>(P.plotVector);
    runtimeCalls.prepare.mockImplementationOnce(() => { throw new Error('剧情动能这回合算不出来（test）'); });
    const note = toasts();
    try {
      const ctx = await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } }), cards: [card('茶', 'item')] });
      expect(ctx.messageSources).toContain('plot-vector-mode');   // the judgment stays replaced
      expect(ctx.messageSources).not.toContain('plot-vector');     // but no momentum is injected
      expect(note.seen.map(t => t.i18nKey)).toEqual(['mainGame.toast.vectorNotComputed', 'mainGame.toast.vectorNewCards']);
      expect(runtimeCalls.accept).not.toHaveBeenCalled();
      expect(vector(h).session).toEqual((before ?? initialVectorState()).session); // nothing advanced
      expect(cardIds(h)).toEqual(['item:tea']);
      // The next round computes again.
      const next = await h.adapter.prepare(h.ctx());
      expect(next.messageSources).toContain('plot-vector');
    } finally { note.off(); }
  });
  it('a cancelled or switched round still stops, as before', async () => {
    const h = setup(); writePlotVectorControl(true);
    runtimeCalls.prepare.mockImplementationOnce(() => { h.changeSlot(); throw new Error('cancelled'); });
    const c = h.ctx();
    await expect(h.adapter.prepare(c)).rejects.toThrow('存档已切换');
    expect(c.meta.roundOwnership?.invalidated).toBe(true);
  });
  it('a failed settlement saves the story and items; this round\'s momentum and growth do not advance', async () => {
    const h = setup(); writePlotVectorControl(true);
    const ctx = await h.adapter.prepare(h.ctx());
    const before = h.state.get<VectorState>(P.plotVector) ?? initialVectorState();
    runtimeCalls.accept.mockImplementationOnce(() => { throw new Error('settlement failed (test)'); });
    const note = toasts();
    try {
      h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
      await expect(h.adapter.beforeSave(ctx)).resolves.toBeUndefined();
      expect(note.seen.map(t => t.i18nKey)).toEqual(['mainGame.toast.vectorNotSettled']);
    } finally { note.off(); }
    const saved = vector(h);
    expect(saved.session).toEqual(before.session);
    expect(saved.last).toEqual(before.last);
    expect(saved.tasks.map(t => t.task.entry.id)).toEqual(['item:tea']);
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
  });
  it('a card that fails the one check never binds; its reply is kept with the reason for Step3, and nothing is requested', async () => {
    const h = setup(); writePlotVectorControl(true);
    const bad = { for: '茶', type: 'item', summary: '一句话', onPass: 'return {' };
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } }), cards: [bad] });
    expect(vector(h).cards).toEqual([]);
    expect(row(h, 'item:tea')).toMatchObject({ raw: JSON.stringify(bad), error: expect.stringMatching(/onPass does not compile/) });
    expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(1);
    await playRound(h, 2);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
});

describe('one round, several new entries (PO acceptance shape)', () => {
  it('an item, a talent and a status acquired together are bound from one block; one broken card leaves only its entry for Step3', async () => {
    const h = setup(); writePlotVectorControl(true);
    const block = `[${JSON.stringify(card('冰敷贴', 'item'))}, {"for":"口才","type":"talent","onPass": return oops }, ${JSON.stringify(card('发烧', 'status', 'drag'))}]`;
    await playRound(h, 1, { during: () => {
      h.state.set(P.inventoryItems, { ice: { 名称: '冰敷贴', 描述: '剩下的冰敷贴', 数量: 2 } });
      h.state.set(P.talents, ['口才']);
      h.state.set(P.statusEffects, [{ 状态名称: '发烧', 状态描述: '头很沉' }]);
    }, block });
    expect(cardIds(h)).toEqual(['effect:name:发烧', 'item:ice']);
    expect(h.adapter.abilityBacklog().map(b => [b.id, b.state, b.problem])).toEqual([['talent:name:口才', 'failed', ROUND_PROBLEMS.broken]]);
    const { generate, run } = step3(h, () => ({ abilities: [{ id: 'talent:name:口才', card: card('口才', 'talent', 'social') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(lastRequest(generate)).toContain('oops'); // the broken card goes back as the previous ability
    expect(cardIds(h)).toEqual(['effect:name:发烧', 'item:ice', 'talent:name:口才']);
    expect(vector(h).tasks).toEqual([]);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('entries there before the feature was on wait in the backlog; Step3 fills them over rounds, at most REPAIR_BATCH per request', async () => {
    const h = setup();
    const many = Object.fromEntries(Array.from({ length: REPAIR_BATCH + 3 }, (_, i) => [`k${i}`, { 名称: `旧物${i}`, 描述: `旧物${i}` }]));
    h.state.set(P.inventoryItems, many);
    writePlotVectorControl(true);
    await playRound(h, 1);
    expect(h.adapter.abilityBacklog()).toHaveLength(REPAIR_BATCH + 3);
    expect(h.adapter.abilityBacklog().every(b => b.state === 'waiting')).toBe(true);
    const answerAll = (request: string) => ({ abilities: [...request.matchAll(/"id": "(item:k\d+)"/g)].map(m => ({ id: m[1], card: card('x', 'item') })) });
    const first = step3(h, answerAll);
    expect((await first.run()).extra).toEqual({ resolved: true });
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(first.generate.mock.calls[0][0].messages).toHaveLength(1); // the task alone: no game state, memory or history
    expect(vector(h).cards).toHaveLength(REPAIR_BATCH);
    expect(h.adapter.abilityBacklog()).toHaveLength(3);
    await playRound(h, 2);
    await step3(h, answerAll).run();
    expect(vector(h).cards).toHaveLength(REPAIR_BATCH + 3);
    expect(h.adapter.abilityBacklog()).toEqual([]);
  });
});

describe('environment abilities come from the same block (PO correction)', () => {
  const environmentCards = (h: Harness) => vector(h).cards.filter(c => c.task.entry.kind === 'environment');

  it('a saved item card on the board is not consumed: the item stays in the inventory round after round', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 2 } }), cards: [card('茶', 'item')] });
    expect(cardIds(h)).toEqual(['item:tea']);
    h.state.set(P.plotVector, { ...vector(h), layout: { placements: { '01': 'item:tea', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
    for (const n of [2, 3]) {
      await playRound(h, n);
      expect(vector(h).last!.result.trace.some(e => e.owner?.id === 'item:tea' && e.status === 'applied')).toBe(true);
      expect(h.state.get(`${P.inventoryItems}.tea.数量`)).toBe(2);
    }
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('bound with the round, acting at departure next round, kept when not rewritten, replaced, then removed', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑' }]),
      cards: [card('细雨', 'environment', 'social')] });
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:细雨']);
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑' }]); // the story state holds no card
    const bound = environmentCards(h)[0].spec;
    expect(bound.type).toBe('environment');
    // Next round: Step2 re-emits the same tag and writes no card for it → kept, acting like weather.
    await playRound(h, 2, { during: () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '路滑' }]) });
    expect(Object.values(vector(h).last!.layout.placements)).not.toContain('environment:name:细雨');
    expect(departed(vector(h), 'environment:name:细雨')).toBe(true);
    expect(environmentCards(h).map(c => c.spec)).toEqual([bound]);
    // The environment changes: the new tag's card replaces the old one.
    await playRound(h, 3, { during: () => h.state.set(P.environmentTags, [{ 名称: '放晴', 描述: '云开日出', 效果: '' }]), cards: [card('放晴', 'environment', 'chance')] });
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:放晴']);
    // The environment clears: its card goes with it.
    await playRound(h, 4, { during: () => h.state.set(P.environmentTags, []) });
    expect(environmentCards(h)).toEqual([]);
    expect(h.ai.generate).not.toHaveBeenCalled();
  });
  it('a same-name environment updated without a new card stops using the old one; Step3 fills it and later rounds use the new one', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '湿滑' }]), cards: [card('路面', 'environment', 'drag')] });
    const wet = environmentCards(h)[0].spec.onPass;
    await playRound(h, 2, { during: () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '干燥' }]), cards: [] });
    expect(environmentCards(h)).toEqual([]); // the old wet-road ability no longer takes part
    const repair = await h.adapter.abilityRepairTask();
    expect(repair?.block).toContain('路面');
    expect(repair?.block).toContain(ROUND_PROBLEMS.missing);
    const { run } = step3(h, () => ({ abilities: [{ id: 'environment:name:路面', card: card('路面', 'environment', 'push') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    const dry = environmentCards(h).map(c => c.spec.onPass);
    expect(dry).toHaveLength(1); expect(dry[0]).not.toBe(wet);
    await playRound(h, 3, { during: () => h.state.set(P.environmentTags, [{ 名称: '路面', 描述: '石板路', 效果: '干燥' }]) });
    const ran = vector(h).last!.result.trace.filter(e => e.owner?.id === 'environment:name:路面' && e.status === 'applied');
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every(e => e.visitId === 'departure' && e.deltas.some(d => d.channelOrField === 'S+'))).toBe(true);
    expect(environmentCards(h).map(c => c.spec.onPass)).toEqual(dry);
  });
  it('an invalid environment card rides the existing Step3 request and loads once fixed', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '浓雾', 描述: '看不清路', 效果: '' }]),
      cards: [{ for: '浓雾', type: 'environment', summary: '看不清', onPass: 'return {' }] });
    expect(environmentCards(h)).toEqual([]);
    const { generate, run } = step3(h, () => ({ abilities: [{ id: 'environment:name:浓雾', card: card('浓雾', 'environment', 'drag') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(generate).toHaveBeenCalledTimes(1);
    const request = lastRequest(generate);
    expect(request).toContain('<能力补生>');
    expect(request).toContain('浓雾');
    expect(request).toContain('does not compile'); // the concrete diagnostic, not a request to judge
    expect(request).toContain('onPass');           // the same card domain Step2 uses
    expect(environmentCards(h).map(c => c.task.entry.id)).toEqual(['environment:name:浓雾']);
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '浓雾', 描述: '看不清路', 效果: '' }]);
    expect(await h.adapter.abilityRepairTask()).toBeNull(); // nothing left to repair
  });
  it('a repair that never validates stays bounded, keeps the round, and is reported as unresolved (not as field success)', async () => {
    const h = setup(); writePlotVectorControl(true);
    const still = { for: '浓雾', type: 'environment', summary: '看不清', onPass: 'return {' };
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '浓雾', 描述: '看不清路', 效果: '' }]), cards: [still] });
    const { generate, run } = step3(h, () => ({ abilities: [{ id: 'environment:name:浓雾', card: still }] }));
    const result = await run();
    expect(result.extra).toEqual({ resolved: false });
    expect(result.fieldsNeeded).toBe(false);
    expect(generate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(generate.mock.calls.length).toBeLessThanOrEqual(result.attempts);
    expect(environmentCards(h)).toEqual([]);
    expect(vector(h).session.round).toBe(2); // the round itself stays committed
  });
  it('a duplicated environment tag name does not silently drop the card of a tag that is still there', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '' }]), cards: [card('细雨', 'environment', 'social')] });
    const bound = environmentCards(h).map(c => c.spec);
    await playRound(h, 2, { during: () => h.state.set(P.environmentTags, [{ 名称: '细雨', 描述: '雨丝细密', 效果: '' }, { 名称: '细雨', 描述: '又下起来', 效果: '' }]) });
    expect(environmentCards(h).map(c => c.spec)).toEqual(bound);
    await playRound(h, 3, { during: () => h.state.set(P.environmentTags, []) });
    expect(environmentCards(h)).toEqual([]);
  });
});

describe('ability failure lifecycle: the obtained entry stays, only the card is dropped and can be regenerated (PO D8)', () => {
  const brokenCard = { for: '修复药膏', type: 'item', summary: '术后用', onPass: 'const x = null; return x.y;' };
  const broken = JSON.stringify(brokenCard);
  const ointment = { 名称: '修复药膏', 数量: 1, 描述: '术后用' };
  const acquire = (h: Harness, n = 1) => playRound(h, n, { during: () => h.state.set(P.inventoryItems, { ointment }), cards: [brokenCard] });
  /** A page reload: a new adapter over the saved tree. */
  function reload(h: Harness) {
    const next = setup();
    next.state.loadTree(structuredClone(h.state.toSnapshot()));
    return next;
  }
  /** The model call behind a player retry. */
  function network(h: Harness, send: () => Promise<string>) {
    const sends = vi.fn(send);
    h.ai.generate.mockImplementation(sends as never);
    return sends;
  }

  it('a failed ability keeps the item, its name, description and quantity; no card is faked and the board lists it as not ready', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    expect(row(h, 'item:ointment')).toMatchObject({ raw: broken });
    expect(vector(h).cards).toEqual([]);
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
    expect(h.adapter.abilityBacklog().map(b => [b.id, b.name, b.state])).toEqual([['item:ointment', '修复药膏', 'failed']]);
  });

  it("this round's Step3 regenerates it in the task's own reply field and binds it without writing to the item", async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    const { generate, run } = step3(h, () => ({ commands: [], abilities: [{ id: 'item:ointment', card: card('修复药膏', 'item', 'social') }] }));
    const result = await run();
    expect(result.extra).toEqual({ resolved: true });
    const request = lastRequest(generate);
    expect(request).toContain('<能力补生>');
    expect(request).toContain('修复药膏');
    expect(request).toContain('x.y');       // the previous ability, so the new one can avoid the same failure
    expect(request).toContain('"abilities"'); // the reply field
    expect(request).toContain('onPass');      // the same card domain the round block uses
    expect(cardIds(h)).toEqual(['item:ointment']);
    expect(row(h, 'item:ointment')).toBeUndefined(); // rows only describe entries still without a card
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
    expect(await h.adapter.abilityRepairTask()).toBeNull();
  });

  it('a Step3 regeneration asks for no commands and never applies commands from its reply', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    const { generate, run } = step3(h, () => ({
      commands: [{ action: 'set', key: `${P.inventoryItems}.ointment.能力`, value: 'smuggled' }],
      abilities: [{ id: 'item:ointment', card: card('修复药膏', 'item', 'social') }],
    }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(lastRequest(generate)).not.toContain('"commands"');
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('after a reload a later Step3 still finds the waiting entry; automatic tries stop after two rounds; the story keeps going', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    // Round 1's Step3 reply forgot the ability: bounded retries inside the round, counted as one round.
    const first = step3(h, () => ({ commands: [] }));
    expect((await first.run()).extra).toEqual({ resolved: false });
    expect(row(h, 'item:ointment')?.retry).toMatchObject({ autoRounds: 1, lastAutoRound: 1 });
    const h2 = reload(h);
    await playRound(h2, 2);
    const second = step3(h2, () => ({ commands: [], abilities: [{ id: 'item:ointment', card: brokenCard }] }));
    expect((await second.run()).extra).toEqual({ resolved: false });
    expect(row(h2, 'item:ointment')).toMatchObject({ raw: broken, retry: { autoRounds: 2, source: 'step3' } });
    expect(row(h2, 'item:ointment')?.retry?.error).toBeTruthy();
    await playRound(h2, 3);
    expect(await h2.adapter.abilityRepairTask()).toBeNull();                            // no third automatic round
    expect(h2.adapter.abilityBacklog().map(b => b.id)).toEqual(['item:ointment']);        // still offered to the player
    expect(vector(h2).last?.id).toBe('p/s/3');                                            // the story went on
    expect(h2.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('a player retry is a new request, counted before it leaves; the first failure stays on record until it binds', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    const firstError = row(h, 'item:ointment')!.error;
    const saves = h.saveGame.mock.calls.length;
    const sends = network(h, async () => JSON.stringify(card('修复药膏', 'item', 'chance')));
    const note = toasts();
    try {
      expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
      expect(note.seen.map(t => t.i18nKey)).toEqual(['mainGame.toast.vectorNewCards']);
    } finally { note.off(); }
    expect(sends).toHaveBeenCalledTimes(1);
    const input = JSON.parse(String((h.ai.generate.mock.calls.at(-1) as unknown as [{ messages: AIMessage[] }])[0].messages[1].content));
    expect(input).toMatchObject({ entry: { id: 'item:ointment' }, problem: firstError });
    // Counted and saved before the request left, then saved again with the result.
    const beforeSend = (h.saveGame.mock.calls[saves] as unknown as [string, string, Record<string, unknown>])[2];
    expect(((beforeSend as { 系统: { 扩展: { plotVector: VectorState } } }).系统.扩展.plotVector.tasks[0])).toMatchObject({ error: firstError, retry: { attempts: 1, source: 'manual' } });
    expect(cardIds(h)).toEqual(['item:ointment']);
    expect(row(h, 'item:ointment')).toBeUndefined();
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('a Step3 request that fails without a reply counts; the player can retry it too', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.inventoryItems, { ointment }) });
    const down = () => new FieldRepairPipeline(h.state, new CommandExecutor(h.state), { generate: vi.fn(async () => { throw new Error('502'); }) } as unknown as AIService,
      new ResponseParser(), {} as PromptAssembler, null, { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, () => h.adapter.abilityRepairTask());
    await down().execute();
    expect(row(h, 'item:ointment')?.retry).toMatchObject({ autoRounds: 1, lastAutoRound: 1, source: 'step3', error: '补生请求没有得到回复' });
    expect(h.adapter.abilityBacklog().map(b => b.state)).toEqual(['failed']);
    // The player's retry fails the same way: the entry stays, still failed, still Step3's to fill.
    const failing = network(h, async () => { throw new Error('still down'); });
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: false, requested: true });
    expect(failing).toHaveBeenCalledTimes(1);
    // Step3 tried twice inside round 1 (one automatic round); the player's retry is the third attempt.
    expect(row(h, 'item:ointment')?.retry).toMatchObject({ attempts: 3, autoRounds: 1, source: 'manual', error: 'still down' });
    await playRound(h, 2);
    await down().execute();
    expect(row(h, 'item:ointment')?.retry?.autoRounds).toBe(2);
    await playRound(h, 3);
    expect(await h.adapter.abilityRepairTask()).toBeNull();
    expect(h.adapter.abilityBacklog().map(b => b.id)).toEqual(['item:ointment']);
    network(h, async () => JSON.stringify(card('修复药膏', 'item', 'chance')));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
    expect(h.state.get(`${P.inventoryItems}.ointment`)).toEqual(ointment);
  });

  it('an entry bound by the player while its Step3 request was out counts as resolved, and is not overwritten', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
    const task = (await h.adapter.abilityRepairTask())!;
    task.sent?.();
    network(h, async () => JSON.stringify(card('修复药膏', 'item', 'chance')));
    expect(await h.adapter.regenerateAbility('item:ointment')).toEqual({ bound: true, requested: true });
    const bound = vector(h).cards[0].spec;
    expect(await task.settle({ abilities: [{ id: 'item:ointment', card: card('修复药膏', 'item', 'drag') }] })).toBe(true);
    expect(vector(h).cards.map(c => c.spec)).toEqual([bound]);
  });

  it('a Step3 task whose game changed right before sending is withdrawn: nothing is sent for it alone and nothing is counted', async () => {
    const h = setup(); writePlotVectorControl(true);
    await acquire(h);
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

  it('one Step3 request fills an environment tag and an item together and sends the shared card domain once', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => {
      h.state.set(P.inventoryItems, { ointment });
      h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]);
    }, cards: [brokenCard] });
    const { generate, run } = step3(h, () => ({ abilities: [
      { id: 'environment:name:微风', card: card('微风', 'environment', 'social') },
      { id: 'item:ointment', card: card('修复药膏', 'item', 'chance') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    const request = lastRequest(generate);
    expect(request.split('<能力补生>').length - 1).toBe(1);
    expect(request.split(CARD_API).length - 1).toBe(1);
    expect(cardIds(h)).toEqual(['environment:name:微风', 'item:ointment']);
  });

  it('an environment tag waiting for its ability survives a reload; a later Step3 fills it and the card carries on', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    expect(row(h, 'environment:name:微风')).toMatchObject({ error: ROUND_PROBLEMS.noBlock });
    const h2 = reload(h);
    await playRound(h2, 2, { during: () => h2.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    expect(h2.adapter.abilityBacklog().map(b => b.id)).toEqual(['environment:name:微风']); // unchanged, still waiting
    const { run } = step3(h2, () => ({ abilities: [{ id: 'environment:name:微风', card: card('微风', 'environment', 'social') }] }));
    expect((await run()).extra).toEqual({ resolved: true });
    expect(cardIds(h2)).toEqual(['environment:name:微风']);
    expect(vector(h2).tasks).toEqual([]);
    await playRound(h2, 3, { during: () => h2.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    expect(departed(vector(h2), 'environment:name:微风')).toBe(true);
  });

  it('the player can regenerate an environment ability too; the tag itself is not rewritten', async () => {
    const h = setup(); writePlotVectorControl(true);
    await playRound(h, 1, { during: () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    network(h, async () => JSON.stringify(card('微风', 'environment', 'chance')));
    expect(await h.adapter.regenerateAbility('environment:name:微风')).toEqual({ bound: true, requested: true });
    expect(h.state.get(P.environmentTags)).toEqual([{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]);
    await playRound(h, 2, { during: () => h.state.set(P.environmentTags, [{ 名称: '微风', 描述: '街道上的风', 效果: '舒适' }]) });
    expect(departed(vector(h), 'environment:name:微风')).toBe(true);
    expect(h.adapter.abilityBacklog()).toEqual([]);
  });

  it('an entry never tried (there before the feature was on) can be retried by the player; its row is created then', async () => {
    const h = setup();
    h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
    writePlotVectorControl(true);
    await playRound(h, 1);
    expect(h.adapter.abilityBacklog().map(b => [b.id, b.state])).toEqual([['item:tea', 'waiting']]);
    network(h, async () => JSON.stringify(card('茶', 'item')));
    expect(await h.adapter.regenerateAbility('item:tea')).toEqual({ bound: true, requested: true });
    expect(cardIds(h)).toEqual(['item:tea']);
  });
});
