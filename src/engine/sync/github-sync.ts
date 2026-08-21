// Archived research: docs/design/archive/cloud-sync-options.md
// App doc: docs/user-guide/cloud-sync.md, docs/user-guide/pages/game-save.md §2.2 + §7.5 (上传保护) + §7.6 (自动同步冲突), docs/user-guide/pages/home.md §1.3.3
/**
 * GitHub Sync Service — 通过 GitHub Contents API 实现存档云同步
 *
 * API 参考：https://docs.github.com/en/rest/repos/contents
 *
 * 前提条件：
 * - 用户手动创建一个私有仓库（如 aga-cloud-save），勾选 auto_init
 * - 创建 Fine-grained PAT，权限：Contents → Read & Write，仅限该仓库
 * - 或创建 Classic PAT，scope: repo
 *
 * 设计：
 * - 不自动创建仓库（避免需要 Administration 权限）
 * - 纯浏览器实现，api.github.com 原生 CORS
 * - 全覆盖语义：上传覆盖云端，下载覆盖本地
 * - 用户需提供 GitHub 用户名（fine-grained PAT 可能无法通过 GET /user 获取）
 */

import type { BackupService, ExportImageIntegrity, ProfileDisplayMeta } from '../persistence/backup-service';
import { packChunks, unpack, sha256String, sha256Blob, type ChunkManifest } from './chunked-bundle-packer';
import { getDeviceStamp } from './device-identity';

// ─── 常量 ───

const API = 'https://api.github.com';
const SAVE_PATH = 'backup.json';
const MANIFEST_PATH = 'v2/manifest.json';
const V2_DIR = 'v2';
const LS_TOKEN = 'aga_github_sync_token';
const LS_OWNER = 'aga_github_sync_owner';
const LS_REPO = 'aga_github_sync_repo';
// Auto-sync toggle (portable preference) + device-local conflict baseline.
// The baseline is EXCLUDED from backup/cloud collection (backup-service.ts
// LS_DEVICE_LOCAL_KEYS): it is *this* device's view of the last-synced cloud
// manifest createdAt and must never travel, or another device would mis-detect
// conflicts. See docs/design/github-auto-sync-design.md §5 + §7.
const LS_AUTOSYNC = 'aga_github_autosync_enabled';
const LS_BASELINE = 'aga_github_sync_baseline';
// Device-local "there is a local save not yet auto-uploaded" flag. Persisted (not a
// same-session ref) so a failed tail-flush is retried next session, and so a fresh
// session that left data unsynced still uploads. Excluded from backup alongside the
// baseline (backup-service LS_DEVICE_LOCAL_KEYS).
const LS_PENDING = 'aga_github_sync_pending';
const DEFAULT_REPO = 'aga-cloud-save';
const API_VERSION = '2022-11-28';

// ─── v3 存档插槽（docs/design/github-save-slots-design.md）───
// 一个角色档案一个云端目录 slots/<profileId>/，全局设置独立 global/。
// baselines/pending 从单标量变为按插槽的 JSON map（仍是设备本地键，
// 与旧键一起列于 backup-service LS_DEVICE_LOCAL_KEYS 四处排除）。
const SLOTS_DIR = 'slots';
const GLOBAL_DIR = 'global';
const LS_BASELINES = 'aga_github_sync_baselines';
const LS_PENDING_MAP = 'aga_github_sync_pending_map';
/** 全局设置插槽在 baselines/conflict API 中使用的 slotKey。 */
export const GLOBAL_SLOT_KEY = 'global';

// ─── 类型 ───

export interface SyncStatus {
  stage: 'idle' | 'checking' | 'uploading' | 'downloading' | 'done' | 'error';
  message: string;
}

export interface DegradedUploadDetail {
  /** distinct image asset ids referenced by the local save being exported */
  referencedAssets: number;
  /** how many of those were actually exported (fewer = local image cache evicted) */
  exportedAssets: number;
  /** referencedAssets − exportedAssets: images that would be MISSING from the upload */
  missingAssets: number;
}

/**
 * Thrown by {@link GitHubSyncService.upload} BEFORE any cloud file is touched when
 * the outgoing backup references more image assets than it could actually export —
 * i.e. the local image cache was evicted (TOTALLY or PARTIALLY), so uploading would
 * replace a healthy cloud save with an image-degraded one. The UI catches this,
 * shows the specifics, and may re-call upload with `{ force: true }` after explicit
 * user confirmation. Primary guard against the 2026-07-10 class of incident.
 */
export class DegradedUploadError extends Error {
  constructor(public readonly detail: DegradedUploadDetail) {
    super('degraded-upload-blocked');
    this.name = 'DegradedUploadError';
  }
}

/** Cloud-save summary returned by {@link GitHubSyncService.getCloudInfo}. */
export interface CloudInfo {
  exists: boolean;
  updatedAt?: string;
  sizeKB?: number;
  /** 上传该云端版本的设备（manifest `uploadedBy` 审计戳；旧 manifest 无此字段）。 */
  uploadedByLabel?: string;
  uploadedByDeviceId?: string;
}

/**
 * Thrown by {@link GitHubSyncService.upload} / {@link GitHubSyncService.download}
 * when another cloud operation is already in flight. Upload and download share ONE
 * lock so that WITHIN A TAB a manual action and an automatic one (or the on-exit
 * flush) never interleave and race on the manifest/chunk PUTs. Callers that
 * opportunistically trigger sync (auto-upload) should check
 * {@link GitHubSyncService.isSyncing} first and skip rather than catch.
 *
 * NOTE — scope is per-tab: `_syncInFlight` is an instance field, and there is one
 * service instance per browser tab, so two tabs of the same origin are NOT
 * serialized by this lock. Cross-tab races are de-risked (not eliminated) by the
 * unchanged upload atomicity: chunks go to per-upload generation paths, and the
 * manifest PUT carries a `sha` precondition, so GitHub 409s the losing writer
 * rather than silently accepting a stale overwrite (the loser's orphan chunks are
 * pruned on the next successful upload). No silent corruption, but not a universal
 * cross-tab mutex.
 */
export class SyncInProgressError extends Error {
  constructor() {
    super('sync-in-progress');
    this.name = 'SyncInProgressError';
  }
}

/** Result of {@link GitHubSyncService.detectConflict}. */
export interface ConflictCheck {
  /** true ⇒ cloud changed since this device last synced (or a fresh device meets a non-empty cloud). */
  conflict: boolean;
  cloud: CloudInfo;
}

/** 云端仓库格式（v3 插槽 / v2 全量 / 空仓）。分派 UI 与自动同步走哪条管线。 */
export type CloudFormat = 'v3' | 'v2' | 'empty';

/** 插槽 manifest = 分块 manifest + 档案展示元信息（列表 UI 免下载整包）。 */
export interface SlotManifest extends ChunkManifest {
  slotMeta?: ProfileDisplayMeta;
  /**
   * 全局设置插槽专用：**内容**指纹（剔除 exportedAt 等每次导出必变的时间戳字段后
   * 计算的 SHA-256）。跳传判断必须用它而非 bundleChecksum —— bundleChecksum 覆盖
   * 完整 JSON（含时间戳），同样的设置每次导出哈希都不同，用它比对会导致"永不跳过、
   * 每回合白传"（code review 2026-07-23 Critical #1）。
   */
  contentChecksum?: string;
}

/** migrateToSlots 的结果。 */
export interface MigrationResult {
  /** 已上传并通过验证闸的插槽（含 global，若其未因内容相同被跳过） */
  slots: Array<{ slotKey: string; verified: boolean }>;
  /** v2/manifest.json 是否已成功下线（false = 可重试，迁移本身已实质完成） */
  v2Cleaned: boolean;
}

