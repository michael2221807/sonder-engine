import { describe, it, expect } from 'vitest';
import { formatMemoryEntry, parseMemoryEntry } from '@/engine/social/npc-memory-format';

describe('parseMemoryEntry', () => {
  it('parses plain string entry', () => {
    expect(parseMemoryEntry('初次相遇')).toEqual({ content: '初次相遇', time: '' });
  });

  it('parses { 内容, 时间 } object (Chinese keys)', () => {
    expect(parseMemoryEntry({ 内容: '在茶馆相识', 时间: '1-01-15 09:30' }))
      .toEqual({ content: '在茶馆相识', time: '1-01-15 09:30' });
  });

  it('parses { 内容 } object without 时间', () => {
    expect(parseMemoryEntry({ 内容: '无时间条目' }))
      .toEqual({ content: '无时间条目', time: '' });
  });

  it('parses { content, time } object (English keys — forward compat)', () => {
    expect(parseMemoryEntry({ content: 'first meeting', time: 'dawn' }))
      .toEqual({ content: 'first meeting', time: 'dawn' });
  });

  it('returns empty strings for null', () => {
    expect(parseMemoryEntry(null)).toEqual({ content: '', time: '' });
  });

  it('returns empty strings for undefined', () => {
    expect(parseMemoryEntry(undefined)).toEqual({ content: '', time: '' });
  });

  it('empty string input → empty content', () => {
    expect(parseMemoryEntry('')).toEqual({ content: '', time: '' });
  });

  it('object missing both content and time → empty strings', () => {
    expect(parseMemoryEntry({})).toEqual({ content: '', time: '' });
  });

  it('object with non-string content → empty content (defensive)', () => {
    expect(parseMemoryEntry({ 内容: 42 })).toEqual({ content: '', time: '' });
  });

  it('object with non-string time → empty time', () => {
    expect(parseMemoryEntry({ 内容: 'x', 时间: 999 })).toEqual({ content: 'x', time: '' });
  });

  it('array input → falls through to String stringification', () => {
    // 数组视为异常形态（不是 string 也不是 plain object），走兜底分支。
    // 实现对数组走兜底分支：String(['a','b']) === 'a,b'，时间为空。
    expect(parseMemoryEntry(['a', 'b'])).toEqual({ content: 'a,b', time: '' });
  });

  it('number input → stringified content', () => {
    expect(parseMemoryEntry(42)).toEqual({ content: '42', time: '' });
  });

  it('boolean input → stringified content', () => {
    expect(parseMemoryEntry(true)).toEqual({ content: 'true', time: '' });
  });
});

describe('formatMemoryEntry', () => {
  it('renders plain string as-is', () => {
    expect(formatMemoryEntry('hello')).toBe('hello');
  });

  it('renders { 内容, 时间 } as "[time] content"', () => {
    expect(formatMemoryEntry({ 内容: '相遇', 时间: '1-01-15 09:30' }))
      .toBe('[1-01-15 09:30] 相遇');
  });

  it('renders { 内容 } without time as just content', () => {
    expect(formatMemoryEntry({ 内容: '无时间' })).toBe('无时间');
  });

  it('renders empty object as empty string', () => {
    expect(formatMemoryEntry({})).toBe('');
  });

  it('renders null as empty string', () => {
    expect(formatMemoryEntry(null)).toBe('');
  });

  it('renders undefined as empty string', () => {
    expect(formatMemoryEntry(undefined)).toBe('');
  });

  it('trims time whitespace so empty-ish time is dropped', () => {
    expect(formatMemoryEntry({ 内容: 'x', 时间: '   ' })).toBe('x');
  });

  it('supports English keys symmetrically', () => {
    expect(formatMemoryEntry({ content: 'hi', time: 'now' })).toBe('[now] hi');
  });

  it('falls through to String(raw) for arrays and numbers', () => {
    expect(formatMemoryEntry(42)).toBe('42');
    expect(formatMemoryEntry(['a', 'b'])).toBe('a,b');
  });

  it('preserves empty-string content (does not crash)', () => {
    expect(formatMemoryEntry('')).toBe('');
  });

  it('mixed shapes in same array can be rendered one-by-one', () => {
    const arr: unknown[] = [
      '旧文本条目',
      { 内容: '新条目', 时间: '1-01-15 10:00' },
      { 内容: '无时间条目' },
    ];
    const rendered = arr.map(formatMemoryEntry);
    expect(rendered).toEqual([
      '旧文本条目',
      '[1-01-15 10:00] 新条目',
      '无时间条目',
    ]);
  });
});
