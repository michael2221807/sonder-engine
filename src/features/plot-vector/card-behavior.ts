// App doc: docs/user-guide/pages/game-main.md §3.18.5 · Card details
/**
 * What a card really does, read from its own code (PO 2026-10-09; plan docs/design/plot-vector-card-face-converter-plan-2026-10-09.md):
 * the engine runs the card on chosen values and reads off when it acts (going back, a line on its pass count, a
 * quantity, its store or the trip's step — with the exact side of the line —, at random) and what it returns (adds,
 * multiplies, clearings, moves with all / half / a cap, steps, turns, stores, releases, relays). It starts from a
 * point where the card acts (searched for when the plain values leave it idle), splits on what changes it, and then
 * checks its own reading against the card on a spread of values: where the reading would say something the card does
 * not do, the card is marked complex — the face never states a condition it has not checked. Nothing here reads the
 * model's sentence or a measured average.
 */
import { passCard } from './contract/pass';
import { CHANNEL_NAMES, LIMITS, MULTIPLIER_OF, type CardReturn, type CardSpec, type ChannelName, type PassValues, type RelayReturn } from './contract/types';

/** A number a card may draw a line on: one of the four quantities, its own store, the trip's step, its pass count. */
export type LineInput = ChannelName | 'stored' | 'step' | 'pass';
/** When a clause applies. A line is `input cmp value`; a pass line at 2 reads "first pass" / "later". */
export type BehaviorCondition =
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'line'; on: LineInput; cmp: '<' | '<=' | '>=' | '>'; value: number }
  | { kind: 'chance'; percent: number };

/** What an amount follows besides the card's own number (the value is the one where the clause was read). */
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
  /** The reading does not match the card everywhere it was checked: the clauses list what it does, not every condition. */
  complex: boolean;
}

const PROBE_SEED = 'card-behavior';
/** Seeds that tell a random card's outcomes apart (only for cards whose code reads ctx.rng). */
const SIG_SEEDS = 8;
/** Enough draws to tell a chance within a few points; it is shown to the nearest 5% (as "about"). */
const CHANCE_SEEDS = 400;
const SCAN: Readonly<Record<LineInput, readonly number[]>> = {
  push: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, 75, 100],
  drag: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, 75, 100],
  social: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, 75, 100],
  chance: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, 75, 100],
  stored: [0, 0.001, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30],
  step: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20, 30, 45, 60],
  pass: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20],
};
const WHOLE: ReadonlySet<LineInput> = new Set(['step', 'pass']);
const MAX_SPLITS = 3;
const EPS = 1e-9;

type Fixed = Partial<PassValues>;
interface Probe { spec: CardSpec; departs: boolean; base: PassValues; random: boolean }

const round = (n: number) => Math.round(n * 100) / 100;
const run = (p: Probe, fixed: Fixed, seed = PROBE_SEED): CardReturn => passCard(p.spec, { ...p.base, ...fixed }, seed).ret;

