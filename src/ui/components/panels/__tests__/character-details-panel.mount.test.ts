// @vitest-environment happy-dom
/**
 * CharacterDetailsPanel behaviour lock (refactor R7, step 7).
 *
 * The real CharacterDetailsPanel.vue is mounted with a real pinia engine-state store (backed by a real StateManager),
 * the real zh-CN i18n, a real event bus and a memory router. Only the services the panel injects (imageService,
 * aiService) are fakes, and they record every call that changes something or starts a generation. Leaf components
 * are stubbed (ImageDisplay, RegenerateSameModal, CivitaiLoraShelf, MultiReferencePicker, Tooltip); a stub renders
 * every prop it receives into `data-props`, so the arguments the panel passes down are part of the html.
 *
 * What a case did is stored byte for byte in `../__snapshots__/character-details-panel/<id>.json` (service calls,
 * event bus emits and state writes, in order) and `<id>.html` (the normalised DOM after the case; extra steps get
 * `<id>.<step>.html`). A refactor of CharacterDetailsPanel.vue must leave every file unchanged. Snapshots are never
 * rewritten with `-u` during the refactor; a changed snapshot is a failed step.
 *
 * Determinism: Date, setTimeout and clearTimeout are faked, Math.random is fixed, the timezone is UTC,
 * `data-v-*` attributes are removed, and long strings in recorded arguments are stored as length + sha1 + head.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createHash } from 'node:crypto';
import { h, nextTick, type Component, type SetupContext } from 'vue';
import CharacterDetailsPanel from '../CharacterDetailsPanel.vue';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import RegenerateSameModal from '@/ui/components/image/RegenerateSameModal.vue';
import CivitaiLoraShelf from '@/ui/components/image/CivitaiLoraShelf.vue';
import MultiReferencePicker from '@/ui/components/shared/MultiReferencePicker.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { i18n } from '@/ui/i18n';
import { eventBus } from '@/engine/core/event-bus';
import { StateManager } from '@/engine/core/state-manager';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useAPIManagementStore } from '@/engine/stores/engine-api';

const SNAPSHOT_DIR = '../__snapshots__/character-details-panel';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const FIXED_RANDOM = 0.123456;
const UNDEFINED_MARK = '__undefined__';
const LONG_STRING = 300;
const T0 = 1790000000000;

type Json = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

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

const BLOB_ASSETS: Record<string, string> = { pimg_1: 'player-one', pimg_2: 'player-two', sec_breast: 'secret-breast' };

function baseTree(backend: string): Json {
  return {
    系统: {
      nsfwMode: false,
      扩展: {
        image: {
          config: {
            defaultBackend: backend,
            reference: {},
            civitai: { allowMatureContent: false },
          },
          artistPresets: [
            { id: 'ap1', name: '画师甲', scope: 'npc', artistString: 'artist:foo, artist:bar', positive: 'soft light', negative: 'blurry' },
            { id: 'png_1', name: 'PNG风', scope: 'npc', artistString: '', positive: 'masterpiece', negative: 'lowres', pngMeta: { source: 'a1111', originalPrompt: 'masterpiece', rawText: 'raw', replicateParams: false, parsedParams: { steps: 28 } } },
          ],
          characterAnchors: [],
        },
      },
    },
    世界: {
      时间: { 年: 1, 月: 2, 日: 3, 小时: 9, 分钟: 30 },
      地点信息: [{ 名称: '酒肆' }, { 名称: '码头' }],
    },
    角色: {
      基础信息: { 姓名: '沈青', 年龄: 22, 性别: '女', 当前位置: '酒肆', 特质: { 名称: '坚韧', 描述: '不轻易放弃' } },
      属性: { 体质: 5, 悟性: 7 },
      身份: {
        出身: { 名称: '商贾之家', 描述: '家境殷实' },
        天赋档次: '上品',
        天赋: [{ 名称: '过目不忘', 描述: '读书极快' }, '耳聪目明'],
        先天六维: { 体质: 4, 悟性: 6 },
      },
      可变属性: { 体力: { 当前: 80, 上限: 100 }, 精力: { 当前: 60, 上限: 100 }, 声望: 12, 地位: { 名称: '账房先生', 描述: '掌管账目' } },
      身体: {
        身高: 165, 体重: 50, 三围: { 胸围: 86, 腰围: 60, 臀围: 88 }, 胸部描述: '饱满', 私处描述: '粉嫩', 生殖器描述: '',
        身体部位: [{ 部位名称: '嘴', 敏感度: 40, 开发度: 10, 特征描述: '柔软' }],
        子宫: { 状态: '正常', 宫口状态: '闭合', 内射记录: [] },
        敏感点: ['耳后'], 开发度: { 嘴: 10 }, 纹身与印记: [],
      },
      图片档案: {
        生图历史: [
          { id: 'pimg_1', status: 'complete', createdAt: T0 + 2000, composition: 'portrait', positivePrompt: 'player portrait', negativePrompt: 'lowres', width: 832, height: 1216, backend: 'novelai', model: 'nai-v4' },
          { id: 'pimg_2', status: 'failed', createdAt: T0 + 3000, composition: 'half-body', width: 832, height: 1216, backend: 'novelai' },
          { id: 'sec_breast', status: 'complete', createdAt: T0 + 4000, composition: 'secret_part', positivePrompt: 'close-up', width: 1024, height: 1024, backend: 'novelai' },
        ],
        已选头像图片ID: 'pimg_1',
        已选立绘图片ID: '',
        香闺秘档: { 胸部: { id: 'sec_breast' } },
      },
    },
    社交: {
      关系: [
        { 名称: '林暖', 好感度: 72, 内心想法: '她看起来很可靠', 在做事项: '擦拭酒杯', 图片档案: { 已选头像图片ID: '' } },
        { 名称: '关宇', 好感度: -20, 内心想法: '', 在做事项: '' },
      ],
    },
    元数据: { 叙事历史: [] },
  };
}

// ── fake services ───────────────────────────────────────────────────────────

interface FakeOptions {
  backend: string;
  configured: boolean;
  regenFails: boolean;
  charFails: boolean;
  anchorReply: string;
}

interface Fake {
  imageService: unknown;
  aiService: unknown;
}

function makeFake(rec: Recorder, opts: FakeOptions): Fake {
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
      return id in BLOB_ASSETS
        ? { blob: new Blob([BLOB_ASSETS[id]], { type: 'image/png' }), metadata: { mimeType: 'image/png', width: 832, height: 1216, sizeBytes: 12, backend: 'novelai' } }
        : null;
    },
    store: recordAsync('cache.store', () => undefined),
    delete: recordAsync('cache.delete', () => undefined),
  };
  const imageService = {
    getAssetCache: () => cache,
    generateCharacterImage: recordAsync('generateCharacterImage', () => (opts.charFails ? task('gen_char_fail', { status: 'failed', error: 'no image API configured', resultAssetId: undefined }) : task('gen_char'))),
    generateSecretPartImage: recordAsync('generateSecretPartImage', () => task('gen_secret', { subjectType: 'secret_part' })),
    regenerateFromPrompts: recordAsync('regenerateFromPrompts', () => (opts.regenFails ? task('regen_fail', { status: 'failed', error: 'quota exceeded' }) : task('regen_ok'))),
    setNpcSecretPart: record('setNpcSecretPart'),
    clearNpcSecretPart: record('clearNpcSecretPart'),
    deleteNpcImage: record('deleteNpcImage'),
    state: {
      addReferenceEntry: record('state.addReferenceEntry'),
    },
  };
  const aiService = {
    getImageConfigForBackend: (bk: string) => (opts.configured
      ? { id: 'img_cfg', name: '图片API', url: `https://img.test/${bk}`, apiKey: 'key', model: `model-${bk}` }
      : undefined),
    generate: recordAsync('ai.generate', () => opts.anchorReply),
  };
  return { imageService, aiService };
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
  edit?: (tree: Json) => void;
  regenFails?: boolean;
  charFails?: boolean;
  anchorReply?: string;
}

interface Harness {
  wrapper: VueWrapper;
  rec: Recorder;
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
    regenFails: options.regenFails ?? false,
    charFails: options.charFails ?? false,
    anchorReply: options.anchorReply ?? '{"positivePrompt":"1girl, long hair","negativePrompt":"bad hands","structuredFeatures":{"hair":"long"}}',
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

  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/game/character', component: { template: '<div />' } }] });
  await router.push('/game/character');
  await router.isReady();

  const wrapper = mount(CharacterDetailsPanel, {
    global: {
      plugins: [pinia, i18n, router],
      provide: { imageService: fake.imageService, aiService: fake.aiService },
      stubs: STUBS,
    },
  });
  mounted = wrapper;
  await flush();
  rec.calls.length = 0;
  rec.emits.length = 0;
  rec.writes.length = 0;
  return { wrapper, rec, html: () => normalizeHtml(wrapper.html()) };
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
const TABS = ['basic', 'attributes', 'relations', 'body', 'playerImage'] as const;
async function selectTab(w: VueWrapper, key: (typeof TABS)[number]): Promise<void> {
  await setVm(w, { activeTab: key });
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
async function lock(id: string, hh: Harness, htmls: Record<string, string> = {}): Promise<void> {
  await expect(serialize({ calls: hh.rec.calls, emits: hh.rec.emits, writes: hh.rec.writes })).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
  const main = htmls.main ?? hh.html();
  await expect(main).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.html`);
  for (const [step, html] of Object.entries(htmls)) {
    if (step !== 'main') await expect(html).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.${step}.html`);
  }
}
const names = (hh: Harness): string[] => hh.rec.calls.map(([n]) => n);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  eventBus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const REGEN_CONFIRM = {
  backend: 'novelai',
  positivePrompt: 'player portrait, edited',
  negativePrompt: 'lowres',
};

// ════════════════════════════════════════════════════════════════════════════
// T1–T5: one html per tab
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · tabs', () => {
  TABS.forEach((key, i) => {
    it(`T${i + 1} ${key} tab renders`, async () => {
      const hh = await mountPanel({ nsfw: key === 'body' || key === 'playerImage' });
      await selectTab(hh.wrapper, key);
      await lock(`T${i + 1}-${key}`, hh);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G1–G3: player image generation
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · player image generation', () => {
  it('G1 novelai with artist preset, png preset, extra prompt and custom size', async () => {
    const hh = await mountPanel();
    await selectTab(hh.wrapper, 'playerImage');
    await setVm(hh.wrapper, {
      playerStyle: 'anime',
      playerArtistPreset: 'ap1',
      playerPngPreset: 'png_1',
      playerExtraPrompt: '雨天，窗外有灯',
      playerSize: '768 x 1024',
    });
    const before = hh.html();
    await click(hh.wrapper, tr('character.image.generateButton.portrait'));
    expect(names(hh)).toEqual(['generateCharacterImage']);
    await lock('G1-generate-default', hh, { main: hh.html(), before });
  });

  it('G2 custom composition without a description is refused; a failed task shows its error', async () => {
    const hh = await mountPanel({ charFails: true });
    await selectTab(hh.wrapper, 'playerImage');
    await setVm(hh.wrapper, { playerComposition: 'custom' });
    await click(hh.wrapper, tr('character.image.generateButton.fullLength'));
    expect(names(hh)).toEqual([]);
    const refused = hh.html();
    await setVm(hh.wrapper, { playerCustomComposition: '坐在窗边看雨' });
    await click(hh.wrapper, tr('character.image.generateButton.fullLength'));
    expect(names(hh)).toEqual(['generateCharacterImage']);
    await lock('G2-generate-refused-failed', hh, { main: hh.html(), refused });
  });

  it('G3 volcengine multi reference: quick-source ignored when listed, list sent as references', async () => {
    const hh = await mountPanel({ backend: 'volcengine' });
    await selectTab(hh.wrapper, 'playerImage');
    await setVm(hh.wrapper, { playerRefEnabled: true });
    await setVm(hh.wrapper, {
      playerMultiRefItems: [
        { id: 'pmr1', dataUrl: 'data:image/png;base64,AAAA', label: '图1' },
        { id: 'pmr2', dataUrl: 'data:image/png;base64,BBBB', assetId: 'pimg_1', label: '头像' },
      ],
      playerRefDenoise: 0.7,
    });
    const before = hh.html();
    await click(hh.wrapper, tr('character.image.generateButton.portrait'));
    expect(names(hh)).toEqual(['generateCharacterImage']);
    await lock('G3-generate-multiref', hh, { main: hh.html(), before });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A1–A2: player anchor
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · player anchor', () => {
  it('A1 extract an anchor through the AI service, then edit and save it, then delete it', async () => {
    const hh = await mountPanel();
    await selectTab(hh.wrapper, 'playerImage');
    await click(hh.wrapper, tr('character.image.anchor.extractButton'));
    const extracted = hh.html();
    await setVm(hh.wrapper, { anchorPositive: '1girl, short hair', anchorEnabled: false, anchorAutoScene: true });
    await click(hh.wrapper, tr('character.image.anchor.save'));
    await click(hh.wrapper, tr('character.image.anchor.delete'));
    await lock('A1-anchor-lifecycle', hh, { main: hh.html(), extracted });
  });

  it('A2 extract without an AI service reports it', async () => {
    const bare = await mountBare();
    await selectTab(bare.wrapper, 'playerImage');
    await click(bare.wrapper, tr('character.image.anchor.extractButton'));
    await lock('A2-anchor-no-ai', bare);
  });
});

/** Mounts the panel with no aiService provided (a distinct provide set). */
async function mountBare(): Promise<Harness> {
  const rec: Recorder = { calls: [], emits: [], writes: [] };
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useEngineStateStore();
  const sm = new StateManager();
  store.linkStateManager(sm);
  sm.loadTree(baseTree('novelai'));
  store.markLoaded('test-pack', 'test-profile', 'test-slot');
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    if (event !== 'engine:state-changed') rec.emits.push([String(event), plain(payload)]);
    origEmit(event, payload);
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/game/character', component: { template: '<div />' } }] });
  await router.push('/game/character');
  await router.isReady();
  const wrapper = mount(CharacterDetailsPanel, { global: { plugins: [pinia, i18n, router], stubs: STUBS } });
  mounted = wrapper;
  await flush();
  rec.emits.length = 0;
  return { wrapper, rec, html: () => normalizeHtml(wrapper.html()) };
}

