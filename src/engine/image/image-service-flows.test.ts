import 'fake-indexeddb/auto';
/**
 * Image generation behaviour lock (refactor R3, step 0).
 *
 * The four generation flows of `ImageService` (scene, character, secret part, regenerate) and the archive helpers
 * around them are run end to end with the real task queue, state manager, asset cache (fake IndexedDB), tokenizer,
 * prompt assembler and pack prompts. Only the AI service and the six image providers are fakes, and they record
 * every call. What a case did is stored byte for byte in `__snapshots__/image-flows/<id>.json`: the outcome (the
 * task with its key order, or the error thrown), every event in order (nested toasts included), every AI request,
 * every provider call, every cache operation, the state subtree the flow touches and the lock state afterwards.
 *
 * A refactor of image-service.ts must leave every file unchanged. Snapshots are never rewritten with `-u` during
 * the refactor; a changed snapshot is a failed step. A pack prompt edit changes the AI requests on purpose: rebase
 * and regenerate the baseline in the step-0 commit only.
 *
 * Determinism: only Date is faked (fake-indexeddb needs the real timers), Math.random is fixed, task ids are
 * renumbered by first appearance (the id counter is module state), and the event bus is cleared after each case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ImageService } from './image-service';
import { ImageAssetCache } from './asset-cache';
import { ImageProviderRegistry } from './provider-registry';
import { PLAYER_PSEUDO_NPC_ID } from './image-state-manager';
import type { ImageAsset, ImageBackendType, ImageProvider, ImageReferenceInput, StylePreset } from './types';
import { StateManager } from '../core/state-manager';
import { eventBus } from '../core/event-bus';
import { PromptAssembler } from '../prompt/prompt-assembler';
import { PromptRegistry } from '../prompt/prompt-registry';
import { TemplateEngine } from '../prompt/template-engine';
import { isPromptAlwaysOn } from '../prompt/builtin-slots';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { AIService } from '../ai/ai-service';
import type { GamePack } from '../types';
import { loadPackFromDisk } from '../__test-utils__/load-pack-from-disk';
import type { TransformerDefaultsData } from './transformer-presets';

const SNAPSHOT_DIR = '__snapshots__/image-flows';
const UNDEFINED_MARK = '__undefined__';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const FIXED_RANDOM = 0.123456;
const ALL_BACKENDS: ImageBackendType[] = ['openai', 'novelai', 'sd_webui', 'comfyui', 'civitai', 'volcengine'];
/** Backends whose fake provider has `imageToImage` (the capability is "the method exists"). */
const IMAGE_TO_IMAGE_BACKENDS = new Set<ImageBackendType>(['novelai', 'civitai', 'volcengine']);
const LOCK_KEYS = [
  '林暖', '关宇', PLAYER_PSEUDO_NPC_ID,
  '林暖::breast', '林暖::vagina', '林暖::anus', '关宇::breast', `${PLAYER_PSEUDO_NPC_ID}::breast`, `${PLAYER_PSEUDO_NPC_ID}::vagina`,
];

// ── serialisation (same writing as the R2 reply corpus: key order kept, undefined written as a mark) ──

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

/** Renumbers `img_task_<n>_<t>` by first appearance: the counter is module state and grows across cases. */
function normalizeTaskIds(text: string): string {
  const order = new Map<string, number>();
  return text.replace(/img_task_\d+_\d+/g, (id) => {
    if (!order.has(id)) order.set(id, order.size + 1);
    return `<task#${order.get(id)}>`;
  });
}

type Outcome = { ok: unknown } | { threw: string };

async function record(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}

