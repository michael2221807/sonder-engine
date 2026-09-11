import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubSyncService, DegradedUploadError, SyncInProgressError, type SyncStatus } from './github-sync';
import { pack } from './chunked-bundle-packer';
import type { ChunkManifest } from './chunked-bundle-packer';

// ─── Mock infrastructure ───

function createMockBackup(
  jsonOverride?: string,
  integrity: { referencedAssets: number; exportedAssets: number } = { referencedAssets: 2, exportedAssets: 2 },
) {
  const json = jsonOverride ?? JSON.stringify({
    version: 1,
    exportedAt: '2026-05-09T12:00:00Z',
    engineVersion: '0.1.0',
    bundleType: 'full',
    activeProfile: { profileId: 'p1', slotId: 's1' },
    profiles: { p1: { name: '测试角色' } },
    saves: { 'p1/s1': { 角色: { 姓名: '李明' } } },
    vectors: {},
    configs: {},
    prompts: {},
    engineSettings: { aga_theme: 'dark' },
    imageAssets: [
      { id: 'img1', metadata: { id: 'img1', backend: 'novelai', createdAt: 1 }, base64: 'A'.repeat(500), mimeType: 'image/png' },
      { id: 'img2', metadata: { id: 'img2', backend: 'civitai', createdAt: 2 }, base64: 'B'.repeat(500), mimeType: 'image/webp' },
    ],
  }, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  return {
    exportAll: vi.fn().mockResolvedValue(blob),
    exportForSync: vi.fn().mockResolvedValue({ blob, imageIntegrity: integrity }),
    importAll: vi.fn().mockResolvedValue(undefined),
  };
}

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, val: string) => storage.set(key, val),
  removeItem: (key: string) => storage.delete(key),
});

type FetchCall = { url: string; method: string; body?: unknown };
let fetchCalls: FetchCall[];
let fetchResponses: Map<string, { status: number; body: unknown }>;

function mockFetch() {
  fetchCalls = [];
  fetchResponses = new Map();

  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url, method, body });

    const key = `${method} ${url}`;

    // Check exact match first, then prefix match for dynamic paths
    let resp = fetchResponses.get(key);
    if (!resp) {
      for (const [pattern, r] of fetchResponses) {
        if (key.startsWith(pattern) || key.includes(pattern.replace('GET ', '').replace('PUT ', '').replace('DELETE ', ''))) {
          resp = r;
          break;
        }
      }
    }

    if (!resp) {
      // Default: 404 for GET, 201 for PUT/POST/DELETE
      if (method === 'GET') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ content: {} }), { status: 201 });
    }

    return new Response(JSON.stringify(resp.body), { status: resp.status });
  };

  vi.stubGlobal('fetch', vi.fn(impl));
}

function setupDefaultResponses() {
  // All GETs to contents/ for SHA lookup → 404 (file doesn't exist yet)
  // PUT responses → 201 success
  // Default is already handled by mockFetch's default behavior
}

function setupV2DirectoryListing(files: Array<{ path: string; sha: string }>) {
  fetchResponses.set(
    `GET https://api.github.com/repos/testuser/aga-cloud-save/contents/v2`,
    { status: 200, body: files },
  );
}

// ─── Setup ───

beforeEach(() => {
  storage.clear();
  storage.set('aga_github_sync_token', 'ghp_test123');
  storage.set('aga_github_sync_owner', 'testuser');
  storage.set('aga_github_sync_repo', 'aga-cloud-save');
  vi.restoreAllMocks();
  mockFetch();
  setupDefaultResponses();
});

// ─── upload: basic flow ───

