/**
 * 变更记录压缩 — 追加 / 移除一项的记录只记那一项（存档瘦身 D3A，2026-10-09）
 *
 * StateManager records a push or pull with the whole list before and after; on the narrative entries (`_delta`) of the
 * PO save these records were 11.6M characters. As stored there, such a record keeps only the entry it moved:
 * - a push that appended one entry at the end → `element`;
 * - a push that started a list that was not there (before: undefined or null) → `element`;
 * - a pull that removed one entry → `element` and its `index`.
 * Every other record is kept as it is: set, delete, add, a push or pull that did not change the list by exactly one
 * entry, and a push that replaced a value that was not a list — a record holding a value it replaced may be the only
 * copy of that value (E1 recovered two lost lists from set records; on the PO save a push of round 61 holds a two-item
 * inventory it wiped).
 *
 * Only what is stored is compacted: in-memory change logs keep both lists (round logic reads them). Nothing to compact
 * comes back as the same object or list, so a caller can tell "nothing changed" by identity.
 */
import { isEqual } from 'lodash-es';
import { isPlainRecord } from './plain-data';

/** A push or pull as stored on a narrative entry once compacted. */
export interface CompactListChange {
  path: string;
  action: 'push' | 'pull';
  /** The entry the push appended, or the one the pull removed. */
  element: unknown;
  /** Where the pulled entry was: where the two lists first differ (with equal neighbours, any of them gives the same list). */
  index?: number;
  timestamp?: number;
  source?: string;
}

/** The narrative-entry field holding a round's stored change records. */
export const DELTA_FIELD = '_delta';

/** The record as it is stored: compacted when it moved exactly one entry, otherwise the same object. */
export function compactChangeRecord<T extends object>(record: T): T | CompactListChange;
export function compactChangeRecord(record: unknown): unknown;
export function compactChangeRecord(record: unknown): unknown {
  if (!isPlainRecord(record) || typeof record.path !== 'string') return record;
  const { oldValue, newValue, ...rest } = record;
  if (record.action === 'push') {
    const element = pushedElement(oldValue, newValue);
    return element ? { ...rest, element: element.value } : record;
  }
  if (record.action === 'pull') {
    const removed = pulledElement(oldValue, newValue);
    return removed ? { ...rest, element: removed.value, index: removed.index } : record;
  }
  return record;
}

/** Each record as it is stored (see compactChangeRecord); the same list when none changes. */
export function compactChangeRecords<T extends object>(records: readonly T[]): ReadonlyArray<T | CompactListChange>;
export function compactChangeRecords(records: readonly unknown[]): readonly unknown[];
export function compactChangeRecords(records: readonly unknown[]): readonly unknown[] {
  const stored = records.map((record) => compactChangeRecord(record));
  return stored.every((record, i) => record === records[i]) ? records : stored;
}

/**
 * The history with every entry's stored change records compacted: a new list whose untouched entries are the same
 * objects, or the given list itself when nothing compacts.
 */
export function compactHistoryDeltas(history: readonly unknown[]): readonly unknown[] {
  let next: unknown[] | undefined;
  history.forEach((entry, i) => {
    if (!isPlainRecord(entry) || !Array.isArray(entry[DELTA_FIELD])) return;
    const delta = entry[DELTA_FIELD] as unknown[];
    const stored = compactChangeRecords(delta);
    if (stored === delta) return;
    next ??= [...history];
    next[i] = { ...entry, [DELTA_FIELD]: stored };
  });
  return next ?? history;
}

/** Whether a stored record is a compacted push or pull (it names its entry and no longer holds the lists). */
export function isCompactListChange(record: unknown): record is CompactListChange {
  return isPlainRecord(record)
    && (record.action === 'push' || record.action === 'pull')
    && Object.prototype.hasOwnProperty.call(record, 'element')
    && record.oldValue === undefined && record.newValue === undefined;
}

function pushedElement(before: unknown, after: unknown): { value: unknown } | undefined {
  if (!Array.isArray(after)) return undefined;
  if (before === undefined || before === null) return after.length === 1 ? { value: after[0] } : undefined;
  if (!Array.isArray(before) || after.length !== before.length + 1) return undefined;
  for (let i = 0; i < before.length; i++) {
    if (!isEqual(before[i], after[i])) return undefined;
  }
  return { value: after[after.length - 1] };
}

function pulledElement(before: unknown, after: unknown): { value: unknown; index: number } | undefined {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length + 1) return undefined;
  let k = 0;
  while (k < after.length && isEqual(before[k], after[k])) k++;
  for (let i = k; i < after.length; i++) {
    if (!isEqual(before[i + 1], after[i])) return undefined;
  }
  return { value: before[k], index: k };
}