/** Lets every fire-and-forget cache delete and the eviction cleanup land. Timers other than Date stay real. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── fixtures ──

type Json = Record<string, unknown>;

function baseTree(): Json {
  return {
    系统: {
      扩展: {
        image: {
          enabled: true,
          tasks: [],
          characterAnchors: [
            { id: 'anc1', npcName: '林暖', enabled: true, sceneLink: true, positive: '1girl, long black hair, red eyes, white dress', negative: 'bad hands' },
            { id: 'anc2', npcName: '关宇', enabled: false, sceneLink: true, positive: '1boy, short hair, sword' },
          ],
          sceneArchive: { 生图历史: [], 当前壁纸图片ID: '' },
          referenceLibrary: [],
          config: {
            sceneHistoryLimit: 10,
            auto: { historyLimit: 100 },
            civitai: {
              allowMatureContent: true,
              scheduler: 'DPM++ 2M',
              steps: 25,
              cfgScale: 6,
              additionalNetworksJson: '{"urn:air:sdxl:lora:civitai:999@1":{"strength":0.5}}',
              loras: [],
            },
            novelai: { sampler: 'k_euler', noiseSchedule: 'karras', steps: 28, cfgScale: 5, smea: true },
            comfyui: { workflowJson: '' },
            reference: {},
          },
        },
      },
    },
    角色: {
      基础信息: { 姓名: '主角' },
      身体: {
        胸部描述: '胸型匀称',
        私处描述: '干净整洁',
        生殖器描述: '形态正常',
        身体部位: [
          { 部位名称: '胸部', 特征描述: '饱满挺拔，肤色偏白' },
          { 部位名称: '小穴', 特征描述: '粉嫩紧致，毛发稀疏' },
        ],
      },
    },
    社交: {
      关系: [
        {
          名称: '林暖', 类型: '重要', 性别: '女', 年龄: 18, 描述: '酒肆老板娘', 外貌描述: '眉目清亮，黑发及腰',
          身材描写: '纤细修长', 衣着风格: '素色长裙', 是否在场: true, 好感度: 50,
          私密信息: {
            身体部位: [
              { 部位名称: '胸部', 特征描述: '小巧挺翘，肤色白皙', 特殊印记: '锁骨下一颗小痣', 敏感度: 60, 开发度: 10 },
              { 部位名称: '屁穴', 特征描述: '紧致' },
            ],
          },
        },
        { 名称: '关宇', 类型: '普通', 性别: '男', 年龄: 25, 描述: '游侠', 外貌描述: '剑眉星目', 身材描写: '高大结实', 衣着风格: '黑色劲装', 是否在场: true, 好感度: 20 },
      ],
    },
  };
}

type TreeEdit = (tree: Json) => void;
const imageConf = (tree: Json): Json => ((tree['系统'] as Json)['扩展'] as Json)['image'] as Json;
const imageConfig = (tree: Json): Json => imageConf(tree)['config'] as Json;
const npcList = (tree: Json): Json[] => (tree['社交'] as Json)['关系'] as Json[];

const PRESET: StylePreset = {
  id: 'preset_a', name: 'Preset A', positivePrefix: 'masterpiece, best quality', positiveSuffix: 'detailed',
  negative: 'lowres, blurry', width: 1216, height: 832, source: 'user_defined',
};

const LORA_AIR = 'urn:air:sdxl:lora:civitai:123@456';
function loraItem(over: Json = {}): Json {
  return {
    id: 'lora1', name: 'Ink Style', air: LORA_AIR, enabled: true, strength: 0.8,
    scopes: ['scene', 'character', 'player', 'secret_part'], autoInjectTriggers: true,
    triggers: [
      { id: 't1', text: 'ink wash, soft edges', enabled: true, source: 'manual', createdAt: 1, updatedAt: 1 },
      { id: 't2', text: '<lora:ink:0.8>', enabled: true, source: 'manual', createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1, updatedAt: 1, ...over,
  };
}

const REPLY_SCENE = '<thinking>scene reasoning</thinking>\n<场景判定>适合场景快照</场景判定><判定说明>有清晰互动</判定说明><场景类型>场景快照</场景类型>\n'
  + '<提示词结构><基础>ancient courtyard, night, lanterns</基础><角色>[1]林暖|1girl, smile, black robe</角色></提示词结构>';
const REPLY_CHARACTER = '<thinking>character reasoning</thinking>\n<提示词>1girl, long hair, red eyes, school uniform, smile</提示词>';
const REPLY_SECRET = '<thinking>secret reasoning</thinking>\n<提示词>breast close-up, pale skin, soft light</提示词>';
const REPLY_PLACEHOLDER = '<提示词>...</提示词>';

// ── the harness ──

type Replies = Record<string, string>;
interface Harness {
  svc: ImageService;
  sm: StateManager;
  cache: ImageAssetCache;
  replies: Replies;
  /** backend → null = no image API config bound */
  configs: Partial<Record<ImageBackendType, null>>;
  /** backend → message the fake provider throws */
  providerFail: Partial<Record<ImageBackendType, string>>;
  events: Array<[string, unknown]>;
  aiCalls: unknown[];
  providerCalls: unknown[];
  cacheOps: unknown[];
  logs: unknown[];
  seedAsset: (id: string, text?: string) => Promise<void>;
}

let pack: GamePack;
const origStore = ImageAssetCache.prototype.store;
const origRetrieve = ImageAssetCache.prototype.retrieve;
const origDelete = ImageAssetCache.prototype.delete;

function installFileReader(): void {
  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  (globalThis as unknown as Record<string, unknown>).FileReader = FakeFileReader;
}

function slimEvent(event: string, payload: unknown): unknown {
  if (event === 'engine:state-changed' && payload && typeof payload === 'object') {
    const p = payload as { change?: { path?: string; action?: string }; source?: string; type?: string };
    if (p.change) return { path: p.change.path, action: p.change.action, source: p.source };
  }
  return payload === undefined ? undefined : structuredClone(payload);
}

