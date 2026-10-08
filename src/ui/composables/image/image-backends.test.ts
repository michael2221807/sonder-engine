import { describe, expect, it, vi } from 'vitest';
import type { APIAssignment, APIConfig } from '@/engine/ai/types';
import type { ImageService } from '@/engine/image/image-service';
import {
  copyAssetToReferenceLibrary,
  extractLoraSnapshot,
  listConfiguredImageBackends,
} from './image-backends';

// Partial fixtures: only the fields the helpers read.
function cfg(partial: Partial<APIConfig> & { id: string }): APIConfig {
  return { enabled: true, apiCategory: 'image', ...partial } as unknown as APIConfig;
}
function assign(type: string, apiId: string): APIAssignment {
  return { type, apiId } as unknown as APIAssignment;
}

const KEYS = ['novelai', 'openai', 'civitai'];

describe('listConfiguredImageBackends', () => {
  it('lists backends with an enabled image config assigned, in key order', () => {
    const set = listConfiguredImageBackends(
      [cfg({ id: 'a' }), cfg({ id: 'b' })],
      [assign('imageGen_civitai', 'b'), assign('imageGen_novelai', 'a')],
      KEYS,
    );
    expect([...set]).toEqual(['novelai', 'civitai']);
  });

  it('skips default assignments, disabled configs, non-image configs and missing configs', () => {
    const set = listConfiguredImageBackends(
      [cfg({ id: 'off', enabled: false }), cfg({ id: 'llm', apiCategory: 'llm' }), cfg({ id: 'nocat', apiCategory: undefined })],
      [assign('imageGen_novelai', 'default'), assign('imageGen_openai', 'off'), assign('imageGen_civitai', 'llm'), assign('imageGen_x', 'nocat')],
      [...KEYS, 'x'],
    );
    expect(set.size).toBe(0);
  });

  it('falls back to the legacy imageGeneration assignment via the config backend field', () => {
    const set = listConfiguredImageBackends(
      [cfg({ id: 'legacy', backend: 'openai' })],
      [assign('imageGeneration', 'legacy')],
      KEYS,
    );
    expect([...set]).toEqual(['openai']);
  });

  it('ignores a legacy backend that is not a known key, and a legacy default assignment', () => {
    expect(listConfiguredImageBackends([cfg({ id: 'l', backend: 'custom' })], [assign('imageGeneration', 'l')], KEYS).size).toBe(0);
    expect(listConfiguredImageBackends([cfg({ id: 'l', backend: 'openai' })], [assign('imageGeneration', 'default')], KEYS).size).toBe(0);
  });

  it('does not use the legacy fallback when a per-backend assignment exists', () => {
    const set = listConfiguredImageBackends(
      [cfg({ id: 'a' }), cfg({ id: 'l', backend: 'openai' })],
      [assign('imageGen_novelai', 'a'), assign('imageGeneration', 'l')],
      KEYS,
    );
    expect([...set]).toEqual(['novelai']);
  });
});

describe('extractLoraSnapshot', () => {
  it('returns the civitai snapshot only when loras is an array', () => {
    const snap = { loras: [], additionalNetworks: {} };
    expect(extractLoraSnapshot({ providerMeta: { civitai: snap } })).toBe(snap);
    expect(extractLoraSnapshot({ providerMeta: { civitai: { loras: 'x' } } })).toBeUndefined();
    expect(extractLoraSnapshot({ providerMeta: {} })).toBeUndefined();
    expect(extractLoraSnapshot({ providerMeta: null })).toBeUndefined();
    expect(extractLoraSnapshot({})).toBeUndefined();
  });
});

describe('copyAssetToReferenceLibrary', () => {
  function fakeService(retrieved: unknown) {
    const store = vi.fn().mockResolvedValue(undefined);
    const addReferenceEntry = vi.fn();
    const service = {
      getAssetCache: () => ({ retrieve: vi.fn().mockResolvedValue(retrieved), store }),
      state: { addReferenceEntry },
    } as unknown as ImageService;
    return { service, store, addReferenceEntry };
  }

  it('returns missing and writes nothing when the asset is not cached', async () => {
    const { service, store, addReferenceEntry } = fakeService(undefined);
    expect(await copyAssetToReferenceLibrary(service, 'a1', { name: 'n', source: 'player' })).toBe('missing');
    expect(store).not.toHaveBeenCalled();
    expect(addReferenceEntry).not.toHaveBeenCalled();
  });

  it('stores a reference-origin copy and registers the library entry', async () => {
    const blob = new Blob(['x']);
    const { service, store, addReferenceEntry } = fakeService({
      blob,
      metadata: { mimeType: 'image/png', width: 10, height: 20, sizeBytes: 1, backend: 'novelai' },
    });
    expect(await copyAssetToReferenceLibrary(service, 'a1', { name: 'ref_a1', source: 'gallery' })).toBe('ok');
    const [asset, storedBlob] = store.mock.calls[0];
    expect(storedBlob).toBe(blob);
    expect(asset).toMatchObject({ taskId: '', origin: 'reference', mimeType: 'image/png', width: 10, height: 20, backend: 'novelai' });
    expect(asset.id).toMatch(/^ref_copy_\d+_[a-z0-9]+$/);
    expect(asset.storageKey).toBe(asset.id);
    expect(addReferenceEntry).toHaveBeenCalledWith(expect.objectContaining({
      assetId: asset.id, name: 'ref_a1', source: 'gallery', width: 10, height: 20, sizeBytes: 1,
    }));
  });

  it('propagates storage failures to the caller', async () => {
    const { service, store } = fakeService({ blob: new Blob(['x']), metadata: { mimeType: 'image/png', width: 1, height: 1, sizeBytes: 1, backend: 'novelai' } });
    store.mockRejectedValueOnce(new Error('quota'));
    await expect(copyAssetToReferenceLibrary(service, 'a1', { name: 'n', source: 'player' })).rejects.toThrow('quota');
  });
});
