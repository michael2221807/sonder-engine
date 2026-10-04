/**
 * Card import payload appliers 单元测试 — Story 6 P4 (OD-D 9 矩阵)
 *
 * 覆盖：图片命名空间 + 引用重写(SC-11) / 存档级 presets·worldBooks / 全局 opt-in
 * configOverlays·settings·promptOverrides·builtinOverrides / SC-9 denylist 永不写 /
 * OD-L ledger。store 用最小 mock；localStorage 走 createMockLocalStorage。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import {
  namespaceImageEntries,
  rewriteAssetRefs,
  applyCustomPresets,
  applyWorldBooks,
  applyGlobalConfigOverlays,
  applyGlobalPromptOverrides,
  applyGlobalPromptEdits,
  applyGlobalSettings,
  applyAuthorGameplaySettings,
  readImportedCardLedger,
  recordImportedCard,
  IMPORTED_CARDS_LEDGER_KEY,
} from './card-import-payloads';
import { SETTINGS_EXPORT_DENYLIST } from './settings-export-whitelist';
import type { CardImageAssetEntry } from './game-card-bundle.types';
import type { CustomPresetStore } from '../persistence/custom-preset-store';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import { eventBus } from '../core/event-bus';

function imgEntry(id: string): CardImageAssetEntry {
  return {
    id,
    metadata: { id, prompt: 'p', createdAt: 1 } as unknown as CardImageAssetEntry['metadata'],
    base64: 'AAAA',
    mimeType: 'image/png',
  };
}

// ─── namespaceImageEntries (OD-K) ────────────────────────────────

describe('namespaceImageEntries', () => {
  it('给 entry.id 和 metadata.id 都加命名空间，并产出 idMap', () => {
    const { entries, idMap } = namespaceImageEntries([imgEntry('img_a'), imgEntry('img_b')], 'card_42');
    expect(entries[0].id).toBe('card_42::img_a');
    expect(entries[0].metadata.id).toBe('card_42::img_a'); // ★ P1-c: metadata.id 也改（importEntries put key）
    expect(entries[1].id).toBe('card_42::img_b');
    expect(idMap.get('img_a')).toBe('card_42::img_a');
    expect(idMap.get('img_b')).toBe('card_42::img_b');
  });

  it('纯函数：不修改入参 entries', () => {
    const input = [imgEntry('img_a')];
    namespaceImageEntries(input, 'ns');
    expect(input[0].id).toBe('img_a');
    expect(input[0].metadata.id).toBe('img_a');
  });

  it('跳过缺 id 的脏条目', () => {
    const { entries } = namespaceImageEntries(
      [{ id: '', metadata: {} as never, base64: '', mimeType: '' }, imgEntry('img_ok')],
      'ns',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('ns::img_ok');
  });
});

// ─── rewriteAssetRefs (SC-11 通用重写) ───────────────────────────

describe('rewriteAssetRefs — 通用深度重写（非硬编码字段名）', () => {
  it('重写树内任意位置的资产引用（玩家档案/生图历史/NPC/场景），不漏', () => {
    const idMap = new Map([
      ['img_avatar', 'ns::img_avatar'],
      ['img_hist1', 'ns::img_hist1'],
      ['img_npc', 'ns::img_npc'],
      ['img_scene', 'ns::img_scene'],
    ]);
    const tree = {
      角色: { 图片档案: { 已选头像图片ID: 'img_avatar', 生图历史: [{ id: 'img_hist1' }, { id: 'unrelated' }] } },
      社交: { 关系: [{ 名称: 'A', 图片档案: { 已选立绘图片ID: 'img_npc' } }] },
      系统: { 扩展: { image: { sceneArchive: { 当前壁纸图片ID: 'img_scene' } } } },
      叙事: '这是一段无关文字',
    };
    rewriteAssetRefs(tree, idMap);
    expect((tree.角色.图片档案 as Record<string, unknown>).已选头像图片ID).toBe('ns::img_avatar');
    expect((tree.角色.图片档案.生图历史 as Array<{ id: string }>)[0].id).toBe('ns::img_hist1');
    expect((tree.角色.图片档案.生图历史 as Array<{ id: string }>)[1].id).toBe('unrelated'); // 不在 idMap → 不动
    const npc0 = (tree.社交.关系 as unknown as Array<{ 图片档案: { 已选立绘图片ID: string } }>)[0];
    expect(npc0.图片档案.已选立绘图片ID).toBe('ns::img_npc');
    expect((tree.系统.扩展.image.sceneArchive as Record<string, unknown>).当前壁纸图片ID).toBe('ns::img_scene');
    expect(tree.叙事).toBe('这是一段无关文字'); // 无关字符串不动
  });

  it('空 idMap → no-op', () => {
    const tree = { a: 'img_x' };
    rewriteAssetRefs(tree, new Map());
    expect(tree.a).toBe('img_x');
  });

  it('根节点是数组也能重写', () => {
    const tree: unknown[] = [{ id: 'img_a' }, 'img_a', 'other'];
    rewriteAssetRefs(tree, new Map([['img_a', 'ns::img_a']]));
    expect((tree[0] as { id: string }).id).toBe('ns::img_a');
    expect(tree[1]).toBe('ns::img_a');
    expect(tree[2]).toBe('other');
  });

  it('原型污染防护：不写入 __proto__ 键', () => {
    const tree = JSON.parse('{"__proto__": {"polluted": "img_a"}, "safe": "img_a"}');
    rewriteAssetRefs(tree, new Map([['img_a', 'ns::img_a']]));
    expect(tree.safe).toBe('ns::img_a'); // 正常键重写
    // 原型未被污染
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('与 namespaceImageEntries 配合：命名后的 entries 与树引用对齐', () => {
    const { idMap } = namespaceImageEntries([imgEntry('img_a')], 'card_1');
    const tree = { 角色: { 图片档案: { 已选头像图片ID: 'img_a' } } };
    rewriteAssetRefs(tree, idMap);
    expect(tree.角色.图片档案.已选头像图片ID).toBe('card_1::img_a');
  });
});

// ─── 存档级 appliers ─────────────────────────────────────────────

describe('applyCustomPresets', () => {
  it('用 customPresets[packId] 调 appendPreservingIds', async () => {
    const appendPreservingIds = vi.fn(async () => [{ id: 'user_x' }, { id: 'user_y' }]);
    const store = { appendPreservingIds } as unknown as CustomPresetStore;
    const n = await applyCustomPresets(store, 'tianming', {
      tianming: { worlds: [{ id: 'user_x' } as never], origins: [{ id: 'user_y' } as never] },
    });
    expect(appendPreservingIds).toHaveBeenCalledWith('tianming', {
      worlds: [{ id: 'user_x' }],
      origins: [{ id: 'user_y' }],
    });
    expect(n).toBe(2);
  });

  it('customPresets 缺失或无该 pack → 0，不调 store', async () => {
    const appendPreservingIds = vi.fn();
    const store = { appendPreservingIds } as unknown as CustomPresetStore;
    expect(await applyCustomPresets(store, 'tianming', undefined)).toBe(0);
    expect(await applyCustomPresets(store, 'tianming', { other: {} })).toBe(0);
    expect(appendPreservingIds).not.toHaveBeenCalled();
  });
});

describe('applyWorldBooks', () => {
  it('调 importWorldBooks(新profileId, data)', async () => {
    const importWorldBooks = vi.fn(async () => 3);
    const wb = { importWorldBooks } as unknown as WorldBookStorage;
    const data = { version: 1, exportedAt: 'x', books: [{}, {}, {}] } as never;
    const n = await applyWorldBooks(wb, 'profile_new', data);
    expect(importWorldBooks).toHaveBeenCalledWith('profile_new', data);
    expect(n).toBe(3);
  });

  it('worldBooks 缺失 → 0', async () => {
    const importWorldBooks = vi.fn();
    const wb = { importWorldBooks } as unknown as WorldBookStorage;
    expect(await applyWorldBooks(wb, 'p', undefined)).toBe(0);
    expect(importWorldBooks).not.toHaveBeenCalled();
  });
});

// ─── 全局 opt-in appliers ────────────────────────────────────────

describe('applyGlobalConfigOverlays (opt-in)', () => {
  it('调 configStore.importAll', async () => {
    const importAll = vi.fn(async () => {});
    const cs = { importAll } as unknown as ConfigStore;
    const overlays = [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }];
    const n = await applyGlobalConfigOverlays(cs, overlays);
    expect(importAll).toHaveBeenCalledWith(overlays);
    expect(n).toBe(1);
  });

  it('空/缺失 → 0，不调 store', async () => {
    const importAll = vi.fn();
    const cs = { importAll } as unknown as ConfigStore;
    expect(await applyGlobalConfigOverlays(cs, undefined)).toBe(0);
    expect(await applyGlobalConfigOverlays(cs, [])).toBe(0);
    expect(importAll).not.toHaveBeenCalled();
  });
});

describe('applyGlobalPromptOverrides + applyGlobalPromptEdits (opt-in)', () => {
  let storage: ReturnType<typeof createMockLocalStorage>;
  beforeEach(() => { storage = createMockLocalStorage(); storage.install(); });
  afterEach(() => storage.restore());

  it('promptOverrides → promptStorage.importAll', async () => {
    const importAll = vi.fn(async () => {});
    const ps = { importAll } as unknown as PromptStorage;
    const overrides = [{ key: 'k', value: 'v' }];
    expect(await applyGlobalPromptOverrides(ps, overrides)).toBe(1);
    expect(importAll).toHaveBeenCalledWith(overrides);
  });

  it('the author\'s prompt edits go where the prompt page keeps them, and the registry is told to reload', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    localStorage.setItem('aga_prompt_tianming_writeStyle', 'mine, kept');
    const n = applyGlobalPromptEdits('tianming', { promptEdits: { version: 1, packId: 'tianming', entries: [
      { id: 'jailbreak', content: 'AUTHOR' }, { id: 'antiCliche', enabled: false },
    ] } });
    expect(n).toBe(2);
    expect(localStorage.getItem('aga_prompt_tianming_jailbreak')).toBe('AUTHOR');
    expect(localStorage.getItem('aga_prompt_enabled_tianming_antiCliche')).toBe('false');
    expect(localStorage.getItem('aga_prompt_tianming_writeStyle')).toBe('mine, kept');
    expect(emit).toHaveBeenCalledWith('prompt:edits-replaced', { packId: 'tianming' });
    emit.mockRestore();
  });

  it('a card from before 2026-10-04 carries them as slot overrides: read as edits of the slots\' prompts', () => {
    const n = applyGlobalPromptEdits('tianming', { builtinPromptOverrides: { version: 1, exportedAt: 'x', entries: [
      { slotId: 'narrator_role', userContent: '旁白' }, { slotId: 'write_style', enabled: false },
    ] } as never });
    expect(n).toBe(2);
    expect(localStorage.getItem('aga_prompt_tianming_narratorFrame')).toBe('旁白');
    expect(localStorage.getItem('aga_prompt_enabled_tianming_writeStyle')).toBe('false');
  });

  it('缺失 → 0', async () => {
    const ps = { importAll: vi.fn() } as unknown as PromptStorage;
    expect(await applyGlobalPromptOverrides(ps, undefined)).toBe(0);
    expect(applyGlobalPromptEdits('p', {})).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});

// ─── settings + ledger (localStorage) ────────────────────────────

describe('applyGlobalSettings + OD-L ledger (localStorage)', () => {
  let mock: ReturnType<typeof createMockLocalStorage>;
  beforeEach(() => {
    mock = createMockLocalStorage();
    mock.install();
  });
  afterEach(() => mock.restore());

  it('写白名单 key，跳过 null/缺失', () => {
    const n = applyGlobalSettings({
      aga_user_settings: '{"theme":"dark"}',
      aga_text_speed: null, // null 跳过
      // aga_memory_settings 缺失
    });
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('aga_text_speed')).toBeNull();
    expect(n).toBe(1);
  });

  it('SC-9：所有 denylist/secret key 即使出现在 settings 也绝不写（白名单闭集，全量核对）', () => {
    // 把每个 denylist key 都塞进入参，证明闭集迭代一个都不写
    const malicious: Record<string, string> = { aga_user_settings: '{"ok":true}' };
    for (const k of SETTINGS_EXPORT_DENYLIST) malicious[k] = 'LEAKED-SECRET';
    applyGlobalSettings(malicious as never);
    for (const k of SETTINGS_EXPORT_DENYLIST) {
      expect(localStorage.getItem(k)).toBeNull(); // ★ 每个 denylist key 都永不写
    }
    expect(localStorage.getItem('aga_user_settings')).toBe('{"ok":true}');
  });

  it('NSFW 门控独占：applyGlobalSettings 绝不写 aga_nsfw_settings', () => {
    applyGlobalSettings({ aga_nsfw_settings: '{"nsfwMode":true}', aga_user_settings: '{}' });
    expect(localStorage.getItem('aga_nsfw_settings')).toBeNull(); // ★ 门控独占，settings 导入不碰
    expect(localStorage.getItem('aga_user_settings')).toBe('{}');
  });

  it('settings 缺失 → 0', () => {
    expect(applyGlobalSettings(undefined)).toBe(0);
  });

  it('applyAuthorGameplaySettings：只写玩法子集，不碰主题/记忆等非玩法键', () => {
    const n = applyAuthorGameplaySettings({
      aga_action_options_settings: '{"mode":"a"}', // 玩法 → 写
      aga_cot_settings: '{"on":true}',             // 玩法 → 写
      aga_user_settings: '{"theme":"dark"}',       // 非玩法 → 不写
      aga_memory_settings: '{"x":1}',              // 非玩法 → 不写
      aga_nsfw_settings: '{"nsfwMode":true}',      // 门控独占 → 不写
    });
    expect(localStorage.getItem('aga_action_options_settings')).toBe('{"mode":"a"}');
    expect(localStorage.getItem('aga_cot_settings')).toBe('{"on":true}');
    expect(localStorage.getItem('aga_user_settings')).toBeNull();   // 非玩法不动
    expect(localStorage.getItem('aga_memory_settings')).toBeNull();
    expect(localStorage.getItem('aga_nsfw_settings')).toBeNull();   // 门控独占
    expect(n).toBe(2);
  });

  it('OD-L ledger：空→record→dedup→read', () => {
    expect(readImportedCardLedger()).toEqual([]);
    recordImportedCard('card_1');
    recordImportedCard('card_2');
    recordImportedCard('card_1'); // 重复 → 去重
    expect(readImportedCardLedger()).toEqual(['card_1', 'card_2']);
    expect(localStorage.getItem(IMPORTED_CARDS_LEDGER_KEY)).toBe('["card_1","card_2"]');
  });

  it('OD-L ledger：损坏数据容错 → []', () => {
    localStorage.setItem(IMPORTED_CARDS_LEDGER_KEY, 'not json{');
    expect(readImportedCardLedger()).toEqual([]);
  });

  it('OD-L ledger：空 cardId 忽略', () => {
    recordImportedCard('');
    expect(readImportedCardLedger()).toEqual([]);
  });
});