describe('upload — v2 chunked pipeline', () => {
  it('calls exportAll, packs, and uploads chunks + manifest', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    expect(backup.exportForSync).toHaveBeenCalledOnce();

    // Should have PUT calls for state.gz, img-0.gz, manifest.json
    const puts = fetchCalls.filter(c => c.method === 'PUT');
    const putPaths = puts.map(c => c.url);

    // Chunks are written to per-upload generation-suffixed paths (atomicity fix),
    // e.g. v2/state.<tag>.gz — never the bare v2/state.gz a prior upload used.
    expect(putPaths.some(p => /\/v2\/state\.[a-z0-9]+\.gz$/.test(p))).toBe(true);
    expect(putPaths.some(p => /\/v2\/img-0\.[a-z0-9]+\.gz$/.test(p))).toBe(true);
    expect(putPaths.some(p => p.includes('v2/manifest.json'))).toBe(true);
  });

  it('uploads manifest LAST (after all chunks)', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const puts = fetchCalls.filter(c => c.method === 'PUT');
    const manifestIdx = puts.findIndex(c => c.url.includes('manifest.json'));
    const lastChunkIdx = puts.findIndex(c => c.url.includes('.gz') && !c.url.includes('manifest'));

    expect(manifestIdx).toBeGreaterThan(lastChunkIdx);
  });

  it('writes chunks to fresh generation paths without a SHA, never overwriting existing chunk paths (atomicity)', async () => {
    setupV2DirectoryListing([
      { path: 'v2/manifest.json', sha: 'sha_manifest_old' },
      { path: 'v2/state.gz', sha: 'existing_sha_123' },
      { path: 'v2/img-0.gz', sha: 'sha_img0_old' },
    ]);
    // 2026-07-23 fix: the manifest PUT's sha precondition is now FETCHED FRESH via a
    // single-file GET right before the PUT (directory listings can serve stale shas
    // after a recent commit → spurious 409 on back-to-back uploads). Stub that GET.
    fetchResponses.set(
      'GET https://api.github.com/repos/testuser/aga-cloud-save/contents/v2/manifest.json',
      { status: 200, body: { sha: 'sha_manifest_old' } },
    );

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    // The new state chunk goes to a FRESH generation path with NO sha (create, not
    // in-place overwrite) — so an interrupted upload cannot clobber the live
    // v2/state.gz the current manifest still references.
    const statePut = fetchCalls.find(c => c.method === 'PUT' && /\/v2\/state\.[a-z0-9]+\.gz$/.test(c.url));
    expect(statePut).toBeDefined();
    expect(statePut!.url).not.toContain('/v2/state.gz');
    expect((statePut!.body as Record<string, string>).sha).toBeUndefined();

    // The manifest pointer is the ONLY in-place write, carrying the old sha.
    const manifestPut = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('manifest.json'));
    expect((manifestPut!.body as Record<string, string>).sha).toBe('sha_manifest_old');
  });

  it('omits SHA when file is new (first upload, v2/ empty)', async () => {
    // Default mock: v2/ returns 404 → listV2Files returns [] → no SHAs
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const statePut = fetchCalls.find(c => c.method === 'PUT' && /\/v2\/state\.[a-z0-9]+\.gz$/.test(c.url));
    expect(statePut).toBeDefined();
    expect((statePut!.body as Record<string, string>).sha).toBeUndefined();
  });

  it('PUT body contains base64 content and commit message', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const puts = fetchCalls.filter(c => c.method === 'PUT');
    for (const put of puts) {
      const body = put.body as Record<string, string>;
      expect(body.content).toBeTruthy();
      expect(body.message).toMatch(/^sync \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
  });
});

// ─── upload: progress callbacks ───

describe('upload — progress callbacks', () => {
  it('emits uploading stages in order', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const statuses: SyncStatus[] = [];

    await sync.upload((s) => statuses.push({ ...s }));

    const messages = statuses.map(s => s.message);

    expect(statuses[0]).toEqual({ stage: 'uploading', message: '正在导出存档…' });
    expect(messages.some(m => m === '正在压缩并上传…')).toBe(true);
    expect(messages.some(m => m.includes('正在压缩并上传分块'))).toBe(true);
    expect(messages.some(m => m === '正在更新索引…')).toBe(true);
    expect(statuses[statuses.length - 1]).toEqual({ stage: 'done', message: '上传完成' });
  });

  it('chunk progress shows a running per-chunk count', async () => {
    // Streaming upload compresses + PUTs one chunk at a time, so the total chunk
    // count is not known up front — progress is a running "分块 N" counter.
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const statuses: SyncStatus[] = [];

    await sync.upload((s) => statuses.push({ ...s }));

    const chunkMsgs = statuses
      .map(s => s.message)
      .filter(m => m.includes('正在压缩并上传分块'));

    expect(chunkMsgs.length).toBeGreaterThanOrEqual(2); // state + img
    expect(chunkMsgs[0]).toMatch(/正在压缩并上传分块 1…/);
    expect(chunkMsgs[1]).toMatch(/正在压缩并上传分块 2…/);
  });
});

// ─── upload: no images bundle ───

describe('upload — bundle without images', () => {
  it('uploads only state.gz + manifest.json (no img chunks)', async () => {
    const json = JSON.stringify({
      version: 1, exportedAt: '2026-05-09', engineVersion: '0.1.0',
      profiles: {}, saves: {}, vectors: {}, configs: {}, prompts: {},
      engineSettings: {},
    }, null, 2);

    const backup = createMockBackup(json);
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const puts = fetchCalls.filter(c => c.method === 'PUT');
    const putPaths = puts.map(c => c.url);

    expect(putPaths.some(p => /\/v2\/state\.[a-z0-9]+\.gz$/.test(p))).toBe(true);
    expect(putPaths.some(p => p.includes('v2/manifest.json'))).toBe(true);
    expect(putPaths.some(p => p.includes('v2/img-'))).toBe(false);
  });
});

