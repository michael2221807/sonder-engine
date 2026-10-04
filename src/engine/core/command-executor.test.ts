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

  // PO G1 (2026-09-26): a behaviour that must hold for writes from any flow observes every batch.
  describe('batch observer', () => {
    it('sees each batch that changed something, once, with its changeLog; a failing observer does not fail the batch', async () => {
      const { StateManager } = await import('@/engine/core/state-manager');
      const real = new StateManager();
      real.loadTree({ 角色: { 属性: { 体力: 100 } } });
      const executor = new CommandExecutor(real, ['角色']);
      const sm = real;
      const seen: string[][] = [];
      executor.observeBatches((log) => { seen.push(log.changes.map((c) => c.path)); });
      executor.executeBatch([{ action: 'set', key: '角色.名字', value: '张三' }, { action: 'add', key: '角色.属性.体力', value: -5 }]);
      executor.executeBatch([]);
      expect(seen).toEqual([['角色.名字', '角色.属性.体力']]);
      executor.observeBatches(() => { throw new Error('observer broke'); });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = executor.executeBatch([{ action: 'set', key: '角色.名字', value: '李四' }]);
      expect(result.hasErrors).toBe(false);
      expect(sm.get('角色.名字')).toBe('李四');
    });
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

    it('add with a negative delta decreases the value (injury, spending)', () => {
      const result = executor.execute({ action: 'add', key: '角色.属性.体力', value: -10 });
      expect(result.success).toBe(true);
      expect(sm.get('角色.属性.体力')).toBe(90);
    });

    it('add never takes a non-negative value below 0 and never goes above the cap', () => {
      executor.execute({ action: 'add', key: '角色.属性.体力', value: -150 });
      expect(sm.get('角色.属性.体力')).toBe(0);
      sm.set('角色.属性.体力', 999_990);
      executor.execute({ action: 'add', key: '角色.属性.体力', value: 100 });
      expect(sm.get('角色.属性.体力')).toBe(999_999);
    });

    it('an ordinary add keeps its exact delta; a non-number adds nothing', () => {
      sm.set('角色.属性.体力', 0.1);
      executor.execute({ action: 'add', key: '角色.属性.体力', value: 0.2 });
      expect(sm.get('角色.属性.体力')).toBe(0.1 + 0.2);
      executor.execute({ action: 'add', key: '角色.属性.体力', value: '三十' });
      expect(sm.get('角色.属性.体力')).toBe(0.1 + 0.2);
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

  it('does not relocate a missing item path by matching only its generic leaf field', () => {
    const mock = createMockStateManager({
      角色: { 背包: { 物品: {} } },
      世界: { 节日: { 名称: '平日', 描述: '', 效果: '' } },
    });
    const ex = new CommandExecutor(mock.sm as never, ['角色', '世界']);
    const result = ex.execute({ action: 'push', key: '背包.物品.item_missing.名称', value: '纸巾' });
    expect(result.success).toBe(false);
    expect(mock.sm.get('世界.节日.名称')).toBe('平日');
    expect(mock.sm.get('角色.背包.物品')).toEqual({});
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

describe('CommandExecutor · add on the real state tree', () => {
  it('spending and a filtered relation decrease apply, and stop at 0', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const sm = new StateManager();
    sm.loadTree({ 角色: { 背包: { 金钱: { 现金: 10 } } }, 社交: { 关系: [{ 名称: '林晚照', 好感度: 50 }] } });
    const ex = new CommandExecutor(sm, ['角色', '社交']);
    const results = ex.executeBatch([
      { action: 'add', key: '角色.背包.金钱.现金', value: -3 },
      { action: 'add', key: '社交.关系[名称=林晚照].好感度', value: -20 },
    ]).results;
    expect(results.every(r => r.success)).toBe(true);
    expect(sm.get('角色.背包.金钱.现金')).toBe(7);
    expect(sm.get('社交.关系[名称=林晚照].好感度')).toBe(30);
    ex.execute({ action: 'add', key: '角色.背包.金钱.现金', value: -30 });
    expect(sm.get('角色.背包.金钱.现金')).toBe(0);
  });
  it('an already negative value is never pulled back to 0: an increase applies, a further decrease keeps it', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const sm = new StateManager();
    sm.loadTree({ 社交: { 关系: [{ 名称: '沈墨琛', 好感度: -35 }] } });
    const ex = new CommandExecutor(sm, ['社交']);
    ex.execute({ action: 'add', key: '社交.关系[名称=沈墨琛].好感度', value: -5 });
    expect(sm.get('社交.关系[名称=沈墨琛].好感度')).toBe(-35);
    ex.execute({ action: 'add', key: '社交.关系[名称=沈墨琛].好感度', value: 5 });
    expect(sm.get('社交.关系[名称=沈墨琛].好感度')).toBe(-30);
    ex.execute({ action: 'add', key: '社交.关系[名称=沈墨琛].好感度', value: 50 });
    expect(sm.get('社交.关系[名称=沈墨琛].好感度')).toBe(20);
  });
});

// Paid check 2026-10-04: a single call's `push 记忆 …` replaced the whole memory object with a one-item list, wiping
// every tier; the next round's request said 「暂无」 for long- and mid-term memory.
describe('CommandExecutor · a push never replaces a value that is not a list', () => {
  it('refuses a push onto an object or a text and leaves it as it was; the rest of the batch still applies', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const sm = new StateManager();
    const memory = { 短期: [{ summary: 's' }], 中期: [{ 记忆主体: 'm' }], 长期: [{ content: 'l' }] };
    sm.loadTree({ 记忆: memory, 社交: { 关系: [{ 名称: '林晚照', 记忆: '旧的一句', 好感度: 50 }] } });
    const memoryBefore = JSON.parse(JSON.stringify(memory)) as unknown;
    const ex = new CommandExecutor(sm, ['记忆', '社交']);
    const { results } = ex.executeBatch([
      { action: 'push', key: '记忆', value: { 角色: '林晚照', 内容: '喂粥' } },
      { action: 'push', key: '社交.关系[名称=林晚照].记忆', value: '新的一句' },
      { action: 'add', key: '社交.关系[名称=林晚照].好感度', value: 4 },
    ]);
    expect(results.map((r) => r.success)).toEqual([false, false, true]);
    expect(results[0].error).toContain('not a list');
    expect(sm.get('记忆')).toEqual(memoryBefore);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toBe('旧的一句');
    expect(sm.get('社交.关系[名称=林晚照].好感度')).toBe(54);
  });
  it('still starts a list where there is none yet, and appends to one that is there', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const sm = new StateManager();
    sm.loadTree({ 社交: { 关系: [{ 名称: '林晚照', 记忆: ['第一条'], 经历: null }] } });
    const ex = new CommandExecutor(sm, ['社交']);
    expect(ex.execute({ action: 'push', key: '社交.关系[名称=林晚照].记忆', value: '第二条' }).success).toBe(true);
    expect(ex.execute({ action: 'push', key: '社交.关系[名称=林晚照].经历', value: '一次' }).success).toBe(true);
    expect(ex.execute({ action: 'push', key: '社交.关系[名称=林晚照].新列表', value: 'x' }).success).toBe(true);
    expect(sm.get('社交.关系[名称=林晚照].记忆')).toEqual(['第一条', '第二条']);
    expect(sm.get('社交.关系[名称=林晚照].经历')).toEqual(['一次']);
    expect(sm.get('社交.关系[名称=林晚照].新列表')).toEqual(['x']);
  });
});

describe('CommandExecutor · numeric ranges declared by the pack schema', () => {
  it('finds the declared range through filtered and indexed array segments only', async () => {
    const { schemaNumberBounds } = await import('@/engine/core/command-executor');
    const schema = (await import('../../../public/packs/tianming/schemas/state-schema.json')).default;
    for (const path of ['社交.关系[名称=林晚照].好感度', '社交.关系[0].好感度', '社交.关系.0.好感度'])
      expect(schemaNumberBounds(schema, path)).toEqual({ min: -100, max: 100 });
    for (const path of ['角色.背包.金钱.现金', '社交.关系[名称=林晚照].名称', '不存在.路径'])
      expect(schemaNumberBounds(schema, path)).toBeUndefined();
    // A current vital declares only its floor here; its max is the sibling field, applied at round end.
    expect(schemaNumberBounds(schema, '角色.可变属性.体力.当前')).toEqual({ min: 0, max: undefined });
  });

  it('an affinity may be negative and stays within -100~100 for set and add; undeclared fields keep the defaults', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const { schemaNumberBounds } = await import('@/engine/core/command-executor');
    const schema = (await import('../../../public/packs/tianming/schemas/state-schema.json')).default;
    const sm = new StateManager();
    sm.loadTree({ 角色: { 背包: { 金钱: { 现金: 5 } } }, 社交: { 关系: [{ 名称: '林晚照', 好感度: 60 }, { 名称: '沈墨琛', 好感度: -35 }] } });
    const ex = new CommandExecutor(sm, ['角色', '社交'], undefined, path => schemaNumberBounds(schema, path));
    const affinity = (name: string) => sm.get(`社交.关系[名称=${name}].好感度`);
    ex.execute({ action: 'add', key: '社交.关系[名称=林晚照].好感度', value: -80 });
    expect(affinity('林晚照')).toBe(-20);
    ex.execute({ action: 'add', key: '社交.关系[名称=沈墨琛].好感度', value: -100 });
    expect(affinity('沈墨琛')).toBe(-100);
    ex.execute({ action: 'add', key: '社交.关系[名称=沈墨琛].好感度', value: 300 });
    expect(affinity('沈墨琛')).toBe(100);
    ex.execute({ action: 'set', key: '社交.关系[名称=林晚照].好感度', value: -150 });
    expect(affinity('林晚照')).toBe(-100);
    ex.execute({ action: 'set', key: '社交.关系[名称=林晚照].好感度', value: -20 });
    expect(affinity('林晚照')).toBe(-20);
    ex.execute({ action: 'add', key: '角色.背包.金钱.现金', value: -9 });
    expect(sm.get('角色.背包.金钱.现金')).toBe(0);
    ex.execute({ action: 'set', key: '角色.背包.金钱.现金', value: -9 });
    expect(sm.get('角色.背包.金钱.现金')).toBe(0);
  });

  it('the round-end schema repair keeps an affinity written inside a whole NPC object within range', async () => {
    const { StateManager } = await import('@/engine/core/state-manager');
    const { ValidationRepairModule } = await import('@/engine/behaviors/validation-repair');
    const schema = (await import('../../../public/packs/tianming/schemas/state-schema.json')).default;
    const sm = new StateManager();
    sm.loadTree({ 社交: { 关系: [] } });
    new CommandExecutor(sm, ['社交']).execute({ action: 'push', key: '社交.关系', value: { 名称: '仇人', 好感度: -150 } });
    new ValidationRepairModule(schema as Record<string, unknown>).onRoundEnd(sm);
    expect(sm.get('社交.关系[名称=仇人].好感度')).toBe(-100);
  });
});
