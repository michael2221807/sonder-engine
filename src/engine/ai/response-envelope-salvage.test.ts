/**
 * A reply whose JSON cannot be parsed still shows its narrative, never the JSON source: the text is read out of
 * the `{"text":"…` envelope. Split-gen step1 has no repair stage behind it, so before this the player saw
 * `{"text":"…` and `\"` in the story (2026-10-02, PO trial).
 */
import { describe, expect, it, vi } from 'vitest';
import { ResponseParser, salvageEnvelopeText } from './response-parser';
import { AICallStage } from '../pipeline/stages/ai-call';
import { ResponseRepairStage } from '../pipeline/stages/response-repair';
import type { PipelineContext } from '../pipeline/types';
import type { AIService } from './ai-service';
import type { GenerateOptions } from './types';

const parser = new ResponseParser();
const STORY = '【Nove那扇玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，"嗡"地，白了半分。';
const ENVELOPED = String.raw`{"text":"【Nove那扇玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，\"嗡\"地，白了半分。`;

function unparseable(raw: string): void {
  expect(() => JSON.parse(raw)).toThrow();
}

describe('salvageEnvelopeText', () => {
  it('a reply cut off before the closing quote gives everything it has', () => {
    unparseable(ENVELOPED);
    expect(salvageEnvelopeText(ENVELOPED)).toBe(STORY);
  });
  it('a raw line break inside the string stays a line break', () => {
    const raw = '{"text":"第一段\n第二段，\\"嗡\\"地"}';
    unparseable(raw);
    expect(salvageEnvelopeText(raw)).toBe('第一段\n第二段，"嗡"地');
  });
  it('stops at the closing quote when the object ends or the next key follows', () => {
    expect(salvageEnvelopeText(String.raw`{"text":"正文\"引\""}` + '\n附注 {a} 完')).toBe('正文"引"');
    expect(salvageEnvelopeText(String.raw`{"text":"正文\"引\"" , "commands":[{"action":"set",}]`)).toBe('正文"引"');
  });
  it('a quote the model forgot to escape is part of the text', () => {
    expect(salvageEnvelopeText('{"text":"他喊"走",然后又说"快"。","commands":[')).toBe('他喊"走",然后又说"快"。');
  });
  it('a reply key written without double quotes still ends the story; prose before a colon does not', () => {
    expect(salvageEnvelopeText('{"text":"正文", commands:[{action:"set"')).toBe('正文');
    expect(salvageEnvelopeText("{\"text\":\"正文\", 'action_options':['走'")).toBe('正文');
    expect(salvageEnvelopeText('{"text":"他喊"走", 然后: 跑。')).toBe('他喊"走", 然后: 跑。');
  });
  it('decodes escapes; an unknown escape keeps its character; a cut-off escape is dropped', () => {
    expect(salvageEnvelopeText(String.raw`{"text":"你\t好\你\/x`)).toBe('你\t好你/x');
    expect(salvageEnvelopeText(String.raw`{"text":"笑😀了`)).toBe('笑😀了');
    expect(salvageEnvelopeText(String.raw`{"text":"a\u12G4`)).toBe('au12G4');
    expect(salvageEnvelopeText('{"text":"abc\\')).toBe('abc');
    expect(salvageEnvelopeText(String.raw`{"text":"abc\u4f`)).toBe('abc');
    expect(salvageEnvelopeText(String.raw`{"text":"abc\u`)).toBe('abc');
  });
  it('prose with braces before the envelope does not hide it; a nested "text" is never the story', () => {
    expect(salvageEnvelopeText('好的{场景}：\n' + ENVELOPED)).toBe(STORY);
    expect(salvageEnvelopeText('好的，{\n' + ENVELOPED)).toBe(STORY);
    expect(salvageEnvelopeText('好的，{\n{"commands":[{"value":{"text":"不是正文"')).toBeNull();
    expect(salvageEnvelopeText('{"commands":[{"action":"set","key":"a","value":{"text":"不是正文"}}]}\n' + ENVELOPED)).toBe(STORY);
  });
  it('a long dialogue-heavy story with unescaped quotes is read in linear time', () => {
    const story = '他说"好",她答"走",'.repeat(2500) + '完。';
    const started = performance.now();
    expect(salvageEnvelopeText(`{"text":"${story}`)).toBe(story);
    expect(performance.now() - started).toBeLessThan(200);
  });
  it('reads the legacy key and an envelope inside a code fence', () => {
    expect(salvageEnvelopeText('{"叙事文本":"旧键')).toBe('旧键');
    expect(salvageEnvelopeText('```json\n' + String.raw`{"text":"正文\n\n第二段`)).toBe('正文\n\n第二段');
  });
  it('anything else is not an envelope', () => {
    expect(salvageEnvelopeText('just prose {')).toBeNull();
    expect(salvageEnvelopeText('{"commands":[{"action":"set","key":"a","value":{"text":"not the story"}}')).toBeNull();
    expect(salvageEnvelopeText('{"text":"   ')).toBeNull();
    expect(salvageEnvelopeText('{"text":123, "commands":[')).toBeNull();
    expect(salvageEnvelopeText('{"text":null, "commands":[')).toBeNull();
    expect(salvageEnvelopeText('no json at all')).toBeNull();
  });
});

