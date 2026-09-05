/**
 * Story 7 存档转卡 集成测试 — P7。
 *
 * 模拟一个「已玩 50 回合」的存档（叙事历史、三级记忆、状态效果、NPC 私聊、心跳历史、
 * 行动选项、图片任务队列、混合来源知识边、注入密钥与私密文本），用 REAL
 * GameCardExportService 走 Story 7 路径（分类后的 selectedEdgeIds 子集 +
 * markSelectedEdgesCore），再用 REAL decodeAndValidateCard 解码：
 *
 *  1. SC-4/G12 — roundtrip 全过 + 边恰为勾选集且全 core:true + 游玩产物残留扫描
 *  2. SC-6     — 转卡纯只读：源存档字节级不变 + saveGame 零调用
 *  3. SC-9/F2  — NSFW off：已勾选但命中私密文本的边被二次擦除剔除；密钥零泄漏
 *  4. U19      — 实体全量进卡（即使其引用边被剔除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const IMAGE_API_KEY = 'sk-IMAGE-LEAK-S7';
const PROVIDER_API_KEY = 'sk-API-LEAK-S7';
const GITHUB_TOKEN = 'ghp_GITHUBSECRET-S7';
const NPC_PRIVATE = '私密泄露文本S7';
const ALL_SECRETS = [IMAGE_API_KEY, PROVIDER_API_KEY, GITHUB_TOKEN];

/** A save that has clearly been PLAYED: 50 rounds of residue everywhere. */
function makePlayedTree(): Record<string, unknown> {
  return {
    元数据: {
      回合序号: 50,
      叙事历史: Array.from({ length: 50 }, (_, i) => ({ round: i + 1, text: `第${i + 1}回合正文` })),
      推理历史: [{ round: 50, cot: '推理痕迹' }],
      当前行动选项: ['选项A', '选项B'],
    },
    记忆: {
      短期: ['短期记忆残留'],
      中期: ['中期记忆残留'],
      长期: ['长期记忆残留'],
      隐式中期: ['隐式残留'],
    },
    角色: {
      基础信息: { 姓名: '萧寒' },
      属性: { 体质: 12, 悟性: 9 },
      可变属性: { 声望: 800, 体力: { 当前: 10, 上限: 100 }, 精力: { 当前: 5, 上限: 90 } },
      效果: [{ 名称: '重伤', 持续: 3 }],
      身体: { 私密: '正文身体描写' },
      图片档案: { 已选头像图片ID: 'sel-avatar', 生图历史: [{ id: 'player-hist' }] },
    },
    世界: {
      描述: '烟雨江湖',
      地点信息: { loc1: { 名称: '客栈' }, loc2: { 名称: '镖局' } },
      状态: { 心跳: { 历史: [{ round: 40 }], 上次心跳回合序号: 40, 上次执行时间: 123 } },
    },
    社交: {
      关系: [{
        名称: 'NPC1',
        私密信息: NPC_PRIVATE,
        记忆: ['NPC 记忆残留'],
        私聊历史: [{ role: 'user', text: '私聊残留' }],
        图片档案: { 已选立绘图片ID: 'npc-portrait' },
      }],
      事件: { 事件记录: [{ round: 12, text: '世界事件残留' }] },
    },
    系统: {
      actionOptions: { cached: true },
      设置: { prompt: { 游戏设定: 'world-setup' }, theme: 'dark' },
      扩展: {
        engramMemory: {
          entities: [
            { name: '萧寒', type: 'player', attributes: {}, firstSeen: 1, lastSeen: 50, mentionCount: 50, summary: '主角', is_embedded: true },
            { name: 'NPC1', type: 'npc', attributes: {}, firstSeen: 1, lastSeen: 50, mentionCount: 30, summary: 'NPC1 生平外貌', is_embedded: true },
            { name: '客栈', type: 'location', attributes: {}, firstSeen: 1, lastSeen: 50, mentionCount: 9, summary: '', is_embedded: true },
            { name: '剧情人物甲', type: 'npc', attributes: {}, firstSeen: 30, lastSeen: 31, mentionCount: 1, summary: '只被剧情边引用', is_embedded: true },
          ],
          v2Edges: [
            // 开局边：天然 core:true + source 'opening'（U5 跳过 AI 直接预勾）
            { id: 'edge-core-opening', sourceEntity: 'NPC1', targetEntity: '客栈', fact: 'NPC1 常驻客栈', episodes: [], is_embedded: true, createdAtRound: 0, lastSeenRound: 50, core: true, source: 'opening' },
            // 游玩产生但语义是世界观（AI 分类为 worldview → 勾选）
            { id: 'edge-world-ai', sourceEntity: '萧寒', targetEntity: 'NPC1', fact: '萧寒与 NPC1 结为金兰', episodes: ['e1'], is_embedded: true, createdAtRound: 20, lastSeenRound: 50 },
            // 剧情事件（AI 分类为 plot-event → 不勾，留在原存档不进卡）
            { id: 'edge-plot-ai', sourceEntity: '萧寒', targetEntity: '剧情人物甲', fact: '萧寒上月与剧情人物甲在镖局发生冲突', episodes: ['e2'], is_embedded: true, createdAtRound: 30, lastSeenRound: 31 },
            // 用户手动边（worldview → 勾选）
            { id: 'edge-user', sourceEntity: 'NPC1', targetEntity: '镖局', fact: 'NPC1 兼任镖局供奉', episodes: [], is_embedded: false, createdAtRound: 10, lastSeenRound: 10, source: 'user' },
            // 命中私密文本的边（用户勾了，但 NSFW off 时导出端二次擦除会剔除 — F2 的前提）
            { id: 'edge-nsfw', sourceEntity: '萧寒', targetEntity: 'NPC1', fact: `这条边提到${NPC_PRIVATE}`, episodes: [], is_embedded: true, createdAtRound: 44, lastSeenRound: 44 },
          ],
        },
        image: {
          config: { transformer: { apiKey: IMAGE_API_KEY, endpoint: 'http://img-leak' } },
          tasks: [{ prompt: 'queued task 残留' }],
        },
      },
    },
  };
}

