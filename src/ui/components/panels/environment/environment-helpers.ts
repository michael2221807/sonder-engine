/**
 * Pure helpers for environment-tags status-bar display (P1, 2026-04-19).
 *
 * Kept as a standalone `.ts` module so unit tests don't need @vue/test-utils
 * (matches the convention used by `round-divider-helpers.ts` and
 * `commands-viewer-helpers.ts`). Vue components import these and stay thin.
 *
 * All functions defensively accept malformed input — the AI occasionally
 * emits partial tag objects during prompt drift, and we must not crash
 * the status-bar.
 */

/** Shape of a single environment / festival tag. Matches pack schema. */
export interface EnvironmentTag {
  名称: string;
  描述: string;
  效果: string;
}

/** Narrow runtime guard — confirms the object has the expected string fields. */
export function isValidTag(obj: unknown): obj is EnvironmentTag {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.名称 !== 'string') return false;
  if (o.名称.trim().length === 0) return false;
  // 描述 and 效果 can be empty strings but must exist as strings.
  if (typeof o.描述 !== 'string') return false;
  if (typeof o.效果 !== 'string') return false;
  return true;
}

/**
 * Format an array of tags into a status-bar chip string.
 *
 * - `cap` controls how many tag names are shown before overflow.
 * - Overflow suffix is `…+N` (three-char ellipsis + count).
 * - Separator is `、` (CJK enumeration comma).
 * - Malformed tags are skipped (so a stray half-typed tag mid-round doesn't
 *   poison the whole display).
 * - Empty input → empty string (caller uses that to hide the chip entirely).
 */
export function formatTagSummary(tags: unknown, cap = 3): string {
  if (!Array.isArray(tags)) return '';
  const valid = tags.filter(isValidTag);
  if (valid.length === 0) return '';
  const shown = valid.slice(0, cap).map((t) => t.名称.trim());
  const overflow = valid.length - shown.length;
  const joined = shown.join('、');
  return overflow > 0 ? `${joined}…+${overflow}` : joined;
}

/**
 * How many tags were NOT shown due to `cap` truncation.
 * Useful for aria-label / screen-reader text or chip tooltips.
 */
export function countOverflow(tags: unknown, cap = 3): number {
  if (!Array.isArray(tags)) return 0;
  const valid = tags.filter(isValidTag);
  return Math.max(0, valid.length - cap);
}

/**
 * Filter an unknown tag array to only valid entries. Used by popover component
 * so rendering doesn't have to re-guard each item.
 */
export function sanitizeTagList(tags: unknown): EnvironmentTag[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter(isValidTag);
}

/**
 * Decide whether to show the festival chip in the status-bar.
 *
 * Hides the chip when the festival is the default `平日` with empty
 * description AND empty effect — which is the canonical "no active festival"
 * state. Any of:
 *   - a different name (e.g. `元宵节`)
 *   - non-empty description
 *   - non-empty effect
 * counts as "there's something to show" and the chip appears.
 *
 * Defensively handles null / undefined / malformed inputs → returns false.
 */
export function isFestivalVisible(festival: unknown): boolean {
  if (!festival || typeof festival !== 'object') return false;
  const f = festival as Record<string, unknown>;
  const name = typeof f.名称 === 'string' ? f.名称.trim() : '';
  const desc = typeof f.描述 === 'string' ? f.描述.trim() : '';
  const effect = typeof f.效果 === 'string' ? f.效果.trim() : '';
  if (name.length === 0) return false;
  if (name !== '平日') return true;
  // name is '平日' — show only if user customized desc or effect.
  return desc.length > 0 || effect.length > 0;
}

/**
 * Normalize a festival value for popover binding. Returns null when there's
 * nothing usable to render (matches `isFestivalVisible` semantics).
 *
 * All three fields are trimmed for consistency — trailing whitespace from an
 * AI stutter shouldn't leak into the popover body.
 */
export function normalizeFestival(festival: unknown): EnvironmentTag | null {
  if (!festival || typeof festival !== 'object') return null;
  const f = festival as Record<string, unknown>;
  const name = typeof f.名称 === 'string' ? f.名称.trim() : '';
  if (name.length === 0) return null;
  return {
    名称: name,
    描述: typeof f.描述 === 'string' ? f.描述.trim() : '',
    效果: typeof f.效果 === 'string' ? f.效果.trim() : '',
  };
}

/**
 * Safe fallback for the weather badge. Empty / whitespace / non-string →
 * the schema default `"晴"`. Prevents a blank chip if AI forgets to set it.
 */
export function normalizeWeather(weather: unknown): string {
  if (typeof weather !== 'string') return '晴';
  const trimmed = weather.trim();
  return trimmed.length > 0 ? trimmed : '晴';
}
