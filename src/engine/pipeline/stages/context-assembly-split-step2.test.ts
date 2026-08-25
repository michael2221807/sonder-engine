/**
 * Split-gen step2 must see the CURRENT round's player input.
 *
 * Round-62 incident (2026-08-25, third structural defect): on the new-builder path
 * the step2 message list was flow modules + narrative history only — the player's
 * input reached step2 exclusively as step1's RETELLING. The settingCapture protocol
 * demands evidence quoted verbatim from the tagged input, so with the original absent
 * from context every candidate the model produced failed the evidence gate
 * ("引文与标记原文对不上×6"). The legacy assembler path had always appended the input
 * to both steps; the builder path dropped it. This suite pins the parity.
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

const TAGGED_INPUT = '我回宿舍睡觉。<设定>林月从小怕水，从不去泳池。</设定>';

function makeStage(): ContextAssemblyStage {
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 62, 叙事历史: [] },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
    角色: { 基础信息: { 姓名: '主角' } },
    系统: { 设置: { prompt: { enableWorldBook: true, enableSettingCapture: true } } },
  });

  const registry = createMockPromptRegistry([
    { id: 'splitGenStep2', content: 'step2 系统指令' },
    { id: 'settingCapture', content: '设定提取协议：输出 setting_updates。' },
  ]);

  const pack = {
    id: 'test-pack',
    prompts: {},
    promptFlows: {
      splitGenMainRoundStep1: {
        id: 'splitGenMainRoundStep1',
        modules: [{ promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 }],
      },
      splitGenMainRoundStep2: {
        id: 'splitGenMainRoundStep2',
        modules: [
          { promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 },
          { promptId: 'settingCapture', role: 'system', order: 1, depth: 0, condition: 'SETTING_CAPTURE_ACTIVE' },
        ],
      },
    },
    engineFragments: {},
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
    DEFAULT_ENGINE_PATHS,
    undefined,
    undefined,
    () => [],
    () => [],
    true, // useNewBuilder — the production configuration (game-orchestrator.ts)
  );
}

function makeCtx(): PipelineContext {
  return {
    userInput: TAGGED_INPUT,
    originalUserInput: TAGGED_INPUT,
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 62,
    generationId: 'gen-ctx-1',
    meta: { splitGen: true },
  } as unknown as PipelineContext;
}

describe('ContextAssembly · split-gen step2 player-input parity', () => {
  it('step2 messages contain the verbatim tagged input as a user message', async () => {
    const out = await makeStage().execute(makeCtx());

    const step2 = out.meta.splitStep2Messages;
    expect(step2, 'splitStep2Messages must be assembled').toBeDefined();

    const inputMsg = step2!.find((m) => m.content.includes(TAGGED_INPUT));
    expect(inputMsg, 'the raw tagged input must be present in step2').toBeDefined();
    expect(inputMsg!.role).toBe('user');
    // Verbatim — the evidence gate matches against this exact text.
    expect(inputMsg!.content).toContain('<设定>林月从小怕水，从不去泳池。</设定>');
  });

  it('the input message is labeled current_input for the debug panel', async () => {
    const out = await makeStage().execute(makeCtx());
    const sources = out.meta.splitStep2Sources ?? [];
    expect(sources).toContain('current_input');
  });

  it('step2 still receives the settingCapture module on tagged rounds', async () => {
    const out = await makeStage().execute(makeCtx());
    const step2 = out.meta.splitStep2Messages ?? [];
    expect(step2.some((m) => m.content.includes('设定提取协议'))).toBe(true);
  });
});
