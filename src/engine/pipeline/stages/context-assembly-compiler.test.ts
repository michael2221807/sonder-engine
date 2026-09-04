/**
 * Context Compiler v1 wired into ContextAssemblyStage (plan §5 "阶段" row).
 *
 * Pins the four user-facing guarantees:
 *   S3 — switch off = old behaviour (step2 identical to the pre-compiler assembly);
 *   S4 — step1 is byte-identical whether the compiler is on or off;
 *   on  — step2 JSON has no world description / selection, locations are a neighbourhood
 *         view, events are recent+relevant, MEMORY_BLOCK is blank, history is 2 pairs;
 *   trace — meta.compileTrace lists every decision (and is absent when off).
 */
import { describe, it, expect } from 'vitest';
import { ContextAssemblyStage } from './context-assembly';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { TemplateEngine } from '../../prompt/template-engine';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext, IMemoryRetriever, IBehaviorRunner } from '../types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import type { PromptRegistry } from '../../prompt/prompt-registry';
import { createMockStateManager, createMockPromptRegistry } from '../../__test-utils__';
import { isColocatedLocation } from '../../social/npc-presence';

const P = DEFAULT_ENGINE_PATHS;
const LF = P.locationFieldNames;
const EF = P.worldEventFieldNames;
const ENGRAM_BLOCK = 'ENGRAM-BLOCK-XYZ';
const STATE_HEADER = '## 状态\n';
const MEMORY_HEADER = '\n## 记忆\n';

function loc(name: string, parent?: string): Record<string, unknown> {
  return { [LF.name]: name, ...(parent ? { [LF.parent]: parent } : {}), [LF.description]: `desc of ${name}` };
}
function ev(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 事件ID: `evt_${i}`, [EF.participants]: [], [EF.scope]: '', [EF.description]: `event ${i}`, ...extra };
}

const HISTORY = [
  { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
];

function makeStage(useNewBuilder = true): ContextAssemblyStage {
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 83, 叙事历史: HISTORY },
    世界: {
      时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 },
      信息: { 世界名称: 'W' },
      描述: 'WORLD-DESC-TEXT',
      地点信息: [loc('A'), loc('A·B', 'A'), loc('A·B·C', 'A·B'), loc('A·B·D', 'A·B'), loc('A·B·C·E', 'A·B·C'), loc('A·F', 'A'), loc('G')],
    },
    world: { name: 'W', description: 'SEL-DESC' },
    角色: { 基础信息: { 姓名: '主角', 当前位置: 'A·B·C' } },
    社交: {
      关系: [{ 名称: '甲', 是否在场: true }, { 名称: '乙', 是否在场: false }],
      事件: { 事件记录: Array.from({ length: 8 }, (_, i) => ev(i, i === 0 ? { [EF.participants]: ['甲'] } : {})) },
    },
    记忆: { 短期: [] },
    系统: { 设置: { prompt: { enableWorldBook: false } } },
  });

  const registry = createMockPromptRegistry([
    { id: 'splitGenStep2', content: 'step2 系统指令' },
    { id: 'splitGenContext', content: `${STATE_HEADER}{{GAME_STATE_JSON}}${MEMORY_HEADER}{{MEMORY_BLOCK}}` },
  ]);

  const pack = {
    id: 'test-pack',
    prompts: {},
    promptFlows: {
      splitGenMainRoundStep1: { id: 'splitGenMainRoundStep1', modules: [{ promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 }] },
      splitGenMainRoundStep2: {
        id: 'splitGenMainRoundStep2',
        modules: [
          { promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 },
          { promptId: 'splitGenContext', role: 'system', order: 1, depth: 0 },
        ],
      },
    },
    engineFragments: {},
  } as unknown as GamePack;

  const memoryRetriever: IMemoryRetriever = { retrieve: () => ENGRAM_BLOCK };
  const behaviorRunner: IBehaviorRunner = {
    checkScheduledEvents: () => false,
    runOnContextAssembly: () => undefined,
    runAfterCommands: () => undefined,
    runOnRoundEnd: () => undefined,
  };

  return new ContextAssemblyStage(
    sm as unknown as StateManager,
    new PromptAssembler(registry as unknown as PromptRegistry, new TemplateEngine()),
    memoryRetriever,
    behaviorRunner,
    pack,
    P,
    undefined,
    undefined,
    () => [],
    () => [],
    useNewBuilder, // true = production main round; false = the Enhanced Opening legacy path
  );
}