/** listCloudSlots 返回的插槽卡片数据。 */
export interface CloudSlotInfo {
  /** profileId，或 GLOBAL_SLOT_KEY（全局设置插槽） */
  slotKey: string;
  updatedAt: string;
  sizeKB: number;
  profileName?: string;
  packId?: string;
  slotCount?: number;
  lastPlayedAt?: string | null;
  /** 上传该插槽当前版本的设备（manifest `uploadedBy` 审计戳；旧 manifest 无此字段）。 */
  uploadedByLabel?: string;
  uploadedByDeviceId?: string;
}

// ─── 服务 ───

export class GitHubSyncService {
  constructor(private backup: BackupService) {}

  /**
   * Single in-flight guard shared by upload() and download(). Only one cloud
   * read-or-write runs at a time, so a manual action and an automatic one (or the
   * on-exit flush) never interleave and race on the manifest/chunk PUTs.
   */
  private _syncInFlight = false;

  // ── 配置读写 ──

  getToken(): string { return localStorage.getItem(LS_TOKEN) ?? ''; }
  setToken(v: string): void { v.trim() ? localStorage.setItem(LS_TOKEN, v.trim()) : localStorage.removeItem(LS_TOKEN); }

  getOwner(): string { return localStorage.getItem(LS_OWNER) ?? ''; }
  setOwner(v: string): void { v.trim() ? localStorage.setItem(LS_OWNER, v.trim()) : localStorage.removeItem(LS_OWNER); }

  getRepoName(): string { return localStorage.getItem(LS_REPO) || DEFAULT_REPO; }
  setRepoName(v: string): void { localStorage.setItem(LS_REPO, v.trim() || DEFAULT_REPO); }

  isConfigured(): boolean { return !!(this.getToken() && this.getOwner()); }

  // ── 自动同步开关（可移植偏好）──

  /** Whether auto-upload-on-next-round is enabled. Off by default. */
  getAutoSyncEnabled(): boolean { return localStorage.getItem(LS_AUTOSYNC) === '1'; }
  setAutoSyncEnabled(v: boolean): void {
    if (v) localStorage.setItem(LS_AUTOSYNC, '1');
    else localStorage.removeItem(LS_AUTOSYNC);
  }

  // ── 冲突基线（设备本地，绝不随备份/云同步迁移）──

  /**
   * This device's view of the cloud manifest `createdAt` it last synced to (via a
   * successful upload OR download). Empty string = never synced from this device.
   */
  getSyncBaseline(): string { return localStorage.getItem(LS_BASELINE) ?? ''; }
  setSyncBaseline(createdAt: string): void {
    if (createdAt) localStorage.setItem(LS_BASELINE, createdAt);
    else localStorage.removeItem(LS_BASELINE);
  }

  /**
   * "This device has a local save not yet successfully auto-uploaded." Persisted so
   * it survives across sessions: a tail-flush that failed on close (browser killed
   * the request) is retried on the next launch, and a session that left data unsynced
   * still uploads. Set on every save, cleared only when an upload that covered that
   * save succeeds (the caller compares an in-memory save epoch to avoid clearing a
   * newer save that landed mid-upload). Device-local — excluded from backup.
   */
  hasPendingSync(): boolean { return localStorage.getItem(LS_PENDING) === '1'; }
  setPendingSync(pending: boolean): void {
    if (pending) localStorage.setItem(LS_PENDING, '1');
    else localStorage.removeItem(LS_PENDING);
  }

  /** True while an upload or download is running. Auto-triggers should skip when set. */
  isSyncing(): boolean { return this._syncInFlight; }

  /**
   * Compare the current cloud save against this device's sync baseline.
   *
   * conflict === true means the cloud moved on since we last synced — either a
   * DIFFERENT device (or session) uploaded after our baseline, OR this is a fresh
   * device (empty baseline) meeting a non-empty cloud. In both cases an automatic
   * upload would silently clobber a cloud save the user may still want, so the
   * caller must confirm first (docs/design/github-auto-sync-design.md §5). An
   * imageless/empty cloud (`exists === false`) is never a conflict.
   */
  async detectConflict(): Promise<ConflictCheck> {
    const cloud = await this.getCloudInfo();
    if (!cloud.exists) return { conflict: false, cloud };
    const baseline = this.getSyncBaseline();
    const conflict = !baseline || cloud.updatedAt !== baseline;
    return { conflict, cloud };
  }

  // ── 验证连接 ──

