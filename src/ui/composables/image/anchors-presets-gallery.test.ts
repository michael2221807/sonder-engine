import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import { identityT, makeStateAccess } from './test-helpers';
import { useAnchors } from './anchors';
import { useArtistPresets } from './artist-presets';
import { useGallery } from './gallery';
import { useReferenceLibrary } from './reference-library';
import { useUnderstanding } from './understanding';

afterEach(() => { vi.restoreAllMocks(); });

const ANCHORS = '系统.扩展.image.characterAnchors';
const PRESETS = '系统.扩展.image.artistPresets';

describe('useAnchors', () => {
  function make(initial: Record<string, unknown> = {}, ai: unknown = undefined) {
    const s = makeStateAccess(initial);
    const relationships = ref<Array<Record<string, unknown>> | undefined>([{ 名称: '甲', 性别: '女', 年龄: 20, 描述: ' 开朗 ', 性格特征: ['勇敢'] }]);
    const m = useAnchors({ get: s.get, setValue: s.setValue, t: identityT, aiService: ai as never, relationships });
    return { s, m };
  }
  const anchor = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, npcName: 'n', enabled: true, defaultAppend: true, sceneLink: false, positive: 'pos', negative: 'neg', ...over });

  it('selecting an anchor loads it into the editor; unknown ids only change the selection', () => {
    const { m } = make({ [ANCHORS]: [anchor('a', { name: 'A', npcName: '甲', positive: 'P', negative: 'N' })] });
    m.selectAnchor('a');
    expect([m.selectedAnchorId.value, m.editAnchorName.value, m.editAnchorNpc.value, m.editAnchorPositive.value, m.editAnchorNegative.value]).toEqual(['a', 'A', '甲', 'P', 'N']);
    m.selectAnchor('zzz');
    expect(m.selectedAnchorId.value).toBe('zzz');
    expect(m.editAnchorName.value).toBe('A');
    expect(m.selectedAnchor.value).toBeNull();
  });

  it('save / toggle / delete write the whole list and toast on save', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { s, m } = make({ [ANCHORS]: [anchor('a'), anchor('b')] });
    m.saveAnchor(); // nothing selected -> no write
    expect(s.setValue).not.toHaveBeenCalled();
    m.selectAnchor('a');
    m.editAnchorName.value = 'renamed';
    m.saveAnchor();
    expect((s.writes[0][1] as Array<{ name: string }>)[0].name).toBe('renamed');
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.toast.anchorSaved', duration: 1500 });
    m.toggleAnchorProp('sceneLink', true);
    expect((s.writes[1][1] as Array<{ id: string; sceneLink: boolean }>).map((a) => [a.id, a.sceneLink])).toEqual([['a', true], ['b', false]]);
    m.deleteAnchor();
    expect((s.writes[2][1] as Array<{ id: string }>).map((a) => a.id)).toEqual(['b']);
    expect(m.selectedAnchorId.value).toBe('');
  });

  it('extractAnchor reports the two precondition errors without writing', async () => {
    const { s, m } = make({}, undefined);
    await m.extractAnchor();
    expect(m.anchorExtractStage.value).toBe('error');
    expect(m.anchorExtractMessage.value).toBe('image.toast.anchorAiNotReady');
    const { m: m2 } = make({}, {});
    await m2.extractAnchor();
    expect(m2.anchorExtractMessage.value).toBe('image.toast.anchorSelectNpcFirst');
    expect(s.setValue).not.toHaveBeenCalled();
  });

  it('extractAnchor fails with "NPC not found" for an unknown NPC and always resets the busy flag', async () => {
    const { m } = make({}, {});
    m.editAnchorNpc.value = '不存在';
    await m.extractAnchor();
    expect(m.anchorExtracting.value).toBe(false);
    expect(m.anchorExtractStage.value).toBe('error');
    expect(m.anchorExtractMessage.value).toBe('image.toast.anchorExtractFailed|{"error":"NPC not found"}');
  });
});

