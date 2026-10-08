/**
 * Sparse state-tree overlay merge — shared engine primitive (Story 6 card import).
 *
 * A game card's `stateTree` is a SPARSE world-setup overlay: gameplay history and
 * other transient keys were DELETED at export (not emptied), so they simply do not
 * appear in the overlay. Import rebuilds a schema-default base tree (see
 * `pipeline/state-defaults.ts`) and deep-merges the card overlay on top of it.
 *
 * Semantics:
 * - Objects are deep-merged recursively (overlay wins on leaf conflicts).
 * - Arrays are REPLACED wholesale by the overlay's array — NOT lodash's default
 *   by-index merge. A card array field is an authoritative snapshot, not a
 *   positional patch (e.g. a 3-item card array must not leave element 4 of a longer
 *   base array dangling). Same rationale as the array-replace merge in `core/config-system.ts`.
 * - Keys ABSENT from the overlay keep the base (schema-default) value — this is what
 *   makes the sparse overlay safe: stripped keys fall back to their schema default.
 * - `undefined` overlay values are skipped by lodash `mergeWith` (base survives);
 *   an explicit `null` overlay value DOES override.
 *
 * Pure: neither input is mutated and the returned tree shares no references with
 * either `base` or `overlay`.
 *
 * Engine-layer rule: no game-specific content here — operates purely structurally.
 */
import { mergeWith, cloneDeep } from 'lodash-es';

/**
 * Deep-merge a sparse `overlay` onto `base` with array-replace semantics.
 *
 * @param base    Fully-populated base tree (e.g. the schema-default state tree).
 * @param overlay Sparse overlay whose present keys win; arrays replace wholesale.
 * @returns A new tree; inputs are left untouched.
 */
export function deepMergeOverlay<T extends Record<string, unknown>>(
  base: T,
  overlay: Record<string, unknown>,
): T {
  return mergeWith(
    cloneDeep(base),
    cloneDeep(overlay),
    (_objValue: unknown, srcValue: unknown): unknown => {
      // Arrays replace wholesale instead of merging by index. Returning `srcValue`
      // directly is pure because it references the `cloneDeep(overlay)` copy above —
      // a private temporary, never the caller's `overlay` — so the result shares no
      // reference with either input (asserted by the purity tests). If the overlay
      // pre-clone is ever dropped, this must become `cloneDeep(srcValue)`.
      if (Array.isArray(srcValue)) return srcValue;
      // Everything else falls back to lodash's default deep-merge.
      return undefined;
    },
  ) as T;
}
