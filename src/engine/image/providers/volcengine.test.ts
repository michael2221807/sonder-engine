import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSeedreamSize, seedreamSupportsSeed, SEEDREAM_MAX_REFERENCE_IMAGES, VolcengineImageProvider } from './volcengine';
import type { ImageReferenceInput } from '../reference-types';

// NOTE: these ranges mirror the official docs as of 2026-08 and are pinned so
// future tweaks are deliberate; the real-key calibration matrix (P1 acceptance)
// is the authority if they disagree.
describe('resolveSeedreamSize', () => {
  const parse = (s: string) => s.split('x').map(Number) as [number, number];

  it('seedream-4.x: scales small requests up into [1280, 4096]', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 1024, 1024));
    expect(w).toBe(1280);
    expect(h).toBe(1280);
  });

  it('seedream-4.x: keeps aspect ratio for portrait requests', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 832, 1216));
    expect(w).toBe(1280);                       // min side raised to floor
    expect(h / w).toBeCloseTo(1216 / 832, 1);   // ratio preserved (±rounding)
    expect(h).toBeLessThanOrEqual(4096);
  });

  it('seedream-3.x: 1024 passes through unscaled inside [512, 2048]', () => {
    expect(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 1024, 1024)).toBe('1024x1024');
  });

  it('oversized requests scale down to the max bound', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 8192, 4096));
    expect(w).toBe(2048);
    expect(h).toBeGreaterThanOrEqual(512);      // clamped floor even at extreme ratios
    expect(h).toBeLessThanOrEqual(2048);
  });

  it('extreme aspect ratios stay within bounds (down-scale wins, floor clamps)', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 100, 4000));
    expect(w).toBeGreaterThanOrEqual(1280);
    expect(w).toBeLessThanOrEqual(4096);
    expect(h).toBeGreaterThanOrEqual(1280);
    expect(h).toBeLessThanOrEqual(4096);
  });

  it('every output side is a multiple of 8', () => {
    for (const [rw, rh] of [[1024, 1024], [832, 1216], [1920, 1080], [500, 700]] as const) {
      const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', rw, rh));
      expect(w % 8).toBe(0);
      expect(h % 8).toBe(0);
    }
  });

  it('unknown model uses the conservative [512, 4096] range without upscaling above floor', () => {
    expect(resolveSeedreamSize('some-future-model', 1024, 1024)).toBe('1024x1024');
  });

  it('non-finite / non-positive inputs fall back to a square instead of NaNxNaN', () => {
    expect(resolveSeedreamSize('doubao-seedream-4-0-250828', NaN, Infinity)).toBe('1280x1280');
    expect(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 0, -5)).toBe('1024x1024');
  });

  // seedream-5.x validates total PIXEL AREA, not per-dimension ranges —
  // live-verified 2026-08-27 ("at least 3686400" / "at most 16777216" pixels).
  describe('seedream-5.x area-based sizing', () => {
    const MIN = 3_686_400;
    const MAX = 16_777_216;

    it('scales a 1024 square up to the exact minimum area (1920x1920)', () => {
      expect(resolveSeedreamSize('doubao-seedream-5.0-lite', 1024, 1024)).toBe('1920x1920');
    });

    it('keeps aspect ratio while lifting small landscape requests over the floor', () => {
      const [w, h] = parse(resolveSeedreamSize('doubao-seedream-5.0-lite', 2048, 1024));
      expect(w * h).toBeGreaterThanOrEqual(MIN);
      expect(w / h).toBeCloseTo(2, 1);
      expect(w % 8).toBe(0);
      expect(h % 8).toBe(0);
    });

    it('passes through in-range sizes (live-verified 2048x1800 generates)', () => {
      expect(resolveSeedreamSize('doubao-seedream-5.0-lite', 2048, 1800)).toBe('2048x1800');
    });

    it('shrinks oversized requests under the area ceiling', () => {
      const [w, h] = parse(resolveSeedreamSize('doubao-seedream-5.0-lite', 8192, 8192));
      expect(w * h).toBeLessThanOrEqual(MAX);
      expect(w).toBe(h);
      expect(w % 8).toBe(0);
    });

    it('4096 square (exactly the max area) passes through', () => {
      expect(resolveSeedreamSize('doubao-seedream-5.0-lite', 4096, 4096)).toBe('4096x4096');
    });

    it('extreme aspect ratios never emit a zero side and stay within area bounds', () => {
      // Regression (review Important 2026-08-27): the free-text manual-size
      // inputs can feed values like 5000000x1; the in-range branch used to
      // round the tiny side straight to 0.
      for (const [rw, rh] of [[5_000_000, 1], [1, 5_000_000], [4_000_000, 2], [10_000_000, 3]] as const) {
        const [w, h] = parse(resolveSeedreamSize('doubao-seedream-5.0-lite', rw, rh));
        expect(w).toBeGreaterThanOrEqual(8);
        expect(h).toBeGreaterThanOrEqual(8);
        expect(w % 8).toBe(0);
        expect(h % 8).toBe(0);
        expect(w * h).toBeGreaterThanOrEqual(MIN);
        expect(w * h).toBeLessThanOrEqual(MAX);
      }
    });
  });
});

