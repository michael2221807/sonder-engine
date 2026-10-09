/**
 * A save's size for display (存档瘦身 D9A): one format for the save panel's slots, the cloud slot list, the cloud line
 * on the home page and the save panel, and the sync conflict dialog. Under 1 MB in whole KB, from 1 MB on in MB with
 * one decimal.
 */

/** A size given in KB (what the cloud manifests give), as "640 KB" or "8.6 MB"; "—" for no size. */
export function formatSizeKB(sizeKB: number | null | undefined): string {
  if (sizeKB === null || sizeKB === undefined || !Number.isFinite(sizeKB) || sizeKB < 0) return '—';
  const kb = Math.round(sizeKB);
  return kb < 1024 ? `${kb} KB` : `${(sizeKB / 1024).toFixed(1)} MB`;
}

/** A size given in bytes (a local save's size), formatted as formatSizeKB does. */
export function formatSizeBytes(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '—' : formatSizeKB(bytes / 1024);
}
