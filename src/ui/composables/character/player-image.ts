/**
 * The player's own image generation, moved verbatim out of CharacterDetailsPanel.vue (refactor R7 step 7).
 *
 * `usePlayerImage` holds the backend resolution, reference-redraw state, anchor management, generation, archive
 * actions and the regenerate-same flow. `usePlayerSecretParts` holds the secret-part close-ups. Both are called by
 * the panel at the position where the original code stood, so every watch and computed is created in the same order.
 * No lifecycle hooks are registered here (the panel keeps its onUnmounted). The player's basic fields are declared
 * later in the panel, so they are passed as getters and only read when a function runs.
 */
import { ref, computed, watch } from 'vue';
import type { ComposerTranslation } from 'vue-i18n';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { extractAnchorViaAI } from '@/engine/image/anchor-extractor';
import { providerCatalog } from '@/engine/providers';
import type { useAPIManagementStore } from '@/engine/stores/engine-api';
import type { AIService } from '@/engine/ai/ai-service';
import type { ImageService } from '@/engine/image/image-service';
import type { ImageBackendType, CivitaiLoraSnapshot, SecretPartType } from '@/engine/image/types';
import { buildPromptStyleInjection, type PromptStylePresetLike } from '@/engine/image/style-preset-injection';
import { resolveStyleParams } from '@/engine/image/style-param-resolver';
import { PROVIDER_CAPABILITIES } from '@/engine/image/provider-capabilities';
import { SEEDREAM_MAX_REFERENCE_IMAGES } from '@/engine/image/providers/volcengine';
import type { ArtistPreset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import type { MultiReferenceItem } from '@/ui/components/shared/MultiReferencePicker.vue';
import { appendReferenceFiles, readFileAsDataUrl } from '@/ui/components/shared/multi-reference-files';
import { listConfiguredImageBackends, extractLoraSnapshot, copyAssetToReferenceLibrary } from '@/ui/composables/image/image-backends';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
import type { UseGameStateReturn } from '@/ui/composables/useGameState';

const P = DEFAULT_ENGINE_PATHS;

export interface PlayerImageDeps {
  t: ComposerTranslation;
  get: UseGameStateReturn['get'];
  setValue: UseGameStateReturn['setValue'];
  useValue: UseGameStateReturn['useValue'];
  imageService: ImageService | undefined;
  aiService: AIService | undefined;
  apiStore: ReturnType<typeof useAPIManagementStore>;
  getGender: () => string | undefined;
  getAge: () => number | undefined;
  getOccupation: () => string | undefined;
  getTraitText: () => string;
  getName: () => string | undefined;
  getNsfwEnabled: () => boolean;
}

export function usePlayerImage(deps: PlayerImageDeps) {
  const { t, get, setValue, useValue, imageService, aiService, apiStore, getGender, getAge, getOccupation, getTraitText, getName, getNsfwEnabled } = deps;
  // Catalog-derived (epic P0 §3.3) — mirrors ImagePanel.configuredBackends.
  const IMAGE_BACKEND_KEYS = providerCatalog.byCategory('image').map((d) => d.id) as ImageBackendType[];
  const configuredImageBackends = computed(() => {
    apiStore.apiConfigs; apiStore.apiAssignments;
    return listConfiguredImageBackends(apiStore.apiConfigs, apiStore.apiAssignments, IMAGE_BACKEND_KEYS);
  });

  const availableBackendOptions = computed(() => {
    // Catalog-derived; labels via the shared api.backend.* i18n keys.
    const ALL: SelectOption[] = providerCatalog
      .byCategory('image')
      .map((d) => ({ label: t(`api.backend.${d.id}`), value: d.id }));
    const available = configuredImageBackends.value;
    if (available.size === 0) return [{ label: t('character.image.noImageApi'), value: '' }];
    return ALL.filter((o) => available.has(o.value));
  });

  // Catalog-derived (review Critical 2026-08-26: a hand-written set here
  // silently coerced newly-added backends back to novelai).
  const VALID_BACKENDS = new Set<string>(IMAGE_BACKEND_KEYS);
  function resolveDefaultBackend(): ImageBackendType {
    const raw = String(get('系统.扩展.image.config.defaultBackend') ?? 'novelai');
    const validated = VALID_BACKENDS.has(raw) ? raw as ImageBackendType : 'novelai' as ImageBackendType;
    const available = configuredImageBackends.value;
    if (available.size === 0 || available.has(validated)) return validated;
    const first = available.values().next().value;
    return VALID_BACKENDS.has(first ?? '') ? first as ImageBackendType : 'novelai' as ImageBackendType;
  }

  const playerDefaultBackend = computed(() => resolveDefaultBackend());

  async function analyzePlayerImageFromCard(assetId: string) {
    if (!imageService) return;
    try {
      const entry = await imageService.getAssetCache().retrieve(assetId);
      if (!entry) { eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.cacheMissingExtract'), duration: 2000 }); return; }
      eventBus.emit('ui:toast', { type: 'info', message: t('character.toast.goToWorkbench'), duration: 3000 });
    } catch (err) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.operationFailed', { error: (err as Error).message }), duration: 2000 });
    }
  }

  async function savePlayerAsReferenceMaterial(assetId: string) {
    if (!imageService) return;
    try {
      const result = await copyAssetToReferenceLibrary(imageService, assetId, { name: `主角_${assetId.slice(0, 12)}`, source: 'player' });
      if (result === 'missing') { eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.cacheMissing'), duration: 2000 }); return; }
      eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.savedAsReference'), duration: 2000 });
    } catch (err) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.saveFailed', { error: (err as Error).message }), duration: 2000 });
    }
  }

  const ALL_BACKEND_LABELS: Record<string, string> = { novelai: 'NovelAI', openai: 'OpenAI DALL-E', sd_webui: 'SD-WebUI', comfyui: 'ComfyUI', civitai: 'Civitai' };
  const activeBackend = computed(() => resolveDefaultBackend());
  /** 该后端当前配置的模型名——`resolveStyleParams` 判定 Seedream `seed` 是否适用要用它 */
  function configuredModelFor(bk: string): string | undefined {
    return aiService?.getImageConfigForBackend(bk)?.model || undefined;
  }

  const activeBackendStatus = computed(() => {
    const bk = activeBackend.value;
    const cfg = aiService?.getImageConfigForBackend(bk);
    return { label: ALL_BACKEND_LABELS[bk] ?? bk, model: cfg?.model ?? '', configured: !!cfg };
  });

  // ─── Player image generation ───
  const compositionOptions = computed<SelectOption[]>(() => [
    { label: t('character.image.composition.portrait'), value: 'portrait' },
    { label: t('character.image.composition.halfBody'), value: 'half-body' },
    { label: t('character.image.composition.fullLength'), value: 'full-length' },
    { label: t('character.image.composition.custom'), value: 'custom' },
  ]);
  const styleOptions = computed<SelectOption[]>(() => [
    { label: t('character.image.style.generic'), value: 'generic' },
    { label: t('character.image.style.anime'), value: 'anime' },
    { label: t('character.image.style.realistic'), value: 'realistic' },
    { label: t('character.image.style.chinese'), value: 'chinese' },
  ]);

  const playerComposition = ref('portrait');
  const playerCustomComposition = ref('');
  const isPlayerCustomComposition = computed(() => playerComposition.value === 'custom');
  const playerStyle = ref('generic');
  const playerExtraPrompt = ref('');
  const playerArtistPreset = ref('');
  const playerPngPreset = ref('');
  const playerSize = ref('');
  const playerGenerating = ref(false);
  const playerGenError = ref('');

  const playerRefEnabled = ref(false);
  /** 多图参考（仅豆包等声明 multiReference 的后端渲染；PO 决策① 2026-08-29）。 */
  const playerMultiRefItems = ref<MultiReferenceItem[]>([]);
  const playerBackendSupportsMultiRef = computed(() =>
    PROVIDER_CAPABILITIES[playerDefaultBackend.value]?.multiReference === true,
  );
  /** 体积校验：与同文件的单图路径 onPlayerRefFileChange 用同一条规则。 */
  function validatePlayerRefSize(file: File): boolean {
    if (file.size <= playerRefConfigMaxBytes.value) return true;
    const limitMB = (playerRefConfigMaxBytes.value / 1048576).toFixed(0);
    eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.fileSizeLimit', { limit: limitMB }), duration: 3000 });
    return false;
  }

  /** 落资产库 + 进参考素材库；`persistUploadedReferences` 关掉时返回 null（沿用单图路径的语义）。 */
  async function persistPlayerRef(file: File): Promise<string | null> {
    if (!imageService || !playerRefConfigPersist.value) return null;
    const aid = `ref_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await imageService.getAssetCache().store({
        id: aid, taskId: '', storageKey: aid,
        mimeType: file.type || 'image/png', width: 0, height: 0,
        sizeBytes: file.size, backend: 'civitai', createdAt: Date.now(), origin: 'upload',
      }, file);
      imageService.state.addReferenceEntry({
        id: generateReferenceId(), assetId: aid,
        name: file.name.replace(/\.\w+$/, ''),
        mimeType: file.type || 'image/png', width: 0, height: 0,
        sizeBytes: file.size, source: 'upload', createdAt: Date.now(),
      });
      return aid;
    } catch { return null; }
  }

  async function onPlayerMultiRefFiles(files: FileList): Promise<void> {
    playerMultiRefItems.value = await appendReferenceFiles(files, {
      max: SEEDREAM_MAX_REFERENCE_IMAGES,
      current: playerMultiRefItems.value,
      validate: validatePlayerRefSize,
      persist: (file) => persistPlayerRef(file),
      makeId: () => `pmr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      onOverflow: () => eventBus.emit('ui:toast', {
        type: 'warning',
        message: t('image.multiRef.tooMany', { max: SEEDREAM_MAX_REFERENCE_IMAGES }),
        duration: 3000,
      }),
    });
  }

  /** 快捷来源：恢复切到多图后端后丢失的「用头像 / 用立绘」（review Minor 修复）。 */
  const playerQuickSources = computed(() => {
    const archive = get('角色.图片档案') as Record<string, unknown> | undefined;
    const out: Array<{ key: string; label: string }> = [];
    if (String(archive?.['已选头像图片ID'] ?? '')) out.push({ key: 'avatar', label: t('character.image.reference.sourceAvatar') });
    if (String(archive?.['已选立绘图片ID'] ?? '')) out.push({ key: 'portrait', label: t('character.image.reference.sourcePortrait') });
    return out;
  });

  async function onPlayerQuickSource(key: string): Promise<void> {
    const archive = get('角色.图片档案') as Record<string, unknown> | undefined;
    const assetId = String((key === 'avatar' ? archive?.['已选头像图片ID'] : archive?.['已选立绘图片ID']) ?? '');
    if (!assetId || !imageService) return;
    if (playerMultiRefItems.value.length >= SEEDREAM_MAX_REFERENCE_IMAGES) return;
    if (playerMultiRefItems.value.some((it) => it.assetId === assetId)) return;
    try {
      const entry = await imageService.getAssetCache().retrieve(assetId);
      if (!entry) return;
      const label = key === 'avatar'
        ? t('character.image.reference.sourceAvatar')
        : t('character.image.reference.sourcePortrait');
      const dataUrl = await readFileAsDataUrl(new File([entry.blob], label, { type: entry.metadata.mimeType }));
      playerMultiRefItems.value = [...playerMultiRefItems.value, {
        id: `pmr_${Date.now()}`, dataUrl, assetId, label,
      }];
    } catch (err) {
      console.warn('[CharacterDetailsPanel] 快捷来源加入多图参考失败:', err);
    }
  }

  const playerRefSource = ref('upload');
  const playerRefDenoise = ref(0.65);
  const playerRefFile = ref<File | null>(null);
  const playerRefDataUrl = ref<string | null>(null);
  const playerRefAssetId = ref<string | null>(null);
  const playerRefConfigDenoise = computed(() =>
    (get('系统.扩展.image.config.reference.defaultDenoiseStrength') as number | undefined) ?? 0.65,
  );
  const playerRefConfigMaxBytes = computed(() =>
    (get('系统.扩展.image.config.reference.maxUploadBytes') as number | undefined) ?? 10485760,
  );
  const playerRefConfigPersist = computed(() =>
    get('系统.扩展.image.config.reference.persistUploadedReferences') !== false,
  );
  watch(playerRefEnabled, (v) => { if (v) playerRefDenoise.value = playerRefConfigDenoise.value; });

  async function onPlayerRefFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > playerRefConfigMaxBytes.value) {
      const limitMB = (playerRefConfigMaxBytes.value / 1048576).toFixed(0);
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.fileSizeLimit', { limit: limitMB }), duration: 3000 });
      (e.target as HTMLInputElement).value = '';
      return;
    }
    playerRefFile.value = file;
    const reader = new FileReader();
    reader.onload = async () => {
      playerRefDataUrl.value = reader.result as string;
      if (imageService && playerRefConfigPersist.value) {
        const aid = `ref_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          const { generateReferenceId } = await import('@/engine/image/utils');
          await imageService.getAssetCache().store({
            id: aid, taskId: '', storageKey: aid,
            mimeType: file.type || 'image/png', width: 0, height: 0,
            sizeBytes: file.size, backend: 'civitai', createdAt: Date.now(), origin: 'upload',
          }, file);
          imageService.state.addReferenceEntry({
            id: generateReferenceId(), assetId: aid,
            name: file.name.replace(/\.\w+$/, ''),
            mimeType: file.type || 'image/png', width: 0, height: 0,
            sizeBytes: file.size, source: 'upload', createdAt: Date.now(),
          });
          playerRefAssetId.value = aid;
        } catch { playerRefAssetId.value = null; }
      }
    };
    reader.readAsDataURL(file);
  }

  const playerArchiveReactive = useValue<Record<string, unknown>>('角色.图片档案');
  const playerArchive = computed(() => {
    const raw = playerArchiveReactive.value;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  });
  const playerArchiveHistory = computed(() => {
    const h = playerArchive.value['生图历史'];
    return Array.isArray(h) ? (h as Array<Record<string, unknown>>) : [];
  });
  const playerArchiveTick = ref(0);
  const playerAvatarId = computed(() => String(playerArchive.value['已选头像图片ID'] ?? ''));
  const playerPortraitId = computed(() => String(playerArchive.value['已选立绘图片ID'] ?? ''));

  // Player image stats
  const playerImageStats = computed(() => ({
    total: playerArchiveHistory.value.length,
    avatarBound: !!playerAvatarId.value,
    portraitBound: !!playerPortraitId.value,
    anchorName: (get('系统.扩展.image.characterAnchors') as Array<Record<string, unknown>> | undefined)
      ?.find((a) => a.npcName === '__player__')?.name as string | undefined,
  }));

  // Artist/PNG presets from state
  const playerArtistPresetOptions = computed<SelectOption[]>(() => {
    const raw = get('系统.扩展.image.artistPresets');
    if (!Array.isArray(raw)) return [{ label: t('character.image.formLabel.noPreset'), value: '' }];
    const npcPresets = (raw as Array<Record<string, unknown>>).filter((p) => p.scope === 'npc' && !String(p.id ?? '').startsWith('png_') && !String(p.id ?? '').startsWith('img_'));
    return [{ label: t('character.image.formLabel.noPreset'), value: '' }, ...npcPresets.map((p) => ({ label: String(p.name ?? ''), value: String(p.id ?? '') }))];
  });
  const playerPngPresetOptions = computed<SelectOption[]>(() => {
    const raw = get('系统.扩展.image.artistPresets');
    if (!Array.isArray(raw)) return [{ label: t('character.image.formLabel.noPngPreset'), value: '' }];
    const pngPresets = (raw as Array<Record<string, unknown>>).filter((p) => p.scope === 'npc' && (String(p.id ?? '').startsWith('png_') || String(p.id ?? '').startsWith('img_')));
    return [{ label: t('character.image.formLabel.noPngPreset'), value: '' }, ...pngPresets.map((p) => ({ label: String(p.name ?? ''), value: String(p.id ?? '') }))];
  });

  // ─── Player anchor management ───
  const extractingAnchor = ref(false);

  const playerAnchor = computed(() => {
    const anchors = get('系统.扩展.image.characterAnchors') as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(anchors)) return null;
    return anchors.find((a) => a.subjectId === '__player__' || a.npcName === '__player__') ?? null;
  });

  const anchorPositive = ref('');
  const anchorNegative = ref('');
  const anchorEnabled = ref(true);
  const anchorAppendDefault = ref(true);
  const anchorAutoScene = ref(false);

  watch(() => playerAnchor.value, (anchor) => {
    if (anchor) {
      anchorPositive.value = String(anchor.positivePrompt ?? '');
      anchorNegative.value = String(anchor.negativePrompt ?? '');
      anchorEnabled.value = anchor.enabled !== false;
      anchorAppendDefault.value = anchor.appendByDefault !== false;
      anchorAutoScene.value = anchor.autoInjectToScene === true;
    }
  }, { immediate: true });

  async function extractPlayerAnchor() {
    if (!aiService) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.aiServiceNotReady'), duration: 2500 });
      return;
    }
    extractingAnchor.value = true;
    try {
      const playerName = get(P.playerName) as string ?? '主角';

      const npcData: Record<string, unknown> = { 姓名: playerName };
      const tryGet = (path: string) => { const v = get(path); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      if (getGender()) npcData['性别'] = getGender();
      if (getAge()) npcData['年龄'] = getAge();
      if (getOccupation()) npcData['身份'] = getOccupation();
      const descText = tryGet(P.characterDescription);
      if (descText) npcData['描述'] = descText;
      const appearance = tryGet('角色.外貌描写') ?? tryGet('角色.描述');
      if (appearance) npcData['外貌描述'] = appearance;
      const bodyDesc = tryGet('角色.身材描写');
      if (bodyDesc) npcData['身材描写'] = bodyDesc;
      const outfitStyle = tryGet('角色.衣着风格');
      if (outfitStyle) npcData['衣着风格'] = outfitStyle;
      if (getTraitText()) npcData['特质'] = getTraitText();

      const result = await extractAnchorViaAI(
        aiService,
        JSON.stringify(npcData, null, 2),
        { displayName: playerName },
      );

      const anchors = (get('系统.扩展.image.characterAnchors') as unknown[] ?? []).filter(
        (a) => (a as Record<string, unknown>).subjectId !== '__player__' && (a as Record<string, unknown>).npcName !== '__player__'
      );
      const newAnchor = {
        id: `anchor_player_${Date.now()}`,
        subjectId: '__player__',
        npcName: '__player__',
        name: `${playerName} 锚点`,
        enabled: true,
        appendByDefault: true,
        autoInjectToScene: false,
        positivePrompt: result.positivePrompt,
        negativePrompt: result.negativePrompt,
        structuredFeatures: result.structuredFeatures,
        source: 'ai_extract',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      anchors.push(newAnchor);
      setValue('系统.扩展.image.characterAnchors', anchors);
      eventBus.emit('engine:request-save');
      eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.anchorExtracted'), duration: 2000 });
    } catch (err) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.anchorExtractFailed', { error: (err as Error).message }), duration: 3500 });
    } finally {
      extractingAnchor.value = false;
    }
  }

  function savePlayerAnchor() {
    const anchors = (get('系统.扩展.image.characterAnchors') as Array<Record<string, unknown>> ?? []).map((a) => {
      if (a.subjectId === '__player__' || a.npcName === '__player__') {
        return {
          ...a,
          positivePrompt: anchorPositive.value,
          negativePrompt: anchorNegative.value,
          enabled: anchorEnabled.value,
          appendByDefault: anchorAppendDefault.value,
          autoInjectToScene: anchorAutoScene.value,
          updatedAt: Date.now(),
        };
      }
      return a;
    });
    setValue('系统.扩展.image.characterAnchors', anchors);
    eventBus.emit('engine:request-save');
  }

  function deletePlayerAnchor() {
    const anchors = (get('系统.扩展.image.characterAnchors') as unknown[] ?? []).filter(
      (a) => (a as Record<string, unknown>).subjectId !== '__player__' && (a as Record<string, unknown>).npcName !== '__player__'
    );
    setValue('系统.扩展.image.characterAnchors', anchors);
    eventBus.emit('engine:request-save');
  }

  async function generatePlayerImage() {
    if (!imageService || playerGenerating.value) return;
    if (isPlayerCustomComposition.value && !playerCustomComposition.value.trim()) {
      playerGenError.value = t('character.toast.customCompositionRequired');
      return;
    }
    playerGenerating.value = true;
    playerGenError.value = '';
    try {
      const playerName = get(P.playerName) as string ?? '主角';
      const playerDesc = get(P.characterDescription) as string ?? '';
      const defaultBackend = resolveDefaultBackend();
      const anchor = playerAnchor.value;
      const rawPresets = get('系统.扩展.image.artistPresets');
      const styleInjection = buildPromptStyleInjection(
        Array.isArray(rawPresets) ? rawPresets as PromptStylePresetLike[] : [],
        [playerArtistPreset.value, playerPngPreset.value],
      );

      // Build NPC-format data JSON (player mapped to NPC format)
      const npcData: Record<string, unknown> = { 姓名: playerName };
      const tryGet = (path: string) => { const v = get(path); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      if (getGender()) npcData['性别'] = getGender();
      if (getAge()) npcData['年龄'] = getAge();
      if (getOccupation()) npcData['身份'] = getOccupation();
      const bg = tryGet(P.characterDescription);
      if (bg) npcData['简介'] = bg;
      const appearance = tryGet('角色.外貌描写') ?? tryGet('角色.描述');
      if (appearance) npcData['外貌'] = appearance;

      // Parse custom size
      let w: number | undefined;
      let h: number | undefined;
      if (playerSize.value.trim()) {
        const m = playerSize.value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
        if (m) { w = Number(m[1]); h = Number(m[2]); }
      }

      // Resolve replicateParams from selected PNG preset
      const allPresets = Array.isArray(rawPresets) ? rawPresets as ArtistPreset[] : [];
      const playerPngObj = playerPngPreset.value ? allPresets.find((p) => p.id === playerPngPreset.value) : undefined;
      const playerStyleApplicability = playerPngObj ? resolveStyleParams(playerPngObj, defaultBackend, configuredModelFor(defaultBackend)) : null;

      // Build reference if enabled
      let playerReferences: import('@/engine/image/types').ImageReferenceInput[] | undefined;
      let playerReference: import('@/engine/image/types').ImageReferenceInput | undefined;
      if (playerRefEnabled.value && PROVIDER_CAPABILITIES[defaultBackend]?.imageToImage) {
        const refId = `ref_player_${Date.now()}`;
        if (PROVIDER_CAPABILITIES[defaultBackend]?.multiReference) {
          // 多图后端：**独立分支**——列表为空也不许回落到单图逻辑。
          // 单图控件此时根本没渲染，playerRefSource 可能还留着上一个后端选的
          // 'avatar'，回落会把用户看不见的旧选择当成参考图发出去
          //（review Important 2026-08-29）。
          if (playerMultiRefItems.value.length > 0) {
            playerReferences = playerMultiRefItems.value.map((it) => (it.assetId
              ? { id: `${refId}_${it.id}`, role: 'source' as const, source: 'asset' as const, assetId: it.assetId, denoiseStrength: playerRefDenoise.value }
              : { id: `${refId}_${it.id}`, role: 'source' as const, source: 'data_url' as const, dataUrl: it.dataUrl, denoiseStrength: playerRefDenoise.value }));
          }
        } else if (playerRefSource.value === 'upload' && (playerRefAssetId.value || playerRefDataUrl.value)) {
          playerReference = playerRefAssetId.value
            ? { id: refId, role: 'source', source: 'asset', assetId: playerRefAssetId.value, denoiseStrength: playerRefDenoise.value }
            : { id: refId, role: 'source', source: 'data_url', dataUrl: playerRefDataUrl.value!, denoiseStrength: playerRefDenoise.value };
        } else if (playerRefSource.value === 'avatar' || playerRefSource.value === 'portrait') {
          const archive = get('角色.图片档案') as Record<string, unknown> | undefined;
          const assetId = playerRefSource.value === 'avatar'
            ? String(archive?.['已选头像图片ID'] ?? '')
            : String(archive?.['已选立绘图片ID'] ?? '');
          if (assetId) playerReference = { id: refId, role: 'source', source: 'asset', assetId, denoiseStrength: playerRefDenoise.value };
        }
      }

      // Use __player__ as characterName so image-service writes to 角色.图片档案 via ImageStateManager
      const task = await imageService.generateCharacterImage({
        characterName: '__player__',
        description: playerDesc,
        backend: defaultBackend,
        composition: playerComposition.value as 'portrait' | 'half-body' | 'full-length' | 'custom',
        customComposition: playerCustomComposition.value || undefined,
        artStyle: playerStyle.value === 'generic' ? '通用' : playerStyle.value === 'anime' ? '二次元' : playerStyle.value === 'realistic' ? '写实' : '国风',
        extraPrompt: playerExtraPrompt.value || undefined,
        anchorPositive: anchor?.enabled !== false ? String(anchor?.positivePrompt ?? '') || undefined : undefined,
        anchorNegative: anchor?.enabled !== false ? String(anchor?.negativePrompt ?? '') || undefined : undefined,
        artistPrefix: styleInjection.artistPrefix,
        extraNegative: styleInjection.extraNegative,
        npcDataJson: JSON.stringify(npcData, null, 2),
        preset: w && h ? { id: 'custom', name: '自定义', positivePrefix: '', positiveSuffix: '', negative: '', width: w, height: h, source: 'manual' } : undefined,
        references: playerReferences ?? (playerReference ? [playerReference] : undefined),
        styleParamOverrides: playerStyleApplicability?.applied,
      });

      if (task.status === 'failed') {
        playerGenError.value = task.error ?? t('character.toast.generationFailed');
      }
      // Archive write is now handled by image-service via ImageStateManager.__player__ path
    } catch (err) {
      playerGenError.value = (err as Error).message ?? String(err);
    } finally {
      playerGenerating.value = false;
    }
  }

  function setPlayerAvatar(assetId: string) {
    const archive = { ...(get('角色.图片档案') ?? {}) } as Record<string, unknown>;
    archive['已选头像图片ID'] = playerAvatarId.value === assetId ? '' : assetId;
    setValue('角色.图片档案', archive);
    eventBus.emit('engine:request-save');
  }

  function setPlayerPortrait(assetId: string) {
    const archive = { ...(get('角色.图片档案') ?? {}) } as Record<string, unknown>;
    archive['已选立绘图片ID'] = playerPortraitId.value === assetId ? '' : assetId;
    setValue('角色.图片档案', archive);
    eventBus.emit('engine:request-save');
  }

  function deletePlayerImage(assetId: string) {
    if (!imageService) return;
    imageService.deleteNpcImage('__player__', assetId);
  }

  function isPlayerCurrentSecretPart(assetId: string, part: SecretPartType): boolean {
    void playerArchiveTick.value;
    const secretArchive = playerArchive.value['香闺秘档'] as Record<string, unknown> | undefined;
    if (!secretArchive) return false;
    const cnKey = part === 'breast' ? '胸部' : part === 'vagina' ? '小穴' : '屁穴';
    const entry = secretArchive[cnKey] as Record<string, unknown> | undefined;
    return typeof entry?.id === 'string' && entry.id === assetId;
  }

  function canShowPlayerSecretPartActions(): boolean {
    return getNsfwEnabled() && !!getGender() && !String(getGender()).includes('男');
  }

  function setPlayerSecretPart(assetId: string, part: SecretPartType) {
    if (!imageService) return;
    imageService.setNpcSecretPart('__player__', part, assetId);
    playerArchiveTick.value++;
    const label = part === 'breast' ? t('character.image.archive.partBreast') : part === 'vagina' ? t('character.image.archive.partVagina') : t('character.image.archive.partAnus');
    eventBus.emit('ui:toast', { type: 'success', message: t('character.image.archive.toastSetSecretPart', { part: label }), duration: 1500 });
  }

  function clearPlayerSecretPart(part: SecretPartType) {
    if (!imageService) return;
    imageService.clearNpcSecretPart('__player__', part);
    playerArchiveTick.value++;
  }

  // ── Regenerate-Same for player images ──
  // Parallel to ImagePanel's version — uses the same ImageService API but scoped
  // to __player__, so regenerated images flow back into 角色.图片档案.生图历史.
  interface PlayerRegenPayload {
    subjectLabel: string;
    subtitle?: string;
    composition: 'portrait' | 'half-body' | 'full-length' | 'custom';
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
  const playerRegenPayload = ref<PlayerRegenPayload | null>(null);
  const playerRegenBusy = ref(false);

  function openPlayerRegenerate(img: Record<string, unknown>, asReference = false) {
    const positive = String(img.positivePrompt ?? '');
    if (!positive.trim()) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.regenMissingPrompt'), duration: 2000 });
      return;
    }
    const comp = (String(img.composition ?? 'portrait') as 'portrait' | 'half-body' | 'full-length' | 'custom');
    const width = Number(img.width) || 832;
    const height = Number(img.height) || 1216;
    const rawBackend = String(img.backend ?? '');
    const bk = (rawBackend as ImageBackendType) || resolveDefaultBackend();
    const playerName = String(getName() ?? '主角');
    const compLabel = comp === 'portrait' ? t('character.image.archive.compositionPortrait') : comp === 'half-body' ? t('character.image.archive.compositionHalfBody') : comp === 'custom' ? t('character.image.archive.compositionCustom') : t('character.image.archive.compositionFullLength');
    playerRegenPayload.value = {
      subjectLabel: playerName,
      subtitle: [compLabel, `${width} × ${height}`, bk].filter(Boolean).join(' · '),
      composition: comp,
      positivePrompt: positive,
      negativePrompt: String(img.negativePrompt ?? ''),
      width,
      height,
      initialBackend: bk,
      artStyle: String(img.artStyle ?? '') || undefined,
      civitaiLoraSnapshot: extractLoraSnapshot(img),
      sourceAssetId: typeof img.id === 'string' ? img.id : undefined,
      preActivateReference: asReference,
    };
  }

  function cancelPlayerRegenerate() {
    if (playerRegenBusy.value) return;
    playerRegenPayload.value = null;
  }

  async function confirmPlayerRegenerate(opts: { backend: ImageBackendType; positivePrompt: string; negativePrompt: string; references?: import('@/engine/image/types').ImageReferenceInput[] }) {
    if (!imageService || !playerRegenPayload.value || playerRegenBusy.value) return;
    const p = playerRegenPayload.value;
    playerRegenBusy.value = true;
    try {
      const task = await imageService.regenerateFromPrompts({
        subjectType: 'character',
        targetCharacter: '__player__',
        composition: p.composition,
        positivePrompt: opts.positivePrompt,
        negativePrompt: opts.negativePrompt,
        width: p.width,
        height: p.height,
        backend: opts.backend,
        artStyle: p.artStyle,
        references: opts.references,
      });
      if (task.status === 'failed') {
        eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.regenFailed', { error: task.error ?? '' }), duration: 2500 });
      } else {
        eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.regenSubmitted'), duration: 2000 });
        playerRegenPayload.value = null;
      }
    } catch (err) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.regenFailed', { error: (err as Error).message }), duration: 2500 });
    } finally {
      playerRegenBusy.value = false;
    }
  }

  return {
    IMAGE_BACKEND_KEYS,
    configuredImageBackends,
    availableBackendOptions,
    VALID_BACKENDS,
    resolveDefaultBackend,
    playerDefaultBackend,
    analyzePlayerImageFromCard,
    savePlayerAsReferenceMaterial,
    ALL_BACKEND_LABELS,
    activeBackend,
    configuredModelFor,
    activeBackendStatus,
    compositionOptions,
    styleOptions,
    playerComposition,
    playerCustomComposition,
    isPlayerCustomComposition,
    playerStyle,
    playerExtraPrompt,
    playerArtistPreset,
    playerPngPreset,
    playerSize,
    playerGenerating,
    playerGenError,
    playerRefEnabled,
    playerMultiRefItems,
    playerBackendSupportsMultiRef,
    validatePlayerRefSize,
    persistPlayerRef,
    onPlayerMultiRefFiles,
    playerQuickSources,
    onPlayerQuickSource,
    playerRefSource,
    playerRefDenoise,
    playerRefFile,
    playerRefDataUrl,
    playerRefAssetId,
    playerRefConfigDenoise,
    playerRefConfigMaxBytes,
    playerRefConfigPersist,
    onPlayerRefFileChange,
    playerArchiveReactive,
    playerArchive,
    playerArchiveHistory,
    playerArchiveTick,
    playerAvatarId,
    playerPortraitId,
    playerImageStats,
    playerArtistPresetOptions,
    playerPngPresetOptions,
    extractingAnchor,
    playerAnchor,
    anchorPositive,
    anchorNegative,
    anchorEnabled,
    anchorAppendDefault,
    anchorAutoScene,
    extractPlayerAnchor,
    savePlayerAnchor,
    deletePlayerAnchor,
    generatePlayerImage,
    setPlayerAvatar,
    setPlayerPortrait,
    deletePlayerImage,
    isPlayerCurrentSecretPart,
    canShowPlayerSecretPartActions,
    setPlayerSecretPart,
    clearPlayerSecretPart,
    playerRegenPayload,
    playerRegenBusy,
    openPlayerRegenerate,
    cancelPlayerRegenerate,
    confirmPlayerRegenerate,
  };
}

export interface PlayerSecretPartsDeps {
  t: ComposerTranslation;
  get: UseGameStateReturn['get'];
  imageService: ImageService | undefined;
  playerDefaultBackend: { readonly value: ImageBackendType };
  playerAnchor: { readonly value: Record<string, unknown> | null };
  configuredModelFor: (bk: string) => string | undefined;
}

export function usePlayerSecretParts(deps: PlayerSecretPartsDeps) {
  const { t, get, imageService, playerDefaultBackend, playerAnchor, configuredModelFor } = deps;
  // ─── Player secret part close-up (mirrors NPC flow in ImagePanel.vue) ───

  const playerSecretParts = computed(() => [
    { key: 'breast' as const, label: t('character.image.secret.partBreast') },
    { key: 'vagina' as const, label: t('character.image.secret.partVagina') },
    { key: 'anus' as const, label: t('character.image.secret.partAnus') },
  ]);

  const playerSecretSizeOptions = computed(() => [
    { label: t('character.image.secret.sizeNone'), value: 'none' },
    { label: '1:1', value: '1:1' },
    { label: '3:4', value: '3:4' },
    { label: '9:16', value: '9:16' },
    { label: '16:9', value: '16:9' },
  ]);

  const PLAYER_SECRET_SIZE_MAP: Record<string, { w: number; h: number }> = {
    '1:1': { w: 1024, h: 1024 },
    '3:4': { w: 768, h: 1024 },
    '9:16': { w: 576, h: 1024 },
    '16:9': { w: 1024, h: 576 },
  };

  const playerSecretSizePreset = ref('1:1');
  const playerSecretArtistPreset = ref('');
  const playerSecretPngPreset = ref('');
  const playerSecretExtraPrompt = ref('');
  const playerSecretBusy = ref('');
  const playerSecretStatusText = ref('');

  const playerSecretViewerOpen = ref(false);
  const playerSecretViewerSrc = ref('');
  const secretViewerBackdrop = useBackdropClose(() => { playerSecretViewerOpen.value = false; });

  async function openPlayerSecretViewer(assetId: string) {
    if (!imageService) return;
    try {
      const result = await imageService.getAssetCache().retrieve(assetId);
      if (result) {
        if (playerSecretViewerSrc.value) URL.revokeObjectURL(playerSecretViewerSrc.value);
        playerSecretViewerSrc.value = URL.createObjectURL(result.blob);
        playerSecretViewerOpen.value = true;
      }
    } catch { /* silent */ }
  }

  function getPlayerSecretPartAssetId(partKey: 'breast' | 'vagina' | 'anus'): string | null {
    const archive = get('角色.图片档案') as Record<string, unknown> | undefined;
    const secretArchive = archive?.['香闺秘档'] as Record<string, unknown> | undefined;
    if (!secretArchive) return null;
    const cnKey = partKey === 'breast' ? '胸部' : partKey === 'vagina' ? '小穴' : '屁穴';
    const entry = secretArchive[cnKey] as Record<string, unknown> | undefined;
    return typeof entry?.id === 'string' && entry.id ? entry.id : null;
  }

  function resolvePlayerSecretPreset(): import('@/engine/image/types').StylePreset | undefined {
    const p = playerSecretSizePreset.value;
    const dims = PLAYER_SECRET_SIZE_MAP[p];
    if (!dims) return undefined;
    return { id: `secret_${p}`, name: p, positivePrefix: '', positiveSuffix: '', negative: '', width: dims.w, height: dims.h, source: 'manual' as const };
  }

  async function generatePlayerSecretPart(partKey: 'breast' | 'vagina' | 'anus') {
    if (!imageService || playerSecretBusy.value) return;
    const part = playerSecretParts.value.find((p) => p.key === partKey);
    if (!part) return;
    playerSecretBusy.value = partKey;
    playerSecretStatusText.value = t('character.toast.secretSubmitted', { part: part.label });
    try {
      const rawPresets = get('系统.扩展.image.artistPresets');
      const presetArr = Array.isArray(rawPresets) ? rawPresets as PromptStylePresetLike[] : [];
      const styleInjection = buildPromptStyleInjection(presetArr, [
        playerSecretArtistPreset.value,
        playerSecretPngPreset.value,
      ]);
      const allPresets = Array.isArray(rawPresets) ? rawPresets as ArtistPreset[] : [];
      const pngObj = playerSecretPngPreset.value ? allPresets.find((p) => p.id === playerSecretPngPreset.value) : undefined;
      const styleApplicability = pngObj ? resolveStyleParams(pngObj, playerDefaultBackend.value, configuredModelFor(playerDefaultBackend.value)) : null;
      const anchor = playerAnchor.value;
      const task = await imageService.generateSecretPartImage({
        characterName: '__player__',
        part: partKey,
        backend: playerDefaultBackend.value,
        artistPrefix: styleInjection.artistPrefix,
        extraNegative: styleInjection.extraNegative,
        extraPrompt: playerSecretExtraPrompt.value || undefined,
        preset: resolvePlayerSecretPreset(),
        anchorPositive: anchor?.enabled !== false ? String(anchor?.positivePrompt ?? '') || undefined : undefined,
        anchorNegative: anchor?.enabled !== false ? String(anchor?.negativePrompt ?? '') || undefined : undefined,
        styleParamOverrides: styleApplicability?.applied,
      });
      if (task.status === 'failed') {
        playerSecretStatusText.value = t('character.toast.secretFailed', { part: part.label, error: task.error ?? '' });
      } else {
        playerSecretStatusText.value = t('character.toast.secretDone', { part: part.label });
      }
    } catch (err) {
      playerSecretStatusText.value = t('character.toast.secretSubmitFailed', { part: part.label, error: (err as Error).message });
    } finally {
      playerSecretBusy.value = '';
    }
  }

  async function generateAllPlayerSecretParts() {
    if (!imageService || playerSecretBusy.value) return;
    playerSecretBusy.value = 'all';
    playerSecretStatusText.value = t('character.toast.secretAllSubmitted');
    try {
      const rawPresets = get('系统.扩展.image.artistPresets');
      const presetArr = Array.isArray(rawPresets) ? rawPresets as PromptStylePresetLike[] : [];
      const styleInjection = buildPromptStyleInjection(presetArr, [
        playerSecretArtistPreset.value,
        playerSecretPngPreset.value,
      ]);
      const allPresets = Array.isArray(rawPresets) ? rawPresets as ArtistPreset[] : [];
      const pngObj = playerSecretPngPreset.value ? allPresets.find((p) => p.id === playerSecretPngPreset.value) : undefined;
      const styleApplicability = pngObj ? resolveStyleParams(pngObj, playerDefaultBackend.value, configuredModelFor(playerDefaultBackend.value)) : null;
      const anchor = playerAnchor.value;
      const failed: string[] = [];
      for (const part of playerSecretParts.value) {
        const task = await imageService.generateSecretPartImage({
          characterName: '__player__',
          part: part.key,
          backend: playerDefaultBackend.value,
          artistPrefix: styleInjection.artistPrefix,
          extraNegative: styleInjection.extraNegative,
          extraPrompt: playerSecretExtraPrompt.value || undefined,
          preset: resolvePlayerSecretPreset(),
          anchorPositive: anchor?.enabled !== false ? String(anchor?.positivePrompt ?? '') || undefined : undefined,
          anchorNegative: anchor?.enabled !== false ? String(anchor?.negativePrompt ?? '') || undefined : undefined,
          styleParamOverrides: styleApplicability?.applied,
        });
        if (task.status === 'failed') failed.push(part.label);
      }
      playerSecretStatusText.value = failed.length
        ? t('character.toast.secretPartialFailed', { parts: failed.join('、') })
        : t('character.toast.secretAllDone');
    } catch {
      playerSecretStatusText.value = t('character.toast.secretSubmitError');
    } finally {
      playerSecretBusy.value = '';
    }
  }

  async function generatePlayerSecretPartWithReference(partKey: 'breast' | 'vagina' | 'anus') {
    if (!imageService || playerSecretBusy.value) return;
    const prevAssetId = getPlayerSecretPartAssetId(partKey);
    if (!prevAssetId) {
      eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.noReferenceImage'), duration: 2000 });
      return;
    }
    const part = playerSecretParts.value.find((p) => p.key === partKey);
    if (!part) return;
    playerSecretBusy.value = partKey;
    playerSecretStatusText.value = t('character.toast.secretRefSubmitted', { part: part.label });
    try {
      const entry = await imageService.getAssetCache().retrieve(prevAssetId);
      if (!entry) {
        eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.prevCacheMissing'), duration: 2000 });
        return;
      }
      const rawPresets = get('系统.扩展.image.artistPresets');
      const presetArr = Array.isArray(rawPresets) ? rawPresets as PromptStylePresetLike[] : [];
      const styleInjection = buildPromptStyleInjection(presetArr, [playerSecretArtistPreset.value, playerSecretPngPreset.value]);
      const denoiseDefault = (get('系统.扩展.image.config.reference.defaultDenoiseStrength') as number | undefined) ?? 0.65;
      const secretRef: import('@/engine/image/types').ImageReferenceInput = {
        id: generateReferenceId(), role: 'source', source: 'asset', assetId: prevAssetId,
        denoiseStrength: denoiseDefault,
      };
      const anchor = playerAnchor.value;
      const task = await imageService.generateSecretPartImage({
        characterName: '__player__',
        part: partKey,
        backend: playerDefaultBackend.value,
        artistPrefix: styleInjection.artistPrefix,
        extraNegative: styleInjection.extraNegative,
        extraPrompt: playerSecretExtraPrompt.value || undefined,
        references: [secretRef],
        anchorPositive: anchor?.enabled !== false ? String(anchor?.positivePrompt ?? '') || undefined : undefined,
        anchorNegative: anchor?.enabled !== false ? String(anchor?.negativePrompt ?? '') || undefined : undefined,
      });
      playerSecretStatusText.value = task.status === 'failed'
        ? t('character.toast.secretRefFailed', { part: part.label, error: task.error ?? '' })
        : t('character.toast.secretRefDone', { part: part.label });
    } catch (err) {
      playerSecretStatusText.value = t('character.toast.secretRefFailed', { part: part.label, error: (err as Error).message });
    } finally {
      playerSecretBusy.value = '';
    }
  }

  return {
    playerSecretParts,
    playerSecretSizeOptions,
    PLAYER_SECRET_SIZE_MAP,
    playerSecretSizePreset,
    playerSecretArtistPreset,
    playerSecretPngPreset,
    playerSecretExtraPrompt,
    playerSecretBusy,
    playerSecretStatusText,
    playerSecretViewerOpen,
    playerSecretViewerSrc,
    secretViewerBackdrop,
    openPlayerSecretViewer,
    getPlayerSecretPartAssetId,
    resolvePlayerSecretPreset,
    generatePlayerSecretPart,
    generateAllPlayerSecretParts,
    generatePlayerSecretPartWithReference,
  };
}
