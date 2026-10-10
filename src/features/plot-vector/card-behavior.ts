// App doc: docs/user-guide/pages/game-main.md §3.18.5 · Card details
/**
 * What a card really does, read from its own code (PO 2026-10-09; plan docs/design/plot-vector-card-face-converter-plan-2026-10-09.md):
 * the engine runs the card on chosen values, one input changed at a time, and reads off when it acts (going back,
 * the first pass, a quantity above or below a line, at random) and what it returns (adds, multiplies, clears, moves
 * one quantity into another, steps, turns, stores, relays). Nothing here reads the model's sentence or a measured
 * average: the face says what the code does. A card whose conditions cross each other more than the reader follows
 * is marked complex rather than given a condition it does not have.
 */
import { passCard } from './contract/pass';
import { CHANNEL_NAMES, LIMITS, MULTIPLIER_OF, type CardReturn, type CardSpec, type ChannelName, type PassValues, type RelayReturn } from './contract/types';

/** A number a card may draw a line on: one of the four quantities, its own store, the trip's step. */
export type LineInput = ChannelName | 'stored' | 'step';
/** When a clause applies. A line is "below" / "at least" `value`; on a quantity a value of 0 reads "none" / "some". */
export type BehaviorCondition =
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'firstPass' }
  | { kind: 'laterPass' }
  | { kind: 'below'; on: LineInput; value: number }
  | { kind: 'atLeast'; on: LineInput; value: number }
  | { kind: 'chance'; percent: number };

/** What an amount follows besides the card's own number (the value is the one at the probe's plain inputs). */
export type VaryBy = 'pass' | 'step' | 'level' | 'stored' | 'random' | ChannelName;
export interface BehaviorAmount { value: number; varies?: VaryBy }

export type BehaviorOp =
  | { kind: 'add'; channel: ChannelName; amount: BehaviorAmount }
  /** Multiplied by 0, or lowered by all of itself. */
  | { kind: 'clear'; channel: ChannelName }
  | { kind: 'scale'; channel: ChannelName; factor: BehaviorAmount }
  /** `share`: all / half of `from` (up to `cap` when one shows); otherwise a fixed `amount`. */
  | { kind: 'convert'; from: ChannelName; to: ChannelName; share?: 'all' | 'half'; cap?: number; amount?: BehaviorAmount }
  | { kind: 'steps'; amount: BehaviorAmount }
  | { kind: 'xSteps'; factor: BehaviorAmount }
  | { kind: 'turn' }
  | { kind: 'store'; from: ChannelName; amount: BehaviorAmount }
  | { kind: 'release' }
  /** Acts on the next card that triggers: its operations, and/or once more (`echo`). */
  | { kind: 'relay'; ops: BehaviorOp[]; echo: boolean };

export interface BehaviorClause {
  /** Every condition must hold; none means always. */
  when: BehaviorCondition[];
  ops: BehaviorOp[];
}
export interface CardBehavior {
  clauses: BehaviorClause[];
  /** Conditions cross more than the reader follows: the clauses list what it does, not every condition. */
  complex: boolean;
}

const PROBE_SEED = 'card-behavior';
const RANDOM_SEEDS = 48;
/** Where a line is looked for on each input (a tiny positive value catches "none" against "some"). */
const CHANNEL_SCAN = [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50];
const LINE_SCAN: Readonly<Record<'stored' | 'step', number[]>> = {
  stored: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30],
  step: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16],
};
/** Passes beyond the second that must act like the second for "first pass / later" to hold. */
const LATER_PASSES = [3, 4, 6];
const MAX_SPLITS = 2;
const EPS = 1e-9;

type Fixed = Partial<PassValues>;
interface Probe { spec: CardSpec; departs: boolean; base: PassValues }

function run(p: Probe, fixed: Fixed, seed = PROBE_SEED): CardReturn {
  return passCard(p.spec, { ...p.base, ...fixed }, seed).ret;
}

