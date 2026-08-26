import type { ArtistPreset, ImageBackendType } from './types';
import { clamp } from './utils';

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

export function resolveStyleParams(
  preset: ArtistPreset,
  backend: ImageBackendType,
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

  // cfgScale — universal, except Seedream: guidance_scale 只在 3.x 模型存在
  // （4.x 无此参数），resolver 无模型上下文无法区分，宣称 applied 会对默认
  // 4.x 模型说谎（review Important 2026-08-26）。保守标记不适用，待 P1 真实
  // key 校准后再按模型系开启（provider 侧映射注释见 volcengine.ts）。
  if (typeof parsed.cfgScale === 'number') {
    if (backend === 'volcengine') {
      notApplicable.push({ key: 'cfgScale', value: parsed.cfgScale, reason: 'Seedream 4.x 无 guidance_scale；3.x 待真实校准' });
    } else {
      applied.cfgScale = clamp(parsed.cfgScale, 1, backend === 'civitai' ? 30 : 20);
    }
  }

  // seed — universal, -1 means random
  if (typeof parsed.seed === 'number' && parsed.seed >= 0) {
    applied.seed = parsed.seed;
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
