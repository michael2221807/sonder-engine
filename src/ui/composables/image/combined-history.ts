/**
 * Combined image history for the history tab (R7 step 2): NPC archives + player archive +
 * scene archive, newest first, plus the tab filter. `buildCombinedHistory` is the pure part;
 * the computed that feeds it stays reactive in `useCombinedHistory`.
 */
import { ref, computed, type Ref } from 'vue';
import type { ImageBackendType, CivitaiLoraSnapshot } from '@/engine/image/types';
import type { ImageService } from '@/engine/image/image-service';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import { eventBus } from '@/engine/core/event-bus';
import type { PanelTranslate } from './panel-deps';
import type { GalleryImage } from './gallery';

export interface CombinedHistoryEntry {
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

export interface CombinedHistorySources {
  /** `relationships.value` — NPC list (each may carry an 图片档案). */
  relationships: Array<Record<string, unknown>> | undefined;
  /** Player archive records; called inside the computed so the read stays tracked. */
  getPlayerArchiveHistory: () => GalleryImage[];
  /** Read lazily (only when the player has records), like the original `playerName.value`. */
  getPlayerName: () => string | undefined;
  sceneArchiveHistory: Array<Record<string, unknown>>;
  extractProviderMeta: (obj: Record<string, unknown>) => CombinedHistoryEntry['providerMeta'];
  t: PanelTranslate;
}

export function buildCombinedHistory(sources: CombinedHistorySources): CombinedHistoryEntry[] {
  const { relationships, getPlayerArchiveHistory, getPlayerName, sceneArchiveHistory, extractProviderMeta, t } = sources;
  const entries: CombinedHistoryEntry[] = [];

  // NPC archives
  if (Array.isArray(relationships)) {
    for (const npc of relationships) {
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
      name: getPlayerName() ?? t('image.scene.playerFallback'),
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
  for (const record of sceneArchiveHistory) {
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
}

export interface UseCombinedHistoryDeps {
  t: PanelTranslate;
  imageService: ImageService | undefined;
  relationships: Readonly<Ref<Array<Record<string, unknown>> | undefined>>;
  imageUpdateTick: Readonly<Ref<number>>;
  extractProviderMeta: (obj: Record<string, unknown>) => CombinedHistoryEntry['providerMeta'];
  getPlayerArchiveHistory: () => GalleryImage[];
  getPlayerName: () => string | undefined;
  sceneArchiveHistory: Readonly<Ref<Array<Record<string, unknown>>>>;
  clearSceneHistory: () => void;
}

export function useCombinedHistory(deps: UseCombinedHistoryDeps) {
  const { t, imageService, relationships, imageUpdateTick, extractProviderMeta, getPlayerArchiveHistory, getPlayerName, sceneArchiveHistory, clearSceneHistory } = deps;

  // History state
  const historyFilter = ref('all');
  const historyFilterOptions = computed<SelectOption[]>(() => [
    { label: t('common.actions.all'), value: 'all' },
    { label: t('image.lora.scope.character'), value: 'character' },
    { label: t('image.lora.scope.scene'), value: 'scene' },
    { label: t('image.queue.status.complete'), value: 'complete' },
    { label: t('image.queue.status.failed'), value: 'failed' },
  ]);

  const combinedHistory = computed<CombinedHistoryEntry[]>(() => {
    void imageUpdateTick.value;
    return buildCombinedHistory({
      relationships: relationships.value,
      getPlayerArchiveHistory,
      getPlayerName,
      sceneArchiveHistory: sceneArchiveHistory.value,
      extractProviderMeta,
      t,
    });
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

  return {
    historyFilter,
    historyFilterOptions,
    combinedHistory,
    filteredHistory,
    clearAllNpcHistory,
    clearAllSceneHistory,
  };
}