/** The kind of a return, without its numbers: which operations, which way an add goes, a clearing multiplier. */
function shapeOf(ret: RelayReturn & { relay?: RelayReturn }): string {
  const t: string[] = [];
  for (const ch of CHANNEL_NAMES) {
    const a = ret[ch];
    if (a) t.push(`${ch}${a > 0 ? '+' : '-'}`);
    const f = ret[MULTIPLIER_OF[ch]];
    if (f !== undefined && f !== 1) t.push(`x${ch}${f === 0 ? '0' : ''}`);
  }
  if (ret.convert && ret.convert.amount > 0) t.push(`c${ret.convert.from}>${ret.convert.to}`);
  if (ret.store && ret.store.amount > 0) t.push(`s${ret.store.from}`);
  if (ret.release) t.push('release');
  if (ret.steps) t.push('steps');
  if (ret.xSteps !== undefined && ret.xSteps !== 1) t.push('xSteps');
  if (ret.turn) t.push('turn');
  if (ret.echo) t.push('echo');
  if (ret.relay) t.push(`r(${shapeOf(ret.relay)})`);
  return t.join(',');
}

const round = (n: number) => Math.round(n * 100) / 100;

// ── Conditions ─────────────────────────────────────────────────────

interface Split { conditions: [BehaviorCondition, BehaviorCondition]; fixes: [Fixed, Fixed]; irregular?: boolean }

/**
 * Where a line on one input lies, if the card changes kind along it; `irregular` when it changes more than once.
 * Each side is then read at its most ordinary value (the one nearest the probe's plain input), not at the line.
 */
function lineOn(p: Probe, fixed: Fixed, on: LineInput): Split | null {
  const scan = on in LINE_SCAN ? LINE_SCAN[on as keyof typeof LINE_SCAN] : CHANNEL_SCAN;
  const shapes = scan.map(v => shapeOf(run(p, { ...fixed, [on]: v })));
  const changes = shapes.flatMap((s, i) => (i && s !== shapes[i - 1] ? [i] : []));
  if (!changes.length) return null;
  const i = changes[0];
  let lo = scan[i - 1], hi = scan[i];
  const below = shapes[i - 1];
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (shapeOf(run(p, { ...fixed, [on]: mid })) === below) lo = mid; else hi = mid;
  }
  const value = round(hi) < 0.01 ? 0 : on === 'step' ? Math.ceil(hi - EPS) : round(hi);
  const plain = p.base[on] as number;
  const nearest = (from: number, to: number) => scan.slice(from, to).reduce((a, b) => (Math.abs(b - plain) < Math.abs(a - plain) ? b : a));
  return {
    conditions: [{ kind: 'below', on, value }, { kind: 'atLeast', on, value }],
    fixes: [{ [on]: nearest(0, i) }, { [on]: nearest(i, changes[1] ?? scan.length) }],
    irregular: changes.length > 1,
  };
}

/** The inputs that may change a card's kind, in the order they are told apart. */
function splits(p: Probe, fixed: Fixed): Split[] {
  const out: Split[] = [];
  if (!p.departs) {
    if (!('back' in fixed)) out.push({ conditions: [{ kind: 'forward' }, { kind: 'back' }], fixes: [{ back: false }, { back: true }] });
    if (!('pass' in fixed)) {
      const later = shapeOf(run(p, { ...fixed, pass: 2 }));
      const irregular = LATER_PASSES.some(n => shapeOf(run(p, { ...fixed, pass: n })) !== later);
      out.push({ conditions: [{ kind: 'firstPass' }, { kind: 'laterPass' }], fixes: [{ pass: 1 }, { pass: 2 }], irregular });
    }
  }
  // Not the level: growth adds to a card's numbers level by level, which reads as an amount that grows, not a condition.
  const lines: LineInput[] = [...CHANNEL_NAMES, 'stored', ...(p.departs ? [] : ['step' as const])];
  for (const on of lines) {
    if (on in fixed) continue;
    const line = lineOn(p, fixed, on);
    if (line) out.push(line);
  }
  return out;
}

