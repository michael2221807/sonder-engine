// @vitest-environment happy-dom
/**
 * ImagePanel behaviour lock (refactor R7, step 0).
 *
 * The real ImagePanel.vue is mounted with a real pinia engine-state store (backed by a real StateManager), the real
 * zh-CN i18n, a real event bus and a memory router at `/game/image?npc=林暖`. Only the services the panel injects
 * (imageService, aiService) are fakes, and they record every call that changes something or starts a generation.
 * Only leaf components are stubbed (ImageDisplay, ImageViewer, RegenerateSameModal, CivitaiLoraShelf,
 * MultiReferencePicker, Tooltip); a stub renders every prop it receives into `data-props`, so the arguments the panel
 * passes down are part of the html. Teleported content (the delete confirmation, select lists) renders in place.
 *
 * What a case did is stored byte for byte in `../__snapshots__/image-panel/<id>.json` (service calls, event bus
 * emits and state writes, in order) and `<id>.html` (the normalised DOM after the case; extra steps get
 * `<id>.<step>.html`). A refactor of ImagePanel.vue must leave every file unchanged. Snapshots are never rewritten
 * with `-u` during the refactor; a changed snapshot is a failed step.
 *
 * Determinism: Date, setTimeout and clearTimeout are faked, Math.random is fixed, the timezone is UTC and the
 * locale-dependent Date.prototype.toLocale*String methods are pinned to an ISO form, `data-v-*` attributes are
 * removed, and long strings in recorded arguments are stored as length + sha1 + head.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createHash } from 'node:crypto';
import { h, nextTick, type Component, type SetupContext } from 'vue';
import ImagePanel from '../ImagePanel.vue';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import ImageViewer from '@/ui/components/image/ImageViewer.vue';
import RegenerateSameModal from '@/ui/components/image/RegenerateSameModal.vue';
import CivitaiLoraShelf from '@/ui/components/image/CivitaiLoraShelf.vue';
import MultiReferencePicker from '@/ui/components/shared/MultiReferencePicker.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { i18n } from '@/ui/i18n';
import { eventBus } from '@/engine/core/event-bus';
import { StateManager } from '@/engine/core/state-manager';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import { getDefaultModelBundles } from '@/engine/image/transformer-presets';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SNAPSHOT_DIR = '../__snapshots__/image-panel';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const FIXED_RANDOM = 0.123456;
const UNDEFINED_MARK = '__undefined__';
const LONG_STRING = 300;
const T0 = 1790000000000;

type Json = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

/** The tianming pack's own transformer defaults, read straight from disk (the pack loader helper needs a Node URL). */
function loadPackTransformerDefaults(): Record<string, unknown> {
  const file = resolve(process.cwd(), 'public/packs/tianming/prompts/transformer-defaults.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const tr = (key: string, params?: Record<string, unknown>): string => String(i18n.global.t(key, params ?? {}));

// ── recording and serialisation ─────────────────────────────────────────────

interface Recorder {
  calls: Array<[string, unknown[]]>;
  emits: Array<[string, unknown]>;
  writes: Array<[string, unknown]>;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => {
    if (v === undefined) return UNDEFINED_MARK;
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'string' && v.length > LONG_STRING) {
      return `<str len=${v.length} sha1=${createHash('sha1').update(v).digest('hex').slice(0, 12)} head=${v.slice(0, 40)}>`;
    }
    if (v instanceof Set) return { __set: [...v] };
    if (typeof File !== 'undefined' && v instanceof File) return { __file: v.name, size: v.size, type: v.type };
    if (typeof Blob !== 'undefined' && v instanceof Blob) return { __blob: v.size, type: v.type };
    return v;
  }) ?? 'null') as unknown;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function normalizeHtml(html: string): string {
  // The html() pretty-printer picks its line ending from the input, so a CRLF checkout
  // (core.autocrlf=true) would otherwise turn every line into CRLF.
  return html.replace(/\r\n/g, '\n').replace(/ data-v-[0-9a-f]{8}=""/g, '').replace(/ data-v-[0-9a-f]{8}/g, '') + '\n';
}

// ── fixtures ────────────────────────────────────────────────────────────────

const BLOB_ASSETS: Record<string, string> = { sec_breast_1: 'secret-breast', img_1: 'img-one', img_3: 'img-three' };

