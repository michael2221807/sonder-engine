/**
 * Secret-part rows, size/style carriers and the three generate flows (R7 step 3).
 */
import { type Ref, computed } from 'vue';
import type { ImageTask, StylePreset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';
import { buildPromptStyleInjection } from '@/engine/image/style-preset-injection';
import { resolveStyleParams } from '@/engine/image/style-param-resolver';
import { eventBus } from '@/engine/core/event-bus';
import type { ImageService } from '@/engine/image/image-service';
import type { ImageBackendType } from '@/engine/image/types';
import type { ArtistPreset } from '@/engine/image/types';
import type { PanelTranslate } from './panel-deps';

export interface UseSecretPartsDeps {
  t: PanelTranslate;
  imageService: ImageService | undefined;
  selectedNpc: Readonly<Ref<string>>;
  selectedNpcData: Readonly<Ref<Record<string, unknown> | null>>;
  artistPresets: Readonly<Ref<ArtistPreset[]>>;
  secretArtistPreset: Readonly<Ref<string>>;
  secretPngPreset: Readonly<Ref<string>>;
  secretStyle: Readonly<Ref<'none' | 'generic' | 'anime' | 'realistic' | 'chinese'>>;
  secretSizePreset: Readonly<Ref<'none' | '1:1' | '3:4' | '9:16' | '16:9'>>;
  secretExtraPrompt: Readonly<Ref<string>>;
  secretStatusText: Ref<string>;
  secretBusy: Ref<string>;
  lastTask: Ref<ImageTask | null>;
  backend: Readonly<Ref<ImageBackendType>>;
  configuredModelFor: (bk: ImageBackendType) => string | undefined;
  refConfigDenoiseDefault: Readonly<Ref<number>>;
  imageUpdateTick: Readonly<Ref<number>>;
  sizePresetOptions: Readonly<Ref<Array<{ label: string; value: 'none' } | { label: string; value: '1:1' } | { label: string; value: '3:4' } | { label: string; value: '9:16' } | { label: string; value: '16:9' } | { label: string; value: 'custom' }>>>;
  SIZE_BASES: Record<'1:1' | '3:4' | '9:16' | '16:9', { w: number; h: number }>;
}

export function useSecretParts(deps: UseSecretPartsDeps) {
  const { t, imageService, selectedNpc, selectedNpcData, artistPresets, secretArtistPreset, secretPngPreset, secretStyle, secretSizePreset, secretExtraPrompt, secretStatusText, secretBusy, lastTask, backend, configuredModelFor, refConfigDenoiseDefault, imageUpdateTick, sizePresetOptions, SIZE_BASES } = deps;

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

  return {
    secretParts,
    secretSizeStylePreset,
    secretSizeOptions,
    artStyleLabelFor,
    generateSecretPart,
    generateAllSecretParts,
    generateSecretPartWithReference,
    getSecretPartAssetId,
  };
}
