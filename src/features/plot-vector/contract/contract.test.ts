import { describe, expect, it } from 'vitest';
import { compilePass, compiledPass, findForbiddenToken, runPass, seededRng } from './compile';
import { acts, applyRelay, readReturn, triggers, withGrowth } from './returns';
import { grow, growAtRound, growthCap, initialGrowth, readGrowth } from './growth';
import { checkCardSpec, readCardSpec, validateCard, SAMPLE_VALUES } from './validate';
import { burstOf, passCard } from './pass';
import type { CardSpec, PassValues } from './types';

const values = (over: Partial<PassValues> = {}): PassValues =>
  ({ push: 3, drag: 1, social: 2, chance: 4, pass: 1, step: 1, back: false, level: 0, stored: 0, ...over });
const spec = (onPass: string, over: Partial<CardSpec> = {}): CardSpec =>
  ({ for: '随身日记', type: 'item', summary: '一句话', onPass, ...over });
const run = (source: string, v: Partial<PassValues> = {}) => runPass(compilePass(source), values(v), 'seed');

describe('in-page execution (rebuild plan §4)', () => {
  it.each([
    ['while (true) {}', 'while'], ['for (;;) {}', 'for'], ['do;', 'do'], ['function f() {}', 'function'],
    ['const f = () => 1;', '=>'], ['return new Object();', 'new'], ['return this;', 'this'], ['return Math.random();', 'Math.random'],
    ["return 'x'.repeat(9);", '.repeat('], ["return 'x'.padStart(9);", '.padStart('], ['return Array(9);', 'Array'],
    ['return `x`;', '`'], ['return globalThis;', 'globalThis'], ['eval("1")', 'eval'], ['return x.__proto__;', '__proto__'],
  ])('refuses %s', (source, token) => {
    expect(findForbiddenToken(source)).toBe(token);
    expect(() => compilePass(source)).toThrow(token);
  });
  it('does not mistake names that merely contain a forbidden word', () => {
    expect(findForbiddenToken('const done = ctx.pass; const format = 1; return { push: done + format };')).toBeNull();
  });
  it('page globals read as undefined; Math has no random; Number and isFinite work', () => {
    expect(run('return typeof console + typeof navigator + typeof location + typeof alert + typeof parent;')).toEqual({ ok: true, value: 'undefinedundefinedundefinedundefinedundefined' });
    expect(run('return Math.min(ctx.push, 2) + Math.max(1, 2) + Number(isFinite(1));')).toEqual({ ok: true, value: 5 });
    expect(run('return Math["ran" + "dom"]();').ok).toBe(false);
  });
  it('assigning to an undeclared name fails the pass instead of leaking a global', () => {
    const out = run('leak = 1; return { push: 1 };');
    expect(out.ok).toBe(false);
    expect((globalThis as Record<string, unknown>).leak).toBeUndefined();
  });
  it('a body cannot break out of its wrapper', () => {
    expect(() => compilePass('return 1; }; globalThis.x = 1; {')).toThrow();
  });
  it('compiles each distinct body once and remembers a broken one', () => {
    const a = compiledPass('return { push: 1 };'), b = compiledPass('return { push: 1 };');
    expect('compiled' in a && 'compiled' in b && a.compiled === b.compiled).toBe(true);
    expect(compiledPass('return {')).toEqual({ error: expect.any(String) });
  });
  it('rng is fixed by its seed', () => {
    const a = seededRng('round-7:card'), b = seededRng('round-7:card'), c = seededRng('round-8:card');
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(c()).not.toBe(first[0]);
    expect(first.every(n => n >= 0 && n < 1)).toBe(true);
  });
});

