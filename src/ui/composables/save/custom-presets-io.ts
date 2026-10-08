/**
 * The custom-presets file of SavePanel (2026-04-14 Phase 5): its shape and the pure steps of exporting and importing it,
 * moved out of SavePanel.vue (refactor R7 step 10). The panel keeps the busy flags, the store calls, the file picker,
 * the confirm dialog, the download and every toast.
 */

export interface CustomPresetsExportFile {
  /** 固定为 1，未来字段变化时升版 */
  version: number;
  /** 区分文件类型与全量备份 */
  type: 'custom_presets';
  /** 与导出时的 packId 绑定，导入时校验 */
  packId: string;
  /** ISO 时间戳 */
  exportedAt: string;
  /** 各 preset 类型的用户条目数组（结构与 BackupBundle.customPresets[packId] 一致） */
  presets: Record<string, unknown[]>;
}

/** CR-2026-04-14 P2-8：校验文件版本 —— 高于当前支持版本时拒绝 */
export const CUSTOM_PRESETS_SUPPORTED_VERSION = 1;

/** How many user entries a preset map holds, over all preset types. */
export function countCustomPresets(presets: Record<string, unknown[]> | undefined): number {
  return Object.values(presets ?? {}).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
}

/** The file written for the presets of a pack. */
export function buildCustomPresetsExport(
  packId: string,
  presets: Record<string, unknown[]> | undefined,
  exportedAt: string,
): CustomPresetsExportFile {
  return {
    version: 1,
    type: 'custom_presets',
    packId,
    exportedAt,
    presets: presets ?? {},
  };
}

/** The download name of the presets file. */
export function customPresetsFileName(packId: string, today: string): string {
  return `presets-${packId}-${today}.json`;
}

/** True when the file's version is not a number or is newer than this build understands. */
export function isUnsupportedPresetsVersion(version: unknown): boolean {
  return typeof version !== 'number' || version > CUSTOM_PRESETS_SUPPORTED_VERSION;
}

/** The importable entries of a file's preset map: object entries only, types with none are left out. */
export function cleanImportedPresets(presets: Record<string, unknown[]> | undefined): Record<string, Record<string, unknown>[]> {
  const presetsByType: Record<string, Record<string, unknown>[]> = {};
  for (const [presetType, list] of Object.entries(presets ?? {})) {
    if (!Array.isArray(list)) continue;
    const cleaned: Record<string, unknown>[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      cleaned.push(raw as Record<string, unknown>);
    }
    if (cleaned.length > 0) presetsByType[presetType] = cleaned;
  }
  return presetsByType;
}