/** SaveManager 测试替身：模拟真实 IDB 行为（loadGame 返回深拷贝），并监视写入。 */
function makeCloningSaveManager(stored: Record<string, unknown>) {
  const loadGame = vi.fn(async () => structuredClone(stored));
  const saveGame = vi.fn(async () => {});
  return { manager: { loadGame, saveGame } as unknown as SaveManager, loadGame, saveGame };
}

function makeService(saveManager: SaveManager) {
  const configStore = { listOverlays: async () => [] } as unknown as ConfigStore;
  const promptStorage = { exportAll: async () => [] } as unknown as PromptStorage;
  const worldBookStorage = {
    exportWorldBooks: async () => ({ version: 1, exportedAt: 'x', books: [] }),
    exportBuiltinOverrides: async () => ({ version: 1, exportedAt: 'x', entries: [] }),
  } as unknown as WorldBookStorage;
  const customPresetStore = { load: async () => null } as unknown as CustomPresetStore;
  const imageAssetCache = {
    exportByIds: async (ids: Set<string>) => [...ids].map((id) => ({ id, metadata: { id }, base64: `B64_${id}`, mimeType: 'image/png' })),
  } as unknown as ImageAssetCache;
  return new GameCardExportService(saveManager, configStore, promptStorage, worldBookStorage, customPresetStore, imageAssetCache);
}

const mockPack = {
  manifest: { id: 'tianming', version: '1.0.0' },
  stateSchema: {
    properties: {
      元数据: { type: 'object', properties: { 回合序号: { type: 'number', default: 0 } } },
      角色: { type: 'object', properties: { 基础信息: { type: 'object', properties: { 姓名: { type: 'string', default: '' } } } } },
      世界: { type: 'object', properties: { 描述: { type: 'string', default: '' } } },
    },
  },
} as unknown as GamePack;

