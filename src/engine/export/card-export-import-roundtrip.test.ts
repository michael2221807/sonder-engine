/**
 * Export → Import round-trip integration test — Story 6 P8.
 *
 * Uses the REAL GameCardExportService to produce a .aga-card blob, then the REAL
 * decodeAndValidateCard to decode it — proving the two halves agree byte-for-byte on the
 * envelope (format / formatVersion / checksum over JSON.stringify(bundle) / shape / packId)
 * with NO hand-built fixture. Also re-confirms SC-9 (no secrets survive) across the round-trip
 * and the OD-I version-drift signal on a real card.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get as _get } from 'lodash-es';
import { GameCardExportService } from './game-card-export-service';
import { decodeAndValidateCard } from './game-card-import-service';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import type { ExportOptions } from './game-card-bundle.types';
import type { GamePack } from '../types/game-pack';
import type { SaveManager } from '../persistence/save-manager';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { CustomPresetStore } from '../persistence/custom-preset-store';
import type { ImageAssetCache } from '../image/asset-cache';

const IMAGE_API_KEY = 'sk-IMAGE-LEAK-RT';
const PROVIDER_API_KEY = 'sk-API-LEAK-RT';
const GITHUB_TOKEN = 'ghp_GITHUBSECRET-RT';
const NPC_PRIVATE = '私密泄露文本RT';
const ALL_SECRETS = [IMAGE_API_KEY, PROVIDER_API_KEY, GITHUB_TOKEN, NPC_PRIVATE];

function makeTree(): Record<string, unknown> {
  return {
    元数据: {
      叙事历史: [{ round: 1 }],
      // Plot Threads fixture: 2 active threads (one focus) + 1 scheduled thread gated on the first.
      剧情导向: {
        activeArcIndex: 0,
        focusArcId: 'arc-a',
        pendingConfirmations: [{ arcId: 'arc-b', nodeId: 'b1', evidence: 'ev', round: 9 }],
        arcs: [
          { id: 'arc-a', title: 'A', synopsis: '', status: 'active', lane: 0, gauges: [],
            nodes: [{ id: 'a1', arcId: 'arc-a', title: 'a1', status: 'completed', activatedAtRound: 1, completedAtRound: 3,
              activatedAtTime: { year: 1, month: 1, day: 1 }, completionEvidence: 'done', premise: 'pre', stakes: 'stk', consecutiveReachedCount: 2 },
              { id: 'a2', arcId: 'arc-a', title: 'a2', status: 'active', activatedAtRound: 4, consecutiveReachedCount: 0 }] },
          { id: 'arc-b', title: 'B', synopsis: '', status: 'active', lane: 1, gauges: [],
            nodes: [{ id: 'b1', arcId: 'arc-b', title: 'b1', status: 'active', activatedAtRound: 2, consecutiveReachedCount: 1 }] },
          { id: 'arc-s', title: 'S', synopsis: '', status: 'scheduled', lane: 2, gauges: [],
            activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'arc-a', nodeId: 'a2' }] },
            nodes: [{ id: 's1', arcId: 'arc-s', title: 's1', status: 'pending', consecutiveReachedCount: 0 }] },
        ],
      },
    },
    角色: {
      基础信息: { 姓名: '萧寒' },
      属性: { 体质: 12, 悟性: 9 },
      可变属性: { 声望: 500, 体力: { 当前: 30, 上限: 100 }, 精力: { 当前: 20, 上限: 90 } },
      身体: { 私密: '正文身体描写' },
      图片档案: { 已选头像图片ID: 'sel-avatar', 生图历史: [{ id: 'player-hist' }] },
    },
    世界: { 描述: '烟雨江湖', 地点信息: { loc1: { 名称: '客栈' }, loc2: { 名称: '镖局' } } },
    社交: { 关系: [{ 名称: 'NPC1', 私密信息: NPC_PRIVATE, 图片档案: { 已选立绘图片ID: 'npc-portrait' } }] },
    系统: {
      设置: { prompt: { 游戏设定: 'world-setup' } },
      扩展: {
        engramMemory: {
          entities: [{ id: 'ent1', name: 'NPC1', type: 'npc', attributes: {}, firstSeen: 1, lastSeen: 2, mentionCount: 3, summary: 'NPC1 生平外貌', is_embedded: true }],
          v2Edges: [{ id: 'edge1', sourceEntity: '萧寒', targetEntity: 'NPC1', fact: '相识', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 2, core: true }],
        },
        image: { config: { transformer: { apiKey: IMAGE_API_KEY, endpoint: 'http://img-leak' } } },
      },
    },
  };
}

function makeExportService(tree: Record<string, unknown>) {
  const saveManager = { loadGame: async () => tree } as unknown as SaveManager;
  const configStore = { listOverlays: async () => [{ domainId: 'd', packId: 'tianming', patches: { foo: 1 }, version: 1, updatedAt: 0 }] } as unknown as ConfigStore;
  const promptStorage = { exportAll: async () => [{ key: 'sys.main', value: 'override' }] } as unknown as PromptStorage;
  const worldBookStorage = {
    exportWorldBooks: async () => ({ version: 1, exportedAt: 'x', books: [] }),
    exportBuiltinOverrides: async () => ({ version: 1, exportedAt: 'x', entries: [] }),
  } as unknown as WorldBookStorage;
  const customPresetStore = { load: async () => ({ packId: 'tianming', schemaVersion: 1, presets: { origins: [{ id: 'user_o1', source: 'user', createdAt: 1, generatedBy: 'manual', name: '寒门', genres: ['modern'], adultOnly: true, attribute_modifiers: { 直觉: 2 } }] }, meta: { lastUpdated: 0 } }) } as unknown as CustomPresetStore;
  const imageAssetCache = { exportByIds: async (ids: Set<string>) => [...ids].map((id) => ({ id, metadata: { id }, base64: `B64_${id}`, mimeType: 'image/png' })) } as unknown as ImageAssetCache;
  return new GameCardExportService(saveManager, configStore, promptStorage, worldBookStorage, customPresetStore, imageAssetCache);
}

const mockPack = {
  manifest: { id: 'tianming', version: '1.0.0' },
  stateSchema: {
    properties: {
      角色: {
        type: 'object',
        properties: {
          基础信息: { type: 'object', properties: { 姓名: { type: 'string', default: '' } } },
          属性: { type: 'object', properties: { 体质: { type: 'number', default: 5 }, 悟性: { type: 'number', default: 5 }, 身法: { type: 'number', default: 5 } } },
        },
      },
      世界: { type: 'object', properties: { 描述: { type: 'string', default: '' } } },
    },
  },
} as unknown as GamePack;

function makeOptions(over: Partial<ExportOptions> = {}): ExportOptions {
  return {
    protagonist: { mode: 'fixed' },
    cardMeta: {
      formatVersion: 0, cardId: 'rt-card', title: '往返卡', description: '一句简介', author: '作者',
      tags: ['武侠'], createdAt: '2026-06-04T00:00:00Z', updatedAt: '2026-06-04T00:00:00Z',
      packId: 'tianming', packVersion: '1.0.0',
    },
    selectedEdgeIds: new Set(['edge1']),
    checklist: {
      containsNsfw: false, includedGenerationHistory: false, includedReferenceGallery: false,
      includedSettings: true, includedApiTemplate: true, includedEngineConfig: true,
      includedWorldBooks: true, includedBuiltinOverrides: true, includedPromptSettings: true,
      includedHeroinePlan: false, includedPlotDirection: true,
    },
    ...over,
  };
}

let mock: ReturnType<typeof createMockLocalStorage>;
beforeEach(() => {
  mock = createMockLocalStorage({
    aga_api_management: JSON.stringify({ apiConfigs: [{ name: 'GPT', provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 2000, enabled: true, apiCategory: 'chat', apiKey: PROVIDER_API_KEY, url: 'http://leak', customRoutingPath: '/r' }] }),
    aga_github_sync_token: GITHUB_TOKEN,
    aga_user_settings: JSON.stringify({ theme: 'dark' }),
  });
  mock.install();
});
afterEach(() => mock.restore());

describe('export → import round-trip (real services)', () => {
  it('★真实导出的卡被真实导入解码：format/formatVersion/checksum/packId 全对齐', async () => {
    const svc = makeExportService(makeTree());
    const { blob, bundle } = await svc.exportCard('p', 's', makeOptions());
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true); // 若信封/校验和不对齐这里会是 false
    if (!decoded.ok) return;
    expect(decoded.bundle.cardMeta.packId).toBe('tianming');
    expect(decoded.bundle.cardMeta.title).toBe('往返卡');
    expect(decoded.bundle.cardMeta.formatVersion).toBe(bundle.cardMeta.formatVersion);
    expect(decoded.bundle.customPresets?.tianming?.origins?.[0]).toMatchObject({
      genres: ['modern'],
      adultOnly: true,
      attribute_modifiers: { 直觉: 2 },
    });
  });

  it('engram + 世界设定 往返保真，mergedTree 重建世界', async () => {
    const svc = makeExportService(makeTree());
    const { bundle } = await svc.exportCard('p', 's', makeOptions());
    const { blob } = await svc.exportCard('p', 's', makeOptions());
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // engram entities/edges survive the round-trip (is_embedded reset by export)
    expect(decoded.bundle.engram.entities).toHaveLength(bundle.engram.entities.length);
    expect(decoded.bundle.engram.knowledgeEdges).toHaveLength(1);
    expect(decoded.bundle.engram.entities[0].is_embedded).toBe(false); // export reset → import re-embeds
    // merged tree = schema default + card stateTree: world setup kept, missing leaf defaulted
    expect(_get(decoded.mergedTree, '角色.基础信息.姓名')).toBe('萧寒'); // kept
    expect(_get(decoded.mergedTree, '角色.属性.体质')).toBe(12);        // kept (not default 5)
    expect(_get(decoded.mergedTree, '角色.属性.身法')).toBe(5);          // schema default (absent in card)
    expect(_get(decoded.mergedTree, '世界.描述')).toBe('烟雨江湖');      // world setup kept
  });

  it('Plot Threads 往返：2 活跃线 + 1 排期线 → 进度全部归零、触发器与 id 原样保留', async () => {
    const svc = makeExportService(makeTree());
    const { blob } = await svc.exportCard('p', 's', makeOptions());
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const plot = _get(decoded.mergedTree, '元数据.剧情导向') as Record<string, unknown>;
    expect(plot.activeArcIndex).toBeNull();
    expect(plot.focusArcId).toBeNull();
    expect(plot.pendingConfirmations).toEqual([]);
    const arcs = plot.arcs as Array<Record<string, unknown>>;
    expect(arcs.map(a => a.id)).toEqual(['arc-a', 'arc-b', 'arc-s']);
    expect(arcs.map(a => a.status)).toEqual(['draft', 'draft', 'draft']);
    expect(arcs.map(a => a.lane)).toEqual([0, 1, 2]);
    const a1 = (arcs[0].nodes as Array<Record<string, unknown>>)[0];
    expect(a1.status).toBe('pending');
    expect(a1.activatedAtTime).toBeUndefined();
    expect(a1.completionEvidence).toBeUndefined();
    expect(a1.premise).toBe('pre');
    expect(a1.stakes).toBe('stk');
    // the scheduled thread's trigger still points at a surviving node id
    expect(arcs[2].activation).toEqual({ mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'arc-a', nodeId: 'a2' }] });
    expect((arcs[0].nodes as Array<Record<string, unknown>>).some(n => n.id === 'a2')).toBe(true);
  });

  it('★SC-9 往返：真实导出→导入后的 bundle JSON 不含任何密钥/私密', async () => {
    const svc = makeExportService(makeTree());
    const { blob } = await svc.exportCard('p', 's', makeOptions());
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const json = JSON.stringify(decoded.bundle);
    for (const secret of ALL_SECRETS) {
      expect(json.includes(secret)).toBe(false); // 零泄露穿透往返
    }
  });

  it('OD-I 版本漂移：卡版本 > 装机版 → 解码出 comparison=1', async () => {
    const svc = makeExportService(makeTree());
    const meta = { ...makeOptions().cardMeta, packVersion: '2.0.0' };
    const { blob } = await svc.exportCard('p', 's', makeOptions({ cardMeta: meta }));
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.packVersionDrift?.comparison).toBe(1);
  });

  it('整数键 map 世界字段往返保真（V8 键序两端一致，不报 checksum-mismatch）', async () => {
    const tree = makeTree();
    // 世界.地点信息 用整数字符串键
    (tree.世界 as Record<string, unknown>).地点信息 = { '2': { 名称: 'b' }, '0': { 名称: 'a' }, '10': { 名称: 'c' } };
    const svc = makeExportService(tree);
    const { blob } = await svc.exportCard('p', 's', makeOptions());
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true); // 若键序往返不一致 → checksum-mismatch
  });
});
