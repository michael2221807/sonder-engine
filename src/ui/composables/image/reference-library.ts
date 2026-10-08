/**
 * Reference library list, thumbnails and deletion (R7 step 2).
 */
import { ref, computed } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import type { ImageService } from '@/engine/image/image-service';
import type { PanelTranslate } from './panel-deps';

export interface UseReferenceLibraryDeps {
  imageService: ImageService | undefined;
  t: PanelTranslate;
}

export function useReferenceLibrary(deps: UseReferenceLibraryDeps) {
  const { imageService, t } = deps;

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

  return {
    referenceLibrary,
    refLibThumbnails,
    loadRefLibThumbnail,
    deleteReferenceEntry,
  };
}