describe('useArtistPresets', () => {
  function make(initial: Record<string, unknown> = {}) {
    const s = makeStateAccess(initial);
    const openUnderstandingForFile = vi.fn(async () => {});
    const m = useArtistPresets({
      get: s.get, setValue: s.setValue, t: identityT,
      backend: computed(() => 'novelai' as const),
      configuredModelFor: () => undefined,
      openUnderstandingForFile,
    });
    return { s, m, openUnderstandingForFile };
  }
  const preset = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, scope: 'npc', artistString: 'as', positive: 'pos', negative: 'neg', ...over });

  it('splits PNG / image-derived presets from artist presets and by scope', () => {
    const { m } = make({ [PRESETS]: [preset('p1'), preset('png_1'), preset('img_1'), preset('p2', { scope: 'scene' })] });
    expect(m.pngPresets.value.map((p) => p.id)).toEqual(['png_1', 'img_1']);
    expect(m.npcArtistPresets.value.map((p) => p.id)).toEqual(['p1']);
    expect(m.artistOnlyPresets.value.map((p) => p.id)).toEqual(['p1']);
    m.presetScope.value = 'scene';
    expect(m.artistOnlyPresets.value.map((p) => p.id)).toEqual(['p2']);
  });

  it('create -> edit -> save -> toggle replicate -> delete write the expected lists', () => {
    vi.spyOn(Date, 'now').mockReturnValue(99);
    const { s, m } = make({ [PRESETS]: [preset('png_1', { pngMeta: { source: 's', originalPrompt: '', rawText: '', replicateParams: false } })] });
    m.newPresetName.value = '  My  ';
    m.createPreset();
    expect(s.writes[0][1]).toEqual([
      expect.objectContaining({ id: 'png_1' }),
      { id: 'preset_99', name: 'My', scope: 'npc', artistString: '', positive: '', negative: '' },
    ]);
    expect(m.selectedPresetId.value).toBe('preset_99');
    expect(m.newPresetName.value).toBe('');

    m.newPresetPositive.value = 'P'; m.newPresetNegative.value = 'N'; m.newPresetArtist.value = 'A';
    m.savePreset();
    expect((s.writes[1][1] as Array<Record<string, unknown>>)[1]).toMatchObject({ name: 'My', positive: 'P', negative: 'N', artistString: 'A' });

    m.selectedPresetId.value = 'png_1';
    m.loadPresetIntoEditor();
    expect([m.newPresetName.value, m.newPresetPositive.value, m.newPresetArtist.value]).toEqual(['png_1', 'pos', 'as']);
    m.toggleReplicateParams(true);
    expect((s.writes[2][1] as Array<{ pngMeta?: { replicateParams: boolean } }>)[0].pngMeta?.replicateParams).toBe(true);

    m.deletePreset();
    expect((s.writes[3][1] as Array<{ id: string }>).map((p) => p.id)).toEqual(['preset_99']);
    expect(m.selectedPresetId.value).toBe('');
  });

  it('toggleReplicateParams / savePreset do nothing without a (PNG) selection', () => {
    const { s, m } = make({ [PRESETS]: [preset('p1')] });
    m.savePreset();
    m.toggleReplicateParams(true);
    m.selectedPresetId.value = 'p1';
    m.toggleReplicateParams(true); // no pngMeta
    expect(s.setValue).not.toHaveBeenCalled();
  });

  it('exportArtistPresets only toasts when the scope has no presets', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { m } = make({ [PRESETS]: [preset('p', { scope: 'scene' })] });
    m.exportArtistPresets();
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'info', message: 'image.toast.noPresetsToExport', duration: 1500 });
  });
});

