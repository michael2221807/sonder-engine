/**
 * The `{"text":"` leak's root (2026-10-03, PO trial round 128): the CoT protocol asks for the narrative in
 * `<正文>…</正文>` while the format asks for a JSON reply, and a model that does both writes the whole reply inside
 * the tag — the parser took the tag's content, the JSON source, as the story. Or it writes the tag inside the JSON
 * string — the parser took the tag's content from the still-escaped source, showing `\"` and `\n`. The tag is now
 * judged by where it stands. These are the shapes, every one checked with and without thinking capture.
 */
import { describe, expect, it } from 'vitest';
import { ResponseParser, repairStoredNarrative } from './response-parser';
import { createJsonTextStreamUnwrapper } from '../pipeline/stages/ai-call';
import { NarrativeEnvelopeRepairModule } from '../behaviors/narrative-envelope-repair';
import { StateManager } from '../core/state-manager';

const STORY = '【楼道那盏声控灯，在你踩上最后一级台阶时，又"啪"地熄了。】\n\n你轻手轻脚地，推开了寝室那扇门。';
/** As models write it: the inner quotes unescaped, the line breaks raw. */
const LOOSE = `{"text":"${STORY}"}`;
const parser = new ResponseParser();
const textOf = (raw: string, captureThinking = false) => parser.parse(raw, { captureThinking }).text;

describe('the narrative tag is judged by where it stands', () => {
  for (const capture of [false, true]) {
    it(`the whole reply inside <正文> is the reply, not the story (capture=${capture})`, () => {
      expect(textOf(`<正文>${LOOSE}</正文>`, capture)).toBe(STORY);
      expect(textOf(`<thinking>先想一想</thinking>\n<正文>${LOOSE}</正文>`, capture)).toBe(STORY);
      expect(textOf(`<正文>${JSON.stringify({ text: STORY })}</正文>`, capture)).toBe(STORY);
    });
    it(`a tag inside the JSON string is the JSON's: decoded, without the tag (capture=${capture})`, () => {
      expect(textOf(JSON.stringify({ text: `<正文>${STORY}</正文>` }), capture)).toBe(STORY);
    });
  }
  it('a single-call reply wrapped in the tag keeps its commands and options', () => {
    const reply = { text: STORY, commands: [{ action: 'set', key: '世界.天气', value: '晴' }], action_options: ['走', '停'] };
    const parsed = parser.parse(`<正文>${JSON.stringify(reply)}</正文>`);
    expect(parsed.parseOk).toBe(true);
    expect(parsed.text).toBe(STORY);
    expect(parsed.commands).toEqual([{ action: 'set', key: '世界.天气', value: '晴' }]);
    expect(parsed.actionOptions).toEqual(['走', '停']);
  });
  it('prose in the tag that merely starts like JSON stays the story', () => {
    const prose = '{"系统":"警告"}——屏幕亮了。';
    expect(textOf(`<正文>${prose}</正文>`)).toBe(prose);
  });
  it('a fenced reply in the tag is read too', () => {
    expect(textOf('<正文>```json\n' + JSON.stringify({ text: STORY }) + '\n```</正文>')).toBe(STORY);
  });
  it('fields written after a reply in the tag still count', () => {
    for (const inTag of [LOOSE, JSON.stringify({ text: STORY })]) {
      const parsed = parser.parse(`<正文>${inTag}</正文>\n${JSON.stringify({ commands: [{ action: 'set', key: 'x', value: 1 }], action_options: ['走', '停', '回头'] })}`);
      expect(parsed.text).toBe(STORY);
      expect(parsed.commands).toHaveLength(1);
      expect(parsed.actionOptions).toEqual(['走', '停', '回头']);
    }
  });
  it('a loose reply with the tag inside its string keeps its structure', () => {
    const parsed = parser.parse(`{"text":"<正文>${STORY}</正文>","commands":[{"action":"set","key":"x","value":1}],"action_options":["走"]}`);
    expect(parsed.parseOk).toBe(true);
    expect(parsed.text).toBe(STORY);
    expect(parsed.commands).toHaveLength(1);
  });
  it('a stray brace in prose before the tag does not hide it', () => {
    expect(textOf(`好的，{\n<正文>${STORY}</正文>\n${JSON.stringify({ text: '(见上方正文)', commands: [] })}`)).toBe(STORY);
  });
  it('an unclosed tag and an example tag inside the thinking are handled as before', () => {
    expect(textOf('<正文>未闭合的正文')).toBe('未闭合的正文');
    for (const capture of [false, true]) {
      expect(textOf('<thinking>输出格式是 <正文>...</正文></thinking>\n<正文>真正的叙事。</正文>', capture)).toBe('真正的叙事。');
    }
  });
  it('only the exact narrative key makes the tag a reply', () => {
    const odd = '{"Text":"大写的键"}';
    expect(parser.parse(`<正文>${odd}</正文>`).text).toBe(odd);
  });
  it('the CoT protocol shape is unchanged: the story in the tag, the JSON after it', () => {
    const raw = `<正文>${STORY}</正文>\n${JSON.stringify({ text: '(见上方正文)', commands: [] })}`;
    expect(textOf(raw)).toBe(STORY);
    expect(parser.parse(raw).parseOk).toBe(true);
  });
});