async function makeHarness(edit?: TreeEdit, loadTree = true): Promise<Harness> {
  (globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory();
  const tree = baseTree();
  edit?.(tree);

  const sm = new StateManager();
  const registry = new PromptRegistry();
  registry.registerPack(pack.prompts, isPromptAlwaysOn);
  const assembler = new PromptAssembler(registry, new TemplateEngine());

  const h: Harness = {
    svc: undefined as unknown as ImageService,
    sm,
    cache: undefined as unknown as ImageAssetCache,
    replies: { imageSceneTokenizer: REPLY_SCENE, imageCharacterTokenizer: REPLY_CHARACTER, imageSecretTokenizer: REPLY_SECRET },
    configs: {},
    providerFail: {},
    events: [], aiCalls: [], providerCalls: [], cacheOps: [], logs: [],
    seedAsset: async () => undefined,
  };

  const aiService = {
    getImageConfigForBackend: (backend: string) => (h.configs[backend as ImageBackendType] === null
      ? undefined
      : { name: `cfg-${backend}`, url: `https://img.test/${backend}`, apiKey: `key-${backend}`, model: `model-${backend}` }),
    getConfigForUsage: () => ({ name: 'cfg-default', url: 'https://img.test/default', apiKey: 'key-default', model: 'model-default' }),
    generate: async (req: { usageType?: string }) => {
      h.aiCalls.push(structuredClone(req));
      return h.replies[req.usageType ?? ''] ?? '';
    },
  } as unknown as AIService;

  const providers = new ImageProviderRegistry();
  let blobCounter = 0;
  for (const backend of ALL_BACKENDS) {
    providers.register(backend, (config) => {
      h.providerCalls.push({ op: 'resolve', backend, config });
      const provider: Record<string, unknown> = {
        backend,
        generate: async (prompt: string, negative: string, width: number, height: number, options?: Record<string, unknown>) => {
          h.providerCalls.push({ op: 'generate', backend, prompt, negative, width, height, options });
          const failure = h.providerFail[backend];
          if (failure) throw new Error(failure);
          return new Blob([`image:${backend}:${++blobCounter}`], { type: 'image/png' });
        },
        testConnection: async () => true,
      };
      if (IMAGE_TO_IMAGE_BACKENDS.has(backend)) {
        provider.imageToImage = async (prompt: string, negative: string, width: number, height: number, references: unknown[], options?: Record<string, unknown>) => {
          h.providerCalls.push({ op: 'imageToImage', backend, prompt, negative, width, height, references, options });
          const failure = h.providerFail[backend];
          if (failure) throw new Error(failure);
          return new Blob([`image:${backend}:${++blobCounter}`], { type: 'image/png' });
        };
      }
      return provider as unknown as ImageProvider;
    });
  }

  // Construct first and load the tree after, like production, so the load restores the task queue.
  h.svc = new ImageService(sm, aiService, assembler, providers, DEFAULT_ENGINE_PATHS);
  h.svc.setTransformerDefaults(pack.transformerDefaults as TransformerDefaultsData | undefined);
  h.cache = h.svc.getAssetCache();
  h.seedAsset = async (id, text = `seed:${id}`) => {
    const meta: ImageAsset = {
      id, taskId: 'seed', storageKey: id, mimeType: 'image/png', width: 8, height: 8, sizeBytes: text.length,
      backend: 'novelai', createdAt: 1, origin: 'generated',
    };
    await origStore.call(h.cache, meta, new Blob([text], { type: 'image/png' }));
  };
  if (loadTree) sm.loadTree(tree);
  return h;
}

/** Installs the recorders. Called after the fixtures are seeded so setup is not part of what a case did. */
function startRecording(h: Harness): void {
  const emit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    h.events.push([event, slimEvent(event, payload)]);
    emit(event, payload);
  });
  vi.spyOn(ImageAssetCache.prototype, 'store').mockImplementation(async function (this: ImageAssetCache, asset, blob) {
    h.cacheOps.push(['store', asset.id, { metadata: asset, blobSize: blob.size, blobType: blob.type }]);
    return origStore.call(this, asset, blob);
  });
  vi.spyOn(ImageAssetCache.prototype, 'retrieve').mockImplementation(async function (this: ImageAssetCache, id) {
    h.cacheOps.push(['retrieve', id]);
    return origRetrieve.call(this, id);
  });
  vi.spyOn(ImageAssetCache.prototype, 'delete').mockImplementation(async function (this: ImageAssetCache, id) {
    h.cacheOps.push(['delete', id]);
    return origDelete.call(this, id);
  });
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      h.logs.push([level, ...args.map((a) => (typeof a === 'string' ? a : String(a)))]);
    });
  }
}

