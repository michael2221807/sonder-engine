// App doc: docs/user-guide/pages/game-prompts.md §4.8
/**
 * useCapturedSettings — the UI's single handle on Canon Capture state.
 *
 * Views never touch `captured-entry-mutations` directly: every write goes through
 * `CapturedSettingCoordinator`, which is what keeps the world book, the Engram
 * projection and the save file from drifting apart (see the coordinator's header).
 * This composable builds that coordinator once, wired to the Pinia state tree and the
 * engine's save event, and exposes read-side helpers on top.
 */
import { computed, inject } from 'vue';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import type { GamePack } from '@/engine/types/game-pack';
import type { WorldBook, WorldBookEntry } from '@/engine/prompt/world-book';
import type { EngramManager } from '@/engine/memory/engram/engram-manager';
import type { StateManager } from '@/engine/core/state-manager';
import type { CanonMutationInput } from '@/engine/memory/engram/canon-projection';
import { findCanonEdges, isProjectableRelationship } from '@/engine/memory/engram/canon-projection';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type { SettingCaptureLastRecord } from '@/engine/pipeline/stages/setting-capture';
import {
  CapturedSettingCoordinator,
  type CapturedMutationResult,
  type CapturedSettingStatePort,
  type CapturedEngramBridge,
} from '@/engine/prompt/captured-setting-coordinator';
import {
  findCapturedBook,
  activeCapturedEntries,
  FALLBACK_CAPTURED_LABELS,
  MAX_ACTIVE_CAPTURED_ENTRIES,
  type CapturedSettingLabels,
} from '@/engine/prompt/captured-entry-mutations';

const paths = DEFAULT_ENGINE_PATHS;

