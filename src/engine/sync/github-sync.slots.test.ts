/**
 * GitHubSyncService v3 存档插槽单测（docs/design/github-save-slots-design.md Phase 2）
 *
 * 覆盖：格式探测 / uploadSlot（gen-tag、manifest 最后写、slotMeta、退化拦截、
 * 目录内清理隔离）/ uploadGlobal checksum 跳传 / downloadSlot→importProfileReplace /
 * downloadGlobal bundleType 防线 / deleteCloudSlot（manifest 先删）/
 * per-slot 冲突检测 / baselines-pending map 读写与自愈 / slotId 校验。
 *
 * Mock 基建沿用 github-sync.test.ts 的 fetch/localStorage stub 模式。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubSyncService, DegradedUploadError, GLOBAL_SLOT_KEY, computeGlobalContentChecksum } from './github-sync';
import { pack } from './chunked-bundle-packer';

// ─── Mock 基建 ───

const PROFILE_JSON = JSON.stringify({
  version: 1,
  exportedAt: '2026-07-23T00:00:00Z',
  engineVersion: '0.1.0',
  bundleType: 'profile',
  activeProfile: null,
  profiles: { p1: { profileId: 'p1', characterName: '李明', slots: { s1: {} } } },
  saves: { 'p1/s1': { 角色: { 姓名: '李明' } } },
  vectors: {},
  configs: {},
  prompts: {},
  engineSettings: {},
  imageAssets: [
    { id: 'img1', metadata: { id: 'img1' }, base64: 'A'.repeat(300), mimeType: 'image/png' },
  ],
}, null, 2);

const GLOBAL_JSON = JSON.stringify({
  version: 1,
  exportedAt: '2026-07-23T00:00:00Z',
  engineVersion: '0.1.0',
  bundleType: 'global',
  activeProfile: null,
  profiles: {},
  saves: {},
  vectors: {},
  configs: { overlays: [{ id: 'ov1' }] },
  prompts: { entries: [] },
  engineSettings: { aga_theme: 'dark' },
}, null, 2);

const DISPLAY_META = { profileId: 'p1', profileName: '李明', packId: 'tianming', slotCount: 1, lastPlayedAt: '2026-07-22T00:00:00Z' };

function createMockBackup(opts?: {
  integrity?: { referencedAssets: number; exportedAssets: number };
  profileIds?: string[];
  /** 指定某档案返回退化 integrity（迁移中止测试用） */
  degradedProfile?: string;
}) {
  const integrity = opts?.integrity ?? { referencedAssets: 1, exportedAssets: 1 };
  return {
    exportProfileForSync: vi.fn().mockImplementation((pid: string) => Promise.resolve({
      blob: new Blob([PROFILE_JSON], { type: 'application/json' }),
      imageIntegrity: pid === opts?.degradedProfile
        ? { referencedAssets: 9, exportedAssets: 0 }
        : integrity,
      displayMeta: { ...DISPLAY_META, profileId: pid },
    })),
    exportGlobalForSync: vi.fn().mockResolvedValue({
      blob: new Blob([GLOBAL_JSON], { type: 'application/json' }),
    }),
    listProfileIds: vi.fn().mockReturnValue(opts?.profileIds ?? ['p1']),
    importProfileReplace: vi.fn().mockResolvedValue(undefined),
    importAll: vi.fn().mockResolvedValue(undefined),
    exportForSync: vi.fn(),
    exportAll: vi.fn(),
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
/** 一次性响应（先于 fetchResponses 匹配，命中即消费）——模拟 sha 漂移/瞬态 409。 */
let fetchOnceResponses: Map<string, Array<{ status: number; body: unknown }>>;
/** 本会话内被 PUT 过的文件（path → base64 content）——GET 可读回，供迁移验证闸测试。 */
let uploadedFiles: Map<string, string>;
/** 匹配到的已上传文件在读回时返回损坏字节——模拟"PUT 200 但云端字节坏了"。 */
let corruptReadbackPattern: RegExp | null;

function mockFetch() {
  fetchCalls = [];
  fetchResponses = new Map();
  fetchOnceResponses = new Map();
  uploadedFiles = new Map();
  corruptReadbackPattern = null;
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url, method, body });
    const onceQueue = fetchOnceResponses.get(`${method} ${url}`);
    if (onceQueue && onceQueue.length > 0) {
      const once = onceQueue.shift()!;
      return new Response(JSON.stringify(once.body), { status: once.status });
    }
    const resp = fetchResponses.get(`${method} ${url}`);
    if (resp) return new Response(JSON.stringify(resp.body), { status: resp.status });

    // PUT 落库，后续 GET 自动可读回（contents → 伪 sha → git blob）
    const contentsMatch = url.match(/\/contents\/(.+)$/);
    if (method === 'PUT' && contentsMatch) {
      uploadedFiles.set(contentsMatch[1], (body as { content: string }).content);
      return new Response(JSON.stringify({ content: {} }), { status: 201 });
    }
    if (method === 'GET' && contentsMatch && uploadedFiles.has(contentsMatch[1])) {
      return new Response(JSON.stringify({ sha: `up:${contentsMatch[1]}` }), { status: 200 });
    }
    const blobMatch = url.match(/\/git\/blobs\/up:(.+)$/);
    if (method === 'GET' && blobMatch && uploadedFiles.has(decodeURIComponent(blobMatch[1]))) {
      const p = decodeURIComponent(blobMatch[1]);
      const content = corruptReadbackPattern?.test(p)
        ? btoa('CORRUPTED-BYTES')
        : uploadedFiles.get(p)!;
      return new Response(JSON.stringify({ content, encoding: 'base64' }), { status: 200 });
    }

    if (method === 'GET') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify({ content: {} }), { status: 201 });
  };
  vi.stubGlobal('fetch', vi.fn(impl));
}

