/**
 * PreProcessStage × 存档瘦身 D2B: at round start, before the snapshot, a retrieval trace outside the latest five
 * completed rounds keeps only its injected candidates (with the count of every outcome). Only the traces that left the
 * window are written, and the window is the one the load-time format upgrade uses: a tree the rounds wrote has nothing
 * left for the upgrade to change.
 */
import { describe, it, expect, vi } from 'vitest';
import { PreProcessStage } from './pre-process';
import { StateManager } from '../../core/state-manager';
import { RollbackSnapshot } from '../../core/rollback-snapshot';
import { DEFAULT_ENGINE_PATHS, type PipelineContext } from '../types';
import { upgradeSaveFormat } from '../../persistence/save-format/save-format-migration';

const P = DEFAULT_ENGINE_PATHS;
const SAVE_FORMAT_PATHS = {
  narrativeHistory: P.narrativeHistory, preRoundSnapshot: P.preRoundSnapshot, rollbackPatch: P.rollbackPatch,
  roundNumber: P.roundNumber, saveFormat: P.saveFormat,
};
type Json = Record<string, unknown>;

const trace = (round: number): Json => ({
  query: `问${round}`,
  candidates: [
    { text: `用上${round}`, outcome: 'injected' },
    { text: `落选${round}`, outcome: 'filtered-by-topK' },
    { text: `重复${round}`, outcome: 'filtered-as-redundant' },
  ],
});

const ctx = (): PipelineContext => ({ userInput: '继续', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [], roundNumber: 0, meta: {} }) as unknown as PipelineContext;

/** What PostProcess adds for a round: the player's entry and the reply with its trace. */
function finishRound(sm: StateManager, round: number): void {
  sm.push(P.narrativeHistory, { role: 'user', content: `输入${round}` }, 'system');
  sm.push(P.narrativeHistory, { role: 'assistant', content: `正文${round}`, _engramRead: trace(round) }, 'system');
}

function game(rounds: number): StateManager {
  const sm = new StateManager();
  const history: Json[] = [];
  for (let round = 1; round <= rounds; round++) {
    history.push({ role: 'user', content: `输入${round}` }, { role: 'assistant', content: `正文${round}`, _engramRead: trace(round) });
  }
  sm.loadTree({ 元数据: { 回合序号: rounds, 叙事历史: history }, 系统: { 扩展: {} } });
  return sm;
}

const traceOf = (sm: StateManager, round: number): Json => sm.get<Json>(`${P.narrativeHistory}.${round * 2 - 1}._engramRead`)!;

describe('PreProcessStage · retrieval traces outside the latest five rounds (存档瘦身 D2B)', () => {
  it('trims the traces that left the window before the snapshot is taken; the rest stay whole', async () => {
    const sm = game(7);
    const holder = new RollbackSnapshot(P);
    await new PreProcessStage(sm, { consumeActions: () => [] }, P, holder).execute(ctx());

    for (const round of [1, 2]) {
      expect(traceOf(sm, round)).toEqual({
        query: `问${round}`,
        candidates: [{ text: `用上${round}`, outcome: 'injected' }],
        trimmed: { counts: { injected: 1, 'filtered-by-topK': 1, 'filtered-as-redundant': 1 } },
      });
    }
    for (const round of [3, 4, 5, 6, 7]) expect(traceOf(sm, round)).toEqual(trace(round));
    // The snapshot holds the same entries trimmed.
    const held = holder.get(sm.get(P.rollbackPatch)) as { 元数据: { 叙事历史: Json[] } };
    expect(held.元数据.叙事历史[1]._engramRead).toEqual(traceOf(sm, 1));
    expect(held.元数据.叙事历史[5]._engramRead).toEqual(trace(3));
  });

  it('at the next round start writes only the trace that just left the window', async () => {
    const sm = game(7);
    const stage = new PreProcessStage(sm, { consumeActions: () => [] }, P, new RollbackSnapshot(P));
    await stage.execute(ctx());
    finishRound(sm, 8);
    const set = vi.spyOn(sm, 'set');
    await stage.execute(ctx());
    const traceWrites = set.mock.calls.map((call) => call[0]).filter((path) => path.endsWith('._engramRead'));
    expect(traceWrites).toEqual([`${P.narrativeHistory}.5._engramRead`]);
    expect(traceOf(sm, 3).trimmed).toBeDefined();
    expect(traceOf(sm, 4)).toEqual(trace(4));
  });

  it('leaves a history of five rounds or fewer as it is', async () => {
    const sm = game(5);
    const set = vi.spyOn(sm, 'set');
    await new PreProcessStage(sm, { consumeActions: () => [] }, P, new RollbackSnapshot(P)).execute(ctx());
    expect(set.mock.calls.some((call) => call[0].endsWith('._engramRead'))).toBe(false);
  });

  it('uses the window the load-time upgrade uses: a tree the rounds wrote comes back from it as the same object', async () => {
    const sm = game(3);
    const holder = new RollbackSnapshot(P);
    const stage = new PreProcessStage(sm, { consumeActions: () => [] }, P, holder);
    for (let round = 4; round <= 12; round++) {
      await stage.execute(ctx());
      finishRound(sm, round);
      const saved = JSON.parse(JSON.stringify(holder.treeToSave(sm.liveTree()))) as Json;
      const upgrade = upgradeSaveFormat(saved, SAVE_FORMAT_PATHS);
      expect(upgrade.changed).toBe(false);
      expect(upgrade.tree).toBe(saved);
    }
  });
});
