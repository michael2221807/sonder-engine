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

// Option C (PO 2026-10-05; docs/research/numeric-status-lines-2026-10-05.md): the model's view of recent story in
// plot momentum leaves out a gauge's status bracket written right after a verdict, and short gauge status lines.
describe('ModelStoryOptions (the model’s recent story only)', () => {
  const opts = { dropBracketsAfterSystemLines: true, gaugeNames: new Set(['人性锚点', '反差体质失控度', '外婆治疗费缺口']) };

  it('display and speech are unchanged: without options a status bracket after a verdict keeps its text', () => {
    expect(withoutSystemLines('她点头。〖判定:心性,结果:成功,判定值:57〗〖人性锚点回升至27〗')).toBe('她点头。人性锚点回升至27');
  });

  it('a bracket right after a verdict goes with it, a chain of them too, with spaces between but not a line break', () => {
    expect(storyText('她点头。〖判定:心性,结果:成功〗〖人性锚点回升至27〗〖失控微涌后缓降至74〗', opts)).toBe('她点头。');
    expect(storyText('她点头。〖判定:心性,结果:成功〗 〖人性锚点回升至27〗', { dropBracketsAfterSystemLines: true })).toBe('她点头。');
    expect(storyText('〖判定:心性,结果:成功〗\n〖她心里一沉〗', { dropBracketsAfterSystemLines: true })).toBe('她心里一沉');
    // A bracket of the story's own, not after a verdict, keeps its text.
    expect(storyText('她说〖别回头〗然后走了。', opts)).toBe('她说别回头然后走了。');
  });

  it('a short line of its own that opens with a gauge name and carries a digit is left out; story lines stay', () => {
    const raw = '她靠在你肩上睡着了。\n人性锚点回升至28\n反差体质失控度平稳维持72\n外婆治疗费缺口清零，后天三甲会诊有着落了。\n'
      + '人性锚点这几个字在她心里转了很久很久，终于在第3次深夜里被她自己说出口，像一块石头落了地。';
    expect(storyText(raw, opts)).toBe('她靠在你肩上睡着了。\n外婆治疗费缺口清零，后天三甲会诊有着落了。\n'
      + '人性锚点这几个字在她心里转了很久很久，终于在第3次深夜里被她自己说出口，像一块石头落了地。');
    // Without gauge names (no plot threads) nothing is read as a status line.
    expect(storyText('人性锚点回升至28', { dropBracketsAfterSystemLines: true })).toBe('人性锚点回升至28');
  });

  it('a short gauge name or a line that ends as a sentence is story, not a status line', () => {
    const short = { gaugeNames: new Set(['体力', '信任', '钱']) };
    expect(storyText('体力只剩下20%了，她咬牙往前走。', short)).toBe('体力只剩下20%了，她咬牙往前走。');
    expect(storyText('信任，她只剩下这一点了——3年。', short)).toBe('信任，她只剩下这一点了——3年。');
    expect(storyText('钱少了20', short)).toBe('钱少了20');
    expect(storyText('体力降至20', short)).toBe('');
    expect(storyText('外婆治疗费缺口缓解：先到账150万', opts)).toBe('');
  });

  it('memory blocks too, line by line, bullets included', () => {
    expect(storyLines('### 最近\n- 人性锚点微降至25，档案热度升至315\n- 她笑了。', opts)).toBe('### 最近\n- 她笑了。');
  });
});
