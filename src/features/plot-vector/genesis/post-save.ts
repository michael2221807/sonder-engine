import type { CardSpec } from '../contract/types';

/** Where a saved entry lives: inventory, talents, status effects or environment tags. */
export type GenesisEntryKind = 'item' | 'talent' | 'environment' | 'effect' | 'other';

/** Host-owned snapshots: capability excludes stock, charges and other bookkeeping. */
export interface SavedElement {
  id: string;
  kind: GenesisEntryKind;
  capability: Readonly<Record<string, unknown>>;
}
export interface SavedAction {
  id: string;
  success: boolean;
  before: readonly SavedElement[];
  after: readonly SavedElement[];
}
export interface GenesisTask { key: string; actionId: string; entry: SavedElement }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Prose that does not change what an entry does. Inventory prose (name and description) is a journal, not an
 * instruction to reroll a collected ability. An environment is rewritten every round, often in new words;
 * only its name or its effect gives it a new card (2026-09-26, PO D5). Other entry kinds keep their
 * content-sensitive lifecycle. */
const PROSE: Partial<Record<SavedElement['kind'], readonly string[]>> = { item: ['name', 'description'], environment: ['description'] };

export function capabilityKey(entry: SavedElement): string {
  const prose = PROSE[entry.kind];
  if (!prose) return stable(entry);
  const mechanics: Record<string, unknown> = Object.fromEntries(
    Object.entries(entry.capability).filter(([key]) => !prose.includes(key)));
  // An explicit first revision is equivalent to an older save without the field.
  if (entry.kind === 'item' && mechanics['能力版本'] === 1) delete mechanics['能力版本'];
  return stable({ id: entry.id, kind: entry.kind, capability: mechanics });
}
function normalizeKnownKey(key: string): string {
  try {
    const entry: unknown = JSON.parse(key);
    if (entry && typeof entry === 'object' && 'kind' in entry && typeof entry.kind === 'string' && entry.kind in PROSE
      && 'id' in entry && typeof entry.id === 'string' && 'capability' in entry
      && entry.capability && typeof entry.capability === 'object' && !Array.isArray(entry.capability))
      return capabilityKey(entry as SavedElement);
  } catch { /* Preserve opaque historical keys. */ }
  return key;
}
export function tasksAfterSave(action: SavedAction, known: readonly string[] = []): GenesisTask[] {
  if (!action.success) return [];
  const seen = new Set(known.map(normalizeKnownKey));
  const before = new Map(action.before.map(e => [e.id, capabilityKey(e)]));
  return action.after.flatMap(entry => {
    const key = capabilityKey(entry);
    if (seen.has(key) || before.get(entry.id) === key) return [];
    seen.add(key);
    return [{ key, actionId: action.id, entry: structuredClone(entry) }];
  });
}

/** An obtained entry with its bound ability (rebuild plan §2.2), checked once when bound (§5). */
export interface BoundCard { task: GenesisTask; spec: CardSpec }