function baseTree(backend: string): Json {
  return {
    系统: {
      nsfwMode: false,
      扩展: {
        image: {
          enabled: true,
          config: {
            defaultBackend: backend,
            reference: {},
            sceneHistoryLimit: 10,
            civitai: { allowMatureContent: false },
          },
          artistPresets: [
            { id: 'ap1', name: '画师甲', scope: 'npc', artistString: 'artist:foo, artist:bar', positive: 'soft light', negative: 'blurry' },
            { id: 'ap2', name: '场景画师', scope: 'scene', artistString: 'artist:scenic', positive: 'wide shot', negative: '' },
            {
              id: 'png_1', name: 'PNG风', scope: 'npc', artistString: '', positive: 'masterpiece, best quality', negative: 'lowres',
              pngMeta: { source: 'a1111', originalPrompt: 'masterpiece', rawText: 'raw text', replicateParams: false, parsedParams: { steps: 28, sampler: 'k_euler' } },
            },
          ],
          characterAnchors: [
            { id: 'anc1', name: '林暖锚点', npcName: '林暖', enabled: true, defaultAppend: true, sceneLink: true, positive: '1girl, black hair', negative: 'bad hands' },
          ],
          transformerPresets: [{ id: 'tf1', name: 'NPC转换', scope: 'npc', prompt: 'convert the description' }],
          sceneArchive: {
            生图历史: [
              { id: 'scn_1', status: 'complete', createdAt: T0 + 5000, positivePrompt: 'courtyard at night', negativePrompt: 'lowres', width: 1024, height: 576, backend: 'novelai', model: 'nai-v4' },
              { id: 'scn_2', status: 'failed', createdAt: T0 + 1000, width: 1024, height: 576 },
            ],
            当前壁纸图片ID: 'scn_1',
          },
          persistentWallpaper: '',
        },
      },
    },
    世界: { 时间: { 年: 1, 月: 2, 日: 3, 小时: 9, 分钟: 30 }, 天气: '晴', 节日: '', 环境: [] },
    角色: {
      基础信息: { 姓名: '主角', 当前位置: '酒肆' },
      图片档案: { 生图历史: [{ id: 'pimg_1', status: 'complete', createdAt: T0 + 2000, composition: 'portrait', positivePrompt: 'player portrait', negativePrompt: 'lowres', width: 832, height: 1216, backend: 'novelai', model: 'nai-v4' }] },
    },
    社交: {
      关系: [
        {
          名称: '林暖', 性别: '女', 年龄: 18, 是否主要角色: true, 是否在场: true, 类型: '重要', 描述: '酒肆老板娘', 外貌描述: '眉目清亮，黑发及腰',
          身材描写: '纤细修长', 衣着风格: '素色长裙', 性格特征: ['温柔', '机灵'],
          图片档案: {
            生图历史: [
              { id: 'img_1', status: 'complete', createdAt: T0 + 3000, composition: 'portrait', positivePrompt: '1girl, black hair', negativePrompt: 'lowres', width: 832, height: 1216, backend: 'novelai', model: 'nai-v4', apiConfigName: '图片API' },
              { id: 'img_2', status: 'failed', createdAt: T0 + 4000, composition: 'half-body', width: 832, height: 1216, backend: 'novelai' },
              {
                id: 'img_3', status: 'complete', createdAt: T0 + 6000, composition: 'full-length', positivePrompt: '1girl, full body', negativePrompt: 'bad anatomy', width: 832, height: 1216, backend: 'novelai',
                providerMeta: { reference: { mode: 'img2img', denoiseStrength: 0.6 } },
              },
            ],
            已选头像图片ID: 'img_1',
          },
        },
        { 名称: '关宇', 性别: '男', 年龄: 25, 是否主要角色: false, 是否在场: true, 类型: '普通', 描述: '游侠', 外貌描述: '剑眉星目' },
      ],
    },
    元数据: {
      叙事历史: [
        { role: 'user', content: '推门进去' },
        { role: 'assistant', content: '你推开酒肆的木门，暖黄的灯光洒在地上。\n林暖抬头对你笑了笑。', _metrics: { roundNumber: 1 } },
        { role: 'user', content: '点一壶酒' },
        { role: 'assistant', content: '林暖端来一壶温好的酒，窗外下起了小雨。', _metrics: { roundNumber: 2 } },
        { role: 'assistant', content: '关宇从角落里站起身，向你举杯。' },
      ],
    },
  };
}

function baseTasks(): Json[] {
  return [
    { id: 'task_done', subjectType: 'character', targetCharacter: '林暖', status: 'complete', resultAssetId: 'img_1', positivePrompt: '1girl, black hair', negativePrompt: 'lowres', width: 832, height: 1216, backend: 'novelai', createdAt: T0 + 3000, updatedAt: T0 + 3100 },
    { id: 'task_fail', subjectType: 'character', targetCharacter: '林暖', status: 'failed', error: 'upstream 500', positivePrompt: '1girl, retry me', width: 832, height: 1216, backend: 'novelai', createdAt: T0 + 4000, updatedAt: T0 + 4100 },
    { id: 'task_scene_run', subjectType: 'scene', status: 'generating', positivePrompt: 'courtyard, rain', width: 1024, height: 576, backend: 'novelai', createdAt: T0 + 5000, updatedAt: T0 + 5100 },
    { id: 'task_scene_done', subjectType: 'scene', status: 'complete', resultAssetId: 'scn_1', positivePrompt: 'courtyard at night', width: 1024, height: 576, backend: 'novelai', createdAt: T0 + 2500, updatedAt: T0 + 2600 },
  ];
}

