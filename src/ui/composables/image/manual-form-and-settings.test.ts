// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import { identityT, makeStateAccess } from './test-helpers';
import { useManualForm } from './manual-form';
import { useReferences } from './references';
import { useSecretParts, type UseSecretPartsDeps } from './secret-parts';
import { useSettingsTab } from './settings-tab';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useManualForm', () => {
  it('backend: saved value if the catalog knows it, novelai otherwise', () => {
    const s = makeStateAccess();
    const m = useManualForm({ get: s.get });
    expect(m.backend.value).toBe('novelai');
    s.tree['系统.扩展.image.config.defaultBackend'] = 'civitai';
    expect(m.backend.value).toBe('civitai');
    s.tree['系统.扩展.image.config.defaultBackend'] = 'not-a-backend';
    expect(m.backend.value).toBe('novelai');
    expect(m.IMAGE_BACKEND_KEYS).toContain('novelai');
    expect(m.IMAGE_BACKEND_KEYS).toContain('civitai');
  });

  it('capability flags follow the backend', () => {
    const s = makeStateAccess({ '系统.扩展.image.config.defaultBackend': 'novelai' });
    const m = useManualForm({ get: s.get });
    expect(m.backendSupportsRefStrength.value).toBe(true);
    s.tree['系统.扩展.image.config.defaultBackend'] = 'volcengine';
    // whatever the capability table says for the current backend, the flags stay in sync with it
    expect(typeof m.backendSupportsImg2Img.value).toBe('boolean');
    expect(typeof m.backendSupportsMultiRef.value).toBe('boolean');
  });

  it('reference config defaults and overrides', () => {
    const s = makeStateAccess();
    const m = useManualForm({ get: s.get });
    expect(m.refConfigDenoiseDefault.value).toBe(0.65);
    expect(m.refConfigMaxUploadBytes.value).toBe(10485760);
    expect(m.refConfigPersist.value).toBe(true);
    s.tree['系统.扩展.image.config.reference.defaultDenoiseStrength'] = 0.4;
    s.tree['系统.扩展.image.config.reference.maxUploadBytes'] = 100;
    s.tree['系统.扩展.image.config.reference.persistUploadedReferences'] = false;
    expect([m.refConfigDenoiseDefault.value, m.refConfigMaxUploadBytes.value, m.refConfigPersist.value]).toEqual([0.4, 100, false]);
  });

  it('changing the NPC clears every reference image; enabling references resets the denoise default', async () => {
    const s = makeStateAccess({ '系统.扩展.image.config.reference.defaultDenoiseStrength': 0.3 });
    const m = useManualForm({ get: s.get });
    m.npcReferenceItems.value = [{ id: 'a', dataUrl: 'd', label: 'x' }];
    m.npcReferenceFile.value = new File(['x'], 'x.png');
    m.npcReferenceDataUrl.value = 'data:';
    m.npcReferenceAssetId.value = 'asset';
    m.selectedNpc.value = '甲';
    await nextTick();
    expect([m.npcReferenceItems.value, m.npcReferenceFile.value, m.npcReferenceDataUrl.value, m.npcReferenceAssetId.value]).toEqual([[], null, null, null]);

    m.npcReferenceDenoise.value = 0.9;
    m.npcReferenceEnabled.value = true;
    await nextTick();
    expect(m.npcReferenceDenoise.value).toBe(0.3);
    m.npcReferenceDenoise.value = 0.9;
    m.npcReferenceEnabled.value = false; // turning it off leaves the slider alone
    await nextTick();
    expect(m.npcReferenceDenoise.value).toBe(0.9);
  });
});

