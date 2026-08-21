// App doc: docs/user-guide/pages/game-save.md §2.2.1 (设备指纹审计戳)
/**
 * Device identity for cloud-sync audit stamps.
 *
 * Every cloud upload stamps its manifest with `uploadedBy` — which device
 * produced it — so that after an incident (wrong overwrite, unexpected save
 * state) the manifest / repo history answers "which device uploaded this?".
 *
 * `aga_device_id` is DEVICE-LOCAL bookkeeping, exactly like the sync
 * baseline/pending keys: it must NEVER travel inside a backup bundle or cloud
 * sync. If device A's id were restored onto device B, both devices would report
 * the same fingerprint and the audit trail would be meaningless. It is
 * therefore listed in backup-service `LS_DEVICE_LOCAL_KEYS` (the four-place
 * exclusion: collect / wipe / restore / rollback-snapshot).
 */

const LS_DEVICE_ID = 'aga_device_id';

/** Stamp written into a cloud manifest's `uploadedBy` field. */
export interface UploadDeviceStamp {
  /** Stable random id, generated once per device (browser profile). */
  deviceId: string;
  /** Human-readable platform + browser summary, derived from the UA at upload time. */
  deviceLabel: string;
}

function randomId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `dev_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The stable per-device id. Created lazily on first use and persisted in
 * localStorage. Storage failures (private mode, quota) degrade to a
 * non-persistent id rather than throwing — sync must never fail over auditing.
 */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(LS_DEVICE_ID);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(LS_DEVICE_ID, id);
    return id;
  } catch {
    return randomId();
  }
}

/** Best-effort "Windows · Chrome"-style summary. Pure function of the UA string. */
export function describeDevice(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!ua) return 'unknown';

  let platform = 'unknown';
  if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPod/i.test(ua)) platform = 'iPhone';
  else if (/iPad/i.test(ua)) platform = 'iPad';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  // Order matters: Edge/Opera UAs also contain "Chrome"; Chrome/Safari overlap.
  let browser = 'browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return `${platform} · ${browser}`;
}

/** The full stamp for a cloud upload. */
export function getDeviceStamp(): UploadDeviceStamp {
  return { deviceId: getDeviceId(), deviceLabel: describeDevice() };
}