describe('useGallery', () => {
  function make(archiveByNpc: Record<string, unknown> = {}, initial: Record<string, unknown> = {}) {
    const s = makeStateAccess({ '角色.图片档案': undefined, ...initial });
    const service = {
      setNpcAvatar: vi.fn(), setNpcPortrait: vi.fn(), clearNpcAvatar: vi.fn(), clearNpcPortrait: vi.fn(),
      setNpcBackground: vi.fn(), clearNpcBackground: vi.fn(), setNpcSecretPart: vi.fn(), clearNpcSecretPart: vi.fn(),
      deleteNpcImage: vi.fn(), clearNpcHistory: vi.fn(),
      state: { setPersistentWallpaper: vi.fn(), clearPersistentWallpaper: vi.fn() },
    };
    const relationships = ref<Array<Record<string, unknown>> | undefined>(
      Object.entries(archiveByNpc).map(([name, archive]) => ({ 名称: name, 性别: name === '男' ? '男' : '女', 图片档案: archive })),
    );
    const tick = ref(0);
    const g = useGallery({ useValue: <T,>(path: string) => computed(() => s.get<T>(path)), get: s.get, t: identityT, imageService: service as never, relationships, imageUpdateTick: tick });
    return { s, g, service, relationships, tick };
  }

  it('lists only NPCs with history, with the player first, and reverses the selected archive', async () => {
    const { g, s } = make({
      甲: { 生图历史: [{ id: '1' }, { id: '2' }] },
      乙: { 生图历史: [] },
      丙: {},
    });
    expect(g.npcsWithImages.value.map((n) => n['名称'])).toEqual(['甲']);
    s.tree['角色.图片档案'] = { 生图历史: [{ id: 'p' }] };
    await nextTick();
    expect(g.npcsWithImages.value.map((n) => n['名称'])).toEqual(['__player__', '甲']);
    g.galleryNpc.value = '甲';
    expect(g.galleryImages.value.map((i) => i.id)).toEqual(['2', '1']);
    g.galleryNpc.value = '__player__';
    expect(g.galleryImages.value.map((i) => i.id)).toEqual(['p']);
    expect(g.galleryNpcData.value?.['名称']).toBe('image.scene.playerFallback');
    g.galleryNpc.value = '';
    expect(g.galleryImages.value).toEqual([]);
    expect(g.galleryNpcData.value).toBeNull();
  });

  it('selection eligibility: complete non-secret images; secret parts need NSFW mode and a non-male NPC', () => {
    const { g, s } = make({ 甲: {}, 男: {} });
    expect(g.canSelectAvatar({ id: 'a', createdAt: 1, status: 'complete' })).toBe(true);
    expect(g.canSelectAvatar({ id: 'a', createdAt: 1, status: 'complete', composition: 'secret_part' })).toBe(false);
    expect(g.canSelectPortrait({ id: 'a', createdAt: 1, status: 'failed' })).toBe(false);
    expect(g.canSelectBackground({ id: 'a', createdAt: 1, status: 'complete', composition: 'secret_part' })).toBe(true);
    const img = { id: 'a', createdAt: 1, status: 'complete' as const };
    g.galleryNpc.value = '甲';
    expect(g.canSelectSecretPart(img)).toBe(false); // nsfw off
    s.tree['系统.nsfwMode'] = true;
    expect(g.canSelectSecretPart(img)).toBe(true);
    g.galleryNpc.value = '男';
    expect(g.canSelectSecretPart(img)).toBe(false);
    expect(g.canSelectSecretPart({ ...img, status: 'pending' })).toBe(false);
  });

  it('current-selection predicates read the archive of the selected NPC (and secret slots)', () => {
    const { g } = make({ 甲: { 已选头像图片ID: 'av', 已选立绘图片ID: 'po', 已选背景图片ID: 'bg', 香闺秘档: { 胸部: { id: 'sb' } } } });
    g.galleryNpc.value = '甲';
    expect([g.isCurrentAvatar('av'), g.isCurrentPortrait('po'), g.isCurrentBackground('bg'), g.isCurrentAvatar('x')]).toEqual([true, true, true, false]);
    expect([g.isCurrentSecretPart('sb', 'breast'), g.isCurrentSecretPart('sb', 'vagina')]).toEqual([true, false]);
  });

  it('actions need a selected NPC, delegate to the service, and secret-part changes bump the tick', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { g, service, tick } = make({ 甲: {} });
    g.setAsAvatar('a');
    g.deleteImage('a');
    expect(service.setNpcAvatar).not.toHaveBeenCalled();
    expect(service.deleteNpcImage).not.toHaveBeenCalled();

    g.galleryNpc.value = '甲';
    g.setAsAvatar('a'); g.setAsPortrait('b'); g.setAsBackground('c');
    g.clearAvatar(); g.clearPortrait(); g.clearBackground();
    g.deleteImage('d');
    g.deleteNpcHistoryEntry('乙', 'e');
    expect(service.setNpcAvatar).toHaveBeenCalledWith('甲', 'a');
    expect(service.setNpcPortrait).toHaveBeenCalledWith('甲', 'b');
    expect(service.setNpcBackground).toHaveBeenCalledWith('甲', 'c');
    expect(service.clearNpcAvatar).toHaveBeenCalledWith('甲');
    expect(service.deleteNpcImage.mock.calls).toEqual([['甲', 'd'], ['乙', 'e']]);

    g.setAsSecretPart('s', 'vagina');
    expect(service.setNpcSecretPart).toHaveBeenCalledWith('甲', 'vagina', 's');
    expect(tick.value).toBe(1);
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.gallery.toast.setSecretPart|{"part":"image.gallery.action.partVagina"}', duration: 1500 });
    g.clearSecretPart('vagina');
    expect(tick.value).toBe(2);

    g.clearNpcImages();
    expect(service.clearNpcHistory).toHaveBeenCalledWith('甲');
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'info', message: 'image.toast.clearedNpcImages|{"name":"甲"}', duration: 1500 });
  });

  it('persistent wallpaper: toasts and the reactive id check', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { g, service, s } = make({}, { '系统.扩展.image.persistentWallpaper': 'w1' });
    expect(g.isPersistentWallpaper('w1')).toBe(true);
    expect(g.isPersistentWallpaper('w2')).toBe(false);
    s.tree['系统.扩展.image.persistentWallpaper'] = undefined;
    expect(g.isPersistentWallpaper('w1')).toBe(false);
    g.setPersistentWallpaper('w2');
    g.clearPersistentWallpaper();
    expect(service.state.setPersistentWallpaper).toHaveBeenCalledWith('w2');
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.toast.setPersistentWallpaper', duration: 1500 });
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'info', message: 'image.toast.clearedPersistentWallpaper', duration: 1500 });
  });
});

