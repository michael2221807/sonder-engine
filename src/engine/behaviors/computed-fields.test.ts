import { describe, it, expect } from 'vitest';
import { ComputedFieldsModule } from '@/engine/behaviors/computed-fields';
import { createMockStateManager } from '@/engine/__test-utils__';
import type { ComputedFieldConfig } from '@/engine/types';

describe('ComputedFieldsModule', () => {
  it('has correct module id', () => {
    const mod = new ComputedFieldsModule([]);
    expect(mod.id).toBe('computed-fields');
  });

  it('evaluates formula with get()', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.战斗力', formula: 'get(角色.属性.力量) * 2', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: { 属性: { 力量: 10 } } });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.战斗力')).toBe(20);
  });

  it('handles addition formula', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.总攻', formula: 'get(角色.基础攻击) + get(角色.武器攻击)', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: { 基础攻击: 15, 武器攻击: 8 } });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.总攻')).toBe(23);
  });

  it('only evaluates matching trigger', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.创建值', formula: '100', trigger: 'onCreation' },
      { target: '角色.回合值', formula: '200', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: {} });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.回合值')).toBe(200);
    expect(sm.get('角色.创建值')).toBeUndefined(); // not triggered
  });

  it('handles empty configs', () => {
    const { sm } = createMockStateManager({});
    const mod = new ComputedFieldsModule([]);
    mod.onRoundEnd(sm as never);
    // No-op
    expect(true).toBe(true);
  });

  it('does not crash on formula error and writes no garbage', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.bad', formula: 'get(不存在的路径) * 2', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({});
    const mod = new ComputedFieldsModule(configs);
    expect(() => mod.onRoundEnd(sm as never)).not.toThrow();
    // Verify the target either gets a safe value (0/NaN handled) or undefined
    const val = sm.get<number>('角色.bad');
    expect(val === undefined || val === 0 || Number.isNaN(val)).toBe(true);
  });

  it('evaluates max() formula', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.clamped', formula: 'max(0, get(角色.hp) - 10)', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: { hp: 5 } });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.clamped')).toBe(0); // max(0, 5-10) = max(0, -5) = 0
  });

  it('evaluates min() formula', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.cap', formula: 'min(100, get(角色.raw))', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: { raw: 150 } });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.cap')).toBe(100); // min(100, 150) = 100
  });

  it('evaluates division formula', () => {
    const configs: ComputedFieldConfig[] = [
      { target: '角色.pct', formula: 'get(角色.当前) / get(角色.上限) * 100', trigger: 'onRoundEnd' },
    ];
    const { sm } = createMockStateManager({ 角色: { 当前: 75, 上限: 100 } });
    const mod = new ComputedFieldsModule(configs);
    mod.onRoundEnd(sm as never);
    expect(sm.get('角色.pct')).toBe(75);
  });
});

describe('ComputedFieldsModule · the tianming vital percentages', () => {
  it('never read above 100% even before the round-end clamp has run', async () => {
    const config = (await import('../../../public/packs/tianming/rules/computed-fields.json')).default as { fields: ComputedFieldConfig[] };
    const { sm } = createMockStateManager({ 角色: { 可变属性: { 体力: { 当前: 116, 上限: 100 }, 精力: { 当前: 35, 上限: 70 } } } });
    new ComputedFieldsModule(config.fields).onRoundEnd(sm as never);
    expect(sm.get('角色.可变属性.体力.百分比')).toBe(100);
    expect(sm.get('角色.可变属性.精力.百分比')).toBe(50);
  });
});
