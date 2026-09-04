import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatTokens,
  findFirstAssistantIdx,
  findLatestAssistantIdx,
  roundForAssistantAt,
  deriveDisplayMetrics,
  countCjkChars,
  truncate,
  type DividerMsg,
} from './round-divider-helpers';

const u = (): DividerMsg => ({ role: 'user' });
const a = (roundNumber?: number): DividerMsg =>
  roundNumber != null
    ? { role: 'assistant', _metrics: { roundNumber } }
    : { role: 'assistant' };

describe('formatDuration', () => {
  it('returns 0s for zero / negative / non-finite', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-100)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(Infinity)).toBe('0s');
  });

  it('returns em-dash for "unknown"', () => {
    expect(formatDuration('unknown')).toBe('—');
  });

  it('shows one decimal for sub-10s', () => {
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(9999)).toBe('10.0s');
    expect(formatDuration(500)).toBe('0.5s');
  });

  it('rounds to whole seconds for >= 10s', () => {
    expect(formatDuration(10001)).toBe('10s');
    expect(formatDuration(139_000)).toBe('139s');
    expect(formatDuration(45_600)).toBe('46s');
  });
});

describe('formatTokens', () => {
  it('returns "0" for zero / negative / non-finite', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(NaN)).toBe('0');
  });

  it('returns em-dash for "unknown"', () => {
    expect(formatTokens('unknown')).toBe('—');
  });

  it('uses en-US thousands separator', () => {
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(48845)).toBe('48,845');
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });

  it('floors decimals', () => {
    expect(formatTokens(1234.9)).toBe('1,234');
  });
});

describe('deriveDisplayMetrics', () => {
  it('returns the stored _metrics unchanged for modern entries', () => {
    const msg: DividerMsg & { _metrics: object } = {
      role: 'assistant',
      content: 'narrative',
      _metrics: {
        roundNumber: 7,
        durationMs: 3456,
        inputTokens: 12345,
        outputTokens: 678,
        startedAt: 9999,
      },
    };
    const out = deriveDisplayMetrics(msg, 999 /* ignored */);
    expect(out).toEqual({
      roundNumber: 7,
      durationMs: 3456,
      inputTokens: 12345,
      outputTokens: 678,
    });
  });

  it('prefers whole-round totals (step1+step2) when the round was metered in split-gen mode (R1 P0)', () => {
    const msg: DividerMsg = {
      role: 'assistant',
      content: 'x',
      _metrics: {
        roundNumber: 8, durationMs: 10, startedAt: 1,
        inputTokens: 100, outputTokens: 5,
        step2InputTokens: 300, step2OutputTokens: 40,
        totalInputTokens: 400, totalOutputTokens: 45,
      },
    };
    const out = deriveDisplayMetrics(msg, 0);
    expect(out.inputTokens).toBe(400);
    expect(out.outputTokens).toBe(45);
  });

  it('estimates outputTokens from content when _metrics missing', () => {
    const msg: DividerMsg = {
      role: 'assistant',
      content: '你好世界', // 4 CJK tokens
    };
    const out = deriveDisplayMetrics(msg, 5);
    expect(out.roundNumber).toBe(5);
    expect(out.outputTokens).toBe(4);
    expect(out.inputTokens).toBe('unknown');
    expect(out.durationMs).toBe('unknown');
  });

  it('legacy entry with no content → all unknown', () => {
    const msg: DividerMsg = { role: 'assistant' };
    const out = deriveDisplayMetrics(msg, 3);
    expect(out.roundNumber).toBe(3);
    expect(out.outputTokens).toBe('unknown');
    expect(out.inputTokens).toBe('unknown');
    expect(out.durationMs).toBe('unknown');
  });

  it('uses fallbackRoundNumber when _metrics absent', () => {
    const msg: DividerMsg = { role: 'assistant', content: 'x' };
    expect(deriveDisplayMetrics(msg, 42).roundNumber).toBe(42);
  });
});

describe('findFirstAssistantIdx', () => {
  it('returns -1 on empty', () => {
    expect(findFirstAssistantIdx([])).toBe(-1);
  });

  it('returns -1 when no assistant exists', () => {
    expect(findFirstAssistantIdx([u(), u()])).toBe(-1);
  });

  it('finds the first assistant index', () => {
    expect(findFirstAssistantIdx([u(), a(), u(), a()])).toBe(1);
    expect(findFirstAssistantIdx([a(), a()])).toBe(0);
  });
});

describe('findLatestAssistantIdx', () => {
  it('returns -1 on empty', () => {
    expect(findLatestAssistantIdx([])).toBe(-1);
  });

  it('finds the last assistant index', () => {
    expect(findLatestAssistantIdx([u(), a(), u(), a(), u()])).toBe(3);
  });

  it('handles single assistant', () => {
    expect(findLatestAssistantIdx([u(), a()])).toBe(1);
  });
});

