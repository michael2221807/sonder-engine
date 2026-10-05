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
 * the page or read it at runtime. It is retired: what a backup or an old card import left in it moves into this
 * store once (`migrateLegacyBuiltinOverrides`); full backups still round-trip it, empty. Cards written before this
 * carry their author's edits in that slot form (`promptEditsFromSlotOverrides`).
 */
import type { PromptRegistry } from './prompt-registry';
import { ALWAYS_ON_PROMPT_IDS, BUILTIN_SLOTS } from './builtin-slots';

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

/** The part of the world-book store the retired slot overrides are read from and cleared in. */
export interface LegacyOverrideStore {
  loadAllBuiltinOverrides(packId: string): Promise<unknown[]>;
  clearBuiltinOverrides(packId: string): Promise<void>;
}

/**
 * The same text whatever its line endings: a Windows working copy serves the pack's prompts with CRLF while a
 * textarea gives LF back, so a text typed in and deleted again must not count as an edit (code review L2).
 */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** The longest prompt text a card may bring (the longest pack prompt, core, is about 30 000 characters). */
export const MAX_IMPORTED_PROMPT_LENGTH = 200_000;

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

/**
 * The edits stored for a pack's prompts (all of them, or the ids given): only prompts edited or switched off. An
 * always-on prompt is never off, so a stored "off" for one is not an edit.
 */
export function readPromptEdits(packId: string, ids?: Iterable<string>, storage?: EditStorage): PromptEdit[] {
  const s = storeOf(storage);
  const out: PromptEdit[] = [];
  for (const id of ids ?? promptEditIds(packId, s)) {
    const content = s.getItem(promptContentKey(packId, id));
    const off = s.getItem(promptEnabledKey(packId, id)) === 'false' && !ALWAYS_ON_PROMPT_IDS.has(id);
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
 * Prompt edits as they come in from a card or a file: an entry that is no edit — no id, text that is not text,
 * nothing to change — is skipped, never stored; "off" counts only for a prompt that can be off (code review M3).
 */
export function sanitizePromptEdits(raw: unknown, knownIds?: ReadonlySet<string>): PromptEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptEdit[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { id, content, enabled } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id || (content !== undefined && typeof content !== 'string')) continue;
    // Only the pack's own prompts, within a size: a card must not fill the device's storage (code review L5).
    if ((knownIds && !knownIds.has(id)) || (typeof content === 'string' && content.length > MAX_IMPORTED_PROMPT_LENGTH)) continue;
    const off = enabled === false && !ALWAYS_ON_PROMPT_IDS.has(id);
    if (content === undefined && !off) continue;
    out.push({ id, ...(typeof content === 'string' ? { content } : {}), ...(off ? { enabled: false as const } : {}) });
  }
  return out;
}

/**
 * Apply edits to a pack's prompts: each listed prompt becomes exactly what its edit says (its text or the pack's,
 * on or off); every other prompt keeps the player's own edit. Entries that are no edit are skipped. Returns how
 * many prompts were written.
 */
export function writePromptEdits(packId: string, edits: readonly unknown[], storage?: EditStorage, knownIds?: ReadonlySet<string>): number {
  const s = storeOf(storage);
  const valid = sanitizePromptEdits(edits, knownIds);
  for (const edit of valid) storeEdit(s, packId, edit);
  return valid.length;
}

/** Put a pack's edits back exactly as a snapshot had them: the snapshot's prompts edited, every other one cleared. */
export function restorePromptEdits(packId: string, snapshot: readonly PromptEdit[], storage?: EditStorage): void {
  const s = storeOf(storage);
  for (const id of promptEditIds(packId, s)) storeEdit(s, packId, { id });
  for (const edit of snapshot) storeEdit(s, packId, edit);
}

/**
 * Load a pack's stored edits into the registry: each prompt gets the player's text or the pack's, on or off. What
 * is no edit is dropped from the store first (code review M2): a copy identical to the pack's text (a save without
 * a change) would otherwise freeze that text when the pack's own changes, and an always-on prompt is never off.
 */
export function hydratePromptRegistry(registry: PromptRegistry, packId: string, ids: Iterable<string>, storage?: EditStorage): void {
  const s = storeOf(storage);
  for (const id of ids) {
    const mod = registry.get(id);
    const contentKey = promptContentKey(packId, id), enabledKey = promptEnabledKey(packId, id);
    let content = s.getItem(contentKey);
    if (content !== null && mod && sameText(content, mod.content)) {
      s.removeItem(contentKey);
      content = null;
    }
    if (mod?.alwaysOn && s.getItem(enabledKey) !== null) s.removeItem(enabledKey);
    if (content === null) registry.resetToDefault(id);
    else registry.setUserContent(id, content);
    registry.setEnabled(id, mod?.alwaysOn === true || s.getItem(enabledKey) !== 'false');
  }
}

/** A prompt a pack split in two (`GamePackManifest.promptSplits`): `to` took some of `from`'s sections. */
export interface PromptSplit {
  from: string;
  to: string;
}

const HEADING = /^#{2,3} \S/;

/** The section headings of a text (`## ` and `### ` lines), trimmed. */
function headingsOf(text: string): Set<string> {
  return new Set(text.replace(/\r\n/g, '\n').split('\n').filter((line) => HEADING.test(line)).map((line) => line.trim()));
}

