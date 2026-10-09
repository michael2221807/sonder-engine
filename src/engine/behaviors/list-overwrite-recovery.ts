// App doc: docs/user-guide/pages/game-main.md §3.8.2（读档时找回被清空的列表）
/**
 * 列表被整体覆盖后的找回 — 读档时从存档自己的变更记录里找回被覆盖的列表（E1，2026-10-08）
 *
 * Until 2026-10-08 a model's `set` could put a single value where a declared list was — a world-event log became one
 * event object (a 73-event log, round 131), an implicit mid-term memory became one text (round 75). The end-of-round
 * type repair then emptied a top-level list; a list inside a list entry (an NPC's memory) it never repairs, so that one
 * kept the single value. Either way the list as it was is still in that round's change record (`_delta`: the set's
 * oldValue). On load this module puts it back: the entries the list held before the set, then the set's value when it
 * is one record of the list's kind, then what the list holds now; an entry already there is not added twice.
 *
 * - An overwrite is a set the command executor's list guard now refuses or turns into an append: any value but a
 *   list, null or an empty object (those two clear a list on purpose and are left alone), onto a list the schema
 *   declares, whatever it held — also an empty or missing list, or the single value an earlier slip left there, as a
 *   model that repeats the mistake does. A record that changed nothing (no value before or after, e.g. a set on an
 *   entry that does not exist) is ignored.
 * - A list value is read as the type repair leaves it — what the list held before the set, and what it holds now:
 *   text or an empty object made a list (listFromMalformed), another single value as its one entry; a missing list
 *   now reads as empty while the field holding it is there. A list that is still not a list after the recovery is
 *   written as one even when nothing is put back.
 * - Records are used newest first, each putting its entries in front of what is there, so a list overwritten more
 *   than once comes back in the order it was written.
 * - A list rebuilt or removed after the overwrite is not put back: a later set of it with a list, null or an empty
 *   object, a later set of a field that holds it, or a later delete replaced it on purpose (a list the model re-sets
 *   every round, such as environment tags).
 * - Each record is used once: the outcome is marked on the record itself (`_recovered`), so it travels with the
 *   history (a rollback that takes the history back takes the mark back with it).
 * - The implicit mid-term memory pairs one to one with the short-term memory (MemoryManager.shiftAndPromoteOldest):
 *   it is put back only when the result has as many entries as the short-term memory; otherwise nothing is written,
 *   the record is marked skipped and the player is told.
 * - A record with nowhere to put the list yet (it is null, the field holding it is gone, the short-term memory is not
 *   a list) is left unmarked and tried on a later load.
 * - Writes stay in memory and reach the save with the next save: a load hook runs before the active slot is switched
 *   (engine-state.loadGame), so asking for a save here could write into the previous slot.
 */
import { isEqual } from 'lodash-es';
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import { eventBus } from '../core/event-bus';
import { splitPathSegments } from '../core/command-executor';
import { isNonEmptyRecord, listFromMalformed, listHoldsRecords } from '../core/list-repair';

/** The engine paths this module reads (from DEFAULT_ENGINE_PATHS). */
export interface ListRecoveryPaths {
  narrativeHistory: string;
  shortTermMemory: string;
  implicitMidTermMemory: string;
}

/** What a used record is marked with. */
export interface ListRecoveryMark {
  at: number;
  /** Entries put back (0 when nothing was missing or the record was skipped). */
  restored: number;
  /**
   * Set when the record was not used: `pairing` — the implicit mid-term memory would not pair with the short-term
   * memory; `replaced` — the list was rebuilt or removed after the overwrite.
   */
  skipped?: 'pairing' | 'replaced';
}

type Entry = Record<string, unknown>;
type Overwrite = Entry & { path: string };

/** A change record and where it sits: history entry, index in that entry's `_delta`. */
interface Located { entry: number; index: number; record: Entry }

/** A later write that replaced a path: itself (`self`) and everything below it. */
interface Replacement { path: string; self: boolean }

/**
 * What a load did: the marks by history entry and record index, the entries put back by list, the lists skipped for
 * pairing.
 */
interface Outcome {
  marks: Map<number, Map<number, ListRecoveryMark>>;
  recovered: Map<string, number>;
  skipped: Set<string>;
}

export class ListOverwriteRecoveryModule implements BehaviorModule {
  readonly id = 'list-overwrite-recovery';