const API = 'https://api.github.com/repos/testuser/aga-cloud-save-dev';

function setDirListing(dir: string, files: Array<{ name: string; path: string; sha: string; type: string }>) {
  fetchResponses.set(`GET ${API}/contents/${dir}`, { status: 200, body: files });
}

async function blobToB64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 把 pack 产物注册成可下载的云端文件（contents → sha → git blob）。 */
async function serveManifestAndChunks(dir: string, json: string) {
  const { manifest, chunks } = await pack(json, dir);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestB64 = btoa(unescape(encodeURIComponent(manifestJson)));
  fetchResponses.set(`GET ${API}/contents/${dir}/manifest.json`, { status: 200, body: { sha: `sha-${dir}-manifest` } });
  fetchResponses.set(`GET ${API}/git/blobs/sha-${dir}-manifest`, { status: 200, body: { content: manifestB64, encoding: 'base64' } });
  for (const [path, blob] of chunks) {
    fetchResponses.set(`GET ${API}/contents/${path}`, { status: 200, body: { sha: `sha-${path}` } });
    fetchResponses.set(`GET ${API}/git/blobs/sha-${path}`, { status: 200, body: { content: await blobToB64(blob), encoding: 'base64' } });
  }
  return manifest;
}

beforeEach(() => {
  storage.clear();
  storage.set('aga_github_sync_token', 'ghp_test123');
  storage.set('aga_github_sync_owner', 'testuser');
  storage.set('aga_github_sync_repo', 'aga-cloud-save-dev');
  vi.restoreAllMocks();
  mockFetch();
});

// ─── 格式探测 ───

describe('detectCloudFormat', () => {
  it('reports v3 when slots/ has entries', async () => {
    setDirListing('slots', [{ name: 'p1', path: 'slots/p1', sha: 'x', type: 'dir' }]);
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(await sync.detectCloudFormat()).toBe('v3');
  });

  it('reports v2 when only v2/manifest.json exists', async () => {
    fetchResponses.set(`GET ${API}/contents/v2/manifest.json`, { status: 200, body: { sha: 'm' } });
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(await sync.detectCloudFormat()).toBe('v2');
  });

  it('reports v3 when only global/ exists (slots/ empty)', async () => {
    setDirListing('global', [{ name: 'manifest.json', path: 'global/manifest.json', sha: 'g', type: 'file' }]);
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(await sync.detectCloudFormat()).toBe('v3');
  });

  it('reports empty when neither exists', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect(await sync.detectCloudFormat()).toBe('empty');
  });
});

// ─── uploadSlot ───

