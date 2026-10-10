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
      { when: [{ kind: 'line', on: 'chance', cmp: '<', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 12 } }, { kind: 'steps', amount: { value: 2 } }] },
      { when: [{ kind: 'line', on: 'chance', cmp: '>=', value: 3 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 1 } }] },
    ]);
  });

  it('黑金狗项圈: with no drag relations +3 (+ growth); with drag all of it (up to 8) turns into relations', () => {
    const b = readCardBehavior(spec("if (ctx.drag <= 0) return { social: 3 };\nreturn { convert: { from: 'drag', to: 'social', amount: Math.min(ctx.drag, 8) } };", 'item',
      { on: 'trigger', every: 3, max: 10, add: { social: 0.5 } }), { level: 5 });
    expect(b.clauses).toEqual([
      { when: [{ kind: 'line', on: 'drag', cmp: '<=', value: 0 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 5.5, varies: 'level' } }] },
      { when: [{ kind: 'line', on: 'drag', cmp: '>', value: 0 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 2.5, varies: 'level' } }, { kind: 'convert', from: 'drag', to: 'social', share: 'all', cap: 8 }] },
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
    expect(supply('supply:hello').clauses).toEqual([{ when: [{ kind: 'line', on: 'pass', cmp: '<', value: 2 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 3 } }] }]);
    expect(supply('supply:second').clauses).toEqual([{ when: [{ kind: 'line', on: 'pass', cmp: '<', value: 2 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 2 } }, { kind: 'turn' }] }]);
    expect(supply('supply:shortcut').clauses).toEqual([{ when: [{ kind: 'line', on: 'pass', cmp: '<', value: 2 }], ops: [{ kind: 'xSteps', factor: { value: 1.5 } }] }]);
  });
  it('going back', () => {
    expect(supply('supply:steady').clauses).toEqual([{ when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'push', amount: { value: 2 } }] }]);
  });
  it('a line on a quantity: relations ×1.5 from 3, +1 below', () => {
    expect(supply('supply:network').clauses).toEqual([
      { when: [{ kind: 'line', on: 'social', cmp: '<', value: 3 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 1 } }] },
      { when: [{ kind: 'line', on: 'social', cmp: '>=', value: 3 }], ops: [{ kind: 'scale', channel: 'social', factor: { value: 1.5 } }] },
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
      { when: [{ kind: 'line', on: 'stored', cmp: '<', value: 3 }], ops: [{ kind: 'store', from: 'push', amount: { value: 1 } }] },
      { when: [{ kind: 'line', on: 'stored', cmp: '>=', value: 3 }], ops: [{ kind: 'release' }] },
    ]);
    expect(supply('supply:chain').clauses).toEqual([{ when: [], ops: [{ kind: 'relay', ops: [], echo: true }] }]);
    expect(supply('supply:reframe').clauses).toEqual([{ when: [], ops: [{ kind: 'convert', from: 'drag', to: 'social', amount: { value: 1 } }] }]);
  });
});

