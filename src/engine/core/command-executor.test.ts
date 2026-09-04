import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockStateManager } from '@/engine/__test-utils__';

// Mock eventBus before importing CommandExecutor
vi.mock('@/engine/core/event-bus', () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    eventBus: {
      emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
      on: () => () => {},
      _emitted: emitted,
      _clear: () => { emitted.length = 0; },
    },
  };
});

// Dynamic import after mock setup
const { CommandExecutor } = await import('@/engine/core/command-executor');
const { eventBus } = await import('@/engine/core/event-bus');

describe('CommandExecutor', () => {
  let sm: ReturnType<typeof createMockStateManager>['sm'];
  let executor: InstanceType<typeof CommandExecutor>;

  beforeEach(() => {
    const mock = createMockStateManager({ 角色: { 属性: { 体力: 100 }, 背包: { 物品: ['剑'] } } });
    sm = mock.sm;
    executor = new CommandExecutor(sm as never, ['角色', '世界', '社交']);
    (eventBus as unknown as { _clear: () => void })._clear();
  });

  describe('single command execution', () => {
    it('set action writes value', () => {
      const result = executor.execute({ action: 'set', key: '角色.名字', value: '张三' });
      expect(result.success).toBe(true);
      expect(sm.get('角色.名字')).toBe('张三');
    });

    it('set trims string values', () => {
      executor.execute({ action: 'set', key: '角色.名字', value: '  张三  ' });
      expect(sm.get('角色.名字')).toBe('张三');
    });

    it('add action increments number', () => {
      executor.execute({ action: 'add', key: '角色.属性.体力', value: 10 });
      expect(sm.get('角色.属性.体力')).toBe(110);
    });

    it('add with negative delta: clamp prevents health reduction', () => {
      // clampNumber(-10) = 0 → add(体力, 0) = 100 (unchanged)
      // Design: add action can only INCREASE values, not decrease.
      // To decrease, AI must use set with calculated value.
      executor.execute({ action: 'add', key: '角色.属性.体力', value: -10 });
      expect(sm.get('角色.属性.体力')).toBe(100);
    });

    it('delete action removes path', () => {
      executor.execute({ action: 'delete', key: '角色.属性.体力' });
      expect(sm.has('角色.属性.体力')).toBe(false);
    });

    it('push action appends to array', () => {
      executor.execute({ action: 'push', key: '角色.背包.物品', value: '盾' });
      const items = sm.get<string[]>('角色.背包.物品');
      expect(items).toContain('盾');
    });

    it('pull action removes from array', () => {
      executor.execute({ action: 'pull', key: '角色.背包.物品', value: '剑' });
      const items = sm.get<string[]>('角色.背包.物品');
      expect(items).not.toContain('剑');
    });

    it('returns error for missing action', () => {
      const result = executor.execute({ key: 'x', value: 1 } as never);
      expect(result.success).toBe(false);
    });

    it('returns error for missing key', () => {
      const result = executor.execute({ action: 'set', value: 1 } as never);
      expect(result.success).toBe(false);
    });
  });

  describe('batch execution', () => {
    it('executes all valid commands', () => {
      const result = executor.executeBatch([
        { action: 'set', key: '角色.名字', value: '李四' },
        { action: 'add', key: '角色.属性.体力', value: 5 },
      ]);
      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(2);
    });

    it('continues after partial failure', () => {
      const result = executor.executeBatch([
        { action: 'set', key: '角色.名字', value: '王五' },
        { key: 'bad' } as never, // missing action
        { action: 'set', key: '角色.年龄', value: 20 },
      ]);
      expect(result.hasErrors).toBe(true);
      expect(sm.get('角色.名字')).toBe('王五'); // first succeeded
      expect(sm.get('角色.年龄')).toBe(20); // third succeeded
    });

    it('handles empty batch', () => {
      const result = executor.executeBatch([]);
      expect(result.results).toHaveLength(0);
      expect(result.hasErrors).toBe(false);
    });
  });

  describe('path root whitelist', () => {
    it('emits toast for unknown path root', () => {
      executor.execute({ action: 'set', key: '未知根.字段', value: 1 });
      const emitted = (eventBus as unknown as { _emitted: Array<{ event: string }> })._emitted;
      expect(emitted.some((e) => e.event === 'ui:toast')).toBe(true);
    });

    it('does not warn for known root', () => {
      (eventBus as unknown as { _clear: () => void })._clear();
      executor.execute({ action: 'set', key: '角色.名字', value: '测试' });
      const emitted = (eventBus as unknown as { _emitted: Array<{ event: string }> })._emitted;
      expect(emitted.filter((e) => e.event === 'ui:toast')).toHaveLength(0);
    });
  });

  describe('array capacity', () => {
    it('push at capacity evicts oldest (FIFO)', () => {
      const bigArr = Array.from({ length: 200 }, (_, i) => `item${i}`);
      sm.set('角色.背包.物品', bigArr);
      executor.execute({ action: 'push', key: '角色.背包.物品', value: 'new' });
      const items = sm.get<string[]>('角色.背包.物品')!;
      expect(items.length).toBeLessThanOrEqual(200);
      expect(items[items.length - 1]).toBe('new');
      expect(items).not.toContain('item0'); // oldest evicted
    });
  });

  describe('pushDedupGuard', () => {
    it('suppresses push when guard returns false', () => {
      const guard = vi.fn().mockReturnValue(false);
      const mock = createMockStateManager({ 社交: { 关系: [{ 记忆: ['existing'] }] } });
      const guarded = new CommandExecutor(mock.sm as never, null, guard);
      const result = guarded.execute({
        action: 'push',
        key: '社交.关系.0.记忆',
        value: 'duplicate',
      });
      expect(result.success).toBe(true);
      expect(guard).toHaveBeenCalledWith('社交.关系.0.记忆', 'duplicate', ['existing']);
      expect(mock.sm.get<string[]>('社交.关系.0.记忆')).toEqual(['existing']);
    });

    it('allows push when guard returns true', () => {
      const guard = vi.fn().mockReturnValue(true);
      const mock = createMockStateManager({ 社交: { 关系: [{ 记忆: ['existing'] }] } });
      const guarded = new CommandExecutor(mock.sm as never, null, guard);
      guarded.execute({ action: 'push', key: '社交.关系.0.记忆', value: 'new' });
      expect(mock.sm.get<string[]>('社交.关系.0.记忆')).toContain('new');
    });

    it('skips guard when no existing array', () => {
      const guard = vi.fn().mockReturnValue(true);
      const mock = createMockStateManager({ 角色: {} });
      const guarded = new CommandExecutor(mock.sm as never, null, guard);
      guarded.execute({ action: 'push', key: '角色.技能', value: 'fireball' });
      expect(guard).not.toHaveBeenCalled();
    });

    it('skips guard when target is non-array value', () => {
      const guard = vi.fn().mockReturnValue(true);
      const mock = createMockStateManager({ 角色: { 名字: 'text' } });
      const guarded = new CommandExecutor(mock.sm as never, null, guard);
      guarded.execute({ action: 'push', key: '角色.名字', value: 'append' });
      expect(guard).not.toHaveBeenCalled();
    });

    it('returns failure when guard throws', () => {
      const guard = vi.fn().mockImplementation(() => { throw new Error('guard boom'); });
      const mock = createMockStateManager({ 社交: { 关系: [{ 记忆: ['existing'] }] } });
      const guarded = new CommandExecutor(mock.sm as never, null, guard);
      const result = guarded.execute({
        action: 'push',
        key: '社交.关系.0.记忆',
        value: 'x',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('guard boom');
      expect(mock.sm.get<string[]>('社交.关系.0.记忆')).toEqual(['existing']);
    });
  });
});

// ─── §11.4 伪根路径：归位 / 拒绝（2026-09-04，Context Compiler 冒烟发现，PO 要求修复） ───
describe('CommandExecutor · unknown path root → relocate or reject', () => {
  const emitted = (eventBus as unknown as { _emitted: Array<{ event: string; payload: unknown }> })._emitted;

  function make() {
    const mock = createMockStateManager({
      角色: {
        基础信息: { 姓名: '主角', 当前位置: 'A·B' },
        身体: { 反差体质失控度: 10, 部位: [{ 名称: '颈', 敏感度: 20 }] },
        属性: { 等级: 3 },
      },
      世界: { 规则: { 等级: 1 }, 描述: 'w' },
      社交: { 关系: [{ 名称: '甲', 好感度: 50 }] },
      元数据: { 上次对话前快照: { 角色: { 身体: { 反差体质失控度: 5 } } } },
    });
    const ex = new CommandExecutor(mock.sm as never, ['角色', '世界', '社交', '元数据']);
    (eventBus as unknown as { _clear: () => void })._clear();
    return { sm: mock.sm, ex };
  }

  it('relocates a dropped-root path to its unique home (shallowest wins over the pre-round snapshot copy)', () => {
    const { sm, ex } = make();
    const r = ex.execute({ action: 'set', key: '身体.反差体质失控度', value: 42 });
    expect(r.success).toBe(true);
    expect(r.command.key).toBe('角色.身体.反差体质失控度');
    expect(r.relocatedFrom).toBe('身体.反差体质失控度');
    expect(sm.get('角色.身体.反差体质失控度')).toBe(42);
    expect(sm.get('身体')).toBeUndefined(); // no top-level pseudo key
    expect(sm.get('元数据.上次对话前快照.角色.身体.反差体质失控度')).toBe(5); // deeper copy untouched
  });

  it('drops a fabricated leading segment (builder piece title used as a root) and still relocates', () => {
    const { sm, ex } = make();
    const r = ex.execute({ action: 'add', key: '用户角色数据.身体.反差体质失控度', value: 5 });
    expect(r.success).toBe(true);
    expect(r.command.key).toBe('角色.身体.反差体质失控度');
    expect(sm.get('角色.身体.反差体质失控度')).toBe(15);
    expect(sm.get('用户角色数据')).toBeUndefined();
  });

  it('keeps filter segments intact when relocating', async () => {
    // The mock's filter regex needs an ASCII-leading field name; the real StateManager
    // resolves `[名称=颈]`, so this case runs against the real one.
    const { StateManager } = await import('@/engine/core/state-manager');
    const sm = new StateManager();
    sm.loadTree({
      角色: { 身体: { 反差体质失控度: 10, 部位: [{ 名称: '颈', 敏感度: 20 }] } },
      世界: {}, 社交: {}, 元数据: {},
    });
    const ex = new CommandExecutor(sm, ['角色', '世界', '社交', '元数据']);
    const r = ex.execute({ action: 'set', key: '身体.部位[名称=颈].敏感度', value: 60 });
    expect(r.success).toBe(true);
    expect(r.command.key).toBe('角色.身体.部位[名称=颈].敏感度');
    expect(sm.get('角色.身体.部位[名称=颈].敏感度')).toBe(60);
  });

  it('rejects when nothing in the tree can host the path — no pseudo key is created', () => {
    const { sm, ex } = make();
    const r = ex.execute({ action: 'set', key: '人性锚点', value: 3 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('已拒绝');
    expect(sm.get('人性锚点')).toBeUndefined();
    const r2 = ex.execute({ action: 'push', key: '记忆（甲）', value: 'x' });
    expect(r2.success).toBe(false);
    expect(sm.get('记忆（甲）')).toBeUndefined();
  });

  it('rejects an ambiguous path (two equally shallow homes) instead of guessing', () => {
    const { sm, ex } = make();
    const r = ex.execute({ action: 'set', key: '等级', value: 9 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('不唯一');
    expect(sm.get('角色.属性.等级')).toBe(3);
    expect(sm.get('世界.规则.等级')).toBe(1);
    expect(sm.get('等级')).toBeUndefined();
  });

  it('whitelisted roots are untouched and produce no toast', () => {
    const { sm, ex } = make();
    const r = ex.execute({ action: 'set', key: '角色.属性.等级', value: 4 });
    expect(r.success).toBe(true);
    expect(r.relocatedFrom).toBeUndefined();
    expect(sm.get('角色.属性.等级')).toBe(4);
    expect(emitted.filter((e) => e.event === 'ui:toast')).toHaveLength(0);
  });

  it('warns + toasts once per pseudo root per session, and batch results carry the outcome', () => {
    const { ex } = make();
    const batch = ex.executeBatch([
      { action: 'set', key: '身体.反差体质失控度', value: 1 },
      { action: 'set', key: '身体.反差体质失控度', value: 2 },
      { action: 'set', key: '人性锚点', value: 3 },
    ]);
    expect(batch.results.map((r) => r.success)).toEqual([true, true, false]);
    expect(batch.hasErrors).toBe(true);
    expect(batch.results[0].relocatedFrom).toBe('身体.反差体质失控度');
    expect(batch.results[2].error).toContain('已拒绝');
    const toasts = emitted.filter((e) => e.event === 'ui:toast');
    expect(toasts).toHaveLength(2); // 身体 once, 人性锚点 once
  });

  it('whitelist null → validation disabled (legacy behaviour preserved for tests / compat)', () => {
    const mock = createMockStateManager({ 角色: {} });
    const ex = new CommandExecutor(mock.sm as never, null);
    const r = ex.execute({ action: 'set', key: '任意.路径', value: 1 });
    expect(r.success).toBe(true);
  });
});
