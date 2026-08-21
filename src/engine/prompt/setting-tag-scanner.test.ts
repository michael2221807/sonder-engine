import { describe, it, expect } from 'vitest';
import {
  scanSettingTags,
  hasSettingTag,
  normalizeForEvidence,
  parseSettingTagNames,
  DEFAULT_SETTING_TAG_NAMES,
  MAX_SETTING_SEGMENTS,
} from './setting-tag-scanner';

const open = '<设定>';
const close = '</设定>';

describe('normalizeForEvidence', () => {
  it('collapses whitespace runs to a single space and trims', () => {
    expect(normalizeForEvidence('  林月   从小\n\n怕水  ')).toBe('林月 从小 怕水');
  });

  it('applies NFKC so full-width and half-width forms compare equal', () => {
    expect(normalizeForEvidence('ＡＢＣ１２３')).toBe('ABC123');
  });

  it('collapses rather than strips whitespace', () => {
    // Stripping would let "林月 怕水" satisfy a claimed evidence of "林月怕水".
    expect(normalizeForEvidence('林月 怕水')).not.toBe('林月怕水');
  });

  it('handles non-strings', () => {
    expect(normalizeForEvidence(undefined as unknown as string)).toBe('');
  });
});

describe('scanSettingTags — well-formed input', () => {
  it('finds a single segment and reports offsets that slice back to the original', () => {
    const raw = `我带她去码头。${open}林月从小怕水${close}`;
    const { segments } = scanSettingTags(raw);
    expect(segments).toHaveLength(1);
    expect(segments[0].rawText).toBe('林月从小怕水');
    expect(raw.slice(segments[0].startOffset, segments[0].endOffset)).toBe('林月从小怕水');
  });

  it('keeps multiple segments SEPARATE (never concatenated)', () => {
    // This is the cross-segment fabrication guard: joined, "林月怕水" would be a valid
    // contiguous substring even though the player never wrote it.
    const raw = `${open}林月${close}走了很久。${open}怕水${close}`;
    const { segments } = scanSettingTags(raw);
    expect(segments.map((s) => s.normalizedText)).toEqual(['林月', '怕水']);
    expect(segments.some((s) => s.normalizedText.includes('林月怕水'))).toBe(false);
  });

  it('tolerates whitespace inside the delimiters', () => {
    const { segments } = scanSettingTags('< 设定 >林月怕水</ 设定 >');
    expect(segments.map((s) => s.rawText)).toEqual(['林月怕水']);
  });

  it('matches the English tag name too', () => {
    const { segments } = scanSettingTags('<setting>Linyue fears water</setting>');
    expect(segments.map((s) => s.rawText)).toEqual(['Linyue fears water']);
  });

  it('matches tag names case-insensitively', () => {
    const { segments } = scanSettingTags('<SETTING>x</Setting>');
    expect(segments.map((s) => s.rawText)).toEqual(['x']);
  });

  it('assigns sequential indexes', () => {
    const raw = `${open}a${close}${open}b${close}${open}c${close}`;
    expect(scanSettingTags(raw).segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

describe('scanSettingTags — malformed input degrades, never throws', () => {
  it('ignores an unclosed open tag', () => {
    const r = scanSettingTags(`我走了。${open}林月怕水`);
    expect(r.segments).toHaveLength(0);
    expect(r.hadMalformedTag).toBe(true);
  });

  it('ignores an orphan close tag', () => {
    const r = scanSettingTags(`我走了。${close}`);
    expect(r.segments).toHaveLength(0);
    expect(r.hadMalformedTag).toBe(true);
  });

  it('does not support nesting — a second open discards the first', () => {
    const r = scanSettingTags(`${open}外层${open}内层${close}`);
    expect(r.segments.map((s) => s.rawText)).toEqual(['内层']);
    expect(r.hadMalformedTag).toBe(true);
  });

  it('keeps the well-formed segment when a malformed one sits beside it', () => {
    const r = scanSettingTags(`${open}好的${close} 然后 ${open}坏的`);
    expect(r.segments.map((s) => s.rawText)).toEqual(['好的']);
    expect(r.hadMalformedTag).toBe(true);
  });

  it('ignores an empty tag and does not let it consume the cap', () => {
    const r = scanSettingTags(`${open}${close}${open}   ${close}${open}真内容${close}`);
    expect(r.segments.map((s) => s.rawText)).toEqual(['真内容']);
    expect(r.segments[0].index).toBe(0);
  });

  it('returns an empty result for input with no tags at all', () => {
    const r = scanSettingTags('我带她去码头。');
    expect(r.segments).toHaveLength(0);
    expect(r.hadMalformedTag).toBe(false);
  });

  it('handles empty / non-string input', () => {
    expect(scanSettingTags('').segments).toHaveLength(0);
    expect(scanSettingTags(undefined as unknown as string).segments).toHaveLength(0);
  });

  it('a greedy regex would over-capture here; the scanner must not', () => {
    const raw = `${open}A${close}未标记的叙事${open}B${close}`;
    const { segments } = scanSettingTags(raw);
    expect(segments.map((s) => s.rawText)).toEqual(['A', 'B']);
    expect(segments.some((s) => s.rawText.includes('未标记的叙事'))).toBe(false);
  });
});

describe('scanSettingTags — caps are visible, never silent', () => {
  it('caps the number of segments and reports the overflow', () => {
    const raw = Array.from({ length: MAX_SETTING_SEGMENTS + 3 },
      (_, i) => `${open}s${i}${close}`).join('');
    const r = scanSettingTags(raw);
    expect(r.segments).toHaveLength(MAX_SETTING_SEGMENTS);
    expect(r.droppedBySegmentCap).toBe(3);
  });

  it('truncates at the segment boundary when the character cap is hit', () => {
    const raw = `${open}${'x'.repeat(50)}${close}`;
    const r = scanSettingTags(raw, { maxTotalChars: 20 });
    expect(r.segments[0].rawText).toHaveLength(20);
    expect(r.droppedByCharCap).toBe(30);
    // Offsets still slice back correctly after truncation.
    expect(raw.slice(r.segments[0].startOffset, r.segments[0].endOffset))
      .toBe(r.segments[0].rawText);
  });

  it('drops a whole later segment once the character budget is exhausted', () => {
    const raw = `${open}${'x'.repeat(20)}${close}${open}${'y'.repeat(20)}${close}`;
    const r = scanSettingTags(raw, { maxTotalChars: 20 });
    expect(r.segments).toHaveLength(1);
    expect(r.droppedByCharCap).toBe(20);
  });
});

describe('hasSettingTag / parseSettingTagNames', () => {
  it('hasSettingTag is true only for a well-formed pair', () => {
    expect(hasSettingTag(`${open}x${close}`)).toBe(true);
    expect(hasSettingTag(`${open}x`)).toBe(false);
    expect(hasSettingTag('普通输入')).toBe(false);
    expect(hasSettingTag(`${open}${close}`)).toBe(false); // empty tag doesn't count
  });

  it('honours a custom tag name from the pack', () => {
    expect(hasSettingTag('<lore>x</lore>', ['lore'])).toBe(true);
    expect(hasSettingTag('<lore>x</lore>')).toBe(false);
  });

  it('parseSettingTagNames splits on commas (both widths) and whitespace', () => {
    expect(parseSettingTagNames('设定, setting')).toEqual(['设定', 'setting']);
    expect(parseSettingTagNames('设定，setting')).toEqual(['设定', 'setting']);
    expect(parseSettingTagNames('  lore  ')).toEqual(['lore']);
  });

  it('falls back to the defaults for missing / empty pack config', () => {
    expect(parseSettingTagNames(undefined)).toEqual([...DEFAULT_SETTING_TAG_NAMES]);
    expect(parseSettingTagNames('   ')).toEqual([...DEFAULT_SETTING_TAG_NAMES]);
  });
});
