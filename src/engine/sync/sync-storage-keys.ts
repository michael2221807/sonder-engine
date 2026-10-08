/**
 * Device-local localStorage keys of the cloud-sync layer.
 *
 * Leaf module (no imports): github-sync.ts and device-identity.ts write these keys,
 * backup-service.ts excludes them from every backup / cloud collection. Keeping the
 * key names and the exclusion set in ONE place stops the hand-copied literals from
 * drifting apart.
 */

/** Last-synced cloud manifest createdAt (v2 whole-repo conflict token). */
export const LS_SYNC_BASELINE = 'aga_github_sync_baseline';
/** "This device has a local save not yet auto-uploaded" (v2 scalar flag). */
export const LS_SYNC_PENDING = 'aga_github_sync_pending';
/** Per-slot baselines JSON map (v3 save slots). */
export const LS_SYNC_BASELINES = 'aga_github_sync_baselines';
/** Per-profile pending JSON map (v3 save slots). */
export const LS_SYNC_PENDING_MAP = 'aga_github_sync_pending_map';
/** Stable per-device id used for the cloud-upload audit stamp. */
export const LS_DEVICE_ID = 'aga_device_id';

/**
 * Device-local localStorage keys that must NEVER travel in a backup / cloud sync.
 *
 * These hold per-device sync bookkeeping, not user content or portable settings.
 * Exporting them and restoring on another device would corrupt that device's own
 * state. Concretely `aga_github_sync_baseline` is *this* device's view of the
 * last-synced cloud manifest `createdAt` — the multi-device conflict token
 * (github-sync.ts). If device A's baseline landed on device B, B would either
 * miss a real conflict or raise a false one.
 *
 * Excluded from FOUR places (backup-service.ts): collect (never exported), wipe
 * (a foreign full-restore must not erase this device's sync state), restore (a
 * bundle must never write it), and the import-rollback snapshot write-back
 * (restoreFromSnapshot). Keys here still match the `aga_` prefix — the Set is the
 * override that carves them back out.
 *
 * Members:
 * - aga_github_sync_baseline — last-synced cloud manifest createdAt (conflict token)
 * - aga_github_sync_pending  — "this device has a local save not yet auto-uploaded"
 *   (survives across sessions so a failed tail-flush is retried next session)
 * - 存档插槽 epic（2026-07-23）：插槽化后基线/待传标志变为 per-slot JSON map，
 *   语义仍是"本设备的同步记账"，同样绝不随备份/云同步迁移。旧两个标量键保留在
 *   排除集——升级期间旧客户端仍在写它们。
 * - 设备指纹（2026-08-21）：云上传审计用的本设备稳定 ID（device-identity.ts）。
 *   若随备份迁移，恢复方会继承源设备的指纹，"这个存档是哪台设备传的"就失去意义。
 */
export const LS_DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set([
  LS_SYNC_BASELINE,
  LS_SYNC_PENDING,
  LS_SYNC_BASELINES,
  LS_SYNC_PENDING_MAP,
  LS_DEVICE_ID,
]);