describe('useReferences', () => {
  function make(over: { imageService?: unknown; max?: number; persist?: boolean; npcData?: Record<string, unknown> | null } = {}) {
    const npcReferenceItems = ref<Array<{ id: string; dataUrl: string; assetId?: string; label: string }>>([]);
    const r = useReferences({
      imageService: over.imageService as never,
      t: identityT,
      refConfigMaxUploadBytes: ref(over.max ?? 1000),
      refConfigPersist: ref(over.persist ?? true),
      npcReferenceItems: npcReferenceItems as never,
      npcReferenceFile: ref(null),
      npcReferenceDataUrl: ref(null),
      npcReferenceAssetId: ref(null),
      selectedNpcData: computed(() => over.npcData ?? null),
    });
    return { r, npcReferenceItems };
  }

  it('validateUploadSize rejects oversized files with an error toast', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { r } = make({ max: 2 * 1048576 });
    expect(r.validateUploadSize(new File(['x'], 'ok.png'))).toBe(true);
    const big = new File([new Uint8Array(3 * 1048576)], 'big.png');
    expect(r.validateUploadSize(big)).toBe(false);
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'error', message: 'image.manual.fileOversize|{"actual":"3.0","limit":"2"}', duration: 3000 });
  });

  it('persistUploadedReference skips without a service or when persistence is off, else stores asset + library entry', async () => {
    const file = new File(['abc'], 'pic.png', { type: 'image/png' });
    expect(await make({ imageService: undefined }).r.persistUploadedReference(file, '')).toBeNull();
    expect(await make({ imageService: {}, persist: false }).r.persistUploadedReference(file, '')).toBeNull();

    const store = vi.fn(async () => {});
    const addReferenceEntry = vi.fn();
    const service = { getAssetCache: () => ({ store }), state: { addReferenceEntry } };
    const id = await make({ imageService: service }).r.persistUploadedReference(file, '');
    expect(id).toMatch(/^ref_upload_\d+_[a-z0-9]+$/);
    expect(store).toHaveBeenCalledTimes(1);
    expect(addReferenceEntry).toHaveBeenCalledWith(expect.objectContaining({ assetId: id, name: 'pic', source: 'upload', sizeBytes: 3 }));
  });

  it('persistUploadedReference swallows storage failures and returns null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = { getAssetCache: () => ({ store: async () => { throw new Error('quota'); } }), state: { addReferenceEntry: vi.fn() } };
    expect(await make({ imageService: service }).r.persistUploadedReference(new File(['a'], 'a.png'), '')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('multiRefToInputs keeps order and picks asset vs data_url sources', () => {
    const { r } = make();
    const out = r.multiRefToInputs([
      { id: '1', dataUrl: 'data:1', assetId: 'asset-1', label: 'a' },
      { id: '2', dataUrl: 'data:2', label: 'b' },
    ], 0.5);
    expect(out).toEqual([
      { id: expect.any(String), role: 'source', source: 'asset', assetId: 'asset-1', denoiseStrength: 0.5 },
      { id: expect.any(String), role: 'source', source: 'data_url', dataUrl: 'data:2', denoiseStrength: 0.5 },
    ]);
  });

  it('npc quick source is the selected avatar, else the portrait, else nothing', () => {
    expect(make({ npcData: null }).r.npcQuickSources.value).toEqual([]);
    expect(make({ npcData: { 图片档案: { 已选头像图片ID: 'av', 已选立绘图片ID: 'po' } } }).r.npcAvatarAssetId.value).toBe('av');
    const withPortrait = make({ npcData: { 图片档案: { 已选立绘图片ID: 'po' } } });
    expect(withPortrait.r.npcAvatarAssetId.value).toBe('po');
    expect(withPortrait.r.npcQuickSources.value).toEqual([{ key: 'avatar', label: 'image.manual.refAvatar' }]);
  });

  it('addAssetToMultiRef ignores empty ids, duplicates, full lists and cache misses; adds a read asset', async () => {
    const retrieve = vi.fn(async (id: string) => (id === 'miss' ? null : { blob: new Blob(['x']), metadata: { mimeType: 'image/png' } }));
    const { r, npcReferenceItems } = make({ imageService: { getAssetCache: () => ({ retrieve }) } });
    await r.addAssetToMultiRef(npcReferenceItems as never, '', 'L');
    await r.addAssetToMultiRef(npcReferenceItems as never, 'miss', 'L');
    expect(npcReferenceItems.value).toEqual([]);
    await r.addAssetToMultiRef(npcReferenceItems as never, 'a1', 'Avatar');
    expect(npcReferenceItems.value).toHaveLength(1);
    expect(npcReferenceItems.value[0]).toMatchObject({ assetId: 'a1', label: 'Avatar' });
    expect(npcReferenceItems.value[0].dataUrl).toMatch(/^data:/);
    await r.addAssetToMultiRef(npcReferenceItems as never, 'a1', 'Avatar'); // duplicate
    expect(npcReferenceItems.value).toHaveLength(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});

describe('useSecretParts', () => {
  const SIZE_BASES = { '1:1': { w: 1024, h: 1024 }, '3:4': { w: 768, h: 1024 }, '9:16': { w: 576, h: 1024 }, '16:9': { w: 1024, h: 576 } };
  function make(over: Partial<UseSecretPartsDeps> = {}) {
    const generateSecretPartImage = vi.fn(async (_params: unknown) => ({ status: 'complete', id: 't' }));
    const service = { generateSecretPartImage, getAssetCache: () => ({ retrieve: vi.fn(async () => ({ blob: new Blob(['x']) })) }) };
    const state = {
      secretStatusText: ref(''), secretBusy: ref(''), lastTask: ref<unknown>(null),
      secretStyle: ref<'none' | 'generic' | 'anime' | 'realistic' | 'chinese'>('none'),
      secretSizePreset: ref<'none' | '1:1' | '3:4' | '9:16' | '16:9'>('1:1'),
    };
    const sizePresetOptions = ref([
      { label: 'n', value: 'none' as const }, { label: '1', value: '1:1' as const }, { label: 'c', value: 'custom' as const },
    ]);
    const deps: UseSecretPartsDeps = {
      t: identityT, imageService: service as never,
      selectedNpc: ref('甲'), selectedNpcData: ref(null),
      artistPresets: ref([]),
      secretArtistPreset: ref(''), secretPngPreset: ref(''), secretStyle: state.secretStyle, secretSizePreset: state.secretSizePreset,
      secretExtraPrompt: ref(''), secretStatusText: state.secretStatusText, secretBusy: state.secretBusy, lastTask: state.lastTask as never,
      backend: ref('novelai' as const), configuredModelFor: () => undefined, refConfigDenoiseDefault: ref(0.65), imageUpdateTick: ref(0),
      sizePresetOptions: sizePresetOptions as never, SIZE_BASES, ...over,
    };
    return { s: useSecretParts(deps), state, generateSecretPartImage, deps };
  }

  it('lists the three parts and drops the "custom" size option', () => {
    const { s } = make();
    expect(s.secretParts.value.map((p) => p.key)).toEqual(['breast', 'vagina', 'anus']);
    expect(s.secretSizeOptions.value.map((o) => o.value)).toEqual(['none', '1:1']);
  });

  it('size carrier: none -> undefined, otherwise the base dimensions', () => {
    const { s, state } = make();
    expect(s.secretSizeStylePreset()).toMatchObject({ id: 'secret_1:1', width: 1024, height: 1024, source: 'manual' });
    state.secretSizePreset.value = '16:9';
    expect(s.secretSizeStylePreset()).toMatchObject({ width: 1024, height: 576 });
    state.secretSizePreset.value = 'none';
    expect(s.secretSizeStylePreset()).toBeUndefined();
    expect(s.artStyleLabelFor('none')).toBeUndefined();
    expect(s.artStyleLabelFor('anime')).toBe('image.manual.artStyle.anime');
  });

  it('getSecretPartAssetId reads the Chinese part keys from the selected NPC archive', () => {
    const { s } = make({ selectedNpcData: ref({ 图片档案: { 香闺秘档: { 胸部: { id: 'b1' }, 小穴: { id: '' }, 屁穴: {} } } }) });
    expect(s.getSecretPartAssetId('breast')).toBe('b1');
    expect(s.getSecretPartAssetId('vagina')).toBeNull();
    expect(s.getSecretPartAssetId('anus')).toBeNull();
    expect(make().s.getSecretPartAssetId('breast')).toBeNull();
  });

  it('generateSecretPart: needs a service and NPC, submits one part, reports success / failure and clears busy', async () => {
    const none = make({ imageService: undefined });
    await none.s.generateSecretPart('breast');
    expect(none.state.secretBusy.value).toBe('');

    const ok = make();
    await ok.s.generateSecretPart('vagina');
    expect(ok.generateSecretPartImage).toHaveBeenCalledTimes(1);
    expect(ok.generateSecretPartImage.mock.calls[0][0]).toMatchObject({ characterName: '甲', part: 'vagina', backend: 'novelai', artStyle: undefined, extraPrompt: undefined });
    expect(ok.state.secretStatusText.value).toBe('image.secret.allComplete');
    expect(ok.state.secretBusy.value).toBe('');
    expect(ok.state.lastTask.value).toMatchObject({ id: 't' });

    const failed = make();
    failed.generateSecretPartImage.mockResolvedValueOnce({ status: 'failed', error: 'boom' } as never);
    await failed.s.generateSecretPart('breast');
    expect(failed.state.secretStatusText.value).toBe('image.secret.failGenerate|{"part":"image.secret.bodyPart.breast","error":"boom"}');

    const thrown = make();
    thrown.generateSecretPartImage.mockRejectedValueOnce(new Error('net'));
    await thrown.s.generateSecretPart('anus');
    expect(thrown.state.secretStatusText.value).toBe('image.secret.failGenerate|{"part":"image.secret.bodyPart.anus","error":"net"}');
    expect(thrown.state.secretBusy.value).toBe('');
  });

  it('generateAllSecretParts submits all three in order, keeping the last completed task', async () => {
    const { s, generateSecretPartImage, state } = make();
    generateSecretPartImage
      .mockResolvedValueOnce({ status: 'complete', id: 'a' } as never)
      .mockResolvedValueOnce({ status: 'failed', id: 'b' } as never)
      .mockResolvedValueOnce({ status: 'complete', id: 'c' } as never);
    await s.generateAllSecretParts();
    expect(generateSecretPartImage.mock.calls.map((c) => (c[0] as { part: string }).part)).toEqual(['breast', 'vagina', 'anus']);
    expect(state.lastTask.value).toMatchObject({ id: 'c' });
    expect(state.secretStatusText.value).toBe('image.secret.allComplete');
  });

  it('reference repaint needs a previous image in the cache', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { s, generateSecretPartImage } = make();
    await s.generateSecretPartWithReference('breast');
    expect(generateSecretPartImage).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'error', message: 'image.secret.noPreviousRef', duration: 2000 });

    const withPrev = make({ selectedNpcData: ref({ 图片档案: { 香闺秘档: { 胸部: { id: 'prev' } } } }) });
    await withPrev.s.generateSecretPartWithReference('breast');
    const call = withPrev.generateSecretPartImage.mock.calls[0][0] as { references: Array<Record<string, unknown>> };
    expect(call.references[0]).toMatchObject({ role: 'source', source: 'asset', assetId: 'prev', denoiseStrength: 0.65 });
  });
});

