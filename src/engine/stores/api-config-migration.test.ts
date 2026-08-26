import { describe, it, expect } from 'vitest';
import { normalizeApiManagementState } from './api-config-migration';
import type { APIConfig } from '../ai/types';

function cfg(partial: Partial<APIConfig>): APIConfig {
  return {
    id: partial.id ?? 'api_test',
    name: 'test',
    provider: 'openai',
    url: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 1000,
    enabled: true,
    ...partial,
  };
}

describe('normalizeApiManagementState (epic P0 backend backfill)', () => {
  // Group 1: old-format rows get backend backfilled
  it('backfills image backends from URL, unknown URLs become "custom"', () => {
    const { configs, changed } = normalizeApiManagementState([
      cfg({ id: 'a', apiCategory: 'image', url: 'https://orchestration.civitai.com' }),
      cfg({ id: 'b', apiCategory: 'image', url: 'https://image.novelai.net' }),
      cfg({ id: 'c', apiCategory: 'image', url: 'http://localhost:7860' }),
      cfg({ id: 'd', apiCategory: 'image', url: 'https://my-own-proxy.example.com' }),
    ]);
    expect(changed).toBe(true);
    expect(configs.map((c) => c.backend)).toEqual(['civitai', 'novelai', 'sd_webui', 'custom']);
  });

  it('backfills tts/stt rows with cosyvoice (the only pre-P0 voice backend)', () => {
    const { configs } = normalizeApiManagementState([
      cfg({ apiCategory: 'tts', url: 'http://localhost:9880' }),
      cfg({ apiCategory: 'stt', url: 'http://localhost:9880' }),
    ]);
    expect(configs.map((c) => c.backend)).toEqual(['cosyvoice', 'cosyvoice']);
  });

  // Group 2: new-format rows pass through untouched (idempotency)
  it('is idempotent — already-normalized rows are returned as-is with changed=false', () => {
    const rows = [
      cfg({ apiCategory: 'image', url: 'https://orchestration.civitai.com', backend: 'civitai' }),
      cfg({ apiCategory: 'tts', backend: 'cosyvoice' }),
    ];
    const first = normalizeApiManagementState(rows);
    expect(first.changed).toBe(false);
    expect(first.configs[0]).toBe(rows[0]);
    const second = normalizeApiManagementState(first.configs);
    expect(second.changed).toBe(false);
    expect(second.configs).toEqual(rows);
  });

  // Group 3: mixed old/new + non-target categories
  it('leaves llm/embedding/rerank rows alone in a mixed batch', () => {
    const { configs, changed } = normalizeApiManagementState([
      cfg({ id: 'llm1', url: 'https://api.openai.com' }),                       // no apiCategory → llm
      cfg({ id: 'emb1', apiCategory: 'embedding', url: 'https://api.x.test' }),
      cfg({ id: 'img1', apiCategory: 'image', url: 'http://localhost:8188' }),  // old-format image
    ]);
    expect(changed).toBe(true);
    expect(configs[0].backend).toBeUndefined();
    expect(configs[1].backend).toBeUndefined();
    expect(configs[2].backend).toBe('comfyui');
  });

  // Group 4: corrupted data must not throw
  it('survives corrupted rows (null entries, missing url)', () => {
    const corrupted = [
      null as unknown as APIConfig,
      cfg({ apiCategory: 'image', url: undefined as unknown as string }),
      'garbage' as unknown as APIConfig,
    ];
    const { configs } = normalizeApiManagementState(corrupted);
    expect(configs[0]).toBeNull();
    expect((configs[1] as APIConfig).backend).toBe('custom');
    expect(configs[2]).toBe('garbage' as unknown as APIConfig);
  });
});