describe('the domain: every value a card reads (§2.3)', () => {
  it('reads all nine values and rng()', () => {
    const out = run('return [ctx.push, ctx.drag, ctx.social, ctx.chance, ctx.pass, ctx.step, ctx.back, ctx.level, ctx.stored, typeof ctx.rng()];',
      { push: 1, drag: 2, social: 3, chance: 4, pass: 5, step: 6, back: true, level: 7, stored: 8 });
    expect(out).toEqual({ ok: true, value: [1, 2, 3, 4, 5, 6, true, 7, 8, 'number'] });
  });
  it('the values are read-only', () => {
    expect(run('ctx.push = 99; return ctx.push;').ok).toBe(false);
  });
});

describe('every return and its bounds (§2.4, §2.6)', () => {
  it('reads each operation', () => {
    expect(readReturn({ push: 1, drag: -2, social: 3, chance: 4, xPush: 1.5, xDrag: 0.5, xSocial: 2, xChance: 3,
      convert: { from: 'drag', to: 'chance', amount: 2 }, steps: 2, xSteps: 1.5, turn: 1,
      store: { from: 'push', amount: 3 }, release: true, relay: { xPush: 2, echo: 1 } })).toEqual({
      push: 1, drag: -2, social: 3, chance: 4, xPush: 1.5, xDrag: 0.5, xSocial: 2, xChance: 3,
      convert: { from: 'drag', to: 'chance', amount: 2 }, steps: 2, xSteps: 1.5, turn: true,
      store: { from: 'push', amount: 3 }, release: true, relay: { xPush: 2, echo: true } });
  });
  it('clamps every number to its safety bound', () => {
    expect(readReturn({ push: 999, drag: -999, xPush: 9, xDrag: -1, convert: { from: 'push', to: 'social', amount: 80 },
      steps: 20.9, xSteps: 9, store: { from: 'chance', amount: 99 } })).toEqual({ push: 50, drag: -50, xPush: 5, xDrag: 0,
      convert: { from: 'push', to: 'social', amount: 50 }, steps: 8, xSteps: 3, store: { from: 'chance', amount: 50 } });
    expect(readReturn({ steps: 3.7, xSteps: 1.2 })).toEqual({ steps: 3, xSteps: 1.2 });
    expect(readReturn({ steps: -4, xSteps: 0.2 })).toEqual({});
  });
  it('ignores what it cannot read: unknown keys, non-finite numbers, bad channels, a relay inside a relay', () => {
    expect(readReturn({ gold: 5, push: NaN, drag: Infinity, social: '3', turn: 0, release: 0.5,
      convert: { from: 'push', to: 'push', amount: 1 }, store: { from: 'luck', amount: 1 },
      relay: { relay: { push: 1 } } })).toEqual({});
  });
  it('a non-object return, or a throwing getter, means the card did not act', () => {
    expect(readReturn(undefined)).toEqual({});
    expect(readReturn(5)).toEqual({});
    expect(readReturn([1])).toEqual({});
    expect(readReturn({ get push() { throw new Error('boom'); }, chance: 1 })).toEqual({ chance: 1 });
  });
  it('triggering means doing something', () => {
    expect(triggers({})).toBe(false);
    expect(triggers(readReturn({ push: 0, xPush: 1, steps: 0, xSteps: 1 }))).toBe(false);
    expect(triggers(readReturn({ relay: { echo: 1 } }))).toBe(true);
    expect(acts({ turn: true })).toBe(true);
  });
});

describe('growth add over a triggered return (§2.5)', () => {
  it('amounts and steps add from 0, multipliers from 1, switches turn on at ≥ 1', () => {
    const add = { chance: 0.5, xPush: 0.1, steps: 0.5, turn: 0.5, release: 1 };
    expect(withGrowth({ chance: 1 }, add, 4)).toEqual({ chance: 3, xPush: 1.4, steps: 2, turn: true, release: true });
    expect(withGrowth({ chance: 1 }, add, 1)).toEqual({ chance: 1.5, xPush: 1.1, release: true });
  });
  it('can grow a convert, a store and a relay the card did not return, and stays bounded', () => {
    expect(withGrowth({ push: 1 }, { convert: { from: 'drag', to: 'chance', amount: 1 }, store: { from: 'push', amount: 2 }, relay: { xSocial: 0.5 } }, 3))
      .toEqual({ push: 1, convert: { from: 'drag', to: 'chance', amount: 3 }, store: { from: 'push', amount: 6 }, relay: { xSocial: 2.5 } });
    expect(withGrowth({ push: 40 }, { push: 5 }, 50)).toEqual({ push: 50 });
  });
  it('level 0 or no add changes nothing', () => {
    expect(withGrowth({ push: 1 }, { push: 5 }, 0)).toEqual({ push: 1 });
    expect(withGrowth({ push: 1 }, undefined, 9)).toEqual({ push: 1 });
  });
});

