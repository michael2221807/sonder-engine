/**
 * Release check for in-page card code (P5, docs/design/plot-vector-rebuild-plan.md §13.3). A card body is code
 * written by a model — or carried in a save, a backup or a game card from someone else — and it runs in the page
 * that holds the player's API keys and sync token. It must never reach the page (globals, storage, network, DOM,
 * the page's built-ins and prototypes) and must never hold the page (no unbounded work or memory).
 * Every attempt below is refused when the body compiles, or runs without reaching anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compilePass, compiledPass, runPass } from './compile';
import type { PassValues } from './types';

const values: PassValues = { push: 1, drag: 2, social: 3, chance: 4, pass: 1, step: 1, back: false, level: 0, stored: 0 };
const refused = (body: string) => expect(() => compilePass(body), body).toThrow();
const run = (body: string) => runPass(compilePass(body), values, 'seed');

// Things only the page should hold: a stand-in key, a stand-in token in storage, a global a body might try to call.
const g = globalThis as Record<string, unknown>;
beforeEach(() => { g.agaApiKey = 'sk-secret'; g.sendHome = () => { throw new Error('page function called'); }; });
afterEach(() => { delete g.agaApiKey; delete g.sendHome; });

describe('a body cannot reach the page', () => {
  it('refuses every way to the page\'s Function and constructors', () => {
    for (const body of [
      'return ctx.constructor;',
      'return ctx.rng.constructor;',
      'return Math.abs.constructor;',
      'return ({}).constructor;',
      'return (1).constructor;',
      'return 1..constructor;',
      'return ctx?.constructor;',
      'return ctx . constructor;',
      'return ctx\n.constructor;',
      'return ctx.con/**/structor;',
      "const k = 'constr' + 'uctor'; return ctx[k];",
      'return ctx["constructor"];',
      'return \\u0063onstructor;',
      'return ctx.\\u0063onstructor;',
      'return ctx.\\x63onstructor;',
      'return ctx.соnstructor;',            // Cyrillic о: another name, not on the list of members
      'const { constructor } = ctx; return constructor;',
      'const { push: p, ...rest } = ctx; return rest;',
      'return Function;',
      "return Function('return 1')();",
      "return eval('1');",
      'return new Error();',
      'return Reflect;', 'return Proxy;', 'return Symbol;', 'return WebAssembly;',
    ]) refused(body);
  });
  it('refuses functions in any form: they could recurse, run later or be handed out', () => {
    for (const body of [
      'return (() => 1)();',
      'return function () {};',
      'function f() {} return 1;',
      'return { a() { return 1; } };',
      "return { 'a'() { return 1; } };",
      'return { 1() { return 1; } };',
      'return { get x() { return 1; } };',
      "return { get 'x'() { return 1; } };",
      'return { set x(v) {} };',
      'return { async a() {} };',
      'return { *a() {} };',
      'class A {} return 1;',
      'return async function () {};',
    ]) refused(body);
  });
  it('refuses loops, so every body ends', () => {
    for (const body of ['while (true) {}', 'for (;;) {}', 'do {} while (true);', 'for (const k in ctx) {}', 'for (const k of ctx) {}', 'x: while (true) { continue x; }'])
      refused(body);
  });
  it('refuses calling what is not a Math or Number function, isFinite, isNaN or ctx.rng', () => {
    for (const body of [
      'return sendHome();', 'return queueMicrotask(1);', 'return requestAnimationFrame(1);', 'return postMessage(1);',
      'return Math.abs.call(null, -1);', 'return Math.abs.apply(null, [-1]);', 'return Math.abs.bind(null);',
      'return (0, Math.abs)(-1);', 'return Math.abs?.(-1);', 'return ctx.push.toString();',
      'return (ctx.rng)();', 'try { return 1; } catch (e) { return e; }', 'switch (ctx.pass) { case 1: return {}; }',
    ]) refused(body);
  });
  it('refuses every way to text that runs: templates, regular expressions, escapes, HTML comments', () => {
    for (const body of [
      'return `${1}`;', 'return String.raw`x`;', 'return /x/;', "return 'a'.replace(/a/, 'b');", "return '\\x41';",
      '<!-- x\nreturn 1;', 'return 1; --> x', 'return 1 <!-- 2;',
    ]) refused(body);
  });
  it('refuses the page\'s globals by name, and any other name reads as undefined', () => {
    for (const name of ['globalThis', 'window', 'self', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch',
      'XMLHttpRequest', 'Worker', 'import', 'require', 'process', 'crypto', 'performance', 'setTimeout', 'setInterval',
      'Date', 'JSON', 'Object', 'Array', 'String', 'Promise', 'this', 'arguments'])
      refused(`return ${name};`);
    for (const name of ['top', 'parent', 'frames', 'opener', 'location', 'navigator', 'name', 'origin', 'agaApiKey', 'sendHome', 'caches', 'cookieStore'])
      expect(run(`return ${name};`), name).toEqual({ ok: true, value: undefined });
    expect(run('return typeof agaApiKey;')).toEqual({ ok: true, value: 'undefined' });
  });
  it('cannot create, change or delete a page global, and cannot change what it is given', () => {
    expect(run('agaApiKey = 1; return 1;').ok).toBe(false);
    expect(g.agaApiKey).toBe('sk-secret');
    expect(run('leaked = 1; return 1;').ok).toBe(false);
    expect('leaked' in g).toBe(false);
    expect(run('ctx.push = 99; return 1;').ok).toBe(false);
    expect(run('Math.abs = 1; return 1;').ok).toBe(false);
    expect(run('delete Math.abs; return 1;').ok).toBe(false);
    expect(run('return Math.abs(-2);')).toEqual({ ok: true, value: 2 });
  });
  it('cannot reach or pollute the page\'s prototypes', () => {
    for (const body of ['return ({}).__proto__;', "return { __proto__: null };", 'return ({}).__defineGetter__;', 'return Object.prototype;'])
      refused(body);
    const before = Object.getOwnPropertyNames(Object.prototype).join();
    for (const body of ['const o = {}; o.push = 1; return o;', 'return { push: ctx.push, drag: 2 };', 'return { push: 1, drag: 2 };']) expect(run(body).ok).toBe(true);
    expect(Object.getOwnPropertyNames(Object.prototype).join()).toBe(before);
  });
  it("a value it throws is reported as fixed text: an error's message or a channel name, never a function's source", () => {
    const other = 'the card threw something that is not an error';
    expect(run('throw { toString: Math.abs };')).toEqual({ ok: false, error: other });
    expect(run('throw { message: 1 };')).toEqual({ ok: false, error: other });
    expect(run('throw ctx.rng;')).toEqual({ ok: false, error: other });
    expect(run('throw Math.abs;')).toEqual({ ok: false, error: other });
    expect(run("throw 'drag';")).toEqual({ ok: false, error: 'drag' });
    expect(run("throw ctx.rng + 'drag';")).toEqual({ ok: false, error: other });
    expect(run("throw Math.abs + 'push';")).toEqual({ ok: false, error: other });
    expect(run('ctx.push = 1;')).toMatchObject({ ok: false, error: expect.stringContaining('read only') });
  });
  it('a method named like a keyword that is not an expression keyword is refused', () => {
    for (const body of ['return { of() {} };', 'return { case() {} };', 'return { *of() {} };']) refused(body);
  });
  it('a method named like an expression keyword can be written but never runs: nothing can call it', () => {
    // `.if` is not a member (refused), and turning an object into a value only looks up valueOf/toString.
    refused('const o = { if() { return 1; } }; return o.if();');
    // Turned into a number, the object reads as NaN: valueOf and toString are Object's own, the methods never run.
    const out = run("const o = { if() { throw 'push'; }, typeof() { throw 'drag'; } }; return { push: isNaN(o * 1) ? 1 : 0 };");
    expect(out).toEqual({ ok: true, value: { push: 1 } });
  });
});