function clausesAt(p: Probe, fixed: Fixed, when: BehaviorCondition[], depth: number): { clauses: BehaviorClause[]; complex: boolean } {
  for (const split of splits(p, fixed)) {
    const [a, b] = split.fixes.map(f => shapeOf(run(p, { ...fixed, ...f })));
    if (a === b) continue;
    if (depth >= MAX_SPLITS) return { clauses: [clauseOf(p, fixed, when)], complex: true };
    // "None" against "some" of a quantity, where "some" only adds what feeds on that quantity (moving it, clearing
    // it, storing it): nothing to feed on is no condition worth a word, so the card reads as the "some" side.
    const [low, high] = split.conditions;
    if (low.kind === 'below' && low.value === 0 && isChannel(low.on) && consumesOnly(p, fixed, split.fixes, low.on)) {
      return clausesAt(p, { ...fixed, ...split.fixes[1] }, when, depth);
    }
    let complex = !!split.irregular;
    const clauses: BehaviorClause[] = [];
    split.fixes.forEach((fix, i) => {
      const sub = clausesAt(p, { ...fixed, ...fix }, [...when, i ? high : low], depth + 1);
      clauses.push(...sub.clauses);
      complex ||= sub.complex;
    });
    return { clauses: clauses.filter(c => c.ops.length), complex };
  }
  return { clauses: [clauseOf(p, fixed, when)], complex: false };
}

const isChannel = (on: LineInput): on is ChannelName => (CHANNEL_NAMES as readonly string[]).includes(on);

/** Whether the "some" side only adds operations that take from `ch` (move it, clear it, store it) to the "none" side. */
function consumesOnly(p: Probe, fixed: Fixed, fixes: [Fixed, Fixed], ch: ChannelName): boolean {
  const none = run(p, { ...fixed, ...fixes[0] }), some = run(p, { ...fixed, ...fixes[1] });
  const tokens = (r: CardReturn) => new Set(shapeOf(r).split(',').filter(Boolean));
  const a = tokens(none), b = tokens(some);
  if ([...a].some(t => !b.has(t))) return false;
  // What both sides do must also be the same size, or the "none" side says something of its own.
  for (const name of CHANNEL_NAMES) {
    const key = MULTIPLIER_OF[name];
    if ((none[name] ?? 0) !== (some[name] ?? 0) && name !== ch) return false;
    if (none[key] !== undefined && none[key] !== some[key]) return false;
  }
  const extra = [...b].filter(t => !a.has(t));
  return extra.length > 0 && extra.every(t => t === `c${ch}>${some.convert?.to}` || t === `x${ch}0` || t === `${ch}-` || t === `s${ch}`);
}

// ── Operations and their amounts ───────────────────────────────────

/** What else an amount follows: the first input that changes it while the card stays the same kind. */
function variesBy(p: Probe, fixed: Fixed, read: (r: CardReturn) => number | undefined, value: number): VaryBy | undefined {
  const shape = shapeOf(run(p, fixed));
  const tries: Array<[VaryBy, Fixed]> = [
    ...(p.departs ? [] : [['pass', { pass: 1 }], ['pass', { pass: 5 }], ['step', { step: 1 }], ['step', { step: 7 }]] as Array<[VaryBy, Fixed]>),
    ['level', { level: p.base.level + 2 }], ['stored', { stored: 5 }],
    ...CHANNEL_NAMES.flatMap(ch => [[ch, { [ch]: 0.5 }], [ch, { [ch]: 10 }]] as Array<[VaryBy, Fixed]>),
  ];
  for (const [by, change] of tries) {
    if (Object.keys(change).some(k => k in fixed)) continue;
    const r = run(p, { ...fixed, ...change });
    if (shapeOf(r) !== shape) continue;
    const x = read(r);
    if (x !== undefined && Math.abs(x - value) > EPS) return by;
  }
  for (let s = 0; s < 8; s++) {
    const x = read(run(p, fixed, `${PROBE_SEED}:${s}`));
    if (x !== undefined && Math.abs(x - value) > EPS) return 'random';
  }
  return undefined;
}

