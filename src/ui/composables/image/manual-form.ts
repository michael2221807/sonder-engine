/**
 * Manual-generation form state, backend capability flags and the reference-image settings read from the state tree (R7 step 3). IMAGE_BACKEND_KEYS moved in with it because `backend` reads it.
 */
import { ref, computed, watch } from 'vue';
import type { ImageBackendType } from '@/engine/image/types';
import { PROVIDER_CAPABILITIES } from '@/engine/image/provider-capabilities';
import type { MultiReferenceItem } from '@/ui/components/shared/MultiReferencePicker.vue';
import { providerCatalog } from '@/engine/providers';
import type { GetState } from './panel-deps';

export interface UseManualFormDeps {
  get: GetState;
}

export function useManualForm(deps: UseManualFormDeps) {
  const { get } = deps;

  const IMAGE_BACKEND_KEYS = providerCatalog.byCategory('image').map((d) => d.id) as ImageBackendType[];

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

  return {
    IMAGE_BACKEND_KEYS,
    selectedNpc,
    composition,
    customComposition,
    artStyle,
    backend,
    extraPrompt,
    selectedArtistPreset,
    selectedPngPreset,
    sizePreset,
    sizeScale,
    manualWidth,
    manualHeight,
    backgroundMode,
    backendSupportsImg2Img,
    backendSupportsRefStrength,
    backendSupportsMultiRef,
    npcReferenceEnabled,
    npcReferenceItems,
    npcReferenceSource,
    npcReferenceDenoise,
    npcReferenceFile,
    npcReferenceDataUrl,
    npcReferenceAssetId,
    npcReferenceNoise,
    refConfigDenoiseDefault,
    refConfigMaxUploadBytes,
    refConfigPersist,
  };
}
