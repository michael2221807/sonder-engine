/**
 * Shared serializer of the path-contract behaviour lock (refactor R4, step 0).
 *
 * Same writing as the R2 reply corpus: key order is kept and undefined-valued keys are written as a mark, so a
 * snapshot also locks which keys exist. Snapshots live in `pipeline/__snapshots__/path-contract/` and are never
 * rewritten with `-u` during the refactor; a changed snapshot is a failed step.
 */
const UNDEFINED_MARK = '__undefined__';

/** Stable text of a snapshot. */
export function serializeContract(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

/** Runs `fn` and returns its result, or the error it throws, as plain data. */
export function recordOutcome(fn: () => unknown): { ok: unknown } | { threw: string } {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}
