import { describe, expect, it } from 'vitest';
import { isSystemBracket, storyLines, storyText, withoutSystemLines } from './narrative-brackets';

describe('isSystemBracket', () => {
  it('a key before a colon in the first clause is a system line; anything else is the narrative\'s own emphasis', () => {
    expect(isSystemBracket('系统提示：车门关上，后座那人')).toBe(true);
    expect(isSystemBracket('社交:成功,判定值:16')).toBe(true);
    expect(isSystemBracket('你那根弦,彻底松了下来')).toBe(false);
    expect(isSystemBracket('走丢的开头 〖行动:成功')).toBe(true);
  });
});

// PO 2026-10-02 (A): with plot vector on, the model sees its recent story without system lines, as the player
// reads it; speech has always read it this way.
describe('storyText', () => {
  const round = '【车厢里很静。】\n\n〖系统提示：车门关上，后座那人，没再看你。〗\n\n你望着窗外。〖那点东西，又冷又软地，翻了一下。〗\n\n〖社交:成功,判定值:16,难度:9〗他点了点头。';
  it('leaves the system lines out, keeps a bracketed thought as its words, and closes the gaps', () => {
    expect(storyText(round)).toBe('【车厢里很静。】\n\n你望着窗外。那点东西，又冷又软地，翻了一下。\n\n他点了点头。');
    expect(storyText(round)).not.toContain('〖');
  });
  it('is the text speech reads, with the blank lines a removed line leaves closed up', () => {
    expect(withoutSystemLines(round)).toContain('\n\n\n\n');
    expect(storyText(round)).toBe(withoutSystemLines(round).replace(/\n{3,}/g, '\n\n').trim());
  });
  it('removes the slips too: a verdict written in 【】 and a verdict reasoning block; narrative 【】 stays', () => {
    expect(storyText('【判定:心性,结果:失败】她低下头。【判定日快到了】<judge>心性 46 < 70</judge>')).toBe('她低下头。【判定日快到了】');
  });
  it('a story without system lines comes back as it was', () => {
    expect(storyText('他说"好"。\n\n她走了。')).toBe('他说"好"。\n\n她走了。');
    expect(storyText('')).toBe('');
  });
});

describe('storyLines (a memory block)', () => {
  it('works line by line: a snippet cut inside a bracket never takes the next bullets with it', () => {
    const block = '### 相关事件\n- 你上了车。〖系统提示：车门关\n- （第5轮）\n- 他点了点头。〖系统提示：好感度变化〗\n- 她笑了。';
    expect(storyLines(block)).toBe('### 相关事件\n- 你上了车。系统提示：车门关\n- （第5轮）\n- 他点了点头。\n- 她笑了。');
    // Treated as one text, the cut 〖 pairs with the later 〗 and the bullets between are lost.
    expect(storyText(block)).not.toContain('（第5轮）');
  });
});