describe('uploadSlot', () => {
  it('uploads chunks under slots/<pid>/ with gen tags, writes slotMeta manifest LAST, updates only that slot baseline', async () => {
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);
    storage.set('aga_github_sync_baseline', 'legacy-untouched');

    await sync.uploadSlot('p1');

    const puts = fetchCalls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBeGreaterThanOrEqual(3); // state + img-0 + manifest
    // 所有 PUT 都在本插槽目录内
    for (const p of puts) {
      expect(p.url).toContain('/contents/slots/p1/');
    }
    // 分块带 gen tag（非裸路径）
    const chunkPuts = puts.slice(0, -1);
    for (const p of chunkPuts) {
      expect(p.url).toMatch(/slots\/p1\/(state|img-\d+)\.[a-z0-9]+\.gz$/);
    }
    // manifest 最后写
    const last = puts[puts.length - 1];
    expect(last.url).toBe(`${API}/contents/slots/p1/manifest.json`);
    const manifestBody = JSON.parse(
      decodeURIComponent(escape(atob((last.body as { content: string }).content))),
    ) as { slotMeta?: typeof DISPLAY_META; chunks: Array<{ path: string }> };
    expect(manifestBody.slotMeta).toEqual(DISPLAY_META);
    for (const c of manifestBody.chunks) {
      expect(c.path).toMatch(/^slots\/p1\//);
    }
    // 基线：仅 p1 写入 map；旧标量键不动
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(Object.keys(baselines)).toEqual(['p1']);
    expect(storage.get('aga_github_sync_baseline')).toBe('legacy-untouched');
  });

  it('hard-blocks a degraded export before any cloud write', async () => {
    const backup = createMockBackup({ integrity: { referencedAssets: 5, exportedAssets: 2 } });
    const sync = new GitHubSyncService(backup as never);
    await expect(sync.uploadSlot('p1')).rejects.toBeInstanceOf(DegradedUploadError);
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('does not touch the cloud when profile export detects missing save data', async () => {
    const backup = createMockBackup();
    backup.exportProfileForSync.mockRejectedValue(
      new Error('档案存档结构不完整：元数据有槽但存档数据缺失'),
    );
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.uploadSlot('p1')).rejects.toThrow('存档结构不完整');
    expect(fetchCalls.filter((c) => c.method === 'PUT' || c.method === 'DELETE')).toHaveLength(0);
  });

  it('cleanup deletes stale files ONLY inside its own slot directory', async () => {
    setDirListing('slots/p1', [
      { name: 'state.old.gz', path: 'slots/p1/state.old.gz', sha: 'stale1', type: 'file' },
      { name: 'manifest.json', path: 'slots/p1/manifest.json', sha: 'old-manifest', type: 'file' },
    ]);
    const sync = new GitHubSyncService(createMockBackup() as never);
    await sync.uploadSlot('p1');

    const deletes = fetchCalls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d.url).toContain('/contents/slots/p1/'); // 绝不越界到其他插槽
      expect(d.url).not.toContain('manifest.json');   // 新 manifest 已就位，不删
    }
  });

  it('manifest PUT takes its sha from a FRESH single-file GET, never the (possibly stale) directory listing', async () => {
    // 真机验证 2026-07-23：目录列表在最近 commit 后最终一致，沿用其 sha 会 409。
    // 目录列表给 stale sha，单文件 GET 给 fresh sha —— PUT 必须带 fresh。
    setDirListing('slots/p1', [
      { name: 'manifest.json', path: 'slots/p1/manifest.json', sha: 'stale-from-listing', type: 'file' },
    ]);
    fetchResponses.set(`GET ${API}/contents/slots/p1/manifest.json`, { status: 200, body: { sha: 'fresh-from-file-get' } });

    const sync = new GitHubSyncService(createMockBackup() as never);
    await sync.uploadSlot('p1');

    const manifestPuts = fetchCalls.filter((c) => c.method === 'PUT' && c.url.endsWith('slots/p1/manifest.json'));
    expect(manifestPuts).toHaveLength(1);
    expect((manifestPuts[0].body as { sha?: string }).sha).toBe('fresh-from-file-get');
  });

  it('a 409 AFTER the fresh sha fetch (genuine concurrent writer) surfaces loudly — no blind retry overwrite', async () => {
    // 审查 Imp#1：现取 sha 后仍 409 = 另一写者真实提交。绝不重取重试（那会用本机
    // 旧内容静默覆盖对方刚成功的上传）——必须响亮失败，交给冲突检测处理。
    fetchResponses.set(`GET ${API}/contents/slots/p1/manifest.json`, { status: 200, body: { sha: 'fresh' } });
    fetchResponses.set(`PUT ${API}/contents/slots/p1/manifest.json`, { status: 409, body: { message: 'does not match' } });

    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.uploadSlot('p1')).rejects.toThrow('更新云端索引失败');

    const manifestPuts = fetchCalls.filter((c) => c.method === 'PUT' && c.url.endsWith('slots/p1/manifest.json'));
    expect(manifestPuts).toHaveLength(1); // 无第二次 PUT
    // 提交点未成立 → 基线不得写入
    expect(storage.get('aga_github_sync_baselines') ?? '{}').not.toContain('p1');
  });

  it('rejects malformed profile ids (path traversal / global collision)', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.uploadSlot('../evil')).rejects.toThrow('非法');
    await expect(sync.uploadSlot('global')).rejects.toThrow('非法');
    await expect(sync.uploadSlot('a/b')).rejects.toThrow('非法');
    expect(fetchCalls).toHaveLength(0);
  });
});

