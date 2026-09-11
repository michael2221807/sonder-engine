// Design doc: docs/design/github-auto-sync-design.md
// App doc: docs/user-guide/pages/game-save.md §2.2 (自动上传开关 — 触发守卫)
/**
 * Pure decision helpers for CloudSyncManager, extracted so the safety-critical
 * "may we auto-upload right now?" gate is unit-testable without mounting the Vue
 * component or touching the network. The component owns the refs/eventBus; this
 * file owns the logic.
 */

export interface AutoSyncGuardState {
  /** User toggle. */
  enabled: boolean;
  /** GitHub token + owner present. */
  configured: boolean;
  /** An upload/download is already running in the shared lock. */
  syncing: boolean;
  /** Our own maybeAutoUpload() check is mid-flight (async conflict pre-check). */
  busy: boolean;
  /** The conflict modal is open, awaiting the user's decision. */
  conflictOpen: boolean;
  /** Soft-suspended this session after a degraded skip. */
  degradedActive: boolean;
  /** A save happened since the last successful upload — there is new data to back up. */
  dirty: boolean;
  /**
   * The pre-round save-health check found the active save damaged (2026-09-10). A damaged
   * save must never be auto-uploaded — that is how a silent local loss would overwrite
   * the healthy cloud copy behind the player's back.
   */
  saveDamaged: boolean;
}

/**
 * True only when EVERY guard passes. Any single blocker (off, disconnected, a sync
 * already running, an open conflict modal, a degraded soft-suspend, or nothing new
 * to upload) returns false — the auto path must never touch the network otherwise.
 */
export function shouldAttemptAutoUpload(s: AutoSyncGuardState): boolean {
  return (
    s.enabled &&
    s.configured &&
    !s.syncing &&
    !s.busy &&
    !s.conflictOpen &&
    !s.degradedActive &&
    !s.saveDamaged &&
    s.dirty
  );
}
