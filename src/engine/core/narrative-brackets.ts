/**
 * `〖…〗` in the narrative: a system line (a verdict such as `类型:结果,判定值:X,…`, or a notice such as
 * `系统提示：…`) names a key before a colon in its first clause. Anything else is the narrative's own
 * emphasis — a thought, a beat — and must read as text: the display shows it in full and speech reads it
 * (2026-09-26, PO G2; the model imitates old lines of this kind from the save's history).
 *
 * Shared by the display (formatted-text-parser) and speech (sentence-splitter) so what is shown and what is
 * read can never disagree.
 */
export function isSystemBracket(inner: string): boolean {
  // An unclosed 〖 earlier in the text swallowed this one: malformed, so stay on the old safe side and treat it as
  // a system line (hidden from speech, shown as a chip) rather than risk showing a verdict as prose.
  if (inner.includes('〖')) return true;
  const firstClause = inner.split(/[,，]/)[0] ?? '';
  return /[:：]/.test(firstClause);
}