/** Debug-prompt events repeat the AI request; the AI request is stored once and the event is checked against it. */
function dedupeDebugPrompts(h: Harness): Array<[string, unknown]> {
  let n = 0;
  return h.events.map(([event, payload]) => {
    if (event !== 'ui:debug-prompt' || !payload || typeof payload !== 'object') return [event, payload];
    const request = h.aiCalls[n++] as { messages?: unknown } | undefined;
    const p = payload as { messages?: unknown };
    if (request && JSON.stringify(request.messages) === JSON.stringify(p.messages)) {
      return [event, { ...p, messages: `<same as aiCalls[${n - 1}].messages>` }];
    }
    return [event, payload];
  });
}

async function snapshotCase(id: string, h: Harness, outcome: Outcome): Promise<void> {
  await settle();
  const tree = h.sm.toSnapshot() as Json;
  const locks: Record<string, boolean> = {};
  for (const key of LOCK_KEYS) locks[key] = h.svc.state.isGenerating(key);
  const doc = {
    outcome,
    events: dedupeDebugPrompts(h),
    aiCalls: h.aiCalls,
    providerCalls: h.providerCalls,
    cacheOps: h.cacheOps,
    cacheIds: (await h.cache.listAll()).map((a) => a.id),
    state: {
      image: imageConf(tree),
      relationships: (tree['社交'] as Json)['关系'],
      playerArchive: (tree['角色'] as Json)['图片档案'],
    },
    locks,
    logs: h.logs,
  };
  await expect(normalizeTaskIds(serialize(doc))).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}

/** Runs one case: build the harness, seed, start recording, run, snapshot. */
async function flow(
  id: string,
  options: {
    edit?: TreeEdit;
    replies?: Replies;
    configs?: Harness['configs'];
    providerFail?: Harness['providerFail'];
    fileReader?: boolean;
    seed?: (h: Harness) => Promise<void>;
  },
  run: (h: Harness) => Promise<unknown>,
): Promise<void> {
  const h = await makeHarness(options.edit);
  Object.assign(h.replies, options.replies);
  Object.assign(h.configs, options.configs);
  Object.assign(h.providerFail, options.providerFail);
  if (options.fileReader) installFileReader();
  await options.seed?.(h);
  startRecording(h);
  const outcome = await record(() => run(h));
  await snapshotCase(id, h, outcome);
}

beforeEach(async () => {
  pack ??= await loadPackFromDisk();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
});

afterEach(() => {
  eventBus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as unknown as Record<string, unknown>).FileReader;
});

// ── parameters shared by several cases ──

const SCENE = {
  sceneDescription: '夜色里，林暖在庭院中点起灯笼，关宇站在廊下看她。',
  location: '大唐·长安·朱雀大街·酒肆',
  gameTime: { year: 1, month: 10, day: 3, hour: 21, minute: 30 },
  weather: '小雨',
  festival: { 名称: '中秋节', 描述: '团圆', 效果: '灯火' },
  environment: [{ 名称: '雾气' }, { 名称: '潮湿' }],
  presentNpcs: ['林暖', '关宇'],
  npcDetails: [{ name: '林暖', appearance: '黑发及腰', bodyDescription: '纤细', outfitStyle: '素色长裙', description: '酒肆老板娘' }],
  extraRequirements: '突出灯笼光影',
};

const dataUrlRef = (over: Partial<ImageReferenceInput> = {}): ImageReferenceInput => ({
  id: 'ref_data', role: 'source', source: 'data_url', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', denoiseStrength: 0.6, ...over,
});

describe('ImageService flows · scene', () => {
  it('S1 novelai default, scene history at its limit is trimmed', async () => {
    await flow('S1', {
      edit: (t) => {
        imageConfig(t).sceneHistoryLimit = 2;
        imageConf(t).sceneArchive = {
          生图历史: [{ id: 'old_scene_1', taskId: 'x1', status: 'complete', createdAt: 100 }, { id: 'old_scene_2', taskId: 'x2', status: 'complete', createdAt: 50 }],
          当前壁纸图片ID: 'old_scene_2', 最近生图结果: 'old_scene_1',
        };
      },
    }, (h) => h.svc.generateSceneImage({ ...SCENE, backend: 'novelai' }));
  });

  it('S2 civitai with a LoRA shelf, two references, role anchors and style overrides', async () => {
    await flow('S2', {
      edit: (t) => {
        imageConfig(t).civitai = { ...(imageConfig(t).civitai as Json), loras: [loraItem({ strength: 2.0 })] };
      },
    }, (h) => h.svc.generateSceneImage({
      ...SCENE,
      backend: 'civitai',
      compositionMode: 'story_snapshot',
      preset: PRESET,
      artistPrefix: 'artist:someone',
      extraNegative: 'extra negative',
      roleAnchors: [{ name: '林暖', positive: '1girl, long black hair, red eyes' }],
      references: [
        dataUrlRef({ id: 'ref_a', denoiseStrength: 0.45 }),
        { id: 'ref_b', role: 'source', source: 'asset', assetId: 'asset_ref_b', denoiseStrength: 0.3 },
      ],
      styleParamOverrides: { steps: 30, cfgScale: 7.5 },
    }));
  });

  it('S3 provider throws', async () => {
    await flow('S3', { providerFail: { novelai: 'provider exploded' } }, (h) => h.svc.generateSceneImage({ ...SCENE, backend: 'novelai' }));
  });

  it('S4 image generation disabled throws', async () => {
    await flow('S4', { edit: (t) => { imageConf(t).enabled = false; } }, (h) => h.svc.generateSceneImage({ ...SCENE, backend: 'novelai' }));
  });

  it('S5 placeholder tokenizer reply fails the task', async () => {
    await flow('S5', { replies: { imageSceneTokenizer: REPLY_PLACEHOLDER } }, (h) => h.svc.generateSceneImage({ ...SCENE, backend: 'novelai' }));
  });
});

