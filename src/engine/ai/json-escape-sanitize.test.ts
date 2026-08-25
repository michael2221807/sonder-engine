import { describe, it, expect } from 'vitest';
import { sanitizeJsonEscapes } from '@/engine/ai/json-escape-sanitize';

describe('sanitizeJsonEscapes', () => {
  describe('no-op on valid JSON', () => {
    it('leaves empty input untouched', () => {
      expect(sanitizeJsonEscapes('')).toBe('');
    });

    it('leaves JSON without strings untouched', () => {
      expect(sanitizeJsonEscapes('{"a":1,"b":true}')).toBe('{"a":1,"b":true}');
    });

    it('leaves all legal escapes untouched', () => {
      const src = '{"t":"line1\\nline2\\ttab\\"quote\\\\back\\/slash\\b\\f\\r"}';
      expect(sanitizeJsonEscapes(src)).toBe(src);
    });

    it('leaves valid \\uXXXX untouched', () => {
      const src = '{"t":"\\u0041\\u4f60"}';
      expect(sanitizeJsonEscapes(src)).toBe(src);
    });
  });

  describe('strips invalid \\X escapes in strings', () => {
    it('removes stray backslash before CJK char (the \\你 bug)', () => {
      // JSON source: {"t":"\你"} — invalid. After sanitize: {"t":"你"}
      const src = '{"t":"\\你"}';
      const sanitized = sanitizeJsonEscapes(src);
      expect(sanitized).toBe('{"t":"你"}');
      expect(JSON.parse(sanitized)).toEqual({ t: '你' });
    });

    it('preserves \\\\你 (valid double-backslash then CJK)', () => {
      // JSON source: {"t":"\\你"} — valid, decodes to literal backslash + 你
      const src = '{"t":"\\\\你"}';
      const sanitized = sanitizeJsonEscapes(src);
      expect(sanitized).toBe(src);
      expect(JSON.parse(sanitized)).toEqual({ t: '\\你' });
    });

    it('only strips backslash before invalid char, keeps the char', () => {
      const src = '{"t":"a\\xb"}';
      expect(sanitizeJsonEscapes(src)).toBe('{"t":"axb"}');
    });

    it('handles real-world stutter case from test data', () => {
      // Exact shape from the AGA main round response payload
      const src = '{"text":"是时候落下第一子了。\\n\\你站起身"}';
      const sanitized = sanitizeJsonEscapes(src);
      const parsed = JSON.parse(sanitized);
      expect(parsed.text).toBe('是时候落下第一子了。\n你站起身');
      expect(parsed.text).not.toContain('\\');
    });

    it('handles multiple stutters in one string', () => {
      const src = '{"t":"a\\bc\\de\\fg"}'; // \b, \f are valid; \d is not
      const sanitized = sanitizeJsonEscapes(src);
      expect(JSON.parse(sanitized)).toEqual({ t: 'a\bcde\fg' });
    });

    it('strips \\u when followed by non-hex', () => {
      const src = '{"t":"\\u你好"}'; // \u needs 4 hex, 你 is not hex
      const sanitized = sanitizeJsonEscapes(src);
      expect(JSON.parse(sanitized)).toEqual({ t: 'u你好' });
    });

    it('keeps \\u when followed by only 3 hex then space', () => {
      const src = '{"t":"\\u004 leftover"}';
      const sanitized = sanitizeJsonEscapes(src);
      // \u004 (only 3 hex) → invalid \uXXXX, strip backslash
      expect(JSON.parse(sanitized)).toEqual({ t: 'u004 leftover' });
    });
  });

  describe('string boundary handling', () => {
    it('does not touch backslashes outside strings', () => {
      // malformed input with a stray backslash outside quotes — leave it so
      // JSON.parse can still report the real error
      const src = '{\\"t":1}';
      expect(sanitizeJsonEscapes(src)).toBe('{\\"t":1}');
    });

    it('correctly re-enters strings after \\" inside a string', () => {
      const src = '{"t":"he said \\"hi\\" to \\他"}';
      // \" legal, \他 illegal
      const sanitized = sanitizeJsonEscapes(src);
      expect(JSON.parse(sanitized)).toEqual({ t: 'he said "hi" to 他' });
    });

    it('handles adjacent strings with bad escapes in each', () => {
      const src = '{"a":"\\啊","b":"\\哦"}';
      const sanitized = sanitizeJsonEscapes(src);
      expect(JSON.parse(sanitized)).toEqual({ a: '啊', b: '哦' });
    });
  });

  describe('edge cases', () => {
    it('handles trailing backslash at string end', () => {
      const src = '{"t":"incomplete\\';
      // trailing lone \ → drop it; string is still unterminated but at least
      // one symptom removed for the parser error to be more accurate
      const sanitized = sanitizeJsonEscapes(src);
      expect(sanitized).toBe('{"t":"incomplete');
    });

    it('handles empty string values', () => {
      expect(sanitizeJsonEscapes('{"t":""}')).toBe('{"t":""}');
    });

    it('passes undefined/null-ish inputs through', () => {
      expect(sanitizeJsonEscapes('')).toBe('');
      // @ts-expect-error testing runtime robustness
      expect(sanitizeJsonEscapes(null)).toBe(null);
      // @ts-expect-error
      expect(sanitizeJsonEscapes(undefined)).toBe(undefined);
    });
  });
});