describe('repairStoredNarrative', () => {
  it('reads the story out of a round saved as its envelope, bare or in the tag', () => {
    expect(repairStoredNarrative(LOOSE)).toBe(STORY);
    expect(repairStoredNarrative(`<正文>${LOOSE}</正文>`)).toBe(STORY);
    expect(repairStoredNarrative(JSON.stringify({ text: STORY }))).toBe(STORY);
  });
  it('leaves a story alone, even one that quotes JSON further down', () => {
    expect(repairStoredNarrative(STORY)).toBeNull();
    expect(repairStoredNarrative(`他念出那行字：{"text":"x"}`)).toBeNull();
    expect(repairStoredNarrative('')).toBeNull();
  });
});

describe('the stream shows the story while it arrives', () => {
  const streamed = (raw: string, size = 3) => {
    let shown = '';
    const filter = createJsonTextStreamUnwrapper((chunk) => { shown += chunk; });
    for (const piece of raw.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []) filter.onChunk(piece);
    filter.flush();
    return shown;
  };
  it('behind <正文> too, and through quotes the model did not escape', () => {
    for (const size of [1, 3, 17]) {
      expect(streamed(LOOSE, size)).toBe(STORY);
      expect(streamed(`<正文>${LOOSE}</正文>`, size)).toBe(STORY);
      expect(streamed(JSON.stringify({ text: STORY, commands: [] }), size)).toBe(STORY);
    }
  });
  it('prose that is not an envelope passes through', () => {
    expect(streamed(STORY)).toBe(STORY);
  });
  it('a quote and a comma in the story do not end it; a quote, a comma and the next key do', () => {
    const prose = '他说"好", 然后走了。';
    for (const size of [1, 3, 17]) {
      expect(streamed(`{"text":"${prose}"}`, size)).toBe(prose);
      expect(streamed(`{"text":"${prose}", "commands":[]}`, size)).toBe(prose);
    }
  });
});

describe('NarrativeEnvelopeRepairModule', () => {
  it('heals saved rounds and short-term memories, and nothing else', () => {
    const sm = new StateManager();
    sm.loadTree({
      元数据: { 叙事历史: [
        { role: 'user', content: LOOSE },
        { role: 'assistant', content: `<正文>${LOOSE}</正文>`, _rawResponse: `<正文>${LOOSE}</正文>`, _polish: { applied: true, originalText: LOOSE } },
        { role: 'assistant', content: STORY },
      ] },
      记忆: { 短期: [{ round: 127, summary: STORY }, { round: 128, summary: LOOSE }] },
    } as never);
    sm.set('元数据.收藏楼层', [{ id: 'bm_128', round: 128, content: LOOSE }, { id: 'bm_3', round: 3, content: STORY }], 'system');
    new NarrativeEnvelopeRepairModule('元数据.叙事历史', '记忆.短期', '元数据.收藏楼层').onGameLoad(sm);
    const history = sm.get<Array<Record<string, unknown>>>('元数据.叙事历史')!;
    expect(history[0].content).toBe(LOOSE);            // the player's own words are never touched
    expect(history[1].content).toBe(STORY);
    expect(history[1]._rawResponse).toBe(`<正文>${LOOSE}</正文>`);
    expect((history[1]._polish as { originalText: string; applied: boolean })).toEqual({ applied: true, originalText: STORY });
    expect(history[2].content).toBe(STORY);
    expect(sm.get('记忆.短期')).toEqual([{ round: 127, summary: STORY }, { round: 128, summary: STORY }]);
    expect(sm.get('元数据.收藏楼层')).toEqual([{ id: 'bm_128', round: 128, content: STORY }, { id: 'bm_3', round: 3, content: STORY }]);
  });
  it('a save with nothing to heal is not written', () => {
    const sm = new StateManager();
    sm.loadTree({ 元数据: { 叙事历史: [{ role: 'assistant', content: STORY }] }, 记忆: { 短期: [{ round: 1, summary: STORY }] } } as never);
    const changes: unknown[] = [];
    const before = JSON.stringify(sm.toSnapshot());
    const spy = sm.set.bind(sm);
    sm.set = ((path: string, value: unknown, source?: never) => { changes.push(path); return spy(path, value, source); }) as typeof sm.set;
    new NarrativeEnvelopeRepairModule('元数据.叙事历史', '记忆.短期', '元数据.收藏楼层').onGameLoad(sm);
    expect(changes).toEqual([]);
    expect(JSON.stringify(sm.toSnapshot())).toBe(before);
  });
});
