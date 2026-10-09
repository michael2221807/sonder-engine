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

  it('agrees with the upgrade in every shape a history takes: an opening, failed rounds, saves mid-round, notices', async () => {
    // An opening reply with no player entry before it and no trace; system notices between rounds; a reply without a
    // trace; a round whose reply never came (failed, rolled back to its start); a save while the round runs.
    const sm = new StateManager();
    sm.loadTree({ 元数据: { 回合序号: 0, 叙事历史: [{ role: 'assistant', content: '开场' }] }, 系统: { 扩展: {} } });
    const holder = new RollbackSnapshot(P);
    const stage = new PreProcessStage(sm, { consumeActions: () => [] }, P, holder);
    const unchanged = (label: string) => {
      const saved = JSON.parse(JSON.stringify(holder.treeToSave(sm.liveTree()))) as Json;
      const upgrade = upgradeSaveFormat(saved, SAVE_FORMAT_PATHS);
      expect({ label, changed: upgrade.changed, same: upgrade.tree === saved }).toEqual({ label, changed: false, same: true });
    };
    for (let round = 1; round <= 14; round++) {
      await stage.execute(ctx());
      unchanged(`round ${round}, right after the round start`);
      sm.push(P.narrativeHistory, { role: 'user', content: `输入${round}` }, 'system');
      unchanged(`round ${round}, mid-round`);
      if (round % 5 === 0) {
        // The reply failed: the round rolls back to its start.
        sm.rollbackTo(holder.get(sm.get(P.rollbackPatch)) as Json);
        holder.clear();
        unchanged(`round ${round}, rolled back`);
        continue;
      }
      const reply: Json = { role: 'assistant', content: `正文${round}` };
      if (round % 4 !== 0) reply._engramRead = trace(round);
      sm.push(P.narrativeHistory, reply, 'system');
      if (round % 3 === 0) sm.push(P.narrativeHistory, { role: 'system', content: `提示${round}` }, 'system');
      unchanged(`round ${round}, done`);
    }
    // The window did move: the early traces are trimmed.
    const history = sm.get<Json[]>(P.narrativeHistory)!;
    const trimmed = history.filter((e) => (e._engramRead as Json | undefined)?.trimmed !== undefined).length;
    expect(trimmed).toBeGreaterThan(2);
  });

  it('a trim that throws never stops the round: it is logged and the round starts as before', async () => {
    const sm = game(7);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const realGet = sm.get.bind(sm);
    vi.spyOn(sm, 'liveTree').mockImplementation(() => { throw new Error('trace store broken'); });
    const holder = new RollbackSnapshot(P);
    await new PreProcessStage(sm, { consumeActions: () => [] }, P, holder).execute(ctx());
    expect(warn).toHaveBeenCalledWith('[PreProcess] Trimming old retrieval traces failed; the round goes on with them as they are:', expect.any(Error));
    expect(holder.get(realGet(P.rollbackPatch))).toBeDefined();
    expect(traceOf(sm, 1)).toEqual(trace(1));
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