// ─── uploadGlobal ───

describe('computeGlobalContentChecksum (timestamp-immune fingerprint)', () => {
  it('same settings with DIFFERENT exportedAt timestamps → identical fingerprint', async () => {
    const a = GLOBAL_JSON;
    const b = GLOBAL_JSON.replace('2026-07-23T00:00:00Z', '2026-07-24T09:59:59Z');
    expect(JSON.parse(b).exportedAt).not.toBe(JSON.parse(a).exportedAt); // 前提确认
    expect(await computeGlobalContentChecksum(a)).toBe(await computeGlobalContentChecksum(b));
  });

  it('builtinPromptOverrides.exportedAt is also excluded; entries changes are detected', async () => {
    const base = JSON.parse(GLOBAL_JSON) as Record<string, unknown>;
    const withBpo = { ...base, builtinPromptOverrides: { version: 1, exportedAt: 'T1', entries: [{ slotId: 'x' }], packId: 'p' } };
    const sameContentNewTime = { ...base, builtinPromptOverrides: { version: 1, exportedAt: 'T2', entries: [{ slotId: 'x' }], packId: 'p' } };
    const changedEntries = { ...base, builtinPromptOverrides: { version: 1, exportedAt: 'T1', entries: [{ slotId: 'y' }], packId: 'p' } };
    const fp = (o: unknown) => computeGlobalContentChecksum(JSON.stringify(o));
    expect(await fp(withBpo)).toBe(await fp(sameContentNewTime));
    expect(await fp(withBpo)).not.toBe(await fp(changedEntries));
  });

  it('volatile session keys (aga_pending_input) do NOT change the fingerprint', async () => {
    // 真机验证 2026-07-23：输入草稿键每回合都变，若进指纹会击穿跳传
    const base = JSON.parse(GLOBAL_JSON) as Record<string, unknown>;
    const draftA = { ...base, engineSettings: { aga_theme: 'dark', aga_pending_input: '环顾四周' } };
    const draftB = { ...base, engineSettings: { aga_theme: 'dark', aga_pending_input: '继续观察' } };
    const fp = (o: unknown) => computeGlobalContentChecksum(JSON.stringify(o));
    expect(await fp(draftA)).toBe(await fp(draftB));
  });

  it('engineSettings key ORDER does not change the fingerprint; value changes do', async () => {
    const base = JSON.parse(GLOBAL_JSON) as Record<string, unknown>;
    const ab = { ...base, engineSettings: { aga_a: '1', aga_b: '2' } };
    const ba = { ...base, engineSettings: { aga_b: '2', aga_a: '1' } };
    const changed = { ...base, engineSettings: { aga_a: '1', aga_b: 'CHANGED' } };
    const fp = (o: unknown) => computeGlobalContentChecksum(JSON.stringify(o));
    expect(await fp(ab)).toBe(await fp(ba));
    expect(await fp(ab)).not.toBe(await fp(changed));
  });
});

