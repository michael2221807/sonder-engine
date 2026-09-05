/**
 * GameCardExportService 集成测试 — Story 5 (P9)，最关键。
 *
 * 核心断言 = SC-9「密钥 + 私密零泄露」：向 fixture 注入 6 类密钥（图像 transformer apiKey、
 * API 管理 apiKey/url/customRoutingPath、GitHub token/owner、分配预设里的流氓密钥字段）+ NPC 私密文本，
 * 导出后 `JSON.stringify(bundle)` 不得含其中任何一个（NSFW=off 时连 engram 文字也不得残留）。
 *
 * 同时覆盖：engram 按 selectedEdgeIds 过滤 + is_embedded 归零 + NSFW 边/summary 擦除、
 * 设置白名单闭集（denylist 键 absent）、API 模板逐字段无密钥、图片两态、单文件 gzip roundtrip。
 *
 * 测试基建：vitest env=node 无 localStorage → createMockLocalStorage 安装/还原（backup-service.test 范式）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameCardExportService } from './game-card-export-service';
import { gzipDecompress, sha256String } from '../sync/chunked-bundle-packer';
import { isValidCardBundleShape, type ExportFlags, type ExportOptions, type GameCardBundle } from './game-card-bundle.types';
import { SETTINGS_EXPORT_WHITELIST, SETTINGS_EXPORT_DENYLIST } from './settings-export-whitelist';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import type { SaveManager } from '../persistence/save-manager';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { CustomPresetStore } from '../persistence/custom-preset-store';
import type { ImageAssetCache } from '../image/asset-cache';

// ─── Secret markers — every one of these MUST be absent from an exported card ───
const IMAGE_API_KEY = 'sk-IMAGE-LEAK';
const PROVIDER_API_KEY = 'sk-API-LEAK';
const PROVIDER_BASE_URL = 'http://secret-base-url';
const PROVIDER_ROUTE = '/secret/route';
const GITHUB_TOKEN = 'ghp_GITHUBSECRETTOKEN';
const GITHUB_OWNER = 'secretowner-xyz';
const NPC_PRIVATE_TEXT = '私密泄露文本XYZ';
const ALL_SECRETS = [IMAGE_API_KEY, PROVIDER_API_KEY, PROVIDER_BASE_URL, PROVIDER_ROUTE, GITHUB_TOKEN, GITHUB_OWNER];

function makeFlags(overrides: Partial<ExportFlags> = {}): ExportFlags {
  return {
    containsNsfw: false,
    includedGenerationHistory: false,
    includedReferenceGallery: false,
    includedSettings: true,
    includedApiTemplate: true,
    includedEngineConfig: true,
    includedWorldBooks: true,
    includedBuiltinOverrides: true,
    includedPromptSettings: true,
    includedHeroinePlan: true,
    includedPlotDirection: true,
    includedNarrativeContract: true,
    ...overrides,
  };
}

/** Save tree carrying the image-transformer secret, an NPC private profile, and an engram graph. */
function makeTree(): Record<string, unknown> {
  return {
    元数据: {
      叙事历史: [{ round: 1 }],
      剧情导向: { activeArcIndex: 1, arcs: [{ status: 'active', nodes: [], gauges: [] }] },
      女主规划: { plan: 'heroine' },
    },
    角色: {
      基础信息: { 姓名: '主角' },
      属性: { 体质: 12 },
      可变属性: { 声望: 500, 体力: { 当前: 30, 上限: 100 }, 精力: { 当前: 20, 上限: 90 } },
      身体: { 私密: '正文身体描写' },
      图片档案: { 已选头像图片ID: 'sel-avatar', 生图历史: [{ id: 'player-hist' }] },
    },
    社交: {
      关系: [
        {
          名称: 'NPC1',
          私密信息: NPC_PRIVATE_TEXT,
          图片档案: { 已选立绘图片ID: 'npc-portrait', 生图历史: [{ id: 'npc-hist' }] },
        },
      ],
    },
    系统: {
      设置: { prompt: { 游戏设定: 'world-setup' }, theme: 'dark' },
      扩展: {
        engramMemory: {
          entities: [
            { id: 'ent1', name: 'NPC1', type: 'npc', attributes: {}, firstSeen: 1, lastSeen: 2, mentionCount: 3, summary: 'NPC1 的生平与外貌', is_embedded: true },
            { id: 'ent2', name: 'NPC2', type: 'npc', attributes: {}, firstSeen: 1, lastSeen: 2, mentionCount: 1, summary: `脏summary包含${NPC_PRIVATE_TEXT}`, is_embedded: true },
          ],
          v2Edges: [
            { id: 'edge-keep', sourceEntity: 'A', targetEntity: 'B', fact: '世界设定边', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 2, core: true },
            { id: 'edge-unselected', sourceEntity: 'A', targetEntity: 'C', fact: '未选中边', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 2 },
            { id: 'edge-nsfw', sourceEntity: 'A', targetEntity: 'D', fact: `这条边提到${NPC_PRIVATE_TEXT}`, episodes: [], is_embedded: false, createdAtRound: 1, lastSeenRound: 2 },
          ],
        },
        image: {
          config: { transformer: { apiKey: IMAGE_API_KEY, endpoint: 'http://img-leak' } },
          tasks: [{ prompt: 'queued task' }],
          sceneArchive: { 当前壁纸图片ID: 'wallpaper', 生图历史: [{ id: 'scene-hist' }] },
        },
      },
    },
  };
}