describe('ResponseParser.parse falls back to the envelope', () => {
  it('a broken reply gives the narrative and still says the structure was not parsed', () => {
    const out = parser.parse(ENVELOPED);
    expect(out).toMatchObject({ text: STORY, parseOk: false, raw: ENVELOPED });
  });
  it('after thinking is taken out, with the thinking kept', () => {
    const out = parser.parse(`<thinking>想一想 {x}</thinking>\n${ENVELOPED}`, { captureThinking: true });
    expect(out).toMatchObject({ text: STORY, parseOk: false, thinking: '想一想 {x}' });
  });
  it('a feature block after a broken envelope is still lifted out, not read into the story', () => {
    const out = parser.parse(`${ENVELOPED}"}\n<卡>[{"for":"茶"}]</卡>\n{坏}`, { sidecars: ['卡'] });
    expect(out).toMatchObject({ text: STORY, parseOk: false, sidecars: { 卡: '[{"for":"茶"}]' } });
  });
  it('a <正文> block still wins, and a reply that parses is untouched', () => {
    expect(parser.parse('<正文>标签正文</正文>\n{"text":"坏').text).toBe('标签正文');
    expect(parser.parse(JSON.stringify({ text: STORY })).text).toBe(STORY);
    expect(parser.parse('plain prose without json').text).toBe('plain prose without json');
  });
});

describe('single call: the repair stage cannot rescue anything, the story is still the narrative', () => {
  it('the repair model answers with prose: the salvaged narrative stays', async () => {
    const generate = vi.fn(async () => '抱歉，我无法修复。');
    const stage = new ResponseRepairStage({ generate } as unknown as AIService, parser);
    const parsed = parser.parse(ENVELOPED);
    const ctx = { userInput: 'u', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [], worldEventTriggered: false,
      roundNumber: 1, generationId: 'g', meta: {}, rawResponse: ENVELOPED, parsedResponse: parsed } as unknown as PipelineContext;
    const out = await stage.execute(ctx);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.parsedResponse).toMatchObject({ text: STORY, parseOk: false });
  });
});

describe('split-gen: a broken step1 never reaches the story as JSON', () => {
  it('the round keeps step1\'s narrative and step2\'s structure; step2 reads the narrative, not the envelope', async () => {
    const seen: GenerateOptions[] = [];
    const step2 = JSON.stringify({ commands: [{ action: 'set', key: 'a.b', value: 1 }], action_options: ['x', 'y', 'z'] });
    const ai = { generate: async (o: GenerateOptions) => { seen.push(o); return o.generationId?.endsWith('_step2') ? step2 : ENVELOPED; } } as unknown as AIService;
    const ctx = { userInput: 'u', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [{ role: 'user', content: 'u' }],
      worldEventTriggered: false, roundNumber: 1, generationId: 'g',
      meta: { splitGen: true, splitStep2Messages: [{ role: 'system', content: 'step2' }], plotVectorPromptMode: true } } as unknown as PipelineContext;
    const out = await new AICallStage(ai, parser).execute(ctx);
    expect(out.parsedResponse).toMatchObject({ text: STORY, parseOk: true });
    expect(out.parsedResponse?.commands).toHaveLength(1);
    expect(out.rawResponse).toBe(ENVELOPED);
    expect(seen[1].messages.find(m => m.role === 'assistant')?.content).toBe(JSON.stringify({ text: STORY }));
  });
});