  constructor(
    private paths: ListRecoveryPaths,
    /** Whether the pack schema declares a path a list; without a schema a non-empty old list is the only evidence. */
    private declaresArray?: (path: string) => boolean,
    /** The item types the pack schema allows for a list; without them the old list's entries say whether it holds records. */
    private itemTypes?: (path: string) => string[] | undefined,
  ) {}

  onGameLoad(stateManager: StateManager): void {
    const history = stateManager.get<unknown[]>(this.paths.narrativeHistory);
    if (!Array.isArray(history)) return;
    const outcome = this.useRecords(stateManager, changeRecords(history));
    this.writeMarks(stateManager, history, outcome.marks);
    notify(outcome);
  }

  /** Use the overwrite records newest first: a record sees only the writes that came after it. */
  private useRecords(stateManager: StateManager, records: Located[]): Outcome {
    const at = Date.now();
    const outcome: Outcome = { marks: new Map(), recovered: new Map(), skipped: new Set() };
    const replacements: Replacement[] = [];
    for (let k = records.length - 1; k >= 0; k--) {
      const { entry, index, record } = records[k];
      if (record.oldValue === undefined && record.newValue === undefined) continue; // changed nothing
      if (!this.isOverwrite(record)) {
        const replacement = replacementBy(record);
        if (replacement) replacements.push(replacement);
        continue;
      }
      if (record._recovered !== undefined) continue; // used on an earlier load
      const mark = replacements.some((r) => replaces(r, record.path))
        ? { at, restored: 0, skipped: 'replaced' as const }
        : this.recover(stateManager, record, at);
      if (mark) addMark(outcome, entry, index, record.path, mark);
    }
    return outcome;
  }

  /** Put each mark on its record, one write per history entry. */
  private writeMarks(stateManager: StateManager, history: unknown[], marks: Outcome['marks']): void {
    for (const [entry, byIndex] of marks) {
      const holder = history[entry];
      if (!isRecord(holder) || !Array.isArray(holder._delta)) continue;
      const next = holder._delta.map((record: unknown, j: number) => {
        const mark = byIndex.get(j);
        return mark && isRecord(record) ? { ...record, _recovered: mark } : record;
      });
      stateManager.set(`${this.paths.narrativeHistory}.${entry}._delta`, next, 'system');
    }
  }

  /** A set that put a single value where a declared list was (used or not). */
  private isOverwrite(record: Entry): record is Overwrite {
    if (record.action !== 'set' || typeof record.path !== 'string') return false;
    if (isWithin(record.path, this.paths.narrativeHistory) || clearsList(record.newValue)) return false;
    if (!this.declaresArray) return Array.isArray(record.oldValue) && record.oldValue.length > 0;
    return this.declaresArray(record.path);
  }

  /** Put the list back; the mark for the record, or undefined to try again on a later load. */
  private recover(stateManager: StateManager, record: Overwrite, at: number): ListRecoveryMark | undefined {
    const now = currentList(stateManager, record.path);
    if (!now) return undefined;
    const { entries: current, isList } = now;

    const old = record.oldValue === undefined || record.oldValue === null ? [] : asList(record.oldValue);
    const missing = missingFrom(old, current);
    const value = record.newValue;
    const oneRecord = isNonEmptyRecord(value) && listHoldsRecords(this.itemTypes?.(record.path), old)
      && !current.some((x) => isEqual(x, value)) && !missing.some((x) => isEqual(x, value));
    const putBack = oneRecord ? [...missing, value] : missing;
    const next = [...putBack, ...current];

    if (putBack.length > 0 && record.path === this.paths.implicitMidTermMemory) {
      const shortTerm = stateManager.get<unknown>(this.paths.shortTermMemory);
      if (!Array.isArray(shortTerm)) return undefined;
      if (shortTerm.length !== next.length) {
        console.warn(
          `[ListOverwriteRecovery] Not putting back ${record.path}: ${next.length} entries would not pair with ` +
          `${shortTerm.length} short-term memories`,
        );
        return { at, restored: 0, skipped: 'pairing' };
      }
    }

    if (putBack.length > 0 || !isList) stateManager.set(record.path, next, 'system');
    return { at, restored: putBack.length };
  }
}

/**
 * The list at `path` as the type repair leaves it (see the module comment), and whether it is a list in the tree
 * already. Undefined when there is nowhere to put it yet: it is null, or the field holding it is gone.
 */