function amount(p: Probe, fixed: Fixed, read: (r: CardReturn) => number | undefined, value: number): BehaviorAmount {
  const varies = variesBy(p, fixed, read, value);
  return varies ? { value: round(value), varies } : { value: round(value) };
}

/** An add that is always minus the quantity itself is a clearing. */
function clears(p: Probe, fixed: Fixed, ch: ChannelName): boolean {
  const shape = shapeOf(run(p, fixed));
  return [0.5, 2, 10].every(v => {
    const r = run(p, { ...fixed, [ch]: v });
    return shapeOf(r) === shape && Math.abs((r[ch] ?? 0) + v) < EPS;
  });
}

function convertOf(p: Probe, fixed: Fixed, ret: CardReturn): BehaviorOp {
  const { from, to } = ret.convert!;
  const shape = shapeOf(run(p, fixed));
  const at = (v: number): number | undefined => {
    const r = run(p, { ...fixed, [from]: v });
    return shapeOf(r) === shape ? r.convert?.amount : undefined;
  };
  // Small amounts, below any cap a card is likely to set; the cap itself shows at a very large amount.
  const probes = [0.2, 0.4, 0.8].map(v => [v, at(v)] as const);
  for (const [share, ratio] of [['all', 1], ['half', 0.5]] as const) {
    if (probes.every(([v, a]) => a !== undefined && Math.abs(a - v * ratio) < EPS)) {
      const far = at(1000);
      const cap = far !== undefined && far < 1000 * ratio - EPS && far < LIMITS.amount - EPS ? round(far) : undefined;
      return { kind: 'convert', from, to, share, ...(cap !== undefined ? { cap } : {}) };
    }
  }
  return { kind: 'convert', from, to, amount: amount(p, fixed, r => r.convert?.amount, ret.convert!.amount) };
}

/** The operations of a relay, by their values only (they act on another card's return). */
function relayOps(ret: RelayReturn): BehaviorOp[] {
  const ops: BehaviorOp[] = [];
  for (const ch of CHANNEL_NAMES) if (ret[ch]) ops.push({ kind: 'add', channel: ch, amount: { value: round(ret[ch]!) } });
  for (const ch of CHANNEL_NAMES) {
    const f = ret[MULTIPLIER_OF[ch]];
    if (f !== undefined && f !== 1) ops.push(f === 0 ? { kind: 'clear', channel: ch } : { kind: 'scale', channel: ch, factor: { value: round(f) } });
  }
  if (ret.convert && ret.convert.amount > 0) ops.push({ kind: 'convert', from: ret.convert.from, to: ret.convert.to, amount: { value: round(ret.convert.amount) } });
  if (ret.store && ret.store.amount > 0) ops.push({ kind: 'store', from: ret.store.from, amount: { value: round(ret.store.amount) } });
  if (ret.release) ops.push({ kind: 'release' });
  if (ret.steps) ops.push({ kind: 'steps', amount: { value: round(ret.steps) } });
  if (ret.xSteps !== undefined && ret.xSteps !== 1) ops.push({ kind: 'xSteps', factor: { value: round(ret.xSteps) } });
  if (ret.turn) ops.push({ kind: 'turn' });
  return ops;
}