describe('uploadGlobal checksum-skip', () => {
  async function serveGlobalManifest(manifest: Record<string, unknown>) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest))));
    fetchResponses.set(`GET ${API}/contents/global/manifest.json`, { status: 200, body: { sha: 'gm' } });
    fetchResponses.set(`GET ${API}/git/blobs/gm`, { status: 200, body: { content: b64, encoding: 'base64' } });
  }

  it('skips upload when cloud contentChecksum matches (even though exportedAt differs), re-anchors baseline', async () => {
    // 云端 manifest 的 contentChecksum 来自"同内容、不同时间戳"的另一次导出——
    // 这正是生产中的每回合场景，必须命中跳过。
    const olderExport = GLOBAL_JSON.replace('2026-07-23T00:00:00Z', '2026-07-20T00:00:00Z');
    await serveGlobalManifest({
      manifestVersion: 2, createdAt: '2026-07-20T00:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 10, bundleChecksum: 'whole-json-hash-never-matches', chunks: [],
      contentChecksum: await computeGlobalContentChecksum(olderExport),
    });

    const sync = new GitHubSyncService(createMockBackup() as never);
    const result = await sync.uploadGlobal();

    expect(result.skipped).toBe(true);
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(baselines[GLOBAL_SLOT_KEY]).toBe('2026-07-20T00:00:00Z');
  });

  it('uploads (and stamps contentChecksum into the manifest) when content differs', async () => {
    const changed = JSON.parse(GLOBAL_JSON) as Record<string, unknown>;
    (changed.engineSettings as Record<string, string>)['aga_theme'] = 'light';
    await serveGlobalManifest({
      manifestVersion: 2, createdAt: '2026-07-20T00:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 10, bundleChecksum: 'x', chunks: [],
      contentChecksum: await computeGlobalContentChecksum(JSON.stringify(changed)),
    });

    const sync = new GitHubSyncService(createMockBackup() as never);
    const result = await sync.uploadGlobal();

    expect(result.skipped).toBe(false);
    const puts = fetchCalls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBeGreaterThanOrEqual(2); // state chunk + manifest
    for (const p of puts) expect(p.url).toContain('/contents/global/');
    const last = puts[puts.length - 1];
    expect(last.url).toBe(`${API}/contents/global/manifest.json`);
    const manifestBody = JSON.parse(
      decodeURIComponent(escape(atob((last.body as { content: string }).content))),
    ) as { contentChecksum?: string };
    expect(manifestBody.contentChecksum).toBe(await computeGlobalContentChecksum(GLOBAL_JSON));
  });

  it('legacy cloud manifest WITHOUT contentChecksum → uploads (no skip on bundleChecksum alone)', async () => {
    await serveGlobalManifest({
      manifestVersion: 2, createdAt: '2026-07-20T00:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 10, bundleChecksum: 'anything', chunks: [],
    });
    const sync = new GitHubSyncService(createMockBackup() as never);
    const result = await sync.uploadGlobal();
    expect(result.skipped).toBe(false);
    expect(fetchCalls.filter((c) => c.method === 'PUT').length).toBeGreaterThanOrEqual(2);
  });
});

// ─── downloadSlot / downloadGlobal ───

describe('downloadSlot', () => {
  it('downloads, verifies, hands the bundle to importProfileReplace, and sets the slot baseline', async () => {
    const manifest = await serveManifestAndChunks('slots/p1', PROFILE_JSON);
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.downloadSlot('p1');

    expect(backup.importProfileReplace).toHaveBeenCalledOnce();
    const blobArg = backup.importProfileReplace.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blobArg.text())).toEqual(JSON.parse(PROFILE_JSON));
    // 走档案级替换，绝不走全量 importAll
    expect(backup.importAll).not.toHaveBeenCalled();
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(baselines['p1']).toBe(manifest.createdAt);
  });

  it('surfaces a readable error when the slot does not exist', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.downloadSlot('ghost')).rejects.toThrow('云端没有该档案的存档');
  });

  it('rejects malformed profile ids before any network call', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.downloadSlot('../evil')).rejects.toThrow('非法');
    await expect(sync.deleteCloudSlot('a/b')).rejects.toThrow('非法');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('downloadGlobal', () => {
  it('imports via importAll after asserting bundleType=global', async () => {
    const manifest = await serveManifestAndChunks('global', GLOBAL_JSON);
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await sync.downloadGlobal();

    expect(backup.importAll).toHaveBeenCalledOnce();
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(baselines[GLOBAL_SLOT_KEY]).toBe(manifest.createdAt);
  });

  it('REFUSES to import when the global slot secretly contains a full bundle (wipe-guard)', async () => {
    const fullJson = PROFILE_JSON.replace('"bundleType": "profile"', '"bundleType": "full"');
    await serveManifestAndChunks('global', fullJson);
    const backup = createMockBackup();
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.downloadGlobal()).rejects.toThrow('内容异常');
    expect(backup.importAll).not.toHaveBeenCalled();
  });
});

// ─── deleteCloudSlot ───

describe('deleteCloudSlot', () => {
  it('deletes the manifest FIRST, then chunks, and clears slot bookkeeping', async () => {
    setDirListing('slots/p1', [
      { name: 'state.abc.gz', path: 'slots/p1/state.abc.gz', sha: 's1', type: 'file' },
      { name: 'manifest.json', path: 'slots/p1/manifest.json', sha: 'm1', type: 'file' },
      { name: 'img-0.abc.gz', path: 'slots/p1/img-0.abc.gz', sha: 'i1', type: 'file' },
    ]);
    storage.set('aga_github_sync_baselines', JSON.stringify({ p1: 't1', other: 't2' }));
    storage.set('aga_github_sync_pending_map', JSON.stringify({ p1: true }));

    const sync = new GitHubSyncService(createMockBackup() as never);
    await sync.deleteCloudSlot('p1');

    const deletes = fetchCalls.filter((c) => c.method === 'DELETE');
    expect(deletes[0].url).toBe(`${API}/contents/slots/p1/manifest.json`);
    expect(deletes).toHaveLength(3);
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(baselines).toEqual({ other: 't2' }); // 只清本插槽
    expect(JSON.parse(storage.get('aga_github_sync_pending_map')!)).toEqual({});
  });

  it('throws when the cloud slot does not exist', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.deleteCloudSlot('ghost')).rejects.toThrow('云端没有该档案的存档');
  });
});