function currentList(stateManager: StateManager, path: string): { entries: unknown[]; isList: boolean } | undefined {
  const value = stateManager.get<unknown>(path);
  if (Array.isArray(value)) return { entries: value, isList: true };
  if (value === null) return undefined;
  if (value === undefined) {
    const holder = splitPathSegments(path).slice(0, -1).join('.');
    return holder === '' || isRecord(stateManager.get<unknown>(holder)) ? { entries: [], isList: false } : undefined;
  }
  return { entries: asList(value), isList: false };
}

/** A value read as the type repair leaves a list field: a list as it is, text or `{}` made a list, else its one entry. */
function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : (listFromMalformed(value) ?? [value]);
}

/** Every change record in the history, oldest first. */
function changeRecords(history: unknown[]): Located[] {
  const records: Located[] = [];
  history.forEach((entry, i) => {
    if (!isRecord(entry) || !Array.isArray(entry._delta)) return;
    entry._delta.forEach((record: unknown, j: number) => {
      if (isRecord(record)) records.push({ entry: i, index: j, record });
    });
  });
  return records;
}

function addMark(outcome: Outcome, entry: number, index: number, path: string, mark: ListRecoveryMark): void {
  const byIndex = outcome.marks.get(entry) ?? new Map<number, ListRecoveryMark>();
  byIndex.set(index, mark);
  outcome.marks.set(entry, byIndex);
  if (mark.restored > 0) outcome.recovered.set(path, (outcome.recovered.get(path) ?? 0) + mark.restored);
  if (mark.skipped === 'pairing') outcome.skipped.add(path);
}

/**
 * Tell the player once per load: what was put back (each list with its count), and which lists were left as they
 * were. The fields are joined without a language-specific separator; the sentence around them is translated.
 */
function notify({ recovered, skipped }: Outcome): void {
  if (recovered.size > 0) {
    const count = [...recovered.values()].reduce((n, r) => n + r, 0);
    const fields = [...recovered].map(([path, n]) => `${path} ×${n}`).join(' / ');
    console.log(`[ListOverwriteRecovery] Put back ${count} list item(s) from the change records: ${fields}`);
    eventBus.emit('ui:toast', {
      type: 'success',
      i18nKey: 'engine.toast.listsRecovered',
      i18nParams: { count, fields },
      message: `已从变更记录找回 ${count} 条被覆盖的列表数据：${fields}`,
      id: 'lists-recovered',
      duration: 8000,
    });
  }
  if (skipped.size > 0) {
    const fields = [...skipped].join(' / ');
    eventBus.emit('ui:toast', {
      type: 'warning',
      i18nKey: 'engine.toast.listRecoverySkipped',
      i18nParams: { fields },
      message: `未找回 ${fields}：找回后的条数与短期记忆对不上，已保持原样`,
      id: 'list-recovery-skipped',
      duration: 8000,
    });
  }
}

/** A value a set uses to clear a list on purpose (or to rebuild it, for a list): a list, null, an empty object. */
function clearsList(value: unknown): boolean {
  return Array.isArray(value) || value === null || (isRecord(value) && !isNonEmptyRecord(value));
}

/**
 * What a record replaced, if anything: a delete, or a set of a list, null or an empty object, replaced its path and
 * everything below it; any other set replaced everything below its path (it put a new value where they were).
 */
function replacementBy(record: Entry): Replacement | undefined {
  if (typeof record.path !== 'string') return undefined;
  if (record.action === 'delete') return { path: record.path, self: true };
  if (record.action === 'set') return { path: record.path, self: clearsList(record.newValue) };
  return undefined;
}

function replaces(replacement: Replacement, path: string): boolean {
  return replacement.self ? isWithin(path, replacement.path) : isBelow(path, replacement.path);
}

/** `path` is `base` or a field inside it (`base.x`, `base[名称=…]`). */
function isWithin(path: string, base: string): boolean {
  return path === base || isBelow(path, base);
}

function isBelow(path: string, base: string): boolean {
  return path.startsWith(`${base}.`) || path.startsWith(`${base}[`);
}

/** The entries of `old` that `current` does not hold; an entry `current` holds once covers one copy in `old`. */
function missingFrom(old: unknown[], current: unknown[]): unknown[] {
  const pool = [...current];
  return old.filter((item) => {
    const k = pool.findIndex((x) => isEqual(x, item));
    if (k === -1) return true;
    pool.splice(k, 1);
    return false;
  });
}

function isRecord(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
