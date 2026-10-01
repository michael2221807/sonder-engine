/**
 * The words of the card detail (PO 2026-10-01): fixed templates from the real glossary, filled with engine data.
 * Every phrase kind and growth timing reads as a whole sentence in both languages, with no key or placeholder left.
 */
import { describe, expect, it } from 'vitest';
import zh from '@/ui/i18n/locales/zh-CN/mainGame.json';
import en from '@/ui/i18n/locales/en/mainGame.json';
import { CardWords, type Seg, type Translate } from './card-words';
import type { GrowthView, ReturnPhrase } from '@/features/plot-vector/card-describe';

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
    const [lean] = exact.effects([{ mark: 'up', strength: 2, exact: { push: 0.6, drag: -0.6 } }]);
    expect(lean).toMatchObject({ label: '往顺', strength: 2, num: '推力 +0.6 · 阻力 −0.6／次' });
    expect(lean.tip).toContain('亮两条');
    expect(plain.effects([{ mark: 'up', strength: 2, exact: { push: 0.6 } }])[0].num).toBeUndefined();
    expect(plain.faceTip([{ mark: 'up', strength: 1, exact: {} }, { mark: 'social', strength: 1, less: true, exact: {} }])).toBe('这张卡：↑ 往顺 · ◇ 人际变少');
  });
  it('this trip: what moved, what was stored or let out, a route change; nothing when it did not act', () => {
    const w = new CardWords(translator(zh), 'zh-CN', true);
    expect(w.trip({ activations: 0, shuttleChanges: {}, stored: 0, released: 0, otherEffects: [] })).toBeNull();
    const toks = w.trip({ activations: 2, shuttleChanges: { J: 1.6, Y: 0.4, 'S-': 0 }, stored: 1, released: 0, otherEffects: ['route'] })!;
    expect(toks.map(t => `${t.label}${t.num ?? ''}`)).toEqual(['机会+1.6', '人际+0.4', '存放+1', '改路线']);
  });
});
