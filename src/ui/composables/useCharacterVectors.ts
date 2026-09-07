// App doc: docs/user-guide/pages/game-relationships.md §人物向量 (vector card data flow)
// Design: docs/design/character-vector-v1-implementation-plan.md S3
/**
 * useCharacterVectors — the single read/write port for the per-NPC "potential vectors".
 *
 * Reads straight from the state tree (`DEFAULT_ENGINE_PATHS.characterVectors`) so the
 * vectors roll back with the round and ride save / backup / cloud sync / card for free;
 * every write goes through `useGameState().setValue` and then asks the engine to persist
 * (`engine:request-save`) — the panels live OUTSIDE the round pipeline.
 *
 * World-written entries (`source: 'proposed'`) are first-class here: the player edits or
 * deletes them like any other, never "accepts" them (PO decision, 2026-09-05).
 */
import { computed } from 'vue';
import { useGameState } from './useGameState';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import {
  readCharacterVectors,
  activeVectorEntries,
  resolveVectorScope,
  lastNarrativeText,
  CHARACTER_VECTOR_LINE_MAX_CHARS,
  CHARACTER_VECTOR_HIDDEN_MAX_CHARS,
  type CharacterVectorEntry,
  type CharacterVectorsState,
} from '@/engine/prompt/character-vectors';

const paths = DEFAULT_ENGINE_PATHS;

export { CHARACTER_VECTOR_LINE_MAX_CHARS, CHARACTER_VECTOR_HIDDEN_MAX_CHARS };

/** The four editable lines of one entry. */
export type CharacterVectorFields = Pick<CharacterVectorEntry, 'toward' | 'never' | 'direction' | 'hidden'>;

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampFields(fields: Partial<CharacterVectorFields>): CharacterVectorFields {
  const line = (v: string | undefined) => (v ?? '').trim().slice(0, CHARACTER_VECTOR_LINE_MAX_CHARS);
  return {
    toward: line(fields.toward),
    never: line(fields.never),
    direction: line(fields.direction),
    hidden: (fields.hidden ?? '').trim().slice(0, CHARACTER_VECTOR_HIDDEN_MAX_CHARS),
  };
}

export function useCharacterVectors() {
  const { get, setValue, useValue } = useGameState();

  const raw = useValue<unknown>(paths.characterVectors);
  const relationships = useValue<unknown>(paths.relationships);
  const history = useValue<unknown>(paths.narrativeHistory);
  const playerName = useValue<string>(paths.playerName);

  /** Normalised view (missing / malformed → empty state). */
  const vectors = computed<CharacterVectorsState>(() => readCharacterVectors({ get: () => raw.value as never }, paths));
  const entries = computed<CharacterVectorEntry[]>(() => vectors.value.entries);
  const enabled = computed<boolean>(() => vectors.value.enabled);

  /**
   * Names the NEXT round would carry, using the engine's own projection rule (present ∪
   * previous narrative — the player input is not known yet, so it is left out).
   */
  const projectedScope = computed<string[]>(() => resolveVectorScope({
    relationships: relationships.value,
    candidates: activeVectorEntries(vectors.value).map((e) => e.name),
    lastNarrative: lastNarrativeText({ get: () => history.value as never }, paths),
    paths,
  }));

  function write(next: CharacterVectorsState): void {
    setValue(paths.characterVectors, next);
    eventBus.emit('engine:request-save', undefined);
  }

  function setEnabled(value: boolean): void {
    write({ ...vectors.value, enabled: value });
  }

  function entryFor(name: string): CharacterVectorEntry | undefined {
    return vectors.value.entries.find((e) => e.name === name);
  }

  /**
   * Create or replace the entry for `name` with the given lines. Refuses the protagonist
   * (the player writes her). Returns false when nothing was written.
   */
  function upsertEntry(name: string, fields: Partial<CharacterVectorFields>): boolean {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === (playerName.value ?? '')) return false;
    const clamped = clampFields(fields);
    const round = get<number>(paths.roundNumber) ?? 0;
    const existing = entryFor(trimmedName);
    const next: CharacterVectorEntry = existing
      ? { ...existing, ...clamped, updatedRound: round }
      : { id: newId(), name: trimmedName, ...clamped, enabled: true, source: 'player', updatedRound: round };
    const others = vectors.value.entries.filter((e) => e.name !== trimmedName);
    write({ ...vectors.value, entries: existing ? vectors.value.entries.map((e) => (e.name === trimmedName ? next : e)) : [...others, next] });
    return true;
  }

  function toggleEntry(name: string): void {
    write({ ...vectors.value, entries: vectors.value.entries.map((e) => (e.name === name ? { ...e, enabled: !e.enabled } : e)) });
  }

  function removeEntry(name: string): void {
    write({ ...vectors.value, entries: vectors.value.entries.filter((e) => e.name !== name) });
  }

  return { vectors, entries, enabled, projectedScope, setEnabled, entryFor, upsertEntry, toggleEntry, removeEntry };
}
