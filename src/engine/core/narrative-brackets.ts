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

/**
 * The narrative without its system lines — the story as the player hears it (speech reads this) and, for a
 * component whose rounds write no system lines (plot vector, PO 2026-10-02), as the model sees its recent story.
 *
 * 1. `<judge>…</judge>` verdict reasoning (closed blocks only, so a cut-off one never swallows the rest).
 * 2. `〖…〗`: scanned exactly like the display's `findJudgementSlices` — each 〖 runs to the nearest 〗, swallowing
 *    any 〖 in between, and an unclosed 〖 leaves the rest alone. A system line (`isSystemBracket`) is left out;
 *    any other is the narrative's own emphasis and keeps its text (PO G2). Changing one scan without the other
 *    would make what is shown and what is read disagree.
 * 3. A verdict or notice written in 【】 by mistake (`【判定:…】`, `【…,判定值:X,…】`, `【系统提示:…】`) — only in
 *    that colon form, so `【环境】`, `【判定日快到了】` or `【任务】难度:高` stay.
 * 4. A stray 〖 or 〗 left by an unclosed bracket.
 */
export function withoutSystemLines(raw: string): string {
  if (!raw) return '';
  let t = raw.replace(/<\s*judge\s*>[\s\S]*?<\s*\/\s*judge\s*>/gi, '');
  let out = '';
  let cursor = 0;
  while (cursor < t.length) {
    const open = t.indexOf('〖', cursor);
    if (open === -1) break;
    const close = t.indexOf('〗', open + 1);
    if (close === -1) break;
    const inner = t.slice(open + 1, close);
    out += t.slice(cursor, open) + (isSystemBracket(inner) ? '' : inner);
    cursor = close + 1;
  }
  t = out + t.slice(cursor);
  t = t.replace(/【([^【】]*)】/g, (whole, inner: string) => {
    const norm = inner.replace(/：/g, ':').replace(/，/g, ',').trim();
    // Narrowly the verdict syntax: a `判定:` type, or a `判定值:` field (判定 alone is an everyday word).
    const looksLikeJudgement = /^判定\s*:/.test(norm) || /判定值\s*:/.test(norm);
    const looksLikeSystemNote = /^系统提示\s*:/.test(norm);
    return looksLikeJudgement || looksLikeSystemNote ? '' : whole;
  });
  return t.replace(/[〖〗]/g, '');
}

/** `withoutSystemLines` as recent story for the model: the blank lines a removed line leaves are closed up. */
export function storyText(raw: string): string {
  return withoutSystemLines(raw).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * `storyText` for a block of separate lines (a memory block's bullets and snippets): each line on its own, so a
 * snippet cut off inside a bracket can never pair with a later line's 〗 and take the lines between with it.
 */
export function storyLines(raw: string): string {
  return raw.split('\n').map(withoutSystemLines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
