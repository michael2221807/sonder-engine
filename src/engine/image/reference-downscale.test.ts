import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  downscaleReferenceDataUrl,
  estimateDataUrlBytes,
  isReferenceOversized,
  REFERENCE_MAX_EDGE,
} from './reference-downscale';

/** 造一个指定 base64 载荷长度的 data URL（内容无关，只看体积判定）。 */
function makeDataUrl(bytes: number, mime = 'image/png'): string {
  const b64Len = Math.ceil((bytes * 4) / 3);
  return `data:${mime};base64,${'A'.repeat(b64Len)}`;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('estimateDataUrlBytes', () => {
  it('approximates the decoded byte count from base64 length', () => {
    expect(estimateDataUrlBytes(makeDataUrl(300_000))).toBeGreaterThan(299_000);
    expect(estimateDataUrlBytes(makeDataUrl(300_000))).toBeLessThan(301_000);
  });

  it('returns 0 for a malformed data URL with no comma', () => {
    expect(estimateDataUrlBytes('data:image/png;base64')).toBe(0);
  });
});

describe('isReferenceOversized', () => {
  it('flags payloads above the threshold', () => {
    // 真实存档里那张 2560x1440 上传图约 1.92MB —— 必须被判为偏大
    expect(isReferenceOversized(makeDataUrl(1_920_000))).toBe(true);
  });

  it('leaves typical generated images alone（832x1216 约 170-340KB）', () => {
    expect(isReferenceOversized(makeDataUrl(340_000))).toBe(false);
    expect(isReferenceOversized(makeDataUrl(170_000))).toBe(false);
  });

  it('never flags a remote URL (we do not download it)', () => {
    expect(isReferenceOversized('https://example.test/a.png')).toBe(false);
  });
});

describe('downscaleReferenceDataUrl — fail-soft 契约', () => {
  it('returns non-data URLs untouched', async () => {
    const url = 'https://example.test/a.png';
    expect(await downscaleReferenceDataUrl(url)).toBe(url);
  });

  it('returns the original when the environment cannot decode (vitest/node has no canvas)', async () => {
    // 该用例即"无 canvas 环境降级"的真实断言：这里跑在 node 环境下，
    // downscale 必须原样返回而不是抛错——否则生图会被压缩失败连累。
    const src = makeDataUrl(1_920_000);
    expect(await downscaleReferenceDataUrl(src)).toBe(src);
  });

  it('returns the original when image decoding fails', async () => {
    const src = makeDataUrl(1_920_000);
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null, toDataURL: () => 'data:image/jpeg;base64,AAAA' }),
    });
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    });
    expect(await downscaleReferenceDataUrl(src)).toBe(src);
  });

  it('scales the long edge down to the cap and re-encodes as JPEG', async () => {
    const src = makeDataUrl(1_920_000);
    const drawn: Array<[number, number]> = [];
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: (_i: unknown, _x: number, _y: number, w: number, h: number) => { drawn.push([w, h]); },
        }),
        toDataURL: (mime: string, q: number) => `data:${mime};q=${q};base64,SHORT`,
      }),
    });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      naturalWidth = 2560; naturalHeight = 1440;   // 真实存档里那张上传图
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    });

    const out = await downscaleReferenceDataUrl(src);
    expect(out).toContain('image/jpeg');
    // 2560x1440 → 长边压到 1536，保持宽高比
    expect(drawn[0][0]).toBe(REFERENCE_MAX_EDGE);
    expect(drawn[0][1]).toBe(Math.round(1440 * (REFERENCE_MAX_EDGE / 2560)));
  });

  it('keeps the original when re-encoding would make it bigger', async () => {
    const src = makeDataUrl(700_000, 'image/jpeg');
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {} }),
        // 故意返回一个比原图更长的结果
        toDataURL: () => `data:image/jpeg;base64,${'B'.repeat(src.length * 2)}`,
      }),
    });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      naturalWidth = 800; naturalHeight = 600;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    });
    expect(await downscaleReferenceDataUrl(src)).toBe(src);
  });

  it('leaves an already-compact image untouched（不做无谓的有损重编码）', async () => {
    const src = makeDataUrl(200_000, 'image/jpeg');
    let toDataUrlCalls = 0;
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => { toDataUrlCalls++; return 'data:image/jpeg;base64,X'; },
      }),
    });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      naturalWidth = 1024; naturalHeight = 1024;   // 长边未超限 + 体积达标
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    });
    expect(await downscaleReferenceDataUrl(src)).toBe(src);
    expect(toDataUrlCalls).toBe(0);
  });
});
