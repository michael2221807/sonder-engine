import type { CardGenesisCandidateV1, GenesisEntryKind } from './types';
import type { ScriptProgramRef } from '../../../engine/plot-vector/core/types';

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
export interface GenesisOutputV2 {
  version: 2;
  card: Omit<CardGenesisCandidateV1['card'], 'initialPersistentState'> & {
    initialPersistentState?: CardGenesisCandidateV1['card']['initialPersistentState'];
  };
}
/** Production output contains only the model-owned executable ability. */
export interface GenesisOutputV3 {
  version: 3;
  card: Pick<CardGenesisCandidateV1['card'], 'hooks' | 'selfStore' | 'stateDisplay'> & {
    initialPersistentState?: CardGenesisCandidateV1['card']['initialPersistentState'];
  };
}
export type GenesisOutput = GenesisOutputV2 | GenesisOutputV3;
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Inventory prose is a journal, not an instruction to reroll a collected ability.
 * Functional fields (including an explicit capability revision) still invalidate it.
 * Other entry kinds keep their existing content-sensitive lifecycle. */
export function capabilityKey(entry: SavedElement): string {
  if (entry.kind !== 'item') return stable(entry);
  const mechanics: Record<string, unknown> = Object.fromEntries(
    Object.entries(entry.capability).filter(([key]) => key !== 'name' && key !== 'description'));
  // An explicit first revision is equivalent to an older save without the field.
  if (mechanics['能力版本'] === 1) delete mechanics['能力版本'];
  return stable({ id: entry.id, kind: entry.kind, capability: mechanics });
}
function normalizeKnownKey(key: string): string {
  try {
    const entry: unknown = JSON.parse(key);
    if (entry && typeof entry === 'object' && 'kind' in entry && entry.kind === 'item'
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

/** Explicit adapter to the existing JS runtime. No model evidence is requested or checked. */
export function toRuntimeCandidate(task: GenesisTask, output: GenesisOutput): CardGenesisCandidateV1 {
  if (output.version !== 2 && output.version !== 3) throw new Error('Expected post-save card version 2 or 3');
  const savedName = typeof task.entry.capability.name === 'string' && task.entry.capability.name.trim()
    ? task.entry.capability.name.trim() : task.entry.id;
  const savedDescription = typeof task.entry.capability.description === 'string' && task.entry.capability.description.trim()
    ? task.entry.capability.description.trim() : savedName;
  return {
    version: 1,
    anchor: { commandIndex: 0, entrySelector: task.entry.id, entryKind: task.entry.kind,
      entryLabel: String(task.entry.capability.name ?? task.entry.id), storyEvidence: '' },
    card: output.version === 2
      ? { ...output.card, initialPersistentState: output.card.initialPersistentState ?? {} }
      : { name: savedName, description: savedDescription, behaviorSummary: '以棋盘试走结果为准',
        hooks: output.card.hooks, ...(output.card.selfStore ? { selfStore: output.card.selfStore } : {}),
        ...(output.card.stateDisplay ? { stateDisplay: output.card.stateDisplay } : {}),
        initialPersistentState: output.card.initialPersistentState ?? {} },
  };
}
export interface BoundCard { task: GenesisTask; candidate: CardGenesisCandidateV1; ref: ScriptProgramRef; attempts: number }
