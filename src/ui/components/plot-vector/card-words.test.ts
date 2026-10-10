/**
 * The words of the card detail (PO 2026-10-01): fixed templates from the real glossary, filled with engine data.
 * Every phrase kind and growth timing reads as a whole sentence in both languages, with no key or placeholder left.
 */
import { describe, expect, it } from 'vitest';
import zh from '@/ui/i18n/locales/zh-CN/mainGame.json';
import en from '@/ui/i18n/locales/en/mainGame.json';
import { CardWords, type Seg, type Translate } from './card-words';
import type { GrowthView, ReturnPhrase } from '@/features/plot-vector/card-describe';
import type { CardBehavior } from '@/features/plot-vector/card-behavior';

const translator = (messages: Record<string, string>): Translate => (key, params = {}) => {
  const message = messages[key];
  if (message === undefined) throw new Error(`missing key ${key}`);
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
};
const read = (segs: Seg[]) => segs.map(s => ('text' in s ? s.text : `[${s.tok.label}${s.tok.num ? ` ${s.tok.num}` : ''}]`)).join('');
const ALL: ReturnPhrase[] = [
  { kind: 'amount', channel: 'push', value: 1 }, { kind: 'amount', channel: 'drag', value: -0.5 },
  { kind: 'factor', channel: 'social', value: 0.5 }, { kind: 'factor', channel: 'chance', value: -0.25 },
  { kind: 'convert', from: 'drag', to: 'chance', amount: 1 }, { kind: 'convert', amount: 1 },
  { kind: 'steps', value: 1 }, { kind: 'xSteps', value: 0.5 }, { kind: 'turn' }, { kind: 'store', from: 'push', amount: 2 },
  { kind: 'release' }, { kind: 'echo' }, { kind: 'relay', parts: [{ kind: 'amount', channel: 'social', value: 1 }, { kind: 'echo' }] },
];
const growth = (over: Partial<GrowthView> = {}): GrowthView =>
  ({ on: 'trigger', every: 3, max: 20, level: 2, progress: 1, toNext: 2, add: [], burst: [], readsLevel: false, ...over });

