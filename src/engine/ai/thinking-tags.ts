/**
 * Thinking-block helpers: the three families of `<think...>` patterns the engine reads.
 *
 * The families differ on purpose (tag set, case sensitivity), so they are NOT merged:
 *   V1  think | thinking | reasoning | thought, case-insensitive  (reply parser, debug capture, tokenizer, field repair)
 *   V2  think | thinking, case-insensitive                         (assistant payload, preset generator)
 *   V3  thinking only, case-sensitive                              (opening and character-init flows)
 *
 * Every call builds a fresh RegExp: a shared `g` instance would carry `lastIndex` between calls.
 * The literals are written out in full so `thinking-tags.test.ts` can pin them to the old ones.
 */

/** Thinking blocks a reply may carry — never part of a story. */
export const THINKING_TAGS: readonly string[] = ['think', 'thinking', 'reasoning', 'thought'];

/** V1 — a new global, case-insensitive matcher; group 1 is the block's content. */
export function thinkingBlockRe(): RegExp {
  return /<(?:think|thinking|reasoning|thought)>([\s\S]*?)<\/(?:think|thinking|reasoning|thought)>/gi;
}

/** V2 — a new global, case-insensitive matcher for `<think>` / `<thinking>`. */
export function thinkOrThinkingBlockRe(): RegExp {
  return /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
}

/** V3 — a new global, case-sensitive matcher for `<thinking>` only. */
export function thinkingTagOnlyRe(): RegExp {
  return /<thinking>[\s\S]*?<\/thinking>/g;
}

/** V1: the trimmed, non-empty block contents joined by a blank line; undefined when there is none. */
export function extractThinkingBlocks(raw: string): string | undefined {
  const blocks: string[] = [];
  const re = thinkingBlockRe();
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const content = match[1]?.trim();
    if (content) blocks.push(content);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/** V1: the text with every block taken out (not trimmed — callers trim as they did before). */
export function stripThinkingBlocks(raw: string): string {
  return raw.replace(thinkingBlockRe(), '');
}

/** V2: the text with every `<think>` / `<thinking>` block taken out. */
export function stripThinkOrThinkingBlocks(text: string): string {
  return text.replace(thinkOrThinkingBlockRe(), '');
}

/** V3: the text with every `<thinking>` block taken out (not trimmed). */
export function stripThinkingTagOnly(text: string): string {
  return text.replace(thinkingTagOnlyRe(), '');
}
