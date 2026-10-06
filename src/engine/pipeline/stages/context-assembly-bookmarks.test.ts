/**
 * The rounds the player bookmarked reach the story request (P15, PO 2026-10-04).
 *
 * The bookmarks block was a flow variable only: Step 2's context rendered it, but the story request (split Step 1
 * and the single call) is built by the context-piece builder, which renders unknown placeholders empty — so the
 * story was written without the rounds the player picked for it. The builder now gets the block as its own piece.
 */
import { describe, it, expect } from 'vitest';
import { ContextAssemblyStage } from './context-assembly';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { PromptRegistry } from '../../prompt/prompt-registry';
import { ALWAYS_ON_PROMPT_IDS } from '../../prompt/builtin-slots';
import { TemplateEngine } from '../../prompt/template-engine';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { BookmarkedRound, PipelineContext, IMemoryRetriever, IBehaviorRunner } from '../types';
import type { GamePack } from '../../types';
import type { StateManager } from '../../core/state-manager';
import { createMockStateManager } from '../../__test-utils__';

const PACK_PROMPTS: Record<string, string> = {
  mainRound: 'PACK MAIN FORMAT\n{{BOOKMARKED_ROUNDS_BLOCK}}',
  splitGenStep1: 'PACK STEP1 FORMAT',
  narratorFrame: 'PACK NARRATOR',
  splitGenContext: 'STEP2 CONTEXT\n{{BOOKMARKED_ROUNDS_BLOCK}}',
  splitGenStep2: 'PACK STEP2',
  splitGenStep2Followup: 'PACK FOLLOWUP',
};

function bookmark(round: number, name: string, content: string, pending: boolean): BookmarkedRound {
  return { id: `bm_${round}`, round, createdAt: round * 1000, name, content, pending };
}

function makeStage(bookmarks: BookmarkedRound[]): ContextAssemblyStage {
  const { sm } = createMockStateManager({
    元数据: { 回合序号: 12, 叙事历史: [], 收藏楼层: bookmarks },
    世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
    角色: { 基础信息: { 姓名: '主角' } },
    系统: { 设置: { prompt: { enableWorldBook: false } } },
  });
  const registry = new PromptRegistry();
  registry.registerPack(PACK_PROMPTS, ALWAYS_ON_PROMPT_IDS);
  const pack = {
    id: 'test-pack',
    prompts: PACK_PROMPTS,
    promptFlows: {
      splitGenMainRoundStep2: {
        id: 'splitGenMainRoundStep2',
        modules: [
          { promptId: 'splitGenContext', role: 'system', order: -1, depth: 0 },
          { promptId: 'splitGenStep2', role: 'system', order: 0, depth: 0 },
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

function makeCtx(meta: Record<string, unknown>): PipelineContext {
  return {
    userInput: '走两步', originalUserInput: '走两步', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [],
    messages: [], roundNumber: 12, generationId: 'gen-bookmarks', meta,
  } as unknown as PipelineContext;
}

const text = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((m) => String(m.content)).join('\n');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const PICKED = bookmark(3, '血誓之夜', '立下血誓的那夜', true);
const NOT_PICKED = bookmark(5, '没选的那回', '不该出现的正文', false);

describe('ContextAssembly · bookmarked rounds reach the story request', () => {
  it('split Step 1 carries the rounds the player picked, not the others; Step 2 still does too', async () => {
    const out = await makeStage([PICKED, NOT_PICKED]).execute(makeCtx({ splitGen: true }));
    const story = text(out.messages);
    expect(story).toContain('立下血誓的那夜');
    expect(story).toContain('第3回合');
    expect(story).not.toContain('不该出现的正文');
    const step2 = text(out.meta.splitStep2Messages as Array<{ content: unknown }> | undefined);
    expect(step2).toContain('立下血誓的那夜');
    expect(step2).not.toContain('不该出现的正文');
  });

  it('the single call carries them once (the format prompt\'s own placeholder stays empty under the builder)', async () => {
    const out = await makeStage([PICKED]).execute(makeCtx({ splitGen: false }));
    const story = text(out.messages);
    expect(count(story, '立下血誓的那夜')).toBe(1);
    expect(story).toContain('PACK MAIN FORMAT');
  });

  it('nothing picked: no bookmarks piece, no header', async () => {
    const out = await makeStage([NOT_PICKED]).execute(makeCtx({ splitGen: true }));
    const story = text(out.messages);
    expect(story).not.toContain('玩家收藏的历史片段');
    expect(story).not.toContain('不该出现的正文');
  });
});
