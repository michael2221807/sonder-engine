import 'fake-indexeddb/auto';
/**
 * GitHub sync request-trace lock (refactor R6, step 0, group B).
 *
 * `GitHubSyncService` runs against an in-memory fake GitHub (contents API, directory listings, git blobs, sha
 * preconditions, injectable 404/409/500) with the real BackupService, real stores and the real chunk packer on top. Every
 * request is recorded as method, path and body, and the outcome as the status lines, the thrown `{name, message}`, the
 * localStorage difference and the BackupService calls. Written byte for byte to `__snapshots__/github-trace/<id>.json`.
 *
 * A refactor of github-sync.ts must leave every file unchanged. Snapshots are never rewritten with `-u` during the
 * refactor; a changed snapshot is a failed step. See docs/status/code-audit-2026-10/plans/R6-memory-save-sync.md §3.
 *
 * Why the traces are stable:
 *  - gzip bytes never enter a snapshot: a chunk upload is recorded by the sha-256 and length of its UNCOMPRESSED text,
 *    and the manifest's `checksum` and `compressedSize` are masked as `<gz>`. `bundleChecksum` and every plain-text
 *    hash stay. (gzip output changes with the zlib version.) Since 存档瘦身 D9A the manifest's `storedBytes` (the sum
 *    of the compressed sizes, masked as `<gz>` once checked to be that sum) and every `sizeKB` (shown from it) depend on
 *    the gzip bytes too; a manifest without `storedBytes` shows `totalSizeBytes`, which github-sync.test.ts covers.
 *  - the fake's file shas are a counter (`sha1`, `sha2`, ...), not a hash of the bytes.
 *  - Date is faked (and advanced explicitly where two uploads must get different generation tags), `Math.random` is
 *    fixed, the device id and the user agent are preset, the harness rebuilds the idbAdapter per case.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  GitHubSyncService, DegradedUploadError, computeGlobalContentChecksum, type SyncStatus,
} from './github-sync';
import { pack, type ChunkManifest } from './chunked-bundle-packer';
import {
  makeBackupHarness, FIXED_NOW, GH_TOKEN, type BackupHarness, type SeedKind,
} from '../__test-utils__/backup-harness';
import {
  serialize, sha256Hex, errorInfo, dumpLocalStorage, diffLocalStorage, dumpAllIdb,
} from '../__test-utils__/snapshot-lock';

// A case builds its own modules and database; the first one of a file also pays the module transform, which is slow
// under a parallel run. A timed-out case is NOT cancelled: it would keep running and swap the globals of the next case.
vi.setConfig({ testTimeout: 120_000 });

const SNAPSHOT_DIR = '__snapshots__/github-trace';
const OWNER = 'octo';
const REPO = 'aga-cloud-save';
const API_ROOT = `/repos/${OWNER}/${REPO}`;

type Doc = Record<string, unknown>;
type Outcome = { ok: unknown } | { threw: { name: string; message: string; status?: number } };

async function snapDoc(id: string, doc: unknown): Promise<void> {
  await expect(serialize(maskGzipFields(doc))).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}

/**
 * Masks every manifest chunk's gzip-dependent fields wherever a manifest appears in a
 * document (request bodies are masked in describeBody; returned manifests reach here).
 * Compressed bytes differ between zlib builds, so CI on Linux and Windows disagree on them.
 */
function maskGzipFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskGzipFields);
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Doc = {};
  for (const [k, v] of Object.entries(value as Doc)) {
    if (k === 'chunks' && Array.isArray(v)) {
      out[k] = v.map((c) =>
        c && typeof c === 'object' && 'compressedSize' in (c as Doc)
          ? { ...(maskGzipFields(c) as Doc), checksum: '<gz>', compressedSize: '<gz>' }
          : maskGzipFields(c),
      );
    } else if (k === 'storedBytes') {
      out[k] = maskStoredBytes(value as Doc);
    } else if (k === 'sizeKB' && typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      out[k] = '<gz>';
    } else {
      out[k] = maskGzipFields(v);
    }
  }
  return out;
}

/** A manifest's `storedBytes` as `<gz>` when it is the sum of its chunks' compressed sizes; a mark that fails the lock when not. */
function maskStoredBytes(manifest: Doc): unknown {
  if (manifest.storedBytes === '<gz>') return '<gz>'; // masked already (a request body, then the whole document)
  const chunks = manifest.chunks;
  const sum = Array.isArray(chunks)
    ? chunks.reduce((n: number, c) => n + Number((c as Doc | null)?.compressedSize), 0)
    : NaN;
  return manifest.storedBytes === sum ? '<gz>' : `<not the sum of the chunks: ${String(manifest.storedBytes)}>`;
}

// ─── the fake GitHub ───

interface RepoFile { sha: string; b64: string; encoding?: string }
interface Fault { method: string; path: RegExp; status: number; times: number }
interface TraceEntry { method: string; path: string; body?: unknown }

/** Masks everything that depends on the gzip bytes; leaves every plain-text field. */
function maskManifest(manifest: ChunkManifest): unknown {
  return maskGzipFields(manifest);
}

async function describeBody(path: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object') return body;
  const b = body as { message?: string; content?: string; sha?: string };
  if (typeof b.content !== 'string') return b;
  const bytes = Buffer.from(b.content, 'base64');
  const head: Doc = { message: b.message };
  if (b.sha !== undefined) head['sha'] = b.sha;
  if (path.endsWith('/manifest.json')) {
    return { ...head, manifest: maskManifest(JSON.parse(bytes.toString('utf8')) as ChunkManifest) };
  }
  if (path.endsWith('.gz')) {
    const plain = gunzipSync(bytes).toString('utf8');
    return { ...head, chunk: { plainLength: plain.length, plainSha256: sha256Hex(plain) } };
  }
  return { ...head, content: { size: bytes.length, sha256: sha256Hex(bytes) } };
}

class FakeGitHub {
  files = new Map<string, RepoFile>();
  trace: TraceEntry[] = [];
  faults: Fault[] = [];
  headerVariants = new Set<string>();
  /** Called after a PUT stored a file, so a case can tamper with what the repo now holds. */
  onPut: ((path: string, file: RepoFile) => void) | null = null;
  /** While set, the first request waits for it (lock tests). */
  gate: Promise<void> | null = null;
  private counter = 0;

  nextSha(): string { return `sha${++this.counter}`; }

  seed(path: string, text: string | Buffer, encoding?: string): void {
    const buf = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    this.files.set(path, { sha: this.nextSha(), b64: buf.toString('base64'), encoding });
  }

