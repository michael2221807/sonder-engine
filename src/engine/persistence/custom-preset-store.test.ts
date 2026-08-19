/**
 * CustomPresetStore 单元测试
 *
 * 通过 vi.mock 替换 idb-adapter 为内存 Map，覆盖 store 的全部表面：
 * load/save/get/add/update/remove/replaceAll/clear/listPackIds + ID 工具
 *
 * 对应 docs/status/research-custom-creation-presets-2026-04-14.md Phase 1 验收清单。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 内存模拟 IDB —— 必须在 import store 之前 mock
const memStore = new Map<string, unknown>();
vi.mock('./idb-adapter', () => ({
  idbAdapter: {
    async get<T>(key: string): Promise<T | undefined> {
      return memStore.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      // 模拟真实 idbAdapter 的 structuredClone 行为，避免测试间数据污染
      memStore.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      memStore.delete(key);
    },
    async keys(): Promise<string[]> {
      return Array.from(memStore.keys());
    },
    async clear(): Promise<void> {
      memStore.clear();
    },
  },
}));

import {
  CustomPresetStore,
  generateUserPresetId,
  isUserPresetId,
  type CustomPresetEntry,
} from './custom-preset-store';

beforeEach(() => {
  memStore.clear();
});

// ─── ID 工具 ──────────────────────────────────────────────────

describe('generateUserPresetId / isUserPresetId', () => {
  it('generates id with user_ prefix', () => {
    const id = generateUserPresetId();
    expect(id.startsWith('user_')).toBe(true);
  });

  it('id matches user_{base36-ts}_{6-char-rand} format', () => {
    const id = generateUserPresetId();
    expect(id).toMatch(/^user_[a-z0-9]+_[a-z0-9]{6}$/);
  });

  it('two ids in tight loop are unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateUserPresetId()));
    expect(ids.size).toBe(100);
  });

  it('isUserPresetId true for user_xxx', () => {
    expect(isUserPresetId('user_abc')).toBe(true);
  });

  it('isUserPresetId false for pack-style ids', () => {
    expect(isUserPresetId('world_qingcheng')).toBe(false);
    expect(isUserPresetId('1')).toBe(false);
    expect(isUserPresetId(123)).toBe(false);
    expect(isUserPresetId(undefined)).toBe(false);
  });
});

// ─── load / save 基础 ────────────────────────────────────────

describe('load (empty cases)', () => {
  it('returns empty structure for unknown packId', async () => {
    const s = new CustomPresetStore();
    const data = await s.load('nonexistent-pack');
    expect(data.packId).toBe('nonexistent-pack');
    expect(data.presets).toEqual({});
    expect(data.schemaVersion).toBe(1);
  });

  it('returns empty for blank packId without throwing', async () => {
    const s = new CustomPresetStore();
    const data = await s.load('');
    expect(data.presets).toEqual({});
  });
});

describe('save / load round-trip', () => {
  it('preserves creation genre and adult metadata without a schema migration', async () => {
    const s = new CustomPresetStore();
    const created = await s.add('tianming', 'origins', {
      name: '夜班信使',
      genres: ['modern'],
      adultOnly: true,
      attribute_modifiers: { 直觉: 2 },
    });
    const loaded = await s.get('tianming', 'origins');
    expect(loaded[0]).toMatchObject({
      id: created.id,
      genres: ['modern'],
      adultOnly: true,
      attribute_modifiers: { 直觉: 2 },
    });
    expect((await s.load('tianming')).schemaVersion).toBe(1);
  });

  it('persists data and reloads', async () => {
    const s = new CustomPresetStore();
    await s.save({
      packId: 'tianming',
      schemaVersion: 1,
      presets: {
        worlds: [
          {
            id: 'user_x_1',
            source: 'user',
            createdAt: 1,
            generatedBy: 'manual',
            name: '测试世界',
          },
        ],
      },
      meta: { lastUpdated: 0 },
    });
    const data = await s.load('tianming');
    expect(data.presets.worlds).toHaveLength(1);
    expect(data.presets.worlds[0].name).toBe('测试世界');
    // save 强制更新 lastUpdated 时间戳
    expect(data.meta.lastUpdated).toBeGreaterThan(0);
  });

  it('save throws on missing packId', async () => {
    const s = new CustomPresetStore();
    await expect(
      s.save({ packId: '', schemaVersion: 1, presets: {}, meta: { lastUpdated: 0 } }),
    ).rejects.toThrow();
  });
});

// ─── add ───────────────────────────────────────────────────

describe('add', () => {
  it('creates entry with user_ id, source=user, generatedBy=manual by default', async () => {
    const s = new CustomPresetStore();
    const e = await s.add('tianming', 'worlds', { name: '测试世界' });
    expect(e.id.startsWith('user_')).toBe(true);
    expect(e.source).toBe('user');
    expect(e.generatedBy).toBe('manual');
    expect(e.createdAt).toBeGreaterThan(0);
    expect(e.name).toBe('测试世界');
  });

  it('records generatedBy=ai when specified', async () => {
    const s = new CustomPresetStore();
    const e = await s.add('tianming', 'worlds', { name: 'AI 世界' }, 'ai');
    expect(e.generatedBy).toBe('ai');
  });

  it('appends to FRONT of list (unshift)', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: '第一加' });
    await s.add('tianming', 'worlds', { name: '第二加' });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].name).toBe('第二加');
    expect(list[1].name).toBe('第一加');
  });

  it('different preset types are isolated', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'W1' });
    await s.add('tianming', 'origins', { name: 'O1' });
    expect(await s.get('tianming', 'worlds')).toHaveLength(1);
    expect(await s.get('tianming', 'origins')).toHaveLength(1);
    expect(await s.get('tianming', 'talents')).toHaveLength(0);
  });

  it('different packIds are isolated', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'T-World' });
    await s.add('wasteland', 'worlds', { name: 'W-World' });
    const t = await s.get('tianming', 'worlds');
    const w = await s.get('wasteland', 'worlds');
    expect(t).toHaveLength(1);
    expect(w).toHaveLength(1);
    expect(t[0].name).toBe('T-World');
    expect(w[0].name).toBe('W-World');
  });
});

// ─── update ────────────────────────────────────────────────

describe('update', () => {
  it('patches existing entry and preserves protected fields', async () => {
    const s = new CustomPresetStore();
    const created = await s.add('tianming', 'worlds', { name: 'orig', desc: 'd1' });
    const ok = await s.update('tianming', 'worlds', created.id, {
      desc: 'updated',
      // 试图覆盖保护字段：必须被忽略
      id: 'malicious_id',
      source: 'pack',
      createdAt: 0,
    });
    expect(ok).toBe(true);
    const list = await s.get('tianming', 'worlds');
    expect(list[0].desc).toBe('updated');
    expect(list[0].id).toBe(created.id); // 未被覆盖
    expect(list[0].source).toBe('user'); // 未被覆盖
    expect(list[0].createdAt).toBe(created.createdAt); // 未被覆盖
  });

  it('adds optional creation metadata to a legacy entry without a store schema bump', async () => {
    const s = new CustomPresetStore();
    const created = await s.add('tianming', 'origins', { name: 'Legacy origin' });

    expect(await s.update('tianming', 'origins', created.id, {
      genres: ['fantasy'], adultOnly: true, talent_cost: 6,
    })).toBe(true);

    expect((await s.get('tianming', 'origins'))[0]).toMatchObject({
      name: 'Legacy origin', genres: ['fantasy'], adultOnly: true, talent_cost: 6,
    });
    expect((await s.load('tianming')).schemaVersion).toBe(1);
  });

  it('returns false for non-user id', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'x' });
    const ok = await s.update('tianming', 'worlds', 'pack_world_1', { name: 'y' });
    expect(ok).toBe(false);
  });

  it('returns false when entry not found', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'x' });
    const ok = await s.update('tianming', 'worlds', 'user_nonexistent_xxx', { name: 'y' });
    expect(ok).toBe(false);
  });

  it('returns false when preset type has no entries', async () => {
    const s = new CustomPresetStore();
    const ok = await s.update('tianming', 'worlds', 'user_a_b', { name: 'y' });
    expect(ok).toBe(false);
  });
});

// ─── remove ────────────────────────────────────────────────

describe('remove', () => {
  it('deletes existing user entry', async () => {
    const s = new CustomPresetStore();
    const created = await s.add('tianming', 'worlds', { name: 'gone' });
    const ok = await s.remove('tianming', 'worlds', created.id);
    expect(ok).toBe(true);
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
  });

  it('returns false for non-user id (cannot delete pack entries)', async () => {
    const s = new CustomPresetStore();
    const ok = await s.remove('tianming', 'worlds', 'pack_world_1');
    expect(ok).toBe(false);
  });

  it('returns false when entry not found', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'x' });
    const ok = await s.remove('tianming', 'worlds', 'user_zzz_zzz');
    expect(ok).toBe(false);
  });

  it('does not affect other preset types', async () => {
    const s = new CustomPresetStore();
    const w = await s.add('tianming', 'worlds', { name: 'w' });
    await s.add('tianming', 'origins', { name: 'o' });
    await s.remove('tianming', 'worlds', w.id);
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
    expect(await s.get('tianming', 'origins')).toHaveLength(1);
  });
});

// ─── replaceAll ────────────────────────────────────────────

describe('replaceAll', () => {
  it('overwrites all preset types for pack', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'old1' });
    await s.add('tianming', 'origins', { name: 'old2' });
    await s.replaceAll('tianming', {
      worlds: [
        {
          id: 'user_new_1',
          source: 'user',
          createdAt: 100,
          generatedBy: 'manual',
          name: 'new world',
        },
      ],
      // origins 不在新数据里 → 应被清空
    });
    const w = await s.get('tianming', 'worlds');
    const o = await s.get('tianming', 'origins');
    expect(w).toHaveLength(1);
    expect(w[0].name).toBe('new world');
    expect(o).toHaveLength(0);
  });

  it('normalizes entries with missing id / wrong source', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        // 缺 id，source 错的，无 createdAt
        {
          source: 'pack' as never,
          name: '导入的',
        } as unknown as CustomPresetEntry,
        // id 缺前缀
        {
          id: 'foreign_id',
          source: 'user',
          createdAt: 200,
          generatedBy: 'manual',
          name: '另一个',
        } as CustomPresetEntry,
      ],
    });
    const w = await s.get('tianming', 'worlds');
    expect(w).toHaveLength(2);
    // 全部强制 source=user
    expect(w.every((e) => e.source === 'user')).toBe(true);
    // 全部 id 带 user_ 前缀
    expect(w.every((e) => e.id.startsWith('user_'))).toBe(true);
    // 已有合法 createdAt 的保留
    expect(w[1].createdAt).toBe(200);
    // 缺 createdAt 的补当前时间
    expect(w[0].createdAt).toBeGreaterThan(0);
  });

  it('skips non-array values in input', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        { id: 'user_a_b', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'ok' },
      ],
      origins: 'not an array' as unknown as CustomPresetEntry[],
    });
    const w = await s.get('tianming', 'worlds');
    const o = await s.get('tianming', 'origins');
    expect(w).toHaveLength(1);
    expect(o).toHaveLength(0);
  });
});

// ─── clear / listPackIds ────────────────────────────────────

describe('clear', () => {
  it('removes all user data for pack', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'x' });
    await s.add('tianming', 'origins', { name: 'y' });
    await s.clear('tianming');
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
    expect(await s.get('tianming', 'origins')).toHaveLength(0);
  });

  it('does not affect other packs', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 't' });
    await s.add('wasteland', 'worlds', { name: 'w' });
    await s.clear('tianming');
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
    expect(await s.get('wasteland', 'worlds')).toHaveLength(1);
  });

  it('clear with empty packId is no-op', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'x' });
    await s.clear('');
    expect(await s.get('tianming', 'worlds')).toHaveLength(1);
  });
});

describe('listPackIds', () => {
  it('lists all packs that have user data', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 't' });
    await s.add('wasteland', 'worlds', { name: 'w' });
    await s.add('cyberpunk', 'origins', { name: 'c' });
    const ids = (await s.listPackIds()).sort();
    expect(ids).toEqual(['cyberpunk', 'tianming', 'wasteland']);
  });

  it('returns empty array when no packs', async () => {
    const s = new CustomPresetStore();
    expect(await s.listPackIds()).toEqual([]);
  });

  it('does not include packs after clear', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 't' });
    await s.clear('tianming');
    expect(await s.listPackIds()).toEqual([]);
  });
});

// ─── CR-2026-04-14 边界用例补充 ──────────────────────────────
//
// 来源：docs/status/cr-custom-presets-2026-04-14.md
// 目的：锁定当前行为，作为修复时的回归基线。修 P1-5 / P2-5 后
// 标 "已知缺陷的回归测试" 的用例需更新。

describe('CR-2026-04-14 P1-5：replaceAll 按 id 去重', () => {
  it('同 id 重复条目只保留首次出现的（修复后行为）', async () => {
    const s = new CustomPresetStore();
    const dupId = 'user_zzz_dup001';
    await s.replaceAll('tianming', {
      worlds: [
        { id: dupId, source: 'user', createdAt: 100, generatedBy: 'manual', name: 'first' },
        { id: dupId, source: 'user', createdAt: 200, generatedBy: 'manual', name: 'second' },
      ] as CustomPresetEntry[],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('first');
  });

  it('replaceAll 接受空数组（清空某 type 而保留其他 type）', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'w' });
    await s.add('tianming', 'origins', { name: 'o' });
    await s.replaceAll('tianming', { worlds: [] });
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
    // origins 在 replaceAll 中未提及 —— 整个 presets 被覆盖，origins 也丢了
    expect(await s.get('tianming', 'origins')).toHaveLength(0);
  });

  it('replaceAll 跳过非数组 value（防御性）', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [{ id: 'user_a', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'A' }] as CustomPresetEntry[],
      // @ts-expect-error 故意传非数组测防御性
      origins: 'not an array',
      // @ts-expect-error 故意传 null
      talents: null,
    });
    expect(await s.get('tianming', 'worlds')).toHaveLength(1);
    expect(await s.get('tianming', 'origins')).toHaveLength(0);
    expect(await s.get('tianming', 'talents')).toHaveLength(0);
  });
});

describe('CR-2026-04-14 边界：normalizeEntry 极端输入', () => {
  it('id 缺失 → 自动补 user_ 前缀新 id', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        // @ts-expect-error 故意省 id
        { source: 'user', createdAt: 1, generatedBy: 'manual', name: 'no-id' },
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(1);
    expect(list[0].id).toMatch(/^user_/);
  });

  it('id 不带 user_ 前缀 → 重新生成', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        { id: 'world_qingcheng_legacy', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'X' } as CustomPresetEntry,
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].id).not.toBe('world_qingcheng_legacy');
    expect(list[0].id.startsWith('user_')).toBe(true);
  });

  it('createdAt 为 NaN/字符串 → 补当前时间', async () => {
    const s = new CustomPresetStore();
    const before = Date.now();
    await s.replaceAll('tianming', {
      worlds: [
        // @ts-expect-error 故意传字符串
        { id: 'user_a', source: 'user', createdAt: 'not-a-number', generatedBy: 'manual', name: 'X' },
        { id: 'user_b', source: 'user', createdAt: NaN, generatedBy: 'manual', name: 'Y' } as CustomPresetEntry,
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(list[1].createdAt).toBeGreaterThanOrEqual(before);
  });

  it('source 字段不论传什么都强制为 "user"', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        // @ts-expect-error 故意传 'pack'
        { id: 'user_a', source: 'pack', createdAt: 1, generatedBy: 'manual', name: 'X' },
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].source).toBe('user');
  });

  it('generatedBy 异常值（非 ai/manual）→ 默认 manual', async () => {
    const s = new CustomPresetStore();
    await s.replaceAll('tianming', {
      worlds: [
        // @ts-expect-error 故意传非法
        { id: 'user_a', source: 'user', createdAt: 1, generatedBy: 'random', name: 'X' },
        // @ts-expect-error
        { id: 'user_b', source: 'user', createdAt: 1, generatedBy: undefined, name: 'Y' },
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].generatedBy).toBe('manual');
    expect(list[1].generatedBy).toBe('manual');
  });
});

describe('CR-2026-04-14 边界：update 保护字段（P2-5 相关）', () => {
  it('id 不可被 patch 覆盖（已保护）', async () => {
    const s = new CustomPresetStore();
    const entry = await s.add('tianming', 'worlds', { name: 'X' });
    await s.update('tianming', 'worlds', entry.id, { id: 'user_hijack', name: 'Y' });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].id).toBe(entry.id);
    expect(list[0].name).toBe('Y');
  });

  it('source 不可被 patch 覆盖（已保护）', async () => {
    const s = new CustomPresetStore();
    const entry = await s.add('tianming', 'worlds', { name: 'X' });
    await s.update('tianming', 'worlds', entry.id, { source: 'pack' as 'user' });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].source).toBe('user');
  });

  it('createdAt 不可被 patch 覆盖（已保护）', async () => {
    const s = new CustomPresetStore();
    const entry = await s.add('tianming', 'worlds', { name: 'X' });
    const original = entry.createdAt;
    await s.update('tianming', 'worlds', entry.id, { createdAt: 0 });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].createdAt).toBe(original);
  });

  it('generatedBy 不可被 patch 覆盖（CR P2-5 修复后）', async () => {
    const s = new CustomPresetStore();
    const entry = await s.add('tianming', 'worlds', { name: 'X' }, 'ai');
    expect(entry.generatedBy).toBe('ai');
    await s.update('tianming', 'worlds', entry.id, { generatedBy: 'manual' });
    const list = await s.get('tianming', 'worlds');
    expect(list[0].generatedBy).toBe('ai'); // 保护后保持原值
  });
});

// ─── CR-2026-04-14 P0-1：write mutex 并发测试 ────────────

describe('CR-2026-04-14 P0-1：写操作互斥锁', () => {
  it('Promise.all([add, add, add]) 全部条目都被持久化（无丢失）', async () => {
    const s = new CustomPresetStore();
    await Promise.all([
      s.add('tianming', 'worlds', { name: 'A' }),
      s.add('tianming', 'worlds', { name: 'B' }),
      s.add('tianming', 'worlds', { name: 'C' }),
    ]);
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(3);
    const names = list.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });

  it('并发 add + remove 不会串改顺序（remove 只能删已存在条目）', async () => {
    const s = new CustomPresetStore();
    const a = await s.add('tianming', 'worlds', { name: 'A' });
    // 同时再 add 一个 + remove 第一个
    await Promise.all([
      s.add('tianming', 'worlds', { name: 'B' }),
      s.remove('tianming', 'worlds', a.id),
    ]);
    const list = await s.get('tianming', 'worlds');
    // 必有 B；A 必被删（mutex 保证 remove 看到的快照已含 add 之前的状态）
    expect(list.find((e) => e.name === 'B')).toBeDefined();
    expect(list.find((e) => e.id === a.id)).toBeUndefined();
  });
});

// ─── CR-2026-04-14 P2-1：bulkAppend ──────────────────────

describe('CR-2026-04-14 P2-1：bulkAppend 批量追加', () => {
  it('单次调用追加多个 type 多条 entry，全部分配新 user_ id', async () => {
    const s = new CustomPresetStore();
    await s.add('tianming', 'worlds', { name: 'existing' });
    const added = await s.bulkAppend('tianming', {
      worlds: [{ name: 'W1' }, { name: 'W2' }],
      origins: [{ name: 'O1' }],
    });
    expect(added).toHaveLength(3);
    added.forEach((e) => {
      expect(e.id.startsWith('user_')).toBe(true);
      expect(e.source).toBe('user');
    });
    const worlds = await s.get('tianming', 'worlds');
    expect(worlds).toHaveLength(3); // existing + W1 + W2
    const origins = await s.get('tianming', 'origins');
    expect(origins).toHaveLength(1);
  });

  it('入参 id 被忽略，避免与既有数据冲突', async () => {
    const s = new CustomPresetStore();
    const existing = await s.add('tianming', 'worlds', { name: 'A' });
    const added = await s.bulkAppend('tianming', {
      worlds: [{ id: existing.id, name: 'B' }], // 试图复用既有 id
    });
    expect(added[0].id).not.toBe(existing.id);
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(2);
  });

  it('generatedBy="ai" 被保留，其他值视为 manual', async () => {
    const s = new CustomPresetStore();
    const added = await s.bulkAppend('tianming', {
      worlds: [
        { name: 'X', generatedBy: 'ai' },
        { name: 'Y', generatedBy: 'random_value' },
        { name: 'Z' },
      ],
    });
    expect(added[0].generatedBy).toBe('ai');
    expect(added[1].generatedBy).toBe('manual');
    expect(added[2].generatedBy).toBe('manual');
  });

  it('空入参时返回空数组且不写 IDB', async () => {
    const s = new CustomPresetStore();
    const before = await s.load('tianming');
    const beforeUpdated = before.meta.lastUpdated;
    const added = await s.bulkAppend('tianming', { worlds: [] });
    expect(added).toEqual([]);
    const after = await s.load('tianming');
    expect(after.meta.lastUpdated).toBe(beforeUpdated); // 未触发写入
  });

  it('跳过 null/非对象条目', async () => {
    const s = new CustomPresetStore();
    const added = await s.bulkAppend('tianming', {
      worlds: [
        { name: 'good' },
        // @ts-expect-error
        null,
        // @ts-expect-error
        'not an object',
        { name: 'also good' },
      ],
    });
    expect(added).toHaveLength(2);
  });
});

// ─── Story 6 P1：appendPreservingIds（卡导入 OD-J 保 id 原语） ──────

describe('Story 6 P1：appendPreservingIds 保 id append-if-absent', () => {
  it('保留入参的 id 原样（不重生）—— 卡 角色 引用靠它解析', async () => {
    const s = new CustomPresetStore();
    const cardId = 'user_card_origin_42';
    const added = await s.appendPreservingIds('tianming', {
      origins: [
        { id: cardId, source: 'user', createdAt: 111, generatedBy: 'manual', name: '寒门子弟' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(cardId); // ★ 与 bulkAppend 的关键区别：不重生 id
    const list = await s.get('tianming', 'origins');
    expect(list[0].id).toBe(cardId);
    expect(list[0].name).toBe('寒门子弟');
  });

  it('不抹玩家既有预设（append 到既有列表，与 replaceAll 区别）', async () => {
    const s = new CustomPresetStore();
    const mine = await s.add('tianming', 'worlds', { name: '我的世界' });
    await s.appendPreservingIds('tianming', {
      worlds: [
        { id: 'user_card_w1', source: 'user', createdAt: 1, generatedBy: 'manual', name: '卡世界' },
      ],
    });
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.id === mine.id)).toBeDefined(); // 玩家的还在
    expect(list.find((e) => e.id === 'user_card_w1')).toBeDefined(); // 卡的也在
  });

  it('append-if-absent：玩家已有同 id → 跳过（不产生重复）', async () => {
    const s = new CustomPresetStore();
    const shared = 'user_shared_id_1';
    await s.appendPreservingIds('tianming', {
      worlds: [{ id: shared, source: 'user', createdAt: 1, generatedBy: 'manual', name: '首次' }],
    });
    const added2 = await s.appendPreservingIds('tianming', {
      worlds: [{ id: shared, source: 'user', createdAt: 2, generatedBy: 'manual', name: '二次（应跳过）' }],
    });
    expect(added2).toHaveLength(0); // 已存在 → 不追加
    const list = await s.get('tianming', 'worlds');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('首次'); // 保留既有，不被覆盖
  });

  it('幂等：重复导入同一张卡不产生重复条目', async () => {
    const s = new CustomPresetStore();
    const card = {
      origins: [{ id: 'user_c_o1', source: 'user' as const, createdAt: 1, generatedBy: 'manual' as const, name: 'O' }],
      talents: [{ id: 'user_c_t1', source: 'user' as const, createdAt: 1, generatedBy: 'manual' as const, name: 'T' }],
    };
    await s.appendPreservingIds('tianming', card);
    await s.appendPreservingIds('tianming', card); // 再导入一次
    expect(await s.get('tianming', 'origins')).toHaveLength(1);
    expect(await s.get('tianming', 'talents')).toHaveLength(1);
  });

  it('卡自身列表内同 id 重复 → 保留首次出现', async () => {
    const s = new CustomPresetStore();
    const dup = 'user_dup_x';
    const added = await s.appendPreservingIds('tianming', {
      worlds: [
        { id: dup, source: 'user', createdAt: 1, generatedBy: 'manual', name: 'first' },
        { id: dup, source: 'user', createdAt: 2, generatedBy: 'manual', name: 'second' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('first');
  });

  it('缺 id 的脏条目被跳过（无 id 无法保 id 语义）', async () => {
    const s = new CustomPresetStore();
    const added = await s.appendPreservingIds('tianming', {
      worlds: [
        // @ts-expect-error 故意省 id
        { source: 'user', createdAt: 1, generatedBy: 'manual', name: 'no-id' },
        { id: 'user_ok', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'ok' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe('user_ok');
  });

  it('规范化 source/createdAt/generatedBy 但保留 id', async () => {
    const s = new CustomPresetStore();
    const before = Date.now();
    const added = await s.appendPreservingIds('tianming', {
      worlds: [
        // source 错、缺 createdAt、generatedBy 非法 —— 但 id 必须保留
        { id: 'user_keepme', source: 'pack' as never, generatedBy: 'weird' as never, name: 'X' } as unknown as CustomPresetEntry,
      ],
    });
    expect(added[0].id).toBe('user_keepme'); // id 保留
    expect(added[0].source).toBe('user'); // 强制 user
    expect(added[0].generatedBy).toBe('manual'); // 非法 → manual
    expect(added[0].createdAt).toBeGreaterThanOrEqual(before); // 缺 → 补当前时间
  });

  it('空入参/全跳过时不写 IDB', async () => {
    const s = new CustomPresetStore();
    const before = await s.load('tianming');
    const added = await s.appendPreservingIds('tianming', { worlds: [] });
    expect(added).toEqual([]);
    const after = await s.load('tianming');
    expect(after.meta.lastUpdated).toBe(before.meta.lastUpdated); // 未触发写入
  });

  it('不同 preset type 隔离追加', async () => {
    const s = new CustomPresetStore();
    await s.appendPreservingIds('tianming', {
      origins: [{ id: 'user_o', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'O' }],
      talents: [{ id: 'user_t', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'T' }],
    });
    expect(await s.get('tianming', 'origins')).toHaveLength(1);
    expect(await s.get('tianming', 'talents')).toHaveLength(1);
    expect(await s.get('tianming', 'worlds')).toHaveLength(0);
  });
});
