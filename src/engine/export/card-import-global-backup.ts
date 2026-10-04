// App doc: docs/user-guide/pages/game-save.md §2.6.4
/**
 * Global-settings backup for card import (Story 6 — reversibility, user request 2026-06-04).
 *
 * The import's GLOBAL opt-in payloads (configOverlays / promptOverrides / builtinPromptOverrides — the
 * prompt-page edits / 
 * settings) and the NSFW gate write app-wide localStorage/IDB IMMEDIATELY. That is irreversible by
 * design otherwise — so before any global write we SNAPSHOT the affected stores, and the import flow:
 *   - restores the snapshot if the import FAILS (a failed import must not leave globals clobbered), and
 *   - lets a SUCCESSFUL import offer a one-click "undo global changes" (restore to pre-import state).
 *
 * Restore is wholesale per store (clear + re-import the snapshot) → the result exactly matches the
 * snapshot. Only the stores an opt-in actually touches are snapshotted/restored.
 *
 * Engine-layer rule: no game-specific field paths; operates purely on the stores + the settings whitelist.
 */
import { SETTINGS_EXPORT_WHITELIST } from './settings-export-whitelist';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import { readPromptEdits, restorePromptEdits, type PromptEdit } from '../prompt/prompt-edits';
import { eventBus } from '../core/event-bus';
import type { GlobalOptInFlag } from './game-card-import.types';

type ConfigOverlays = Awaited<ReturnType<ConfigStore['exportAll']>>;
type PromptEntries = Awaited<ReturnType<PromptStorage['exportAll']>>;

/** The global stores a backup needs (subset of ImportServiceDeps). */
export interface GlobalBackupDeps {
  configStore: ConfigStore;
  promptStorage: PromptStorage;
}

export interface GlobalSettingsBackup {
  /** localStorage key → prior value (null = was absent). Covers settings / gameplay / nsfw keys. */
  localStorage: Record<string, string | null>;
  /** Prior ConfigStore overlays (all packs) — present only if `configOverlays` was opted-in. */
  configOverlays?: ConfigOverlays;
  /** Prior PromptStorage entries — present only if `promptOverrides` was opted-in. */
  promptOverrides?: PromptEntries;
  /** Prior prompt-page edits for the pack — present only if `builtinPromptOverrides` was opted-in. */
  promptEdits?: { packId: string; entries: PromptEdit[] };
  /** True iff the import will mutate ANY global store — drives the undo affordance + failure restore. */
  hasChanges: boolean;
}

/**
 * Snapshot the CURRENT global state the import (with these opt-ins) is about to overwrite, BEFORE
 * any global write. Cheap: localStorage is read key-by-key; IDB stores are only read when opted-in.
 */
export async function captureGlobalSettingsBackup(
  deps: GlobalBackupDeps,
  packId: string,
  opt: ReadonlySet<GlobalOptInFlag>,
  enableNsfw: boolean,
): Promise<GlobalSettingsBackup> {
  // localStorage is touched by `settings`, `authorGameplaySettings`, and the NSFW gate.
  const touchesLocalStorage = enableNsfw || opt.has('settings') || opt.has('authorGameplaySettings');
  const ls: Record<string, string | null> = {};
  if (touchesLocalStorage) {
    for (const key of SETTINGS_EXPORT_WHITELIST) ls[key] = localStorage.getItem(key);
  }

  const backup: GlobalSettingsBackup = { localStorage: ls, hasChanges: touchesLocalStorage };
  if (opt.has('configOverlays')) {
    backup.configOverlays = await deps.configStore.exportAll();
    backup.hasChanges = true;
  }
  if (opt.has('promptOverrides')) {
    backup.promptOverrides = await deps.promptStorage.exportAll();
    backup.hasChanges = true;
  }
  if (opt.has('builtinPromptOverrides')) {
    backup.promptEdits = { packId, entries: readPromptEdits(packId) };
    backup.hasChanges = true;
  }
  return backup;
}

/** Result of a restore attempt. `failed` lists the store keys that could NOT be reverted. */
export interface RestoreResult {
  failed: string[];
}

/**
 * Restore a previously-captured backup, reverting the import's global overwrites to their
 * pre-import state. Each IDB store is restored ATOMICALLY (single-transaction replaceAll), and each
 * store is wrapped in its own try/catch so one store's failure cannot abort the others. Returns the
 * list of stores that failed (empty = full success) so callers can surface a partial-failure to the
 * user instead of silently swallowing it.
 */
export async function restoreGlobalSettingsBackup(
  deps: GlobalBackupDeps,
  backup: GlobalSettingsBackup,
): Promise<RestoreResult> {
  const failed: string[] = [];

  // localStorage first (synchronous; reverts settings/gameplay/nsfw keys).
  try {
    for (const [key, val] of Object.entries(backup.localStorage)) {
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    }
  } catch {
    failed.push('settings');
  }

  if (backup.configOverlays) {
    try {
      await deps.configStore.replaceAll(backup.configOverlays);
    } catch {
      failed.push('configOverlays');
    }
  }
  if (backup.promptOverrides) {
    try {
      await deps.promptStorage.replaceAll(backup.promptOverrides);
    } catch {
      failed.push('promptOverrides');
    }
  }
  if (backup.promptEdits) {
    try {
      restorePromptEdits(backup.promptEdits.packId, backup.promptEdits.entries);
      eventBus.emit('prompt:edits-replaced', { packId: backup.promptEdits.packId });
    } catch {
      failed.push('builtinPromptOverrides');
    }
  }

  return { failed };
}