function makeCtx(contextCompiler: boolean | undefined): PipelineContext {
  return {
    userInput: '我走进弄堂。',
    originalUserInput: '我走进弄堂。',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 83,
    generationId: 'gen-compiler',
    meta: contextCompiler === undefined ? { splitGen: true } : { splitGen: true, contextCompiler },
  } as unknown as PipelineContext;
}

interface Step2View {
  json: Record<string, unknown>;
  memory: string;
  historyUsers: number;
}

function step2View(out: PipelineContext): Step2View {
  const msgs = out.meta.splitStep2Messages ?? [];
  const ctxMsg = msgs.find((m) => String(m.content).startsWith(STATE_HEADER));
  expect(ctxMsg, 'splitGenContext message must be present').toBeDefined();
  const body = String(ctxMsg!.content).slice(STATE_HEADER.length);
  const cut = body.indexOf(MEMORY_HEADER);
  expect(cut).toBeGreaterThan(0);
  const json = JSON.parse(body.slice(0, cut)) as Record<string, unknown>;
  const memory = body.slice(cut + MEMORY_HEADER.length).trim();
  const historyUsers = (out.meta.splitStep2Sources ?? []).filter((s) => s === 'history:user').length;
  return { json, memory, historyUsers };
}

const text = (out: PipelineContext): string[] => out.messages.map((m) => String(m.content));

