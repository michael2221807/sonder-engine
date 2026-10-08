/**
 * Pure part of SavePanel's LAN sync row, moved out of SavePanel.vue (refactor R7 step 10). The panel keeps the refs,
 * the availability probe on setup, every call to the LAN service and the reload timer.
 */

/** The uploaded bundle size in whole kilobytes, as the status line and the toast show it. */
export function lanUploadSizeKb(sizeBytes: number): number {
  return Math.round(sizeBytes / 1024);
}
