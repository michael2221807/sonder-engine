/**
 * Image Size Options — ported
 *
 * Predefined image resolution presets for manual and automatic generation.
 * Exports:
 * - COMMON_SIZE_OPTIONS: 7 common sizes (512x512 to 832x1216)
 * - SCENE_PORTRAIT_SIZE_OPTIONS: 9 portrait scene presets
 * - SCENE_LANDSCAPE_SIZE_OPTIONS: 10 landscape scene presets
 */

type SizeOrientation = 'square' | 'portrait' | 'landscape';

export interface ImageSizeOption {
  value: string;
  label: string;
  width: number;
  height: number;
  orientation: SizeOrientation;
}

function createSizeOption(
  w: number,
  h: number,
  ratio: string,
  desc: string,
  orientation: SizeOrientation,
): ImageSizeOption {
  return {
    value: `${w}x${h}`,
    label: `${w}x${h} (${ratio}, ${desc})`,
    width: w,
    height: h,
    orientation,
  };
}

function dedup(options: ImageSizeOption[]): ImageSizeOption[] {
  const seen = new Set<string>();
  return options.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function indexByValue(options: ImageSizeOption[]): Map<string, ImageSizeOption> {
  return new Map(options.map((item) => [item.value, item]));
}

// ═══════════════════════════════════════════════════════════
// §1 — Common size presets (常用文生图尺寸选项)
// ═══════════════════════════════════════════════════════════

export const COMMON_SIZE_OPTIONS: ImageSizeOption[] = [
  createSizeOption(512, 512, '1:1', 'Icon', 'square'),
  createSizeOption(640, 640, '1:1', 'Icon', 'square'),
  createSizeOption(512, 768, '2:3', 'Portrait', 'portrait'),
  createSizeOption(768, 512, '3:2', 'Landscape', 'landscape'),
  createSizeOption(1024, 1024, '1:1', 'SDXL', 'square'),
  createSizeOption(1216, 832, '19:13', 'Ultra HD', 'landscape'),
  createSizeOption(832, 1216, '13:19', 'Ultra HD', 'portrait'),
];

// ═══════════════════════════════════════════════════════════
// §2 — Scene size presets (自动场景竖屏/横屏尺寸选项)
// ═══════════════════════════════════════════════════════════

const SCENE_EXTRA_SIZE_OPTIONS: ImageSizeOption[] = [
  createSizeOption(576, 1024, '9:16', 'Portrait', 'portrait'),
  createSizeOption(720, 1280, '9:16', 'Portrait HD', 'portrait'),
  createSizeOption(864, 1536, '9:16', 'Portrait HQ', 'portrait'),
  createSizeOption(768, 1024, '3:4', 'Portrait', 'portrait'),
  createSizeOption(832, 1216, '13:19', 'Ultra HD', 'portrait'),
  createSizeOption(1024, 1280, '4:5', 'Portrait', 'portrait'),
  createSizeOption(1024, 1536, '2:3', 'Portrait', 'portrait'),
  createSizeOption(1024, 576, '16:9', 'Landscape', 'landscape'),
  createSizeOption(1216, 832, '19:13', 'Ultra HD', 'landscape'),
  createSizeOption(1280, 720, '16:9', 'Landscape HD', 'landscape'),
  createSizeOption(1536, 864, '16:9', 'Landscape HQ', 'landscape'),
  createSizeOption(1152, 640, '18:10', 'Landscape', 'landscape'),
  createSizeOption(1024, 640, '8:5', 'Landscape', 'landscape'),
  createSizeOption(1024, 768, '4:3', 'Landscape', 'landscape'),
  createSizeOption(1024, 832, '5:4', 'Landscape', 'landscape'),
];

const ALL_SIZE_OPTIONS_MAP = indexByValue(dedup([
  ...SCENE_EXTRA_SIZE_OPTIONS,
  ...COMMON_SIZE_OPTIONS,
]));

function pickByOrder(values: string[]): ImageSizeOption[] {
  return values
    .map((v) => ALL_SIZE_OPTIONS_MAP.get(v))
    .filter((item): item is ImageSizeOption => Boolean(item));
}

export const SCENE_PORTRAIT_SIZE_OPTIONS: ImageSizeOption[] = pickByOrder([
  '576x1024',
  '720x1280',
  '768x1024',
  '832x1216',
  '864x1536',
  '1024x1024',
  '1024x1280',
  '1024x1536',
  '512x768',
]);

export const SCENE_LANDSCAPE_SIZE_OPTIONS: ImageSizeOption[] = pickByOrder([
  '1024x576',
  '1152x640',
  '1216x832',
  '1280x720',
  '1536x864',
  '1024x640',
  '1024x768',
  '1024x832',
  '1024x1024',
  '768x512',
]);

/**
 * Parse a "WxH" string into width/height numbers.
 * Returns null if format is invalid.
 */
export function parseSizeString(value: string): { width: number; height: number } | null {
  const m = value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) return null;
  return { width: w, height: h };
}

/**
 * Convert ImageSizeOption[] to SelectOption[] format for AgaSelect.
 */
export function sizeOptionsToSelectOptions(options: ImageSizeOption[]): Array<{ label: string; value: string }> {
  return options.map((o) => ({ label: o.label, value: o.value }));
}
