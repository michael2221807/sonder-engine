import type { CardGenesisCandidateV1 } from './types';
import { createScriptCardDef, type ScriptProgramRegistry } from './script-runtime';
import { buildSixCellBoard } from '../default-board';
import { compileBoard } from '../../../engine/plot-vector/core/policies';
import { run } from '../../../engine/plot-vector/core/runner';
import { createSession, commitRun } from '../../../engine/plot-vector/core/session';
import type { ScriptProgramRef } from '../../../engine/plot-vector/core/types';

/** This fixed fixture never reads the player's current board or build. */
export function probeGenerated(registry: ScriptProgramRegistry, candidate: CardGenesisCandidateV1, ref: ScriptProgramRef): string[] {
  const errors: string[] = [];
  for (const topology of ['line', 'ring'] as const) {
    const base = buildSixCellBoard({ topology });
    const card = createScriptCardDef(candidate, ref, { id: 'PROBE', tags: [], source: 'Codex' });
    const board = compileBoard({ ...base, cards: [card], talents: [], items: [],
      cells: base.cells.map(c => ({ ...c, effects: [], windows: undefined, capacity: undefined, buffer: undefined })) }, { triggerDefault: 'a' });
    let session = createSession();
    for (let round = 1; round <= 3; round++) {
      const result = run(board, { ...session, id: `probe-${topology}-${round}`, seed: 'fixed-probe',
        layout: { placements: { '02': 'PROBE' }, tray: [] }, actionLog: [], visitBudget: 10,
        options: { capacityEnabled: false, capacityScope: 'total', pickup: 'none', readout: { kind: 'N1', kappa: 10 } } }, { scripts: registry });
      if (result.status !== 'done') { errors.push(`${topology}: run did not complete`); break; }
      errors.push(...result.trace.filter(e => e.programHash === ref.hash && e.status === 'notTriggered' && e.reason).map(e => e.reason!));
      session = commitRun(session, board, result, registry);
      errors.push(...(session.scriptCommitLog ?? []).filter(e => e.status === 'failed').map(e => e.reason ?? 'accept failed'));
    }
  }
  return [...new Set(errors)];
}
