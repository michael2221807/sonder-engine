/**
 * In-page execution of a card's `onPass` (rebuild plan §4, charter I9): forbidden tokens plus a
 * `with (scope)` shadow, the way the Balatro PoC ran its hooks. No loops, no function definitions, no
 * constructors: a body can only run top to bottom once, so it always ends. No iframe, Worker or
 * result re-check.
 *
 * A word list alone cannot keep a body inside that shape: `x['constr' + 'uctor']` spells a forbidden
 * name at run time and reaches the page's `Function`, and `({})['__pro' + 'to__']` reaches the page's
 * prototypes. So the body is also held to the subset the card domain promises (const/let, if, ternary,
 * arithmetic, Math, object literals): no brackets, escapes or regular expressions; after a dot only the
 * names of the domain; calls only to Math/Number functions, isFinite, isNaN and ctx.rng(); no getters or
 * setters (they run without call syntax). Everything a body can reach is a fresh frozen object, never one
 * of the page's own built-ins.
 *
 * Nor may a body hold the page (P5, docs/design/plot-vector-rebuild-plan.md §13.3). Without loops each operator
 * runs at most once, but some operators cost without bound all the same:
 * - `x = x + x` doubles a text every statement (some thirty reach half a billion characters, and one comparison
 *   or conversion then takes hundreds of megabytes): text is only a channel name (the domain's only text) and a
 *   body has at most MAX_PLUS plus signs, so any text it builds is its longest piece × 2^15 at most (a few
 *   million characters even when a piece is a stand-in's source; comparing or converting it takes milliseconds);
 * - a BigInt literal (`3n ** 300000000n`, also `0x1n`) computes for minutes or exhausts memory: numbers are plain
 *   numbers, and a number running into a name is refused;
 * - spread turns every character of a text into a property (`{ ...x }`, a million per spread): no spread.
 * The body's length is held to LIMITS.sourceChars here too. In-page code cannot be interrupted, so a pass that
 * still runs long switches its card off for the session (SLOW_PASS_MS). What a failing body reports is cut
 * short and is never a function's source (it travels with the trip into the save).
 */
import { CHANNEL_NAMES, LIMITS, type PassValues } from './types';

/** Words and fragments a body may not contain (matched outside identifiers where the token is a word). */
const FORBIDDEN_WORDS = [
  'while', 'for', 'do', 'function', 'class', 'new', 'this', 'with', 'debugger', 'arguments',
  'import', 'require', 'async', 'await', 'yield', 'Promise', 'fetch', 'XMLHttpRequest', 'globalThis',
  'window', 'document', 'self', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function',
  'process', 'Reflect', 'Proxy', 'Symbol', 'WebAssembly', 'Worker', 'constructor', 'prototype',
  'Date', 'performance', 'crypto', 'setTimeout', 'setInterval', 'Array', 'Object', 'String', 'JSON',
] as const;
/** `[`/`]` (computed names), `\` (escaped names) and `__` (proto accessors) keep every name literal. */
const FORBIDDEN_FRAGMENTS = ['=>', '__', 'Math.random', '.repeat(', '.padStart(', '.padEnd(', '`', '\\', '[', ']', '<!--', '-->'] as const;
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
/** A fresh frozen stand-in for a built-in function, so a body never holds (or decorates) the page's own. */
const standIn = <A extends unknown[], R>(fn: (...args: A) => R) => Object.freeze((...args: A) => fn(...args));

const MATH_FUNCTIONS = ['abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'min', 'max', 'pow', 'sqrt', 'cbrt',
  'log', 'log2', 'log10', 'exp', 'hypot'] as const;
/** Math without its entropy source. */
const SAFE_MATH: Readonly<Record<string, unknown>> = Object.freeze({
  ...Object.fromEntries(MATH_FUNCTIONS.map(name => [name, standIn((...args: number[]) => (Math[name] as (...a: number[]) => number)(...args))])),
  PI: Math.PI, E: Math.E, random: Object.freeze(noRandom),
});
const NUMBER_FUNCTIONS = ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger'] as const;
/** Number's checks and constants only (not the page's Number itself). */
const SAFE_NUMBER: Readonly<Record<string, unknown>> = Object.freeze({
  ...Object.fromEntries(NUMBER_FUNCTIONS.map(name => [name, standIn((value: unknown) => Number[name](value))])),
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER, EPSILON: Number.EPSILON,
  MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Number.POSITIVE_INFINITY, NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
});

