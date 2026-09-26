/**
 * Blocks a feature lets the model append after the structured JSON (tag names come from the feature, never
 * from the engine): they are lifted out before the JSON is parsed, so a broken block cannot break the JSON
 * and a broken JSON does not lose the block. Covers the parser, both AI-call modes and the repair stage.
 */
import { describe, expect, it, vi } from 'vitest';
import { liftSidecars, ResponseParser } from './response-parser';
import { AICallStage } from '../pipeline/stages/ai-call';
import { ResponseRepairStage } from '../pipeline/stages/response-repair';
import type { PipelineContext } from '../pipeline/types';
import type { AIService } from './ai-service';
import type { GenerateOptions } from './types';

const JSON_REPLY = JSON.stringify({ commands: [{ action: 'set', key: 'a.b', value: 1 }], action_options: ['x', 'y', 'z'] });
const BLOCK = '[{"for":"茶","type":"item","summary":"s","onPass":"return { push: 1 };"}]';

describe('liftSidecars', () => {
  it('takes each tag out and returns its contents; absent tags are absent', () => {
    expect(liftSidecars(`${JSON_REPLY}\n<卡>${BLOCK}</卡>`, ['卡', '其他'])).toEqual({ text: JSON_REPLY, sidecars: { 卡: BLOCK } });
    expect(liftSidecars(JSON_REPLY, ['卡'])).toEqual({ text: JSON_REPLY, sidecars: {} });
    expect(liftSidecars(JSON_REPLY, undefined)).toEqual({ text: JSON_REPLY, sidecars: {} });
  });
  it('joins several blocks of one tag, and an unclosed block at the end takes the rest', () => {
    expect(liftSidecars('<a>1</a> mid <a>2</a>', ['a'])).toEqual({ text: 'mid', sidecars: { a: '1\n\n2' } });
    expect(liftSidecars(`${JSON_REPLY}\n<a>[{"cut`, ['a'])).toEqual({ text: JSON_REPLY, sidecars: { a: '[{"cut' } });
  });
  it('never takes the tag from inside the JSON: a quoted tag in a string cannot cut the reply', () => {
    const quoted = JSON.stringify({ text: '他喊道：<卡>！', commands: [] });
    expect(liftSidecars(quoted, ['卡'])).toEqual({ text: quoted, sidecars: {} });
    const both = JSON.stringify({ text: '引用<卡>x</卡>', commands: [] });
    expect(liftSidecars(`${both}\n<卡>${BLOCK}</卡>`, ['卡'])).toEqual({ text: both, sidecars: { 卡: BLOCK } });
    expect(new ResponseParser().parse(quoted, { sidecars: ['卡'] })).toMatchObject({ parseOk: true, text: '他喊道：<卡>！' });
  });
  it('a block before the JSON (e.g. with a narrative tag) is lifted too', () => {
    expect(liftSidecars(`<卡>${BLOCK}</卡>\n${JSON_REPLY}`, ['卡'])).toEqual({ text: JSON_REPLY, sidecars: { 卡: BLOCK } });
  });
  it('treats tag names literally', () => {
    expect(liftSidecars('<a.b>x</a.b><a+b>y</a+b>', ['a.b', 'a+b']).sidecars).toEqual({ 'a.b': 'x', 'a+b': 'y' });
  });
});

describe('ResponseParser with sidecars', () => {
  const parser = new ResponseParser();
  it('a block with braces after the JSON would break the JSON unless lifted out', () => {
    const raw = `${JSON_REPLY}\n<卡>${BLOCK}</卡>`;
    expect(parser.parse(raw).parseOk).toBe(false);
    const parsed = parser.parse(raw, { sidecars: ['卡'] });
    expect(parsed.parseOk).toBe(true);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.sidecars).toEqual({ 卡: BLOCK });
  });
  it('a broken block leaves the JSON intact; a broken JSON keeps the block', () => {
    const brokenBlock = parser.parse(`${JSON_REPLY}\n<卡>[{"for": 茶 ]]</卡>`, { sidecars: ['卡'] });
    expect(brokenBlock.parseOk).toBe(true);
    expect(brokenBlock.sidecars?.卡).toBe('[{"for": 茶 ]]');
    const brokenJson = parser.parse(`{"commands": [ <卡>${BLOCK}</卡>`, { sidecars: ['卡'] });
    expect(brokenJson.parseOk).toBe(false);
    expect(brokenJson.sidecars).toEqual({ 卡: BLOCK });
  });
  it('without the option nothing changes, and a reply without the block has no sidecars field', () => {
    expect(parser.parse(JSON_REPLY)).toEqual(parser.parse(JSON_REPLY, { sidecars: ['卡'] }));
    expect(parser.parse(JSON_REPLY, { sidecars: ['卡'] })).not.toHaveProperty('sidecars');
  });
});

function ctx(split: boolean, sidecars?: string[]): PipelineContext {
  return { userInput: 'u', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [{ role: 'user', content: 'u' }],
    worldEventTriggered: false, roundNumber: 1, generationId: 'g',
    meta: { ...(split ? { splitGen: true, splitStep2Messages: [{ role: 'system', content: 'step2' }] } : {}), ...(sidecars ? { responseSidecars: sidecars } : {}) } } as unknown as PipelineContext;
}

describe('AICallStage lifts the requested blocks in both modes', () => {
  it('split: from step2, merged into the round response', async () => {
    const ai = { generate: async (o: GenerateOptions) => (o.generationId?.endsWith('_step2') ? `${JSON_REPLY}\n<卡>${BLOCK}</卡>` : JSON.stringify({ text: '正文' })) } as unknown as AIService;
    const out = await new AICallStage(ai, new ResponseParser()).execute(ctx(true, ['卡']));
    expect(out.parsedResponse).toMatchObject({ text: '正文', parseOk: true, sidecars: { 卡: BLOCK } });
    expect(out.parsedResponse?.commands).toHaveLength(1);
  });
  it('single call: from the one reply', async () => {
    const ai = { generate: async () => `${JSON.stringify({ text: '正文', commands: [] })}\n<卡>${BLOCK}</卡>` } as unknown as AIService;
    const out = await new AICallStage(ai, new ResponseParser()).execute(ctx(false, ['卡']));
    expect(out.parsedResponse).toMatchObject({ text: '正文', parseOk: true, sidecars: { 卡: BLOCK } });
  });
  it('not requested: the reply is parsed exactly as before', async () => {
    const ai = { generate: async () => JSON.stringify({ text: '正文', commands: [] }) } as unknown as AIService;
    const out = await new AICallStage(ai, new ResponseParser()).execute(ctx(false));
    expect(out.parsedResponse).not.toHaveProperty('sidecars');
  });
});

describe('ResponseRepairStage keeps the block and repairs only the structure', () => {
  it('the repair model never sees the block; the round keeps it', async () => {
    const generate = vi.fn(async (_o: GenerateOptions) => JSON_REPLY);
    const stage = new ResponseRepairStage({ generate } as unknown as AIService, new ResponseParser());
    const raw = `{"commands": [ broken <卡>${BLOCK}</卡>`;
    const parsed = new ResponseParser().parse(raw, { sidecars: ['卡'] });
    const out = await stage.execute({ ...ctx(false, ['卡']), rawResponse: raw, parsedResponse: parsed });
    expect(String(generate.mock.calls[0][0].messages.at(-1)?.content)).not.toContain('<卡>');
    expect(out.parsedResponse).toMatchObject({ parseOk: true, sidecars: { 卡: BLOCK } });
  });
});
