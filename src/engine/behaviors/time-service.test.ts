import { describe, it, expect, beforeEach } from 'vitest';
import { TimeService, gameCalendar } from '@/engine/behaviors/time-service';
import { EffectLifecycleModule } from '@/engine/behaviors/effect-lifecycle';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { createMockStateManager } from '@/engine/__test-utils__';
import type { CalendarConfig } from '@/engine/types';

const config: CalendarConfig = {
  timeFieldPath: '世界.时间',
  timeFieldFormat: { '年': 'number', '月': 'number', '日': 'number', '小时': 'number', '分钟': 'number' },
  minutesPerHour: 60,
  hoursPerDay: 24,
  daysPerMonth: 30,
  monthsPerYear: 12,
};

function makeTime(年 = 1, 月 = 1, 日 = 1, 小时 = 8, 分钟 = 0) {
  return { 世界: { 时间: { 年, 月, 日, 小时, 分钟 } }, 角色: { 基础信息: { 年龄: 20 } } };
}

describe('TimeService', () => {
  let ts: TimeService;

  beforeEach(() => {
    ts = new TimeService(config);
  });

  it('normalizes minute overflow', () => {
    const { sm } = createMockStateManager(makeTime(1, 1, 1, 8, 90));
    ts.afterCommands(sm as never, { source: 'command', timestamp: 0, changes: [{ path: '世界.时间.分钟', action: 'add', oldValue: 0, newValue: 90, timestamp: 0 }] });
    expect(sm.get('世界.时间.分钟')).toBe(30);
    expect(sm.get('世界.时间.小时')).toBe(9);
  });

  it('normalizes hour overflow into next day', () => {
    const { sm } = createMockStateManager(makeTime(1, 1, 1, 25, 0));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间.小时')).toBe(1);
    expect(sm.get('世界.时间.日')).toBe(2);
  });

  it('normalizes day overflow into next month', () => {
    const { sm } = createMockStateManager(makeTime(1, 1, 31, 0, 0));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间.日')).toBe(1);
    expect(sm.get('世界.时间.月')).toBe(2);
  });

  it('normalizes month overflow into next year', () => {
    const { sm } = createMockStateManager(makeTime(1, 13, 1, 0, 0));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间.月')).toBe(1);
    expect(sm.get('世界.时间.年')).toBe(2);
  });

  it('cascades multi-level overflow', () => {
    // 90 minutes + 23 hours + 29 days = should cascade across all levels
    const { sm } = createMockStateManager(makeTime(1, 1, 30, 23, 90));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间.分钟')).toBe(30);
    expect(sm.get('世界.时间.小时')).toBe(0);
    expect(sm.get('世界.时间.日')).toBe(1);
    expect(sm.get('世界.时间.月')).toBe(2);
  });

  it('updates age on year change', () => {
    const { sm } = createMockStateManager(makeTime(1, 13, 1, 0, 0)); // month 13 → year+1
    ts.onGameLoad(sm as never);
    expect(sm.get('角色.基础信息.年龄')).toBe(21);
  });

  it('skips when no time change in changeLog', () => {
    const { sm, mutations } = createMockStateManager(makeTime(1, 1, 1, 8, 90));
    ts.afterCommands(sm as never, { source: 'command', timestamp: 0, changes: [{ path: '角色.名字', action: 'set', oldValue: '', newValue: 'X', timestamp: 0 }] });
    // No time-related mutation should happen
    expect(mutations).toHaveLength(0);
  });

  it('handles negative minutes (borrow)', () => {
    const { sm } = createMockStateManager(makeTime(1, 1, 1, 8, -1));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间.分钟')).toBe(59);
    expect(sm.get('世界.时间.小时')).toBe(7);
  });

  it('no-op for already normalized time', () => {
    const { sm } = createMockStateManager(makeTime(1, 6, 15, 12, 30));
    ts.onGameLoad(sm as never);
    // Values written back same as original — mutations exist but values unchanged
    expect(sm.get('世界.时间.分钟')).toBe(30);
    expect(sm.get('世界.时间.小时')).toBe(12);
  });

  // Day and month count from 1: the last day of a month and the last month of a year are real dates.
  it('keeps day 30 and month 12 as they are', () => {
    const { sm } = createMockStateManager(makeTime(1, 12, 30, 23, 59));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 12, 日: 30, 小时: 23, 分钟: 59 });
    expect(sm.get('角色.基础信息.年龄')).toBe(20);
  });

  it('carries the last minute of a year into the first day of the next', () => {
    const { sm } = createMockStateManager(makeTime(1, 12, 30, 23, 59));
    sm.set('世界.时间.分钟', 60);
    ts.afterCommands(sm as never, { source: 'command', timestamp: 0, changes: [{ path: '世界.时间.分钟', action: 'add', oldValue: 59, newValue: 60, timestamp: 0 }] });
    expect(sm.get('世界.时间')).toEqual({ 年: 2, 月: 1, 日: 1, 小时: 0, 分钟: 0 });
    expect(sm.get('角色.基础信息.年龄')).toBe(21);
  });

  it('reads a day 0 left by the old zero-based carry as the last day of the month before', () => {
    const { sm } = createMockStateManager(makeTime(1, 3, 0, 9, 0));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 30, 小时: 9, 分钟: 0 });
  });

  it('borrows across a year: day 0 of month 1 is the last day of the year before, and the age follows', () => {
    const { sm } = createMockStateManager(makeTime(2, 1, 0, 6, 0));
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 12, 日: 30, 小时: 6, 分钟: 0 });
    expect(sm.get('角色.基础信息.年龄')).toBe(19);
  });

  it('does not create a clock the save does not have', () => {
    const { sm, mutations } = createMockStateManager({ 角色: { 基础信息: { 年龄: 20 } } });
    ts.onGameLoad(sm as never);
    expect(mutations).toHaveLength(0);
    expect(sm.get('世界.时间')).toBeUndefined();
  });

  // PO D1 (2026-09-26): saves from the three-field wiring keep their date; minute and hour fold into range.
  it('repairs a clock written without hour and minute wiring: same date, folded time, fallback fields gone', () => {
    const { sm } = createMockStateManager({ 世界: { 时间: { 年: 1, 月: 2, 日: 3, 小时: 8, 分钟: 13830, minute: 0, hour: 0 } }, 角色: { 基础信息: { 年龄: 20 } } });
    ts.onGameLoad(sm as never);
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 3, 小时: 8, 分钟: 30 });
    expect(sm.get('角色.基础信息.年龄')).toBe(20);
    ts.onGameLoad(sm as never);   // a second load finds nothing left to repair
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 3, 小时: 8, 分钟: 30 });
  });

  it('folds an uncarried hour too, and leaves a clock without fallback fields to the ordinary carry', () => {
    const legacy = createMockStateManager({ 世界: { 时间: { 年: 1, 月: 2, 日: 3, 小时: 30, 分钟: -5, hour: 0 } } });
    ts.onGameLoad(legacy.sm as never);
    expect(legacy.sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 3, 小时: 6, 分钟: 55 });
    const current = createMockStateManager(makeTime(1, 2, 3, 8, 90));
    ts.onGameLoad(current.sm as never);
    expect(current.sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 3, 小时: 9, 分钟: 30 });
  });
});