// ── fake services ───────────────────────────────────────────────────────────

interface FakeOptions {
  backend: string;
  configured: boolean;
  tasks: Json[];
  packDefaults: Record<string, unknown> | undefined;
  regenFails: boolean;
  charFails: boolean;
}

interface Fake {
  imageService: unknown;
  aiService: unknown;
  queue: Json[];
}

function makeFake(rec: Recorder, opts: FakeOptions): Fake {
  const queue = opts.tasks.map((t) => ({ ...t }));
  const task = (id: string, extra: Json = {}): Json => ({
    id, status: 'complete', subjectType: 'character', resultAssetId: `${id}_asset`, width: 832, height: 1216, backend: opts.backend, createdAt: T0, updatedAt: T0, ...extra,
  });
  const record = (name: string) => (...args: unknown[]): void => { rec.calls.push([name, args.map(plain)]); };
  const recordAsync = (name: string, result: () => unknown) => async (...args: unknown[]): Promise<unknown> => {
    rec.calls.push([name, args.map(plain)]);
    return result();
  };
  const cache = {
    retrieve: async (id: string): Promise<unknown> => {
      rec.calls.push(['cache.retrieve', [id]]);
      return id in BLOB_ASSETS ? { blob: new Blob([BLOB_ASSETS[id]], { type: 'image/png' }), metadata: { mimeType: 'image/png' } } : null;
    },
    store: recordAsync('cache.store', () => undefined),
    delete: recordAsync('cache.delete', () => undefined),
  };
  const imageService = {
    getTaskQueue: () => ({
      getAll: () => queue.slice(),
      remove: (id: string) => {
        rec.calls.push(['queue.remove', [id]]);
        const i = queue.findIndex((t) => t.id === id);
        if (i >= 0) queue.splice(i, 1);
      },
    }),
    getAssetCache: () => cache,
    getTransformerDefaults: () => opts.packDefaults,
    getUnderstandingConfig: () => ({ defaultEngine: 'civitai_vlm' }),
    getGeneralLlmInfo: () => ({ available: true, model: 'gpt-test' }),
    collectSceneRoleAnchors: () => {
      rec.calls.push(['collectSceneRoleAnchors', []]);
      return { presentNpcs: ['林暖', '关宇'], roleAnchors: [{ name: '林暖', positive: '1girl, black hair', negative: 'bad hands' }, { name: '关宇', positive: '1boy' }] };
    },
    generateCharacterImage: recordAsync('generateCharacterImage', () => (opts.charFails ? task('gen_char_fail', { status: 'failed', error: 'no image API configured', resultAssetId: undefined }) : task('gen_char'))),
    generateSceneImage: recordAsync('generateSceneImage', () => task('gen_scene', { subjectType: 'scene' })),
    generateSecretPartImage: recordAsync('generateSecretPartImage', () => task('gen_secret', { subjectType: 'secret_part' })),
    regenerateFromPrompts: recordAsync('regenerateFromPrompts', () => (opts.regenFails ? task('regen_fail', { status: 'failed', error: 'quota exceeded' }) : task('regen_ok'))),
    analyzeImage: recordAsync('analyzeImage', () => ({ provider: 'civitai_vlm', task: 'both', positiveDraft: 'draft', negativeDraft: '', tags: [], caption: 'cap', raw: {} })),
    setNpcAvatar: record('setNpcAvatar'),
    setNpcPortrait: record('setNpcPortrait'),
    setNpcBackground: record('setNpcBackground'),
    setNpcSecretPart: record('setNpcSecretPart'),
    clearNpcAvatar: record('clearNpcAvatar'),
    clearNpcPortrait: record('clearNpcPortrait'),
    clearNpcBackground: record('clearNpcBackground'),
    clearNpcSecretPart: record('clearNpcSecretPart'),
    deleteNpcImage: record('deleteNpcImage'),
    clearNpcHistory: record('clearNpcHistory'),
    state: {
      getReferenceLibrary: () => [],
      addReferenceEntry: record('state.addReferenceEntry'),
      removeReferenceEntry: record('state.removeReferenceEntry'),
      isAssetReferencedByTasks: () => false,
      setSceneWallpaper: record('state.setSceneWallpaper'),
      clearSceneWallpaper: record('state.clearSceneWallpaper'),
      setPersistentWallpaper: record('state.setPersistentWallpaper'),
      clearPersistentWallpaper: record('state.clearPersistentWallpaper'),
    },
  };
  const aiService = {
    getImageConfigForBackend: (bk: string) => (opts.configured
      ? { id: 'img_cfg', name: '图片API', url: `https://img.test/${bk}`, apiKey: 'key', model: `model-${bk}` }
      : undefined),
    generate: recordAsync('ai.generate', () => ''),
  };
  return { imageService, aiService, queue };
}

