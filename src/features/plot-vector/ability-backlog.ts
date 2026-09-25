import { capabilityKey, type SavedElement } from './genesis/post-save';
import type { GenesisEntryKind } from './genesis/types';
import type { VectorState, VectorTaskRow } from './runtime';

/**
 * - `failed`: generation, parsing or validation did not give a usable ability.
 * - `unknown`: a request was sent and no reply was ever recorded (never re-sent automatically).
 * - `retrying`: a player retry was sent and its reply has not been recorded yet.
 */
export type BacklogState = 'failed' | 'unknown' | 'retrying';
export interface BacklogEntry {
  id: string;
  kind: GenesisEntryKind;
  name: string;
  state: BacklogState;
  /** Why the latest attempt did not give a usable ability (diagnostic text). */
  problem?: string;
  row: VectorTaskRow;
}

/** The saved entry as ability identity sees it: the transport-only ability field of an environment tag is not content. */
export function bareEntry(entry: SavedElement, abilityField?: string): SavedElement {
  if (entry.kind !== 'environment' || !abilityField || !Object.hasOwn(entry.capability, abilityField)) return entry;
  const { [abilityField]: _ability, ...capability } = entry.capability;
  return { ...entry, capability };
}

/**
 * Entries the player has obtained whose ability is not usable yet. Only entries still in the save with
 * unchanged content count (a changed or removed source is handled as the current source); an entry that
 * already has a card for its current content is never listed. The saved entry itself is never touched.
 */
export function abilityBacklog(state: VectorState, entries: readonly SavedElement[], abilityField?: string): BacklogEntry[] {
  const current = new Map(entries.map(e => { const bare = bareEntry(e, abilityField); return [capabilityKey(bare), bare] as const; }));
  const withCard = new Set(state.cards.map(c => capabilityKey(c.task.entry)));
  const listed = new Set<string>();
  const backlog: BacklogEntry[] = [];
  for (const row of state.tasks) {
    const key = capabilityKey(row.task.entry);
    const entry = current.get(key);
    if (!entry || withCard.has(key) || listed.has(key)) continue;
    const status: BacklogState | undefined = row.retry?.sending ? 'retrying'
      : row.status === 'failed' ? 'failed'
        : row.status === 'sending' && row.raw === undefined ? 'unknown' : undefined;
    if (!status) continue;
    listed.add(key);
    const name = typeof entry.capability.name === 'string' && entry.capability.name.trim() ? entry.capability.name.trim() : entry.id;
    backlog.push({ id: entry.id, kind: entry.kind, name, state: status, problem: row.retry?.error ?? row.error, row });
  }
  return backlog;
}