describe('readCardBehavior — edges the first reading got wrong (review 2026-10-09)', () => {
  const read = (onPass: string, opts?: { departs?: boolean; level?: number }) => readCardBehavior(spec(onPass), opts);
  const push1 = [{ kind: 'add', channel: 'push', amount: { value: 1 } }];
  it('a strict line on a whole number reads as its first whole value; on a quantity the side of the line is kept', () => {
    expect(read('if (ctx.step > 3) return { push: 1 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'step', cmp: '>=', value: 4 }], ops: push1 }]);
    expect(read('if (ctx.drag > 3) return { push: 1 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'drag', cmp: '>', value: 3 }], ops: push1 }]);
    expect(read('if (ctx.drag >= 3) return { push: 1 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'drag', cmp: '>=', value: 3 }], ops: push1 }]);
  });
  it('any line on the pass count, not only the first pass', () => {
    expect(read('if (ctx.pass >= 3) return { social: 2 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'pass', cmp: '>=', value: 3 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 2 } }] }]);
    expect(read('if (ctx.pass <= 2) return { social: 2 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'pass', cmp: '<', value: 3 }], ops: [{ kind: 'add', channel: 'social', amount: { value: 2 } }] }]);
  });
  it('a card idle at the plain values is read where it acts: both conditions of a conjunction, a line far out', () => {
    expect(read('if (ctx.back && ctx.push > 5) return { chance: 3 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'back' }, { kind: 'line', on: 'push', cmp: '>', value: 5 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 3 } }] }]);
    expect(read('if (ctx.push >= 40) return { chance: 3 };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'line', on: 'push', cmp: '>=', value: 40 }], ops: [{ kind: 'add', channel: 'chance', amount: { value: 3 } }] }]);
  });
  it('chance under a condition keeps the condition', () => {
    const b = read('if (ctx.back && ctx.rng() < 0.5) return { chance: 2 };\nreturn {};');
    expect(b.complex).toBe(false);
    expect(b.clauses).toHaveLength(1);
    expect(b.clauses[0].when[0]).toEqual({ kind: 'back' });
    expect(b.clauses[0].when[1]).toMatchObject({ kind: 'chance' });
  });
  it('the same kind of return in a different size or direction is told apart', () => {
    expect(read('return { push: ctx.back ? 3 : 1 };').clauses).toEqual([
      { when: [{ kind: 'forward' }], ops: push1 },
      { when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'push', amount: { value: 3 } }] },
    ]);
    expect(read('if (ctx.drag > 2) return { xPush: 2 };\nreturn { xPush: 0.5 };').clauses).toEqual([
      { when: [{ kind: 'line', on: 'drag', cmp: '<=', value: 2 }], ops: [{ kind: 'scale', channel: 'push', factor: { value: 0.5 } }] },
      { when: [{ kind: 'line', on: 'drag', cmp: '>', value: 2 }], ops: [{ kind: 'scale', channel: 'push', factor: { value: 2 } }] },
    ]);
  });
  it('an amount that follows a quantity inside a branch says so', () => {
    expect(read('if (ctx.back) return { push: ctx.social };\nreturn {};').clauses).toEqual([{ when: [{ kind: 'back' }], ops: [{ kind: 'add', channel: 'push', amount: { value: 2, varies: 'social' } }] }]);
  });
  it('an environment is read at level 0, as it runs', () => {
    expect(readCardBehavior(spec('return { chance: 1 + ctx.level };', 'environment'), { departs: true, level: 4 }).clauses)
      .toEqual([{ when: [], ops: [{ kind: 'add', channel: 'chance', amount: { value: 1, varies: 'level' } }] }]);
  });
  it('a card whose conditions the reading cannot hold is marked complex; a card that never acts says nothing', () => {
    expect(read('if ((ctx.push * 7 + ctx.drag * 3) % 5 < 1) return { chance: 1 };\nreturn { social: 1 };').complex).toBe(true);
    expect(read('return {};')).toEqual({ clauses: [], complex: true });
    // Review round 2: a condition hidden going out, and one inside a random card, are caught by the self-check.
    expect(read('if (!ctx.back && ctx.social === 25) return { chance: 1 };\nreturn { push: 1 };').complex).toBe(true);
    expect(read('if (ctx.rng() < 0.5) return { push: 2 };\nif (ctx.social === 25) return { chance: 1 };\nreturn { drag: 1 };').complex).toBe(true);
  });
  it('a card that acts only on a rare roll is read, not left blank (review round 3)', () => {
    const b = read('if (ctx.rng() < 0.05) return { push: 5 };\nreturn {};');
    expect(b.complex).toBe(false);
    expect(b.clauses).toEqual([{ when: [{ kind: 'chance', percent: 5 }], ops: [{ kind: 'add', channel: 'push', amount: { value: 5 } }] }]);
  });
  it('a rare random branch is still read (review round 3)', () => {
    const b = read('if (ctx.rng() < 0.05) return { push: 5 };\nreturn { drag: 1 };');
    expect(b.complex).toBe(false);
    const read2 = b.clauses.map(c => [(c.when[0] as { percent: number }).percent, c.ops]).sort((x, y) => (x[0] as number) - (y[0] as number));
    expect(read2).toEqual([[5, [{ kind: 'add', channel: 'push', amount: { value: 5 } }]], [95, [{ kind: 'add', channel: 'drag', amount: { value: 1 } }]]]);
  });
  it('a line between the hundredths is said at the decimals it needs', () => {
    expect(read('if (ctx.drag > 2.555) return { push: 1 };\nreturn {};').clauses[0].when).toEqual([{ kind: 'line', on: 'drag', cmp: '>', value: 2.555 }]);
    expect(read('if (ctx.drag >= 2.5) return { push: 1 };\nreturn {};').clauses[0].when).toEqual([{ kind: 'line', on: 'drag', cmp: '>=', value: 2.5 }]);
  });
});
