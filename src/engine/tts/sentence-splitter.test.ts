import { describe, it, expect } from 'vitest';
import { stripMarkersForSpeech, stripJudgementForSpeech, splitSentences, groupSentencesBySize } from '@/engine/tts/sentence-splitter';

describe('stripMarkersForSpeech', () => {
  it('returns empty for empty input', () => {
    expect(stripMarkersForSpeech('')).toBe('');
  });

  it('strips inline backticks (内心独白) but keeps content', () => {
    expect(stripMarkersForSpeech('他想着`这声音似曾相识`然后停住')).toContain('这声音似曾相识');
    expect(stripMarkersForSpeech('`内心`')).not.toContain('`');
  });

  it('removes 【环境】 category brackets but keeps content', () => {
    const out = stripMarkersForSpeech('【环境】暮色四合');
    expect(out).not.toContain('【');
    expect(out).not.toContain('】');
    expect(out).toContain('暮色四合');
    expect(out).toContain('环境');
  });

  it('strips markdown emphasis and headings', () => {
    expect(stripMarkersForSpeech('# 标题\n**加粗**文字')).toBe('标题\n加粗文字');
  });

  it('collapses markdown table pipes into pauses', () => {
    const out = stripMarkersForSpeech('| 名称 | 数值 |\n|---|---|\n| 力量 | 10 |');
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
  });

  it('removes code fences entirely', () => {
    expect(stripMarkersForSpeech('前```code```后').replace(/\s/g, '')).toBe('前后');
  });

  it('unwraps markdown links to their text', () => {
    expect(stripMarkersForSpeech('看[这里](http://x)吧')).toContain('这里');
    expect(stripMarkersForSpeech('看[这里](http://x)吧')).not.toContain('http');
  });
});

describe('stripJudgementForSpeech (判定不配音)', () => {
  it('returns empty for empty input', () => {
    expect(stripJudgementForSpeech('')).toBe('');
  });

  it('drops a full 〖…〗 judgement block, not just its brackets', () => {
    const out = stripJudgementForSpeech('他一跃而上。〖行动:成功,判定值:45,难度:35,基础:30,幸运:+8,环境:+5,状态:+2〗屋檐在脚下碎裂。');
    expect(out).not.toContain('判定值');
    expect(out).not.toContain('难度');
    expect(out).not.toContain('成功');
    expect(out).toContain('他一跃而上。');
    expect(out).toContain('屋檐在脚下碎裂。');
  });

  it('drops 〖系统提示…〗 status blocks too', () => {
    expect(stripJudgementForSpeech('〖系统提示：好感度变化〗她低下头。')).toBe('她低下头。');
  });

  it('drops every judgement block when several appear', () => {
    const out = stripJudgementForSpeech('〖探索:成功,判定值:45〗中间〖社交:失败,判定值:12〗结尾');
    expect(out).toBe('中间结尾');
  });

  it('drops <judge> thinking blocks', () => {
    const out = stripJudgementForSpeech('前<judge>基础30 幸运+8 → 成功</judge>后');
    expect(out).toBe('前后');
  });

  it('drops 【…】 blocks only when they are actually judgement/system syntax', () => {
    expect(stripJudgementForSpeech('【判定:成功,判定值:45】走了')).toBe('走了');
    expect(stripJudgementForSpeech('【行动:成功,判定值:45,难度:35】走了')).toBe('走了');
    expect(stripJudgementForSpeech('【系统提示：好感度变化】她低下头。')).toBe('她低下头。');
    // 叙事标签不受影响 —— 「判定」「难度」都是日常词,不能只看前缀/关键词
    expect(stripJudgementForSpeech('【环境】暮色四合')).toBe('【环境】暮色四合');
    expect(stripJudgementForSpeech('【任务】难度:高')).toBe('【任务】难度:高');
    expect(stripJudgementForSpeech('【判定日快到了，所有人都很紧张】')).toBe('【判定日快到了，所有人都很紧张】');
  });

  it('matches the display layer on an orphan 〖 followed by a real block', () => {
    // formatted-text-parser.findJudgementSlices 会把「孤立〖 → 最近的〗」整段吃掉,
    // 屏幕上看不到 orphan 文本 —— 朗读也必须一并跳过,否则"看不到却读得到"。
    const out = stripJudgementForSpeech('A〖走丢的开头 B〖行动:成功,判定值:10〗C');
    expect(out).toBe('AC');
  });

  it('does not swallow trailing narrative when 〖 is unclosed', () => {
    const out = stripJudgementForSpeech('他停住〖未闭合 然后继续走');
    expect(out).toContain('然后继续走');
    expect(out).not.toContain('〖');
  });
});

describe('stripMarkersForSpeech · 判定跳过接线', () => {
  it('never speaks judgement content through the main preprocessing entry', () => {
    const out = stripMarkersForSpeech('【环境】暮色四合。\n〖行动:成功,判定值:45,难度:35,基础:30,幸运:+8,环境:+5,状态:+2〗\n`他松了口气`。');
    expect(out).not.toContain('判定值');
    expect(out).not.toContain('难度');
    expect(out).not.toContain('〖');
    expect(out).not.toContain('〗');
    expect(out).toContain('暮色四合');
    expect(out).toContain('他松了口气');
  });

  it('yields empty text when the round is nothing but a judgement block', () => {
    // TtsService.speak() 对空文本早退,不会给 provider 发空请求。
    expect(stripMarkersForSpeech('〖行动:成功,判定值:45,难度:35〗')).toBe('');
  });

  it('leaves no orphan blank segment where the judgement line was', () => {
    const segments = splitSentences(stripMarkersForSpeech('他一跃而上。\n〖行动:成功,判定值:45〗\n屋檐碎裂。'));
    expect(segments.join('')).not.toContain('判定值');
    expect(segments.every((s) => /[\p{L}\p{N}]/u.test(s))).toBe(true);
  });
});

