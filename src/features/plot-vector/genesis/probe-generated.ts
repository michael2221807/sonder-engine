import type { CardGenesisCandidateV1 } from './types';
import { createScriptCardDef, type ScriptProgramRegistry } from './script-runtime';
import { buildSixCellBoard } from '../default-board';
import { compileBoard } from '../../../engine/plot-vector/core/policies';
import { run } from '../../../engine/plot-vector/core/runner';
import { createSession, commitRun } from '../../../engine/plot-vector/core/session';
import type { ReasonCode, ScriptProgramRef, TraceEvent } from '../../../engine/plot-vector/core/types';

/**
 * Outcomes that mean "nothing to do this time", not a broken ability: a store or release with nothing at
 * its source, or a card with no uses left. They follow from the fixture's empty accounts, not from the code.
 * Everything else still rejects the card: script failures (compile, exception, timeout, illegal return,
 * non-determinism) carry no reason code, and `notAuthorised` is a move outside the card's declared store.
 */
const NORMAL_OUTCOMES: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['nothingToTransfer', 'noUses']);
const isError = (outcome: { reasonCode?: ReasonCode }) => !outcome.reasonCode || !NORMAL_OUTCOMES.has(outcome.reasonCode);

/** Why this event shows the ability is broken, if it does. Exported for its classification tests. */
export function probeErrorsOf(event: TraceEvent): string[] {
  const errors: string[] = [];
  // The script itself did not run to a result (no reason code), or its only outcome was an error.
  if (event.status === 'notTriggered' && event.reason && !event.scriptIssues?.length && isError(event)) errors.push(event.reason);
  // Each operation of the visit, so a normal outcome can never hide an error before or after it.
  for (const issue of event.scriptIssues ?? []) if (isError(issue)) errors.push(issue.reason);
  return errors;
}

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
      errors.push(...result.trace.filter(e => e.programHash === ref.hash).flatMap(probeErrorsOf));
      session = commitRun(session, board, result, registry);
      errors.push(...(session.scriptCommitLog ?? []).filter(e => e.status === 'failed').map(e => e.reason ?? 'accept failed'));
    }
  }
  return [...new Set(errors)];
}
