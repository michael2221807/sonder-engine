/**
 * Split-gen field-merge regression.
 *
 * `executeSplitGen` merges the two responses through a HAND-WRITTEN whitelist: the
 * narrative comes from step1, the structured fields from step2, and anything not named
 * in that object literal is silently dropped — in split mode only. That asymmetry has
 * bitten this codebase before, and for Canon Capture it would mean a player's explicitly
 * marked setting vanishes for anyone who has split generation enabled, with no error.
 *
 * So the whitelist gets a test.
 */
import { describe, it, expect } from 'vitest';
import { AICallStage } from './ai-call';
import { ResponseParser } from '../../ai/response-parser';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { GenerateOptions } from '../../ai/types';

void DEFAULT_ENGINE_PATHS;

const STEP1 = JSON.stringify({ text: '码头的风很凉，林月停在栈桥前。' });
const STEP2 = JSON.stringify({
  commands: [{ action: 'add', path: '世界.时间.分钟', value: 20 }],
  action_options: ['靠近水边', '牵住她的手', '换条路走'],
  mid_term_memory: { 相关角色: ['林月'], 事件时间: '1-01-15-08-30', 记忆主体: '带林月到码头。' },
  knowledge_facts: [{ fact: '林月害怕靠近深水区域', source_entity: '林月', target_entity: '码头' }],
  setting_updates: [{
    kind: 'character',
    statement: '林月从小怕水。',
    evidence: '她从小怕水',
    anchors: ['林月', '怕水'],
    entities: ['林月'],
  }],
});

/** Minimal AIService double: step1 vs step2 chosen by generationId suffix. */
function fakeAiService(): AIService {
  return {
    generate: async (opts: GenerateOptions): Promise<string> =>
      opts.generationId?.endsWith('_step2') ? STEP2 : STEP1,
  } as unknown as AIService;
}

function splitCtx(): PipelineContext {
  return {
    userInput: '我带她去码头。<设定>她从小怕水</设定>',
    originalUserInput: '我带她去码头。<设定>她从小怕水</设定>',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [{ role: 'system', content: 'step1 prompt' }],
    worldEventTriggered: false,
    roundNumber: 2,
    generationId: 'gen-1',
    meta: {
      splitGen: true,
      splitStep2Messages: [{ role: 'system', content: 'step2 prompt' }],
    },
  } as unknown as PipelineContext;
}