export function useCapturedSettings() {
  const engineState = useEngineStateStore();

  const pack = inject<GamePack | undefined>('gamePack', undefined);

  /**
   * State port over the Pinia store — no casts needed.
   *
   * The store owns the reactive tree and does not expose the raw manager to views;
   * `setValue` forwards to the real `StateManager` when one is linked, so reactivity
   * and change tracking are preserved.
   */
  const stateAdapter: CapturedSettingStatePort = {
    get: <T = unknown>(path: string): T | undefined => engineState.get<T>(path),
    set: (path: string, value: unknown): void => { engineState.setValue(path, value); },
  };

  /**
   * Display labels for a manually-added setting, from the pack.
   *
   * MUST be supplied: `addManual()` refuses to run without labels, so leaving this out
   * turns the entire manual-add fallback into a permanent `internal_error` — the exact
   * "wired in the pipeline, never wired in the UI" failure this project keeps hitting.
   * Sourced identically to `GameOrchestrator`'s stage registration.
   */
  const getLabels = (): CapturedSettingLabels => ({
    bookTitle: pack?.engineFragments?.settingBookTitle ?? FALLBACK_CAPTURED_LABELS.bookTitle,
    kind: {
      character: pack?.engineFragments?.settingKindCharacter ?? FALLBACK_CAPTURED_LABELS.kind.character,
      relationship: pack?.engineFragments?.settingKindRelationship ?? FALLBACK_CAPTURED_LABELS.kind.relationship,
      world_fact: pack?.engineFragments?.settingKindWorldFact ?? FALLBACK_CAPTURED_LABELS.kind.world_fact,
    },
  });

  /**
   * Graph side of a player-initiated change.
   *
   * The panel and toast act OUTSIDE the round pipeline, so the round's single
   * `processResponse()` write cannot carry them; these two manager methods are the
   * out-of-round equivalent, and they run under the same write lock so they cannot
   * interleave with a turn in flight.
   *
   * Absent manager (tests, degraded boot) → no bridge at all, and the world book keeps
   * working alone. That is the designed relationship: the book is the authority, the
   * graph is a projection.
   */
  const engramManager = inject<EngramManager | null>('engramManager', null);
  // The graph methods take the real StateManager (they read/write the engram subtree,
  // not the world book). It is the same instance the store writes through, so there is
  // one source of truth — this is not a second write path.
  const stateManager = inject<StateManager | null>('stateManager', null);

  const engramBridge: CapturedEngramBridge | undefined = engramManager && stateManager
    ? {
        isActive: () => {
          const cfg = engramManager.getConfig();
          return engramManager.isEnabled() && cfg.knowledgeEdgeMode === 'active';
        },
        invalidate: async (entryId) => {
          await engramManager.invalidateCanonEntries(stateManager, [entryId]);
        },
        reproject: async (entry) => {
          const meta = entry.capturedSetting;
          if (!meta) return;
          const mutation: CanonMutationInput = {
            entryId: entry.id,
            kind: meta.kind,
            statement: entry.content,
            entities: meta.entityRefs ?? [],
            op: 'add',
          };
          await engramManager.reprojectCanonEntry(stateManager, mutation);
        },
      }
    : undefined;

  const coordinator = new CapturedSettingCoordinator({
    stateManager: stateAdapter,
    paths,
    // The orchestrator owns persistence; asking it to save keeps one save path.
    persist: () => { eventBus.emit('engine:request-save', undefined); },
    getLabels,
    getRound: () => engineState.get<number>(paths.roundNumber) ?? 0,
    engram: engramBridge,
  });

  const slotBooks = computed<WorldBook[]>(() => {
    const raw = engineState.get<WorldBook[]>(paths.slotWorldBooks);
    return Array.isArray(raw) ? raw : [];
  });

  const capturedBook = computed<WorldBook | undefined>(() => findCapturedBook(slotBooks.value));

  const entries = computed<WorldBookEntry[]>(() => capturedBook.value?.entries ?? []);

  const activeCount = computed(() => activeCapturedEntries(capturedBook.value).length);

  /**
   * Standing summary of the most recent capture round (absent until the save's first
   * tagged round). This is what lets the panel explain a miss AFTER the toast is gone —
   * the acceptance finding that motivated it: a player missed the 10-second toast, found
   * the tab empty, and had no way to learn what happened.
   */
  const lastResult = computed<SettingCaptureLastRecord | null>(() => {
    const raw = engineState.get<SettingCaptureLastRecord>(paths.settingCaptureLast);
    return raw && typeof raw === 'object' && typeof raw.round === 'number' ? raw : null;
  });

  const isFull = computed(() => activeCount.value >= MAX_ACTIVE_CAPTURED_ENTRIES);

  function entryById(id: string): WorldBookEntry | undefined {
    return entries.value.find((e) => e.id === id);
  }

  /**
   * Whether a captured setting also lives in the relationship graph, and why not if it
   * does not (design §10.2 requires the panel to show this).
   *
   * The distinction matters to the player: "not projected" is normal for a character
   * trait — a one-entity setting has no second endpoint, and fabricating one would put a
   * made-up node into retrieval. Showing that as an error would teach the wrong lesson,
   * and showing nothing at all leaves a real absence unexplained.
   */
  function engramStatus(
    entry: WorldBookEntry,
  ): 'linked' | 'not_projected' | 'off' | 'pending' | 'retracted' {
    const meta = entry.capturedSetting;
    if (!meta) return 'not_projected';
    // A retracted entry has no live edge BY DESIGN. Reporting that as "pending" would
    // promise the player it turns up next round, which it never will.
    if (meta.status === 'retracted') return 'retracted';

    const projectable = isProjectableRelationship({
      entryId: entry.id,
      kind: meta.kind,
      statement: entry.content,
      entities: meta.entityRefs ?? [],
    });
    if (!projectable) return 'not_projected';

    if (!engramManager) return 'off';
    const cfg = engramManager.getConfig();
    if (!engramManager.isEnabled() || cfg.knowledgeEdgeMode !== 'active') return 'off';

    const edges = engineState.get<{ v2Edges?: EngramEdge[] }>('系统.扩展.engramMemory')?.v2Edges ?? [];
    return findCanonEdges(edges, entry.id).length > 0 ? 'linked' : 'pending';
  }

  return {
    coordinator,
    slotBooks,
    capturedBook,
    entries,
    activeCount,
    isFull,
    entryById,
    engramStatus,
    lastResult,
    maxEntries: MAX_ACTIVE_CAPTURED_ENTRIES,
  };
}

export type { CapturedMutationResult };
