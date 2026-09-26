import { capabilityKey, type SavedElement } from './genesis/post-save';
import type { GenesisEntryKind } from './genesis/post-save';
import type { VectorState, VectorTaskRow } from './runtime';

/** An obtained entry without a usable ability. Step3 tries it again automatically; the player can too. */
export type BacklogState = 'failed';
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
 * A request that never came back (page closed while it was out) counts as failed like any other.
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
    // A received first reply still waiting for its free check is not backlog; the next round binds it.
    const waitingCheck = row.status === 'sending' && row.raw !== undefined && !row.retry;
    if (waitingCheck || (row.status !== 'failed' && row.status !== 'sending')) continue;
    listed.add(key);
    const name = typeof entry.capability.name === 'string' && entry.capability.name.trim() ? entry.capability.name.trim() : entry.id;
    backlog.push({ id: entry.id, kind: entry.kind, name, state: 'failed', problem: row.retry?.error ?? row.error, row });
  }
  return backlog;
}