/** The kind of a return, without its numbers: which operations, which way an add or a multiplier goes, a clearing. */
function shapeOf(ret: RelayReturn & { relay?: RelayReturn }): string {
  const t: string[] = [];
  for (const ch of CHANNEL_NAMES) {
    const a = ret[ch];
    if (a) t.push(`${ch}${a > 0 ? '+' : '-'}`);
    const f = ret[MULTIPLIER_OF[ch]];
    if (f !== undefined && f !== 1) t.push(`x${ch}${f === 0 ? '0' : f > 1 ? '+' : '-'}`);
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
/** The kind together with its numbers (going back may change only how much a card does). */
const valueSig = (ret: CardReturn) => `${shapeOf(ret)}#${JSON.stringify(ret, (_, v) => (typeof v === 'number' ? round(v) : v))}`;

/** The kinds a card returns at a point, over several seeds when it reads ctx.rng ('' = it does nothing there). */
function sigAt(p: Probe, fixed: Fixed, salt = ''): string {
  if (!p.random) return shapeOf(run(p, fixed));
  const shapes = new Set<string>();
  for (let s = 0; s < SIG_SEEDS; s++) shapes.add(shapeOf(run(p, fixed, `${PROBE_SEED}:${salt}${s}`)));
  return [...shapes].sort().join('|');
}

// ── Where to start: a point where the card acts ──────────────────────

/** Single changes, then pairs of them, tried in order when the plain values leave the card idle. */
function variants(p: Probe): Fixed[] {
  const one: Fixed[] = [
    ...(p.departs ? [] : [{ back: true }, { pass: 1 }, { pass: 3 }, { pass: 6 }, { step: 1 }, { step: 8 }, { step: 20 }]),
    ...CHANNEL_NAMES.flatMap(ch => [0, 5, 12, 40, 100].map(v => ({ [ch]: v }) as Fixed)),
    { stored: 5 }, { stored: 30 },
  ];
  const pairs: Fixed[] = [];
  for (let i = 0; i < one.length; i++) for (let j = i + 1; j < one.length; j++) {
    const a = Object.keys(one[i])[0], b = Object.keys(one[j])[0];
    if (a !== b) pairs.push({ ...one[i], ...one[j] });
  }
  return [...one, ...pairs];
}
/** Whether the card does anything at `fixed`: a random card is drawn many times, so a rare roll counts too. */
function actsAt(p: Probe, fixed: Fixed, draws: number): boolean {
  if (!p.random) return sigAt(p, fixed) !== '';
  for (let s = 0; s < draws; s++) if (shapeOf(run(p, fixed, `${PROBE_SEED}:a${s}`))) return true;
  return false;
}
function activeStart(p: Probe): Fixed | null {
  if (actsAt(p, {}, CHANCE_SEEDS)) return {};
  return variants(p).find(v => actsAt(p, v, SIG_SEEDS * 4)) ?? null;
}

// ── Splitting on what changes the card ─────────────────────────────

interface Split { conditions: [BehaviorCondition, BehaviorCondition]; fixes: [Fixed, Fixed]; irregular: boolean; on?: LineInput }

/**
 * Where a line on one input lies, if the card changes along it, with the exact side the line value itself is on
 * (`> 3` and `>= 4` on a whole number read the same way; `> 3` and `>= 3` on a quantity do not). Each side is read
 * at its most ordinary value (the one nearest where the reading started), not at the line. `irregular`: it changes
 * more than once along the input.
 */
function lineOn(p: Probe, fixed: Fixed, on: LineInput): Split | null {
  const scan = SCAN[on];
  const at = (v: number) => sigAt(p, { ...fixed, [on]: v });
  const sigs = scan.map(at);
  const changes = sigs.flatMap((s, i) => (i && s !== sigs[i - 1] ? [i] : []));
  if (!changes.length) return null;
  const i = changes[0];
  const low = sigs[i - 1], high = sigs[i];
  let lo = scan[i - 1], hi = scan[i];
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) === low) lo = mid; else hi = mid;
  }
  let cut: { low: BehaviorCondition; high: BehaviorCondition };
  if (WHOLE.has(on)) {
    // The first whole number on the high side.
    const first = at(Math.ceil(hi - EPS)) === high ? Math.ceil(hi - EPS) : Math.ceil(hi - EPS) + 1;
    cut = { low: { kind: 'line', on, cmp: '<', value: first }, high: { kind: 'line', on, cmp: '>=', value: first } };
  } else {
    // The line at the fewest decimals that still is the line (2.5, not 2.50; 2.555, not 2.56).
    const v = [0, 1, 2, 3, 4].map(k => Math.round(hi * 10 ** k) / 10 ** k).find(x => Math.abs(x - hi) < 1e-6) ?? Math.round(hi * 1e4) / 1e4;
    const inclusive = v > 0 && at(v) === high;
    cut = inclusive
      ? { low: { kind: 'line', on, cmp: '<', value: v }, high: { kind: 'line', on, cmp: '>=', value: v } }
      : { low: { kind: 'line', on, cmp: '<=', value: v }, high: { kind: 'line', on, cmp: '>', value: v } };
  }
  const plain = (fixed[on] as number | undefined) ?? (p.base[on] as number);
  const nearest = (from: number, to: number) => scan.slice(from, to).reduce((a, b) => (Math.abs(b - plain) < Math.abs(a - plain) ? b : a));
  return { conditions: [cut.low, cut.high], fixes: [{ [on]: nearest(0, i) }, { [on]: nearest(i, changes[1] ?? scan.length) }], irregular: changes.length > 1, on };
}