// ─── upload: stale chunk cleanup ───

describe('upload — stale chunk cleanup', () => {
  it('deletes ALL previous-generation chunks after committing the new manifest', async () => {
    // v2/ holds the previous upload's chunks. Under generation-suffixed paths, the
    // new upload writes fresh paths, so EVERY previous chunk path is now stale and
    // is pruned — while the manifest pointer is preserved (updated in place).
    setupV2DirectoryListing([
      { path: 'v2/manifest.json', sha: 'sha_manifest' },
      { path: 'v2/state.gz', sha: 'sha_state' },
      { path: 'v2/img-0.gz', sha: 'sha_img0' },
      { path: 'v2/img-1.gz', sha: 'sha_img1' },
      { path: 'v2/img-2.gz', sha: 'sha_img2' },
    ]);

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const deletePaths = fetchCalls.filter(c => c.method === 'DELETE').map(c => c.url);

    // Every previous-generation chunk is stale → deleted.
    expect(deletePaths.some(p => p.includes('v2/state.gz'))).toBe(true);
    expect(deletePaths.some(p => p.includes('v2/img-0.gz'))).toBe(true);
    expect(deletePaths.some(p => p.includes('v2/img-1.gz'))).toBe(true);
    expect(deletePaths.some(p => p.includes('v2/img-2.gz'))).toBe(true);
    // The manifest pointer is NOT deleted (it is the in-place commit point).
    expect(deletePaths.some(p => p.includes('manifest.json'))).toBe(false);
  });

  it('handles empty v2 directory (first upload)', async () => {
    // v2/ doesn't exist → listV2Files returns [] → no deletes
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const deletes = fetchCalls.filter(c => c.method === 'DELETE');
    expect(deletes).toHaveLength(0);
  });

  it('handles v2 directory listing failure gracefully', async () => {
    fetchResponses.set(
      'GET https://api.github.com/repos/testuser/aga-cloud-save/contents/v2',
      { status: 500, body: { message: 'Internal Server Error' } },
    );

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    // Should throw because listV2Files throws on non-404 errors
    await expect(sync.upload()).rejects.toThrow();
  });

  it('a cleanup DELETE 409 does NOT fail an already-committed upload (best-effort)', async () => {
    // Regression guard for the 2026-07-13 "409 storm": cleanup is now awaited inside
    // the lock, but a stale-sha 409 on an orphan DELETE must never fail the upload —
    // the manifest already committed; a leftover orphan is harmless.
    setupV2DirectoryListing([
      { path: 'v2/manifest.json', sha: 'sha_manifest' },
      { path: 'v2/state.gz', sha: 'stale_sha' }, // prior-generation orphan to be cleaned
    ]);
    // The orphan DELETE 409s (sha drifted); the refetch GET is the default 404 → give up.
    fetchResponses.set(
      'DELETE https://api.github.com/repos/testuser/aga-cloud-save/contents/v2/state.gz',
      { status: 409, body: { message: 'Conflict' } },
    );

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.upload()).resolves.toBeUndefined(); // did NOT throw
    // The commit (manifest PUT) still happened → the cloud save is valid.
    expect(fetchCalls.some(c => c.method === 'PUT' && c.url.includes('manifest.json'))).toBe(true);
    // And the baseline advanced (upload treated as successful).
    expect(sync.getSyncBaseline()).not.toBe('');
  });

  it('cleanup is awaited before upload() resolves (deletes complete, not fire-and-forget)', async () => {
    setupV2DirectoryListing([
      { path: 'v2/manifest.json', sha: 'sha_manifest' },
      { path: 'v2/state.gz', sha: 'sha_state_old' },
      { path: 'v2/img-0.gz', sha: 'sha_img0_old' },
    ]);

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    // By the time upload() resolves, the stale DELETEs have already been issued
    // (awaited inside the lock) — so a follow-up upload can never race them.
    const deletePaths = fetchCalls.filter(c => c.method === 'DELETE').map(c => c.url);
    expect(deletePaths.some(p => p.includes('v2/state.gz'))).toBe(true);
    expect(deletePaths.some(p => p.includes('v2/img-0.gz'))).toBe(true);
  });
});

// ─── upload: error handling ───