describe('relay: applied to the next triggering card (§2.4, I17)', () => {
  it('adds, multiplies and moves between what the target produces', () => {
    expect(applyRelay({ push: 4, social: 1 }, { push: 1, xSocial: 3 }).target).toEqual({ push: 5, social: 3 });
    expect(applyRelay({ drag: 6, chance: 1 }, { convert: { from: 'drag', to: 'chance', amount: 4 } }).target).toEqual({ drag: 2, chance: 5 });
    expect(applyRelay({ drag: 2 }, { convert: { from: 'drag', to: 'chance', amount: 9 } }).target).toEqual({ drag: 0, chance: 2 });
  });
  it('adds steps, multiplies the remaining-steps factor and adds a turn', () => {
    expect(applyRelay({ push: 1, xSteps: 1.5 }, { steps: 2, xSteps: 2, turn: true }).target).toEqual({ push: 1, steps: 2, xSteps: 3, turn: true });
  });
  it('store keeps part of the target output in the relaying card; release empties the relaying card now; echo repeats the target', () => {
    const out = applyRelay({ push: 5 }, { store: { from: 'push', amount: 3 }, release: true, echo: true });
    expect(out).toEqual({ target: { push: 2 }, echo: true, storeIntoRelayCard: { channel: 'push', amount: 3 }, releaseRelayCard: true });
    expect(applyRelay({ chance: 1 }, { store: { from: 'push', amount: 3 } }).storeIntoRelayCard).toBeUndefined();
  });
  it('the target stays within bounds after a relay', () => {
    expect(applyRelay({ push: 30 }, { xPush: 5 }).target).toEqual({ push: 50 });
  });
});

describe('the growth machine', () => {
  const diary = { on: 'trigger' as const, every: 3, max: 2 };
  it('levels up every `every` events of its own kind, up to max', () => {
    let state = initialGrowth(), gained = 0;
    for (let i = 0; i < 9; i++) { const next = grow(diary, state, 'trigger'); state = next.state; gained += next.gained; }
    expect(state).toEqual({ level: 2, progress: 0, pendingBursts: 0 });
    expect(gained).toBe(2);
    expect(grow(diary, initialGrowth(), 'round').gained).toBe(0);
  });
  it('the engine hard cap is 50 levels', () => {
    expect(growthCap({ on: 'trigger', every: 1, max: 999 })).toBe(50);
  });
  it('round growth counts every accepted round; placedRound only rounds on the board; their bursts wait for the next departure', () => {
    expect(growAtRound({ on: 'round', every: 1, max: 5 }, initialGrowth(), false)).toEqual({ level: 1, progress: 0, pendingBursts: 1 });
    expect(growAtRound({ on: 'placedRound', every: 1, max: 5 }, initialGrowth(), false)).toEqual(initialGrowth());
    expect(growAtRound({ on: 'placedRound', every: 2, max: 5 }, { level: 0, progress: 1, pendingBursts: 0 }, true)).toEqual({ level: 1, progress: 0, pendingBursts: 1 });
  });
  it('reads a damaged record as a fresh card', () => {
    expect(readGrowth({ level: -3, progress: 'x', pendingBursts: 1.5 })).toEqual(initialGrowth());
    expect(readGrowth({ level: 99, progress: 2, pendingBursts: 1 })).toEqual({ level: 50, progress: 2, pendingBursts: 1 });
  });
});

