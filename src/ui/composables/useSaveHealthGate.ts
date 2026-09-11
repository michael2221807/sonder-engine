// App doc: docs/user-guide/pages/game-main.md §3.17（回合前存档自检）
/**
 * useSaveHealthGate — wires the engine's save-health check to the app's stores.
 *
 * Reads the live tree and the active profile/slot from the Pinia engine store, hands the
 * three side stores (image cache, world-book library, vector store) to
 * `runSaveHealthCheck`, records the verdict in `useSaveHealthStore`, and — when the
 * library is readable and not in the lost state — writes the confirmed world-book ids
 * back into the save tree as the next baseline. The same writer is exposed to the
 * world-book tab so deliberate creates / deletes / imports move the baseline with them.
 */
import { inject } from 'vue';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useSaveHealthStore } from '@/engine/stores/save-health';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import type { GameStateTree } from '@/engine/types';
import type { ImageAssetCache } from '@/engine/image/asset-cache';
import type { WorldBookStorage } from '@/engine/prompt/world-book-storage';
import type { VectorStore } from '@/engine/memory/engram/vector-store';
import { runSaveHealthCheck, canRecordWorldBookBaseline, type SaveHealthReport } from '@/engine/persistence/save-health';
import { baselineDiffers, buildStorageHealthBaseline } from '@/engine/persistence/save-health-baseline';

const paths = DEFAULT_ENGINE_PATHS;

export function useSaveHealthGate() {
  const engineState = useEngineStateStore();
  const store = useSaveHealthStore();
  const imageCache = inject<ImageAssetCache | null>('imageAssetCache', null);
  const worldBookStorage = inject<WorldBookStorage | null>('worldBookStorage', null);
  const vectorStore = inject<VectorStore | null>('vectorStore', null);

  /**
   * Persist the confirmed profile-book ids into the save tree (no-op when unchanged).
   *
   * `forProfileId` is the profile the ids were read FOR. The live tree is mutated in place
   * on a profile switch (`engineState.loadGame`), so ids read for profile A must never be
   * written after the tree has become profile B's — the write is dropped instead.
   */
  function recordWorldBookIds(ids: readonly string[], forProfileId: string | null | undefined): void {
    const tree = engineState.tree as unknown as GameStateTree;
    if (!engineState.isGameLoaded || !tree) return;
    if (!forProfileId || engineState.activeProfileId !== forProfileId) return;
    if (!baselineDiffers(tree, paths.storageHealth, ids)) return;
    const round = engineState.get<number>(paths.roundNumber) ?? 0;
    engineState.setValue(paths.storageHealth, buildStorageHealthBaseline(ids, round));
  }

  /**
   * Run the check for the active save. Returns null when no save is active (nothing to
   * protect) so callers can fall through without a special case.
   */
  async function check(): Promise<SaveHealthReport | null> {
    const profileId = engineState.activeProfileId;
    const slotId = engineState.activeSlotId;
    if (!engineState.isGameLoaded || !profileId || !slotId) return null;
    const tree = engineState.tree as unknown as Record<string, unknown>;
    const report = await runSaveHealthCheck({
      tree,
      paths,
      profileId,
      slotId,
      imageCache: imageCache ?? undefined,
      worldBookStorage: worldBookStorage ?? undefined,
      vectorStore: vectorStore ?? undefined,
    });
    // The reads took real time; if the player switched profile meanwhile, this report
    // describes a save that is no longer active. Record nothing and let the next send
    // re-check the save that IS active.
    if (engineState.activeProfileId !== profileId || engineState.activeSlotId !== slotId) return null;
    store.record(report);
    if (canRecordWorldBookBaseline(report) && worldBookStorage) {
      recordWorldBookIds(report.worldBooks.presentIds, profileId);
    }
    return report;
  }

  /** Damage the player has not already waved through this session. */
  function needsDecision(report: SaveHealthReport | null): report is SaveHealthReport {
    return !!report && report.damaged && !store.isAcknowledged(report);
  }

  return { check, needsDecision, recordWorldBookIds, store };
}