describe('upload — error handling', () => {
  it('throws when not configured (no token)', async () => {
    storage.delete('aga_github_sync_token');
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.upload()).rejects.toThrow('Token');
  });

  it('throws when not configured (no owner)', async () => {
    storage.delete('aga_github_sync_owner');
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.upload()).rejects.toThrow('用户名');
  });

  it('throws when PUT returns error', async () => {
    // State chunk now uploads to a generation-suffixed path (v2/state.<tag>.gz);
    // register the 422 on the v2/state prefix so the mock's startsWith match fires.
    fetchResponses.set(
      'PUT https://api.github.com/repos/testuser/aga-cloud-save/contents/v2/state',
      { status: 422, body: { message: 'Validation Failed' } },
    );

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.upload()).rejects.toThrow(/422/);
  });
});

// ─── upload: degraded-overwrite guardrail ───

describe('upload — degraded-overwrite guardrail', () => {
  it('blocks when the exported trees record world books but the export carries none (2026-09-10)', async () => {
    const backup = createMockBackup(undefined, { referencedAssets: 2, exportedAssets: 2 });
    const healthy = await backup.exportForSync();
    backup.exportForSync.mockResolvedValue({
      ...healthy,
      worldBookIntegrity: { expectedBooks: 2, exportedBooks: 0, degradedProfiles: ['p1'] },
    });
    const sync = new GitHubSyncService(backup as never);
    const err = await sync.upload().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DegradedUploadError);
    expect((err as DegradedUploadError).detail).toMatchObject({
      missingAssets: 0, worldBooksExpected: 2, worldBooksExported: 0,
    });
  });

  it('blocks (throws DegradedUploadError) on a TOTAL image-cache wipe (references 5, exported 0)', async () => {
    const backup = createMockBackup(undefined, { referencedAssets: 5, exportedAssets: 0 });
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.upload()).rejects.toBeInstanceOf(DegradedUploadError);

    // Guardrail runs BEFORE any cloud mutation → nothing was PUT or DELETEd.
    expect(fetchCalls.some(c => c.method === 'PUT')).toBe(false);
    expect(fetchCalls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('blocks on a PARTIAL image-cache eviction (references 21, exported 15)', async () => {
    const backup = createMockBackup(undefined, { referencedAssets: 21, exportedAssets: 15 });
    const sync = new GitHubSyncService(backup as never);

    const err = await sync.upload().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DegradedUploadError);
    expect((err as DegradedUploadError).detail.referencedAssets).toBe(21);
    expect((err as DegradedUploadError).detail.exportedAssets).toBe(15);
    expect((err as DegradedUploadError).detail.missingAssets).toBe(6);
    expect(fetchCalls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('does NOT block a legitimately imageless upload (references 0, exported 0)', async () => {
    // Deliberate deletion of all image-bearing profiles → internally consistent
    // export → must upload freely, no false alarm (audit finding #2).
    const backup = createMockBackup(undefined, { referencedAssets: 0, exportedAssets: 0 });
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    expect(fetchCalls.some(c => c.method === 'PUT' && c.url.includes('manifest.json'))).toBe(true);
  });

  it('force:true bypasses the guardrail and uploads', async () => {
    const backup = createMockBackup(undefined, { referencedAssets: 5, exportedAssets: 0 });
    const sync = new GitHubSyncService(backup as never);

    await sync.upload(undefined, { force: true });

    const puts = fetchCalls.filter(c => c.method === 'PUT');
    expect(puts.some(c => /\/v2\/state\.[a-z0-9]+\.gz$/.test(c.url))).toBe(true);
    expect(puts.some(c => c.url.includes('v2/manifest.json'))).toBe(true);
  });

  it('does not block a healthy image-bearing upload (references 2, exported 2)', async () => {
    const backup = createMockBackup(); // default integrity { referenced: 2, exported: 2 }
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    expect(fetchCalls.some(c => c.method === 'PUT' && c.url.includes('manifest.json'))).toBe(true);
  });
});

// ─── upload: API request format ───

describe('upload — atomicity (generation-suffixed chunk paths)', () => {
  it('committed manifest references exactly the generation paths that were uploaded', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const manifestPut = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('manifest.json'));
    const b64 = (manifestPut!.body as Record<string, string>).content;
    const manifestStr = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    const manifest = JSON.parse(manifestStr) as { chunks: Array<{ path: string }> };

    const chunkPutPaths = fetchCalls
      .filter(c => c.method === 'PUT' && c.url.endsWith('.gz'))
      .map(c => c.url.replace(/^.*\/contents\//, '')); // → "v2/state.<tag>.gz"

    // Every manifest chunk path was actually written → a download finds its chunks.
    for (const ch of manifest.chunks) {
      expect(chunkPutPaths).toContain(ch.path);
    }
    // And none of them is a bare (prior-generation) path.
    for (const ch of manifest.chunks) {
      expect(ch.path).toMatch(/^v2\/(state|state-\d+|img-\d+)\.[a-z0-9]+\.gz$/);
    }
  });
});

describe('upload — API request details', () => {
  it('sends correct Authorization header', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const fetchImpl = vi.mocked(fetch);
    const firstCall = fetchImpl.mock.calls[0];
    const headers = firstCall[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test123');
  });

  it('uses configured repo name in URLs', async () => {
    storage.set('aga_github_sync_repo', 'my-custom-repo');
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const puts = fetchCalls.filter(c => c.method === 'PUT');
    for (const put of puts) {
      expect(put.url).toContain('my-custom-repo');
    }
  });

  it('manifest JSON in PUT is valid and contains expected fields', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const manifestPut = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('manifest.json'));
    expect(manifestPut).toBeDefined();

    const b64Content = (manifestPut!.body as Record<string, string>).content;
    const manifestStr = new TextDecoder().decode(Uint8Array.from(atob(b64Content), c => c.charCodeAt(0)));
    const manifest = JSON.parse(manifestStr);

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.bundleChecksum).toHaveLength(64);
    expect(manifest.chunks.length).toBeGreaterThanOrEqual(2);
    expect(manifest.chunks[0].name).toBe('state');
    // Path carries the per-upload generation tag; the name stays canonical.
    expect(manifest.chunks[0].path).toMatch(/^v2\/state\.[a-z0-9]+\.gz$/);
  });
});

