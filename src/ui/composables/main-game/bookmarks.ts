/**
 * Bookmarked-rounds list helpers for MainGamePanel (R7 step 4). Pure functions moved
 * out of the panel; reading the list from the state tree and writing it back
 * (`writeBookmarks`) stays in the panel.
 */
import type { BookmarkedRound } from '@/engine/pipeline/types';

/** Default name for a fresh bookmark: first ~10 non-space chars of the narrative. */
export function defaultBookmarkName(content: string, unnamed: () => string): string {
  const stripped = content.replace(/\s+/g, '');
  return stripped.length > 10 ? stripped.slice(0, 10) : (stripped || unnamed());
}

/**
 * Toggle the bookmark of `round`: remove it when present, otherwise append the
 * entry built by `makeEntry` (only called when adding) and keep the list sorted by
 * round descending (newest floors first). Never mutates `list`.
 */
export function toggleBookmarkList(
  list: ReadonlyArray<BookmarkedRound>,
  round: number,
  makeEntry: () => BookmarkedRound,
): BookmarkedRound[] {
  const existing = list.findIndex((b) => b.round === round);
  if (existing >= 0) {
    const next = list.slice();
    next.splice(existing, 1);
    return next;
  }
  const bm = makeEntry();
  return [...list, bm].sort((a, b) => b.round - a.round);
}

/** Compact preview for a bookmark row snippet. */
export function bookmarkSnippet(content: string, n = 48): string {
  const s = content.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