  async validate(): Promise<{ ok: boolean; error?: string }> {
    if (!this.getToken()) return { ok: false, error: '请填写 Token' };

    // 1. 尝试 GET /user 自动获取用户名
    try {
      const user = await this.get<{ login: string }>('/user');
      if (user.login) this.setOwner(user.login);
    } catch {
      // fine-grained PAT 可能 403 — 需要用户手动填写用户名
    }

    // 2. 检查 owner 是否已知
    const owner = this.getOwner();
    if (!owner) {
      return { ok: false, error: '无法自动获取用户名，请手动填写 GitHub 用户名' };
    }

    // 3. 验证能否访问目标仓库
    const repo = this.getRepoName();
    try {
      await this.get(`/repos/${owner}/${repo}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { ok: false, error: `仓库 ${owner}/${repo} 不存在。请先在 GitHub 上手动创建该私有仓库。` };
      }
      return { ok: false, error: fmtErr(err) };
    }
  }

  // ── 上传存档（v2 分块管道）──

  /**
   * Upload the local save to the cloud (full overwrite). Serialized against any
   * other cloud op via the shared in-flight lock — throws {@link SyncInProgressError}
   * if one is already running. On success, records the committed manifest's
   * `createdAt` as this device's sync baseline (feeds conflict detection).
   */
  async upload(onStatus?: (s: SyncStatus) => void, opts?: { force?: boolean }): Promise<void> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      await this._uploadLocked(onStatus, opts);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _uploadLocked(onStatus?: (s: SyncStatus) => void, opts?: { force?: boolean }): Promise<void> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('uploading', '正在导出存档…');
    let exportBlob: Blob;
    let imageIntegrity: ExportImageIntegrity;
    try {
      // Atomic export: the blob AND its image integrity come from the SAME call, so
      // the guard evaluates exactly this export (no shared-field TOCTOU with a
      // concurrent export).
      ({ blob: exportBlob, imageIntegrity } = await this.backup.exportForSync());
    } catch (err) {
      throw stageError('导出存档', err);
    }
    const approxMB = Math.round(exportBlob.size / 1_048_576);

    // ── Overwrite guardrail (hard block unless forced) ──
    // Runs BEFORE any cloud file is created/overwritten, so a block leaves the cloud
    // save fully intact. Fires whenever the export references MORE image assets than
    // it could actually produce (referencedAssets > exportedAssets) — the local
    // image cache was evicted, TOTALLY (21→0, the reported incident) or PARTIALLY
    // (21→15). An internally-consistent export (referenced === exported, incl. a
    // legitimately imageless save) is never blocked, so deliberate profile/image
    // deletion uploads freely without a false alarm.
    if (!opts?.force && imageIntegrity.referencedAssets > imageIntegrity.exportedAssets) {
      throw new DegradedUploadError({
        referencedAssets: imageIntegrity.referencedAssets,
        exportedAssets: imageIntegrity.exportedAssets,
        missingAssets: imageIntegrity.referencedAssets - imageIntegrity.exportedAssets,
      });
    }

    // Batch-fetch the existing v2/ listing up front (needed for the manifest.json
    // SHA on the in-place manifest write, and for cleaning up old chunks after the
    // commit). Must run BEFORE the first chunk PUT.
    let existingFiles: Array<{ path: string; sha: string }>;
    try {
      existingFiles = await this.listV2Files(owner, repo);
    } catch (err) {
      throw stageError('读取云端文件列表', err);
    }

    // STREAMING pack + upload: compress ONE chunk, PUT it, release it, then
    // compress the next — memory stays bounded to ~one chunk instead of holding
    // the whole compressed set. The eager pack() held every compressed chunk in a
    // Map and OOM-crashed the tab on 110MB+ base64-image saves; feeding the Blob
    // (not exportBlob.text()) also keeps the decoded JSON string generator-local
    // so the caller never holds a second ~100MB copy.
    //
    // ATOMICITY (2026-07-09 audit fix): each chunk is written to a per-upload,
    // GENERATION-SUFFIXED path (v2/state-0.<genTag>.gz), never the bare path a
    // PRIOR upload used. So a re-upload can NEVER overwrite a chunk the CURRENT
    // cloud manifest still references. Combined with writing the manifest LAST,
    // this makes an interrupted upload truly non-destructive: the old manifest
    // keeps pointing at its old chunks, whose bytes are untouched (the new bytes
    // went to fresh paths), so the previously-healthy cloud save stays
    // downloadable. Old-generation chunks are pruned by cleanupStaleFromList only
    // AFTER the new manifest commits. (Previously chunks were overwritten in place
    // at stable paths, so an interrupted upload could brick the live save — the
    // "old chunks intact" claim was false whenever a path was reused.)
    const genTag = uploadGenTag();
    emit('uploading', '正在压缩并上传…');
    const gen = packChunks(exportBlob);
    let res: IteratorResult<{ path: string; blob: Blob }, ChunkManifest>;
    try {
      res = await gen.next();
    } catch (err) {
      throw stageError(`压缩存档（约 ${approxMB}MB）`, err);
    }
    let uploaded = 0;
    const genPathByOriginal = new Map<string, string>();
    while (!res.done) {
      const { path, blob } = res.value;
      const genPath = withGenTag(path, genTag);
      genPathByOriginal.set(path, genPath);
      uploaded++;
      emit('uploading', `正在压缩并上传分块 ${uploaded}…`);
      try {
        // Fresh generation path → always a NEW file → create (no SHA, never an
        // in-place overwrite of a live-referenced chunk).
        await this.uploadFile(owner, repo, genPath, await blobToBase64(blob), undefined);
      } catch (err) {
        throw stageError(`上传分块 ${genPath}`, err);
      }
      // Advance the generator only after the current chunk is uploaded + released,
      // so the next chunk's compression peak never overlaps a retained prior chunk.
      try {
        res = await gen.next();
      } catch (err) {
        throw stageError(`压缩存档（约 ${approxMB}MB）`, err);
      }
    }
    const manifest = res.value;
    // Point the manifest at the generation-suffixed paths we actually wrote, so a
    // download fetches the freshly-written chunks. (Names stay canonical —
    // 'state'/'state-N'/'img-N' — only paths carry the generation tag.)
    for (const c of manifest.chunks) {
      const gp = genPathByOriginal.get(c.path);
      if (gp) c.path = gp;
    }
    manifest.uploadedBy = getDeviceStamp();

    // The manifest is written LAST so it is the commit point: if any chunk PUT
    // above fails, the cloud still has the OLD manifest pointing at OLD chunks,
    // so a partial upload can never be silently downloaded as wrong data (it
    // fails loudly via the per-chunk SHA-256 check on download).
    emit('uploading', '正在更新索引…');
    try {
      const manifestJson = JSON.stringify(manifest, null, 2);
      await this.putManifestFresh(owner, repo, MANIFEST_PATH, utf8ToBase64(manifestJson));
    } catch (err) {
      throw stageError('更新云端索引', err);
    }

    // Commit point reached: the manifest now points at the freshly-written chunks,
    // so cloud == this export. Record its createdAt as our baseline BEFORE the
    // best-effort cleanup, so conflict detection treats a later interrupted cleanup
    // as already-synced (the save is valid) rather than a phantom conflict.
    this.setSyncBaseline(manifest.createdAt);

    // Cleanup stale chunks — AWAITED, still inside the shared upload lock, so the
    // NEXT upload cannot start until this cleanup finishes. That serialization is
    // what prevents the 2026-07-13 "409 storm": previously cleanup was
    // fire-and-forget, so back-to-back uploads' DELETEs raced each other with
    // stale shas and every prior generation piled up as orphans. Best-effort:
    // wrapped so a cleanup failure never fails an ALREADY-committed upload (the
    // manifest + its chunks are safe; leftover orphans are pruned next time).
    emit('uploading', '正在清理旧分块…');
    try {
      await this.cleanupStaleFromList(owner, repo, manifest, existingFiles);
    } catch { /* best-effort — orphans are harmless and retried on the next upload */ }

    emit('done', '上传完成');
  }

  // ── v1 上传方法（保留供紧急回退，当前不调用）──

  // @ts-expect-error kept for emergency rollback
  private async uploadViaContentsApi(
    owner: string, repo: string, b64: string,
    emit: (stage: SyncStatus['stage'], message: string) => void,
  ): Promise<void> {
    emit('uploading', '正在上传…');
    const sha = await this.getFileSha(owner, repo, SAVE_PATH);
    const body: Record<string, string> = {
      message: `sync ${new Date().toISOString().slice(0, 19)}`,
      content: b64,
    };
    if (sha) body.sha = sha;
    await this.put(`/repos/${owner}/${repo}/contents/${SAVE_PATH}`, body);
  }

  // @ts-expect-error kept for emergency rollback
  private async uploadViaGitDataApi(
    owner: string, repo: string, b64: string,
    emit: (stage: SyncStatus['stage'], message: string) => void,
  ): Promise<void> {
    const commitMsg = `sync ${new Date().toISOString().slice(0, 19)}`;

    const repoInfo = await this.get<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    const branch = repoInfo.default_branch;

    emit('uploading', '正在上传存档数据…');
    const blobRes = await this.post<{ sha: string }>(
      `/repos/${owner}/${repo}/git/blobs`,
      { content: b64, encoding: 'base64' },
    );

    emit('uploading', '正在同步仓库状态…');
    const refRes = await this.get<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    );
    const parentSha = refRes.object.sha;

    const commitInfo = await this.get<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${parentSha}`,
    );

    emit('uploading', '正在构建提交…');
    const treeRes = await this.post<{ sha: string }>(
      `/repos/${owner}/${repo}/git/trees`,
      {
        base_tree: commitInfo.tree.sha,
        tree: [{
          path: SAVE_PATH,
          mode: '100644',
          type: 'blob',
          sha: blobRes.sha,
        }],
      },
    );

    const newCommit = await this.post<{ sha: string }>(
      `/repos/${owner}/${repo}/git/commits`,
      {
        message: commitMsg,
        tree: treeRes.sha,
        parents: [parentSha],
      },
    );

    emit('uploading', '正在更新分支…');
    await this.patch(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { sha: newCommit.sha, force: false },
    );
  }

  // ── 下载存档（v2 分块管道）──

  /**
   * Download the cloud save and overwrite local (full replace). Serialized against
   * any other cloud op via the shared lock. On success, records the downloaded
   * manifest's `createdAt` as this device's sync baseline — local now equals cloud,
   * so a subsequent auto-upload of unchanged data raises no false conflict.
   */
  async download(onStatus?: (s: SyncStatus) => void): Promise<void> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      await this._downloadLocked(onStatus);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _downloadLocked(onStatus?: (s: SyncStatus) => void): Promise<void> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('downloading', '正在获取云端索引…');
    let manifest: ChunkManifest;
    try {
      manifest = await this.fetchManifest(owner, repo);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('云端无存档，请先上传');
      }
      throw err;
    }

