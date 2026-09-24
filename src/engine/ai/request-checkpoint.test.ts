import { afterEach, expect, it, vi } from 'vitest';
import { AIService } from './ai-service';
import type { APIConfig } from './types';

const config: APIConfig = {id: 'test', name: 'test', apiCategory: 'llm', provider: 'openai',
  url: 'https://test.invalid', apiKey: 'secret', model: 'test', temperature: 0.7, maxTokens: 100, enabled: true};
afterEach(() => vi.unstubAllGlobals());
it('replays cached output to streaming consumers without a transport', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const ai = new AIService(); ai.setConfigs([{...config, forceStreaming: true, strictMessageFormat: true}]);
  const onStreamChunk = vi.fn();
  const run = vi.fn(async (request) => {
    expect(request.stream).toBe(true);
    expect(request.messages.at(-1).role).toBe('user');
    return 'cached story';
  });
  expect(await ai.generate({messages: [{role: 'assistant', content: 'prefix'}], checkpoint: {run}, onStreamChunk})).toBe('cached story');
  expect(onStreamChunk).toHaveBeenCalledExactlyOnceWith('cached story'); expect(fetch).not.toHaveBeenCalled();
});
it('does not retry or downgrade a checkpoint-owned streaming request', async () => {
  const fetch = vi.fn(async () => new Response('{}', {headers: {'content-type': 'application/json'}}));
  vi.stubGlobal('fetch', fetch);
  const ai = new AIService(); ai.setConfigs([config]);
  const run = vi.fn(async (_request, send: () => Promise<string>) => send());
  await expect(ai.generate({messages: [{role: 'user', content: 'test'}], stream: true, checkpoint: {run}})).rejects.toThrow('Stream unsupported');
  expect(fetch).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
});
