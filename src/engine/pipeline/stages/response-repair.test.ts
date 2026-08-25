/**
 * ResponseRepairStage tests (2026-04-19).
 *
 * Covers:
 *   - No-op when parseOk=true
 *   - No-op when rawResponse is empty
 *   - Narrative rescue from <正文>...</正文> when present
 *   - Structure rescue via AI call (commands/memory/options restored)
 *   - Graceful degradation when both rescue paths fail
 *   - extractNarrativeFromWrapper correctness
 */
import { describe, it, expect, vi } from 'vitest';
import { hasSettingUpdatesTrace } from './response-repair';
import { ResponseRepairStage, extractNarrativeFromWrapper } from './response-repair';
import { ResponseParser } from '../../ai/response-parser';
import type { PipelineContext } from '../types';
import type { AIResponse } from '../../ai/types';

function makeAIService(rawResponse = '{"text":"","commands":[],"action_options":[]}') {
  return {
    generate: vi.fn(async () => rawResponse),
    getConfigForUsage: vi.fn(() => ({ model: 'test-repair-model' })),
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: '',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    generationId: 'test-gen',
    roundNumber: 5,
    worldEventTriggered: false,
    meta: {},
    ...overrides,
  };
}

describe('extractNarrativeFromWrapper', () => {
  it('returns null on empty / non-string', () => {
    expect(extractNarrativeFromWrapper('')).toBeNull();
    expect(extractNarrativeFromWrapper(null as unknown as string)).toBeNull();
  });

  it('extracts content between last <正文>...</正文>', () => {
    const raw = '<thinking>...</thinking>\n<正文>\n深沉的夜色。\n</正文>\n{"text":"..."}';
    expect(extractNarrativeFromWrapper(raw)).toBe('深沉的夜色。');
  });

  it('returns null when no <正文> tag present', () => {
    const raw = '{"text":"just json"}';
    expect(extractNarrativeFromWrapper(raw)).toBeNull();
  });

  it('returns null for empty <正文></正文>', () => {
    expect(extractNarrativeFromWrapper('<正文></正文>')).toBeNull();
  });

  it('handles unclosed <正文> by taking until end', () => {
    const raw = '<正文>未闭合的正文';
    expect(extractNarrativeFromWrapper(raw)).toBe('未闭合的正文');
  });

  it('skips <正文> literals inside thinking block and uses the last real one', () => {
    const raw =
      '<thinking>输出格式是 <正文>...</正文></thinking>\n' +
      '<正文>真正的叙事。</正文>';
    expect(extractNarrativeFromWrapper(raw)).toBe('真正的叙事。');
  });
});

