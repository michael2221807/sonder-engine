/**
 * Reference-image upload, persistence and multi-reference helpers shared by the manual and scene forms (R7 step 3). The scene-only handlers stay in the panel.
 */
import { computed, type Ref } from 'vue';
import type { ImageAsset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';
import type { MultiReferenceItem } from '@/ui/components/shared/MultiReferencePicker.vue';
import { appendReferenceFiles, readFileAsDataUrl } from '@/ui/components/shared/multi-reference-files';
import { SEEDREAM_MAX_REFERENCE_IMAGES } from '@/engine/image/providers/volcengine';
import { eventBus } from '@/engine/core/event-bus';
import type { ImageService } from '@/engine/image/image-service';
import type { PanelTranslate } from './panel-deps';

export interface UseReferencesDeps {
  imageService: ImageService | undefined;
  t: PanelTranslate;
  refConfigMaxUploadBytes: Readonly<Ref<number>>;
  refConfigPersist: Readonly<Ref<boolean>>;
  npcReferenceItems: Ref<MultiReferenceItem[]>;
  npcReferenceFile: Ref<File | null>;
  npcReferenceDataUrl: Ref<string | null>;
  npcReferenceAssetId: Ref<string | null>;
  selectedNpcData: Readonly<Ref<Record<string, unknown> | null>>;
}

export function useReferences(deps: UseReferencesDeps) {
  const { imageService, t, refConfigMaxUploadBytes, refConfigPersist, npcReferenceItems, npcReferenceFile, npcReferenceDataUrl, npcReferenceAssetId, selectedNpcData } = deps;

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

  /** 当前 NPC 已选头像/立绘的资产 id（多图选择器的快捷来源按钮据此显隐）。 */
  const npcAvatarAssetId = computed(() => {
    const archive = selectedNpcData.value?.['图片档案'] as Record<string, unknown> | undefined;
    return String(archive?.['已选头像图片ID'] ?? archive?.['已选立绘图片ID'] ?? '') || '';
  });
  const npcQuickSources = computed(() => (npcAvatarAssetId.value
    ? [{ key: 'avatar', label: t('image.manual.refAvatar') }]
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

  return {
    validateUploadSize,
    persistUploadedReference,
    addMultiRefFiles,
    addAssetToMultiRef,
    onNpcMultiRefFiles,
    npcAvatarAssetId,
    npcQuickSources,
    multiRefToInputs,
    onNpcReferenceFileChange,
  };
}