describe('ImageService flows · character', () => {
  const CHARACTER = {
    characterName: '林暖',
    description: '酒肆老板娘',
    appearance: '眉目清亮，黑发及腰',
    bodyDescription: '纤细修长',
    outfitStyle: '素色长裙',
  };

  it('C1 novelai with anchor, size preset, artist string, custom rule templates, NPC history over the limit', async () => {
    await flow('C1', {
      edit: (t) => {
        imageConfig(t).auto = { historyLimit: 2 };
        imageConf(t).ruleTemplates = [{
          id: 'transformer_nai_npc', name: 'Custom NPC', scope: 'npc', baseRule: 'CUSTOM BASE RULE', anchorRule: 'CUSTOM ANCHOR RULE',
          noAnchorFallback: 'CUSTOM FALLBACK', outputFormat: 'CUSTOM OUTPUT FORMAT',
        }];
        npcList(t)[0]['图片档案'] = {
          生图历史: [
            { id: 'hist_1', status: 'complete', composition: 'portrait', createdAt: 200 },
            { id: 'hist_2', status: 'complete', composition: 'full-length', createdAt: 100 },
          ],
          最近生图结果: 'hist_1', 已选头像图片ID: 'hist_2', 已选立绘图片ID: '', 已选背景图片ID: '',
        };
      },
      seed: async (h) => { await h.seedAsset('hist_1'); await h.seedAsset('hist_2'); },
    }, (h) => h.svc.generateCharacterImage({
      ...CHARACTER,
      backend: 'novelai',
      composition: 'half-body',
      preset: PRESET,
      artistPrefix: 'artist:someone, artist:other',
      extraNegative: 'extra negative',
      anchorPositive: '1girl, long black hair, red eyes, white dress',
      anchorNegative: 'bad hands, extra fingers',
      anchorStructuredFeatures: { appearance: ['1girl'], hairstyle: ['long hair'], hairColor: ['black hair'], eyes: ['red eyes'] },
      artStyle: '二次元',
      extraPrompt: '微笑，回眸',
    }));
  });

  it('C2 sd_webui with the transformer off builds the prompt directly', async () => {
    await flow('C2', {}, (h) => h.svc.generateCharacterImage({
      ...CHARACTER, backend: 'sd_webui', useTransformer: false, composition: 'full-length', artStyle: '写实', extraPrompt: '站在门口',
    }));
  });

  it('C3 civitai with an asset reference', async () => {
    await flow('C3', {
      fileReader: true,
      seed: async (h) => { await h.seedAsset('asset_ref_c3', 'reference-bytes'); },
    }, (h) => h.svc.generateCharacterImage({
      ...CHARACTER,
      backend: 'civitai',
      references: [{ id: 'ref_c3', role: 'source', source: 'asset', assetId: 'asset_ref_c3', denoiseStrength: 0.55, mimeType: 'image/png' }],
    }));
  });

  it('C4 the player pseudo NPC writes the player archive', async () => {
    await flow('C4', {}, (h) => h.svc.generateCharacterImage({
      characterName: PLAYER_PSEUDO_NPC_ID, description: '主角', appearance: '清瘦少年', backend: 'volcengine', composition: 'scene', artStyle: '国风',
    }));
  });

  it('C5 a lock conflict throws before any task exists', async () => {
    await flow('C5', {}, async (h) => {
      h.svc.state.lockGeneration('林暖');
      return h.svc.generateCharacterImage({ ...CHARACTER, backend: 'novelai' });
    });
  });

  it('C6 an invalid LoRA AIR fails the task and the lock is released', async () => {
    await flow('C6', {
      edit: (t) => {
        imageConfig(t).civitai = { ...(imageConfig(t).civitai as Json), loras: [loraItem({ air: 'not-an-air', name: 'Bad Lora' })] };
      },
    }, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'civitai' }));
  });

  it('C7 a backend with no API config fails the task', async () => {
    await flow('C7', { configs: { novelai: null } }, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'novelai' }));
  });

  it('C8 civitai reference redraw disabled in settings fails the task', async () => {
    await flow('C8', {
      edit: (t) => { imageConfig(t).reference = { civitai: { imageToImageEnabled: false } }; },
    }, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'civitai', references: [dataUrlRef()] }));
  });

  // Extra cases beyond the 29 of the plan: callProvider branches that no other case reaches.
  it('C9 sd_webui has no image-to-image: a reference fails the task', async () => {
    await flow('C9', {}, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'sd_webui', references: [dataUrlRef()] }));
  });

  it('C10 novelai reference redraw disabled in settings fails the task', async () => {
    await flow('C10', {
      edit: (t) => { imageConfig(t).reference = { novelai: { imageToImageEnabled: false } }; },
    }, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'novelai', references: [dataUrlRef()] }));
  });

  it('C11 comfyui reads the workflow template from settings', async () => {
    await flow('C11', {
      edit: (t) => { imageConfig(t).comfyui = { workflowJson: '{"3":{"class_type":"KSampler"}}' }; },
    }, (h) => h.svc.generateCharacterImage({ ...CHARACTER, backend: 'comfyui', useTransformer: false }));
  });
});