describe('roundForAssistantAt', () => {
  it('returns 0 for out-of-range index', () => {
    expect(roundForAssistantAt([], 0)).toBe(0);
    expect(roundForAssistantAt([a(5)], -1)).toBe(0);
    expect(roundForAssistantAt([a(5)], 10)).toBe(0);
  });

  it('prefers _metrics.roundNumber when present', () => {
    const msgs = [u(), a(7), u(), a(42)];
    expect(roundForAssistantAt(msgs, 1)).toBe(7);
    expect(roundForAssistantAt(msgs, 3)).toBe(42);
  });

  it('falls back to counting assistants for legacy entries (no _metrics)', () => {
    const msgs: DividerMsg[] = [u(), a(), u(), a(), u(), a()];
    // no _metrics on any → count from start
    expect(roundForAssistantAt(msgs, 1)).toBe(1);
    expect(roundForAssistantAt(msgs, 3)).toBe(2);
    expect(roundForAssistantAt(msgs, 5)).toBe(3);
  });

  it('mixed legacy + new — uses metrics where present, counts fallback otherwise', () => {
    const msgs: DividerMsg[] = [u(), a(), u(), a(99)];
    // idx 1: legacy → count = 1
    expect(roundForAssistantAt(msgs, 1)).toBe(1);
    // idx 3: has metrics → 99 (NOT 2)
    expect(roundForAssistantAt(msgs, 3)).toBe(99);
  });

  it('treats roundNumber <= 0 as absent metrics', () => {
    const msgs: DividerMsg[] = [a(0), u(), a(-1)];
    expect(roundForAssistantAt(msgs, 0)).toBe(1); // falls back
    expect(roundForAssistantAt(msgs, 2)).toBe(2); // falls back, 2 assistants by this idx
  });
});

describe('countCjkChars', () => {
  it('returns 0 for empty / null / undefined', () => {
    expect(countCjkChars('')).toBe(0);
    expect(countCjkChars(null)).toBe(0);
    expect(countCjkChars(undefined)).toBe(0);
  });

  it('counts only CJK ideographs, ignoring ASCII + punctuation', () => {
    expect(countCjkChars('你好 world 123!')).toBe(2);
    // '旁白' (2) + '他走了过来' (5) = 7; 【】 and 。 are CJK punctuation, outside the ideograph range.
    expect(countCjkChars('【旁白】他走了过来。')).toBe(7);
  });

  it('counts CJK Extension A and Compatibility Ideographs', () => {
    // U+3400 (Extension A first), U+F900 (Compatibility first)
    expect(countCjkChars('\u3400\uF900')).toBe(2);
  });

  it('does not count Japanese kana (hiragana / katakana are outside the target ranges)', () => {
    expect(countCjkChars('あいうえお')).toBe(0); // hiragana — not CJK ideograph block
    expect(countCjkChars('アイウエオ')).toBe(0); // katakana — not CJK ideograph block
  });
});

describe('truncate', () => {
  it('returns empty for null / undefined / empty', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
    expect(truncate('', 10)).toBe('');
  });

  it('leaves short strings unchanged', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij');
  });

  it('truncates with ellipsis suffix when longer', () => {
    expect(truncate('abcdefghijk', 10)).toBe('abcdefghij…');
    expect(truncate('你好世界', 2)).toBe('你好…');
  });
});

describe('integration: divider asymmetry scenarios', () => {
  it('opening round suppressed — first assistant divider should be skipped by caller', () => {
    // Caller's rule: render divider iff idx !== firstAssistantIdx
    const msgs: DividerMsg[] = [u(), a(1), u(), a(2), u(), a(3)];
    const first = findFirstAssistantIdx(msgs);
    const latest = findLatestAssistantIdx(msgs);
    expect(first).toBe(1);
    expect(latest).toBe(5);
    // Expected divider visibility per assistant index:
    // idx 1 (first) → hidden
    // idx 3 → shown, not current
    // idx 5 (latest) → shown, current
    expect(first !== 3).toBe(true); // shown at idx 3
    expect(first !== 5).toBe(true); // shown at idx 5
    expect(latest === 5).toBe(true); // is current
    expect(latest === 3).toBe(false); // not current
  });

  it('empty history → no dividers', () => {
    const msgs: DividerMsg[] = [];
    expect(findFirstAssistantIdx(msgs)).toBe(-1);
    expect(findLatestAssistantIdx(msgs)).toBe(-1);
  });

  it('only user messages — no dividers possible', () => {
    const msgs: DividerMsg[] = [u(), u(), u()];
    expect(findFirstAssistantIdx(msgs)).toBe(-1);
    expect(findLatestAssistantIdx(msgs)).toBe(-1);
  });
});