describe('useReferenceLibrary', () => {
  it('removes the entry; deletes the blob only when no task still uses it', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const del = vi.fn(async () => {});
    const removeReferenceEntry = vi.fn();
    const used = new Set<string>(['kept']);
    const service = {
      state: {
        getReferenceLibrary: () => [{ id: 'e1', assetId: 'free' }, { id: 'e2', assetId: 'kept' }],
        removeReferenceEntry,
        isAssetReferencedByTasks: (id: string) => used.has(id),
      },
      getAssetCache: () => ({ delete: del }),
    };
    const r = useReferenceLibrary({ imageService: service as never, t: identityT });
    await r.deleteReferenceEntry('e1');
    expect(del).toHaveBeenCalledWith('free');
    expect(emit).toHaveBeenLastCalledWith('ui:toast', { type: 'info', message: 'image.toast.deletedReference', duration: 1500 });
    await r.deleteReferenceEntry('e2');
    expect(del).toHaveBeenCalledTimes(1);
    expect(removeReferenceEntry.mock.calls).toEqual([['e1'], ['e2']]);
    expect(emit).toHaveBeenLastCalledWith('ui:toast', { type: 'info', message: 'image.toast.deletedReferenceKept', duration: 3500 });
  });

  it('without a service there is nothing to list or delete', async () => {
    const r = useReferenceLibrary({ imageService: undefined, t: identityT });
    expect(r.referenceLibrary.value).toEqual([]);
    await expect(r.deleteReferenceEntry('x')).resolves.toBeUndefined();
    await expect(r.loadRefLibThumbnail('x')).resolves.toBeNull();
  });
});