describe('ImageService flows · secret part', () => {
  const SECRET = { characterName: '林暖', part: 'breast' as const };
  const SEEDREAM_RULESET = (t: Json): void => {
    imageConf(t).ruleTemplates = [
      { id: 'tpl-npc', name: 'npc tpl', scope: 'npc', baseRule: 'NPC BASE', anchorRule: 'NPC ANCHOR', noAnchorFallback: 'NPC FALLBACK', outputFormat: 'NPC FORMAT' },
    ];
    imageConf(t).modelRulesets = [{
      id: 'seedream', name: 'Seedream', enabled: true, baseModelRule: 'SEEDREAM MODEL RULE', anchorModeModelRule: 'SEEDREAM ANCHOR RULE',
      serializationStrategy: 'seedream_narrative', npcTemplateId: 'tpl-npc', sceneTemplateId: '', judgeTemplateId: '',
    }];
  };

  it('P1 NPC breast with a resolvable body-part entry; the previous secret image blob is deleted', async () => {
    await flow('P1', {
      edit: (t) => {
        npcList(t)[0]['图片档案'] = {
          生图历史: [{ id: 'old_secret_1', status: 'complete', composition: 'secret_part', part: 'breast', createdAt: 100 }],
          最近生图结果: 'old_secret_1', 已选头像图片ID: '', 已选立绘图片ID: '', 已选背景图片ID: '',
          香闺秘档: { 胸部: { id: 'old_secret_1', status: 'complete', part: 'breast', createdAt: 100 } },
        };
      },
      seed: async (h) => { await h.seedAsset('old_secret_1'); },
    }, (h) => h.svc.generateSecretPartImage({
      ...SECRET,
      backend: 'novelai',
      anchorPositive: '1girl, pale skin, small breasts',
      anchorNegative: 'bad anatomy',
      artStyle: '写实',
      extraPrompt: '柔光',
      preset: PRESET,
      artistPrefix: 'artist:someone',
      extraNegative: 'extra negative',
    }));
  });

  it('P2 volcengine with the seedream_narrative ruleset and several references', async () => {
    await flow('P2', { edit: SEEDREAM_RULESET }, (h) => h.svc.generateSecretPartImage({
      ...SECRET,
      backend: 'volcengine',
      artStyle: '国风',
      references: [
        dataUrlRef({ id: 'ref_1', assetId: 'asset_p2_1', denoiseStrength: 0.7 }),
        dataUrlRef({ id: 'ref_2', denoiseStrength: 0.2 }),
        { id: 'ref_3', role: 'style', source: 'url', url: 'https://example.test/ref.png', denoiseStrength: 0.1 },
      ],
    }));
  });

  it('P3 player vagina reads the three description fields of 角色.身体', async () => {
    await flow('P3', {}, (h) => h.svc.generateSecretPartImage({
      characterName: PLAYER_PSEUDO_NPC_ID, part: 'vagina', backend: 'sd_webui',
    }));
  });

  it('P4 a lock conflict throws', async () => {
    await flow('P4', {}, async (h) => {
      h.svc.state.lockGeneration('林暖::breast');
      return h.svc.generateSecretPartImage({ ...SECRET, backend: 'novelai' });
    });
  });

  it('P5 provider throws', async () => {
    await flow('P5', { providerFail: { novelai: 'secret provider exploded' } }, (h) => h.svc.generateSecretPartImage({ ...SECRET, backend: 'novelai' }));
  });

  // Extra case beyond the 29 of the plan: the civitai branch of the secret-part flow, and the player breast fields.
  it('P6 player breast with civitai, a LoRA shelf and an asset reference', async () => {
    await flow('P6', {
      edit: (t) => {
        imageConfig(t).civitai = { ...(imageConfig(t).civitai as Json), loras: [loraItem()] };
      },
      fileReader: true,
      seed: async (h) => { await h.seedAsset('asset_ref_p6', 'p6-reference'); },
    }, (h) => h.svc.generateSecretPartImage({
      characterName: PLAYER_PSEUDO_NPC_ID, part: 'breast', backend: 'civitai',
      references: [{ id: 'ref_p6', role: 'source', source: 'asset', assetId: 'asset_ref_p6', denoiseStrength: 0.4 }],
    }));
  });
});

