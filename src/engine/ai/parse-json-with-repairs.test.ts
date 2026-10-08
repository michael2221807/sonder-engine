import { describe, it, expect } from 'vitest';
import { parseJsonWithRepairs } from './json-escape-sanitize';
import { scanJsonObjectBlocks } from './json-extract';

describe('parseJsonWithRepairs', () => {
  it('returns a parsed falsy value as a success, at every depth', () => {
    for (const depth of ['none', 'escapes', 'escapes+quotes'] as const) {
      expect(parseJsonWithRepairs('null', depth)).toBeNull();
      expect(parseJsonWithRepairs('0', depth)).toBe(0);
      expect(parseJsonWithRepairs('false', depth)).toBe(false);
      expect(parseJsonWithRepairs('""', depth)).toBe('');
    }
  });

  it('repairs only as deep as the depth allows', () => {
    const badEscape = '{"a":"\\你好"}';
    expect(parseJsonWithRepairs(badEscape, 'none')).toBeUndefined();
    expect(parseJsonWithRepairs(badEscape, 'escapes')).toEqual({ a: '你好' });
    expect(parseJsonWithRepairs(badEscape, 'escapes+quotes')).toEqual({ a: '你好' });

    const badQuotes = '{"a":"他说"你好"然后走了"}';
    expect(parseJsonWithRepairs(badQuotes, 'none')).toBeUndefined();
    expect(parseJsonWithRepairs(badQuotes, 'escapes')).toBeUndefined();
    expect(parseJsonWithRepairs(badQuotes, 'escapes+quotes')).toEqual({ a: '他说"你好"然后走了' });
  });
});

describe('scanJsonObjectBlocks', () => {
  it('visits plain-object blocks in order with their index, skips the rest, and returns the cleaned text', () => {
    const seen: Array<[number, unknown]> = [];
    const cleaned = scanJsonObjectBlocks(
      '<think>{"x":0}</think>```json\n{"a":1}\n``` [1] {"b":2} {broken {"c":3}',
      (obj, idx) => seen.push([idx, obj]),
    );
    expect(seen.map(([, o]) => o)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(cleaned).not.toContain('<think>');
    expect(cleaned).not.toContain('```');
  });

  it('swallows what visit throws and keeps going', () => {
    const seen: unknown[] = [];
    scanJsonObjectBlocks('{"a":1} {"b":2}', (obj) => {
      if ('a' in obj) throw new Error('unusable');
      seen.push(obj);
    });
    expect(seen).toEqual([{ b: 2 }]);
  });
});