// ─── upload: chunk contents ───

describe('upload — chunk contents are valid gzipped data', () => {
  it('state chunk can be decoded back to valid JSON', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const statePut = fetchCalls.find(c => c.method === 'PUT' && /\/v2\/state\.[a-z0-9]+\.gz$/.test(c.url));
    const b64 = (statePut!.body as Record<string, string>).content;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes]);

    // Decompress
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const parsed = JSON.parse(text);

    expect(parsed.version).toBe(1);
    expect(parsed.profiles.p1).toBeDefined();
    // imageAssets content is extracted to img chunks, but an empty placeholder
    // stays in state to preserve the key's original position (order-stable
    // reassembly → bundle checksum matches even with trailing keys).
    expect(parsed.imageAssets).toEqual([]);
  });

  it('image chunk can be decoded back to valid JSON array', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.upload();

    const imgPut = fetchCalls.find(c => c.method === 'PUT' && /\/v2\/img-0\.[a-z0-9]+\.gz$/.test(c.url));
    expect(imgPut).toBeDefined();

    const b64 = (imgPut!.body as Record<string, string>).content;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes]);

    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const parsed = JSON.parse(text);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].id).toBeTruthy();
    expect(parsed[0].base64).toBeTruthy();
  });
});

// ─── Download test infrastructure ───

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function utf8ToBase64(str: string): string {
  return bytesToBase64(new TextEncoder().encode(str));
}

const REPO_BASE = 'https://api.github.com/repos/testuser/aga-cloud-save';

async function setupDownloadableBundle(bundleJson?: string): Promise<{ manifest: ChunkManifest; json: string }> {
  const json = bundleJson ?? JSON.stringify({
    version: 1,
    exportedAt: '2026-05-09T12:00:00Z',
    engineVersion: '0.1.0',
    bundleType: 'full',
    activeProfile: { profileId: 'p1', slotId: 's1' },
    profiles: { p1: { name: '李逍遥' } },
    saves: { 'p1/s1': { 角色: { 姓名: '李逍遥', 属性: { 体力: 100 } } } },
    vectors: {},
    configs: {},
    prompts: {},
    engineSettings: { aga_theme: 'dark', aga_token: null },
    imageAssets: [
      { id: 'img1', metadata: { id: 'img1', backend: 'novelai', createdAt: 1 }, base64: 'A'.repeat(500), mimeType: 'image/png' },
      { id: 'img2', metadata: { id: 'img2', backend: 'civitai', createdAt: 2, origin: 'generated' }, base64: 'B'.repeat(500), mimeType: 'image/webp' },
    ],
  }, null, 2);

  const { manifest, chunks } = await pack(json);

  // Setup manifest responses: GET contents → sha, GET blobs/{sha} → base64 content
  const manifestSha = 'sha_manifest_' + Date.now();
  const manifestB64 = utf8ToBase64(JSON.stringify(manifest, null, 2));

  fetchResponses.set(
    `GET ${REPO_BASE}/contents/v2/manifest.json`,
    { status: 200, body: { sha: manifestSha, path: 'v2/manifest.json', size: manifestB64.length } },
  );
  fetchResponses.set(
    `GET ${REPO_BASE}/git/blobs/${manifestSha}`,
    { status: 200, body: { content: manifestB64, encoding: 'base64' } },
  );

  // Setup each chunk: contents → sha, blobs → base64
  for (const entry of manifest.chunks) {
    const chunkSha = `sha_${entry.name}_${Date.now()}`;
    const chunkBytes = new Uint8Array(await chunks.get(entry.path)!.arrayBuffer());
    const chunkB64 = bytesToBase64(chunkBytes);

    fetchResponses.set(
      `GET ${REPO_BASE}/contents/${entry.path}`,
      { status: 200, body: { sha: chunkSha, path: entry.path, size: chunkBytes.length } },
    );
    fetchResponses.set(
      `GET ${REPO_BASE}/git/blobs/${chunkSha}`,
      { status: 200, body: { content: chunkB64, encoding: 'base64' } },
    );
  }

  return { manifest, json };
}