/** The only free names a body can resolve; every other name reads as undefined. */
const SCOPE_VALUES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Math', SAFE_MATH], ['Number', SAFE_NUMBER], ['isFinite', standIn((v: unknown) => Number.isFinite(v))],
  ['isNaN', standIn((v: unknown) => Number.isNaN(v))], ['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined],
]);
const FREE_CALLS = new Set(['isFinite', 'isNaN']);
/**
 * Plus signs a body may use (each runs at most once, and only `+` can grow a text). The cards written so far use
 * at most 3 (97 cards, P5); 16 keeps arithmetic room and caps a text at its longest piece × 2^16.
 */
export const MAX_PLUS = 16;
/** The only texts a body may write: the channel names (in convert and store). */
const TEXTS = new Set(CHANNEL_NAMES.flatMap(name => [`'${name}'`, `"${name}"`]));
/** How much of a failing body's report is kept (it travels with the trip into the save). */
export const MAX_ERROR_CHARS = 300;
/**
 * A pass longer than this switches its card off for the session (a pass normally takes microseconds; this is far
 * above that even on a slow phone).
 */
export const SLOW_PASS_MS = 250;
/** Words after which `(` may follow without being a call (an `if` head, a grouped expression after a keyword). */
const CALL_FREE_KEYWORDS = new Set(['if', 'return', 'typeof', 'void', 'delete', 'in', 'instanceof', 'throw', 'else']);

/** Names a body may read after a dot: the ctx values, Math and Number members, and the return fields. */
const CTX_FIELDS = ['push', 'drag', 'social', 'chance', 'pass', 'step', 'back', 'level', 'stored', 'rng'];
const RETURN_FIELDS = ['xPush', 'xDrag', 'xSocial', 'xChance', 'convert', 'from', 'to', 'amount', 'steps', 'xSteps',
  'turn', 'store', 'release', 'relay', 'echo'];
const MEMBERS = new Set([...CTX_FIELDS, ...RETURN_FIELDS, ...Object.keys(SAFE_MATH), ...Object.keys(SAFE_NUMBER)]);
/** Names a body may call after a dot. */
const CALLABLE_MEMBERS = new Set(['rng', ...MATH_FUNCTIONS, ...NUMBER_FUNCTIONS]);
/** Words after which `(` groups an expression and `/` would start a regular expression. */
const EXPRESSION_KEYWORDS = new Set(['if', 'return', 'typeof', 'void', 'delete', 'in', 'instanceof', 'case', 'throw', 'else', 'of']);

interface Token { kind: 'name' | 'number' | 'string' | 'punct'; text: string; closesIf?: boolean }
const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const LINE_END = new RegExp('[\n\r\u2028\u2029]', 'u');
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/y;