describe('ContextAssembly · Context Compiler v1 (split-gen step2 projection)', () => {
  it('ON (default): step2 gets the projection — no world description, neighbourhood locations, recent+relevant events, blank Engram block, 2 history pairs', async () => {
    const out = await makeStage().execute(makeCtx(undefined));
    const v = step2View(out);
    const world = v.json['世界'] as Record<string, unknown>;
    expect(world['描述']).toBeUndefined();
    expect(v.json['world']).toBeUndefined();
    const locs = world['地点信息'] as Array<Record<string, unknown>>;
    expect(locs).toHaveLength(7);
    expect(locs.filter((l) => LF.description in l).map((l) => l[LF.name])).toEqual(['A·B', 'A·B·C', 'A·B·D', 'A·B·C·E']);
    expect(locs.find((l) => l[LF.name] === 'G')).toEqual({ [LF.name]: 'G' });
    const events = ((v.json['社交'] as Record<string, unknown>)['事件'] as Record<string, unknown>)['事件记录'] as unknown[];
    expect(events).toHaveLength(6);
    expect(v.memory).toBe('');
    expect(v.historyUsers).toBe(2);

    const trace = out.meta.compileTrace;
    expect(trace).toBeDefined();
    expect(trace!.entries.map((e) => e.target)).toEqual([P.locations, P.worldEvents, P.worldDescription, P.worldSelection, 'MEMORY_BLOCK', 'history']);
    expect(trace!.savedTokens).toBeGreaterThan(0);
  });

  it('OFF: step2 is the old assembly — full state, Engram block, 3 history pairs, no trace', async () => {
    const out = await makeStage().execute(makeCtx(false));
    const v = step2View(out);
    const world = v.json['世界'] as Record<string, unknown>;
    expect(world['描述']).toBe('WORLD-DESC-TEXT');
    expect(v.json['world']).toEqual({ name: 'W', description: 'SEL-DESC' });
    const locs = world['地点信息'] as Array<Record<string, unknown>>;
    expect(locs.every((l) => LF.description in l)).toBe(true);
    const events = ((v.json['社交'] as Record<string, unknown>)['事件'] as Record<string, unknown>)['事件记录'] as unknown[];
    expect(events).toHaveLength(8);
    expect(v.memory).toBe(ENGRAM_BLOCK);
    expect(v.historyUsers).toBe(3);
    expect(out.meta.compileTrace).toBeUndefined();
  });

  it('S4: step1 messages are byte-identical with the compiler on and off', async () => {
    const stage = makeStage();
    const on = await stage.execute(makeCtx(true));
    const off = await stage.execute(makeCtx(false));
    expect(text(on)).toEqual(text(off));
    expect(on.messageSources).toEqual(off.messageSources);
    // and step1 really carries what step2 was allowed to drop
    expect(on.messageSources).toContain('builder:world_prompt');
    expect(on.messageSources).toContain('builder:memory_engram');
  });

  it('presence off: NPCs colocated with the player (exact OR parent/child, like syncPresence) count as present for event relevance', async () => {
    // 甲 is flagged 是否在场; 乙 stands exactly at the player's location; 丁 stands in a CHILD
    // location of it (hierarchical colocation, the syncPresence rule); 丙 is elsewhere.
    // 甲/乙/丁's events must be relevant, 丙's must not.
    const { sm } = createMockStateManager({
      元数据: { 回合序号: 83, 叙事历史: [] },
      世界: { 时间: {}, 信息: {}, 描述: 'w', 地点信息: [loc('A·B·C')] },
      角色: { 基础信息: { 姓名: '主角', 当前位置: 'A·B·C' } },
      社交: {
        关系: [{ 名称: '甲', 是否在场: true }, { 名称: '乙', 位置: 'A·B·C' }, { 名称: '丙', 位置: 'Elsewhere' }, { 名称: '丁', 位置: 'A·B·C·E' }],
        事件: { 事件记录: [
          ev(0, { [EF.participants]: ['乙'] }), ev(1, { [EF.participants]: ['丙'] }), ev(2, { [EF.participants]: ['丁'] }),
          ev(3), ev(4), ev(5), ev(6), ev(7),
        ] },
      },
      记忆: { 短期: [] },
      系统: { 设置: { prompt: { enableWorldBook: false } } },
    });
    const registry = createMockPromptRegistry([
      { id: 'splitGenStep2', content: 'step2 系统指令' },
      { id: 'splitGenContext', content: `${STATE_HEADER}{{GAME_STATE_JSON}}${MEMORY_HEADER}{{MEMORY_BLOCK}}` },
    ]);
    const pack = {
      id: 'test-pack', prompts: {}, engineFragments: {},
      promptFlows: {
        splitGenMainRoundStep1: { id: 'splitGenMainRoundStep1', modules: [{ promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 }] },
        splitGenMainRoundStep2: { id: 'splitGenMainRoundStep2', modules: [
          { promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 },
          { promptId: 'splitGenContext', role: 'system', order: 1, depth: 0 },
        ] },
      },
    } as unknown as GamePack;
    const stage = new ContextAssemblyStage(
      sm as unknown as StateManager,
      new PromptAssembler(registry as unknown as PromptRegistry, new TemplateEngine()),
      { retrieve: () => '' }, { checkScheduledEvents: () => false, runOnContextAssembly: () => undefined, runAfterCommands: () => undefined, runOnRoundEnd: () => undefined },
      pack, P, undefined, undefined, () => [], () => [], true,
    );
    const out = await stage.execute(makeCtx(true));
    const v = step2View(out);
    const events = ((v.json['社交'] as Record<string, unknown>)['事件'] as Record<string, unknown>)['事件记录'] as Array<Record<string, unknown>>;
    const ids = events.map((e) => e['事件ID']);
    expect(ids).toContain('evt_0'); // 乙 exact colocation → relevant
    expect(ids).toContain('evt_2'); // 丁 child location → relevant (hierarchical rule)
    expect(ids).not.toContain('evt_1'); // 丙 elsewhere → dropped
    expect(events).toHaveLength(7); // recent 5 (evt_3..7) + 2 relevant
  });

  it('isColocatedLocation mirrors syncPresence: exact, parent/child by separator, never sibling-prefix or empty', () => {
    expect(isColocatedLocation('A·B·C', 'A·B·C', '·')).toBe(true);
    expect(isColocatedLocation('A·B', 'A·B·C', '·')).toBe(true); // NPC at parent
    expect(isColocatedLocation('A·B·C·E', 'A·B·C', '·')).toBe(true); // NPC at child
    expect(isColocatedLocation('A·Bx', 'A·B', '·')).toBe(false); // name prefix is not hierarchy
    expect(isColocatedLocation('', 'A·B', '·')).toBe(false);
    expect(isColocatedLocation('A·B', '', '·')).toBe(false);
    expect(isColocatedLocation('A·B', 'A·B·C', '')).toBe(false); // no separator → exact only
  });

  it('legacy path (useNewBuilder=false, Enhanced Opening): history is the constant 3 pairs for BOTH steps and no compiler trace', async () => {
    const out = await makeStage(false).execute(makeCtx(true));
    // legacy step1 carries history pairs directly (builder path does not)
    expect((out.messageSources ?? []).filter((s) => s === 'history:user')).toHaveLength(3);
    expect((out.meta.splitStep2Sources ?? []).filter((s) => s === 'history:user')).toHaveLength(3);
    expect(out.meta.compileTrace).toBeUndefined();
    // and the legacy step2 JSON is the full ledger (no projection)
    const v = step2View(out);
    expect((v.json['世界'] as Record<string, unknown>)['描述']).toBe('WORLD-DESC-TEXT');
  });

  it('step2 still ends with the verbatim player input as a user turn (round-62 parity kept)', async () => {
    const out = await makeStage().execute(makeCtx(true));
    const msgs = out.meta.splitStep2Messages ?? [];
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('我走进弄堂。');
  });
});
