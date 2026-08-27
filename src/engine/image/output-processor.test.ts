import { describe, it, expect } from 'vitest';
import {
  stripThinkingBlocks,
  cleanPromptOutput,
  normalizeArtistCase,
  stripAllStructuralTags,
  removeRolePrefixes,
  extractLastTagBlock,
  extractLastTagContent,
  extractFirstMatchingTagContent,
  parseStructuredOutput,
  normalizeNaiWeightSyntax,
  cleanSubjectPrompt,
  normalizeSingleCharacterOutput,
  processTransformerOutput,
} from '@/engine/image/output-processor';

// ── §1 Leaf utilities ──

describe('stripThinkingBlocks', () => {
  it('removes <thinking> blocks', () => {
    expect(stripThinkingBlocks('<thinking>internal thoughts</thinking>tags here')).toBe('tags here');
  });
  it('removes <think> blocks', () => {
    expect(stripThinkingBlocks('<think>thoughts</think>1girl, blue hair')).toBe('1girl, blue hair');
  });
  it('handles mixed case and whitespace', () => {
    expect(stripThinkingBlocks('<Thinking>\nstuff\n</Thinking>\nresult')).toBe('result');
  });
  it('strips unclosed <thinking> up to the next output tag', () => {
    // Regression: gemini-2.5-pro emits `<thinking>...` without `</thinking>`
    // and then prints the final answer wrapped in `<prompt>...</prompt>`.
    // The thinking body often cites the expected output schema verbatim, so
    // naive tag extractors match the template (`<提示词>...</提示词>`) from
    // the body instead of the real answer.
    const raw = '<thinking>\nanalysis mentioning `<提示词>...</提示词>` as a template\n<prompt>\nreal tags, 1man, suit\n</prompt>';
    const result = stripThinkingBlocks(raw);
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('analysis mentioning');
    expect(result).toContain('<prompt>');
    expect(result).toContain('real tags');
  });
  it('handles unclosed <thinking> before <提示词结构>', () => {
    const raw = '<thinking>\nloose analysis <prompt>example</prompt>\n<提示词结构><基础>beach</基础></提示词结构>';
    const result = stripThinkingBlocks(raw);
    expect(result.startsWith('<提示词结构>')).toBe(true);
  });
  it('drops only the <thinking> open tag when no output tag follows', () => {
    // Edge case: unclosed <thinking> with no subsequent schema tag. We still
    // remove the tag itself so downstream parsers don't see junk; the body
    // becomes plain text and flows through the normal cleanup.
    const raw = '<thinking>just free-form analysis';
    const result = stripThinkingBlocks(raw);
    expect(result).toBe('just free-form analysis');
  });
});

describe('cleanPromptOutput', () => {
  it('strips code fences', () => {
    expect(cleanPromptOutput('```text\n1girl, blue hair\n```')).toBe('1girl, blue hair');
  });
  it('strips Chinese label prefix', () => {
    expect(cleanPromptOutput('【生图词组】：1girl, blue hair')).toBe('1girl, blue hair');
  });
  it('strips plain label prefix', () => {
    expect(cleanPromptOutput('生图词组: 1girl, blue hair')).toBe('1girl, blue hair');
  });
});

describe('normalizeArtistCase', () => {
  it('lowercases Artist: to artist:', () => {
    expect(normalizeArtistCase('Artist: name, 1girl')).toBe('artist: name, 1girl');
  });
  it('handles Artist : with space', () => {
    expect(normalizeArtistCase('Artist :name')).toBe('artist:name');
  });
});

describe('stripAllStructuralTags', () => {
  it('replaces all XML tags with spaces', () => {
    expect(stripAllStructuralTags('<基础>content</基础>')).toBe('content');
  });
});

describe('removeRolePrefixes', () => {
  it('removes [1] Name | prefix', () => {
    expect(removeRolePrefixes('[1] Character A | 1girl, blue hair')).toBe('1girl, blue hair');
  });
  it('preserves content without prefix', () => {
    expect(removeRolePrefixes('1girl, blue hair')).toBe('1girl, blue hair');
  });
});

// ── §2 Tag extraction ──

describe('extractLastTagBlock', () => {
  it('extracts the last matching tag block', () => {
    const input = '<提示词>first</提示词> other <提示词>second</提示词>';
    expect(extractLastTagBlock(input, '提示词')).toBe('<提示词>second</提示词>');
  });
  it('returns empty for no match', () => {
    expect(extractLastTagBlock('no tags here', '提示词')).toBe('');
  });
});