/** The inputs that may change a card, in the order they are told apart. */
function splits(p: Probe, fixed: Fixed, done: ReadonlySet<string>): Split[] {
  const out: Split[] = [];
  if (!p.departs && !done.has('back')) {
    const [f, b] = [run(p, { ...fixed, back: false }), run(p, { ...fixed, back: true })];
    // Going back may change only how much a card does: that is a condition too (a magnitude on a quantity is not).
    const differs = sigAt(p, { ...fixed, back: false }) !== sigAt(p, { ...fixed, back: true }) || (!p.random && valueSig(f) !== valueSig(b));
    if (differs) out.push({ conditions: [{ kind: 'forward' }, { kind: 'back' }], fixes: [{ back: false }, { back: true }], irregular: false });
  }
  const lines: LineInput[] = [...(p.departs ? [] : ['pass' as const]), ...CHANNEL_NAMES, 'stored', ...(p.departs ? [] : ['step' as const])];
  for (const on of lines) {
    if (done.has(on)) continue;
    const line = lineOn(p, fixed, on);
    if (line) out.push(line);
  }
  return out;
}

const isChannel = (on: LineInput): on is ChannelName => (CHANNEL_NAMES as readonly string[]).includes(on);

/** Whether the "some" side only adds operations that take from `ch` (move it, clear it, store it) to the "none" side. */
function consumesOnly(p: Probe, fixed: Fixed, fixes: [Fixed, Fixed], ch: ChannelName): boolean {
  if (p.random) return false;
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

/**
 * Whether the card does nothing at 0 of `ch` only because what it returns is as much as `ch` (an add of the quantity
 * itself, a multiplier of 1 + it): just above 0 it does the same kind of thing in an amount that fades to nothing.
 */
function fadesAtZero(p: Probe, fixed: Fixed, fixes: [Fixed, Fixed], ch: ChannelName): boolean {
  if (p.random || shapeOf(run(p, { ...fixed, ...fixes[0] })) !== '') return false;
  const near = run(p, { ...fixed, [ch]: 0.001 });
  if (shapeOf(near) !== shapeOf(run(p, { ...fixed, ...fixes[1] }))) return false;
  const small = (v: number | undefined, rest = 0) => v === undefined || Math.abs(v - rest) < 0.01;
  return CHANNEL_NAMES.every(c => small(near[c]) && small(near[MULTIPLIER_OF[c]], 1))
    && small(near.convert?.amount) && small(near.store?.amount) && small(near.steps) && small(near.xSteps, 1);
}

/** A clause as read: where it was read (`at`) and the kind of return it says (`shape`), for the self-check. */
type ReadClause = BehaviorClause & { at: Fixed; shape: string };
interface Read { clauses: ReadClause[]; complex: boolean }

function clausesAt(p: Probe, fixed: Fixed, when: BehaviorCondition[], done: ReadonlySet<string>, depth: number): Read {
  for (const split of splits(p, fixed, done)) {
    const [low, high] = split.conditions;
    const key = split.on ?? 'back';
    // "None" against "some" of a quantity, where "some" only adds what feeds on that quantity (moving it, clearing
    // it, storing it) or returns as much as it: nothing to feed on is no condition worth a word, so the card reads
    // as the "some" side.
    if (low.kind === 'line' && low.value === 0 && isChannel(low.on)
      && (consumesOnly(p, fixed, split.fixes, low.on) || fadesAtZero(p, fixed, split.fixes, low.on))) {
      // The same depth: this is no split, and it ends because `done` gains the input each time.
      return clausesAt(p, { ...fixed, ...split.fixes[1] }, when, new Set([...done, key]), depth);
    }
    if (depth >= MAX_SPLITS) return { ...leaf(p, fixed, when), complex: true };
    let complex = split.irregular;
    const clauses: ReadClause[] = [];
    split.fixes.forEach((fix, i) => {
      const sub = clausesAt(p, { ...fixed, ...fix }, [...when, i ? high : low], new Set([...done, key]), depth + 1);
      clauses.push(...sub.clauses);
      complex ||= sub.complex;
    });
    return { clauses: clauses.filter(c => c.ops.length), complex };
  }
  return { ...leaf(p, fixed, when), complex: false };
}

/** A point with no more splits: one clause, or one per outcome of a random card, with how often it comes. */
function leaf(p: Probe, fixed: Fixed, when: BehaviorCondition[]): { clauses: ReadClause[] } {
  if (!p.random) return { clauses: [{ when, ops: opsAt(p, fixed), at: fixed, shape: sigAt(p, fixed) }] };
  // A random card is drawn many times at every leaf: a branch too rare for the few draws that told the splits
  // apart still shows here.
  const outcomes = new Map<string, { n: number; seed: string }>();
  for (let s = 0; s < CHANCE_SEEDS; s++) {
    const seed = `${PROBE_SEED}:c${s}`;
    const shape = shapeOf(run(p, fixed, seed));
    const seen = outcomes.get(shape);
    outcomes.set(shape, { n: (seen?.n ?? 0) + 1, seed: seen?.seed ?? seed });
  }
  // One outcome every time: no chance to tell (how much may still vary at random, which opsAt reads).
  if (outcomes.size === 1 && !outcomes.has('')) return { clauses: [{ when, ops: opsAt(p, fixed), at: fixed, shape: [...outcomes.keys()][0] }] };
  return {
    clauses: [...outcomes.entries()].filter(([shape]) => shape).map(([shape, { n, seed }]) => {
      const ret = run(p, fixed, seed);
      // To the nearest 5 (it is told as "about"); a rare outcome is never rounded away to 0.
      const raw = (n / CHANCE_SEEDS) * 100;
      const percent = raw < 2.5 ? Math.max(1, Math.round(raw)) : raw > 97.5 ? Math.min(99, Math.round(raw)) : Math.round(raw / 5) * 5;
      return { when: [...when, { kind: 'chance', percent }], ops: [...valueOps(ret), ...relayOf(ret)], at: fixed, shape };
    }),
  };
}

// ── Operations and their amounts ───────────────────────────────────

/** What else an amount follows: the first input that changes it while the card stays the same kind. */
function variesBy(p: Probe, fixed: Fixed, read: (r: CardReturn) => number | undefined, value: number): VaryBy | undefined {
  const shape = shapeOf(run(p, fixed));
  const tries: Array<[VaryBy, Fixed]> = [
    ...(p.departs ? [] : ([['pass', { pass: 1 }], ['pass', { pass: 5 }], ['step', { step: 1 }], ['step', { step: 7 }]] as Array<[VaryBy, Fixed]>)),
    ['level', { level: p.base.level + 2 }], ['stored', { stored: 5 }],
    ...CHANNEL_NAMES.flatMap(ch => [0.5, 1, 3, 10, 30].map(v => [ch, { [ch]: v }] as [VaryBy, Fixed])),
  ];
  for (const [by, change] of tries) {
    const r = run(p, { ...fixed, ...change });
    // Within its own clause only: a change that crosses a condition is not how much the card does.
    if (shapeOf(r) !== shape) continue;
    const x = read(r);
    if (x !== undefined && Math.abs(x - value) > EPS) return by;
  }
  if (p.random) for (let s = 0; s < SIG_SEEDS; s++) {
    const r = run(p, fixed, `${PROBE_SEED}:${s}`);
    const x = shapeOf(r) === shape ? read(r) : undefined;
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

/** Operations by their values only (a relay's, or one random outcome's). */
function valueOps(ret: RelayReturn): BehaviorOp[] {
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
const relayOf = (ret: CardReturn): BehaviorOp[] => (ret.relay ? [{ kind: 'relay', ops: valueOps(ret.relay), echo: !!ret.relay.echo }] : []);

/** The operations a card returns at `fixed`, in the engine's order (add, multiply, move, store, release, steps, turn, relay). */
function opsAt(p: Probe, fixed: Fixed): BehaviorOp[] {
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
  ops.push(...relayOf(ret));
  return ops;
}

// ── Checking the reading against the card ───────────────────────────

function holds(c: BehaviorCondition, v: PassValues): boolean {
  switch (c.kind) {
    case 'back': return v.back;
    case 'forward': return !v.back;
    case 'chance': return true;
    case 'line': {
      const x = v[c.on] as number;
      return c.cmp === '<' ? x < c.value : c.cmp === '<=' ? x <= c.value : c.cmp === '>=' ? x >= c.value : x > c.value;
    }
  }
}
const CHECKS = 96;
/** A seeded spread of points over every input the card can read (mulberry32, so every input varies on its own). */
function checkPoints(p: Probe): PassValues[] {
  let s = 0x2f6b9d13;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const amounts = [0, 0, 0.5, 1, 2, 3, 4, 5, 8, 12, 25, 60];
  return Array.from({ length: CHECKS }, () => ({
    ...p.base,
    push: pick(amounts), drag: pick(amounts), social: pick(amounts), chance: pick(amounts),
    stored: pick([0, 0, 1, 2, 3, 5, 10, 30]),
    ...(p.departs ? {} : { back: next() < 0.5, pass: pick([1, 1, 2, 3, 4, 6, 10]), step: pick([1, 2, 3, 4, 5, 8, 15, 30]) }),
  }));
}
const tokensOf = (shape: string) => new Set(shape.split(/[|,]/).filter(Boolean));
/**
 * Where a quantity is 0 a card may do less than its clause says only because there is nothing to take from (a move,
 * a clearing, a store of it) or its amount is that quantity: then just above 0 it does what the clause says.
 */
function nothingToTake(p: Probe, v: PassValues, actual: string, said: string): boolean {
  const zero = CHANNEL_NAMES.filter(ch => v[ch] === 0);
  if (!zero.length) return false;
  const have = tokensOf(said);
  if ([...tokensOf(actual)].some(t => !have.has(t))) return false;
  return sigAt(p, { ...v, ...Object.fromEntries(zero.map(ch => [ch, 0.5])) }) === said;
}
/** Whether the clauses say what the card does at every check point (which kinds of return, not how much). */
function matches(p: Probe, clauses: ReadClause[]): boolean {
  for (const [i, v] of checkPoints(p).entries()) {
    // Fresh draws at every point (a random card): together they see a branch the reading's draws never met.
    const actual = sigAt(p, v, `m${i}:`);
    const said = clauses.filter(c => c.when.every(w => w.kind === 'chance' || holds(w, v)));
    if (!said.length) { if (actual !== '') return false; continue; }
    const chancy = said.filter(c => c.when.some(w => w.kind === 'chance'));
    if (!chancy.length) {
      // One clause holds here (they never overlap) and the card does what it says.
      if (said.length > 1) return false;
      if (actual !== said[0].shape && !nothingToTake(p, v, actual, said[0].shape)) return false;
      continue;
    }
    // A random branch: every outcome seen here is one its clauses name, or nothing (the rest of the time).
    const named = new Set(chancy.map(c => c.shape));
    if (actual.split('|').some(o => o !== '' && !named.has(o))) return false;
  }
  return true;
}

// ── Reading a card ─────────────────────────────────────────────────

const memo = new Map<string, CardBehavior>();
const MEMO_LIMIT = 500;

/**
 * Read a card. `departs`: an environment, which acts once at departure (no pass, step or direction, and at level 0,
 * as the engine runs it). `level`: the card's growth level now (its numbers are read at it).
 */
export function readCardBehavior(spec: CardSpec, opts: { departs?: boolean; level?: number } = {}): CardBehavior {
  const departs = !!opts.departs, level = departs ? 0 : opts.level ?? 0;
  const key = `${spec.onPass}\u0000${JSON.stringify(spec.growth?.add ?? null)}\u0000${departs}\u0000${level}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const base: PassValues = { push: 2, drag: 2, social: 2, chance: 2, pass: departs ? 0 : 2, step: departs ? 0 : 3, back: false, level, stored: 0 };
  const p: Probe = { spec, departs, base, random: spec.onPass.includes('rng') };
  const start = activeStart(p);
  let behavior: CardBehavior;
  if (!start) {
    // It does nothing anywhere it was tried: say so rather than guess.
    behavior = { clauses: [], complex: true };
  } else {
    const read = clausesAt(p, start, [], new Set(), 0);
    const clauses = read.clauses.filter(c => c.ops.length);
    behavior = { clauses: clauses.map(({ when, ops }) => ({ when, ops })), complex: read.complex || !matches(p, clauses) };
  }
  if (memo.size >= MEMO_LIMIT) { const oldest = memo.keys().next(); if (!oldest.done) memo.delete(oldest.value); }
  memo.set(key, behavior);
  return behavior;
}