describe('a body cannot hold the page', () => {
  it('text is only a channel name: anything else is refused', () => {
    for (const body of ["return 'x';", "return { convert: { from: 'pushpush', to: 'drag', amount: 1 } };", "return '';", "return 'constructor';"]) refused(body);
    expect(run("return { convert: { from: 'drag', to: \"push\", amount: 1 } };").ok).toBe(true);
  });
  it('a body that doubles text again and again is refused before it runs (it would take the page\'s memory)', () => {
    const bomb = ["let x = 'push';", ...Array.from({ length: 30 }, () => 'x = x + x;'), 'return Math.abs(x);'].join('\n');
    refused(bomb);
    const constBomb = ["const a0 = 'drag';", ...Array.from({ length: 30 }, (_, i) => `const a${i + 1} = a${i} + a${i};`), `return a30 < 'push';`].join('\n');
    refused(constBomb);
  });
  it('ordinary arithmetic keeps its room: up to 16 plus signs', () => {
    const sixteen = `return { push: ${Array.from({ length: 17 }, () => '1').join(' + ')} };`;
    expect(compiledPass(sixteen)).toHaveProperty('compiled');
    refused(`return { push: ${Array.from({ length: 18 }, () => '1').join(' + ')} };`);
    // The most a body can then build stays small, and comparing or converting it takes no time.
    const largest = ["let x = 'social' + (-1.7976931348623157e308);", ...Array.from({ length: 15 }, () => 'x = x + x;'), 'return { push: x < \'push\' ? 1 : 0 };'].join('\n');
    const started = performance.now();
    expect(run(largest).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
  it('BigInt in any spelling is refused: one short body could compute for minutes or exhaust memory', () => {
    for (const body of [
      'const a = 3n ** 300000000n; return 1;', 'return { push: 1n };', 'const a = 0x1n << 0x2FAF080n; return 1;',
      'const a = 0b1n; return 1;', 'const a = 0o7n; return 1;', 'const a = 1_0n; return 1;', 'return 1n;',
      'const a = 7n ** 400000000n; return 1;', 'let x = 3n ** 1000n; x = x * x; return 1;', 'return 1in ctx;',
      'const a = 0x1_n; return 1;', 'const a = 1_n; return 1;', 'const a = 0n; return 1;', 'const a = .5n; return 1;',
      'const a = 1e3n; return 1;', 'const a = 0xFFn; return 1;', 'const a = 1\u200dn; return 1;', 'return typeof 5n;',
    ]) refused(body);
    expect(run('return { push: 2 ** 10, drag: 1 << 3 };')).toEqual({ ok: true, value: { push: 1024, drag: 8 } });
  });
  it('spread is refused: it would turn every character of a text into a property', () => {
    for (const body of [
      ["let x = 'social';", ...Array.from({ length: 15 }, () => 'x = x + x;'), 'const o = { ...x }; return 1;'].join('\n'),
      'return { ...ctx, push: 2 };', 'return Math.max(...ctx);', "return Math.hypot(...'push');",
    ]) refused(body);
  });
  it('a body longer than the card limit is refused by the compiler itself', () => {
    refused(`return { push: 1 };${' '.repeat(1500)}`);
  });
  it('a pass that runs long switches its card off for the session (in-page code cannot be interrupted)', () => {
    const slow = (() => { const end = performance.now() + 300; while (performance.now() < end) { /* busy */ } return { push: 1 }; }) as never;
    expect(runPass(slow, values, 's')).toEqual({ ok: true, value: { push: 1 } });
    expect(runPass(slow, values, 's')).toMatchObject({ ok: false, error: expect.stringContaining('switched off') });
    const quick = (() => ({ push: 1 })) as never;
    expect(runPass(quick, values, 's')).toEqual({ ok: true, value: { push: 1 } });
  });
  it('the longest text a body can build, even from a stand-in\'s source, costs milliseconds whatever it does with it', () => {
    const build = ["let x = ctx.rng + 'social';", ...Array.from({ length: 15 }, () => 'x = x + x;')];
    for (const tail of ["return { push: x < 'push' ? 1 : 0 };", 'return { push: x in ctx ? 1 : 0 };', 'return { push: Math.abs(x) };',
      "return { push: isNaN(x) ? 1 : 0, convert: { from: x, to: x, amount: 1 } };", 'throw x;']) {
      const started = performance.now();
      run([...build, tail].join('\n'));
      expect(performance.now() - started, tail).toBeLessThan(250);
    }
  });
  it('what a failing body reports is short, so it cannot fill the save', () => {
    const body = ["let x = 'chance';", ...Array.from({ length: 15 }, () => 'x = x + x;'), 'throw x;'].join('\n');
    const out = run(body);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.length).toBeLessThanOrEqual(300);
  });
});