describe('ImageService flows · regenerate', () => {
  const REGEN = { positivePrompt: 'masterpiece, 1girl, lantern', negativePrompt: 'lowres', width: 896, height: 1152 };

  it('R1 scene', async () => {
    await flow('R1', {}, (h) => h.svc.regenerateFromPrompts({ ...REGEN, backend: 'novelai', subjectType: 'scene', references: [dataUrlRef({ assetId: 'asset_r1' })] }));
  });

  it('R2 character with civitai', async () => {
    await flow('R2', {
      edit: (t) => {
        imageConfig(t).civitai = { ...(imageConfig(t).civitai as Json), loras: [loraItem()] };
      },
    }, (h) => h.svc.regenerateFromPrompts({
      ...REGEN, backend: 'civitai', subjectType: 'character', targetCharacter: '关宇', composition: 'full-length', artStyle: '写实',
    }));
  });

  it('R3 secret part with a previous secret image', async () => {
    await flow('R3', {
      edit: (t) => {
        npcList(t)[0]['图片档案'] = {
          生图历史: [{ id: 'old_secret_r3', status: 'complete', composition: 'secret_part', part: 'vagina', createdAt: 100 }],
          最近生图结果: 'old_secret_r3', 已选头像图片ID: '', 已选立绘图片ID: '', 已选背景图片ID: '',
          香闺秘档: { 小穴: { id: 'old_secret_r3', status: 'complete', part: 'vagina', createdAt: 100 } },
        };
      },
      seed: async (h) => { await h.seedAsset('old_secret_r3'); },
    }, (h) => h.svc.regenerateFromPrompts({
      ...REGEN, backend: 'novelai', subjectType: 'secret_part', targetCharacter: '林暖', part: 'vagina', artStyle: '二次元',
    }));
  });

  it('R4 character without targetCharacter throws', async () => {
    await flow('R4', {}, (h) => h.svc.regenerateFromPrompts({ ...REGEN, backend: 'novelai', subjectType: 'character' }));
  });

  it('R5 secret part without part throws', async () => {
    await flow('R5', {}, (h) => h.svc.regenerateFromPrompts({ ...REGEN, backend: 'novelai', subjectType: 'secret_part', targetCharacter: '林暖' }));
  });

  // Extra case beyond the 29 of the plan: the lock check of the regenerate flow.
  it('R7 secret part lock conflict throws', async () => {
    await flow('R7', {}, async (h) => {
      h.svc.state.lockGeneration('林暖::vagina');
      return h.svc.regenerateFromPrompts({ ...REGEN, backend: 'novelai', subjectType: 'secret_part', targetCharacter: '林暖', part: 'vagina' });
    });
  });

  it('R6 provider throws and the lock is released', async () => {
    await flow('R6', { providerFail: { novelai: 'regen provider exploded' } }, (h) => h.svc.regenerateFromPrompts({
      ...REGEN, backend: 'novelai', subjectType: 'character', targetCharacter: '林暖',
    }));
  });
});

