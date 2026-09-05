// App doc: docs/user-guide/pages/game-prompts.md §叙事契约 (contract tab data flow)
// Design: docs/design/narrative-contract-positioning.md §4.4 · docs/design/narrative-contract-v1-implementation-plan.md S2
/**
 * useNarrativeContract — the contract tab's single read/write port.
 *
 * Reads the contract straight from the state tree (`DEFAULT_ENGINE_PATHS.narrativeContract`)
 * so it rolls back with the round and rides save / backup / cloud sync / card for free;
 * every write goes through `useGameState().setValue` and then asks the engine to persist
 * (`engine:request-save`, the same path `useCapturedSettings` uses) — the tab lives
 * OUTSIDE the round pipeline, so nothing else would hit the disk.
 *
 * The focal cast is NOT stored: it is derived every render from the relationship list
 * with the same rule the engine applies at prompt time (`resolveFocalCast`), so what the
 * tab shows is exactly what the model will be told.
 */
import { computed } from 'vue';
import { useGameState } from './useGameState';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import {
  readNarrativeContract,
  resolveFocalCast,
  type NarrativeContractClause,
  type NarrativeContractState,
} from '@/engine/prompt/narrative-contract';

const paths = DEFAULT_ENGINE_PATHS;

/** Clause text is one sentence; the pack fragments frame it, so keep it short. */
export const CONTRACT_CLAUSE_MAX_CHARS = 200;

function newClauseId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useNarrativeContract() {
  const { get, setValue, useValue } = useGameState();

  const raw = useValue<unknown>(paths.narrativeContract);
  const relationships = useValue<unknown>(paths.relationships);

  /** Normalised view of the stored contract (missing / malformed → empty contract). */
  const contract = computed<NarrativeContractState>(() => readNarrativeContract({ get: () => raw.value as never }, paths));
  const clauses = computed<NarrativeContractClause[]>(() => contract.value.clauses);
  const enabled = computed<boolean>(() => contract.value.enabled);
  /** 「重点」 ∪ 「关注」 from the relationship list — the names the prompt will carry. */
  const focalCast = computed<string[]>(() => resolveFocalCast(relationships.value, paths));

  function write(next: NarrativeContractState): void {
    setValue(paths.narrativeContract, next);
    eventBus.emit('engine:request-save', undefined);
  }

  function setEnabled(value: boolean): void {
    write({ ...contract.value, enabled: value });
  }

  /** Adds a player clause; returns false (and writes nothing) for blank or over-long text. */
  function addClause(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > CONTRACT_CLAUSE_MAX_CHARS) return false;
    const clause: NarrativeContractClause = {
      id: newClauseId(),
      text: trimmed,
      enabled: true,
      source: 'player',
      createdRound: get<number>(paths.roundNumber) ?? 0,
    };
    write({ ...contract.value, clauses: [...contract.value.clauses, clause] });
    return true;
  }

  function updateClauseText(id: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > CONTRACT_CLAUSE_MAX_CHARS) return false;
    const current = contract.value.clauses.find((c) => c.id === id);
    if (!current || current.text === trimmed) return current !== undefined;
    write({ ...contract.value, clauses: contract.value.clauses.map((c) => (c.id === id ? { ...c, text: trimmed } : c)) });
    return true;
  }

  function toggleClause(id: string): void {
    write({ ...contract.value, clauses: contract.value.clauses.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)) });
  }

  function removeClause(id: string): void {
    write({ ...contract.value, clauses: contract.value.clauses.filter((c) => c.id !== id) });
  }

  return { contract, clauses, enabled, focalCast, setEnabled, addClause, updateClauseText, toggleClause, removeClause };
}
