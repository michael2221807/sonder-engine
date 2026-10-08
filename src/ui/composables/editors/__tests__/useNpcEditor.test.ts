import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockGameState, type MockGameState } from './mock-game-state';

let mockState: MockGameState;

vi.mock('@/ui/composables/useGameState', () => ({
  useGameState: () => mockState,
}));
vi.mock('@/engine/core/event-bus', () => ({
  eventBus: { emit: vi.fn(), on: () => () => {} },
}));
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, inject: () => null };
});

const { useNpcEditor } = await import('../useNpcEditor');
const { eventBus } = await import('@/engine/core/event-bus');

describe('useNpcEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const { mock } = createMockGameState({
      角色: { 基础信息: { 姓名: '张三' } },
      社交: {
        关系: [
          { 名称: '李四', 类型: '朋友', 好感度: 60, 位置: '京城' },
          { 名称: '王五', 类型: '商人', 好感度: 30, 位置: '东城', 关系网变量: [{ 对象: '李四', 关系: '同门', 备注: '' }] },
        ],
      },
      世界: {
        地点信息: [
          { 名称: '京城', NPC: ['李四'] },
          { 名称: '东城', NPC: ['王五', '李四'] },
        ],
      },
      系统: { 扩展: { engramMemory: { entities: [{ name: '李四' }] } } },
    });
    mockState = mock;
  });

  describe('save — new NPC', () => {
    it('creates a new NPC', () => {
      const editor = useNpcEditor();
      const result = editor.save(-1, { 名称: '赵六', 类型: '中立' });
      expect(result.ok).toBe(true);
      const list = mockState.get<Array<{ 名称: string }>>('社交.关系');
      expect(list).toHaveLength(3);
      expect(list![2].名称).toBe('赵六');
    });

    it('rejects empty name', () => {
      const editor = useNpcEditor();
      const result = editor.save(-1, { 名称: '' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FIELD_REQUIRED');
    });

    it('rejects duplicate name', () => {
      const editor = useNpcEditor();
      const result = editor.save(-1, { 名称: '李四' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NPC_NAME_CONFLICT');
    });

    it('rejects name conflicting with player', () => {
      const editor = useNpcEditor();
      const result = editor.save(-1, { 名称: '张三' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NPC_NAME_CONFLICT');
    });
  });

  describe('save — edit existing NPC', () => {
    it('updates an existing NPC preserving unedited fields', () => {
      const editor = useNpcEditor();
      const result = editor.save(0, { 名称: '李四', 好感度: 80 });
      expect(result.ok).toBe(true);
      const npc = mockState.get<Array<Record<string, unknown>>>('社交.关系')![0];
      expect(npc['好感度']).toBe(80);
      expect(npc['类型']).toBe('朋友');
    });

    it('cascades rename to location NPC lists', () => {
      const editor = useNpcEditor();
      editor.save(0, { 名称: '李四改名', 类型: '朋友' });
      const locations = mockState.get<Array<{ 名称: string; NPC: string[] }>>('世界.地点信息');
      expect(locations![0].NPC).toContain('李四改名');
      expect(locations![0].NPC).not.toContain('李四');
      expect(locations![1].NPC).toContain('李四改名');
    });

    it('cascades rename to other NPCs relationship network entries', () => {
      const editor = useNpcEditor();
      editor.save(0, { 名称: '李四改名', 类型: '朋友' });
      // After rename cascade, 王五's 关系网变量[0].对象 should be updated
      // Note: save() runs the rename cascades (cascadeNpcRenameLocations / cascadeNpcRenameNetwork)
      // before writing, so we need to check the final state after setValue
      const npcs = mockState.get<Array<Record<string, unknown>>>('社交.关系');
      const wangwu = npcs![1];
      const network = wangwu['关系网变量'] as Array<{ 对象: string }>;
      expect(network[0].对象).toBe('李四改名');
    });

    it('emits editor:npc-renamed event on rename', () => {
      const editor = useNpcEditor();
      editor.save(0, { 名称: '李四改名', 类型: '朋友' });
      expect(eventBus.emit).toHaveBeenCalledWith('editor:npc-renamed', {
        oldName: '李四',
        newName: '李四改名',
      });
    });
  });

  describe('delete', () => {
    it('removes NPC from list', () => {
      const editor = useNpcEditor();
      const result = editor.delete(0);
      expect(result.ok).toBe(true);
      const list = mockState.get<Array<{ 名称: string }>>('社交.关系');
      expect(list).toHaveLength(1);
      expect(list![0].名称).toBe('王五');
    });

    it('cascades cleanup to location NPC lists', () => {
      const editor = useNpcEditor();
      editor.delete(0);
      const locations = mockState.get<Array<{ NPC: string[] }>>('世界.地点信息');
      expect(locations![0].NPC).not.toContain('李四');
      expect(locations![1].NPC).not.toContain('李四');
    });

    it('emits editor:npc-deleted event', () => {
      const editor = useNpcEditor();
      editor.delete(0);
      expect(eventBus.emit).toHaveBeenCalledWith('editor:npc-deleted', { name: '李四' });
    });

    it('rejects invalid index', () => {
      const editor = useNpcEditor();
      const result = editor.delete(99);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NPC_NOT_FOUND');
    });

    it('cascades cleanup to other NPCs relationship network entries', () => {
      const editor = useNpcEditor();
      editor.delete(0); // delete 李四
      const npcs = mockState.get<Array<Record<string, unknown>>>('社交.关系');
      // 王五's 关系网变量 should no longer reference 李四
      const wangwu = npcs![0]; // after delete, 王五 is now index 0
      const network = wangwu['关系网变量'] as Array<{ 对象: string }> | undefined;
      expect(network ?? []).toHaveLength(0);
    });
  });

  describe('analyzeDeleteImpact', () => {
    it('correctly identifies location refs and engram entity', () => {
      const editor = useNpcEditor();
      const impact = editor.analyzeDeleteImpact(0);
      expect(impact.npcName).toBe('李四');
      expect(impact.locationRefs).toEqual(['京城', '东城']);
      expect(impact.hasEngramEntity).toBe(true);
    });

    it('returns no engram entity for NPC without one', () => {
      const editor = useNpcEditor();
      const impact = editor.analyzeDeleteImpact(1);
      expect(impact.npcName).toBe('王五');
      expect(impact.hasEngramEntity).toBe(false);
    });
  });

  describe('toggleFlag', () => {
    it('toggles a boolean flag', () => {
      const editor = useNpcEditor();
      const result = editor.toggleFlag(0, '关注');
      expect(result.ok).toBe(true);
      const npc = mockState.get<Array<Record<string, unknown>>>('社交.关系')![0];
      expect(npc['关注']).toBe(true);
    });

    it('toggles back to false', () => {
      const editor = useNpcEditor();
      editor.toggleFlag(0, '关注');
      editor.toggleFlag(0, '关注');
      const npc = mockState.get<Array<Record<string, unknown>>>('社交.关系')![0];
      expect(npc['关注']).toBe(false);
    });

    it('rejects invalid index', () => {
      const editor = useNpcEditor();
      const result = editor.toggleFlag(99, '关注');
      expect(result.ok).toBe(false);
    });
  });
});
