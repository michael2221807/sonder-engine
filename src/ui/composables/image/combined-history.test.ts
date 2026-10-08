import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import type { GalleryImage } from './gallery';
import { identityT } from './test-helpers';
import { buildCombinedHistory, useCombinedHistory, type CombinedHistorySources } from './combined-history';

function sources(over: Partial<CombinedHistorySources> = {}): CombinedHistorySources {
  return {
    relationships: [],
    getPlayerArchiveHistory: () => [],
    getPlayerName: () => undefined,
    sceneArchiveHistory: [],
    extractProviderMeta: () => undefined,
    t: identityT,
    ...over,
  };
}

describe('buildCombinedHistory', () => {
  it('returns [] for no sources', () => {
    expect(buildCombinedHistory(sources())).toEqual([]);
    expect(buildCombinedHistory(sources({ relationships: undefined }))).toEqual([]);
  });

  it('merges NPC, player and scene records newest first and maps the legacy Chinese keys', () => {
    const entries = buildCombinedHistory(sources({
      relationships: [
        { 名称: '甲', 图片档案: { 生图历史: [
          { id: 'n1', createdAt: 100, positivePrompt: 'p', width: 832, height: 1216, backend: 'novelai' },
          { createdAt: 300, 生成时间: 1, 最终正向提示词: 'legacy-pos', 使用模型: 'm1', 画风: 'anime', status: 'failed' },
        ] } },
        { 名称: '乙' }, // no archive
        { 名称: '丙', 图片档案: { 生图历史: 'not-an-array' } },
      ],
      getPlayerArchiveHistory: () => [{ id: 'p1', createdAt: 200, status: 'complete', composition: 'portrait' } as GalleryImage],
      getPlayerName: () => '主角',
      sceneArchiveHistory: [{ id: 's1', 生成时间: 250, taskId: 'tk', 最终负向提示词: 'neg' }],
    }));
    expect(entries.map((e) => e.key)).toEqual(['npc_甲_300', 'scene_s1', 'player_p1', 'npc_甲_n1']);
    expect(entries[0]).toMatchObject({ type: 'character', name: '甲', status: 'failed', positivePrompt: 'legacy-pos', model: 'm1', artStyle: 'anime', timestamp: 300 });
    expect(entries[1]).toMatchObject({ type: 'scene', name: 'image.history.typeScene', negativePrompt: 'neg', taskId: 'tk', timestamp: 250 });
    expect(entries[2]).toMatchObject({ type: 'character', name: '主角', composition: 'portrait' });
    expect(entries[3]).toMatchObject({ id: 'n1', width: 832, height: 1216, backend: 'novelai', status: 'complete' });
  });

  it('only reads the player name when the player has records, and falls back through t()', () => {
    const getPlayerName = vi.fn(() => undefined);
    buildCombinedHistory(sources({ getPlayerName }));
    expect(getPlayerName).not.toHaveBeenCalled();
    const entries = buildCombinedHistory(sources({
      getPlayerName,
      getPlayerArchiveHistory: () => [{ id: 'p', createdAt: 1 } as GalleryImage],
    }));
    expect(getPlayerName).toHaveBeenCalledTimes(1);
    expect(entries[0].name).toBe('image.scene.playerFallback');
  });

  it('threads extractProviderMeta through every record kind', () => {
    const extract = vi.fn(() => ({ reference: { mode: 'x' } }));
    const entries = buildCombinedHistory(sources({
      relationships: [{ 名称: 'n', 图片档案: { 生图历史: [{ id: 'a', createdAt: 1 }] } }],
      getPlayerArchiveHistory: () => [{ id: 'b', createdAt: 2 } as GalleryImage],
      sceneArchiveHistory: [{ id: 'c', createdAt: 3 }],
      extractProviderMeta: extract,
    }));
    expect(extract).toHaveBeenCalledTimes(3);
    expect(entries.every((e) => e.providerMeta?.reference?.mode === 'x')).toBe(true);
  });
});

describe('useCombinedHistory', () => {
  function make() {
    const tick = ref(0);
    const relationships = ref<Array<Record<string, unknown>> | undefined>([
      { 名称: '甲', 图片档案: { 生图历史: [
        { id: 'ok', createdAt: 1, status: 'complete' },
        { id: 'bad', createdAt: 2, status: 'failed' },
      ] } },
    ]);
    const scene = ref<Array<Record<string, unknown>>>([{ id: 's', createdAt: 3, status: 'complete' }]);
    const clearNpcHistory = vi.fn();
    const clearSceneHistory = vi.fn();
    const h = useCombinedHistory({
      t: identityT,
      imageService: { clearNpcHistory } as never,
      relationships,
      imageUpdateTick: tick,
      extractProviderMeta: () => undefined,
      getPlayerArchiveHistory: () => [],
      getPlayerName: () => undefined,
      sceneArchiveHistory: scene,
      clearSceneHistory,
    });
    return { h, tick, relationships, scene, clearNpcHistory, clearSceneHistory };
  }

  it('filters by tab filter', () => {
    const { h } = make();
    expect(h.filteredHistory.value.map((e) => e.id)).toEqual(['s', 'bad', 'ok']);
    h.historyFilter.value = 'character';
    expect(h.filteredHistory.value.map((e) => e.id)).toEqual(['bad', 'ok']);
    h.historyFilter.value = 'scene';
    expect(h.filteredHistory.value.map((e) => e.id)).toEqual(['s']);
    h.historyFilter.value = 'failed';
    expect(h.filteredHistory.value.map((e) => e.id)).toEqual(['bad']);
    h.historyFilter.value = 'complete';
    expect(h.filteredHistory.value.map((e) => e.id)).toEqual(['s', 'ok']);
  });

  it('recomputes when the image tick bumps', () => {
    const { h, tick, scene } = make();
    expect(h.combinedHistory.value).toHaveLength(3);
    scene.value = [...scene.value, { id: 's2', createdAt: 9 }];
    expect(h.combinedHistory.value).toHaveLength(4);
    tick.value++;
    expect(h.combinedHistory.value).toHaveLength(4);
  });

  it('offers the five filter options in order', () => {
    const { h } = make();
    expect(h.historyFilterOptions.value.map((o) => o.value)).toEqual(['all', 'character', 'scene', 'complete', 'failed']);
  });

  it('clears every NPC history with a toast, skipping nameless NPCs; scene clear delegates', () => {
    const { h, relationships, clearNpcHistory, clearSceneHistory } = make();
    relationships.value = [{ 名称: 'a' }, { 名称: '' }, { 名称: 'b' }];
    const emit = vi.spyOn(eventBus, 'emit');
    h.clearAllNpcHistory();
    expect(clearNpcHistory.mock.calls).toEqual([['a'], ['b']]);
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'info', message: 'image.toast.clearedAllNpcHistory', duration: 1500 });
    h.clearAllSceneHistory();
    expect(clearSceneHistory).toHaveBeenCalledTimes(1);
    emit.mockRestore();
  });
});