/** Story 7 路径的 options：分类确认后的勾选集 + 全量 core 盖章。 */
const CONFIRMED_IDS = ['edge-core-opening', 'edge-world-ai', 'edge-user', 'edge-nsfw'];
function makeStory7Options(over: Partial<ExportOptions> = {}): ExportOptions {
  return {
    protagonist: { mode: 'fixed' },
    cardMeta: {
      formatVersion: 0, cardId: 's7-card', title: '五十回合转卡', description: '', author: '玩家',
      tags: [], createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z',
      packId: 'tianming', packVersion: '1.0.0',
    },
    selectedEdgeIds: new Set(CONFIRMED_IDS),
    markSelectedEdgesCore: true,
    checklist: {
      containsNsfw: false, includedGenerationHistory: false, includedReferenceGallery: false,
      includedSettings: false, includedApiTemplate: false, includedEngineConfig: false,
      includedWorldBooks: false, includedBuiltinOverrides: false, includedPromptSettings: false,
      includedHeroinePlan: false, includedPlotDirection: true, includedNarrativeContract: true,
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

describe('Story 7 存档转卡（real export → real import decode）', () => {
  it('★SC-4/G12 — 50 回合存档转出的卡 roundtrip 全过；边恰为勾选集且全 core:true；游玩产物零残留', async () => {
    const { manager } = makeCloningSaveManager(makePlayedTree());
    const svc = makeService(manager);
    const { blob, bundle } = await svc.exportCard('p1', 'slot1', makeStory7Options());

    // 导入端九步校验全过（信封/checksum/shape/packId）
    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    // 边 = 勾选集 ∖ NSFW 擦除（edge-nsfw 命中私密文本被剔除），且全部 core:true（D5）
    const ids = decoded.bundle.engram.knowledgeEdges.map((e) => e.id).sort();
    expect(ids).toEqual(['edge-core-opening', 'edge-user', 'edge-world-ai']);
    expect(decoded.bundle.engram.knowledgeEdges.every((e) => e.core === true)).toBe(true);
    // 未勾选的剧情边绝不进卡
    expect(ids).not.toContain('edge-plot-ai');

    // G12 残留扫描：游玩产物全部不在卡的 stateTree 里
    const st = bundle.stateTree;
    expect(_get(st, '元数据.叙事历史')).toBeUndefined();
    expect(_get(st, '元数据.推理历史')).toBeUndefined();
    expect(_get(st, '元数据.当前行动选项')).toBeUndefined();
    expect(_get(st, '记忆.短期')).toBeUndefined();
    expect(_get(st, '记忆.中期')).toBeUndefined();
    expect(_get(st, '记忆.长期')).toBeUndefined();
    expect(_get(st, '记忆.隐式中期')).toBeUndefined();
    expect(_get(st, '角色.效果')).toBeUndefined();
    expect(_get(st, '社交.关系.0.记忆')).toBeUndefined();
    expect(_get(st, '社交.关系.0.私聊历史')).toBeUndefined();
    expect(_get(st, '社交.事件.事件记录')).toBeUndefined();
    expect(_get(st, '世界.状态.心跳.历史')).toBeUndefined();
    expect(_get(st, '系统.actionOptions')).toBeUndefined();
    expect(_get(st, '系统.扩展.image.tasks')).toBeUndefined();
    expect(_get(st, '系统.扩展.image.config')).toBeUndefined();
    expect(_get(st, '系统.扩展.engramMemory')).toBeUndefined(); // 经 bundle.engram 单独携带
    // 可变属性重置：声望归零、体力/精力回满
    expect(_get(st, '角色.可变属性.声望')).toBe(0);
    expect(_get(st, '角色.可变属性.体力.当前')).toBe(100);
    expect(_get(st, '角色.可变属性.精力.当前')).toBe(90);
    // 回合数不进卡（fixture 是第 50 回合）→ 导入端 sparse-merge 回 schema 默认 0
    expect(_get(st, '元数据.回合序号')).toBeUndefined();
    expect(_get(decoded.mergedTree, '元数据.回合序号')).toBe(0);
    // 世界设定保留
    expect(_get(st, '世界.描述')).toBe('烟雨江湖');
    expect(_get(st, '世界.地点信息.loc1.名称')).toBe('客栈');
  });

  it('★SC-6 — 转卡纯只读：源存档字节级不变，saveGame 零调用', async () => {
    const stored = makePlayedTree();
    const before = JSON.stringify(stored);
    const { manager, loadGame, saveGame } = makeCloningSaveManager(stored);
    const svc = makeService(manager);

    await svc.exportCard('p1', 'slot1', makeStory7Options());

    expect(loadGame).toHaveBeenCalledTimes(1);
    expect(saveGame).not.toHaveBeenCalled();
    expect(JSON.stringify(stored)).toBe(before); // core 盖章只发生在导出拷贝上（SC-8 延续）
  });

  it('★SC-9/F2 — NSFW off：勾选的私密边被二次擦除剔除；密钥与私密文本零泄漏', async () => {
    const { manager } = makeCloningSaveManager(makePlayedTree());
    const svc = makeService(manager);
    const { blob } = await svc.exportCard('p1', 'slot1', makeStory7Options());

    const decoded = await decodeAndValidateCard(blob, mockPack);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const json = JSON.stringify(decoded.bundle);
    for (const secret of ALL_SECRETS) expect(json.includes(secret)).toBe(false);
    expect(json.includes(NPC_PRIVATE)).toBe(false); // edge-nsfw 的 fact 与 NPC 私密信息均不残留
  });

  it('U19 — 实体全量进卡（仅被剔除剧情边引用的实体也保留，D1 骨架原则）', async () => {
    const { manager } = makeCloningSaveManager(makePlayedTree());
    const svc = makeService(manager);
    const { bundle } = await svc.exportCard('p1', 'slot1', makeStory7Options());

    const names = bundle.engram.entities.map((e) => e.name).sort();
    expect(names).toEqual(['NPC1', '剧情人物甲', '客栈', '萧寒'].sort());
    expect(bundle.engram.entities.every((e) => e.is_embedded === false)).toBe(true);
  });
});
