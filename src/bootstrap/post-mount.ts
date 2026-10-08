import { eventBus } from '../engine/core/event-bus';
import { requestPersistentStorage } from '../engine/persistence/idb-adapter';
import type { WorldBookStorage } from '../engine/prompt/world-book-storage';
import { useEngineStateStore } from '../engine/stores/engine-state';
import type { GamePack } from '../engine/types';
import type { App as VueApp } from 'vue';
import { watch } from 'vue';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function mountAndFollowUp(deps: {
  app: VueApp;
  pack: GamePack | null;
  worldBookStorage: WorldBookStorage;
}) {
  const { app, pack, worldBookStorage } = deps;
  app.mount('#app');
  eventBus.emit('engine:initialized', { packId: pack?.manifest.id ?? null });

  // 申请持久化存储：避免本源 IndexedDB 在磁盘紧张 / LRU 驱逐下被浏览器自动清空。
  // 放在 mount 之后，保证授予被拒时的警告 toast 能被已挂载的 Toast 组件显示。
  // 不 await —— 申请结果不阻断后续启动逻辑。
  void requestPersistentStorage();

  // Load world books when a game profile becomes active (fixes: first round with empty books)
  const engineState = useEngineStateStore();
  let lastWorldBookPid: string | null = null;
  // Watch only the profile id: `$subscribe` deep-watches the whole store state, which holds the game tree,
  // so every state change walked the entire tree (0.6 s per write on a large save).
  watch(() => engineState.activeProfileId, async (pid) => {
    if (!pid || pid === lastWorldBookPid) return;
    lastWorldBookPid = pid;
    try {
      const loadedBooks = await worldBookStorage.loadWorldBooks(pid);
      eventBus.emit('worldbook:updated', loadedBooks.filter((b) => b.enabled !== false));
    } catch { /* best-effort */ }
  }, { immediate: true });
}
