/**
 * The player's edits to a pack's prompts, made on the prompt page (PromptPanel).
 *
 * One store for them (P7, PO 2026-10-04): localStorage keys per pack and prompt, read into the PromptRegistry at
 * boot (main.ts) and again whenever something replaces them (a game card's prompt edits, an import undone —
 * `prompt:edits-replaced`). The registry is what every request reads: the flow assembler and the main round's
 * story builder alike. Full backups carry these keys as engine settings; a game card carries them when its author
 * ticks "built-in prompt edits".
 *
 * The world-book `builtin-prompts` store (slot overrides) was meant for this once, but nothing ever filled it from
 * the page or read it at runtime; it is only round-tripped by full backups. Cards written before this carry their
 * author's edits in that slot form (`promptEditsFromSlotOverrides`).
 */
import type { PromptRegistry } from './prompt-registry';
import type { BuiltinPromptEntry } from './world-book';
import { BUILTIN_SLOTS } from './builtin-slots';

/** One prompt's edit: the player's text and/or that the prompt is switched off. A prompt left alone has none. */
export interface PromptEdit {
  id: string;
  /** The player's text in place of the pack's. */
  content?: string;
  /** Present when the player switched the prompt off. */
  enabled?: false;
}

/** A game card's copy of its author's prompt edits for one pack. */
export interface PromptEditsExport {
  version: 1;
  packId: string;
  entries: PromptEdit[];
}

/** The parts of `Storage` these functions use (tests pass a map). */
export type EditStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export function promptContentKey(packId: string, id: string): string {
  return `aga_prompt_${packId}_${id}`;
}

export function promptEnabledKey(packId: string, id: string): string {
  return `aga_prompt_enabled_${packId}_${id}`;
}

function storeOf(storage?: EditStorage): EditStorage {
  return storage ?? localStorage;
}

/** The ids of a pack's prompts that have an edit stored (text or switched off). */
export function promptEditIds(packId: string, storage?: EditStorage): string[] {
  const s = storeOf(storage);
  const content = promptContentKey(packId, ''), enabled = promptEnabledKey(packId, '');
  const ids = new Set<string>();
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(enabled)) ids.add(key.slice(enabled.length));
    else if (key?.startsWith(content)) ids.add(key.slice(content.length));
  }
  ids.delete('');
  return [...ids].sort();
}

/** The edits stored for a pack's prompts (all of them, or the ids given): only prompts edited or switched off. */
export function readPromptEdits(packId: string, ids?: Iterable<string>, storage?: EditStorage): PromptEdit[] {
  const s = storeOf(storage);
  const out: PromptEdit[] = [];
  for (const id of ids ?? promptEditIds(packId, s)) {
    const content = s.getItem(promptContentKey(packId, id));
    const off = s.getItem(promptEnabledKey(packId, id)) === 'false';
    if (content === null && !off) continue;
    out.push({ id, ...(content === null ? {} : { content }), ...(off ? { enabled: false as const } : {}) });
  }
  return out;
}

/** Store one prompt exactly as the edit says: its text (or the pack's) and on or off. */
function storeEdit(s: EditStorage, packId: string, edit: PromptEdit): void {
  if (edit.content === undefined) s.removeItem(promptContentKey(packId, edit.id));
  else s.setItem(promptContentKey(packId, edit.id), edit.content);
  if (edit.enabled === false) s.setItem(promptEnabledKey(packId, edit.id), 'false');
  else s.removeItem(promptEnabledKey(packId, edit.id));
}

/**
 * Apply edits to a pack's prompts: each listed prompt becomes exactly what its edit says (its text or the pack's,
 * on or off); every other prompt keeps the player's own edit. Returns how many prompts were written.
 */
export function writePromptEdits(packId: string, edits: readonly PromptEdit[], storage?: EditStorage): number {
  const s = storeOf(storage);
  for (const edit of edits) storeEdit(s, packId, edit);
  return edits.length;
}

/** Put a pack's edits back exactly as a snapshot had them: the snapshot's prompts edited, every other one cleared. */
export function restorePromptEdits(packId: string, snapshot: readonly PromptEdit[], storage?: EditStorage): void {
  const s = storeOf(storage);
  for (const id of promptEditIds(packId, s)) storeEdit(s, packId, { id });
  for (const edit of snapshot) storeEdit(s, packId, edit);
}

/** Load a pack's stored edits into the registry: each prompt gets the player's text or the pack's, on or off. */
export function hydratePromptRegistry(registry: PromptRegistry, packId: string, ids: Iterable<string>, storage?: EditStorage): void {
  const s = storeOf(storage);
  for (const id of ids) {
    const content = s.getItem(promptContentKey(packId, id));
    if (content === null) registry.resetToDefault(id);
    else registry.setUserContent(id, content);
    registry.setEnabled(id, s.getItem(promptEnabledKey(packId, id)) !== 'false');
  }
}

/**
 * A card written before prompt edits had their own copy carried its author's edits as world-book slot overrides:
 * each as an edit of the prompt its slot names (an override of an unknown slot, or with nothing to say, is skipped).
 */
export function promptEditsFromSlotOverrides(entries: readonly BuiltinPromptEntry[]): PromptEdit[] {
  const out = new Map<string, PromptEdit>();
  for (const entry of entries) {
    const id = BUILTIN_SLOTS[entry.slotId]?.defaultPromptId;
    if (!id) continue;
    const content = typeof entry.userContent === 'string' && entry.userContent.trim() ? entry.userContent : undefined;
    const off = entry.enabled === false;
    if (content === undefined && !off) continue;
    out.set(id, { id, ...(content === undefined ? {} : { content }), ...(off ? { enabled: false as const } : {}) });
  }
  return [...out.values()];
}
