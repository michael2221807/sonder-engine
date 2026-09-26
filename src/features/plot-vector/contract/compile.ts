/**
 * In-page execution of a card's `onPass` (rebuild plan §4, charter I9): forbidden tokens plus a
 * `with (scope)` shadow, the way the Balatro PoC ran its hooks. No loops, no function definitions, no
 * constructors: a body can only run top to bottom once, so it always ends. No iframe, Worker or
 * result re-check.
 */
import type { PassValues } from './types';

/** Words and fragments a body may not contain (matched outside identifiers where the token is a word). */
const FORBIDDEN_WORDS = [
  'while', 'for', 'do', 'function', 'class', 'new', 'this', 'with', 'debugger', 'arguments',
  'import', 'require', 'async', 'await', 'yield', 'Promise', 'fetch', 'XMLHttpRequest', 'globalThis',
  'window', 'document', 'self', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function',
  'process', 'Reflect', 'Proxy', 'Symbol', 'WebAssembly', 'Worker', 'constructor', 'prototype',
  'Date', 'performance', 'crypto', 'setTimeout', 'setInterval', 'Array', 'Object', 'String', 'JSON',
] as const;
const FORBIDDEN_FRAGMENTS = ['=>', '__proto__', 'Math.random', '.repeat(', '.padStart(', '.padEnd(', '`'] as const;
const WORD_PATTERNS = FORBIDDEN_WORDS.map(word => ({ word, pattern: new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`) }));

/** The first forbidden token in a body, or null. */
export function findForbiddenToken(source: string): string | null {
  for (const fragment of FORBIDDEN_FRAGMENTS) if (source.includes(fragment)) return fragment;
  for (const { word, pattern } of WORD_PATTERNS) if (pattern.test(source)) return word;
  return null;
}

function noRandom(): never {
  throw new Error('Math.random is not available; use ctx.rng()');
}

/** Math without its entropy source. */
const SAFE_MATH: Readonly<Record<string, unknown>> = Object.freeze({
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, sqrt: Math.sqrt, cbrt: Math.cbrt, log: Math.log,
  log2: Math.log2, log10: Math.log10, exp: Math.exp, hypot: Math.hypot, PI: Math.PI, E: Math.E,
  random: noRandom,
});

/** The only free names a body can resolve; every other name reads as undefined. */
const SCOPE_VALUES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Math', SAFE_MATH], ['Number', Number], ['isFinite', Number.isFinite], ['isNaN', Number.isNaN],
  ['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined],
]);
/** `with (scope)` target: `has` answers true for every name so no lookup reaches the page's globals. */
const SCOPE: object = new Proxy(Object.freeze(Object.create(null) as object), {
  has: () => true,
  get: (_target, key) => (typeof key === 'string' ? SCOPE_VALUES.get(key) : undefined),
  set: () => false,
  deleteProperty: () => false,
  defineProperty: () => false,
  getOwnPropertyDescriptor: () => undefined,
});

/** What a card body sees as `ctx`. */
export interface PassContext extends Readonly<PassValues> {
  rng(): number;
}
export type CompiledPass = (ctx: PassContext) => unknown;

/** Compile a body. Throws when it contains a forbidden token or does not parse. */
export function compilePass(source: string): CompiledPass {
  const forbidden = findForbiddenToken(source);
  if (forbidden) throw new Error(`forbidden token: ${forbidden}`);
  const ctor = Function as unknown as new (...args: string[]) => unknown;
  // Syntax gate: the body must parse as a complete strict function body on its own, so a stray brace
  // cannot escape the wrapper below.
  new ctor('ctx', `"use strict";\n${source}`);
  const factory = new ctor('scope', `with (scope) { return function (ctx) { "use strict";\n${source}\n}; }`) as (scope: object) => unknown;
  const compiled = factory(SCOPE);
  if (typeof compiled !== 'function') throw new Error('onPass did not compile to a function');
  return compiled as CompiledPass;
}

/** Content hash of a body (FNV-1a in both directions); only a cache key, not a security boundary. */
export function sourceHash(source: string): string {
  let a = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) { a ^= source.charCodeAt(i); a = Math.imul(a, 0x01000193) >>> 0; }
  let b = 0x811c9dc5 ^ source.length;
  for (let i = source.length - 1; i >= 0; i--) { b ^= source.charCodeAt(i); b = Math.imul(b, 0x01000193) >>> 0; }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

const CACHE_LIMIT = 512;
const cache = new Map<string, { source: string; compiled: CompiledPass | null; error?: string }>();

/** Compile once per distinct body; a body that does not compile is remembered as such. */
export function compiledPass(source: string): { compiled: CompiledPass } | { error: string } {
  const key = sourceHash(source);
  let entry = cache.get(key);
  if (!entry || entry.source !== source) {
    try { entry = { source, compiled: compilePass(source) }; }
    catch (error) { entry = { source, compiled: null, error: error instanceof Error ? error.message : String(error) }; }
    if (cache.size >= CACHE_LIMIT) { const oldest = cache.keys().next(); if (!oldest.done) cache.delete(oldest.value); }
    cache.set(key, entry);
  }
  return entry.compiled ? { compiled: entry.compiled } : { error: entry.error ?? 'onPass does not compile' };
}

/** A deterministic 0–1 generator from a seed string (mulberry32). */
export function seededRng(seed: string): () => number {
  let state = Number.parseInt(sourceHash(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run a compiled body once. Never throws: an error comes back as the reason this pass did not act. */
export function runPass(compiled: CompiledPass, values: PassValues, seed: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const ctx: PassContext = Object.freeze({ ...values, rng: seededRng(seed) });
  try { return { ok: true, value: compiled(ctx) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