// ─── download: basic flow ───

describe('download — v2 chunked pipeline', () => {
  it('fetches manifest, downloads chunks, unpacks, and calls importAll', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const { json } = await setupDownloadableBundle();

    await sync.download();

    expect(backup.importAll).toHaveBeenCalledOnce();
    const importedBlob = backup.importAll.mock.calls[0][0] as Blob;
    const importedText = await importedBlob.text();
    expect(importedText).toBe(json);
  });

  it('restores exact same data that was packed (roundtrip via API)', async () => {
    const originalJson = JSON.stringify({
      version: 1,
      exportedAt: '2026-05-09T18:00:00Z',
      engineVersion: '0.1.0',
      profiles: { p1: { name: '赵灵儿' } },
      saves: { 'p1/s1': { 角色: { 姓名: '赵灵儿', 属性: { 灵力: 200 } }, 世界: { 天气: '月光' } } },
      vectors: { 'p1/s1': { nodes: [{ embedding: new Array(10).fill(0.5) }] } },
      configs: {},
      prompts: { entries: [{ key: 'sys', value: '修仙世界' }] },
      engineSettings: { aga_nsfw: 'true' },
      customPresets: { pack1: { worlds: [{ id: 'w1' }] } },
      imageAssets: [
        { id: 'img_a', metadata: { id: 'img_a', backend: 'civitai', origin: 'upload', createdAt: 100 }, base64: 'C'.repeat(1000), mimeType: 'image/png' },
      ],
    }, null, 2);

    const backup = createMockBackup(originalJson);
    const sync = new GitHubSyncService(backup as never);
    await setupDownloadableBundle(originalJson);

    await sync.download();

    const importedBlob = backup.importAll.mock.calls[0][0] as Blob;
    expect(await importedBlob.text()).toBe(originalJson);
  });

  it('handles bundle without imageAssets', async () => {
    const json = JSON.stringify({
      version: 1, exportedAt: '2026-05-09', engineVersion: '0.1.0',
      profiles: {}, saves: {}, vectors: {}, configs: {}, prompts: {},
      engineSettings: {},
    }, null, 2);

    const backup = createMockBackup(json);
    const sync = new GitHubSyncService(backup as never);
    await setupDownloadableBundle(json);

    await sync.download();

    const importedBlob = backup.importAll.mock.calls[0][0] as Blob;
    expect(await importedBlob.text()).toBe(json);
  });
});

// ─── download: progress callbacks ───

describe('download — progress callbacks', () => {
  it('emits downloading stages in order', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    await setupDownloadableBundle();

    const statuses: SyncStatus[] = [];
    await sync.download((s) => statuses.push({ ...s }));

    const messages = statuses.map(s => s.message);
    expect(statuses[0]).toEqual({ stage: 'downloading', message: '正在获取云端索引…' });
    expect(messages.some(m => m.includes('正在下载分块'))).toBe(true);
    expect(messages.some(m => m === '正在校验并恢复…')).toBe(true);
    expect(statuses[statuses.length - 1]).toEqual({ stage: 'done', message: '下载并恢复完成' });
  });

  it('chunk progress shows correct N/total format', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    await setupDownloadableBundle();

    const statuses: SyncStatus[] = [];
    await sync.download((s) => statuses.push({ ...s }));

    const chunkMsgs = statuses.map(s => s.message).filter(m => m.includes('正在下载分块'));
    expect(chunkMsgs.length).toBeGreaterThanOrEqual(2); // state + img
    expect(chunkMsgs[0]).toMatch(/正在下载分块 1\/\d+…/);
  });
});

