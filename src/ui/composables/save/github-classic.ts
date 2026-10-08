/**
 * Pure parts of SavePanel's classic (whole-bundle) GitHub upload / download, moved out of SavePanel.vue
 * (refactor R7 step 10). The panel keeps the refs, the auto-validate on setup, every call to the sync service and
 * the timers; the auto-sync toggle is the shared composable useCloudAutoSyncToggle.
 */
import type { CloudFormat, SyncStatus } from '@/engine/sync/github-sync';
import type { SaveSlotMeta } from '@/engine/types/persistence';

/** The whole-bundle rows show on a v2 cloud and while the format is not known yet (v3 / empty: the slot list takes over). */
export function isGhClassicVisible(format: CloudFormat | 'unknown'): boolean {
  return format === 'v2' || format === 'unknown';
}

/** A request is in flight: the buttons wait. */
export function isGhBusyStage(stage: SyncStatus['stage']): boolean {
  return ['checking', 'uploading', 'downloading'].includes(stage);
}

/** What the current slot is saved with just before a manual upload, so the cloud gets the latest data. */
export function buildPreUploadSlotMeta(
  slotId: string,
  packId: string,
  store: { characterName: string; currentLocation: string; gameTime: string },
): Partial<SaveSlotMeta> {
  return {
    slotId,
    slotName: slotId,
    lastSavedAt: new Date().toISOString(),
    packId,
    characterName: store.characterName,
    currentLocation: store.currentLocation,
    gameTime: store.gameTime,
    saveType: 'auto',
  };
}

/** Copies the text through a hidden textarea (works where the async clipboard API is not allowed). */
export function copyTextWithTextarea(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}
