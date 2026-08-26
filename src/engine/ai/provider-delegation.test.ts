import { describe, it, expect, vi, afterEach } from 'vitest';
import { AIService } from './ai-service';
import { OpenAIProvider } from './providers/openai-provider';
import { resolveLlmChatPath, resolveLlmModelsPath } from '../providers/llm-paths';
import type { APIConfig } from './types';

function cfg(partial: Partial<APIConfig>): APIConfig {
  return {
    id: partial.id ?? 'api_x',
    name: partial.name ?? 'x',
    provider: 'openai',
    url: 'https://example.test',
    apiKey: 'k',
    model: 'm',
    temperature: 0.7,
    maxTokens: 1000,
    enabled: true,
    ...partial,
  };
}

describe('per-backend assignment switching (product multi-config switcher — PO 2026-08-26)', () => {
  it('two configs of the SAME backend: the assignment row decides which one serves', () => {
    // The core of the product model: a user keeps e.g. two Civitai configs
    // (same URL/key, different models) and switches between them via the
    // assignment table. This must survive every P0 refactor.
    const service = new AIService();
    const a = cfg({ id: 'civitai_a', apiCategory: 'image', backend: 'civitai', model: 'model-A' });
    const b = cfg({ id: 'civitai_b', apiCategory: 'image', backend: 'civitai', model: 'model-B' });
    service.setConfigs([a, b]);

    service.setAssignments([{ type: 'imageGen_civitai', apiId: 'civitai_a' }]);
    expect(service.getImageConfigForBackend('civitai')?.model).toBe('model-A');

    service.setAssignments([{ type: 'imageGen_civitai', apiId: 'civitai_b' }]);
    expect(service.getImageConfigForBackend('civitai')?.model).toBe('model-B');
  });

  it('assignment pointing at a disabled config: per-backend fallback refuses cross-backend borrow; only the legacy imageGeneration path may serve category-wide', () => {
    const service = new AIService();
    const a = cfg({ id: 'a', apiCategory: 'image', backend: 'civitai', model: 'model-A', enabled: false });
    const b = cfg({ id: 'b', apiCategory: 'image', backend: 'novelai', model: 'model-B' });
    service.setConfigs([a, b]);
    service.setAssignments([{ type: 'imageGen_civitai', apiId: 'a' }]);
    // 2026-08-26 review: the per-backend usage no longer borrows the novelai
    // config; getImageConfigForBackend still finds `b` — but ONLY through the
    // documented legacy 'imageGeneration' category-wide fallback row.
    expect(service.getConfigForUsage('imageGen_civitai')).toBeUndefined();
    expect(service.getImageConfigForBackend('civitai')?.id).toBe('b');
  });

  it('seed guard (review Critical repro A): untouched default assignments never hand the LLM seed config to voice rows', () => {
    const service = new AIService();
    service.setConfigs([cfg({ id: 'default', model: 'gpt-4o' })]); // enabled LLM seed
    // engine-api initializes EVERY row to apiId 'default'
    service.setAssignments([
      { type: 'ttsGen_doubao', apiId: 'default' },
      { type: 'sttGen_doubao', apiId: 'default' },
      { type: 'embedding', apiId: 'default' },
    ]);
    expect(service.getTtsConfigForBackend('doubao')).toBeUndefined();
    expect(service.getSttConfigForBackend('doubao')).toBeUndefined();
    expect(service.getConfigForUsage('embedding')).toBeUndefined();
    // llm usages keep honoring the seed assignment
    expect(service.getConfigForUsage('main')?.id).toBe('default');
  });

  it('backend-match fallback (review Critical repro B): doubao row never borrows the CosyVoice config', () => {
    const service = new AIService();
    service.setConfigs([
      cfg({ id: 'default', enabled: false }),
      cfg({ id: 'tts1', apiCategory: 'tts', backend: 'cosyvoice', url: 'http://localhost:9880' }),
    ]);
    service.setAssignments([{ type: 'ttsGen_doubao', apiId: 'default' }]);
    expect(service.getTtsConfigForBackend('doubao')).toBeUndefined();
    // …while the cosyvoice row finds its own config via the same fallback
    expect(service.getTtsConfigForBackend('cosyvoice')?.id).toBe('tts1');
  });

  it('explicit non-default assignment is honored verbatim (CR-R11 escape hatch preserved)', () => {
    const service = new AIService();
    const forced = cfg({ id: 'my_gateway', apiCategory: 'llm', model: 'weird' });
    service.setConfigs([forced]);
    service.setAssignments([{ type: 'ttsGen_doubao', apiId: 'my_gateway' }]);
    // The user deliberately force-assigned a category-mismatched config via
    // "show all APIs" — the engine must not second-guess it.
    expect(service.getTtsConfigForBackend('doubao')?.id).toBe('my_gateway');
  });

  it('tts/stt per-backend routing matches only their own category', () => {
    const service = new AIService();
    service.setConfigs([
      cfg({ id: 'llm1' }),
      cfg({ id: 'tts1', apiCategory: 'tts', backend: 'cosyvoice' }),
      cfg({ id: 'stt1', apiCategory: 'stt', backend: 'cosyvoice' }),
    ]);
    service.setAssignments([
      { type: 'ttsGen_cosyvoice', apiId: 'tts1' },
      { type: 'sttGen_cosyvoice', apiId: 'stt1' },
    ]);
    expect(service.getTtsConfigForBackend('cosyvoice')?.id).toBe('tts1');
    expect(service.getSttConfigForBackend('cosyvoice')?.id).toBe('stt1');
  });
});