// ── leaf stubs: every prop the panel passes is rendered into data-props ─────

function leafStub(tag: string, real: Component, renderSlot: boolean): Component {
  const source = real as { props?: unknown; emits?: unknown };
  const options = {
    name: `${tag}Stub`,
    inheritAttrs: false,
    props: source.props,
    emits: source.emits,
    setup(props: Record<string, unknown>, ctx: SetupContext) {
      return () => h(`${tag}-stub`, { ...ctx.attrs, 'data-props': JSON.stringify(plain(props)) }, renderSlot ? ctx.slots.default?.() : undefined);
    },
  };
  return options as unknown as Component;
}

const STUBS = {
  ImageDisplay: leafStub('image-display', ImageDisplay, false),
  ImageViewer: leafStub('image-viewer', ImageViewer, false),
  RegenerateSameModal: leafStub('regenerate-same-modal', RegenerateSameModal, false),
  CivitaiLoraShelf: leafStub('civitai-lora-shelf', CivitaiLoraShelf, false),
  MultiReferencePicker: leafStub('multi-reference-picker', MultiReferencePicker, false),
  Tooltip: leafStub('tooltip', Tooltip, true),
  teleport: true,
};

// ── harness ─────────────────────────────────────────────────────────────────

interface MountOptions {
  backend?: string;
  configured?: boolean;
  nsfw?: boolean;
  tasks?: Json[];
  edit?: (tree: Json) => void;
  packDefaults?: Record<string, unknown>;
  regenFails?: boolean;
  charFails?: boolean;
  keepMountRecords?: boolean;
  query?: string | null;
}

interface Harness {
  wrapper: VueWrapper;
  rec: Recorder;
  fake: Fake;
  html: () => string;
}

let mounted: VueWrapper | null = null;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await nextTick();
}

async function mountPanel(options: MountOptions = {}): Promise<Harness> {
  const backend = options.backend ?? 'novelai';
  const rec: Recorder = { calls: [], emits: [], writes: [] };
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useEngineStateStore();
  const sm = new StateManager();
  store.linkStateManager(sm);
  const tree = baseTree(backend);
  if (options.nsfw) (tree['系统'] as Json)['nsfwMode'] = true;
  options.edit?.(tree);
  sm.loadTree(tree);
  store.markLoaded('test-pack', 'test-profile', 'test-slot');

  const configured = options.configured ?? true;
  const api = useAPIManagementStore();
  api.apiConfigs = configured
    ? [{ id: 'img_cfg', name: '图片API', apiCategory: 'image', backend, provider: 'openai', url: 'https://img.test', apiKey: 'key', model: `model-${backend}`, enabled: true } as never]
    : [];
  api.apiAssignments = configured ? [{ type: `imageGen_${backend}`, apiId: 'img_cfg' } as never] : [];

  const fake = makeFake(rec, {
    backend,
    configured,
    tasks: options.tasks ?? baseTasks(),
    packDefaults: options.packDefaults,
    regenFails: options.regenFails ?? false,
    charFails: options.charFails ?? false,
  });

  const origSetValue = store.setValue.bind(store);
  vi.spyOn(store, 'setValue').mockImplementation((path: string, value: unknown) => {
    rec.writes.push([path, plain(value)]);
    origSetValue(path, value);
  });
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    if (event !== 'engine:state-changed') rec.emits.push([String(event), plain(payload)]);
    origEmit(event, payload);
  });

  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/game/image', component: { template: '<div />' } }] });
  const query = options.query === undefined ? '林暖' : options.query;
  await router.push(query ? `/game/image?npc=${encodeURIComponent(query)}` : '/game/image');
  await router.isReady();

  const wrapper = mount(ImagePanel, {
    global: {
      plugins: [pinia, i18n, router],
      provide: { imageService: fake.imageService, aiService: fake.aiService },
      stubs: STUBS,
    },
  });
  mounted = wrapper;
  await flush();
  if (!options.keepMountRecords) {
    rec.calls.length = 0;
    rec.emits.length = 0;
    rec.writes.length = 0;
  }
  return { wrapper, rec, fake, html: () => normalizeHtml(wrapper.html()) };
}

// ── interaction helpers ─────────────────────────────────────────────────────

