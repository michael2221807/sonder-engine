<script setup lang="ts">
// App doc: docs/user-guide/pages/game-character.md
/**
 * CharacterDetailsPanel — 角色详情面板。
 *
 * 三系统审计结论（2026-04-08）：
 * - 角色.基础信息.年龄 由 AI 直接 set，无需从出生年份推算
 * - 社交.关系 ← 数组，每项含 名称/好感度/内心想法/在做事项 等字段
 * - 属性读取路径与现有代码一致，schema 驱动优先
 *
 * 2026-04-08 升级：英雄头像区、Tab 结构（基础/属性/关系/身体）
 */
import { ref, reactive, computed, inject, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { useConfig } from '@/ui/composables/useConfig';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
import Modal from '@/ui/components/common/Modal.vue';
import SchemaForm from '@/ui/components/editing/SchemaForm.vue';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import RegenerateSameModal from '@/ui/components/image/RegenerateSameModal.vue';
import CivitaiLoraShelf from '@/ui/components/image/CivitaiLoraShelf.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { readStatFields } from '@/engine/pack/stat-section-reader';
import { extractAnchorViaAI } from '@/engine/image/anchor-extractor';
import { providerCatalog } from '@/engine/providers';
import type { AIService } from '@/engine/ai/ai-service';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import type { ImageService } from '@/engine/image/image-service';
import type { ImageBackendType, CivitaiLoraSnapshot, SecretPartType } from '@/engine/image/types';
import { buildPromptStyleInjection, type PromptStylePresetLike } from '@/engine/image/style-preset-injection';
import { resolveStyleParams } from '@/engine/image/style-param-resolver';
import { PROVIDER_CAPABILITIES } from '@/engine/image/provider-capabilities';
import type { ArtistPreset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';

import { useCharacterEditor } from '@/ui/composables/editors';
import { useRouter } from 'vue-router';

const P = DEFAULT_ENGINE_PATHS;

const { t } = useI18n();
const { isLoaded, useValue, setValue, get } = useGameState();
const charEditor = useCharacterEditor();
const router = useRouter();
const imageService = inject<ImageService>('imageService');
const aiService = inject<AIService | undefined>('aiService', undefined);
const apiStore = useAPIManagementStore();

// Catalog-derived (epic P0 §3.3) — mirrors ImagePanel.configuredBackends.
const IMAGE_BACKEND_KEYS = providerCatalog.byCategory('image').map((d) => d.id) as ImageBackendType[];
const configuredImageBackends = computed(() => {
  apiStore.apiConfigs; apiStore.apiAssignments;
  const set = new Set<string>();
  for (const bk of IMAGE_BACKEND_KEYS) {
    const assignment = apiStore.apiAssignments.find((a) => a.type === `imageGen_${bk}`);
    if (assignment && assignment.apiId !== 'default') {
      const cfg = apiStore.apiConfigs.find((c) => c.id === assignment.apiId && c.enabled && (c.apiCategory ?? 'llm') === 'image');
      if (cfg) set.add(bk);
    }
  }
  if (set.size === 0) {
    const legacyAssign = apiStore.apiAssignments.find((a) => a.type === 'imageGeneration');
    if (legacyAssign && legacyAssign.apiId !== 'default') {
      const cfg = apiStore.apiConfigs.find((c) => c.id === legacyAssign.apiId && c.enabled && (c.apiCategory ?? 'llm') === 'image');
      // Epic P0: persisted backend field replaces URL sniffing.
      const b = cfg?.backend;
      if (b && IMAGE_BACKEND_KEYS.includes(b as ImageBackendType)) set.add(b);
    }
  }
  return set;
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
    const entry = await imageService.getAssetCache().retrieve(assetId);
    if (!entry) { eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.cacheMissing'), duration: 2000 }); return; }
    const refAssetId = `ref_copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await imageService.getAssetCache().store({
      id: refAssetId, taskId: '', storageKey: refAssetId,
      mimeType: entry.metadata.mimeType, width: entry.metadata.width, height: entry.metadata.height,
      sizeBytes: entry.metadata.sizeBytes, backend: entry.metadata.backend, createdAt: Date.now(), origin: 'reference',
    }, entry.blob);
    imageService.state.addReferenceEntry({
      id: generateReferenceId(),
      assetId: refAssetId,
      name: `主角_${assetId.slice(0, 12)}`,
      mimeType: entry.metadata.mimeType,
      width: entry.metadata.width,
      height: entry.metadata.height,
      sizeBytes: entry.metadata.sizeBytes,
      source: 'player',
      createdAt: Date.now(),
    });
    eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.savedAsReference'), duration: 2000 });
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('character.toast.saveFailed', { error: (err as Error).message }), duration: 2000 });
  }
}

function extractLoraSnapshot(record: Record<string, unknown>): CivitaiLoraSnapshot | undefined {
  const meta = record.providerMeta;
  if (!meta || typeof meta !== 'object') return undefined;
  const snap = (meta as Record<string, unknown>).civitai;
  if (!snap || typeof snap !== 'object' || !Array.isArray((snap as CivitaiLoraSnapshot).loras)) return undefined;
  return snap as CivitaiLoraSnapshot;
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
    if (gender.value) npcData['性别'] = gender.value;
    if (age.value) npcData['年龄'] = age.value;
    if (occupation.value) npcData['身份'] = occupation.value;
    const descText = tryGet(P.characterDescription);
    if (descText) npcData['描述'] = descText;
    const appearance = tryGet('角色.外貌描写') ?? tryGet('角色.描述');
    if (appearance) npcData['外貌描述'] = appearance;
    const bodyDesc = tryGet('角色.身材描写');
    if (bodyDesc) npcData['身材描写'] = bodyDesc;
    const outfitStyle = tryGet('角色.衣着风格');
    if (outfitStyle) npcData['衣着风格'] = outfitStyle;
    if (traitText.value) npcData['特质'] = traitText.value;

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
    if (gender.value) npcData['性别'] = gender.value;
    if (age.value) npcData['年龄'] = age.value;
    if (occupation.value) npcData['身份'] = occupation.value;
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
    let playerReference: import('@/engine/image/types').ImageReferenceInput | undefined;
    if (playerRefEnabled.value && PROVIDER_CAPABILITIES[defaultBackend]?.imageToImage) {
      const refId = `ref_player_${Date.now()}`;
      if (playerRefSource.value === 'upload' && (playerRefAssetId.value || playerRefDataUrl.value)) {
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
      reference: playerReference,
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
  return nsfwEnabled.value && !!gender.value && !String(gender.value).includes('男');
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
  const playerName = String(name.value ?? '主角');
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

async function confirmPlayerRegenerate(opts: { backend: ImageBackendType; positivePrompt: string; negativePrompt: string; reference?: import('@/engine/image/types').ImageReferenceInput }) {
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
      reference: opts.reference,
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
const { getStateSchema } = useConfig();

// ─── Character basic info (reactive) ───

const name = useValue<string>(P.playerName);
const age = useValue<number>(P.characterAge);
const location = useValue<string>(P.playerLocation);
const gender = useValue<string>(P.characterGender);
const occupation = useValue<string>(P.characterOccupation);
const description = useValue<string>(P.characterDescription);

// 2026-04-11 fix：特质 schema 是 string（单个名称），不是 string[]。
// 旧代码按 string[] 读取会在 string 类型值上走 `.slice` / `v-for` 迭代字符，
// 导致显示异常。这里读为 unknown + 双形态 fallback（兼容旧存档）。
const traitsRaw = useValue<unknown>(P.characterTraits);
const traitText = computed<string>(() => {
  const v = traitsRaw.value;
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const name = (v as Record<string, unknown>)['名称'];
    return typeof name === 'string' ? name.trim() : '';
  }
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').join('、');
  }
  return '';
});
const traitDesc = computed<string>(() => {
  const v = traitsRaw.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const desc = (v as Record<string, unknown>)['描述'];
    return typeof desc === 'string' ? desc : '';
  }
  return '';
});

// 2026-04-11 fix：补全创角身份字段的读取 —— 出身 / 天赋档次 / 天赋列表 / 先天六维。
// 之前 CharacterDetailsPanel 只显示基础信息 + 后天属性，身份字段完全没展示，
// 导致玩家创角选的天资/出身/特质/天赋不出现在角色页面上。
const originObj = useValue<Record<string, unknown>>(P.characterOrigin);
const origin = computed(() => {
  const v = originObj.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return typeof v['名称'] === 'string' ? v['名称'] : '';
  return '';
});
const originDesc = computed(() => {
  const v = originObj.value;
  if (v && typeof v === 'object' && typeof v['描述'] === 'string') return v['描述'];
  return '';
});
const talentTier = useValue<string>(P.characterTalentTier);
const talentList = useValue<unknown>(P.talents);
const innateStats = useValue<Record<string, unknown>>(P.characterInnateStats);

const idSectionOpen = reactive({ origin: true, trait: true, talent: true });
const originDescExpanded = ref(false);
const traitDescExpanded = ref(false);
const talentExpanded = ref<Record<number, boolean>>({});

/** 天赋列表 — 兼容旧格式 string[] 和新格式 {名称, 描述}[] */
const talentItems = computed<Array<{ name: string; desc: string }>>(() => {
  const v = talentList.value;
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    if (typeof item === 'string') return { name: item.trim(), desc: '' };
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      return {
        name: typeof o['名称'] === 'string' ? o['名称'] : '',
        desc: typeof o['描述'] === 'string' ? o['描述'] : '',
      };
    }
    return { name: '', desc: '' };
  }).filter((t) => t.name !== '');
});

const attributes = useValue<Record<string, unknown>>(P.characterAttributes);

// ─── Story 2: Inline editing state for basic tab ───

const locations = useValue<Array<{ 名称: string }>>(P.locations);
const locationOptions = computed<string[]>(() => {
  const locs = locations.value;
  if (!Array.isArray(locs)) return [];
  return locs.map(l => l.名称).filter(Boolean);
});

const editingGender = ref(false);
const editingOccupation = ref(false);
const editingLocation = ref(false);
const editingDescription = ref(false);
const editingOrigin = ref(false);
const editingTrait = ref(false);
const editingTalentIdx = ref<number | null>(null);
const addingTalent = ref(false);

const genderDraft = ref('');
const occupationDraft = ref('');
const locationDraft = ref('');
const descriptionDraft = ref('');
const originNameDraft = ref('');
const originDescDraft = ref('');
const traitNameDraft = ref('');
const traitDescDraft = ref('');
const talentNameDraft = ref('');
const talentDescDraft = ref('');
const locationCancelled = ref(false);
const descriptionCancelled = ref(false);

const genderSelectOptions = computed<SelectOption[]>(() => [
  { label: t('character.edit.genderOption.male'), value: '男' },
  { label: t('character.edit.genderOption.female'), value: '女' },
  { label: t('character.edit.genderOption.other'), value: '其他' },
]);
const locationSelectOptions = computed<SelectOption[]>(() => {
  const opts = locationOptions.value.map((loc) => ({ label: loc, value: loc }));
  // Include the free-typed current draft value if it is not already a known location.
  if (locationDraft.value && !locationOptions.value.includes(locationDraft.value)) {
    opts.push({ label: locationDraft.value, value: locationDraft.value });
  }
  return opts;
});

function startEditGender(): void { genderDraft.value = gender.value ?? ''; editingGender.value = true; }
function commitGender(): void {
  charEditor.updateField(P.characterGender, genderDraft.value);
  editingGender.value = false;
}

function startEditOccupation(): void { occupationDraft.value = occupation.value ?? ''; editingOccupation.value = true; }
function commitOccupation(): void {
  charEditor.updateField(P.characterOccupation, occupationDraft.value);
  editingOccupation.value = false;
}
function cancelOccupation(): void { editingOccupation.value = false; }

function startEditLocation(): void { locationDraft.value = location.value ?? ''; locationCancelled.value = false; editingLocation.value = true; }
function commitLocation(): void {
  if (locationCancelled.value) { locationCancelled.value = false; return; }
  charEditor.updateField(P.playerLocation, locationDraft.value);
  editingLocation.value = false;
}
function cancelLocation(): void { locationCancelled.value = true; editingLocation.value = false; }

function startEditDescription(): void { descriptionDraft.value = description.value ?? ''; descriptionCancelled.value = false; editingDescription.value = true; }
function commitDescription(): void {
  if (descriptionCancelled.value) { descriptionCancelled.value = false; return; }
  charEditor.updateField(P.characterDescription, descriptionDraft.value);
  editingDescription.value = false;
}
function cancelDescription(): void { descriptionCancelled.value = true; editingDescription.value = false; }

const showOriginModal = ref(false);
function startEditOrigin(): void {
  originNameDraft.value = origin.value ?? '';
  originDescDraft.value = originDesc.value ?? '';
  showOriginModal.value = true;
}
function commitOrigin(): void {
  charEditor.updateField(P.characterOrigin, { 名称: originNameDraft.value, 描述: originDescDraft.value });
  showOriginModal.value = false;
}

const showTraitModal = ref(false);
function startEditTrait(): void {
  traitNameDraft.value = traitText.value ?? '';
  traitDescDraft.value = traitDesc.value ?? '';
  showTraitModal.value = true;
}
function commitTrait(): void {
  charEditor.updateField(P.characterTraits, { 名称: traitNameDraft.value, 描述: traitDescDraft.value });
  showTraitModal.value = false;
}

const showTalentModal = ref(false);
const talentModalMode = ref<'edit' | 'add'>('add');

function startEditTalent(idx: number): void {
  const item = talentItems.value[idx];
  if (!item) return;
  talentNameDraft.value = item.name;
  talentDescDraft.value = item.desc;
  editingTalentIdx.value = idx;
  talentModalMode.value = 'edit';
  showTalentModal.value = true;
}
function commitEditTalent(): void {
  if (talentModalMode.value === 'edit' && editingTalentIdx.value !== null) {
    charEditor.updateTalent(editingTalentIdx.value, { 名称: talentNameDraft.value, 描述: talentDescDraft.value });
  } else {
    if (!talentNameDraft.value.trim()) {
      eventBus.emit('ui:toast', { type: 'error', i18nKey: 'character.edit.nameRequired', message: 'Name required', duration: 2000 });
      return;
    }
    charEditor.addTalent({ 名称: talentNameDraft.value, 描述: talentDescDraft.value });
  }
  showTalentModal.value = false;
  editingTalentIdx.value = null;
}

function startAddTalent(): void {
  talentNameDraft.value = '';
  talentDescDraft.value = '';
  editingTalentIdx.value = null;
  talentModalMode.value = 'add';
  showTalentModal.value = true;
}
const showRemoveTalentConfirm = ref(false);
const removeTalentIdx = ref(-1);
const removeTalentName = ref('');

function requestRemoveTalent(idx: number, name: string): void {
  removeTalentIdx.value = idx;
  removeTalentName.value = name;
  showRemoveTalentConfirm.value = true;
}

function confirmRemoveTalent(): void {
  if (removeTalentIdx.value >= 0) {
    charEditor.removeTalent(removeTalentIdx.value);
  }
  showRemoveTalentConfirm.value = false;
}

// ─── Story 2: Attribute steppers ───

function stepInnateAttr(key: string, delta: number): void {
  const path = `${P.characterInnateStats}.${key}`;
  const current = get<number>(path) ?? 0;
  const newVal = Math.max(1, Math.min(10, current + delta));
  charEditor.updateField(path, newVal);
}

function stepAcquiredAttr(key: string, delta: number): void {
  const path = `${P.characterAttributes}.${key}`;
  charEditor.updateAttribute(path, delta);
}

// ─── Story 2: Vitals editing ───

const vitalHealth = useValue<{ 当前: number; 上限: number }>(P.vitalHealth);
const vitalEnergy = useValue<{ 当前: number; 上限: number }>(P.vitalEnergy);
const reputationVal = useValue<number>(P.reputation);

const showVitalsEdit = ref(false);
const vitalsForm = ref({ healthCurrent: 0, healthMax: 100, energyCurrent: 0, energyMax: 100, reputation: 0 });

function openVitalsEdit(): void {
  vitalsForm.value = {
    healthCurrent: vitalHealth.value?.当前 ?? 0,
    healthMax: vitalHealth.value?.上限 ?? 100,
    energyCurrent: vitalEnergy.value?.当前 ?? 0,
    energyMax: vitalEnergy.value?.上限 ?? 100,
    reputation: reputationVal.value ?? 0,
  };
  showVitalsEdit.value = true;
}

function saveVitals(): void {
  const f = vitalsForm.value;
  const result = charEditor.updateVitals({
    health: { current: f.healthCurrent, max: f.healthMax },
    energy: { current: f.energyCurrent, max: f.energyMax },
    reputation: f.reputation,
  });
  if (result.ok) showVitalsEdit.value = false;
}

// ─── Story 2: Relations tab jump ───

function jumpToNpcEdit(npcName: string): void {
  router.push({ path: '/game/relationships', query: { npc: npcName } });
}

function openAdvancedEditor(targetPath: string): void {
  router.push({ name: 'GameVariables', query: { path: targetPath, from: 'character' } });
}

// ─── Story 2: Body editing helpers ───
// H-2: body parts / 子宫 / 敏感点 / 纹身 are edited as a local draft inside this modal
// and committed together via charEditor.updateBody() on save — mirrors the NPC editor's
// batch-save pattern (RelationshipPanel), so "delete then cancel" cleanly discards drafts.

interface BodyEditPart {
  _id: number;
  部位名称: string;
  敏感度: number;
  开发度: number;
  特征描述: string;
  特殊印记: string;
}
interface BodyEditRecord { _id: number; 日期: string; 描述: string }
interface BodyEditUterus { 状态: string; 宫口状态: string; 内射记录: BodyEditRecord[] }
interface BodyEditForm {
  身高: number; 体重: number;
  胸围: number; 腰围: number; 臀围: number;
  胸部描述: string; 私处描述: string; 生殖器描述: string;
  身体部位: BodyEditPart[];
  敏感点: string[];
  纹身与印记: string[];
  子宫: BodyEditUterus;
}

const showBodyEditModal = ref(false);
const sensitivePointDraft = ref('');
const tattooDraft = ref('');
// Stable keys for draftable list rows (so removing a middle row doesn't reuse DOM by index).
let bodyDraftIdSeq = 0;
// Raw 子宫 captured at modal-open time → save merges over this open-time snapshot (draft
// isolation), preserving any 子宫 sub-fields not surfaced in the form.
const bodyEditUterusRaw = ref<Record<string, unknown>>({});
const bodyEditForm = ref<BodyEditForm>({
  身高: 0, 体重: 0,
  胸围: 0, 腰围: 0, 臀围: 0,
  胸部描述: '', 私处描述: '', 生殖器描述: '',
  身体部位: [],
  敏感点: [],
  纹身与印记: [],
  子宫: { 状态: '', 宫口状态: '', 内射记录: [] },
});

function openBodyEdit(): void {
  const b = get<Record<string, unknown>>('角色.身体') ?? {};
  const sw = (b['三围'] as Record<string, number>) ?? {};
  const rawParts = Array.isArray(b['身体部位']) ? (b['身体部位'] as Array<Record<string, unknown>>) : [];
  const rawUterus = (b['子宫'] as Record<string, unknown>) ?? {};
  const rawRecords = Array.isArray(rawUterus['内射记录']) ? (rawUterus['内射记录'] as Array<Record<string, unknown>>) : [];
  bodyEditForm.value = {
    身高: (b['身高'] as number) ?? 0,
    体重: (b['体重'] as number) ?? 0,
    胸围: sw['胸围'] ?? 0,
    腰围: sw['腰围'] ?? 0,
    臀围: sw['臀围'] ?? 0,
    胸部描述: (b['胸部描述'] as string) ?? '',
    私处描述: (b['私处描述'] as string) ?? '',
    生殖器描述: (b['生殖器描述'] as string) ?? '',
    身体部位: rawParts.map((p) => ({
      _id: bodyDraftIdSeq++,
      部位名称: (p['部位名称'] as string) ?? '',
      敏感度: (p['敏感度'] as number) ?? 0,
      开发度: (p['开发度'] as number) ?? 0,
      特征描述: (p['特征描述'] as string) ?? '',
      特殊印记: (p['特殊印记'] as string) ?? '',
    })),
    敏感点: Array.isArray(b['敏感点']) ? (b['敏感点'] as string[]).slice() : [],
    纹身与印记: Array.isArray(b['纹身与印记']) ? (b['纹身与印记'] as string[]).slice() : [],
    子宫: {
      状态: (rawUterus['状态'] as string) ?? '',
      宫口状态: (rawUterus['宫口状态'] as string) ?? '',
      内射记录: rawRecords.map((r) => ({ _id: bodyDraftIdSeq++, 日期: (r['日期'] as string) ?? '', 描述: (r['描述'] as string) ?? '' })),
    },
  };
  bodyEditUterusRaw.value = { ...rawUterus };
  sensitivePointDraft.value = '';
  tattooDraft.value = '';
  showBodyEditModal.value = true;
}

function addDraftBodyPart(): void {
  bodyEditForm.value.身体部位.push({ _id: bodyDraftIdSeq++, 部位名称: '', 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' });
}
function removeDraftBodyPart(index: number): void {
  bodyEditForm.value.身体部位.splice(index, 1);
}
function addSensitivePoint(): void {
  const v = sensitivePointDraft.value.trim();
  if (!v) return;
  if (!bodyEditForm.value.敏感点.includes(v)) bodyEditForm.value.敏感点.push(v);
  sensitivePointDraft.value = '';
}
function removeSensitivePoint(index: number): void {
  bodyEditForm.value.敏感点.splice(index, 1);
}
function addTattoo(): void {
  const v = tattooDraft.value.trim();
  if (!v) return;
  if (!bodyEditForm.value.纹身与印记.includes(v)) bodyEditForm.value.纹身与印记.push(v);
  tattooDraft.value = '';
}
function removeTattoo(index: number): void {
  bodyEditForm.value.纹身与印记.splice(index, 1);
}
function addInseminationRecord(): void {
  bodyEditForm.value.子宫.内射记录.push({ _id: bodyDraftIdSeq++, 日期: '', 描述: '' });
}
function removeInseminationRecord(index: number): void {
  bodyEditForm.value.子宫.内射记录.splice(index, 1);
}

function saveBodyEdit(): void {
  const f = bodyEditForm.value;
  // Drop blank body parts; trim names. Keep only the 5 known per-part fields.
  const cleanParts = f.身体部位
    .filter((p) => p.部位名称.trim() !== '')
    .map((p) => ({
      部位名称: p.部位名称.trim(),
      敏感度: p.敏感度,
      开发度: p.开发度,
      特征描述: p.特征描述,
      特殊印记: p.特殊印记,
    }));
  // Keep a record only if it has a date or description (drop fully-blank rows).
  const cleanRecords = f.子宫.内射记录
    .filter((r) => r.日期.trim() !== '' || r.描述.trim() !== '')
    .map((r) => ({ 日期: r.日期, 描述: r.描述 }));
  charEditor.updateBody({
    身高: f.身高,
    体重: f.体重,
    三围: { 胸围: f.胸围, 腰围: f.腰围, 臀围: f.臀围 },
    胸部描述: f.胸部描述,
    私处描述: f.私处描述,
    生殖器描述: f.生殖器描述,
    身体部位: cleanParts,
    敏感点: f.敏感点.slice(),
    纹身与印记: f.纹身与印记.slice(),
    // Merge over the open-time 子宫 snapshot to preserve any sub-fields not in the form.
    子宫: { ...bodyEditUterusRaw.value, 状态: f.子宫.状态, 宫口状态: f.子宫.宫口状态, 内射记录: cleanRecords },
  });
  showBodyEditModal.value = false;
}

// ─── Relationships ───

interface RelationEntry {
  名称: string;
  好感度?: number;
  内心想法?: string;
  在做事项?: string;
  图片档案?: Record<string, string | undefined>;
  [key: string]: unknown;
}

const relationships = useValue<RelationEntry[]>(P.relationships);

const relationList = computed<RelationEntry[]>(() => {
  const raw = relationships.value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => typeof r?.名称 === 'string');
});

/** 好感度颜色 */
function affinityColor(val: number | undefined): string {
  if (val === undefined) return 'var(--color-text-secondary)';
  if (val >= 60) return 'var(--color-success)';
  if (val >= 30) return 'var(--color-sage-300)';
  if (val >= 0) return 'var(--color-text-secondary)';
  return 'var(--color-danger)';
}

/** 好感度 bar 宽度（0-100%，以50为中点） */
function affinityPct(val: number | undefined): number {
  if (val === undefined) return 50;
  return Math.min(100, Math.max(0, ((val + 100) / 200) * 100));
}

// ─── NSFW body data ───

const nsfwEnabled = computed(() => get<boolean>('系统.nsfwMode') === true);

interface BodyPart {
  部位名称: string;
  敏感度?: number;
  开发度?: number;
  特征描述?: string;
  特殊印记?: string;
}

interface UterusData {
  状态?: string;
  宫口状态?: string;
  内射记录?: Array<{ 日期?: string; 描述?: string; 怀孕判定日?: string }>;
}

interface PlayerBody {
  身高?: number;
  体重?: number;
  三围?: { 胸围?: number; 腰围?: number; 臀围?: number };
  胸部描述?: string;
  私处描述?: string;
  生殖器描述?: string;
  身体部位?: BodyPart[];
  子宫?: UterusData;
  敏感点?: string[];
  开发度?: Record<string, number>;
  纹身与印记?: string[];
}

const playerBody = useValue<PlayerBody>('角色.身体');

const hasBodyData = computed(() => {
  const b = playerBody.value;
  if (!b || typeof b !== 'object') return false;
  return !!(b.身高 || b.体重 || b.三围 || b.胸部描述 || b.私处描述 || b.生殖器描述
    || b.身体部位?.length || b.敏感点?.length || b.开发度 || b.纹身与印记?.length);
});

const bodyParts = computed<BodyPart[]>(() => {
  const raw = playerBody.value?.身体部位;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is BodyPart => !!p?.部位名称);
});

function displayBodyPartName(name: string | undefined): string {
  if (!name) return '';
  const map: Record<string, string> = {
    嘴: t('character.body.partName.mouth'),
    胸部: t('character.body.partName.breast'),
    小穴: t('character.body.partName.pussy'),
    屁穴: t('character.body.partName.anus'),
  };
  return map[name] ?? name;
}

const devEntries = computed<Array<{ part: string; val: number }>>(() => {
  const raw = playerBody.value?.开发度;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, v]) => typeof v === 'number')
    .map(([part, val]) => ({ part, val: val as number }));
});

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

onUnmounted(() => {
  if (playerSecretViewerSrc.value) URL.revokeObjectURL(playerSecretViewerSrc.value);
});

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
      reference: secretRef,
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

// ─── Tab state ───

type Tab = 'basic' | 'attributes' | 'relations' | 'body' | 'playerImage';
const activeTab = ref<Tab>('basic');

const tabList = computed(() => {
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'basic', label: t('character.tab.basic') },
    { id: 'attributes', label: t('character.tab.attributes') },
    { id: 'relations', label: t('character.tab.relations'), count: relationList.value.length },
  ];
  if (nsfwEnabled.value) {
    tabs.push({ id: 'body', label: t('character.tab.body') });
  }
  tabs.push({ id: 'playerImage', label: t('character.tab.playerImage') });
  return tabs;
});

// ─── Inline editing state ───

interface EditingField {
  path: string;
  label: string;
  value: string;
}

const editingField = ref<EditingField | null>(null);
const editInputValue = ref('');

function startInlineEdit(path: string, label: string, currentValue: unknown): void {
  editingField.value = { path, label, value: String(currentValue ?? '') };
  editInputValue.value = String(currentValue ?? '');
}

function commitInlineEdit(): void {
  if (!editingField.value) return;
  const { path } = editingField.value;
  const raw = editInputValue.value.trim();

  const numericPaths: string[] = [P.characterAge];
  if (numericPaths.includes(path) && !isNaN(Number(raw))) {
    setValue(path, Number(raw));
  } else {
    setValue(path, raw);
  }

  editingField.value = null;
  eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.updated'), duration: 1500 });
}

function cancelInlineEdit(): void {
  editingField.value = null;
}

// ─── SchemaForm modal for complex editing ───

const showSchemaModal = ref(false);
const schemaModalData = ref<Record<string, unknown>>({});
const schemaModalPath = ref('');
const schemaModalTitle = ref('');

function getSubSchema(dotPath: string): Record<string, unknown> {
  const schema = getStateSchema();
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = schema;
  for (const seg of segments) {
    const props = current['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props && props[seg]) {
      current = props[seg];
    } else {
      return {};
    }
  }
  return current;
}

function openSchemaEdit(path: string, title: string): void {
  const data = get<Record<string, unknown>>(path);
  schemaModalPath.value = path;
  schemaModalTitle.value = title;
  schemaModalData.value = data ? (JSON.parse(JSON.stringify(data)) as Record<string, unknown>) : {};
  showSchemaModal.value = true;
}

function onSchemaUpdate(newValue: unknown): void {
  schemaModalData.value = newValue as Record<string, unknown>;
}

function saveSchemaEdit(): void {
  setValue(schemaModalPath.value, schemaModalData.value);
  showSchemaModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('character.toast.dataSaved'), duration: 1500 });
}

// ─── Attributes computed ───

interface AttributeEntry {
  key: string;
  label: string;
  current: number;
  max: number | null;
}

const attributeList = computed<AttributeEntry[]>(() => {
  const raw = attributes.value;
  if (!raw || typeof raw !== 'object') return [];

  const schema = getStateSchema();
  const defs = readStatFields(schema, P.characterAttributes);

  if (defs.length > 0) {
    return defs.map((def) => ({
      key: def.key,
      label: def.key,
      current: typeof raw[def.key] === 'number' ? (raw[def.key] as number) : 0,
      max: def.max,
    }));
  }

  return Object.entries(raw)
    .filter(([, val]) => typeof val === 'number')
    .map(([key, val]) => ({
      key,
      label: key,
      current: val as number,
      max: null,
    }));
});

function attrPercent(entry: AttributeEntry): number {
  if (entry.max === null || entry.max === 0) return 100;
  return Math.min(100, Math.max(0, (entry.current / entry.max) * 100));
}

/**
 * 先天六维列表（基线 1-10）
 *
 * 与 `attributeList` 的区别：
 *   - `attributeList` 读 `角色.属性`（后天六维，1-20），schema 驱动 x-display 扫描
 *   - 此 list 读 `角色.身份.先天六维`（基线 1-10），使用相同的字段名但独立存储
 *
 * 字段顺序与后天六维保持一致 —— 都来自同一个 schema stat section 扫描结果，
 * 只是值从不同路径读取。若后天六维列表为空（pack 未声明 x-display），退化为
 * 按先天六维对象的 own keys 顺序显示。
 */
const innateStatList = computed<AttributeEntry[]>(() => {
  const raw = innateStats.value;
  if (!raw || typeof raw !== 'object') return [];

  // 优先使用后天六维的字段顺序（schema x-order）以保持两列对齐
  if (attributeList.value.length > 0) {
    return attributeList.value.map((def) => ({
      key: def.key,
      label: def.label,
      current: typeof raw[def.key] === 'number' ? (raw[def.key] as number) : 0,
      max: 10, // 先天六维上限固定 10（与创角分配 perAttributeMax 对齐）
    }));
  }

  return Object.entries(raw)
    .filter(([, val]) => typeof val === 'number')
    .map(([key, val]) => ({
      key,
      label: key,
      current: val as number,
      max: 10,
    }));
});

function attrBarColor(pct: number): string {
  if (pct <= 25) return 'var(--color-danger)';
  if (pct <= 50) return 'var(--color-amber-400)';
  return 'var(--color-success)';
}

/** Schema for the SchemaForm modal */
const modalSchema = computed(() => getSubSchema(schemaModalPath.value));

/** Avatar initial */
const avatarInitial = computed<string>(() => {
  const n = name.value;
  if (!n || typeof n !== 'string') return '？';
  return n.charAt(0);
});
</script>

<template>
  <div class="character-panel">
    <template v-if="isLoaded">
      <!-- ─── Hero Header ─── -->
      <div class="hero-header">
        <Tooltip :text="t('character.hero.viewGallery')" interactive>
          <button class="hero-avatar" @click="activeTab = 'playerImage'">
            <ImageDisplay
              v-if="playerAvatarId"
              :asset-id="playerAvatarId"
              :fallback-letter="avatarInitial"
              size="fill"
              class="hero-avatar-img"
            />
            <span v-else>{{ avatarInitial }}</span>
          </button>
        </Tooltip>
        <div class="hero-info">
          <div class="hero-name-row">
            <h2 class="hero-name">{{ name ?? $t('character.hero.unnamed') }}</h2>
            <span v-if="occupation" class="occupation-badge">{{ occupation }}</span>
          </div>
          <div class="hero-sub">
            <span v-if="gender" class="hero-meta-item">{{ gender }}</span>
            <span v-if="age != null" class="hero-meta-item">{{ $t('character.hero.ageSuffix', { n: age }) }}</span>
            <span v-if="location" class="hero-meta-item location-item">📍 {{ location }}</span>
          </div>
          <!--
            2026-04-11 fix：特质是 string（单个），不是 string[]。
            用一个 chip 显示；附带天赋档次作为第二个 chip（若存在）。
          -->
          <div v-if="traitText || talentTier" class="trait-strip">
            <span v-if="traitText" class="trait-chip">{{ traitText }}</span>
            <span v-if="talentTier" class="trait-chip trait-chip--tier">{{ talentTier }}</span>
          </div>
        </div>
        <Tooltip :text="t('character.hero.editBasicInfo')" interactive>
          <button class="btn-edit-all" @click="openSchemaEdit(P.characterBaseInfo, t('character.hero.editBasicInfo'))">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <!-- ─── Tab bar ─── -->
      <div class="tab-bar" role="tablist">
        <button
          v-for="tab in tabList"
          :key="tab.id"
          role="tab"
          :class="['tab-btn', { 'tab-btn--active': activeTab === tab.id }]"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span v-if="tab.count && tab.count > 0" class="tab-count">{{ tab.count }}</span>
        </button>
      </div>

      <!-- ─── Tab: 基础 ─── -->
      <template v-if="activeTab === 'basic'">
        <section class="info-card" :aria-label="$t('character.basic.sectionBasicInfo')">
          <div class="info-grid">
            <!-- Name -->
            <div class="info-row" @dblclick="startInlineEdit(P.playerName, $t('character.basic.fieldName'), name)">
              <span class="info-label">{{ $t('character.basic.fieldName') }}</span>
              <template v-if="editingField?.path === P.playerName">
                <input
                  v-model="editInputValue"
                  class="inline-input"
                  @keydown.enter="commitInlineEdit"
                  @keydown.escape="cancelInlineEdit"
                  @blur="commitInlineEdit"
                />
              </template>
              <span v-else class="info-value">{{ name ?? '—' }}</span>
            </div>

            <!-- Age -->
            <div class="info-row" @dblclick="startInlineEdit(P.characterAge, $t('character.basic.fieldAge'), age)">
              <span class="info-label">{{ $t('character.basic.fieldAge') }}</span>
              <template v-if="editingField?.path === P.characterAge">
                <input
                  v-model="editInputValue"
                  type="number"
                  inputmode="numeric"
                  class="inline-input inline-input--narrow"
                  @keydown.enter="commitInlineEdit"
                  @keydown.escape="cancelInlineEdit"
                  @blur="commitInlineEdit"
                />
              </template>
              <span v-else class="info-value info-value--mono">{{ age ?? '—' }}</span>
            </div>

            <!-- Gender (Story 2: click → select dropdown) -->
            <div class="info-row" @click="!editingGender && startEditGender()">
              <span class="info-label">{{ $t('character.basic.fieldGender') }}</span>
              <template v-if="editingGender">
                <span @keydown.escape="editingGender = false">
                  <AgaSelect
                    :model-value="genderDraft"
                    :options="genderSelectOptions"
                    @update:model-value="v => { genderDraft = v; commitGender(); }"
                    @close="commitGender"
                  />
                </span>
              </template>
              <span v-else class="info-value info-value--editable">{{ gender ?? '—' }} <span class="edit-icon">✏</span></span>
            </div>

            <!-- Occupation (Story 2: click → inline text input) -->
            <div class="info-row" @click="!editingOccupation && startEditOccupation()">
              <span class="info-label">{{ $t('character.basic.fieldOccupation') }}</span>
              <template v-if="editingOccupation">
                <input
                  v-model="occupationDraft"
                  type="text"
                  class="inline-input"
                  @keydown.enter="commitOccupation"
                  @keydown.escape="cancelOccupation"
                  @blur="commitOccupation"
                />
              </template>
              <span v-else class="info-value info-value--editable">{{ occupation ?? '—' }} <span class="edit-icon">✏</span></span>
            </div>

            <!-- Location (Story 2: click-to-edit combo box with location suggestions) -->
            <div class="info-row" @click="startEditLocation">
              <span class="info-label">{{ $t('character.basic.fieldLocation') }}</span>
              <template v-if="editingLocation">
                <span @keydown.escape="cancelLocation">
                  <AgaSelect
                    :model-value="locationDraft"
                    :options="locationSelectOptions"
                    @update:model-value="v => { locationDraft = v; commitLocation(); }"
                    @close="commitLocation"
                  />
                </span>
              </template>
              <span v-else class="info-value info-value--editable">{{ location ?? '—' }} <span class="edit-icon">✏</span></span>
            </div>
          </div>
        </section>

        <!--
          2026-04-11 fix：新增「身份」section，展示创角选定的只读身份元数据。
          之前这些字段（出身 / 天赋档次 / 天赋列表 / 特质）没有在角色页面展示，
          玩家只能在 GameVariablePanel 里看到原始 JSON。
        -->
        <section
          v-if="origin || traitText || talentItems.length"
          class="identity-tier"
        >
          <!-- Origin -->
          <div v-if="origin" class="id-tier-section">
            <button class="id-tier-header" @click="idSectionOpen.origin = !idSectionOpen.origin; if (!idSectionOpen.origin) editingOrigin = false">
              <div class="id-tier-title-group">
                <span class="id-tier-indicator id-tier-indicator--origin" />
                <span class="id-tier-label">{{ $t('character.basic.fieldOrigin') }}</span>
              </div>
              <svg :class="['id-tier-chevron', { 'id-tier-chevron--open': idSectionOpen.origin }]" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            </button>
            <Transition name="id-tier-expand">
              <div v-if="idSectionOpen.origin" class="id-tier-body">
                <div :class="['id-entry', { 'id-entry--expanded': originDescExpanded }]" @click="originDescExpanded = !originDescExpanded">
                  <div class="id-entry__title">{{ origin }} <span class="edit-icon" @click.stop="startEditOrigin">✏</span></div>
                  <div v-if="originDesc" class="id-entry__text">{{ originDesc }}</div>
                </div>
              </div>
            </Transition>
          </div>

          <!-- Trait -->
          <div v-if="traitText" class="id-tier-section">
            <button class="id-tier-header" @click="idSectionOpen.trait = !idSectionOpen.trait; if (!idSectionOpen.trait) editingTrait = false">
              <div class="id-tier-title-group">
                <span class="id-tier-indicator id-tier-indicator--trait" />
                <span class="id-tier-label">{{ $t('character.basic.fieldTrait') }}</span>
              </div>
              <svg :class="['id-tier-chevron', { 'id-tier-chevron--open': idSectionOpen.trait }]" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            </button>
            <Transition name="id-tier-expand">
              <div v-if="idSectionOpen.trait" class="id-tier-body">
                <div :class="['id-entry', { 'id-entry--expanded': traitDescExpanded }]" @click="traitDescExpanded = !traitDescExpanded">
                  <div class="id-entry__title">{{ traitText }} <span class="edit-icon" @click.stop="startEditTrait">✏</span></div>
                  <div v-if="traitDesc" class="id-entry__text">{{ traitDesc }}</div>
                </div>
              </div>
            </Transition>
          </div>

          <!-- Talents (Story 2: editable with add/remove) -->
          <div v-if="talentItems.length || addingTalent" class="id-tier-section">
            <button class="id-tier-header" @click="idSectionOpen.talent = !idSectionOpen.talent">
              <div class="id-tier-title-group">
                <span class="id-tier-indicator id-tier-indicator--talent" />
                <span class="id-tier-label">{{ $t('character.basic.fieldTalent') }}</span>
                <span class="id-tier-count">{{ talentItems.length }}</span>
              </div>
              <svg :class="['id-tier-chevron', { 'id-tier-chevron--open': idSectionOpen.talent }]" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            </button>
            <Transition name="id-tier-expand">
              <div v-if="idSectionOpen.talent" class="id-tier-body">
                <div v-for="(talent, idx) in talentItems" :key="`${idx}-${talent.name}`" class="talent-entry">
                  <div :class="['id-entry', { 'id-entry--expanded': talentExpanded[idx] }]" @click="talentExpanded[idx] = !talentExpanded[idx]">
                    <div class="id-entry__title talent-title-row">
                      <span class="talent-name-group">
                        {{ talent.name }}
                        <span class="edit-icon" @click.stop="startEditTalent(idx)">✏</span>
                      </span>
                      <span class="edit-icon edit-icon--danger talent-delete" @click.stop="requestRemoveTalent(idx, talent.name)">✕</span>
                    </div>
                    <div v-if="talent.desc" class="id-entry__text">{{ talent.desc }}</div>
                  </div>
                </div>
                <button class="btn-add-talent" @click="startAddTalent">+ {{ $t('character.edit.addTalent') }}</button>
              </div>
            </Transition>
          </div>
        </section>

        <section class="info-card" :aria-label="$t('character.basic.sectionDescription')">
          <h3 class="card-title">{{ $t('character.basic.sectionDescription') }}</h3>
          <template v-if="editingDescription">
            <textarea v-model="descriptionDraft" class="inline-textarea" rows="3" autofocus @keydown.escape="cancelDescription" @blur="commitDescription" />
          </template>
          <p v-else class="description-text description-text--editable" @click="startEditDescription">
            {{ description || $t('character.edit.clickToEdit') }}
            <span class="edit-icon">✏</span>
          </p>
        </section>
      </template>

      <!-- ─── Tab: 属性 ─── -->
      <template v-else-if="activeTab === 'attributes'">
        <!--
          2026-04-11 fix：新增先天六维展示（创角基线，1-10 范围，只读）。
          与下方后天六维（运行时值，1-20 范围）对应同一套字段名，但来自不同状态树路径。
          先天六维 = 玩家分配的基线；后天六维 = 基线 + 出身修正 + 天赋修正。
        -->
        <section v-if="innateStatList.length" class="info-card" :aria-label="$t('character.attributes.sectionInnate')">
          <h3 class="card-title">{{ $t('character.attributes.sectionInnate') }} <span class="card-subtitle">{{ $t('character.attributes.innateSubtitle') }}</span></h3>
          <div class="attribute-list attribute-list--compact">
            <div v-for="attr in innateStatList" :key="attr.key" class="attribute-item attribute-item--stepper">
              <div class="attribute-header">
                <span class="attribute-name">{{ attr.label }}</span>
                <div class="stepper-group">
                  <button class="stepper-btn" @click="stepInnateAttr(attr.key, -1)" :disabled="attr.current <= 1">−</button>
                  <span class="attribute-numbers">{{ attr.current }}</span>
                  <button class="stepper-btn" @click="stepInnateAttr(attr.key, 1)" :disabled="attr.current >= 10">+</button>
                </div>
              </div>
              <div class="attribute-bar">
                <div class="attribute-bar__fill" :style="{ width: attrPercent(attr) + '%', background: 'var(--color-text-secondary, #8888a0)' }" />
              </div>
            </div>
          </div>
        </section>

        <section class="info-card" :aria-label="$t('character.attributes.sectionAcquired')">
          <h3 class="card-title">
            {{ $t('character.attributes.sectionAcquired') }} <span class="card-subtitle">{{ $t('character.attributes.acquiredSubtitle') }}</span>
            <Tooltip :text="$t('character.attributes.editAttributes')" interactive>
              <button class="btn-icon" @click="openSchemaEdit(P.characterAttributes, t('character.attributes.editAttributes'))">
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                </svg>
              </button>
            </Tooltip>
          </h3>
          <div v-if="attributeList.length" class="attribute-list">
            <div v-for="attr in attributeList" :key="attr.key" class="attribute-item attribute-item--stepper">
              <div class="attribute-header">
                <span class="attribute-name">{{ attr.label }}</span>
                <div class="stepper-group">
                  <button class="stepper-btn" @click="stepAcquiredAttr(attr.key, -1)" :disabled="attr.current <= 0">−</button>
                  <span class="attribute-numbers">{{ attr.current }}<template v-if="attr.max !== null"> / {{ attr.max }}</template></span>
                  <button class="stepper-btn" @click="stepAcquiredAttr(attr.key, 1)" :disabled="attr.current >= 20">+</button>
                </div>
              </div>
              <div class="attribute-bar">
                <div class="attribute-bar__fill" :style="{ width: attrPercent(attr) + '%', background: attrBarColor(attrPercent(attr)) }" />
              </div>
            </div>
          </div>
          <p v-else class="empty-hint">{{ $t('character.attributes.empty') }}</p>
        </section>

        <!-- Story 2: Vitals section -->
        <section class="info-card" :aria-label="$t('character.edit.vitals')">
          <h3 class="card-title">
            {{ $t('character.edit.vitals') }}
            <Tooltip :text="$t('character.edit.advancedEdit')" interactive>
              <button class="btn-icon" @click="openVitalsEdit">
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" /></svg>
              </button>
            </Tooltip>
          </h3>
          <div class="vitals-grid">
            <div class="vital-item">
              <span class="vital-label">{{ $t('character.edit.health') }}</span>
              <span class="vital-value">{{ vitalHealth?.当前 ?? 0 }} / {{ vitalHealth?.上限 ?? 100 }}</span>
            </div>
            <div class="vital-item">
              <span class="vital-label">{{ $t('character.edit.energy') }}</span>
              <span class="vital-value">{{ vitalEnergy?.当前 ?? 0 }} / {{ vitalEnergy?.上限 ?? 100 }}</span>
            </div>
            <div class="vital-item">
              <span class="vital-label">{{ $t('character.edit.reputation') }}</span>
              <span class="vital-value">{{ reputationVal ?? 0 }}</span>
            </div>
          </div>
        </section>
      </template>

      <!-- ─── Tab: 关系 ─── -->
      <template v-else-if="activeTab === 'relations'">
        <div v-if="relationList.length" class="relation-list">
          <div
            v-for="(rel, idx) in relationList"
            :key="idx"
            class="relation-card"
          >
            <div class="relation-header">
              <div class="relation-avatar">
                <ImageDisplay
                  :asset-id="rel['图片档案']?.['已选头像图片ID']"
                  :fallback-letter="rel.名称?.charAt(0) ?? '?'"
                  size="md"
                  class="relation-avatar-img"
                />
              </div>
              <div class="relation-info">
                <span class="relation-name">{{ rel.名称 }}</span>
                <span v-if="rel.在做事项" class="relation-activity">{{ rel.在做事项 }}</span>
              </div>
              <div v-if="rel.好感度 !== undefined" class="affinity-badge" :style="{ color: affinityColor(rel.好感度) }">
                {{ rel.好感度 > 0 ? '+' : '' }}{{ rel.好感度 }}
              </div>
            </div>
            <!-- Affinity bar -->
            <div v-if="rel.好感度 !== undefined" class="affinity-bar">
              <div
                class="affinity-bar__fill"
                :style="{ width: affinityPct(rel.好感度) + '%', background: affinityColor(rel.好感度) }"
              />
            </div>
            <p v-if="rel.内心想法" class="relation-thought">
              <span class="thought-quote">「</span>{{ rel.内心想法 }}<span class="thought-quote">」</span>
            </p>
            <button class="btn-jump-social" @click="jumpToNpcEdit(rel.名称)">✏ {{ $t('relationship.detail.edit') }}</button>
          </div>
        </div>
        <div v-else class="empty-state">
          <p>{{ $t('character.relations.empty') }}</p>
        </div>
      </template>

      <!-- ─── Tab: 身体 (NSFW) ─── -->
      <template v-else-if="activeTab === 'body' && nsfwEnabled">
        <div v-if="hasBodyData" class="body-nsfw-card">
          <div class="body-nsfw-title">{{ $t('character.body.title') }} <span class="body-nsfw-badge">{{ $t('character.body.privateBadge') }}</span></div>

          <!-- Measurements row (Story 2: display with edit button) -->
          <div class="body-metrics-row">
            <div v-if="playerBody?.身高" class="body-metric">
              <span class="body-metric-val">{{ playerBody.身高 }}</span>
              <span class="body-metric-lbl">{{ $t('character.body.heightUnit') }}</span>
            </div>
            <div v-if="playerBody?.体重" class="body-metric">
              <span class="body-metric-val">{{ playerBody.体重 }}</span>
              <span class="body-metric-lbl">{{ $t('character.body.weightUnit') }}</span>
            </div>
            <template v-if="playerBody?.三围">
              <div v-if="playerBody.三围.胸围" class="body-metric">
                <span class="body-metric-val">{{ playerBody.三围.胸围 }}</span>
                <span class="body-metric-lbl">{{ $t('character.body.bust') }}</span>
              </div>
              <div v-if="playerBody.三围.腰围" class="body-metric">
                <span class="body-metric-val">{{ playerBody.三围.腰围 }}</span>
                <span class="body-metric-lbl">{{ $t('character.body.waist') }}</span>
              </div>
              <div v-if="playerBody.三围.臀围" class="body-metric">
                <span class="body-metric-val">{{ playerBody.三围.臀围 }}</span>
                <span class="body-metric-lbl">{{ $t('character.body.hip') }}</span>
              </div>
            </template>
            <button class="btn-edit-body btn-edit-body--nsfw" @click="openBodyEdit">✏ {{ $t('map.action.edit') }}</button>
            <button class="btn-edit-body btn-edit-body--nsfw" @click="openAdvancedEditor('角色.身体')">⚙ {{ $t('character.edit.advancedEdit') }}</button>
          </div>

          <!-- Text descriptions (read-only display, edit via modal) -->
          <div v-if="playerBody?.胸部描述" class="body-desc-field">
            <span class="body-hint">{{ $t('character.body.breastDesc') }}</span>
            <p class="body-desc-text">{{ playerBody.胸部描述 }}</p>
          </div>
          <div v-if="playerBody?.私处描述" class="body-desc-field">
            <span class="body-hint">{{ $t('character.body.privateDesc') }}</span>
            <p class="body-desc-text">{{ playerBody.私处描述 }}</p>
          </div>
          <div v-if="playerBody?.生殖器描述" class="body-desc-field">
            <span class="body-hint">{{ $t('character.body.genitalDesc') }}</span>
            <p class="body-desc-text">{{ playerBody.生殖器描述 }}</p>
          </div>

          <!-- Body parts grid (mirrors NPC 私密信息.身体部位) -->
          <div v-if="bodyParts.length" class="body-parts-section">
            <span class="body-hint" style="display:block;margin-bottom:6px">{{ $t('character.body.bodyParts') }}</span>
            <div class="bp-grid">
              <div v-for="(bp, bi) in bodyParts" :key="bi" class="bp-card">
                <div class="bp-head">
                  {{ displayBodyPartName(bp.部位名称) }}
                  <span v-if="bp.特殊印记" class="bp-mark">{{ bp.特殊印记 }}</span>
                </div>
                <p v-if="bp.特征描述" class="bp-desc">{{ bp.特征描述 }}</p>
                <div class="bp-meters">
                  <div class="bp-meter">
                    <span>{{ $t('character.body.sensitivity') }}</span>
                    <div class="bp-bar"><div class="bp-fill" :style="{ width: (bp.敏感度 ?? 0) + '%' }" /></div>
                    <span>{{ bp.敏感度 ?? 0 }}</span>
                  </div>
                  <div class="bp-meter">
                    <span>{{ $t('character.body.development') }}</span>
                    <div class="bp-bar"><div class="bp-fill bp-fill--dev" :style="{ width: (bp.开发度 ?? 0) + '%' }" /></div>
                    <span>{{ bp.开发度 ?? 0 }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Uterus (mirrors NPC 子宫) -->
          <div v-if="playerBody?.子宫" class="body-uterus-section">
            <span class="body-hint" style="display:block;margin-bottom:6px">{{ $t('character.body.uterus') }}</span>
            <div class="uterus-card">
              <div v-if="playerBody.子宫.状态" class="uterus-row">
                <span class="body-hint">{{ $t('character.body.uterusStatus') }}</span>
                <span class="uterus-val">{{ playerBody.子宫.状态 }}</span>
              </div>
              <div v-if="playerBody.子宫.宫口状态" class="uterus-row">
                <span class="body-hint">{{ $t('character.body.uterusCervix') }}</span>
                <span class="uterus-val">{{ playerBody.子宫.宫口状态 }}</span>
              </div>
              <div v-if="playerBody.子宫.内射记录?.length" class="uterus-records">
                <span class="body-hint">{{ $t('character.body.inseminationRecords', { n: playerBody.子宫.内射记录.length }) }}</span>
                <div v-for="(rec, ri) in playerBody.子宫.内射记录" :key="ri" class="uterus-record-item">
                  <span v-if="rec.日期" class="uterus-record-date">{{ rec.日期 }}</span>
                  <span v-if="rec.描述" class="uterus-record-desc">{{ rec.描述 }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Legacy flat dev entries (for old saves that use 开发度 Record) -->
          <div v-if="devEntries.length && !bodyParts.length" class="body-dev-section">
            <span class="body-hint" style="display:block;margin-bottom:6px">{{ $t('character.body.devLevel') }}</span>
            <div class="body-dev-grid">
              <div v-for="d in devEntries" :key="d.part" class="body-dev-item">
                <span class="body-dev-name">{{ d.part }}</span>
                <div class="body-dev-bar"><div class="body-dev-fill" :style="{ width: d.val + '%' }" /></div>
                <span class="body-dev-num">{{ d.val }}</span>
              </div>
            </div>
          </div>

          <!-- Sensitive points -->
          <div v-if="playerBody?.敏感点?.length" class="body-tag-section">
            <span class="body-hint">{{ $t('character.body.sensitivePoints') }}</span>
            <div class="body-tag-row">
              <span v-for="s in playerBody.敏感点" :key="s" class="body-tag body-tag--nsfw">{{ s }}</span>
            </div>
          </div>

          <!-- Tattoos / marks -->
          <div v-if="playerBody?.纹身与印记?.length" class="body-tag-section">
            <span class="body-hint">{{ $t('character.body.tattoos') }}</span>
            <div class="body-tag-row">
              <span v-for="t in playerBody.纹身与印记" :key="t" class="body-tag body-tag--mark">{{ t }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <p>{{ $t('character.body.empty') }}</p>
        </div>
      </template>

      <!-- ─── Tab: 主角生图 ─── -->
      <template v-else-if="activeTab === 'playerImage'">
        <!-- Stats card -->
        <div class="player-stats-bar">
          <div class="player-stat-card"><span class="player-stat-val">{{ $t('character.image.statsTotal', { n: playerImageStats.total }) }}</span><span class="player-stat-lbl">{{ $t('character.image.statsLabel.total') }}</span></div>
          <div class="player-stat-card"><span class="player-stat-val" :style="{ color: playerImageStats.avatarBound ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted, #888)' }">{{ playerImageStats.avatarBound ? $t('character.image.bound') : $t('character.image.unbound') }}</span><span class="player-stat-lbl">{{ $t('character.image.statsLabel.avatar') }}</span></div>
          <div class="player-stat-card"><span class="player-stat-val" :style="{ color: playerImageStats.portraitBound ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted, #888)' }">{{ playerImageStats.portraitBound ? $t('character.image.bound') : $t('character.image.unbound') }}</span><span class="player-stat-lbl">{{ $t('character.image.statsLabel.portrait') }}</span></div>
          <div class="player-stat-card"><span class="player-stat-val">{{ playerImageStats.anchorName ?? $t('character.image.anchorUnset') }}</span><span class="player-stat-lbl">{{ $t('character.image.statsLabel.anchor') }}</span></div>
        </div>

        <section class="player-image-section">
          <div class="player-image-form">
            <h3 class="section-label">{{ $t('character.image.generateTitle') }}</h3>
            <p class="section-desc">{{ $t('character.image.generateDesc') }}</p>
            <div class="pi-backend-status">
              <span :class="['pi-status-dot', activeBackendStatus.configured ? 'pi-status-dot--ok' : 'pi-status-dot--off']" />
              <span class="pi-status-label">{{ activeBackendStatus.label }}</span>
              <span v-if="activeBackendStatus.model" class="pi-status-model">{{ activeBackendStatus.model }}</span>
              <span v-if="!activeBackendStatus.configured" class="pi-status-warn">{{ $t('character.image.notConfigured') }}</span>
            </div>

            <CivitaiLoraShelf
              v-if="activeBackend === 'civitai'"
              mode="compact"
              scope="player"
              :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
            />

            <div class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.composition') }}</label>
              <AgaSelect v-model="playerComposition" :options="compositionOptions" />
            </div>
            <div v-if="isPlayerCustomComposition" class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.compositionDesc') }}</label>
              <input v-model="playerCustomComposition" class="pi-select" :placeholder="$t('character.image.formLabel.compositionPlaceholder')" />
            </div>

            <div class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.style') }}</label>
              <AgaSelect v-model="playerStyle" :options="styleOptions" />
            </div>

            <div v-if="playerArtistPresetOptions.length > 1" class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.artistPreset') }}</label>
              <AgaSelect v-model="playerArtistPreset" :options="playerArtistPresetOptions" />
            </div>

            <div v-if="playerPngPresetOptions.length > 1" class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.pngPreset') }}</label>
              <AgaSelect v-model="playerPngPreset" :options="playerPngPresetOptions" />
            </div>

            <div class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.extraPrompt') }}</label>
              <textarea v-model="playerExtraPrompt" class="pi-textarea" rows="2" :placeholder="$t('character.image.formLabel.extraPlaceholder')" />
            </div>

            <div class="pi-form-row">
              <label class="pi-label">{{ $t('character.image.formLabel.size') }}</label>
              <input v-model="playerSize" class="pi-select" :placeholder="$t('character.image.formLabel.sizePlaceholder')" style="max-width:200px" />
            </div>

            <!-- Reference redraw (C1) -->
            <div v-if="PROVIDER_CAPABILITIES[playerDefaultBackend]?.imageToImage" class="pi-form-row" style="flex-direction:column;align-items:stretch">
              <div style="display:flex;align-items:center;gap:8px;">
                <label class="pi-label" style="margin:0">{{ $t('character.image.reference.label') }}</label>
                <AgaToggle v-model="playerRefEnabled" />
              </div>
              <div v-if="playerRefEnabled" style="display:flex;flex-direction:column;gap:6px;padding-left:12px;border-left:2px solid rgba(163,190,140,0.3);margin-top:6px;">
                <label class="pi-label">{{ $t('character.image.reference.source') }}</label>
                <AgaSelect
                  :options="[
                    { label: $t('character.image.reference.sourceUpload'), value: 'upload' },
                    { label: $t('character.image.reference.sourceAvatar'), value: 'avatar' },
                    { label: $t('character.image.reference.sourcePortrait'), value: 'portrait' },
                  ]"
                  v-model="playerRefSource"
                />
                <div v-if="playerRefSource === 'upload'" style="margin-top:4px;">
                  <label style="display:inline-block;padding:4px 12px;font-size:0.8rem;border:1px dashed var(--color-border);border-radius:6px;color:var(--color-text-secondary);cursor:pointer;">
                    {{ playerRefFile ? playerRefFile.name : $t('character.image.reference.selectFile') }}
                    <input type="file" accept="image/*" style="display:none" @change="onPlayerRefFileChange" />
                  </label>
                </div>
                <template v-if="PROVIDER_CAPABILITIES[playerDefaultBackend]?.referenceStrength">
                  <label class="pi-label" style="margin-top:4px;">{{ $t('character.image.reference.denoise') }}</label>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="0.1" max="1" step="0.05" v-model.number="playerRefDenoise" class="bp-edit-range" style="flex:1" data-testid="player-ref-denoise-slider" />
                    <span style="font-size:0.8rem;min-width:32px;text-align:right">{{ playerRefDenoise.toFixed(2) }}</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--color-text-muted);">
                    <span>{{ $t('character.image.reference.denoiseNear') }}</span><span>{{ $t('character.image.reference.denoiseMid') }}</span><span>{{ $t('character.image.reference.denoiseFar') }}</span>
                  </div>
                </template>
                <p v-else style="font-size:0.75rem;color:var(--color-text-muted);margin-top:4px;" data-testid="player-ref-strength-unsupported">
                  {{ $t('character.image.reference.strengthUnsupported') }}
                </p>
                <p style="font-size:0.75rem;color:var(--color-text-muted);margin-top:2px;">{{ $t('character.image.reference.notice') }}</p>
              </div>
            </div>
            <p v-else style="font-size:0.75rem;color:var(--color-text-muted);margin:0;">{{ $t('character.image.reference.unsupported') }}</p>

            <AgaButton
              class="pi-gen-btn"
              :loading="playerGenerating"
              @click="generatePlayerImage"
            >
              {{ playerComposition === 'portrait' ? $t('character.image.generateButton.portrait') : playerComposition === 'half-body' ? $t('character.image.generateButton.halfBody') : $t('character.image.generateButton.fullLength') }}
            </AgaButton>

            <div v-if="playerGenError" class="pi-error">{{ playerGenError }}</div>

            <!-- Player anchor management (UI-IMPLEMENTATION-DESIGN §3.1) -->
            <div class="anchor-section">
              <h3 class="section-label">{{ $t('character.image.anchor.title') }}</h3>
              <p class="section-desc">{{ $t('character.image.anchor.desc') }}</p>

              <div v-if="playerAnchor" class="anchor-editor">
                <div class="anchor-status anchor-status--active">{{ $t('character.image.anchor.established', { name: playerAnchor.name || $t('character.image.anchor.defaultName') }) }}</div>

                <div class="pi-form-row">
                  <label class="pi-label">{{ $t('character.image.anchor.positivePrompt') }}</label>
                  <textarea v-model="anchorPositive" class="pi-textarea" rows="2" :placeholder="$t('character.image.anchor.positivePlaceholder')" />
                </div>
                <div class="pi-form-row">
                  <label class="pi-label">{{ $t('character.image.anchor.negativePrompt') }}</label>
                  <textarea v-model="anchorNegative" class="pi-textarea" rows="1" :placeholder="$t('character.image.anchor.negativePlaceholder')" />
                </div>

                <div class="anchor-toggles">
                  <div class="anchor-toggle-row">
                    <div>
                      <span class="pi-label">{{ $t('character.image.anchor.toggleEnabled') }}</span>
                      <span class="section-desc">{{ $t('character.image.anchor.toggleEnabledDesc') }}</span>
                    </div>
                    <AgaToggle v-model="anchorEnabled" />
                  </div>
                  <div class="anchor-toggle-row">
                    <div>
                      <span class="pi-label">{{ $t('character.image.anchor.toggleAppend') }}</span>
                      <span class="section-desc">{{ $t('character.image.anchor.toggleAppendDesc') }}</span>
                    </div>
                    <AgaToggle v-model="anchorAppendDefault" />
                  </div>
                  <div class="anchor-toggle-row">
                    <div>
                      <span class="pi-label">{{ $t('character.image.anchor.toggleAutoScene') }}</span>
                      <span class="section-desc">{{ $t('character.image.anchor.toggleAutoSceneDesc') }}</span>
                    </div>
                    <AgaToggle v-model="anchorAutoScene" />
                  </div>
                </div>

                <div class="anchor-actions">
                  <AgaButton size="sm" @click="savePlayerAnchor">{{ $t('character.image.anchor.save') }}</AgaButton>
                  <AgaButton size="sm" variant="danger" @click="deletePlayerAnchor">{{ $t('character.image.anchor.delete') }}</AgaButton>
                </div>
              </div>

              <div v-else class="anchor-empty">
                <p>{{ $t('character.image.anchor.emptyHint') }}</p>
                <AgaButton size="sm" :loading="extractingAnchor" @click="extractPlayerAnchor">
                  {{ $t('character.image.anchor.extractButton') }}
                </AgaButton>
              </div>
            </div>
          </div>

          <!-- Player secret part close-up (NSFW gated, non-male) -->
          <div
            v-if="nsfwEnabled && gender && !String(gender).includes('男')"
            class="player-secret-section"
          >
            <CivitaiLoraShelf
              v-if="playerDefaultBackend === 'civitai'"
              mode="compact"
              scope="player"
              :mature-enabled="get('系统.扩展.image.config.civitai.allowMatureContent') === true"
            />
            <div class="secret-header-row">
              <div>
                <h3 class="section-label">{{ $t('character.image.secret.title') }}</h3>
                <p class="section-desc">{{ $t('character.image.secret.desc') }}</p>
              </div>
              <AgaButton
                size="sm"
                :disabled="!!playerSecretBusy"
                @click="generateAllPlayerSecretParts"
              >{{ playerSecretBusy === 'all' ? $t('character.image.secret.generating') : $t('character.image.secret.generateAll') }}</AgaButton>
            </div>

            <div class="secret-config-grid">
              <div class="pi-form-row" style="flex-direction:column;align-items:stretch">
                <label class="pi-label">{{ $t('character.image.secret.resolution') }}</label>
                <div class="secret-btn-row">
                  <button v-for="opt in playerSecretSizeOptions" :key="opt.value" type="button"
                    :class="['secret-opt-btn', { 'secret-opt-btn--active': playerSecretSizePreset === opt.value }]"
                    @click="playerSecretSizePreset = opt.value"
                  >{{ opt.label }}</button>
                </div>
              </div>
            </div>

            <div class="secret-config-grid">
              <div class="pi-form-row">
                <label class="pi-label">{{ $t('character.image.formLabel.artistPreset') }}</label>
                <AgaSelect :options="[{ label: t('character.image.formLabel.noPreset'), value: '' }, ...playerArtistPresetOptions.slice(1)]" v-model="playerSecretArtistPreset" />
              </div>
              <div class="pi-form-row">
                <label class="pi-label">{{ $t('character.image.formLabel.pngPreset') }}</label>
                <AgaSelect :options="playerPngPresetOptions" v-model="playerSecretPngPreset" />
              </div>
              <div class="pi-form-row" style="flex-direction:column;align-items:stretch">
                <label class="pi-label">{{ $t('character.image.formLabel.extraPrompt') }}</label>
                <textarea v-model="playerSecretExtraPrompt" class="pi-textarea" rows="2" placeholder="如：近景柔光、细节清晰、细腻写实..." />
              </div>
            </div>

            <div v-if="playerSecretStatusText" class="secret-status">{{ playerSecretStatusText }}</div>

            <div class="secret-cards">
              <div v-for="part in playerSecretParts" :key="part.key" class="secret-card">
                <div class="secret-card-header">
                  <span class="secret-card-label">{{ part.label }}</span>
                  <AgaButton size="sm" :disabled="!!playerSecretBusy" @click="generatePlayerSecretPart(part.key)">
                    {{ playerSecretBusy === part.key ? $t('character.image.secret.generating') : $t('character.image.secret.generate') }}
                  </AgaButton>
                  <AgaButton
                    v-if="getPlayerSecretPartAssetId(part.key) && PROVIDER_CAPABILITIES[playerDefaultBackend]?.imageToImage"
                    size="sm" variant="ghost"
                    :disabled="!!playerSecretBusy"
                    @click="generatePlayerSecretPartWithReference(part.key)"
                  >{{ $t('character.image.secret.referenceRedraw') }}</AgaButton>
                </div>
                <div
                  class="secret-card-image"
                  :class="{ 'secret-card-image--has-img': getPlayerSecretPartAssetId(part.key) }"
                  @click="getPlayerSecretPartAssetId(part.key) && openPlayerSecretViewer(getPlayerSecretPartAssetId(part.key)!)"
                >
                  <template v-if="getPlayerSecretPartAssetId(part.key)">
                    <ImageDisplay
                      :asset-id="getPlayerSecretPartAssetId(part.key)!"
                      :fallback-letter="part.label.charAt(0)"
                      size="lg"
                      class="secret-card-img"
                    />
                  </template>
                  <div v-else class="secret-card-placeholder">{{ $t('character.image.secret.noImage') }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Image viewer for secret part close-ups -->
          <teleport to="body">
            <div
              v-if="playerSecretViewerOpen"
              class="secret-viewer-overlay"
              @pointerdown="secretViewerBackdrop.onPointerdown"
              @pointerup="secretViewerBackdrop.onPointerup"
            >
              <img :src="playerSecretViewerSrc" class="secret-viewer-img" />
              <Tooltip :text="$t('common.actions.close')" interactive>
                <button class="secret-viewer-close" :aria-label="$t('common.actions.close')" @click="playerSecretViewerOpen = false">&times;</button>
              </Tooltip>
            </div>
          </teleport>

          <!-- Player image archive -->
          <div class="player-archive">
            <h3 class="section-label">{{ $t('character.image.archive.title') }}</h3>
            <div v-if="playerArchiveHistory.length > 0" class="player-grid">
              <div v-for="img in playerArchiveHistory" :key="String(img.id)" class="player-img-card">
                <div class="player-img-preview">
                  <ImageDisplay :asset-id="String(img.id)" :fallback-letter="name?.charAt(0) ?? '?'" size="lg" />
                  <div class="player-img-badges">
                    <span class="player-img-badge player-img-badge--status">{{ img.status === 'failed' ? $t('character.image.archive.statusFailed') : $t('character.image.archive.statusSuccess') }}</span>
                    <span v-if="img.composition" class="player-img-badge">{{ img.composition === 'portrait' ? $t('character.image.archive.compositionPortrait') : img.composition === 'half-body' ? $t('character.image.archive.compositionHalfBody') : img.composition === 'custom' ? $t('character.image.archive.compositionCustom') : $t('character.image.archive.compositionFullLength') }}</span>
                    <span v-if="playerAvatarId === String(img.id)" class="player-img-badge player-img-badge--selected">{{ $t('character.image.archive.selectedAvatar') }}</span>
                    <span v-if="playerPortraitId === String(img.id)" class="player-img-badge player-img-badge--selected">{{ $t('character.image.archive.selectedPortrait') }}</span>
                    <span v-if="isPlayerCurrentSecretPart(String(img.id), 'breast')" class="player-img-badge player-img-badge--secret">{{ $t('character.image.archive.secretBreast') }}</span>
                    <span v-if="isPlayerCurrentSecretPart(String(img.id), 'vagina')" class="player-img-badge player-img-badge--secret">{{ $t('character.image.archive.secretVagina') }}</span>
                    <span v-if="isPlayerCurrentSecretPart(String(img.id), 'anus')" class="player-img-badge player-img-badge--secret">{{ $t('character.image.archive.secretAnus') }}</span>
                  </div>
                </div>
                <div v-if="img.positivePrompt || img.negativePrompt" class="player-img-prompts">
                  <details v-if="img.positivePrompt" class="prompt-details">
                    <summary>{{ $t('character.image.archive.positivePrompt') }}</summary>
                    <pre class="prompt-text">{{ img.positivePrompt }}</pre>
                  </details>
                  <details v-if="img.negativePrompt" class="prompt-details">
                    <summary>{{ $t('character.image.archive.negativePrompt') }}</summary>
                    <pre class="prompt-text">{{ img.negativePrompt }}</pre>
                  </details>
                </div>
                <div class="player-img-actions">
                  <AgaButton
                    v-if="img.positivePrompt"
                    size="sm"
                    @click="openPlayerRegenerate(img as Record<string, unknown>)"
                  >{{ $t('character.image.archive.regenerateSame') }}</AgaButton>
                  <AgaButton
                    v-if="img.positivePrompt && PROVIDER_CAPABILITIES[playerDefaultBackend]?.imageToImage"
                    size="sm"
                    @click="openPlayerRegenerate(img as Record<string, unknown>, true)"
                  >{{ $t('character.image.archive.referenceRedraw') }}</AgaButton>
                  <AgaButton size="sm" variant="ghost" @click="analyzePlayerImageFromCard(String(img.id))">{{ $t('character.image.archive.analyzeStyle') }}</AgaButton>
                  <AgaButton size="sm" variant="ghost" @click="savePlayerAsReferenceMaterial(String(img.id))">{{ $t('character.image.archive.saveAsReference') }}</AgaButton>
                  <AgaButton
                    v-if="img.status !== 'failed' && img.composition !== 'secret_part'"
                    size="sm"
                    variant="secondary"
                    @click="setPlayerAvatar(String(img.id))"
                  >{{ playerAvatarId === String(img.id) ? $t('character.image.archive.unsetAvatar') : $t('character.image.archive.setAsAvatar') }}</AgaButton>
                  <AgaButton
                    v-if="img.status !== 'failed' && img.composition !== 'secret_part'"
                    size="sm"
                    variant="secondary"
                    @click="setPlayerPortrait(String(img.id))"
                  >{{ playerPortraitId === String(img.id) ? $t('character.image.archive.unsetPortrait') : $t('character.image.archive.setAsPortrait') }}</AgaButton>
                  <template v-if="img.status !== 'failed' && canShowPlayerSecretPartActions()">
                    <AgaButton size="sm" :variant="isPlayerCurrentSecretPart(String(img.id), 'breast') ? 'ghost' : 'secondary'" @click="isPlayerCurrentSecretPart(String(img.id), 'breast') ? clearPlayerSecretPart('breast') : setPlayerSecretPart(String(img.id), 'breast')">{{ isPlayerCurrentSecretPart(String(img.id), 'breast') ? $t('character.image.archive.cancelSecretBreast') : $t('character.image.archive.setSecretBreast') }}</AgaButton>
                    <AgaButton size="sm" :variant="isPlayerCurrentSecretPart(String(img.id), 'vagina') ? 'ghost' : 'secondary'" @click="isPlayerCurrentSecretPart(String(img.id), 'vagina') ? clearPlayerSecretPart('vagina') : setPlayerSecretPart(String(img.id), 'vagina')">{{ isPlayerCurrentSecretPart(String(img.id), 'vagina') ? $t('character.image.archive.cancelSecretVagina') : $t('character.image.archive.setSecretVagina') }}</AgaButton>
                    <AgaButton size="sm" :variant="isPlayerCurrentSecretPart(String(img.id), 'anus') ? 'ghost' : 'secondary'" @click="isPlayerCurrentSecretPart(String(img.id), 'anus') ? clearPlayerSecretPart('anus') : setPlayerSecretPart(String(img.id), 'anus')">{{ isPlayerCurrentSecretPart(String(img.id), 'anus') ? $t('character.image.archive.cancelSecretAnus') : $t('character.image.archive.setSecretAnus') }}</AgaButton>
                  </template>
                  <AgaButton size="sm" variant="danger" @click="deletePlayerImage(String(img.id))">{{ $t('common.actions.delete') }}</AgaButton>
                </div>
              </div>
            </div>
            <p v-else class="pi-empty">还没有生成过主角图片</p>
          </div>
        </section>
      </template>
    </template>

    <!-- Not loaded state -->
    <div v-else class="empty-state">
      <p>尚未加载游戏数据</p>
    </div>

    <!-- Player Regenerate-Same modal -->
    <RegenerateSameModal
      v-if="playerRegenPayload"
      :subject-label="playerRegenPayload.subjectLabel"
      :subtitle="playerRegenPayload.subtitle"
      :positive-prompt="playerRegenPayload.positivePrompt"
      :negative-prompt="playerRegenPayload.negativePrompt"
      :width="playerRegenPayload.width"
      :height="playerRegenPayload.height"
      :initial-backend="playerRegenPayload.initialBackend"
      :available-backends="availableBackendOptions"
      :busy="playerRegenBusy"
      :civitai-lora-snapshot="playerRegenPayload.civitaiLoraSnapshot"
      :source-asset-id="playerRegenPayload.sourceAssetId"
      :default-denoise-strength="Number(get('系统.扩展.image.config.reference.defaultDenoiseStrength') ?? 0.65)"
      :pre-activate-reference="playerRegenPayload.preActivateReference"
      @confirm="confirmPlayerRegenerate"
      @cancel="cancelPlayerRegenerate"
    />

    <!-- ─── SchemaForm Modal ─── -->
    <Modal v-model="showSchemaModal" :title="schemaModalTitle" width="560px">
      <SchemaForm
        :schema="modalSchema"
        :value="schemaModalData"
        @update:value="onSchemaUpdate"
      />
      <template #footer>
        <AgaButton variant="secondary" @click="showSchemaModal = false">取消</AgaButton>
        <AgaButton @click="saveSchemaEdit">保存</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Remove talent confirmation -->
    <Modal v-model="showRemoveTalentConfirm" :title="$t('character.edit.removeTalent')" width="360px">
      <p>{{ $t('character.edit.confirmRemove') }}</p>
      <p style="font-weight: 600; margin-top: 6px">{{ removeTalentName }}</p>
      <template #footer>
        <AgaButton variant="secondary" @click="showRemoveTalentConfirm = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton variant="danger" @click="confirmRemoveTalent">{{ $t('character.edit.removeTalent') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Body edit modal -->
    <Modal v-model="showBodyEditModal" :title="$t('character.body.title')" width="480px">
      <div class="vitals-edit-form">
        <div class="form-row-s2">
          <div class="form-group-s2">
            <label class="form-label-s2">{{ $t('character.body.heightUnit') }}</label>
            <input v-model.number="bodyEditForm.身高" type="number" min="0" class="form-input-s2" inputmode="numeric" />
          </div>
          <div class="form-group-s2">
            <label class="form-label-s2">{{ $t('character.body.weightUnit') }}</label>
            <input v-model.number="bodyEditForm.体重" type="number" min="0" class="form-input-s2" inputmode="numeric" />
          </div>
        </div>
        <div class="form-row-s2">
          <div class="form-group-s2">
            <label class="form-label-s2">{{ $t('character.body.bust') }}</label>
            <input v-model.number="bodyEditForm.胸围" type="number" min="0" class="form-input-s2" inputmode="numeric" />
          </div>
          <div class="form-group-s2">
            <label class="form-label-s2">{{ $t('character.body.waist') }}</label>
            <input v-model.number="bodyEditForm.腰围" type="number" min="0" class="form-input-s2" inputmode="numeric" />
          </div>
          <div class="form-group-s2">
            <label class="form-label-s2">{{ $t('character.body.hip') }}</label>
            <input v-model.number="bodyEditForm.臀围" type="number" min="0" class="form-input-s2" inputmode="numeric" />
          </div>
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.body.breastDesc') }}</label>
          <textarea v-model="bodyEditForm.胸部描述" class="form-textarea-s2" rows="2" />
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.body.privateDesc') }}</label>
          <textarea v-model="bodyEditForm.私处描述" class="form-textarea-s2" rows="2" />
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.body.genitalDesc') }}</label>
          <textarea v-model="bodyEditForm.生殖器描述" class="form-textarea-s2" rows="2" />
        </div>

        <!-- H-2: Body parts -->
        <div class="body-edit-section">
          <span class="body-edit-section-title">{{ $t('character.body.bodyParts') }}</span>
          <div v-for="(bp, bi) in bodyEditForm.身体部位" :key="bp._id" class="bp-edit-card">
            <div class="bp-edit-head">
              <input v-model="bp.部位名称" type="text" class="form-input-s2" :placeholder="$t('character.body.edit.partName')" />
              <Tooltip :text="$t('common.actions.delete')" interactive>
                <button type="button" class="bp-edit-remove" :aria-label="$t('common.actions.delete')" @click="removeDraftBodyPart(bi)">×</button>
              </Tooltip>
            </div>
            <textarea v-model="bp.特征描述" class="form-textarea-s2" rows="2" :placeholder="$t('character.body.edit.featureDescription')" />
            <input v-model="bp.特殊印记" type="text" class="form-input-s2" :placeholder="$t('character.body.edit.specialMark')" />
            <div class="form-row-s2">
              <div class="form-group-s2">
                <label class="form-label-s2">{{ $t('character.body.sensitivity') }} ({{ bp.敏感度 }})</label>
                <input v-model.number="bp.敏感度" type="range" min="0" max="100" class="bp-edit-range" />
              </div>
              <div class="form-group-s2">
                <label class="form-label-s2">{{ $t('character.body.development') }} ({{ bp.开发度 }})</label>
                <input v-model.number="bp.开发度" type="range" min="0" max="100" class="bp-edit-range" />
              </div>
            </div>
          </div>
          <button type="button" class="bp-edit-add" @click="addDraftBodyPart">+ {{ $t('character.body.edit.addBodyPart') }}</button>
        </div>

        <!-- H-2: Uterus -->
        <div class="body-edit-section">
          <span class="body-edit-section-title">{{ $t('character.body.uterus') }}</span>
          <div class="form-row-s2">
            <div class="form-group-s2">
              <label class="form-label-s2">{{ $t('character.body.uterusStatus') }}</label>
              <input v-model="bodyEditForm.子宫.状态" type="text" class="form-input-s2" />
            </div>
            <div class="form-group-s2">
              <label class="form-label-s2">{{ $t('character.body.uterusCervix') }}</label>
              <input v-model="bodyEditForm.子宫.宫口状态" type="text" class="form-input-s2" />
            </div>
          </div>
          <span class="form-label-s2">{{ $t('character.body.edit.inseminationRecords') }}</span>
          <div v-for="(rec, ri) in bodyEditForm.子宫.内射记录" :key="rec._id" class="record-edit-row">
            <input v-model="rec.日期" type="text" class="form-input-s2 record-edit-date" :placeholder="$t('character.body.edit.recordDate')" />
            <input v-model="rec.描述" type="text" class="form-input-s2" :placeholder="$t('character.body.edit.recordDesc')" />
            <Tooltip :text="$t('common.actions.delete')" interactive>
              <button type="button" class="bp-edit-remove" :aria-label="$t('common.actions.delete')" @click="removeInseminationRecord(ri)">×</button>
            </Tooltip>
          </div>
          <button type="button" class="bp-edit-add" @click="addInseminationRecord">+ {{ $t('character.body.edit.addRecord') }}</button>
        </div>

        <!-- H-2: Sensitive points -->
        <div class="body-edit-section">
          <span class="body-edit-section-title">{{ $t('character.body.sensitivePoints') }}</span>
          <div v-if="bodyEditForm.敏感点.length" class="tag-edit-row">
            <span v-for="(s, si) in bodyEditForm.敏感点" :key="si" class="tag-edit-chip">
              {{ s }}<Tooltip :text="$t('common.actions.delete')" interactive><button type="button" class="tag-edit-x" :aria-label="$t('common.actions.delete')" @click="removeSensitivePoint(si)">×</button></Tooltip>
            </span>
          </div>
          <div class="tag-edit-add">
            <input v-model="sensitivePointDraft" type="text" class="form-input-s2" :placeholder="$t('character.body.edit.addSensitivePoint')" @keyup.enter="addSensitivePoint" />
            <AgaButton variant="secondary" @click="addSensitivePoint">{{ $t('common.actions.add') }}</AgaButton>
          </div>
        </div>

        <!-- H-2: Tattoos / marks -->
        <div class="body-edit-section">
          <span class="body-edit-section-title">{{ $t('character.body.tattoos') }}</span>
          <div v-if="bodyEditForm.纹身与印记.length" class="tag-edit-row">
            <span v-for="(t, ti) in bodyEditForm.纹身与印记" :key="ti" class="tag-edit-chip">
              {{ t }}<Tooltip :text="$t('common.actions.delete')" interactive><button type="button" class="tag-edit-x" :aria-label="$t('common.actions.delete')" @click="removeTattoo(ti)">×</button></Tooltip>
            </span>
          </div>
          <div class="tag-edit-add">
            <input v-model="tattooDraft" type="text" class="form-input-s2" :placeholder="$t('character.body.edit.addTattoo')" @keyup.enter="addTattoo" />
            <AgaButton variant="secondary" @click="addTattoo">{{ $t('common.actions.add') }}</AgaButton>
          </div>
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showBodyEditModal = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton @click="saveBodyEdit">{{ $t('common.actions.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Origin edit modal -->
    <Modal v-model="showOriginModal" :title="$t('character.edit.origin')" width="420px">
      <div class="vitals-edit-form">
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.origin') }}</label>
          <input v-model="originNameDraft" type="text" class="form-input-s2" />
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.description') }}</label>
          <textarea v-model="originDescDraft" class="form-textarea-s2" rows="3" />
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showOriginModal = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton @click="commitOrigin">{{ $t('common.actions.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Trait edit modal -->
    <Modal v-model="showTraitModal" :title="$t('character.edit.trait')" width="420px">
      <div class="vitals-edit-form">
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.trait') }}</label>
          <input v-model="traitNameDraft" type="text" class="form-input-s2" />
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.description') }}</label>
          <textarea v-model="traitDescDraft" class="form-textarea-s2" rows="3" />
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showTraitModal = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton @click="commitTrait">{{ $t('common.actions.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Talent edit/add modal -->
    <Modal v-model="showTalentModal" :title="talentModalMode === 'edit' ? $t('character.edit.talent') : $t('character.edit.addTalent')" width="420px">
      <div class="vitals-edit-form">
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.talent') }}</label>
          <input v-model="talentNameDraft" type="text" class="form-input-s2" />
        </div>
        <div class="form-group-s2">
          <label class="form-label-s2">{{ $t('character.edit.description') }}</label>
          <textarea v-model="talentDescDraft" class="form-textarea-s2" rows="3" />
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showTalentModal = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton @click="commitEditTalent">{{ $t('common.actions.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 2: Vitals edit modal -->
    <Modal v-model="showVitalsEdit" :title="$t('character.edit.vitals')" width="400px">
      <div class="vitals-edit-form">
        <div class="vitals-edit-row">
          <span class="vitals-edit-label">{{ $t('character.edit.health') }}</span>
          <input v-model.number="vitalsForm.healthCurrent" type="number" min="0" class="vitals-edit-input" inputmode="numeric" />
          <span class="vitals-edit-sep">/</span>
          <input v-model.number="vitalsForm.healthMax" type="number" min="1" class="vitals-edit-input" inputmode="numeric" />
        </div>
        <div class="vitals-edit-row">
          <span class="vitals-edit-label">{{ $t('character.edit.energy') }}</span>
          <input v-model.number="vitalsForm.energyCurrent" type="number" min="0" class="vitals-edit-input" inputmode="numeric" />
          <span class="vitals-edit-sep">/</span>
          <input v-model.number="vitalsForm.energyMax" type="number" min="1" class="vitals-edit-input" inputmode="numeric" />
        </div>
        <div class="vitals-edit-row">
          <span class="vitals-edit-label">{{ $t('character.edit.reputation') }}</span>
          <input v-model.number="vitalsForm.reputation" type="number" min="0" class="vitals-edit-input" inputmode="numeric" />
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showVitalsEdit = false">{{ $t('common.actions.cancel') }}</AgaButton>
        <AgaButton @click="saveVitals">{{ $t('common.actions.save') }}</AgaButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.character-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  height: 100%;
  overflow-y: auto;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

/* ── Hero header ── */
.hero-header {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px;
  background: radial-gradient(ellipse 80% 60% at 20% 50%,
    color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    color-mix(in oklch, var(--color-sage-400) 4%, transparent));
  border-radius: 12px;
  position: relative;
}
.hero-header::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 0;
}

.hero-avatar {
  width: 120px;
  height: 120px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface-elevated);
  color: var(--color-text-secondary);
  font-size: 2.4rem;
  font-weight: 700;
  border: 2px solid transparent;
  border-radius: var(--radius-lg);
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  transition: border-color var(--duration-fast) ease,
              box-shadow var(--duration-fast) ease;
}
.hero-avatar:hover {
  border-color: var(--color-sage-400);
  box-shadow: var(--shadow-glow), 0 0 20px color-mix(in oklch, var(--color-sage-400) 18%, transparent);
}
.hero-avatar-img :deep(.img-display) { border-radius: var(--radius-lg); }
.hero-avatar-img :deep(.img-display--fill .img-display__img) { width: 100%; height: 100%; object-fit: cover; }
.hero-avatar-img :deep(.img-display__fallback) { font-size: 2.4rem; }

.hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hero-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hero-name {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
}

.occupation-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  border-radius: 10px;
  white-space: nowrap;
}

.hero-sub {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.hero-meta-item {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
}

.location-item {
  word-break: break-word;
}

.trait-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.trait-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border-radius: 10px;
}

.trait-chip--more {
  opacity: 0.6;
}

.trait-chip--tier {
  color: var(--color-amber-300);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}

.btn-edit-all {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  color: var(--color-text-secondary, #8888a0);
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-edit-all:hover {
  color: var(--color-sage-400);
  border-color: var(--color-sage-600);
}

/* ── Tab bar ── */
.tab-bar {
  display: flex;
  gap: 2px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
  padding: 3px;
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-text-secondary, #8888a0);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--color-text, #e0e0e6);
  background: rgba(255, 255, 255, 0.04);
}

.tab-btn--active {
  color: var(--color-text-bone);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  font-weight: 600;
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: var(--color-sage-500);
  border-radius: 8px;
}

/* ── Cards ── */
.info-card {
  padding: 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary, #8888a0);
}

.card-subtitle {
  font-size: 0.68rem;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.65;
  margin-left: 2px;
}

/* ── Info grid ── */
.info-grid {
  display: flex;
  flex-direction: column;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 0;
  cursor: default;
}
.info-row + .info-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.info-row:hover {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  padding-left: 4px;
  padding-right: 4px;
  box-shadow: var(--lumi-inset-highlight);
}

.info-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary, #8888a0);
}

.info-value {
  font-size: 0.85rem;
  color: var(--color-text, #e0e0e6);
  font-weight: 500;
  word-break: break-word;
}

.info-value--mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}


/* ── Inline editing ── */
.inline-input {
  height: 26px;
  padding: 0 8px;
  font-size: 0.84rem;
  color: var(--color-text);
  background: var(--color-surface-input);
  border: 1px solid var(--color-sage-600);
  border-radius: 6px;
  outline: none;
  max-width: 160px;
}

.inline-input--narrow {
  max-width: 80px;
}

/* ── Description ── */
.description-text {
  margin: 0;
  font-size: 0.84rem;
  color: var(--color-text, #e0e0e6);
  line-height: 1.65;
  opacity: 0.9;
}

/* ── Traits ── */
.trait-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.trait-tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: 14px;
}

/* ── Talents section (basic tab 身份 sub-section) ── */


/* ── Identity tier (mirrors .memory-tier pattern from MemoryPanel) ── */
.identity-tier {
  position: relative;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
  flex-shrink: 0;
}
.identity-tier::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 1;
}

.id-tier-section + .id-tier-section {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.id-tier-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text);
  user-select: none;
  transition: background var(--duration-fast, 120ms) ease;
}
.id-tier-header:hover {
  background: rgba(255, 255, 255, 0.02);
}
.id-tier-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.id-tier-indicator {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full, 999px);
  position: relative;
  flex-shrink: 0;
}
.id-tier-indicator::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: var(--radius-full, 999px);
  background: inherit;
  opacity: 0.4;
  filter: blur(5px);
}
.id-tier-indicator--origin { background: var(--color-amber-400, #d4a24e); }
.id-tier-indicator--trait  { background: var(--color-sage-400); }
.id-tier-indicator--talent { background: var(--color-success); }

.id-tier-label {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
}
.id-tier-count {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--color-text-muted);
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: var(--radius-full, 999px);
  letter-spacing: 0.02em;
}

.id-tier-chevron {
  color: var(--color-text-muted);
  width: 14px;
  height: 14px;
  transition: transform var(--duration-normal, 240ms) ease;
  transform: rotate(-90deg);
}
.id-tier-chevron--open {
  transform: rotate(0deg);
}

/* Tier expand transition */
.id-tier-expand-enter-active {
  transition: opacity var(--duration-normal, 240ms) ease,
              max-height var(--duration-normal, 240ms) ease;
  overflow: hidden;
  max-height: 2000px;
}
.id-tier-expand-leave-active {
  transition: opacity var(--duration-fast, 120ms) ease,
              max-height var(--duration-fast, 120ms) ease;
  overflow: hidden;
}
.id-tier-expand-enter-from,
.id-tier-expand-leave-to {
  opacity: 0;
  max-height: 0;
  padding: 0 12px;
}

.id-tier-body {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Entry (mirrors .mem-entry) */
.id-entry {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  transition: background var(--duration-fast, 120ms) ease;
  position: relative;
}
.id-entry:hover {
  background: rgba(255, 255, 255, 0.045);
  box-shadow: var(--lumi-inset-highlight);
}
.id-entry::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  opacity: 0.35;
  transition: opacity var(--duration-fast, 120ms) ease;
}
.id-entry:hover::before { opacity: 0.8; }
.id-tier-section:nth-child(1) .id-entry::before { background: var(--color-amber-400, #d4a24e); }
.id-tier-section:nth-child(2) .id-entry::before { background: var(--color-sage-400); }
.id-tier-section:nth-child(3) .id-entry::before { background: var(--color-success); }

.id-entry__title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--color-text);
}
.id-entry__text {
  margin-top: 6px;
  font-family: var(--font-serif-cjk, serif);
  font-size: 0.8rem;
  line-height: 1.75;
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  letter-spacing: 0.01em;
}
.id-entry--expanded .id-entry__text {
  -webkit-line-clamp: unset;
}


/* ── Attributes ── */
.attribute-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* compact variant for 先天六维 (thinner bars, tighter spacing) */
.attribute-list--compact {
  gap: 6px;
}
.attribute-list--compact .attribute-bar {
  height: 4px;
}
.attribute-list--compact .attribute-numbers {
  font-size: 0.72rem;
}

.attribute-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attribute-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.attribute-name {
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  font-weight: 500;
}

.attribute-numbers {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
}

.attribute-bar {
  height: 5px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  overflow: hidden;
}

.attribute-bar__fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

/* ── Relations ── */
.relation-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relation-card {
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: var(--lumi-inset-highlight);
}

.relation-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.relation-avatar {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
}
.relation-avatar-img :deep(.img-display) { width: 34px; height: 34px; border-radius: 50%; }
.relation-avatar-img :deep(.img-display__img) { width: 100%; height: 100%; object-fit: cover; }
.relation-avatar-img :deep(.img-display__fallback) {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  color: var(--color-sage-400);
  font-size: 0.9rem;
  font-weight: 700;
}

.relation-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.relation-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
}

.relation-activity {
  font-size: 0.75rem;
  color: var(--color-text-secondary, #8888a0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.affinity-badge {
  font-size: 0.78rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  flex-shrink: 0;
}

.affinity-bar {
  height: 3px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
  overflow: hidden;
}

.affinity-bar__fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease;
  opacity: 0.6;
  box-shadow: 0 0 6px currentColor;
}

.relation-thought {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  font-style: italic;
  line-height: 1.5;
}

.thought-quote {
  font-style: normal;
  opacity: 0.5;
}

/* ── Badge ── */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: var(--color-sage-500);
  border-radius: 9px;
}

/* ── Buttons ── */
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--color-text-secondary, #8888a0);
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.15s ease;
}
.btn-icon:hover {
  color: var(--color-sage-400);
}

/* ── Empty states ── */
.empty-hint {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.6;
  margin: 0;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 100px;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.9rem;
}

/* ── Scrollbar ── */
.character-panel::-webkit-scrollbar {
  width: 5px;
}
.character-panel::-webkit-scrollbar-track {
  background: transparent;
}
.character-panel::-webkit-scrollbar-thumb {
  background: color-mix(in oklch, var(--color-text-umber) 35%, transparent);
  border-radius: 3px;
}

/* Player image stats bar */
.player-stats-bar {
  display: flex; gap: 8px; padding: 8px 0; margin-bottom: 8px;
}
.player-stat-card {
  display: flex; flex-direction: column; align-items: center;
  padding: 6px 12px; background: var(--color-surface);
  border: 1px solid var(--color-border-subtle); border-radius: 6px;
  min-width: 80px;
}
.player-stat-val { font-size: 13px; font-weight: 600; color: var(--color-text, #e0e0e6); }
.player-stat-lbl { font-size: 11px; color: var(--color-text-muted, #55556a); }

/* Player image tab */
.player-image-section { display: flex; flex-direction: column; gap: var(--space-xl, 24px); }
.player-image-form { display: flex; flex-direction: column; gap: var(--space-md, 12px); }
.section-label { font-size: var(--font-size-md, 14px); color: var(--color-text, #e0e0e6); }
.section-desc { font-size: var(--font-size-xs, 12px); color: var(--color-text-muted, #55556a); }
.pi-backend-status { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--color-text-secondary, #8888a0); margin-top: 4px; }
.pi-status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.pi-status-dot--ok { background: #4ade80; box-shadow: 0 0 6px #4ade8066, 0 0 12px #4ade8033; }
.pi-status-dot--off { background: #666; }
.pi-status-label { font-weight: 600; color: var(--color-text, #e0e0e6); }
.pi-status-model { color: var(--color-text-secondary, #8888a0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.pi-status-warn { color: var(--color-amber, #fbbf24); }
.pi-form-row { display: flex; flex-direction: column; gap: 4px; }
.pi-label { font-size: var(--font-size-xs, 12px); color: var(--color-text-secondary, #8888a0); }
.pi-select, .pi-textarea {
  padding: 6px 10px;
  background: var(--color-surface-input, #1a1a24);
  border: 1px solid var(--color-border-subtle, #222230);
  border-radius: var(--radius-md, 8px);
  color: var(--color-text, #e0e0e6);
  font-size: var(--font-size-sm, 13px);
  transition: border-color var(--duration-fast) var(--ease-out);
}
.pi-select:focus, .pi-textarea:focus {
  outline: none;
  border-color: var(--color-sage-600);
}
.pi-textarea { resize: vertical; font-family: var(--font-sans); }
.pi-gen-btn { align-self: flex-start; }
.pi-error { padding: 6px 10px; background: color-mix(in oklch, var(--color-danger) 12%, transparent); border: 1px solid var(--color-danger); border-radius: 6px; color: var(--color-danger); font-size: 12px; }
.pi-empty { color: var(--color-text-muted, #55556a); font-size: 13px; text-align: center; padding: 24px; }
.player-archive { }
.player-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: var(--space-md, 12px); }
.player-img-card { background: var(--color-surface); border: 1px solid var(--color-border-subtle); border-radius: 8px; overflow: hidden; box-shadow: var(--lumi-inset-highlight); }
.player-img-preview { position: relative; }
.player-img-preview :deep(.img-display) { width: 100%; height: auto; aspect-ratio: 3/4; border-radius: 0; }
.player-img-badges {
  position: absolute; top: 4px; left: 4px;
  display: flex; flex-direction: column; gap: 3px;
}
.player-img-badge {
  display: inline-block; width: fit-content;
  padding: 1px 6px; border-radius: 4px;
  font-size: 10px; font-weight: 500;
  border: 1px solid var(--color-border, #2a2a3a);
  background: rgba(0,0,0,0.6); color: var(--color-text-muted, #888);
  backdrop-filter: blur(4px);
}
.player-img-badge--status { border-color: var(--color-success, #22c55e); color: var(--color-success, #22c55e); }
.player-img-badge--selected { border-color: var(--color-sage-400); color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-400) 18%, transparent); }
.player-img-badge--secret { border-color: var(--color-rose-400, #eb6f92); color: var(--color-rose-400, #eb6f92); background: rgba(235, 111, 146, 0.15); box-shadow: 0 0 8px rgba(235, 111, 146, 0.25); }
.player-img-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; }
.player-img-prompts { display: flex; flex-direction: column; gap: 4px; padding: 4px 8px 0; }
.player-img-prompts .prompt-details summary {
  font-size: 11px; color: var(--color-text-muted, #888); cursor: pointer;
  list-style: none;
}
.player-img-prompts .prompt-details summary::-webkit-details-marker { display: none; }
.player-img-prompts .prompt-details summary::before { content: '▸ '; display: inline-block; transition: transform 0.15s; }
.player-img-prompts .prompt-details[open] summary::before { transform: rotate(90deg); }
.player-img-prompts .prompt-text {
  font-size: 11px; color: var(--color-text-secondary, #b0b0c0);
  white-space: pre-wrap; word-break: break-all;
  max-height: 120px; overflow-y: auto;
  background: var(--color-bg, #0d0d14);
  padding: 6px 8px; border-radius: 4px; margin-top: 4px;
}

/* Anchor section */
.anchor-section {
  margin-top: var(--space-lg, 16px);
  padding: var(--space-md, 12px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  background: var(--color-surface-elevated);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.anchor-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-bottom: 8px; }
.anchor-status--active { background: color-mix(in oklch, var(--color-success) 12%, transparent); color: var(--color-success); }
.anchor-toggles { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.anchor-toggle-row {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--color-border, #2a2a3a); background: var(--color-surface, #1a1a24);
}
.anchor-actions { display: flex; gap: 6px; }
.anchor-empty { text-align: center; padding: 16px; color: var(--color-text-muted, #55556a); font-size: 13px; }
.anchor-empty p { margin-bottom: 8px; }

/* ── Body / NSFW tab ── */
.body-nsfw-card {
  padding: 14px;
  border-radius: var(--radius-lg, 12px);
  background: linear-gradient(135deg, rgba(232, 121, 160, 0.04), rgba(232, 121, 160, 0.02) 60%);
  border: 1px solid rgba(232, 121, 160, 0.08);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.body-nsfw-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: #e879a0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.body-nsfw-badge {
  font-size: 0.58rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(232, 121, 160, 0.12);
  color: #e879a0;
  letter-spacing: 0.06em;
}
.body-metrics-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.body-metric {
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding: 6px 12px;
  background: rgba(232, 121, 160, 0.04);
  border: 1px solid rgba(232, 121, 160, 0.08);
  border-radius: 8px;
}
.body-metric-val {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text-bone, #e0e0e6);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}
.body-metric-lbl {
  font-size: 0.68rem;
  color: var(--color-text-secondary, #8888a0);
}
.body-hint {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--color-text-secondary, #8888a0);
}
.body-desc-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.body-desc-text {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: color-mix(in oklch, var(--color-text-bone, #e0e0e6) 70%, transparent);
  font-style: italic;
}
.body-dev-section {
  margin-top: 2px;
}
.body-dev-grid {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.body-dev-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.body-dev-name {
  font-size: 0.74rem;
  color: var(--color-text-bone, #e0e0e6);
  min-width: 48px;
  font-weight: 500;
}
.body-dev-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(232, 121, 160, 0.1);
  overflow: hidden;
}
.body-dev-fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #e879a0, #f472b6);
  transition: width 0.4s ease;
}
.body-dev-num {
  font-size: 0.7rem;
  font-weight: 600;
  color: #e879a0;
  min-width: 22px;
  text-align: right;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}
.body-tag-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.body-tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.body-tag {
  padding: 3px 12px;
  font-size: 0.72rem;
  font-weight: 500;
  border-radius: 14px;
}
.body-tag--nsfw {
  background: rgba(232, 121, 160, 0.07);
  color: #e879a0;
  border: 1px solid rgba(232, 121, 160, 0.12);
}
.body-tag--mark {
  background: color-mix(in oklch, var(--color-sage-600, #4a8a6a) 10%, transparent);
  color: var(--color-sage-400, #6aaa8a);
  border: 1px solid color-mix(in oklch, var(--color-sage-600, #4a8a6a) 15%, transparent);
}

/* ── Body parts grid (mirrors RelationshipPanel .bp-*) ── */
.body-parts-section,
.body-uterus-section {
  margin-top: 2px;
}
.bp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
}
.bp-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(232, 121, 160, 0.025);
  border: 1px solid rgba(232, 121, 160, 0.08);
  transition: border-color 0.15s;
}
.bp-card:hover {
  border-color: rgba(232, 121, 160, 0.2);
  box-shadow: inset 0 0 10px rgba(232, 121, 160, 0.06);
}
.bp-head {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text-bone, #e0e0e6);
  display: flex;
  align-items: center;
  gap: 4px;
}
.bp-mark {
  font-size: 0.65rem;
  color: #e879a0;
  opacity: 0.8;
}
.bp-desc {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  margin: 3px 0 6px;
  line-height: 1.4;
}
.bp-meters {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bp-meter {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.62rem;
  color: var(--color-text-secondary, #8888a0);
}
.bp-bar {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in oklch, var(--color-text-bone, #e0e0e6) 6%, transparent);
  overflow: hidden;
}
.bp-fill {
  height: 100%;
  border-radius: 2px;
  background: #e879a0;
  transition: width 0.3s;
}
.bp-fill--dev {
  background: var(--color-sage-600, #4a8a6a);
}

/* ── Uterus card ── */
.uterus-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(232, 121, 160, 0.025);
  border: 1px solid rgba(232, 121, 160, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.uterus-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.uterus-val {
  font-size: 0.82rem;
  color: var(--color-text-bone, #e0e0e6);
}
.uterus-records {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}
.uterus-record-item {
  display: flex;
  gap: 8px;
  font-size: 0.72rem;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(232, 121, 160, 0.04);
}
.uterus-record-date {
  color: #e879a0;
  font-weight: 500;
  flex-shrink: 0;
}
.uterus-record-desc {
  color: var(--color-text-secondary, #8888a0);
  font-style: italic;
}

/* ─── Mobile: stack hero, fullwidth sections ─── */
@media (max-width: 767px) {
  .character-panel {
    padding-left: var(--space-sm);
    padding-right: var(--space-sm);
    transition: none;
  }
  .hero-header {
    flex-wrap: wrap;
  }
  .hero-avatar {
    width: 80px;
    height: 80px;
    font-size: 1.8rem;
  }
  .player-archive {
    width: 100%;
  }
  .bp-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
  /* Story 2: mobile touch targets */
  .stepper-btn { min-width: 44px; min-height: 44px; font-size: 1rem; }
  .btn-add-talent { min-height: 44px; }
  .btn-sm { min-height: 44px; }
  .btn-edit-body { min-height: 44px; }
  .btn-jump-social { min-height: 44px; }
  .btn-edit-all { min-height: 44px; }
  .vitals-edit-input { height: 44px; }
  .form-input-s2 { height: 44px; }
  .form-textarea-s2 { min-height: 44px; }
  .form-row-s2 { flex-direction: column; }
  .body-metric-input { height: 44px; width: 80px; }
}

@media (hover: none) and (pointer: coarse) {
  .edit-icon { opacity: 0.5; }
  .info-value--editable:active { background: rgba(163, 190, 140, 0.08); border-radius: 4px; }
}

/* ─── Player secret part close-up styles ─── */
.player-secret-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md, 12px);
  padding: var(--space-lg, 20px) 0;
  border-top: 1px solid rgba(255,255,255,0.06);
}

.secret-header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md, 12px);
}

.secret-config-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm, 8px);
}

.secret-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.secret-opt-btn {
  padding: 4px 12px;
  font-size: 0.78rem;
  border-radius: 6px;
  border: 1px solid var(--color-border-subtle);
  background: var(--glass-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.secret-opt-btn:hover {
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.secret-opt-btn--active {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border-color: var(--color-sage-300);
  color: var(--color-sage-300);
}

.secret-status {
  font-size: 0.8rem;
  color: var(--color-text-secondary, #aaa);
  padding: 4px 0;
}

.secret-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-md, 12px);
}

.secret-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(255,255,255,0.03);
  border-radius: 10px;
  padding: var(--space-sm, 8px);
  border: 1px solid rgba(255,255,255,0.06);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: var(--lumi-inset-highlight), inset 0 0 12px rgba(232, 121, 160, 0.03);
}

.secret-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.secret-card-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-primary, #e5e5e5);
  margin-right: auto;
}

.secret-card-image {
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0,0,0,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.secret-card-image--has-img {
  cursor: pointer;
}
.secret-card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.secret-card-placeholder {
  font-size: 0.78rem;
  color: var(--color-text-muted, #666);
}

/* Viewer overlay */
.secret-viewer-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
}
.secret-viewer-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
}
.secret-viewer-close {
  position: absolute;
  top: 16px;
  right: 20px;
  font-size: 2rem;
  color: #fff;
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s;
}
.secret-viewer-close:hover { opacity: 1; }

@media (max-width: 600px) {
  .secret-cards {
    grid-template-columns: 1fr 1fr;
  }
}

/* ── Story 2: Inline editing ── */
.info-value--editable { cursor: pointer; transition: color 0.15s ease; }
.info-value--editable:hover { color: var(--color-sage-300); }
.edit-icon { font-size: 0.7em; opacity: 0.3; transition: opacity 0.15s; margin-left: 3px; }
.info-value--editable:hover .edit-icon,
.id-entry__title:hover .edit-icon,
.description-text--editable:hover .edit-icon { opacity: 0.8; }
.edit-icon--danger { color: var(--color-danger); }
.edit-icon--danger:hover { opacity: 1; }
.inline-textarea {
  width: 100%;
  padding: 6px 10px;
  font-size: 0.84rem;
  color: var(--color-text, #e0e0e6);
  background: var(--color-surface-input, rgba(255,255,255,0.04));
  border: 1px solid var(--color-sage-600);
  border-radius: 6px;
  outline: none;
  resize: vertical;
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.description-text--editable { cursor: pointer; }
.description-text--editable:hover { color: var(--color-sage-300); }

/* Identity edit form */
.id-edit-form { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; }
.id-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
.btn-sm { padding: 2px 10px; font-size: 0.78rem; border: 1px solid var(--color-border); border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.04); color: var(--color-text-secondary); }
.btn-save { color: var(--color-sage-400); border-color: var(--color-sage-600); }
.btn-cancel { color: var(--color-text-secondary); }
.btn-add-talent { padding: 4px 12px; font-size: 0.75rem; color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent); border-radius: 6px; cursor: pointer; margin-top: 6px; }
.talent-entry { margin-bottom: 4px; }
.talent-title-row { display: flex; align-items: center; justify-content: space-between; width: 100%; }
.talent-name-group { display: flex; align-items: center; gap: 4px; }
.talent-delete { flex-shrink: 0; margin-left: auto; }

/* Stepper buttons */
.attribute-item--stepper .attribute-header { display: flex; align-items: center; }
.stepper-group { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.stepper-btn { min-width: 24px; min-height: 24px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; font-weight: 700; color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent); border-radius: 4px; cursor: pointer; transition: all 0.15s; }
.stepper-btn:hover:not(:disabled) { background: color-mix(in oklch, var(--color-sage-400) 20%, transparent); }
.stepper-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* Vitals display */
.vitals-grid { display: flex; gap: 16px; flex-wrap: wrap; }
.vital-item { display: flex; flex-direction: column; gap: 2px; min-width: 80px; }
.vital-label { font-size: 0.72rem; color: var(--color-text-secondary); }
.vital-value { font-size: 0.9rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: var(--color-text); }

/* Vitals edit modal */
.vitals-edit-form { display: flex; flex-direction: column; gap: 12px; }
.vitals-edit-row { display: flex; align-items: center; gap: 8px; }
.vitals-edit-label { font-size: 0.82rem; color: var(--color-text-secondary); min-width: 50px; }
.vitals-edit-input { width: 80px; height: 32px; padding: 0 8px; font-size: 0.84rem; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 6px; outline: none; }
.vitals-edit-sep { color: var(--color-text-secondary); font-size: 0.9rem; }

/* Relations jump button */
.btn-jump-social { padding: 3px 10px; font-size: 0.72rem; color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent); border-radius: 4px; cursor: pointer; margin-top: 6px; transition: all 0.15s; }
.btn-jump-social:hover { background: color-mix(in oklch, var(--color-sage-400) 16%, transparent); }

/* Body editing */
.body-metric--editable { flex-direction: column; }
.body-metric-input { width: 60px; height: 28px; padding: 0 6px; font-size: 0.88rem; font-weight: 700; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 4px; outline: none; text-align: center; font-family: 'JetBrains Mono', monospace; }
/* Story 2: Modal form classes */
.form-group-s2 { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.form-row-s2 { display: flex; gap: 10px; }
.form-label-s2 { font-size: 0.75rem; font-weight: 500; color: var(--color-text-secondary); }
.form-input-s2 { height: 34px; padding: 0 10px; font-size: 0.84rem; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 6px; outline: none; }
.form-textarea-s2 { padding: 8px 10px; font-size: 0.84rem; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 6px; outline: none; resize: vertical; }
.btn-edit-body { padding: 4px 10px; font-size: 0.78rem; color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent); border-radius: 5px; cursor: pointer; transition: all 0.15s; }
.btn-edit-body:hover { background: color-mix(in oklch, var(--color-sage-400) 16%, transparent); }
.btn-edit-body--nsfw { color: #e879a0; background: rgba(232, 121, 160, 0.08); border-color: rgba(232, 121, 160, 0.25); }
.btn-edit-body--nsfw:hover { background: rgba(232, 121, 160, 0.16); }

/* H-2: Body modal — parts / uterus / sensitive points / tattoos editing */
.body-edit-section { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; padding-top: 12px; border-top: 1px solid color-mix(in oklch, var(--color-border) 60%, transparent); }
.body-edit-section-title { font-size: 0.8rem; font-weight: 600; color: #e879a0; }
.bp-edit-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 8px; background: rgba(232, 121, 160, 0.05); border: 1px solid rgba(232, 121, 160, 0.18); }
.bp-edit-head { display: flex; align-items: center; gap: 8px; }
.bp-edit-head .form-input-s2 { flex: 1; }
.bp-edit-remove { flex: none; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; line-height: 1; color: #e879a0; background: rgba(232, 121, 160, 0.1); border: 1px solid rgba(232, 121, 160, 0.25); border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.bp-edit-remove:hover { background: rgba(232, 121, 160, 0.22); }
.bp-edit-add { align-self: flex-start; padding: 5px 12px; font-size: 0.8rem; color: #e879a0; background: rgba(232, 121, 160, 0.08); border: 1px dashed rgba(232, 121, 160, 0.35); border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.bp-edit-add:hover { background: rgba(232, 121, 160, 0.16); }
.bp-edit-range { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 3px; background: color-mix(in oklch, var(--color-border) 80%, transparent); outline: none; cursor: pointer; }
.bp-edit-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #e879a0; border: 2px solid var(--color-bg, #1a1a22); cursor: pointer; }
.bp-edit-range::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #e879a0; border: 2px solid var(--color-bg, #1a1a22); cursor: pointer; }
.bp-edit-range::-moz-range-track { height: 6px; border-radius: 3px; background: color-mix(in oklch, var(--color-border) 80%, transparent); }
.record-edit-row { display: flex; align-items: center; gap: 8px; }
.record-edit-row .form-input-s2 { flex: 1; }
.record-edit-date { flex: none !important; width: 96px; }
.tag-edit-row { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-edit-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px 3px 10px; font-size: 0.8rem; color: var(--color-text); background: rgba(232, 121, 160, 0.1); border: 1px solid rgba(232, 121, 160, 0.25); border-radius: 999px; }
.tag-edit-x { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; line-height: 1; color: #e879a0; background: transparent; border: none; border-radius: 50%; cursor: pointer; }
.tag-edit-x:hover { background: rgba(232, 121, 160, 0.2); }
.tag-edit-add { display: flex; align-items: center; gap: 8px; }
.tag-edit-add .form-input-s2 { flex: 1; }
</style>
