import { describe, it, expect } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { readGameTimeStamp, toGameTimeStamp, gameTimeToDayOrdinal } from './game-time-stamp';

describe('toGameTimeStamp', () => {
  const names = DEFAULT_ENGINE_PATHS.gameTimeFieldNames;

  it('maps the pack field names to engine keys and coerces numeric strings', () => {
    expect(toGameTimeStamp({ 年: 1, 月: 3, 日: '9', 小时: 14, 分钟: 30 }, names))
      .toEqual({ year: 1, month: 3, day: 9, hour: 14, minute: 30 });
  });

  it('returns undefined when nothing numeric is present (pack without a time object)', () => {
    expect(toGameTimeStamp(undefined, names)).toBeUndefined();
    expect(toGameTimeStamp('三月初九', names)).toBeUndefined();
    expect(toGameTimeStamp({ 季节: '春' }, names)).toBeUndefined();
  });

  it('reads through the state tree using paths (no Chinese keys in the caller)', () => {
    const sm = new StateManager();
    sm.loadTree({ 世界: { 时间: { 年: 2, 月: 1, 日: 1 } } });
    expect(readGameTimeStamp(sm, DEFAULT_ENGINE_PATHS)).toEqual({ year: 2, month: 1, day: 1 });
  });
});

describe('gameTimeToDayOrdinal', () => {
  it('is monotonic across day/month/year boundaries and null for empty stamps', () => {
    const a = gameTimeToDayOrdinal({ year: 1, month: 3, day: 9 })!;
    const b = gameTimeToDayOrdinal({ year: 1, month: 3, day: 10 })!;
    const c = gameTimeToDayOrdinal({ year: 1, month: 4, day: 1 })!;
    const d = gameTimeToDayOrdinal({ year: 2, month: 1, day: 1 })!;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(d);
    expect(b - a).toBe(1);
    expect(gameTimeToDayOrdinal(undefined)).toBeNull();
    expect(gameTimeToDayOrdinal({ hour: 3 })).toBeNull();
  });
});