// ─── download: manifest not found ───

describe('download — manifest not found', () => {
  it('throws user-friendly message when manifest does not exist', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.download()).rejects.toThrow('云端无存档，请先上传');
    expect(backup.importAll).not.toHaveBeenCalled();
  });
});

// ─── download: error handling ───

describe('download — error handling', () => {
  it('throws when not configured', async () => {
    storage.delete('aga_github_sync_token');
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.download()).rejects.toThrow('Token');
  });

  it('throws when a chunk download fails (404)', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const { manifest } = await setupDownloadableBundle();

    // Remove one chunk's response to simulate 404
    const imgEntry = manifest.chunks.find(c => c.name.startsWith('img-'))!;
    fetchResponses.delete(`GET ${REPO_BASE}/contents/${imgEntry.path}`);

    await expect(sync.download()).rejects.toThrow(/404/);
    expect(backup.importAll).not.toHaveBeenCalled();
  });

  it('does not call importAll when checksum verification fails', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const { manifest } = await setupDownloadableBundle();

    // Tamper the manifest bundleChecksum after setup
    // We need to re-setup manifest with wrong checksum
    const tamperedManifest = { ...manifest, bundleChecksum: '0'.repeat(64) };
    const manifestSha = 'sha_tampered';
    const manifestB64 = utf8ToBase64(JSON.stringify(tamperedManifest, null, 2));

    fetchResponses.set(
      `GET ${REPO_BASE}/contents/v2/manifest.json`,
      { status: 200, body: { sha: manifestSha } },
    );
    fetchResponses.set(
      `GET ${REPO_BASE}/git/blobs/${manifestSha}`,
      { status: 200, body: { content: manifestB64, encoding: 'base64' } },
    );

    await expect(sync.download()).rejects.toThrow(/校验失败/);
    expect(backup.importAll).not.toHaveBeenCalled();
  });
});

// ─── getCloudInfo ───

describe('getCloudInfo — v2 manifest', () => {
  it('returns exists:true with correct metadata when manifest exists', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const { manifest } = await setupDownloadableBundle();

    const info = await sync.getCloudInfo();

    expect(info.exists).toBe(true);
    expect(info.updatedAt).toBe(manifest.createdAt);
    expect(info.sizeKB).toBe(Math.round(manifest.totalSizeBytes / 1024));
  });

  it('returns exists:false when manifest not found', async () => {
    // Default mock returns 404 → manifest not found
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    const info = await sync.getCloudInfo();

    expect(info.exists).toBe(false);
    expect(info.updatedAt).toBeUndefined();
    expect(info.sizeKB).toBeUndefined();
  });

  it('throws on non-404 errors', async () => {
    fetchResponses.set(
      `GET ${REPO_BASE}/contents/v2/manifest.json`,
      { status: 500, body: { message: 'Server Error' } },
    );

    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.getCloudInfo()).rejects.toThrow(/500/);
  });

  it('does not call old backup.json path', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    await setupDownloadableBundle();

    await sync.getCloudInfo();

    const gets = fetchCalls.filter(c => c.method === 'GET');
    const backupJsonCalls = gets.filter(c => c.url.includes('backup.json'));
    expect(backupJsonCalls).toHaveLength(0);
  });
});

// ─── Auto-sync toggle (portable preference) ───

describe('auto-sync toggle', () => {
  it('defaults to OFF', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(sync.getAutoSyncEnabled()).toBe(false);
  });

  it('persists on/off via localStorage', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    sync.setAutoSyncEnabled(true);
    expect(sync.getAutoSyncEnabled()).toBe(true);
    expect(storage.get('aga_github_autosync_enabled')).toBe('1');
    sync.setAutoSyncEnabled(false);
    expect(sync.getAutoSyncEnabled()).toBe(false);
    expect(storage.has('aga_github_autosync_enabled')).toBe(false);
  });
});

// ─── Pending-sync flag (persisted "local save not yet uploaded") ───

describe('pending-sync flag', () => {
  it('defaults to false', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(sync.hasPendingSync()).toBe(false);
  });

  it('persists set/clear via localStorage (survives across service instances = across sessions)', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    sync.setPendingSync(true);
    expect(sync.hasPendingSync()).toBe(true);
    expect(storage.get('aga_github_sync_pending')).toBe('1');

    // A fresh instance (simulating a new session/tab) still sees the persisted flag.
    const next = new GitHubSyncService(createMockBackup() as never);
    expect(next.hasPendingSync()).toBe(true);

    next.setPendingSync(false);
    expect(next.hasPendingSync()).toBe(false);
    expect(storage.has('aga_github_sync_pending')).toBe(false);
  });
});