function makeLocalStorageSeed(): Record<string, string> {
  return {
    // DENYLIST keys — present in storage, must NEVER reach the card:
    aga_api_management: JSON.stringify({
      apiConfigs: [{
        name: 'My GPT', provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 2000,
        enabled: true, apiCategory: 'chat',
        apiKey: PROVIDER_API_KEY, url: PROVIDER_BASE_URL, customRoutingPath: PROVIDER_ROUTE,
      }],
    }),
    aga_github_sync_token: GITHUB_TOKEN,
    aga_github_sync_owner: GITHUB_OWNER,
    aga_assignment_presets: JSON.stringify([
      { id: 'p1', name: '主用GPT', createdAt: 123, assignments: [], featureToggles: { cot: true }, rogueSecret: PROVIDER_API_KEY },
    ]),
    // WHITELIST keys — safe, should travel:
    aga_user_settings: JSON.stringify({ theme: 'dark', locale: 'zh-CN' }),
    aga_nsfw_settings: JSON.stringify({ nsfwMode: true }),
  };
}

/** Build a service with stubbed deps; `captured` records the ids requested from the image cache. */
function makeService(tree: Record<string, unknown> | null, captured: { ids?: Set<string> }) {
  const saveManager = { loadGame: async () => tree } as unknown as SaveManager;
  const configStore = {
    listOverlays: async () => [{ domainId: 'd', packId: 'tianming', patches: { foo: 1 }, version: 1, updatedAt: 0 }],
  } as unknown as ConfigStore;
  const promptStorage = {
    exportAll: async () => [{ key: 'sys.main', value: 'override-text' }],
  } as unknown as PromptStorage;
  const worldBookStorage = {
    exportWorldBooks: async () => ({ worldBooks: [], version: 1 }),
    exportBuiltinOverrides: async () => ({ overrides: {} }),
  } as unknown as WorldBookStorage;
  const customPresetStore = {
    load: async () => ({ presets: { origin: [{ id: 'o1', name: '寒门' }] } }),
  } as unknown as CustomPresetStore;
  const imageAssetCache = {
    exportByIds: async (ids: Set<string>) => {
      captured.ids = new Set(ids);
      return [...ids].map((id) => ({ id, metadata: { id }, base64: `BASE64_${id}`, mimeType: 'image/png' }));
    },
  } as unknown as ImageAssetCache;

  return new GameCardExportService(saveManager, configStore, promptStorage, worldBookStorage, customPresetStore, imageAssetCache);
}

function makeOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    protagonist: { mode: 'fixed' },
    cardMeta: {
      formatVersion: 0, cardId: 'card-1', title: '测试卡', description: '', author: '作者',
      tags: [], createdAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z', packId: 'tianming',
    },
    selectedEdgeIds: new Set(['edge-keep', 'edge-nsfw']), // deliberately omit edge-unselected
    checklist: makeFlags(),
    ...overrides,
  };
}