const rootOf = (w: VueWrapper): HTMLElement => w.element as unknown as HTMLElement;
const vmOf = (w: VueWrapper): Record<string, unknown> => w.vm as unknown as Record<string, unknown>;
async function setVm(w: VueWrapper, values: Json): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    vmOf(w)[k] = v;
    await flush();
  }
}
async function callVm(w: VueWrapper, name: string, ...args: unknown[]): Promise<void> {
  const fn = vmOf(w)[name];
  if (typeof fn !== 'function') throw new Error(`vm has no function ${name}`);
  await (fn as Fn)(...args);
  await flush();
}
const TABS = ['manual', 'gallery', 'scene', 'queue', 'history', 'presets', 'rules', 'settings'] as const;
async function selectTab(w: VueWrapper, key: (typeof TABS)[number]): Promise<void> {
  const el = w.findAll('.aga-tab__btn')[TABS.indexOf(key)];
  if (!el) throw new Error(`no tab ${key}`);
  await el.trigger('click');
  await flush();
}
function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
async function click(w: VueWrapper, text: string, nth = 0): Promise<void> {
  const matches = Array.from(rootOf(w).querySelectorAll('button')).filter((b) => textOf(b) === text);
  const el = matches[nth];
  if (!el) throw new Error(`no button "${text}" #${nth} (found ${matches.length})`);
  el.click();
  await flush();
}
async function clickSelector(w: VueWrapper, selector: string, nth = 0): Promise<void> {
  const el = rootOf(w).querySelectorAll(selector)[nth] as HTMLElement | undefined;
  if (!el) throw new Error(`no element ${selector} #${nth}`);
  el.click();
  await flush();
}
const modalStub = (w: VueWrapper) => w.findComponent({ name: 'regenerate-same-modalStub' });

