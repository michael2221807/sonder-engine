// App doc: docs/user-guide/pages/game-image.md §6.3 PNG 画风预设（参数预览 · 不适用参数）
import type { ArtistPreset, ImageBackendType } from './types';
import { clamp } from './utils';
import { seedreamSupportsSeed } from './providers/volcengine';

export interface ResolvedStyleParams {
  steps?: number;
  cfgScale?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  noiseSchedule?: string;
  clipSkip?: number;
  smea?: boolean;
  smeaDyn?: boolean;
  cfgRescale?: number;
  preferBrownian?: boolean;
  [key: string]: unknown;
}

export interface StyleParamNotApplicable {
  key: string;
  value: unknown;
  reason: string;
}

export interface StyleParamApplicability {
  applied: ResolvedStyleParams;
  notApplicable: StyleParamNotApplicable[];
}

const NOVELAI_SAMPLER_NAMES = new Set([
  'k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m',
  'k_dpmpp_sde', 'k_dpmpp_2m_sde', 'ddim', 'ddim_v3',
]);

const CIVITAI_SCHEDULER_MAP: Record<string, string> = {
  'k_euler': 'Euler',
  'k_euler_ancestral': 'EulerA',
  'k_euler_a': 'EulerA',
  'euler': 'Euler',
  'euler_a': 'EulerA',
  'eulera': 'EulerA',
  'k_dpmpp_2m': 'DPM++2M',
  'k_dpmpp_sde': 'DPM++SDE',
  'k_dpmpp_2m_sde': 'DPM++2MSDE',
  'k_dpmpp_2s_ancestral': 'DPM++2SAncestral',
  'ddim': 'DDIM',
  'dpm2': 'DPM2',
  'dpm2_a': 'DPM2A',
  'lms': 'LMS',
  'heun': 'Heun',
  'uni_pc': 'UniPC',
  'uni_pc_bh2': 'UniPCBH2',
};

function mapSamplerForNovelAI(sampler: string): string | null {
  const lower = sampler.toLowerCase().trim();
  if (NOVELAI_SAMPLER_NAMES.has(lower)) return lower;
  if (NOVELAI_SAMPLER_NAMES.has(`k_${lower}`)) return `k_${lower}`;
  return null;
}

function mapSamplerForCivitai(sampler: string): string | null {
  const lower = sampler.toLowerCase().trim();
  return CIVITAI_SCHEDULER_MAP[lower] ?? null;
}

/**
 * @param model 该后端当前配置的模型名。**仅 Seedream 的 `seed` 需要它**：
 *   官方参数表把 `seed` 限定在 doubao-seedream-3.0-t2i / seededit-3.0-i2i，
 *   而 provider 侧已按机型门控（`seedreamSupportsSeed`）。不传（或后端没配模型）
 *   时退回保守判断——标不适用，好过对用户宣称「已应用」却被 provider 丢掉。
 */