    const total = manifest.chunks.length;
    const chunks = new Map<string, Blob>();

    for (let i = 0; i < manifest.chunks.length; i++) {
      const entry = manifest.chunks[i];
      emit('downloading', `正在下载分块 ${i + 1}/${total}…`);
      chunks.set(entry.path, await this.downloadBlob(owner, repo, entry.path));
    }

    emit('downloading', '正在校验并恢复…');
    const json = await unpack(manifest, chunks);
    await this.backup.importAll(new Blob([json], { type: 'application/json' }));
    // Local now equals this cloud manifest. importAll's wipe preserves the
    // device-local baseline (backup-service LS_DEVICE_LOCAL_KEYS), so overwrite it
    // here with the cloud's createdAt — a later unchanged auto-upload sees no conflict.
    this.setSyncBaseline(manifest.createdAt);
    emit('done', '下载并恢复完成');
  }

  // ── v1 下载（保留供紧急回退，当前不调用）──

  // @ts-expect-error kept for emergency rollback
  private async downloadV1(onStatus?: (s: SyncStatus) => void): Promise<void> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('downloading', '正在获取文件信息…');
    const meta = await this.get<{ sha: string }>(`/repos/${owner}/${repo}/contents/${SAVE_PATH}`);

    emit('downloading', '正在下载存档…');
    const blob = await this.get<{ content: string; encoding: string }>(
      `/repos/${owner}/${repo}/git/blobs/${meta.sha}`,
    );
    if (blob.encoding !== 'base64') throw new Error(`Blob API 返回了非预期编码: ${blob.encoding}`);

    emit('downloading', '正在恢复本地数据…');
    const json = base64ToUtf8(blob.content);
    await this.backup.importAll(new Blob([json], { type: 'application/json' }));
    emit('done', '下载并恢复完成');
  }

  // ── v3 存档插槽：设备本地记账（per-slot baselines / pending map）──

  /** 按插槽的同步基线 map（slotKey → 云端 manifest createdAt）。设备本地，绝不入备份。 */
  getSlotBaselines(): Record<string, string> {
    return readJsonMap(LS_BASELINES);
  }

  /** 写入/清除某插槽的基线（createdAt 为空串 ⇒ 删除该键）。 */
  setSlotBaseline(slotKey: string, createdAt: string): void {
    const map = this.getSlotBaselines();
    if (createdAt) map[slotKey] = createdAt;
    else delete map[slotKey];
    localStorage.setItem(LS_BASELINES, JSON.stringify(map));
  }

  /** 按档案的"本地有存档未上传"标志 map。设备本地，跨会话持久（补传语义同旧 pending）。 */
  getSlotPendingMap(): Record<string, true> {
    return readJsonMap(LS_PENDING_MAP);
  }

  setSlotPending(profileId: string, pending: boolean): void {
    const map = this.getSlotPendingMap();
    if (pending) map[profileId] = true;
    else delete map[profileId];
    localStorage.setItem(LS_PENDING_MAP, JSON.stringify(map));
  }

  // ── v3 存档插槽：云端查询 ──

  /**
   * 探测云端仓库格式：slots/ 或 global/ 存在 ⇒ v3；否则有 v2/manifest.json ⇒ v2；
   * 都没有 ⇒ empty。v2 仓库继续走现有整包管线，**只有用户显式迁移后才进入 v3**
   * （设计 §2：部署零自动副作用）。
   */
  async detectCloudFormat(): Promise<CloudFormat> {
    const { owner, repo } = this.resolveTarget();
    if ((await this.listDirEntries(owner, repo, SLOTS_DIR)).length > 0) return 'v3';
    if ((await this.listDirEntries(owner, repo, GLOBAL_DIR)).length > 0) return 'v3';
    const v2Sha = await this.getFileSha(owner, repo, MANIFEST_PATH);
    return v2Sha ? 'v2' : 'empty';
  }

  /**
   * 列举云端全部插槽（含 global 设置插槽，若存在）。
   * slots/ 下 manifest 缺失/损坏的目录跳过（孤儿目录，无害）。
   */
  async listCloudSlots(): Promise<CloudSlotInfo[]> {
    const { owner, repo } = this.resolveTarget();
    const infos: CloudSlotInfo[] = [];
    for (const entry of await this.listDirEntries(owner, repo, SLOTS_DIR)) {
      if (entry.type !== 'dir') continue;
      try {
        const m = await this.fetchManifestAt(owner, repo, `${SLOTS_DIR}/${entry.name}/manifest.json`) as SlotManifest;
        infos.push({
          slotKey: entry.name,
          updatedAt: m.createdAt,
          sizeKB: Math.round(m.totalSizeBytes / 1024),
          profileName: m.slotMeta?.profileName,
          packId: m.slotMeta?.packId,
          slotCount: m.slotMeta?.slotCount,
          lastPlayedAt: m.slotMeta?.lastPlayedAt ?? null,
          uploadedByLabel: m.uploadedBy?.deviceLabel,
          uploadedByDeviceId: m.uploadedBy?.deviceId,
        });
      } catch (err) {
        // 404（缺 manifest 的孤儿目录）与损坏（JSON 解析/编码错误）都只跳过该
        // 插槽——一个坏目录不得拉黑整张插槽列表。网络/鉴权类 ApiError 必须上抛，
        // 否则认证失败会被渲染成"云端没有插槽"的假象。
        if (err instanceof ApiError && err.status === 404) continue;
        if (err instanceof ApiError) throw err;
        console.warn(`[GitHubSync] skip corrupted slot manifest slots/${entry.name}:`, err);
      }
    }
    try {
      const g = await this.fetchManifestAt(owner, repo, `${GLOBAL_DIR}/manifest.json`);
      infos.push({
        slotKey: GLOBAL_SLOT_KEY, updatedAt: g.createdAt, sizeKB: Math.round(g.totalSizeBytes / 1024),
        uploadedByLabel: g.uploadedBy?.deviceLabel, uploadedByDeviceId: g.uploadedBy?.deviceId,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 404) throw err;
      if (!(err instanceof ApiError)) console.warn('[GitHubSync] skip corrupted global manifest:', err);
    }
    return infos;
  }

  /** 查询单个插槽的云端信息（slotKey = profileId 或 GLOBAL_SLOT_KEY）。 */
  async getCloudSlotInfo(slotKey: string): Promise<CloudInfo> {
    if (slotKey !== GLOBAL_SLOT_KEY) validateSlotId(slotKey);
    const { owner, repo } = this.resolveTarget();
    try {
      const m = await this.fetchManifestAt(owner, repo, `${slotDir(slotKey)}/manifest.json`);
      return {
        exists: true, updatedAt: m.createdAt, sizeKB: Math.round(m.totalSizeBytes / 1024),
        uploadedByLabel: m.uploadedBy?.deviceLabel, uploadedByDeviceId: m.uploadedBy?.deviceId,
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { exists: false };
      if (err instanceof ApiError) throw err; // 网络/鉴权错误上抛
      // manifest 损坏（解析/编码失败）：按"无有效存档"处理——后续上传会用健康
      // 数据整体覆盖该插槽（gen-tag 新路径，不会与损坏残留冲突）。
      console.warn(`[GitHubSync] corrupted manifest for slot ${slotKey}:`, err);
      return { exists: false };
    }
  }

  /** 按插槽的多设备冲突检测（语义同 detectConflict，基线取自 per-slot map）。 */
  async detectSlotConflict(slotKey: string): Promise<ConflictCheck> {
    const cloud = await this.getCloudSlotInfo(slotKey);
    if (!cloud.exists) return { conflict: false, cloud };
    const baseline = this.getSlotBaselines()[slotKey] ?? '';
    return { conflict: !baseline || cloud.updatedAt !== baseline, cloud };
  }

  // ── v3 存档插槽：上传 / 下载 / 删除 ──

  /**
   * 上传单个档案到其云端插槽 slots/<profileId>/（全覆盖该插槽）。
   * 复用 v2 全量上传的全部护栏：退化拦截（DegradedUploadError，force 才放行）、
   * generation-tag 新路径 + manifest 最后写（原子）、锁内 await 的**本目录内**清理。
   */
  async uploadSlot(profileId: string, onStatus?: (s: SyncStatus) => void, opts?: { force?: boolean }): Promise<SlotManifest> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      return await this._uploadSlotLocked(profileId, onStatus, opts);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _uploadSlotLocked(profileId: string, onStatus?: (s: SyncStatus) => void, opts?: { force?: boolean }): Promise<SlotManifest> {
    validateSlotId(profileId);
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('uploading', '正在导出存档…');
    let blob: Blob;
    let imageIntegrity: ExportImageIntegrity;
    let displayMeta: ProfileDisplayMeta;
    try {
      ({ blob, imageIntegrity, displayMeta } = await this.backup.exportProfileForSync(profileId));
    } catch (err) {
      throw stageError('导出存档', err);
    }

    if (!opts?.force && imageIntegrity.referencedAssets > imageIntegrity.exportedAssets) {
      throw new DegradedUploadError({
        referencedAssets: imageIntegrity.referencedAssets,
        exportedAssets: imageIntegrity.exportedAssets,
        missingAssets: imageIntegrity.referencedAssets - imageIntegrity.exportedAssets,
      });
    }

    const manifest = await this.uploadBundleToDir(
      owner, repo, `${SLOTS_DIR}/${profileId}`, blob, emit,
      (m) => { m.slotMeta = displayMeta; },
      // 提交点即写基线（清理之前）：清理中断不得制造幻影冲突（v2 :397 同款语义）
      (m) => this.setSlotBaseline(profileId, m.createdAt),
    );
    emit('done', '上传完成');
    return manifest;
  }

  /**
   * 上传全局设置插槽 global/。先比对本次导出与云端 manifest 的 bundleChecksum，
   * **内容未变则跳过**（设置极少变化，避免每回合白传 + 多设备写热点）。
   */
  async uploadGlobal(onStatus?: (s: SyncStatus) => void): Promise<{ skipped: boolean; manifest?: SlotManifest }> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      return await this._uploadGlobalLocked(onStatus);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _uploadGlobalLocked(onStatus?: (s: SyncStatus) => void): Promise<{ skipped: boolean; manifest?: SlotManifest }> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('uploading', '正在导出设置…');
    let json: string;
    try {
      const { blob } = await this.backup.exportGlobalForSync();
      json = await blob.text(); // 设置包很小（无图片/存档），常驻字符串无内存压力
    } catch (err) {
      throw stageError('导出设置', err);
    }

    // 跳传比对用**内容指纹**（剔除时间戳），不能用整包 bundleChecksum ——
    // exportedAt 每次导出都变，整包哈希永不相等，跳传会名存实亡。
    const contentChecksum = await computeGlobalContentChecksum(json);
    let remote: SlotManifest | null = null;
    try {
      remote = await this.fetchManifestAt(owner, repo, `${GLOBAL_DIR}/manifest.json`) as SlotManifest;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    if (remote?.contentChecksum && remote.contentChecksum === contentChecksum) {
      // 云端已是同一份设置——把基线校准到云端（覆盖"本地重装后基线丢失"的场景）
      this.setSlotBaseline(GLOBAL_SLOT_KEY, remote.createdAt);
      emit('done', '设置未变化，已跳过');
      return { skipped: true, manifest: remote };
    }

    // 基线在 manifest 提交点（onCommitted）立即写入，先于 best-effort 清理 ——
    // 清理中断不得让下次冲突检测把本机刚成功的上传误判为"他人改动"（v2 同款语义）。
    const manifest = await this.uploadBundleToDir(
      owner, repo, GLOBAL_DIR, json, emit,
      (m) => { m.contentChecksum = contentChecksum; },
      (m) => this.setSlotBaseline(GLOBAL_SLOT_KEY, m.createdAt),
    );
    emit('done', '设置上传完成');
    return { skipped: false, manifest };
  }

  /**
   * 下载单个档案插槽并**档案级替换**本地（BackupService.importProfileReplace——
   * 只动该档案，绝不触碰其他档案与全局设置）。
   */
  async downloadSlot(profileId: string, onStatus?: (s: SyncStatus) => void): Promise<void> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      await this._downloadSlotLocked(profileId, onStatus);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _downloadSlotLocked(profileId: string, onStatus?: (s: SyncStatus) => void): Promise<void> {
    validateSlotId(profileId);
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('downloading', '正在获取云端索引…');
    const manifest = await this.fetchSlotManifestOr404(owner, repo, `${SLOTS_DIR}/${profileId}/manifest.json`, '云端没有该档案的存档');
    const json = await this.downloadAndUnpack(owner, repo, manifest, emit);
    await this.backup.importProfileReplace(new Blob([json], { type: 'application/json' }));
    this.setSlotBaseline(profileId, manifest.createdAt);
    emit('done', '下载并恢复完成');
  }

  /** 下载全局设置插槽并替换本地全局区（BackupService.importGlobal 路径）。 */
  async downloadGlobal(onStatus?: (s: SyncStatus) => void): Promise<void> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      await this._downloadGlobalLocked(onStatus);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _downloadGlobalLocked(onStatus?: (s: SyncStatus) => void): Promise<void> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    emit('downloading', '正在获取云端索引…');
    const manifest = await this.fetchSlotManifestOr404(owner, repo, `${GLOBAL_DIR}/manifest.json`, '云端没有设置备份');
    const json = await this.downloadAndUnpack(owner, repo, manifest, emit);
    // 防线：global 插槽里若被塞进了 full 包，importAll 会走全替换把本地整机抹掉。
    // 先做廉价的 bundleType 断言（设置包很小，parse 无压力）。
    const parsed = JSON.parse(json) as { bundleType?: string };
    if (parsed.bundleType !== 'global') {
      throw new Error(`云端设置插槽内容异常（bundleType='${parsed.bundleType ?? '(无)'}'），已中止恢复`);
    }
    await this.backup.importAll(new Blob([json], { type: 'application/json' }));
    this.setSlotBaseline(GLOBAL_SLOT_KEY, manifest.createdAt);
    emit('done', '设置下载并恢复完成');
  }

  /**
   * 显式删除云端某档案插槽（Q6：仅手动触发；本地删除档案绝不联动调用）。
   * 先删 manifest（提交点先失效，残余块立即成为无害孤儿），再逐块清理。
   */
  async deleteCloudSlot(profileId: string, onStatus?: (s: SyncStatus) => void): Promise<void> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      await this._deleteCloudSlotLocked(profileId, onStatus);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _deleteCloudSlotLocked(profileId: string, onStatus?: (s: SyncStatus) => void): Promise<void> {
    validateSlotId(profileId);
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();
    const dir = `${SLOTS_DIR}/${profileId}`;

    emit('checking', '正在读取云端插槽…');
    const files = await this.listDirEntries(owner, repo, dir);
    if (files.length === 0) throw new Error('云端没有该档案的存档');

    const manifestPath = `${dir}/manifest.json`;
    const manifestFile = files.find((f) => f.path === manifestPath);
    emit('uploading', '正在删除云端插槽…');
    if (manifestFile) {
      // manifest 删除失败必须 surface（这是用户显式动作，不能静默半删）
      await this.del(`/repos/${owner}/${repo}/contents/${manifestPath}`, {
        message: `delete slot ${profileId}`,
        sha: manifestFile.sha,
      });
    }
    for (const f of files) {
      if (f.path === manifestPath || f.type !== 'file') continue;
      await this.deleteStale(owner, repo, f.path, f.sha); // 404/409 容错，best-effort
    }
    this.setSlotBaseline(profileId, '');
    this.setSlotPending(profileId, false);
    emit('done', '云端插槽已删除');
  }

  // ── v3 迁移（用户显式触发，设计 §6）──

  /**
   * 把云端从 v2 全量格式迁移为 v3 插槽格式。**只能由用户显式触发**（设计 §2 /
   * M5：部署零自动副作用）。流程与中断语义（设计 §6）：
   *
   * 1. 逐档案 exportProfileForSync → 上传插槽（任一档案退化 ⇒ 中止，云端 v2 原样）
   * 2. exportGlobalForSync → 上传 global 插槽
   * 3. **验证闸（M4）**：逐插槽从云端重新拉 manifest，核对 bundleChecksum 与本次
   *    上传一致——"上传返回 200"不算数，读回来对得上才算
   * 4. 全部 ✓ 才 DELETE v2/manifest.json（git 历史可恢复；块文件保留不动）
   * 5. 清理旧标量基线/pending 键（per-slot map 已在各上传提交点写入）
   *
   * 步骤 1-3 任意失败：slots/ 可能残留部分插槽（无 manifest 引用者为孤儿，无害），
   * v2/manifest.json 未删 ⇒ 云端旧格式完好，重试即可。步骤 4 失败：不抛错——
   * 迁移已实质完成（v3 数据全部就位且验证通过），返回 v2Cleaned=false 提示可重试。
   */
  async migrateToSlots(
    onStatus?: (s: SyncStatus) => void,
    onSlotProgress?: (p: { slotKey: string; phase: 'uploading' | 'verifying' | 'verified' }) => void,
  ): Promise<MigrationResult> {
    if (this._syncInFlight) throw new SyncInProgressError();
    this._syncInFlight = true;
    try {
      return await this._migrateLocked(onStatus, onSlotProgress);
    } finally {
      this._syncInFlight = false;
    }
  }

  private async _migrateLocked(
    onStatus?: (s: SyncStatus) => void,
    onSlotProgress?: (p: { slotKey: string; phase: 'uploading' | 'verifying' | 'verified' }) => void,
  ): Promise<MigrationResult> {
    const emit = (stage: SyncStatus['stage'], message: string) => onStatus?.({ stage, message });
    const { owner, repo } = this.resolveTarget();

    /* ── 1. 逐档案上传插槽 ── */
    const profileIds = this.backup.listProfileIds();
    const uploaded: Array<{ slotKey: string; manifest: SlotManifest }> = [];
    for (let i = 0; i < profileIds.length; i++) {
      const pid = profileIds[i];
      emit('uploading', `正在迁移档案 ${i + 1}/${profileIds.length}…`);
      onSlotProgress?.({ slotKey: pid, phase: 'uploading' });
      // 不传 force：迁移中任何档案退化（缺图）都必须中止（设计 §6-2），
      // DegradedUploadError 原样上抛给调用方展示细节。
      const manifest = await this._uploadSlotLocked(pid, undefined, undefined);
      uploaded.push({ slotKey: pid, manifest });
    }

    /* ── 2. global 设置插槽 ── */
    emit('uploading', '正在迁移全局设置…');
    onSlotProgress?.({ slotKey: GLOBAL_SLOT_KEY, phase: 'uploading' });
    const globalResult = await this._uploadGlobalLocked();
    if (globalResult.manifest) {
      uploaded.push({ slotKey: GLOBAL_SLOT_KEY, manifest: globalResult.manifest });
    }

    /* ── 3. 验证闸（M4）：读回每个插槽的 manifest 核对 checksum，并**逐块下载
       回读比对 SHA-256**（审查 Imp#2：manifest 里的 bundleChecksum 是上传前本地
       算好的自述字段，只比它防不了"PUT 200 但字节坏了"。迁移是一次性的数据安全
       关口，值得为每块付一次回读带宽——压缩块直接比 Layer-1 checksum，无需解压） ── */
    const slots: MigrationResult['slots'] = [];
    for (const { slotKey, manifest } of uploaded) {
      emit('checking', `正在验证插槽 ${slotKey}…`);
      onSlotProgress?.({ slotKey, phase: 'verifying' });
      const remote = await this.fetchManifestAt(owner, repo, `${slotDir(slotKey)}/manifest.json`);
      if (remote.bundleChecksum !== manifest.bundleChecksum) {
        throw new Error(
          `迁移验证失败：插槽 ${slotKey} 云端校验和与本次上传不一致，` +
            '已中止（云端 v2 存档未动，可安全重试）',
        );
      }
      for (let ci = 0; ci < remote.chunks.length; ci++) {
        const entry = remote.chunks[ci];
        emit('checking', `正在验证插槽 ${slotKey} 分块 ${ci + 1}/${remote.chunks.length}…`);
        const blob = await this.downloadBlob(owner, repo, entry.path);
        const actual = await sha256Blob(blob);
        if (actual !== entry.checksum) {
          throw new Error(
            `迁移验证失败：插槽 ${slotKey} 分块 ${entry.name} 云端字节损坏，` +
              '已中止（云端 v2 存档未动，可安全重试）',
          );
        }
      }
      onSlotProgress?.({ slotKey, phase: 'verified' });
      slots.push({ slotKey, verified: true });
    }

    /* ── 4. 全部验证通过 → 删除 v2 索引（旧客户端安全失败为"云端无存档"） ── */
    emit('uploading', '正在下线旧格式索引…');
    let v2Cleaned = false;
    try {
      const v2Sha = await this.getFileSha(owner, repo, MANIFEST_PATH);
      if (v2Sha) {
        await this.del(`/repos/${owner}/${repo}/contents/${MANIFEST_PATH}`, {
          message: 'migrate to v3 slots: retire v2 manifest',
          sha: v2Sha,
        });
      }
      v2Cleaned = true;
    } catch (err) {
      // 迁移已实质完成（v3 全部就位且验证通过）——删除失败只提示可重试，不抛错
      console.warn('[GitHubSync] v2 manifest retire failed (retryable):', err);
    }

    /* ── 5. 旧标量记账键退役（per-slot map 已在各提交点写入） ── */
    localStorage.removeItem(LS_BASELINE);
    localStorage.removeItem(LS_PENDING);

    emit('done', v2Cleaned ? '迁移完成' : '迁移完成（旧索引未删净，可重试）');
    return { slots, v2Cleaned };
  }

  /**
   * v2 复活检测（设计 §6 末段）：v3 模式下若 v2/manifest.json 重新出现，
   * 说明另一台设备仍在用旧版本上传——UI 据此显著警告。仅探测，不做任何写操作。
   */
  async checkV2Revival(): Promise<{ revived: boolean; v2UpdatedAt?: string }> {
    const { owner, repo } = this.resolveTarget();
    try {
      const m = await this.fetchManifestAt(owner, repo, MANIFEST_PATH);
      return { revived: true, v2UpdatedAt: m.createdAt };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { revived: false };
      if (!(err instanceof ApiError)) return { revived: true }; // 存在但损坏——同样值得警告
      throw err;
    }
  }

  // ── v3 共享上传/下载管线 ──

  /**
   * 把一份 bundle 以分块形式上传到指定目录（v3 专用；v2 的 _uploadLocked 保持
   * 独立不动——回归面隔离）。原子性与 v2 相同：gen-tag 新路径 → manifest 最后写
   * → 锁内 await 清理，且清理范围**仅限本目录**。
   */
  private async uploadBundleToDir(
    owner: string, repo: string, dir: string, source: Blob | string,
    emit: (stage: SyncStatus['stage'], message: string) => void,
    decorate?: (m: SlotManifest) => void,
    /** 在 manifest PUT 成功（提交点）后、best-effort 清理**之前**调用——基线写入放这里。 */
    onCommitted?: (m: SlotManifest) => void,
  ): Promise<SlotManifest> {
    let existingFiles: Array<{ path: string; sha: string }>;
    try {
      existingFiles = (await this.listDirEntries(owner, repo, dir))
        .filter((f) => f.type !== 'dir')
        .map((f) => ({ path: f.path, sha: f.sha }));
    } catch (err) {
      throw stageError('读取云端文件列表', err);
    }

    const genTag = uploadGenTag();
    emit('uploading', '正在压缩并上传…');
    const gen = packChunks(source, dir);
    let res: IteratorResult<{ path: string; blob: Blob }, ChunkManifest>;
    try {
      res = await gen.next();
    } catch (err) {
      throw stageError('压缩存档', err);
    }
    let uploaded = 0;
    const genPathByOriginal = new Map<string, string>();
    while (!res.done) {
      const { path, blob } = res.value;
      const genPath = withGenTag(path, genTag);
      genPathByOriginal.set(path, genPath);
      uploaded++;
      emit('uploading', `正在压缩并上传分块 ${uploaded}…`);
      try {
        await this.uploadFile(owner, repo, genPath, await blobToBase64(blob), undefined);
      } catch (err) {
        throw stageError(`上传分块 ${genPath}`, err);
      }
      try {
        res = await gen.next();
      } catch (err) {
        throw stageError('压缩存档', err);
      }
    }
    const manifest = res.value as SlotManifest;
    for (const c of manifest.chunks) {
      const gp = genPathByOriginal.get(c.path);
      if (gp) c.path = gp;
    }
    manifest.uploadedBy = getDeviceStamp();
    decorate?.(manifest);

    emit('uploading', '正在更新索引…');
    const manifestPath = `${dir}/manifest.json`;
    try {
      const manifestJson = JSON.stringify(manifest, null, 2);
      await this.putManifestFresh(owner, repo, manifestPath, utf8ToBase64(manifestJson));
    } catch (err) {
      throw stageError('更新云端索引', err);
    }

    onCommitted?.(manifest);

    emit('uploading', '正在清理旧分块…');
    try {
      const validPaths = new Set([manifestPath, ...manifest.chunks.map((c) => c.path)]);
      const stale = existingFiles.filter((f) => !validPaths.has(f.path));
      for (const file of stale) {
        await this.deleteStale(owner, repo, file.path, file.sha);
      }
    } catch { /* best-effort — orphans are harmless and retried on the next upload */ }

    return manifest;
  }

  /** 下载 manifest 声明的全部分块并 unpack（双层校验在 unpack 内）。 */
  private async downloadAndUnpack(
    owner: string, repo: string, manifest: ChunkManifest,
    emit: (stage: SyncStatus['stage'], message: string) => void,
  ): Promise<string> {
    const total = manifest.chunks.length;
    const chunks = new Map<string, Blob>();
    for (let i = 0; i < manifest.chunks.length; i++) {
      const entry = manifest.chunks[i];
      emit('downloading', `正在下载分块 ${i + 1}/${total}…`);
      chunks.set(entry.path, await this.downloadBlob(owner, repo, entry.path));
    }
    emit('downloading', '正在校验并恢复…');
    return unpack(manifest, chunks);
  }

  /** 读取任意路径的 manifest，404 转成给定的用户可读错误。 */
  private async fetchSlotManifestOr404(
    owner: string, repo: string, path: string, notFoundMessage: string,
  ): Promise<SlotManifest> {
    try {
      return await this.fetchManifestAt(owner, repo, path) as SlotManifest;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new Error(notFoundMessage);
      throw err;
    }
  }

  // ── 查询云端信息（v2）──

  async getCloudInfo(): Promise<CloudInfo> {
    const { owner, repo } = this.resolveTarget();
    try {
      const manifest = await this.fetchManifest(owner, repo);
      return {
        exists: true,
        updatedAt: manifest.createdAt,
        sizeKB: Math.round(manifest.totalSizeBytes / 1024),
        uploadedByLabel: manifest.uploadedBy?.deviceLabel,
        uploadedByDeviceId: manifest.uploadedBy?.deviceId,
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { exists: false };
      throw err;
    }
  }

  // ── v2 下载辅助 ──

  private async fetchManifest(owner: string, repo: string): Promise<ChunkManifest> {
    return this.fetchManifestAt(owner, repo, MANIFEST_PATH);
  }

  /** 读取任意路径的 manifest JSON（v2 与 v3 插槽共用）。 */
  private async fetchManifestAt(owner: string, repo: string, path: string): Promise<ChunkManifest> {
    const meta = await this.get<{ sha: string }>(`/repos/${owner}/${repo}/contents/${path}`);
    const blob = await this.get<{ content: string; encoding: string }>(
      `/repos/${owner}/${repo}/git/blobs/${meta.sha}`,
    );
    if (blob.encoding !== 'base64') throw new Error(`Unexpected blob encoding: ${blob.encoding}`);
    const json = base64ToUtf8(blob.content);
    return JSON.parse(json) as ChunkManifest;
  }

  private async downloadBlob(owner: string, repo: string, path: string): Promise<Blob> {
    const meta = await this.get<{ sha: string }>(`/repos/${owner}/${repo}/contents/${path}`);
    const blobRes = await this.get<{ content: string; encoding: string }>(
      `/repos/${owner}/${repo}/git/blobs/${meta.sha}`,
    );
    if (blobRes.encoding !== 'base64') throw new Error(`Unexpected blob encoding: ${blobRes.encoding}`);
    const cleaned = blobRes.content.replace(/\s/g, '');
    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes]);
  }

  // ── v2 上传辅助 ──

  /**
   * manifest 的提交点 PUT——sha 前置条件必须**现取**（单文件 GET 强一致），
   * 不能沿用目录列表里的 sha：GitHub 目录列表在最近一次 commit 后可能滞后
   * （最终一致），连续两次上传会拿到过期 sha → 409（2026-07-23 真机验证抓获，
   * 也可能是 2026-07-14 事故 409 的隐藏成因之一）。
   *
   * **故意不做 409 自动重试**（审查 2026-07-23 Imp#1）：现取 sha 后仍然 409 只剩
   * 一种解释——GET 与 PUT 之间有**另一个写者**真实提交了。此时盲目重取 sha 重试
   * 等于用本机（可能更旧的）内容静默覆盖对方刚成功的上传，违背"败者响亮失败"
   * 的并发契约（见 SyncInProgressError docstring）。让 409 上抛：手动路径给用户
   * 报错，自动路径下一回合经 per-slot 冲突检测正确弹窗。
   */
  private async putManifestFresh(owner: string, repo: string, path: string, b64: string): Promise<void> {
    const sha = await this.getFileSha(owner, repo, path);
    await this.uploadFile(owner, repo, path, b64, sha ?? undefined);
  }

  private async uploadFile(
    owner: string, repo: string, path: string, b64Content: string,
    knownSha?: string,
  ): Promise<void> {
    const sha = knownSha ?? null;
    const body: Record<string, string> = {
      message: `sync ${new Date().toISOString().slice(0, 19)}`,
      content: b64Content,
    };
    if (sha) body.sha = sha;
    await this.put(`/repos/${owner}/${repo}/contents/${path}`, body);
  }

  private async cleanupStaleFromList(
    owner: string, repo: string, manifest: ChunkManifest,
    existingFiles: Array<{ path: string; sha: string }>,
  ): Promise<void> {
    const validPaths = new Set([
      MANIFEST_PATH,
      ...manifest.chunks.map(c => c.path),
    ]);
    const stale = existingFiles.filter(f => !validPaths.has(f.path));

    // Sequential (not Promise.all): gentler on the API and, being awaited inside
    // the lock, no other upload is mutating v2/ meanwhile, so each sha stays fresh.
    for (const file of stale) {
      await this.deleteStale(owner, repo, file.path, file.sha);
    }
  }

  /**
   * Delete one stale chunk, tolerating the two benign failures: 404 (already gone)
   * and 409/422 (sha drifted — e.g. a manual upload from another tab touched it;
   * refetch the current sha and retry once). Any residual failure is swallowed —
   * an orphan chunk is harmless and the next upload's cleanup will retry it.
   */
  private async deleteStale(owner: string, repo: string, path: string, sha: string): Promise<void> {
    try {
      await this.del(`/repos/${owner}/${repo}/contents/${path}`, { message: `cleanup ${path}`, sha });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return; // already deleted
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        const fresh = await this.getFileSha(owner, repo, path).catch(() => null);
        if (!fresh) return; // gone in the meantime
        await this.del(`/repos/${owner}/${repo}/contents/${path}`, { message: `cleanup ${path}`, sha: fresh })
          .catch(() => { /* give up; harmless orphan */ });
        return;
      }
      /* other errors (network etc.): swallow — best-effort */
    }
  }

  private async listV2Files(owner: string, repo: string): Promise<Array<{ path: string; sha: string }>> {
    // 仅排除显式子目录（v2 从不建子目录；缺 type 字段的响应按文件处理，
    // 与改造前的行为逐字一致）。
    return (await this.listDirEntries(owner, repo, V2_DIR))
      .filter((f) => f.type !== 'dir')
      .map((f) => ({ path: f.path, sha: f.sha }));
  }

  /** 列举任意目录的条目（含子目录，type: 'file' | 'dir'）。404 ⇒ 空数组。 */
  private async listDirEntries(
    owner: string, repo: string, dir: string,
  ): Promise<Array<{ name: string; path: string; sha: string; type: string }>> {
    try {
      const items = await this.get<Array<{ name: string; path: string; sha: string; type: string }>>(
        `/repos/${owner}/${repo}/contents/${dir}`,
      );
      return Array.isArray(items) ? items : [];
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
  }

  // ── 内部 ──

  private resolveTarget(): { owner: string; repo: string } {
    const owner = this.getOwner();
    const repo = this.getRepoName();
    if (!owner) throw new Error('请填写 GitHub 用户名');
    if (!this.getToken()) throw new Error('请填写 Token');
    return { owner, repo };
  }

  private async getFileSha(owner: string, repo: string, path: string): Promise<string | null> {
    try {
      const res = await this.get<{ sha: string }>(`/repos/${owner}/${repo}/contents/${path}`);
      return res.sha;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, { headers: this.headers() });
    if (!res.ok) throw new ApiError(res.status, await safeBody(res));
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await safeBody(res));
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await safeBody(res));
    return res.json() as Promise<T>;
  }

  private async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await safeBody(res));
    return res.json() as Promise<T>;
  }

  private async del(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${API}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await safeBody(res));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
  }
}