describe('useSettingsTab', () => {
  function make(ai: unknown, state: Record<string, unknown> = {}) {
    const s = makeStateAccess(state);
    const t = useSettingsTab({ get: s.get, t: identityT, aiService: ai as never, backend: ref('civitai' as const), ALL_IMAGE_BACKENDS: ref([{ label: 'Civitai', value: 'civitai' }]) });
    return { t, s };
  }

  it('backend status reads the configured API for the active backend', () => {
    expect(make(undefined).t.activeBackendStatus.value).toEqual({ label: 'Civitai', model: '', configured: false, apiName: '' });
    const ai = { getImageConfigForBackend: () => ({ model: 'm', name: 'api' }) };
    expect(make(ai).t.activeBackendStatus.value).toEqual({ label: 'Civitai', model: 'm', configured: true, apiName: 'api' });
    expect(make(ai).t.configuredModelFor('civitai')).toBe('m');
    expect(make({ getImageConfigForBackend: () => ({ model: '' }) }).t.configuredModelFor('civitai')).toBeUndefined();
  });

  it('flags derive from stored settings', () => {
    const { t, s } = make(undefined);
    expect(t.settingsBackend.value).toBe('novelai');
    expect(t.isNovelAIBackend.value).toBe(true);
    s.tree['系统.扩展.image.config.defaultBackend'] = 'civitai';
    expect(t.isNovelAIBackend.value).toBe(false);
    expect(t.settingsTransformerIndependent.value).toBe(false);
    s.tree['系统.扩展.image.config.transformerIndependentModel'] = true;
    expect(t.settingsTransformerIndependent.value).toBe(true);
  });

  it('validateCivitaiJson sets / clears the matching error ref', () => {
    const { t, s } = make(undefined);
    s.tree['系统.扩展.image.config.civitai.additionalNetworksJson'] = '{bad';
    t.validateCivitaiJson('additionalNetworksJson', 'civitaiNetworksJsonError');
    expect(t.civitaiNetworksJsonError.value).toMatch(/^image\.civitai\.jsonFormatError\|/);
    expect(t.civitaiControlNetsJsonError.value).toBe('');
    s.tree['系统.扩展.image.config.civitai.additionalNetworksJson'] = '{"ok":1}';
    t.validateCivitaiJson('additionalNetworksJson', 'civitaiNetworksJsonError');
    expect(t.civitaiNetworksJsonError.value).toBe('');
    s.tree['系统.扩展.image.config.civitai.controlNetsJson'] = '   ';
    t.validateCivitaiJson('controlNetsJson', 'civitaiControlNetsJsonError');
    expect(t.civitaiControlNetsJsonError.value).toBe('');
  });

  it('whatif: not configured, http failure, cost, and network error', async () => {
    const cfg = { url: 'https://civitai.example///', apiKey: 'KEY', model: 'urn:air:x' };
    const ai = { getImageConfigForBackend: () => cfg };
    const none = make({ getImageConfigForBackend: () => undefined });
    await none.t.runCivitaiWhatif();
    expect(none.t.civitaiWhatifResult.value).toBe('image.civitai.notConfigured');
    expect(none.t.civitaiWhatifLoading.value).toBe(false);

    const { t } = make(ai, { '系统.扩展.image.config.civitai.steps': 30 });
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await t.runCivitaiWhatif();
    expect(t.civitaiWhatifResult.value).toBe('image.civitai.queryFailedHttp|{"status":500}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://civitai.example/v2/consumer/recipes/textToImage?whatif=true');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer KEY');
    expect(JSON.parse(init.body)).toMatchObject({ prompt: 'cost estimate', width: 1024, height: 1024, quantity: 1, batchSize: 1, model: 'urn:air:x', steps: 30 });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jobs: [{ cost: 12 }] }) })));
    await t.runCivitaiWhatif();
    expect(t.civitaiWhatifResult.value).toBe('image.civitai.estimatedCost|{"cost":12}');

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) })));
    await t.runCivitaiWhatif();
    expect(t.civitaiWhatifResult.value).toBe('image.civitai.queryComplete|{"data":"{\\"x\\":1}"}');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await t.runCivitaiWhatif();
    expect(t.civitaiWhatifResult.value).toBe('image.civitai.queryFailed|{"error":"offline"}');
    expect(t.civitaiWhatifLoading.value).toBe(false);
  });
});
