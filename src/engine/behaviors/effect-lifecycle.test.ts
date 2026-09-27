import { describe, it, expect } from 'vitest';
import { EffectLifecycleModule } from './effect-lifecycle';
import { CommandExecutor } from '../core/command-executor';
import { StateManager } from '../core/state-manager';
import { createMockStateManager } from '../__test-utils__/state-manager.mock';
import type { EffectLifecycleConfig, CalendarConfig } from '../types';

describe('EffectLifecycleModule', () => {
  const calendarConfig: CalendarConfig = {
    minutesPerHour: 60,
    hoursPerDay: 24,
    daysPerMonth: 30,
    monthsPerYear: 12,
    timeFieldPath: '世界.时间',
    timeFieldFormat: {
      年: 'number',
      月: 'number',
      日: 'number',
      时: 'number',
      分: 'number',
    },
  };

  const effectConfig: EffectLifecycleConfig = {
    effectsPath: '角色.状态效果',
    effectSchema: {
      nameField: '名称',
      typeField: '类型',
      typeValues: ['buff', 'debuff', 'neutral'],
      startTimeField: '开始时间',
      durationField: '持续时间',
      permanentSentinel: 99999,
    },
  };

  function makeTime(year = 1, month = 1, day = 1, hour = 0, minute = 0) {
    return { 年: year, 月: month, 日: day, 时: hour, 分: minute };
  }

  function makeEffect(
    name: string,
    startTime: Record<string, number>,
    duration: number,
    type = 'buff',
  ) {
    return { 名称: name, 类型: type, 开始时间: startTime, 持续时间: duration };
  }

  describe('removeExpiredEffects', () => {
    it('removes expired effect', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 5) },
        角色: {
          状态效果: [
            makeEffect('中毒', makeTime(1, 1, 1), 60),
          ],
        },
      });

      mod.onRoundEnd(sm as never);

      const effects = sm.get<unknown[]>('角色.状态效果');
      expect(effects).toHaveLength(0);
    });

    it('keeps non-expired effect', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 1, 0, 30) },
        角色: {
          状态效果: [
            makeEffect('祝福', makeTime(1, 1, 1), 120),
          ],
        },
      });

      mod.onRoundEnd(sm as never);

      const effects = sm.get<unknown[]>('角色.状态效果');
      expect(effects).toHaveLength(1);
    });

    it('keeps permanent effects (duration >= sentinel)', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(99, 12, 30) },
        角色: {
          状态效果: [
            makeEffect('天生丽质', makeTime(1, 1, 1), 99999),
          ],
        },
      });

      mod.onRoundEnd(sm as never);

      const effects = sm.get<unknown[]>('角色.状态效果');
      expect(effects).toHaveLength(1);
    });

    it('retains effect when startTime is unparseable', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 5) },
        角色: {
          状态效果: [
            { 名称: '神秘', 类型: 'buff', 开始时间: 'invalid', 持续时间: 10 },
          ],
        },
      });

      mod.onRoundEnd(sm as never);
      expect(sm.get<unknown[]>('角色.状态效果')).toHaveLength(1);
    });

    it('does nothing when effects array is empty', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm, mutations } = createMockStateManager({
        世界: { 时间: makeTime() },
        角色: { 状态效果: [] },
      });

      mod.onRoundEnd(sm as never);
      expect(mutations).toHaveLength(0);
    });

    it('does nothing when effects path is missing', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm, mutations } = createMockStateManager({
        世界: { 时间: makeTime() },
      });

      mod.onRoundEnd(sm as never);
      expect(mutations).toHaveLength(0);
    });
  });

  describe('deduplicateEffects', () => {
    it('removes duplicate names, keeping the last occurrence', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 1) },
        角色: {
          状态效果: [
            makeEffect('中毒', makeTime(1, 1, 1), 99999),
            makeEffect('祝福', makeTime(1, 1, 1), 99999),
            makeEffect('中毒', makeTime(1, 1, 1), 99999),
          ],
        },
      });

      mod.onRoundEnd(sm as never);

      const effects = sm.get<Array<Record<string, unknown>>>('角色.状态效果')!;
      const names = effects.map((e) => e['名称']);
      expect(names).toEqual(['祝福', '中毒']);
    });

    it('skips effects with empty name', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 1) },
        角色: {
          状态效果: [
            makeEffect('', makeTime(1, 1, 1), 99999),
            makeEffect('祝福', makeTime(1, 1, 1), 99999),
          ],
        },
      });

      mod.onRoundEnd(sm as never);

      const effects = sm.get<Array<Record<string, unknown>>>('角色.状态效果')!;
      expect(effects).toHaveLength(1);
      expect(effects[0]['名称']).toBe('祝福');
    });

    it('handles single effect (no dedup needed)', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm, mutations } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 1) },
        角色: {
          状态效果: [makeEffect('祝福', makeTime(1, 1, 1), 99999)],
        },
      });

      mod.onRoundEnd(sm as never);
      expect(mutations).toHaveLength(0);
    });
  });

  describe('time scalar calculation', () => {
    it('later time produces larger scalar', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);

      // Effect started at (1,1,1,0,0), duration=1 minute
      // Current time (1,1,1,0,2) → effect expired (start+1 < 2)
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 1, 0, 2) },
        角色: {
          状态效果: [makeEffect('短效', makeTime(1, 1, 1, 0, 0), 1)],
        },
      });

      mod.onRoundEnd(sm as never);
      expect(sm.get<unknown[]>('角色.状态效果')).toHaveLength(0);
    });

    it('handles month/year boundaries correctly', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      // Start: year 1, month 1, day 1, hour 0, minute 0
      // Duration: 10 minutes
      // Current: year 2, month 1, day 1 → well past expiry
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(2, 1, 1, 0, 0) },
        角色: {
          状态效果: [makeEffect('跨年效果', makeTime(1, 1, 1, 0, 0), 10)],
        },
      });

      mod.onRoundEnd(sm as never);
      expect(sm.get<unknown[]>('角色.状态效果')).toHaveLength(0);
    });
  });

  describe('onGameLoad', () => {
    it('runs both dedup and expiry check', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const { sm } = createMockStateManager({
        世界: { 时间: makeTime(1, 1, 10) },
        角色: {
          状态效果: [
            makeEffect('中毒', makeTime(1, 1, 1), 60),
            makeEffect('中毒', makeTime(1, 1, 1), 60),
            makeEffect('永久', makeTime(1, 1, 1), 99999),
          ],
        },
      });

      mod.onGameLoad(sm as never);

      const effects = sm.get<Array<Record<string, unknown>>>('角色.状态效果')!;
      expect(effects).toHaveLength(1);
      expect(effects[0]['名称']).toBe('永久');
    });
  });

  // PO G1 (2026-09-26): the model dates a status from the story, which can drift from the clock by hours.
  describe('afterCommands: a status written this round starts on the game clock', () => {
    const path = effectConfig.effectsPath;
    const push = (before: unknown[], after: unknown[]) => ({ path, action: 'push' as const, oldValue: before, newValue: after, timestamp: 0 });
    const log = (...changes: ReturnType<typeof push>[]) => ({ source: 'command' as const, timestamp: 0, changes });

    it('a new status dated twelve hours behind the clock starts now and survives the round end', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const fever = makeEffect('低烧', makeTime(1, 2, 3, 5, 40), 720, 'debuff');
      const { sm } = createMockStateManager({ 世界: { 时间: makeTime(1, 2, 3, 17, 40) }, 角色: { 状态效果: [fever] } });
      mod.afterCommands(sm as never, log(push([], [fever])));
      mod.onRoundEnd(sm as never);
      const effects = sm.get<Record<string, unknown>[]>(path)!;
      expect(effects).toHaveLength(1);
      expect(effects[0]['开始时间']).toEqual(makeTime(1, 2, 3, 17, 40));
    });

    it('a status already there keeps its start and still expires when due', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const old = makeEffect('旧伤', makeTime(1, 2, 3, 0, 0), 60);
      const fresh = makeEffect('新伤', makeTime(1, 1, 1, 0, 0), 60);
      const { sm } = createMockStateManager({ 世界: { 时间: makeTime(1, 2, 3, 12, 0) }, 角色: { 状态效果: [old, fresh] } });
      mod.afterCommands(sm as never, log(push([old], [old, fresh])));
      mod.onRoundEnd(sm as never);
      expect(sm.get<Record<string, unknown>[]>(path)!.map((e) => e['名称'])).toEqual(['新伤']);
    });

    it('a status written again under the same name restarts now, and one copy is kept', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const first = makeEffect('低烧', makeTime(1, 2, 3, 6, 0), 120);
      const again = makeEffect('低烧', makeTime(1, 2, 3, 6, 0), 120);
      const { sm } = createMockStateManager({ 世界: { 时间: makeTime(1, 2, 3, 9, 0) }, 角色: { 状态效果: [first, again] } });
      mod.afterCommands(sm as never, log(push([first], [first, again])));
      mod.onRoundEnd(sm as never);
      const effects = sm.get<Record<string, unknown>[]>(path)!;
      expect(effects).toHaveLength(1);
      expect(effects[0]['开始时间']).toEqual(makeTime(1, 2, 3, 9, 0));
    });

    it('a status written outside the main round (any command batch) is stamped too, through the executor', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const sm = new StateManager();
      sm.loadTree({ 世界: { 时间: makeTime(1, 2, 3, 17, 40) }, 角色: { 状态效果: [] } });
      const executor = new CommandExecutor(sm);
      executor.observeBatches((changeLog) => mod.stampWritten(sm as never, changeLog));
      executor.executeBatch([{ action: 'push', key: path, value: makeEffect('中毒', makeTime(1, 2, 3, 5, 0), 120, 'debuff') }]);
      expect(sm.get<Record<string, unknown>[]>(path)![0]['开始时间']).toEqual(makeTime(1, 2, 3, 17, 40));
    });

    it('only the last copy of a written name is stamped (the one the round-end dedup keeps)', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const stale = makeEffect('低烧', makeTime(1, 2, 1, 0, 0), 60);
      const again = makeEffect('低烧', makeTime(1, 2, 3, 6, 0), 120);
      const { sm } = createMockStateManager({ 世界: { 时间: makeTime(1, 2, 3, 9, 0) }, 角色: { 状态效果: [stale, stale, again] } });
      mod.afterCommands(sm as never, log(push([stale, stale], [stale, stale, again])));
      expect(sm.get<Record<string, unknown>[]>(path)!.map((e) => e['开始时间'])).toEqual([makeTime(1, 2, 1, 0, 0), makeTime(1, 2, 1, 0, 0), makeTime(1, 2, 3, 9, 0)]);
    });

    it('editing a field of a status, or a round that does not touch the list, restarts nothing', () => {
      const mod = new EffectLifecycleModule(effectConfig, calendarConfig);
      const old = makeEffect('旧伤', makeTime(1, 2, 3, 0, 0), 600);
      const { sm, mutations } = createMockStateManager({ 世界: { 时间: makeTime(1, 2, 3, 12, 0) }, 角色: { 状态效果: [old] } });
      mod.afterCommands(sm as never, { source: 'command', timestamp: 0,
        changes: [{ path: `${path}[0].持续时间`, action: 'set', oldValue: 60, newValue: 600, timestamp: 0 }] });
      mod.afterCommands(sm as never, { source: 'command', timestamp: 0, changes: [] });
      expect(mutations).toHaveLength(0);
      expect(sm.get<Record<string, unknown>[]>(path)![0]['开始时间']).toEqual(makeTime(1, 2, 3, 0, 0));
    });
  });
});
