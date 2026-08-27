/**
 * Output Processor — processes raw AI transformer output into clean image prompts.
 *
 * Ported — full processing pipeline including:
 * - Thinking block removal
 * - Code fence / label stripping
 * - Structured output parsing (<基础><角色> or 【基础】【角色】 formats)
 * - NAI weight syntax normalization: (content:weight) → weight::content::
 * - Dirty weight syntax cleanup (malformed groups)
 * - Artist tag case normalization
 * - Subject prompt cleanup with tag extraction
 *
 * Two entry points:
 * - normalizeSingleCharacterOutput — for NPC portraits + secret parts
 * - processTransformerOutput — for multi-character/scene (core only; full
 *   multi-character serialization deferred to Phase 1.6)
 */

// ═══════════════════════════════════════════════════════════
// §1 — Shared types
// ═══════════════════════════════════════════════════════════

/** Parsed structured output with base scene + per-character segments */
export interface StructuredOutput {
  base: string;
  roles: Array<{ name: string; content: string }>;
}

/** Serialization strategy — image prompt serialization strategy type */
export type SerializationStrategy = 'flat' | 'nai_character_segments' | 'gemini_structured' | 'grok_structured' | 'sd_danbooru' | 'seedream_narrative';

// ═══════════════════════════════════════════════════════════
// §2 — Leaf utilities (no internal dependencies)
// ═══════════════════════════════════════════════════════════

/** Strip <thinking> and <think> blocks — ported */
export function stripThinkingBlocks(rawText: string): string {
  let text = rawText || '';
  // Pass 1: paired <thinking>...</thinking> / <think>...</think>
  text = text
    .replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, '')
    .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '');

  // Pass 2: unclosed <thinking> — some LLMs (observed on gemini-2.5-pro) emit
  // an opening `<thinking>` tag and never close it before printing the final
  // answer. Without this pass, the thinking body leaks into parsing; worse,
  // the body often cites the expected output schema verbatim (e.g. the string
  // "`<提示词>...</提示词>`"), so tag-extractors match the template example
  // and return the literal `...` placeholder as the prompt.
  //
  // Strategy: strip from `<thinking>` up to the LAST top-level output tag
  // in the remaining text — that's where the real answer lives. Any earlier
  // tag matches inside the thinking body are schema citations / examples.
  // Only top-level container tags (<prompt>, <提示词>, <提示词结构>, <词组>,
  // <生图词组>) anchor the split; sub-tags like <基础> / <角色> don't, because
  // they live INSIDE <提示词结构> and splitting there would truncate the
  // structured wrapper.
  //
  // If no top-level output tag follows, drop only the `<thinking>` open tag
  // itself so downstream parsers see the body as raw text.
  const thinkingOpen = /<\s*(thinking|think)\s*>/i.exec(text);
  if (thinkingOpen) {
    const openIdx = thinkingOpen.index;
    const afterOpen = openIdx + thinkingOpen[0].length;
    const topLevelOutputTag = /<\s*(prompt|提示词结构|提示词|生图词组|词组)(?=[>\s/])[^>]*>/gi;
    topLevelOutputTag.lastIndex = afterOpen;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = topLevelOutputTag.exec(text))) {
      lastMatch = m;
    }
    if (lastMatch) {
      text = text.slice(0, openIdx) + text.slice(lastMatch.index);
    } else {
      text = text.slice(0, openIdx) + text.slice(afterOpen);
    }
  }

  return text.trim();
}