describe('useUnderstanding', () => {
  function make(opts: { civitai: boolean; llm: boolean; defaultEngine?: 'civitai_vlm' | 'general_llm' }) {
    const s = makeStateAccess();
    const apiStore = { apiConfigs: [], apiAssignments: [] } as never;
    const imageService = {
      getUnderstandingConfig: () => ({ defaultEngine: opts.defaultEngine ?? 'civitai_vlm' }),
      getGeneralLlmInfo: () => (opts.llm ? { available: true, model: 'gpt' } : { available: false }),
    };
    const aiService = { getImageConfigForBackend: (b: string) => (b === 'civitai' && opts.civitai ? { name: 'c' } : undefined) };
    const artistPresets = ref<never[]>([]);
    const selectedPresetId = ref('');
    const u = useUnderstanding({
      imageService: imageService as never, aiService: aiService as never, apiStore,
      get: s.get, setValue: s.setValue, t: identityT,
      artistPresets, selectedPresetId, loadPresetIntoEditor: vi.fn(), validateUploadSize: () => true,
    });
    return { u, s };
  }

  it('starts on the configured engine and falls back to the other one when it is unavailable', () => {
    const a = make({ civitai: true, llm: true, defaultEngine: 'general_llm' });
    expect(a.u.understandingEngine.value).toBe('general_llm');
    expect(a.u.understandingNoEngine.value).toBe(false);
    const b = make({ civitai: false, llm: true });
    expect(b.u.understandingEngine.value).toBe('general_llm'); // immediate watch moved off the disabled default
    const c = make({ civitai: false, llm: false });
    expect(c.u.understandingNoEngine.value).toBe(true);
    expect(c.u.understandingEngine.value).toBe('civitai_vlm');
  });

  it('labels the general LLM engine with the model name and writes the Civitai model preset', () => {
    const { u, s } = make({ civitai: true, llm: true });
    expect(u.understandingEngineOptions.value.map((o) => o.label)).toEqual(['image.presets.engineCivitai', 'image.presets.engineGeneralLlm|{"model":"gpt"}']);
    expect(u.understandingCivitaiModel.value).toBe('claude-sonnet-5');
    u.applyUnderstandingModel('gpt-4o-mini');
    expect(s.writes).toEqual([['系统.扩展.image.config.understanding.civitaiModel', 'gpt-4o-mini']]);
    expect(u.UNDERSTANDING_MODEL_PRESETS.map((p) => p.id)).toEqual(['claude-sonnet-5', 'gpt-4o-mini', 'gemini-2.5-flash']);
  });

  it('saveUnderstandingAsPreset needs a result; with one it appends a scoped img_ preset and closes the mode', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5);
    const emit = vi.spyOn(eventBus, 'emit');
    const { u, s } = make({ civitai: true, llm: true });
    u.saveUnderstandingAsPreset('npc');
    expect(s.setValue).not.toHaveBeenCalled();
    u.understandingMode.value = true;
    u.understandingResult.value = { provider: 'general_llm', task: 'both', positiveDraft: 'draft', negativeDraft: 'neg', raw: { a: 1 } } as never;
    u.understandingEditDraft.value = 'edited';
    u.saveUnderstandingAsPreset('scene');
    const saved = (s.writes[0][1] as Array<Record<string, unknown>>)[0];
    expect(saved).toMatchObject({ id: 'img_5', scope: 'scene', positive: 'edited', negative: 'neg', pngMeta: { source: 'llm_both', originalPrompt: 'draft', rawText: '{"a":1}', replicateParams: false } });
    expect(u.understandingMode.value).toBe(false);
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.toast.savedAsStylePresetScene', duration: 2000 });
  });
});