// ─── 工具 ───

export class ApiError extends Error {
  constructor(public status: number, body: string) {
    super(`GitHub API ${status}: ${body.slice(0, 300)}`);
  }
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-upload generation tag. Chunk filenames are suffixed with it so each upload
 * writes to fresh paths and never overwrites a chunk the current cloud manifest
 * still references — the property that makes "manifest written last" atomic.
 * Timestamp + a small random suffix keeps it unique even for two uploads in the
 * same millisecond.
 */
function uploadGenTag(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}

/** Insert the generation tag before the `.gz` extension: `v2/state-0.gz` → `v2/state-0.<tag>.gz`. */
function withGenTag(path: string, tag: string): string {
  return path.replace(/\.gz$/, `.${tag}.gz`);
}

/** slotKey → 远端目录（GLOBAL_SLOT_KEY → global/，否则 slots/<profileId>/）。 */
function slotDir(slotKey: string): string {
  return slotKey === GLOBAL_SLOT_KEY ? GLOBAL_DIR : `${SLOTS_DIR}/${slotKey}`;
}

/**
 * 校验 profileId 可安全用作远端路径段：只允许字母/数字/下划线/连字符，
 * 且不得与全局插槽键冲突。拦截路径穿越与畸形 id 污染仓库结构。
 */
function validateSlotId(profileId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId) || profileId === GLOBAL_SLOT_KEY) {
    throw new Error(`非法的档案 ID："${profileId}"`);
  }
}