/** Locks one case: recorded calls/emits/writes plus the html of every named step. */
async function lock(id: string, h: Harness, htmls: Record<string, string> = {}): Promise<void> {
  await expect(serialize({ calls: h.rec.calls, emits: h.rec.emits, writes: h.rec.writes })).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
  const main = htmls.main ?? h.html();
  await expect(main).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.html`);
  for (const [step, html] of Object.entries(htmls)) {
    if (step !== 'main') await expect(html).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.${step}.html`);
  }
}
const names = (h: Harness): string[] => h.rec.calls.map(([n]) => n);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
  const iso = function (this: Date): string { return Number.isNaN(this.getTime()) ? 'Invalid Date' : this.toISOString(); };
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(iso);
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(iso);
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(iso);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  eventBus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
// T1–T8: one html per tab
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · tabs', () => {
  TABS.forEach((key, i) => {
    it(`T${i + 1} ${key} tab renders`, async () => {
      const h = await mountPanel({ nsfw: key === 'manual' });
      await selectTab(h.wrapper, key);
      expect(h.wrapper.find('.tab-content').exists()).toBe(true);
      await lock(`T${i + 1}-${key}`, h);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G1–G4: manual generation
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · manual generation', () => {
  it('G1 default novelai: add to queue', async () => {
    const h = await mountPanel();
    await click(h.wrapper, tr('image.manual.addToQueue'));
    expect(names(h)).toEqual(['generateCharacterImage']);
    await lock('G1-manual-default', h);
  });

  it('G2 artist string + size preset + multi reference + anchor on volcengine', async () => {
    const h = await mountPanel({ backend: 'volcengine' });
    await setVm(h.wrapper, { composition: 'custom', customComposition: '坐在窗边看雨' });
    await setVm(h.wrapper, { sizeScale: '1x', sizePreset: '3:4' });
    await setVm(h.wrapper, {
      selectedArtistPreset: 'ap1',
      selectedPngPreset: 'png_1',
      extraPrompt: '雨天，窗外有灯',
      npcReferenceEnabled: true,
    });
    await setVm(h.wrapper, {
      npcReferenceItems: [
        { id: 'mr1', dataUrl: 'data:image/png;base64,AAAA', label: '图1' },
        { id: 'mr2', dataUrl: 'data:image/png;base64,BBBB', assetId: 'img_1', label: '头像' },
      ],
      npcReferenceDenoise: 0.7,
    });
    const before = h.html();
    await click(h.wrapper, tr('image.manual.addToQueue'));
    expect(names(h)).toEqual(['generateCharacterImage']);
    await lock('G2-manual-multiref', h, { main: h.html(), before });
  });

  it('G3 backend not configured: reference without a picture warns, failed task is shown', async () => {
    const h = await mountPanel({ configured: false, charFails: true });
    await setVm(h.wrapper, { npcReferenceEnabled: true });
    await click(h.wrapper, tr('image.manual.addToQueue'));
    expect(h.rec.emits.some(([e]) => e === 'ui:toast')).toBe(true);
    await lock('G3-manual-unconfigured', h);
  });

  it('G4 foreground mode: confirm overlay, go back, confirm again and submit', async () => {
    const h = await mountPanel();
    await setVm(h.wrapper, { backgroundMode: false });
    await click(h.wrapper, tr('image.manual.generateNow', { comp: tr('image.manual.composition.portrait') }));
    const confirm = h.html();
    expect(h.wrapper.find('.confirm-overlay').exists()).toBe(true);
    await click(h.wrapper, tr('image.confirm.goBack'));
    expect(h.wrapper.find('.confirm-overlay').exists()).toBe(false);
    const cancelled = h.html();
    await click(h.wrapper, tr('image.manual.generateNow', { comp: tr('image.manual.composition.portrait') }));
    await click(h.wrapper, tr('image.confirm.confirmGenerate'));
    vi.advanceTimersByTime(450);
    await flush();
    expect(names(h)).toEqual(['generateCharacterImage']);
    await lock('G4-manual-foreground', h, { main: h.html(), confirm, cancelled });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S1–S2: scene generation
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · scene generation', () => {
  it('S1 pick rounds and NPCs, generate a snapshot scene', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'scene');
    await clickSelector(h.wrapper, '.round-selector__item', 1);
    await click(h.wrapper, tr('image.scene.deselectAll'));
    await clickSelector(h.wrapper, '.npc-selector__item', 0);
    await clickSelector(h.wrapper, '.npc-selector__item', 1);
    await setVm(h.wrapper, { sceneExtraPrompt: '黄昏，窗边', selectedScenePreset: 'ap2' });
    await click(h.wrapper, tr('image.scene.generateByNarrative'));
    expect(names(h)).toContain('generateSceneImage');
    await lock('S1-scene-snapshot', h);
  });

  it('S2 portrait orientation, landscape mode, history limit and queue clearing', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'scene');
    await click(h.wrapper, tr('image.scene.orientationPortrait'));
    await click(h.wrapper, tr('image.scene.modeLandscape'));
    await setVm(h.wrapper, { sceneResolution: '576x1024', sceneArchiveLimitDraft: '20' });
    await click(h.wrapper, tr('image.scene.applyLimit'));
    await click(h.wrapper, tr('image.scene.clearCompleted'));
    await click(h.wrapper, tr('image.scene.generateByNarrative'));
    expect(names(h)).toContain('generateSceneImage');
    await lock('S2-scene-portrait', h);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1–P2: secret parts
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · secret parts', () => {
  it('P1 one part and all parts', async () => {
    const h = await mountPanel({ nsfw: true });
    await setVm(h.wrapper, { secretStyle: 'anime', secretSizePreset: '3:4', secretExtraPrompt: '特写', secretArtistPreset: 'ap1' });
    await click(h.wrapper, tr('image.manual.secretGenerate'), 0);
    const afterOne = h.html();
    await click(h.wrapper, tr('image.manual.secretGenerateAll'));
    expect(names(h)).toEqual(['generateSecretPartImage', 'generateSecretPartImage', 'generateSecretPartImage', 'generateSecretPartImage']);
    await lock('P1-secret-parts', h, { main: h.html(), afterOne });
  });

  it('P2 reference version of a part', async () => {
    const h = await mountPanel({
      nsfw: true,
      edit: (tree) => {
        const npc = ((tree['社交'] as Json)['关系'] as Json[])[0];
        (npc['图片档案'] as Json)['香闺秘档'] = { 胸部: { id: 'sec_breast_1' } };
      },
    });
    await click(h.wrapper, tr('image.manual.secretRefRedraw'));
    expect(names(h)).toEqual(['cache.retrieve', 'generateSecretPartImage']);
    await lock('P2-secret-reference', h);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// R1–R3: regenerate-same
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · regenerate same', () => {
  const REGEN_CONFIRM = { backend: 'novelai', positivePrompt: 'edited positive', negativePrompt: 'edited negative' };

  it('R1 from a queue task, then confirm', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'queue');
    await click(h.wrapper, tr('image.queue.action.regenPrompt'), 0);
    expect(modalStub(h.wrapper).exists()).toBe(true);
    const opened = h.html();
    modalStub(h.wrapper).vm.$emit('confirm', REGEN_CONFIRM);
    await flush();
    expect(names(h)).toEqual(['regenerateFromPrompts']);
    expect(modalStub(h.wrapper).exists()).toBe(false);
    await lock('R1-regen-from-task', h, { main: h.html(), opened });
  });

  it('R2 from a gallery image: reference redraw, cancel, plain, confirm with references', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'gallery');
    await clickSelector(h.wrapper, '.gallery-npc-btn', 1);
    await click(h.wrapper, tr('image.gallery.action.refRedraw'), 0);
    const asReference = h.html();
    modalStub(h.wrapper).vm.$emit('cancel');
    await flush();
    expect(modalStub(h.wrapper).exists()).toBe(false);
    await click(h.wrapper, tr('image.gallery.action.regenSame'), 0);
    const plainRegen = h.html();
    modalStub(h.wrapper).vm.$emit('confirm', {
      ...REGEN_CONFIRM,
      references: [{ id: 'ref_a', role: 'source', source: 'asset', assetId: 'img_1', denoiseStrength: 0.6 }],
    });
    await flush();
    expect(names(h)).toEqual(['regenerateFromPrompts']);
    await lock('R2-regen-from-gallery', h, { main: h.html(), asReference, plainRegen });
  });

  it('R3 from a history entry; a failed task keeps the modal open', async () => {
    const h = await mountPanel({ regenFails: true });
    await selectTab(h.wrapper, 'history');
    await click(h.wrapper, tr('image.history.action.regenSame'), 0);
    const opened = h.html();
    modalStub(h.wrapper).vm.$emit('confirm', REGEN_CONFIRM);
    await flush();
    expect(names(h)).toEqual(['regenerateFromPrompts']);
    expect(modalStub(h.wrapper).exists()).toBe(true);
    await lock('R3-regen-from-history', h, { main: h.html(), opened });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C1–C4 (+C5): create, edit, delete — the sequence of state writes is the lock
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · create / edit / delete', () => {
  it('C1 artist presets: create, save, delete, toggle replicate params', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'presets');
    await click(h.wrapper, tr('image.presets.newPreset'));
    await setVm(h.wrapper, { newPresetName: '新画师串', newPresetArtist: 'artist:new', newPresetPositive: 'pos', newPresetNegative: 'neg' });
    await click(h.wrapper, tr('image.presets.saveChanges'));
    const saved = h.html();
    await click(h.wrapper, tr('image.presets.deletePreset'));
    await setVm(h.wrapper, { selectedPresetId: 'png_1' });
    await callVm(h.wrapper, 'loadPresetIntoEditor');
    await callVm(h.wrapper, 'toggleReplicateParams', true);
    expect(h.rec.writes.length).toBe(4);
    await lock('C1-artist-presets', h, { main: h.html(), saved });
  });

  it('C2 rule templates: create, edit, save, switch scope, delete, save active', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'rules');
    await click(h.wrapper, tr('image.rules.newRule'));
    await setVm(h.wrapper, { editRuleName: '我的NPC规则', editBaseRule: 'base rule', editAnchorRule: 'anchor rule', editNoAnchorFallback: 'fallback', editOutputFormat: 'format' });
    await click(h.wrapper, tr('image.rules.saveRule'));
    await click(h.wrapper, tr('image.rules.sceneTransformRule'));
    await click(h.wrapper, tr('image.rules.newRule'));
    await click(h.wrapper, tr('image.rules.deleteCurrentRule'));
    await click(h.wrapper, tr('image.rules.saveActive'));
    expect(h.rec.writes.length).toBe(5);
    await lock('C2-rule-templates', h);
  });

  it('C3 model rulesets: create, edit, save, enable, compat, delete', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'rules');
    await clickSelector(h.wrapper, '.model-ruleset-toggle');
    await click(h.wrapper, tr('image.rules.newRuleset'));
    await setVm(h.wrapper, { editModelRulesetName: '我的规则集', editModelRulesetBase: 'base model rule', editModelRulesetAnchor: 'anchor model rule' });
    await click(h.wrapper, tr('image.rules.saveRuleset'));
    await callVm(h.wrapper, 'toggleModelRulesetEnabled', true);
    await callVm(h.wrapper, 'toggleModelRulesetCompat', true);
    const expanded = h.html();
    await click(h.wrapper, tr('image.rules.deleteCurrent'));
    expect(h.rec.writes.length).toBe(5);
    await lock('C3-model-rulesets', h, { main: h.html(), expanded });
  });

  it('C4 anchors: extract without NPC, select, edit, save, toggle, delete', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'presets');
    await callVm(h.wrapper, 'extractAnchor');
    const extractError = h.html();
    await clickSelector(h.wrapper, '.anchor-list .preset-item', 0);
    await setVm(h.wrapper, { editAnchorName: '改名锚点', editAnchorPositive: 'new positive', editAnchorNegative: 'new negative' });
    await click(h.wrapper, tr('image.presets.anchorSave'));
    await callVm(h.wrapper, 'toggleAnchorProp', 'enabled', false);
    await callVm(h.wrapper, 'toggleAnchorProp', 'sceneLink', false);
    const selected = h.html();
    await click(h.wrapper, tr('image.presets.anchorDelete'));
    expect(h.rec.writes.length).toBe(4);
    await lock('C4-anchors', h, { main: h.html(), extractError, selected });
  });

  it('C5 transformer presets: create, save, delete', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'presets');
    await setVm(h.wrapper, { newTransformerName: '我的转换器' });
    await click(h.wrapper, tr('image.presets.addNew'));
    await setVm(h.wrapper, { editTransformerPrompt: 'transform prompt' });
    await click(h.wrapper, tr('image.presets.saveChanges'), 0);
    expect(h.rec.writes.length).toBeGreaterThanOrEqual(1);
    await lock('C5-transformer-presets', h);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M1–M3: onMounted seeding of built-in rulesets and rule templates
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · seeding on mount', () => {
  const staleRulesets = (): Json[] => {
    const first = getDefaultModelBundles(undefined)[0];
    return [
      { id: first.id, name: '旧名字', enabled: true, compatMode: true, baseModelRule: 'old base', anchorModeModelRule: 'old anchor', serializationStrategy: 'nai_character_segments', npcTemplateId: '', sceneTemplateId: '', judgeTemplateId: '' },
      { id: 'mrs_user', name: '用户规则集', enabled: false, compatMode: false, baseModelRule: 'mine', anchorModeModelRule: 'mine', serializationStrategy: 'nai_character_segments', npcTemplateId: '', sceneTemplateId: '', judgeTemplateId: '' },
    ];
  };
  const staleTemplates = (): Json[] => [
    { id: 'rule_user', name: '用户规则', scope: 'npc', baseRule: 'mine', anchorRule: '', noAnchorFallback: '', outputFormat: '', transformerPresetId: '' },
  ];

  it('M1 empty tree is seeded with the defaults', async () => {
    const h = await mountPanel({ keepMountRecords: true });
    expect(h.rec.writes.map(([p]) => p)).toEqual(['系统.扩展.image.modelRulesets', '系统.扩展.image.ruleTemplates']);
    await lock('M1-seed-empty', h);
  });

  it('M2 existing built-ins are refreshed, user items kept', async () => {
    const h = await mountPanel({
      keepMountRecords: true,
      edit: (tree) => {
        const image = ((tree['系统'] as Json)['扩展'] as Json)['image'] as Json;
        image['modelRulesets'] = staleRulesets();
        image['ruleTemplates'] = staleTemplates();
      },
    });
    expect(h.rec.writes.length).toBe(2);
    await selectTab(h.wrapper, 'rules');
    await lock('M2-seed-existing', h);
  });

  it('M3 pack defaults always rewrite the built-ins', async () => {
    const packDefaults = loadPackTransformerDefaults();
    expect(Object.keys(packDefaults).length).toBeGreaterThan(0);
    const h = await mountPanel({
      keepMountRecords: true,
      packDefaults,
      edit: (tree) => {
        const image = ((tree['系统'] as Json)['扩展'] as Json)['image'] as Json;
        image['modelRulesets'] = staleRulesets();
        image['ruleTemplates'] = staleTemplates();
      },
    });
    expect(h.rec.writes.length).toBe(2);
    await lock('M3-seed-pack-defaults', h);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Y1: gallery bindings
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · gallery bindings', () => {
  it('Y1 avatar, background, persistent wallpaper, secret part, cancel, delete, clear', async () => {
    const h = await mountPanel({ nsfw: true });
    await selectTab(h.wrapper, 'gallery');
    await clickSelector(h.wrapper, '.gallery-npc-btn', 1);
    await click(h.wrapper, tr('image.gallery.action.setAvatar'), 0);
    await click(h.wrapper, tr('image.gallery.action.setBackground'), 0);
    await click(h.wrapper, tr('image.gallery.action.setPersistentWallpaper'), 0);
    await click(h.wrapper, tr('image.gallery.action.setSecretBreast'), 0);
    await click(h.wrapper, tr('image.gallery.action.cancelAvatar'), 0);
    await click(h.wrapper, tr('image.gallery.action.deleteImage'), 0);
    const confirmOpen = h.html();
    await click(h.wrapper, tr('image.delete.confirmLabel'));
    await click(h.wrapper, tr('image.gallery.clearRecords'));
    expect(names(h)).toEqual([
      'setNpcAvatar', 'setNpcBackground', 'state.setPersistentWallpaper', 'setNpcSecretPart', 'clearNpcAvatar', 'deleteNpcImage', 'clearNpcHistory',
    ]);
    await lock('Y1-gallery-bindings', h, { main: h.html(), confirmOpen });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// H1: history
// ════════════════════════════════════════════════════════════════════════════

describe('ImagePanel · history', () => {
  it('H1 filters, delete one, clear NPC and scene history', async () => {
    const h = await mountPanel();
    await selectTab(h.wrapper, 'history');
    const all = h.html();
    await setVm(h.wrapper, { historyFilter: 'scene' });
    const scene = h.html();
    await setVm(h.wrapper, { historyFilter: 'failed' });
    const failed = h.html();
    await setVm(h.wrapper, { historyFilter: 'all' });
    await click(h.wrapper, tr('image.history.action.deleteImage'), 0);
    await click(h.wrapper, tr('image.history.clearNpc'));
    await click(h.wrapper, tr('image.history.clearScene'));
    expect(names(h)).toContain('clearNpcHistory');
    await lock('H1-history', h, { main: h.html(), all, scene, failed });
  });
});
