/**
 * The player's action-options switch (PO 2026-10-03): off, the last instruction step 2 reads does not ask for
 * options, and the round shows none whatever the model wrote. On, both are exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { AICallStage } from './ai-call';
import { RenderStage } from './render';
import { ResponseParser } from '../../ai/response-parser';
import { eventBus } from '../../core/event-bus';
import type { PipelineContext } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { AIResponse, GenerateOptions } from '../../ai/types';

const STEP2 = JSON.stringify({ commands: [], action_options: ['走', '停', '回头'], mid_term_memory: null, knowledge_facts: [] });
function splitCtx(meta: Record<string, unknown>): PipelineContext {
  return { userInput: 'u', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [{ role: 'user', content: 'u' }],
    roundNumber: 1, generationId: 'g',
    meta: { splitGen: true, splitStep2Messages: [{ role: 'system', content: 'step2' }], ...meta } } as unknown as PipelineContext;
}
async function step2Followup(meta: Record<string, unknown>): Promise<string> {
  const seen: GenerateOptions[] = [];
  const ai = { generate: async (o: GenerateOptions) => { seen.push(o); return o.generationId?.endsWith('_step2') ? STEP2 : JSON.stringify({ text: '正文' }); } } as unknown as AIService;
  await new AICallStage(ai, new ResponseParser()).execute(splitCtx(meta));
  return String(seen[1].messages.at(-1)?.content);
}

describe('step 2 follow-up and the action-options switch', () => {
  it('off: lists no action_options and says not to write them', async () => {
    const off = await step2Followup({ actionOptionsEnabled: false });
    expect(off).toContain('不要输出 action_options');
    expect(off).toContain('commands / mid_term_memory / knowledge_facts 三个字段');
    expect(off).not.toMatch(/action_options 必须|commands \/ action_options/);
    const capture = await step2Followup({ actionOptionsEnabled: false, settingCaptureActive: true });
    expect(capture).toContain('commands / mid_term_memory / knowledge_facts / setting_updates 四个字段');
  });
  it('on (or unset): the follow-up is the one it always was', async () => {
    const on = await step2Followup({ actionOptionsEnabled: true });
    expect(on).toBe(await step2Followup({}));
    expect(on).toContain('commands / action_options / mid_term_memory / knowledge_facts 四个字段');
    expect(on).toContain('2. **action_options 必须 3-5 个**');
  });
});

describe('RenderStage and the action-options switch', () => {
  it('off: nothing on screen and nothing in the round-complete payload; on: the model\'s options', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    for (const [enabled, expected] of [[false, []], [true, ['走', '停']]] as const) {
      emit.mockClear();
      const ctx = { ...splitCtx({ actionOptionsEnabled: enabled }), parsedResponse: { text: 't', actionOptions: ['走', '停'] } as AIResponse };
      const out = await new RenderStage().execute(ctx);
      expect(out.actionOptions).toEqual(expected);
      expect(emit).toHaveBeenCalledWith('ui:round-rendered', expect.objectContaining({ actionOptions: expected }));
    }
    emit.mockRestore();
  });
});