/** Strip code fences + label prefixes — ported */
export function cleanPromptOutput(rawText: string): string {
  return (rawText || '')
    .replace(/^```(?:text|markdown|json)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^【?生图词组】?[:：]?/i, '')
    .trim();
}

/** Normalize "Artist:" → "artist:" — ported */
export function normalizeArtistCase(rawText: string): string {
  return (rawText || '').replace(/\bArtist\s*:/g, 'artist:');
}

/** Strip all XML-like structural tags — ported */
export function stripAllStructuralTags(rawText: string): string {
  return (rawText || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove [1] Name | prefix lines — ported */
export function removeRolePrefixes(rawText: string): string {
  return (rawText || '')
    .replace(/(^|\n)\s*\[\d+\]\s*[^|\n<>]{1,80}\|/g, '$1')
    .trim();
}

// ═══════════════════════════════════════════════════════════
// §3 — Tag extraction
// ═══════════════════════════════════════════════════════════

/** Extract last occurrence of <tagName>...</tagName> — ported */
export function extractLastTagBlock(rawText: string, tagName: string): string {
  const source = (rawText || '').trim();
  if (!source) return '';
  // Use (?=[>\s/]) lookahead instead of \b — Chinese characters are non-word chars
  // so \b fails between Chinese and '>'. Lookahead ensures exact tag name match.
  const regex = new RegExp(`<\\s*${tagName}(?=[>\\s/])[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tagName}\\s*>`, 'gi');
  const matches = source.match(regex);
  return Array.isArray(matches) && matches.length > 0 ? (matches[matches.length - 1] || '').trim() : '';
}

/** Extract text inside the last <tagName> block — ported */
export function extractLastTagContent(rawText: string, tagName: string): string {
  const block = extractLastTagBlock(rawText, tagName);
  if (!block) return '';
  return block
    .replace(new RegExp(`^<\\s*${tagName}(?=[>\\s/])[^>]*>`, 'i'), '')
    .replace(new RegExp(`<\\s*\\/\\s*${tagName}\\s*>$`, 'i'), '')
    .trim();
}

/** Try multiple tag names, return first match — ported.
 *
 *  Candidates that resolve to placeholder-only content (e.g. `...`, `…`,
 *  whitespace, or Chinese/English template markers) are skipped. This matters
 *  when an LLM's thinking body cites the expected schema verbatim — without
 *  this guard, `<提示词>...</提示词>` from a template example would match
 *  before the real `<prompt>...</prompt>` at the end of the response and the
 *  extractor would hand the literal `...` back to the image pipeline.
 */
export function extractFirstMatchingTagContent(rawText: string, tagNames: string[]): string {
  let firstNonEmpty = '';
  for (const tagName of tagNames) {
    const text = extractLastTagContent(rawText, tagName);
    if (!text) continue;
    if (!firstNonEmpty) firstNonEmpty = text;
    if (!isPlaceholderContent(text)) return text;
  }
  // All candidates were placeholder-only. Return empty so the caller falls
  // through to its next strategy rather than POSTing `...` to the backend.
  return firstNonEmpty && !isPlaceholderContent(firstNonEmpty) ? firstNonEmpty : '';
}

/** True for content consisting only of ellipses, dots, or template markers.
 *
 *  Intentionally narrow: we only reject content that is unambiguously a
 *  placeholder (literal `...` / `…`, Chinese bracket markers like 【占位】,
 *  or whitespace). Short Chinese phrases such as "场景快照" are real answers
 *  at 4 characters and MUST NOT be filtered.
 */
function isPlaceholderContent(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  // Strip outer code fences / backticks that often wrap template examples.
  const core = trimmed.replace(/^`+|`+$/g, '').trim();
  if (!core) return true;
  // Dots / ellipsis only (including CJK full-width)
  if (/^[.。…·\s]+$/.test(core)) return true;
  // Chinese template markers like 【占位】 or 【提示词】
  if (/^【[^】]*】$/.test(core)) return true;
  return false;
}

/** Parse XML-like attributes from tag opening — ported */
function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([^\s=]+)\s*=\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(raw || ''))) {
    const key = (match[1] || '').trim();
    const value = (match[2] || '').trim();
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

// ═══════════════════════════════════════════════════════════
// §4 — Indexed role list parsing
// ═══════════════════════════════════════════════════════════

/** Parse [1] Name | content format into role list */
function parseIndexedRoleList(rawText: string): Array<{ name: string; content: string }> {
  const source = (rawText || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  const roles: Array<{ name: string; content: string }> = [];
  const regex = /(?:^|\n)\s*\[(\d+)\]\s*([\s\S]*?)(?=(?:\n\s*\[\d+\]\s*)|$)/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(source))) {
    const index = Number(match[1] || String(roles.length + 1));
    const payload = cleanPromptOutput(match[2] || '');
    if (!payload) continue;
    const separatorIndex = payload.indexOf('|');
    const maybeName = separatorIndex >= 0 ? payload.slice(0, separatorIndex).trim() : '';
    const maybeContent = separatorIndex >= 0 ? payload.slice(separatorIndex + 1).trim() : payload;
    const safeName = maybeName && !/,/.test(maybeName) ? maybeName : `role${index}`;
    const safeContent = cleanPromptOutput(maybeContent);
    if (!safeContent) continue;
    roles.push({ name: safeName, content: safeContent });
  }
  return roles;
}

// ═══════════════════════════════════════════════════════════
// §5 — Structured output parsing
// ═══════════════════════════════════════════════════════════

/**
 * Parse AI transformer output into structured base + role segments.
 * Supports two formats:
 * 1. XML: <提示词结构><基础>...</基础><角色 名称="X">...</角色></提示词结构>
 * 2. Brackets: 【基础】...【角色：X】...
 */
export function parseStructuredOutput(rawText: string): StructuredOutput | null {
  const source = (extractLastTagBlock(rawText, '提示词结构') || rawText || '').trim();
  if (!source) return null;

  // Try XML format: <基础>...</基础> + <角色>...</角色>
  const baseBlock = extractLastTagBlock(source, '基础');
  const base = baseBlock ? extractLastTagContent(baseBlock, '基础') : extractLastTagContent(source, '基础');
  const roles: Array<{ name: string; content: string }> = [];

  const roleRegex = /<\s*角色(?=[>\s/])([^>]*)>([\s\S]*?)<\s*\/\s*角色\s*>/gi;
  let roleMatch: RegExpExecArray | null = null;
  let roleIndex = 0;
  while ((roleMatch = roleRegex.exec(source))) {
    const attrs = parseTagAttributes(roleMatch[1] || '');
    const rawContent = roleMatch[2] || '';
    const indexedRoles = parseIndexedRoleList(rawContent);
    if (indexedRoles.length > 0 && !attrs['名称'] && !attrs.name && !attrs.role && !attrs['角色']) {
      for (const item of indexedRoles) {
        roles.push(item);
        roleIndex += 1;
      }
      continue;
    }
    const name = (attrs['名称'] || attrs.name || attrs.role || attrs['角色'] || `role${roleIndex + 1}`).trim();
    const content = cleanPromptOutput(rawContent);
    if (name || content) {
      roles.push({ name, content });
      roleIndex += 1;
    }
  }

  if (roles.length <= 0) {
    const roleContent = extractLastTagContent(source, '角色');
    const indexed = parseIndexedRoleList(roleContent);
    if (indexed.length > 0) roles.push(...indexed);
  }

  if (base || roles.length > 0) {
    return { base: cleanPromptOutput(base), roles };
  }

  // Try bracket format: 【基础】...【角色：X】...
  const bracketSource = source.replace(/\r\n/g, '\n');
  const blockRegex = /【\s*(基础|角色(?:\s*[:：]\s*([^\]】]+))?)\s*】([\s\S]*?)(?=【\s*(?:基础|角色)|$)/g;
  let blockMatch: RegExpExecArray | null = null;
  let bracketBase = '';
  const bracketRoles: Array<{ name: string; content: string }> = [];
  while ((blockMatch = blockRegex.exec(bracketSource))) {
    const section = (blockMatch[1] || '').trim();
    const roleName = (blockMatch[2] || '').trim();
    const content = cleanPromptOutput(blockMatch[3] || '');
    if (!content) continue;
    if (section.startsWith('基础')) {
      bracketBase = content;
      continue;
    }
    bracketRoles.push({ name: roleName || `role${bracketRoles.length + 1}`, content });
  }
  if (!bracketBase && bracketRoles.length <= 0) return null;
  return { base: bracketBase, roles: bracketRoles };
}

// ═══════════════════════════════════════════════════════════
// §6 — NAI weight syntax normalization
// ═══════════════════════════════════════════════════════════

/**
 * Convert SD-style (content:weight) → NAI weight::content:: syntax.
 * Iterates up to 8 times for nested groups.
 * Convert SD-style bracket weight to NAI syntax — ported
 */
function convertBracketWeightSyntax(rawText: string): string {
  let output = rawText || '';
  // Pass 1: (content:weight) → weight::content::
  for (let i = 0; i < 8; i += 1) {
    const next = output.replace(/\(([^()]+?)\s*:\s*(-?\d+(?:\.\d+)?)\)/g, (_match, content, weight) => {
      const cleanedContent = cleanPromptOutput(String(content || ''));
      const cleanedWeight = String(weight || '').trim();
      if (!cleanedContent || !cleanedWeight) return '';
      return `${cleanedWeight}::${cleanedContent}::`;
    });
    if (next === output) break;
    output = next;
  }
  // Pass 2: strip parentheses wrapping existing weight syntax: ( weight::content:: ) → weight::content::
  for (let i = 0; i < 8; i += 1) {
    const next = output.replace(/\(\s*(-?\d+(?:\.\d+)?)::([\s\S]*?)::\s*\)/g, (_match, weight, content) => {
      const cleanedContent = cleanPromptOutput(String(content || ''));
      const cleanedWeight = String(weight || '').trim();
      if (!cleanedContent || !cleanedWeight) return '';
      return `${cleanedWeight}::${cleanedContent}::`;
    });
    if (next === output) break;
    output = next;
  }
  return normalizeArtistCase(output);
}

/**
 * Fix malformed NAI weight groups (stray commas inside groups, etc.)
 * Fix malformed NAI weight groups — ported
 */
function cleanDirtyWeightSyntax(rawText: string): string {
  let output = rawText || '';

  // Fix: weight::content, ::weight::content:: → weight::content::, weight::content::
  for (let i = 0; i < 8; i += 1) {
    const next = output.replace(
      /(-?\d+(?:\.\d+)?)::\s*([^:]+?)\s*,\s*::\s*(-?\d+(?:\.\d+)?)::\s*([^:]+?)::/g,
      (_match, lw, lc, rw, rc) => {
        const leftW = String(lw || '').trim();
        const rightW = String(rw || '').trim();
        const leftC = cleanPromptOutput(String(lc || ''));
        const rightC = cleanPromptOutput(String(rc || ''));
        const parts = [
          leftW && leftC ? `${leftW}::${leftC}::` : '',
          rightW && rightC ? `${rightW}::${rightC}::` : '',
        ].filter(Boolean);
        return parts.join(', ');
      },
    );
    if (next === output) break;
    output = next;
  }

  // Fix: , ::weight::content:: → , weight::content::
  for (let i = 0; i < 8; i += 1) {
    const next = output.replace(
      /,\s*::\s*(-?\d+(?:\.\d+)?)::\s*([^:]+?)::/g,
      (_match, weight, content) => {
        const w = String(weight || '').trim();
        const c = cleanPromptOutput(String(content || ''));
        if (!w || !c) return '';
        return `, ${w}::${c}::`;
      },
    );
    if (next === output) break;
    output = next;
  }

  // Fix: weight::content, :: → weight::content::,
  for (let i = 0; i < 8; i += 1) {
    const next = output.replace(
      /(-?\d+(?:\.\d+)?)::\s*([^:]+?)\s*,\s*::/g,
      (_match, weight, content) => {
        const w = String(weight || '').trim();
        const c = cleanPromptOutput(String(content || ''));
        if (!w || !c) return '';
        return `${w}::${c}::, `;
      },
    );
    if (next === output) break;
    output = next;
  }

  // Final cleanup: collapse repeated commas and whitespace
  output = output
    .replace(/,\s*,+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();

  return output;
}

/**
 * Full NAI weight syntax normalization pipeline.
 * Full NAI weight syntax normalization pipeline — ported
 */
export function normalizeNaiWeightSyntax(rawText: string): string {
  const cleaned = cleanPromptOutput(
    cleanDirtyWeightSyntax(
      convertBracketWeightSyntax(
        stripThinkingBlocks(rawText),
      ),
    ),
  );
  return cleaned || '';
}

// ═══════════════════════════════════════════════════════════
// §7 — Subject prompt cleanup
// ═══════════════════════════════════════════════════════════

/**
 * Clean the final subject prompt from raw AI output.
 * Tries structured extraction first, then falls back to tag-based extraction.
 * Clean final subject prompt — ported
 */
export function cleanSubjectPrompt(rawText: string, options?: { isNovelAI?: boolean }): string {
  const withoutThinking = stripThinkingBlocks(rawText);

  // Try structured: extract <基础> and <角色> segments
  const baseContent = extractLastTagContent(withoutThinking, '基础');
  const roleBlockContent = extractLastTagContent(withoutThinking, '角色');
  const indexedRoles = parseIndexedRoleList(roleBlockContent || withoutThinking);

  if (indexedRoles.length > 0) {
    const safeBase = normalizeArtistCase(cleanPromptOutput(baseContent || ''));
    const safeRoles = indexedRoles
      .map((item) => normalizeArtistCase(cleanPromptOutput(item.content || '')))
      .filter(Boolean);
    const mergedStructured = options?.isNovelAI
      ? [safeBase, ...safeRoles].filter(Boolean).join(' | ')
      : [safeBase, ...safeRoles].filter(Boolean).join('; ');
    if (mergedStructured.trim()) {
      return options?.isNovelAI ? normalizeNaiWeightSyntax(mergedStructured) : mergedStructured.trim();
    }
  }

  // Fallback: extract from <提示词>, <prompt>, <词组>, or <生图词组> tags
  const extracted = extractFirstMatchingTagContent(withoutThinking, ['提示词', 'prompt', '词组', '生图词组'])
    || extractLastTagContent(withoutThinking, '基础')
    || withoutThinking;

  const withoutResidualTags = removeRolePrefixes(
    stripAllStructuralTags(
      (extracted || '')
        .replace(/<\s*\/?\s*提示词\s*>/gi, '')
        .replace(/<\s*\/?\s*prompt\s*>/gi, '')
        .replace(/<\s*\/?\s*词组\s*>/gi, '')
        .replace(/<\s*\/?\s*生图词组\s*>/gi, '')
        .trim(),
    ),
  );

  const cleaned = normalizeArtistCase(cleanPromptOutput(withoutResidualTags));
  if (!cleaned) return '';
  return options?.isNovelAI ? normalizeNaiWeightSyntax(cleaned) : cleaned;
}

// ═══════════════════════════════════════════════════════════
// §8 — Entry points
// ═══════════════════════════════════════════════════════════

/**
 * Strip role placeholder prefixes from NAI character segment text.
 * Strip NAI role placeholder prefixes — ported
 */
function stripRolePlaceholders(text: string): string {
  const source = cleanPromptOutput(text)
    .replace(/^\[\d+\]\s*/u, '')
    .replace(/^(?:主体|角色\s*\d+|character\s*\d+|role\s*\d+|subject)\s*[:：\-]?\s*/iu, '')
    .trim();
  if (!source) return '';
  return splitByComma(source)
    .filter(Boolean)
    .filter((token) => !/^(?:主体|角色\s*\d+|character\s*\d+|role\s*\d+|subject)\s*[:：\-]?$/iu.test(token))
    .join(', ');
}

/** Split prompt by commas */
function splitByComma(text: string): string[] {
  return (text || '')
    .replace(/\r?\n+/g, ', ')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Deduplicate tokens by lowercase key, preserving order and original casing */
function dedupTokens(tokens: string[]): string[] {
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

/** Merge and deduplicate prompt parts (simplified) */
function mergeAndDedup(...parts: Array<string | undefined>): string {
  const allTokens = parts
    .filter(Boolean)
    .flatMap((part) => splitByComma(part!));
  return normalizeArtistCase(dedupTokens(allTokens).join(', '));
}

/**
 * Normalize single-character transformer output.
 * Used for NPC portraits and secret parts (single subject, no multi-character segments).
 * Normalize single-character transformer output — ported
 */
export function normalizeSingleCharacterOutput(
  rawText: string,
  options?: { isNovelAI?: boolean },
): string {
  const sanitized = stripThinkingBlocks(rawText);
  const structured = parseStructuredOutput(sanitized);

  let merged: string;
  if (structured) {
    // Flatten structured output: strip role placeholders + dedup
    // Strip role placeholders + merge positive prompt fragments (which deduplicates)
    const roleParts = (structured.roles || [])
      .map((role) => stripRolePlaceholders(role.content || ''))
      .filter(Boolean);
    merged = mergeAndDedup(structured.base, ...roleParts);
  } else {
    merged = cleanSubjectPrompt(sanitized, { isNovelAI: options?.isNovelAI });
  }

  return options?.isNovelAI
    ? normalizeNaiWeightSyntax(merged)
    : cleanPromptOutput(merged);
}

/**
 * Process multi-character transformer output with serialization strategy.
 * Core path: parses structured output → routes by strategy.
 * Full scene-specific serialization (anchor matching, NAI segment helpers)
 * will be completed in Phase 1.6.
 * Serialize transformer output — ported
 */
export function processTransformerOutput(
  rawText: string,
  options?: { strategy?: SerializationStrategy; isNovelAI?: boolean },
): string {
  const strategy = options?.strategy || 'flat';
  const sanitized = stripThinkingBlocks(rawText);
  const structured = parseStructuredOutput(sanitized);

  if (structured) {
    // For flat strategy or when no scene anchors, serialize inline
    const safeBase = normalizeArtistCase(cleanPromptOutput(structured.base || ''));
    const roleTexts = (structured.roles || [])
      .map((r) => normalizeArtistCase(cleanPromptOutput(r.content || '')))
      .filter(Boolean);

    if (strategy === 'nai_character_segments') {
      const segments = roleTexts.length > 0
        ? [safeBase, ...roleTexts].filter(Boolean).join(' | ')
        : safeBase;
      return normalizeNaiWeightSyntax(segments);
    }

    if (strategy === 'sd_danbooru') {
      // SD/Danbooru models use comma-separated tags natively
      // No NAI weight normalization — A1111 (tag:1.3) syntax is native
      const parts = [safeBase, ...roleTexts].filter(Boolean);
      return parts.join(', ');
    }

    if (strategy === 'gemini_structured' || strategy === 'grok_structured') {
      const baseLabel = strategy === 'grok_structured' ? 'Scene staging' : 'Base scene';
      const parts = [
        safeBase ? `${baseLabel}: ${safeBase}` : '',
        ...roleTexts.map((text, i) => `Character ${i + 1}: ${text}`),
      ].filter(Boolean);
      return parts.join('; ');
    }

    if (strategy === 'seedream_narrative') {
      // Doubao Seedream reads the whole prompt as ONE coherent natural-language
      // instruction (no tag stacking, no weight syntax, Chinese-native) — join
      // the base scene and per-character descriptions as flowing paragraphs.
      // Labels stay Chinese on purpose: the ruleset asks the transformer for
      // Chinese narrative output (calibrated 2026-08-27).
      const parts = [
        safeBase,
        ...roleTexts.map((text, i) =>
          roleTexts.length > 1 ? `画面中的角色${i + 1}：${text}` : `画面中的角色：${text}`),
      ].filter(Boolean);
      return parts.join('\n');
    }

    // flat: merge all parts
    return normalizeArtistCase(cleanPromptOutput([safeBase, ...roleTexts].filter(Boolean).join(', ')));
  }

  // No structured output — clean as flat prompt
  const cleaned = cleanSubjectPrompt(sanitized, { isNovelAI: strategy === 'nai_character_segments' });
  if (!cleaned) return '';
  if (strategy === 'flat') return cleaned;

  // Non-flat strategy with flat input — wrap as base-only
  if (strategy === 'nai_character_segments') return normalizeNaiWeightSyntax(cleaned);
  // sd_danbooru / gemini_structured / grok_structured / seedream_narrative:
  // return cleaned text as-is (no NAI weight normalization — A1111 syntax is
  // native for SD models; Seedream narrative text has no weight syntax at all)
  return cleaned;
}
