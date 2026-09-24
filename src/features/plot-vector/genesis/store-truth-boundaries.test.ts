/**
 * D194 independent boundary tests (Claude, 2026-09-24; D195 handoff §A), ported to the product location
 * after the bfed0b1 migration (gate 0) so they run in the product suite instead of the ignored local lab.
 *
 * Every assertion reads the ENGINE's private-store account, never the script's own runState mirror:
 * the balance seen by onVisit is the one BEFORE the visit and reflects the amount actually transferred
 * (not requested); a full cap keeps the overflow at the source; a zero source never inflates; a linear
 * endpoint fold runs the card once; expiry after commit falls back through the product progress reader;
 * a v2 card without a store sees an empty object; and a store request with nothing at the source is
 * rejected by the shared probe while a requested-amount mirror diverges from the real account.
 * (The archived D193 replay stays a local research diagnostic; it is not part of the product suite.)
 */
import { describe, expect, it } from 'vitest';
import { compileBoard } from '../../../engine/plot-vector/core/policies';
import { run, scriptStateKey, scriptStoreAccountId } from '../../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../../engine/plot-vector/core/session';
import type { BoardDef, Layout, RunDone, RunOptions, Settlement } from '../../../engine/plot-vector/core/types';
import { buildSixCellBoard } from '../default-board';
import type { CardGenesisCandidateV1 } from './types';
import { createScriptCardDef, ScriptProgramRegistry } from './script-runtime';
import { GENESIS_CATALOG } from './catalog';
import { probeGenerated } from './probe-generated';
import { parseAgaGenerationOutput } from './generation-prompt';
import { tasksAfterSave, type BoundCard } from './post-save';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorState } from '../runtime';
import { readCardProgress } from '../card-progress';
import { BASIC_SUPPLY_IDS } from '../basic-supply';

const OPTIONS: RunOptions = { capacityEnabled: false, capacityScope: 'total', pickup: 'none', readout: { kind: 'N1', kappa: 10 } };

function candidate(onVisit: string, onRoundAccepted: string | null = null, initialPersistentState: Record<string, number | boolean> = {}): CardGenesisCandidateV1 {
  return {
    version: 1,
    anchor: { commandIndex: 0, entrySelector: '角色.背包.物品.测试', entryKind: 'item', entryLabel: '测试', storyEvidence: '测试' },
    card: { name: '边界测试卡', description: '只用于 D194 边界测试', behaviorSummary: '按引擎账户结算', hooks: { onVisit, onRoundAccepted }, initialPersistentState },
  };
}
function blankBoard(cards: ReturnType<typeof createScriptCardDef>[], startPayload: Record<string, number>, topology: 'line' | 'ring' = 'line'): BoardDef {
  const base = buildSixCellBoard({ topology });
  return { ...base, id: `store-truth-${topology}`, cells: base.cells.map(cell => ({ ...cell, effects: [], windows: undefined, capacity: undefined, buffer: undefined })), cards, talents: [], items: [], startPayload };
}
function settlement(layout: Layout, session: VectorSession, visitBudget: number, id = 'store-truth'): Settlement {
  return { id, round: session.round, seed: 'store-truth-seed', layout, actionLog: [], options: OPTIONS,
    carriedAccounts: session.carriedAccounts, talentCharges: {}, itemUses: {}, resources: {}, visitBudget, scriptStates: session.scriptStates };
}
function done(value: ReturnType<typeof run>): RunDone { if (value.status !== 'done') throw new Error(JSON.stringify(value)); return value; }
const balance = (session: VectorSession, accountId: string, channel: string) => (session.carriedAccounts[accountId] ?? []).reduce((sum, e) => sum + (e.amounts[channel] ?? 0), 0);