/** The operations a card returns at `fixed`, in the engine's order (add, multiply, move, store, release, steps, turn, relay). */
function clauseOf(p: Probe, fixed: Fixed, when: BehaviorCondition[]): BehaviorClause {
  const ret = run(p, fixed);
  const ops: BehaviorOp[] = [];
  for (const ch of CHANNEL_NAMES) {
    const a = ret[ch];
    if (!a) continue;
    ops.push(a < 0 && clears(p, fixed, ch) ? { kind: 'clear', channel: ch } : { kind: 'add', channel: ch, amount: amount(p, fixed, r => r[ch], a) });
  }
  for (const ch of CHANNEL_NAMES) {
    const key = MULTIPLIER_OF[ch];
    const f = ret[key];
    if (f === undefined || f === 1) continue;
    ops.push(f === 0 ? { kind: 'clear', channel: ch } : { kind: 'scale', channel: ch, factor: amount(p, fixed, r => r[key], f) });
  }
  if (ret.convert && ret.convert.amount > 0) ops.push(convertOf(p, fixed, ret));
  if (ret.store && ret.store.amount > 0) ops.push({ kind: 'store', from: ret.store.from, amount: amount(p, fixed, r => r.store?.amount, ret.store.amount) });
  if (ret.release) ops.push({ kind: 'release' });
  if (ret.steps) ops.push({ kind: 'steps', amount: amount(p, fixed, r => r.steps, ret.steps) });
  if (ret.xSteps !== undefined && ret.xSteps !== 1) ops.push({ kind: 'xSteps', factor: amount(p, fixed, r => r.xSteps, ret.xSteps) });
  if (ret.turn) ops.push({ kind: 'turn' });
  if (ret.relay) ops.push({ kind: 'relay', ops: relayOps(ret.relay), echo: !!ret.relay.echo });
  return { when, ops };
}

// ── Reading a card ─────────────────────────────────────────────────

/** A card that acts at random: one clause per kind of return, with how often it comes. */
function randomClauses(p: Probe): BehaviorClause[] | null {
  const counts = new Map<string, { n: number; seed: string }>();
  for (let s = 0; s < RANDOM_SEEDS; s++) {
    const seed = `${PROBE_SEED}:r${s}`;
    const shape = shapeOf(run(p, {}, seed));
    const seen = counts.get(shape);
    counts.set(shape, { n: (seen?.n ?? 0) + 1, seed: seen?.seed ?? seed });
  }
  if (counts.size < 2) return null;
  // Each outcome by its own values (read at a seed that lands on it), with how often it comes, to the nearest 5%.
  return [...counts.entries()].filter(([shape]) => shape).map(([, { n, seed }]) => {
    const ret = run(p, {}, seed);
    return {
      when: [{ kind: 'chance', percent: Math.round((n / RANDOM_SEEDS) * 20) * 5 }],
      ops: [...relayOps(ret), ...(ret.relay ? [{ kind: 'relay' as const, ops: relayOps(ret.relay), echo: !!ret.relay.echo }] : [])],
    };
  });
}

const memo = new Map<string, CardBehavior>();
const MEMO_LIMIT = 500;

/**
 * Read a card. `departs`: an environment, which acts once at departure (no pass, step or direction). `level`: the
 * card's growth level now (its numbers are read at it).
 */
export function readCardBehavior(spec: CardSpec, opts: { departs?: boolean; level?: number } = {}): CardBehavior {
  const departs = !!opts.departs, level = opts.level ?? 0;
  const key = `${spec.onPass}\u0000${JSON.stringify(spec.growth?.add ?? null)}\u0000${departs}\u0000${level}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const base: PassValues = { push: 2, drag: 2, social: 2, chance: 2, pass: departs ? 0 : 2, step: departs ? 0 : 3, back: false, level, stored: 0 };
  const p: Probe = { spec, departs, base };
  const random = randomClauses(p);
  const read = random ? { clauses: random, complex: false } : clausesAt(p, {}, [], 0);
  const behavior: CardBehavior = { clauses: read.clauses.filter(c => c.ops.length), complex: read.complex };
  if (memo.size >= MEMO_LIMIT) { const oldest = memo.keys().next(); if (!oldest.done) memo.delete(oldest.value); }
  memo.set(key, behavior);
  return behavior;
}
