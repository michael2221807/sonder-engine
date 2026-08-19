import { describe, it, expect } from 'vitest';
import { ValidationRepairModule } from './validation-repair';
import { createMockStateManager } from '../__test-utils__/state-manager.mock';

describe('ValidationRepairModule', () => {
  function createModule(schema: Record<string, unknown>) {
    return new ValidationRepairModule(schema);
  }

  describe('missing field repair', () => {
    it('fills missing field with schema default', () => {
      const schema = {
        type: 'object',
        properties: {
          体力: { type: 'number', default: 100 },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({});
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(100);
    });

    it('does not fill missing field without default', () => {
      const schema = {
        type: 'object',
        properties: {
          体力: { type: 'number' },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({});
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBeUndefined();
    });

    it('fills null field with default', () => {
      const schema = {
        type: 'object',
        properties: {
          名称: { type: 'string', default: '无名' },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 名称: null });
      mod.onRoundEnd(sm as never);
      expect(sm.get('名称')).toBe('无名');
    });
  });

  describe('type coercion', () => {
    it('coerces string to number', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number' } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: '42' });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(42);
    });

    it('coerces NaN string to default', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number', default: 50 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: 'abc' });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(50);
    });

    it('coerces NaN string to 0 without default', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number' } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: 'abc' });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(0);
    });

    it('coerces number to string', () => {
      const schema = {
        type: 'object',
        properties: { 名称: { type: 'string' } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 名称: 123 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('名称')).toBe('123');
    });

    it('coerces to boolean', () => {
      const schema = {
        type: 'object',
        properties: { 已死亡: { type: 'boolean' } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 已死亡: 1 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('已死亡')).toBe(true);
    });

    it('replaces non-array with default when array expected', () => {
      const schema = {
        type: 'object',
        properties: { 效果: { type: 'array', default: [] } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 效果: 'not an array' });
      mod.onRoundEnd(sm as never);
      expect(sm.get('效果')).toEqual([]);
    });

    it('keeps valid array unchanged', () => {
      const schema = {
        type: 'object',
        properties: { 效果: { type: 'array' } },
      };
      const mod = createModule(schema);
      const arr = [1, 2, 3];
      const { sm } = createMockStateManager({ 效果: arr });
      mod.onRoundEnd(sm as never);
      expect(sm.get('效果')).toEqual([1, 2, 3]);
    });
  });

  describe('numeric clamping', () => {
    it('clamps value below minimum', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number', minimum: 0, maximum: 100 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: -5 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(0);
    });

    it('clamps value above maximum', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number', minimum: 0, maximum: 100 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: 150 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(100);
    });

    it('does not clamp when no bounds defined', () => {
      const schema = {
        type: 'object',
        properties: { 体力: { type: 'number' } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 体力: 9999 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('体力')).toBe(9999);
    });

    it('ignores creation-only bounds when loading an existing save', () => {
      const schema = {
        type: 'object',
        properties: {
          角色: {
            type: 'object',
            properties: {
              属性: {
                type: 'object',
                properties: {
                  体质: {
                    type: 'number',
                    default: 5,
                    'x-creation-min': 1,
                    'x-max': 20,
                  },
                },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 角色: { 属性: { 体质: -7 } } });

      mod.onGameLoad(sm as never);

      expect(sm.get('角色.属性.体质')).toBe(-7);
    });

    it('handles integer type same as number', () => {
      const schema = {
        type: 'object',
        properties: { 等级: { type: 'integer', minimum: 1, maximum: 99 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({ 等级: 0 });
      mod.onRoundEnd(sm as never);
      expect(sm.get('等级')).toBe(1);
    });
  });

  describe('nested object validation', () => {
    it('validates nested properties recursively', () => {
      const schema = {
        type: 'object',
        properties: {
          角色: {
            type: 'object',
            properties: {
              属性: {
                type: 'object',
                properties: {
                  体力: { type: 'number', minimum: 0, maximum: 100 },
                  智力: { type: 'number', default: 50 },
                },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({
        角色: { 属性: { 体力: -10 } },
      });
      mod.onRoundEnd(sm as never);
      expect(sm.get('角色.属性.体力')).toBe(0);
      expect(sm.get('角色.属性.智力')).toBe(50);
    });
  });

  describe('array items validation', () => {
    it('fills missing defaults in array items', () => {
      const schema = {
        type: 'object',
        properties: {
          NPC列表: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                好感度: { type: 'number', default: 50 },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({
        NPC列表: [{ 名称: '张三' }, { 名称: '李四', 好感度: 80 }],
      });
      mod.onRoundEnd(sm as never);
      expect(sm.get('NPC列表[0].好感度')).toBe(50);
      expect(sm.get('NPC列表[1].好感度')).toBe(80);
    });

    it('clamps numeric values in array items', () => {
      const schema = {
        type: 'object',
        properties: {
          效果: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                强度: { type: 'number', minimum: 0, maximum: 10 },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({
        效果: [{ 强度: -5 }, { 强度: 15 }, { 强度: 5 }],
      });
      mod.onRoundEnd(sm as never);
      expect(sm.get('效果[0].强度')).toBe(0);
      expect(sm.get('效果[1].强度')).toBe(10);
      expect(sm.get('效果[2].强度')).toBe(5);
    });

    it('recursively validates nested objects inside arrays (CR-R4)', () => {
      const schema = {
        type: 'object',
        properties: {
          关系: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                私密信息: {
                  type: 'object',
                  properties: {
                    敏感度: { type: 'number', minimum: 0, maximum: 100, default: 0 },
                  },
                },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({
        关系: [{ 私密信息: { 敏感度: 150 } }],
      });
      mod.onRoundEnd(sm as never);
      expect(sm.get('关系[0].私密信息.敏感度')).toBe(100);
    });

    it('recursively validates nested arrays inside arrays (CR-R4)', () => {
      const schema = {
        type: 'object',
        properties: {
          关系: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                部位: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      敏感度: { type: 'number', minimum: 0, maximum: 100 },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({
        关系: [{ 部位: [{ 敏感度: -10 }, { 敏感度: 200 }] }],
      });
      mod.onRoundEnd(sm as never);
      expect(sm.get('关系[0].部位[0].敏感度')).toBe(0);
      expect(sm.get('关系[0].部位[1].敏感度')).toBe(100);
    });
  });

  describe('lifecycle hooks', () => {
    it('onGameLoad runs validation', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'number', default: 10 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({});
      mod.onGameLoad(sm as never);
      expect(sm.get('x')).toBe(10);
    });

    it('onCreation runs validation', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'number', default: 10 } },
      };
      const mod = createModule(schema);
      const { sm } = createMockStateManager({});
      mod.onCreation(sm as never);
      expect(sm.get('x')).toBe(10);
    });
  });

  describe('no-op when schema has no properties', () => {
    it('does nothing for empty schema', () => {
      const mod = createModule({});
      const { sm, mutations } = createMockStateManager({ x: 1 });
      mod.onRoundEnd(sm as never);
      expect(mutations).toHaveLength(0);
    });
  });
});
