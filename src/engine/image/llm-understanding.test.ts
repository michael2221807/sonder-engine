import { describe, it, expect, vi } from 'vitest';
import { describeImageWithGeneralLlm, getGeneralLlmInfo } from './llm-understanding';
import type { AIService } from '../ai/ai-service';
import type { ImageUnderstandingRequest } from './reference-types';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function makeAiService(overrides?: {
  config?: Record<string, unknown> | undefined;
  response?: string;
}): { service: AIService; generateMock: ReturnType<typeof vi.fn> } {
  const generateMock = vi.fn(async () => overrides?.response ?? '{"tags":["1girl"],"caption":"A girl."}');
  const service = {
    getConfigForUsage: vi.fn(() => (
      'config' in (overrides ?? {})
        ? overrides!.config
        : { id: 'default', name: '主对话', provider: 'custom', model: 'claude-opus-4-8' }
    )),
    generate: generateMock,
  } as unknown as AIService;
  return { service, generateMock };
}

function makeRequest(overrides?: Partial<ImageUnderstandingRequest>): ImageUnderstandingRequest {
  return {
    engine: 'general_llm',
    image: { id: 'r1', role: 'source', source: 'data_url', dataUrl: DATA_URL },
    task: 'both',
    ...overrides,
  };
}

describe('getGeneralLlmInfo（D3B「必须标明」数据源）', () => {
  it('reports available with provider/model for openai-compatible main config', () => {
    const { service } = makeAiService();
    expect(getGeneralLlmInfo(service)).toEqual({
      available: true, configName: '主对话', provider: 'custom', model: 'claude-opus-4-8', reason: undefined,
    });
  });

  it('reports not_configured when main has no config', () => {
    const { service } = makeAiService({ config: undefined });
    expect(getGeneralLlmInfo(service).available).toBe(false);
    expect(getGeneralLlmInfo(service).reason).toBe('not_configured');
  });

  it('reports provider_unsupported for claude/gemini direct providers（D7）', () => {
    const { service } = makeAiService({ config: { id: 'c', name: 'c', provider: 'claude', model: 'm' } });
    const info = getGeneralLlmInfo(service);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('provider_unsupported');
  });
});

describe('describeImageWithGeneralLlm', () => {
  it('sends multimodal messages via usageType main and parses the result', async () => {
    const { service, generateMock } = makeAiService();
    const result = await describeImageWithGeneralLlm(service, makeRequest());

    const call = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.usageType).toBe('main');
    expect(call.stream).toBe(false);
    const messages = call.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toEqual([
      { type: 'image', dataUrl: DATA_URL },
      { type: 'text', text: expect.stringContaining('"tags"') },
    ]);

    expect(result.provider).toBe('general_llm');
    expect(result.tags).toEqual([{ text: '1girl' }]);
    expect(result.caption).toBe('A girl.');
    expect(result.positiveDraft).toBe('1girl, A girl.');
  });

  it('passes temperature/maxNewTokens overrides through', async () => {
    const { service, generateMock } = makeAiService();
    await describeImageWithGeneralLlm(service, makeRequest({ temperature: 0.7, maxNewTokens: 450 }));
    const call = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.7);
    expect(call.maxTokens).toBe(450);
  });

  it('throws with guidance when main is not configured', async () => {
    const { service } = makeAiService({ config: undefined });
    await expect(describeImageWithGeneralLlm(service, makeRequest()))
      .rejects.toThrow(/未配置主对话 LLM/);
  });

  it('throws with guidance for unsupported providers（D7）', async () => {
    const { service } = makeAiService({ config: { id: 'g', name: 'g', provider: 'gemini', model: 'm' } });
    await expect(describeImageWithGeneralLlm(service, makeRequest()))
      .rejects.toThrow(/暂不支持图片输入/);
  });

  it('throws when image is not a data URL', async () => {
    const { service } = makeAiService();
    await expect(describeImageWithGeneralLlm(service, makeRequest({
      image: { id: 'r2', role: 'source', source: 'url', url: 'https://x.test/a.png' },
    }))).rejects.toThrow(/data URL/);
  });

  it('throws a dedicated error on refusal（D6）', async () => {
    const { service } = makeAiService({ response: '抱歉，我无法分析这张图片。' });
    await expect(describeImageWithGeneralLlm(service, makeRequest()))
      .rejects.toThrow(/拒绝分析/);
  });

  it('degrades plain-text answers to caption instead of failing', async () => {
    const { service } = makeAiService({ response: 'A watercolor illustration of a red sun.' });
    const result = await describeImageWithGeneralLlm(service, makeRequest());
    expect(result.caption).toBe('A watercolor illustration of a red sun.');
    expect(result.tags).toBeUndefined();
  });

  it('throws on empty model response', async () => {
    const { service } = makeAiService({ response: '   ' });
    await expect(describeImageWithGeneralLlm(service, makeRequest()))
      .rejects.toThrow(/空响应/);
  });
});