export function resolveStyleParams(
  preset: ArtistPreset,
  backend: ImageBackendType,
  model?: string,
): StyleParamApplicability | null {
  if (!preset.pngMeta?.replicateParams || !preset.pngMeta?.parsedParams) return null;

  const parsed = preset.pngMeta.parsedParams;
  const applied: ResolvedStyleParams = {};
  const notApplicable: StyleParamNotApplicable[] = [];

  // steps — universal, except Seedream (no step parameter)
  if (typeof parsed.steps === 'number') {
    if (backend === 'volcengine') {
      notApplicable.push({ key: 'steps', value: parsed.steps, reason: 'Seedream 不支持步数参数' });
    } else {
      applied.steps = clamp(parsed.steps, 1, backend === 'civitai' ? 150 : 50);
    }
  }

  // cfgScale — universal, except Seedream: 官方参数表已确认 guidance_scale
  // 「doubao-seedream-5.0-lite / 4.5 / 4.0 不支持」，只有 3.0-t2i /
  // seededit-3.0-i2i 有。resolver 无模型上下文无法区分机型，宣称 applied 会
  // 对默认机型说谎（review Important 2026-08-26），故一律标不适用。
  // 校准悬念于 2026-08-28 官方规格核对后关闭（provider 侧注释见 volcengine.ts）。
  if (typeof parsed.cfgScale === 'number') {
    if (backend === 'volcengine') {
      notApplicable.push({ key: 'cfgScale', value: parsed.cfgScale, reason: 'Seedream 5.x/4.x 无 guidance_scale；仅 3.0-t2i / seededit-3.0-i2i 支持' });
    } else {
      applied.cfgScale = clamp(parsed.cfgScale, 1, backend === 'civitai' ? 30 : 20);
    }
  }

  // seed — universal, -1 means random。例外 Seedream：官方参数表写明「仅
  // doubao-seedream-3.0-t2i / doubao-seededit-3.0-i2i 支持该参数」，5.0-lite /
  // 4.x 收到也只会忽略。这里与 provider 侧门控用**同一个谓词**，避免
  // resolver 一刀切封死后 provider 的机型放行变成死代码（review Important
  // 2026-08-28）；拿不到模型名时才退回保守判断。
  if (typeof parsed.seed === 'number' && parsed.seed >= 0) {
    if (backend === 'volcengine' && !(model && seedreamSupportsSeed(model))) {
      notApplicable.push({ key: 'seed', value: parsed.seed, reason: 'Seedream 5.x/4.x 不支持 seed；仅 3.0-t2i / seededit-3.0-i2i 支持' });
    } else {
      applied.seed = parsed.seed;
    }
  }

  // sampler — requires backend-specific mapping
  if (typeof parsed.sampler === 'string') {
    if (backend === 'novelai') {
      const mapped = mapSamplerForNovelAI(parsed.sampler);
      if (mapped) applied.sampler = mapped;
      else notApplicable.push({ key: 'sampler', value: parsed.sampler, reason: 'NovelAI 不支持此采样器' });
    } else if (backend === 'civitai') {
      const mapped = mapSamplerForCivitai(parsed.sampler);
      if (mapped) applied.scheduler = mapped;
      else notApplicable.push({ key: 'sampler', value: parsed.sampler, reason: 'Civitai 不支持此采样器' });
    } else {
      notApplicable.push({ key: 'sampler', value: parsed.sampler, reason: `${backend} 暂不支持采样器映射` });
    }
  }

  // --- NovelAI exclusive ---
  if (backend === 'novelai') {
    if (typeof parsed.noiseSchedule === 'string') applied.noiseSchedule = parsed.noiseSchedule;
    if (typeof parsed.smea === 'boolean') applied.smea = parsed.smea;
    if (typeof parsed.smeaDynamic === 'boolean') applied.smeaDyn = parsed.smeaDynamic;
    if (typeof parsed.cfgRescale === 'number') applied.cfgRescale = parsed.cfgRescale;
    if (typeof parsed.preferBrownian === 'boolean') applied.preferBrownian = parsed.preferBrownian;
  } else {
    if (parsed.noiseSchedule != null) notApplicable.push({ key: 'noiseSchedule', value: parsed.noiseSchedule, reason: 'NovelAI 专属' });
    if (parsed.smea != null) notApplicable.push({ key: 'smea', value: parsed.smea, reason: 'NovelAI 专属' });
    if (parsed.smeaDynamic != null) notApplicable.push({ key: 'smeaDynamic', value: parsed.smeaDynamic, reason: 'NovelAI 专属' });
    if (parsed.cfgRescale != null) notApplicable.push({ key: 'cfgRescale', value: parsed.cfgRescale, reason: 'NovelAI 专属' });
    if (parsed.preferBrownian != null) notApplicable.push({ key: 'preferBrownian', value: parsed.preferBrownian, reason: 'NovelAI 专属' });
  }

  // --- Civitai exclusive ---
  if (backend === 'civitai' && typeof parsed.clipSkip === 'number') {
    applied.clipSkip = clamp(parsed.clipSkip, 1, 12);
  } else if (parsed.clipSkip != null && backend !== 'civitai') {
    notApplicable.push({ key: 'clipSkip', value: parsed.clipSkip, reason: 'Civitai 专属' });
  }

  // --- Never auto-applied ---
  if (parsed.width != null) notApplicable.push({ key: 'width', value: parsed.width, reason: '需启用复刻尺寸' });
  if (parsed.height != null) notApplicable.push({ key: 'height', value: parsed.height, reason: '需启用复刻尺寸' });
  if (parsed.model != null) notApplicable.push({ key: 'model', value: parsed.model, reason: '不自动切换模型' });
  if (Array.isArray(parsed.loras) && parsed.loras.length > 0) {
    notApplicable.push({ key: 'loras', value: `${parsed.loras.length} 个 LoRA`, reason: '需手动添加到 LoRA 书架' });
  }
  if (parsed.unconditionalScale != null) notApplicable.push({ key: 'unconditionalScale', value: parsed.unconditionalScale, reason: '暂不支持' });
  if (parsed.dynamicThresholding != null) notApplicable.push({ key: 'dynamicThresholding', value: parsed.dynamicThresholding, reason: '暂不支持' });

  return (Object.keys(applied).length > 0 || notApplicable.length > 0)
    ? { applied, notApplicable }
    : null;
}