/**
 * 全局设置包的**内容指纹**：剔除每次导出必变的时间戳字段（顶层 exportedAt 与
 * builtinPromptOverrides.exportedAt）后，对与设置语义相关的 sections 做 SHA-256。
 * engineSettings 按 key 排序，localStorage 枚举顺序波动不产生假变更。
 * 供 uploadGlobal 跳传比对与 Phase 3 迁移复用；导出为公共函数以便单测锁定
 * "时间戳不同、内容相同 ⇒ 指纹相同"这一关键性质。
 */
/**
 * 会话性易变键——每回合/每次输入都会变化、且对"设置是否变了"没有语义贡献的键。
 * 从内容指纹中剔除（仍随包携带，只是不触发重传）；不剔除的话 checksum-skip
 * 名存实亡（2026-07-23 真机验证：aga_pending_input 输入草稿每回合击穿跳传）。
 */
const VOLATILE_FINGERPRINT_KEYS: ReadonlySet<string> = new Set([
  'aga_pending_input', // 主输入框草稿——随玩家每次输入变化
]);

export async function computeGlobalContentChecksum(json: string): Promise<string> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const bpo = parsed.builtinPromptOverrides as Record<string, unknown> | undefined;
  const engineSettings = parsed.engineSettings as Record<string, unknown> | undefined;
  const sortedSettings: Record<string, unknown> = {};
  for (const k of Object.keys(engineSettings ?? {}).sort()) {
    if (VOLATILE_FINGERPRINT_KEYS.has(k)) continue;
    sortedSettings[k] = (engineSettings as Record<string, unknown>)[k];
  }
  const fingerprint = {
    configs: parsed.configs,
    prompts: parsed.prompts,
    engineSettings: sortedSettings,
    customPresets: parsed.customPresets,
    builtinPromptOverrides: bpo
      ? { version: bpo.version, entries: bpo.entries, packId: bpo.packId }
      : undefined,
  };
  return sha256String(JSON.stringify(fingerprint));
}

/** 读取设备本地 JSON map 键；损坏/缺失 ⇒ 空对象（自愈，不抛错）。 */
function readJsonMap<T = string>(lsKey: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, T>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Wrap a stage failure so the surfaced message names the failing step.
 *
 * `fetch()` (and `Response.blob()` over a failed CompressionStream) throws a
 * bare `TypeError: Failed to fetch` with no HTTP status and no Network-tab
 * entry — useless on its own. Prefixing the stage + a likely-cause hint turns
 * it into something actionable, while preserving the original stack.
 */
function stageError(stage: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const hint = /failed to fetch/i.test(raw)
    ? '（网络中断、被浏览器/扩展拦截，或存档过大导致内存不足）'
    : '';
  const wrapped = new Error(`${stage}失败：${raw}${hint}`);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}


function base64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s/g, '');
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function safeBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