// ── healUnescapedQuotes（2026-08-25 round-62 事故回归） ──
import { healUnescapedQuotes } from '@/engine/ai/json-escape-sanitize';

describe('healUnescapedQuotes', () => {
  it('heals the REAL round-62 evidence payload (unescaped ASCII quotes copied verbatim from player input)', () => {
    // 逐字截取自 2026-08-25 真实 step2 响应：模型按协议逐字引用玩家原文，
    // 原文里的英文直引号未转义，整个 step2 JSON 在此断裂。
    const src = '{"setting_updates":[{"kind":"world_fact","statement":"男性虽承担更重劳动却欣然接受条例。","evidence":"男人有合法权利去使用那些看上去"养尊处优"的女性，因此女性打扮的越好看他们征服的快感就越高","anchors":["男性","使用权"],"entities":[]}]}';
    expect(() => JSON.parse(src)).toThrow();

    const healed = healUnescapedQuotes(src);
    const obj = JSON.parse(healed) as { setting_updates: Array<{ evidence: string }> };
    expect(obj.setting_updates).toHaveLength(1);
    // 引号以内容形式保留 —— 证据文本不丢字
    expect(obj.setting_updates[0].evidence).toContain('"养尊处优"');
  });

  it('leaves valid JSON semantically identical', () => {
    const src = '{"a":"他说：\\"好\\"","b":[1,2],"c":{"d":"x"}}';
    expect(JSON.parse(healUnescapedQuotes(src))).toEqual(JSON.parse(src));
  });

  it('heals multiple content quotes in one string value', () => {
    const src = '{"t":"评语是"奶香"和"手感极品"级别"}';
    const obj = JSON.parse(healUnescapedQuotes(src)) as { t: string };
    expect(obj.t).toBe('评语是"奶香"和"手感极品"级别');
  });

  it('a quote legitimately followed by a comma still closes the string', () => {
    const src = '{"a":"x","b":"y"}';
    expect(healUnescapedQuotes(src)).toBe(src);
  });

  it('closing quote before ] and } is untouched', () => {
    const src = '{"arr":["one","two"],"obj":{"k":"v"}}';
    expect(healUnescapedQuotes(src)).toBe(src);
  });
});

describe('healUnescapedQuotes · premature-closure guard (review of 9226845, Important #1)', () => {
  it('content quote followed by ASCII comma + prose does NOT close the string', () => {
    // Reviewer's hand-traced pathological shape: without the comma lookahead the
    // healer closed the string at 你好", leaving bare CJK tokens outside.
    const src = '{"evidence": "他说"你好", 然后走了", "kind":"character"}';
    const obj = JSON.parse(healUnescapedQuotes(src)) as { evidence: string; kind: string };
    expect(obj.evidence).toBe('他说"你好", 然后走了');
    expect(obj.kind).toBe('character');
  });

  it('a genuine close-quote + comma + next value still closes', () => {
    const src = '{"a":"x", "n": 5, "arr": [1], "t": true}';
    expect(healUnescapedQuotes(src)).toBe(src);
  });
});
