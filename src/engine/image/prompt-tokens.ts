// Small prompt-text helpers shared by anchor-injector and output-processor
// (R3 step 4; both files carried byte-identical copies of the first two).

/** Split prompt by commas (newlines count as separators) */
export function splitByComma(text: string): string[] {
  return (text || '')
    .replace(/\r?\n+/g, ', ')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Deduplicate tokens by lowercase key, preserving order and original casing */
export function dedupTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    const normalized = token.replace(/^[-*•\s]+/, '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Apply `re` + `replacer` to `text` repeatedly until the text stops changing,
 * at most `maxPasses` times (nested groups need more than one pass).
 */
export function replaceUntilStable(
  text: string,
  re: RegExp,
  replacer: (match: string, ...groups: string[]) => string,
  maxPasses: number,
): string {
  let output = text;
  for (let i = 0; i < maxPasses; i += 1) {
    const next = output.replace(re, replacer);
    if (next === output) break;
    output = next;
  }
  return output;
}