describe('card words', () => {
  for (const [name, messages] of [['zh', zh], ['en', en]] as const) {
    const words = new CardWords(translator(messages), name === 'zh' ? 'zh-CN' : 'en', true);
    it(`${name}: every phrase kind, per level and once, is whole words with its bubbles`, () => {
      for (const mode of ['add', 'once'] as const) for (const phrase of ALL) {
        const segs = words.phrase(phrase, mode, 2);
        const text = read(segs);
        expect(text).not.toMatch(/\{|\u0001|mainGame\./);
        expect(segs.some(s => 'tok' in s)).toBe(true);
        for (const s of segs) if ('tok' in s) { expect(s.tok.label).toBeTruthy(); expect(s.tok.tip).toBeTruthy(); }
      }
    });
    it(`${name}: the three growth timings, a burst, the level read in the rule, and growth that changes nothing`, () => {
      for (const on of ['trigger', 'round', 'placedRound'] as const) {
        const text = read(words.growth(growth({ on, add: [ALL[0]], burst: [{ kind: 'amount', channel: 'chance', value: 1 }] })));
        expect(text).not.toMatch(/\{|\u0001|mainGame\./);
      }
      expect(read(words.growth(growth({ readsLevel: true })))).toBe(messages['mainGame.vectorTable.grow.when.trigger'].replace('{n}', '3').replace('{max}', '20')
        + messages['mainGame.vectorTable.grow.readsLevel']);
      expect(read(words.growth(growth()))).toContain(messages['mainGame.vectorTable.grow.nothing']);
      expect(words.level(growth())).toMatchObject({ fill: 1 / 3 });
      expect(words.level(growth({ level: 20, toNext: 0, progress: 0 })).fill).toBe(1);
    });
  }
  it('zh reads as the demo said: one sentence, numbers in the bubbles only with exact numbers', () => {
    const exact = new CardWords(translator(zh), 'zh-CN', true), plain = new CardWords(translator(zh), 'zh-CN', false);
    const g = growth({ on: 'placedRound', every: 2, add: [{ kind: 'amount', channel: 'social', value: 0.1 }], burst: [{ kind: 'amount', channel: 'chance', value: 1 }] });
    expect(read(plain.growth(g))).toBe('在棋盘上每待满 2 回合升一级，最多 20 级。每升一级，它每次起作用时[人际]再多一点；每次升级后，下一趟[出发时]还会额外送一点[机会]。');
    expect(read(exact.growth(g))).toBe('在棋盘上每待满 2 回合升一级，最多 20 级。每升一级，它每次起作用时[人际 +0.1／级]再多一点；每次升级后，下一趟[出发时]还会额外送一点[机会 +1]。');
  });
  it('says what a card does (PO 2026-10-09): push and drag apart, an add and a multiplier apart, conditions in front', () => {
    const exact = new CardWords(translator(zh), 'zh-CN', true), plain = new CardWords(translator(zh), 'zh-CN', false);
    // 骚鸡贱畜: only going back, drag cleared, chances +4.
    const back: CardBehavior = { complex: false, clauses: [{ when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 4 } }, { kind: 'clear', channel: 'drag' }] }] };
    expect(plain.face(back)).toEqual([{ when: ['返程'], chips: [
      { text: '✦+', color: 'var(--ch-chance)', frame: 'fill' }, { text: '↓0', color: 'var(--ch-drag)', frame: 'line' }] }]);
    expect(exact.face(back)[0].chips.map(c => c.text)).toEqual(['✦+4', '↓0']);
    expect(plain.faceTip(back)).toBe('返程时：机会增加、阻力清零');
    // 天命主角: two cases, a line on chances.
    const fate: CardBehavior = { complex: false, clauses: [
      { when: [{ kind: 'line', on: 'chance', cmp: '<', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 12 } }, { kind: 'steps', amount: { value: 2 } }] },
      { when: [{ kind: 'line', on: 'chance', cmp: '>=', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 1 } }] }] };
    expect(plain.face(fate).map(r => `${r.when.join('')} ${r.chips.map(c => c.text).join(' ')}`)).toEqual(['✦<3 ✦+ +步', '✦≥3 ✦+']);
    expect(plain.faceTip(fate)).toBe('梭上机会低于 3 时：机会增加、多走几步；梭上机会达到 3 时：机会增加');
    // A multiplier reads × or ÷; a move is an arrow; less drag is told it cannot become going well.
    const mixed: CardBehavior = { complex: false, clauses: [{ when: [], ops: [
      { kind: 'scale', channel: 'social', factor: { value: 2 } }, { kind: 'scale', channel: 'push', factor: { value: 0.7 } },
      { kind: 'convert', from: 'drag', to: 'social', share: 'all', cap: 3 }, { kind: 'add', channel: 'drag', amount: { value: -1 } }] }] };
    expect(plain.face(mixed)[0].chips.map(c => c.text)).toEqual(['◇×', '↑÷', '↓→◇', '↓−']);
    expect(exact.face(mixed)[0].chips.map(c => c.text)).toEqual(['◇×2', '↑×0.7', '↓→◇≤3', '↓−1']);
    const [detail] = exact.clauses(mixed);
    expect(detail.when).toBe('');
    expect(detail.toks.map(t => `${t.label}${t.num ? ` ${t.num}` : ''}`)).toEqual(['人际放大 ×2', '推力打折 ×0.7', '阻力转成人际 全部 · 每次最多 3', '阻力减少 −1']);
    expect(detail.toks[3].tip).toContain('不会变成「顺」');
    expect(plain.clauses(mixed)[0].toks.every(t => t.num === undefined)).toBe(true);
    // An amount that moves with the trip is told as approximate; one that grows with the level is exact.
    const moving: CardBehavior = { complex: false, clauses: [{ when: [], ops: [{ kind: 'add', channel: 'push', amount: { value: 2, varies: 'pass' } }, { kind: 'add', channel: 'chance', amount: { value: 4, varies: 'level' } }] }] };
    expect(exact.face(moving)[0].chips.map(c => c.text)).toEqual(['↑+~2', '✦+4']);
    expect(exact.clauses(moving)[0].toks[0].tip).toContain('随经过次数变化');
  });
  it('says each side of a line exactly: < ≤ ≥ >, none and some, passes and steps, in both languages', () => {
    const zhW = new CardWords(translator(zh), 'zh-CN', false), enW = new CardWords(translator(en), 'en', false);
    const line = (on: 'drag' | 'stored' | 'pass' | 'step', cmp: '<' | '<=' | '>=' | '>', value: number) => ({ kind: 'line', on, cmp, value }) as const;
    const cases = [line('drag', '<', 3), line('drag', '<=', 3), line('drag', '>=', 3), line('drag', '>', 3), line('drag', '<=', 0), line('drag', '>', 0),
      line('stored', '<', 2), line('stored', '<=', 2), line('stored', '>=', 2), line('stored', '>', 2),
      line('pass', '<', 2), line('pass', '>=', 2), line('pass', '<', 4), line('pass', '>=', 3), line('step', '<', 4), line('step', '>=', 4)];
    expect(cases.map(c => zhW.condition(c, false))).toEqual(['↓<3', '↓≤3', '↓≥3', '↓>3', '无↓', '有↓', '存<2', '存≤2', '存≥2', '存>2', '首次', '之后', '前3次', '第3次起', '4步前', '4步起']);
    expect(cases.map(c => zhW.condition(c, true))).toEqual(['梭上阻力低于 3 时', '梭上阻力不超过 3 时', '梭上阻力达到 3 时', '梭上阻力超过 3 时', '梭上没有阻力时', '梭上有阻力时',
      '存量不到 2 时', '存量不超过 2 时', '存量达到 2 时', '存量超过 2 时', '第一次经过时', '之后每次经过', '前 3 次经过时', '第 3 次经过起', '这一趟第 4 步之前', '这一趟第 4 步起']);
    for (const c of cases) for (const long of [false, true]) expect(enW.condition(c, long)).not.toMatch(/\{|mainGame\./);
    // Steps are words in each language.
    const steps: CardBehavior = { complex: false, clauses: [{ when: [], ops: [{ kind: 'steps', amount: { value: 2 } }, { kind: 'xSteps', factor: { value: 1.5 } }] }] };
    expect(zhW.face(steps)[0].chips.map(c => c.text)).toEqual(['+步', '步×']);
    expect(enW.face(steps)[0].chips.map(c => c.text)).toEqual(['+ steps', 'steps×']);
  });
  it('this trip: what moved, what was stored or let out, a route change; nothing when it did not act', () => {
    const w = new CardWords(translator(zh), 'zh-CN', true);
    expect(w.trip({ activations: 0, shuttleChanges: {}, stored: 0, released: 0, otherEffects: [] })).toBeNull();
    const toks = w.trip({ activations: 2, shuttleChanges: { J: 1.6, Y: 0.4, 'S-': 0 }, stored: 1, released: 0, otherEffects: ['route'] })!;
    expect(toks.map(t => `${t.label}${t.num ?? ''}`)).toEqual(['机会+1.6', '人际+0.4', '存放+1', '改路线']);
  });
});
