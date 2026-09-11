// App doc: docs/user-guide/pages/game-main.md §3.17（回合前存档自检）
/**
 * Save-health store — the UI's single memory of the last pre-round check.
 *
 * Two consumers need the verdict without re-running IndexedDB reads:
 * - the composer gate (MainGamePanel) decides whether to block the round and whether the
 *   player already waved this exact set of findings through in this session;
 * - CloudSyncManager refuses to auto-upload while the save is known to be damaged, so a
 *   local loss never propagates to the cloud copy behind the player's back.
 *
 * Acknowledgement is SESSION-scoped on purpose: a reload re-raises the alarm once. It is
 * keyed by the report fingerprint, so a NEW loss (different ids, a new store) is never
 * silenced by an old "continue".
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { SaveHealthReport } from '../persistence/save-health';

export const useSaveHealthStore = defineStore('saveHealth', () => {
  const lastReport = ref<SaveHealthReport | null>(null);
  const acknowledgedFingerprints = ref(new Set<string>());
  /** Set once the "auto-upload paused" notice was shown, so it does not repeat every round. */
  const autoSyncNoticeShown = ref(false);

  /** True while the most recent check found damage — regardless of acknowledgement. */
  const damaged = computed(() => lastReport.value?.damaged === true);

  function record(report: SaveHealthReport): void {
    lastReport.value = report;
    if (!report.damaged) autoSyncNoticeShown.value = false;
  }

  function isAcknowledged(report: SaveHealthReport): boolean {
    return acknowledgedFingerprints.value.has(report.fingerprint);
  }

  function acknowledge(report: SaveHealthReport): void {
    acknowledgedFingerprints.value.add(report.fingerprint);
  }

  function markAutoSyncNoticeShown(): boolean {
    if (autoSyncNoticeShown.value) return false;
    autoSyncNoticeShown.value = true;
    return true;
  }

  function reset(): void {
    lastReport.value = null;
    acknowledgedFingerprints.value = new Set();
    autoSyncNoticeShown.value = false;
  }

  return { lastReport, damaged, record, isAcknowledged, acknowledge, markAutoSyncNoticeShown, reset };
});
