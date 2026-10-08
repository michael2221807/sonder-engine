/**
 * localStorage policy of a backup: which keys travel, which are wiped, which are restored.
 *
 * Three key tables decide it: the `aga_` / `aga-` prefixes (portable), the device-local keys
 * (never travel, see sync/sync-storage-keys) and the own-sync keys (travel only with the
 * player's own cloud sync). Moved out of backup-service.ts (R6 step 4), unchanged.
 */
import { LS_DEVICE_LOCAL_KEYS } from '../sync/sync-storage-keys';
import { PLOT_VECTOR_CONTROL_KEY } from '../plot-vector/feature-control';

/**
 * localStorage 中引擎相关 key 的前缀集合
 *
 * 正式版混用 `aga_`（下划线，如 `aga_api_management`）与历史 `aga-`（横杠）；
 * 备份须同时采集，否则恢复后 API / 设置 / Action Queue 会丢失。
 * 对应 STEP-03B M5.2 engineSettings。
 */
export const LS_KEY_PREFIXES = ['aga_', 'aga-'] as const;

/**
 * Keys that travel with the player's own cloud sync and nothing else (P3, PO 2026-10-04 A): the plot-momentum
 * switch follows the player from device to device, but a backup file, a game card or another player's bundle never
 * switches it.
 * - collect: only the sync exports (`exportForSync`, `exportGlobalForSync`) carry them; `exportAll` does not;
 * - wipe: no import wipes them (the device keeps its value);
 * - restore: written back only by a download from the player's own sync (`importAll(…, { fromOwnSync: true })`);
 * - rollback: the snapshot of an own-sync download records them (absent too), so a failed download puts them back
 *   exactly; any other import's snapshot leaves them out, and its rollback leaves them as they are now.
 */
export const LS_OWN_SYNC_KEYS: ReadonlySet<string> = new Set([PLOT_VECTOR_CONTROL_KEY]);

/**
 * 从 localStorage 收集引擎设置
 *
 * 收集以 `aga_` 或 `aga-` 开头的 key，
 * 避免采集其他库或应用的无关数据。
 */
export function collectLocalStorageSettings(
  opts: { ownSync?: boolean; snapshot?: boolean } = {},
): Record<string, string | null> {
  const settings: Record<string, string | null> = {};
  // `snapshot`: a rollback snapshot of an own-sync download. It carries the own-sync keys, one that is not there
  // too (null), so a failed download puts each back exactly — removed again when it was absent.
  const ownSync = opts.ownSync === true || opts.snapshot === true;
  if (opts.snapshot) for (const key of LS_OWN_SYNC_KEYS) settings[key] = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // device-local sync state never travels
    if (LS_OWN_SYNC_KEYS.has(key) && !ownSync) continue; // only the player's own sync carries these
    if (LS_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      settings[key] = localStorage.getItem(key);
    }
  }
  return settings;
}

/**
 * 擦除 localStorage 中所有 aga_* / aga-* 键
 *
 * 用于全替换导入前的清理阶段，确保备份中不存在的设置在本地也被移除。
 * 必须先收集再删除，避免边遍历边删除导致索引错位。
 */
export function wipeLocalStorageSettings(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // keep this device's own sync bookkeeping across a foreign restore
    if (LS_OWN_SYNC_KEYS.has(key)) continue; // no import wipes these; only an own-sync download replaces them
    if (LS_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

/**
 * 恢复 localStorage 引擎设置
 *
 * 处理 null 值的语义：
 * - null → 删除该 key（localStorage.removeItem）
 * - string → 写入该值（localStorage.setItem）
 *
 * 安全限制：只允许写入 `aga_` / `aga-` 前缀的 key，防止恶意备份覆盖无关数据。
 */
export function restoreLocalStorageSettings(
  settings: Record<string, string | null>,
  opts: { ownSync?: boolean } = {},
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (!LS_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // a bundle must never overwrite device-local sync state
    if (LS_OWN_SYNC_KEYS.has(key) && !opts.ownSync) continue; // a file or a card never switches these
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  }
}

/**
 * Write a rollback snapshot of localStorage settings back (prefix-checked, device-local keys
 * skipped, null = remove). Shared by the full-replace and the global-section rollbacks.
 */
export function restoreSnapshotSettings(ls: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(ls)) {
    if (!LS_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // never restore device-local sync state (defense-in-depth; source already excludes it)
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
}
