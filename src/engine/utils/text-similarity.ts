/**
 * Character-bigram Dice coefficient for short-text near-duplicate detection.
 *
 * Designed for CJK text (20-80 chars typical) where word segmentation is
 * impractical. Character bigrams naturally capture local context without
 * requiring a tokenizer.
 *
 * Limitation: uses Set (not multiset) for bigrams, so repeated bigrams
 * are collapsed. E.g. "哈哈哈哈" and "哈哈" both reduce to {"哈哈"} and
 * score 1.0. This is acceptable for narrative prose (20-80 chars) where
 * pathological repetition does not occur in practice.
 *
 * Used by:
 * - social/memory-dedup.ts (the push-dedup guard: prevents AI from pushing duplicate
 *   memory entries via commands across rounds)
 * - NpcChatPipeline.appendNpcMemory (prevents duplicate memoryEntry from
 *   private chat)
 */

/** Default Dice coefficient threshold for near-duplicate detection */
export const DEDUP_THRESHOLD = 0.65;

/**
 * Extract character bigrams from a string.
 *
 * For a string of length N, produces N-1 bigrams.
 * Works with any script (CJK, Latin, mixed).
 */
export function extractBigrams(text: string): Set<string> {
  const s = text.trim();
  const bigrams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Sørensen–Dice coefficient on character bigrams.
 *
 * Returns a value in [0, 1] where 1.0 means identical bigram sets.
 * Returns 1 for two identical strings (including two empty strings),
 * 0 when exactly one side is empty.
 */
export function diceCoefficient(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return 1;
  const bgramsA = extractBigrams(ta);
  const bgramsB = extractBigrams(tb);
  if (bgramsA.size === 0 || bgramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bgramsA) {
    if (bgramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bgramsA.size + bgramsB.size);
}

/**
 * Check whether `candidate` is a near-duplicate of any entry in `existing`.
 *
 * Uses exact match first (fast path), then Dice coefficient.
 *
 * @param candidate  The text to check
 * @param existing   Array of texts to compare against
 * @param threshold  Dice coefficient threshold (default: DEDUP_THRESHOLD)
 * @returns true if `candidate` is a near-duplicate of any existing entry
 */
export function isNearDuplicate(
  candidate: string,
  existing: readonly string[],
  threshold: number = DEDUP_THRESHOLD,
): boolean {
  const c = candidate.trim();
  if (!c) return false;

  for (const e of existing) {
    const et = e.trim();
    if (!et) continue;

    if (c === et) return true;
    if (diceCoefficient(c, et) >= threshold) return true;
  }
  return false;
}
