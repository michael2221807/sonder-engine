import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockGameState, type MockGameState } from './mock-game-state';

let mockState: MockGameState;

vi.mock('@/ui/composables/useGameState', () => ({
  useGameState: () => mockState,
}));
vi.mock('@/engine/core/event-bus', () => ({
  eventBus: { emit: vi.fn(), on: () => () => {} },
}));

const { useInventoryEditor, changedItemFields } = await import('../useInventoryEditor');
const { projectSavedElements } = await import('@/features/plot-vector/saved-elements');
const { capabilityKey } = await import('@/features/plot-vector/genesis/post-save');

describe('useInventoryEditor', () => {
  beforeEach(() => {
    const { mock } = createMockGameState({
      角色: {
        背包: {
          物品: {
            weapon_001: { 名称: '倚天剑', 类型: '武器', 数量: 1, 品质: '传说', 可装备: true, 已装备: true },
            potion_002: { 名称: '金创药', 类型: '消耗品', 数量: 5, 品质: '优良' },
          },
          金钱: { 现金: 500, 铜: 200, 银: 15, 金: 3 },
        },
      },
    });
    mockState = mock;
  });

  describe('create', () => {
    it('creates a new item with generated ID', () => {
      const editor = useInventoryEditor();
      const result = editor.create({ 名称: '铁矿石', 类型: '材料', 数量: 10 });
      expect(result.ok).toBe(true);
      expect(result.data?.id).toMatch(/^材料_\d+_/);

      const items = mockState.get<Record<string, { 名称: string }>>('角色.背包.物品');
      const newItem = items![result.data!.id];
      expect(newItem.名称).toBe('铁矿石');
    });

    it('defaults quantity to 1 and type to 其他', () => {
      const editor = useInventoryEditor();
      const result = editor.create({ 名称: '神秘物品' });
      expect(result.ok).toBe(true);
      expect(result.data?.id).toMatch(/^其他_/);

      const items = mockState.get<Record<string, { 数量: number }>>('角色.背包.物品');
      expect(items![result.data!.id].数量).toBe(1);
    });

    it('rejects empty name', () => {
      const editor = useInventoryEditor();
      const result = editor.create({ 名称: '' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FIELD_REQUIRED');
    });

    it('rejects quantity < 1', () => {
      const editor = useInventoryEditor();
      const result = editor.create({ 名称: '坏物品', 数量: 0 });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('ITEM_QUANTITY_INVALID');
    });
  });

  describe('update', () => {
    it('updates item fields', () => {
      const editor = useInventoryEditor();
      const result = editor.update('weapon_001', { 名称: '屠龙刀', 品质: '神话' });
      expect(result.ok).toBe(true);
      const item = mockState.get<{ 名称: string; 品质: string }>('角色.背包.物品.weapon_001');
      expect(item!.名称).toBe('屠龙刀');
      expect(item!.品质).toBe('神话');
    });

    it('auto-clears equipped when equippable set to false', () => {
      const editor = useInventoryEditor();
      editor.update('weapon_001', { 名称: '倚天剑', 可装备: false });
      const item = mockState.get<{ 可装备: boolean; 已装备: boolean }>('角色.背包.物品.weapon_001');
      expect(item!.已装备).toBe(false);
    });

    it('rejects update for non-existent item', () => {
      const editor = useInventoryEditor();
      const result = editor.update('fake_id', { 名称: 'x' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('ITEM_NOT_FOUND');
    });

    it('rejects empty name on update', () => {
      const editor = useInventoryEditor();
      const result = editor.update('weapon_001', { 名称: '' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FIELD_REQUIRED');
    });

    it('rejects quantity < 1 on update', () => {
      const editor = useInventoryEditor();
      const result = editor.update('weapon_001', { 名称: '倚天剑', 数量: 0 });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('ITEM_QUANTITY_INVALID');
    });
  });

  // PO 2026-10-03: an edit writes only what the player changed, so an item keeps its card (and its card's rarity).
  describe('changedItemFields', () => {
    const opened = { 名称: '随身日记', 类型: '其他', 数量: 1, 品质: '稀有', 描述: '记录日常', 可装备: false, 已装备: false };

    it('sends the name alone when nothing else changed', () => {
      expect(changedItemFields(opened, { ...opened })).toEqual({ 名称: '随身日记' });
    });

    it('sends each field the player changed, and only those', () => {
      expect(changedItemFields(opened, { ...opened, 名称: '旧日记', 描述: '换了个说法', 数量: 2 }))
        .toEqual({ 名称: '旧日记', 描述: '换了个说法', 数量: 2 });
      expect(changedItemFields(opened, { ...opened, 可装备: true, 已装备: true, 品质: '史诗' }))
        .toEqual({ 名称: '随身日记', 可装备: true, 已装备: true, 品质: '史诗' });
    });

    it('a description fix on an item the model made adds no field, so its card stays the same card', () => {
      const made = { 名称: '随身日记', 描述: '记录日常', 数量: 1, 品质: '稀有', 能力版本: 1 };
      const { mock } = createMockGameState({ 角色: { 背包: { 物品: { notebook: { ...made } } } } });
      mockState = mock;
      const keyOf = () => capabilityKey(projectSavedElements(mockState.tree.value).entries[0]);
      const before = keyOf();
      // What the form shows for it: defaults for the fields it never had.
      const form = { 名称: made.名称, 类型: '其他', 数量: 1, 品质: '稀有', 描述: made.描述, 可装备: false, 已装备: false };
      const result = useInventoryEditor().update('notebook', changedItemFields(form, { ...form, 描述: '换了个说法' }));
      expect(result.ok).toBe(true);
      expect(mockState.get('角色.背包.物品.notebook')).toEqual({ ...made, 描述: '换了个说法' });
      expect(keyOf()).toBe(before);
    });
  });

  describe('delete', () => {
    it('removes item from Record', () => {
      const editor = useInventoryEditor();
      const result = editor.delete('weapon_001');
      expect(result.ok).toBe(true);
      const items = mockState.get<Record<string, unknown>>('角色.背包.物品');
      expect(items!['weapon_001']).toBeUndefined();
      expect(items!['potion_002']).toBeDefined();
    });

    it('rejects delete of non-existent item', () => {
      const editor = useInventoryEditor();
      const result = editor.delete('fake_id');
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('ITEM_NOT_FOUND');
    });
  });

  describe('updateCurrency', () => {
    it('updates all currency values', () => {
      const editor = useInventoryEditor();
      const result = editor.updateCurrency({ 现金: 1000, 铜: 0, 银: 50, 金: 10 });
      expect(result.ok).toBe(true);
      const currency = mockState.get<Record<string, number>>('角色.背包.金钱');
      expect(currency).toEqual({ 现金: 1000, 铜: 0, 银: 50, 金: 10 });
    });

    it('rejects negative currency value', () => {
      const editor = useInventoryEditor();
      const result = editor.updateCurrency({ 现金: -100, 铜: 0, 银: 0, 金: 0 });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FIELD_INVALID');
    });
  });
});
