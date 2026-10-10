/**
 * Card growth for the table (PO 2026-10-01): growth from the spec and the engine's record — never from the
 * model's words. What a card does is read from its code (card-behavior.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { describeAdd, describeReturn, growthView } from './card-describe';
import { withGrowth } from './contract/returns';
import { codeMentions } from './contract/code-words';
import type { CardSpec } from './contract/types';

const card = (onPass: string, growth?: CardSpec['growth']): CardSpec => ({ for: 'x', type: 'item', summary: 's', onPass, ...(growth ? { growth } : {}) });

describe('growth in words', () => {
  it('an add says what one level adds: amounts, multipliers as their rise, switches from the level they turn on, steps', () => {
    expect(describeAdd({ chance: 1 })).toEqual([{ kind: 'amount', channel: 'chance', value: 1 }]);
    expect(describeAdd({ xSocial: 0.5, drag: -0.5 })).toEqual([
      { kind: 'amount', channel: 'drag', value: -0.5 }, { kind: 'factor', channel: 'social', value: 0.5 }]);
    expect(describeAdd({ steps: 1, xSteps: 0.25, turn: 1 })).toEqual([{ kind: 'steps', value: 1 }, { kind: 'xSteps', value: 0.25 }, { kind: 'turn', fromLevel: 1 }]);
    // Read unbounded, as the engine scales them: fractional and negative steps, a large rise, a switch from level 2.
    expect(describeAdd({ steps: 0.5, xPush: 5, turn: 0.5, release: 0.3 })).toEqual([
      { kind: 'factor', channel: 'push', value: 5 }, { kind: 'steps', value: 0.5 }, { kind: 'turn', fromLevel: 2 }, { kind: 'release', fromLevel: 4 }]);
    expect(describeAdd({ steps: -1 })).toEqual([{ kind: 'steps', value: -1 }]);
    expect(describeAdd({ turn: true, echo: 1 })).toEqual([]); // a `true` in an add and a top-level echo do nothing
    expect(describeAdd(undefined)).toEqual([]);
    expect(describeAdd({ nonsense: 3 })).toEqual([]);
  });
  it('a convert or store amount grows the card\'s own when its code returns one, else the add\'s; a relay add is said as a relay', () => {
    expect(describeAdd({ convert: { amount: 1 } }, 'return { convert: { from: "drag", to: "push", amount: 1 } };')).toEqual([{ kind: 'convert', amount: 1 }]);
    expect(describeAdd({ convert: { from: 'drag', to: 'chance', amount: 1 } }, 'return { push: 1 };')).toEqual([{ kind: 'convert', from: 'drag', to: 'chance', amount: 1 }]);
    // No channels of its own or in the add: the engine drops the convert, so the words say nothing of it.
    expect(describeAdd({ convert: { amount: 1 } }, 'return { push: 1 };')).toEqual([]);
    expect(describeAdd({ store: { from: 'push', amount: 2 } })).toEqual([{ kind: 'store', from: 'push', amount: 2 }]);
    expect(describeAdd({ store: { amount: -1 } })).toEqual([{ kind: 'other' }]);
    expect(describeAdd({ relay: { push: 1, echo: 0.5 } })).toEqual([{ kind: 'relay', parts: [{ kind: 'amount', channel: 'push', value: 1 }, { kind: 'echo', fromLevel: 2 }] }]);
  });
  it('says what the engine does: each phrase matches withGrowth at levels 1 to 3', () => {
    const adds: Array<Record<string, unknown>> = [
      { push: 1 }, { drag: -0.5 }, { xSocial: 0.5 }, { xChance: 5 }, { steps: 0.5 }, { steps: -1 }, { xSteps: 0.25 }, { turn: 0.5 }, { release: 0.3 },
      { convert: { from: 'drag', to: 'chance', amount: 1 } }, { store: { from: 'push', amount: 2 } },
    ];
    const base = { push: 1, steps: 3, xSocial: 1, xChance: 1, xSteps: 1.5 } as const;
    for (const add of adds) {
      const [phrase] = describeAdd(add, 'return {};');
      for (const level of [1, 2, 3]) {
        const engine = withGrowth(base, add, level) as Record<string, unknown>;
        switch (phrase.kind) {
          case 'amount': expect(engine[phrase.channel]).toBeCloseTo(((base as Record<string, number>)[phrase.channel] ?? 0) + phrase.value * level); break;
          case 'factor': {
            const key = { push: 'xPush', drag: 'xDrag', social: 'xSocial', chance: 'xChance' }[phrase.channel];
            expect(engine[key]).toBeCloseTo(Math.min(5, ((base as Record<string, number>)[key] ?? 1) + phrase.value * level));
            break;
          }
          case 'steps': expect(engine.steps ?? 0).toBe(Math.max(0, Math.min(8, Math.floor(base.steps + phrase.value * level)))); break;
          case 'xSteps': expect(engine.xSteps).toBeCloseTo(Math.min(3, base.xSteps + phrase.value * level)); break;
          case 'turn': case 'release': expect(!!engine[phrase.kind]).toBe(level >= phrase.fromLevel!); break;
          case 'convert': expect(engine.convert).toEqual({ from: 'drag', to: 'chance', amount: phrase.amount * level }); break;
          case 'store': expect(engine.store).toEqual({ from: 'push', amount: phrase.amount * level }); break;
          default: throw new Error(`no phrase for ${JSON.stringify(add)}`);
        }
      }
    }
  });
  it('a name in a comment or a text is not code; a quoted key is', () => {
    expect(codeMentions('// level up later\nreturn { push: 1 };', 'level')).toBe(false);
    expect(codeMentions('return { push: ctx.level };', 'level')).toBe(true);
    expect(codeMentions('const note = "relay"; return {};', 'relay')).toBe(false);
    expect(codeMentions('return { "relay": { echo: true } };', 'relay')).toBe(true);
    expect(codeMentions('const k = ctx.back ? "level" : "x"; return {};', 'level')).toBe(false);
    expect(codeMentions('switch (x) { case "relay": return {}; }', 'relay')).toBe(false);
  });
  it('a switch that would turn on only beyond the highest level is not said', () => {
    const spec = card('return { push: 1 };', { on: 'trigger', every: 1, max: 5, add: { turn: 0.1, relay: { echo: 0.1, push: 1 } } });
    expect(growthView(spec, undefined)?.add).toEqual([{ kind: 'relay', parts: [{ kind: 'amount', channel: 'push', value: 1 }] }]);
  });
  it('every one of the fifteen return fields has its phrase', () => {
    expect(describeReturn({
      push: 1, drag: -1, social: 2, chance: 3, xPush: 2, xDrag: 0.5, xSocial: 1.5, xChance: 3,
      convert: { from: 'drag', to: 'push', amount: 1 }, steps: 2, xSteps: 1.5, turn: true, store: { from: 'social', amount: 1 }, release: true,
      relay: { echo: true, chance: 1 },
    })).toEqual([
      { kind: 'amount', channel: 'push', value: 1 }, { kind: 'factor', channel: 'push', value: 2 },
      { kind: 'amount', channel: 'drag', value: -1 }, { kind: 'factor', channel: 'drag', value: 0.5 },
      { kind: 'amount', channel: 'social', value: 2 }, { kind: 'factor', channel: 'social', value: 1.5 },
      { kind: 'amount', channel: 'chance', value: 3 }, { kind: 'factor', channel: 'chance', value: 3 },
      { kind: 'convert', from: 'drag', to: 'push', amount: 1 }, { kind: 'steps', value: 2 }, { kind: 'xSteps', value: 1.5 }, { kind: 'turn' },
      { kind: 'store', from: 'social', amount: 1 }, { kind: 'release' },
      { kind: 'relay', parts: [{ kind: 'amount', channel: 'chance', value: 1 }, { kind: 'echo' }] },
    ]);
  });
  it('a burst is said as the engine carries it out, bounded', () => {
    expect(describeReturn({ chance: 2, xPush: 1.5 })).toEqual([
      { kind: 'factor', channel: 'push', value: 1.5 }, { kind: 'amount', channel: 'chance', value: 2 }]);
    expect(describeReturn({ push: 999 })).toEqual([{ kind: 'amount', channel: 'push', value: 50 }]);
    expect(describeReturn({ relay: { echo: true } })).toEqual([{ kind: 'relay', parts: [{ kind: 'echo' }] }]);
    expect(describeReturn(undefined)).toEqual([]);
  });
  it('the view: level, what is left to the next, and whether the rule reads its level', () => {
    const spec = card('return { push: 1 + ctx.level };', { on: 'trigger', every: 3, max: 5, add: { social: 1 }, burst: { chance: 2 } });
    expect(growthView(spec, { level: 2, progress: 1, pendingBursts: 0 })).toEqual({
      on: 'trigger', every: 3, max: 5, level: 2, progress: 1, toNext: 2,
      add: [{ kind: 'amount', channel: 'social', value: 1 }], burst: [{ kind: 'amount', channel: 'chance', value: 2 }], readsLevel: true,
    });
    expect(growthView(spec, { level: 5, progress: 2, pendingBursts: 0 })).toMatchObject({ level: 5, progress: 0, toNext: 0 });
    expect(growthView(spec, undefined)).toMatchObject({ level: 0, progress: 0, toNext: 3 });
    expect(growthView(card('return { push: 1 };', { on: 'round', every: 2, max: 3 }), undefined)).toMatchObject({ on: 'round', readsLevel: false, add: [], burst: [] });
    expect(growthView(card('return { push: 1 };', { on: 'placedRound', every: 1, max: 99 }), { level: 0, progress: 0, pendingBursts: 0 })).toMatchObject({ on: 'placedRound', max: 50 });
    expect(growthView(card('return { push: 1 };'), undefined)).toBeUndefined();
  });
});