  fault(method: string, path: RegExp, status: number, times = 1): void {
    this.faults.push({ method, path, status, times });
  }

  has(path: string): boolean { return this.files.has(path); }
  paths(): string[] { return [...this.files.keys()].sort(); }
  mark(): void { this.trace.length = 0; }

  private json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const pathname = decodeURIComponent(url.pathname);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.headerVariants.add(JSON.stringify(Object.entries((init?.headers ?? {}) as Record<string, string>).sort()));
    const entry: TraceEntry = { method, path: pathname };
    if (body !== undefined) entry.body = await describeBody(pathname, body);
    this.trace.push(entry);

    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    const fault = this.faults.find((f) => f.times > 0 && f.method === method && f.path.test(pathname));
    if (fault) {
      fault.times--;
      return this.json(fault.status, { message: `fake ${fault.status}` });
    }
    return this.route(method, pathname, body);
  };

  private route(method: string, pathname: string, body: unknown): Response {
    if (pathname === '/user') return this.json(200, { login: OWNER });
    if (pathname === API_ROOT) return this.json(200, { name: REPO, default_branch: 'main' });
    const blob = pathname.match(new RegExp(`^${API_ROOT}/git/blobs/(.+)$`));
    if (blob && method === 'GET') {
      const file = [...this.files.values()].find((f) => f.sha === blob[1]);
      if (!file) return this.json(404, { message: 'Not Found' });
      return this.json(200, { sha: file.sha, content: file.b64.replace(/(.{60})/g, '$1\n'), encoding: file.encoding ?? 'base64' });
    }
    const contents = pathname.match(new RegExp(`^${API_ROOT}/contents/(.+)$`));
    if (!contents) return this.json(404, { message: 'Not Found' });
    const path = contents[1];

    if (method === 'GET') {
      const file = this.files.get(path);
      if (file) return this.json(200, { name: path.split('/').pop(), path, sha: file.sha, size: file.b64.length, type: 'file' });
      const prefix = `${path}/`;
      const children = new Map<string, { name: string; path: string; sha: string; type: string }>();
      for (const [p, f] of this.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const name = rest.split('/')[0];
        if (rest.includes('/')) children.set(name, { name, path: `${prefix}${name}`, sha: 'dir', type: 'dir' });
        else children.set(name, { name, path: p, sha: f.sha, type: 'file' });
      }
      if (children.size === 0) return this.json(404, { message: 'Not Found' });
      return this.json(200, [...children.values()]);
    }

    if (method === 'PUT') {
      const b = body as { content: string; sha?: string };
      const existing = this.files.get(path);
      if (existing && b.sha === undefined) return this.json(422, { message: '"sha" wasn\'t supplied.' });
      if (existing && b.sha !== existing.sha) return this.json(409, { message: `${path} does not match ${b.sha}` });
      const file: RepoFile = { sha: this.nextSha(), b64: b.content };
      this.files.set(path, file);
      this.onPut?.(path, file);
      return this.json(existing ? 200 : 201, { content: { sha: file.sha }, commit: { sha: 'commit' } });
    }

    if (method === 'DELETE') {
      const b = body as { sha?: string };
      const existing = this.files.get(path);
      if (!existing) return this.json(404, { message: 'Not Found' });
      if (b.sha !== existing.sha) return this.json(409, { message: `${path} does not match ${b.sha}` });
      this.files.delete(path);
      return this.json(200, { commit: { sha: 'commit' } });
    }
    return this.json(404, { message: 'Not Found' });
  }
}

// ─── environment of one case ───

interface Env {
  gh: FakeGitHub;
  h: BackupHarness;
  svc: GitHubSyncService;
  status: SyncStatus[];
  onStatus: (s: SyncStatus) => void;
  backupCalls: unknown[];
  lsBefore: Record<string, string | null>;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

async function summarizeAsync(arg: unknown): Promise<unknown> {
  if (arg instanceof Blob) return { blob: true, size: arg.size, sha256: sha256Hex(await arg.text()) };
  return arg;
}

async function makeEnv(seed: SeedKind, gh: FakeGitHub = new FakeGitHub(), configure = true): Promise<Env> {
  const h = await makeBackupHarness(seed);
  vi.stubGlobal('fetch', gh.fetch);
  vi.stubGlobal('navigator', { userAgent: USER_AGENT });
  const svc = new GitHubSyncService(h.backup);
  if (configure) {
    svc.setToken(GH_TOKEN);
    svc.setOwner(OWNER);
    svc.setRepoName(REPO);
  }
  const backupCalls: unknown[] = [];
  for (const name of ['exportForSync', 'exportProfileForSync', 'exportGlobalForSync', 'listProfileIds'] as const) {
    const original = (h.backup[name] as (...a: unknown[]) => unknown).bind(h.backup);
    vi.spyOn(h.backup, name).mockImplementation(((...args: unknown[]) => {
      backupCalls.push({ method: name, args });
      return original(...args);
    }) as never);
  }
  for (const name of ['importAll', 'importProfileReplace'] as const) {
    const original = (h.backup[name] as (...a: unknown[]) => Promise<unknown>).bind(h.backup);
    vi.spyOn(h.backup, name).mockImplementation((async (...args: unknown[]) => {
      const summary = { method: name, args: await Promise.all(args.map(summarizeAsync)) };
      backupCalls.push(summary);
      return original(...args);
    }) as never);
  }
  const status: SyncStatus[] = [];
  return { gh, h, svc, status, onStatus: (s) => status.push({ ...s }), backupCalls, lsBefore: dumpLocalStorage(h.storage) };
}

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (err) {
    const info = errorInfo(err);
    const detail = err instanceof DegradedUploadError ? { detail: err.detail } : {};
    const status = typeof (err as { status?: unknown }).status === 'number' ? { status: (err as { status: number }).status } : {};
    return { threw: { ...info, ...status, ...detail } } as Outcome;
  }
}

/** The standard result document of a case. */
function report(env: Env, outcome: unknown, extra: Doc = {}): Doc {
  // copies: the arrays are reused (and cleared) by later steps of the same case
  return {
    outcome,
    status: structuredClone(env.status),
    trace: structuredClone(env.gh.trace),
    backupCalls: structuredClone(env.backupCalls),
    lsDiff: diffLocalStorage(env.lsBefore, dumpLocalStorage(env.h.storage)),
    headers: [...env.gh.headerVariants],
    repoAfter: env.gh.paths(),
    warnings: warnings(),
    ...extra,
  };
}

