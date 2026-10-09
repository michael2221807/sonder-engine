/**
 * How malformed data in a declared list field becomes the list it should have been, and what kind of entry a list
 * holds. Shared by the command executor (a push onto malformed data, the list guard of a set), the end-of-round type
 * repair (a list field holding something else) and the load-time list recovery, so all of them read a list the same
 * way.
 */

/**
 * The list malformed data in a declared list field should have been: text becomes its first entry (blank text, no
 * entry), an empty object an empty list. Anything else is not repaired (undefined): it may be real data.
 */
export function listFromMalformed(value: unknown): unknown[] | undefined {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return [];
  return undefined;
}

/** A plain object with at least one key — what a list of records holds as one entry. */
export function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * Whether a list holds records: the item types the pack schema declares for it include objects; with none declared,
 * its entries say so (an empty list may hold anything).
 */
export function listHoldsRecords(declaredItemTypes: readonly string[] | undefined, entries: readonly unknown[]): boolean {
  if (declaredItemTypes !== undefined) return declaredItemTypes.includes('object');
  return entries.length === 0 || entries.some(isNonEmptyRecord);
}