describe('D194 · the private store seen by scripts is the engine account, not a mirror', () => {
  it('onVisit sees the balance before the visit and the actually transferred amount afterwards; a drained source moves nothing', async () => {
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const generated = candidate(`
      const seen = ctx.selfStore['S+'] || 0;
      const n = (ctx.runState.n || 0) + 1;
      return { effects: ctx.entryPort === 'L' ? [{ kind: 'store', store: 'self', channel: 'S+', amount: 6 }] : [], runState: { seen: seen, n: n } };
    `, "return { persistentState: { final: ctx.selfStore['S+'] || 0 } };", { final: 0 });
    generated.card.selfStore = { cap: 40, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] };
    const ref = await registry.register(generated);
    const card = createScriptCardDef(generated, ref, { id: 'GEN', tags: [], source: 'Model' });
    const board = compileBoard(blankBoard([card], { 'S+': 4, 'S-': 0, Y: 0, J: 0 }, 'ring'), { triggerDefault: 'a' });
    const storeId = scriptStoreAccountId('GEN', ref);
    const session = createSession();
    const result = done(run(board, settlement({ placements: { '02': 'GEN' }, tray: [] }, session, 10), { scripts: registry }));
    const events = result.trace.filter(e => e.programHash === ref.hash && e.eventType === 'effect');
    expect(events.map(e => e.status)).toEqual(['applied', 'notTriggered']);
    expect(events[1].reason).toContain('nothing to transfer');
    expect(result.finalState.accounts[storeId].byChannel['S+']).toBe(4);
    expect(result.finalState.shuttle['S+']).toBe(0);
    const acceptance = result.pendingScriptAcceptances?.find(a => a.ref.hash === ref.hash);
    expect(acceptance?.runState).toEqual({ seen: 4, n: 2 });
    const committed = commitRun(session, board, result, registry);
    expect(committed.scriptStates?.[scriptStateKey('GEN', ref)]).toEqual({ final: 4 });
    expect(balance(committed, storeId, 'S+')).toBe(4);
  });

  it('a full cap keeps the overflow at the source; the store balance does not inflate', async () => {
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const generated = candidate(`
      const seen = ctx.selfStore['S+'] || 0;
      return { effects: ctx.entryPort === 'L' ? [{ kind: 'store', store: 'self', channel: 'S+', amount: 6 }] : [], runState: { seen: seen } };
    `);
    generated.card.selfStore = { cap: 3, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] };
    const ref = await registry.register(generated);
    const card = createScriptCardDef(generated, ref, { id: 'GEN', tags: [], source: 'Model' });
    const board = compileBoard(blankBoard([card], { 'S+': 5, 'S-': 0, Y: 0, J: 0 }, 'ring'), { triggerDefault: 'a' });
    const storeId = scriptStoreAccountId('GEN', ref);
    const result = done(run(board, settlement({ placements: { '01': 'GEN' }, tray: [] }, createSession(), 7), { scripts: registry }));
    const events = result.trace.filter(e => e.programHash === ref.hash && e.eventType === 'effect');
    expect(events).toHaveLength(2);
    expect(events.map(e => e.reasonCode)).toEqual(['stayedAtSource', 'stayedAtSource']);
    expect(result.finalState.accounts[storeId].byChannel['S+']).toBe(3);
    expect(result.finalState.shuttle['S+']).toBe(2);
  });

  it('a zero source stores nothing in the run, in the committed account and in the acceptance hook', async () => {
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const generated = candidate(
      "return { effects: [{ kind: 'store', store: 'self', channel: 'S+', amount: 6 }] };",
      "return { persistentState: { final: ctx.selfStore['S+'] || 0 } };", { final: 0 });
    generated.card.selfStore = { cap: 40, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] };
    const ref = await registry.register(generated);
    const card = createScriptCardDef(generated, ref, { id: 'GEN', tags: [], source: 'Model' });
    const board = compileBoard(blankBoard([card], { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, 'ring'), { triggerDefault: 'a' });
    const storeId = scriptStoreAccountId('GEN', ref);
    const session = createSession();
    const result = done(run(board, settlement({ placements: { '03': 'GEN' }, tray: [] }, session, 9), { scripts: registry }));
    expect(result.trace.filter(e => e.programHash === ref.hash && e.eventType === 'effect').every(e => e.status === 'notTriggered')).toBe(true);
    expect(result.finalState.accounts[storeId].byChannel['S+'] ?? 0).toBe(0);
    const committed = commitRun(session, board, result, registry);
    expect(committed.carriedAccounts[storeId] ?? []).toEqual([]);
    expect(committed.scriptStates?.[scriptStateKey('GEN', ref)]).toEqual({ final: 0 });
  });

  it('the linear endpoint fold executes a store card once, so one visit stores once', async () => {
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const generated = candidate("return { effects: [{ kind: 'store', store: 'self', channel: 'S+', amount: 2 }] };");
    generated.card.selfStore = { cap: 40, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] };
    const ref = await registry.register(generated);
    const card = createScriptCardDef(generated, ref, { id: 'GEN', tags: [], source: 'Model' });
    const board = compileBoard(blankBoard([card], { 'S+': 10, 'S-': 0, Y: 0, J: 0 }, 'line'), { triggerDefault: 'a' });
    const storeId = scriptStoreAccountId('GEN', ref);
    const result = done(run(board, settlement({ placements: { '06': 'GEN' }, tray: [] }, createSession(), 12), { scripts: registry }));
    const events = result.trace.filter(e => e.programHash === ref.hash && e.eventType === 'effect');
    expect(events).toHaveLength(1);
    expect(events[0].cellId).toBe('06');
    expect(result.finalState.accounts[storeId].byChannel['S+']).toBe(2);
    expect(result.finalState.shuttle['S+']).toBe(8);
  });

  it('through the product runtime: preview never touches the session, and an expired store reads back as 0 with the right delta', async () => {
    const entry = { id: 'store-item', kind: 'item' as const, capability: { name: '保温杯', description: '短暂存热' } };
    const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
    const bound = await executeVectorOperation({ kind: 'validate', task, attempts: 1, output: { version: 3, card: {
      hooks: { onVisit: `
        const room = 3 - (ctx.selfStore['S+'] || 0);
        const available = ctx.shuttle['S+'] || 0;
        return { effects: room > 0 && available > 0 ? [{ kind: 'store', store: 'self', channel: 'S+', amount: Math.min(room, available) }] : [] };
      `, onRoundAccepted: null },
      selfStore: { cap: 3, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] }, initialPersistentState: {} } } }) as BoundCard;
    const state: VectorState = { ...initialVectorState(), cards: [bound], layout: { placements: { '02': entry.id }, tray: [] } };
    const rich = { ruleId: 'test', payload: { 'S+': 5, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
    const empty = { ruleId: 'test', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
    const sessionBefore = JSON.stringify(state.session);
    const first = await executeVectorOperation({ kind: 'prepare', state, entries: [entry], id: 'r1', native: rich }) as PreparedVector;
    const preview = await executeVectorOperation({ kind: 'prepare', state, entries: [entry], id: 'r1-preview', native: rich }) as PreparedVector;
    expect(JSON.stringify(state.session)).toBe(sessionBefore);
    expect(first.progress?.[0].rows[0]).toMatchObject({ key: 'store:S+', value: 0, max: 3 });
    expect(preview.progress).toEqual(first.progress);
    const round1 = await executeVectorOperation({ kind: 'accept', state, prepared: first }) as VectorState;
    expect(round1.last?.progress?.[0].rows[0]).toMatchObject({ value: 3, delta: 3 });
    const accountId = scriptStoreAccountId(entry.id, bound.ref);
    expect(balance(round1.session, accountId, 'S+')).toBe(3);
    const second = await executeVectorOperation({ kind: 'prepare', state: round1, entries: [entry], id: 'r2', native: empty }) as PreparedVector;
    expect(second.progress?.[0].rows[0]).toMatchObject({ value: 3 });
    const round2 = await executeVectorOperation({ kind: 'accept', state: round1, prepared: second }) as VectorState;
    expect(round2.last?.progress?.[0].rows[0]).toMatchObject({ value: 0, delta: -3 });
    expect(balance(round2.session, accountId, 'S+')).toBe(0);
    expect(Object.entries(round2.session.scriptStates ?? {}).filter(([key]) => !BASIC_SUPPLY_IDS.some(id => key.startsWith(`${id}:`))).map(([, value]) => value)).toEqual([{}]);
    expect(readCardProgress([bound], round2.session)[0].rows[0]).toMatchObject({ key: 'store:S+', value: 0, max: 3 });
  });

  it('a v2 card without a private store sees an empty selfStore and shows no store rows (old raw stays readable)', async () => {
    const entry = { id: 'plain-item', kind: 'item' as const, capability: { name: '普通本子', description: '记事' } };
    const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
    const bound = await executeVectorOperation({ kind: 'validate', task, attempts: 1, output: parseAgaGenerationOutput(JSON.stringify({ version: 2, card: {
      name: '普通本子', description: '每次经过加 1 点机会', behaviorSummary: '加机会',
      hooks: { onVisit: "return { effects: [{ kind: 'add', channel: 'J', amount: ctx.selfStore['S+'] === undefined ? 1 : 100 }] };", onRoundAccepted: null },
      initialPersistentState: {},
    } })) }) as BoundCard;
    expect(bound.candidate.card.selfStore).toBeUndefined();
    const state: VectorState = { ...initialVectorState(), cards: [bound], layout: { placements: { '01': entry.id }, tray: [] } };
    const native = { ruleId: 'test', payload: { 'S+': 1, 'S-': 0, Y: 0, J: 0 }, visitBudget: 6, contributions: [] };
    const prepared = await executeVectorOperation({ kind: 'prepare', state, entries: [entry], id: 'v2', native }) as PreparedVector;
    expect(prepared.result.finalState.shuttle.J).toBe(1);
    expect(prepared.progress?.filter(p => !BASIC_SUPPLY_IDS.includes(p.cardId))).toEqual([]);
  });

  it('a store request with nothing at the source is rejected by the shared probe, and a requested-amount mirror diverges from the real account', async () => {
    // Self-contained stand-in for the archived D193 diagnostic: the general rule, not the historical sample.
    const onVisit = "const stored = ctx.runState.stored || 0; return { effects: [{ kind: 'store', store: 'self', channel: 'S+', amount: 6 }], runState: { stored: stored + 6 } };";
    const generated = candidate(onVisit, null, {});
    generated.card.selfStore = { cap: 40, lifetimeRounds: 2, allowedIn: ['S+'], allowedOut: ['S+'] };
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const ref = await registry.register(generated);
    expect(probeGenerated(registry, generated, ref).join('; ')).toMatch(/nothing to transfer/);
    const card = createScriptCardDef(generated, ref, { id: 'MIRROR', tags: [], source: 'Model' });
    const board = compileBoard(blankBoard([card], { 'S+': 4, 'S-': 0, Y: 0, J: 0 }, 'ring'), { triggerDefault: 'a' });
    const result = done(run(board, settlement({ placements: { '02': 'MIRROR' }, tray: [] }, createSession(), 10), { scripts: registry }));
    expect(result.finalState.accounts[scriptStoreAccountId('MIRROR', ref)].byChannel['S+']).toBe(4);
    expect(result.pendingScriptAcceptances?.find(a => a.ref.hash === ref.hash)?.runState).toEqual({ stored: 12 });
  });
});
