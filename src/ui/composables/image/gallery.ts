/**
 * Gallery tab: per-NPC image archive, avatar / portrait / background / secret-part selection and deletion (R7 step 2).
 */
import { type Ref, ref, computed } from 'vue';
import type { ImageBackendType, SecretPartType } from '@/engine/image/types';
import type { CivitaiLoraSnapshot } from '@/engine/image/types';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { eventBus } from '@/engine/core/event-bus';
import type { ImageService } from '@/engine/image/image-service';
import type { UseGameStateReturn } from '@/ui/composables/useGameState';
import type { PanelTranslate, GetState } from './panel-deps';

export interface GalleryImage {
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

export interface UseGalleryDeps {
  useValue: UseGameStateReturn['useValue'];
  get: GetState;
  t: PanelTranslate;
  imageService: ImageService | undefined;
  relationships: Readonly<Ref<Array<Record<string, unknown>> | undefined>>;
  imageUpdateTick: Ref<number>;
}

export function useGallery(deps: UseGalleryDeps) {
  const { useValue, get, t, imageService, relationships, imageUpdateTick } = deps;

  const galleryNpc = ref('');

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

  return {
    galleryNpc,
    playerArchiveRaw,
    playerName,
    getArchiveHistory,
    getPlayerArchiveHistory,
    npcsWithImages,
    galleryImages,
    galleryNpcData,
    getCurrentArchive,
    isCurrentAvatar,
    isCurrentPortrait,
    isCurrentBackground,
    setAsAvatar,
    setAsPortrait,
    clearAvatar,
    clearPortrait,
    setAsBackground,
    clearBackground,
    setPersistentWallpaper,
    clearPersistentWallpaper,
    persistentWallpaperRaw,
    persistentWallpaper,
    isPersistentWallpaper,
    canSelectAvatar,
    canSelectPortrait,
    canSelectBackground,
    canSelectSecretPart,
    isCurrentSecretPart,
    setAsSecretPart,
    clearSecretPart,
    deleteImage,
    deleteNpcHistoryEntry,
    clearNpcImages,
  };
}