const advance = (ms: number): void => { vi.setSystemTime(new Date(FIXED_NOW.getTime() + ms)); };

let warnSpy: MockInstance<typeof console.warn>;
const warnings = (): unknown[] => warnSpy.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '<non-string>'));

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── helpers that fill the fake repo ───

/** Lets the rich source machine upload into `gh` (v2 whole-repo, then optionally the slots and the global slot). */
async function publish(gh: FakeGitHub, what: { v2?: boolean; slots?: string[]; global?: boolean }): Promise<void> {
  const env = await makeEnv('full', gh);
  if (what.v2) await env.svc.upload();
  for (const pid of what.slots ?? []) {
    advance(1000);
    await env.svc.uploadSlot(pid);
  }
  if (what.global) {
    advance(2000);
    await env.svc.uploadGlobal();
  }
  gh.mark();
  advance(0);
}

/** Packs `json` under `dir` the way an upload would and writes the chunk files and manifest into the fake. */
async function seedBundle(gh: FakeGitHub, dir: string, json: string, tag = 'old1', extra: Doc = {}): Promise<ChunkManifest> {
  const { manifest, chunks } = await pack(json, dir);
  for (const entry of manifest.chunks) {
    const blob = chunks.get(entry.path)!;
    const newPath = entry.path.replace(/\.gz$/, `.${tag}.gz`);
    gh.seed(newPath, Buffer.from(await blob.arrayBuffer()));
    entry.path = newPath;
  }
  Object.assign(manifest, extra);
  gh.seed(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}

function flipLastByte(file: RepoFile): void {
  const bytes = Buffer.from(file.b64, 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  file.b64 = bytes.toString('base64');
}

const NOT_JSON = Buffer.from('this is not a manifest', 'utf8');

// ════════════════════════════════════════════════════════════════════════════════════════════
// G0 · device-local accounting (no network)
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('R6 step 0 · B · sync', () => {
  it('G0 local accounting, self-healing maps and the global content fingerprint', async () => {
    const env = await makeEnv('empty', new FakeGitHub(), false);
    const s = env.svc;
    const steps: Doc = {};
    steps['fresh'] = { token: s.getToken(), owner: s.getOwner(), repo: s.getRepoName(), configured: s.isConfigured(), autoSync: s.getAutoSyncEnabled() };
    s.setToken('  tok  '); s.setOwner(' who '); s.setRepoName('   ');
    steps['afterSetters'] = { token: s.getToken(), owner: s.getOwner(), repo: s.getRepoName(), configured: s.isConfigured() };
    s.setToken(''); s.setOwner('');
    steps['afterClear'] = { token: s.getToken(), owner: s.getOwner(), configured: s.isConfigured() };
    s.setAutoSyncEnabled(true);
    const autoOn = s.getAutoSyncEnabled();
    s.setAutoSyncEnabled(false);
    steps['autoSync'] = { on: autoOn, off: s.getAutoSyncEnabled() };
    s.setSyncBaseline('2026-01-01T00:00:00.000Z');
    s.setPendingSync(true);
    steps['scalar'] = { baseline: s.getSyncBaseline(), pending: s.hasPendingSync() };
    s.setSyncBaseline(''); s.setPendingSync(false);
    steps['scalarCleared'] = { baseline: s.getSyncBaseline(), pending: s.hasPendingSync() };
    s.setSlotBaseline('prof_a', 'T1'); s.setSlotBaseline('global', 'T2'); s.setSlotPending('prof_a', true); s.setSlotPending('prof_b', true);
    const filled = { baselines: s.getSlotBaselines(), pending: s.getSlotPendingMap() };
    s.setSlotBaseline('prof_a', ''); s.setSlotPending('prof_b', false);
    steps['slotMaps'] = { filled, after: { baselines: s.getSlotBaselines(), pending: s.getSlotPendingMap() } };
    const heal: Doc = {};
    for (const [label, raw] of [['brokenJson', '{bad'], ['array', '[1,2]'], ['string', '"s"'], ['null', 'null']] as const) {
      env.h.storage.setItem('aga_github_sync_baselines', raw);
      heal[label] = s.getSlotBaselines();
    }
    steps['selfHeal'] = heal;

    const base = {
      configs: { overlays: [1] }, prompts: { entries: [] }, customPresets: { a: {} },
      engineSettings: { b: '2', a: '1', aga_pending_input: 'draft' },
      builtinPromptOverrides: { version: 1, exportedAt: 'T1', entries: [], packId: 'x' },
      exportedAt: 'T1',
    };
    const text = JSON.stringify(base);
    const sameContentOtherTime = JSON.stringify({ ...base, exportedAt: 'T2', builtinPromptOverrides: { ...base.builtinPromptOverrides, exportedAt: 'T2' } });
    const reordered = JSON.stringify({ ...base, engineSettings: { aga_pending_input: 'other draft', a: '1', b: '2' } });
    const changed = JSON.stringify({ ...base, engineSettings: { b: '2', a: 'changed' } });
    const noOverrides = JSON.stringify({ ...base, builtinPromptOverrides: undefined });
    const fp = {
      base: await computeGlobalContentChecksum(text),
      sameContentOtherTime: await computeGlobalContentChecksum(sameContentOtherTime),
      reorderedAndVolatileChanged: await computeGlobalContentChecksum(reordered),
      changedSetting: await computeGlobalContentChecksum(changed),
      withoutOverrides: await computeGlobalContentChecksum(noOverrides),
    };
    await snapDoc('G0-local-accounting', { steps, fingerprints: fp, ls: dumpLocalStorage(env.h.storage) });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G1 · v2 whole-repo upload
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G1a v2 upload into an empty repo', async () => {
    const env = await makeEnv('full');
    const outcome = await outcomeOf(() => env.svc.upload(env.onStatus));
    await snapDoc('G1a-empty-repo', report(env, outcome, { baseline: env.svc.getSyncBaseline(), isSyncing: env.svc.isSyncing() }));
  });

  it('G1b v2 re-upload prunes the old generation, a stray file and tolerates a 409 on delete', async () => {
    const env = await makeEnv('full');
    await env.svc.upload();
    env.gh.seed('v2/stray.gz', 'stray');
    env.gh.seed('v2/sub/inner.gz', 'inner (a directory entry, ignored)');
    env.gh.mark();
    advance(60_000);
    env.gh.fault('DELETE', /\/contents\/v2\/state\.[0-9a-z]+\.gz$/, 409, 1);
    const outcome = await outcomeOf(() => env.svc.upload(env.onStatus));
    await snapDoc('G1b-old-generation', report(env, outcome, { baseline: env.svc.getSyncBaseline() }));
  });

  it('G1c v2 degraded export uploads nothing, force goes through', async () => {
    const env = await makeEnv('full');
    for (const id of ['img_avatar_a', 'img_hist_a1']) await env.h.images.delete(id);
    const blocked = await outcomeOf(() => env.svc.upload(env.onStatus));
    const blockedTrace = [...env.gh.trace];
    const forcedStatus: SyncStatus[] = [];
    const forced = await outcomeOf(() => env.svc.upload((s) => forcedStatus.push({ ...s }), { force: true }));
    await snapDoc('G1c-degraded', {
      blocked: { outcome: blocked, status: structuredClone(env.status), requests: blockedTrace.length },
      forced: { outcome: forced, status: forcedStatus, trace: env.gh.trace, baseline: env.svc.getSyncBaseline() },
      warnings: warnings(),
    });
  });

  it('G1d v2 upload failures name the failing stage', async () => {
    const out: Doc = {};

    const chunk = await makeEnv('full');
    chunk.gh.fault('PUT', /\/contents\/v2\/state\.[0-9a-z]+\.gz$/, 500);
    out['chunkPut500'] = report(chunk, await outcomeOf(() => chunk.svc.upload(chunk.onStatus)));

    const manifest = await makeEnv('full');
    manifest.gh.fault('PUT', /\/contents\/v2\/manifest\.json$/, 409);
    out['manifestPut409'] = report(manifest, await outcomeOf(() => manifest.svc.upload(manifest.onStatus)));

    const list = await makeEnv('full');
    list.gh.fault('GET', /\/contents\/v2$/, 500);
    out['listing500'] = report(list, await outcomeOf(() => list.svc.upload(list.onStatus)));

    const exporting = await makeEnv('full');
    vi.spyOn(exporting.h.backup, 'exportForSync').mockRejectedValue(new Error('export boom'));
    out['exportFails'] = report(exporting, await outcomeOf(() => exporting.svc.upload(exporting.onStatus)));

    const compress = await makeEnv('full');
    vi.stubGlobal('CompressionStream', class { constructor() { throw new Error('compress boom'); } });
    out['compressFails'] = report(compress, await outcomeOf(() => compress.svc.upload(compress.onStatus)));
    vi.unstubAllGlobals();

    await snapDoc('G1d-failures', out);
  });

  it('G1e v2 upload without configuration', async () => {
    const noToken = await makeEnv('empty', new FakeGitHub(), false);
    noToken.svc.setOwner(OWNER);
    const noOwner = await makeEnv('empty', new FakeGitHub(), false);
    noOwner.svc.setToken(GH_TOKEN);
    await snapDoc('G1e-not-configured', {
      noToken: await outcomeOf(() => noToken.svc.upload()),
      noOwner: await outcomeOf(() => noOwner.svc.upload()),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G2 · v2 download
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G2a v2 download restores the uploaded bundle through unpack and importAll', async () => {
    const gh = new FakeGitHub();
    await publish(gh, { v2: true });
    const env = await makeEnv('local', gh);
    const outcome = await outcomeOf(() => env.svc.download(env.onStatus));
    const manifest = JSON.parse(Buffer.from(gh.files.get('v2/manifest.json')!.b64, 'base64').toString('utf8')) as ChunkManifest;
    await snapDoc('G2a-download', report(env, outcome, {
      baselineIsManifestCreatedAt: env.svc.getSyncBaseline() === manifest.createdAt,
      databases: Object.keys(await dumpAllIdb()),
    }));
  });

  it('G2b v2 download without a cloud save, with a server error, with a damaged or missing chunk', async () => {
    const out: Doc = {};
    const none = await makeEnv('local');
    out['empty'] = report(none, await outcomeOf(() => none.svc.download(none.onStatus)));

    const gh500 = new FakeGitHub();
    gh500.fault('GET', /\/contents\/v2\/manifest\.json$/, 500);
    const e500 = await makeEnv('local', gh500);
    out['manifest500'] = report(e500, await outcomeOf(() => e500.svc.download(e500.onStatus)));

    const ghBad = new FakeGitHub();
    await publish(ghBad, { v2: true });
    flipLastByte(ghBad.files.get(ghBad.paths().find((p) => p.startsWith('v2/state.'))!)!);
    const bad = await makeEnv('local', ghBad);
    out['damagedChunk'] = report(bad, await outcomeOf(() => bad.svc.download(bad.onStatus)));

    const ghMissing = new FakeGitHub();
    await publish(ghMissing, { v2: true });
    ghMissing.files.delete(ghMissing.paths().find((p) => p.startsWith('v2/state.'))!);
    const missing = await makeEnv('local', ghMissing);
    out['missingChunk'] = report(missing, await outcomeOf(() => missing.svc.download(missing.onStatus)));

    await snapDoc('G2b-download-failures', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G3 · cloud info: the two queries diverge on a corrupted manifest
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G3 getCloudInfo throws on a corrupted manifest, getCloudSlotInfo answers exists:false', async () => {
    const out: Doc = {};

    const gh = new FakeGitHub();
    gh.seed('v2/manifest.json', NOT_JSON);
    gh.seed('slots/prof_x/manifest.json', NOT_JSON);
    gh.seed('global/manifest.json', NOT_JSON);
    const bad = await makeEnv('empty', gh);
    out['corruptedJson'] = {
      v2: await outcomeOf(() => bad.svc.getCloudInfo()),
      slot: await outcomeOf(() => bad.svc.getCloudSlotInfo('prof_x')),
      global: await outcomeOf(() => bad.svc.getCloudSlotInfo('global')),
      warnings: warnings(),
    };

    const ghEnc = new FakeGitHub();
    ghEnc.seed('v2/manifest.json', '{}', 'utf-8');
    ghEnc.seed('slots/prof_x/manifest.json', '{}', 'utf-8');
    const enc = await makeEnv('empty', ghEnc);
    out['unexpectedEncoding'] = {
      v2: await outcomeOf(() => enc.svc.getCloudInfo()),
      slot: await outcomeOf(() => enc.svc.getCloudSlotInfo('prof_x')),
    };

    const none = await makeEnv('empty');
    out['missing'] = {
      v2: await outcomeOf(() => none.svc.getCloudInfo()),
      slot: await outcomeOf(() => none.svc.getCloudSlotInfo('prof_x')),
      global: await outcomeOf(() => none.svc.getCloudSlotInfo('global')),
    };

    const gh500 = new FakeGitHub();
    gh500.fault('GET', /\/contents\/v2\/manifest\.json$/, 500);
    gh500.fault('GET', /\/contents\/slots\/prof_x\/manifest\.json$/, 403);
    const e500 = await makeEnv('empty', gh500);
    out['serverErrors'] = {
      v2: await outcomeOf(() => e500.svc.getCloudInfo()),
      slot: await outcomeOf(() => e500.svc.getCloudSlotInfo('prof_x')),
    };

    const ghOk = new FakeGitHub();
    await publish(ghOk, { v2: true, slots: ['prof_a'], global: true });
    const ok = await makeEnv('empty', ghOk);
    out['healthy'] = {
      v2: await outcomeOf(() => ok.svc.getCloudInfo()),
      slot: await outcomeOf(() => ok.svc.getCloudSlotInfo('prof_a')),
      global: await outcomeOf(() => ok.svc.getCloudSlotInfo('global')),
      invalidSlotId: await outcomeOf(() => ok.svc.getCloudSlotInfo('../evil')),
    };
    await snapDoc('G3-cloud-info', out);
  });

  it('G3b listCloudSlots skips orphans and corrupted manifests, detectCloudFormat tells the layouts apart', async () => {
    const out: Doc = {};

    const gh = new FakeGitHub();
    await publish(gh, { slots: ['prof_a'], global: true });
    gh.seed('slots/prof_bad/manifest.json', NOT_JSON);
    gh.seed('slots/prof_orphan/state.old.gz', 'no manifest next to me');
    gh.seed('slots/stray-file.txt', 'a file directly under slots/ is not a slot');
    const env = await makeEnv('empty', gh);
    out['list'] = { outcome: await outcomeOf(() => env.svc.listCloudSlots()), trace: gh.trace, warnings: warnings() };

    const ghAuth = new FakeGitHub();
    await publish(ghAuth, { slots: ['prof_a'] });
    ghAuth.fault('GET', /\/contents\/slots\/prof_a\/manifest\.json$/, 403);
    const auth = await makeEnv('empty', ghAuth);
    out['listAuthError'] = await outcomeOf(() => auth.svc.listCloudSlots());

    const formats: Doc = {};
    const empty = await makeEnv('empty');
    formats['empty'] = await outcomeOf(() => empty.svc.detectCloudFormat());
    const ghV2 = new FakeGitHub();
    await publish(ghV2, { v2: true });
    formats['v2'] = await outcomeOf(async () => (await makeEnv('empty', ghV2)).svc.detectCloudFormat());
    const ghV3 = new FakeGitHub();
    await publish(ghV3, { global: true });
    formats['v3FromGlobalOnly'] = await outcomeOf(async () => (await makeEnv('empty', ghV3)).svc.detectCloudFormat());
    const ghBoth = new FakeGitHub();
    await publish(ghBoth, { v2: true, slots: ['prof_a'] });
    formats['bothV2AndSlots'] = await outcomeOf(async () => (await makeEnv('empty', ghBoth)).svc.detectCloudFormat());
    out['formats'] = formats;
    await snapDoc('G3b-list-and-format', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G4 · conflict detection
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G4 detectConflict and detectSlotConflict against none / empty / equal / different baselines', async () => {
    const gh = new FakeGitHub();
    await publish(gh, { v2: true, slots: ['prof_a'], global: true });
    const env = await makeEnv('empty', gh);
    const v2 = JSON.parse(Buffer.from(gh.files.get('v2/manifest.json')!.b64, 'base64').toString('utf8')) as ChunkManifest;
    const slot = JSON.parse(Buffer.from(gh.files.get('slots/prof_a/manifest.json')!.b64, 'base64').toString('utf8')) as ChunkManifest;
    const glob = JSON.parse(Buffer.from(gh.files.get('global/manifest.json')!.b64, 'base64').toString('utf8')) as ChunkManifest;
    const s = env.svc;
    const rows: Doc[] = [];
    for (const [label, baseline] of [['no baseline', ''], ['equal', 'CREATED'], ['different', '2020-01-01T00:00:00.000Z']] as const) {
      s.setSyncBaseline(baseline === 'CREATED' ? v2.createdAt : baseline);
      s.setSlotBaseline('prof_a', baseline === 'CREATED' ? slot.createdAt : baseline);
      s.setSlotBaseline('global', baseline === 'CREATED' ? glob.createdAt : baseline);
      rows.push({
        label,
        v2: await outcomeOf(() => s.detectConflict()),
        slot: await outcomeOf(() => s.detectSlotConflict('prof_a')),
        global: await outcomeOf(() => s.detectSlotConflict('global')),
      });
    }
    const none = await makeEnv('empty');
    none.svc.setSyncBaseline('SOMETHING');
    const noCloud = {
      v2: await outcomeOf(() => none.svc.detectConflict()),
      slot: await outcomeOf(() => none.svc.detectSlotConflict('prof_a')),
    };
    await snapDoc('G4-conflict', { rows, noCloud });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G5 · slot upload
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G5a uploadSlot into an empty repo (manifest carries the slot display meta)', async () => {
    const env = await makeEnv('full');
    const outcome = await outcomeOf(async () => {
      const m = await env.svc.uploadSlot('prof_a', env.onStatus);
      return { manifestKeys: Object.keys(m), slotMeta: m.slotMeta, uploadedBy: m.uploadedBy };
    });
    await snapDoc('G5a-slot-empty-repo', report(env, outcome));
  });

  it('G5b uploadSlot again: only this directory is cleaned, a 404 and a 409 on delete are tolerated', async () => {
    const env = await makeEnv('full');
    await env.svc.uploadSlot('prof_a');
    await env.svc.uploadSlot('prof_b');
    env.gh.seed('slots/prof_a/stray-1.gz', 'stray one');
    env.gh.seed('slots/prof_a/stray-2.gz', 'stray two');
    env.gh.mark();
    advance(60_000);
    env.gh.fault('DELETE', /\/contents\/slots\/prof_a\/stray-1\.gz$/, 404);
    env.gh.fault('DELETE', /\/contents\/slots\/prof_a\/stray-2\.gz$/, 409);
    const outcome = await outcomeOf(async () => {
      const m = await env.svc.uploadSlot('prof_a', env.onStatus);
      return { chunks: m.chunks.map((c) => ({ name: c.name, path: c.path })) };
    });
    await snapDoc('G5b-slot-reupload', report(env, outcome, { baselines: env.svc.getSlotBaselines() }));
  });

  it('G5c uploadSlot refusals: degraded images, degraded world books, bad id, failures per stage', async () => {
    const out: Doc = {};

    const img = await makeEnv('full');
    await img.h.images.delete('img_avatar_a');
    out['degradedImages'] = report(img, await outcomeOf(() => img.svc.uploadSlot('prof_a', img.onStatus)), { requests: img.gh.trace.length });
    img.gh.mark();
    img.status.length = 0;
    out['degradedImagesForced'] = report(img, await outcomeOf(async () => {
      const m = await img.svc.uploadSlot('prof_a', img.onStatus, { force: true });
      return { chunks: m.chunks.length };
    }));

    const books = await makeEnv('full');
    await books.h.books.deleteWorldBook('prof_a', 'wb_a1');
    out['degradedWorldBooks'] = report(books, await outcomeOf(() => books.svc.uploadSlot('prof_a', books.onStatus)), { requests: books.gh.trace.length });

    const ids = await makeEnv('full');
    const badIds: Doc = {};
    for (const id of ['../evil', 'a b', 'global', '', 'ok-id_1']) badIds[id || '(empty)'] = await outcomeOf(() => ids.svc.uploadSlot(id));
    out['slotIds'] = badIds;

    const unknown = await makeEnv('full');
    out['unknownProfile'] = report(unknown, await outcomeOf(() => unknown.svc.uploadSlot('prof_nope', unknown.onStatus)));

    const chunk = await makeEnv('full');
    chunk.gh.fault('PUT', /\/contents\/slots\/prof_a\/state\.[0-9a-z]+\.gz$/, 500);
    out['chunkPut500'] = report(chunk, await outcomeOf(() => chunk.svc.uploadSlot('prof_a', chunk.onStatus)));

    const manifest = await makeEnv('full');
    manifest.gh.fault('PUT', /\/contents\/slots\/prof_a\/manifest\.json$/, 409);
    out['manifestPut409'] = report(manifest, await outcomeOf(() => manifest.svc.uploadSlot('prof_a', manifest.onStatus)));

    const list = await makeEnv('full');
    list.gh.fault('GET', /\/contents\/slots\/prof_a$/, 500);
    out['listing500'] = report(list, await outcomeOf(() => list.svc.uploadSlot('prof_a', list.onStatus)));

    const compress = await makeEnv('full');
    vi.stubGlobal('CompressionStream', class { constructor() { throw new Error('compress boom'); } });
    out['compressFails'] = report(compress, await outcomeOf(() => compress.svc.uploadSlot('prof_a', compress.onStatus)));
    vi.unstubAllGlobals();

    await snapDoc('G5c-slot-refusals', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G6 · global slot upload
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G6 uploadGlobal skips an unchanged settings bundle and uploads when the content changes', async () => {
    const env = await makeEnv('full');
    const first = await outcomeOf(() => env.svc.uploadGlobal(env.onStatus));
    const firstDoc = { outcome: first, status: [...env.status], trace: [...env.gh.trace], baselines: env.svc.getSlotBaselines() };

    env.status.length = 0; env.gh.mark(); advance(60_000);
    const same = await outcomeOf(() => env.svc.uploadGlobal(env.onStatus));
    const sameDoc = { outcome: same, status: [...env.status], trace: [...env.gh.trace] };

    env.status.length = 0; env.gh.mark(); advance(120_000);
    env.h.storage.setItem('aga_pending_input', 'a different draft');
    const volatile = await outcomeOf(() => env.svc.uploadGlobal(env.onStatus));
    const volatileDoc = { outcome: volatile, status: [...env.status], requests: env.gh.trace.length, trace: [...env.gh.trace] };

    env.status.length = 0; env.gh.mark(); advance(180_000);
    env.h.storage.setItem('aga-ui-theme', 'light');
    const changed = await outcomeOf(() => env.svc.uploadGlobal(env.onStatus));
    const changedDoc = { outcome: changed, status: [...env.status], trace: [...env.gh.trace], baselines: env.svc.getSlotBaselines() };

    const out: Doc = { first: firstDoc, unchanged: sameDoc, volatileKeyChanged: volatileDoc, themeChanged: changedDoc };

    const legacy = new FakeGitHub();
    await seedBundle(legacy, 'global', '{"bundleType":"global","note":"legacy manifest without contentChecksum"}');
    const l = await makeEnv('full', legacy);
    advance(240_000);
    out['remoteWithoutContentChecksum'] = report(l, await outcomeOf(() => l.svc.uploadGlobal(l.onStatus)));

    const e500 = new FakeGitHub();
    e500.fault('GET', /\/contents\/global\/manifest\.json$/, 500);
    const f = await makeEnv('full', e500);
    out['manifestFetch500'] = report(f, await outcomeOf(() => f.svc.uploadGlobal(f.onStatus)));

    const ex = await makeEnv('full');
    vi.spyOn(ex.h.backup, 'exportGlobalForSync').mockRejectedValue(new Error('export boom'));
    out['exportFails'] = report(ex, await outcomeOf(() => ex.svc.uploadGlobal(ex.onStatus)));

    await snapDoc('G6-global-upload', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G7 · slot and global download
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G7a downloadSlot replaces the profile through importProfileReplace and moves the slot baseline', async () => {
    const gh = new FakeGitHub();
    await publish(gh, { slots: ['prof_a'] });
    const env = await makeEnv('local', gh);
    const outcome = await outcomeOf(() => env.svc.downloadSlot('prof_a', env.onStatus));
    const manifest = JSON.parse(Buffer.from(gh.files.get('slots/prof_a/manifest.json')!.b64, 'base64').toString('utf8')) as ChunkManifest;
    await snapDoc('G7a-download-slot', report(env, outcome, {
      baselineIsManifestCreatedAt: env.svc.getSlotBaselines()['prof_a'] === manifest.createdAt,
      profileIds: env.h.backup.listProfileIds(),
    }));
  });

  it('G7b downloadSlot failures: nothing there, bad id, damaged chunk, wrong bundle type, server error', async () => {
    const out: Doc = {};
    const none = await makeEnv('local');
    out['nothing'] = report(none, await outcomeOf(() => none.svc.downloadSlot('prof_a', none.onStatus)));
    out['badId'] = await outcomeOf(() => none.svc.downloadSlot('../x', none.onStatus));

    const gh = new FakeGitHub();
    await publish(gh, { slots: ['prof_a'] });
    flipLastByte(gh.files.get(gh.paths().find((p) => p.startsWith('slots/prof_a/state.'))!)!);
    const bad = await makeEnv('local', gh);
    out['damagedChunk'] = report(bad, await outcomeOf(() => bad.svc.downloadSlot('prof_a', bad.onStatus)));

    const full = await makeEnv('full');
    const fullJson = await (await full.h.backup.exportAll()).text();
    const ghFull = new FakeGitHub();
    await seedBundle(ghFull, 'slots/prof_a', fullJson);
    const wrong = await makeEnv('local', ghFull);
    out['fullBundleInSlot'] = report(wrong, await outcomeOf(() => wrong.svc.downloadSlot('prof_a', wrong.onStatus)));

    const gh500 = new FakeGitHub();
    gh500.fault('GET', /\/contents\/slots\/prof_a\/manifest\.json$/, 500);
    const e500 = await makeEnv('local', gh500);
    out['manifest500'] = report(e500, await outcomeOf(() => e500.svc.downloadSlot('prof_a', e500.onStatus)));
    await snapDoc('G7b-download-slot-failures', out);
  });

  it('G7c downloadGlobal applies the settings, and refuses anything that is not a global bundle', async () => {
    const out: Doc = {};
    const gh = new FakeGitHub();
    await publish(gh, { global: true });
    const env = await makeEnv('local', gh);
    out['success'] = report(env, await outcomeOf(() => env.svc.downloadGlobal(env.onStatus)), {
      baseline: env.svc.getSlotBaselines()['global'] !== undefined,
    });

    const none = await makeEnv('local');
    out['nothing'] = report(none, await outcomeOf(() => none.svc.downloadGlobal(none.onStatus)));

    const full = await makeEnv('full');
    const fullJson = await (await full.h.backup.exportAll()).text();
    const noType = JSON.stringify({ ...(JSON.parse(fullJson) as Doc), bundleType: undefined }, null, 2);
    for (const [label, json] of [['fullBundleInGlobal', fullJson], ['bundleWithoutType', noType]] as const) {
      const g = new FakeGitHub();
      await seedBundle(g, 'global', json);
      const e = await makeEnv('local', g);
      out[label] = report(e, await outcomeOf(() => e.svc.downloadGlobal(e.onStatus)));
    }

    const gh500 = new FakeGitHub();
    gh500.fault('GET', /\/contents\/global\/manifest\.json$/, 500);
    const e500 = await makeEnv('local', gh500);
    out['manifest500'] = report(e500, await outcomeOf(() => e500.svc.downloadGlobal(e500.onStatus)));
    await snapDoc('G7c-download-global', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G8 · delete a cloud slot
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G8 deleteCloudSlot removes the manifest first and then the chunks, and clears the device bookkeeping', async () => {
    const out: Doc = {};

    const env = await makeEnv('full');
    await env.svc.uploadSlot('prof_a');
    await env.svc.uploadSlot('prof_b');
    env.svc.setSlotPending('prof_a', true);
    env.gh.seed('slots/prof_a/stray.gz', 'stray');
    env.gh.mark();
    out['success'] = report(env, await outcomeOf(() => env.svc.deleteCloudSlot('prof_a', env.onStatus)), {
      baselines: env.svc.getSlotBaselines(), pending: env.svc.getSlotPendingMap(),
    });

    const none = await makeEnv('full');
    out['nothingThere'] = report(none, await outcomeOf(() => none.svc.deleteCloudSlot('prof_a', none.onStatus)));
    out['badId'] = await outcomeOf(() => none.svc.deleteCloudSlot('global', none.onStatus));

    const man = await makeEnv('full');
    await man.svc.uploadSlot('prof_a');
    man.svc.setSlotPending('prof_a', true);
    man.gh.mark();
    man.gh.fault('DELETE', /\/contents\/slots\/prof_a\/manifest\.json$/, 500);
    out['manifestDelete500'] = report(man, await outcomeOf(() => man.svc.deleteCloudSlot('prof_a', man.onStatus)), {
      baselines: man.svc.getSlotBaselines(), pending: man.svc.getSlotPendingMap(),
    });

    const tol = await makeEnv('full');
    await tol.svc.uploadSlot('prof_a');
    tol.gh.mark();
    tol.gh.fault('DELETE', /\/contents\/slots\/prof_a\/state\.[0-9a-z]+\.gz$/, 409);
    out['chunkDelete409Retried'] = report(tol, await outcomeOf(() => tol.svc.deleteCloudSlot('prof_a', tol.onStatus)));

    const list = await makeEnv('full');
    list.gh.fault('GET', /\/contents\/slots\/prof_a$/, 500);
    out['listing500'] = report(list, await outcomeOf(() => list.svc.deleteCloudSlot('prof_a', list.onStatus)));
    await snapDoc('G8-delete-slot', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G9 · v2 -> v3 migration
  // ──────────────────────────────────────────────────────────────────────────────────────────

  /** A source machine whose cloud holds a v2 upload; the trace starts after it. */
  async function v2Source(): Promise<Env> {
    const env = await makeEnv('full');
    await env.svc.upload();
    env.gh.mark();
    advance(60_000);
    return env;
  }

  it('G9a migrateToSlots uploads every profile and global, verifies by reading back, then retires the v2 manifest', async () => {
    const env = await v2Source();
    const progress: unknown[] = [];
    const outcome = await outcomeOf(() => env.svc.migrateToSlots(env.onStatus, (p) => progress.push({ ...p })));
    await snapDoc('G9a-migrate', report(env, outcome, {
      progress,
      baselines: env.svc.getSlotBaselines(),
      scalarBaselineAfter: env.svc.getSyncBaseline(),
      scalarPendingAfter: env.svc.hasPendingSync(),
    }));
  });

  it('G9b migration verification failures abort and leave the v2 manifest alone', async () => {
    const out: Doc = {};

    const sum = await v2Source();
    sum.gh.onPut = (path, file) => {
      if (path !== 'slots/prof_a/manifest.json') return;
      const manifest = JSON.parse(Buffer.from(file.b64, 'base64').toString('utf8')) as ChunkManifest;
      manifest.bundleChecksum = 'tampered';
      file.b64 = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8').toString('base64');
    };
    out['checksumMismatch'] = report(sum, await outcomeOf(() => sum.svc.migrateToSlots(sum.onStatus)), {
      v2ManifestStillThere: sum.gh.has('v2/manifest.json'),
      scalarBaselineAfter: sum.svc.getSyncBaseline(),
    });

    const bytes = await v2Source();
    bytes.gh.onPut = (path, file) => { if (/^slots\/prof_a\/state\.[0-9a-z]+\.gz$/.test(path)) flipLastByte(file); };
    out['chunkBytesDamaged'] = report(bytes, await outcomeOf(() => bytes.svc.migrateToSlots(bytes.onStatus)), {
      v2ManifestStillThere: bytes.gh.has('v2/manifest.json'),
    });

    const deg = await v2Source();
    await deg.h.images.delete('img_avatar_b');
    out['degradedSecondProfile'] = report(deg, await outcomeOf(() => deg.svc.migrateToSlots(deg.onStatus)), {
      v2ManifestStillThere: deg.gh.has('v2/manifest.json'),
    });
    await snapDoc('G9b-migrate-failures', out);
  });

  it('G9c migration finishes even when the v2 manifest cannot be removed, or is already gone', async () => {
    const out: Doc = {};

    const retire = await v2Source();
    retire.gh.fault('DELETE', /\/contents\/v2\/manifest\.json$/, 500);
    out['retire500'] = report(retire, await outcomeOf(() => retire.svc.migrateToSlots(retire.onStatus)), {
      v2ManifestStillThere: retire.gh.has('v2/manifest.json'),
      scalarBaselineAfter: retire.svc.getSyncBaseline(),
    });

    const gone = await makeEnv('full');
    advance(60_000);
    out['noV2Manifest'] = report(gone, await outcomeOf(() => gone.svc.migrateToSlots(gone.onStatus)));
    await snapDoc('G9c-migrate-finish', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G10 · the in-flight lock
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G10 every cloud operation refuses to start while another one is running, and the lock is released afterwards', async () => {
    const env = await makeEnv('full');
    let release: () => void = () => undefined;
    env.gh.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = env.svc.upload(env.onStatus);
    const refused: Doc = {};
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['upload', () => env.svc.upload()],
      ['download', () => env.svc.download()],
      ['uploadSlot', () => env.svc.uploadSlot('prof_a')],
      ['uploadGlobal', () => env.svc.uploadGlobal()],
      ['downloadSlot', () => env.svc.downloadSlot('prof_a')],
      ['downloadGlobal', () => env.svc.downloadGlobal()],
      ['deleteCloudSlot', () => env.svc.deleteCloudSlot('prof_a')],
      ['migrateToSlots', () => env.svc.migrateToSlots()],
    ];
    // wait until the first request is parked at the gate, so the count below does not depend on timing
    while (env.gh.trace.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const syncingWhileRunning = env.svc.isSyncing();
    for (const [name, call] of calls) refused[name] = await outcomeOf(call);
    const requestsWhileBlocked = env.gh.trace.length;
    release();
    const firstOutcome = await outcomeOf(() => first);
    const afterSuccess = env.svc.isSyncing();

    env.gh.fault('PUT', /\/contents\/v2\/manifest\.json$/, 500);
    advance(60_000);
    const failing = await outcomeOf(() => env.svc.upload());
    const afterFailure = env.svc.isSyncing();
    advance(120_000);
    const retried = await outcomeOf(() => env.svc.upload());
    await snapDoc('G10-lock', {
      syncingWhileRunning, refused, requestsWhileBlocked, firstOutcome, afterSuccess,
      failing, afterFailure, retried, finalSyncing: env.svc.isSyncing(),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G11 · validate
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G11 validate: token, user lookup, owner, repository', async () => {
    const out: Doc = {};

    const noToken = await makeEnv('empty', new FakeGitHub(), false);
    out['noToken'] = { outcome: await outcomeOf(() => noToken.svc.validate()), requests: noToken.gh.trace.length };

    const ok = await makeEnv('empty', new FakeGitHub(), false);
    ok.svc.setToken(GH_TOKEN);
    out['userLookupSetsOwner'] = { outcome: await outcomeOf(() => ok.svc.validate()), owner: ok.svc.getOwner(), trace: ok.gh.trace };

    const forbidden = new FakeGitHub();
    forbidden.fault('GET', /^\/user$/, 403);
    const noOwner = await makeEnv('empty', forbidden, false);
    noOwner.svc.setToken(GH_TOKEN);
    out['user403NoOwner'] = { outcome: await outcomeOf(() => noOwner.svc.validate()), trace: noOwner.gh.trace };

    const forbidden2 = new FakeGitHub();
    forbidden2.fault('GET', /^\/user$/, 403);
    const withOwner = await makeEnv('empty', forbidden2);
    out['user403WithOwner'] = { outcome: await outcomeOf(() => withOwner.svc.validate()), trace: withOwner.gh.trace };

    const missingRepo = new FakeGitHub();
    missingRepo.fault('GET', new RegExp(`^${API_ROOT}$`), 404);
    const noRepo = await makeEnv('empty', missingRepo);
    out['repo404'] = await outcomeOf(() => noRepo.svc.validate());

    const brokenRepo = new FakeGitHub();
    brokenRepo.fault('GET', new RegExp(`^${API_ROOT}$`), 500);
    const e500 = await makeEnv('empty', brokenRepo);
    out['repo500'] = await outcomeOf(() => e500.svc.validate());
    await snapDoc('G11-validate', out);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // G12 · v2 revival
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('G12 checkV2Revival: absent, present, corrupted, server error', async () => {
    const out: Doc = {};
    const none = await makeEnv('empty');
    out['absent'] = { outcome: await outcomeOf(() => none.svc.checkV2Revival()), trace: none.gh.trace };

    const gh = new FakeGitHub();
    await publish(gh, { v2: true });
    const present = await makeEnv('empty', gh);
    out['present'] = await outcomeOf(() => present.svc.checkV2Revival());

    const bad = new FakeGitHub();
    bad.seed('v2/manifest.json', NOT_JSON);
    const corrupted = await makeEnv('empty', bad);
    out['corrupted'] = await outcomeOf(() => corrupted.svc.checkV2Revival());

    const err = new FakeGitHub();
    err.fault('GET', /\/contents\/v2\/manifest\.json$/, 500);
    const e500 = await makeEnv('empty', err);
    out['server500'] = await outcomeOf(() => e500.svc.checkV2Revival());
    await snapDoc('G12-v2-revival', out);
  });
});