// ─── per-slot conflict ───

describe('detectSlotConflict', () => {
  function serveSlotManifest(slotKeyDir: string, createdAt: string) {
    const m = { manifestVersion: 2, createdAt, engineVersion: '0.1.0', totalSizeBytes: 10, bundleChecksum: 'x', chunks: [] };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(m))));
    fetchResponses.set(`GET ${API}/contents/${slotKeyDir}/manifest.json`, { status: 200, body: { sha: `cm-${slotKeyDir}` } });
    fetchResponses.set(`GET ${API}/git/blobs/cm-${slotKeyDir}`, { status: 200, body: { content: b64, encoding: 'base64' } });
  }

  it('empty cloud slot → never a conflict', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.detectSlotConflict('p1')).conflict).toBe(false);
  });

  it('fresh device (no baseline) meeting a non-empty slot → conflict', async () => {
    serveSlotManifest('slots/p1', '2026-07-23T01:00:00Z');
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.detectSlotConflict('p1')).conflict).toBe(true);
  });

  it('matching baseline → no conflict; per-slot isolation (other slot conflict does not leak)', async () => {
    serveSlotManifest('slots/p1', '2026-07-23T01:00:00Z');
    storage.set('aga_github_sync_baselines', JSON.stringify({ p1: '2026-07-23T01:00:00Z', p2: 'stale' }));
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.detectSlotConflict('p1')).conflict).toBe(false);
  });

  it('global slot conflict uses the global baseline key', async () => {
    serveSlotManifest('global', '2026-07-23T02:00:00Z');
    storage.set('aga_github_sync_baselines', JSON.stringify({ [GLOBAL_SLOT_KEY]: '2026-07-23T02:00:00Z' }));
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.detectSlotConflict(GLOBAL_SLOT_KEY)).conflict).toBe(false);
  });
});

// ─── 设备本地 map 读写 ───

describe('slot baselines / pending maps', () => {
  it('roundtrips and self-heals corrupted JSON', () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    sync.setSlotBaseline('p1', 't1');
    sync.setSlotBaseline('p2', 't2');
    sync.setSlotBaseline('p1', ''); // 删除
    expect(sync.getSlotBaselines()).toEqual({ p2: 't2' });

    storage.set('aga_github_sync_baselines', 'not-json{');
    expect(sync.getSlotBaselines()).toEqual({});
    storage.set('aga_github_sync_baselines', '[1,2]');
    expect(sync.getSlotBaselines()).toEqual({});

    sync.setSlotPending('p1', true);
    expect(sync.getSlotPendingMap()).toEqual({ p1: true });
    sync.setSlotPending('p1', false);
    expect(sync.getSlotPendingMap()).toEqual({});
  });
});

// ─── listCloudSlots ───