// ─── Sync baseline + conflict detection (multi-device guard) ───

/** Read the createdAt out of the committed manifest PUT (the upload's commit point). */
function committedManifestCreatedAt(): string {
  const manifestPut = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('manifest.json'));
  const b64 = (manifestPut!.body as Record<string, string>).content;
  const str = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  return (JSON.parse(str) as { createdAt: string }).createdAt;
}

describe('sync baseline', () => {
  it('starts empty (never synced from this device)', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(sync.getSyncBaseline()).toBe('');
  });

  it('upload records the committed manifest createdAt as the baseline', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(sync.getSyncBaseline()).toBe('');

    await sync.upload();

    expect(sync.getSyncBaseline()).toBe(committedManifestCreatedAt());
    expect(sync.getSyncBaseline()).not.toBe('');
  });

  it('download records the downloaded manifest createdAt as the baseline', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    const { manifest } = await setupDownloadableBundle();

    await sync.download();

    expect(sync.getSyncBaseline()).toBe(manifest.createdAt);
  });

  it('a blocked degraded upload does NOT move the baseline (nothing was committed)', async () => {
    const sync = new GitHubSyncService(createMockBackup(undefined, { referencedAssets: 5, exportedAssets: 0 }) as never);
    await expect(sync.upload()).rejects.toBeInstanceOf(DegradedUploadError);
    expect(sync.getSyncBaseline()).toBe('');
  });
});

describe('detectConflict', () => {
  it('no conflict when the cloud is empty', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never); // default mock → manifest 404
    const { conflict, cloud } = await sync.detectConflict();
    expect(cloud.exists).toBe(false);
    expect(conflict).toBe(false);
  });

  it('conflict on a fresh device (no baseline) meeting a non-empty cloud', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await setupDownloadableBundle(); // cloud now exists
    expect(sync.getSyncBaseline()).toBe('');

    const { conflict, cloud } = await sync.detectConflict();
    expect(cloud.exists).toBe(true);
    expect(conflict).toBe(true);
  });

  it('no conflict when the cloud createdAt equals our baseline (unchanged since we synced)', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    const { manifest } = await setupDownloadableBundle();
    sync.setSyncBaseline(manifest.createdAt);

    const { conflict } = await sync.detectConflict();
    expect(conflict).toBe(false);
  });

  it('conflict when the cloud createdAt differs from our baseline (another device uploaded)', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await setupDownloadableBundle();
    sync.setSyncBaseline('2000-01-01T00:00:00.000Z'); // stale baseline

    const { conflict } = await sync.detectConflict();
    expect(conflict).toBe(true);
  });
});

// ─── Shared upload/download concurrency lock ───

describe('sync concurrency lock', () => {
  it('rejects a second upload while one is in flight (SyncInProgressError)', async () => {
    // Hold the first upload at its export step with a deferred promise so it stays
    // in flight deterministically.
    let releaseExport!: (v: { blob: Blob; imageIntegrity: { referencedAssets: number; exportedAssets: number } }) => void;
    const blob = new Blob([JSON.stringify({ version: 1, profiles: {}, saves: {}, vectors: {}, configs: {}, prompts: {}, engineSettings: {} })], { type: 'application/json' });
    const backup = {
      exportForSync: vi.fn().mockReturnValue(new Promise((res) => { releaseExport = res; })),
      importAll: vi.fn().mockResolvedValue(undefined),
    };
    const sync = new GitHubSyncService(backup as never);

    const p1 = sync.upload();          // enters lock, awaits export (pending)
    expect(sync.isSyncing()).toBe(true);

    await expect(sync.upload()).rejects.toBeInstanceOf(SyncInProgressError);
    await expect(sync.download()).rejects.toBeInstanceOf(SyncInProgressError); // download shares the lock

    releaseExport({ blob, imageIntegrity: { referencedAssets: 0, exportedAssets: 0 } });
    await p1;
    expect(sync.isSyncing()).toBe(false); // lock released
  });

  it('releases the lock after a blocked degraded upload, so a later upload can proceed', async () => {
    const sync = new GitHubSyncService(createMockBackup(undefined, { referencedAssets: 5, exportedAssets: 0 }) as never);

    await expect(sync.upload()).rejects.toBeInstanceOf(DegradedUploadError);
    expect(sync.isSyncing()).toBe(false);

    // force:true now succeeds — proving the lock was released by the finally, not stuck.
    await sync.upload(undefined, { force: true });
    expect(fetchCalls.some(c => c.method === 'PUT' && c.url.includes('manifest.json'))).toBe(true);
  });
});