describe('splitSentences', () => {
  it('returns [] for empty / whitespace-only input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });

  it('splits on sentence-ending punctuation, keeping the punctuation', () => {
    const out = splitSentences('第一句话。第二句话！第三句话？');
    expect(out).toEqual(['第一句话。', '第二句话！', '第三句话？']);
  });

  it('treats newlines as sentence boundaries without emitting them', () => {
    const out = splitSentences('上一行\n下一行');
    expect(out).toEqual(['上一行', '下一行']);
  });

  it('merges too-short fragments into the previous segment', () => {
    // "好。" (2 chars, < MIN 4) should not stand alone.
    const out = splitSentences('这是完整的一句话。好。');
    expect(out.length).toBe(1);
    expect(out[0]).toContain('好');
  });

  it('folds trailing pure-punctuation into the previous segment', () => {
    const out = splitSentences('一段正文……');
    expect(out.length).toBe(1);
    expect(out[0]).toContain('正文');
  });

  it('secondary-splits an over-long sentence on soft breaks', () => {
    const long = '甲'.repeat(60) + '，' + '乙'.repeat(60) + '，' + '丙'.repeat(20) + '。';
    const out = splitSentences(long);
    // Each emitted segment must be bounded (no single 140-char blob).
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(100);
  });

  it('keeps a single short sentence as one segment', () => {
    expect(splitSentences('你好世界。')).toEqual(['你好世界。']);
  });
});

describe('groupSentencesBySize', () => {
  // 用固定长度的假句子直观验证算法(不依赖真实分句)。
  const sent = (len: number, tag = '甲') => tag.repeat(len);

  it('returns [] for empty input', () => {
    expect(groupSentencesBySize([], 120, 6)).toEqual([]);
  });

  it('用户例A：短句不足字数 → 继续攒句直到达标', () => {
    // 5 句各 40 字,目标 200 字 / 最多 6 句 → 攒到 200(5 句)成一段。
    const s = [sent(40, '甲'), sent(40, '乙'), sent(40, '丙'), sent(40, '丁'), sent(40, '戊')];
    const out = groupSentencesBySize(s, 200, 6);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(200);
  });

  it('用户例B：两长句就超字数 → 就断在两句(平衡断点保留)', () => {
    // 两句各 125 字,目标 200:250 比 125 更接近 200 → 保留 2 句成段。
    const s = [sent(125, '甲'), sent(125, '乙')];
    const out = groupSentencesBySize(s, 200, 6);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(250);
  });

  it('平衡断点：跨界句过长时,在其之前断,避免暴冲', () => {
    // 已攒 190(接近 200),下一句 150 → 含它=340 超 140,不含=190 差 10 → 断在之前。
    const s = [sent(100, '甲'), sent(90, '乙'), sent(150, '丙')];
    const out = groupSentencesBySize(s, 200, 6);
    // 第一段 = 甲+乙 = 190;丙 单独成段(150,自身不足一半? 150 >= 100 → 自成段)。
    expect(out[0].length).toBe(190);
    expect(out[1].length).toBe(150);
  });

  it('最多句数为硬上限：句数到顶即断,即使字数没到', () => {
    // 6 句各 10 字,目标 200 / 最多 3 句 → 每 3 句一段(30 字),共 2 段。
    const s = Array.from({ length: 6 }, (_, i) => sent(10, String(i)));
    const out = groupSentencesBySize(s, 200, 3);
    expect(out.length).toBe(2);
    expect(out.every((g) => g.length === 30)).toBe(true);
  });

  it('短尾合并：末尾残段过短 → 并进上一段', () => {
    // 目标 100:甲100 成段;乙5(残尾,<50)→ 并入上一段。
    const s = [sent(100, '甲'), sent(5, '乙')];
    const out = groupSentencesBySize(s, 100, 6);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(105);
  });

  it('短尾合并受最多句数约束：并入会超上限则残段自成一段', () => {
    // 目标 100 / 最多 2 句:甲60+乙60=120 成段(2 句到顶);丙5 残尾,
    // 但上一段已 2 句(=上限),并入会超 → 丙 自成一段。
    const s = [sent(60, '甲'), sent(60, '乙'), sent(5, '丙')];
    const out = groupSentencesBySize(s, 100, 2);
    expect(out.length).toBe(2);
    expect(out[1].length).toBe(5);
  });

  it('clamps out-of-range params defensively', () => {
    // maxSentences 0 → 夹到 1;targetChars 巨大 → 夹到上限但输入短 → 一段。
    const s = [sent(10, '甲'), sent(10, '乙')];
    const out = groupSentencesBySize(s, 5, 0);
    // maxSentences=1 → 每句一段。
    expect(out.length).toBe(2);
  });
});