describe('listCloudSlots', () => {
  it('lists slot dirs with slotMeta and appends the global slot', async () => {
    setDirListing('slots', [
      { name: 'p1', path: 'slots/p1', sha: 'x', type: 'dir' },
      { name: 'broken', path: 'slots/broken', sha: 'y', type: 'dir' }, // manifest 404 → 跳过
    ]);
    const slotManifest = {
      manifestVersion: 2, createdAt: '2026-07-23T03:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 2048, bundleChecksum: 'x', chunks: [], slotMeta: DISPLAY_META,
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(slotManifest))));
    fetchResponses.set(`GET ${API}/contents/slots/p1/manifest.json`, { status: 200, body: { sha: 'sm' } });
    fetchResponses.set(`GET ${API}/git/blobs/sm`, { status: 200, body: { content: b64, encoding: 'base64' } });
    const globalManifest = {
      manifestVersion: 2, createdAt: '2026-07-23T04:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 1024, bundleChecksum: 'g', chunks: [],
    };
    const gb64 = btoa(unescape(encodeURIComponent(JSON.stringify(globalManifest))));
    fetchResponses.set(`GET ${API}/contents/global/manifest.json`, { status: 200, body: { sha: 'gm2' } });
    fetchResponses.set(`GET ${API}/git/blobs/gm2`, { status: 200, body: { content: gb64, encoding: 'base64' } });

    const sync = new GitHubSyncService(createMockBackup() as never);
    const infos = await sync.listCloudSlots();

    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ slotKey: 'p1', profileName: '李明', packId: 'tianming', slotCount: 1, sizeKB: 2 });
    expect(infos[1]).toMatchObject({ slotKey: GLOBAL_SLOT_KEY, sizeKB: 1 });
  });

  it('a CORRUPTED slot manifest is skipped without blanking the rest of the list', async () => {
    setDirListing('slots', [
      { name: 'good', path: 'slots/good', sha: 'x', type: 'dir' },
      { name: 'corrupt', path: 'slots/corrupt', sha: 'y', type: 'dir' },
    ]);
    const good = {
      manifestVersion: 2, createdAt: '2026-07-23T05:00:00Z', engineVersion: '0.1.0',
      totalSizeBytes: 1024, bundleChecksum: 'x', chunks: [],
    };
    const gb64 = btoa(unescape(encodeURIComponent(JSON.stringify(good))));
    fetchResponses.set(`GET ${API}/contents/slots/good/manifest.json`, { status: 200, body: { sha: 'ok' } });
    fetchResponses.set(`GET ${API}/git/blobs/ok`, { status: 200, body: { content: gb64, encoding: 'base64' } });
    // 损坏：blob 内容不是合法 JSON
    fetchResponses.set(`GET ${API}/contents/slots/corrupt/manifest.json`, { status: 200, body: { sha: 'bad' } });
    fetchResponses.set(`GET ${API}/git/blobs/bad`, { status: 200, body: { content: btoa('this is not json'), encoding: 'base64' } });

    const sync = new GitHubSyncService(createMockBackup() as never);
    const infos = await sync.listCloudSlots();
    expect(infos.map((i) => i.slotKey)).toEqual(['good']);
  });

  it('auth/network errors are NOT swallowed as an empty list', async () => {
    fetchResponses.set(`GET ${API}/contents/slots`, { status: 401, body: { message: 'Bad credentials' } });
    const sync = new GitHubSyncService(createMockBackup() as never);
    await expect(sync.listCloudSlots()).rejects.toThrow('401');
  });
});

// ─── migrateToSlots（设计 §6 全流程 + 中断语义）───

