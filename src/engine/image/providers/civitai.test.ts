import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CivitaiImageProvider, CivitaiBlockedError } from './civitai';
import { supportsImageToImage, supportsImageUnderstanding } from '../provider-capabilities';
import type { ImageReferenceInput, ImageUnderstandingRequest } from '../reference-types';

function makeProvider(model = 'urn:air:sdxl:checkpoint:civitai:101055@128078'): CivitaiImageProvider {
  return new CivitaiImageProvider('https://orchestration.civitai.com', 'test-key', model);
}

function mockFetchSequence(...responses: Array<{ status: number; body?: unknown; blob?: Blob; text?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let callIndex = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.status === 200 ? 'OK' : 'Error',
      headers: new Headers(resp.headers ?? { 'content-type': 'application/json' }),
      text: async () => resp.text ?? JSON.stringify(resp.body ?? {}),
      json: async () => resp.body,
      blob: async () => resp.blob ?? new Blob(['fake-image'], { type: 'image/jpeg' }),
    } as unknown as Response;
  }));
  return calls;
}

function makeReference(overrides?: Partial<ImageReferenceInput>): ImageReferenceInput {
  return {
    id: 'ref_test',
    role: 'source',
    source: 'data_url',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    denoiseStrength: 0.65,
    ...overrides,
  };
}

