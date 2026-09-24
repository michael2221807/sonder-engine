/**
 * Engine card-use rules that any formal consumable wiring relies on (charter C3), through the same
 * `createScriptCardDef(..., { usage })` entry point such wiring would use. No usage source is wired in
 * the product yet (that needs a PO decision); this only pins the engine behavior underneath it.
 */
import { describe, expect, it } from 'vitest';
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../engine/plot-vector/core/session';
import type { RunDone, RunOptions } from '../../engine/plot-vector/core/types';
import { buildSixCellBoard } from './default-board';
import { createScriptCardDef, ScriptProgramRegistry } from './genesis/script-runtime';
import { GENESIS_CATALOG } from './genesis/catalog';
import type { CardGenesisCandidateV1 } from './genesis/types';

const OPTIONS: RunOptions = { capacityEnabled: false, capacityScope: 'total', pickup: 'none', readout: { kind: 'N1', kappa: 10 } };
const tea: CardGenesisCandidateV1 = { version: 1,
  anchor: { commandIndex: 0, entrySelector: 'item:tea', entryKind: 'item', entryLabel: 'tea', storyEvidence: '' },
  card: { name: '茶', description: '每次经过加 1 点机会', behaviorSummary: '加机会', initialPersistentState: {},
    hooks: { onVisit: "return { effects: [{ kind: 'add', channel: 'J', amount: 1 }] };", onRoundAccepted: null } } };

async function setup(stock: number) {
  const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
  const ref = await registry.register(tea);
  const card = createScriptCardDef(tea, ref, { id: 'item:tea', tags: [], source: 'Model', usage: { kind: 'consumable', initialStock: 3, maxStock: 3 } });
  const base = buildSixCellBoard({ topology: 'ring' });
  const board = compileBoard({ ...base, startPayload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, talents: [], items: [], cards: [card],
    cells: base.cells.map(c => ({ ...c, effects: [], windows: undefined, capacity: undefined, buffer: undefined })) }, { triggerDefault: 'a' });
  const session: VectorSession = { ...createSession(), cardStates: { 'item:tea': { stacks: 0, stock, charges: 0 } } };
  const trip = (s: VectorSession, id: string) => {
    const result = run(board, { ...s, id, seed: id, layout: { placements: { '02': 'item:tea' }, tray: [] }, actionLog: [], visitBudget: 14, options: OPTIONS }, { scripts: registry });
    if (result.status !== 'done') throw new Error(JSON.stringify(result));
    return result as RunDone;
  };
  return { board, registry, session, trip };
}

describe('card use: once per accepted round, never on preview', () => {
  it('several passes over the card in one trip deduct one use; the deduction lands only on commit', async () => {
    const h = await setup(3);
    const result = h.trip(h.session, 'r1');
    expect(result.visitCounts['02']).toBeGreaterThan(1);
    const applied = result.trace.filter(e => e.owner?.id === 'item:tea' && e.status === 'applied');
    expect(applied.length).toBe(result.visitCounts['02']); // the effect fires on every pass
    expect(result.pendingCardStates?.['item:tea']?.stock).toBe(2);
    expect(h.session.cardStates?.['item:tea']?.stock).toBe(3); // a preview changes nothing
    const committed = commitRun(h.session, h.board, result, h.registry);
    expect(committed.cardStates?.['item:tea']?.stock).toBe(2);
    expect(commitRun(committed, h.board, result, h.registry)).toBe(committed); // a repeated commit is a no-op
  });
  it('with no uses left the card does not fire and nothing is deducted', async () => {
    const h = await setup(0);
    const result = h.trip(h.session, 'r1');
    expect(result.trace.some(e => e.owner?.id === 'item:tea' && e.status === 'applied')).toBe(false);
    expect(result.pendingCardStates?.['item:tea']?.stock).toBe(0);
  });
});
