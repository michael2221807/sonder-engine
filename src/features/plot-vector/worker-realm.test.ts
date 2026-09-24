/**
 * Gate 1 · the REAL product Worker source (the same `virtual:plot-vector-runtime` bundle the
 * app embeds in its sandboxed iframe) executed inside a separate `node:vm` realm. The realm
 * hardens itself exactly as in the browser; the test process' own intrinsics are never frozen.
 * One `bootRealm()` = one child Worker (the browser creates a new one per `execute`).
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import source from 'virtual:plot-vector-runtime';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorOperation, type VectorState } from './runtime';
import { assertVectorResult } from './result-guard';
import { stable, tasksAfterSave, type BoundCard, type GenesisOutputV2, type SavedElement } from './genesis/post-save';
import { DEFAULT_SCRIPT_LIMITS } from './genesis/script-runtime';
import type { NativeInput } from './native-input';

type Reply = { id: string; result?: unknown; error?: string };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function bootRealm() {
  const waiting = new Map<string, (reply: Reply) => void>();
  const context = vm.createContext({
    // Replies are copied out of the realm, like a structured-clone postMessage.
    postMessage: (message: Reply) => waiting.get(message.id)?.(clone(message)),
    crypto: webcrypto, TextEncoder, console,
  });
  vm.runInContext(source, context);
  const execute = <T,>(op: VectorOperation): Promise<T> => new Promise((resolve, reject) => {
    const id = webcrypto.randomUUID();
    waiting.set(id, reply => (reply.error !== undefined ? reject(new Error(reply.error)) : resolve(reply.result as T)));
    context.__request = JSON.stringify({ id, op });
    vm.runInContext('onmessage({ data: JSON.parse(__request) })', context);
  });
  return { execute, evaluate: (code: string): unknown => vm.runInContext(code, context) };
}

const card = (id: string, onVisit: string, extra: Partial<GenesisOutputV2['card']> = {}): { entry: SavedElement; output: GenesisOutputV2 } => ({
  entry: { id, kind: 'item', capability: { name: id, description: `${id} test ability` } },
  output: { version: 2, card: { name: id, description: `${id} test ability`, behaviorSummary: id, hooks: { onVisit, onRoundAccepted: null }, ...extra } },
});
const validateOp = (c: ReturnType<typeof card>): VectorOperation => ({
  kind: 'validate', attempts: 1, output: c.output,
  task: tasksAfterSave({ id: 'acquire', success: true, before: [], after: [c.entry] })[0],
});

const HONEST = [
  card('DIARY', "return { effects: [{ kind: 'add', channel: 'J', amount: 1 + ctx.persistentState.pages }] };",
    { hooks: { onVisit: "return { effects: [{ kind: 'add', channel: 'J', amount: 1 + ctx.persistentState.pages }] };",
      onRoundAccepted: 'return { persistentState: { pages: Math.min(100, ctx.persistentState.pages + (ctx.wasTriggered ? 1 : 0)) } };' },
    initialPersistentState: { pages: 0 } }),
  card('STEPS', "return { effects: ctx.runState.used ? [] : [{ kind: 'addVisits', amount: 2 }], runState: { used: true } };"),
  card('STORE', `
    const stored = ctx.selfStore['S+'] || 0; const available = ctx.shuttle['S+'] || 0;
    if (ctx.entryPort === 'L' && stored < 4 && available > 0) return { effects: [{ kind: 'store', store: 'self', channel: 'S+', amount: Math.min(4 - stored, available) }] };
    if (ctx.entryPort === 'R' && stored > 0) return { effects: [{ kind: 'release', store: 'self', channel: 'S+', amount: stored, gainAsExtra: 0.5 }] };
    return { effects: [] };`, { selfStore: { cap: 4, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] } }),
  // A deliberately strong card: each visit is within the per-effect bound, the aggregate is far above it.
  card('STRONG', "return { effects: [{ kind: 'add', channel: 'S+', amount: 900000 }] };"),
];
const NATIVE: NativeInput = { ruleId: 'test', payload: { 'S+': 2, 'S-': 0, Y: 2, J: 0 }, visitBudget: 8, contributions: [] };

async function boardFor(execute: <T>(op: VectorOperation) => Promise<T>, cards: ReturnType<typeof card>[]): Promise<{ state: VectorState; entries: SavedElement[] }> {
  const bound: BoundCard[] = [];
  for (const c of cards) bound.push(await execute<BoundCard>(validateOp(c)));
  const placements: Record<string, string | null> = { '01': null, '02': null, '03': null, '04': null, '05': null, '06': null };
  cards.forEach((c, i) => { placements[String(i + 1).padStart(2, '0')] = c.entry.id; });
  return { state: { ...initialVectorState(), cards: bound, layout: { placements, tray: [] } }, entries: cards.map(c => c.entry) };
}

describe('gate 1 · hardened product Worker realm', () => {
  it('the Worker source freezes its own intrinsics, cuts the dynamic-code links, and leaves the host realm untouched', () => {
    const realm = bootRealm();
    expect(realm.evaluate('[Math, Object, Array, Number, JSON, Object.prototype, Array.prototype, Function.prototype, Number.prototype].every(Object.isFrozen)')).toBe(true);
    expect(() => realm.evaluate("Function.prototype['constr' + 'uctor']('return 1')")).toThrow(/dynamic code/);
    expect(() => realm.evaluate("Object.getPrototypeOf({ *m() {} }.m)['constr' + 'uctor']('return 1')")).toThrow(/dynamic code/);
    // Generator and async-generator instance prototypes (reachable from generator methods) are frozen too.
    expect(realm.evaluate(`(() => {
      const chain = value => { const out = []; let p = Object.getPrototypeOf(value); while (p) { out.push(p); p = Object.getPrototypeOf(p); } return out; };
      const sync = new Function('return function* () {}')()(), asyncGen = new Function('return async function* () {}')()();
      return [...chain(sync).slice(1), ...chain(asyncGen).slice(1)].every(Object.isFrozen);
    })()`)).toBe(true);
    expect(Object.isFrozen(Math)).toBe(false);
    expect(Object.isFrozen(Object.prototype)).toBe(false);
    expect(typeof Function.prototype.constructor('return 1')).toBe('function');
  });

  it('honest cards (growth, extra steps, private store, a strong aggregate) give identical results hardened and on the host', async () => {
    const realm = bootRealm();
    const hardened = await boardFor(realm.execute, HONEST);
    const host = await boardFor(op => executeVectorOperation(clone(op)).then(clone) as Promise<never>, HONEST);
    expect(stable(hardened.state)).toBe(stable(host.state));
    const prepareOp: VectorOperation = { kind: 'prepare', state: hardened.state, entries: hardened.entries, id: 'p/s/1', native: NATIVE };
    const prepared = await realm.execute<PreparedVector>(clone(prepareOp));
    expect(stable(prepared)).toBe(stable(clone(await executeVectorOperation(clone(prepareOp)))));
    await expect(assertVectorResult(clone(prepareOp), prepared)).resolves.toBeDefined();
    // Strong stays strong: the aggregate is far above one effect's bound and the host guard accepts it.
    expect(prepared.result.finalState.shuttle['S+']).toBeGreaterThan(DEFAULT_SCRIPT_LIMITS.maxAbsNumber);
    // Extra steps apply: the trip is longer than the native budget.
    expect(prepared.result.visits).toBeGreaterThan(NATIVE.visitBudget);
    const acceptOp: VectorOperation = { kind: 'accept', state: hardened.state, prepared };
    const accepted = await realm.execute<VectorState>(clone(acceptOp));
    await expect(assertVectorResult(clone(acceptOp), accepted)).resolves.toBeDefined();
    expect(stable(accepted)).toBe(stable(clone(await executeVectorOperation(clone(acceptOp)))));
    const diary = Object.entries(accepted.session.scriptStates ?? {}).find(([key]) => key.startsWith('DIARY'))?.[1];
    expect(diary).toEqual({ pages: 1 });
    const store = Object.entries(accepted.session.carriedAccounts).find(([key]) => key.startsWith('script-store:STORE'))?.[1] ?? [];
    expect(store.every(entry => Object.values(entry.amounts).every(amount => amount >= 0))).toBe(true);
    const twice = await realm.execute<VectorState>(clone({ kind: 'accept', state: accepted, prepared }));
    expect(stable(twice)).toBe(stable(accepted));
  });

  const ATTACKS: Array<{ name: string; onVisit: string; rejects: RegExp; check?: string }> = [
    { name: 'rewrite a shared intrinsic', onVisit: "Math.min = Math.max; return { effects: [{ kind: 'add', channel: 'Y', amount: -3 }] };", rejects: /read.only|Cannot assign/i, check: 'Math.min(1, 2) === 1' },
    { name: 'rebind an allowlisted name', onVisit: "Math = { min: 0 }; return { effects: [] };", rejects: /Cannot assign|read.only|'set' on proxy/i, check: 'typeof Math.min === "function"' },
    { name: 'define on Object.prototype', onVisit: "Object.defineProperty(Object.getPrototypeOf({}), 'polluted', { value: 1 }); return { effects: [] };", rejects: /not extensible|Cannot define/i, check: '({}).polluted === undefined' },
    { name: 'reach globalThis through a function constructor', onVisit: "ctx.rng['constr' + 'uctor']('this.escaped = 1')(); return { effects: [] };", rejects: /dynamic code/, check: 'typeof escaped === "undefined"' },
    { name: 'reach globalThis through a generator constructor', onVisit: "const o = { *m() {} }; o.m['constr' + 'uctor']('this.escaped = 1')().next(); return { effects: [] };", rejects: /dynamic code/, check: 'typeof escaped === "undefined"' },
    { name: 'disable the validator, then return NaN', onVisit: "try { Number.isFinite = Boolean; Array.isArray = Boolean; } catch (e) {} return { effects: [{ kind: 'add', channel: 'J', amount: NaN }] };", rejects: /outside/, check: 'Number.isFinite(NaN) === false' },
  ];
  for (const attack of ATTACKS) {
    it(`blocks: ${attack.name}; the same realm keeps working for an honest card`, async () => {
      const realm = bootRealm();
      await expect(realm.execute(validateOp(card('ATTACK', attack.onVisit)))).rejects.toThrow(attack.rejects);
      if (attack.check) expect(realm.evaluate(attack.check)).toBe(true);
      await expect(realm.execute<BoundCard>(validateOp(HONEST[0]))).resolves.toMatchObject({ task: { entry: { id: 'DIARY' } } });
    });
  }

  it('hides every non-allowlisted global from card code (self, onmessage, postMessage, console, TextEncoder)', async () => {
    const realm = bootRealm();
    const seen = "(typeof self !== 'undefined' ? 1 : 0) + (typeof onmessage !== 'undefined' ? 1 : 0) + (typeof postMessage !== 'undefined' ? 1 : 0) + (typeof console !== 'undefined' ? 1 : 0) + (typeof TextEncoder !== 'undefined' ? 1 : 0)";
    await expect(realm.execute(validateOp(card('LOOK', `return ${seen} === 0 ? { effects: [] } : { effects: 'visible' };`)))).resolves.toBeDefined();
  });

  it('a getter cannot show the validator one value and the runner another', async () => {
    const realm = bootRealm();
    const sly = card('SLY', "let n = 0; return { get effects() { n = n + 1; return n > 1 ? [{ kind: 'add', channel: 'J', amount: 1000000000000 }] : []; } };");
    const { state, entries } = await boardFor(realm.execute, [sly]);
    const op: VectorOperation = { kind: 'prepare', state, entries, id: 'p/s/1', native: NATIVE };
    const prepared = await realm.execute<PreparedVector>(clone(op));
    expect(prepared.result.finalState.shuttle.J).toBe(0);
  });

  it('an own `__proto__` key cannot hide data from the determinism check or smuggle effects', async () => {
    const realm = bootRealm();
    const smuggle = card('SMUGGLE', "const o = {}; Object.defineProperty(o, ['__pro', 'to__'].join(''), { value: { effects: [{ kind: 'add', channel: 'J', amount: ctx.visitOrdinal }] }, enumerable: true, configurable: true, writable: true }); return o;");
    const { state, entries } = await boardFor(realm.execute, [smuggle]);
    const op: VectorOperation = { kind: 'prepare', state, entries, id: 'p/s/1', native: NATIVE };
    const prepared = await realm.execute<PreparedVector>(clone(op));
    const hash = state.cards[0].ref.hash;
    const applied = prepared.result.trace.filter(e => e.programHash === hash && e.deltas.length > 0);
    expect(applied).toEqual([]);
  });

  it('an own `constructor` key in a hook result is ordinary data, not a crash on the frozen prototype', async () => {
    const realm = bootRealm();
    const named = card('NAMED', "const o = { effects: [{ kind: 'add', channel: 'J', amount: 1 }] }; Object.defineProperty(o, ['constr', 'uctor'].join(''), { value: 1, enumerable: true, configurable: true, writable: true }); return o;");
    await expect(realm.execute<BoundCard>(validateOp(named))).resolves.toMatchObject({ task: { entry: { id: 'NAMED' } } });
  });

  it('one card that tries to tamper cannot change another card in the same run', async () => {
    const realm = bootRealm();
    const tamper = card('TAMPER', "let tampered = 1; try { Math.min = Math.max; } catch (e) { tampered = 0; } return { effects: [{ kind: 'add', channel: 'J', amount: 1 }], runState: { tampered: tampered } };");
    const drain = card('DRAIN', "return { effects: [{ kind: 'add', channel: 'Y', amount: -3 }] };");
    const { state, entries } = await boardFor(realm.execute, [tamper, drain]);
    const op: VectorOperation = { kind: 'prepare', state, entries, id: 'p/s/1', native: NATIVE };
    const prepared = await realm.execute<PreparedVector>(clone(op));
    await expect(assertVectorResult(clone(op), prepared)).resolves.toBeDefined();
    const y = prepared.result.trace.flatMap(e => e.deltas).filter(d => d.account === 'shuttle' && d.channelOrField === 'Y');
    expect(y.length).toBeGreaterThan(0);
    expect(y.every(d => d.after >= 0)).toBe(true);
    // The drain asked for −3 with less than 3 available: the untampered ledger clamps it at zero.
    expect(y.some(d => d.before < 3 && d.after === 0)).toBe(true);
    expect(prepared.result.finalState.shuttle.Y).toBeGreaterThanOrEqual(0);
    expect(prepared.result.pendingScriptAcceptances?.find(a => a.cardId === 'TAMPER')?.runState).toEqual({ tampered: 0 });
  });
});