describe('ResponseRepairStage', () => {
  const parser = new ResponseParser();

  it('no-op when parseOk=true', async () => {
    const ai = makeAIService();
    const stage = new ResponseRepairStage(ai as never, parser);
    const ctx = makeCtx({
      rawResponse: '{"text":"ok","commands":[]}',
      parsedResponse: { text: 'ok', commands: [], parseOk: true } as AIResponse,
    });
    const result = await stage.execute(ctx);
    expect(result).toBe(ctx);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('no-op when rawResponse is empty', async () => {
    const ai = makeAIService();
    const stage = new ResponseRepairStage(ai as never, parser);
    const ctx = makeCtx({
      rawResponse: '',
      parsedResponse: { text: '', parseOk: false } as AIResponse,
    });
    const result = await stage.execute(ctx);
    expect(result).toBe(ctx);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('narrative rescue: extracts <正文> content even when AI repair fails', async () => {
    const ai = makeAIService('not json at all'); // repair AI returns garbage
    const stage = new ResponseRepairStage(ai as never, parser);
    const raw =
      '<thinking>analysis</thinking>\n' +
      '<正文>\n真实的叙事内容。\n</正文>\n' +
      '{"text":"broken \\你 json"'; // unclosed brace beyond sanitizer reach
    const ctx = makeCtx({
      rawResponse: raw,
      parsedResponse: { text: raw, parseOk: false } as AIResponse,
    });
    const result = await stage.execute(ctx);
    expect(result.parsedResponse?.text).toBe('真实的叙事内容。');
    expect(result.meta.responseRepairApplied).toBe(true);
    expect(result.meta.responseRepairNarrativeRescued).toBe(true);
    expect(result.meta.responseRepairStructureRescued).toBe(false);
  });

  it('structure rescue: AI call recovers commands and options', async () => {
    const repairResponse = JSON.stringify({
      text: '清理后的叙事',
      commands: [{ action: 'add', path: '世界.时间.分钟', value: 30 }],
      action_options: ['选项一', '选项二'],
      mid_term_memory: null,
    });
    const ai = makeAIService(repairResponse);
    const stage = new ResponseRepairStage(ai as never, parser);
    const raw = '<正文>清理后的叙事</正文>\n{broken json';
    const ctx = makeCtx({
      rawResponse: raw,
      parsedResponse: { text: raw, parseOk: false } as AIResponse,
    });
    const result = await stage.execute(ctx);
    expect(result.parsedResponse?.parseOk).toBe(true);
    expect(result.parsedResponse?.commands).toHaveLength(1);
    expect(result.parsedResponse?.commands?.[0].key).toBe('世界.时间.分钟');
    expect(result.parsedResponse?.actionOptions).toEqual(['选项一', '选项二']);
    expect(result.meta.responseRepairStructureRescued).toBe(true);
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when both rescue paths fail', async () => {
    const ai = makeAIService('nothing parseable');
    const stage = new ResponseRepairStage(ai as never, parser);
    const raw = '完全畸形的 raw 输出，没有任何结构标签也没有合法 json';
    const originalParsed: AIResponse = { text: raw, parseOk: false };
    const ctx = makeCtx({
      rawResponse: raw,
      parsedResponse: originalParsed,
    });
    const result = await stage.execute(ctx);
    // No rescue → ctx returned unchanged
    expect(result).toBe(ctx);
    expect(result.parsedResponse).toBe(originalParsed);
  });

  it('uses repaired text when <正文> missing but AI gave clean text', async () => {
    const repairResponse = JSON.stringify({
      text: '从 AI 救援得到的叙事',
      commands: [],
      action_options: ['选项'],
    });
    const ai = makeAIService(repairResponse);
    const stage = new ResponseRepairStage(ai as never, parser);
    const raw = '{broken no正文 tag';
    const ctx = makeCtx({
      rawResponse: raw,
      parsedResponse: { text: raw, parseOk: false } as AIResponse,
    });
    const result = await stage.execute(ctx);
    expect(result.parsedResponse?.text).toBe('从 AI 救援得到的叙事');
    expect(result.parsedResponse?.parseOk).toBe(true);
  });

  it('does not crash when AI service throws', async () => {
    const ai = {
      generate: vi.fn().mockRejectedValue(new Error('network error')),
      getConfigForUsage: vi.fn(),
    };
    const stage = new ResponseRepairStage(ai as never, parser);
    const raw = '<正文>backup 叙事</正文>\n{broken';
    const ctx = makeCtx({
      rawResponse: raw,
      parsedResponse: { text: raw, parseOk: false } as AIResponse,
    });
    const result = await stage.execute(ctx);
    // Narrative rescue still happened even though AI failed
    expect(result.parsedResponse?.text).toBe('backup 叙事');
    expect(result.meta.responseRepairStructureRescued).toBe(false);
  });
});

// ─── Canon Capture provenance gate (design §5.6) ─────────────

describe('ResponseRepairStage · split-gen structure source (round-62, 2026-08-25)', () => {
  // In split mode ctx.rawResponse is step1's NARRATIVE; the broken structured JSON
  // lives in meta.rawResponseStep2. Repair must feed THAT to the repair model and
  // read the provenance gate from it — otherwise setting_updates is unrecoverable
  // (step1 prose never carries the field) and commands get reinvented from prose.
  const STEP1_PROSE = '<正文>夜色沉沉，她抱着外衣走进宿舍楼。</正文>';
  const BROKEN_STEP2 =
    '{"commands":[{"action":"set","path":"世界.天气","value":"晴"}],"setting_updates":[{"kind":"world_fact","statement":"x","evidence":"看上去"养尊处优"的女性"}]';

  function splitRepairCtx(): PipelineContext {
    return makeCtx({
      rawResponse: STEP1_PROSE,
      parsedResponse: { text: '夜色沉沉。', commands: [], actionOptions: [], parseOk: false, raw: STEP1_PROSE } as AIResponse,
      meta: { rawResponseStep2: BROKEN_STEP2 },
    });
  }

  it('feeds meta.rawResponseStep2 (not step1 prose) to the repair model', async () => {
    const service = makeAIService(
      '{"commands":[{"action":"set","path":"世界.天气","value":"晴"}],"action_options":["a","b","c"],"setting_updates":[{"kind":"world_fact","statement":"x","evidence":"e"}]}',
    );
    await new ResponseRepairStage(
      service as never, new ResponseParser(),
    ).execute(splitRepairCtx());

    const call = (service.generate.mock.calls as unknown[][])[0][0] as { messages: Array<{ content: string }> };
    const userMsg = call.messages[call.messages.length - 1].content;
    expect(userMsg).toContain(BROKEN_STEP2);
    expect(userMsg).not.toContain('夜色沉沉，她抱着外衣');
  });

  it('provenance gate reads step2 raw: repaired setting_updates are ACCEPTED when step2 carried the field', async () => {
    const service = makeAIService(
      '{"commands":[],"action_options":["a","b","c"],"setting_updates":[{"kind":"world_fact","statement":"x","evidence":"e"}]}',
    );
    const out = await new ResponseRepairStage(
      service as never, new ResponseParser(),
    ).execute(splitRepairCtx());
    expect(out.parsedResponse?.settingUpdates).toHaveLength(1);
  });

  it('provenance gate still REJECTS when step2 raw never had the field', async () => {
    const service = makeAIService(
      '{"commands":[],"action_options":["a","b","c"],"setting_updates":[{"kind":"world_fact","statement":"invented","evidence":"e"}]}',
    );
    const ctx = makeCtx({
      rawResponse: STEP1_PROSE,
      parsedResponse: { text: 'x', commands: [], actionOptions: [], parseOk: false, raw: STEP1_PROSE } as AIResponse,
      meta: { rawResponseStep2: '{"commands":[{"action":"set"' },
    });
    const out = await new ResponseRepairStage(service as never, new ResponseParser()).execute(ctx);
    expect(out.parsedResponse?.settingUpdates).toBeUndefined();
  });

  it('single-call mode is unchanged: structure comes from ctx.rawResponse', async () => {
    const raw = '正文...{"commands":[{"action":"set"'; // broken single-call output
    const service = makeAIService('{"commands":[],"action_options":["a","b","c"]}');
    await new ResponseRepairStage(service as never, new ResponseParser()).execute(makeCtx({
      rawResponse: raw,
      parsedResponse: { text: '', commands: [], actionOptions: [], parseOk: false, raw } as AIResponse,
    }));
    const call = (service.generate.mock.calls as unknown[][])[0][0] as { messages: Array<{ content: string }> };
    expect(call.messages[call.messages.length - 1].content).toContain(raw);
  });
});

describe('hasSettingUpdatesTrace', () => {
  it('detects the field in a malformed but recognisable output', () => {
    expect(hasSettingUpdatesTrace('{"text":"x","setting_updates":[{')).toBe(true);
    expect(hasSettingUpdatesTrace("{'setting_updates' : [")).toBe(true);
    expect(hasSettingUpdatesTrace('setting_updates: [')).toBe(true);
  });

  it('is false when the output only CONTAINS narrative that could imply settings', () => {
    // The repair model sees the whole narrative; without this gate it could invent a
    // plausible `setting_updates` array from the prose. A prompt rule cannot stop that.
    expect(hasSettingUpdatesTrace('林月从小怕水，她站在码头边发抖。')).toBe(false);
    expect(hasSettingUpdatesTrace('{"text":"...","commands":[]}')).toBe(false);
  });

  it('is false for empty / non-string input', () => {
    expect(hasSettingUpdatesTrace(undefined)).toBe(false);
    expect(hasSettingUpdatesTrace('')).toBe(false);
    expect(hasSettingUpdatesTrace(123 as unknown as string)).toBe(false);
  });

  it('does not fire on a mere mention without the JSON key shape', () => {
    expect(hasSettingUpdatesTrace('the setting_updates field was missing')).toBe(false);
  });
});

/** Read the system prompt the repair stage actually sent, without leaning on mock tuple types. */
function systemPromptOf(ai: ReturnType<typeof makeAIService>): string {
  const call = ai.generate.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }];
  return call[0].messages[0].content;
}

describe('ResponseRepairStage · Canon Capture provenance gate (end-to-end)', () => {
  const parser = new ResponseParser();

  const REPAIRED = JSON.stringify({
    text: '救回来的正文',
    commands: [],
    action_options: ['a', 'b', 'c'],
    setting_updates: [{
      kind: 'character', statement: '林月从小怕水。', evidence: '她从小怕水',
      anchors: ['林月'], entities: ['林月'],
    }],
  });

  it('accepts repaired settings when the malformed output really had the field', async () => {
    const ai = makeAIService(REPAIRED);
    const stage = new ResponseRepairStage(ai as never, parser);
    const result = await stage.execute(makeCtx({
      // Truncated mid-array — the field IS there, just unparseable.
      rawResponse: '{"text":"半截", "setting_updates":[{"kind":"character","statement":"林月从小',
      parsedResponse: { text: '半截', parseOk: false } as AIResponse,
    }));
    expect(result.parsedResponse?.settingUpdates).toHaveLength(1);
  });

  it('DISCARDS repaired settings when the malformed output never had the field', async () => {
    // The repair model sees the whole narrative and can happily invent a plausible
    // array from it. Only code can stop that — a prompt rule cannot.
    const ai = makeAIService(REPAIRED);
    const stage = new ResponseRepairStage(ai as never, parser);
    const result = await stage.execute(makeCtx({
      rawResponse: '{"text":"林月从小怕水，她站在码头边发抖。","commands":[',
      parsedResponse: { text: '林月从小怕水…', parseOk: false } as AIResponse,
    }));
    expect(result.parsedResponse?.settingUpdates).toBeUndefined();
    // The rest of the rescue still works — the gate is surgical.
    expect(result.parsedResponse?.actionOptions).toHaveLength(3);
  });

  it('only asks the repair model for the field when it was actually present', async () => {
    const withField = makeAIService(REPAIRED);
    await new ResponseRepairStage(withField as never, parser).execute(makeCtx({
      rawResponse: '{"setting_updates":[{',
      parsedResponse: { text: 'x', parseOk: false } as AIResponse,
    }));
    expect(systemPromptOf(withField)).toContain('setting_updates');

    const withoutField = makeAIService(REPAIRED);
    await new ResponseRepairStage(withoutField as never, parser).execute(makeCtx({
      rawResponse: '{"text":"普通叙事","commands":[',
      parsedResponse: { text: 'x', parseOk: false } as AIResponse,
    }));
    expect(systemPromptOf(withoutField)).not.toContain('setting_updates');
  });
});
