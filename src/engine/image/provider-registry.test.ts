import { describe, it, expect } from 'vitest';
import { ImageProviderRegistry } from '@/engine/image/provider-registry';
import { NovelAIImageProvider } from '@/engine/image/providers/novelai';

describe('ImageProviderRegistry', () => {
  it('registers and resolves a provider', () => {
    const reg = new ImageProviderRegistry();
    reg.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));

    const provider = reg.resolve({
      backend: 'novelai',
      endpoint: 'https://image.novelai.net',
      apiKey: 'test-key',
    });

    expect(provider.backend).toBe('novelai');
  });

  it('throws for unregistered backend', () => {
    const reg = new ImageProviderRegistry();

    expect(() => reg.resolve({
      backend: 'comfyui',
      endpoint: 'http://localhost:8188',
      apiKey: '',
    })).toThrow(/No provider registered for backend "comfyui"/);
  });

  it('has() returns correct state', () => {
    const reg = new ImageProviderRegistry();
    expect(reg.has('novelai')).toBe(false);

    reg.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));
    expect(reg.has('novelai')).toBe(true);
    expect(reg.has('openai')).toBe(false);
  });

  it('registeredBackends lists all', () => {
    const reg = new ImageProviderRegistry();
    reg.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));
    reg.register('openai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));

    expect(reg.registeredBackends.sort()).toEqual(['novelai', 'openai']);
  });

  it('real providers have correct backend property', () => {
    const reg = new ImageProviderRegistry();
    reg.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));

    const provider = reg.resolve({
      backend: 'novelai',
      endpoint: 'https://image.novelai.net',
      apiKey: 'test',
    });

    expect(provider.backend).toBe('novelai');
  });
});
