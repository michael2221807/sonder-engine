import type { AccountSnapshot, CardStates, CompiledBoard, RunDone } from './types';
import { ageSnapshot } from './accounts';
import { accountDefsOf } from './runner';

/**
 * Host-side state that outlives a single trip: the round index, carried accounts (card stores) and
 * card uses. The host owns it; the runner never mutates it.
 */
export interface VectorSession {
  round: number;
  carriedAccounts: AccountSnapshot;
  cardStates?: CardStates;
  /** Recently committed settlement ids (the last COMMITTED_KEPT); a repeated commit is a no-op. */
  committed: string[];
}
/** A repeated commit is a retry of a recent round, so only this many recent ids are kept. */
export const COMMITTED_KEPT = 64;

export function createSession(): VectorSession {
  return { round: 1, carriedAccounts: {}, committed: [] };
}

/**
 * Commit an accepted trip: persist `acrossRounds` accounts (aged for the next round) and card uses,
 * advance the round. Pure and idempotent: a settlement id already committed changes nothing.
 */
export function commitRun(session: VectorSession, board: CompiledBoard, result: RunDone): VectorSession {
  if (session.committed.includes(result.settlementId)) return session;
  const nextRound = session.round + 1;
  return {
    round: nextRound,
    cardStates: result.pendingCardStates,
    carriedAccounts: ageSnapshot(result.pendingAccounts, accountDefsOf(board), nextRound),
    committed: [...session.committed, result.settlementId].slice(-COMMITTED_KEPT),
  };
}