describe('testConnection delegation (epic P0 §3.4)', () => {
  it('image/tts/stt categories route to the registered tester with the full config', async () => {
    const service = new AIService();
    const tester = vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 });
    service.registerConnectionTester('image', tester);

    const result = await service.testConnection({
      url: 'https://img.test', apiKey: 'k', model: 'm',
      apiCategory: 'image', backend: 'civitai',
      credentials: { extra: 'v' },
    });
    expect(result).toEqual({ ok: true, latencyMs: 42 });
    expect(tester).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://img.test', backend: 'civitai', credentials: { extra: 'v' },
    }));
  });

  it('a delegated category without a registered tester fails loudly, not silently', async () => {
    const service = new AIService();
    const result = await service.testConnection({
      url: 'https://x.test', apiKey: 'k', model: 'm', apiCategory: 'tts', backend: 'cosyvoice',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tts');
  });
});

describe('llm endpoint path resolution (epic P4 / D4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolveLlmChatPath: default → preset → custom override, with slash normalization', () => {
    expect(resolveLlmChatPath()).toBe('/v1/chat/completions');
    expect(resolveLlmChatPath('volcano_ark')).toBe('/api/v3/chat/completions');
    expect(resolveLlmChatPath('volcano_ark', '/my/path')).toBe('/my/path');
    expect(resolveLlmChatPath(undefined, 'no-slash')).toBe('/no-slash');
    expect(resolveLlmChatPath('not-in-catalog')).toBe('/v1/chat/completions');
  });

  it('resolveLlmModelsPath: null for presets that declare no listing endpoint', () => {
    expect(resolveLlmModelsPath('openai')).toBe('/v1/models');
    expect(resolveLlmModelsPath('volcano_ark')).toBeNull();
    expect(resolveLlmModelsPath()).toBe('/v1/models');
  });

  it('OpenAIProvider actually hits the Ark preset chat path for backend volcano_ark', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const provider = new OpenAIProvider(cfg({
      provider: 'custom', backend: 'volcano_ark',
      url: 'https://ark.cn-beijing.volces.com', model: 'doubao-seed-1-6-250615',
    }));
    const text = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(text).toBe('ok');
    expect(calls[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  });

  it('OpenAIProvider keeps the /v1 default for plain configs (no backend)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const provider = new OpenAIProvider(cfg({ url: 'https://api.openai.com', model: 'gpt-4o' }));
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(calls[0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
