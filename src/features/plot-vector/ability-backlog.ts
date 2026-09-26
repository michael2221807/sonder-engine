import { capabilityKey, type SavedElement } from './genesis/post-save';
import type { GenesisEntryKind } from './genesis/post-save';
import type { VectorState, VectorTaskRow } from './runtime';

/** `failed`: an attempt did not give a usable ability. `waiting`: not tried yet (e.g. there before the feature was on). */
export type BacklogState = 'failed' | 'waiting';
export interface BacklogEntry {
  id: string;
  kind: GenesisEntryKind;
  name: string;
  state: BacklogState;
  /** Why the latest attempt did not give a usable ability (diagnostic text). */
  problem?: string;
  /** The entry's stored row, or a fresh one (not stored) when it has not been tried. */
  row: VectorTaskRow;
}

/**
 * The backlog (rebuild plan §6, charter I20): every obtained item, talent, status and environment in the save
 * that has no usable ability for its current content — entries that were there before the feature was turned
 * on included. Step3 fills it over the next rounds; the player can retry any of them. The saved entries
 * themselves are never touched.
 */
export function abilityBacklog(state: VectorState, entries: readonly SavedElement[]): BacklogEntry[] {
  const withCard = new Set(state.cards.map(c => capabilityKey(c.task.entry)));
  const rows = new Map(state.tasks.map(row => [capabilityKey(row.task.entry), row]));
  return entries.flatMap(entry => {
    const key = capabilityKey(entry);
    if (withCard.has(key)) return [];
    const row = rows.get(key);
    const name = typeof entry.capability.name === 'string' && entry.capability.name.trim() ? entry.capability.name.trim() : entry.id;
    return [{ id: entry.id, kind: entry.kind, name, state: row ? 'failed' as const : 'waiting' as const,
      problem: row?.retry?.error ?? row?.error, row: row ?? { task: { key, actionId: 'backlog', entry } } }];
  });
}
