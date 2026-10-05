/**
 * The prompt page's edits and switches reach the main round's story request (P7, PO 2026-10-04).
 *
 * The story request (split Step 1 and the single call) is built by the context-piece builder. It used to read the
 * pack's text directly, so an edit or a switch on the prompt page reached Step 2 (the flow assembler reads the
 * registry) but never the story: a marker experiment on real requests showed every builder prompt sent as the pack
 * wrote it, switched-off prompts sent anyway. The stage now hands the builder the registry's view.
 * Registry set up as main.ts does (registerPack with the always-on prompts), the page's edits and switches on top.
 */
import { describe, it, expect } from 'vitest';
import { ContextAssemblyStage } from './context-assembly';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { PromptRegistry } from '../../prompt/prompt-registry';
import { ALWAYS_ON_PROMPT_IDS } from '../../prompt/builtin-slots';
import { TemplateEngine } from '../../prompt/template-engine';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext, IMemoryRetriever, IBehaviorRunner } from '../types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import { createMockStateManager } from '../../__test-utils__';

const PACK_PROMPTS: Record<string, string> = {
  mainRound: 'PACK MAIN FORMAT',
  splitGenStep1: 'PACK STEP1 FORMAT',
  narratorFrame: 'PACK NARRATOR',
  writeStyle: 'PACK STYLE',
  antiCliche: 'PACK ANTICLICHE',
  emotionGuard: 'PACK EMOTION',
  jailbreak: 'PACK JAILBREAK',
  core: 'PACK CORE',
  splitGenStep2: 'PACK STEP2',
  splitGenStep2Followup: 'PACK FOLLOWUP',
  perspectiveSecond: 'PACK PERSPECTIVE',
  wordCountReq: 'PACK LENGTH',
};

function makeStage(edit: (registry: PromptRegistry) => void): ContextAssemblyStage {
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 12, 叙事历史: [] },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
    角色: { 基础信息: { 姓名: '主角' } },
    系统: { 设置: { prompt: { enableWorldBook: false } } },
  });
  const registry = new PromptRegistry();
  registry.registerPack(PACK_PROMPTS, ALWAYS_ON_PROMPT_IDS);
  edit(registry);
  const pack = {
    id: 'test-pack',
    prompts: PACK_PROMPTS,
    promptFlows: {
      splitGenMainRoundStep2: {
        id: 'splitGenMainRoundStep2',
        modules: [
          { promptId: 'jailbreak', role: 'system', order: -2, depth: 0 },
          { promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 },
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
  return new ContextAssemblyStage(sm as unknown as StateManager, new PromptAssembler(registry, new TemplateEngine()),
    memoryRetriever, behaviorRunner, pack, DEFAULT_ENGINE_PATHS, undefined, undefined, () => [], true);
}

function makeCtx(meta: Record<string, unknown>): PipelineContext {
  return {
    userInput: '走两步', originalUserInput: '走两步', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [],
    messages: [], worldEventTriggered: false, roundNumber: 12, generationId: 'gen-edits', meta,
  } as unknown as PipelineContext;
}

const text = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((m) => String(m.content)).join('\n');

describe('ContextAssembly · the prompt page reaches the story request', () => {
  it('split Step 1 sends the edited text, leaves out a prompt switched off, keeps the pack text of the rest', async () => {
    const out = await makeStage((r) => {
      r.setUserContent('writeStyle', 'EDITED STYLE');
      r.setEnabled('antiCliche', false);
    }).execute(makeCtx({ splitGen: true }));
    const story = text(out.messages);
    expect(story).toContain('EDITED STYLE');
    expect(story).not.toContain('PACK STYLE');
    expect(story).not.toContain('PACK ANTICLICHE');
    expect(story).toContain('PACK NARRATOR');
    expect(story).toContain('PACK EMOTION');
  });

  it('the single call reads the page the same way', async () => {
    const out = await makeStage((r) => {
      r.setUserContent('narratorFrame', 'EDITED NARRATOR');
      r.setEnabled('emotionGuard', false);
    }).execute(makeCtx({ splitGen: false }));
    const story = text(out.messages);
    expect(story).toContain('EDITED NARRATOR');
    expect(story).not.toContain('PACK NARRATOR');
    expect(story).not.toContain('PACK EMOTION');
    expect(story).toContain('PACK MAIN FORMAT');
  });

  it('a format the round cannot do without is sent even when switched off, edited if the player edited it', async () => {
    const out = await makeStage((r) => {
      r.setEnabled('splitGenStep1', false);
      r.setUserContent('splitGenStep1', 'EDITED STEP1 FORMAT');
    }).execute(makeCtx({ splitGen: true, plotVectorPromptMode: true }));
    expect(text(out.messages)).toContain('EDITED STEP1 FORMAT');
  });

  // P13 (PO 2026-10-04): a single call writes the commands too, so it carries the jailbreak and the protocol.
  it('the single call carries the jailbreak and the output protocol as the player left them', async () => {
    const out = await makeStage((r) => r.setUserContent('jailbreak', 'EDITED JAILBREAK')).execute(makeCtx({ splitGen: false }));
    const story = text(out.messages);
    expect(story).toContain('EDITED JAILBREAK');
    expect(story).not.toContain('PACK JAILBREAK');
    expect(story.indexOf('PACK CORE')).toBeGreaterThan(-1);
    expect(story.indexOf('PACK CORE')).toBeLessThan(story.indexOf('PACK MAIN FORMAT'));
    const off = await makeStage((r) => r.setEnabled('core', false)).execute(makeCtx({ splitGen: false }));
    expect(text(off.messages)).not.toContain('PACK CORE');
  });

  it('split Step 1 writes only the story: no jailbreak, no protocol (Step 2 has both)', async () => {
    const out = await makeStage(() => undefined).execute(makeCtx({ splitGen: true }));
    const story = text(out.messages);
    expect(story).not.toContain('PACK JAILBREAK');
    expect(story).not.toContain('PACK CORE');
  });

  // Code review H2/M1 (2026-10-04): what a setting chooses and what the round needs is never dropped by a stored
  // "off" (an older page let players switch them off; a card or a prompt file can still carry one).
  it('the perspective the setting chose, the length rule and the Step 2 follow-up are sent despite a stored off', async () => {
    const out = await makeStage((r) => {
      r.setEnabled('perspectiveSecond', false);
      r.setEnabled('wordCountReq', false);
      r.setEnabled('splitGenStep2Followup', false);
    }).execute(makeCtx({ splitGen: true, plotVectorPromptMode: true }));
    const story = text(out.messages);
    expect(story).toContain('PACK PERSPECTIVE');
    expect(story).toContain('PACK LENGTH');
    expect(String(out.meta.splitStep2Followup)).toContain('PACK FOLLOWUP');
  });

  it('Step 2 keeps reading the page too (the flow assembler), so both steps agree', async () => {
    const out = await makeStage((r) => r.setUserContent('jailbreak', 'EDITED JAILBREAK')).execute(makeCtx({ splitGen: true }));
    const step2 = text(out.meta.splitStep2Messages as Array<{ content: unknown }> | undefined);
    expect(step2).toContain('EDITED JAILBREAK');
    expect(step2).not.toContain('PACK JAILBREAK');
  });
});
