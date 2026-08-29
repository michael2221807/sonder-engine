import { describe, it, expect, vi, afterEach } from 'vitest';
import { NovelAIImageProvider } from './novelai';
import type { ImageReferenceInput } from '../reference-types';

/**
 * NovelAI 参考重绘的**单图契约**（多图参考重绘 epic S1，2026-08-29）。
 *
 * NovelAI img2img 的 `parameters.image` 是单个 base64 字符串——它的多图能力
 * 属于另一个功能 Vibe Transfer（`reference_image_multiple`，≤16 张，V4+ 每张
 * 需付费编码），语义是搬运画风而非照原图重绘，**不并入本方法**。故目录里不
 * 声明 `multiReference`，UI 选不出第二张；这里钉死引擎侧兜底：取首张 + 告警，
 * 绝不静默丢弃。查证见 docs/design/seedream-multi-reference-implementation.md §1。
 */
describe('NovelAIImageProvider.imageToImage 单图契约', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function makeRef(tag: string): ImageReferenceInput {
    return {
      id: `ref_${tag}`,
      role: 'source',
      source: 'data_url',
      dataUrl: `data:image/png;base64,${tag}`,
      denoiseStrength: 0.5,
    };
  }

  /** 捕获请求体后让响应失败——本用例只关心我们发了什么，不关心 NAI 的 zip 解码。 */
  function captureBody(refs: ImageReferenceInput[]): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: unknown) => {
        resolve(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
        return new Response('nope', { status: 500 });
      }));
      const provider = new NovelAIImageProvider('https://api.novelai.net', 'k', 'nai-diffusion-4-5-full');
      void provider.imageToImage('a girl', '', 832, 1216, refs).catch(() => { /* 预期失败 */ });
    });
  }

  it('单张：base64 去掉 data URL 前缀后进 parameters.image', async () => {
    const body = await captureBody([makeRef('ONLY')]);
    const params = body.parameters as Record<string, unknown>;
    expect(params.image).toBe('ONLY');
    expect(params.strength).toBe(0.5);
    expect(body.action).toBe('img2img');
  });

  it('多张：取第 1 张并告警（不静默丢弃）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = await captureBody([makeRef('FIRST'), makeRef('SECOND'), makeRef('THIRD')]);
    const params = body.parameters as Record<string, unknown>;
    expect(params.image).toBe('FIRST');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('只支持单图'));
  });

  it('空列表直接报错', async () => {
    const provider = new NovelAIImageProvider('https://api.novelai.net', 'k', 'nai-diffusion-4-5-full');
    await expect(provider.imageToImage('x', '', 832, 1216, []))
      .rejects.toThrow(/参考图列表为空/);
  });

  it('远程 URL（非 data URL）仍然明确拒绝——多图改造不得放宽此限制', async () => {
    const provider = new NovelAIImageProvider('https://api.novelai.net', 'k', 'nai-diffusion-4-5-full');
    const remote: ImageReferenceInput = { id: 'r', role: 'source', source: 'url', url: 'https://example.com/a.png' };
    await expect(provider.imageToImage('x', '', 832, 1216, [remote]))
      .rejects.toThrow(/base64 data URL/);
  });
});