describe('extractLastTagContent', () => {
  it('extracts content from last tag block', () => {
    const input = '<提示词>first</提示词><提示词>1girl, blue hair</提示词>';
    expect(extractLastTagContent(input, '提示词')).toBe('1girl, blue hair');
  });
});

describe('extractFirstMatchingTagContent', () => {
  it('returns first matching tag from list', () => {
    const input = '<词组>1girl, tags</词组>';
    expect(extractFirstMatchingTagContent(input, ['提示词', '词组'])).toBe('1girl, tags');
  });
  it('returns empty when no tags match', () => {
    expect(extractFirstMatchingTagContent('plain text', ['提示词', '词组'])).toBe('');
  });
  it('skips placeholder-only candidates and prefers real content', () => {
    // Template example in text vs real content at the end — the `...` match
    // is a placeholder and must not be returned even though it's listed
    // first in the candidate order.
    const input = 'Template: `<提示词>...</提示词>`. Real answer: <prompt>1girl, black hair, red eyes</prompt>';
    expect(extractFirstMatchingTagContent(input, ['提示词', 'prompt'])).toBe('1girl, black hair, red eyes');
  });
  it('skips ellipsis-only content (…)', () => {
    const input = '<提示词>…</提示词><prompt>masterpiece, 1boy</prompt>';
    expect(extractFirstMatchingTagContent(input, ['提示词', 'prompt'])).toBe('masterpiece, 1boy');
  });
  it('returns empty when all candidates are placeholder-only', () => {
    const input = '<提示词>...</提示词><prompt>...</prompt>';
    expect(extractFirstMatchingTagContent(input, ['提示词', 'prompt'])).toBe('');
  });
});

// ── §3 Structured output parsing ──