describe('the bind-time check (§5)', () => {
  it.each([
    [null, 'not an object'], [{ type: 'item', summary: 's', onPass: 'return {}' }, '"for"'],
    [{ for: 'x', type: 'money', summary: 's', onPass: 'return {}' }, '"type"'],
    [{ for: 'x', type: 'item', summary: '', onPass: 'return {}' }, '"summary"'],
    [{ for: 'x', type: 'item', summary: 's', onPass: '' }, '"onPass"'],
    [{ for: 'x', type: 'item', summary: 's', onPass: 'x'.repeat(1501) }, 'longer'],
    [{ for: 'x', type: 'item', summary: 's', onPass: 'return {}', growth: { on: 'daily', every: 1, max: 1 } }, '"growth"'],
  ])('refuses a malformed card %#', (raw, reason) => {
    const out = readCardSpec(raw);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain(reason);
  });
  it('reads a complete card, bounding growth max to 50', () => {
    expect(readCardSpec({ for: ' 药 ', type: 'status', summary: ' 一句 ', onPass: 'return {}', growth: { on: 'round', every: 1.7, max: 80, add: { drag: 1 } }, extra: 1 }))
      .toEqual({ ok: true, spec: { for: '药', type: 'status', summary: '一句', onPass: 'return {}', growth: { on: 'round', every: 1, max: 50, add: { drag: 1 } } } });
  });
  it('refuses code that does not compile or fails on every sample', () => {
    expect(checkCardSpec(spec('return {'))).toEqual({ ok: false, reason: expect.any(String) });
    expect(checkCardSpec(spec('while (1) {}'))).toEqual({ ok: false, reason: 'forbidden token: while' });
    expect(checkCardSpec(spec('return ctx.nothing.there;'))).toEqual({ ok: false, reason: expect.stringContaining('every sample') });
  });
  it('binds a card that fails only on some samples, or never fires on them (D7)', () => {
    expect(checkCardSpec(spec('if (ctx.level > 5) return ctx.nothing.there; return {};'))).toEqual({ ok: true });
    expect(checkCardSpec(spec('return ctx.pass > 99 ? { push: 1 } : {};'))).toEqual({ ok: true });
    expect(SAMPLE_VALUES).toHaveLength(6);
  });
  it('validateCard reads and checks together', () => {
    expect(validateCard({ for: '日记', type: 'item', summary: '记下一页', onPass: 'return { chance: 1 };' }).ok).toBe(true);
    expect(validateCard({ for: '日记', type: 'item', summary: '记下一页', onPass: 'return ctx.x.y;' }).ok).toBe(false);
  });
});

describe('one pass of one card', () => {
  it('a card that errors did not act, and says why', () => {
    expect(passCard(spec('return ctx.x.y;'), values(), 's')).toEqual({ ret: {}, triggered: false, error: expect.any(String) });
  });
  it('a card that chooses not to act is not an error, and growth does not make it act', () => {
    expect(passCard(spec('return {};', { growth: { on: 'trigger', every: 1, max: 5, add: { push: 1 } } }), values({ level: 3 }), 's'))
      .toEqual({ ret: {}, triggered: false });
  });
  it('growth adds only when the card triggers', () => {
    expect(passCard(spec('return { chance: 1 };', { growth: { on: 'trigger', every: 1, max: 5, add: { chance: 0.5 } } }), values({ level: 2 }), 's'))
      .toEqual({ ret: { chance: 2 }, triggered: true });
  });
  it('a burst reads like a return', () => {
    expect(burstOf(spec('return {};', { growth: { on: 'trigger', every: 3, max: 50, burst: { turn: 1 } } }))).toEqual({ turn: true });
    expect(burstOf(spec('return {};'))).toEqual({});
  });
});