describe('migrateToSlots', () => {
  function serveV2Manifest() {
    fetchResponses.set(`GET ${API}/contents/v2/manifest.json`, { status: 200, body: { sha: 'v2m' } });
  }

  it('happy path: uploads every profile + global, verifies each, retires v2 manifest, clears legacy scalar keys', async () => {
    serveV2Manifest();
    storage.set('aga_github_sync_baseline', 'legacy');
    storage.set('aga_github_sync_pending', '1');
    const backup = createMockBackup({ profileIds: ['p1', 'p2'] });
    const sync = new GitHubSyncService(backup as never);
    const progress: Array<{ slotKey: string; phase: string }> = [];

    const result = await sync.migrateToSlots(undefined, (p) => progress.push(p));

    // 全部插槽验证通过
    expect(result.slots.map((s) => s.slotKey).sort()).toEqual(['global', 'p1', 'p2']);
    expect(result.slots.every((s) => s.verified)).toBe(true);
    expect(result.v2Cleaned).toBe(true);
    // v2 索引被 DELETE，且发生在全部验证之后
    const deleteV2Idx = fetchCalls.findIndex((c) => c.method === 'DELETE' && c.url.endsWith('/contents/v2/manifest.json'));
    expect(deleteV2Idx).toBeGreaterThan(-1);
    const lastVerifyIdx = fetchCalls.map((c, i) => (c.method === 'GET' && /slots\/p2\/manifest\.json|global\/manifest\.json/.test(c.url) ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(deleteV2Idx).toBeGreaterThan(lastVerifyIdx);
    // 旧标量键清除；per-slot 基线齐备
    expect(storage.has('aga_github_sync_baseline')).toBe(false);
    expect(storage.has('aga_github_sync_pending')).toBe(false);
    const baselines = JSON.parse(storage.get('aga_github_sync_baselines')!) as Record<string, string>;
    expect(Object.keys(baselines).sort()).toEqual(['global', 'p1', 'p2']);
    // 进度回调覆盖 uploading → verifying → verified
    expect(progress.filter((p) => p.phase === 'verified').map((p) => p.slotKey).sort()).toEqual(['global', 'p1', 'p2']);
  });

  it('a degraded profile ABORTS migration before v2 is touched', async () => {
    serveV2Manifest();
    const backup = createMockBackup({ profileIds: ['p1', 'p2'], degradedProfile: 'p2' });
    const sync = new GitHubSyncService(backup as never);

    await expect(sync.migrateToSlots()).rejects.toBeInstanceOf(DegradedUploadError);
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('v2/manifest.json'))).toBe(false);
  });

  it('verification mismatch ABORTS migration and leaves v2 alone', async () => {
    serveV2Manifest();
    // 显式响应优先于自动读回：让 p1 的验证读回一个错误 checksum 的 manifest
    const evil = {
      manifestVersion: 2, createdAt: 'x', engineVersion: '0.1.0',
      totalSizeBytes: 1, bundleChecksum: 'TAMPERED', chunks: [],
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(evil))));
    fetchResponses.set(`GET ${API}/contents/slots/p1/manifest.json`, { status: 200, body: { sha: 'ev' } });
    fetchResponses.set(`GET ${API}/git/blobs/ev`, { status: 200, body: { content: b64, encoding: 'base64' } });

    const sync = new GitHubSyncService(createMockBackup({ profileIds: ['p1'] }) as never);
    await expect(sync.migrateToSlots()).rejects.toThrow('迁移验证失败');
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('v2/manifest.json'))).toBe(false);
  });

  it('M4 gate re-downloads chunk BYTES: corrupted cloud bytes abort migration and leave v2 alone', async () => {
    // 审查 Imp#2：只比 manifest 里的自述 checksum 防不了"PUT 200 但字节坏了"。
    // 验证闸必须逐块回读比对 SHA-256。
    serveV2Manifest();
    corruptReadbackPattern = /^slots\/p1\/state/; // p1 的 state 块读回即损坏
    const sync = new GitHubSyncService(createMockBackup({ profileIds: ['p1'] }) as never);

    await expect(sync.migrateToSlots()).rejects.toThrow('字节损坏');
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('v2/manifest.json'))).toBe(false);
  });

  it('v2 retire failure does NOT fail the migration (v2Cleaned=false, retryable)', async () => {
    serveV2Manifest();
    fetchResponses.set(`DELETE ${API}/contents/v2/manifest.json`, { status: 500, body: { message: 'boom' } });
    const sync = new GitHubSyncService(createMockBackup({ profileIds: ['p1'] }) as never);

    const result = await sync.migrateToSlots();
    expect(result.slots.every((s) => s.verified)).toBe(true);
    expect(result.v2Cleaned).toBe(false);
  });
});

describe('checkV2Revival', () => {
  it('no v2 manifest → not revived', async () => {
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.checkV2Revival()).revived).toBe(false);
  });

  it('v2 manifest present → revived with its timestamp', async () => {
    const m = { manifestVersion: 2, createdAt: '2026-07-25T00:00:00Z', engineVersion: '0.1.0', totalSizeBytes: 1, bundleChecksum: 'x', chunks: [] };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(m))));
    fetchResponses.set(`GET ${API}/contents/v2/manifest.json`, { status: 200, body: { sha: 'rv' } });
    fetchResponses.set(`GET ${API}/git/blobs/rv`, { status: 200, body: { content: b64, encoding: 'base64' } });
    const sync = new GitHubSyncService(createMockBackup() as never);
    const check = await sync.checkV2Revival();
    expect(check.revived).toBe(true);
    expect(check.v2UpdatedAt).toBe('2026-07-25T00:00:00Z');
  });

  it('corrupted v2 manifest → still counts as revived (worth warning)', async () => {
    fetchResponses.set(`GET ${API}/contents/v2/manifest.json`, { status: 200, body: { sha: 'cv' } });
    fetchResponses.set(`GET ${API}/git/blobs/cv`, { status: 200, body: { content: btoa('junk'), encoding: 'base64' } });
    const sync = new GitHubSyncService(createMockBackup() as never);
    expect((await sync.checkV2Revival()).revived).toBe(true);
  });
});

describe('getCloudSlotInfo corrupted manifest', () => {
  it('treats an unparseable manifest as exists:false (a healthy re-upload will overwrite it)', async () => {
    fetchResponses.set(`GET ${API}/contents/slots/p1/manifest.json`, { status: 200, body: { sha: 'bad' } });
    fetchResponses.set(`GET ${API}/git/blobs/bad`, { status: 200, body: { content: btoa('garbage'), encoding: 'base64' } });
    const sync = new GitHubSyncService(createMockBackup() as never);
    const check = await sync.detectSlotConflict('p1');
    expect(check.cloud.exists).toBe(false);
    expect(check.conflict).toBe(false);
  });
});