describe('parseStructuredOutput', () => {
  it('parses XML format with base and roles', () => {
    const input = '<提示词结构><基础>scene tags</基础><角色 名称="Alice">1girl, blue hair</角色></提示词结构>';
    const result = parseStructuredOutput(input);
    expect(result).not.toBeNull();
    expect(result!.base).toBe('scene tags');
    expect(result!.roles).toHaveLength(1);
    expect(result!.roles[0].name).toBe('Alice');
    expect(result!.roles[0].content).toBe('1girl, blue hair');
  });

  it('parses bracket format', () => {
    const input = '【基础】masterpiece, scenery\n【角色：林清霜】1girl, white dress';
    const result = parseStructuredOutput(input);
    expect(result).not.toBeNull();
    expect(result!.base).toContain('masterpiece');
    expect(result!.roles).toHaveLength(1);
    expect(result!.roles[0].content).toContain('1girl');
  });

  it('parses indexed role list [1] format', () => {
    const input = '<角色>[1] Alice | 1girl, blue hair\n[2] Bob | 1boy, red hair</角色>';
    const result = parseStructuredOutput(input);
    expect(result).not.toBeNull();
    expect(result!.roles.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for unstructured text', () => {
    expect(parseStructuredOutput('just plain 1girl, blue hair, no structure')).toBeNull();
  });
});

// ── §4 NAI weight syntax ──

describe('normalizeNaiWeightSyntax', () => {
  it('converts (content:weight) to weight::content::', () => {
    expect(normalizeNaiWeightSyntax('(blue eyes:1.2)')).toBe('1.2::blue eyes::');
  });

  it('handles nested brackets', () => {
    const result = normalizeNaiWeightSyntax('((deep content:0.8):1.5)');
    expect(result).toContain('::');
  });

  it('preserves already-correct NAI syntax', () => {
    expect(normalizeNaiWeightSyntax('1.2::blue eyes::')).toBe('1.2::blue eyes::');
  });

  it('strips thinking blocks before processing', () => {
    expect(normalizeNaiWeightSyntax('<thinking>thoughts</thinking>(blue eyes:1.2)')).toBe('1.2::blue eyes::');
  });

  it('normalizes Artist: case', () => {
    const result = normalizeNaiWeightSyntax('Artist: name, (blue eyes:1.2)');
    expect(result).toContain('artist:');
    expect(result).toContain('1.2::blue eyes::');
  });

  it('handles negative weights', () => {
    expect(normalizeNaiWeightSyntax('(bad anatomy:-0.5)')).toBe('-0.5::bad anatomy::');
  });

  it('cleans dirty weight syntax: stray comma inside group', () => {
    const input = '1.2::blue eyes, ::1.3::long hair::';
    const result = normalizeNaiWeightSyntax(input);
    expect(result).toContain('1.2::blue eyes::');
    expect(result).toContain('1.3::long hair::');
  });
});

// ── §5 Subject prompt cleanup ──

describe('cleanSubjectPrompt', () => {
  it('extracts content from <提示词> tags', () => {
    const input = '<thinking>thoughts</thinking><提示词>1girl, blue hair, school uniform</提示词>';
    expect(cleanSubjectPrompt(input)).toBe('1girl, blue hair, school uniform');
  });

  it('handles structured output with <基础> and <角色>', () => {
    const input = '<基础>masterpiece</基础><角色>[1] Alice | 1girl, blue hair</角色>';
    const result = cleanSubjectPrompt(input);
    expect(result).toContain('masterpiece');
    expect(result).toContain('1girl');
  });

  it('applies NAI weight normalization when isNovelAI', () => {
    const input = '<提示词>(blue eyes:1.2), long hair</提示词>';
    const result = cleanSubjectPrompt(input, { isNovelAI: true });
    expect(result).toContain('1.2::blue eyes::');
  });

  it('strips residual structural tags', () => {
    const input = '1girl, <角色>blue hair</角色>, school uniform';
    const result = cleanSubjectPrompt(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });
});

// ── §6 Single character normalization ──

describe('normalizeSingleCharacterOutput', () => {
  it('flattens structured output into single string', () => {
    const input = '<提示词结构><基础>masterpiece</基础><角色>1girl, blue hair</角色></提示词结构>';
    const result = normalizeSingleCharacterOutput(input);
    expect(result).toContain('masterpiece');
    expect(result).toContain('1girl');
  });

  it('applies NAI weight normalization for NovelAI', () => {
    const input = '1girl, (blue eyes:1.3), long hair';
    const result = normalizeSingleCharacterOutput(input, { isNovelAI: true });
    expect(result).toContain('1.3::blue eyes::');
  });

  it('deduplicates overlapping tokens between base and role', () => {
    const input = '<提示词结构><基础>masterpiece, 1girl</基础><角色>1girl, blue hair</角色></提示词结构>';
    const result = normalizeSingleCharacterOutput(input);
    const tags = result.split(', ');
    const lowerTags = tags.map((t) => t.toLowerCase());
    expect(new Set(lowerTags).size).toBe(lowerTags.length);
    expect(result).toContain('masterpiece');
    expect(result).toContain('blue hair');
  });

  it('strips role placeholder prefixes', () => {
    const input = '<提示词结构><基础>masterpiece</基础><角色>角色1: 1girl, blue hair</角色></提示词结构>';
    const result = normalizeSingleCharacterOutput(input);
    expect(result).not.toContain('角色1');
    expect(result).toContain('1girl');
  });

  it('handles plain flat prompt', () => {
    const input = '<thinking>plan</thinking><提示词>1girl, blue hair, school uniform</提示词>';
    const result = normalizeSingleCharacterOutput(input);
    expect(result).toContain('1girl');
    expect(result).toContain('blue hair');
    expect(result).not.toContain('thinking');
  });

  it('regression: gemini-2.5-pro unclosed <thinking> + template example in body', () => {
    // Mirrors a real response where the thinking tag was never closed and its
    // body cited the output schema verbatim as `<提示词>...</提示词>`. Prior
    // to the stripThinkingBlocks + placeholder-guard fixes, this response
    // caused the extractor to return `...` and the image backend received
    // `"prompt": "..."` — producing garbage images.
    const raw = [
      '',
      '<thinking>',
      '1.  **Deconstruct the Request:**',
      '    *   **Output Format:** `<提示词>...</提示词>`, English tags, comma-separated.',
      '    *   Lots of analysis here without a closing thinking tag.',
      '',
      '    The final prompt is ready.',
      '<prompt>',
      '(masterpiece, best quality), (1man, middle-aged, elegant merchant:1.2), (lean face, goatee, gold-rimmed glasses:1.3), portrait, looking at viewer, soft lighting',
      '</prompt>',
    ].join('\n');

    const result = normalizeSingleCharacterOutput(raw);

    expect(result).not.toBe('...');
    expect(result).not.toContain('Deconstruct');
    expect(result).toContain('masterpiece');
    expect(result).toContain('1man');
    expect(result).toContain('gold-rimmed glasses');
    expect(result).toContain('soft lighting');
  });
});

// ── §7 Multi-character output processing ──

describe('processTransformerOutput', () => {
  it('flat strategy: returns cleaned prompt', () => {
    const input = '<提示词>1girl, blue hair, masterpiece</提示词>';
    const result = processTransformerOutput(input, { strategy: 'flat' });
    expect(result).toBe('1girl, blue hair, masterpiece');
  });

  it('nai_character_segments: joins with | separator', () => {
    const input = '<提示词结构><基础>masterpiece, scenery</基础><角色>1girl, blue hair</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'nai_character_segments' });
    expect(result).toContain('masterpiece');
    expect(result).toContain('|');
    expect(result).toContain('1girl');
  });

  it('gemini_structured: uses Base scene label', () => {
    const input = '<提示词结构><基础>scenery tags</基础><角色 名称="A">1girl</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'gemini_structured' });
    expect(result).toContain('Base scene:');
    expect(result).toContain('Character 1:');
  });

  it('grok_structured: uses Scene staging label', () => {
    const input = '<提示词结构><基础>scenery</基础><角色>1girl</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'grok_structured' });
    expect(result).toContain('Scene staging:');
  });

  it('sd_danbooru: comma-joins structured output without pipe separators', () => {
    const input = '<提示词结构><基础>outdoors, scenery, sunset</基础><角色>[1]Alice|1girl, long_hair, blue_eyes\n[2]Bob|1boy, short_hair</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'sd_danbooru' });
    expect(result).not.toContain('|');
    expect(result).not.toContain('Base scene');
    expect(result).not.toContain('Scene staging');
    expect(result).toContain('outdoors');
    expect(result).toContain('1girl');
    expect(result).toContain('1boy');
  });

  it('sd_danbooru: preserves A1111 weight syntax without NAI normalization', () => {
    const input = '<提示词>1girl, (blue_hair:1.3), (red_eyes:1.2), school_uniform</提示词>';
    const result = processTransformerOutput(input, { strategy: 'sd_danbooru' });
    expect(result).toContain('(blue_hair:1.3)');
    expect(result).toContain('(red_eyes:1.2)');
    expect(result).not.toContain('::');
  });

  it('falls back to cleanSubjectPrompt for unstructured input', () => {
    const input = '<提示词>1girl, blue hair</提示词>';
    const result = processTransformerOutput(input, { strategy: 'flat' });
    expect(result).toBe('1girl, blue hair');
  });

  // ── seedream_narrative (Doubao Seedream, 2026-08-27) ──

  it('seedream_narrative: joins base and characters as Chinese narrative paragraphs', () => {
    const input = '<提示词结构><基础>黄昏的青石长街上灯火初上，镜头从街口平视望去。</基础><角色>[1]甲|一位青衣女子立在灯下，手按剑柄，目光望向街尾。\n[2]乙|一名灰袍老者背对镜头缓步走远。</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'seedream_narrative' });
    expect(result).toContain('黄昏的青石长街');
    expect(result).toContain('画面中的角色1：一位青衣女子');
    expect(result).toContain('画面中的角色2：一名灰袍老者');
    // Paragraph join — no pipe segments, no English labels
    expect(result).not.toContain('|');
    expect(result).not.toContain('Base scene');
    expect(result.split('\n')).toHaveLength(3);
  });

  it('seedream_narrative: single character drops the numeric label', () => {
    const input = '<提示词结构><基础>雨后的庭院，苔痕青青。</基础><角色>[1]甲|少女撑伞立于檐下。</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'seedream_narrative' });
    expect(result).toContain('画面中的角色：少女撑伞立于檐下。');
    expect(result).not.toContain('角色1');
  });

  it('seedream_narrative: base-only scene passes through without labels', () => {
    const input = '<提示词结构><基础>云海翻涌的山巅，一轮红日破晓。</基础></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'seedream_narrative' });
    expect(result).toBe('云海翻涌的山巅，一轮红日破晓。');
  });

  it('seedream_narrative: unstructured input returns cleaned narrative untouched', () => {
    const input = '<提示词>一位白衣少年负手立于桥头，晨雾漫过石栏。</提示词>';
    const result = processTransformerOutput(input, { strategy: 'seedream_narrative' });
    expect(result).toBe('一位白衣少年负手立于桥头，晨雾漫过石栏。');
  });

  it('seedream_narrative: empty base with multiple characters keeps only labeled paragraphs', () => {
    const input = '<提示词结构><基础></基础><角色>[1]甲|红衣女子执灯而立。\n[2]乙|黑衣男子按刀在侧。</角色></提示词结构>';
    const result = processTransformerOutput(input, { strategy: 'seedream_narrative' });
    expect(result.split('\n')).toHaveLength(2);
    expect(result.startsWith('画面中的角色1：红衣女子')).toBe(true);
    expect(result).toContain('画面中的角色2：黑衣男子');
  });
});