/**
 * Split a body into tokens the way the engine will run it. Strings and comments are the only text skipped;
 * a `/` that could start a regular expression is refused, so nothing the engine runs hides from the checks.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const parens: boolean[] = []; // per open paren: whether it opened an `if` head
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { const end = source.slice(i).search(LINE_END); i = end < 0 ? source.length : i + end; continue; }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      const end = source.indexOf(c, i + 1);
      if (end < 0) throw new Error('unterminated string');
      tokens.push({ kind: 'string', text: source.slice(i, end + 1) }); i = end + 1; continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(source[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(source);
      if (!match) throw new Error(`unexpected character "${c}"`);
      // `1n`, `0x1n`: a BigInt (unbounded work); any name glued to a number reads differently in the engine.
      if (NAME_PART.test(source[i + match[0].length] ?? '')) throw new Error('numbers are plain numbers (no BigInt)');
      tokens.push({ kind: 'number', text: match[0] }); i += match[0].length; continue;
    }
    if (NAME_START.test(c)) {
      let end = i + 1;
      while (end < source.length && NAME_PART.test(source[end])) end++;
      tokens.push({ kind: 'name', text: source.slice(i, end) }); i = end; continue;
    }
    if (c === '/') {
      const prev = tokens.at(-1);
      const division = !!prev && (prev.kind === 'number' || prev.kind === 'string'
        || (prev.kind === 'name' && !EXPRESSION_KEYWORDS.has(prev.text)) || (prev.text === ')' && !prev.closesIf));
      if (!division) throw new Error('regular expressions are not available');
      tokens.push({ kind: 'punct', text: '/' }); i++; continue;
    }
    if (source.startsWith('...', i)) throw new Error('spread is not available');
    if (source.startsWith('?.', i) && !/\d/.test(source[i + 2] ?? '')) { tokens.push({ kind: 'punct', text: '?.' }); i += 2; continue; }
    if (!'{}();,<>+-*%&|^!~?:=.'.includes(c)) throw new Error(`unexpected character "${c}"`);
    const token: Token = { kind: 'punct', text: c };
    if (c === '(') parens.push(tokens.at(-1)?.text === 'if');
    if (c === ')') token.closesIf = parens.pop() ?? false;
    tokens.push(token); i++;
  }
  return tokens;
}

/** Hold a body to the domain's subset (see the file comment). Throws with the reason. */
function checkShape(source: string): void {
  const tokens = tokenize(source);
  const plus = tokens.filter(token => token.kind === 'punct' && token.text === '+').length;
  if (plus > MAX_PLUS) throw new Error(`at most ${MAX_PLUS} plus signs, not ${plus}`);
  tokens.forEach((token, i) => {
    if (token.kind === 'string' && !TEXTS.has(token.text))
      throw new Error(`text can only be a channel name (${CHANNEL_NAMES.join(', ')}), not ${token.text.slice(0, 20)}`);
    const prev = tokens[i - 1], before = tokens[i - 2];
    // An accessor runs without call syntax (a spread or a read calls it), so it could recurse: refused.
    // `get`/`set` followed by a property name and `(` only ever defines one.
    if (token.kind === 'name' && (token.text === 'get' || token.text === 'set') && tokens[i + 1]
      && tokens[i + 1].kind !== 'punct' && tokens[i + 2]?.text === '(')
      throw new Error('getters and setters are not available');
    // Destructuring reads a property by any literal name, which would hand the body a built-in.
    if (token.text === '{' && prev?.kind === 'name' && ['const', 'let', 'var'].includes(prev.text)
      || token.text === '=' && prev?.text === '}' && tokens[i + 1]?.text !== '=')
      throw new Error('destructuring is not available');
    const afterDot = prev?.text === '.' || prev?.text === '?.';
    if (token.kind === 'name' && afterDot && !MEMBERS.has(token.text))
      throw new Error(`only ctx values, Math and Number can be read, not ".${token.text}"`);
    if (token.text !== '(' || !prev) return;
    if (prev.text === '?.') throw new Error('optional calls are not available');
    const callsName = prev.kind === 'name' && (
      (before && (before.text === '.' || before.text === '?.') ? CALLABLE_MEMBERS.has(prev.text) : FREE_CALLS.has(prev.text) || CALL_FREE_KEYWORDS.has(prev.text)));
    // `(` after a name, `)`, `}` or a literal is a call; only Math/Number functions, isFinite, isNaN and ctx.rng can be called.
    if (prev.kind === 'punct' ? [')', '}'].includes(prev.text) : !callsName)
      throw new Error(`only Math and Number functions, isFinite, isNaN and ctx.rng() can be called, not "${prev.text}("`);
  });
}
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
  if (source.length > LIMITS.sourceChars) throw new Error(`onPass is longer than ${LIMITS.sourceChars} characters`);
  const forbidden = findForbiddenToken(source);
  if (forbidden) throw new Error(`forbidden token: ${forbidden}`);
  checkShape(source);
  const ctor = Function as unknown as new (...args: string[]) => unknown;
  // Syntax gate: the body must parse as a complete strict function body on its own, so a stray brace
  // cannot escape the wrapper below.
  try { new ctor('ctx', `"use strict";\n${source}`); }
  catch (error) { throw new Error(`onPass does not compile: ${error instanceof Error ? error.message : String(error)}`); }
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

/** Bodies that ran longer than SLOW_PASS_MS once: switched off until the page is reloaded. */
const tooSlow = new WeakSet<CompiledPass>();

/**
 * What a failing body reports: an error's message, cut short, or a thrown channel name. Any other thrown value —
 * which could carry a stand-in function's source text — becomes a fixed sentence.
 */
function reportOf(error: unknown): string {
  if (typeof error === 'string' && (CHANNEL_NAMES as readonly string[]).includes(error)) return error;
  const text = error instanceof Error ? String(error.message) : 'the card threw something that is not an error';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/** Run a compiled body once. Never throws: an error comes back as the reason this pass did not act. */
export function runPass(compiled: CompiledPass, values: PassValues, seed: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (tooSlow.has(compiled)) return { ok: false, error: `this card took longer than ${SLOW_PASS_MS} ms and is switched off until the page is reloaded` };
  const ctx: PassContext = Object.freeze({ ...values, rng: Object.freeze(seededRng(seed)) });
  const started = performance.now();
  try { return { ok: true, value: compiled(ctx) }; }
  catch (error) { return { ok: false, error: reportOf(error) }; }
  finally { if (performance.now() - started > SLOW_PASS_MS) tooSlow.add(compiled); }
}