// ════════════════════════════════════════════════════════════════════════════
// S1–S2: secret part close-ups (nsfw, non-male)
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · secret parts', () => {
  it('S1 single part, then all parts, with a size and presets', async () => {
    const hh = await mountPanel({ nsfw: true });
    await selectTab(hh.wrapper, 'playerImage');
    await setVm(hh.wrapper, { playerSecretSizePreset: '3:4', playerSecretArtistPreset: 'ap1', playerSecretPngPreset: 'png_1', playerSecretExtraPrompt: '近景柔光' });
    await click(hh.wrapper, tr('character.image.secret.generate'), 0);
    const single = hh.html();
    await click(hh.wrapper, tr('character.image.secret.generateAll'));
    expect(names(hh)).toEqual(['generateSecretPartImage', 'generateSecretPartImage', 'generateSecretPartImage', 'generateSecretPartImage']);
    await lock('S1-secret-generate', hh, { main: hh.html(), single });
  });

  it('S2 reference redraw of an existing part, and the viewer opens', async () => {
    const hh = await mountPanel({ nsfw: true, backend: 'volcengine' });
    await selectTab(hh.wrapper, 'playerImage');
    await click(hh.wrapper, tr('character.image.secret.referenceRedraw'));
    const redrawn = hh.html();
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:secret-viewer';
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
    await clickSelector(hh.wrapper, '.secret-card-image--has-img');
    await lock('S2-secret-reference-viewer', hh, { main: hh.html(), redrawn });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// R1–R2: regenerate same
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · regenerate same', () => {
  it('R1 open from an archive card, cancel, reopen as reference, confirm', async () => {
    const hh = await mountPanel({ backend: 'volcengine' });
    await selectTab(hh.wrapper, 'playerImage');
    await click(hh.wrapper, tr('character.image.archive.regenerateSame'), 0);
    const opened = hh.html();
    modalStub(hh.wrapper).vm.$emit('cancel');
    await flush();
    expect(modalStub(hh.wrapper).exists()).toBe(false);
    await click(hh.wrapper, tr('character.image.archive.referenceRedraw'), 0);
    const asReference = hh.html();
    modalStub(hh.wrapper).vm.$emit('confirm', REGEN_CONFIRM);
    await flush();
    expect(names(hh)).toEqual(['regenerateFromPrompts']);
    expect(modalStub(hh.wrapper).exists()).toBe(false);
    await lock('R1-regen-confirm', hh, { main: hh.html(), opened, asReference });
  });

  it('R2 a failed regeneration keeps the modal open', async () => {
    const hh = await mountPanel({ regenFails: true });
    await selectTab(hh.wrapper, 'playerImage');
    await click(hh.wrapper, tr('character.image.archive.regenerateSame'), 0);
    modalStub(hh.wrapper).vm.$emit('confirm', REGEN_CONFIRM);
    await flush();
    expect(modalStub(hh.wrapper).exists()).toBe(true);
    await lock('R2-regen-failed', hh);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Y1: archive card actions
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · archive actions', () => {
  it('Y1 avatar, portrait, secret part, delete, analyze and save-as-reference', async () => {
    const hh = await mountPanel({ nsfw: true });
    await selectTab(hh.wrapper, 'playerImage');
    await click(hh.wrapper, tr('character.image.archive.unsetAvatar'), 0);
    await click(hh.wrapper, tr('character.image.archive.setAsAvatar'), 0);
    await click(hh.wrapper, tr('character.image.archive.setAsPortrait'), 0);
    const bound = hh.html();
    await click(hh.wrapper, tr('character.image.archive.setSecretVagina'), 0);
    await click(hh.wrapper, tr('character.image.archive.cancelSecretBreast'), 0);
    await click(hh.wrapper, tr('character.image.archive.analyzeStyle'), 0);
    await click(hh.wrapper, tr('character.image.archive.saveAsReference'), 0);
    await click(hh.wrapper, tr('character.image.archive.saveAsReference'), 1);
    await click(hh.wrapper, tr('common.actions.delete'), 0);
    await lock('Y1-archive-actions', hh, { main: hh.html(), bound });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1: the rest of the panel that must not move (basic-tab edit, body edit, vitals)
// ════════════════════════════════════════════════════════════════════════════

describe('CharacterDetailsPanel · other editors', () => {
  it('P1 gender, occupation and body edits write through the character editor', async () => {
    const hh = await mountPanel({ nsfw: true });
    await setVm(hh.wrapper, { genderDraft: '其他' });
    await callVm(hh.wrapper, 'commitGender');
    await setVm(hh.wrapper, { occupationDraft: '掌柜' });
    await callVm(hh.wrapper, 'commitOccupation');
    await callVm(hh.wrapper, 'openBodyEdit');
    await callVm(hh.wrapper, 'saveBodyEdit');
    await lock('P1-other-editors', hh);
  });
});

async function callVm(w: VueWrapper, name: string, ...args: unknown[]): Promise<void> {
  const fn = vmOf(w)[name];
  if (typeof fn !== 'function') throw new Error(`vm has no function ${name}`);
  await (fn as Fn)(...args);
  await flush();
}
