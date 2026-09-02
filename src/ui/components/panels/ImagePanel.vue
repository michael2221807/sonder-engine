<script setup lang="ts">
// App doc: docs/user-guide/pages/game-image.md
/**
 * ImagePanel — image generation workspace.
 *
 * This is a simplified first-pass that provides actual usable controls.
 * Full ImageManagerModal (7-tab system) will be built on top of this foundation.
 */
import { ref, computed, inject, onMounted, onUnmounted, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import type { ImageService } from '@/engine/image/image-service';
import type { ImageBackendType, ImageTask, ArtistPreset, ImageAsset, SecretPartType, StylePreset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';
import type { GameTime, SceneNpcDetail } from '@/engine/image/scene-context';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import ImageViewer from '@/ui/components/image/ImageViewer.vue';
import RegenerateSameModal from '@/ui/components/image/RegenerateSameModal.vue';
import CivitaiLoraShelf from '@/ui/components/image/CivitaiLoraShelf.vue';
import { prepareCivitaiLora } from '@/engine/image/civitai-lora';
import { buildPromptStyleInjection } from '@/engine/image/style-preset-injection';
import { resolveStyleParams } from '@/engine/image/style-param-resolver';
import { PROVIDER_CAPABILITIES } from '@/engine/image/provider-capabilities';
import type { CivitaiLoraShelfItem, CivitaiLoraScope, CivitaiLoraSnapshot } from '@/engine/image/types';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaSelect, { type SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaTabBar, { type TabItem } from '@/ui/components/shared/AgaTabBar.vue';
import AgaProgressBar from '@/ui/components/shared/AgaProgressBar.vue';
import AgaConfirmModal from '@/ui/components/shared/AgaConfirmModal.vue';
import MultiReferencePicker, { type MultiReferenceItem } from '@/ui/components/shared/MultiReferencePicker.vue';
import { appendReferenceFiles, readFileAsDataUrl } from '@/ui/components/shared/multi-reference-files';
import { SEEDREAM_MAX_REFERENCE_IMAGES } from '@/engine/image/providers/volcengine';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useGameState } from '@/ui/composables/useGameState';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { eventBus } from '@/engine/core/event-bus';
import { extractAnchorViaAI } from '@/engine/image/anchor-extractor';
import { providerCatalog } from '@/engine/providers';
import type { AIService } from '@/engine/ai/ai-service';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import { getDefaultPresets, getDefaultModelBundles } from '@/engine/image/transformer-presets';
import { SCENE_PORTRAIT_SIZE_OPTIONS, SCENE_LANDSCAPE_SIZE_OPTIONS, sizeOptionsToSelectOptions } from '@/engine/image/image-size-options';
import type { TransformerPromptPreset, ModelTransformerBundle, TransformerDefaultsData } from '@/engine/image/transformer-presets';

const { t } = useI18n();
const imageService = inject<ImageService>('imageService');
const aiService = inject<AIService | undefined>('aiService', undefined);
const apiStore = useAPIManagementStore();
const { isLoaded, get, setValue, useValue } = useGameState();
const relationships = useValue<Array<Record<string, unknown>>>(DEFAULT_ENGINE_PATHS.relationships);

// Reactive trigger: incremented on every image event to force computed re-evaluation.
// Necessary because task queue is an in-memory Map — Vue cannot track its mutations.
const imageUpdateTick = ref(0);
const unsubImageUpdate = eventBus.on('image:task-update', () => { imageUpdateTick.value++; });
onUnmounted(() => { unsubImageUpdate(); });

const enabled = computed(() => get('系统.扩展.image.enabled') === true);

// ── Persistence: debounced auto-save for all image config changes ──
// ImagePanel writes to 40+ state paths under 系统.扩展.image.*.
// Each setValue() updates the reactive state tree but does NOT persist to IndexedDB.
// This watcher listens for any change and debounces a single save request.
const imageConfigRoot = useValue<Record<string, unknown>>('系统.扩展.image');
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(imageConfigRoot, () => {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    eventBus.emit('engine:request-save');
    saveDebounceTimer = null;
  }, 800);
}, { deep: true });
onUnmounted(() => { if (saveDebounceTimer) clearTimeout(saveDebounceTimer); });

// Tab state
const tabs = computed<TabItem[]>(() => [
  { key: 'manual', label: t('image.tab.manual') },
  { key: 'gallery', label: t('image.tab.gallery') },
  { key: 'scene', label: t('image.tab.scene') },
  { key: 'queue', label: t('image.tab.queue') },
  { key: 'history', label: t('image.tab.history') },
  { key: 'presets', label: t('image.tab.presets') },
  { key: 'rules', label: t('image.tab.rules') },
  { key: 'settings', label: t('image.tab.settings') },
]);
const activeTab = ref('manual');

// Manual generation state
const selectedNpc = ref('');
const composition = ref<'portrait' | 'half-body' | 'full-length' | 'custom'>('portrait');
const customComposition = ref('');
const artStyle = ref<'none' | 'generic' | 'anime' | 'realistic' | 'chinese'>('none');
const backend = computed<ImageBackendType>(() => {
  const saved = String(get('系统.扩展.image.config.defaultBackend') ?? 'novelai');
  // Catalog-derived allowlist (review Critical 2026-08-26: a hand-written set
  // here silently coerced newly-added backends back to novelai).
  return IMAGE_BACKEND_KEYS.includes(saved as ImageBackendType) ? saved as ImageBackendType : 'novelai';
});
const extraPrompt = ref('');
const selectedArtistPreset = ref('');
const selectedPngPreset = ref('');
const sizePreset = ref<'none' | '1:1' | '3:4' | '9:16' | '16:9' | 'custom'>('none');
const sizeScale = ref<'1x' | '2x'>('2x');
const manualWidth = ref('1024');
const manualHeight = ref('1024');
const backgroundMode = ref(true);
const backendSupportsImg2Img = computed(() =>
  PROVIDER_CAPABILITIES[backend.value]?.imageToImage === true,
);
/**
 * Numeric 重绘幅度 slider — only rendered for backends whose API actually has a
 * strength parameter (NovelAI `strength` / Civitai `sourceImageDenoiseStrenght`).
 * Seedream/Doubao has none, so the slider would be a dead control there; the
 * hint points users at 额外要求 instead (capability-gated, epic 2026-08-27).
 */
const backendSupportsRefStrength = computed(() =>
  PROVIDER_CAPABILITIES[backend.value]?.referenceStrength === true,
);
/**
 * 多图参考（PO 决策① 2026-08-29）：只有声明 `multiReference` 的后端（当前仅
 * 豆包 Seedream）渲染多图选择器；其余后端保持原有单张控件，绝不出现「选了 5 张
 * 只有 1 张生效」的死控件。
 */
const backendSupportsMultiRef = computed(() =>
  PROVIDER_CAPABILITIES[backend.value]?.multiReference === true,
);
const npcReferenceEnabled = ref(false);
const npcReferenceItems = ref<MultiReferenceItem[]>([]);
const npcReferenceSource = ref('upload');
const npcReferenceDenoise = ref(0.65);
const npcReferenceFile = ref<File | null>(null);
const npcReferenceDataUrl = ref<string | null>(null);
const npcReferenceAssetId = ref<string | null>(null);
// 换 NPC 必须清空参考图：留着上一个角色的图会被当成这个角色的参考发出去。
// 单图时代就存在，多图把影响面从「1 张」放大到「14 张」（review Minor 2026-08-29）。
watch(selectedNpc, () => {
  npcReferenceItems.value = [];
  npcReferenceFile.value = null;
  npcReferenceDataUrl.value = null;
  npcReferenceAssetId.value = null;
});
const npcReferenceNoise = ref(0.1);
const refConfigDenoiseDefault = computed(() =>
  (get('系统.扩展.image.config.reference.defaultDenoiseStrength') as number | undefined) ?? 0.65,
);
const refConfigMaxUploadBytes = computed(() =>
  (get('系统.扩展.image.config.reference.maxUploadBytes') as number | undefined) ?? 10485760,
);
const refConfigPersist = computed(() =>
  get('系统.扩展.image.config.reference.persistUploadedReferences') !== false,
);
watch(npcReferenceEnabled, (v) => { if (v) npcReferenceDenoise.value = refConfigDenoiseDefault.value; });

function validateUploadSize(file: File): boolean {
  if (file.size > refConfigMaxUploadBytes.value) {
    const limitMB = (refConfigMaxUploadBytes.value / 1048576).toFixed(0);
    eventBus.emit('ui:toast', { type: 'error', message: t('image.manual.fileOversize', { actual: (file.size / 1048576).toFixed(1), limit: limitMB }), duration: 3000 });
    return false;
  }
  return true;
}

async function persistUploadedReference(file: File, _dataUrl: string): Promise<string | null> {
  if (!imageService || !refConfigPersist.value) return null;
  const assetId = `ref_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const blob = file;
  const asset: ImageAsset = {
    id: assetId,
    taskId: '',
    storageKey: assetId,
    mimeType: file.type || 'image/png',
    width: 0,
    height: 0,
    sizeBytes: file.size,
    backend: 'civitai',
    createdAt: Date.now(),
    origin: 'upload',
  };
  try {
    await imageService.getAssetCache().store(asset, blob);
    imageService.state.addReferenceEntry({
      id: generateReferenceId(),
      assetId,
      name: file.name.replace(/\.\w+$/, ''),
      mimeType: file.type || 'image/png',
      width: 0,
      height: 0,
      sizeBytes: file.size,
      source: 'upload',
      createdAt: Date.now(),
    });
    return assetId;
  } catch (err) {
    console.warn('[ImagePanel] Failed to persist uploaded reference:', err);
    return null;
  }
}

/**
 * 多图选择器的追加入口。读取/校验/持久化/溢出提示全部走共用助手
 * `appendReferenceFiles`（顺序 await，保证「图N」编号与选择顺序一致）。
 */
async function addMultiRefFiles(
  target: Ref<MultiReferenceItem[]>,
  files: FileList,
): Promise<void> {
  target.value = await appendReferenceFiles(files, {
    max: SEEDREAM_MAX_REFERENCE_IMAGES,
    current: target.value,
    validate: validateUploadSize,
    persist: persistUploadedReference,
    makeId: generateReferenceId,
    onOverflow: () => eventBus.emit('ui:toast', {
      type: 'warning',
      message: t('image.multiRef.tooMany', { max: SEEDREAM_MAX_REFERENCE_IMAGES }),
      duration: 3000,
    }),
  });
}

/** 把一张已有资产追加进多图列表（快捷来源：头像 / 壁纸等；重复不加）。 */
async function addAssetToMultiRef(
  target: Ref<MultiReferenceItem[]>,
  assetId: string,
  label: string,
): Promise<void> {
  if (!assetId || !imageService) return;
  if (target.value.length >= SEEDREAM_MAX_REFERENCE_IMAGES) return;
  if (target.value.some((it) => it.assetId === assetId)) return;
  try {
    const entry = await imageService.getAssetCache().retrieve(assetId);
    if (!entry) return;
    const dataUrl = await readFileAsDataUrl(new File([entry.blob], label, { type: entry.metadata.mimeType }));
    target.value = [...target.value, { id: generateReferenceId(), dataUrl, assetId, label }];
  } catch (err) {
    console.warn('[ImagePanel] 快捷来源加入多图参考失败:', err);
  }
}

function onNpcMultiRefFiles(files: FileList): void {
  void addMultiRefFiles(npcReferenceItems, files);
}
function onSceneMultiRefFiles(files: FileList): void {
  void addMultiRefFiles(sceneReferenceItems, files);
}
// 模板里 ref 会被解包成数组，拿不到 ref 本体 → 各配一个薄 handler
function onNpcQuickSource(): void {
  void addAssetToMultiRef(npcReferenceItems, npcAvatarAssetId.value, t('image.manual.refAvatar'));
}
function onSceneQuickSource(): void {
  void addAssetToMultiRef(sceneReferenceItems, sceneWallpaperAssetId.value, t('image.scene.refWallpaper'));
}

/** 当前 NPC 已选头像/立绘的资产 id（多图选择器的快捷来源按钮据此显隐）。 */
const npcAvatarAssetId = computed(() => {
  const archive = selectedNpcData.value?.['图片档案'] as Record<string, unknown> | undefined;
  return String(archive?.['已选头像图片ID'] ?? archive?.['已选立绘图片ID'] ?? '') || '';
});
const npcQuickSources = computed(() => (npcAvatarAssetId.value
  ? [{ key: 'avatar', label: t('image.manual.refAvatar') }]
  : []));
const sceneWallpaperAssetId = computed(() =>
  String(get('系统.扩展.image.sceneArchive.当前壁纸图片ID') ?? '') || '');
const sceneQuickSources = computed(() => (sceneWallpaperAssetId.value
  ? [{ key: 'wallpaper', label: t('image.scene.refWallpaper') }]
  : []));

/** 多图选择器 → 引擎入参。顺序原样保留（= 提示词里的「图N」）。 */
function multiRefToInputs(
  items: MultiReferenceItem[],
  denoise: number,
): import('@/engine/image/types').ImageReferenceInput[] {
  return items.map((it) => (it.assetId
    ? { id: generateReferenceId(), role: 'source' as const, source: 'asset' as const, assetId: it.assetId, denoiseStrength: denoise }
    : { id: generateReferenceId(), role: 'source' as const, source: 'data_url' as const, dataUrl: it.dataUrl, denoiseStrength: denoise }));
}

async function onNpcReferenceFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!validateUploadSize(file)) { (e.target as HTMLInputElement).value = ''; return; }
  npcReferenceFile.value = file;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      npcReferenceDataUrl.value = reader.result as string;
      npcReferenceAssetId.value = await persistUploadedReference(file, reader.result as string);
    } catch (err) {
      console.warn('[ImagePanel] Reference persist failed:', err);
      npcReferenceAssetId.value = null;
    }
  };
  reader.readAsDataURL(file);
}

const isGenerating = ref(false);
const lastTask = ref<ImageTask | null>(null);
const manualFlowStage = ref<'idle' | 'confirm' | 'submitting'>('idle');
const manualStatusText = ref('');

// Secret part state (independent from manual form)
const secretStyle = ref<'none' | 'generic' | 'anime' | 'realistic' | 'chinese'>('none');
const secretSizePreset = ref<'none' | '1:1' | '3:4' | '9:16' | '16:9'>('1:1');
const secretArtistPreset = ref('');
const secretPngPreset = ref('');
const secretExtraPrompt = ref('');
const secretStatusText = ref('');
const secretBusy = ref('');
const errorMsg = ref('');

// Viewer state
const viewerOpen = ref(false);
const viewerSrc = ref('');

function closeViewer() {
  viewerOpen.value = false;
  if (viewerSrc.value) {
    URL.revokeObjectURL(viewerSrc.value);
    viewerSrc.value = '';
  }
}

// Confirm dialog state
const showDeleteConfirm = ref(false);
const pendingDeleteId = ref('');

function requestDelete(assetId: string) {
  pendingDeleteId.value = assetId;
  showDeleteConfirm.value = true;
}

function confirmDelete() {
  deleteImage(pendingDeleteId.value);
  showDeleteConfirm.value = false;
  pendingDeleteId.value = '';
}

// NPC options for AgaSelect
const npcOptions = computed<SelectOption[]>(() => {
  const list = relationships.value;
  if (!Array.isArray(list)) return [];
  return list.map((npc) => ({
    label: `${npc['名称'] ?? '?'}${npc['是否主要角色'] ? ' ★' : ''}`,
    value: String(npc['名称'] ?? ''),
  }));
});

const compositionOptions = computed(() => [
  { label: t('image.manual.composition.portrait'), subtitle: t('image.manual.composition.portraitSubtitle'), value: 'portrait' as const },
  { label: t('image.manual.composition.halfBody'), subtitle: t('image.manual.composition.halfBodySubtitle'), value: 'half-body' as const },
  { label: t('image.manual.composition.fullLength'), subtitle: t('image.manual.composition.fullLengthSubtitle'), value: 'full-length' as const },
  { label: t('image.manual.composition.custom'), subtitle: t('image.manual.composition.customSubtitle'), value: 'custom' as const },
]);
const isCustomComposition = computed(() => composition.value === 'custom');

const SIZE_BASES: Record<'1:1' | '3:4' | '9:16' | '16:9', { w: number; h: number }> = {
  '1:1': { w: 1024, h: 1024 },
  '3:4': { w: 768, h: 1024 },
  '9:16': { w: 576, h: 1024 },
  '16:9': { w: 1024, h: 576 },
};

const sizePresetOptions = computed(() => [
  { label: t('image.manual.sizePreset.none'), value: 'none' as const },
  { label: '1:1', value: '1:1' as const },
  { label: '3:4', value: '3:4' as const },
  { label: '9:16', value: '9:16' as const },
  { label: '16:9', value: '16:9' as const },
  { label: t('image.manual.sizePreset.custom'), value: 'custom' as const },
]);

// Auto-update width/height when preset or scale changes
const presetSize = computed(() => {
  const p = sizePreset.value;
  if (p === 'none' || p === 'custom') return null;
  const base = SIZE_BASES[p];
  const factor = sizeScale.value === '2x' ? 2 : 1;
  return { w: base.w * factor, h: base.h * factor };
});

// Watch preset/scale changes → sync to width/height
watch([sizePreset, sizeScale], () => {
  const ps = presetSize.value;
  if (ps) {
    manualWidth.value = String(ps.w);
    manualHeight.value = String(ps.h);
  }
});

// Reset size preset when switching away from custom composition
watch(composition, (newVal) => {
  if (newVal !== 'custom' && sizePreset.value !== 'none') {
    sizePreset.value = 'none';
  }
});

const currentSizeDisplay = computed(() => {
  if (!isCustomComposition.value) return t('image.manual.sizePreset.none');
  if (sizePreset.value === 'none') return t('image.manual.sizePreset.none');
  const w = manualWidth.value.trim();
  const h = manualHeight.value.trim();
  if (!w || !h || !/^\d+$/.test(w) || !/^\d+$/.test(h)) return t('image.manual.sizeNotFilled');
  return `${w}x${h}`;
});

/**
 * Manual-size → StylePreset carrier. The engine only honors width/height via
 * `params.preset`; without this the size grid was a dead control and every
 * custom-composition request fell back to the composer's 1024×1024 default.
 * Only applies when the size grid is active (custom composition + a selected
 * preset) and both fields hold positive integers.
 */
const manualSizePreset = computed<StylePreset | undefined>(() => {
  if (!isCustomComposition.value || sizePreset.value === 'none') return undefined;
  const w = Number(manualWidth.value.trim());
  const h = Number(manualHeight.value.trim());
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return undefined;
  return { id: 'npc_manual_size', name: '手动分辨率', positivePrefix: '', positiveSuffix: '', negative: '', source: 'manual', width: w, height: h };
});

const styleOptions = computed(() => [
  { label: t('image.manual.artStyle.none'), value: 'none' as const },
  { label: t('image.manual.artStyle.generic'), value: 'generic' as const },
  { label: t('image.manual.artStyle.anime'), value: 'anime' as const },
  { label: t('image.manual.artStyle.realistic'), value: 'realistic' as const },
  { label: t('image.manual.artStyle.chinese'), value: 'chinese' as const },
]);

// Catalog-derived (epic P0 §3.3): a new image vendor appears here without
// touching this file. Labels resolve via the shared api.backend.* i18n keys.
const ALL_IMAGE_BACKENDS = computed<SelectOption[]>(() =>
  providerCatalog.byCategory('image').map((d) => ({ label: t(`api.backend.${d.id}`), value: d.id })),
);

const IMAGE_BACKEND_KEYS = providerCatalog.byCategory('image').map((d) => d.id) as ImageBackendType[];

function getImageApiForBackend(bk: string): import('@/engine/ai/types').APIConfig | null {
  const assignment = apiStore.apiAssignments.find((a) => a.type === `imageGen_${bk}`);
  if (!assignment || assignment.apiId === 'default') return null;
  const cfg = apiStore.apiConfigs.find((c) => c.id === assignment.apiId && c.enabled && (c.apiCategory ?? 'llm') === 'image');
  return cfg ?? null;
}

const configuredBackends = computed<Set<string>>(() => {
  apiStore.apiConfigs; apiStore.apiAssignments;
  const set = new Set<string>();
  for (const bk of IMAGE_BACKEND_KEYS) {
    if (getImageApiForBackend(bk)) set.add(bk);
  }
  if (set.size === 0) {
    const legacyAssign = apiStore.apiAssignments.find((a) => a.type === 'imageGeneration');
    if (legacyAssign && legacyAssign.apiId !== 'default') {
      const cfg = apiStore.apiConfigs.find((c) => c.id === legacyAssign.apiId && c.enabled && (c.apiCategory ?? 'llm') === 'image');
      // Epic P0: the persisted backend field replaces URL sniffing (backfilled
      // by the store's load-time migration; 'custom' has no per-backend route).
      const b = cfg?.backend;
      if (b && IMAGE_BACKEND_KEYS.includes(b as ImageBackendType)) set.add(b);
    }
  }
  return set;
});

const backendOptions = computed<SelectOption[]>(() => {
  const available = configuredBackends.value;
  if (available.size === 0) return [{ label: t('image.backend.placeholder'), value: '' }];
  return ALL_IMAGE_BACKENDS.value.filter((o) => available.has(o.value));
});


const civitaiSchedulerOptions: SelectOption[] = [
  { label: 'Euler A', value: 'EulerA' },
  { label: 'Euler', value: 'Euler' },
  { label: 'DPM++ 2M', value: 'DPM2M' },
  { label: 'DPM++ 2S A', value: 'DPM2SA' },
  { label: 'DPM++ SDE', value: 'DPMSDE' },
  { label: 'DDIM', value: 'DDIM' },
  { label: 'UniPC', value: 'UniPC' },
  { label: 'LCM', value: 'LCM' },
  { label: 'Heun', value: 'Heun' },
  { label: 'DPM++ 2M Karras', value: 'DPM2MKarras' },
  { label: 'DPM++ SDE Karras', value: 'DPMSDEKarras' },
  { label: 'DEIS', value: 'DEIS' },
];

const civitaiOutputFormatOptions: SelectOption[] = [
  { label: 'PNG', value: 'png' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'WebP', value: 'webp' },
];

/** Human-readable label for an image backend. Reuses backendOptions as the
 *  source so any label change propagates without duplicating strings. */
function backendLabel(value: string): string {
  return ALL_IMAGE_BACKENDS.value.find((b) => b.value === value)?.label ?? value;
}

/**
 * Render the "使用模型" cell.
 *
 * Some backends ship with the model baked into their config (NovelAI / DALL-E /
 * SD-WebUI), so `img.model` is the active ckpt name. Others route the model
 * through the workflow graph itself (ComfyUI with a user-supplied workflow)
 * and the APIConfig's `.model` is legitimately empty — in that case we fall
 * back to the backend label so the cell still carries signal.
 */
function modelCellText(img: { model?: string; backend?: string }): string {
  const model = (img.model ?? '').trim();
  const backend = img.backend ? backendLabel(img.backend) : '';
  if (model && backend) return `${backend} · ${model}`;
  if (model) return model;
  if (backend) return backend;
  return t('image.manual.modelNotRecorded');
}

function apiConfigLabel(img: { apiConfigName?: string }): string {
  return img.apiConfigName ?? '';
}

// Selected NPC data
const selectedNpcData = computed(() => {
  if (!selectedNpc.value || !Array.isArray(relationships.value)) return null;
  return relationships.value.find((n) => n['名称'] === selectedNpc.value) ?? null;
});

// PNG preset options for manual tab
const pngPresetOptions = computed<SelectOption[]>(() => [
  { label: t('image.manual.anchor.none'), value: '' },
  ...artistPresets.value
    .filter((p) => p.scope === 'npc' && (p.id.startsWith('png_') || p.id.startsWith('img_')))
    .map((p) => ({ label: p.name, value: p.id })),
]);

// Anchor status for selected NPC
const selectedNpcAnchor = computed(() => {
  if (!selectedNpc.value) return null;
  const anchors = get('系统.扩展.image.characterAnchors');
  if (!Array.isArray(anchors)) return null;
  return (anchors as CharacterAnchor[]).find((a) => a.npcName === selectedNpc.value) ?? null;
});

// Per-NPC task status (最近状態 card + active task display)
const selectedNpcActiveTask = computed(() => {
  void imageUpdateTick.value; // reactive dependency
  if (!selectedNpc.value || !imageService) return null;
  const allTasks = imageService.getTaskQueue().getAll();
  return Array.from(allTasks.values())
    .filter((t) => t.targetCharacter === selectedNpc.value && (t.status === 'pending' || t.status === 'tokenizing' || t.status === 'generating'))
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
});

const selectedNpcLastResult = computed(() => {
  void imageUpdateTick.value;
  if (!selectedNpc.value || !imageService) return null;
  const allTasks = imageService.getTaskQueue().getAll();
  return Array.from(allTasks.values())
    .filter((t) => t.targetCharacter === selectedNpc.value && (t.status === 'complete' || t.status === 'failed'))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
});

const taskStatusLabel = (status: string) => {
  const labels: Record<string, string> = {
    pending: t('image.queue.status.pending'),
    tokenizing: t('image.queue.status.tokenizing'),
    generating: t('image.queue.status.generating'),
    complete: t('image.queue.status.complete'),
    failed: t('image.queue.status.failed'),
  };
  return labels[status] ?? status;
};

const taskStatusVariant = (status: string) => {
  const variants: Record<string, string> = {
    pending: 'info', tokenizing: 'info', generating: 'warning', complete: 'success', failed: 'danger',
  };
  return variants[status] ?? 'default';
};

/** Click handler for generate button — validates, then either direct submit (bg) or open confirm (fg) */
function handleGenerate() {
  if (!selectedNpc.value) {
    errorMsg.value = t('image.manual.errorSelectNpc');
    return;
  }
  if (isCustomComposition.value && !customComposition.value.trim()) {
    errorMsg.value = t('image.manual.errorCustomComposition');
    return;
  }
  errorMsg.value = '';
  manualStatusText.value = '';

  if (backgroundMode.value) {
    void submitGenerate();
  } else {
    manualFlowStage.value = 'confirm';
  }
}

function cancelConfirm() {
  if (manualFlowStage.value === 'submitting') return;
  manualFlowStage.value = 'idle';
}

const confirmBackdrop = useBackdropClose(cancelConfirm);

function cancelSubmitting() {
  if (manualFlowStage.value !== 'submitting') return;
  manualFlowStage.value = 'idle';
  manualStatusText.value = t('image.manual.cancelStatus');
}

async function submitGenerate() {
  if (!imageService || isGenerating.value || !selectedNpc.value) return;
  isGenerating.value = true;
  errorMsg.value = '';
  lastTask.value = null;

  // Background mode: NO overlay — just inline status text
  // Foreground mode: show overlay with progress tracking
  if (backgroundMode.value) {
    manualFlowStage.value = 'idle';
    manualStatusText.value = t('image.manual.backgroundStatus');
  } else {
    manualFlowStage.value = 'submitting';
    manualStatusText.value = t('image.manual.submittingStatus');
  }

  try {
    const npc = selectedNpcData.value;
    const artStyleMap: Record<string, string> = {
      none: t('image.manual.artStyle.none'),
      generic: t('image.manual.artStyle.generic'),
      anime: t('image.manual.artStyle.anime'),
      realistic: t('image.manual.artStyle.realistic'),
      chinese: t('image.manual.artStyle.chinese'),
    };
    const anchor = selectedNpcAnchor.value;
    const styleInjection = buildPromptStyleInjection(artistPresets.value, [
      selectedArtistPreset.value,
      selectedPngPreset.value,
    ]);

    // Extract rich NPC data as JSON (提取NPC生图基础数据)
    const npcBaseData: Record<string, unknown> = {};
    if (npc) {
      const tryField = (keys: string[]): string => {
        for (const k of keys) {
          const v = npc[k];
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
      };
      const setIfPresent = (key: string, val: unknown) => {
        if (val !== undefined && val !== null && val !== '') npcBaseData[key] = val;
      };
      setIfPresent('姓名', npc['名称'] ?? npc['姓名']);
      setIfPresent('性别', npc['性别']);
      setIfPresent('年龄', typeof npc['年龄'] === 'number' ? npc['年龄'] : undefined);
      setIfPresent('身份', tryField(['身份', '职业']));
      setIfPresent('境界', tryField(['境界']));
      setIfPresent('简介', tryField(['简介', '描述']));
      setIfPresent('核心性格特征', tryField(['核心性格特征', '性格', '性格特征']));
      setIfPresent('性格', tryField(['性格', '核心性格特征']));
      setIfPresent('关系状态', tryField(['关系状态']));
      // Schema key is `外貌描述` (appearance); accept 外貌描写 / 外貌 as legacy fallbacks.
      setIfPresent('外貌描述', tryField(['外貌描述', '外貌描写', '外貌', '外貌要点']));
      setIfPresent('身材描写', tryField(['身材描写', '身材', '身材要点']));
      setIfPresent('衣着风格', tryField(['衣着风格', '衣着', '衣着要点']));
      // Legacy key aliases — direct-prompt-builder order expects these names when
      // the transformer is disabled. Mirror the AGA values into them.
      setIfPresent('外貌', tryField(['外貌描述', '外貌描写', '外貌', '外貌要点']));
      setIfPresent('身材', tryField(['身材描写', '身材', '身材要点']));
      setIfPresent('衣着', tryField(['衣着风格', '衣着', '衣着要点']));
    }

    const appearanceText = String(npc?.['外貌描述'] ?? npc?.['外貌描写'] ?? npc?.['描述'] ?? '');
    const bodyText = String(npc?.['身材描写'] ?? npc?.['身材'] ?? '');
    const outfitText = String(npc?.['衣着风格'] ?? npc?.['衣着'] ?? '');

    let references: import('@/engine/image/types').ImageReferenceInput[] | undefined;
    if (npcReferenceEnabled.value && backendSupportsImg2Img.value) {
      if (backendSupportsMultiRef.value) {
        // 多图后端（豆包）：整个列表按序下发，「图N」= 列表里的第 N 张。
        if (npcReferenceItems.value.length > 0) {
          references = multiRefToInputs(npcReferenceItems.value, npcReferenceDenoise.value);
        }
      } else if (npcReferenceSource.value === 'upload' && (npcReferenceAssetId.value || npcReferenceDataUrl.value)) {
        references = [npcReferenceAssetId.value
          ? { id: generateReferenceId(), role: 'source', source: 'asset', assetId: npcReferenceAssetId.value, denoiseStrength: npcReferenceDenoise.value }
          : { id: generateReferenceId(), role: 'source', source: 'data_url', dataUrl: npcReferenceDataUrl.value!, denoiseStrength: npcReferenceDenoise.value }];
      } else if (npcReferenceSource.value === 'avatar') {
        const archive = selectedNpcData.value?.['图片档案'] as Record<string, unknown> | undefined;
        const avatarId = String(archive?.['已选头像图片ID'] ?? archive?.['已选立绘图片ID'] ?? '');
        if (avatarId) references = [{ id: `ref_npc_${Date.now()}`, role: 'source', source: 'asset', assetId: avatarId, denoiseStrength: npcReferenceDenoise.value }];
      }
      if (!references?.length) {
        eventBus.emit('ui:toast', { type: 'warning', message: t('image.manual.refWarning'), duration: 3000 });
      }
      // NovelAI 的 noise 是单图专属参数；多图后端（豆包）没有它，不需要分发。
      if (references?.length && backend.value === 'novelai') {
        references[0].providerMeta = { noise: npcReferenceNoise.value };
      }
    }

    const pngPresetObj = selectedPngPreset.value ? artistPresets.value.find((p) => p.id === selectedPngPreset.value) : undefined;
    const styleApplicability = pngPresetObj ? resolveStyleParams(pngPresetObj, backend.value, configuredModelFor(backend.value)) : null;

    const task = await imageService.generateCharacterImage({
      characterName: selectedNpc.value,
      description: String(npc?.['描述'] ?? ''),
      appearance: appearanceText,
      bodyDescription: bodyText,
      outfitStyle: outfitText,
      backend: backend.value,
      preset: manualSizePreset.value,
      composition: composition.value,
      customComposition: customComposition.value || undefined,
      artStyle: artStyleMap[artStyle.value] ?? t('image.manual.artStyle.generic'),
      extraPrompt: extraPrompt.value || undefined,
      anchorPositive: anchor?.positive || undefined,
      anchorNegative: anchor?.negative || undefined,
      artistPrefix: styleInjection.artistPrefix,
      extraNegative: styleInjection.extraNegative,
      npcDataJson: JSON.stringify(npcBaseData, null, 2),
      useTransformer: get('系统.扩展.image.config.useTransformer') !== false,
      references,
      styleParamOverrides: styleApplicability?.applied,
    });
    lastTask.value = task;
    if (task.status === 'failed') {
      errorMsg.value = task.error ?? t('image.manual.generateFailed');
      if (!backgroundMode.value) manualFlowStage.value = 'confirm';
    } else if (backgroundMode.value) {
      // Background: update inline status, no overlay
      manualStatusText.value = t('image.manual.submitDoneStatus');
    } else {
      // Foreground: auto-close overlay after 450ms
      manualStatusText.value = t('image.manual.taskSubmitted');
      setTimeout(() => {
        manualFlowStage.value = 'idle';
        manualStatusText.value = t('image.manual.taskCompleteAutoClose');
      }, 450);
    }
  } catch (err) {
    errorMsg.value = (err as Error).message ?? String(err);
    manualFlowStage.value = 'confirm';
    manualStatusText.value = '';
  } finally {
    isGenerating.value = false;
  }
}

function removeTask(taskId: string) {
  imageService?.getTaskQueue().remove(taskId);
}

// 4 clear buttons — NPC completed/all + scene completed/all
function clearNpcQueueCompleted() {
  const queue = imageService?.getTaskQueue();
  if (!queue) return;
  for (const t of queue.getAll().filter((t) => t.subjectType !== 'scene' && (t.status === 'complete' || t.status === 'failed'))) {
    queue.remove(t.id);
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.queue.clearCompleted'), duration: 1500 });
}

function clearNpcQueueAll() {
  const queue = imageService?.getTaskQueue();
  if (!queue) return;
  for (const t of queue.getAll().filter((t) => t.subjectType !== 'scene')) {
    queue.remove(t.id);
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.queue.clearAll'), duration: 1500 });
}

function openManualGenerateForRetry(characterName: string) {
  selectedNpc.value = characterName;
  activeTab.value = 'manual';
}

async function retryTask(task: ImageTask) {
  if (!imageService) return;
  removeTask(task.id);
  try {
    if (task.subjectType === 'scene') {
      // P3 env-tags (2026-04-19): retry path must forward the current env
      // state too — otherwise a retried scene image silently loses weather
      // / festival / environment context that the original had.
      const retryAnchors = imageService.collectSceneRoleAnchors();
      await imageService.generateSceneImage({
        sceneDescription: task.positivePrompt ?? '',
        location: '',
        gameTime: get(DEFAULT_ENGINE_PATHS.gameTime) as GameTime | null | undefined,
        weather: get(DEFAULT_ENGINE_PATHS.weather) as string | undefined,
        festival: get(DEFAULT_ENGINE_PATHS.festival),
        environment: get(DEFAULT_ENGINE_PATHS.environmentTags),
        backend: task.backend ?? 'novelai',
        presentNpcs: retryAnchors.presentNpcs,
        roleAnchors: retryAnchors.roleAnchors.length > 0 ? retryAnchors.roleAnchors : undefined,
      });
    } else {
      await imageService.generateCharacterImage({
        characterName: task.targetCharacter ?? '',
        description: task.positivePrompt ?? '',
        backend: task.backend ?? 'novelai',
      });
    }
    eventBus.emit('ui:toast', { type: 'info', message: t('image.queue.resubmitted'), duration: 1500 });
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.retryFailed', { error: (err as Error).message }), duration: 2000 });
  }
}

async function saveToLocal(assetId: string) {
  try {
    const { ImageAssetCache } = await import('@/engine/image/asset-cache');
    const cache = new ImageAssetCache();
    const result = await cache.retrieve(assetId);
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aga-image-${assetId}.png`;
    a.click();
    URL.revokeObjectURL(url);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.history.savedLocal'), duration: 1500 });
  } catch {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.history.saveFailed'), duration: 2000 });
  }
}

// Secret-part UI rows. Keys are engine-native `SecretPartType` values; the
// service auto-resolves `特征描述` from the NPC's `私密信息.身体部位` array by
// `部位名称` (breast→胸部, vagina→小穴, anus→屁穴).
const secretParts = computed(() => [
  { key: 'breast' as const, label: t('image.secret.bodyPart.breast') },
  { key: 'vagina' as const, label: t('image.secret.bodyPart.vagina') },
  { key: 'anus' as const,   label: t('image.secret.bodyPart.anus') },
]);

/**
 * Secret-part size buttons → StylePreset carrier (same consumption fix as
 * `manualSizePreset`): the engine only honors width/height via `params.preset`.
 * 'none' falls through to the engine's secret_part default (1024×1024).
 */
function secretSizeStylePreset(): StylePreset | undefined {
  const p = secretSizePreset.value;
  if (p === 'none') return undefined;
  const dims = SIZE_BASES[p];
  return { id: `secret_${p}`, name: p, positivePrefix: '', positiveSuffix: '', negative: '', source: 'manual', width: dims.w, height: dims.h };
}

/** Secret grid options — the shared list minus 'custom' (the secret section has
 *  no width/height inputs, so a 'custom' button there could never take effect). */
const secretSizeOptions = computed(() => sizePresetOptions.value.filter((o) => o.value !== 'custom'));

/** 画风 grid key → display label passed to the engine ('none' → no style line). */
function artStyleLabelFor(key: 'none' | 'generic' | 'anime' | 'realistic' | 'chinese'): string | undefined {
  if (key === 'none') return undefined;
  return t(`image.manual.artStyle.${key}`);
}

async function generateSecretPart(partKey: 'breast' | 'vagina' | 'anus') {
  if (!imageService || !selectedNpc.value) return;
  const part = secretParts.value.find((p) => p.key === partKey);
  if (!part) return;
  secretBusy.value = partKey;
  secretStatusText.value = t('image.secret.submitted');
  try {
    const styleInjection = buildPromptStyleInjection(artistPresets.value, [
      secretArtistPreset.value,
      secretPngPreset.value,
    ]);
    const secretPngObj = secretPngPreset.value ? artistPresets.value.find((p) => p.id === secretPngPreset.value) : undefined;
    const secretStyleApplicability = secretPngObj ? resolveStyleParams(secretPngObj, backend.value, configuredModelFor(backend.value)) : null;
    const task = await imageService.generateSecretPartImage({
      characterName: selectedNpc.value,
      part: partKey,
      backend: backend.value,
      preset: secretSizeStylePreset(),
      artStyle: artStyleLabelFor(secretStyle.value),
      artistPrefix: styleInjection.artistPrefix,
      extraNegative: styleInjection.extraNegative,
      extraPrompt: secretExtraPrompt.value || undefined,
      styleParamOverrides: secretStyleApplicability?.applied,
    });
    // Mirror the regular generate flow — push result into lastTask so the NPC
    // preview panel picks up the latest image instead of staying blank.
    lastTask.value = task;
    if (task.status === 'failed') {
      secretStatusText.value = t('image.secret.failGenerate', { part: part.label, error: task.error ?? t('common.fallback.unknownError') });
    } else {
      secretStatusText.value = t('image.secret.allComplete');
    }
  } catch (err) {
    secretStatusText.value = t('image.secret.failGenerate', { part: part.label, error: (err as Error).message });
  } finally {
    secretBusy.value = '';
  }
}

async function generateAllSecretParts() {
  if (!imageService || !selectedNpc.value) return;
  secretBusy.value = 'all';
  secretStatusText.value = t('image.secret.submitted');
  try {
    let lastCompleted: ImageTask | null = null;
    const styleInjection = buildPromptStyleInjection(artistPresets.value, [
      secretArtistPreset.value,
      secretPngPreset.value,
    ]);
    const secretPngObj2 = secretPngPreset.value ? artistPresets.value.find((p) => p.id === secretPngPreset.value) : undefined;
    const secretStyleApplicability2 = secretPngObj2 ? resolveStyleParams(secretPngObj2, backend.value, configuredModelFor(backend.value)) : null;
    for (const part of secretParts.value) {
      const task = await imageService.generateSecretPartImage({
        characterName: selectedNpc.value,
        part: part.key,
        backend: backend.value,
        preset: secretSizeStylePreset(),
        artStyle: artStyleLabelFor(secretStyle.value),
        artistPrefix: styleInjection.artistPrefix,
        extraNegative: styleInjection.extraNegative,
        extraPrompt: secretExtraPrompt.value || undefined,
        styleParamOverrides: secretStyleApplicability2?.applied,
      });
      if (task.status === 'complete') lastCompleted = task;
    }
    if (lastCompleted) lastTask.value = lastCompleted;
    secretStatusText.value = t('image.secret.allComplete');
  } catch {
    secretStatusText.value = t('image.secret.partialFail');
  } finally {
    secretBusy.value = '';
  }
}

async function generateSecretPartWithReference(partKey: 'breast' | 'vagina' | 'anus') {
  if (!imageService || !selectedNpc.value) return;
  const prevAssetId = getSecretPartAssetId(partKey);
  if (!prevAssetId) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.secret.noPreviousRef'), duration: 2000 });
    return;
  }
  const entry = await imageService.getAssetCache().retrieve(prevAssetId);
  if (!entry) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.secret.cacheRefMissing'), duration: 2000 });
    return;
  }
  const part = secretParts.value.find((p) => p.key === partKey);
  if (!part) return;
  secretBusy.value = partKey;
  secretStatusText.value = t('image.secret.submitted');
  try {
    const styleInjection = buildPromptStyleInjection(artistPresets.value, [secretArtistPreset.value, secretPngPreset.value]);
    const secretRef: import('@/engine/image/types').ImageReferenceInput = {
      id: generateReferenceId(), role: 'source', source: 'asset', assetId: prevAssetId,
      denoiseStrength: refConfigDenoiseDefault.value,
    };
    const task = await imageService.generateSecretPartImage({
      characterName: selectedNpc.value,
      part: partKey,
      backend: backend.value,
      preset: secretSizeStylePreset(),
      artStyle: artStyleLabelFor(secretStyle.value),
      artistPrefix: styleInjection.artistPrefix,
      extraNegative: styleInjection.extraNegative,
      extraPrompt: secretExtraPrompt.value || undefined,
      references: [secretRef],
    });
    lastTask.value = task;
    secretStatusText.value = task.status === 'failed'
      ? t('image.secret.refRepaintFail', { part: part.label, error: task.error ?? t('common.fallback.unknownError') })
      : t('image.secret.allComplete');
  } catch (err) {
    secretStatusText.value = t('image.secret.refRepaintFail', { part: part.label, error: (err as Error).message });
  } finally {
    secretBusy.value = '';
  }
}

/**
 * Resolve the stored secret-part result's asset ID for the currently-selected
 * NPC, per body part. Drives the inline preview inside each secret card so the
 * latest generation shows up without leaving the manual tab.
 */
function getSecretPartAssetId(partKey: 'breast' | 'vagina' | 'anus'): string | null {
  void imageUpdateTick.value;
  const archive = selectedNpcData.value?.['图片档案'] as Record<string, unknown> | undefined;
  const secretArchive = archive?.['香闺秘档'] as Record<string, unknown> | undefined;
  if (!secretArchive) return null;
  const cnKey = partKey === 'breast' ? '胸部' : partKey === 'vagina' ? '小穴' : '屁穴';
  const entry = secretArchive[cnKey] as Record<string, unknown> | undefined;
  const id = entry?.id;
  return typeof id === 'string' && id ? id : null;
}

// ── Regenerate-Same modal (shared by queue / gallery / scene history) ──
// Captures a snapshot of the source record so the modal can display prompts
// and dispatch `ImageService.regenerateFromPrompts` with the correct subject.
interface RegenPayload {
  subjectType: 'scene' | 'character' | 'secret_part';
  subjectLabel: string;
  subtitle?: string;
  targetCharacter?: string;
  composition?: 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom';
  part?: 'breast' | 'vagina' | 'anus';
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  initialBackend: ImageBackendType;
  artStyle?: string;
  civitaiLoraSnapshot?: CivitaiLoraSnapshot;
  sourceAssetId?: string;
  preActivateReference?: boolean;
}
const regenPayload = ref<RegenPayload | null>(null);
const regenBusy = ref(false);

function openRegenerateModal(payload: RegenPayload) {
  if (!payload.positivePrompt || !payload.positivePrompt.trim()) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.regenerate.noPrompt'), duration: 2000 });
    return;
  }
  regenPayload.value = payload;
}

function cancelRegenerate() {
  if (regenBusy.value) return;
  regenPayload.value = null;
}

async function confirmRegenerate(opts: { backend: ImageBackendType; positivePrompt: string; negativePrompt: string; references?: import('@/engine/image/types').ImageReferenceInput[] }) {
  if (!imageService || !regenPayload.value || regenBusy.value) return;
  const p = regenPayload.value;
  regenBusy.value = true;
  try {
    const task = await imageService.regenerateFromPrompts({
      subjectType: p.subjectType,
      targetCharacter: p.targetCharacter,
      composition: p.composition,
      part: p.part,
      positivePrompt: opts.positivePrompt,
      negativePrompt: opts.negativePrompt,
      width: p.width,
      height: p.height,
      backend: opts.backend,
      artStyle: p.artStyle,
      references: opts.references,
    });
    if (task.status === 'failed') {
      eventBus.emit('ui:toast', { type: 'error', message: t('image.regenerate.failed', { error: task.error ?? t('common.fallback.unknownError') }), duration: 2500 });
    } else {
      eventBus.emit('ui:toast', { type: 'success', message: t('image.regenerate.submitted'), duration: 2000 });
      regenPayload.value = null;
    }
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.regenerate.failed', { error: (err as Error).message }), duration: 2500 });
  } finally {
    regenBusy.value = false;
  }
}

/** Derive a human-readable secondary line (composition · size · backend) */
function buildRegenSubtitle(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');
}

function compositionLabel(comp?: string): string {
  if (!comp) return '';
  const map: Record<string, string> = {
    portrait: t('image.history.compositionLabel.portrait'),
    'half-body': t('image.history.compositionLabel.halfBody'),
    'full-length': t('image.history.compositionLabel.fullLength'),
    scene: t('image.history.compositionLabel.scene'),
    secret_part: t('image.history.compositionLabel.secretPart'),
    custom: t('image.history.compositionLabel.custom'),
  };
  return map[comp] ?? comp;
}

function partLabel(part?: string): string {
  if (!part) return '';
  const map: Record<string, string> = {
    breast: t('image.secret.partLabel.breast'),
    vagina: t('image.secret.partLabel.vagina'),
    anus: t('image.secret.partLabel.anus'),
  };
  return map[part] ?? part;
}

function openRegenerateFromTask(task: ImageTask, asReference = false) {
  const isSecret = task.subjectType === 'secret_part';
  const subjectLabel = task.subjectType === 'scene'
    ? t('image.history.subjectScene')
    : (task.targetCharacter ?? t('image.lora.scope.character'));
  const subtitle = buildRegenSubtitle([
    task.subjectType === 'character' ? t('image.queue.subjectCharacter') : task.subjectType === 'scene' ? t('image.queue.subjectScene') : t('image.queue.subjectSecret'),
    `${task.width} × ${task.height}`,
    task.backend,
  ]);
  openRegenerateModal({
    subjectType: task.subjectType,
    subjectLabel,
    subtitle,
    targetCharacter: task.targetCharacter,
    composition: task.subjectType === 'character' ? 'portrait' : undefined,
    part: isSecret ? task.part : undefined,
    positivePrompt: task.positivePrompt ?? '',
    negativePrompt: task.negativePrompt ?? '',
    width: task.width,
    height: task.height,
    initialBackend: task.backend,
    civitaiLoraSnapshot: task.providerMeta?.civitai,
    sourceAssetId: task.status === 'complete' ? task.resultAssetId : undefined,
    preActivateReference: asReference,
  });
}

function openRegenerateFromGalleryImage(npcName: string, img: GalleryImage, asReference = false) {
  const comp = String(img.composition ?? '');
  const isSecret = comp === 'secret_part';
  const part = img.part;
  const width = Number(img.width) || 832;
  const height = Number(img.height) || 1216;
  const bk = img.backend ?? backend.value;
  openRegenerateModal({
    subjectType: isSecret ? 'secret_part' : 'character',
    subjectLabel: npcName === '__player__' ? t('image.queue.subjectPlayer') : npcName,
    subtitle: buildRegenSubtitle([
      isSecret ? t('image.preset.secretSubtitle', { part: partLabel(part) }) : compositionLabel(comp),
      `${width} × ${height}`,
      bk,
    ]),
    targetCharacter: npcName,
    composition: isSecret
      ? undefined
      : ((comp || 'portrait') as 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom'),
    part: isSecret ? part : undefined,
    positivePrompt: String(img.positivePrompt ?? ''),
    negativePrompt: String(img.negativePrompt ?? ''),
    width,
    height,
    initialBackend: bk,
    artStyle: img.artStyle || undefined,
    civitaiLoraSnapshot: img.providerMeta?.civitai,
    sourceAssetId: img.id,
    preActivateReference: asReference,
  });
}

function openRegenerateFromHistoryEntry(entry: { type: 'scene' | 'character'; name: string; composition?: string; positivePrompt?: string; negativePrompt?: string; width?: number; height?: number; backend?: ImageBackendType; part?: 'breast' | 'vagina' | 'anus'; artStyle?: string; assetId?: string; providerMeta?: CombinedHistoryEntry['providerMeta'] }, asReference = false) {
  const isScene = entry.type === 'scene';
  const isSecret = entry.composition === 'secret_part';
  const width = entry.width ?? (isScene ? 1024 : 832);
  const height = entry.height ?? (isScene ? 576 : 1216);
  const bk = entry.backend ?? backend.value;
  openRegenerateModal({
    subjectType: isScene ? 'scene' : (isSecret ? 'secret_part' : 'character'),
    subjectLabel: isScene ? t('image.history.subjectScene') : entry.name,
    subtitle: buildRegenSubtitle([
      isScene ? t('image.history.sceneBg') : (isSecret ? `${t('image.history.compositionLabel.secretPart')} · ${partLabel(entry.part)}` : compositionLabel(entry.composition)),
      `${width} × ${height}`,
      bk,
    ]),
    targetCharacter: isScene ? undefined : entry.name,
    composition: isScene || isSecret
      ? undefined
      : ((entry.composition || 'portrait') as 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom'),
    part: isSecret ? entry.part : undefined,
    positivePrompt: entry.positivePrompt ?? '',
    negativePrompt: entry.negativePrompt ?? '',
    width,
    height,
    initialBackend: bk,
    artStyle: entry.artStyle,
    civitaiLoraSnapshot: entry.providerMeta?.civitai,
    sourceAssetId: entry.assetId,
    preActivateReference: asReference,
  });
}

function extractLoraSnapshot(obj: Record<string, unknown>): CivitaiLoraSnapshot | undefined {
  const meta = obj.providerMeta;
  if (!meta || typeof meta !== 'object') return undefined;
  const snap = (meta as Record<string, unknown>).civitai;
  if (!snap || typeof snap !== 'object' || !Array.isArray((snap as CivitaiLoraSnapshot).loras)) return undefined;
  return snap as CivitaiLoraSnapshot;
}

function extractProviderMeta(obj: Record<string, unknown>): CombinedHistoryEntry['providerMeta'] {
  const meta = obj.providerMeta;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const result: NonNullable<CombinedHistoryEntry['providerMeta']> = {};
  const snap = extractLoraSnapshot(obj);
  if (snap) result.civitai = snap;
  if (m.reference && typeof m.reference === 'object') {
    result.reference = m.reference as NonNullable<CombinedHistoryEntry['providerMeta']>['reference'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function analyzeImageFromCard(assetId: string) {
  if (!imageService) return;
  try {
    const entry = await imageService.getAssetCache().retrieve(assetId);
    if (!entry) { eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.cacheMissingAnalyze'), duration: 2000 }); return; }
    activeTab.value = 'presets';
    understandingFile.value = new File([entry.blob], `asset_${assetId}`, { type: entry.metadata.mimeType });
    understandingCoverDataUrl.value = null;
    understandingMode.value = true;
    understandingResult.value = null;
    understandingError.value = '';
    understandingEditDraft.value = '';
    try {
      const img = new Image();
      const objUrl = URL.createObjectURL(entry.blob);
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(); img.src = objUrl; });
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 56;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.drawImage(img, 0, 0, 80, 56); understandingCoverDataUrl.value = canvas.toDataURL('image/jpeg', 0.6); }
      URL.revokeObjectURL(objUrl);
    } catch { /* cover optional */ }
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.analyzeStyleFailed', { error: (err as Error).message }), duration: 2500 });
  }
}

async function saveAsReferenceMaterial(assetId: string, source: 'gallery' | 'scene' | 'player', name?: string) {
  if (!imageService) return;
  try {
    const entry = await imageService.getAssetCache().retrieve(assetId);
    if (!entry) { eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.cacheMissingSaveRef'), duration: 2000 }); return; }
    const refAssetId = `ref_copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const refAsset: ImageAsset = {
      id: refAssetId, taskId: '', storageKey: refAssetId,
      mimeType: entry.metadata.mimeType, width: entry.metadata.width, height: entry.metadata.height,
      sizeBytes: entry.metadata.sizeBytes, backend: entry.metadata.backend, createdAt: Date.now(), origin: 'reference',
    };
    await imageService.getAssetCache().store(refAsset, entry.blob);
    imageService.state.addReferenceEntry({
      id: generateReferenceId(),
      assetId: refAssetId,
      name: name ?? `ref_${assetId.slice(0, 12)}`,
      mimeType: entry.metadata.mimeType,
      width: entry.metadata.width,
      height: entry.metadata.height,
      sizeBytes: entry.metadata.sizeBytes,
      source,
      createdAt: Date.now(),
    });
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.savedAsReference'), duration: 2000 });
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.saveReferenceFailed', { error: (err as Error).message }), duration: 2500 });
  }
}

function openRegenerateFromSceneRecord(record: Record<string, unknown>, asReference = false) {
  const width = Number(record.width) || 1024;
  const height = Number(record.height) || 576;
  const rawBackend = String(record.backend ?? '');
  const bk = (rawBackend as ImageBackendType) || backend.value;
  openRegenerateModal({
    subjectType: 'scene',
    subjectLabel: t('image.history.subjectScene'),
    subtitle: buildRegenSubtitle([
      t('image.history.sceneBg'),
      `${width} × ${height}`,
      bk,
    ]),
    positivePrompt: String(record.positivePrompt ?? record['最终正向提示词'] ?? ''),
    negativePrompt: String(record.negativePrompt ?? record['最终负向提示词'] ?? ''),
    width,
    height,
    initialBackend: bk,
    civitaiLoraSnapshot: extractLoraSnapshot(record),
    sourceAssetId: typeof record.id === 'string' ? record.id : undefined,
    preActivateReference: asReference,
  });
}

const recentTasks = computed(() => {
  void imageUpdateTick.value; // reactive dependency — re-evaluate when image events fire
  return imageService?.getTaskQueue().getAll().slice(0, 20) ?? [];
});

// Stats
const totalImages = computed(() => {
  if (!Array.isArray(relationships.value)) return 0;
  return relationships.value.reduce((sum, npc) => {
    const archive = npc['图片档案'] as Record<string, unknown> | undefined;
    const history = archive?.['生图历史'];
    return sum + (Array.isArray(history) ? history.length : 0);
  }, 0);
});
const successCount = computed(() => recentTasks.value.filter((t) => t.status === 'complete').length);
const failedCount = computed(() => recentTasks.value.filter((t) => t.status === 'failed').length);
const pendingCount = computed(() => recentTasks.value.filter((t) => t.status === 'pending' || t.status === 'generating' || t.status === 'tokenizing').length);

const route = useRoute();

async function openViewer(assetId?: string | null) {
  if (!assetId) return;
  try {
    const { ImageAssetCache } = await import('@/engine/image/asset-cache');
    const cache = new ImageAssetCache();
    const result = await cache.retrieve(assetId);
    if (result) {
      viewerSrc.value = URL.createObjectURL(result.blob);
      viewerOpen.value = true;
    }
  } catch { /* silent */ }
}

// Wallpaper state
const currentWallpaperId = computed(() => {
  const v = get('世界.状态.壁纸.资源');
  return typeof v === 'string' && v ? v : null;
});


// Scene generation state
const selectedScenePreset = ref('');
const selectedScenePngPreset = ref('');
const sceneScopedPresets = computed(() =>
  artistPresets.value.filter((p) => p.scope === 'scene' && !(p.id.startsWith('png_') || p.id.startsWith('img_')))
);
const scenePngPresets = computed(() =>
  artistPresets.value.filter((p) => p.scope === 'scene' && (p.id.startsWith('png_') || p.id.startsWith('img_')))
);

const sceneResolution = ref('1024x576');
const sceneResolutionOptions = computed(() =>
  sizeOptionsToSelectOptions(sceneOrientation.value === 'landscape' ? SCENE_LANDSCAPE_SIZE_OPTIONS : SCENE_PORTRAIT_SIZE_OPTIONS)
);
const sceneComposition = ref<'snapshot' | 'landscape'>('snapshot');
const sceneOrientation = ref<'landscape' | 'portrait'>('landscape');
const sceneExtraPrompt = ref('');
const sceneGenerating = ref(false);
const sceneError = ref('');
const sceneStatusText = ref('');
const sceneReferenceEnabled = ref(false);
const sceneReferenceItems = ref<MultiReferenceItem[]>([]);
const sceneReferenceSource = ref('upload');
const sceneReferenceDenoise = ref(0.55);
const sceneReferenceNoise = ref(0.1);
const sceneReferenceFile = ref<File | null>(null);
const sceneReferenceDataUrl = ref<string | null>(null);
const sceneReferenceAssetId = ref<string | null>(null);
watch(sceneReferenceEnabled, (v) => {
  if (v) sceneReferenceDenoise.value = Math.min(refConfigDenoiseDefault.value, 0.55);
});

async function onSceneReferenceFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!validateUploadSize(file)) { (e.target as HTMLInputElement).value = ''; return; }
  sceneReferenceFile.value = file;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      sceneReferenceDataUrl.value = reader.result as string;
      sceneReferenceAssetId.value = await persistUploadedReference(file, reader.result as string);
    } catch (err) {
      console.warn('[ImagePanel] Scene reference persist failed:', err);
      sceneReferenceAssetId.value = null;
    }
  };
  reader.readAsDataURL(file);
}

// ── Round selection for scene generation ──
const narrativeHistoryRaw = useValue<Array<Record<string, unknown>>>(DEFAULT_ENGINE_PATHS.narrativeHistory);
interface RoundEntry {
  originalIndex: number;
  roundNumber: number;
  content: string;
  preview: string;
}
const recentRounds = computed<RoundEntry[]>(() => {
  const history = narrativeHistoryRaw.value;
  if (!Array.isArray(history)) return [];
  const assistantEntries: RoundEntry[] = [];
  let roundCounter = 0;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.role !== 'assistant' || typeof entry.content !== 'string') continue;
    roundCounter++;
    const metrics = entry._metrics as { roundNumber?: number } | undefined;
    const content = String(entry.content);
    assistantEntries.push({
      originalIndex: i,
      roundNumber: metrics?.roundNumber ?? roundCounter,
      content,
      preview: content.replace(/\n/g, ' ').slice(0, 80),
    });
  }
  return assistantEntries.slice(-15).reverse();
});
const selectedRoundKeys = ref<Set<number>>(new Set());
let roundAutoInitDone = false;
watch(recentRounds, (rounds) => {
  if (!roundAutoInitDone && rounds.length > 0) {
    selectedRoundKeys.value = new Set([rounds[0].originalIndex]);
    roundAutoInitDone = true;
  }
}, { immediate: true });
function toggleRound(originalIndex: number) {
  const next = new Set(selectedRoundKeys.value);
  if (next.has(originalIndex)) next.delete(originalIndex);
  else next.add(originalIndex);
  selectedRoundKeys.value = next;
}

// ── NPC selection for scene generation ──
interface SceneNpcEntry {
  name: string;
  isPresent: boolean;
  isPlayer: boolean;
  appearance: string;
  bodyDescription: string;
  outfitStyle: string;
  description: string;
}
const scenePlayerName = useValue<string>(DEFAULT_ENGINE_PATHS.playerName);
const sceneNpcList = computed<SceneNpcEntry[]>(() => {
  const nameKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.name ?? '名称';
  const presenceKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.isPresent ?? '是否在场';
  const appearanceKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.appearance ?? '外貌描述';
  const bodyKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.bodyDescription ?? '身材描写';
  const outfitKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.outfitStyle ?? '衣着风格';
  const descKey = DEFAULT_ENGINE_PATHS.npcFieldNames?.description ?? '描述';

  const entries: SceneNpcEntry[] = [];

  // Player character (always first, always "present")
  const pName = scenePlayerName.value || t('image.scene.playerFallback');
  entries.push({
    name: pName,
    isPresent: true,
    isPlayer: true,
    appearance: String(get('角色.外貌描写') ?? get('角色.描述') ?? ''),
    bodyDescription: String(get('角色.身材描写') ?? ''),
    outfitStyle: '',
    description: String(get(DEFAULT_ENGINE_PATHS.characterDescription) ?? ''),
  });

  // NPCs from relationships
  const list = relationships.value;
  if (Array.isArray(list)) {
    for (const npc of list) {
      const name = String(npc[nameKey] ?? '');
      if (!name) continue;
      entries.push({
        name,
        isPresent: npc[presenceKey] === true,
        isPlayer: false,
        appearance: String(npc[appearanceKey] ?? ''),
        bodyDescription: String(npc[bodyKey] ?? ''),
        outfitStyle: String(npc[outfitKey] ?? ''),
        description: String(npc[descKey] ?? ''),
      });
    }
  }

  // Sort: player first (already), then present NPCs, then others
  return entries.sort((a, b) => {
    if (a.isPlayer) return -1;
    if (b.isPlayer) return 1;
    if (a.isPresent !== b.isPresent) return a.isPresent ? -1 : 1;
    return 0;
  });
});
const selectedNpcNames = ref<Set<string>>(new Set());
let npcAutoInitDone = false;
watch(sceneNpcList, (npcs) => {
  if (!npcAutoInitDone && npcs.length > 0) {
    selectedNpcNames.value = new Set(
      npcs.filter((n) => n.isPresent || n.isPlayer).map((n) => n.name),
    );
    npcAutoInitDone = true;
  }
}, { immediate: true });
function toggleNpc(name: string) {
  const next = new Set(selectedNpcNames.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedNpcNames.value = next;
}
function selectAllNpcs() {
  selectedNpcNames.value = new Set(sceneNpcList.value.map((n) => n.name));
}
function deselectAllNpcs() {
  selectedNpcNames.value = new Set();
}

// Scene archive from state tree (sceneImageArchiveWorkflow)
const sceneArchiveRaw = useValue<Record<string, unknown>>('系统.扩展.image.sceneArchive');
const sceneArchive = computed(() => {
  const raw = sceneArchiveRaw.value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { '生图历史': [] };
});

const sceneArchiveHistory = computed<Array<Record<string, unknown>>>(() => {
  const history = sceneArchive.value['生图历史'];
  return Array.isArray(history) ? history as Array<Record<string, unknown>> : [];
});

const currentSceneWallpaperId = computed(() => {
  const id = sceneArchive.value['当前壁纸图片ID'];
  return typeof id === 'string' && id ? id : null;
});

// Scene queue (from task queue, scene-type only)
const sceneQueueTasks = computed(() => {
  void imageUpdateTick.value;
  return imageService?.getTaskQueue().getAll().filter((t) => t.subjectType === 'scene') ?? [];
});

// Scene stats (6 stat cards)
const sceneStats = computed(() => {
  const history = sceneArchiveHistory.value;
  const queue = sceneQueueTasks.value;
  return {
    total: history.length,
    success: history.filter((r) => r.status === 'complete' || r.status === 'success').length,
    failed: history.filter((r) => r.status === 'failed').length,
    pending: history.filter((r) => r.status === 'pending' || r.status === 'generating' || r.status === 'tokenizing').length,
    queueTotal: queue.length,
    queueRunning: queue.filter((t) => t.status === 'generating' || t.status === 'tokenizing').length,
  };
});

// Scene history limit
const sceneArchiveLimit = computed(() => {
  const v = get('系统.扩展.image.config.sceneHistoryLimit');
  return typeof v === 'number' && v > 0 ? v : 10;
});
const sceneArchiveLimitDraft = ref(String(sceneArchiveLimit.value));
watch(sceneArchiveLimit, (v) => { sceneArchiveLimitDraft.value = String(v); });

function saveSceneArchiveLimit() {
  const n = parseInt(sceneArchiveLimitDraft.value, 10);
  if (!isNaN(n) && n >= 1 && n <= 100) {
    setValue('系统.扩展.image.config.sceneHistoryLimit', n);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.sceneHistoryLimitSet', { n }), duration: 1500 });
  }
}

// Scene wallpaper management
function applySceneWallpaper(imageId: string) {
  if (!imageService) return;
  imageService.state.setSceneWallpaper(imageId);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.setSceneWallpaper'), duration: 1500 });
}

function clearSceneWallpaper() {
  if (!imageService) return;
  imageService.state.clearSceneWallpaper();
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedSceneWallpaper'), duration: 1500 });
}

function isCurrentSceneWallpaper(imageId: string): boolean {
  return currentSceneWallpaperId.value === imageId;
}

// Clear scene operations
function clearSceneHistory() {
  const queue = imageService?.getTaskQueue();
  if (queue) {
    for (const t of queue.getAll().filter((t) => t.subjectType === 'scene')) {
      queue.remove(t.id);
    }
  }
  // Also clear scene archive history
  if (imageService) {
    setValue('系统.扩展.image.sceneArchive', { '生图历史': [], '当前壁纸图片ID': '' });
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedSceneHistory'), duration: 1500 });
}

function clearSceneQueueCompleted() {
  const queue = imageService?.getTaskQueue();
  if (!queue) return;
  for (const t of queue.getAll().filter((t) => t.subjectType === 'scene' && (t.status === 'complete' || t.status === 'failed'))) {
    queue.remove(t.id);
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedSceneQueueCompleted'), duration: 1500 });
}

function clearSceneQueueAll() {
  const queue = imageService?.getTaskQueue();
  if (!queue) return;
  for (const t of queue.getAll().filter((t) => t.subjectType === 'scene')) {
    queue.remove(t.id);
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedSceneQueueAll'), duration: 1500 });
}

function deleteSceneImage(imageId: string) {
  if (!imageService) return;
  const archive = sceneArchive.value;
  const history = Array.isArray(archive['生图历史'])
    ? (archive['生图历史'] as Array<Record<string, unknown>>).filter((r) => r.id !== imageId)
    : [];
  const cleared = String(archive['当前壁纸图片ID'] ?? '') === imageId ? '' : archive['当前壁纸图片ID'];
  setValue('系统.扩展.image.sceneArchive', { ...archive, '生图历史': history, '当前壁纸图片ID': cleared });
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.deletedSceneImage'), duration: 1500 });
}

async function generateScene() {
  if (!imageService || sceneGenerating.value) return;
  sceneGenerating.value = true;
  sceneError.value = '';
  sceneStatusText.value = backgroundMode.value ? t('image.scene.statusBackground') : t('image.scene.statusGenerating');
  try {
    // Parse resolution string to width/height
    const resParts = sceneResolution.value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    const sceneW = resParts ? Number(resParts[1]) : (sceneOrientation.value === 'landscape' ? 1024 : 576);
    const sceneH = resParts ? Number(resParts[2]) : (sceneOrientation.value === 'landscape' ? 576 : 1024);

    // P3 env-tags port (2026-04-19): pipe the four env-related state reads
    // into scene generation so image output reflects current weather,
    // festival decoration, and atmospheric tags.
    const gameTime = get(DEFAULT_ENGINE_PATHS.gameTime) as GameTime | null | undefined;
    const styleInjection = buildPromptStyleInjection(artistPresets.value, [
      selectedScenePreset.value,
      selectedScenePngPreset.value,
    ]);
    let sceneRefs: import('@/engine/image/types').ImageReferenceInput[] | undefined;
    if (sceneReferenceEnabled.value && backendSupportsImg2Img.value) {
      if (backendSupportsMultiRef.value) {
        if (sceneReferenceItems.value.length > 0) {
          sceneRefs = multiRefToInputs(sceneReferenceItems.value, sceneReferenceDenoise.value);
        }
      } else if (sceneReferenceSource.value === 'upload' && (sceneReferenceAssetId.value || sceneReferenceDataUrl.value)) {
        sceneRefs = [sceneReferenceAssetId.value
          ? { id: generateReferenceId(), role: 'source', source: 'asset', assetId: sceneReferenceAssetId.value, denoiseStrength: sceneReferenceDenoise.value }
          : { id: generateReferenceId(), role: 'source', source: 'data_url', dataUrl: sceneReferenceDataUrl.value!, denoiseStrength: sceneReferenceDenoise.value }];
      } else if (sceneReferenceSource.value === 'wallpaper') {
        const wallId = String(get('系统.扩展.image.sceneArchive.当前壁纸图片ID') ?? '');
        if (wallId) sceneRefs = [{ id: generateReferenceId(), role: 'source', source: 'asset', assetId: wallId, denoiseStrength: sceneReferenceDenoise.value }];
      }
      if (!sceneRefs?.length) {
        eventBus.emit('ui:toast', { type: 'warning', message: t('image.toast.sceneRefWarning'), duration: 3000 });
      }
      if (sceneRefs?.length && backend.value === 'novelai') {
        sceneRefs[0].providerMeta = { noise: sceneReferenceNoise.value };
      }
    }
    const scenePngPresetObj = selectedScenePngPreset.value ? artistPresets.value.find((p) => p.id === selectedScenePngPreset.value) : undefined;
    const sceneStyleApplicability = scenePngPresetObj ? resolveStyleParams(scenePngPresetObj, backend.value, configuredModelFor(backend.value)) : null;

    // Assemble narrative text from selected rounds
    const selectedNarrative = recentRounds.value
      .filter((r) => selectedRoundKeys.value.has(r.originalIndex))
      .reverse() // chronological order (oldest first)
      .map((r) => r.content)
      .join('\n\n---\n\n');

    // Collect selected NPC details
    const selectedNpcDetails: SceneNpcDetail[] = sceneNpcList.value
      .filter((n) => selectedNpcNames.value.has(n.name))
      .map((n) => ({
        name: n.name,
        ...(n.appearance ? { appearance: n.appearance } : {}),
        ...(n.bodyDescription ? { bodyDescription: n.bodyDescription } : {}),
        ...(n.outfitStyle ? { outfitStyle: n.outfitStyle } : {}),
        ...(n.description ? { description: n.description } : {}),
      }));

    // Filter scene anchors to only selected NPCs
    const sceneAnchors = imageService.collectSceneRoleAnchors();
    const filteredPresentNpcs = sceneAnchors.presentNpcs.filter((n) => selectedNpcNames.value.has(n));
    const filteredRoleAnchors = sceneAnchors.roleAnchors.filter((a) => selectedNpcNames.value.has(a.name));

    const task = await imageService.generateSceneImage({
      sceneDescription: selectedNarrative || sceneExtraPrompt.value || '当前场景',
      location: get('角色.基础信息.当前位置') as string ?? '',
      gameTime,
      weather: get(DEFAULT_ENGINE_PATHS.weather) as string | undefined,
      festival: get(DEFAULT_ENGINE_PATHS.festival),
      environment: get(DEFAULT_ENGINE_PATHS.environmentTags),
      backend: backend.value,
      compositionMode: sceneComposition.value === 'snapshot' ? 'story_snapshot' : 'pure_landscape',
      extraRequirements: sceneExtraPrompt.value || undefined,
      artistPrefix: styleInjection.artistPrefix,
      extraNegative: styleInjection.extraNegative,
      preset: { id: 'scene_custom', name: '场景自定义', positivePrefix: '', positiveSuffix: '', negative: '', source: 'manual', width: sceneW, height: sceneH },
      references: sceneRefs,
      styleParamOverrides: sceneStyleApplicability?.applied,
      presentNpcs: filteredPresentNpcs,
      npcDetails: selectedNpcDetails.length > 0 ? selectedNpcDetails : undefined,
      roleAnchors: filteredRoleAnchors.length > 0 ? filteredRoleAnchors : undefined,
    });
    if (task.status === 'failed') {
      sceneError.value = task.error ?? t('image.toast.sceneGenerateFailed');
      sceneStatusText.value = '';
    } else {
      sceneStatusText.value = backgroundMode.value ? t('image.scene.statusSubmitted') : t('image.scene.statusGenerated');
    }
  } catch (err) {
    sceneError.value = (err as Error).message ?? String(err);
    sceneStatusText.value = '';
  } finally {
    sceneGenerating.value = false;
  }
}

// Settings tab state
const settingsBackend = computed(() => String(get('系统.扩展.image.config.defaultBackend') ?? 'novelai'));
const isNovelAIBackend = computed(() => settingsBackend.value === 'novelai');
const settingsLoraPreviewScope = ref<CivitaiLoraScope>('character');
const settingsTransformerIndependent = computed(() => get('系统.扩展.image.config.transformerIndependentModel') === true);

/** 该后端当前配置的模型名——`resolveStyleParams` 判定 Seedream `seed` 是否适用要用它 */
function configuredModelFor(bk: ImageBackendType): string | undefined {
  return aiService?.getImageConfigForBackend(bk)?.model || undefined;
}

const activeBackendStatus = computed(() => {
  const bk = backend.value;
  const label = ALL_IMAGE_BACKENDS.value.find((o) => o.value === bk)?.label ?? bk;
  const cfg = aiService?.getImageConfigForBackend(bk);
  return {
    label,
    model: cfg?.model ?? '',
    configured: !!cfg,
    apiName: cfg?.name ?? '',
  };
});

const civitaiNetworksJsonError = ref('');
const civitaiControlNetsJsonError = ref('');
function validateCivitaiJson(field: 'additionalNetworksJson' | 'controlNetsJson', errorRef: 'civitaiNetworksJsonError' | 'civitaiControlNetsJsonError') {
  const raw = String(get(`系统.扩展.image.config.civitai.${field}`) ?? '').trim();
  if (!raw) { (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = ''; return; }
  try { JSON.parse(raw); (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = ''; }
  catch (e) { (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = t('image.civitai.jsonFormatError', { error: (e as Error).message }); }
}

const civitaiWhatifLoading = ref(false);
const civitaiWhatifResult = ref('');
async function runCivitaiWhatif() {
  civitaiWhatifLoading.value = true;
  civitaiWhatifResult.value = '';
  try {
    const apiConfig = aiService?.getImageConfigForBackend('civitai');
    if (!apiConfig) { civitaiWhatifResult.value = t('image.civitai.notConfigured'); return; }
    const base = apiConfig.url.replace(/\/+$/, '');
    const body: Record<string, unknown> = { prompt: 'cost estimate', width: 1024, height: 1024, quantity: 1, batchSize: 1 };
    if (apiConfig.model) body.model = apiConfig.model;
    const steps = get('系统.扩展.image.config.civitai.steps');
    if (steps != null) body.steps = steps;

    // Include LoRA shelf in whatif request
    const loraShelfRaw = get('系统.扩展.image.config.civitai.loras');
    const loraShelf: CivitaiLoraShelfItem[] = Array.isArray(loraShelfRaw) ? loraShelfRaw as CivitaiLoraShelfItem[] : [];
    const rawNetJson = String(get('系统.扩展.image.config.civitai.additionalNetworksJson') ?? '');
    const scope = settingsLoraPreviewScope.value;
    const prepared = prepareCivitaiLora({ shelf: loraShelf, scope, positivePrompt: body.prompt as string, rawAdditionalNetworksJson: rawNetJson });
    body.prompt = prepared.modifiedPositive;
    if (prepared.mergedAdditionalNetworksJson) {
      try { body.additionalNetworks = JSON.parse(prepared.mergedAdditionalNetworksJson); } catch { /* ignore parse error */ }
    }

    const res = await fetch(`${base}/v2/consumer/recipes/textToImage?whatif=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { civitaiWhatifResult.value = t('image.civitai.queryFailedHttp', { status: res.status }); return; }
    const data = await res.json();
    const cost = data?.cost ?? data?.totalCost ?? data?.jobs?.[0]?.cost;
    civitaiWhatifResult.value = cost != null ? t('image.civitai.estimatedCost', { cost }) : t('image.civitai.queryComplete', { data: JSON.stringify(data).slice(0, 120) });
  } catch (e) {
    civitaiWhatifResult.value = t('image.civitai.queryFailed', { error: (e as Error).message });
  } finally {
    civitaiWhatifLoading.value = false;
  }
}

// History state
const historyFilter = ref('all');
const historyFilterOptions = computed<SelectOption[]>(() => [
  { label: t('common.actions.all'), value: 'all' },
  { label: t('image.lora.scope.character'), value: 'character' },
  { label: t('image.lora.scope.scene'), value: 'scene' },
  { label: t('image.queue.status.complete'), value: 'complete' },
  { label: t('image.queue.status.failed'), value: 'failed' },
]);
// Preset management state
const presetScope = ref<'npc' | 'scene'>('npc');
const selectedPresetId = ref('');
const newPresetName = ref('');
const newPresetPositive = ref('');
const newPresetNegative = ref('');
const newPresetArtist = ref('');

// ArtistPreset type imported from '@/engine/image/types' (promoted from UI-local in Phase 1)

const artistPresets = computed<ArtistPreset[]>(() => {
  const raw = get('系统.扩展.image.artistPresets');
  return Array.isArray(raw) ? raw as ArtistPreset[] : [];
});


// Split presets: PNG presets vs artist-only presets
const pngPresets = computed(() =>
  artistPresets.value.filter((p) => (p.id.startsWith('png_') || p.id.startsWith('img_')))
);
const artistOnlyPresets = computed(() =>
  artistPresets.value.filter((p) => p.scope === presetScope.value && !(p.id.startsWith('png_') || p.id.startsWith('img_')))
);

// Always NPC-scoped presets (for Manual + Secret sections, independent of Presets tab scope)
const npcArtistPresets = computed(() =>
  artistPresets.value.filter((p) => p.scope === 'npc' && !(p.id.startsWith('png_') || p.id.startsWith('img_')))
);

const selectedPreset = computed(() =>
  artistPresets.value.find((p) => p.id === selectedPresetId.value) ?? null
);

const selectedPresetParamPreview = computed(() => {
  const p = selectedPreset.value;
  if (!p) return null;
  const bk = (backend.value as import('@/engine/image/types').ImageBackendType) || 'novelai';
  return resolveStyleParams(p, bk, configuredModelFor(bk));
});

function createPreset() {
  const name = newPresetName.value.trim() || t('image.preset.defaultName', { id: Date.now() });
  const preset: ArtistPreset = {
    id: `preset_${Date.now()}`,
    name,
    scope: presetScope.value,
    artistString: '',
    positive: '',
    negative: '',
  };
  const list = [...artistPresets.value, preset];
  setValue('系统.扩展.image.artistPresets', list);
  selectedPresetId.value = preset.id;
  newPresetName.value = '';
}

function savePreset() {
  if (!selectedPreset.value) return;
  const updatedName = newPresetName.value.trim() || selectedPreset.value.name;
  const list = artistPresets.value.map((p) =>
    p.id === selectedPresetId.value
      ? { ...p, name: updatedName, positive: newPresetPositive.value, negative: newPresetNegative.value, artistString: newPresetArtist.value }
      : p
  );
  setValue('系统.扩展.image.artistPresets', list);
}

function deletePreset() {
  const list = artistPresets.value.filter((p) => p.id !== selectedPresetId.value);
  setValue('系统.扩展.image.artistPresets', list);
  selectedPresetId.value = '';
}

// Artist preset import/export (§2.7-A)
function exportArtistPresets() {
  const data = artistPresets.value.filter((p) => p.scope === presetScope.value);
  if (data.length === 0) {
    eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.noPresetsToExport'), duration: 1500 });
    return;
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `artist-presets-${presetScope.value}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.presetsExported', { n: data.length }), duration: 1500 });
}

function importArtistPresets(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result as string);
      const items: ArtistPreset[] = (Array.isArray(parsed) ? parsed : [parsed])
        .filter((p: unknown): p is ArtistPreset =>
          typeof p === 'object' && p !== null && 'name' in p
        )
        .map((p: ArtistPreset) => ({
          ...p,
          id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          scope: p.scope === 'scene' ? 'scene' : 'npc',
        }));
      if (items.length === 0) {
        eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.noValidPresetData'), duration: 2000 });
        return;
      }
      const list = [...artistPresets.value, ...items];
      setValue('系统.扩展.image.artistPresets', list);
      eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.presetsImported', { n: items.length }), duration: 1500 });
    } catch {
      eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// Load selected preset content into editor
// PNG import
const pngImporting = ref(false);
const pngImportStatus = ref('');

// Image understanding (提炼) state
const understandingMode = ref(false);
const understandingFile = ref<File | null>(null);
const understandingCoverDataUrl = ref<string | null>(null);
const understandingTask = ref<'tags' | 'caption' | 'both'>('both');
// 额外要求（可选）：原样附加到提炼提示词末尾，用来指定关注点/提醒细节/解释易误读的画面。
// 刻意**不随新图片清空**——连续提炼同一批图时同一条要求通常要复用（与 understandingEngine
// 的「会话内记忆」同类）。
const understandingExtra = ref('');
// 提炼引擎（重建 epic D1）：默认取设置值，面板内可切换，会话内记忆
const understandingEngine = ref<import('@/engine/image/types').ImageUnderstandingEngine>(
  imageService?.getUnderstandingConfig().defaultEngine ?? 'civitai_vlm',
);

// 能力门控（参照 c1c3463 重绘幅度先例：不可用 = 禁用 + 说明，不留死控件）
const understandingCivitaiAvailable = computed(() => {
  apiStore.apiConfigs; apiStore.apiAssignments; // reactivity deps
  return Boolean(aiService?.getImageConfigForBackend('civitai'));
});
// D3B「必须标明」：通用 LLM 引擎复用主对话配置，选项与设置区都显示当前模型名
const understandingLlmInfo = computed(() => {
  apiStore.apiConfigs; apiStore.apiAssignments; // reactivity deps
  return imageService?.getGeneralLlmInfo();
});
// Civitai 视觉模型速查清单（设置区「支持哪些模型？」）。
// 模型 id 是 API 标识符，不翻译；备注走 i18n。三项均为 2026-08-27 真实探测过的
// 名字，计量差异见 docs/status/image-understanding-api-verification-2026-08-27.md。
const UNDERSTANDING_MODEL_PRESETS: ReadonlyArray<{ id: string; noteKey: string }> = [
  { id: 'claude-sonnet-5', noteKey: 'image.settings.understandingModelNoteSonnet' },
  { id: 'gpt-4o-mini', noteKey: 'image.settings.understandingModelNoteGpt' },
  { id: 'gemini-2.5-flash', noteKey: 'image.settings.understandingModelNoteGemini' },
];

const understandingCivitaiModel = computed(() =>
  String(get('系统.扩展.image.config.understanding.civitaiModel') ?? 'claude-sonnet-5'));

function applyUnderstandingModel(id: string): void {
  setValue('系统.扩展.image.config.understanding.civitaiModel', id);
}

const understandingEngineOptions = computed<Array<{
  label: string;
  value: import('@/engine/image/types').ImageUnderstandingEngine;
  disabled: boolean;
}>>(() => [
  {
    label: t('image.presets.engineCivitai'),
    value: 'civitai_vlm',
    disabled: !understandingCivitaiAvailable.value,
  },
  {
    label: understandingLlmInfo.value?.available
      ? t('image.presets.engineGeneralLlm', { model: understandingLlmInfo.value.model })
      : t('image.presets.engineGeneralLlmBare'),
    value: 'general_llm',
    disabled: !understandingLlmInfo.value?.available,
  },
]);
const understandingNoEngine = computed(() =>
  understandingEngineOptions.value.every((o) => o.disabled));
// 选中引擎失效时自动落到另一个可用引擎。apiStore 若在挂载后一拍才水合，
// 本 watch 会随选项重算再次触发并自我纠正（瞬时切换不产生请求，无用户可见影响）
watch(understandingEngineOptions, (opts) => {
  const current = opts.find((o) => o.value === understandingEngine.value);
  if (current?.disabled) {
    const fallback = opts.find((o) => !o.disabled);
    if (fallback) understandingEngine.value = fallback.value;
  }
}, { immediate: true });
const understandingLoading = ref(false);
const understandingResult = ref<import('@/engine/image/types').ImageUnderstandingResult | null>(null);
const understandingEditDraft = ref('');
const understandingError = ref('');

async function openUnderstandingForFile(file: File) {
  understandingFile.value = file;
  understandingMode.value = true;
  understandingResult.value = null;
  understandingError.value = '';
  understandingEditDraft.value = '';
  try {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(); img.src = objUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 56;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.drawImage(img, 0, 0, 80, 56); understandingCoverDataUrl.value = canvas.toDataURL('image/jpeg', 0.6); }
    URL.revokeObjectURL(objUrl);
  } catch { understandingCoverDataUrl.value = null; }
}

async function runUnderstanding() {
  if (!imageService || !understandingFile.value) return;
  understandingLoading.value = true;
  understandingError.value = '';
  try {
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('read'));
      reader.readAsDataURL(understandingFile.value!);
    });
    const result = await imageService.analyzeImage({
      engine: understandingEngine.value,
      image: { id: generateReferenceId(), role: 'source', source: 'data_url', dataUrl },
      task: understandingTask.value,
      prompt: understandingExtra.value.trim() || undefined,
    });
    understandingResult.value = result;
    understandingEditDraft.value = result.positiveDraft;
    // 结构化解析降级：要标签却没标签 = 模型没按 JSON 出（原文已落 caption）
    if (understandingTask.value !== 'caption' && !result.tags?.length && result.caption) {
      eventBus.emit('ui:toast', { type: 'warning', message: t('image.toast.tagsNotParsed'), duration: 4000 });
    }
  } catch (err) {
    understandingError.value = classifyUnderstandingError((err as Error).message);
  } finally {
    understandingLoading.value = false;
  }
}

// 四类错误的 i18n 呈现（design §5.1）：引擎层错误是中文硬编码（引擎禁 import
// vue-i18n），UI 层按稳定标记分类映射到 zh/en 文案；未识别的原样透出
function classifyUnderstandingError(message: string): string {
  if (message.includes('拒绝分析')) return t('image.understanding.error.refused');
  if (message.includes('空响应（204')) return t('image.understanding.error.emptyResponse');
  if (message.includes('未将图片送达模型')) return t('image.understanding.error.imageDropped');
  return message;
}

function saveUnderstandingAsPreset(scope: 'npc' | 'scene') {
  if (!understandingResult.value) return;
  const preset: ArtistPreset = {
    id: `img_${Date.now()}`,
    name: understandingFile.value?.name?.replace(/\.\w+$/, '') ?? t('image.preset.defaultUnderstandingName'),
    scope,
    artistString: '',
    positive: understandingEditDraft.value || understandingResult.value.positiveDraft,
    negative: understandingResult.value.negativeDraft ?? '',
    pngMeta: {
      // vlm_ / llm_ 前缀（重建 epic §4）；历史 civitai_ 前缀数据保留可读
      source: `${understandingResult.value.provider === 'general_llm' ? 'llm' : 'vlm'}_${understandingResult.value.task}`,
      originalPrompt: understandingResult.value.positiveDraft,
      rawText: JSON.stringify(understandingResult.value.raw ?? {}),
      coverDataUrl: understandingCoverDataUrl.value ?? undefined,
      replicateParams: false,
    },
  };
  const list = [...artistPresets.value, preset];
  setValue('系统.扩展.image.artistPresets', list);
  selectedPresetId.value = preset.id;
  understandingMode.value = false;
  loadPresetIntoEditor();
  eventBus.emit('ui:toast', { type: 'success', message: scope === 'npc' ? t('image.toast.savedAsStylePresetNpc') : t('image.toast.savedAsStylePresetScene'), duration: 2000 });
}

function importImageForUnderstanding(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  if (!validateUploadSize(file)) return;
  void openUnderstandingForFile(file);
}

// ── Reference Library (P1-8) ──
const referenceLibrary = computed(() => imageService?.state.getReferenceLibrary() ?? []);
const refLibThumbnails = ref<Record<string, string>>({});

async function loadRefLibThumbnail(assetId: string): Promise<string | null> {
  if (assetId in refLibThumbnails.value) return refLibThumbnails.value[assetId] || null;
  if (!imageService) return null;
  try {
    const entry = await imageService.getAssetCache().retrieve(assetId);
    if (!entry) {
      refLibThumbnails.value = { ...refLibThumbnails.value, [assetId]: '' };
      return null;
    }
    const img = new Image();
    const objUrl = URL.createObjectURL(entry.blob);
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(); img.src = objUrl; });
    const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 42;
    const ctx = canvas.getContext('2d');
    let thumb = '';
    if (ctx) { ctx.drawImage(img, 0, 0, 60, 42); thumb = canvas.toDataURL('image/jpeg', 0.5); }
    URL.revokeObjectURL(objUrl);
    refLibThumbnails.value = { ...refLibThumbnails.value, [assetId]: thumb || '' };
    return thumb || null;
  } catch {
    refLibThumbnails.value = { ...refLibThumbnails.value, [assetId]: '' };
    return null;
  }
}

async function deleteReferenceEntry(id: string) {
  if (!imageService) return;
  const lib = imageService.state.getReferenceLibrary();
  const entry = lib.find((e) => e.id === id);
  imageService.state.removeReferenceEntry(id);
  // 仍被生图任务引用的图片**本体不能删**：任务归档里的 sourceAssetIds 不会跟着
  // 消失，删了会让备份「引用数 > 导出数」，进而被云同步退化守卫永久硬阻断
  //（CRITICAL 修复 2026-08-29）。条目本身照删——那只是用户的素材清单。
  const stillUsed = entry?.assetId ? imageService.state.isAssetReferencedByTasks(entry.assetId) : false;
  if (entry?.assetId && !stillUsed) {
    try { await imageService.getAssetCache().delete(entry.assetId); } catch { /* best effort */ }
    const { [entry.assetId]: _, ...rest } = refLibThumbnails.value;
    refLibThumbnails.value = rest;
  }
  eventBus.emit('ui:toast', {
    type: 'info',
    message: stillUsed ? t('image.toast.deletedReferenceKept') : t('image.toast.deletedReference'),
    duration: stillUsed ? 3500 : 1500,
  });
}

async function importPng(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  pngImporting.value = true;
  pngImportStatus.value = t('image.png.parsing', { name: file.name });

  try {
    const { extractPngMetadata } = await import('@/engine/image/png-metadata');
    const metadata = await extractPngMetadata(file);

    if (!metadata.positive && !metadata.rawText) {
      pngImportStatus.value = t('image.png.noMetadata');
      pngImporting.value = false;
      void openUnderstandingForFile(file);
      return;
    }

    // Generate small cover thumbnail (80x56)
    let coverDataUrl: string | undefined;
    try {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('load'));
        img.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 56;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, 80, 56);
        coverDataUrl = canvas.toDataURL('image/jpeg', 0.6);
      }
      URL.revokeObjectURL(objectUrl);
    } catch { /* cover is optional */ }

    const parsedParams: Record<string, unknown> = {};
    if (metadata.params?.sampler) parsedParams.sampler = metadata.params.sampler;
    if (metadata.params?.steps) parsedParams.steps = metadata.params.steps;
    if (metadata.params?.cfgScale) parsedParams.cfgScale = metadata.params.cfgScale;
    if (metadata.params?.seed) parsedParams.seed = metadata.params.seed;
    if (metadata.params?.model) parsedParams.model = metadata.params.model;
    if (metadata.params?.width) parsedParams.width = metadata.params.width;
    if (metadata.params?.height) parsedParams.height = metadata.params.height;

    const preset: ArtistPreset = {
      id: `png_${Date.now()}`,
      name: file.name.replace(/\.png$/i, ''),
      scope: presetScope.value,
      artistString: '',
      positive: metadata.positive ?? '',
      negative: metadata.negative ?? '',
      pngMeta: {
        source: metadata.source,
        originalPrompt: metadata.positive ?? '',
        rawText: metadata.rawText ?? '',
        parsedParams: Object.keys(parsedParams).length > 0 ? parsedParams : undefined,
        replicateParams: false,
        coverDataUrl,
      },
    };

    const list = [...artistPresets.value, preset];
    setValue('系统.扩展.image.artistPresets', list);
    selectedPresetId.value = preset.id;
    loadPresetIntoEditor();
    pngImportStatus.value = t('image.png.imported', { name: preset.name });
  } catch (err) {
    pngImportStatus.value = t('image.png.parseFailed', { error: (err as Error).message });
  } finally {
    pngImporting.value = false;
    input.value = '';
  }
}

function loadPresetIntoEditor() {
  if (selectedPreset.value) {
    newPresetName.value = selectedPreset.value.name;
    newPresetPositive.value = selectedPreset.value.positive;
    newPresetNegative.value = selectedPreset.value.negative;
    newPresetArtist.value = selectedPreset.value.artistString;
  }
}

function toggleReplicateParams(value: boolean) {
  if (!selectedPreset.value?.pngMeta) return;
  const list = artistPresets.value.map((p) =>
    p.id === selectedPresetId.value
      ? { ...p, pngMeta: { ...p.pngMeta!, replicateParams: value } }
      : p
  );
  setValue('系统.扩展.image.artistPresets', list);
}

// Character anchor management
interface CharacterAnchor {
  id: string;
  name: string;
  npcName: string;
  enabled: boolean;
  defaultAppend: boolean;
  sceneLink: boolean;
  positive: string;
  negative: string;
  structuredFeatures?: import('@/engine/image/types').AnchorStructuredFeatures;
  source?: string;
  model?: string;
}

const selectedAnchorId = ref('');
const anchorExtractRequirements = ref('');
const anchorExtracting = ref(false);
const anchorExtractMessage = ref('');
const anchorExtractStage = ref<'idle' | 'extracting' | 'done' | 'error'>('idle');

const characterAnchors = computed<CharacterAnchor[]>(() => {
  const raw = get('系统.扩展.image.characterAnchors');
  return Array.isArray(raw) ? raw as CharacterAnchor[] : [];
});

const selectedAnchor = computed(() =>
  characterAnchors.value.find((a) => a.id === selectedAnchorId.value) ?? null
);

// Editor state for anchor
const editAnchorName = ref('');
const editAnchorNpc = ref('');
const editAnchorPositive = ref('');
const editAnchorNegative = ref('');

function selectAnchor(id: string) {
  selectedAnchorId.value = id;
  const a = characterAnchors.value.find((x) => x.id === id);
  if (a) {
    editAnchorName.value = a.name;
    editAnchorNpc.value = a.npcName;
    editAnchorPositive.value = a.positive;
    editAnchorNegative.value = a.negative;
  }
}

async function extractAnchor() {
  if (!editAnchorNpc.value || !aiService) {
    anchorExtractStage.value = 'error';
    anchorExtractMessage.value = !aiService ? t('image.toast.anchorAiNotReady') : t('image.toast.anchorSelectNpcFirst');
    return;
  }
  anchorExtracting.value = true;
  anchorExtractStage.value = 'extracting';
  anchorExtractMessage.value = t('image.toast.anchorExtracting', { name: editAnchorNpc.value });
  try {
    const npc = (relationships.value as Array<Record<string, unknown>>)?.find(
      (n) => n['名称'] === editAnchorNpc.value
    );
    if (!npc) throw new Error('NPC not found');

    const npcData: Record<string, unknown> = { 姓名: editAnchorNpc.value };
    const pick = (key: string) => { const v = npc[key]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
    if (pick('性别')) npcData['性别'] = pick('性别');
    if (npc['年龄']) npcData['年龄'] = npc['年龄'];
    if (pick('描述')) npcData['描述'] = pick('描述');
    if (pick('外貌描述')) npcData['外貌描述'] = pick('外貌描述');
    if (pick('身材描写')) npcData['身材描写'] = pick('身材描写');
    if (pick('衣着风格')) npcData['衣着风格'] = pick('衣着风格');
    if (Array.isArray(npc['性格特征'])) npcData['性格特征'] = npc['性格特征'];

    const result = await extractAnchorViaAI(
      aiService,
      JSON.stringify(npcData, null, 2),
      {
        displayName: editAnchorNpc.value,
        extraRequirements: anchorExtractRequirements.value.trim() || undefined,
      },
    );

    const anchor: CharacterAnchor = {
      id: `anchor_${Date.now()}`,
      name: t('image.anchor.defaultName', { name: editAnchorNpc.value }),
      npcName: editAnchorNpc.value,
      enabled: true,
      defaultAppend: true,
      sceneLink: false,
      positive: result.positivePrompt,
      negative: result.negativePrompt,
      structuredFeatures: result.structuredFeatures,
      source: t('image.anchor.sourceAI'),
    };
    const list = [...characterAnchors.value.filter((a) => a.npcName !== editAnchorNpc.value), anchor];
    setValue('系统.扩展.image.characterAnchors', list);
    selectAnchor(anchor.id);
    anchorExtractStage.value = 'done';
    anchorExtractMessage.value = t('image.toast.anchorExtracted', { name: anchor.name });
  } catch (err) {
    anchorExtractStage.value = 'error';
    anchorExtractMessage.value = t('image.toast.anchorExtractFailed', { error: (err as Error).message });
  } finally {
    anchorExtracting.value = false;
  }
}

function saveAnchor() {
  if (!selectedAnchor.value) return;
  const list = characterAnchors.value.map((a) =>
    a.id === selectedAnchorId.value
      ? { ...a, name: editAnchorName.value, positive: editAnchorPositive.value, negative: editAnchorNegative.value }
      : a
  );
  setValue('系统.扩展.image.characterAnchors', list);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.anchorSaved'), duration: 1500 });
}

function deleteAnchor() {
  const list = characterAnchors.value.filter((a) => a.id !== selectedAnchorId.value);
  setValue('系统.扩展.image.characterAnchors', list);
  selectedAnchorId.value = '';
}

function toggleAnchorProp(prop: 'enabled' | 'defaultAppend' | 'sceneLink', value: boolean) {
  const list = characterAnchors.value.map((a) =>
    a.id === selectedAnchorId.value ? { ...a, [prop]: value } : a
  );
  setValue('系统.扩展.image.characterAnchors', list);
}

// Transformer preset CRUD state (§2.7-C)
interface TransformerPreset {
  id: string;
  name: string;
  scope: 'npc' | 'scene' | 'secret';
  prompt: string;
}

const transformerScope = ref<'npc' | 'scene' | 'secret'>('npc');
const selectedTransformerId = ref('');
const newTransformerName = ref('');
const editTransformerPrompt = ref('');

const transformerPresets = computed<TransformerPreset[]>(() => {
  const raw = get('系统.扩展.image.transformerPresets');
  return Array.isArray(raw) ? raw as TransformerPreset[] : [];
});

const scopedTransformers = computed(() =>
  transformerPresets.value.filter((p) => p.scope === transformerScope.value)
);

const selectedTransformer = computed(() =>
  transformerPresets.value.find((p) => p.id === selectedTransformerId.value) ?? null
);

function loadTransformerIntoEditor() {
  if (selectedTransformer.value) {
    editTransformerPrompt.value = selectedTransformer.value.prompt;
  }
}

function createTransformerPreset() {
  const name = newTransformerName.value.trim() || t('image.transformer.defaultName', { id: Date.now() });
  const preset: TransformerPreset = {
    id: `tf_${Date.now()}`,
    name,
    scope: transformerScope.value,
    prompt: '',
  };
  const list = [...transformerPresets.value, preset];
  setValue('系统.扩展.image.transformerPresets', list);
  selectedTransformerId.value = preset.id;
  newTransformerName.value = '';
  editTransformerPrompt.value = '';
}

function saveTransformerPreset() {
  if (!selectedTransformer.value) return;
  const list = transformerPresets.value.map((p) =>
    p.id === selectedTransformerId.value
      ? { ...p, prompt: editTransformerPrompt.value }
      : p
  );
  setValue('系统.扩展.image.transformerPresets', list);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.transformerPresetSaved'), duration: 1500 });
}

function deleteTransformerPreset() {
  const list = transformerPresets.value.filter((p) => p.id !== selectedTransformerId.value);
  setValue('系统.扩展.image.transformerPresets', list);
  selectedTransformerId.value = '';
  editTransformerPrompt.value = '';
}

// Model rulesets
interface ModelRuleset {
  id: string;
  name: string;
  enabled: boolean;
  compatMode: boolean;
  baseModelRule: string;
  anchorModeModelRule: string;
  serializationStrategy: string;
  npcTemplateId: string;
  sceneTemplateId: string;
  judgeTemplateId: string;
}

const modelRulesetExpanded = ref(false);
const editingModelRulesetId = ref('');
const editModelRulesetName = ref('');
const editModelRulesetBase = ref('');
const editModelRulesetAnchor = ref('');

const modelRulesets = computed<ModelRuleset[]>(() => {
  const raw = get('系统.扩展.image.modelRulesets');
  return Array.isArray(raw) ? raw as ModelRuleset[] : [];
});

const editingModelRuleset = computed(() =>
  modelRulesets.value.find((r) => r.id === editingModelRulesetId.value) ?? null
);

const activeModelRuleset = computed(() =>
  modelRulesets.value.find((r) => r.enabled) ?? null
);

const modelRulesetOptions = computed<SelectOption[]>(() =>
  modelRulesets.value.map((r) => ({ label: `${r.name}${r.enabled ? t('image.rules.enabledSuffix') : ''}`, value: r.id }))
);

// Auto-select the enabled model ruleset when rulesets are seeded
watch(modelRulesets, (list) => {
  if (editingModelRulesetId.value) return;
  const enabled = list.find((r) => r.enabled);
  if (enabled) selectModelRuleset(enabled.id);
}, { immediate: true });

function selectModelRuleset(id: string) {
  editingModelRulesetId.value = id;
  const r = modelRulesets.value.find((x) => x.id === id);
  if (r) {
    editModelRulesetName.value = r.name;
    editModelRulesetBase.value = r.baseModelRule;
    editModelRulesetAnchor.value = r.anchorModeModelRule;
  }
}

function createModelRuleset() {
  const ruleset: ModelRuleset = {
    id: `mrs_${Date.now()}`,
    name: t('image.rules.rulesetDefaultName', { n: modelRulesets.value.length + 1 }),
    enabled: false,
    compatMode: false,
    baseModelRule: '',
    anchorModeModelRule: '',
    serializationStrategy: 'nai_character_segments',
    npcTemplateId: '',
    sceneTemplateId: '',
    judgeTemplateId: '',
  };
  const list = [...modelRulesets.value, ruleset];
  setValue('系统.扩展.image.modelRulesets', list);
  selectModelRuleset(ruleset.id);
}

function saveModelRuleset() {
  if (!editingModelRuleset.value) return;
  const list = modelRulesets.value.map((r) =>
    r.id === editingModelRulesetId.value
      ? { ...r, name: editModelRulesetName.value, baseModelRule: editModelRulesetBase.value, anchorModeModelRule: editModelRulesetAnchor.value }
      : r
  );
  setValue('系统.扩展.image.modelRulesets', list);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetSaved'), duration: 1500 });
}

function deleteModelRuleset() {
  const list = modelRulesets.value.filter((r) => r.id !== editingModelRulesetId.value);
  setValue('系统.扩展.image.modelRulesets', list);
  editingModelRulesetId.value = '';
}

function toggleModelRulesetEnabled(value: boolean) {
  // Only one ruleset can be enabled — disable others first
  const list = modelRulesets.value.map((r) => ({
    ...r,
    enabled: r.id === editingModelRulesetId.value ? value : (value ? false : r.enabled),
  }));
  setValue('系统.扩展.image.modelRulesets', list);
}

function toggleModelRulesetCompat(value: boolean) {
  const list = modelRulesets.value.map((r) =>
    r.id === editingModelRulesetId.value ? { ...r, compatMode: value } : r
  );
  setValue('系统.扩展.image.modelRulesets', list);
}

function exportModelRulesets() {
  const data = modelRulesets.value;
  if (data.length === 0) {
    eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.noModelRulesetsToExport'), duration: 1500 });
    return;
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `model-rulesets-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetsExported', { n: data.length }), duration: 1500 });
}

function importModelRulesets(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result as string);
      const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (r: unknown): r is ModelRuleset => typeof r === 'object' && r !== null && 'name' in r
      ).map((r) => ({
        ...r,
        id: `mrs_import_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        enabled: false,
      }));
      if (items.length === 0) {
        eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.noValidRulesetData'), duration: 2000 });
        return;
      }
      setValue('系统.扩展.image.modelRulesets', [...modelRulesets.value, ...items]);
      eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetsImported', { n: items.length }), duration: 1500 });
    } catch {
      eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// Rules state — full CRUD
interface RuleTemplate {
  id: string;
  name: string;
  scope: 'npc' | 'scene' | 'judge';
  baseRule: string;
  anchorRule: string;
  noAnchorFallback: string;
  outputFormat: string;
  transformerPresetId: string;
}

const ruleScope = ref<'npc' | 'scene' | 'judge'>('npc');

const ruleTemplates = computed<RuleTemplate[]>(() => {
  const raw = get('系统.扩展.image.ruleTemplates');
  return Array.isArray(raw) ? raw as RuleTemplate[] : [];
});

const scopedRuleTemplates = computed(() =>
  ruleTemplates.value.filter((r) => r.scope === ruleScope.value)
);

// "当前生效" — which rule is active per scope
const activeNpcRuleId = ref(String(get('系统.扩展.image.rules.activeNpcRule') ?? ''));
const activeSceneRuleId = ref(String(get('系统.扩展.image.rules.activeSceneRule') ?? ''));
const activeJudgeRuleId = ref(String(get('系统.扩展.image.rules.activeJudgeRule') ?? ''));

const currentActiveRuleId = computed({
  get: () => ruleScope.value === 'npc' ? activeNpcRuleId.value : ruleScope.value === 'scene' ? activeSceneRuleId.value : activeJudgeRuleId.value,
  set: (v: string) => {
    if (ruleScope.value === 'npc') activeNpcRuleId.value = v;
    else if (ruleScope.value === 'scene') activeSceneRuleId.value = v;
    else activeJudgeRuleId.value = v;
  },
});

// "当前编辑" — which rule is being edited
const editingRuleId = ref('');

const editingRule = computed(() =>
  ruleTemplates.value.find((r) => r.id === editingRuleId.value) ?? null
);

// Editor fields
const editRuleName = ref('');
const editBaseRule = ref('');
const editAnchorRule = ref('');
const editNoAnchorFallback = ref('');
const editOutputFormat = ref('');
const editRuleTransformerId = ref('');

const activeRuleOptions = computed<SelectOption[]>(() => [
  { label: t('image.presets.notUsed'), value: '' },
  ...scopedRuleTemplates.value.map((r) => ({ label: r.name, value: r.id })),
]);

const editRuleOptions = computed<SelectOption[]>(() =>
  scopedRuleTemplates.value.map((r) => ({ label: r.name, value: r.id }))
);

const npcTransformerOptions = computed<SelectOption[]>(() => [
  { label: t('image.presets.notUsed'), value: '' },
  ...transformerPresets.value.filter((p) => p.scope === 'npc').map((p) => ({ label: p.name, value: p.id })),
]);
const sceneTransformerOptions = computed<SelectOption[]>(() => [
  { label: t('image.presets.notUsed'), value: '' },
  ...transformerPresets.value.filter((p) => p.scope === 'scene').map((p) => ({ label: p.name, value: p.id })),
]);

const currentTransformerOptions = computed(() =>
  ruleScope.value === 'npc' ? npcTransformerOptions.value : sceneTransformerOptions.value
);

function loadRuleIntoEditor() {
  if (editingRule.value) {
    editRuleName.value = editingRule.value.name;
    editBaseRule.value = editingRule.value.baseRule;
    editAnchorRule.value = editingRule.value.anchorRule;
    editNoAnchorFallback.value = editingRule.value.noAnchorFallback;
    editOutputFormat.value = editingRule.value.outputFormat;
    editRuleTransformerId.value = editingRule.value.transformerPresetId;
  }
}

function selectEditRule(id: string) {
  editingRuleId.value = id;
  loadRuleIntoEditor();
}

// Auto-select first rule template when scope changes and nothing is selected
watch([scopedRuleTemplates, ruleScope], ([templates]) => {
  if (editingRuleId.value && templates.some((t: RuleTemplate) => t.id === editingRuleId.value)) return;
  if (templates.length > 0) {
    selectEditRule(templates[0].id);
  }
}, { immediate: true });

function createRuleTemplate() {
  const rule: RuleTemplate = {
    id: `rule_${Date.now()}`,
    name: (ruleScope.value === 'npc' ? t('image.rules.npcRuleName', { n: scopedRuleTemplates.value.length + 1 }) : ruleScope.value === 'scene' ? t('image.rules.sceneRuleName', { n: scopedRuleTemplates.value.length + 1 }) : t('image.rules.judgeRuleName', { n: scopedRuleTemplates.value.length + 1 })),
    scope: ruleScope.value,
    baseRule: '', anchorRule: '', noAnchorFallback: '', outputFormat: '',
    transformerPresetId: '',
  };
  const list = [...ruleTemplates.value, rule];
  setValue('系统.扩展.image.ruleTemplates', list);
  editingRuleId.value = rule.id;
  loadRuleIntoEditor();
}

function saveRuleTemplate() {
  if (!editingRule.value) return;
  const list = ruleTemplates.value.map((r) =>
    r.id === editingRuleId.value
      ? { ...r, name: editRuleName.value, baseRule: editBaseRule.value, anchorRule: editAnchorRule.value, noAnchorFallback: editNoAnchorFallback.value, outputFormat: editOutputFormat.value, transformerPresetId: editRuleTransformerId.value }
      : r
  );
  setValue('系统.扩展.image.ruleTemplates', list);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.ruleSaved'), duration: 1500 });
}

function deleteRuleTemplate() {
  const list = ruleTemplates.value.filter((r) => r.id !== editingRuleId.value);
  setValue('系统.扩展.image.ruleTemplates', list);
  // Clear active if deleted
  if (currentActiveRuleId.value === editingRuleId.value) {
    currentActiveRuleId.value = '';
  }
  editingRuleId.value = '';
}

function saveActiveRules() {
  const existing = (get('系统.扩展.image.rules') as Record<string, unknown>) ?? {};
  setValue('系统.扩展.image.rules', {
    ...existing,
    activeNpcRule: activeNpcRuleId.value,
    activeSceneRule: activeSceneRuleId.value,
    activeJudgeRule: activeJudgeRuleId.value,
  });
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.activeRulesUpdated'), duration: 1500 });
}

// Rules import/export
function exportRules() {
  const data = {
    ruleTemplates: ruleTemplates.value,
    modelRulesets: modelRulesets.value,
    rules: get('系统.扩展.image.rules'),
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `image-rules-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.rulesExported'), duration: 1500 });
}

function importRules(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      if (Array.isArray(data.ruleTemplates)) {
        setValue('系统.扩展.image.ruleTemplates', data.ruleTemplates);
      }
      if (Array.isArray(data.modelRulesets)) {
        setValue('系统.扩展.image.modelRulesets', data.modelRulesets);
      }
      if (data.rules && typeof data.rules === 'object') {
        setValue('系统.扩展.image.rules', data.rules);
      }
      eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.rulesImported'), duration: 1500 });
    } catch {
      eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// Combined history: NPC archives + scene archives + task queue, sorted by time
interface CombinedHistoryEntry {
  key: string;
  type: 'character' | 'scene';
  timestamp: number;
  id: string;
  name: string;
  status: string;
  positivePrompt?: string;
  negativePrompt?: string;
  composition?: string;
  model?: string;
  apiConfigName?: string;
  artStyle?: string;
  error?: string;
  assetId?: string;
  taskId?: string;
  /** Captured output dimensions + backend — used by "生成同款" to replay. */
  width?: number;
  height?: number;
  backend?: ImageBackendType;
  part?: 'breast' | 'vagina' | 'anus';
  providerMeta?: { civitai?: CivitaiLoraSnapshot; reference?: { mode: string; sourceAssetIds?: string[]; sourceAssetId?: string; denoiseStrength?: number; provider?: string } };
}

const combinedHistory = computed<CombinedHistoryEntry[]>(() => {
  void imageUpdateTick.value;
  const entries: CombinedHistoryEntry[] = [];

  // NPC archives
  if (Array.isArray(relationships.value)) {
    for (const npc of relationships.value) {
      const name = String(npc['名称'] ?? '');
      const archive = npc['图片档案'] as Record<string, unknown> | undefined;
      if (!archive) continue;
      const history = archive['生图历史'];
      if (!Array.isArray(history)) continue;
      for (const record of history as Array<Record<string, unknown>>) {
        entries.push({
          key: `npc_${name}_${record.id ?? record.createdAt}`,
          type: 'character',
          timestamp: Number(record.createdAt ?? record['生成时间'] ?? 0),
          id: String(record.id ?? ''),
          name,
          status: String(record.status ?? 'complete'),
          positivePrompt: String(record.positivePrompt ?? record['最终正向提示词'] ?? ''),
          negativePrompt: String(record.negativePrompt ?? record['最终负向提示词'] ?? ''),
          composition: String(record.composition ?? ''),
          model: String(record.model ?? record['使用模型'] ?? ''),
          apiConfigName: typeof record.apiConfigName === 'string' ? record.apiConfigName : undefined,
          artStyle: String(record.artStyle ?? record['画风'] ?? ''),
          assetId: String(record.id ?? ''),
          width: Number(record.width) || undefined,
          height: Number(record.height) || undefined,
          backend: (record.backend as ImageBackendType | undefined) ?? undefined,
          part: record.part as 'breast' | 'vagina' | 'anus' | undefined,
          providerMeta: extractProviderMeta(record),
        });
      }
    }
  }

  // Player archive
  for (const record of getPlayerArchiveHistory()) {
    entries.push({
      key: `player_${record.id ?? record.createdAt}`,
      type: 'character',
      timestamp: Number(record.createdAt ?? 0),
      id: String(record.id ?? ''),
      name: playerName.value ?? t('image.scene.playerFallback'),
      status: String(record.status ?? 'complete'),
      positivePrompt: String(record.positivePrompt ?? ''),
      negativePrompt: String(record.negativePrompt ?? ''),
      composition: String(record.composition ?? ''),
      model: record.model ?? undefined,
      apiConfigName: record.apiConfigName ?? undefined,
      assetId: String(record.id ?? ''),
      width: Number(record.width) || undefined,
      height: Number(record.height) || undefined,
      backend: record.backend ?? undefined,
      part: record.part ?? undefined,
      providerMeta: extractProviderMeta(record as unknown as Record<string, unknown>),
    });
  }

  // Scene archives
  for (const record of sceneArchiveHistory.value) {
    entries.push({
      key: `scene_${record.id ?? record.createdAt}`,
      type: 'scene',
      timestamp: Number(record.createdAt ?? record['生成时间'] ?? 0),
      id: String(record.id ?? ''),
      name: t('image.history.typeScene'),
      status: String(record.status ?? 'complete'),
      positivePrompt: String(record.positivePrompt ?? record['最终正向提示词'] ?? ''),
      negativePrompt: String(record.negativePrompt ?? record['最终负向提示词'] ?? ''),
      model: String(record.model ?? record['使用模型'] ?? ''),
      apiConfigName: typeof record.apiConfigName === 'string' ? record.apiConfigName : undefined,
      assetId: String(record.id ?? ''),
      taskId: String(record.taskId ?? ''),
      width: Number(record.width) || undefined,
      height: Number(record.height) || undefined,
      backend: (record.backend as ImageBackendType | undefined) ?? undefined,
      providerMeta: extractProviderMeta(record),
    });
  }

  // Sort by timestamp descending (newest first)
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
});

const filteredHistory = computed(() => {
  let entries = combinedHistory.value;
  const f = historyFilter.value;
  if (f === 'character') entries = entries.filter((e) => e.type === 'character');
  else if (f === 'scene') entries = entries.filter((e) => e.type === 'scene');
  else if (f === 'complete') entries = entries.filter((e) => e.status === 'complete');
  else if (f === 'failed') entries = entries.filter((e) => e.status === 'failed');
  return entries;
});

function clearAllNpcHistory() {
  if (!imageService || !Array.isArray(relationships.value)) return;
  for (const npc of relationships.value) {
    const name = String(npc['名称'] ?? '');
    if (name) imageService.clearNpcHistory(name);
  }
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedAllNpcHistory'), duration: 1500 });
}

function clearAllSceneHistory() {
  clearSceneHistory();
}
// Convert engine TransformerPromptPreset → UI RuleTemplate
function enginePresetToRuleTemplate(p: TransformerPromptPreset): RuleTemplate {
  const scopeMap: Record<string, 'npc' | 'scene' | 'judge'> = { npc: 'npc', scene: 'scene', scene_judge: 'judge' };
  return {
    id: p.id,
    name: p.name,
    scope: scopeMap[p.scope] ?? 'npc',
    baseRule: p.prompt,
    anchorRule: p.scope === 'scene' ? (p.sceneAnchorModePrompt ?? p.anchorModePrompt ?? '') : (p.anchorModePrompt ?? ''),
    noAnchorFallback: p.noAnchorFallbackPrompt ?? '',
    outputFormat: p.outputFormatPrompt ?? '',
    transformerPresetId: '',
  };
}

// Convert engine ModelTransformerBundle → UI ModelRuleset
function engineBundleToModelRuleset(b: ModelTransformerBundle): ModelRuleset {
  return {
    id: b.id,
    name: b.name,
    enabled: b.enabled,
    compatMode: false,
    baseModelRule: b.modelPrompt,
    anchorModeModelRule: b.anchorModeModelPrompt,
    serializationStrategy: b.serializationStrategy,
    npcTemplateId: b.npcPresetId,
    sceneTemplateId: b.scenePresetId,
    judgeTemplateId: b.sceneJudgePresetId,
  };
}

onMounted(() => {
  const npcQuery = route.query.npc;
  if (typeof npcQuery === 'string' && npcQuery) {
    selectedNpc.value = npcQuery;
  }

  // Seed or update model rulesets + rule templates with locale-aware prompt text.
  // When pack provides transformer defaults (locale-specific), always update the
  // built-in presets' prompt fields to match the current locale. User-created
  // presets (IDs not in the default set) are preserved untouched.
  const packDefaults: TransformerDefaultsData | undefined = imageService?.getTransformerDefaults();
  const localeDefRulesets = getDefaultModelBundles(packDefaults).map(engineBundleToModelRuleset);
  const localeDefTemplates = getDefaultPresets(packDefaults).map(enginePresetToRuleTemplate);
  const defaultRulesetIds = new Set(localeDefRulesets.map(r => r.id));
  const defaultTemplateIds = new Set(localeDefTemplates.map(r => r.id));

  const existingRulesets = get('系统.扩展.image.modelRulesets') as ModelRuleset[] | undefined;
  if (!Array.isArray(existingRulesets) || existingRulesets.length === 0) {
    setValue('系统.扩展.image.modelRulesets', localeDefRulesets);
  } else {
    const existingIds = new Set(existingRulesets.map(r => r.id));
    const localeMap = new Map(localeDefRulesets.map(r => [r.id, r]));
    const updated = existingRulesets.map(r => {
      const localeVer = localeMap.get(r.id);
      if (localeVer && defaultRulesetIds.has(r.id)) {
        return { ...r, name: localeVer.name, baseModelRule: localeVer.baseModelRule, anchorModeModelRule: localeVer.anchorModeModelRule };
      }
      return r;
    });
    const missing = localeDefRulesets.filter(r => !existingIds.has(r.id));
    if (missing.length > 0 || packDefaults) {
      setValue('系统.扩展.image.modelRulesets', [...updated, ...missing]);
    }
  }

  const existingTemplates = get('系统.扩展.image.ruleTemplates') as RuleTemplate[] | undefined;
  if (!Array.isArray(existingTemplates) || existingTemplates.length === 0) {
    setValue('系统.扩展.image.ruleTemplates', localeDefTemplates);
  } else {
    const existingIds = new Set(existingTemplates.map(r => r.id));
    const localeMap = new Map(localeDefTemplates.map(r => [r.id, r]));
    const updated = existingTemplates.map(r => {
      const localeVer = localeMap.get(r.id);
      if (localeVer && defaultTemplateIds.has(r.id)) {
        return { ...r, name: localeVer.name, baseRule: localeVer.baseRule, anchorRule: localeVer.anchorRule, noAnchorFallback: localeVer.noAnchorFallback, outputFormat: localeVer.outputFormat };
      }
      return r;
    });
    const missing = localeDefTemplates.filter(r => !existingIds.has(r.id));
    if (missing.length > 0 || packDefaults) {
      setValue('系统.扩展.image.ruleTemplates', [...updated, ...missing]);
    }
  }
});

// Gallery state
const galleryNpc = ref('');

interface GalleryImage {
  id: string;
  createdAt: number | string;
  composition?: string;
  artStyle?: string;
  model?: string;
  apiConfigName?: string;
  status?: 'complete' | 'failed' | 'generating' | 'pending' | 'tokenizing';
  positivePrompt?: string;
  negativePrompt?: string;
  /** Populated for secret-part records so regen targets the right archive. */
  part?: 'breast' | 'vagina' | 'anus';
  /** Captured output dimensions — used to replay the same size on regen. */
  width?: number;
  height?: number;
  /** Backend that produced the record; initial value when opening the regen modal. */
  backend?: ImageBackendType;
  providerMeta?: { civitai?: CivitaiLoraSnapshot; reference?: { mode: string; sourceAssetIds?: string[]; sourceAssetId?: string; denoiseStrength?: number; provider?: string } };
}

// Player archive for Gallery/History integration (__player__ pseudo-NPC)
const PLAYER_ID = '__player__';
const playerArchiveRaw = useValue<Record<string, unknown>>('角色.图片档案');
const playerName = useValue<string>(DEFAULT_ENGINE_PATHS.playerName);

function getArchiveHistory(npc: Record<string, unknown>): GalleryImage[] {
  const archive = npc['图片档案'] as Record<string, unknown> | undefined;
  if (!archive) return [];
  const history = archive['生图历史'];
  return Array.isArray(history) ? history as GalleryImage[] : [];
}

function getPlayerArchiveHistory(): GalleryImage[] {
  const raw = playerArchiveRaw.value;
  if (!raw || typeof raw !== 'object') return [];
  const history = raw['生图历史'];
  return Array.isArray(history) ? history as GalleryImage[] : [];
}

const npcsWithImages = computed(() => {
  void imageUpdateTick.value;
  const list = relationships.value;
  const result: Array<Record<string, unknown>> = [];

  // Include player as virtual NPC if they have images
  if (getPlayerArchiveHistory().length > 0) {
    result.push({ '名称': PLAYER_ID, '性别': '', '是否主要角色': true, '图片档案': playerArchiveRaw.value });
  }

  if (Array.isArray(list)) {
    result.push(...list.filter((npc) => getArchiveHistory(npc).length > 0));
  }
  return result;
});

const galleryImages = computed(() => {
  void imageUpdateTick.value;
  if (!galleryNpc.value) return [];
  if (galleryNpc.value === PLAYER_ID) {
    return [...getPlayerArchiveHistory()].reverse();
  }
  if (!Array.isArray(relationships.value)) return [];
  const npc = relationships.value.find((n) => n['名称'] === galleryNpc.value);
  if (!npc) return [];
  return [...getArchiveHistory(npc)].reverse();
});

const galleryNpcData = computed(() => {
  if (!galleryNpc.value) return null;
  if (galleryNpc.value === PLAYER_ID) {
    return { '名称': playerName.value ?? t('image.scene.playerFallback'), '性别': '', '是否主要角色': true, '图片档案': playerArchiveRaw.value } as Record<string, unknown>;
  }
  if (!Array.isArray(relationships.value)) return null;
  return relationships.value.find((n) => n['名称'] === galleryNpc.value) ?? null;
});

function getCurrentArchive(): Record<string, unknown> | undefined {
  if (!galleryNpc.value) return undefined;
  if (galleryNpc.value === PLAYER_ID) {
    const raw = playerArchiveRaw.value;
    return raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  }
  if (!Array.isArray(relationships.value)) return undefined;
  const npc = relationships.value.find((n) => n['名称'] === galleryNpc.value);
  return npc?.['图片档案'] as Record<string, unknown> | undefined;
}

function isCurrentAvatar(assetId: string): boolean {
  return getCurrentArchive()?.['已选头像图片ID'] === assetId;
}

function isCurrentPortrait(assetId: string): boolean {
  return getCurrentArchive()?.['已选立绘图片ID'] === assetId;
}

function isCurrentBackground(assetId: string): boolean {
  return getCurrentArchive()?.['已选背景图片ID'] === assetId;
}

function setAsAvatar(assetId: string) {
  if (!imageService || !galleryNpc.value) return;
  imageService.setNpcAvatar(galleryNpc.value, assetId);
}

function setAsPortrait(assetId: string) {
  if (!imageService || !galleryNpc.value) return;
  imageService.setNpcPortrait(galleryNpc.value, assetId);
}

function clearAvatar() {
  if (!imageService || !galleryNpc.value) return;
  imageService.clearNpcAvatar(galleryNpc.value);
}

function clearPortrait() {
  if (!imageService || !galleryNpc.value) return;
  imageService.clearNpcPortrait(galleryNpc.value);
}

function setAsBackground(assetId: string) {
  if (!imageService || !galleryNpc.value) return;
  imageService.setNpcBackground(galleryNpc.value, assetId);
}

function clearBackground() {
  if (!imageService || !galleryNpc.value) return;
  imageService.clearNpcBackground(galleryNpc.value);
}

function setPersistentWallpaper(assetId: string) {
  if (!imageService) return;
  imageService.state.setPersistentWallpaper(assetId);
  eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.setPersistentWallpaper'), duration: 1500 });
}

function clearPersistentWallpaper() {
  if (!imageService) return;
  imageService.state.clearPersistentWallpaper();
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedPersistentWallpaper'), duration: 1500 });
}

const persistentWallpaperRaw = useValue<string>('系统.扩展.image.persistentWallpaper');
const persistentWallpaper = computed(() => persistentWallpaperRaw.value ?? '');

function isPersistentWallpaper(assetId: string): boolean {
  const pw = persistentWallpaper.value;
  return Boolean(pw && pw === assetId);
}

// Selection button eligibility.
//
// Previously gated on composition (portrait → avatar only; half-body/full-length
// → portrait only). That blocked the "generate 同款 then swap avatar" flow:
// when the regen uses a different composition (or composition wasn't recorded
// on the original), the new image had no button, and the currently-set card's
// cancel button also disappeared because its composition didn't match the new
// gate. We now accept any complete non-secret image — secret-part images are
// still excluded because they're close-ups and make poor avatars.
//
// The composition field stays on the record for display/badging; it just no
// longer blocks the selection actions.
function canSelectAvatar(img: GalleryImage): boolean {
  return img.status === 'complete' && img.composition !== 'secret_part';
}

function canSelectPortrait(img: GalleryImage): boolean {
  return img.status === 'complete' && img.composition !== 'secret_part';
}

function canSelectBackground(img: GalleryImage): boolean {
  return img.status === 'complete';
}

function canSelectSecretPart(img: GalleryImage): boolean {
  if (img.status !== 'complete') return false;
  if (get('系统.nsfwMode') !== true) return false;
  const npcData = galleryNpcData.value;
  if (!npcData) return false;
  const gender = String(npcData['性别'] ?? '');
  return !gender.includes('男');
}

function isCurrentSecretPart(assetId: string, part: SecretPartType): boolean {
  void imageUpdateTick.value;
  const archive = getCurrentArchive();
  const secretArchive = archive?.['香闺秘档'] as Record<string, unknown> | undefined;
  if (!secretArchive) return false;
  const cnKey = part === 'breast' ? '胸部' : part === 'vagina' ? '小穴' : '屁穴';
  const entry = secretArchive[cnKey] as Record<string, unknown> | undefined;
  return typeof entry?.id === 'string' && entry.id === assetId;
}

function setAsSecretPart(assetId: string, part: SecretPartType) {
  if (!imageService || !galleryNpc.value) return;
  imageService.setNpcSecretPart(galleryNpc.value, part, assetId);
  imageUpdateTick.value++;
  const label = part === 'breast' ? t('image.gallery.action.partBreast') : part === 'vagina' ? t('image.gallery.action.partVagina') : t('image.gallery.action.partAnus');
  eventBus.emit('ui:toast', { type: 'success', message: t('image.gallery.toast.setSecretPart', { part: label }), duration: 1500 });
}

function clearSecretPart(part: SecretPartType) {
  if (!imageService || !galleryNpc.value) return;
  imageService.clearNpcSecretPart(galleryNpc.value, part);
  imageUpdateTick.value++;
}

function deleteImage(assetId: string) {
  if (!galleryNpc.value || !imageService) return;
  imageService.deleteNpcImage(galleryNpc.value, assetId);
}

function deleteNpcHistoryEntry(npcName: string, imageId: string) {
  if (!imageService) return;
  imageService.deleteNpcImage(npcName, imageId);
}

function clearNpcImages() {
  if (!galleryNpc.value || !imageService) return;
  imageService.clearNpcHistory(galleryNpc.value);
  eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.clearedNpcImages', { name: galleryNpc.value }), duration: 1500 });
}
</script>

<template>
  <div class="image-panel">
    <header class="panel-header">
      <h2 class="panel-title">{{ $t('image.title') }}</h2>
    </header>

    <div v-if="!enabled" class="panel-notice">
      <p>{{ $t('image.panel.notEnabled') }}</p>
      <p style="margin-top:8px;font-size:var(--font-size-xs);color:var(--color-text-muted)">
        {{ $t('image.panel.notEnabledHint') }}
      </p>
    </div>

    <template v-else-if="isLoaded">
      <AgaTabBar :tabs="tabs" v-model="activeTab" />

      <!-- Stats bar -->
      <div class="stats-bar">
        <div class="stat-card"><span class="stat-value">{{ totalImages }}</span><span class="stat-label">{{ $t('image.panel.statsTotal') }}</span></div>
        <div class="stat-card stat-card--success"><span class="stat-value">{{ successCount }}</span><span class="stat-label">{{ $t('image.panel.statsSuccess') }}</span></div>
        <div class="stat-card stat-card--danger"><span class="stat-value">{{ failedCount }}</span><span class="stat-label">{{ $t('image.panel.statsFailed') }}</span></div>
        <div class="stat-card stat-card--info"><span class="stat-value">{{ pendingCount }}</span><span class="stat-label">{{ $t('image.panel.statsPending') }}</span></div>
        <div v-if="successCount + failedCount > 0" class="stat-card stat-card--bar">
          <AgaProgressBar
            :value="successCount"
            :max="successCount + failedCount"
            :label="$t('image.panel.statsSuccessRate')"
            :show-value="true"
            variant="success"
          />
        </div>
      </div>

      <!-- ═══ Manual Generation Tab ═══ -->
      <div v-if="activeTab === 'manual'" class="tab-content">
        <div class="backend-status-bar">
          <span :class="['status-dot', activeBackendStatus.configured ? 'status-dot--ok' : 'status-dot--off']" />
          <span class="backend-status-label">{{ activeBackendStatus.label }}</span>
          <span v-if="activeBackendStatus.model" class="backend-status-model">{{ activeBackendStatus.model }}</span>
          <span v-if="!activeBackendStatus.configured" class="backend-status-warn">{{ $t('image.panel.backendNotConfigured') }}</span>
        </div>
        <CivitaiLoraShelf
          v-if="backend === 'civitai'"
          mode="compact"
          scope="character"
          :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
        />
        <div class="gen-layout">
          <!-- Left: NPC info + form -->
          <div class="gen-form-col">
            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.selectLabel') }}</label>
              <AgaSelect :options="npcOptions" v-model="selectedNpc" :placeholder="$t('image.manual.selectPlaceholder')" />
            </div>

            <!-- NPC summary card -->
            <div v-if="selectedNpcData" class="npc-summary-card">
              <div class="npc-summary-name">{{ selectedNpcData['名称'] }}</div>
              <div class="npc-summary-meta">
                <span v-if="selectedNpcData['性别']">{{ selectedNpcData['性别'] }}</span>
                <span v-if="selectedNpcData['年龄']">{{ $t('image.npcMeta.ageSuffix', { age: selectedNpcData['年龄'] }) }}</span>
                <span v-if="selectedNpcData['是否主要角色']" class="badge-major">{{ $t('image.manual.majorRole') }}</span>
              </div>
              <p v-if="selectedNpcData['描述']" class="npc-summary-desc">{{ String(selectedNpcData['描述']).slice(0, 120) }}</p>
            </div>

            <!-- Anchor status banner -->
            <div v-if="selectedNpc" :class="[
              'anchor-banner',
              selectedNpcAnchor?.enabled ? 'anchor-banner--active' :
              selectedNpcAnchor ? 'anchor-banner--inactive' : 'anchor-banner--none'
            ]">
              <template v-if="selectedNpcAnchor?.enabled">{{ $t('image.manual.anchorActive', { name: selectedNpcAnchor.name }) }}</template>
              <template v-else-if="selectedNpcAnchor">{{ $t('image.manual.anchorInactive') }}</template>
              <template v-else>{{ $t('image.manual.anchorNone') }}</template>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.compositionPreset') }}</label>
              <div class="btn-grid btn-grid--4">
                <button
                  v-for="opt in compositionOptions"
                  :key="opt.value"
                  type="button"
                  :class="['grid-btn', { 'grid-btn--active': composition === opt.value }]"
                  @click="composition = opt.value"
                >
                  <div class="grid-btn__label">{{ opt.label }}</div>
                  <div class="grid-btn__sub">{{ opt.subtitle }}</div>
                </button>
              </div>
              <div v-if="isCustomComposition" class="form-section" style="margin-top: 8px;">
                <div class="form-hint">{{ $t('image.manual.customCompositionHint') }}</div>
                <input
                  v-model="customComposition"
                  type="text"
                  class="form-input"
                  :placeholder="$t('image.manual.customCompositionPlaceholder')"
                />
              </div>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.artStyleLabel') }}</label>
              <div class="btn-grid btn-grid--5">
                <button
                  v-for="opt in styleOptions"
                  :key="opt.value"
                  type="button"
                  :class="['grid-btn grid-btn--compact', { 'grid-btn--active': artStyle === opt.value }]"
                  @click="artStyle = opt.value"
                >
                  <div class="grid-btn__label">{{ opt.label }}</div>
                </button>
              </div>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.sizeLabel') }}</label>
              <div class="btn-grid btn-grid--6">
                <button
                  v-for="opt in sizePresetOptions"
                  :key="opt.value"
                  type="button"
                  :class="['grid-btn grid-btn--compact', { 'grid-btn--active': sizePreset === opt.value }, { 'grid-btn--disabled': !isCustomComposition }]"
                  :disabled="!isCustomComposition"
                  @click="sizePreset = opt.value"
                >
                  <div class="grid-btn__label">{{ opt.label }}</div>
                </button>
              </div>

              <!-- 1x/2x 倍率 toggle (only for preset ratios, not 'none' or 'custom') -->
              <div v-if="isCustomComposition && sizePreset !== 'custom' && sizePreset !== 'none'" class="scale-toggle">
                <span class="form-hint">{{ $t('image.manual.scaleLabel') }}</span>
                <button
                  v-for="s in (['1x', '2x'] as const)"
                  :key="s"
                  type="button"
                  :class="['scale-btn', { 'scale-btn--active': sizeScale === s }]"
                  @click="sizeScale = s"
                >{{ s.toUpperCase() }}</button>
              </div>

              <!-- Width / Height inputs -->
              <div class="size-inputs">
                <div class="size-input-group">
                  <div class="form-hint">{{ $t('image.manual.widthLabel') }}</div>
                  <input
                    v-model="manualWidth"
                    type="text"
                    class="form-input"
                    :disabled="!isCustomComposition || sizePreset !== 'custom'"
                    :placeholder="presetSize ? String(presetSize.w) : '1024'"
                    @input="sizePreset = 'custom'"
                  />
                </div>
                <div class="size-input-group">
                  <div class="form-hint">{{ $t('image.manual.heightLabel') }}</div>
                  <input
                    v-model="manualHeight"
                    type="text"
                    class="form-input"
                    :disabled="!isCustomComposition || sizePreset !== 'custom'"
                    :placeholder="presetSize ? String(presetSize.h) : '1024'"
                    @input="sizePreset = 'custom'"
                  />
                </div>
              </div>

              <div class="form-hint">{{ $t('image.manual.currentSize', { size: currentSizeDisplay }) }}</div>
              <div v-if="!isCustomComposition" class="form-hint">{{ $t('image.manual.sizeAutoHint') }}</div>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.artistPreset') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.manual.noPreset'), value: '' }, ...npcArtistPresets.map(p => ({ label: p.name, value: p.id }))]"
                v-model="selectedArtistPreset"
              />
              <div v-if="selectedArtistPreset && artistPresets.find(p => p.id === selectedArtistPreset)" class="preset-preview">
                <span class="form-hint">{{ artistPresets.find(p => p.id === selectedArtistPreset)?.artistString?.slice(0, 80) || $t('image.presets.empty') }}</span>
              </div>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.pngPreset') }}</label>
              <AgaSelect
                :options="pngPresetOptions"
                v-model="selectedPngPreset"
              />
              <div v-if="selectedPngPreset && artistPresets.find(p => p.id === selectedPngPreset)" class="preset-preview">
                <span class="form-hint">{{ artistPresets.find(p => p.id === selectedPngPreset)?.positive?.slice(0, 80) || $t('image.presets.empty') }}</span>
              </div>
            </div>

            <div class="form-section">
              <label class="form-label">{{ $t('image.manual.extraPrompt') }}</label>
              <textarea v-model="extraPrompt" class="form-textarea" rows="2" :placeholder="$t('image.manual.extraPromptPlaceholder')" />
            </div>

            <div class="form-section form-section--inline">
              <label class="form-label">{{ $t('image.manual.backgroundMode') }}</label>
              <AgaToggle v-model="backgroundMode" />
            </div>

            <!-- Reference redraw (R9: single toggle) -->
            <div v-if="backendSupportsImg2Img" class="form-section">
              <div class="form-section form-section--inline">
                <label class="form-label">{{ $t('image.manual.referenceRedraw') }}</label>
                <AgaToggle v-model="npcReferenceEnabled" data-testid="ref-redraw-toggle" />
              </div>
              <div v-if="npcReferenceEnabled" class="ref-controls">
                <!-- 多图后端（豆包）：整块换成多图选择器；其余后端保持单张控件 -->
                <MultiReferencePicker
                  v-if="backendSupportsMultiRef"
                  v-model="npcReferenceItems"
                  :max="SEEDREAM_MAX_REFERENCE_IMAGES"
                  :quick-sources="npcQuickSources"
                  testid="npc-multi-ref"
                  @add-files="onNpcMultiRefFiles"
                  @add-quick="onNpcQuickSource"
                />
                <template v-else>
                  <label class="form-label">{{ $t('image.manual.refSource') }}</label>
                  <AgaSelect
                    :options="[
                      { label: $t('image.manual.refUpload'), value: 'upload' },
                      { label: $t('image.manual.refAvatar'), value: 'avatar' },
                    ]"
                    v-model="npcReferenceSource"
                  />
                  <div v-if="npcReferenceSource === 'upload'" style="margin-top: var(--space-xs);">
                    <label class="ref-upload-btn">
                      {{ npcReferenceFile ? npcReferenceFile.name : $t('image.manual.refSelectFile') }}
                      <input type="file" accept="image/*" style="display:none" @change="onNpcReferenceFileChange" />
                    </label>
                  </div>
                </template>
                <template v-if="backendSupportsRefStrength">
                  <label class="form-label" style="margin-top: var(--space-xs);">{{ $t('image.manual.refDenoiseLabel') }}</label>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="0.1" max="1" step="0.05" v-model.number="npcReferenceDenoise" style="flex:1" data-testid="ref-denoise-slider" />
                    <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ npcReferenceDenoise.toFixed(2) }}</span>
                  </div>
                  <div class="ref-marks"><span>{{ $t('image.regenerate.markNear') }}</span><span>{{ $t('image.regenerate.markKeep') }}</span><span>{{ $t('image.regenerate.markHeavy') }}</span></div>
                </template>
                <p v-else class="form-hint" style="margin-top: var(--space-xs);" data-testid="ref-strength-unsupported">
                  {{ $t('image.reference.strengthUnsupported') }}
                </p>
                <div v-if="backend === 'novelai'" style="margin-top:6px;">
                  <label class="form-label">{{ $t('image.manual.refNoiseLabel') }}</label>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="0" max="1" step="0.05" v-model.number="npcReferenceNoise" style="flex:1" />
                    <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ npcReferenceNoise.toFixed(2) }}</span>
                  </div>
                </div>
                <p class="form-hint" style="margin-top:4px;">{{ $t('image.manual.refNote') }}</p>
              </div>
            </div>
            <p v-else class="form-hint" style="margin-top:0;">{{ $t('image.manual.refNotSupported') }}</p>

            <div class="form-actions">
              <AgaButton
                variant="primary"
                size="lg"
                :loading="isGenerating"
                :disabled="!selectedNpc || manualFlowStage === 'submitting'"
                @click="handleGenerate"
              >
                {{ isGenerating ? $t('image.manual.generating') : backgroundMode ? $t('image.manual.addToQueue') : $t('image.manual.generateNow', { comp: compositionOptions.find(o => o.value === composition)?.label ?? '' }) }}
              </AgaButton>
              <div v-if="manualStatusText && manualFlowStage === 'idle'" class="status-text">{{ manualStatusText }}</div>
            </div>

            <!-- Per-NPC task status (最近状態 + active task display) -->
            <div v-if="selectedNpcActiveTask" class="npc-task-status npc-task-status--active">
              <div class="task-status-header">
                <span :class="['task-status-badge', `task-status-badge--${taskStatusVariant(selectedNpcActiveTask.status)}`]">
                  {{ taskStatusLabel(selectedNpcActiveTask.status) }}
                </span>
                <span class="task-status-time">{{ new Date(selectedNpcActiveTask.updatedAt).toLocaleTimeString() }}</span>
              </div>
              <div class="task-status-progress">{{ $t('image.manual.taskProcessing') }}</div>
            </div>
            <div v-else-if="selectedNpcLastResult" :class="['npc-task-status', `npc-task-status--${selectedNpcLastResult.status}`]">
              <div class="task-status-header">
                <span :class="['task-status-badge', `task-status-badge--${taskStatusVariant(selectedNpcLastResult.status)}`]">
                  {{ taskStatusLabel(selectedNpcLastResult.status) }}
                </span>
                <span class="task-status-time">{{ new Date(selectedNpcLastResult.updatedAt).toLocaleTimeString() }}</span>
              </div>
              <div v-if="selectedNpcLastResult.error" class="task-status-error">{{ selectedNpcLastResult.error }}</div>
            </div>

            <div class="gen-nav-buttons">
              <AgaButton variant="ghost" size="sm" @click="activeTab = 'queue'">{{ $t('image.manual.viewQueue') }}</AgaButton>
              <AgaButton variant="ghost" size="sm" @click="activeTab = 'gallery'">{{ $t('image.manual.viewGallery') }}</AgaButton>
            </div>

            <div v-if="errorMsg" class="gen-error">{{ errorMsg }}</div>

            <!-- Secret part generation (NSFW gated, non-male NPC) -->
            <div
              v-if="selectedNpcData && !(selectedNpcData['性别'] && String(selectedNpcData['性别']).includes('男')) && get('系统.nsfwMode') === true"
              class="secret-section"
            >
              <CivitaiLoraShelf
                v-if="backend === 'civitai'"
                mode="compact"
                scope="secret_part"
                :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
              />
              <div class="secret-header-row">
                <div>
                  <h4 class="secret-title">{{ $t('image.manual.secretTitle') }}</h4>
                  <p class="secret-desc">{{ $t('image.manual.secretDesc') }}</p>
                </div>
                <button
                  type="button"
                  class="secret-all-btn"
                  :disabled="!!secretBusy"
                  @click="generateAllSecretParts"
                >{{ secretBusy === 'all' ? $t('image.manual.secretGenerating') : $t('image.manual.secretGenerateAll') }}</button>
              </div>

              <!-- Independent config: style + resolution -->
              <div class="secret-config-grid">
                <div class="form-section">
                  <label class="form-label">{{ $t('image.manual.artStyleLabel') }}</label>
                  <div class="btn-grid btn-grid--5">
                    <button v-for="opt in styleOptions" :key="opt.value" type="button"
                      :class="['grid-btn grid-btn--compact grid-btn--fuchsia', { 'grid-btn--fuchsia-active': secretStyle === opt.value }]"
                      @click="secretStyle = opt.value"
                    ><div class="grid-btn__label">{{ opt.label }}</div></button>
                  </div>
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.manual.sizeLabel') }}</label>
                  <div class="btn-grid btn-grid--5">
                    <button v-for="opt in secretSizeOptions" :key="opt.value" type="button"
                      :class="['grid-btn grid-btn--compact grid-btn--fuchsia', { 'grid-btn--fuchsia-active': secretSizePreset === opt.value }]"
                      @click="secretSizePreset = opt.value"
                    ><div class="grid-btn__label">{{ opt.label }}</div></button>
                  </div>
                </div>
              </div>

              <!-- Presets + extra -->
              <div class="secret-config-grid">
                <div class="form-section">
                  <label class="form-label">{{ $t('image.manual.artistPreset') }}</label>
                  <AgaSelect :options="[{ label: $t('image.manual.noPreset'), value: '' }, ...npcArtistPresets.map(p => ({ label: p.name, value: p.id }))]" v-model="secretArtistPreset" />
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.manual.pngPreset') }}</label>
                  <AgaSelect :options="pngPresetOptions" v-model="secretPngPreset" />
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.manual.extraPrompt') }}</label>
                  <textarea v-model="secretExtraPrompt" class="form-textarea form-textarea--fuchsia" rows="2" :placeholder="$t('image.manual.extraPromptPlaceholder')" />
                </div>
              </div>

              <div v-if="secretStatusText" class="secret-status">{{ secretStatusText }}</div>

              <!-- 3 body part cards — each card shows the latest secret-part
                   image for that body part from the NPC archive (香闺秘档). -->
              <div class="secret-cards">
                <div v-for="part in secretParts" :key="part.key" class="secret-card">
                  <div class="secret-card-header">
                    <span class="secret-card-label">{{ part.label }}</span>
                    <button type="button" class="secret-card-btn" :disabled="!!secretBusy" @click="generateSecretPart(part.key)">
                      {{ secretBusy === part.key ? $t('image.manual.secretGenerating') : $t('image.manual.secretGenerate') }}
                    </button>
                    <button
                      v-if="getSecretPartAssetId(part.key) && backendSupportsImg2Img"
                      type="button" class="secret-card-btn" style="font-size:0.7rem;"
                      :disabled="!!secretBusy"
                      @click="generateSecretPartWithReference(part.key)"
                    >{{ $t('image.manual.secretRefRedraw') }}</button>
                  </div>
                  <div
                    class="secret-card-image"
                    :class="{ 'secret-card-image--has-img': getSecretPartAssetId(part.key) }"
                    @click="getSecretPartAssetId(part.key) && openViewer(getSecretPartAssetId(part.key)!)"
                  >
                    <template v-if="getSecretPartAssetId(part.key)">
                      <ImageDisplay
                        :asset-id="getSecretPartAssetId(part.key)!"
                        :fallback-letter="part.label.charAt(0)"
                        size="lg"
                        class="secret-card-img"
                      />
                    </template>
                    <div v-else class="secret-card-placeholder">{{ $t('image.manual.secretNoImage') }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Legacy preview column removed — preview lives in NPC 预览面板 below -->
        </div>

        <!-- NPC 预览面板（全宽，图片+角色资料） -->
        <div v-if="selectedNpcData" class="npc-preview-panel">
          <div class="npc-preview-image-col">
            <div class="npc-preview-header">
              <span class="npc-preview-title">{{ $t('image.manual.previewTitle') }}</span>
              <button v-if="lastTask?.resultAssetId" type="button" class="npc-preview-link" @click="activeTab = 'gallery'">{{ $t('image.manual.viewGallery') }}</button>
            </div>
            <div class="npc-preview-image-area">
              <div v-if="lastTask?.resultAssetId" class="npc-preview-image-wrap" @click="openViewer(lastTask.resultAssetId!)">
                <!-- `fill` variant expands to the container — previously `lg`
                     forced an 80×80 square that looked tiny in the panel. -->
                <ImageDisplay :asset-id="lastTask.resultAssetId" fallback-letter="?" size="fill" />
              </div>
              <div v-else class="npc-preview-empty">
                <div class="npc-preview-empty-icon">
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="4" y="8" width="40" height="32" rx="4" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
                    <circle cx="16" cy="20" r="3" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
                    <path d="M4 32 l12-10 6 5 8-8 14 13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.4"/>
                  </svg>
                </div>
                <div>{{ $t('image.manual.previewEmpty') }}</div>
              </div>
            </div>
          </div>
          <div class="npc-preview-data-col">
            <div class="npc-preview-header">
              <span class="npc-preview-title">{{ $t('image.manual.npcDataTitle') }}</span>
            </div>
            <div class="npc-preview-data">
              <!--
                角色资料 grid — 增量接口说明：
                后续此区域应扩展显示：
                - 境界/身份（如 pack schema 支持）
                - 外貌特征 grid（外貌/身材/衣着/生日/称呼）
                - 共同记忆时间线
                - 关系驱动面板（核心性格、突破条件、女性关系网）
                当前保持基础信息 + 全文描述，预留结构。
              -->
              <div class="npc-preview-grid">
                <div><div class="npc-meta-label">{{ $t('image.npcMeta.name') }}</div><div class="npc-meta-value">{{ selectedNpcData['名称'] ?? $t('image.npcMeta.unknown') }}</div></div>
                <div><div class="npc-meta-label">{{ $t('image.npcMeta.gender') }}</div><div class="npc-meta-value">{{ selectedNpcData['性别'] ?? $t('image.npcMeta.unknown') }}</div></div>
                <div v-if="selectedNpcData['年龄']"><div class="npc-meta-label">{{ $t('image.npcMeta.age') }}</div><div class="npc-meta-value">{{ $t('image.npcMeta.ageSuffix', { age: selectedNpcData['年龄'] }) }}</div></div>
                <div v-if="selectedNpcData['与玩家关系']"><div class="npc-meta-label">{{ $t('image.npcMeta.relationship') }}</div><div class="npc-meta-value">{{ selectedNpcData['与玩家关系'] }}</div></div>
                <div v-if="selectedNpcData['位置']"><div class="npc-meta-label">{{ $t('image.npcMeta.location') }}</div><div class="npc-meta-value">{{ selectedNpcData['位置'] }}</div></div>
                <div v-if="selectedNpcData['类型']"><div class="npc-meta-label">{{ $t('image.npcMeta.roleType') }}</div><div class="npc-meta-value">{{ selectedNpcData['类型'] }}</div></div>
              </div>
              <div class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.characterSetting') }}</div>
                <div class="npc-preview-desc">{{ selectedNpcData['描述'] || selectedNpcData['外貌描述'] || $t('image.npcMeta.noData') }}</div>
              </div>
              <div v-if="selectedNpcData['外貌描述'] && selectedNpcData['描述']" class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.appearance') }}</div>
                <div class="npc-preview-desc">{{ selectedNpcData['外貌描述'] }}</div>
              </div>
              <div v-if="selectedNpcData['身材描写']" class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.body') }}</div>
                <div class="npc-preview-desc">{{ selectedNpcData['身材描写'] }}</div>
              </div>
              <div v-if="selectedNpcData['衣着风格']" class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.outfit') }}</div>
                <div class="npc-preview-desc">{{ selectedNpcData['衣着风格'] }}</div>
              </div>
              <div v-if="Array.isArray(selectedNpcData['性格特征']) && (selectedNpcData['性格特征'] as string[]).length" class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.personality') }}</div>
                <div class="npc-preview-traits">
                  <span v-for="trait in (selectedNpcData['性格特征'] as string[])" :key="trait" class="npc-preview-trait">{{ trait }}</span>
                </div>
              </div>
              <div v-if="selectedNpcData['背景']" class="npc-preview-desc-section">
                <div class="npc-meta-label">{{ $t('image.npcMeta.background') }}</div>
                <div class="npc-preview-desc">{{ selectedNpcData['背景'] }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ Gallery Tab ═══ -->
      <div v-if="activeTab === 'gallery'" class="tab-content">
        <div class="gallery-layout">
          <!-- Left: NPC list -->
          <div class="gallery-npc-list">
            <button
              v-for="npc in npcsWithImages"
              :key="String(npc['名称'])"
              :class="['gallery-npc-btn', { 'gallery-npc-btn--active': galleryNpc === String(npc['名称']) }]"
              @click="galleryNpc = String(npc['名称'])"
            >
              <span class="gallery-npc-name">{{ String(npc['名称']) === '__player__' ? (playerName ?? $t('image.scene.playerFallback')) : npc['名称'] }}</span>
              <span class="gallery-npc-count">{{ getArchiveHistory(npc).length }}</span>
            </button>
            <div v-if="npcsWithImages.length === 0" class="gallery-empty-list">
              <p>{{ $t('image.gallery.noImages') }}</p>
              <AgaButton variant="secondary" size="sm" @click="activeTab = 'manual'">{{ $t('image.gallery.goGenerate') }}</AgaButton>
            </div>
          </div>

          <!-- Right: Image grid -->
          <div class="gallery-grid-area">
            <div v-if="galleryNpc" class="gallery-header">
              <div class="gallery-header-left">
                <h3>{{ galleryNpc }}</h3>
                <div class="gallery-header-badges">
                  <span class="gallery-info-badge">{{ galleryNpcData?.['性别'] || $t('image.gallery.unknownGender') }}</span>
                  <span class="gallery-info-badge">{{ galleryNpcData?.['是否主要角色'] ? $t('image.gallery.majorRole') : $t('image.gallery.minorRole') }}</span>
                  <span class="gallery-info-badge gallery-info-badge--count">{{ $t('image.gallery.imageCount', { n: galleryImages.length }) }}</span>
                </div>
              </div>
              <div class="gallery-header-actions">
                <AgaButton variant="ghost" size="sm" @click="selectedNpc = galleryNpc; activeTab = 'manual'">{{ $t('image.gallery.goGenerateImages') }}</AgaButton>
                <AgaButton v-if="galleryImages.length > 0" variant="danger" size="sm" @click="clearNpcImages()">{{ $t('image.gallery.clearRecords') }}</AgaButton>
              </div>
            </div>

            <div v-if="galleryImages.length > 0" class="gallery-grid">
              <div v-for="img in galleryImages" :key="img.id" class="gallery-card">
                <!-- native title= (not the glass Tooltip): the bubble would be clipped by .gallery-card overflow:hidden -->
                <div class="gallery-card-image" :title="$t('image.gallery.clickViewLarge')" @click="openViewer(img.id)" style="cursor:pointer">
                  <ImageDisplay :asset-id="img.id" :fallback-letter="galleryNpc?.charAt(0) ?? '?'" size="lg" />
                  <!-- Overlay badges: status + usage (stacked, top-left) -->
                  <div class="gallery-overlay-badges">
                    <span :class="['gallery-status-badge', `gallery-status-badge--${img.status ?? 'complete'}`]">
                      {{ img.status === 'failed' ? $t('image.queue.status.failed') : img.status === 'generating' || img.status === 'tokenizing' ? $t('image.queue.status.generating') : img.status === 'pending' ? $t('image.queue.status.pending') : $t('image.queue.status.complete') }}
                    </span>
                    <span v-if="isCurrentAvatar(img.id)" class="gallery-usage-badge">{{ $t('image.gallery.usageBadge.avatar') }}</span>
                    <span v-if="isCurrentPortrait(img.id)" class="gallery-usage-badge">{{ $t('image.gallery.usageBadge.portrait') }}</span>
                    <span v-if="isCurrentBackground(img.id)" class="gallery-usage-badge">{{ $t('image.gallery.usageBadge.background') }}</span>
                    <span v-if="currentWallpaperId === img.id" class="gallery-usage-badge">{{ $t('image.gallery.usageBadge.wallpaper') }}</span>
                    <span v-if="isCurrentSecretPart(img.id, 'breast')" class="gallery-usage-badge gallery-usage-badge--secret">{{ $t('image.gallery.usageBadge.secretBreast') }}</span>
                    <span v-if="isCurrentSecretPart(img.id, 'vagina')" class="gallery-usage-badge gallery-usage-badge--secret">{{ $t('image.gallery.usageBadge.secretVagina') }}</span>
                    <span v-if="isCurrentSecretPart(img.id, 'anus')" class="gallery-usage-badge gallery-usage-badge--secret">{{ $t('image.gallery.usageBadge.secretAnus') }}</span>
                    <span v-if="img.providerMeta?.reference" class="gallery-usage-badge gallery-usage-badge--ref">{{ $t('image.gallery.usageBadge.reference') }}</span>
                  </div>
                </div>
                <div class="gallery-card-meta">
                  <div class="gallery-meta-top">
                    <span class="gallery-meta-comp">{{ img.composition || $t('image.gallery.metaComp.character') }}</span>
                    <span class="gallery-meta-time">{{ new Date(img.createdAt).toLocaleString() }}</span>
                  </div>
                  <div class="gallery-meta-grid">
                    <div class="gallery-meta-cell gallery-meta-cell--wide" :title="modelCellText(img)">
                      <div class="gallery-meta-label">{{ $t('image.gallery.metaLabel.model') }}</div>
                      <div class="gallery-meta-value">{{ modelCellText(img) }}</div>
                    </div>
                    <div v-if="apiConfigLabel(img)" class="gallery-meta-cell gallery-meta-cell--wide" :title="apiConfigLabel(img)">
                      <div class="gallery-meta-label">{{ $t('image.gallery.metaLabel.apiConfig') }}</div>
                      <div class="gallery-meta-value">{{ apiConfigLabel(img) }}</div>
                    </div>
                  </div>
                  <div v-if="img.providerMeta?.reference" class="gallery-meta-grid" style="margin-top:4px;">
                    <div class="gallery-meta-cell">
                      <div class="gallery-meta-label">{{ $t('image.gallery.metaLabel.refMode') }}</div>
                      <div class="gallery-meta-value">{{ img.providerMeta.reference.mode }}</div>
                    </div>
                    <div v-if="img.providerMeta.reference.denoiseStrength != null" class="gallery-meta-cell">
                      <div class="gallery-meta-label">{{ $t('image.gallery.metaLabel.redrawStrength') }}</div>
                      <div class="gallery-meta-value">{{ img.providerMeta.reference.denoiseStrength }}</div>
                    </div>
                  </div>
                  <div v-if="img.positivePrompt || img.negativePrompt" class="gallery-card-prompts">
                    <details v-if="img.positivePrompt" class="prompt-details">
                      <summary>{{ $t('image.gallery.promptSummary.positive') }}</summary>
                      <pre class="prompt-text">{{ img.positivePrompt }}</pre>
                    </details>
                    <details v-if="img.negativePrompt" class="prompt-details">
                      <summary>{{ $t('image.gallery.promptSummary.negative') }}</summary>
                      <pre class="prompt-text">{{ img.negativePrompt }}</pre>
                    </details>
                  </div>
                </div>
                <div class="gallery-card-actions">
                  <!-- Row 1: selection actions.
                       Cancel buttons are gated only on "is current selection"
                       so the user can always un-bind the current avatar/立绘/
                       background regardless of its composition. Set buttons
                       defer to canSelect*() but are now composition-lax so a
                       同款 regen with any composition can be bound directly. -->
                  <div class="gallery-actions-row">
                    <AgaButton
                      v-if="canSelectAvatar(img) && !isCurrentAvatar(img.id)"
                      variant="secondary" size="sm"
                      @click="setAsAvatar(img.id)"
                    >{{ $t('image.gallery.action.setAvatar') }}</AgaButton>
                    <AgaButton
                      v-if="isCurrentAvatar(img.id)"
                      variant="ghost" size="sm"
                      @click="clearAvatar()"
                    >{{ $t('image.gallery.action.cancelAvatar') }}</AgaButton>
                    <AgaButton
                      v-if="canSelectPortrait(img) && !isCurrentPortrait(img.id)"
                      variant="secondary" size="sm"
                      @click="setAsPortrait(img.id)"
                    >{{ $t('image.gallery.action.setPortrait') }}</AgaButton>
                    <AgaButton
                      v-if="isCurrentPortrait(img.id)"
                      variant="ghost" size="sm"
                      @click="clearPortrait()"
                    >{{ $t('image.gallery.action.cancelPortrait') }}</AgaButton>
                    <AgaButton
                      v-if="canSelectBackground(img) && !isCurrentBackground(img.id)"
                      variant="secondary" size="sm"
                      @click="setAsBackground(img.id)"
                    >{{ $t('image.gallery.action.setBackground') }}</AgaButton>
                    <AgaButton
                      v-if="isCurrentBackground(img.id)"
                      variant="ghost" size="sm"
                      @click="clearBackground()"
                    >{{ $t('image.gallery.action.cancelBackground') }}</AgaButton>
                  </div>
                  <!-- Row 1.5: secret part binding (NSFW + non-male gated) -->
                  <div v-if="canSelectSecretPart(img)" class="gallery-actions-row">
                    <AgaButton v-if="!isCurrentSecretPart(img.id, 'breast')" variant="secondary" size="sm" @click="setAsSecretPart(img.id, 'breast')">{{ $t('image.gallery.action.setSecretBreast') }}</AgaButton>
                    <AgaButton v-else variant="ghost" size="sm" @click="clearSecretPart('breast')">{{ $t('image.gallery.action.cancelSecretBreast') }}</AgaButton>
                    <AgaButton v-if="!isCurrentSecretPart(img.id, 'vagina')" variant="secondary" size="sm" @click="setAsSecretPart(img.id, 'vagina')">{{ $t('image.gallery.action.setSecretVagina') }}</AgaButton>
                    <AgaButton v-else variant="ghost" size="sm" @click="clearSecretPart('vagina')">{{ $t('image.gallery.action.cancelSecretVagina') }}</AgaButton>
                    <AgaButton v-if="!isCurrentSecretPart(img.id, 'anus')" variant="secondary" size="sm" @click="setAsSecretPart(img.id, 'anus')">{{ $t('image.gallery.action.setSecretAnus') }}</AgaButton>
                    <AgaButton v-else variant="ghost" size="sm" @click="clearSecretPart('anus')">{{ $t('image.gallery.action.cancelSecretAnus') }}</AgaButton>
                  </div>
                  <!-- Row 2: utility actions -->
                  <div class="gallery-actions-row">
                    <AgaButton
                      v-if="img.positivePrompt"
                      variant="secondary" size="sm"
                      @click="openRegenerateFromGalleryImage(galleryNpc, img)"
                    >{{ $t('image.gallery.action.regenSame') }}</AgaButton>
                    <AgaButton
                      v-if="img.positivePrompt && backendSupportsImg2Img"
                      variant="secondary" size="sm"
                      @click="openRegenerateFromGalleryImage(galleryNpc, img, true)"
                    >{{ $t('image.gallery.action.refRedraw') }}</AgaButton>
                    <AgaButton v-if="img.status !== 'failed'" variant="ghost" size="sm" @click="analyzeImageFromCard(img.id)">{{ $t('image.gallery.action.analyzeStyle') }}</AgaButton>
                    <AgaButton v-if="img.status !== 'failed'" variant="ghost" size="sm" @click="saveAsReferenceMaterial(img.id, 'gallery', galleryNpc)">{{ $t('image.gallery.action.saveAsRef') }}</AgaButton>
                    <AgaButton
                      v-if="img.status === 'complete' && !isPersistentWallpaper(img.id)"
                      variant="ghost" size="sm"
                      @click="setPersistentWallpaper(img.id)"
                    >{{ $t('image.gallery.action.setPersistentWallpaper') }}</AgaButton>
                    <AgaButton
                      v-if="img.status === 'complete' && isPersistentWallpaper(img.id)"
                      variant="ghost" size="sm"
                      @click="clearPersistentWallpaper()"
                    >{{ $t('image.gallery.action.cancelPersistentWallpaper') }}</AgaButton>
                    <AgaButton variant="ghost" size="sm" @click="saveToLocal(img.id)">{{ $t('image.gallery.action.saveLocal') }}</AgaButton>
                    <AgaButton variant="danger" size="sm" @click="requestDelete(img.id)">{{ $t('image.gallery.action.deleteImage') }}</AgaButton>
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="galleryNpc" class="tab-placeholder">
              <p>{{ $t('image.gallery.noImagesYet', { name: galleryNpc }) }}</p>
              <AgaButton variant="secondary" size="sm" @click="selectedNpc = galleryNpc; activeTab = 'manual'">{{ $t('image.gallery.goGenerate') }}</AgaButton>
            </div>

            <div v-else class="tab-placeholder">
              <p>{{ $t('image.gallery.selectNpc') }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ Scene Tab ═══ -->
      <div v-if="activeTab === 'scene'" class="tab-content">
        <div class="backend-status-bar">
          <span :class="['status-dot', activeBackendStatus.configured ? 'status-dot--ok' : 'status-dot--off']" />
          <span class="backend-status-label">{{ activeBackendStatus.label }}</span>
          <span v-if="activeBackendStatus.model" class="backend-status-model">{{ activeBackendStatus.model }}</span>
          <span v-if="!activeBackendStatus.configured" class="backend-status-warn">{{ $t('image.scene.notConfigured') }}</span>
        </div>
        <CivitaiLoraShelf
          v-if="backend === 'civitai'"
          mode="compact"
          scope="scene"
          :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
        />
        <div class="scene-layout-v2">
          <!-- Left column: wallpaper + stats + controls -->
          <div class="scene-left-col">
            <!-- Current wallpaper -->
            <div class="scene-section">
              <h3 class="section-label">{{ $t('image.scene.currentWallpaper') }}</h3>
              <div v-if="currentSceneWallpaperId" class="wallpaper-card" :title="$t('image.gallery.clickViewLarge')" @click="openViewer(currentSceneWallpaperId)">
                <ImageDisplay :asset-id="currentSceneWallpaperId" fallback-letter="S" size="lg" />
                <span class="wallpaper-badge">{{ $t('image.scene.currentlyUsed') }}</span>
              </div>
              <div v-else class="wallpaper-placeholder">
                <p>{{ $t('image.scene.noWallpaper') }}</p>
                <p class="form-hint">{{ $t('image.scene.noWallpaperHint') }}</p>
              </div>
            </div>

            <!-- Scene stats (6 stat cards) -->
            <div class="scene-section">
              <h3 class="section-label">{{ $t('image.scene.statsTitle') }}</h3>
              <div class="scene-stats-grid">
                <div class="stat-card"><span class="stat-value">{{ sceneStats.total }}</span><span class="stat-label">{{ $t('image.scene.statsTotalImages') }}</span></div>
                <div class="stat-card stat-card--success"><span class="stat-value">{{ sceneStats.success }}</span><span class="stat-label">{{ $t('image.scene.statsSuccess') }}</span></div>
                <div class="stat-card stat-card--danger"><span class="stat-value">{{ sceneStats.failed }}</span><span class="stat-label">{{ $t('image.scene.statsFailed') }}</span></div>
                <div class="stat-card stat-card--warning"><span class="stat-value">{{ sceneStats.pending }}</span><span class="stat-label">{{ $t('image.scene.statsGenerating') }}</span></div>
                <div class="stat-card stat-card--info"><span class="stat-value">{{ sceneStats.queueTotal }}</span><span class="stat-label">{{ $t('image.scene.statsQueueTotal') }}</span></div>
                <div class="stat-card stat-card--info"><span class="stat-value">{{ sceneStats.queueRunning }}</span><span class="stat-label">{{ $t('image.scene.statsQueueRunning') }}</span></div>
              </div>
            </div>

            <!-- Scene history limit -->
            <div class="scene-section">
              <h3 class="section-label">{{ $t('image.scene.historyLimitTitle') }}</h3>
              <p class="form-hint">{{ $t('image.scene.historyLimitHint', { current: sceneStats.total, limit: sceneArchiveLimit }) }}</p>
              <div class="scene-limit-row">
                <input v-model="sceneArchiveLimitDraft" type="number" min="1" max="100" class="form-input scene-limit-input" />
                <AgaButton variant="secondary" size="sm" @click="saveSceneArchiveLimit">{{ $t('image.scene.applyLimit') }}</AgaButton>
              </div>
            </div>

            <!-- Scene composition requirement -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.compositionLabel') }}</label>
              <div class="btn-grid btn-grid--2">
                <button
                  v-for="mode in (['snapshot', 'landscape'] as const)"
                  :key="mode"
                  type="button"
                  :class="['grid-btn grid-btn--compact', { 'grid-btn--active': sceneComposition === mode }]"
                  @click="sceneComposition = mode"
                >
                  <div class="grid-btn__label">{{ mode === 'snapshot' ? $t('image.scene.modeSnapshot') : $t('image.scene.modeLandscape') }}</div>
                </button>
              </div>
              <p class="form-hint">{{ $t('image.scene.compositionHint') }}</p>
            </div>

            <!-- Round/narrative selection -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.narrativeSource') }}</label>
              <p class="form-hint">{{ $t('image.scene.narrativeSourceHint') }}</p>
              <div v-if="recentRounds.length === 0" class="form-hint" style="opacity:0.5">{{ $t('image.scene.noRounds') }}</div>
              <div v-else class="round-selector">
                <div
                  v-for="round in recentRounds"
                  :key="round.originalIndex"
                  :class="['round-selector__item', { 'round-selector__item--selected': selectedRoundKeys.has(round.originalIndex) }]"
                  @click="toggleRound(round.originalIndex)"
                >
                  <span class="round-selector__check">{{ selectedRoundKeys.has(round.originalIndex) ? '☑' : '☐' }}</span>
                  <span class="round-selector__label">{{ $t('image.scene.roundLabel', { n: round.roundNumber }) }}</span>
                  <span class="round-selector__preview">{{ round.preview }}</span>
                </div>
              </div>
            </div>

            <!-- NPC selection -->
            <div class="scene-section">
              <div class="npc-selector__header">
                <label class="form-label">{{ $t('image.scene.npcParticipants') }}</label>
                <span class="npc-selector__actions">
                  <button type="button" class="npc-selector__link" @click="selectAllNpcs">{{ $t('image.scene.selectAll') }}</button>
                  <button type="button" class="npc-selector__link" @click="deselectAllNpcs">{{ $t('image.scene.deselectAll') }}</button>
                </span>
              </div>
              <p class="form-hint">{{ $t('image.scene.npcParticipantsHint') }}</p>
              <div v-if="sceneNpcList.length === 0" class="form-hint" style="opacity:0.5">{{ $t('image.scene.noCharacters') }}</div>
              <div v-else class="npc-selector">
                <div
                  v-for="npc in sceneNpcList"
                  :key="npc.name"
                  :class="['npc-selector__item', { 'npc-selector__item--selected': selectedNpcNames.has(npc.name) }]"
                  @click="toggleNpc(npc.name)"
                >
                  <span class="npc-selector__check">{{ selectedNpcNames.has(npc.name) ? '☑' : '☐' }}</span>
                  <span class="npc-selector__name">{{ npc.name }}</span>
                  <span v-if="npc.isPlayer" class="npc-selector__badge npc-selector__badge--player">{{ $t('image.scene.playerBadge') }}</span>
                  <span v-else-if="npc.isPresent" class="npc-selector__badge">{{ $t('image.scene.presentBadge') }}</span>
                </div>
              </div>
            </div>

            <!-- Orientation -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.orientationLabel') }}</label>
              <div class="btn-grid btn-grid--2">
                <button
                  v-for="ori in (['landscape', 'portrait'] as const)"
                  :key="ori"
                  type="button"
                  :class="['grid-btn grid-btn--compact', { 'grid-btn--active': sceneOrientation === ori }]"
                  @click="sceneOrientation = ori"
                >
                  <div class="grid-btn__label">{{ ori === 'landscape' ? $t('image.scene.orientationLandscape') : $t('image.scene.orientationPortrait') }}</div>
                </button>
              </div>
            </div>

            <!-- Resolution -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.resolutionLabel') }}</label>
              <AgaSelect
                :options="sceneResolutionOptions"
                v-model="sceneResolution"
              />
              <input v-model="sceneResolution" type="text" class="form-input" style="margin-top:var(--space-2xs)" :placeholder="$t('image.scene.customResPlaceholder')" />
              <p class="form-hint">{{ $t('image.scene.currentResolution', { res: sceneResolution || $t('image.scene.notSelected') }) }}</p>
            </div>

            <!-- Extra requirements -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.extraRequirements') }}</label>
              <textarea v-model="sceneExtraPrompt" class="form-textarea" rows="3" :placeholder="$t('image.scene.extraPlaceholder')" />
            </div>

            <!-- Artist preset -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.artistPresetLabel') }}</label>
              <AgaSelect
                :options="[{ label: sceneScopedPresets.length > 0 ? $t('image.presets.notUsed') : $t('image.manual.noPreset'), value: '' }, ...sceneScopedPresets.map(p => ({ label: p.name, value: p.id }))]"
                v-model="selectedScenePreset"
              />
            </div>

            <!-- PNG preset -->
            <div class="scene-section">
              <label class="form-label">{{ $t('image.scene.pngPresetLabel') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.manual.anchor.none'), value: '' }, ...scenePngPresets.map(p => ({ label: p.name, value: p.id }))]"
                v-model="selectedScenePngPreset"
              />
            </div>

            <!-- Background mode toggle -->
            <div class="scene-section form-section--inline">
              <label class="form-label">{{ $t('image.manual.backgroundMode') }}</label>
              <AgaToggle v-model="backgroundMode" />
              <p class="form-hint">{{ $t('image.scene.bgModeHint') }}</p>
            </div>

            <!-- Scene reference redraw -->
            <div v-if="backendSupportsImg2Img" class="scene-section">
              <div class="form-section form-section--inline">
                <label class="form-label">{{ $t('image.scene.refComposition') }}</label>
                <AgaToggle v-model="sceneReferenceEnabled" data-testid="scene-ref-redraw-toggle" />
              </div>
              <div v-if="sceneReferenceEnabled" class="ref-controls">
                <!-- 多图后端（豆包）走多图选择器；其余后端保持单张控件 -->
                <MultiReferencePicker
                  v-if="backendSupportsMultiRef"
                  v-model="sceneReferenceItems"
                  :max="SEEDREAM_MAX_REFERENCE_IMAGES"
                  :quick-sources="sceneQuickSources"
                  testid="scene-multi-ref"
                  @add-files="onSceneMultiRefFiles"
                  @add-quick="onSceneQuickSource"
                />
                <template v-else>
                  <label class="form-label">{{ $t('image.scene.refSource') }}</label>
                  <AgaSelect
                    :options="[
                      { label: $t('image.scene.refUpload'), value: 'upload' },
                      { label: $t('image.scene.refWallpaper'), value: 'wallpaper' },
                    ]"
                    v-model="sceneReferenceSource"
                  />
                  <div v-if="sceneReferenceSource === 'upload'" style="margin-top:var(--space-xs);">
                    <label class="ref-upload-btn">
                      {{ sceneReferenceFile ? sceneReferenceFile.name : $t('image.scene.refSelectFile') }}
                      <input type="file" accept="image/*" style="display:none" @change="onSceneReferenceFileChange" />
                    </label>
                  </div>
                </template>
                <template v-if="backendSupportsRefStrength">
                  <label class="form-label" style="margin-top:var(--space-xs);">{{ $t('image.scene.refDenoiseLabel') }}</label>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="0.1" max="1" step="0.05" v-model.number="sceneReferenceDenoise" style="flex:1" data-testid="scene-ref-denoise-slider" />
                    <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ sceneReferenceDenoise.toFixed(2) }}</span>
                  </div>
                  <div class="ref-marks"><span>{{ $t('image.scene.refMarkNear') }}</span><span>{{ $t('image.scene.refMarkKeep') }}</span><span>{{ $t('image.scene.refMarkHeavy') }}</span></div>
                </template>
                <p v-else class="form-hint" style="margin-top:var(--space-xs);" data-testid="scene-ref-strength-unsupported">
                  {{ $t('image.reference.strengthUnsupported') }}
                </p>
                <div v-if="backend === 'novelai'" style="margin-top:6px;">
                  <label class="form-label">{{ $t('image.manual.refNoiseLabel') }}</label>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="0" max="1" step="0.05" v-model.number="sceneReferenceNoise" style="flex:1" />
                    <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ sceneReferenceNoise.toFixed(2) }}</span>
                  </div>
                </div>
                <p class="form-hint" style="margin-top:4px;">{{ $t('image.manual.refNote') }}</p>
              </div>
            </div>

            <!-- Status text -->
            <div v-if="sceneStatusText" class="scene-status-text">{{ sceneStatusText }}</div>

            <!-- Generate + clear buttons -->
            <div class="scene-form-actions">
              <AgaButton variant="primary" :loading="sceneGenerating" @click="generateScene">
                {{ sceneGenerating ? $t('image.scene.generatingBtn') : $t('image.scene.generateByNarrative') }}
              </AgaButton>
              <AgaButton variant="danger" size="sm" @click="clearSceneHistory">{{ $t('image.scene.clearHistory') }}</AgaButton>
            </div>

            <div v-if="sceneError" class="gen-error">{{ sceneError }}</div>
          </div>

          <!-- Right column: queue + history -->
          <div class="scene-right-col">
            <!-- Scene queue (max 30%) -->
            <div v-if="sceneQueueTasks.length > 0" class="scene-queue-section">
              <div class="scene-queue-header">
                <h3 class="section-label">{{ $t('image.scene.queueTitle') }}</h3>
                <div class="scene-queue-actions">
                  <AgaButton variant="ghost" size="sm" @click="clearSceneQueueCompleted">{{ $t('image.scene.clearCompleted') }}</AgaButton>
                  <AgaButton variant="danger" size="sm" @click="clearSceneQueueAll">{{ $t('image.scene.clearAll') }}</AgaButton>
                </div>
              </div>
              <div class="scene-queue-list">
                <div v-for="task in sceneQueueTasks" :key="task.id" class="scene-queue-card">
                  <div class="scene-queue-card-top">
                    <span class="scene-queue-summary">{{ task.positivePrompt?.slice(0, 40) || $t('image.scene.sceneFallback') }}</span>
                    <span :class="['task-badge', `task-badge--${task.status}`]">{{ taskStatusLabel(task.status) }}</span>
                  </div>
                  <div class="scene-queue-card-meta">{{ new Date(task.createdAt).toLocaleString() }}</div>
                </div>
              </div>
            </div>

            <!-- Scene history -->
            <div class="scene-history-section">
              <div class="scene-history-header">
                <h3 class="section-label">{{ $t('image.scene.historyTitle') }}</h3>
                <span class="scene-history-count">{{ $t('image.scene.recordCount', { n: sceneArchiveHistory.length }) }}</span>
              </div>
              <div v-if="sceneArchiveHistory.length > 0" class="scene-history-grid">
                <div
                  v-for="record in sceneArchiveHistory"
                  :key="String(record.id ?? record.createdAt)"
                  class="scene-history-card"
                >
                  <div class="scene-history-card-image" :title="$t('image.gallery.clickViewLarge')" @click="openViewer(String(record.id ?? ''))" style="cursor:pointer">
                    <ImageDisplay :asset-id="String(record.id ?? '')" fallback-letter="S" size="lg" />
                    <div class="gallery-overlay-badges">
                      <span :class="['gallery-status-badge', `gallery-status-badge--${record.status ?? 'complete'}`]">
                        {{ record.status === 'failed' ? $t('image.scene.statusFailed') : $t('image.scene.statusSuccess') }}
                      </span>
                      <span v-if="isCurrentSceneWallpaper(String(record.id ?? ''))" class="gallery-usage-badge">{{ $t('image.scene.currentWallpaperBadge') }}</span>
                    </div>
                  </div>
                  <div class="scene-history-card-body">
                    <div class="scene-history-card-top">
                      <span class="scene-history-card-time">{{ new Date(Number(record.createdAt) || 0).toLocaleString() }}</span>
                      <span v-if="(record as Record<string, unknown>).providerMeta && ((record as Record<string, unknown>).providerMeta as Record<string, unknown>)?.civitai" class="lora-badge">LoRA</span>
                    </div>
                    <!-- Expandable prompts -->
                    <details v-if="record.positivePrompt" class="prompt-details">
                      <summary>{{ $t('image.gallery.promptSummary.positive') }}</summary>
                      <pre class="prompt-text">{{ record.positivePrompt }}</pre>
                    </details>
                    <details v-if="record.negativePrompt" class="prompt-details">
                      <summary>{{ $t('image.gallery.promptSummary.negative') }}</summary>
                      <pre class="prompt-text">{{ record.negativePrompt }}</pre>
                    </details>
                    <!-- Action buttons -->
                    <div class="scene-history-card-actions">
                      <AgaButton
                        v-if="record.positivePrompt"
                        variant="secondary" size="sm"
                        @click="openRegenerateFromSceneRecord(record as Record<string, unknown>)"
                      >{{ $t('image.scene.action.regenSame') }}</AgaButton>
                      <AgaButton
                        v-if="record.positivePrompt && backendSupportsImg2Img"
                        variant="secondary" size="sm"
                        @click="openRegenerateFromSceneRecord(record as Record<string, unknown>, true)"
                      >{{ $t('image.scene.action.refRedraw') }}</AgaButton>
                      <AgaButton variant="ghost" size="sm" @click="analyzeImageFromCard(String(record.id ?? ''))">{{ $t('image.scene.action.analyzeStyle') }}</AgaButton>
                      <AgaButton variant="ghost" size="sm" @click="saveAsReferenceMaterial(String(record.id ?? ''), 'scene')">{{ $t('image.scene.action.saveAsRef') }}</AgaButton>
                      <AgaButton
                        v-if="!isCurrentSceneWallpaper(String(record.id ?? ''))"
                        variant="secondary" size="sm"
                        @click="applySceneWallpaper(String(record.id ?? ''))"
                      >{{ $t('image.scene.action.setWallpaper') }}</AgaButton>
                      <AgaButton
                        v-if="isCurrentSceneWallpaper(String(record.id ?? ''))"
                        variant="ghost" size="sm"
                        @click="clearSceneWallpaper()"
                      >{{ $t('image.scene.action.cancelWallpaper') }}</AgaButton>
                      <AgaButton
                        v-if="!isPersistentWallpaper(String(record.id ?? ''))"
                        variant="ghost" size="sm"
                        @click="setPersistentWallpaper(String(record.id ?? ''))"
                      >{{ $t('image.scene.action.setPersistentWallpaper') }}</AgaButton>
                      <AgaButton
                        v-if="isPersistentWallpaper(String(record.id ?? ''))"
                        variant="ghost" size="sm"
                        @click="clearPersistentWallpaper()"
                      >{{ $t('image.scene.action.cancelPersistentWallpaper') }}</AgaButton>
                      <AgaButton variant="ghost" size="sm" @click="saveToLocal(String(record.id ?? ''))">{{ $t('image.scene.action.saveLocal') }}</AgaButton>
                      <AgaButton variant="danger" size="sm" @click="deleteSceneImage(String(record.id ?? ''))">{{ $t('image.scene.action.deleteImage') }}</AgaButton>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="tab-placeholder">
                <p>{{ $t('image.scene.noHistory') }}</p>
                <p class="form-hint">{{ $t('image.scene.noHistoryHint') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ Queue Tab ═══ -->
      <div v-if="activeTab === 'queue'" class="tab-content">
        <div class="queue-header-v2">
          <div>
            <h3 class="section-label">{{ $t('image.queue.unifiedTitle') }}</h3>
            <p class="form-hint">{{ $t('image.queue.unifiedHint') }}</p>
          </div>
          <div class="queue-clear-buttons">
            <AgaButton variant="ghost" size="sm" @click="clearNpcQueueCompleted">{{ $t('image.queue.clearCompletedBtn') }}</AgaButton>
            <AgaButton variant="danger" size="sm" @click="clearNpcQueueAll">{{ $t('image.queue.clearAllBtn') }}</AgaButton>
            <AgaButton variant="ghost" size="sm" @click="clearSceneQueueCompleted">{{ $t('image.queue.clearCompletedBtn') }}</AgaButton>
            <AgaButton variant="danger" size="sm" @click="clearSceneQueueAll">{{ $t('image.queue.clearAllBtn') }}</AgaButton>
          </div>
        </div>

        <div v-if="recentTasks.length === 0" class="tab-placeholder">
          <p>{{ $t('image.queue.noTasks') }}</p>
          <p class="form-hint">{{ $t('image.queue.noTasksHint') }}</p>
        </div>
        <div v-else class="task-list-v2">
          <div v-for="task in recentTasks" :key="task.id" class="queue-card-v2">
            <!-- Type badge (top-right corner) -->
            <span class="queue-type-corner">{{ task.subjectType === 'scene' ? $t('image.queue.subjectScene') : $t('image.queue.subjectCharacter') }}</span>

            <!-- Header: name + status -->
            <div class="queue-card-header">
              <div class="queue-card-title">
                <div class="queue-card-name">{{ task.subjectType === 'scene' ? (task.positivePrompt?.slice(0, 30) || $t('image.queue.subjectScene')) : (task.targetCharacter ?? $t('image.lora.scope.character')) }}</div>
                <div class="queue-card-sub">
                  <span v-if="task.subjectType !== 'scene'">{{ task.subjectType === 'character' ? $t('image.queue.subjectTypeCharacter') : task.subjectType }}</span>
                  <span>{{ new Date(task.createdAt).toLocaleString() }}</span>
                </div>
              </div>
              <div class="queue-card-status-area">
                <span :class="['task-badge', `task-badge--${task.status}`]">{{ taskStatusLabel(task.status) }}</span>
                <span v-if="task.providerMeta?.civitai?.loras?.length" class="lora-badge">LoRA ×{{ task.providerMeta.civitai.loras.length }}</span>
                <AgaButton variant="ghost" size="sm" @click="removeTask(task.id)">{{ $t('image.queue.deleteBtn') }}</AgaButton>
              </div>
            </div>

            <!-- 4-card metadata grid -->
            <div class="queue-meta-grid">
              <div class="queue-meta-cell">
                <div class="queue-meta-label">{{ $t('image.queue.createdAt') }}</div>
                <div class="queue-meta-value">{{ new Date(task.createdAt).toLocaleString() }}</div>
              </div>
              <div class="queue-meta-cell">
                <div class="queue-meta-label">{{ $t('image.queue.updatedAt') }}</div>
                <div class="queue-meta-value">{{ new Date(task.updatedAt).toLocaleString() }}</div>
              </div>
              <div class="queue-meta-cell">
                <div class="queue-meta-label">{{ $t('image.regenerate.backendLabel') }}</div>
                <div class="queue-meta-value">{{ task.backend || $t('image.queue.backendUndecided') }}</div>
              </div>
              <div class="queue-meta-cell queue-meta-cell--progress">
                <div class="queue-meta-label">{{ $t('image.queue.taskProgress', { status: taskStatusLabel(task.status) }) }}</div>
                <div class="queue-meta-value">{{ task.error || taskStatusLabel(task.status) }}</div>
              </div>
            </div>

            <!-- Captured prompts (collapsible). Available as soon as the task
                 reaches `generating`; lets the user inspect what was actually
                 sent to the backend and kick off a same-prompt regeneration. -->
            <div v-if="task.positivePrompt || task.negativePrompt" class="queue-card-prompts">
              <details v-if="task.positivePrompt" class="prompt-details">
                <summary>{{ $t('image.gallery.promptSummary.positive') }}</summary>
                <pre class="prompt-text">{{ task.positivePrompt }}</pre>
              </details>
              <details v-if="task.negativePrompt" class="prompt-details">
                <summary>{{ $t('image.gallery.promptSummary.negative') }}</summary>
                <pre class="prompt-text">{{ task.negativePrompt }}</pre>
              </details>
            </div>

            <!-- Actions row: regenerate-same (only when prompts exist) + retry on failure -->
            <div class="queue-card-actions-row">
              <AgaButton
                v-if="task.positivePrompt"
                variant="secondary" size="sm"
                @click="openRegenerateFromTask(task)"
              >{{ $t('image.queue.action.regenPrompt') }}</AgaButton>
              <AgaButton
                v-if="task.status === 'complete' && task.resultAssetId && backendSupportsImg2Img"
                variant="secondary" size="sm"
                @click="openRegenerateFromTask(task, true)"
              >{{ $t('image.queue.action.refRedraw') }}</AgaButton>
              <AgaButton
                v-if="task.status === 'complete' && task.resultAssetId"
                variant="ghost" size="sm"
                @click="saveAsReferenceMaterial(task.resultAssetId, 'gallery')"
              >{{ $t('image.queue.action.saveAsRef') }}</AgaButton>
              <AgaButton
                v-if="task.status === 'failed' && task.subjectType !== 'scene' && task.targetCharacter"
                variant="ghost" size="sm"
                @click="openManualGenerateForRetry(task.targetCharacter!)"
              >{{ $t('image.queue.action.manualRetry') }}</AgaButton>
              <AgaButton
                v-if="task.status === 'failed'"
                variant="ghost" size="sm"
                @click="retryTask(task)"
              >{{ $t('image.queue.action.retryTask') }}</AgaButton>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ History Tab ═══ -->
      <div v-if="activeTab === 'history'" class="tab-content">
        <div class="history-header-v2">
          <div>
            <h3 class="section-label">{{ $t('image.history.allTitle') }}</h3>
          </div>
          <div class="history-header-actions">
            <AgaSelect :options="historyFilterOptions" v-model="historyFilter" :placeholder="$t('image.history.filterPlaceholder')" />
            <AgaButton variant="danger" size="sm" @click="clearAllNpcHistory">{{ $t('image.history.clearNpc') }}</AgaButton>
            <AgaButton variant="danger" size="sm" @click="clearAllSceneHistory">{{ $t('image.history.clearScene') }}</AgaButton>
          </div>
        </div>

        <div v-if="filteredHistory.length > 0" class="history-list-v2">
          <div v-for="entry in filteredHistory" :key="entry.key" class="history-card-v2">
            <!-- Left: image (1/3) -->
            <div
              class="history-card-image-v2"
              :class="entry.type === 'scene' ? 'history-card-image-v2--landscape' : ''"
              :title="$t('image.gallery.clickViewLarge')"
              @click="openViewer(entry.assetId)"
              style="cursor:pointer"
            >
              <ImageDisplay
                :asset-id="entry.assetId"
                :fallback-letter="entry.type === 'scene' ? 'S' : (entry.name?.charAt(0) ?? '?')"
                size="lg"
              />
              <div class="gallery-overlay-badges">
                <span :class="['gallery-status-badge', `gallery-status-badge--${entry.status}`]">
                  {{ entry.status === 'complete' ? $t('image.history.statusComplete') : entry.status === 'failed' ? $t('image.history.statusFailed') : $t('image.history.statusProcessing') }}
                </span>
                <span class="history-type-badge-v2">{{ entry.type === 'scene' ? $t('image.history.typeScene') : $t('image.history.typeCharacter') }}</span>
              </div>
            </div>

            <!-- Right: metadata (2/3) -->
            <div class="history-card-body-v2">
              <div class="history-card-title-row">
                <div>
                  <div class="history-card-name-v2">{{ entry.type === 'scene' ? $t('image.history.typeScene') : entry.name }}</div>
                  <div class="history-card-sub-v2">
                    <span v-if="entry.composition" class="history-comp-badge">{{ entry.composition }}</span>
                    <span v-if="entry.providerMeta?.civitai?.loras?.length" class="lora-badge">LoRA ×{{ entry.providerMeta.civitai.loras.length }}</span>
                    <span v-if="entry.providerMeta?.reference" class="lora-badge" style="color: var(--color-sage-400);">{{ $t('image.history.refBadge') }}</span>
                    <span>{{ new Date(entry.timestamp).toLocaleString() }}</span>
                  </div>
                </div>
                <AgaButton v-if="entry.type === 'character'" variant="danger" size="sm" @click="deleteNpcHistoryEntry(entry.name, entry.id)">{{ $t('image.history.action.deleteImage') }}</AgaButton>
                <AgaButton v-else variant="danger" size="sm" @click="deleteSceneImage(entry.id)">{{ $t('image.history.action.deleteImage') }}</AgaButton>
              </div>

              <!-- Metadata grid -->
              <div class="history-meta-grid-v2">
                <div class="history-meta-cell-v2 history-meta-cell-v2--wide">
                  <div class="history-meta-label-v2">{{ $t('image.history.metaLabel.model') }}</div>
                  <div class="history-meta-value-v2">{{ modelCellText(entry) }}</div>
                </div>
                <div v-if="apiConfigLabel(entry)" class="history-meta-cell-v2 history-meta-cell-v2--wide">
                  <div class="history-meta-label-v2">{{ $t('image.history.metaLabel.apiConfig') }}</div>
                  <div class="history-meta-value-v2">{{ apiConfigLabel(entry) }}</div>
                </div>
                <div class="history-meta-cell-v2">
                  <div class="history-meta-label-v2">{{ $t('image.history.metaLabel.artPref') }}</div>
                  <div class="history-meta-value-v2">{{ entry.artStyle || $t('image.history.metaLabel.none') }}</div>
                </div>
                <div v-if="entry.error" class="history-meta-cell-v2 history-meta-cell-v2--error" style="grid-column: span 2">
                  <div class="history-meta-value-v2">{{ entry.error }}</div>
                </div>
              </div>

              <!-- Expandable prompt details -->
              <div class="history-details-v2">
                <details v-if="entry.positivePrompt" class="prompt-details">
                  <summary>{{ $t('image.gallery.promptSummary.positive') }}</summary>
                  <pre class="prompt-text">{{ entry.positivePrompt }}</pre>
                </details>
                <details v-if="entry.negativePrompt" class="prompt-details">
                  <summary>{{ $t('image.gallery.promptSummary.negative') }}</summary>
                  <pre class="prompt-text">{{ entry.negativePrompt }}</pre>
                </details>
              </div>

              <!-- Action buttons -->
              <div class="history-actions-v2">
                <AgaButton v-if="entry.assetId" variant="ghost" size="sm" @click="openViewer(entry.assetId)">{{ $t('image.history.action.viewLarge') }}</AgaButton>
                <AgaButton
                  v-if="entry.positivePrompt"
                  variant="secondary" size="sm"
                  @click="openRegenerateFromHistoryEntry(entry)"
                >{{ $t('image.history.action.regenSame') }}</AgaButton>
                <AgaButton
                  v-if="entry.positivePrompt && entry.assetId && backendSupportsImg2Img"
                  variant="secondary" size="sm"
                  @click="openRegenerateFromHistoryEntry(entry, true)"
                >{{ $t('image.history.action.refRedraw') }}</AgaButton>
                <AgaButton v-if="entry.assetId" variant="ghost" size="sm" @click="analyzeImageFromCard(entry.assetId)">{{ $t('image.history.action.analyzeStyle') }}</AgaButton>
                <AgaButton v-if="entry.assetId" variant="ghost" size="sm" @click="saveAsReferenceMaterial(entry.assetId, entry.type === 'scene' ? 'scene' : 'gallery', entry.name)">{{ $t('image.history.action.saveAsRef') }}</AgaButton>
                <template v-if="entry.status === 'complete' && entry.assetId">
                  <AgaButton
                    v-if="entry.type === 'scene' && !isCurrentSceneWallpaper(entry.assetId)"
                    variant="ghost" size="sm"
                    @click="applySceneWallpaper(entry.assetId)"
                  >{{ $t('image.history.action.setWallpaper') }}</AgaButton>
                  <AgaButton
                    v-if="entry.type === 'scene' && isCurrentSceneWallpaper(entry.assetId)"
                    variant="ghost" size="sm"
                    @click="clearSceneWallpaper()"
                  >{{ $t('image.history.action.cancelWallpaper') }}</AgaButton>
                  <AgaButton
                    v-if="!isPersistentWallpaper(entry.assetId)"
                    variant="ghost" size="sm"
                    @click="setPersistentWallpaper(entry.assetId)"
                  >{{ $t('image.history.action.setPersistentWallpaper') }}</AgaButton>
                  <AgaButton
                    v-if="isPersistentWallpaper(entry.assetId)"
                    variant="ghost" size="sm"
                    @click="clearPersistentWallpaper()"
                  >{{ $t('image.history.action.cancelPersistentWallpaper') }}</AgaButton>
                  <AgaButton variant="ghost" size="sm" @click="saveToLocal(entry.assetId)">{{ $t('image.history.action.saveLocal') }}</AgaButton>
                </template>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="tab-placeholder">
          <p>{{ $t('image.history.noRecords') }}</p>
          <p class="form-hint">{{ $t('image.history.noRecordsHint') }}</p>
        </div>
      </div>

      <!-- ═══ Presets Tab ═══ -->
      <div v-if="activeTab === 'presets'" class="tab-content">
        <!-- Auto preset bindings (4 dropdowns in 2x2) -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.presets.badgeAuto') }}</span>
          <h3 class="section-label">{{ $t('image.presets.autoTitle') }}</h3>
          <p class="form-hint">{{ $t('image.presets.autoHint') }}</p>
          <div class="bindings-grid">
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.npcArtist') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.presets.notUsed'), value: '' }, ...artistPresets.filter(p => p.scope === 'npc').map(p => ({ label: p.name, value: p.id }))]"
                :model-value="String(get('系统.扩展.image.config.defaultNpcArtistPreset') ?? '')"
                @update:model-value="setValue('系统.扩展.image.config.defaultNpcArtistPreset', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.npcPng') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.presets.notUsed'), value: '' }, ...artistPresets.filter(p => p.scope === 'npc' && (p.id.startsWith('png_') || p.id.startsWith('img_'))).map(p => ({ label: p.name, value: p.id }))]"
                :model-value="String(get('系统.扩展.image.config.defaultNpcPngPreset') ?? '')"
                @update:model-value="setValue('系统.扩展.image.config.defaultNpcPngPreset', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.sceneArtist') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.presets.notUsed'), value: '' }, ...artistPresets.filter(p => p.scope === 'scene').map(p => ({ label: p.name, value: p.id }))]"
                :model-value="String(get('系统.扩展.image.config.defaultSceneArtistPreset') ?? '')"
                @update:model-value="setValue('系统.扩展.image.config.defaultSceneArtistPreset', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.scenePng') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.presets.notUsed'), value: '' }, ...artistPresets.filter(p => p.scope === 'scene' && (p.id.startsWith('png_') || p.id.startsWith('img_'))).map(p => ({ label: p.name, value: p.id }))]"
                :model-value="String(get('系统.扩展.image.config.defaultScenePngPreset') ?? '')"
                @update:model-value="setValue('系统.扩展.image.config.defaultScenePngPreset', $event)"
              />
            </div>
          </div>
        </div>

        <!-- Section: Character Anchor Management -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.presets.badgeAnchor') }}</span>
          <h3 class="section-label">{{ $t('image.presets.anchorTitle') }}</h3>
          <p class="form-hint">{{ $t('image.presets.anchorHint') }}</p>

          <div class="anchor-layout">
            <div class="anchor-list-col">
              <h4 class="form-label">{{ $t('image.presets.anchorList') }}</h4>
              <div class="anchor-list">
                <button
                  v-for="a in characterAnchors"
                  :key="a.id"
                  :class="['preset-item', { 'preset-item--active': selectedAnchorId === a.id }]"
                  @click="selectAnchor(a.id)"
                >
                  <span class="preset-item-name">{{ a.name }}</span>
                  <span class="form-hint">{{ a.npcName }}</span>
                  <span class="anchor-badges">
                    <span :class="a.enabled ? 'anchor-badge--on' : 'anchor-badge--off'">{{ a.enabled ? $t('image.presets.anchorEnabled') : $t('image.presets.anchorDisabled') }}</span>
                    <span v-if="a.sceneLink" class="anchor-badge--link">{{ $t('image.presets.anchorSceneLink') }}</span>
                  </span>
                  <span v-if="a.positive" class="preset-item-preview">{{ a.positive.slice(0, 60) }}</span>
                </button>
              </div>
              <div v-if="characterAnchors.length === 0" class="transformer-empty">
                <span class="form-hint">{{ $t('image.presets.anchorEmptyHint') }}</span>
              </div>
            </div>

            <div class="anchor-editor-col">
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.anchorBindNpc') }}</label>
                <AgaSelect
                  :options="npcOptions"
                  :model-value="editAnchorNpc"
                  @update:model-value="editAnchorNpc = $event"
                />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.anchorExtraReq') }}</label>
                <input v-model="anchorExtractRequirements" class="form-input" :placeholder="$t('image.presets.anchorExtraReqPlaceholder')" />
              </div>

              <div class="anchor-actions-row">
                <AgaButton variant="secondary" size="sm" :loading="anchorExtracting" @click="extractAnchor">{{ anchorExtracting ? $t('image.presets.anchorExtracting') : $t('image.presets.anchorExtractAI') }}</AgaButton>
                <AgaButton v-if="selectedAnchor" variant="primary" size="sm" @click="saveAnchor">{{ $t('image.presets.anchorSave') }}</AgaButton>
                <AgaButton v-if="selectedAnchor" variant="danger" size="sm" @click="deleteAnchor">{{ $t('image.presets.anchorDelete') }}</AgaButton>
              </div>

              <!-- Extract status message (3-state colored box) -->
              <div
                v-if="anchorExtractMessage"
                :class="['anchor-extract-msg',
                  anchorExtractStage === 'error' ? 'anchor-extract-msg--error' :
                  anchorExtractStage === 'done' ? 'anchor-extract-msg--done' :
                  'anchor-extract-msg--info'
                ]"
              >{{ anchorExtractMessage }}</div>

              <template v-if="selectedAnchor">
                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.anchorName') }}</label>
                  <input v-model="editAnchorName" class="form-input" />
                </div>

                <div class="anchor-toggles">
                  <div class="form-section form-section--inline">
                    <label class="form-label">{{ $t('image.presets.anchorEnable') }}</label>
                    <AgaToggle :model-value="selectedAnchor.enabled" @update:model-value="toggleAnchorProp('enabled', $event)" />
                  </div>
                  <span class="form-hint">{{ $t('image.presets.anchorEnableOff') }}</span>

                  <div class="form-section form-section--inline">
                    <label class="form-label">{{ $t('image.presets.anchorDefaultAppend') }}</label>
                    <AgaToggle :model-value="selectedAnchor.defaultAppend" @update:model-value="toggleAnchorProp('defaultAppend', $event)" />
                  </div>
                  <span class="form-hint">{{ $t('image.presets.anchorDefaultAppendHint') }}</span>

                  <div class="form-section form-section--inline">
                    <label class="form-label">{{ $t('image.presets.anchorSceneLinkLabel') }}</label>
                    <AgaToggle :model-value="selectedAnchor.sceneLink" @update:model-value="toggleAnchorProp('sceneLink', $event)" />
                  </div>
                  <span class="form-hint">{{ $t('image.presets.anchorSceneLinkHint') }}</span>
                </div>

                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.anchorPositivePrompt') }}</label>
                  <textarea v-model="editAnchorPositive" class="form-textarea" rows="4" :placeholder="$t('image.presets.anchorPositivePlaceholder')" />
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.anchorNegativePrompt') }}</label>
                  <textarea v-model="editAnchorNegative" class="form-textarea" rows="2" :placeholder="$t('image.presets.anchorNegativePlaceholder')" />
                </div>

                <div v-if="selectedAnchor.structuredFeatures && Object.keys(selectedAnchor.structuredFeatures).length > 0" class="form-section">
                  <label class="form-label">{{ $t('image.presets.anchorStructuredFeatures') }}</label>
                  <div class="anchor-features">
                    <div v-for="(val, key) in selectedAnchor.structuredFeatures" :key="key" class="anchor-feature-row">
                      <span class="form-label">{{ key }}</span>
                      <span class="form-hint">{{ val }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="selectedAnchor.source || selectedAnchor.model" class="anchor-status-card">
                  <span v-if="selectedAnchor.source" class="form-hint">{{ $t('image.presets.anchorSource', { source: selectedAnchor.source }) }}</span>
                  <span v-if="selectedAnchor.model" class="form-hint">{{ $t('image.presets.anchorModel', { model: selectedAnchor.model }) }}</span>
                  <span class="form-hint">{{ $t('image.presets.anchorBoundTo', { name: selectedAnchor.npcName }) }}</span>
                </div>
              </template>

              <div v-else-if="characterAnchors.length > 0" class="tab-placeholder" style="padding:var(--space-lg)">
                <p>{{ $t('image.presets.anchorSelectEdit') }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: 图片风格素材 (renamed from PNG画风预设 — R6) -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.presets.badgeStyleAssets') }}</span>
          <div class="preset-card-header">
            <div>
              <h3 class="section-label">{{ $t('image.presets.styleAssetsTitle') }}</h3>
              <p class="form-hint">{{ $t('image.presets.styleAssetsHint') }}</p>
            </div>
            <div class="preset-card-actions">
              <AgaButton variant="ghost" size="sm" @click="exportArtistPresets">{{ $t('image.presets.exportPresets') }}</AgaButton>
              <label class="png-import-btn">
                {{ $t('image.presets.importPresets') }}
                <input type="file" accept="application/json,.json" style="display:none" @change="importArtistPresets" />
              </label>
              <label class="png-import-btn">
                {{ $t('image.presets.importPng') }}
                <input type="file" accept="image/png" style="display:none" @change="importPng" />
              </label>
              <label class="png-import-btn">
                {{ $t('image.presets.importImageAnalyze') }}
                <input type="file" accept="image/png,image/jpeg,image/webp" style="display:none" data-testid="understanding-import-input" @change="importImageForUnderstanding" />
              </label>
            </div>
          </div>

          <!-- Understanding panel (A3-A5) -->
          <div v-if="understandingMode" class="understanding-panel">
            <div class="understanding-header">
              <div class="understanding-preview">
                <img v-if="understandingCoverDataUrl" :src="understandingCoverDataUrl" alt="preview" style="width:60px;height:42px;border-radius:4px;object-fit:cover" />
                <span v-else class="form-hint">{{ $t('image.presets.noPreview') }}</span>
              </div>
              <div>
                <span class="form-label">{{ understandingFile?.name ?? $t('image.presets.unknownFile') }}</span>
                <span class="form-hint">{{ understandingFile ? `${(understandingFile.size / 1024).toFixed(0)}KB` : '' }}</span>
              </div>
              <AgaButton variant="ghost" size="sm" @click="understandingMode = false">{{ $t('image.presets.close') }}</AgaButton>
            </div>

            <div class="understanding-controls">
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.engineLabel') }}</label>
                <AgaSelect
                  data-testid="understanding-engine-select"
                  :options="understandingEngineOptions"
                  v-model="understandingEngine"
                  :disabled="understandingNoEngine"
                />
                <span v-if="!understandingCivitaiAvailable && !understandingNoEngine" class="form-hint" data-testid="understanding-civitai-hint">{{ $t('image.presets.engineCivitaiNeedApi') }}</span>
                <span v-if="!understandingLlmInfo?.available && !understandingNoEngine" class="form-hint" data-testid="understanding-llm-hint">{{ $t('image.presets.engineLlmNeedConfig') }}</span>
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.analyzeMode') }}</label>
                <AgaSelect
                  :options="[
                    { label: $t('image.presets.analyzeTags'), value: 'tags' },
                    { label: $t('image.presets.analyzeCaption'), value: 'caption' },
                    { label: $t('image.presets.analyzeBoth'), value: 'both' },
                  ]"
                  v-model="understandingTask"
                />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.extraLabel') }}</label>
                <textarea
                  data-testid="understanding-extra-input"
                  v-model="understandingExtra"
                  class="form-textarea"
                  rows="3"
                  :placeholder="$t('image.presets.extraPlaceholder')"
                />
                <span class="form-hint">{{ $t('image.presets.extraHint') }}</span>
              </div>
              <p v-if="understandingNoEngine" class="form-hint" style="color: var(--color-error, #f87171);" data-testid="understanding-no-engine">{{ $t('image.presets.engineNoneAvailable') }}</p>
              <p v-else class="form-hint" style="color: var(--color-amber-400, #fbbf24);">{{ $t('image.presets.analyzeEngineNote') }}</p>
              <AgaButton data-testid="understanding-start-btn" variant="primary" size="sm" :loading="understandingLoading" :disabled="understandingNoEngine" @click="runUnderstanding">
                {{ understandingLoading ? $t('image.presets.analyzing') : $t('image.presets.startAnalyze') }}
              </AgaButton>
              <span v-if="understandingError" class="form-hint" style="color: var(--color-error, #f87171);">{{ understandingError }}</span>
            </div>

            <div v-if="understandingResult" class="understanding-result">
              <div v-if="understandingResult.tags?.length" class="form-section">
                <label class="form-label">{{ $t('image.presets.tagsLabel', { n: understandingResult.tags.length }) }}</label>
                <div class="understanding-tags">
                  <span v-for="tag in understandingResult.tags.slice(0, 30)" :key="tag.text" class="understanding-tag">
                    {{ tag.text }} <span v-if="tag.confidence" class="understanding-tag-conf">{{ (tag.confidence * 100).toFixed(0) }}%</span>
                  </span>
                </div>
              </div>
              <div v-if="understandingResult.caption" class="form-section">
                <label class="form-label">{{ $t('image.presets.captionLabel') }}</label>
                <p class="form-hint">{{ understandingResult.caption }}</p>
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.generatedPrompt') }}</label>
                <textarea v-model="understandingEditDraft" class="form-textarea" rows="4" />
              </div>
              <div class="understanding-save-row">
                <AgaButton variant="primary" size="sm" @click="saveUnderstandingAsPreset('npc')">{{ $t('image.presets.saveAsNpcStyle') }}</AgaButton>
                <AgaButton variant="secondary" size="sm" @click="saveUnderstandingAsPreset('scene')">{{ $t('image.presets.saveAsSceneStyle') }}</AgaButton>
              </div>
            </div>
          </div>

          <!-- Reference Library (P1-8) -->
          <div v-if="!understandingMode && referenceLibrary.length > 0" class="ref-lib-section">
            <div class="ref-lib-header">
              <span class="form-label">{{ $t('image.presets.refLibrary', { n: referenceLibrary.length }) }}</span>
            </div>
            <div class="ref-lib-list">
              <div v-for="entry in referenceLibrary" :key="entry.id" class="ref-lib-item">
                <div class="ref-lib-thumb" @vue:mounted="loadRefLibThumbnail(entry.assetId)">
                  <img v-if="refLibThumbnails[entry.assetId]" :src="refLibThumbnails[entry.assetId]" alt="thumb" />
                  <span v-else class="form-hint" style="font-size:0.6rem">{{ refLibThumbnails[entry.assetId] === '' ? $t('image.presets.refMissing') : '…' }}</span>
                </div>
                <div class="ref-lib-info">
                  <span class="ref-lib-name">{{ entry.name }}</span>
                  <span class="form-hint">{{ entry.source }} · {{ new Date(entry.createdAt).toLocaleDateString() }}</span>
                </div>
                <div class="ref-lib-actions">
                  <button type="button" class="secret-card-btn" style="font-size:0.65rem;" @click="deleteReferenceEntry(entry.id)">{{ $t('image.presets.refDelete') }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub-group labels (A6) -->
          <div v-if="!understandingMode" class="preset-subgroups">
            <span class="preset-subgroup-label">{{ $t('image.presets.subgroupPngMeta') }}</span>
            <span class="preset-subgroup-sep">·</span>
            <span class="preset-subgroup-label" :class="{ 'preset-subgroup-label--active': understandingMode }">{{ $t('image.presets.subgroupImageAnalyze') }}</span>
            <span class="preset-subgroup-sep">·</span>
            <span class="preset-subgroup-label">{{ $t('image.presets.subgroupArtist') }}</span>
          </div>

          <div v-if="!understandingMode" class="presets-layout">
            <!-- PNG preset list with thumbnails (220px) -->
            <div class="png-preset-list-col">
              <h4 class="form-label">{{ $t('image.presets.presetList') }}</h4>
              <div class="png-preset-list">
                <div v-if="pngPresets.length === 0" class="transformer-empty">
                  <span class="form-hint">{{ $t('image.presets.noPngPresets') }}</span>
                </div>
                <button
                  v-for="p in pngPresets"
                  :key="p.id"
                  :class="['preset-item preset-item--png', { 'preset-item--active': selectedPresetId === p.id }]"
                  @click="selectedPresetId = p.id; loadPresetIntoEditor()"
                >
                  <div class="png-preset-item-inner">
                    <div class="png-preset-thumb">
                      <img v-if="p.pngMeta?.coverDataUrl" :src="p.pngMeta.coverDataUrl" alt="cover" />
                      <span v-else class="form-hint">{{ $t('image.presets.noCover') }}</span>
                    </div>
                    <div class="png-preset-info">
                      <span class="preset-item-name">{{ p.name }}</span>
                      <span class="preset-item-preview">{{ p.positive?.slice(0, 40) || $t('image.presets.notAnalyzed') }}</span>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <!-- PNG preset editor -->
            <div class="presets-editor">
              <template v-if="selectedPreset?.pngMeta">
                <!-- Cover + name + source -->
                <div class="png-editor-header">
                  <div class="png-cover-area">
                    <img v-if="selectedPreset.pngMeta.coverDataUrl" :src="selectedPreset.pngMeta.coverDataUrl" class="png-cover-thumb" alt="cover" />
                    <span v-else class="png-no-cover">{{ $t('image.presets.noCoverSet') }}</span>
                  </div>
                  <div class="png-source-info">
                    <div class="form-section">
                      <label class="form-label">{{ $t('image.presets.presetName') }}</label>
                      <input v-model="newPresetName" class="form-input" :placeholder="selectedPreset.name" />
                    </div>
                    <div class="png-source-meta">
                      <span class="form-hint">{{ $t('image.presets.source', { source: selectedPreset.pngMeta.source ?? $t('image.presets.sourceUnknown') }) }}</span>
                      <span v-if="selectedPreset.pngMeta.parsedParams?.model" class="form-hint">{{ $t('image.presets.modelLabel', { model: selectedPreset.pngMeta.parsedParams.model }) }}</span>
                    </div>
                  </div>
                </div>

                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.artistString') }}</label>
                  <textarea v-model="newPresetArtist" class="form-textarea" rows="3" />
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.positivePrompt') }}</label>
                  <textarea v-model="newPresetPositive" class="form-textarea" rows="5" />
                </div>
                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.negativePrompt') }}</label>
                  <textarea v-model="newPresetNegative" class="form-textarea" rows="3" />
                </div>

                <!-- Replicate params toggle -->
                <div class="form-section form-section--inline">
                  <label class="form-label">{{ $t('image.presets.replicateParams') }}</label>
                  <AgaToggle
                    :model-value="selectedPreset.pngMeta.replicateParams === true"
                    @update:model-value="toggleReplicateParams($event)"
                  />
                </div>
                <span class="form-hint">{{ $t('image.presets.replicateParamsHint') }}</span>

                <!-- Param applicability preview (R10) -->
                <div v-if="selectedPreset.pngMeta.replicateParams && selectedPresetParamPreview" class="replicate-preview">
                  <div v-if="Object.keys(selectedPresetParamPreview.applied).length > 0" class="replicate-group">
                    <span class="replicate-group-label replicate-group-label--ok">{{ $t('image.presets.willApply') }}</span>
                    <div class="replicate-chips">
                      <span v-for="(val, key) in selectedPresetParamPreview.applied" :key="key" class="replicate-chip replicate-chip--ok">
                        {{ key }}: {{ val }}
                      </span>
                    </div>
                  </div>
                  <div v-if="selectedPresetParamPreview.notApplicable.length > 0" class="replicate-group">
                    <span class="replicate-group-label replicate-group-label--na">{{ $t('image.presets.notApplicable') }}</span>
                    <div class="replicate-chips">
                      <span v-for="na in selectedPresetParamPreview.notApplicable" :key="na.key" class="replicate-chip replicate-chip--na">
                        {{ na.key }}: {{ na.value }} ({{ na.reason }})
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Expandable metadata -->
                <details class="prompt-details">
                  <summary>{{ $t('image.presets.parsedMetadata') }}</summary>
                  <div class="png-metadata-content">
                    <div v-if="selectedPreset.pngMeta.originalPrompt" class="png-meta-block">
                      <span class="form-label">{{ $t('image.presets.originalPositive') }}</span>
                      <pre class="prompt-text">{{ selectedPreset.pngMeta.originalPrompt }}</pre>
                    </div>
                    <div v-if="selectedPreset.pngMeta.parsedParams && Object.keys(selectedPreset.pngMeta.parsedParams).length > 0" class="png-meta-block">
                      <span class="form-label">{{ $t('image.presets.parsedParams') }}</span>
                      <pre class="prompt-text">{{ JSON.stringify(selectedPreset.pngMeta.parsedParams, null, 2) }}</pre>
                    </div>
                    <div v-if="selectedPreset.pngMeta.rawText" class="png-meta-block">
                      <span class="form-label">{{ $t('image.presets.rawMetadata') }}</span>
                      <pre class="prompt-text">{{ selectedPreset.pngMeta.rawText }}</pre>
                    </div>
                  </div>
                </details>

                <div class="presets-editor-actions">
                  <AgaButton variant="primary" size="sm" @click="savePreset">{{ $t('image.presets.saveChanges') }}</AgaButton>
                  <AgaButton variant="danger" size="sm" @click="deletePreset">{{ $t('image.presets.deletePreset') }}</AgaButton>
                </div>
              </template>

              <div v-else-if="selectedPreset && !selectedPreset.pngMeta" class="tab-placeholder">
                <p>{{ $t('image.presets.notPngType') }}</p>
              </div>
              <div v-else class="tab-placeholder">
                <p>{{ $t('image.presets.noPngSelected') }}</p>
              </div>
            </div>
          </div>

          <!-- PNG import inputs at bottom -->
          <div class="png-import-footer">
            <div class="png-import-status">
              <span v-if="pngImporting" class="png-status png-status--loading">{{ pngImportStatus || $t('image.presets.parsingPng') }}</span>
              <span v-else-if="pngImportStatus" class="png-status">{{ pngImportStatus }}</span>
            </div>
          </div>
        </div>

        <!-- Section: 画师串预设管理 -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.presets.badgeArtistMgmt') }}</span>
          <div class="preset-card-header">
            <h3 class="section-label">{{ $t('image.presets.artistMgmtTitle') }}</h3>
            <div class="preset-card-actions">
              <AgaButton variant="secondary" size="sm" @click="createPreset">{{ $t('image.presets.newPreset') }}</AgaButton>
              <AgaButton variant="ghost" size="sm" @click="exportArtistPresets">{{ $t('image.presets.exportPresets') }}</AgaButton>
              <label class="png-import-btn">
                {{ $t('image.presets.importPresets') }}
                <input type="file" accept="application/json,.json" style="display:none" @change="importArtistPresets" />
              </label>
            </div>
          </div>

          <div class="artist-preset-controls">
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.scopeLabel') }}</label>
              <div class="presets-scope-toggle">
                <AgaButton :variant="presetScope === 'npc' ? 'primary' : 'secondary'" size="sm" @click="presetScope = 'npc'">NPC</AgaButton>
                <AgaButton :variant="presetScope === 'scene' ? 'primary' : 'secondary'" size="sm" @click="presetScope = 'scene'">{{ $t('image.presets.scopeScene') }}</AgaButton>
              </div>
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.presets.currentEdit') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.presets.noPresetSelected'), value: '' }, ...artistOnlyPresets.map(p => ({ label: p.name, value: p.id }))]"
                :model-value="selectedPresetId"
                @update:model-value="selectedPresetId = $event; loadPresetIntoEditor()"
              />
            </div>
          </div>

          <template v-if="selectedPreset && !selectedPreset.pngMeta">
            <div class="artist-preset-editor">
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.presetName') }}</label>
                <input v-model="newPresetName" class="form-input" />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.artistString') }}</label>
                <textarea v-model="newPresetArtist" class="form-textarea" rows="3" :placeholder="$t('image.presets.artistPlaceholder')" />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.positivePrompt') }}</label>
                <textarea v-model="newPresetPositive" class="form-textarea" rows="5" :placeholder="$t('image.presets.positivePlaceholder')" />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.presets.negativePrompt') }}</label>
                <textarea v-model="newPresetNegative" class="form-textarea" rows="3" :placeholder="$t('image.presets.negativePlaceholder')" />
              </div>
              <div class="presets-editor-actions">
                <AgaButton variant="primary" size="sm" @click="savePreset">{{ $t('image.presets.saveChanges') }}</AgaButton>
                <AgaButton variant="danger" size="sm" @click="deletePreset">{{ $t('image.presets.deletePreset') }}</AgaButton>
              </div>
            </div>
          </template>
          <div v-else class="tab-placeholder">
            <p>{{ $t('image.presets.selectOrCreate') }}</p>
          </div>
        </div>
        <!-- Section C: 词组转化器预设 CRUD -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.presets.badgeTransformer') }}</span>
          <h3 class="section-label">{{ $t('image.presets.transformerTitle') }}</h3>
          <p class="form-hint">{{ $t('image.presets.transformerHint') }}</p>

          <div class="transformer-crud-layout">
            <div class="transformer-sidebar">
              <div class="transformer-scope-toggle">
                <AgaButton :variant="transformerScope === 'npc' ? 'primary' : 'secondary'" size="sm" @click="transformerScope = 'npc'">NPC</AgaButton>
                <AgaButton :variant="transformerScope === 'scene' ? 'primary' : 'secondary'" size="sm" @click="transformerScope = 'scene'">{{ $t('image.presets.transformerScopeScene') }}</AgaButton>
                <AgaButton :variant="transformerScope === 'secret' ? 'primary' : 'secondary'" size="sm" @click="transformerScope = 'secret'">{{ $t('image.presets.transformerScopeSecret') }}</AgaButton>
              </div>

              <div class="transformer-list">
                <button
                  v-for="t in scopedTransformers"
                  :key="t.id"
                  :class="['preset-item', { 'preset-item--active': selectedTransformerId === t.id }]"
                  @click="selectedTransformerId = t.id; loadTransformerIntoEditor()"
                >
                  <span class="preset-item-name">{{ t.name }}</span>
                  <span v-if="t.prompt" class="preset-item-preview">{{ t.prompt.slice(0, 40) }}</span>
                </button>
                <div v-if="scopedTransformers.length === 0" class="transformer-empty">
                  <span class="form-hint">{{ $t('image.presets.noTransformerPresets', { scope: transformerScope === 'npc' ? 'NPC' : transformerScope === 'scene' ? $t('image.presets.transformerScopeScene') : $t('image.presets.transformerScopeSecret') }) }}</span>
                </div>
              </div>

              <div class="presets-actions">
                <input v-model="newTransformerName" class="form-input" :placeholder="$t('image.presets.newPresetNamePlaceholder')" style="font-size:12px" />
                <AgaButton variant="secondary" size="sm" @click="createTransformerPreset">{{ $t('image.presets.addNew') }}</AgaButton>
              </div>
            </div>

            <div class="transformer-editor">
              <template v-if="selectedTransformer">
                <h4 class="section-label">{{ selectedTransformer.name }}</h4>

                <div class="form-section">
                  <label class="form-label">{{ $t('image.presets.transformerPromptLabel') }}</label>
                  <span class="form-hint">{{ $t('image.presets.transformerPromptHint', { scope: transformerScope === 'npc' ? $t('image.presets.transformerScopeNpcDesc') : transformerScope === 'scene' ? $t('image.presets.transformerScopeSceneDesc') : $t('image.presets.transformerScopeSecretDesc') }) }}</span>
                  <textarea
                    v-model="editTransformerPrompt"
                    class="form-textarea"
                    rows="8"
                    :placeholder="transformerScope === 'npc'
                      ? $t('image.presets.transformerNpcPlaceholder')
                      : transformerScope === 'scene'
                        ? $t('image.presets.transformerScenePlaceholder')
                        : $t('image.presets.transformerSecretPlaceholder')"
                  />
                </div>

                <div class="presets-editor-actions">
                  <AgaButton variant="primary" size="sm" @click="saveTransformerPreset">{{ $t('image.presets.saveChanges') }}</AgaButton>
                  <AgaButton variant="danger" size="sm" @click="deleteTransformerPreset">{{ $t('image.presets.deletePreset') }}</AgaButton>
                </div>
              </template>

              <div v-else class="tab-placeholder" style="padding:var(--space-xl)">
                <p>{{ $t('image.presets.selectOrCreateTransformer') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ Rules Tab — full CRUD ═══ -->
      <div v-if="activeTab === 'rules'" class="tab-content">
        <div class="rules-layout">
          <div class="rules-header">
            <div>
              <h3 class="section-label">{{ $t('image.rules.centerTitle') }}</h3>
            </div>
            <div class="rules-header-actions">
              <AgaButton variant="ghost" size="sm" @click="exportRules">{{ $t('image.rules.exportAll') }}</AgaButton>
              <label class="png-import-btn">
                {{ $t('image.rules.importAll') }}
                <input type="file" accept="application/json,.json" style="display:none" @change="importRules" />
              </label>
              <AgaButton variant="primary" size="sm" @click="saveActiveRules">{{ $t('image.rules.saveActive') }}</AgaButton>
            </div>
          </div>

          <!-- Sub-section 1: Model Rulesets (collapsible) -->
          <div class="model-ruleset-section" :class="{ 'model-ruleset-section--expanded': modelRulesetExpanded }">
            <button class="model-ruleset-toggle" @click="modelRulesetExpanded = !modelRulesetExpanded">
              <span class="section-label">{{ $t('image.rules.modelRulesetTitle') }}</span>
              <span class="form-hint" style="flex:1">{{ $t('image.rules.modelRulesetHint') }}</span>
              <span v-if="activeModelRuleset" class="model-ruleset-active-name">{{ activeModelRuleset.name }}</span>
              <span class="model-ruleset-expand-text">{{ modelRulesetExpanded ? $t('image.rules.collapse') : $t('image.rules.expand') }}</span>
            </button>

            <div v-if="modelRulesetExpanded" class="model-ruleset-body">
              <div class="model-ruleset-actions">
                <AgaButton variant="secondary" size="sm" @click="createModelRuleset">{{ $t('image.rules.newRuleset') }}</AgaButton>
                <AgaButton v-if="editingModelRuleset" variant="danger" size="sm" @click="deleteModelRuleset">{{ $t('image.rules.deleteCurrent') }}</AgaButton>
                <AgaButton variant="ghost" size="sm" @click="exportModelRulesets">{{ $t('image.rules.export') }}</AgaButton>
                <label class="png-import-btn">
                  {{ $t('image.rules.import') }}
                  <input type="file" accept="application/json,.json" style="display:none" @change="importModelRulesets" />
                </label>
              </div>

              <div class="model-ruleset-two-col">
                <div class="model-ruleset-left">
                  <div class="form-section">
                    <label class="form-label">{{ $t('image.rules.currentEditLabel') }}</label>
                    <AgaSelect
                      v-if="modelRulesetOptions.length > 0"
                      :options="modelRulesetOptions"
                      :model-value="editingModelRulesetId"
                      @update:model-value="selectModelRuleset($event)"
                    />
                    <span v-else class="form-hint">{{ $t('image.rules.noRulesets') }}</span>
                  </div>

                  <template v-if="editingModelRuleset">
                    <div class="form-section form-section--inline">
                      <label class="form-label">{{ $t('image.rules.enableRuleset') }}</label>
                      <AgaToggle
                        :model-value="editingModelRuleset.enabled"
                        @update:model-value="toggleModelRulesetEnabled($event)"
                      />
                    </div>
                    <span class="form-hint">{{ $t('image.rules.enableRulesetHint') }}</span>

                    <div class="form-section form-section--inline">
                      <label class="form-label">{{ $t('image.rules.compatMode') }}</label>
                      <AgaToggle
                        :model-value="editingModelRuleset.compatMode"
                        @update:model-value="toggleModelRulesetCompat($event)"
                      />
                    </div>
                    <span class="form-hint">{{ $t('image.rules.compatModeHint') }}</span>
                  </template>
                </div>

                <div class="model-ruleset-right">
                  <template v-if="editingModelRuleset">
                    <div class="form-section">
                      <label class="form-label">{{ $t('image.rules.rulesetName') }}</label>
                      <input v-model="editModelRulesetName" class="form-input" :placeholder="$t('image.rules.rulesetNamePlaceholder')" />
                    </div>
                    <div class="form-section">
                      <label class="form-label">{{ $t('image.rules.baseModelRule') }}</label>
                      <textarea v-model="editModelRulesetBase" class="form-textarea" rows="5" :placeholder="$t('image.rules.baseModelRulePlaceholder')" />
                    </div>
                    <div class="form-section">
                      <label class="form-label">{{ $t('image.rules.anchorModelRule') }}</label>
                      <textarea v-model="editModelRulesetAnchor" class="form-textarea" rows="5" :placeholder="$t('image.rules.anchorModelRulePlaceholder')" />
                    </div>
                    <AgaButton variant="primary" size="sm" @click="saveModelRuleset">{{ $t('image.rules.saveRuleset') }}</AgaButton>
                  </template>
                  <div v-else class="tab-placeholder" style="padding:var(--space-lg)">
                    <p>{{ $t('image.rules.selectOrCreateRuleset') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub-section 2: Rule Templates -->
          <div class="rules-template-section">
            <div class="rules-template-header">
              <div>
                <h4 class="section-label">{{ $t('image.rules.templateTitle') }}</h4>
                <p class="form-hint">{{ $t('image.rules.templateHint') }}</p>
              </div>
              <div class="rules-scope-tabs">
                <AgaButton :variant="ruleScope === 'npc' ? 'primary' : 'ghost'" size="sm" @click="ruleScope = 'npc'; editingRuleId = ''">{{ $t('image.rules.npcTransformRule') }}</AgaButton>
                <AgaButton :variant="ruleScope === 'scene' ? 'primary' : 'ghost'" size="sm" @click="ruleScope = 'scene'; editingRuleId = ''">{{ $t('image.rules.sceneTransformRule') }}</AgaButton>
                <AgaButton :variant="ruleScope === 'judge' ? 'primary' : 'ghost'" size="sm" @click="ruleScope = 'judge'; editingRuleId = ''">{{ $t('image.rules.judgeTransformRule') }}</AgaButton>
              </div>
            </div>

            <!-- Scope description (per-tab hint) -->
            <p class="form-hint" style="margin-bottom:var(--space-sm)">
              {{ ruleScope === 'npc' ? $t('image.rules.npcScopeHint') :
                 ruleScope === 'scene' ? $t('image.rules.sceneScopeHint') :
                 $t('image.rules.judgeScopeHint') }}
            </p>

          <!-- Enable toggle -->
          <div class="form-section form-section--inline">
            <label class="form-label">{{ $t('image.rules.enableScopeRule', { scope: ruleScope === 'npc' ? 'NPC' : ruleScope === 'scene' ? $t('image.history.typeScene') : $t('image.rules.judgeRule') }) }}</label>
            <AgaToggle
              :model-value="get(`系统.扩展.image.rules.${ruleScope}Enabled`) !== false"
              @update:model-value="setValue(`系统.扩展.image.rules.${ruleScope}Enabled`, $event)"
            />
          </div>

          <!-- Two-column: 当前生效/当前编辑 (left) + editor (right) -->
          <div class="rules-two-col">
            <div class="rules-left-col">
              <div class="form-section">
                <label class="form-label">{{ $t('image.rules.activeLabel') }}</label>
                <span v-if="activeModelRuleset" class="form-hint" style="color:var(--color-warning)">{{ $t('image.rules.overriddenByRuleset', { name: activeModelRuleset.name }) }}</span>
                <span v-else class="form-hint">{{ $t('image.rules.selectActiveHint') }}</span>
                <AgaSelect
                  :options="activeRuleOptions"
                  :model-value="currentActiveRuleId"
                  :disabled="!!activeModelRuleset"
                  @update:model-value="currentActiveRuleId = $event"
                />
              </div>

              <div class="form-section">
                <label class="form-label">{{ $t('image.rules.currentEditRule') }}</label>
                <AgaSelect
                  v-if="editRuleOptions.length > 0"
                  :options="editRuleOptions"
                  :model-value="editingRuleId"
                  @update:model-value="selectEditRule($event)"
                />
                <span v-else class="form-hint">{{ $t('image.rules.noRulesHint') }}</span>
              </div>

              <div class="rules-crud-buttons">
                <AgaButton variant="secondary" size="sm" @click="createRuleTemplate">{{ $t('image.rules.newRule') }}</AgaButton>
                <AgaButton v-if="editingRule" variant="danger" size="sm" @click="deleteRuleTemplate">{{ $t('image.rules.deleteCurrentRule') }}</AgaButton>
              </div>
            </div>

            <div class="rules-right-col">
              <template v-if="editingRule">
                <div class="form-section">
                  <label class="form-label">{{ $t('image.rules.ruleName') }}</label>
                  <input v-model="editRuleName" class="form-input" :placeholder="$t('image.rules.ruleNamePlaceholder')" />
                </div>

                <div class="form-section">
                  <label class="form-label">{{ $t('image.rules.linkedTransformer') }}</label>
                  <AgaSelect
                    :options="currentTransformerOptions"
                    :model-value="editRuleTransformerId"
                    @update:model-value="editRuleTransformerId = $event"
                  />
                </div>

                <!-- NPC/Scene: 4 textareas -->
                <template v-if="ruleScope !== 'judge'">
                  <div class="form-section">
                    <label class="form-label">{{ $t('image.rules.baseTransformRule') }}</label>
                    <span class="form-hint">{{ ruleScope === 'npc' ? $t('image.rules.baseTransformNpcHint') : $t('image.rules.baseTransformSceneHint') }}</span>
                    <textarea v-model="editBaseRule" class="form-textarea" rows="8" :placeholder="ruleScope === 'npc' ? $t('image.rules.baseTransformNpcPlaceholder') : $t('image.rules.baseTransformScenePlaceholder')" />
                  </div>
                  <div class="form-section">
                    <label class="form-label">{{ ruleScope === 'npc' ? $t('image.rules.anchorModeRule') : $t('image.rules.sceneAnchorModeRule') }}</label>
                    <span class="form-hint">{{ $t('image.rules.anchorModeHint', { scope: ruleScope === 'npc' ? $t('image.history.typeCharacter') : $t('image.history.typeScene') }) }}</span>
                    <textarea v-model="editAnchorRule" class="form-textarea" rows="6" :placeholder="$t('image.rules.anchorModePlaceholder')" />
                  </div>
                  <div class="form-section">
                    <label class="form-label">{{ $t('image.rules.noAnchorFallback') }}</label>
                    <span class="form-hint">{{ $t('image.rules.noAnchorFallbackHint') }}</span>
                    <textarea v-model="editNoAnchorFallback" class="form-textarea" rows="4" :placeholder="$t('image.rules.noAnchorFallbackPlaceholder')" />
                  </div>
                  <div class="form-section">
                    <label class="form-label">{{ $t('image.rules.outputFormat') }}</label>
                    <span class="form-hint">{{ $t('image.rules.outputFormatHint') }}</span>
                    <textarea v-model="editOutputFormat" class="form-textarea" rows="4" :placeholder="$t('image.rules.outputFormatPlaceholder')" />
                  </div>
                </template>

                <!-- Judge: 1 textarea -->
                <template v-else>
                  <div class="form-section">
                    <label class="form-label">{{ $t('image.rules.judgeRule') }}</label>
                    <span class="form-hint">{{ $t('image.rules.judgeRuleHint') }}</span>
                    <textarea v-model="editBaseRule" class="form-textarea" rows="10" :placeholder="$t('image.rules.judgeRulePlaceholder')" />
                  </div>
                </template>

                <div class="presets-editor-actions">
                  <AgaButton variant="primary" size="sm" @click="saveRuleTemplate">{{ $t('image.rules.saveRule') }}</AgaButton>
                </div>
              </template>

              <div v-else class="tab-placeholder" style="padding:var(--space-xl)">
                <p>{{ $t('image.rules.selectOrCreateRule') }}</p>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>

      <!-- ═══ Settings Tab (8th tab) ═══ -->
      <div v-if="activeTab === 'settings'" class="tab-content settings-tab">

        <!-- §7.1 Basic -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeBasic') }}</span>
          <div class="settings-row">
            <div><span class="form-label">{{ $t('image.settings.masterSwitch') }}</span></div>
            <AgaToggle
              :model-value="enabled"
              @update:model-value="setValue('系统.扩展.image.enabled', $event)"
            />
          </div>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.backendType') }}</span>
              <span class="form-hint">{{ $t('image.settings.backendTypeHint') }}</span>
            </div>
            <AgaSelect
              :options="backendOptions"
              :model-value="settingsBackend"
              @update:model-value="setValue('系统.扩展.image.config.defaultBackend', $event)"
            />
          </div>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.useTransformer') }}</span>
              <span class="form-hint">{{ $t('image.settings.useTransformerHint') }}</span>
            </div>
            <AgaToggle
              :model-value="isNovelAIBackend || get('系统.扩展.image.config.useTransformer') !== false"
              :disabled="isNovelAIBackend"
              @update:model-value="setValue('系统.扩展.image.config.useTransformer', $event)"
            />
          </div>
        </div>

        <!-- §7.2 Backend settings (conditional per backend) -->
        <div v-if="isNovelAIBackend" class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeNovelai') }}</span>
          <div class="settings-row">
            <div><span class="form-label">{{ $t('image.settings.novelaiCustomParams') }}</span></div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.novelai.customParams') === true"
              @update:model-value="setValue('系统.扩展.image.config.novelai.customParams', $event)"
            />
          </div>
          <div class="settings-grid-3">
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.sampler') }}</label>
              <AgaSelect
                :options="[
                  { label: 'Euler Ancestral', value: 'k_euler_ancestral' },
                  { label: 'Euler', value: 'k_euler' },
                  { label: 'DPM++ 2M', value: 'k_dpmpp_2m' },
                  { label: 'DPM++ 2S Ancestral', value: 'k_dpmpp_2s_ancestral' },
                  { label: 'DPM++ SDE', value: 'k_dpmpp_sde' },
                  { label: 'DPM++ 2M SDE', value: 'k_dpmpp_2m_sde' },
                ]"
                :model-value="String(get('系统.扩展.image.config.novelai.sampler') ?? 'k_euler_ancestral')"
                @update:model-value="setValue('系统.扩展.image.config.novelai.sampler', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.noiseSchedule') }}</label>
              <AgaSelect
                :options="[
                  { label: 'Karras', value: 'karras' },
                  { label: 'Native', value: 'native' },
                  { label: 'Exponential', value: 'exponential' },
                  { label: 'Polyexponential', value: 'polyexponential' },
                ]"
                :model-value="String(get('系统.扩展.image.config.novelai.noiseSchedule') ?? 'karras')"
                @update:model-value="setValue('系统.扩展.image.config.novelai.noiseSchedule', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.steps') }}</label>
              <input
                type="number" min="1" max="50" class="form-input"
                :value="get('系统.扩展.image.config.novelai.steps') ?? 28"
                @change="setValue('系统.扩展.image.config.novelai.steps', Math.max(1, Math.min(50, Number(($event.target as HTMLInputElement).value) || 28)))"
              />
            </div>
          </div>
          <div class="settings-grid-3">
            <div class="form-section">
              <label class="form-label">CFG Scale</label>
              <input
                type="number" min="1" max="30" step="0.5" class="form-input"
                :value="get('系统.扩展.image.config.novelai.cfgScale') ?? 5"
                @change="setValue('系统.扩展.image.config.novelai.cfgScale', Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <div class="form-section settings-row-inline">
              <label class="form-label">{{ $t('image.settings.enableSmea') }}</label>
              <AgaToggle
                :model-value="get('系统.扩展.image.config.novelai.smea') === true"
                @update:model-value="setValue('系统.扩展.image.config.novelai.smea', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.fixedSeed') }}</label>
              <input
                type="number" min="0" class="form-input"
                :value="get('系统.扩展.image.config.novelai.seed') ?? 0"
                @change="setValue('系统.扩展.image.config.novelai.seed', Number(($event.target as HTMLInputElement).value))"
              />
            </div>
          </div>
          <div class="form-section">
            <label class="form-label">{{ $t('image.settings.defaultNegative') }}</label>
            <textarea
              class="form-textarea" rows="4"
              :placeholder="$t('image.settings.defaultNegativePlaceholder')"
              :value="get('系统.扩展.image.config.novelai.negativeDefault') ?? ''"
              @input="setValue('系统.扩展.image.config.novelai.negativeDefault', ($event.target as HTMLTextAreaElement).value)"
            />
          </div>
        </div>

        <div v-if="settingsBackend === 'comfyui'" class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeComfyui') }}</span>
          <div class="form-section">
            <label class="form-label">{{ $t('image.settings.comfyuiWorkflow') }}</label>
            <textarea
              class="form-textarea" rows="12"
              :placeholder="$t('image.settings.comfyuiWorkflowPlaceholder')"
              :value="get('系统.扩展.image.config.comfyui.workflowJson') ?? ''"
              @input="setValue('系统.扩展.image.config.comfyui.workflowJson', ($event.target as HTMLTextAreaElement).value)"
            />
            <p class="form-hint">{{ $t('image.settings.comfyuiWorkflowHint') }}</p>
          </div>
        </div>

        <!-- Civitai settings (tiered: basic + advanced) -->
        <div v-if="settingsBackend === 'civitai'" class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeCivitai') }}</span>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.allowMature') }}</span>
              <p class="form-hint">
                {{ $t('image.settings.allowMatureHint') }}
              </p>
            </div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
              @update:model-value="setValue('系统.扩展.image.config.civitai.allowMatureContent', $event)"
            />
          </div>
          <div class="settings-grid-3">
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.civitaiSampler') }}</label>
              <AgaSelect
                :options="civitaiSchedulerOptions"
                :model-value="String(get('系统.扩展.image.config.civitai.scheduler') ?? 'EulerA')"
                @update:model-value="setValue('系统.扩展.image.config.civitai.scheduler', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.steps') }}</label>
              <input
                type="number" min="1" max="100" class="form-input"
                :value="get('系统.扩展.image.config.civitai.steps') ?? 25"
                @change="setValue('系统.扩展.image.config.civitai.steps', Math.max(1, Math.min(100, Number(($event.target as HTMLInputElement).value) || 25)))"
              />
            </div>
            <div class="form-section">
              <label class="form-label">CFG Scale</label>
              <input
                type="number" min="1" max="30" step="0.5" class="form-input"
                :value="get('系统.扩展.image.config.civitai.cfgScale') ?? 7"
                @change="setValue('系统.扩展.image.config.civitai.cfgScale', Number(($event.target as HTMLInputElement).value) || 7)"
              />
            </div>
          </div>
          <div class="settings-grid-3">
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.seedRandom') }}</label>
              <input
                type="number" min="-1" max="4294967295" class="form-input"
                :value="get('系统.扩展.image.config.civitai.seed') ?? -1"
                @change="setValue('系统.扩展.image.config.civitai.seed', Number(($event.target as HTMLInputElement).value) ?? -1)"
              />
            </div>
          </div>

          <!-- Civitai LoRA Shelf -->
          <CivitaiLoraShelf
            mode="full"
            :scope="settingsLoraPreviewScope"
            :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
            @update:scope="settingsLoraPreviewScope = $event"
          />

          <details class="form-advanced">
            <summary>{{ $t('image.settings.advancedParams') }}</summary>
            <div class="settings-grid-3">
              <div class="form-section">
                <label class="form-label">Clip Skip</label>
                <input
                  type="number" min="1" max="12" class="form-input"
                  :value="get('系统.扩展.image.config.civitai.clipSkip') ?? 2"
                  @change="setValue('系统.扩展.image.config.civitai.clipSkip', Math.max(1, Math.min(12, Number(($event.target as HTMLInputElement).value) || 2)))"
                />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.settings.outputFormat') }}</label>
                <AgaSelect
                  :options="civitaiOutputFormatOptions"
                  :model-value="String(get('系统.扩展.image.config.civitai.outputFormat') ?? 'png')"
                  @update:model-value="setValue('系统.扩展.image.config.civitai.outputFormat', $event)"
                />
              </div>
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.additionalNetworks') }}</label>
              <textarea
                class="form-textarea" rows="3"
                :class="{ 'form-textarea--error': civitaiNetworksJsonError }"
                placeholder='{"urn:air:sdxl:lora:civitai:82098@87153": {"type": "Lora", "strength": 0.8}}'
                :value="String(get('系统.扩展.image.config.civitai.additionalNetworksJson') ?? '')"
                @input="setValue('系统.扩展.image.config.civitai.additionalNetworksJson', ($event.target as HTMLTextAreaElement).value)"
                @blur="validateCivitaiJson('additionalNetworksJson', 'civitaiNetworksJsonError')"
              />
              <span v-if="civitaiNetworksJsonError" class="form-hint" style="color: var(--color-error, #f87171);">{{ civitaiNetworksJsonError }}</span>
            </div>
            <div class="form-section">
              <label class="form-label">ControlNet (JSON)</label>
              <textarea
                class="form-textarea" rows="3"
                :class="{ 'form-textarea--error': civitaiControlNetsJsonError }"
                placeholder='[{"preprocessor": "Canny", "weight": 1.0, "imageUrl": "..."}]'
                :value="String(get('系统.扩展.image.config.civitai.controlNetsJson') ?? '')"
                @input="setValue('系统.扩展.image.config.civitai.controlNetsJson', ($event.target as HTMLTextAreaElement).value)"
                @blur="validateCivitaiJson('controlNetsJson', 'civitaiControlNetsJsonError')"
              />
              <span v-if="civitaiControlNetsJsonError" class="form-hint" style="color: var(--color-error, #f87171);">{{ civitaiControlNetsJsonError }}</span>
            </div>
          </details>

          <div class="settings-row" style="margin-top: 8px;">
            <div>
              <span class="form-label">{{ $t('image.settings.buzzEstimate') }}</span>
              <span class="form-hint">{{ $t('image.settings.buzzEstimateHint') }}</span>
            </div>
            <AgaButton variant="secondary" size="sm" :disabled="civitaiWhatifLoading" @click="runCivitaiWhatif">
              {{ civitaiWhatifLoading ? $t('image.settings.buzzQuerying') : $t('image.settings.buzzQuery') }}
            </AgaButton>
          </div>
          <p v-if="civitaiWhatifResult" class="form-hint" style="margin-top: 4px;">{{ civitaiWhatifResult }}</p>
        </div>

        <!-- §7.2.5 Reference / Understanding settings (always visible) -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeReference') }}</span>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.defaultDenoise') }}</span>
              <span class="form-hint">{{ $t('image.settings.defaultDenoiseHint') }}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;min-width:140px">
              <input
                type="range" min="0.1" max="1" step="0.05" style="flex:1"
                :value="get('系统.扩展.image.config.reference.defaultDenoiseStrength') ?? 0.65"
                @input="setValue('系统.扩展.image.config.reference.defaultDenoiseStrength', Number(($event.target as HTMLInputElement).value))"
              />
              <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ Number(get('系统.扩展.image.config.reference.defaultDenoiseStrength') ?? 0.65).toFixed(2) }}</span>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.uploadSizeLimit') }}</span>
            </div>
            <AgaSelect
              :options="[
                { label: '5 MB', value: '5242880' },
                { label: '10 MB', value: '10485760' },
                { label: '20 MB', value: '20971520' },
              ]"
              :model-value="String(get('系统.扩展.image.config.reference.maxUploadBytes') ?? 10485760)"
              @update:model-value="setValue('系统.扩展.image.config.reference.maxUploadBytes', Number($event))"
            />
          </div>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.persistRef') }}</span>
              <span class="form-hint">{{ $t('image.settings.persistRefHint') }}</span>
            </div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.reference.persistUploadedReferences') !== false"
              @update:model-value="setValue('系统.扩展.image.config.reference.persistUploadedReferences', $event)"
            />
          </div>

          <!-- 图片提炼（重建 epic §5.2）：双引擎设置 -->
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.understandingEngine') }}</span>
              <span class="form-hint">{{ $t('image.settings.understandingEngineHint') }}</span>
            </div>
            <AgaSelect
              data-testid="understanding-default-engine"
              :options="[
                { label: $t('image.presets.engineCivitai'), value: 'civitai_vlm' },
                { label: $t('image.presets.engineGeneralLlmBare'), value: 'general_llm' },
              ]"
              :model-value="String(get('系统.扩展.image.config.understanding.defaultEngine') ?? 'civitai_vlm')"
              @update:model-value="setValue('系统.扩展.image.config.understanding.defaultEngine', $event)"
            />
          </div>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.understandingCivitaiModel') }}</span>
              <span class="form-hint">{{ $t('image.settings.understandingCivitaiModelHint') }}</span>
            </div>
            <input
              type="text" class="form-input" style="max-width: 220px" data-testid="understanding-civitai-model"
              :value="understandingCivitaiModel"
              @change="setValue('系统.扩展.image.config.understanding.civitaiModel', String(($event.target as HTMLInputElement).value).trim() || 'claude-sonnet-5')"
            />
          </div>
          <!-- 模型速查清单：新用户不必去翻文档就知道能填什么（点击即填入） -->
          <details class="form-advanced" data-testid="understanding-model-guide">
            <summary>{{ $t('image.settings.understandingModelGuide') }}</summary>
            <div class="model-guide">
              <span class="form-hint">{{ $t('image.settings.understandingModelApply') }}</span>
              <div class="model-guide-chips">
                <button
                  v-for="m in UNDERSTANDING_MODEL_PRESETS"
                  :key="m.id"
                  type="button"
                  class="model-chip"
                  :class="{ 'model-chip--active': understandingCivitaiModel === m.id }"
                  :aria-pressed="understandingCivitaiModel === m.id"
                  :data-testid="`understanding-model-chip-${m.id}`"
                  @click="applyUnderstandingModel(m.id)"
                >
                  <span class="model-chip-id">{{ m.id }}</span>
                  <span class="model-chip-note">{{ $t(m.noteKey) }}</span>
                </button>
              </div>
              <ul class="model-guide-list">
                <li>{{ $t('image.settings.understandingModelFormat') }}</li>
                <li>
                  {{ $t('image.settings.understandingModelCatalog') }}
                  <a href="https://openrouter.ai/models" target="_blank" rel="noopener" class="model-guide-link">openrouter.ai/models</a>
                </li>
                <li>{{ $t('image.settings.understandingModelBilling') }}</li>
                <li>{{ $t('image.settings.understandingModelInvalid') }}</li>
              </ul>
            </div>
          </details>
          <!-- D3B「必须标明」：通用 LLM 引擎 = 主对话模型配置 -->
          <div class="settings-row">
            <span class="form-hint" data-testid="understanding-llm-note">
              {{ understandingLlmInfo?.available
                ? $t('image.settings.understandingLlmNote', { model: understandingLlmInfo.model })
                : $t('image.settings.understandingLlmNotConfigured') }}
            </span>
          </div>
          <details class="form-advanced">
            <summary>{{ $t('image.settings.understandingAdvanced') }}</summary>
            <div class="settings-grid-3">
              <div class="form-section">
                <label class="form-label">{{ $t('image.settings.understandingTemp') }}</label>
                <input
                  type="number" min="0" max="1" step="0.1" class="form-input"
                  :value="get('系统.扩展.image.config.understanding.temperature') ?? 0.2"
                  @change="setValue('系统.扩展.image.config.understanding.temperature', Math.max(0, Math.min(1, Number(($event.target as HTMLInputElement).value) || 0.2)))"
                />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.settings.understandingMaxTokens') }}</label>
                <input
                  type="number" min="50" max="1000" class="form-input"
                  :value="get('系统.扩展.image.config.understanding.maxNewTokens') ?? 600"
                  @change="setValue('系统.扩展.image.config.understanding.maxNewTokens', Math.max(50, Math.min(1000, Math.floor(Number(($event.target as HTMLInputElement).value) || 600))))"
                />
              </div>
            </div>
          </details>

          <div class="settings-row" style="margin-top: 4px;">
            <div>
              <span class="form-label">{{ $t('image.settings.novelaiRefRedraw') }}</span>
              <span class="form-hint">{{ $t('image.settings.novelaiRefHint') }}</span>
            </div>
            <span class="preset-card-badge" style="font-size: 0.7rem;">
              {{ get('系统.扩展.image.config.reference.novelai.validationStatus') === 'validated' ? $t('image.settings.validated') : $t('image.settings.notValidated') }}
            </span>
          </div>
        </div>

        <!-- §7.3 Transformer section -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeTransformer') }}</span>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.independentTransformer') }}</span>
              <span class="form-hint">{{ $t('image.settings.independentTransformerHint') }}</span>
            </div>
            <AgaToggle
              :model-value="settingsTransformerIndependent"
              @update:model-value="setValue('系统.扩展.image.config.transformerIndependentModel', $event)"
            />
          </div>
          <template v-if="settingsTransformerIndependent">
            <div class="settings-grid-2">
              <div class="form-section">
                <label class="form-label">{{ $t('image.settings.transformerEndpoint') }}</label>
                <input
                  type="text" class="form-input" :placeholder="$t('image.settings.transformerEndpointPlaceholder')"
                  :value="get('系统.扩展.image.config.transformer.endpoint') ?? ''"
                  @input="setValue('系统.扩展.image.config.transformer.endpoint', ($event.target as HTMLInputElement).value)"
                />
              </div>
              <div class="form-section">
                <label class="form-label">{{ $t('image.settings.transformerApiKey') }}</label>
                <input
                  type="password" class="form-input" :placeholder="$t('image.settings.transformerApiKeyPlaceholder')"
                  :value="get('系统.扩展.image.config.transformer.apiKey') ?? ''"
                  @input="setValue('系统.扩展.image.config.transformer.apiKey', ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.transformerModel') }}</label>
              <input
                type="text" class="form-input" :placeholder="$t('image.settings.transformerModelPlaceholder')"
                :value="get('系统.扩展.image.config.transformer.model') ?? ''"
                @input="setValue('系统.扩展.image.config.transformer.model', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </template>
          <div class="settings-row">
            <div>
              <span class="form-label">{{ $t('image.settings.forceNude') }}</span>
              <span class="form-hint">{{ $t('image.settings.forceNudeHint') }}</span>
            </div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.forceNudeSemantics') !== false"
              @update:model-value="setValue('系统.扩展.image.config.forceNudeSemantics', $event)"
            />
          </div>
        </div>

        <!-- §7.4 Automation section -->
        <div class="preset-card">
          <span class="preset-card-badge">{{ $t('image.settings.badgeAuto') }}</span>

          <!-- Scene generation mode -->
          <div class="settings-row">
            <div><span class="form-label">{{ $t('image.settings.autoScene') }}</span></div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.autoSceneOnRound') === true"
              @update:model-value="setValue('系统.扩展.image.config.autoSceneOnRound', $event)"
            />
          </div>

          <!-- Scene defaults -->
          <div class="settings-grid-2">
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.autoSceneComposition') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.scene.modeLandscape'), value: 'landscape' }, { label: $t('image.scene.modeSnapshot'), value: 'snapshot' }]"
                :model-value="String(get('系统.扩展.image.config.auto.sceneComposition') ?? 'landscape')"
                @update:model-value="setValue('系统.扩展.image.config.auto.sceneComposition', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.autoSceneOrientation') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.scene.orientationLandscape'), value: 'landscape' }, { label: $t('image.scene.orientationPortrait'), value: 'portrait' }]"
                :model-value="String(get('系统.扩展.image.config.auto.sceneOrientation') ?? 'landscape')"
                @update:model-value="setValue('系统.扩展.image.config.auto.sceneOrientation', $event)"
              />
            </div>
          </div>
          <div class="form-section">
            <label class="form-label">{{ $t('image.settings.autoSceneResolution') }}</label>
            <AgaSelect
              :options="sizeOptionsToSelectOptions((get('系统.扩展.image.config.auto.sceneOrientation') ?? 'landscape') === 'landscape' ? SCENE_LANDSCAPE_SIZE_OPTIONS : SCENE_PORTRAIT_SIZE_OPTIONS)"
              :model-value="String(get('系统.扩展.image.config.auto.sceneResolution') ?? '1024x576')"
              @update:model-value="setValue('系统.扩展.image.config.auto.sceneResolution', $event)"
            />
          </div>

          <!-- NPC auto generation -->
          <div class="settings-row" style="margin-top:var(--space-md)">
            <div><span class="form-label">{{ $t('image.settings.autoNpc') }}</span></div>
            <AgaToggle
              :model-value="get('系统.扩展.image.config.autoPortraitForMajorNpcs') === true"
              @update:model-value="setValue('系统.扩展.image.config.autoPortraitForMajorNpcs', $event)"
            />
          </div>
          <div class="settings-grid-3">
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.genderFilter') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.settings.genderAll'), value: 'all' }, { label: $t('image.settings.genderMale'), value: 'male' }, { label: $t('image.settings.genderFemale'), value: 'female' }]"
                :model-value="String(get('系统.扩展.image.config.auto.genderFilter') ?? 'all')"
                @update:model-value="setValue('系统.扩展.image.config.auto.genderFilter', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.importanceFilter') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.settings.importanceAll'), value: 'all' }, { label: $t('image.settings.importanceMajor'), value: 'major' }]"
                :model-value="String(get('系统.扩展.image.config.auto.importanceFilter') ?? 'all')"
                @update:model-value="setValue('系统.扩展.image.config.auto.importanceFilter', $event)"
              />
            </div>
            <div class="form-section">
              <label class="form-label">{{ $t('image.settings.npcDefaultStyle') }}</label>
              <AgaSelect
                :options="[{ label: $t('image.manual.artStyle.generic'), value: 'generic' }, { label: $t('image.manual.artStyle.anime'), value: 'anime' }, { label: $t('image.manual.artStyle.realistic'), value: 'realistic' }, { label: $t('image.manual.artStyle.chinese'), value: 'chinese' }]"
                :model-value="String(get('系统.扩展.image.config.auto.npcStyle') ?? 'generic')"
                @update:model-value="setValue('系统.扩展.image.config.auto.npcStyle', $event)"
              />
            </div>
          </div>
        </div>
      </div>

    </template>

    <!-- ─── 前台提交确认 overlay ─── -->
    <Transition name="fade">
      <div
        v-if="manualFlowStage !== 'idle'"
        class="confirm-overlay"
        @pointerdown="confirmBackdrop.onPointerdown"
        @pointerup="confirmBackdrop.onPointerup"
      >
        <!--
          Confirm modal — shows a portrait thumbnail, character vitals,
          visual archive preview, and every active generation parameter so the
          user can double-check before paying for an API call.
        -->
        <div class="confirm-card confirm-card--wide">
          <header class="confirm-header">
            <div>
              <div class="confirm-title">
                {{ manualFlowStage === 'submitting'
                  ? (backgroundMode ? $t('image.confirm.titleSubmitted') : $t('image.confirm.titleSubmitting'))
                  : $t('image.confirm.titleConfirm') }}
              </div>
              <div class="confirm-subtitle">
                {{ manualFlowStage === 'submitting'
                  ? (backgroundMode ? $t('image.confirm.subtitleSubmitted') : $t('image.confirm.subtitleSubmitting'))
                  : $t('image.confirm.subtitleConfirm') }}
              </div>
            </div>
            <Tooltip
              v-if="manualFlowStage !== 'submitting'"
              :text="$t('image.confirm.close')"
              interactive
            >
              <button
                class="confirm-close"
                :aria-label="$t('image.confirm.close')"
                @click="cancelConfirm"
              >×</button>
            </Tooltip>
          </header>

          <div class="confirm-body">
            <!-- ═══ Left: character preview ═══ -->
            <aside class="confirm-character" v-if="selectedNpcData">
              <div class="confirm-character-avatar">
                <ImageDisplay
                  :asset-id="(selectedNpcData['图片档案'] as Record<string, unknown> | undefined)?.['已选头像图片ID'] as string | undefined"
                  :fallback-letter="String(selectedNpcData['名称'] ?? '?').charAt(0)"
                  :alt="String(selectedNpcData['名称'] ?? '')"
                  size="lg"
                  class="confirm-character-avatar__img"
                />
              </div>
              <div class="confirm-character-name">{{ selectedNpcData['名称'] ?? $t('image.confirm.unknown') }}</div>
              <div class="confirm-character-meta">
                <span v-if="selectedNpcData['性别']">{{ selectedNpcData['性别'] }}</span>
                <span v-if="selectedNpcData['年龄']">· {{ $t('image.npcMeta.ageSuffix', { age: selectedNpcData['年龄'] }) }}</span>
                <span v-if="selectedNpcData['类型']">· {{ selectedNpcData['类型'] }}</span>
              </div>
              <div v-if="selectedNpcAnchor" class="confirm-character-anchor">
                <span
                  :class="['confirm-anchor-dot', selectedNpcAnchor.enabled ? 'confirm-anchor-dot--on' : 'confirm-anchor-dot--off']"
                />
                {{ selectedNpcAnchor.enabled ? $t('image.confirm.anchorEnabled') : $t('image.confirm.anchorDisabled') }}
                <span v-if="selectedNpcAnchor.name" class="confirm-anchor-name">: {{ selectedNpcAnchor.name }}</span>
              </div>
              <p v-if="selectedNpcData['描述']" class="confirm-character-desc">
                {{ String(selectedNpcData['描述']).slice(0, 160) }}
              </p>
            </aside>

            <!-- ═══ Right: generation parameters ═══ -->
            <div class="confirm-params-panel">
              <section class="confirm-section">
                <h4 class="confirm-section-title">{{ $t('image.confirm.paramsTitle') }}</h4>
                <dl class="confirm-dl">
                  <div class="confirm-dl-row">
                    <dt>{{ $t('image.confirm.composition') }}</dt>
                    <dd>{{ compositionOptions.find(o => o.value === composition)?.label ?? composition }}</dd>
                  </div>
                  <div class="confirm-dl-row">
                    <dt>{{ $t('image.confirm.artStyle') }}</dt>
                    <dd>{{ styleOptions.find(o => o.value === artStyle)?.label ?? artStyle }}</dd>
                  </div>
                  <div class="confirm-dl-row">
                    <dt>{{ $t('image.confirm.backend') }}</dt>
                    <dd>{{ backendLabel(backend) }}</dd>
                  </div>
                  <div class="confirm-dl-row">
                    <dt>{{ $t('image.confirm.size') }}</dt>
                    <dd>{{ currentSizeDisplay }}</dd>
                  </div>
                </dl>
              </section>

              <section
                v-if="extraPrompt?.trim() || selectedNpcData?.['外貌描述'] || selectedNpcData?.['身材描写'] || selectedNpcData?.['衣着风格']"
                class="confirm-section"
              >
                <h4 class="confirm-section-title">{{ $t('image.confirm.visualDataTitle') }}</h4>
                <div
                  v-if="selectedNpcData?.['外貌描述']"
                  class="confirm-kv"
                >
                  <div class="confirm-kv-key">{{ $t('image.npcMeta.appearance') }}</div>
                  <div class="confirm-kv-value">{{ String(selectedNpcData['外貌描述']).slice(0, 180) }}</div>
                </div>
                <div
                  v-if="selectedNpcData?.['身材描写']"
                  class="confirm-kv"
                >
                  <div class="confirm-kv-key">{{ $t('image.npcMeta.body') }}</div>
                  <div class="confirm-kv-value">{{ String(selectedNpcData['身材描写']).slice(0, 120) }}</div>
                </div>
                <div
                  v-if="selectedNpcData?.['衣着风格']"
                  class="confirm-kv"
                >
                  <div class="confirm-kv-key">{{ $t('image.npcMeta.outfit') }}</div>
                  <div class="confirm-kv-value">{{ String(selectedNpcData['衣着风格']).slice(0, 120) }}</div>
                </div>
                <div
                  v-if="extraPrompt?.trim()"
                  class="confirm-kv"
                >
                  <div class="confirm-kv-key">{{ $t('image.manual.extraPrompt') }}</div>
                  <div class="confirm-kv-value">{{ extraPrompt }}</div>
                </div>
              </section>

              <!-- submitting 状态：real-time progress (tracks task phases) -->
              <div v-if="manualFlowStage === 'submitting'" class="confirm-progress">
                <div class="confirm-spinner" />
                <div class="confirm-progress-text">
                  <span v-if="selectedNpcActiveTask" :class="['task-status-badge', `task-status-badge--${taskStatusVariant(selectedNpcActiveTask.status)}`]">
                    {{ taskStatusLabel(selectedNpcActiveTask.status) }}
                  </span>
                  <span>{{ manualStatusText || $t('image.confirm.waitingStatus') }}</span>
                </div>
              </div>
            </div>
          </div>

          <footer class="confirm-footer">
            <!-- confirm 状态：操作按钮 -->
            <template v-if="manualFlowStage !== 'submitting'">
              <AgaButton variant="secondary" @click="cancelConfirm">{{ $t('image.confirm.goBack') }}</AgaButton>
              <AgaButton variant="primary" :disabled="isGenerating" @click="submitGenerate">{{ $t('image.confirm.confirmGenerate') }}</AgaButton>
            </template>
            <!-- submitting 状态：取消按钮 -->
            <template v-else>
              <AgaButton variant="secondary" @click="cancelSubmitting">
                {{ backgroundMode ? $t('image.confirm.closeHint') : $t('image.confirm.cancelWait') }}
              </AgaButton>
            </template>
          </footer>
        </div>
      </div>
    </Transition>

    <!-- Fullscreen viewer -->
    <ImageViewer v-if="viewerOpen" :src="viewerSrc" @close="closeViewer" />

    <!-- Delete confirmation -->
    <AgaConfirmModal
      v-if="showDeleteConfirm"
      :title="$t('image.delete.confirmTitle')"
      :message="$t('image.delete.confirmMessage')"
      variant="danger"
      :confirm-label="$t('image.delete.confirmLabel')"
      @confirm="confirmDelete"
      @cancel="showDeleteConfirm = false"
    />

    <!-- Regenerate-Same modal (shared across queue / gallery / scene) -->
    <RegenerateSameModal
      v-if="regenPayload"
      :subject-label="regenPayload.subjectLabel"
      :subtitle="regenPayload.subtitle"
      :positive-prompt="regenPayload.positivePrompt"
      :negative-prompt="regenPayload.negativePrompt"
      :width="regenPayload.width"
      :height="regenPayload.height"
      :initial-backend="regenPayload.initialBackend"
      :available-backends="backendOptions"
      :busy="regenBusy"
      :civitai-lora-snapshot="regenPayload.civitaiLoraSnapshot"
      :source-asset-id="regenPayload.sourceAssetId"
      :max-upload-bytes="refConfigMaxUploadBytes"
      :persist-upload="persistUploadedReference"
      :default-denoise-strength="refConfigDenoiseDefault"
      :pre-activate-reference="regenPayload.preActivateReference"
      @confirm="confirmRegenerate"
      @cancel="cancelRegenerate"
    />
  </div>
</template>

<style scoped>
.image-panel { padding: var(--space-lg) var(--sidebar-right-reserve, 40px) var(--space-lg) var(--sidebar-left-reserve, 40px); transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet); height: 100%; display: flex; flex-direction: column; overflow: hidden; }

/* Slim scrollbar for all scrollable areas within image panel */
.image-panel ::-webkit-scrollbar { width: 6px; height: 6px; }
.image-panel ::-webkit-scrollbar-track { background: transparent; }
.image-panel ::-webkit-scrollbar-thumb {
  background: color-mix(in oklch, var(--color-text-umber) 35%, transparent);
  border-radius: 3px;
}
.image-panel ::-webkit-scrollbar-thumb:hover { background: color-mix(in oklch, var(--color-text-umber) 55%, transparent); }
.image-panel { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--color-text-umber) 35%, transparent) transparent; }
.image-panel * { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--color-text-umber) 35%, transparent) transparent; }
.panel-header { margin-bottom: var(--space-md); }
.panel-title { font-size: var(--font-size-xl); color: var(--color-text); }
.panel-notice { padding: var(--space-xl); text-align: center; color: var(--color-text-secondary); }
.panel-notice strong { color: var(--color-primary); }

.tab-content { flex: 1; overflow-y: auto; padding-top: var(--space-md); }

.gen-layout { display: flex; gap: var(--space-xl); }
.gen-form-col { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
/* gen-preview-col removed — preview is now in npc-preview-panel */

.form-section { display: flex; flex-direction: column; gap: var(--space-2xs); }
.form-section--inline { flex-direction: row; align-items: center; justify-content: space-between; }
.form-label { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
.form-textarea {
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--font-size-sm);
  resize: vertical;
}
.form-textarea:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.form-input {
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}
.form-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.form-hint { font-size: 0.68rem; color: var(--color-text-secondary); }
.form-actions { padding-top: var(--space-sm); }

/* ── Button Grid (composition / style / resolution selectors) ── */
.btn-grid { display: grid; gap: 8px; }
.btn-grid--4 { grid-template-columns: repeat(4, 1fr); }
.btn-grid--5 { grid-template-columns: repeat(5, 1fr); }
.btn-grid--6 { grid-template-columns: repeat(6, 1fr); }
.grid-btn {
  padding: 10px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-secondary);
  cursor: pointer;
  text-align: center;
  transition: all 0.25s ease;
}
.grid-btn:hover {
  border-color: var(--color-primary);
  background: linear-gradient(180deg,
    color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    color-mix(in oklch, var(--color-sage-400) 4%, transparent));
  color: var(--color-text);
}
.grid-btn--active {
  border-color: var(--color-primary);
  background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  color: var(--color-primary);
  box-shadow:
    0 0 12px color-mix(in oklch, var(--color-sage-400) 25%, transparent),
    inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.grid-btn--active .grid-btn__sub { color: var(--color-primary); opacity: 0.75; }
.grid-btn--compact { padding: 8px 4px; }
.grid-btn--disabled { opacity: 0.4; cursor: not-allowed; }
.grid-btn--disabled:hover { border-color: var(--color-border); background: rgba(255, 255, 255, 0.03); color: var(--color-text-secondary); }

/* Scale toggle (1X / 2X) */
.scale-toggle { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.scale-btn {
  padding: 3px 10px; font-size: 0.68rem; font-weight: 600;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.03); color: var(--color-text-secondary);
  cursor: pointer; transition: all 0.2s;
}
.scale-btn:hover { border-color: var(--color-primary); }
.scale-btn--active { border-color: var(--color-primary); background: color-mix(in oklch, var(--color-sage-400) 15%, transparent); color: var(--color-primary); }

/* Width / Height inputs */
.size-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 6px; }
.size-input-group { display: flex; flex-direction: column; gap: 3px; }

/* Status text */
.status-text { font-size: 0.75rem; color: var(--color-primary); margin-top: 6px; }

/* ── NPC Preview Panel (full width, below form) ── */
.npc-preview-panel {
  /* 55/45 split gives the image enough canvas for portrait aspect ratios
     while keeping character data readable. Was 50/50 with a tiny image. */
  display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 0;
  margin-top: var(--space-md);
  border: 1px solid var(--color-border); border-radius: var(--radius-lg);
  background: var(--color-surface); overflow: hidden;
}
.npc-preview-image-col { border-right: 1px solid var(--color-border); display: flex; flex-direction: column; min-height: 520px; }
.npc-preview-data-col { display: flex; flex-direction: column; min-height: 520px; }
.npc-preview-header {
  padding: 10px 14px; border-bottom: 1px solid var(--color-border);
  background: rgba(255,255,255,0.02); display: flex; align-items: center; justify-content: space-between;
}
.npc-preview-title { font-size: 0.92rem; font-weight: 700; color: var(--color-text); }
.npc-preview-link {
  font-size: 0.72rem; color: var(--color-primary); background: none; border: none;
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.npc-preview-image-area {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 20px; min-height: 460px;
  background: radial-gradient(circle at center, color-mix(in oklch, var(--color-sage-400) 5%, transparent), transparent 70%);
}
.npc-preview-image-wrap {
  cursor: pointer;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.npc-preview-image-wrap:hover { transform: scale(1.015); }
.npc-preview-image-wrap img,
.npc-preview-image-wrap :deep(.image-display),
.npc-preview-image-wrap :deep(img) {
  /* Max dimensions pinned to viewport so tall portraits stretch to fill the
     canvas while wide scenes still fit. Was hard-capped at 280px which looked
     like a thumbnail inside a giant panel. */
  max-height: min(72vh, 720px);
  max-width: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}
.npc-preview-empty { text-align: center; color: var(--color-text-secondary); font-size: 0.82rem; }
.npc-preview-empty-icon { font-size: 2.5rem; margin-bottom: 8px; opacity: 0.4; }
.npc-preview-data { flex: 1; padding: 16px; overflow-y: auto; }
.npc-preview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
.npc-meta-label { font-size: 0.68rem; color: var(--color-text-secondary); margin-bottom: 2px; }
.npc-meta-value { font-size: 0.82rem; color: var(--color-text); }
.npc-preview-desc-section { border-top: 1px solid var(--color-border); padding-top: 12px; margin-top: 12px; }
.npc-preview-desc-section:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
.npc-preview-desc {
  font-size: 0.78rem; color: var(--color-text-secondary); line-height: 1.6;
  white-space: pre-wrap; margin-top: 4px;
}
.npc-preview-traits {
  display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
}
.npc-preview-trait {
  font-size: 0.72rem;
  padding: 3px 9px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  color: var(--color-primary);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ── Foreground confirm overlay ── */
.confirm-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.confirm-card {
  width: 100%; max-width: 480px;
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); padding: 24px;
  display: flex; flex-direction: column; gap: 14px;
}
.confirm-card--wide {
  max-width: 720px;
  padding: 0;
  gap: 0;
  overflow: hidden;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.confirm-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px;
  padding: 22px 26px 18px;
  border-bottom: 1px solid var(--color-border);
  background: radial-gradient(circle at top right, color-mix(in oklch, var(--color-sage-400) 8%, transparent), transparent 70%);
}
.confirm-close {
  width: 28px; height: 28px;
  padding: 0;
  border: none; border-radius: 6px;
  background: transparent; color: var(--color-text-secondary);
  font-size: 1.2rem; line-height: 1;
  cursor: pointer; transition: all 0.15s;
}
.confirm-close:hover { background: rgba(255, 255, 255, 0.06); color: var(--color-text); }
.confirm-title { font-size: 1.1rem; font-weight: 700; color: var(--color-text); }
.confirm-subtitle { font-size: 0.8rem; color: var(--color-text-secondary); margin-top: 4px; }

.confirm-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 0;
  max-height: 68vh;
  overflow-y: auto;
}
/* Character preview rail — fixed width, sticky visual anchor for the user. */
.confirm-character {
  display: flex; flex-direction: column; align-items: center;
  padding: 20px;
  border-right: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.02);
  text-align: center;
}
.confirm-character-avatar {
  width: 120px; height: 120px;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid var(--color-border);
  background: rgba(0, 0, 0, 0.2);
  margin-bottom: 12px;
}
.confirm-character-avatar__img,
.confirm-character-avatar :deep(.image-display),
.confirm-character-avatar :deep(img) {
  width: 100%; height: 100%; object-fit: cover;
}
.confirm-character-name { font-size: 1rem; font-weight: 700; color: var(--color-text); }
.confirm-character-meta { font-size: 0.72rem; color: var(--color-text-secondary); margin-top: 4px; }
.confirm-character-anchor {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 10px;
  font-size: 0.7rem; color: var(--color-text-secondary);
  padding: 3px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 10px;
}
.confirm-anchor-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.confirm-anchor-dot--on { background: var(--color-success); box-shadow: 0 0 6px color-mix(in oklch, var(--color-success) 60%, transparent); }
.confirm-anchor-dot--off { background: var(--color-text-muted); }
.confirm-anchor-name { color: var(--color-text); font-weight: 500; }
.confirm-character-desc {
  margin-top: 10px;
  font-size: 0.72rem; line-height: 1.5;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
}

.confirm-params-panel {
  padding: 20px 24px;
  display: flex; flex-direction: column; gap: 18px;
}
.confirm-section { display: flex; flex-direction: column; gap: 8px; }
.confirm-section-title {
  font-size: 0.72rem; font-weight: 700;
  color: var(--color-text-secondary);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin: 0; padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
}
.confirm-dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  margin: 0;
}
.confirm-dl-row { display: flex; flex-direction: column; gap: 2px; }
.confirm-dl-row dt { font-size: 0.68rem; color: var(--color-text-secondary); }
.confirm-dl-row dd { margin: 0; font-size: 0.84rem; color: var(--color-text); font-weight: 500; }

.confirm-kv { display: flex; gap: 10px; font-size: 0.78rem; line-height: 1.5; padding: 6px 0; }
.confirm-kv + .confirm-kv { border-top: 1px dashed var(--color-border); }
.confirm-kv-key { flex-shrink: 0; width: 72px; color: var(--color-text-secondary); }
.confirm-kv-value { flex: 1; color: var(--color-text); white-space: pre-wrap; }

/* Legacy compact modal styles — preserved so any un-upgraded callsite still renders. */
.confirm-params {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; background: rgba(255,255,255,0.03);
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
}
.confirm-param { display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--color-text); }
.confirm-param__key { color: var(--color-text-secondary); }
.confirm-progress {
  display: flex; align-items: center; gap: 10px; font-size: 0.82rem;
  color: var(--color-primary); padding: 10px;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent); background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  border-radius: var(--radius-md);
}
.confirm-progress-text { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.confirm-spinner {
  width: 18px; height: 18px; border: 2px solid var(--color-border);
  border-top-color: var(--color-primary); border-radius: 50%;
  animation: spin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
.confirm-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 24px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid var(--color-border);
}
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.grid-btn__label { font-size: 0.82rem; font-weight: 600; color: inherit; }
.grid-btn__sub { font-size: 0.62rem; margin-top: 2px; color: var(--color-text-secondary); }

.npc-summary-card {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: var(--lumi-inset-highlight);
}
.npc-summary-name { font-size: var(--font-size-md); font-weight: 600; color: var(--color-text); }
.npc-summary-meta { font-size: var(--font-size-xs); color: var(--color-text-muted); display: flex; gap: var(--space-sm); margin-top: 2px; }
.badge-major { color: var(--color-warning); font-weight: 500; }
.npc-summary-desc { font-size: var(--font-size-xs); color: var(--color-text-secondary); margin-top: var(--space-xs); line-height: var(--line-height-normal); }

/* Anchor banner */
.anchor-banner {
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
  border: 1px solid;
}
.anchor-banner--active { background: color-mix(in oklch, var(--color-success) 8%, transparent); border-color: color-mix(in oklch, var(--color-success) 30%, transparent); color: var(--color-success); box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-success) 10%, transparent); }
.anchor-banner--inactive { background: color-mix(in oklch, var(--color-amber-400) 8%, transparent); border-color: color-mix(in oklch, var(--color-amber-400) 30%, transparent); color: var(--color-warning); }
.anchor-banner--none { background: var(--color-surface-elevated); border-color: var(--color-border); color: var(--color-text-muted); }
.gen-nav-buttons { display: flex; gap: var(--space-xs); }

.gen-error {
  padding: var(--space-sm); background: var(--color-danger-muted);
  border: 1px solid var(--color-danger); border-radius: var(--radius-md);
  color: var(--color-danger); font-size: var(--font-size-sm);
}

/* ── Per-NPC task status display (Phase 3.1) ── */
.npc-task-status {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  margin-bottom: var(--space-sm);
}
.npc-task-status--active { border-color: var(--color-info); background: linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 6%, transparent), transparent 60%); }
.npc-task-status--complete { border-color: var(--color-success); }
.npc-task-status--failed { border-color: var(--color-danger); }
.task-status-header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm);
}
.task-status-badge {
  display: inline-flex; padding: 2px 8px; border-radius: 9999px;
  font-size: var(--font-size-xs); font-weight: 600; line-height: 1.4;
}
.task-status-badge--info { background: rgba(var(--color-info-rgb, 56, 189, 248), 0.15); color: var(--color-info); }
.task-status-badge--warning { background: rgba(var(--color-warning-rgb, 245, 158, 11), 0.15); color: var(--color-warning); }
.task-status-badge--success { background: rgba(var(--color-success-rgb, 34, 197, 94), 0.15); color: var(--color-success); }
.task-status-badge--danger { background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.15); color: var(--color-danger); }
.task-status-time { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.task-status-progress { font-size: var(--font-size-sm); color: var(--color-info); margin-top: 4px; }
.task-status-error { font-size: var(--font-size-sm); color: var(--color-danger); margin-top: 4px; }

/* Legacy preview styles removed — functionality moved to npc-preview-panel */
.prompt-details { margin-top: var(--space-xs); }
.prompt-details summary { font-size: var(--font-size-xs); color: var(--color-text-muted); cursor: pointer; }
.prompt-text { font-size: var(--font-size-xs); color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; background: var(--color-bg); padding: var(--space-sm); border-radius: var(--radius-sm); margin-top: var(--space-xs); }

.tab-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--space-3xl); color: var(--color-text-muted); gap: var(--space-sm); }
.hint { font-size: var(--font-size-xs); }

/* Task badges (shared) */
.task-badge { padding: 2px 8px; border-radius: var(--radius-xs); font-size: var(--font-size-xs); font-weight: 500; }
.task-badge--complete { background: var(--color-success-muted); color: var(--color-success); }
.task-badge--failed { background: var(--color-danger-muted); color: var(--color-danger); }
.task-badge--generating { background: var(--color-warning-muted); color: var(--color-warning); }
.task-badge--tokenizing { background: var(--color-info); color: var(--color-text-bone); }
.task-badge--pending { background: var(--color-primary-muted); color: var(--color-primary); }
.lora-badge {
  padding: 1px 6px; border-radius: var(--radius-full, 999px); font-size: 10px; font-weight: 500;
  color: var(--color-sage-300); border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

/* Queue tab v2 */
.queue-header-v2 {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
  margin-bottom: var(--space-md); gap: var(--space-md);
}
.queue-clear-buttons { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
.task-list-v2 { display: flex; flex-direction: column; gap: var(--space-md); }
.queue-card-v2 {
  position: relative; padding: var(--space-md);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--duration-fast);
}
.queue-card-v2:hover { border-color: var(--color-primary); box-shadow: var(--lumi-inset-highlight); }
.queue-type-corner {
  position: absolute; top: 0; right: 0;
  padding: 2px 8px; font-size: 10px; color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 212,175,55), 0.1);
  border-bottom: 1px solid var(--color-border); border-left: 1px solid var(--color-border);
  border-bottom-left-radius: var(--radius-md);
}
.queue-card-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-sm); }
.queue-card-title { padding-right: 80px; }
.queue-card-name { font-size: var(--font-size-md); font-weight: 500; color: var(--color-text); }
.queue-card-sub { font-size: 10px; color: var(--color-text-muted); display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-top: 2px; }
.queue-card-status-area { display: flex; align-items: center; gap: var(--space-xs); }
.queue-meta-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-xs); font-size: 11px;
}
.queue-meta-cell {
  padding: var(--space-xs); border: 1px solid var(--color-border);
  border-radius: var(--radius-xs); background: var(--color-surface-elevated);
}
.queue-meta-cell--progress { position: relative; overflow: hidden; }
.queue-meta-cell--progress::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--color-primary); opacity: 0.3;
}
.queue-meta-label { font-size: 10px; color: var(--color-primary); opacity: 0.5; margin-bottom: 2px; }
.queue-meta-value { color: var(--color-text-secondary); font-family: monospace; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-card-failed-actions {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs);
  margin-top: var(--space-sm); padding-top: var(--space-xs); border-top: 1px solid var(--color-border);
}
.queue-card-prompts { margin-top: var(--space-xs); display: flex; flex-direction: column; gap: var(--space-2xs); }
.queue-card-actions-row {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs);
  margin-top: var(--space-sm); padding-top: var(--space-xs); border-top: 1px solid var(--color-border);
}

/* Gallery tab */
.gallery-layout { display: flex; gap: var(--space-md); height: 100%; }
.gallery-npc-list {
  width: 160px; flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  overflow-y: auto; padding-right: var(--space-sm);
  display: flex; flex-direction: column; gap: var(--space-2xs);
}
.gallery-npc-btn {
  display: flex; justify-content: space-between; align-items: center;
  padding: var(--space-xs) var(--space-sm);
  background: transparent; border: 1px solid transparent;
  border-radius: var(--radius-md); color: var(--color-text-secondary);
  font-size: var(--font-size-sm); cursor: pointer;
  transition: all var(--duration-fast);
}
.gallery-npc-btn:hover { background: var(--color-primary-muted); color: var(--color-text); }
.gallery-npc-btn--active {
  background: var(--color-primary-muted); border-color: var(--color-primary);
  color: var(--color-primary); font-weight: 500;
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
.gallery-npc-name { flex: 1; text-align: left; }
.gallery-npc-count {
  background: var(--color-surface-elevated); padding: 1px 6px;
  border-radius: var(--radius-full); font-size: var(--font-size-xs);
}
.gallery-empty-list { padding: var(--space-lg); text-align: center; color: var(--color-text-muted); font-size: var(--font-size-sm); }

.gallery-grid-area { flex: 1; overflow-y: auto; }
.gallery-header {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
  gap: var(--space-sm); margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-md);
}
.gallery-header-left { display: flex; flex-direction: column; gap: var(--space-2xs); }
.gallery-header h3 { font-size: var(--font-size-xl); color: var(--color-primary); margin: 0; }
.gallery-header-badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
.gallery-info-badge {
  padding: 2px 8px; border-radius: var(--radius-xs);
  border: 1px solid var(--color-border); background: var(--color-surface-elevated);
  font-size: 11px; color: var(--color-text-secondary);
}
.gallery-info-badge--count { color: var(--color-primary); border-color: rgba(var(--color-primary-rgb, 212, 175, 55), 0.3); }
.gallery-header-actions { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }

.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-md); }
.gallery-card {
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); overflow: hidden;
  transition: border-color var(--duration-fast), box-shadow var(--duration-normal);
  box-shadow: var(--lumi-inset-highlight);
}
.gallery-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 4px 20px rgba(var(--color-primary-rgb, 212, 175, 55), 0.15);
}
.gallery-card-image { position: relative; aspect-ratio: 3/4; overflow: hidden; }
.gallery-card-image :deep(.img-display) { width: 100%; height: 100%; border-radius: 0; }
.gallery-card-image :deep(.img-display__img) {
  transition: transform 700ms ease;
}
.gallery-card:hover .gallery-card-image :deep(.img-display__img) {
  transform: scale(1.03);
}

/* Overlay badges: stacked column at top-left */
.gallery-overlay-badges {
  position: absolute; top: var(--space-xs); left: var(--space-xs);
  display: flex; flex-direction: column; gap: 4px;
  opacity: 0.9; transition: opacity var(--duration-fast);
}
.gallery-card:hover .gallery-overlay-badges { opacity: 1; }

.gallery-status-badge {
  display: inline-block; width: fit-content;
  padding: 1px 8px; border-radius: var(--radius-xs);
  font-size: 10px; font-weight: 500;
  border: 1px solid; backdrop-filter: blur(4px);
  background: rgba(0, 0, 0, 0.6); box-shadow: 0 1px 4px rgba(0,0,0,0.3);
  text-shadow: 0 0 4px currentColor;
}
.gallery-status-badge--complete { border-color: var(--color-success); color: var(--color-success); }
.gallery-status-badge--failed { border-color: var(--color-danger); color: var(--color-danger); }
.gallery-status-badge--generating,
.gallery-status-badge--tokenizing { border-color: var(--color-warning); color: var(--color-warning); }
.gallery-status-badge--pending { border-color: var(--color-text-muted); color: var(--color-text-muted); }

.gallery-usage-badge {
  display: inline-block; width: fit-content;
  padding: 1px 8px; border-radius: var(--radius-xs);
  font-size: 10px; font-weight: 500;
  border: 1px solid var(--color-primary); color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 212, 175, 55), 0.2);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  box-shadow: 0 0 10px rgba(var(--color-primary-rgb, 212, 175, 55), 0.3);
}
.gallery-usage-badge--ref {
  border-color: var(--color-sage-400, #a3be8c);
  color: var(--color-sage-400, #a3be8c);
  background: rgba(163, 190, 140, 0.15);
  box-shadow: none;
}
.gallery-usage-badge--secret {
  border-color: var(--color-rose-400, #eb6f92);
  color: var(--color-rose-400, #eb6f92);
  background: rgba(235, 111, 146, 0.15);
  box-shadow: 0 0 8px rgba(235, 111, 146, 0.25);
}
.gallery-card-meta {
  padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-xs);
  background: linear-gradient(to bottom, transparent, rgba(0,0,0,0.15));
}
.gallery-meta-top {
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-2xs);
}
.gallery-meta-comp { font-size: var(--font-size-sm); color: var(--color-primary); opacity: 0.9; }
.gallery-meta-time { font-size: 10px; color: var(--color-text-muted); font-family: monospace; }
.gallery-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-xs); }
.gallery-meta-cell {
  border: 1px solid var(--color-border); background: var(--color-surface-elevated);
  border-radius: var(--radius-xs); padding: var(--space-2xs) var(--space-xs);
  text-align: center; cursor: help;
  transition: color var(--duration-fast);
}
.gallery-meta-cell--wide { grid-column: 1 / -1; text-align: left; }
.gallery-meta-cell:hover { color: var(--color-text); }
.gallery-meta-label { font-size: 10px; color: var(--color-primary); opacity: 0.5; margin-bottom: 2px; }
.gallery-meta-value { font-size: 11px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gallery-card-prompts { display: flex; flex-direction: column; gap: var(--space-2xs); margin-top: var(--space-2xs); }
.gallery-card-actions {
  padding: var(--space-xs) var(--space-sm) var(--space-sm);
  display: flex; flex-direction: column; gap: var(--space-2xs);
  border-top: 1px solid var(--color-border);
}
.gallery-actions-row {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2xs);
}

/* Scene tab v2 */
.scene-layout-v2 { display: flex; flex-direction: column; gap: var(--space-lg); }
.scene-left-col { display: flex; flex-direction: column; gap: var(--space-md); }
.scene-right-col {
  display: flex; flex-direction: column; gap: var(--space-lg);
}
.scene-section { display: flex; flex-direction: column; gap: var(--space-2xs); }
.scene-stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-xs); }
.scene-limit-row { display: flex; align-items: center; gap: var(--space-xs); margin-top: var(--space-2xs); }
.scene-limit-input { width: 80px; }
.scene-status-text {
  padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-md);
  border: 1px solid var(--color-primary); background: rgba(var(--color-primary-rgb, 212,175,55), 0.1);
  color: var(--color-primary); font-size: var(--font-size-sm);
}
.scene-form-actions { display: flex; gap: var(--space-sm); align-items: center; }

/* Round selector */
.round-selector {
  max-height: 200px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  padding: var(--space-2xs);
}
.round-selector__item {
  display: flex; align-items: center; gap: var(--space-xs);
  padding: var(--space-2xs) var(--space-xs);
  border-radius: var(--radius-sm);
  cursor: pointer; user-select: none;
  font-size: var(--font-size-sm); color: var(--color-text-muted);
  transition: background var(--duration-fast);
}
.round-selector__item:hover { background: rgba(255,255,255,0.04); }
.round-selector__item--selected { color: var(--color-text); background: rgba(var(--color-primary-rgb, 212,175,55), 0.08); box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent); }
.round-selector__check { flex-shrink: 0; width: 16px; text-align: center; font-size: 13px; }
.round-selector__label { flex-shrink: 0; font-weight: 500; white-space: nowrap; }
.round-selector__preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; font-size: 11px; }

/* NPC selector */
.npc-selector__header { display: flex; align-items: center; justify-content: space-between; }
.npc-selector__actions { display: flex; gap: var(--space-xs); }
.npc-selector__link {
  background: none; border: none; color: var(--color-primary);
  font-size: 11px; cursor: pointer; padding: 0;
  text-decoration: underline; text-underline-offset: 2px;
}
.npc-selector__link:hover { opacity: 0.8; }
.npc-selector {
  display: flex; flex-wrap: wrap; gap: var(--space-2xs);
}
.npc-selector__item {
  display: flex; align-items: center; gap: 4px;
  padding: 3px var(--space-xs);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  cursor: pointer; user-select: none;
  font-size: var(--font-size-sm); color: var(--color-text-muted);
  transition: all var(--duration-fast);
}
.npc-selector__item:hover { border-color: var(--color-primary); }
.npc-selector__item--selected {
  color: var(--color-text);
  border-color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 212,175,55), 0.1);
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.npc-selector__check { font-size: 12px; flex-shrink: 0; }
.npc-selector__name { white-space: nowrap; }
.npc-selector__badge {
  font-size: 9px; padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: rgba(var(--color-success-rgb, 76,175,80), 0.15);
  color: var(--color-success, #4CAF50);
}
.npc-selector__badge--player {
  background: rgba(var(--color-primary-rgb, 212,175,55), 0.15);
  color: var(--color-primary, #d4af37);
}

/* Scene queue section */
.scene-queue-section { display: flex; flex-direction: column; }
.scene-queue-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-xs); }
.scene-queue-actions { display: flex; gap: var(--space-2xs); }
.scene-queue-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2xs); }
.scene-queue-card {
  padding: var(--space-xs) var(--space-sm); border: 1px solid var(--color-border);
  border-radius: var(--radius-md); background: var(--color-surface-elevated);
}
.scene-queue-card-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); }
.scene-queue-summary { font-size: var(--font-size-sm); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scene-queue-card-meta { font-size: 10px; color: var(--color-text-muted); margin-top: 2px; }

/* Scene history section */
.scene-history-section { display: flex; flex-direction: column; }
.scene-history-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-sm); }
.scene-history-count { font-size: 10px; color: var(--color-text-muted); }
.scene-history-grid {
  flex: 1; overflow-y: auto; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: var(--space-md); padding-bottom: var(--space-md);
}
.scene-history-card {
  background: var(--color-surface-elevated); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); overflow: hidden;
  transition: border-color var(--duration-fast), box-shadow var(--duration-normal);
}
.scene-history-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 4px 20px rgba(var(--color-primary-rgb, 212, 175, 55), 0.15);
}
.scene-history-card-image { position: relative; aspect-ratio: 16/9; overflow: hidden; }
.scene-history-card-image :deep(.img-display) { width: 100%; height: 100%; border-radius: 0; }
.scene-history-card-body { padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-2xs); }
.scene-history-card-top { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-2xs); }
.scene-history-card-time { font-size: 10px; color: var(--color-text-muted); font-family: monospace; }
.scene-history-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2xs); margin-top: var(--space-xs); }

/* Wallpaper card (shared) */
.wallpaper-card {
  position: relative; border-radius: var(--radius-lg); overflow: hidden;
  border: 1px solid var(--color-border); cursor: pointer;
  box-shadow: var(--lumi-inset-highlight);
  transition: border-color var(--duration-fast);
}
.wallpaper-card:hover { border-color: var(--color-primary); }
.wallpaper-card :deep(.img-display) { width: 100%; height: auto; aspect-ratio: 16/9; border-radius: 0; }
.wallpaper-badge {
  position: absolute; top: var(--space-xs); right: var(--space-xs);
  padding: 2px 8px; border-radius: var(--radius-xs);
  border: 1px solid var(--color-primary); color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 212, 175, 55), 0.2);
  backdrop-filter: blur(4px); font-size: 10px;
}
.wallpaper-placeholder {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: var(--space-xl); border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg); color: var(--color-text-muted);
  gap: var(--space-xs);
}

/* History tab v2 */
.history-header-v2 {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
  margin-bottom: var(--space-md); gap: var(--space-md);
}
.history-header-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
.history-list-v2 { display: flex; flex-direction: column; gap: var(--space-md); }
.history-card-v2 {
  display: flex; flex-direction: row;
  background: linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 2%, var(--color-surface)), var(--color-surface));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); overflow: hidden;
  transition: border-color var(--duration-fast), box-shadow var(--duration-normal);
}
.history-card-v2:hover {
  border-color: var(--color-primary);
  box-shadow: 0 4px 20px rgba(var(--color-primary-rgb, 212, 175, 55), 0.15);
}
/* Tooltip wrappers around block-level clickable image cards must not collapse
   to inline-flex; keep them transparent to the card grid/flex layout. */
.history-card-image-v2 {
  width: 33.33%; flex-shrink: 0; position: relative; overflow: hidden;
  aspect-ratio: 3/4; border-right: 1px solid var(--color-border);
}
.history-card-image-v2--landscape { aspect-ratio: 16/9; min-height: 240px; }
.history-card-image-v2 :deep(.img-display) { width: 100%; height: 100%; border-radius: 0; }
.history-card-image-v2 :deep(.img-display__img) {
  transition: transform 700ms ease;
}
.history-card-v2:hover .history-card-image-v2 :deep(.img-display__img) {
  transform: scale(1.03);
}
.history-type-badge-v2 {
  display: inline-block; width: fit-content;
  padding: 1px 8px; border-radius: var(--radius-xs);
  font-size: 10px; font-weight: 500;
  border: 1px solid var(--color-primary); color: var(--color-primary);
  background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
}
.history-card-body-v2 {
  flex: 1; padding: var(--space-md);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.history-card-title-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-sm);
  border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-sm);
}
.history-card-name-v2 { font-size: var(--font-size-lg); font-weight: 500; color: var(--color-text); }
.history-card-sub-v2 {
  font-size: 10px; color: var(--color-text-muted);
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-top: 2px;
}
.history-comp-badge {
  padding: 1px 6px; border-radius: var(--radius-xs);
  border: 1px solid var(--color-border); background: var(--color-surface-elevated);
  color: var(--color-primary); font-size: 10px;
}
.history-meta-grid-v2 {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-xs);
}
.history-meta-cell-v2 {
  padding: var(--space-xs); border: 1px solid var(--color-border);
  border-radius: var(--radius-xs); background: var(--color-surface-elevated);
}
.history-meta-cell-v2--wide { grid-column: 1 / -1; text-align: left; }
.history-meta-cell-v2--error {
  border-color: color-mix(in oklch, var(--color-danger) 30%, transparent); background: color-mix(in oklch, var(--color-danger) 5%, transparent);
  color: var(--color-danger); font-size: var(--font-size-xs);
}
.history-meta-label-v2 { font-size: 10px; color: var(--color-primary); opacity: 0.5; margin-bottom: 2px; }
.history-meta-value-v2 { font-size: var(--font-size-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-details-v2 { display: flex; flex-direction: column; gap: var(--space-2xs); }
.history-actions-v2 {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs);
  margin-top: auto; padding-top: var(--space-xs); border-top: 1px solid var(--color-border);
}

/* Settings tab */
.settings-tab { display: flex; flex-direction: column; gap: var(--space-md); }
.settings-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);
  padding: var(--space-xs) 0;
}
.settings-row-inline { display: flex; align-items: center; gap: var(--space-sm); }
.settings-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md); }
.settings-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-md); }

/* Presets tab */
.presets-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--space-lg); }
.presets-sidebar { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.presets-scope-toggle { display: flex; gap: var(--space-2xs); }
.presets-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2xs); }
/* Preset card header */
.preset-card-header {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
  gap: var(--space-sm); margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-sm);
}
.preset-card-actions { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
/* PNG preset list with thumbnails */
.png-preset-list-col { width: 220px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.png-preset-list { max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-xs); }
.preset-item--png { padding: var(--space-xs); }
.png-preset-item-inner { display: flex; gap: var(--space-xs); align-items: center; }
.png-preset-thumb {
  width: 80px; height: 56px; flex-shrink: 0; border-radius: var(--radius-xs);
  border: 1px solid var(--color-border); overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--color-bg); font-size: 10px;
}
.png-preset-thumb img { width: 100%; height: 100%; object-fit: cover; }
.png-preset-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.png-import-footer { margin-top: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--color-border); }
.png-import-status { display: flex; align-items: center; gap: var(--space-xs); }
/* Artist preset controls (scope + dropdown) */
.artist-preset-controls {
  display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: var(--space-md);
  margin-bottom: var(--space-md);
}
.artist-preset-editor { display: flex; flex-direction: column; gap: var(--space-md); padding-top: var(--space-sm); border-top: 1px solid var(--color-border); }
/* PNG editor header */
.png-cover-area {
  width: 120px; flex-shrink: 0;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  overflow: hidden; aspect-ratio: 4/3;
  display: flex; align-items: center; justify-content: center;
  background: var(--color-bg); font-size: 10px; color: var(--color-text-muted);
}
.png-cover-area img { width: 100%; height: 100%; object-fit: cover; }
.png-source-meta { display: flex; flex-direction: column; gap: 2px; }
.preset-item {
  display: flex; flex-direction: column; padding: var(--space-xs) var(--space-sm);
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-md);
  text-align: left; cursor: pointer; color: var(--color-text-secondary);
  font-size: var(--font-size-sm); transition: all var(--duration-fast);
}
.preset-item:hover { background: var(--color-primary-muted); }
.preset-item--active { border-color: var(--color-primary); background: var(--color-primary-muted); color: var(--color-primary); box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 12%, transparent); }
.preset-item-name { font-weight: 500; }
.preset-item-preview { font-size: var(--font-size-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.presets-actions { display: flex; gap: var(--space-2xs); align-items: center; }
.presets-actions .form-input { flex: 1; }
.presets-editor { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
.presets-editor-actions { display: flex; gap: var(--space-sm); }
.transformer-section {
  margin-top: var(--space-lg); padding: var(--space-md);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.transformer-crud-layout { display: flex; gap: var(--space-lg); margin-top: var(--space-sm); }
.transformer-sidebar { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.transformer-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2xs); max-height: 200px; }
.transformer-editor { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
.transformer-scope-toggle { display: flex; gap: var(--space-2xs); }
.transformer-empty { padding: var(--space-sm); text-align: center; }

/* Preset card sections (bordered card pattern with corner badge) */
.preset-card {
  position: relative; margin-bottom: var(--space-lg); padding: var(--space-md);
  padding-top: calc(var(--space-md) + 4px);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  transition: border-color var(--duration-fast);
}
.preset-card:hover { border-color: var(--color-primary); }
.preset-card-badge {
  position: absolute; top: 0; right: 0;
  padding: 2px 8px; font-size: 10px; color: var(--color-primary);
  background: rgba(var(--color-primary-rgb, 212,175,55), 0.1);
  border-bottom: 1px solid var(--color-border); border-left: 1px solid var(--color-border);
  border-bottom-left-radius: var(--radius-md);
  z-index: 1;
  max-width: 40%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.understanding-panel { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) 0; }
.understanding-header { display: flex; align-items: center; gap: var(--space-sm); }
.understanding-preview { flex-shrink: 0; }
.understanding-controls { display: flex; flex-direction: column; gap: var(--space-xs); }
.understanding-result { display: flex; flex-direction: column; gap: var(--space-sm); border-top: 1px solid var(--color-border); padding-top: var(--space-sm); }
.understanding-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.understanding-tag { font-size: 0.7rem; padding: 2px 6px; border-radius: var(--radius-sm); background: rgba(163, 190, 140, 0.1); color: var(--color-sage-300, #b5cea8); }
.understanding-tag-conf { color: var(--color-text-muted); margin-left: 2px; }
.model-guide { display: flex; flex-direction: column; gap: var(--space-xs); padding-top: var(--space-xs); }
.model-guide-chips { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.model-chip {
  display: flex; flex-direction: column; gap: 1px; text-align: left; cursor: pointer;
  padding: 4px 8px; border: none; border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.04); color: var(--color-text-secondary);
  font-family: inherit; transition: background 0.15s ease, color 0.15s ease;
}
.model-chip:hover { background: rgba(163, 190, 140, 0.12); color: var(--color-text-primary); }
.model-chip--active { background: rgba(163, 190, 140, 0.16); color: var(--color-sage-300, #b5cea8); }
.model-chip-id { font-size: 0.75rem; font-family: var(--font-mono, monospace); }
.model-chip-note { font-size: 0.65rem; color: var(--color-text-muted); }
.model-guide-list { margin: 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 2px; }
.model-guide-list li { font-size: 0.7rem; color: var(--color-text-muted); line-height: 1.5; }
.model-guide-link { color: var(--color-sage-300, #b5cea8); text-decoration: none; }
.model-guide-link:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) { .model-chip { transition: none; } }
.understanding-save-row { display: flex; gap: var(--space-sm); }
.ref-lib-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-sm); margin-bottom: var(--space-sm); }
.ref-lib-header { margin-bottom: var(--space-xs); }
.ref-lib-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.ref-lib-item { display: flex; align-items: center; gap: var(--space-xs); padding: 4px; border-radius: var(--radius-sm); background: rgba(255,255,255,0.02); }
.ref-lib-thumb { width: 48px; height: 34px; border-radius: 3px; overflow: hidden; flex-shrink: 0; background: rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; }
.ref-lib-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ref-lib-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ref-lib-name { font-size: 0.75rem; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ref-lib-actions { flex-shrink: 0; }
.preset-subgroups { display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs) 0; }
.preset-subgroup-label { font-size: 0.75rem; color: var(--color-text-muted); }
.preset-subgroup-label--active { color: var(--color-sage-400); font-weight: 500; }
.preset-subgroup-sep { color: var(--color-text-muted); font-size: 0.65rem; }
.ref-controls { display: flex; flex-direction: column; gap: var(--space-2xs); padding: var(--space-xs) 0 0 var(--space-sm); border-left: 2px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent); margin-left: 2px; }
.ref-marks { display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--color-text-muted); }
.ref-upload-btn { display: inline-block; padding: 4px 12px; font-size: 0.8rem; border: 1px dashed var(--color-border); border-radius: var(--radius-sm); color: var(--color-text-secondary); cursor: pointer; transition: border-color var(--duration-fast); }
.ref-upload-btn:hover { border-color: var(--color-sage-400); }
.replicate-preview { display: flex; flex-direction: column; gap: var(--space-xs); margin-top: var(--space-xs); }
.replicate-group { display: flex; flex-direction: column; gap: 2px; }
.replicate-group-label { font-size: 0.7rem; font-weight: 500; }
.replicate-group-label--ok { color: var(--color-sage-400, #a3be8c); }
.replicate-group-label--na { color: var(--color-text-muted); }
.replicate-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.replicate-chip { font-size: 0.7rem; padding: 1px 6px; border-radius: var(--radius-sm); }
.replicate-chip--ok { background: rgba(163, 190, 140, 0.12); color: var(--color-sage-300, #b5cea8); }
.replicate-chip--na { background: rgba(255, 255, 255, 0.04); color: var(--color-text-muted); }
.auto-bindings { margin-bottom: var(--space-lg); padding: var(--space-md); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
.bindings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md); margin-top: var(--space-sm); }

/* Rules tab */
.rules-layout { display: flex; flex-direction: column; gap: var(--space-md); }
.rules-header { display: flex; justify-content: space-between; align-items: center; }
.rules-header-actions { display: flex; gap: var(--space-xs); align-items: center; }
.rules-scope-tabs { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.rules-template-section {
  padding: var(--space-md); background: var(--color-surface);
  border: 1px solid var(--color-border); border-radius: var(--radius-lg);
}
.rules-template-header {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
  gap: var(--space-sm); margin-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-sm);
}
/* Model rulesets collapsible */
.model-ruleset-section {
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.model-ruleset-toggle {
  display: flex; align-items: center; gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  width: 100%; background: transparent; border: none;
  cursor: pointer; color: var(--color-text); text-align: left;
  transition: background var(--duration-fast);
}
.model-ruleset-toggle:hover { background: var(--color-primary-muted); }
.model-ruleset-active-name {
  font-size: var(--font-size-xs); color: var(--color-primary);
  padding: 1px 6px; border-radius: var(--radius-xs);
  background: var(--color-primary-muted);
}
.model-ruleset-expand-text { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.model-ruleset-body { padding: var(--space-md); border-top: 1px solid var(--color-border); }
.model-ruleset-actions { display: flex; gap: var(--space-xs); margin-bottom: var(--space-md); }
.model-ruleset-two-col { display: flex; gap: var(--space-lg); }
.model-ruleset-left { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-md); }
.model-ruleset-right { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }

.rules-two-col { display: flex; gap: var(--space-lg); }
.rules-left-col { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-md); }
.rules-right-col { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
.rules-crud-buttons { display: flex; gap: var(--space-xs); }
.form-input {
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}
.form-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.form-hint { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: var(--space-2xs); }

/* Stats bar */
.stats-bar {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: var(--space-sm); padding: var(--space-sm) 0;
}
.stat-card {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.12);
}
.stat-value { font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text); font-family: var(--font-mono); }
.stat-label { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.stat-card--success .stat-value { color: var(--color-success); }
.stat-card--danger .stat-value { color: var(--color-danger); }
.stat-card--info .stat-value { color: var(--color-info); }
.stat-card--warning .stat-value { color: var(--color-warning); }
.stat-card--bar { justify-content: center; }

/* Preset preview in manual form */
.preset-preview { margin-top: 2px; padding: var(--space-2xs) var(--space-xs); background: var(--color-surface-elevated); border-radius: var(--radius-xs); }

/* ── Secret part section (fuchsia theme) ── */
.secret-section {
  margin-top: var(--space-md); padding: 16px;
  border: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 30%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in oklch, var(--color-fuchsia-base) 4%, transparent);
}
.secret-header-row { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 15%, transparent); padding-bottom: 10px; margin-bottom: 12px; }
.secret-title { font-size: 0.95rem; font-weight: 700; color: var(--color-fuchsia); margin: 0; }
.secret-desc { font-size: 0.68rem; color: var(--color-text-secondary); margin: 3px 0 0; }
.secret-all-btn {
  padding: 5px 12px; font-size: 0.72rem; font-weight: 500;
  border: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 40%, transparent); border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-fuchsia-base) 10%, transparent); color: var(--color-fuchsia-bright); cursor: pointer;
  transition: all 0.2s;
}
.secret-all-btn:hover { background: color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent); }
.secret-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.secret-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
.secret-status { padding: 8px 10px; border: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 25%, transparent); background: color-mix(in oklch, var(--color-fuchsia-base) 8%, transparent); border-radius: var(--radius-md); font-size: 0.78rem; color: var(--color-fuchsia-bright); margin-bottom: 12px; }
.secret-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.secret-card { border: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent); background: rgba(0,0,0,0.3); border-radius: var(--radius-md); padding: 10px; display: flex; flex-direction: column; gap: 6px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-shadow: var(--lumi-inset-highlight), inset 0 0 12px color-mix(in oklch, var(--color-fuchsia-base) 4%, transparent); }
.secret-card-header { display: flex; align-items: center; justify-content: space-between; }
.secret-card-label { font-size: 0.82rem; font-weight: 600; color: var(--color-fuchsia-bright); }
.secret-card-btn {
  font-size: 0.62rem; padding: 3px 8px;
  border: 1px solid color-mix(in oklch, var(--color-fuchsia-base) 35%, transparent); border-radius: var(--radius-sm);
  background: rgba(0,0,0,0.5); color: var(--color-fuchsia); cursor: pointer;
}
.secret-card-btn:hover { background: color-mix(in oklch, var(--color-fuchsia-base) 15%, transparent); }
.secret-card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.secret-card-image {
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  overflow: hidden;
  position: relative;
}
.secret-card-image--has-img {
  cursor: zoom-in;
  transition: transform 0.2s;
}
.secret-card-image--has-img:hover { transform: scale(1.02); box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-400) 20%, transparent); }
.secret-card-img,
.secret-card-image :deep(img),
.secret-card-image :deep(.image-display) {
  width: 100%; height: 100%;
  object-fit: cover;
}
.secret-card-placeholder {
  width: 100%; height: 100%;
  border: 1px dashed color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent);
  background: rgba(0,0,0,0.15);
  display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; color: var(--color-text-secondary);
}

/* Fuchsia-themed grid buttons */
.grid-btn--fuchsia { border-color: color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent); }
.grid-btn--fuchsia:hover { border-color: color-mix(in oklch, var(--color-fuchsia-base) 50%, transparent); background: color-mix(in oklch, var(--color-fuchsia-base) 6%, transparent); }
.grid-btn--fuchsia-active {
  border-color: var(--color-fuchsia) !important; background: color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent) !important;
  color: var(--color-fuchsia-bright) !important; box-shadow: 0 0 10px color-mix(in oklch, var(--color-fuchsia-base) 20%, transparent);
}
.form-textarea--fuchsia { border-color: color-mix(in oklch, var(--color-nsfw) 20%, transparent); }
.form-textarea--fuchsia:focus { border-color: var(--color-nsfw); }
.secret-header { font-size: var(--font-size-sm); color: var(--color-nsfw); margin-bottom: var(--space-2xs); }
.secret-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: var(--space-sm); }
.secret-parts { display: flex; gap: var(--space-sm); }

/* PNG import */
.presets-import { display: flex; flex-direction: column; gap: var(--space-2xs); }
.png-import-btn {
  display: inline-flex; align-items: center; gap: var(--space-2xs);
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface-elevated); border: 1px dashed var(--color-border);
  border-radius: var(--radius-md); color: var(--color-text-secondary);
  font-size: var(--font-size-xs); cursor: pointer;
  transition: border-color var(--duration-fast);
}
.png-import-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.png-status { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.png-status--loading { color: var(--color-warning); }
/* Anchor management */
.anchor-section {
  margin-bottom: var(--space-lg); padding: var(--space-md);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.anchor-layout { display: flex; gap: var(--space-lg); margin-top: var(--space-sm); }
.anchor-list-col { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.anchor-list { max-height: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2xs); }
.anchor-editor-col { flex: 1; display: flex; flex-direction: column; gap: var(--space-md); }
.anchor-actions-row { display: flex; gap: var(--space-xs); }
.anchor-extract-msg {
  padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-md);
  font-size: var(--font-size-xs); border: 1px solid;
}
.anchor-extract-msg--info { border-color: var(--color-primary); background: rgba(var(--color-primary-rgb, 212,175,55), 0.08); color: var(--color-primary); }
.anchor-extract-msg--done { border-color: var(--color-success); background: color-mix(in oklch, var(--color-success) 8%, transparent); color: var(--color-success); }
.anchor-extract-msg--error { border-color: var(--color-danger); background: color-mix(in oklch, var(--color-danger) 8%, transparent); color: var(--color-danger); }
.anchor-toggles { display: flex; flex-direction: column; gap: var(--space-xs); }
.anchor-badges { display: flex; gap: var(--space-2xs); }
.anchor-badge--on { font-size: var(--font-size-xs); color: var(--color-success); }
.anchor-badge--off { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.anchor-badge--link { font-size: var(--font-size-xs); color: var(--color-info); }
.anchor-features {
  background: var(--color-bg); border-radius: var(--radius-md); padding: var(--space-sm);
  display: flex; flex-direction: column; gap: var(--space-2xs);
}
.anchor-feature-row { display: flex; gap: var(--space-sm); align-items: baseline; }
.anchor-status-card {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface-elevated); border-radius: var(--radius-md);
}

.presets-io { display: flex; gap: var(--space-2xs); margin-top: var(--space-2xs); }

/* PNG deep editor */
.png-editor-header {
  display: flex; align-items: center; gap: var(--space-sm);
  padding: var(--space-xs); background: var(--color-surface-elevated);
  border-radius: var(--radius-md); margin-bottom: var(--space-xs);
}
.png-cover-thumb { width: 80px; height: 56px; object-fit: cover; border-radius: var(--radius-sm); flex-shrink: 0; }
.png-no-cover {
  width: 80px; height: 56px; display: flex; align-items: center; justify-content: center;
  background: var(--color-bg); border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm); font-size: var(--font-size-xs); color: var(--color-text-muted); flex-shrink: 0;
}
.png-source-info { display: flex; flex-direction: column; gap: 2px; }
.png-metadata-details { margin-top: var(--space-xs); }
.png-metadata-details summary {
  font-size: var(--font-size-xs); color: var(--color-text-muted); cursor: pointer;
  padding: var(--space-2xs) 0;
}
.png-metadata-details summary:hover { color: var(--color-primary); }
.png-metadata-content { display: flex; flex-direction: column; gap: var(--space-sm); margin-top: var(--space-xs); }
.png-meta-block { display: flex; flex-direction: column; gap: var(--space-2xs); }

.form-advanced {
  margin-top: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px dashed var(--color-border);
  border-radius: 6px;
}
.form-advanced > summary {
  cursor: pointer;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
  user-select: none;
}
.form-advanced[open] > summary {
  margin-bottom: 8px;
  color: var(--color-text);
}
.backend-status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--ok {
  background: var(--color-success);
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-success) 40%, transparent),
              0 0 12px color-mix(in oklch, var(--color-success) 20%, transparent);
}
.status-dot--off { background: var(--color-text-muted); }
.backend-status-label { font-weight: 600; color: var(--color-text); }
.backend-status-model { color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.backend-status-warn { color: var(--color-warning); font-size: 0.75rem; }

.form-textarea--error {
  border-color: var(--color-danger) !important;
}

/* ─── Mobile: stack sidebars, fullwidth forms ─── */
@media (max-width: 767px) {
  .image-panel {
    padding-left: var(--space-sm);
    padding-right: var(--space-sm);
    transition: none;
    overflow-x: hidden;
  }
  .image-panel * {
    max-width: 100%;
    box-sizing: border-box;
  }
  .presets-sidebar,
  .png-preset-list-col,
  .transformer-sidebar,
  .model-ruleset-left,
  .rules-left-col,
  .anchor-list-col {
    width: 100%;
    flex-shrink: 1;
  }
  .gallery-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  }
  /* Prevent any horizontal scrolling within tab content */
  .tab-content {
    overflow-x: hidden;
  }
}
</style>