describe('AICallStage · split-gen merge whitelist', () => {
  it('carries setting_updates from step2 into the merged response', async () => {
    const stage = new AICallStage(fakeAiService(), new ResponseParser());
    const out = await stage.execute(splitCtx());

    expect(out.parsedResponse?.settingUpdates).toHaveLength(1);
    expect(out.parsedResponse?.settingUpdates?.[0]).toMatchObject({
      kind: 'character',
      statement: '林月从小怕水。',
    });
  });

  it('still carries the pre-existing step2 fields (no regression from the addition)', async () => {
    const stage = new AICallStage(fakeAiService(), new ResponseParser());
    const out = await stage.execute(splitCtx());

    expect(out.parsedResponse?.text).toContain('码头的风很凉');   // from step1
    expect(out.parsedResponse?.commands).toHaveLength(1);          // from step2
    expect(out.parsedResponse?.actionOptions).toHaveLength(3);
    expect(out.parsedResponse?.knowledgeFacts).toHaveLength(1);
  });

  it('leaves settingUpdates undefined when step2 did not emit the field', async () => {
    const service = {
      generate: async (opts: GenerateOptions): Promise<string> =>
        opts.generationId?.endsWith('_step2')
          ? JSON.stringify({ commands: [], action_options: ['a', 'b', 'c'] })
          : STEP1,
    } as unknown as AIService;

    const out = await new AICallStage(service, new ResponseParser()).execute(splitCtx());
    expect(out.parsedResponse?.settingUpdates).toBeUndefined();
  });

  it('tagged round: the step2 followup checklist DEMANDS setting_updates', async () => {
    // Round-62 real-API incident (2026-08-25): the followup is the model's final
    // instruction and enumerated only four required fields, so the model omitted
    // setting_updates entirely — zero candidates, banner 0/0/0. The checklist must
    // name the field whenever the round carries a tag.
    const sent: GenerateOptions[] = [];
    const service = {
      generate: async (opts: GenerateOptions): Promise<string> => {
        sent.push(opts);
        return opts.generationId?.endsWith('_step2') ? STEP2 : STEP1;
      },
    } as unknown as AIService;

    const ctx = splitCtx();
    (ctx.meta as Record<string, unknown>)['settingCaptureActive'] = true;
    await new AICallStage(service, new ResponseParser()).execute(ctx);

    const step2Call = sent.find((o) => o.generationId?.endsWith('_step2'));
    const followup = step2Call?.messages[step2Call.messages.length - 1];
    expect(followup?.role).toBe('user');
    expect(followup?.content).toContain('setting_updates');
    expect(followup?.content).toContain('五个字段');
    expect(followup?.content).toContain('设定提取协议');
  });

  it('untagged round: the followup is byte-identical to the pre-capture text (D6)', async () => {
    const sent: GenerateOptions[] = [];
    const service = {
      generate: async (opts: GenerateOptions): Promise<string> => {
        sent.push(opts);
        return opts.generationId?.endsWith('_step2') ? STEP2 : STEP1;
      },
    } as unknown as AIService;

    await new AICallStage(service, new ResponseParser()).execute(splitCtx());

    const step2Call = sent.find((o) => o.generationId?.endsWith('_step2'));
    const followup = step2Call?.messages[step2Call.messages.length - 1];
    // D6 is a BYTE-identity invariant ("无 tag 回合提示词一字不变"), so this must be an
    // exact-string comparison — a substring check would let a whitespace regression
    // through. This literal is the pre-capture followup, verbatim.
    expect(followup?.content).toBe(
      '请基于上面的叙事正文，输出 step2 的结构化数据。要求：\n\n' +
      '1. **完整输出**：commands / action_options / mid_term_memory / knowledge_facts 四个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n' +
      '2. **action_options 必须 3-5 个**（按 `actionOptions` 或 `actionOptionsStory` 模块要求的长度），绝不可空数组或只给 1-2 个。\n' +
      '3. **commands 必须完整**：若本回合正文描述了多个状态变化（位置/时间/NPC/物品/体力/技能等），每条都要对应一条 command；不得合并省略。\n' +
      '4. **格式铁律**：直接输出一个合法 JSON 对象 —— 无 ``` 代码围栏、无前后缀文字、无 `<thinking>` 标签。不重复或扩写正文（正文已由 step1 生成）。\n\n' +
      '现在请输出这个 JSON 对象。',
    );
  });

  it('propagates step2 parseOk so ResponseRepair can trigger (round-62: shattered step2 JSON)', async () => {
    // Truncated beyond any sanitizer's help. Before the fix the merge dropped parseOk
    // entirely (undefined), ResponseRepair's `parseOk !== false` guard saw "healthy",
    // and commands + memory + the player's marked settings vanished with no repair.
    const service = {
      generate: async (opts: GenerateOptions): Promise<string> =>
        opts.generationId?.endsWith('_step2') ? '{"commands": [' : STEP1,
    } as unknown as AIService;

    const out = await new AICallStage(service, new ResponseParser()).execute(splitCtx());
    expect(out.parsedResponse?.parseOk).toBe(false);
    expect(out.meta.rawResponseStep2).toBe('{"commands": [');
  });

  it('healthy step2 merges with parseOk true', async () => {
    const out = await new AICallStage(fakeAiService(), new ResponseParser()).execute(splitCtx());
    expect(out.parsedResponse?.parseOk).toBe(true);
  });

  it('single-call mode carries the field too', async () => {
    const single = JSON.stringify({
      text: 'n',
      setting_updates: [{ kind: 'world_fact', statement: 'x', evidence: 'x', anchors: ['x'], entities: [] }],
    });
    const service = { generate: async (): Promise<string> => single } as unknown as AIService;

    const ctx = splitCtx();
    delete (ctx.meta as Record<string, unknown>)['splitStep2Messages'];
    const out = await new AICallStage(service, new ResponseParser()).execute(ctx);

    expect(out.parsedResponse?.settingUpdates).toHaveLength(1);
  });
});
