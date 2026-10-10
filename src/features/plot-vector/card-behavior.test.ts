import { describe, expect, it } from 'vitest';
import vectorRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { readCardBehavior, type CardBehavior } from './card-behavior';
import type { CardSpec, CardType } from './contract/types';

const spec = (onPass: string, type: CardType = 'item', growth?: CardSpec['growth']): CardSpec => ({ for: 'x', type, summary: '', onPass, ...(growth ? { growth } : {}) });
const pool = new Map((vectorRules.supply.cards as Array<{ id: string; onPass: string }>).map(c => [c.id, c.onPass]));
const supply = (id: string): CardBehavior => readCardBehavior(spec(pool.get(id)!));

describe('readCardBehavior — the PO save of 2026-10-09', () => {
  it('骚鸡贱畜 acts only going back: drag cleared, chances +4', () => {
    const b = readCardBehavior(spec("if (!ctx.back) return {};\nreturn { xDrag: 0, chance: 4 };", 'talent'));
    expect(b).toEqual({ complex: false, clauses: [{ when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 4 } }, { kind: 'clear', channel: 'drag' }] }] });
  });

  it('天命主角: chances below 3 → +12 and two more steps; otherwise chances +1', () => {
    const b = readCardBehavior(spec('if (ctx.chance < 3) return { chance: 12, steps: 2 };\nreturn { chance: 1 };', 'talent'));
    expect(b.complex).toBe(false);
    expect(b.clauses).toEqual([
      { when: [{ kind: 'below', on: 'chance', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 12 } }, { kind: 'steps', amount: { value: 2 } }] },
      { when: [{ kind: 'atLeast', on: 'chance', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 1 } }] },
    ]);
  });

  it('黑金狗项圈: with no drag relations +3 (+ growth); with drag all of it (up to 8) turns into relations', () => {
    const b = readCardBehavior(spec("if (ctx.drag <= 0) return { social: 3 };\nreturn { convert: { from: 'drag', to: 'social', amount: Math.min(ctx.drag, 8) } };", 'item',
      { on: 'trigger', every: 3, max: 10, add: { social: 0.5 } }), { level: 5 });
    expect(b.clauses).toEqual([
      { when: [{ kind: 'below', on: 'drag', value: 0 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 5.5, varies: 'level' } }] },
      { when: [{ kind: 'atLeast', on: 'drag', value: 0 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 2.5, varies: 'level' } }, { kind: 'convert', from: 'drag', to: 'social', share: 'all', cap: 8 }] },
    ]);
  });

  it('顶级魅力: relations multiplied, and drag up to 3 turned into relations (no drag: nothing to move, no condition)', () => {
    const b = readCardBehavior(spec("return { xSocial: 2, convert: { from: 'drag', to: 'social', amount: Math.min(ctx.drag, 3) } };", 'talent'));
    expect(b.clauses).toEqual([{ when: [], ops: [{ kind: 'scale', channel: 'social', factor: { value: 2 } }, { kind: 'convert', from: 'drag', to: 'social', share: 'all', cap: 3 }] }]);
  });

  it('镶钻细表带腕表: chances grow with its level', () => {
    const b = readCardBehavior(spec('return { chance: 2 + ctx.level };'), { level: 2 });
    expect(b.clauses).toEqual([{ when: [], ops: [{ kind: 'add', channel: 'chance', amount: { value: 4, varies: 'level' } }] }]);
  });

  it('an environment acts at departure: no direction or pass conditions', () => {
    expect(readCardBehavior(spec('return { xDrag: 2, xPush: 0.7 };', 'environment'), { departs: true }).clauses)
      .toEqual([{ when: [], ops: [{ kind: 'scale', channel: 'push', factor: { value: 0.7 } }, { kind: 'scale', channel: 'drag', factor: { value: 2 } }] }]);
    expect(readCardBehavior(spec('return { chance: 4, push: -3 };', 'environment'), { departs: true }).clauses)
      .toEqual([{ when: [], ops: [{ kind: 'add', channel: 'push', amount: { value: -3 } }, { kind: 'add', channel: 'chance', amount: { value: 4 } }] }]);
  });
});

describe('readCardBehavior — the pack supply pool', () => {
  it('reads every pool card without marking it complex', () => {
    for (const id of pool.keys()) expect(supply(id).complex, id).toBe(false);
  });
  it('first-pass cards', () => {
    expect(supply('supply:hello').clauses).toEqual([{ when: [{ kind: 'firstPass' }], ops: [{ kind: 'add', channel: 'social', amount: { value: 3 } }] }]);
    expect(supply('supply:second').clauses).toEqual([{ when: [{ kind: 'firstPass' }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 2 } }, { kind: 'turn' }] }]);
    expect(supply('supply:shortcut').clauses).toEqual([{ when: [{ kind: 'firstPass' }], ops: [{ kind: 'xSteps', factor: { value: 1.5 } }] }]);
  });
  it('going back', () => {
    expect(supply('supply:steady').clauses).toEqual([{ when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'push', amount: { value: 2 } }] }]);
  });
  it('a line on a quantity: relations ×1.5 from 3, +1 below', () => {
    expect(supply('supply:network').clauses).toEqual([
      { when: [{ kind: 'below', on: 'social', value: 3 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 1 } }] },
      { when: [{ kind: 'atLeast', on: 'social', value: 3 }], ops: [{ kind: 'scale', channel: 'social', factor: { value: 1.5 } }] },
    ]);
  });
  it('at random: chances +2 about half the time', () => {
    const b = supply('supply:gamble');
    expect(b.clauses).toHaveLength(1);
    expect(b.clauses[0].ops).toEqual([{ kind: 'add', channel: 'chance', amount: { value: 2 } }]);
    expect(b.clauses[0].when[0]).toMatchObject({ kind: 'chance' });
    const pct = (b.clauses[0].when[0] as { percent: number }).percent;
    expect(pct).toBeGreaterThanOrEqual(30);
    expect(pct).toBeLessThanOrEqual(70);
  });
  it('amounts that follow the pass, a clearing, a first-pass bonus', () => {
    expect(supply('supply:warmup').clauses).toEqual([{ when: [], ops: [{ kind: 'add', channel: 'push', amount: { value: 2, varies: 'pass' } }] }]);
    expect(supply('supply:clear').clauses).toEqual([{ when: [], ops: [{ kind: 'clear', channel: 'drag' }] }]);
    expect(supply('supply:tea').clauses).toEqual([{ when: [], ops: [{ kind: 'add', channel: 'push', amount: { value: 1, varies: 'pass' } }] }]);
  });
  it('store and release, relay, convert', () => {
    expect(supply('supply:pocket').clauses).toEqual([
      { when: [{ kind: 'below', on: 'stored', value: 3 }], ops: [{ kind: 'store', from: 'push', amount: { value: 1 } }] },
      { when: [{ kind: 'atLeast', on: 'stored', value: 3 }], ops: [{ kind: 'release' }] },
    ]);
    expect(supply('supply:chain').clauses).toEqual([{ when: [], ops: [{ kind: 'relay', ops: [], echo: true }] }]);
    expect(supply('supply:reframe').clauses).toEqual([{ when: [], ops: [{ kind: 'convert', from: 'drag', to: 'social', amount: { value: 1 } }] }]);
  });
});
