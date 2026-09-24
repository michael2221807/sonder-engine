import type { AccountSnapshot, CompiledBoard, RunDone, CardStates, ScriptProgramRuntime, ScriptState } from './types';
import { ageSnapshot } from './accounts';
import { accountDefsOf, scriptStateKey, scriptStoreAccountId } from './runner';

/**
 * Host-side state that outlives a single settlement: the round index, carried
 * accounts, consumable budgets and edge-cost resources (e.g. return chances).
 * The AGA host owns this state; the runner never mutates it.
 */
export interface VectorSession {
  cardStates?: CardStates;
  round: number;
  carriedAccounts: AccountSnapshot;
  talentCharges: Record<string, number>;
  itemUses: Record<string, number>;
  /** Budgets for edge costs (`EdgeDef.cost` keys), e.g. { returnChance: 1 }. */
  resources: Record<string, number>;
  /** Settlement ids already committed; a repeated commit is a no-op (D74 #1). */
  committed: string[];
  scriptStates?: Record<string, ScriptState>;
  scriptCommitLog?: Array<{ settlementId: string; cardId: string; programHash: string; status: 'applied' | 'failed'; reason?: string }>;
}

export interface SessionInit {
  cardStates?: CardStates;
  talentCharges?: Record<string, number>;
  itemUses?: Record<string, number>;
  resources?: Record<string, number>;
  scriptStates?: Record<string, ScriptState>;
}

export function createSession(init: SessionInit = {}): VectorSession {
  return {
    round: 1,
    carriedAccounts: {},
    talentCharges: { ...(init.talentCharges ?? {}) },
    itemUses: { ...(init.itemUses ?? {}) },
    resources: { ...(init.resources ?? {}) },
    committed: [],
    cardStates: init.cardStates ? { ...init.cardStates } : undefined,
    scriptStates: init.scriptStates ? { ...init.scriptStates } : {},
    scriptCommitLog: [],
  };
}

/**
 * Commit an accepted run: persist `acrossRounds` accounts (aged for the next round),
 * consume charges / uses / edge resources from pendingCosts, advance the round.
 * Pure and idempotent: committing a settlement id that was already committed
 * returns the session unchanged, so retries can never double-charge.
 */
export function commitRun(
  session: VectorSession,
  board: CompiledBoard,
  result: RunDone,
  scripts?: ScriptProgramRuntime,
): VectorSession {
  if (session.committed.includes(result.settlementId)) return session;
  const nextRound = session.round + 1;
  const talentCharges = { ...session.talentCharges };
  for (const [id, n] of Object.entries(result.pendingCosts.talentCharges)) talentCharges[id] = (talentCharges[id] ?? 0) - n;
  const itemUses = { ...session.itemUses };
  for (const [id, n] of Object.entries(result.pendingCosts.itemUses)) itemUses[id] = (itemUses[id] ?? 0) - n;
  const resources = { ...session.resources };
  for (const [k, n] of Object.entries(result.pendingCosts.edgeCosts)) resources[k] = (resources[k] ?? 0) - n;
  const scriptStates: Record<string, ScriptState> = { ...(session.scriptStates ?? {}) };
  const scriptCommitLog = [...(session.scriptCommitLog ?? [])];
  for (const input of result.pendingScriptAcceptances ?? []) {
    const stateKey = scriptStateKey(input.cardId, input.ref);
    if (!scripts) {
      scriptCommitLog.push({ settlementId: result.settlementId, cardId: input.cardId, programHash: input.ref.hash, status: 'failed', reason: 'script runtime unavailable' });
      continue;
    }
    const entries = result.pendingAccounts[scriptStoreAccountId(input.cardId, input.ref)] ?? [];
    const selfStore = entries.reduce<Record<string, number>>((balance, entry) => {
      for (const [channel, amount] of Object.entries(entry.amounts)) {
        balance[channel] = (balance[channel] ?? 0) + amount;
      }
      return balance;
    }, {});
    const accepted = scripts.accept({
      ...input,
      // The account snapshot is the authority, including cap and actual source
      // quantity. Older pending acceptance records need no migration.
      selfStore,
      persistentState: scriptStates[stateKey] ?? scriptStates[input.ref.hash] ?? input.persistentState,
    });
    if (accepted.ok) {
      scriptStates[stateKey] = { ...accepted.persistentState };
      scriptCommitLog.push({ settlementId: result.settlementId, cardId: input.cardId, programHash: input.ref.hash, status: 'applied' });
    } else {
      scriptCommitLog.push({ settlementId: result.settlementId, cardId: input.cardId, programHash: input.ref.hash, status: 'failed', reason: accepted.reason });
    }
  }
  return {
    round: nextRound,
    cardStates: result.pendingCardStates ?? session.cardStates,
    carriedAccounts: ageSnapshot(result.pendingAccounts, accountDefsOf(board), nextRound),
    talentCharges,
    itemUses,
    resources,
    committed: [...session.committed, result.settlementId],
    scriptStates,
    scriptCommitLog,
  };
}
