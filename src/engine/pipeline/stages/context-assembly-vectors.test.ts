/**
 * Character Vectors wired into ContextAssemblyStage (character-vector v1 plan §2 / S1).
 *
 * Pins the user-facing guarantees:
 *   both steps — the projected block reaches step1 (builder piece `character_vectors`,
 *                right after `narrative_contract`) AND step2 (flow module gated by
 *                CHARACTER_VECTORS); the compiler keeps it (trace `vectors · keep`);
 *   projection — only NPCs present in the scene, named in the input or named in the
 *                previous narrative get a line; the protagonist never does;
 *   empty      — a save without vectors (or with the switch off, or with nobody in scope)
 *                produces prompts byte-identical to a save that never heard of the feature.
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
import type { CharacterVectorsState, CharacterVectorEntry } from '../../prompt/character-vectors';

const P = DEFAULT_ENGINE_PATHS;
const F = P.npcFieldNames;

const FRAGMENTS = {
  characterVectorHeader: '【人物向量】倾向不是结局。',
  characterVectorTowardLabel: '对主角｜',
  characterVectorNeverLabel: '不会做｜',
  characterVectorDirectionLabel: '潜在方向｜',
  characterVectorHiddenLabel: '【主角不知道的】',
  characterVectorFieldSeparator: ' ',
  characterVectorHiddenSeparator: '；',
};
const SLOT_TEXT = '{{CHARACTER_VECTORS_BLOCK}}\n\n向量使用说明。';

function entry(over: Partial<CharacterVectorEntry> & { name: string }): CharacterVectorEntry {
  return { id: over.name, toward: '', never: '', direction: '', hidden: '', enabled: true, source: 'player', updatedRound: 1, ...over };
}

const VECTORS: CharacterVectorsState = { enabled: true, entries: [
  entry({ name: '沈墨琛', toward: '当藏品', never: '不解释', hidden: '他叫停了调教' }),   // present
  entry({ name: '林晚照', toward: '完全信赖' }),                                          // absent, unmentioned → out
  entry({ name: '乔诗诗', direction: '继续牵线', source: 'proposed' }),                   // named in previous narrative → in
  entry({ name: '韩素琴', toward: '主角，绝不渲染' }),                                    // protagonist → out
] };

interface StageOptions { vectors?: CharacterVectorsState | 'absent'; useNewBuilder?: boolean }

function makeStage(opts: StageOptions = {}): ContextAssemblyStage {
  const ext: Record<string, unknown> = {};
  if (opts.vectors !== 'absent') ext.characterVectors = opts.vectors ?? VECTORS;
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 91, 叙事历史: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: '乔诗诗发来消息。' }] },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: { 世界名称: 'W' }, 描述: 'WORLD', 地点信息: [] },
    角色: { 基础信息: { 姓名: '韩素琴', 当前位置: '江边' } },
    社交: {
      关系: [
        { [F.name]: '沈墨琛', [F.type]: '重点', [F.isPresent]: true },
        { [F.name]: '林晚照', [F.type]: '重点', [F.isPresent]: false },
        { [F.name]: '乔诗诗', [F.type]: '重点' },
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
    { id: 'characterVectors', content: SLOT_TEXT },
  ]);
  const flowModules = (systemId: string) => [
    { promptId: systemId, role: 'system', order: 0, depth: 0 },
    { promptId: 'splitGenContext', role: 'system', order: 2, depth: 0 },
    { promptId: 'characterVectors', role: 'system', order: 2.25, depth: 0, condition: 'CHARACTER_VECTORS' },
  ];
  const pack = {
    id: 'test-pack',
    prompts: { narrativeConstraints: '总约束', characterVectors: SLOT_TEXT },
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

function makeCtx(input = '我回头看他。', contextCompiler?: boolean): PipelineContext {
  return {
    userInput: input,
    originalUserInput: input,
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 91,
    generationId: 'gen-vectors',
    meta: contextCompiler === undefined ? { splitGen: true } : { splitGen: true, contextCompiler },
  } as unknown as PipelineContext;
}

const EXPECTED_BLOCK = [
  '【人物向量】倾向不是结局。',
  '- 沈墨琛：对主角｜当藏品 不会做｜不解释',
  '- 乔诗诗：潜在方向｜继续牵线',
  '【主角不知道的】他叫停了调教',
].join('\n');

const step1Text = (out: PipelineContext) => out.messages.map((m) => String(m.content));
const step2Text = (out: PipelineContext) => (out.meta.splitStep2Messages ?? []).map((m) => String(m.content));

describe('ContextAssembly · Character Vectors (projected, both steps)', () => {
  it('step1 carries the projected block as a builder piece: present + previously-named NPCs, never the protagonist or absent ones', async () => {
    const out = await makeStage().execute(makeCtx());
    const sources = out.messageSources ?? [];
    const idx = sources.indexOf('builder:character_vectors');
    expect(idx).toBeGreaterThan(sources.indexOf('builder:narrative_constraints'));
    expect(idx).toBeLessThan(sources.indexOf('builder:player_input'));
    expect(step1Text(out)[idx]).toBe(`${EXPECTED_BLOCK}\n\n向量使用说明。`);
    expect(step1Text(out).join('\n')).not.toContain('完全信赖');
    expect(step1Text(out).join('\n')).not.toContain('主角，绝不渲染');
  });

  it('the player input widens the projection: naming an absent NPC pulls her line in', async () => {
    const out = await makeStage().execute(makeCtx('我给林晚照发消息。'));
    const idx = (out.messageSources ?? []).indexOf('builder:character_vectors');
    expect(step1Text(out)[idx]).toContain('- 林晚照：对主角｜完全信赖');
  });

  it('step2 carries the same block through the flow module and the compiler keeps it (trace entry)', async () => {
    const out = await makeStage().execute(makeCtx());
    expect(step2Text(out).some((m) => m === `${EXPECTED_BLOCK}\n\n向量使用说明。`)).toBe(true);
    expect(out.meta.splitStep2Sources).toContain('module:characterVectors');
    const trace = out.meta.compileTrace?.entries.find((e) => e.target === 'vectors');
    expect(trace).toMatchObject({ action: 'keep', reason: COMPILE_REASON.sentInBothSteps, detail: { entries: 4, scope: 2 } });
    expect(trace!.before).toBe(trace!.after);
  });

  it('the raw vector list (with hidden truths) never appears in GAME_STATE_JSON of either step', async () => {
    const out = await makeStage().execute(makeCtx());
    for (const text of [step1Text(out).join('\n'), step2Text(out).join('\n')]) {
      expect(text).not.toContain('characterVectors');
      expect(text).not.toContain('"hidden"');
    }
  });

  it('no vectors (schema default) / switch off / nobody in scope → byte-identical to a save that never had the key', async () => {
    const bare = await makeStage({ vectors: 'absent' }).execute(makeCtx());
    const empty = await makeStage({ vectors: { enabled: true, entries: [] } }).execute(makeCtx());
    const off = await makeStage({ vectors: { ...VECTORS, enabled: false } }).execute(makeCtx());
    const outOfScope = await makeStage({ vectors: { enabled: true, entries: [entry({ name: '林晚照', toward: '完全信赖' })] } }).execute(makeCtx());
    for (const out of [empty, off, outOfScope]) {
      expect(step1Text(out)).toEqual(step1Text(bare));
      expect(step2Text(out)).toEqual(step2Text(bare));
    }
    expect(bare.messageSources).not.toContain('builder:character_vectors');
    expect(bare.meta.splitStep2Sources ?? []).not.toContain('module:characterVectors');
    expect(bare.meta.compileTrace?.entries.some((e) => e.target === 'vectors')).toBe(false);
  });

  it('legacy flow path (useNewBuilder=false): both flows inject the block', async () => {
    const out = await makeStage({ useNewBuilder: false }).execute(makeCtx());
    expect(out.messageSources).toContain('module:characterVectors');
    expect(out.meta.splitStep2Sources).toContain('module:characterVectors');
    expect(step1Text(out).some((m) => m.startsWith(EXPECTED_BLOCK))).toBe(true);
  });
});