function makeUnderstandingRequest(task: 'tags' | 'caption' | 'both', overrides?: Partial<ImageUnderstandingRequest>): ImageUnderstandingRequest {
  return {
    engine: 'civitai_vlm',
    image: makeReference(),
    task,
    temperature: 0.2,
    maxNewTokens: 300,
    ...overrides,
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('CivitaiImageProvider', () => {
  // ── Capability type guards ──

  describe('capability interfaces', () => {
    it('supportsImageToImage returns true', () => {
      expect(supportsImageToImage(makeProvider())).toBe(true);
    });

    it('supportsImageUnderstanding returns true', () => {
      expect(supportsImageUnderstanding(makeProvider())).toBe(true);
    });
  });

  // ── generate() — all existing tests preserved ──

  describe('generate()', () => {
    it('returns blob on successful generation', async () => {
      const imageBlob = new Blob(['png-data'], { type: 'image/png' });
      mockFetchSequence(
        { status: 200, body: { images: [{ id: 'test.jpeg', width: 1024, height: 1024, available: true, url: 'https://orchestration-new.civitai.com/v2/consumer/blobs/test.jpeg?sig=abc' }] } },
        { status: 200, blob: imageBlob },
      );

      const result = await makeProvider().generate('a cat', 'bad', 1024, 1024);
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/png');
    });

    it('sends model, prompt, negative, dimensions in request body', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 512, height: 768 }] } },
        { status: 200 },
      );

      await makeProvider().generate('masterpiece', 'lowres', 512, 768);
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.model).toBe('urn:air:sdxl:checkpoint:civitai:101055@128078');
      expect(body.prompt).toBe('masterpiece');
      expect(body.negativePrompt).toBe('lowres');
      expect(body.width).toBe(512);
      expect(body.height).toBe(768);
      expect(body.quantity).toBe(1);
      expect(body.batchSize).toBe(1);
    });

    it('passes allowMatureContent in query string', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, { allowMatureContent: true });
      expect(calls[0].url).toContain('allowMatureContent=true');
    });

    it('does not include allowMatureContent when false', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, { allowMatureContent: false });
      expect(calls[0].url).not.toContain('allowMatureContent');
    });

    it('passes scheduler, steps, cfgScale, clipSkip, seed in body', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, {
        scheduler: 'EulerA',
        steps: 25,
        cfgScale: 7,
        clipSkip: 2,
        seed: 42,
      });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.scheduler).toBe('EulerA');
      expect(body.steps).toBe(25);
      expect(body.cfgScale).toBe(7);
      expect(body.clipSkip).toBe(2);
      expect(body.seed).toBe(42);
    });

    it('includes cfgScale=0 and steps=0 in body (null-safe guard)', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, { steps: 0, cfgScale: 0 });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.steps).toBe(0);
      expect(body.cfgScale).toBe(0);
    });

    it('omits seed when -1 (random)', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, { seed: -1 });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.seed).toBeUndefined();
    });

    it('throws CivitaiBlockedError when blockedReason is present', async () => {
      mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: false, blockedReason: 'content_policy', nsfwLevel: 'xxx' }] } },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow(CivitaiBlockedError);

      try {
        await makeProvider().generate('test', '', 1024, 1024);
      } catch (e) {
        expect((e as CivitaiBlockedError).blockedReason).toBe('content_policy');
        expect((e as CivitaiBlockedError).nsfwLevel).toBe('xxx');
        expect((e as Error).message).toContain('content_policy');
      }
    });

    it('throws when image is not available and no job ID for polling', async () => {
      mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: false }] } },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('无法获取任务 ID');
    });

    it('throws when response has no images', async () => {
      mockFetchSequence(
        { status: 200, body: { images: [] } },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('响应中无图片数据');
    });

    it('throws descriptive error on whatif mode', async () => {
      mockFetchSequence(
        { status: 200, body: { cost: 6, totalCost: 6 } },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024, { whatif: true }))
        .rejects.toThrow(/预览模式.*6 Buzz/);
    });

    it('throws on HTTP 401 with API key hint', async () => {
      mockFetchSequence({ status: 401, text: 'Unauthorized' });

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('API Key 无效');
    });

    it('throws on HTTP 402 with Buzz hint', async () => {
      mockFetchSequence({ status: 402, text: 'Payment Required' });

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('Buzz 余额不足');
    });

    it('throws on HTTP 429 with rate limit hint', async () => {
      mockFetchSequence({ status: 429, text: 'Too Many Requests' });

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('请求过于频繁');
    });

    it('throws on HTTP 400 with error body excerpt', async () => {
      mockFetchSequence({ status: 400, text: 'Invalid model AIR format' });

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow(/请求参数错误.*Invalid model/);
    });

    it('throws on non-JSON 200 response', async () => {
      mockFetchSequence({ status: 200, text: '<html>Maintenance</html>' });

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('响应解析失败');
    });

    it('throws on invalid additionalNetworks JSON', async () => {
      mockFetchSequence({ status: 200, body: {} });

      await expect(makeProvider().generate('test', '', 1024, 1024, {
        additionalNetworksJson: '{not valid json',
      })).rejects.toThrow(/附加网络.*JSON 格式错误/);
    });

    it('throws on invalid controlNets JSON', async () => {
      mockFetchSequence({ status: 200, body: {} });

      await expect(makeProvider().generate('test', '', 1024, 1024, {
        controlNetsJson: '[broken',
      })).rejects.toThrow(/ControlNet.*JSON 格式错误/);
    });

    it('ignores empty additionalNetworks JSON', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, { additionalNetworksJson: '' });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.additionalNetworks).toBeUndefined();
    });

    it('parses valid additionalNetworks JSON into body', async () => {
      const networks = { 'urn:air:sdxl:lora:civitai:123@456': { type: 'Lora', strength: 0.8 } };
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().generate('test', '', 1024, 1024, {
        additionalNetworksJson: JSON.stringify(networks),
      });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.additionalNetworks).toEqual(networks);
    });

    it('rejects non-HTTPS image URLs', async () => {
      mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'http://example.com/img', width: 1024, height: 1024 }] } },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('必须为 HTTPS');
    });

    it('throws when blob fetch fails', async () => {
      mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 403 },
      );

      await expect(makeProvider().generate('test', '', 1024, 1024))
        .rejects.toThrow('下载图片失败: 403');
    });
  });

  // ── imageToImage() ──

  describe('imageToImage()', () => {
    it('sends sourceImage and sourceImageDenoiseStrenght (typo) in body', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      const ref = makeReference({ denoiseStrength: 0.7 });
      await makeProvider().imageToImage('portrait', 'bad', 1024, 1024, ref);

      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.sourceImage).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(body.sourceImageDenoiseStrenght).toBe(0.7);
      expect(body.prompt).toBe('portrait');
      expect(body.negativePrompt).toBe('bad');
    });

    it('uses same textToImage endpoint', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().imageToImage('test', '', 1024, 1024, makeReference());
      expect(calls[0].url).toContain('/v2/consumer/recipes/textToImage');
    });

    it('includes allowMatureContent query', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().imageToImage('test', '', 1024, 1024, makeReference(), { allowMatureContent: true });
      expect(calls[0].url).toContain('allowMatureContent=true');
    });

    it('defaults denoiseStrength to 0.65', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().imageToImage('test', '', 1024, 1024, makeReference({ denoiseStrength: undefined }));
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.sourceImageDenoiseStrenght).toBe(0.65);
    });

    it('clamps denoiseStrength to 0-1', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().imageToImage('test', '', 1024, 1024, makeReference({ denoiseStrength: 1.5 }));
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.sourceImageDenoiseStrenght).toBe(1);
    });

    it('throws when reference has no dataUrl or url', async () => {
      const ref = makeReference({ dataUrl: undefined, url: undefined });
      await expect(makeProvider().imageToImage('test', '', 1024, 1024, ref))
        .rejects.toThrow('参考图缺少 dataUrl 或 url');
    });

    it('falls back to url when dataUrl is absent', async () => {
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      const ref = makeReference({ dataUrl: undefined, url: 'https://example.com/source.png' });
      await makeProvider().imageToImage('test', '', 1024, 1024, ref);
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.sourceImage).toBe('https://example.com/source.png');
    });

    it('preserves LoRA additionalNetworks alongside sourceImage', async () => {
      const networks = { 'urn:air:sdxl:lora:civitai:123@456': { type: 'Lora', strength: 0.8 } };
      const calls = mockFetchSequence(
        { status: 200, body: { images: [{ id: 'x.jpeg', available: true, url: 'https://example.com/img', width: 1024, height: 1024 }] } },
        { status: 200 },
      );

      await makeProvider().imageToImage('test', '', 1024, 1024, makeReference(), {
        additionalNetworksJson: JSON.stringify(networks),
      });
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.additionalNetworks).toEqual(networks);
      expect(body.sourceImage).toBeDefined();
    });
  });

  // ── describeImage() — chatCompletion VLM 契约（图片提炼重建 epic P1） ──

  const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
  // 真实校准（2026-08-27）：anthropic 路由小图 promptTokens≈109；防幻觉断言只对 openai/ 路由生效
  const okUsage = { promptTokens: 109, completionTokens: 50, totalTokens: 159 };
  // usage 传 null 表示响应体不含 usage 字段（显式 undefined 会落回默认参数）
  const chatOk = (
    content: string,
    usage: Record<string, unknown> | null = okUsage,
    model = 'anthropic/claude-sonnet-5',
  ) => ({
    status: 200,
    body: { model, choices: [{ message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) },
  });
  const BOTH_JSON = '{"tags":["1girl","red_circle","simple_background"],"caption":"A girl in a garden"}';

  describe('describeImage()', () => {
    it('sends a single chatCompletion request with camelCase imageUrl block（snake_case 会被网关静默丢图）', async () => {
      const calls = mockFetchSequence(chatOk(BOTH_JSON));

      await makeProvider().describeImage(makeUnderstandingRequest('both'));

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/v2/consumer/recipes/chatCompletion');
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content[0]).toEqual({ type: 'imageUrl', imageUrl: { url: DATA_URL } });
      expect(body.messages[1].content[1].type).toBe('text');
      expect(JSON.stringify(body)).not.toContain('image_url');
    });

    it('uses request.model when provided and DEFAULT_UNDERSTANDING_MODEL otherwise', async () => {
      const calls = mockFetchSequence(chatOk(BOTH_JSON), chatOk(BOTH_JSON));

      await makeProvider().describeImage(makeUnderstandingRequest('both', { model: 'gpt-4o-mini' }));
      await makeProvider().describeImage(makeUnderstandingRequest('both', { model: undefined }));

      expect(JSON.parse(calls[0].init?.body as string).model).toBe('gpt-4o-mini');
      expect(JSON.parse(calls[1].init?.body as string).model)
        .toBe(CivitaiImageProvider.DEFAULT_UNDERSTANDING_MODEL);
    });

    it('passes temperature and maxNewTokens into the body', async () => {
      const calls = mockFetchSequence(chatOk(BOTH_JSON));

      await makeProvider().describeImage(makeUnderstandingRequest('both', { temperature: 0.8, maxNewTokens: 200 }));
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.temperature).toBe(0.8);
      expect(body.maxTokens).toBe(200);
    });

    it('appends allowMatureContent query（D6）', async () => {
      const calls = mockFetchSequence(chatOk(BOTH_JSON));

      await makeProvider().describeImage(makeUnderstandingRequest('both'), { allowMatureContent: true });
      expect(calls[0].url).toContain('allowMatureContent=true');
    });

    it('parses strict JSON into tags + caption + positiveDraft', async () => {
      mockFetchSequence(chatOk(BOTH_JSON));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('both'));
      expect(result.tags).toHaveLength(3);
      expect(result.tags![0]).toEqual({ text: '1girl' });
      expect(result.caption).toBe('A girl in a garden');
      expect(result.positiveDraft).toBe('1girl, red_circle, simple_background, A girl in a garden');
      expect(result.provider).toBe('civitai_vlm');
      expect(result.task).toBe('both');
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it('parses fenced ```json responses', async () => {
      mockFetchSequence(chatOk('```json\n' + BOTH_JSON + '\n```'));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('tags'));
      expect(result.tags).toHaveLength(3);
      expect(result.positiveDraft).toBe('1girl, red_circle, simple_background');
    });

    it('throws on 204/empty body（模型名无效不走 4xx）', async () => {
      mockFetchSequence({ status: 204, text: '' });

      await expect(makeProvider().describeImage(makeUnderstandingRequest('both')))
        .rejects.toThrow(/空响应.*204/);
    });

    it('anti-hallucination: throws when openai/ route reports text-only promptTokens（图片被静默丢弃）', async () => {
      mockFetchSequence(chatOk(BOTH_JSON, { promptTokens: 77 }, 'openai/gpt-4o-mini'));

      await expect(makeProvider().describeImage(makeUnderstandingRequest('both')))
        .rejects.toThrow(/未将图片送达模型/);
    });

    it('anti-hallucination assertion is scoped to openai/ routes — anthropic 小图 109 tokens 不误伤（真实校准）', async () => {
      mockFetchSequence(chatOk(BOTH_JSON, { promptTokens: 109 }, 'anthropic/claude-sonnet-5'));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('both'));
      expect(result.caption).toBe('A girl in a garden');
    });

    it('openai/ route with genuine image tokens passes the assertion', async () => {
      mockFetchSequence(chatOk(BOTH_JSON, { promptTokens: 8550 }, 'openai/gpt-4o-mini'));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('both'));
      expect(result.caption).toBe('A girl in a garden');
    });

    it('missing usage field skips the anti-hallucination assertion', async () => {
      mockFetchSequence(chatOk(BOTH_JSON, null, 'openai/gpt-4o-mini'));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('both'));
      expect(result.caption).toBe('A girl in a garden');
    });

    it('degrades non-JSON responses to caption', async () => {
      mockFetchSequence(chatOk('Just a plain description of the image.'));

      const result = await makeProvider().describeImage(makeUnderstandingRequest('caption'));
      expect(result.caption).toBe('Just a plain description of the image.');
      expect(result.positiveDraft).toBe('Just a plain description of the image.');
      expect(result.tags).toBeUndefined();
    });

    it('throws a dedicated error on refusal text（D6）', async () => {
      mockFetchSequence(chatOk("I can't assist with analyzing this image due to content policy."));

      await expect(makeProvider().describeImage(makeUnderstandingRequest('both')))
        .rejects.toThrow(/拒绝分析/);
    });

    it('maps 402 to Buzz error', async () => {
      mockFetchSequence({ status: 402, text: 'Insufficient Buzz' });

      await expect(makeProvider().describeImage(makeUnderstandingRequest('both')))
        .rejects.toThrow(/Buzz 余额不足/);
    });

    it('throws when reference has no dataUrl or url', async () => {
      const req = makeUnderstandingRequest('tags', {
        image: makeReference({ dataUrl: undefined, url: undefined }),
      });
      await expect(makeProvider().describeImage(req))
        .rejects.toThrow('提炼图片缺少 dataUrl 或 url');
    });
  });

  // ── testConnection() — existing tests preserved ──

  describe('testConnection()', () => {
    it('returns true on 200', async () => {
      mockFetchSequence({ status: 200, body: { items: [] } });
      const result = await makeProvider().testConnection();
      expect(result).toBe(true);
    });

    it('returns false on 401', async () => {
      mockFetchSequence({ status: 401, text: 'Unauthorized' });
      const result = await makeProvider().testConnection();
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
      const result = await makeProvider().testConnection();
      expect(result).toBe(false);
    });

    it('calls workflows endpoint with auth header', async () => {
      const calls = mockFetchSequence({ status: 200, body: { items: [] } });
      await makeProvider().testConnection();
      expect(calls[0].url).toContain('/v2/consumer/workflows?take=1');
      expect((calls[0].init?.headers as Record<string, string>)?.Authorization).toBe('Bearer test-key');
    });
  });
});
