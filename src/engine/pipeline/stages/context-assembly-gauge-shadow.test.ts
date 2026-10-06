/**
 * Gauge shadows a save already holds (gauge-shadow.ts; PO 2026-10-05) are never shown to the model: neither in
 * Step 1's player data nor in Step 2's game state JSON. The save keeps them; the model reads the gauge from the plot
 * directive only. A declared field that shares a gauge's name is shown as before.
 */
import { describe, it, expect } from 'vitest';
import { ContextAssemblyStage } from './context-assembly';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { PromptRegistry } from '../../prompt/prompt-registry';
import { isPromptAlwaysOn } from '../../prompt/builtin-slots';
import { TemplateEngine } from '../../prompt/template-engine';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext, IMemoryRetriever, IBehaviorRunner } from '../types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import { createMockStateManager } from '../../__test-utils__';

const PACK_PROMPTS: Record<string, string> = {
  mainRound: 'PACK MAIN FORMAT',
  splitGenStep1: 'PACK STEP1 FORMAT',
  splitGenStep2: 'PACK STEP2',
  splitGenContext: 'STATE {{GAME_STATE_JSON}}',
  splitGenStep2Followup: 'PACK FOLLOWUP',
};

const SCHEMA = {
  type: 'object',
  properties: {
    系统: { type: 'object', properties: { 设置: { type: 'object' } } },
    角色: { type: 'object', properties: { 基础信息: { type: 'object' }, 身体: { type: 'object', properties: { 身高: { type: 'string' } } } } },
    社交: { type: 'object', properties: { 关系: { type: 'array', items: { type: 'object', properties: { 名称: { type: 'string' }, 好感度: { type: 'number' } } } } } },
    元数据: { type: 'object' },
    世界: { type: 'object' },
  },
};

function makeStage(withSchema: boolean): ContextAssemblyStage {
  const { sm } = createMockStateManager({
    记忆: { 短期: [{ summary: '她点头。〖判定:心性,结果:成功〗〖人性锚点回升至27〗' }, { summary: '你给她倒水。\n人性锚点回升至28' }] },
    元数据: { 回合序号: 12, 叙事历史: [], 剧情导向: { activeArcIndex: 0, arcs: [{ id: 'a', title: '主线', status: 'active', nodes: [],
      gauges: [{ id: 'g', name: '人性锚点', description: '', min: 0, max: 100, current: 30 }, { id: 'h', name: '好感度', description: '', min: 0, max: 100, current: 10 }] }] } },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
    角色: { 基础信息: { 姓名: '主角' }, 身体: { 身高: '170', 人性锚点: 25 } },
    社交: { 关系: [{ 名称: '林月', 好感度: 44 }] },
    系统: { 设置: { prompt: { enableWorldBook: false } }, 人性锚点: 26 },
  });
  const registry = new PromptRegistry();
  registry.registerPack(PACK_PROMPTS, isPromptAlwaysOn);
  const pack = {
    id: 'test-pack',
    prompts: PACK_PROMPTS,
    ...(withSchema ? { stateSchema: SCHEMA } : {}),
    promptFlows: {
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
  const memoryRetriever: IMemoryRetriever = { retrieve: () => '' };
  const behaviorRunner: IBehaviorRunner = {
    runOnContextAssembly: () => undefined,
    runAfterCommands: () => undefined,
    runOnRoundEnd: () => undefined,
  };
  return new ContextAssemblyStage(sm as unknown as StateManager, new PromptAssembler(registry, new TemplateEngine()),
    memoryRetriever, behaviorRunner, pack, DEFAULT_ENGINE_PATHS, undefined, undefined, () => [], true);
}

const ctx = { userInput: '走', originalUserInput: '走', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [],
  messages: [], roundNumber: 12, generationId: 'gen-shadow', meta: { splitGen: true } } as unknown as PipelineContext;
const text = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((m) => String(m.content)).join('\n');

describe('ContextAssembly · gauge shadows are never shown to the model', () => {
  it('Step 1 player data and Step 2 state leave them out; a declared field of a gauge name stays', async () => {
    const out = await makeStage(true).execute(ctx);
    const step1 = text(out.messages);
    expect(step1).toContain('"身高":"170"');
    expect(step1).not.toMatch(/"人性锚点":(25|26)/);
    const step2 = text(out.meta.splitStep2Messages as Array<{ content: unknown }> | undefined);
    expect(step2).toContain('"好感度":44');
    expect(step2).not.toMatch(/"人性锚点":(25|26)/);
  });

  it('without the pack schema nothing is left out (a real field could not be told apart)', async () => {
    const out = await makeStage(false).execute(ctx);
    expect(text(out.messages)).toContain('"人性锚点":25');
  });
});

// Option C (PO 2026-10-05): with plot momentum (historyStoryOnly) the recap the model reads has no gauge status lines.
describe('ContextAssembly · the plot-momentum recap leaves gauge status lines out', () => {
  it('a status bracket after a verdict and a bare status line are out of the recap; the story stays', async () => {
    const out = await makeStage(true).execute({ ...ctx, meta: { splitGen: true, historyStoryOnly: true } } as unknown as PipelineContext);
    const step1 = text(out.messages);
    expect(step1).toContain('她点头。');
    expect(step1).toContain('你给她倒水。');
    expect(step1).not.toContain('回升至2');
  });

  it('judgement mode (no story-only view) reads the recap as saved', async () => {
    const step1 = text((await makeStage(true).execute(ctx)).messages);
    expect(step1).toContain('〖人性锚点回升至27〗');
  });
});