describe('seed 机型门控（官方参数表 2026-08-28）', () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureBody(model: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: unknown) => {
        resolve(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });
      }));
      const provider = new VolcengineImageProvider('https://ark.example.com', 'k', model);
      void provider.generate('a cat', '', 2048, 2048, options);
    });
  }

  it('seedreamSupportsSeed 只认 3.0-t2i / seededit-3.0-i2i', () => {
    // 点写法（文档）与连字符+日期写法（真实 endpoint ID）都必须认
    expect(seedreamSupportsSeed('doubao-seedream-3.0-t2i')).toBe(true);
    expect(seedreamSupportsSeed('doubao-seedream-3-0-t2i-250415')).toBe(true);
    expect(seedreamSupportsSeed('doubao-seededit-3.0-i2i')).toBe(true);
    expect(seedreamSupportsSeed('doubao-seededit-3-0-i2i-250628')).toBe(true);
    expect(seedreamSupportsSeed('doubao-seedream-5.0-lite')).toBe(false);
    expect(seedreamSupportsSeed('doubao-seedream-4.0')).toBe(false);
  });

  it('5.0-lite 不发 seed（官方：该机型不支持）', async () => {
    const body = await captureBody('doubao-seedream-5.0-lite', { seed: 42 });
    expect(body.seed).toBeUndefined();
  });

  it('3.0-t2i 仍然转发 seed', async () => {
    const body = await captureBody('doubao-seedream-3.0-t2i', { seed: 42 });
    expect(body.seed).toBe(42);
  });

  it('从不转发 guidance_scale（官方：5.0-lite/4.5/4.0 不支持）', async () => {
    const body = await captureBody('doubao-seedream-5.0-lite', { seed: 7, cfgScale: 5, guidance_scale: 5 });
    expect(body.guidance_scale).toBeUndefined();
  });
});

describe('多图参考重绘（PO 决策① 2026-08-29：只有豆包支持）', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function makeRef(i: number): ImageReferenceInput {
    return { id: `r${i}`, role: 'source', source: 'data_url', dataUrl: `data:image/png;base64,IMG${i}` };
  }

  function captureI2iBody(refs: ImageReferenceInput[]): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: unknown) => {
        resolve(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });
      }));
      const provider = new VolcengineImageProvider('https://ark.example.com', 'k', 'doubao-seedream-5.0-lite');
      void provider.imageToImage('a cat', '', 2048, 2048, refs);
    });
  }

  it('全部参考图按顺序进入 image 数组（顺序=提示词里的「图N」）', async () => {
    const body = await captureI2iBody([makeRef(1), makeRef(2), makeRef(3)]);
    expect(body.image).toEqual([
      'data:image/png;base64,IMG1',
      'data:image/png;base64,IMG2',
      'data:image/png;base64,IMG3',
    ]);
  });

  it('单张时行为与改造前一致（数组仍是一元）', async () => {
    const body = await captureI2iBody([makeRef(1)]);
    expect(body.image).toEqual(['data:image/png;base64,IMG1']);
  });

  it(`超过 ${SEEDREAM_MAX_REFERENCE_IMAGES} 张截断为前 N 张并告警（不整单失败）`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refs = Array.from({ length: SEEDREAM_MAX_REFERENCE_IMAGES + 3 }, (_, i) => makeRef(i));
    const body = await captureI2iBody(refs);
    expect((body.image as string[]).length).toBe(SEEDREAM_MAX_REFERENCE_IMAGES);
    expect((body.image as string[])[0]).toBe('data:image/png;base64,IMG0');
    expect(warn).toHaveBeenCalled();
  });

  it('缺 dataUrl/url 的项被剔除时必须告警（剔除会让「图N」前移）；全空则报错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = await captureI2iBody([
      { id: 'bad', role: 'source', source: 'asset', assetId: 'a1' },
      makeRef(9),
    ]);
    expect(body.image).toEqual(['data:image/png;base64,IMG9']);
    // review Important 2026-08-29：此前静默剔除，与本文件「绝不静默丢弃」自相矛盾
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('编号相应前移'));

    const provider = new VolcengineImageProvider('https://ark.example.com', 'k', 'doubao-seedream-5.0-lite');
    await expect(provider.imageToImage('x', '', 2048, 2048, [])).rejects.toThrow(/参考图缺少/);
  });

  it('多图不影响既有 body 字段（size/watermark/无 seed）', async () => {
    const body = await captureI2iBody([makeRef(1), makeRef(2)]);
    expect(body.model).toBe('doubao-seedream-5.0-lite');
    expect(body.size).toBe('2048x2048');
    expect(body.watermark).toBe(false);
    expect(body.seed).toBeUndefined();
  });
});

describe('VolcengineImageProvider generation URL', () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureUrl(endpoint: string): Promise<string> {
    return new Promise((resolve) => {
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        resolve(String(url));
        return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });
      }));
      const provider = new VolcengineImageProvider(endpoint, 'k', 'doubao-seedream-5.0-lite');
      void provider.generate('a cat', '', 2048, 2048);
    });
  }

  it('appends the pay-as-you-go path to a bare origin', async () => {
    expect(await captureUrl('https://ark.cn-beijing.volces.com'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });

  it('uses an endpoint that already carries a path verbatim (plan/proxy setups)', async () => {
    expect(await captureUrl('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations'))
      .toBe('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
    expect(await captureUrl('http://127.0.0.1:8787/ark-plan/images'))
      .toBe('http://127.0.0.1:8787/ark-plan/images');
  });
});
