import { describe, it, expect } from 'vitest';
import { resolveStyleParams } from './style-param-resolver';
import type { ArtistPreset } from './types';

function makePreset(parsedParams: Record<string, unknown>, replicateParams = true): ArtistPreset {
  return {
    id: 'png_test',
    name: 'Test PNG',
    scope: 'npc',
    artistString: '',
    positive: '1girl',
    negative: 'lowres',
    pngMeta: {
      source: 'novelai',
      parsedParams,
      replicateParams,
    },
  };
}

describe('resolveStyleParams', () => {
  // ── Null return cases ──

  it('returns null when replicateParams is false', () => {
    expect(resolveStyleParams(makePreset({ steps: 28 }, false), 'novelai')).toBeNull();
  });

  it('returns null when parsedParams is undefined', () => {
    const preset = makePreset({});
    preset.pngMeta!.parsedParams = undefined;
    expect(resolveStyleParams(preset, 'novelai')).toBeNull();
  });

  it('returns null when pngMeta is undefined', () => {
    const preset: ArtistPreset = { id: 'test', name: 'Test', scope: 'npc', artistString: '', positive: '', negative: '' };
    expect(resolveStyleParams(preset, 'novelai')).toBeNull();
  });

  // ── 火山方舟 Seedream（2026-08-28 官方规格核对）──

  describe('volcengine / Seedream', () => {
    const na = (r: ReturnType<typeof resolveStyleParams>, key: string) =>
      r!.notApplicable.find((n) => n.key === key);

    it('steps 与 cfgScale 一律不适用（Seedream 无步数；5.x/4.x 无 guidance_scale）', () => {
      const r = resolveStyleParams(makePreset({ steps: 28, cfgScale: 7 }), 'volcengine')!;
      expect(r.applied.steps).toBeUndefined();
      expect(r.applied.cfgScale).toBeUndefined();
      expect(na(r, 'steps')).toBeDefined();
      expect(na(r, 'cfgScale')?.reason).toContain('3.0-t2i');
    });

    it('未传模型名时 seed 保守标为不适用', () => {
      const r = resolveStyleParams(makePreset({ seed: 12345 }), 'volcengine')!;
      expect(r.applied.seed).toBeUndefined();
      expect(na(r, 'seed')?.reason).toContain('3.0-t2i');
    });

    it('5.0-lite / 4.x 的 seed 不适用', () => {
      for (const model of ['doubao-seedream-5.0-lite', 'doubao-seedream-4-0-250828']) {
        const r = resolveStyleParams(makePreset({ seed: 12345 }), 'volcengine', model)!;
        expect(r.applied.seed).toBeUndefined();
        expect(na(r, 'seed')).toBeDefined();
      }
    });

    // 回归钉死（review Important 2026-08-28）：resolver 一刀切封死会让 provider
    // 侧的机型门控变成死代码——支持 seed 的机型必须真的能拿到 seed。
    it('3.0-t2i / seededit-3.0-i2i 的 seed 正常应用', () => {
      for (const model of ['doubao-seedream-3.0-t2i', 'doubao-seedream-3-0-t2i-250415', 'doubao-seededit-3-0-i2i-250628']) {
        const r = resolveStyleParams(makePreset({ seed: 12345 }), 'volcengine', model)!;
        expect(r.applied.seed).toBe(12345);
        expect(na(r, 'seed')).toBeUndefined();
      }
    });

    it('model 参数只影响 volcengine，其它后端 seed 照常应用', () => {
      const r = resolveStyleParams(makePreset({ seed: 7 }), 'novelai', 'doubao-seedream-5.0-lite')!;
      expect(r.applied.seed).toBe(7);
    });
  });

  // ── Universal fields ──

  it('maps steps for all backends', () => {
    const result = resolveStyleParams(makePreset({ steps: 28 }), 'novelai')!;
    expect(result.applied.steps).toBe(28);
  });

  it('clamps steps to provider range — NovelAI max 50', () => {
    const result = resolveStyleParams(makePreset({ steps: 100 }), 'novelai')!;
    expect(result.applied.steps).toBe(50);
  });

  it('clamps steps to provider range — Civitai max 150', () => {
    const result = resolveStyleParams(makePreset({ steps: 100 }), 'civitai')!;
    expect(result.applied.steps).toBe(100);
  });

  it('maps cfgScale for all backends', () => {
    const result = resolveStyleParams(makePreset({ cfgScale: 7.5 }), 'civitai')!;
    expect(result.applied.cfgScale).toBe(7.5);
  });

  it('clamps cfgScale — NovelAI max 20', () => {
    const result = resolveStyleParams(makePreset({ cfgScale: 25 }), 'novelai')!;
    expect(result.applied.cfgScale).toBe(20);
  });

  it('maps seed when >= 0', () => {
    const result = resolveStyleParams(makePreset({ seed: 42 }), 'novelai')!;
    expect(result.applied.seed).toBe(42);
  });

  it('ignores seed when < 0 (random)', () => {
    const result = resolveStyleParams(makePreset({ seed: -1 }), 'novelai');
    expect(result).toBeNull();
  });

  // ── Sampler mapping ──

  it('maps k_euler_ancestral for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'k_euler_ancestral' }), 'novelai')!;
    expect(result.applied.sampler).toBe('k_euler_ancestral');
  });

  it('maps euler to k_euler for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'euler' }), 'novelai')!;
    expect(result.applied.sampler).toBe('k_euler');
  });

  it('maps k_euler to Euler for Civitai', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'k_euler' }), 'civitai')!;
    expect(result.applied.scheduler).toBe('Euler');
  });

  it('maps k_euler_ancestral to EulerA for Civitai', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'k_euler_ancestral' }), 'civitai')!;
    expect(result.applied.scheduler).toBe('EulerA');
  });

  it('puts unknown sampler in notApplicable for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'mystery_sampler' }), 'novelai')!;
    expect(result.applied.sampler).toBeUndefined();
    expect(result.notApplicable.find((n) => n.key === 'sampler')).toBeDefined();
  });

  it('puts unknown sampler in notApplicable for Civitai', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'mystery_sampler' }), 'civitai')!;
    expect(result.applied.scheduler).toBeUndefined();
    expect(result.notApplicable.find((n) => n.key === 'sampler')).toBeDefined();
  });

  it('puts sampler in notApplicable for unsupported backend', () => {
    const result = resolveStyleParams(makePreset({ sampler: 'k_euler' }), 'openai')!;
    expect(result.notApplicable.find((n) => n.key === 'sampler')?.reason).toContain('openai');
  });

  // ── NovelAI exclusive ──

  it('maps noiseSchedule for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ noiseSchedule: 'karras' }), 'novelai')!;
    expect(result.applied.noiseSchedule).toBe('karras');
  });

  it('maps smea for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ smea: true }), 'novelai')!;
    expect(result.applied.smea).toBe(true);
  });

  it('maps smeaDynamic to smeaDyn for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ smeaDynamic: true }), 'novelai')!;
    expect(result.applied.smeaDyn).toBe(true);
  });

  it('maps cfgRescale for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ cfgRescale: 0.5 }), 'novelai')!;
    expect(result.applied.cfgRescale).toBe(0.5);
  });

  it('maps preferBrownian for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ preferBrownian: true }), 'novelai')!;
    expect(result.applied.preferBrownian).toBe(true);
  });

  it('puts NovelAI-exclusive params in notApplicable for Civitai', () => {
    const result = resolveStyleParams(makePreset({
      noiseSchedule: 'karras',
      smea: true,
      smeaDynamic: false,
      cfgRescale: 0.3,
      preferBrownian: true,
    }), 'civitai')!;

    const naKeys = result.notApplicable.map((n) => n.key);
    expect(naKeys).toContain('noiseSchedule');
    expect(naKeys).toContain('smea');
    expect(naKeys).toContain('smeaDynamic');
    expect(naKeys).toContain('cfgRescale');
    expect(naKeys).toContain('preferBrownian');
    for (const na of result.notApplicable.filter((n) => naKeys.includes(n.key))) {
      expect(na.reason).toContain('NovelAI');
    }
  });

  // ── Civitai exclusive ──

  it('maps clipSkip for Civitai', () => {
    const result = resolveStyleParams(makePreset({ clipSkip: 2 }), 'civitai')!;
    expect(result.applied.clipSkip).toBe(2);
  });

  it('clamps clipSkip to 1-12', () => {
    const result = resolveStyleParams(makePreset({ clipSkip: 20 }), 'civitai')!;
    expect(result.applied.clipSkip).toBe(12);
  });

  it('puts clipSkip in notApplicable for NovelAI', () => {
    const result = resolveStyleParams(makePreset({ clipSkip: 2 }), 'novelai')!;
    expect(result.notApplicable.find((n) => n.key === 'clipSkip')?.reason).toContain('Civitai');
  });

  // ── Never auto-applied ──

  it('puts width/height in notApplicable', () => {
    const result = resolveStyleParams(makePreset({ width: 1024, height: 768 }), 'novelai')!;
    expect(result.notApplicable.find((n) => n.key === 'width')).toBeDefined();
    expect(result.notApplicable.find((n) => n.key === 'height')).toBeDefined();
    expect(result.applied).toEqual({});
  });

  it('puts model in notApplicable', () => {
    const result = resolveStyleParams(makePreset({ model: 'nai-diffusion-4' }), 'novelai')!;
    expect(result.notApplicable.find((n) => n.key === 'model')?.reason).toContain('模型');
  });

  it('puts loras in notApplicable with count', () => {
    const result = resolveStyleParams(makePreset({ loras: [{ name: 'test', weight: 0.8 }] }), 'civitai')!;
    const na = result.notApplicable.find((n) => n.key === 'loras');
    expect(na?.value).toBe('1 个 LoRA');
    expect(na?.reason).toContain('LoRA 书架');
  });

  it('puts unconditionalScale in notApplicable', () => {
    const result = resolveStyleParams(makePreset({ unconditionalScale: 1 }), 'novelai')!;
    expect(result.notApplicable.find((n) => n.key === 'unconditionalScale')).toBeDefined();
  });

  it('puts dynamicThresholding in notApplicable', () => {
    const result = resolveStyleParams(makePreset({ dynamicThresholding: true }), 'novelai')!;
    expect(result.notApplicable.find((n) => n.key === 'dynamicThresholding')).toBeDefined();
  });

  // ── Comprehensive case ──

  it('handles full NovelAI parsedParams correctly', () => {
    const result = resolveStyleParams(makePreset({
      steps: 28, cfgScale: 5, seed: 42, sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras', smea: true, smeaDynamic: false,
      cfgRescale: 0.3, preferBrownian: true,
      width: 832, height: 1216, model: 'nai-diffusion-4-5-full',
      clipSkip: 2,
    }), 'novelai')!;

    expect(result.applied.steps).toBe(28);
    expect(result.applied.cfgScale).toBe(5);
    expect(result.applied.seed).toBe(42);
    expect(result.applied.sampler).toBe('k_euler_ancestral');
    expect(result.applied.noiseSchedule).toBe('karras');
    expect(result.applied.smea).toBe(true);
    expect(result.applied.smeaDyn).toBe(false);
    expect(result.applied.cfgRescale).toBe(0.3);
    expect(result.applied.preferBrownian).toBe(true);

    const naKeys = result.notApplicable.map((n) => n.key);
    expect(naKeys).toContain('width');
    expect(naKeys).toContain('height');
    expect(naKeys).toContain('model');
    expect(naKeys).toContain('clipSkip');
  });

  it('handles full Civitai parsedParams correctly', () => {
    const result = resolveStyleParams(makePreset({
      steps: 25, cfgScale: 7, seed: 100, sampler: 'k_euler',
      clipSkip: 2, width: 1024, height: 1024,
      smea: true, noiseSchedule: 'native',
    }), 'civitai')!;

    expect(result.applied.steps).toBe(25);
    expect(result.applied.cfgScale).toBe(7);
    expect(result.applied.seed).toBe(100);
    expect(result.applied.scheduler).toBe('Euler');
    expect(result.applied.clipSkip).toBe(2);

    const naKeys = result.notApplicable.map((n) => n.key);
    expect(naKeys).toContain('width');
    expect(naKeys).toContain('height');
    expect(naKeys).toContain('smea');
    expect(naKeys).toContain('noiseSchedule');
  });
});
