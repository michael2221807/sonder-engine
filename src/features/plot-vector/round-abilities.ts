/**
 * Abilities written in the round's own reply (rebuild plan §6, charter I3/I4/I21): Step2 may append one block
 * of cards after its JSON. Right before the round is written, the entries that actually made it into the save
 * (new ones, and changed ones) are matched to those cards by name; each card that passes the one check is
 * bound and saved with the round. Everything else — a missing card, a broken one, one that fails the check —
 * leaves its entry waiting in the backlog. Cards of entries that left the save, or whose content changed, go.
 */
import { bindCard, cardTypeOf, type VectorState, type VectorTaskRow } from './runtime';
import { capabilityKey, tasksAfterSave, type BoundCard, type GenesisTask, type SavedElement } from './genesis/post-save';

/** One card of a block: its target name and the card, or the text of a piece that could not be read. */
export interface BlockCard { for?: string; card?: unknown; broken?: string }

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const forOf = (card: unknown) => (card && typeof card === 'object' && !Array.isArray(card) ? text((card as Record<string, unknown>).for) : undefined);

/** Top-level `{…}` pieces of a text (string-aware), for reading a block card by card when the whole does not parse. */
function objectPieces(source: string): string[] {
  const pieces: string[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) pieces.push(source.slice(start, i + 1));
  }
  if (depth > 0 && start >= 0) pieces.push(source.slice(start)); // cut off at the end
  return pieces;
}

/** The `for` of a card that does not parse as a whole (escaped quotes included). */
function nameIn(piece: string): string | undefined {
  const raw = /"for"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(piece)?.[1];
  if (raw === undefined) return undefined;
  try { return text(JSON.parse(`"${raw}"`)); } catch { return text(raw); }
}

/**
 * The cards of a block: one JSON array (or a single object). When the whole does not parse, each top-level
 * object is read on its own, so one broken card loses only itself.
 */
export function readAbilityBlock(block: string | undefined): BlockCard[] {
  const source = block?.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!source) return [];
  try {
    const value: unknown = JSON.parse(source);
    const list = Array.isArray(value) ? value : [value];
    return list.map(card => ({ for: forOf(card), card }));
  } catch {
    return objectPieces(source).map(piece => {
      try { const card: unknown = JSON.parse(piece); return { for: forOf(card), card }; }
      catch { return { for: nameIn(piece), broken: piece.slice(0, 2000) }; }
    });
  }
}

/** Why an entry of this round did not get a card (data for Step3 and the backlog). */
export const ROUND_PROBLEMS = {
  noBlock: '本回合的回复里没有能力区块',
  missing: '本回合的能力区块里没有这一条',
  broken: '能力区块里这一条写坏了，无法读取',
  ambiguous: '本回合有同名条目，这张卡的 type 与条目种类对不上，无法分辨是给哪一条的',
} as const;

export interface RoundBinding { state: VectorState; gained: BoundCard[] }

/**
 * Bind this round's abilities. `before`/`after`: the saved entries at the round's start and as they are about
 * to be written. `block`: the round's cards (undefined when the reply had no block). `stillPresent`: entries
 * that are in the save but could not be projected this time (their cards stay).
 */
export function bindRoundAbilities(state: VectorState, before: readonly SavedElement[], after: readonly SavedElement[],
  block: BlockCard[] | undefined, stillPresent: (id: string) => boolean = () => false): RoundBinding {
  const current = new Map(after.map(entry => [entry.id, capabilityKey(entry)]));
  const applies = (entry: SavedElement) => current.get(entry.id) === capabilityKey(entry) || (!current.has(entry.id) && stillPresent(entry.id));
  let cards = state.cards.filter(card => applies(card.task.entry));
  const rows = new Map(state.tasks.filter(row => applies(row.task.entry)).map(row => [capabilityKey(row.task.entry), row]));
  const used = new Set<number>();
  const gained: BoundCard[] = [];
  const fail = (task: GenesisTask, error: string, raw?: string) => {
    const prior = rows.get(task.key);
    // The first failure keeps its own reason and reply; later attempts are recorded under `retry`.
    rows.set(task.key, prior ?? { task, error, ...(raw !== undefined ? { raw } : {}) });
  };
  const newTasks = tasksAfterSave({ id: 'round', success: true, before, after });
  const sameName = (name: string | undefined) => newTasks.filter(t => text(t.entry.capability.name) === name).length;
  for (const task of newTasks) {
    const entry = task.entry, name = text(entry.capability.name), type = cardTypeOf(entry);
    if (!block) { fail(task, ROUND_PROBLEMS.noBlock); continue; }
    const candidates = block.map((card, index) => ({ card, index })).filter(({ card, index }) => !used.has(index) && card.for === name);
    const typed = candidates.find(({ card }) => card.card && (card.card as { type?: unknown }).type === type);
    // One new entry of this name: its card, whatever type it declares (the entry decides). Several: the type must say which.
    const pick = typed ?? (sameName(name) > 1 ? undefined : candidates[0]);
    if (!pick) { fail(task, candidates.length ? ROUND_PROBLEMS.ambiguous : ROUND_PROBLEMS.missing); continue; }
    used.add(pick.index);
    if (pick.card.broken !== undefined) { fail(task, ROUND_PROBLEMS.broken, pick.card.broken); continue; }
    try {
      const bound = bindCard(task, pick.card.card);
      cards = [...cards.filter(card => card.task.entry.id !== entry.id), bound];
      rows.delete(task.key);
      gained.push(bound);
    } catch (error) {
      fail(task, error instanceof Error ? error.message : String(error), JSON.stringify(pick.card.card));
    }
  }
  // Rows only describe entries still without a card.
  const withCard = new Set(cards.map(card => capabilityKey(card.task.entry)));
  const tasks: VectorTaskRow[] = [...rows.entries()].filter(([key]) => !withCard.has(key)).map(([, row]) => row);
  return { state: { ...state, cards, tasks }, gained };
}