/** The same lines, separators (`---`) and blank lines aside. */
function sameWords(a: string, b: string): boolean {
  const words = (text: string) => text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && line.trim() !== '---').join('\n');
  return words(a) === words(b);
}

/** A text's lines before its first section heading. */
function preambleOf(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => HEADING.test(line));
  return (first === -1 ? lines : lines.slice(0, first)).join('\n').trimEnd();
}

/**
 * Re-split an edit made before a pack split a prompt in two (code review M1, 2026-10-05: core → coreNarrative).
 * Such an edit still holds the sections the pack moved to the new prompt, so they were sent twice — the player's
 * copy in the old prompt and the pack's in the new — and the player's version never reached a request that carries
 * only the new prompt. Along the pack's own section headings (`## ` / `### ` lines of the two default texts): a
 * section whose heading is now only in `to` moves to an edit of `to`; one in both (a parent kept on each side) is
 * copied; any other stays. Nothing happens when the edit holds no moved heading (it is already of the new kind) or
 * the player has edited `to` already. A switched-off `from` switches `to` off too, as the player meant both off.
 * Returns how many prompts it rewrote.
 */
export function resplitPromptEdits(
  packId: string,
  splits: readonly PromptSplit[],
  defaults: Readonly<Record<string, string>>,
  storage?: EditStorage,
): number {
  const s = storeOf(storage);
  let rewritten = 0;
  for (const { from, to } of splits) {
    const fromDefault = defaults[from], toDefault = defaults[to];
    if (typeof fromDefault !== 'string' || typeof toDefault !== 'string') continue;
    const fromOff = s.getItem(promptEnabledKey(packId, from)) === 'false';
    if (fromOff && s.getItem(promptEnabledKey(packId, to)) === null) s.setItem(promptEnabledKey(packId, to), 'false');
    const stored = s.getItem(promptContentKey(packId, from));
    if (stored === null || s.getItem(promptContentKey(packId, to)) !== null) continue;
    const fromHeadings = headingsOf(fromDefault), toHeadings = headingsOf(toDefault);
    const lines = stored.replace(/\r\n/g, '\n').split('\n');
    if (!lines.some((line) => toHeadings.has(line.trim()) && !fromHeadings.has(line.trim()))) continue;
    const kept: string[] = [], moved: string[] = [];
    let dest: 'from' | 'to' | 'both' = 'from';
    for (const line of lines) {
      if (HEADING.test(line)) {
        const heading = line.trim();
        dest = toHeadings.has(heading) ? (fromHeadings.has(heading) ? 'both' : 'to') : 'from';
      }
      if (dest !== 'to') kept.push(line);
      if (dest !== 'from') moved.push(line);
    }
    const nextFrom = kept.join('\n').trim();
    const nextTo = `${preambleOf(toDefault)}\n\n${moved.join('\n').trim()}`;
    // A part the player left as the pack wrote it is no edit, whatever separators and blank lines it kept.
    if (sameWords(nextFrom, fromDefault)) s.removeItem(promptContentKey(packId, from));
    else s.setItem(promptContentKey(packId, from), nextFrom);
    if (!sameWords(nextTo, toDefault)) s.setItem(promptContentKey(packId, to), nextTo);
    rewritten++;
  }
  return rewritten;
}

/**
 * The slot overrides a card written before prompt edits had their own copy carried (world-book `builtin-prompts`
 * entries), as edits of the prompts their slots name. The old builder used an override only when it was not
 * switched off and had text, so only those become edits — of text, never "off" (code review L4). A `format_prompt`
 * override becomes an edit of the default format (`mainRound`) only, never of Step 1's narrative-only format.
 */
export function promptEditsFromSlotOverrides(entries: unknown): PromptEdit[] {
  if (!Array.isArray(entries)) return [];
  const out = new Map<string, PromptEdit>();
  for (const entry of entries as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { slotId, userContent, enabled } = entry as Record<string, unknown>;
    if (enabled === false || typeof slotId !== 'string') continue;
    const id = BUILTIN_SLOTS[slotId]?.defaultPromptId;
    if (!id || typeof userContent !== 'string' || !userContent.trim()) continue;
    out.set(id, { id, content: userContent });
  }
  return [...out.values()];
}

/**
 * Retire the world-book slot-override store for a pack (P7 A, PO 2026-10-04: its old data joins the prompt page's
 * edits): what a backup or an old card import left there becomes edits of the prompts its slots name, for prompts
 * the player has not edited themselves, and the store is cleared so it is moved once. Returns how many prompts
 * were written; the caller reloads the registry when any were.
 */
export async function migrateLegacyBuiltinOverrides(store: LegacyOverrideStore, packId: string, storage?: EditStorage): Promise<number> {
  const entries = await store.loadAllBuiltinOverrides(packId);
  if (entries.length === 0) return 0;
  const s = storeOf(storage);
  const edits = promptEditsFromSlotOverrides(entries).filter((edit) =>
    s.getItem(promptContentKey(packId, edit.id)) === null && s.getItem(promptEnabledKey(packId, edit.id)) === null);
  const written = writePromptEdits(packId, edits, s);
  await store.clearBuiltinOverrides(packId);
  return written;
}