// The wiring the app uses: both clock readers come from one calendar built from the engine paths.
describe('gameCalendar', () => {
  it('declares all five clock fields, largest first', () => {
    expect(Object.keys(gameCalendar(DEFAULT_ENGINE_PATHS).timeFieldFormat)).toEqual(['年', '月', '日', '小时', '分钟']);
  });

  it('a status written this round survives the round end after the clock moves on', () => {
    const calendar = gameCalendar(DEFAULT_ENGINE_PATHS);
    const time = new TimeService(calendar);
    const effects = new EffectLifecycleModule({ effectsPath: '角色.效果', effectSchema: { nameField: '状态名称', typeField: '类型',
      typeValues: ['buff', 'debuff', 'neutral'], startTimeField: '生成时间', durationField: '持续时间分钟', permanentSentinel: 999999 } }, calendar);
    const { sm } = createMockStateManager({ 世界: { 时间: { 年: 1, 月: 2, 日: 3, 小时: 22, 分钟: 0 } },
      角色: { 效果: [{ 状态名称: '低烧', 类型: 'debuff', 生成时间: { 年: 1, 月: 2, 日: 3, 小时: 22, 分钟: 0 }, 持续时间分钟: 480 }] } });
    sm.set('世界.时间.分钟', 90);
    time.afterCommands(sm as never, { source: 'command', timestamp: 0, changes: [{ path: '世界.时间.分钟', action: 'add', oldValue: 0, newValue: 90, timestamp: 0 }] });
    effects.onRoundEnd(sm as never);
    expect(sm.get('世界.时间')).toEqual({ 年: 1, 月: 2, 日: 3, 小时: 23, 分钟: 30 });
    expect(sm.get<unknown[]>('角色.效果')).toHaveLength(1);
  });
});
