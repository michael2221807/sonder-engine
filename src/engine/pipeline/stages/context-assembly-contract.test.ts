/**
 * Narrative Contract wired into ContextAssemblyStage (plan §3 S1).
 *
 * Pins the user-facing guarantees:
 *   both steps — the same block reaches step1 (builder piece `narrative_contract`, after
 *                the narrative constraints, before extra/format) AND step2 (flow module
 *                gated by NARRATIVE_CONTRACT); the compiler never strips it;
 *   empty      — a save without a contract (or with the switch off) produces prompts
 *                byte-identical to a save that never heard of the feature;
 *   cast       — 「重点」 ∪ 「关注」 from the relationship list, 「普通」 excluded;
 *   legacy     — the flow-only path (useNewBuilder=false) injects it too;
 *   trace      — meta.compileTrace carries a `contract` keep entry when the compiler is on.
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
import { COMPILE_REASON } from '../../prompt/context-compiler';
import type { NarrativeContractState } from '../../prompt/narrative-contract';

const P = DEFAULT_ENGINE_PATHS;
const F = P.npcFieldNames;

const FRAGMENTS = {
  narrativeContractTitle: '【叙事契约】',
  narrativeContractAuthority: '玩家声明，优先级最高：',
  narrativeContractCastLabel: '【主线人物】',
  narrativeContractPeripheralRule: '名单外只作背景。',
  narrativeContractCastSeparator: '、',
};
const SLOT_TEXT = '{{NARRATIVE_CONTRACT_BLOCK}}\n\n契约使用说明。';

function contract(texts: string[], enabled = true): NarrativeContractState {
  return { enabled, clauses: texts.map((text, i) => ({ id: `c${i}`, text, enabled: true, source: 'player', createdRound: 1 })) };
}

interface StageOptions {
  contract?: NarrativeContractState | 'absent';
  useNewBuilder?: boolean;
}

function makeStage(opts: StageOptions = {}): ContextAssemblyStage {
  const ext: Record<string, unknown> = {};
  if (opts.contract !== 'absent') ext.narrativeContract = opts.contract ?? contract(['沈墨琛底色是护不是猎。']);
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 91, 叙事历史: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }] },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: { 世界名称: 'W' }, 描述: 'WORLD', 地点信息: [] },
    角色: { 基础信息: { 姓名: '韩素琴', 当前位置: '江边' } },
    社交: {
      关系: [
        { [F.name]: '沈墨琛', [F.type]: '重点' },
        { [F.name]: '林晚照' },                                             // unmarked → key
        { [F.name]: '路人甲', [F.type]: P.npcTypeExclude },                 // 普通 → out
        { [F.name]: '许静姝', [F.type]: P.npcTypeExclude, [F.attention]: true }, // watched → in
      ],
      事件: { 事件记录: [] },
    },
    记忆: { 短期: [] },
    系统: { 设置: { prompt: { enableWorldBook: false } }, 扩展: ext },
  });
  const registry = createMockPromptRegistry([
    { id: 'splitGenStep1', content: 'step1 系统指令' },
    { id: 'splitGenStep2', content: 'step2 系统指令' },
    { id: 'splitGenContext', content: '## 状态\n{{GAME_STATE_JSON}}' },
    { id: 'narrativeContract', content: SLOT_TEXT },
  ]);
  const flowModules = (systemId: string) => [
    { promptId: systemId, role: 'system', order: 0, depth: 0 },
    { promptId: 'splitGenContext', role: 'system', order: 2, depth: 0 },
    { promptId: 'narrativeContract', role: 'system', order: 2.2, depth: 0, condition: 'NARRATIVE_CONTRACT' },
  ];
  const pack = {
    id: 'test-pack',
    prompts: { narrativeConstraints: '总约束', narrativeContract: SLOT_TEXT },
    promptFlows: {
      splitGenMainRoundStep1: { id: 'splitGenMainRoundStep1', modules: flowModules('splitGenStep1') },
      splitGenMainRoundStep2: { id: 'splitGenMainRoundStep2', modules: flowModules('splitGenStep2') },
    },
    engineFragments: FRAGMENTS,
  } as unknown as GamePack;
  const memoryRetriever: IMemoryRetriever = { retrieve: () => '' };
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
    opts.useNewBuilder ?? true,
  );
}

function makeCtx(contextCompiler?: boolean): PipelineContext {
  return {
    userInput: '我回头看他。',
    originalUserInput: '我回头看他。',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 91,
    generationId: 'gen-contract',
    meta: contextCompiler === undefined ? { splitGen: true } : { splitGen: true, contextCompiler },
  } as unknown as PipelineContext;
}

const EXPECTED_BLOCK = [
  '【叙事契约】',
  '玩家声明，优先级最高：',
  '1. 沈墨琛底色是护不是猎。',
  '【主线人物】沈墨琛、林晚照、许静姝',
  '名单外只作背景。',
].join('\n');

const step1Text = (out: PipelineContext) => out.messages.map((m) => String(m.content));
const step2Text = (out: PipelineContext) => (out.meta.splitStep2Messages ?? []).map((m) => String(m.content));

describe('ContextAssembly · Narrative Contract (both steps)', () => {
  it('step1 carries the contract as a builder piece right after the narrative constraints', async () => {
    const out = await makeStage().execute(makeCtx());
    const sources = out.messageSources ?? [];
    const idx = sources.indexOf('builder:narrative_contract');
    expect(sources.indexOf('builder:narrative_constraints')).toBeGreaterThanOrEqual(0);
    expect(idx).toBe(sources.indexOf('builder:narrative_constraints') + 1);
    expect(idx).toBeLessThan(sources.indexOf('builder:player_input'));
    expect(step1Text(out)[idx]).toBe(`${EXPECTED_BLOCK}\n\n契约使用说明。`);
  });

  it('step2 carries the same block through the flow module, and the compiler keeps it (trace entry)', async () => {
    const out = await makeStage().execute(makeCtx());
    const s2 = step2Text(out);
    expect(s2.some((m) => m === `${EXPECTED_BLOCK}\n\n契约使用说明。`)).toBe(true);
    expect(out.meta.splitStep2Sources).toContain('module:narrativeContract');
    const entry = out.meta.compileTrace?.entries.find((e) => e.target === 'contract');
    expect(entry).toMatchObject({ action: 'keep', reason: COMPILE_REASON.sentInBothSteps, detail: { clauses: 1, cast: 3 } });
    expect(entry!.before).toBe(entry!.after);
  });

  it('the raw contract object never appears in GAME_STATE_JSON of either step', async () => {
    const out = await makeStage().execute(makeCtx());
    // step2's splitGenContext carries GAME_STATE_JSON; step1's builder pieces read state directly.
    expect(step2Text(out).join('\n')).not.toContain('narrativeContract');
    expect(step1Text(out).join('\n')).not.toContain('narrativeContract');
    expect(step2Text(out).join('\n')).not.toContain('"source"');
  });

  it('compiler OFF: both steps still carry the block (the contract is not a compiler feature)', async () => {
    const out = await makeStage().execute(makeCtx(false));
    expect(out.messageSources).toContain('builder:narrative_contract');
    expect(out.meta.splitStep2Sources).toContain('module:narrativeContract');
    expect(out.meta.compileTrace).toBeUndefined();
  });

  it('no clauses (schema default) → nothing injected: byte-identical to a save that never had the key, even with 重点 NPCs', async () => {
    const bare = await makeStage({ contract: 'absent' }).execute(makeCtx());
    const empty = await makeStage({ contract: { enabled: true, clauses: [] } }).execute(makeCtx());
    expect(step1Text(empty)).toEqual(step1Text(bare));
    expect(step2Text(empty)).toEqual(step2Text(bare));
    expect(bare.messageSources).not.toContain('builder:narrative_contract');
    expect(bare.meta.splitStep2Sources ?? []).not.toContain('module:narrativeContract');
    expect(step1Text(bare).join('\n')).not.toContain('【主线人物】');
    expect(bare.meta.compileTrace?.entries.some((e) => e.target === 'contract')).toBe(false);
  });

  it('master switch off: no piece, no module, no trace entry', async () => {
    const off = await makeStage({ contract: contract(['x'], false) }).execute(makeCtx());
    expect(off.messageSources).not.toContain('builder:narrative_contract');
    expect(off.meta.splitStep2Sources ?? []).not.toContain('module:narrativeContract');
    expect(off.meta.compileTrace?.entries.some((e) => e.target === 'contract')).toBe(false);
    expect(step1Text(off).join('\n')).not.toContain('叙事契约');
    expect(step2Text(off).join('\n')).not.toContain('叙事契约');
  });

  it('legacy flow path (useNewBuilder=false): step1 and step2 flows both inject the block', async () => {
    const out = await makeStage({ useNewBuilder: false }).execute(makeCtx());
    expect(out.messageSources).toContain('module:narrativeContract');
    expect(out.meta.splitStep2Sources).toContain('module:narrativeContract');
    expect(step1Text(out).some((m) => m.startsWith(EXPECTED_BLOCK))).toBe(true);
  });
});