describe('ImageService flows · other', () => {
  it('M1 a load with stuck tasks recovers them and toasts', async () => {
    const h = await makeHarness(undefined, false);
    startRecording(h);
    const tree = baseTree();
    imageConf(tree).tasks = [
      { id: 'img_task_1_100', status: 'pending', subjectType: 'scene', width: 1024, height: 576, backend: 'novelai', createdAt: 100, updatedAt: 100 },
      { id: 'img_task_2_200', status: 'tokenizing', subjectType: 'character', targetCharacter: '林暖', width: 832, height: 1216, backend: 'novelai', createdAt: 200, updatedAt: 200 },
      { id: 'img_task_3_300', status: 'generating', subjectType: 'scene', width: 1024, height: 576, backend: 'civitai', createdAt: 300, updatedAt: 300 },
      { id: 'img_task_4_400', status: 'complete', subjectType: 'scene', width: 1024, height: 576, backend: 'novelai', resultAssetId: 'asset_done', createdAt: 400, updatedAt: 400 },
    ];
    const outcome = await record(async () => {
      h.sm.loadTree(tree);
      return h.svc.getTaskQueue().getAll();
    });
    await snapshotCase('M1', h, outcome);
  });

  it('M2 the 51st finished task evicts the oldest, cleans orphan references and toasts', async () => {
    await flow('M2', {
      edit: (t) => {
        const tasks: Json[] = [];
        for (let i = 0; i < 50; i++) {
          tasks.push({
            id: `img_task_${i + 1}_${1000 + i}`, status: 'complete', subjectType: 'scene', width: 1024, height: 576, backend: 'novelai',
            resultAssetId: `asset_old_${i}`, createdAt: 1000 + i, updatedAt: 1000 + i,
            ...(i === 0 ? { providerMeta: { reference: { mode: 'image_to_image', sourceAssetIds: ['ref_kept', 'ref_orphan', ''], provider: 'novelai' } } } : {}),
          });
        }
        imageConf(t).tasks = tasks;
        imageConf(t).referenceLibrary = [{ id: 'lib1', assetId: 'ref_kept', name: 'kept' }];
      },
      seed: async (h) => { await h.seedAsset('ref_kept'); await h.seedAsset('ref_orphan'); },
    }, (h) => h.svc.generateSceneImage({ ...SCENE, backend: 'novelai' }));
  });

  it('M3 setNpcSecretPart and clearNpcSecretPart', async () => {
    await flow('M3', {
      edit: (t) => {
        npcList(t)[0]['图片档案'] = {
          生图历史: [], 最近生图结果: '', 已选头像图片ID: '', 已选立绘图片ID: '', 已选背景图片ID: '',
          香闺秘档: { 胸部: { id: 'secret_old', status: 'complete', part: 'breast', createdAt: 100 } },
        };
      },
      seed: async (h) => { await h.seedAsset('secret_old'); await h.seedAsset('secret_new'); },
    }, async (h) => {
      h.svc.setNpcSecretPart('林暖', 'breast', 'secret_new');
      h.svc.setNpcSecretPart('林暖', 'breast', 'secret_new');
      h.svc.setNpcSecretPart('林暖', 'anus', 'secret_anus');
      h.svc.clearNpcSecretPart('林暖', 'breast');
      h.svc.clearNpcSecretPart('林暖', 'vagina');
    });
  });

  it('M4 deleteNpcImage and clearNpcHistory', async () => {
    await flow('M4', {
      edit: (t) => {
        npcList(t)[0]['图片档案'] = {
          生图历史: [
            { id: 'h3', status: 'complete', composition: 'portrait', createdAt: 300 },
            { id: 'h2', status: 'complete', composition: 'full-length', createdAt: 200 },
            { id: 'h1', status: 'complete', composition: 'secret_part', part: 'breast', createdAt: 100 },
          ],
          最近生图结果: 'h3', 已选头像图片ID: 'h3', 已选立绘图片ID: 'h2', 已选背景图片ID: 'bg1',
          香闺秘档: { 胸部: { id: 'h1', status: 'complete', part: 'breast', createdAt: 100 }, 屁穴: { id: 'sec_anus', status: 'complete', part: 'anus', createdAt: 90 } },
        };
      },
      seed: async (h) => { for (const id of ['h1', 'h2', 'h3', 'bg1', 'sec_anus']) await h.seedAsset(id); },
    }, async (h) => {
      h.svc.deleteNpcImage('林暖', 'h3');
      h.svc.deleteNpcImage('林暖', '');
      h.svc.clearNpcHistory('林暖');
    });
  });

  it('M5 collectSceneRoleAnchors', async () => {
    await flow('M5', {}, async (h) => {
      const withAnchors = h.svc.collectSceneRoleAnchors();
      h.sm.set('系统.扩展.image.characterAnchors', []);
      const noAnchors = h.svc.collectSceneRoleAnchors();
      h.sm.set('系统.扩展.image.characterAnchors', [{ npcName: '林暖', enabled: true, sceneLink: true, positive: '   ' }]);
      const blankAnchor = h.svc.collectSceneRoleAnchors();
      h.sm.set('社交.关系', [{ 名称: '林暖', 是否在场: false }]);
      const nobodyPresent = h.svc.collectSceneRoleAnchors();
      h.sm.delete('社交.关系');
      const noList = h.svc.collectSceneRoleAnchors();
      return { withAnchors, noAnchors, blankAnchor, nobodyPresent, noList };
    });
  });
});
