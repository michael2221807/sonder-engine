/**
 * AI API full logging — 设置 → 高级设置 → "AI API 完整记录（含 prompt/response）"
 * consumption in AIService.doGenerate (2026-08-26 dead-control fix).
 *
 * Contract under test:
 *   - flag ON  → `[AI-LOG] request` (final transformed messages, model, url)
 *                before the call and `[AI-LOG] response` (full text) after;
 *                a failed call logs `[AI-LOG] error` instead of a response.
 *   - flag OFF (or master `debugMode` off) → zero [AI-LOG] output.
 *   - the logged request payload must NEVER contain the apiKey.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AIService } from './ai-service';
import type { APIConfig } from './types';

const baseConfig: APIConfig = {
  id: 'default',
  name: 'test',
  apiCategory: 'llm',
  provider: 'openai',
  url: 'https://proxy.test',
  apiKey: 'sk-SECRET',
  model: 'gpt-4o',
  temperature: 0.7,
  maxTokens: 1000,
  enabled: true,
};

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFlags(settings: Record<string, unknown>): void {
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify(settings),
  });
}

function aiLogCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('[AI-LOG]'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AIService — aiLogging flag', () => {
  it('flag on: logs request (final messages, no apiKey) and full response text', async () => {
    stubFlags({ debugMode: true, aiLogging: true });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('世界回响')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = new AIService();
    svc.setConfigs([baseConfig]);
    const out = await svc.generate({
      messages: [{ role: 'user', content: '你好' }],
      usageType: 'memory_summary',
    });
    expect(out).toBe('世界回响');

    const calls = aiLogCalls(logSpy);
    expect(calls).toHaveLength(2);

    const [reqTag, reqPayload] = calls[0] as [string, Record<string, unknown>];
    expect(reqTag).toBe('[AI-LOG] request');
    expect(reqPayload.usageType).toBe('memory_summary');
    expect(reqPayload.model).toBe('gpt-4o');
    expect(reqPayload.messages).toEqual([{ role: 'user', content: '你好' }]);
    // Never leak credentials into the console record.
    expect(JSON.stringify(reqPayload)).not.toContain('sk-SECRET');

    const [resTag, resPayload] = calls[1] as [string, Record<string, unknown>];
    expect(resTag).toBe('[AI-LOG] response');
    expect(resPayload.text).toBe('世界回响');
    expect(resPayload.length).toBe(4);
  });

  it('flag on + provider failure: logs request then error (no response entry)', async () => {
    stubFlags({ debugMode: true, aiLogging: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = new AIService();
    svc.maxRetries = 0;
    svc.setConfigs([baseConfig]);
    await expect(
      svc.generate({ messages: [{ role: 'user', content: 'x' }], usageType: 'memory_summary' }),
    ).rejects.toThrow();

    const tags = aiLogCalls(logSpy).map((c) => c[0]);
    expect(tags).toEqual(['[AI-LOG] request', '[AI-LOG] error']);
  });

  it('flag off: zero [AI-LOG] output', async () => {
    stubFlags({ debugMode: true, aiLogging: false });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('ok')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = new AIService();
    svc.setConfigs([baseConfig]);
    await svc.generate({ messages: [{ role: 'user', content: 'x' }], usageType: 'memory_summary' });

    expect(aiLogCalls(logSpy)).toHaveLength(0);
  });

  it('master debugMode off gates a persisted aiLogging=true', async () => {
    stubFlags({ debugMode: false, aiLogging: true });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('ok')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = new AIService();
    svc.setConfigs([baseConfig]);
    await svc.generate({ messages: [{ role: 'user', content: 'x' }], usageType: 'memory_summary' });

    expect(aiLogCalls(logSpy)).toHaveLength(0);
  });
});
