import { describe, it, expect } from 'vitest';
import {
  computeCommandStats,
  formatCommandValue,
  COMMAND_ACTION_LABEL,
  type Command,
} from './commands-viewer-helpers';

describe('computeCommandStats', () => {
  it('returns zero stats for empty list', () => {
    expect(computeCommandStats([])).toEqual({
      set: 0, add: 0, push: 0, delete: 0, pull: 0, total: 0,
    });
  });

  it('counts each action type and total', () => {
    const cmds: Command[] = [
      { action: 'set', key: 'a', value: 1 },
      { action: 'add', key: 'b', value: 2 },
      { action: 'push', key: 'c', value: [] },
      { action: 'delete', key: 'd' },
      { action: 'pull', key: 'e', value: 'x' },
      { action: 'set', key: 'f', value: 3 },
    ];
    const s = computeCommandStats(cmds);
    expect(s.set).toBe(2);
    expect(s.add).toBe(1);
    expect(s.push).toBe(1);
    expect(s.delete).toBe(1);
    expect(s.pull).toBe(1);
    expect(s.total).toBe(6);
  });
});

describe('formatCommandValue', () => {
  it('returns em-dash for null / undefined', () => {
    expect(formatCommandValue(null)).toBe('—');
    expect(formatCommandValue(undefined)).toBe('—');
  });

  it('converts primitives to string', () => {
    expect(formatCommandValue(42)).toBe('42');
    expect(formatCommandValue(true)).toBe('true');
    expect(formatCommandValue('hello')).toBe('hello');
  });

  it('stringifies objects', () => {
    expect(formatCommandValue({ a: 1 })).toBe('{"a":1}');
    expect(formatCommandValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('truncates strings over 60 chars with ellipsis', () => {
    const long = 'a'.repeat(100);
    const out = formatCommandValue(long);
    expect(out.length).toBe(58); // 57 chars + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncates long stringified objects', () => {
    const big = { content: 'x'.repeat(200) };
    const out = formatCommandValue(big);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to "[对象]" when JSON.stringify throws (circular)', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(formatCommandValue(obj)).toBe('[对象]');
  });
});

describe('COMMAND_ACTION_LABEL', () => {
  it('maps each action to its uppercase abbreviation', () => {
    expect(COMMAND_ACTION_LABEL.set).toBe('SET');
    expect(COMMAND_ACTION_LABEL.add).toBe('ADD');
    expect(COMMAND_ACTION_LABEL.push).toBe('PUSH');
    expect(COMMAND_ACTION_LABEL.delete).toBe('DEL');
    expect(COMMAND_ACTION_LABEL.pull).toBe('PULL');
  });
});
