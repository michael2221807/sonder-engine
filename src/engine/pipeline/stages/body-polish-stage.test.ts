/**
 * BodyPolishStage tests (Phase 4, 2026-04-19).
 *
 * Covers:
 *   - Skip when `系统.设置.bodyPolish` is false / missing
 *   - Apply polish and replace `parsedResponse.text`
 *   - Fallback to original when extraction fails
 *   - Fallback when polished result is too short (< 30% of original)
 *   - Emits `ui:debug-prompt` + `ui:debug-prompt-response` events
 *   - extractBodyFromPolishOutput correctness
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BodyPolishStage, extractBodyFromPolishOutput } from './body-polish-stage';
import type { PipelineContext } from '../types';
import type { AIResponse } from '../../ai/types';
import { eventBus } from '../../core/event-bus';

function makeStateManager(bodyPolishEnabled: boolean | null = true) {
  const tree: Record<string, unknown> = {};
  if (bodyPolishEnabled !== null) tree['系统.设置.bodyPolish'] = bodyPolishEnabled;
  return {
    get: vi.fn((p: string) => tree[p]),
    set: vi.fn((p: string, v: unknown) => {
      tree[p] = v;
    }),
  };
}

function makeAIService(rawResponse: string = '') {
  return {
    generate: vi.fn(async () => rawResponse),
    getConfigForUsage: vi.fn(() => ({ model: 'test-polish-model' })),
  };
}

function makePromptAssembler(overrideContent: string | null = null) {
  return {
    // Returns null → falls back to TS constants (covers the common case).
    // Tests that want to simulate a user-override pass a string here.
    renderSingle: vi.fn(() => overrideContent),
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: '',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    parsedResponse: {
      text: '原始叙事文本，需要被润色。包含足够多的字符，超过三十字。包含足够多的字符，超过三十字。',
    } as AIResponse,
    generationId: 'test-gen',
    roundNumber: 5,
    meta: {},
    ...overrides,
  };
}

describe('extractBodyFromPolishOutput', () => {
  it('returns empty for empty / non-string input', () => {
    expect(extractBodyFromPolishOutput('')).toBe('');
    expect(extractBodyFromPolishOutput(null as unknown as string)).toBe('');
  });

  it('extracts content between last <正文>...</正文>', () => {
    const raw =
      '<thinking>分析原文</thinking>\n' +
      '<正文>\n【夜色】已润色。\n</正文>';
    expect(extractBodyFromPolishOutput(raw)).toBe('【夜色】已润色。');
  });

  it('strips leading <thinking> that contains literal <正文> examples', () => {
    // The thinking block may reference the tag as a literal string;
    // extraction should pick the LAST top-level <正文>, not one inside thinking.
    const raw =
      '<thinking>输出结构是 <正文>...</正文>，我会整理</thinking>\n' +
      '<正文>真正的正文内容。</正文>';
    expect(extractBodyFromPolishOutput(raw)).toBe('真正的正文内容。');
  });

  it('handles unterminated <正文> (takes everything after last open tag)', () => {
    const raw = '<正文>\n未闭合的正文\n';
    expect(extractBodyFromPolishOutput(raw)).toBe('未闭合的正文');
  });

  it('returns empty when no <正文> tag present', () => {
    expect(extractBodyFromPolishOutput('<thinking>only thinking</thinking>')).toBe('');
  });

  it('trims whitespace on each line', () => {
    const raw = '<正文>  \n  【夜色】内容。   \n   </正文>';
    expect(extractBodyFromPolishOutput(raw)).toBe('【夜色】内容。');
  });
});

describe('BodyPolishStage.execute', () => {
  let capturedEvents: Array<{ name: string; payload: unknown }>;
  let offHandlers: Array<() => void>;

  beforeEach(() => {
    capturedEvents = [];
    offHandlers = [];
    offHandlers.push(
      eventBus.on('ui:debug-prompt', (p) => {
        capturedEvents.push({ name: 'ui:debug-prompt', payload: p });
      }),
    );
    offHandlers.push(
      eventBus.on('ui:debug-prompt-response', (p) => {
        capturedEvents.push({ name: 'ui:debug-prompt-response', payload: p });
      }),
    );
  });
  afterEach(() => {
    for (const off of offHandlers) off();
  });

  it('skips when bodyPolish setting is false', async () => {
    const sm = makeStateManager(false);
    const ai = makeAIService('<正文>polished</正文>');
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    const out = await stage.execute(ctx);
    expect(out).toBe(ctx); // unchanged
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('skips when bodyPolish setting is missing (default OFF)', async () => {
    const sm = makeStateManager(null);
    const ai = makeAIService();
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    await stage.execute(ctx);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('skips when parsedResponse.text is empty', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService();
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx({ parsedResponse: { text: '' } as AIResponse });
    await stage.execute(ctx);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('applies polish and replaces text when AI returns valid <正文>', async () => {
    const sm = makeStateManager(true);
    const polishedBody = '【夜色】润色后的正文，字数足够，不会触发长度过短的回退逻辑。';
    const ai = makeAIService(`<thinking>x</thinking><正文>${polishedBody}</正文>`);
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    const out = await stage.execute(ctx);
    expect(out.parsedResponse?.text).toBe(polishedBody);
    expect(out.meta.polishApplied).toBe(true);
    expect(out.meta.polishOriginalText).toBe(ctx.parsedResponse!.text);
    expect(out.meta.polishModel).toBe('test-polish-model');
    expect(typeof out.meta.polishDurationMs).toBe('number');
  });

  it('falls back to original when AI response has no <正文> tag', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<thinking>only thinking, no body</thinking>');
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    const out = await stage.execute(ctx);
    expect(out.parsedResponse?.text).toBe(ctx.parsedResponse!.text); // unchanged
    expect(out.meta.polishApplied).toBeUndefined();
  });

  it('falls back when polished text is suspiciously short (< 30% of original)', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<正文>短</正文>'); // 1-char polish vs ~40-char original
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    const out = await stage.execute(ctx);
    expect(out.parsedResponse?.text).toBe(ctx.parsedResponse!.text);
    expect(out.meta.polishApplied).toBeUndefined();
  });

  it('falls back when aiService.generate throws', async () => {
    const sm = makeStateManager(true);
    const ai = {
      generate: vi.fn(async () => { throw new Error('network error'); }),
      getConfigForUsage: vi.fn(() => ({ model: 'x' })),
    };
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    const out = await stage.execute(ctx);
    expect(out).toBe(ctx);
  });

  it('uses user-overridden prompt when promptAssembler.renderSingle returns content', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<正文>【夜色】够长的润色结果，确保通过 30% 阈值检查，所以不会回退。</正文>');
    const customPrompt = '用户自定义的润色指令';
    const pa = makePromptAssembler(customPrompt);
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    await stage.execute(makeCtx());
    const args = (ai.generate.mock.calls[0] as unknown as Array<{ messages: Array<{ content: string }> }>)[0];
    expect(args.messages[0].content).toBe(customPrompt);
  });

  it('emits ui:debug-prompt BEFORE the AI call and ui:debug-prompt-response AFTER', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<正文>【夜色】有足够字数的润色稿，超过百分之三十。</正文>');
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    await stage.execute(makeCtx({ generationId: 'abc' }));

    const assembly = capturedEvents.find((e) => e.name === 'ui:debug-prompt');
    const response = capturedEvents.find((e) => e.name === 'ui:debug-prompt-response');
    expect(assembly).toBeDefined();
    expect(response).toBeDefined();
    const assemblyP = assembly!.payload as {
      flow: string;
      messageSources: string[];
      generationId: string;
    };
    expect(assemblyP.flow).toBe('bodyPolish');
    expect(assemblyP.generationId).toBe('abc_polish');
    expect(assemblyP.messageSources).toEqual([
      'builder:bodyPolish_system',
      'builder:bodyPolish_user',
    ]);
  });

  it('passes user message as 【待润色正文】 + original text', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<正文>【夜色】足够长的润色结果，通过三十百分点阈值。</正文>');
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const ctx = makeCtx();
    await stage.execute(ctx);
    const args = (ai.generate.mock.calls[0] as unknown as Array<{ messages: Array<{ role: string; content: string }> }>)[0];
    expect(args.messages[1].role).toBe('user');
    expect(args.messages[1].content).toContain('【待润色正文】');
    expect(args.messages[1].content).toContain(ctx.parsedResponse!.text);
  });

  it('round-trips AGA 〖...〗 judgement blocks unchanged from the AI response', async () => {
    // Post-fix assurance (2026-04-19): if the AI correctly follows the prompt
    // and returns the judgement block byte-for-byte, the stage's extraction
    // must deliver that to the user without any mutation. This is the
    // regression-guard for the "judgement card breaks after polish" bug.
    const sm = makeStateManager(true);
    const judgement = '〖洞察:成功,判定值:42,难度:30,基础:35,幸运:+2,环境:0,状态:+5〗';
    const polished = `夜色深沉。${judgement}\n你站在门口，等待下一步。又补一段让长度过三十。`;
    const ai = makeAIService(`<thinking>ok</thinking><正文>${polished}</正文>`);
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    const out = await stage.execute(makeCtx());
    expect(out.parsedResponse?.text).toContain(judgement);
  });

  it('passes usageType: "bodyPolish" so users can route to a cheap/fast model', async () => {
    const sm = makeStateManager(true);
    const ai = makeAIService('<正文>【夜色】润色够长的结果内容，超过阈值字数。</正文>');
    const pa = makePromptAssembler();
    const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
    await stage.execute(makeCtx());
    const args = (ai.generate.mock.calls[0] as unknown as Array<{ usageType: string }>)[0];
    expect(args.usageType).toBe('bodyPolish');
  });

  // P2 env-tags port (2026-04-19): polish receives env block as read-only
  // reference so it doesn't contradict active weather / festival / env state.
  describe('environment-block pass-through', () => {
    it('prepends ctx.meta.environmentBlock to user message when present', async () => {
      const sm = makeStateManager(true);
      const ai = makeAIService('<正文>【夜色】足够长的润色结果，通过三十百分点阈值。</正文>');
      const pa = makePromptAssembler();
      const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
      const envBlock = '【当前环境】\n天气：暴雨\n节日：平日\n环境标签：\n  - 雾气弥漫';
      const ctx = makeCtx({ meta: { environmentBlock: envBlock } });
      await stage.execute(ctx);
      const args = (ai.generate.mock.calls[0] as unknown as Array<{ messages: Array<{ content: string }> }>)[0];
      expect(args.messages[1].content).toContain(envBlock);
      // Reference disclaimer present
      expect(args.messages[1].content).toContain('仅供润色参考');
      // Original text still present
      expect(args.messages[1].content).toContain(ctx.parsedResponse!.text);
    });

    it('omits the block and disclaimer when ctx.meta.environmentBlock is absent (backwards compat)', async () => {
      const sm = makeStateManager(true);
      const ai = makeAIService('<正文>【夜色】足够长的润色结果，通过三十百分点阈值。</正文>');
      const pa = makePromptAssembler();
      const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
      const ctx = makeCtx(); // no meta.environmentBlock
      await stage.execute(ctx);
      const args = (ai.generate.mock.calls[0] as unknown as Array<{ messages: Array<{ content: string }> }>)[0];
      expect(args.messages[1].content).not.toContain('【当前环境】');
      expect(args.messages[1].content).not.toContain('仅供润色参考');
    });

    it('omits the block when meta.environmentBlock is empty / whitespace', async () => {
      const sm = makeStateManager(true);
      const ai = makeAIService('<正文>【夜色】足够长的润色结果，通过三十百分点阈值。</正文>');
      const pa = makePromptAssembler();
      const stage = new BodyPolishStage(ai as never, sm as never, pa as never);
      const ctx = makeCtx({ meta: { environmentBlock: '   \n  ' } });
      await stage.execute(ctx);
      const args = (ai.generate.mock.calls[0] as unknown as Array<{ messages: Array<{ content: string }> }>)[0];
      expect(args.messages[1].content).not.toContain('【当前环境】');
    });
  });
});