describe('GameCardExportService.exportCard', () => {
  const mock = createMockLocalStorage();
  beforeEach(() => {
    mock.install();
    for (const [k, v] of Object.entries(makeLocalStorageSeed())) localStorage.setItem(k, v);
  });
  afterEach(() => mock.restore());

  // ─── SC-9: the hard zero-leak assertion ───
  it('SC-9 — leaks NO secret of any kind into the bundle (NSFW excluded)', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());
    const json = JSON.stringify(bundle);

    for (const secret of ALL_SECRETS) {
      expect(json, `secret leaked: ${secret}`).not.toContain(secret);
    }
    // With NSFW off, materialized private text must not survive anywhere (stateTree OR engram).
    expect(json).not.toContain(NPC_PRIVATE_TEXT);
    // Blanket: no provider-key-shaped token survives.
    expect(json).not.toMatch(/sk-[A-Z]/);
  });

  it('strips secrets from the gzip blob too (not just the in-memory bundle)', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { blob } = await svc.exportCard('p1', 'auto', makeOptions());
    const text = await gzipDecompress(blob);
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain(NPC_PRIVATE_TEXT);
  });

  // ─── Engram extraction ───
  it('filters engram edges by selectedEdgeIds and resets is_embedded', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());

    const ids = bundle.engram.knowledgeEdges.map((e) => e.id);
    expect(ids).toContain('edge-keep');
    expect(ids).not.toContain('edge-unselected'); // not in selectedEdgeIds
    expect(ids).not.toContain('edge-nsfw');        // scrubbed: fact echoes private text (NSFW off)
    expect(bundle.engram.knowledgeEdges.every((e) => e.is_embedded === false)).toBe(true);
    expect(bundle.engram.entities.every((e) => e.is_embedded === false)).toBe(true);

    // NSFW-echoing entity summary blanked; clean one preserved. (EngramEntity is keyed by name.)
    const ent2 = bundle.engram.entities.find((e) => e.name === 'NPC2');
    expect(ent2?.summary).toBe('');
    const ent1 = bundle.engram.entities.find((e) => e.name === 'NPC1');
    expect(ent1?.summary).toBe('NPC1 的生平与外貌');

    // engramMemory removed from the carried state tree (no double-carry).
    const ext = (bundle.stateTree['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>;
    expect(ext['engramMemory']).toBeUndefined();
  });

  it('Story 7 (D5): markSelectedEdgesCore stamps core:true on every exported edge — copy only', async () => {
    const captured: { ids?: Set<string> } = {};
    const tree = makeTree();
    const svc = makeService(tree, captured);
    // containsNsfw:true keeps edge-nsfw (which has NO core in the fixture) → both
    // pre-cored and core-less edges are exercised by the stamp.
    const { bundle, checksum } = await svc.exportCard('p1', 'auto', makeOptions({
      markSelectedEdgesCore: true,
      checklist: makeFlags({ containsNsfw: true }),
    }));

    expect(bundle.engram.knowledgeEdges.length).toBe(2); // edge-keep + edge-nsfw
    expect(bundle.engram.knowledgeEdges.every((e) => e.core === true)).toBe(true);

    // Source tree untouched (stamp lives on the exported copy only — SC-8).
    const ext = (tree['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>;
    const mem = ext['engramMemory'] as Record<string, unknown>;
    const srcEdges = mem['v2Edges'] as Array<Record<string, unknown>>;
    expect(srcEdges.find((e) => e['id'] === 'edge-nsfw')?.['core']).toBeUndefined();

    // Checksum was computed AFTER stamping (import-side recompute must match).
    expect(await sha256String(JSON.stringify(bundle))).toBe(checksum);
  });

  it('default (flag omitted): edge core values pass through unchanged', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions({
      checklist: makeFlags({ containsNsfw: true }),
    }));
    const byId = new Map(bundle.engram.knowledgeEdges.map((e) => [e.id, e]));
    expect(byId.get('edge-keep')?.core).toBe(true);      // pre-existing core preserved
    expect(byId.get('edge-nsfw')?.core).toBeUndefined(); // absent stays absent
  });

  it('keeps NSFW edges/private text when adult content IS included — but still no secrets', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions({ checklist: makeFlags({ containsNsfw: true }) }));
    const json = JSON.stringify(bundle);

    expect(json).toContain(NPC_PRIVATE_TEXT); // intended adult content survives
    const ids = bundle.engram.knowledgeEdges.map((e) => e.id);
    expect(ids).toContain('edge-nsfw');        // not scrubbed when NSFW kept
    for (const secret of ALL_SECRETS) expect(json).not.toContain(secret); // keys NEVER travel, NSFW or not
  });

  // ─── Settings whitelist (closed set) ───
  it('exports only whitelisted settings; every denylist key is absent', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());

    expect(bundle.settings).toBeDefined();
    const keys = Object.keys(bundle.settings ?? {});
    expect(keys).toContain('aga_user_settings');
    expect(keys).toContain('aga_nsfw_settings');
    for (const denied of SETTINGS_EXPORT_DENYLIST) {
      expect(keys, `denylist key leaked: ${denied}`).not.toContain(denied);
    }
    for (const k of keys) expect(SETTINGS_EXPORT_WHITELIST).toContain(k); // closed set
  });

  // ─── API template (field-level secret exclusion) ───
  it('exports an API template with secret fields removed and rogue preset keys dropped', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());

    const cfg = bundle.apiTemplate?.configs[0] as Record<string, unknown> | undefined;
    expect(cfg).toBeDefined();
    expect(cfg?.name).toBe('My GPT');
    expect(cfg?.model).toBe('gpt-4o');
    expect(cfg).not.toHaveProperty('apiKey');
    expect(cfg).not.toHaveProperty('url');
    expect(cfg).not.toHaveProperty('customRoutingPath');

    const preset = bundle.apiTemplate?.assignmentPresets?.[0] as Record<string, unknown> | undefined;
    expect(preset?.name).toBe('主用GPT');
    expect(preset).not.toHaveProperty('rogueSecret'); // F1: unknown top-level keys reconstructed away
  });

  // ─── Image two-state ───
  it('collects only selected images when generation history is excluded', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    await svc.exportCard('p1', 'auto', makeOptions({ checklist: makeFlags({ includedGenerationHistory: false }) }));

    expect(captured.ids).toBeDefined();
    expect(captured.ids).toEqual(new Set(['sel-avatar', 'npc-portrait', 'wallpaper']));
  });

  it('includes generation-history images when opted in', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    await svc.exportCard('p1', 'auto', makeOptions({ checklist: makeFlags({ includedGenerationHistory: true }) }));

    expect([...(captured.ids ?? [])].sort()).toEqual(
      ['npc-hist', 'npc-portrait', 'player-hist', 'scene-hist', 'sel-avatar', 'wallpaper'].sort(),
    );
  });

  // ─── Optional creative assets are carried when flagged ───
  it('carries world books, engine config, prompt overrides and custom presets when flagged', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());

    expect(bundle.worldBooks).toBeDefined();
    expect(bundle.configOverlays).toHaveLength(1);
    expect(bundle.promptOverrides).toHaveLength(1);
    expect(bundle.customPresets?.['tianming']?.['origin']).toBeDefined();
  });

  // ─── Single-file gzip envelope roundtrip ───
  it('produces a valid single-file gzip envelope that roundtrips to a valid card shape', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { blob, checksum, bundle } = await svc.exportCard('p1', 'auto', makeOptions());

    const text = await gzipDecompress(blob);
    const envelope = JSON.parse(text) as { format: string; formatVersion: number; checksum: string; bundle: GameCardBundle };
    expect(envelope.format).toBe('aga-card');
    expect(envelope.checksum).toBe(checksum);
    expect(isValidCardBundleShape(envelope.bundle)).toBe(true);
    expect(envelope.bundle.cardMeta.title).toBe('测试卡');
    expect(envelope.bundle.cardMeta.formatVersion).toBeGreaterThanOrEqual(1); // service stamps it
    expect(bundle.bundleType).toBe('card');
  });

  // ─── Blank protagonist drops 角色 ───
  it('blank protagonist mode produces a card without a 角色 subtree and an empty opening setup', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions({ protagonist: { mode: 'blank' } }));

    expect(bundle.stateTree['角色']).toBeUndefined();
    expect(bundle.opening).toEqual({ firstRoundSetup: '' });
  });

  // ─── D7: opening-style hint ───
  it('writes the trimmed firstRoundSetup hint into bundle.opening (fixed/template, D7)', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions({ firstRoundSetup: '  以第一人称、悬疑基调展开  ' }));
    expect(bundle.opening).toEqual({ firstRoundSetup: '以第一人称、悬疑基调展开' });
  });

  it('omits bundle.opening for fixed/template when no hint is supplied (D7)', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(makeTree(), captured);
    const { bundle } = await svc.exportCard('p1', 'auto', makeOptions());
    expect(bundle.opening).toBeUndefined();
  });

  it('throws when the save slot does not exist', async () => {
    const captured: { ids?: Set<string> } = {};
    const svc = makeService(null, captured);
    await expect(svc.exportCard('p1', 'missing', makeOptions())).rejects.toThrow();
  });
});
