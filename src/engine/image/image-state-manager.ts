// App doc: docs/user-guide/pages/game-image.md §后台生成保护机制
/**
 * Image State Manager — ported from npcImageStateWorkflow + sceneImageArchiveWorkflow
 *
 * Centralized state mutations for the image subsystem:
 * - NPC archive: history CRUD, avatar/portrait/background selection, auto-fallback
 * - Scene archive: wallpaper set/clear, persistent wallpaper
 * - Secret parts: per-body-part result storage
 * - Concurrent generation lock
 *
 * All mutations write to the state tree via StateManager and trigger auto-save.
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { SecretPartType, ReferenceLibraryEntry } from './types';
import { eventBus } from '../core/event-bus';
import { SYSTEM_PATHS } from '../pipeline/system-paths';
import { TIANMING_IMAGE_ARCHIVE_KEYS, TIANMING_SECRET_PART_CN } from '../pack/tianming-coupling';

/** Player pseudo-NPC identifier (主角角色锚点标识) */
export const PLAYER_PSEUDO_NPC_ID = '__player__';

/** State path for the player character's image archive */
const PLAYER_ARCHIVE_PATH = '角色.图片档案';

export class ImageStateManager {
  /**
   * 生成锁的自动过期时间。**必须显著大于 `IMAGE_GENERATE_TIMEOUT_MS`**：锁要活得
   * 比整个生成流程更久，否则请求还在飞、锁却先过期，用户就能对同一个对象再发一次。
   * 一次生成的总耗时 = 队列/提示词组装 + 参考图取回与 base64（最多 14 张）+ 网络
   * （上限 IMAGE_GENERATE_TIMEOUT_MS）。2026-09-02 网络超时 180s→300s 后，原先的
   * 120s 余量被吃光，故同步上调到 420s，保留 ~120s 缓冲。改动其一必须回看另一个。
   */
  private static readonly LOCK_TIMEOUT_MS = 420_000;

  private generatingMap = new Map<string, number>();

  private isPlayer(name: string): boolean { return name === PLAYER_PSEUDO_NPC_ID; }

  constructor(
    private stateManager: StateManager,
    private paths: EnginePathConfig,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // §1 — Concurrent generation lock (NPC生图进行中集合)
  // ═══════════════════════════════════════════════════════════

  isGenerating(key: string): boolean {
    const lockedAt = this.generatingMap.get(key);
    if (lockedAt === undefined) return false;
    if (Date.now() - lockedAt > ImageStateManager.LOCK_TIMEOUT_MS) {
      this.generatingMap.delete(key);
      console.warn(`[ImageStateManager] Lock expired for "${key}" after ${ImageStateManager.LOCK_TIMEOUT_MS / 1000}s`);
      return false;
    }
    return true;
  }
  lockGeneration(key: string): void { this.generatingMap.set(key, Date.now()); }
  unlockGeneration(key: string): void { this.generatingMap.delete(key); }

  // ═══════════════════════════════════════════════════════════
  // §2 — NPC archive reads
  // ═══════════════════════════════════════════════════════════

  getNpcArchive(npcName: string): Record<string, unknown> | null {
    if (this.isPlayer(npcName)) {
      const raw = this.stateManager.get<Record<string, unknown>>(PLAYER_ARCHIVE_PATH);
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    }
    const npc = this.findNpc(npcName);
    if (!npc) return null;
    const archive = npc['图片档案'];
    return archive && typeof archive === 'object' && !Array.isArray(archive)
      ? archive as Record<string, unknown> : null;
  }

  getNpcImageHistory(npcName: string): Array<Record<string, unknown>> {
    const archive = this.getNpcArchive(npcName);
    return Array.isArray(archive?.[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]) ? archive![TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory] as Array<Record<string, unknown>> : [];
  }

  // ═══════════════════════════════════════════════════════════
  // §3 — NPC archive writes
  // ═══════════════════════════════════════════════════════════

  /**
   * Write an image record to NPC history with dedup + auto-selection.
   * Write NPC image history record — ported
   */
  writeNpcImageRecord(npcName: string, record: Record<string, unknown>): string[] {
    const trimmedIds: string[] = [];
    this.mutateNpc(npcName, (npc) => {
      const archive = this.ensureArchive(npc);
      const history = this.getHistoryArray(archive);

      const newRecord = {
        ...record,
        id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : this.generateRecordId(),
      };

      // Dedup by ID + sort by time descending
      const nextHistory = [newRecord, ...history.filter((item) => item.id !== newRecord.id)]
        .sort((a, b) => (Number((b as Record<string, unknown>)['生成时间'] ?? (b as Record<string, unknown>).createdAt ?? 0)) - (Number((a as Record<string, unknown>)['生成时间'] ?? (a as Record<string, unknown>).createdAt ?? 0)));

      // Auto-select avatar fallback if current selection was removed
      const currentAvatar = String(archive[TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId] ?? '').trim();
      const avatarStillExists = currentAvatar && nextHistory.some((item) => item.id === currentAvatar);
      const autoAvatar = !avatarStillExists
        ? (nextHistory.find((r) => (r as Record<string, unknown>).composition === 'portrait' && (r as Record<string, unknown>).status === 'complete')?.id as string
          ?? nextHistory.find((r) => (r as Record<string, unknown>).composition !== 'secret_part' && (r as Record<string, unknown>).status === 'complete')?.id as string
          ?? '')
        : currentAvatar;

      // Enforce per-NPC history limit (按NPC上限裁剪档案)
      const limit = this.stateManager.get<number>(`${SYSTEM_PATHS.image.config}.auto.historyLimit`) ?? 100;
      if (nextHistory.length > limit) {
        for (let i = limit; i < nextHistory.length; i++) {
          const id = String((nextHistory[i] as Record<string, unknown>).id ?? '');
          if (id) trimmedIds.push(id);
        }
        nextHistory.length = limit;
      }

      npc['图片档案'] = {
        ...archive,
        [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: nextHistory,
        '最近生图结果': newRecord.id,
        [TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId]: autoAvatar,
      };
      return npc;
    });
    return trimmedIds;
  }

  // ── Selection management ──

  setNpcAvatar(npcName: string, assetId: string): void {
    this.setArchiveField(npcName, TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId, assetId);
  }

  clearNpcAvatar(npcName: string): void {
    this.setArchiveField(npcName, TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId, '');
  }

  setNpcPortrait(npcName: string, assetId: string): void {
    this.setArchiveField(npcName, '已选立绘图片ID', assetId);
  }

  clearNpcPortrait(npcName: string): void {
    this.setArchiveField(npcName, '已选立绘图片ID', '');
  }

  setNpcBackground(npcName: string, assetId: string): void {
    this.setArchiveField(npcName, '已选背景图片ID', assetId);
  }

  clearNpcBackground(npcName: string): void {
    this.setArchiveField(npcName, '已选背景图片ID', '');
  }

  // ── Delete + clear ──

  deleteNpcImage(npcName: string, imageId: string): void {
    this.mutateNpc(npcName, (npc) => {
      const archive = this.ensureArchive(npc);
      const history = this.getHistoryArray(archive).filter((r) => r.id !== imageId);

      // Clear selections that pointed to deleted image
      const clearIfMatch = (field: string) => {
        if (String(archive[field] ?? '') === imageId) archive[field] = '';
      };
      clearIfMatch(TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId);
      clearIfMatch('已选立绘图片ID');
      clearIfMatch('已选背景图片ID');
      if (String(archive['最近生图结果'] ?? '') === imageId) {
        archive['最近生图结果'] = history[0]?.id ?? '';
      }

      const secretArchive = archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] as Record<string, unknown> | undefined;
      if (secretArchive) {
        for (const partKey of [TIANMING_SECRET_PART_CN.breast, TIANMING_SECRET_PART_CN.vagina, TIANMING_SECRET_PART_CN.anus]) {
          const entry = secretArchive[partKey] as Record<string, unknown> | undefined;
          if (typeof entry?.id === 'string' && entry.id === imageId) {
            delete secretArchive[partKey];
          }
        }
        archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] = secretArchive;
      }

      npc['图片档案'] = { ...archive, [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: history };
      return npc;
    });
  }

  clearNpcHistory(npcName: string): void {
    this.mutateNpc(npcName, (npc) => {
      npc['图片档案'] = {
        [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [],
        '最近生图结果': '',
        [TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId]: '',
        '已选立绘图片ID': '',
        '已选背景图片ID': '',
      };
      return npc;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // §4 — Secret part results
  // ═══════════════════════════════════════════════════════════

  setSecretPartResult(npcName: string, part: SecretPartType, result: Record<string, unknown>): void {
    this.mutateNpc(npcName, (npc) => {
      const archive = this.ensureArchive(npc);
      const secretArchive = (archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] ?? {}) as Record<string, unknown>;
      const partKey = part === 'breast' ? TIANMING_SECRET_PART_CN.breast : part === 'vagina' ? TIANMING_SECRET_PART_CN.vagina : TIANMING_SECRET_PART_CN.anus;
      secretArchive[partKey] = result;
      npc['图片档案'] = { ...archive, [TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber]: secretArchive };
      return npc;
    });
  }

  getSecretPartResult(npcName: string, part: SecretPartType): Record<string, unknown> | null {
    const archive = this.getNpcArchive(npcName);
    if (!archive) return null;
    const secretArchive = archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] as Record<string, unknown> | undefined;
    if (!secretArchive) return null;
    const partKey = part === 'breast' ? TIANMING_SECRET_PART_CN.breast : part === 'vagina' ? TIANMING_SECRET_PART_CN.vagina : TIANMING_SECRET_PART_CN.anus;
    const result = secretArchive[partKey];
    return result && typeof result === 'object' ? result as Record<string, unknown> : null;
  }

  clearSecretPartResult(npcName: string, part: SecretPartType): void {
    this.mutateNpc(npcName, (npc) => {
      const archive = this.ensureArchive(npc);
      const secretArchive = (archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] ?? {}) as Record<string, unknown>;
      const partKey = part === 'breast' ? TIANMING_SECRET_PART_CN.breast : part === 'vagina' ? TIANMING_SECRET_PART_CN.vagina : TIANMING_SECRET_PART_CN.anus;
      delete secretArchive[partKey];
      npc['图片档案'] = { ...archive, [TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber]: secretArchive };
      return npc;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // §5 — Scene wallpaper
  // ═══════════════════════════════════════════════════════════

  setSceneWallpaper(imageId: string): void {
    this.mutateSceneArchive((archive) => {
      archive['当前壁纸图片ID'] = imageId;
      return archive;
    });
  }

  clearSceneWallpaper(): void {
    this.mutateSceneArchive((archive) => {
      archive['当前壁纸图片ID'] = '';
      return archive;
    });
  }

  setPersistentWallpaper(url: string): void {
    this.stateManager.set(`${SYSTEM_PATHS.image.root}.persistentWallpaper`, url, 'system');
    eventBus.emit('engine:request-save');
  }

  clearPersistentWallpaper(): void {
    this.stateManager.set(`${SYSTEM_PATHS.image.root}.persistentWallpaper`, '', 'system');
    eventBus.emit('engine:request-save');
  }

  getPersistentWallpaper(): string {
    return this.stateManager.get<string>(`${SYSTEM_PATHS.image.root}.persistentWallpaper`) ?? '';
  }

  // ═══════════════════════════════════════════════════════════
  // §6 — Reference Library CRUD
  // ═══════════════════════════════════════════════════════════

  private static readonly REF_LIB_PATH = SYSTEM_PATHS.image.referenceLibrary;

  getReferenceLibrary(): ReferenceLibraryEntry[] {
    const raw = this.stateManager.get<unknown>(ImageStateManager.REF_LIB_PATH);
    return Array.isArray(raw) ? raw as ReferenceLibraryEntry[] : [];
  }

  addReferenceEntry(entry: ReferenceLibraryEntry): void {
    const lib = this.getReferenceLibrary().filter((e) => e.id !== entry.id);
    this.stateManager.set(ImageStateManager.REF_LIB_PATH, [...lib, entry], 'system');
    eventBus.emit('engine:request-save');
  }

  removeReferenceEntry(id: string): void {
    const lib = this.getReferenceLibrary().filter((e) => e.id !== id);
    this.stateManager.set(ImageStateManager.REF_LIB_PATH, lib, 'system');
    eventBus.emit('engine:request-save');
  }

  private static readonly TASKS_PATH = SYSTEM_PATHS.image.tasks;

  /**
   * 该图片资产是否仍被某个生图任务的参考图归档引用。
   *
   * **删素材库条目前必须问一次**（CRITICAL 修复 2026-08-29）：条目删除会连带删掉
   * 图片本体，而任务归档里的 `sourceAssetIds` 不会跟着消失 →
   * 备份采集器（backup-service `collectAssetIdsFromTree`，2026-08-29 起会遍历任务
   * 参考图）继续把它算作"被引用"，导出时却拿不出来 → `referencedAssets >
   * exportedAssets` → GitHub 云同步的退化守卫**永久硬阻断上传**，而它给用户的
   * 提示是"下载找回图片"，对"被主动删掉"这种情形完全无效。
   *
   * 所以：条目可以删（那只是用户的素材清单），图片本体只要还被任何任务引用就必须留。
   */
  isAssetReferencedByTasks(assetId: string): boolean {
    if (!assetId) return false;
    const raw = this.stateManager.get<unknown>(ImageStateManager.TASKS_PATH);
    if (!Array.isArray(raw)) return false;
    return raw.some((task) => {
      if (!task || typeof task !== 'object') return false;
      const meta = (task as Record<string, unknown>).providerMeta as Record<string, unknown> | undefined;
      const ref = meta?.reference as Record<string, unknown> | undefined;
      if (!ref) return false;
      const list = ref.sourceAssetIds;
      if (Array.isArray(list) && list.includes(assetId)) return true;
      return ref.sourceAssetId === assetId;   // 未迁移的旧任务
    });
  }

  updateReferenceLastUsed(id: string): void {
    const lib = this.getReferenceLibrary();
    if (!lib.some((e) => e.id === id)) return;
    const updated = lib.map((e) =>
      e.id === id ? { ...e, lastUsedAt: Date.now() } : e,
    );
    this.stateManager.set(ImageStateManager.REF_LIB_PATH, updated, 'system');
    eventBus.emit('engine:request-save');
  }

  // ═══════════════════════════════════════════════════════════
  // §7 — Internal helpers
  // ═══════════════════════════════════════════════════════════

  private findNpc(npcName: string): Record<string, unknown> | null {
    if (this.isPlayer(npcName)) {
      const raw = this.stateManager.get<Record<string, unknown>>(PLAYER_ARCHIVE_PATH);
      return { '图片档案': raw && typeof raw === 'object' ? raw : undefined };
    }
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return null;
    const nameKey = this.paths.npcFieldNames?.name ?? '名称';
    return list.find((n) => n[nameKey] === npcName) as Record<string, unknown> ?? null;
  }

  private findNpcIndex(npcName: string): number {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return -1;
    const nameKey = this.paths.npcFieldNames?.name ?? '名称';
    return list.findIndex((n) => n[nameKey] === npcName);
  }

  private mutateNpc(npcName: string, mutator: (npc: Record<string, unknown>) => Record<string, unknown>): void {
    // Player pseudo-NPC: read/write directly from 角色.图片档案
    if (this.isPlayer(npcName)) {
      const raw = this.stateManager.get<Record<string, unknown>>(PLAYER_ARCHIVE_PATH);
      const playerObj = { '图片档案': raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined };
      const mutated = mutator({ ...playerObj });
      this.stateManager.set(PLAYER_ARCHIVE_PATH, mutated['图片档案'] ?? {}, 'system');
      eventBus.emit('engine:request-save');
      return;
    }

    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return;
    const idx = this.findNpcIndex(npcName);
    if (idx < 0) return;

    const updated = [...list];
    updated[idx] = mutator({ ...list[idx] });
    this.stateManager.set(this.paths.relationships, updated, 'system');
    eventBus.emit('engine:request-save');
  }

  private setArchiveField(npcName: string, field: string, value: string): void {
    this.mutateNpc(npcName, (npc) => {
      const archive = this.ensureArchive(npc);
      npc['图片档案'] = { ...archive, [field]: value };
      return npc;
    });
  }

  private ensureArchive(npc: Record<string, unknown>): Record<string, unknown> {
    const raw = npc['图片档案'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
    return { [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [], [TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId]: '', '已选立绘图片ID': '', '已选背景图片ID': '', '最近生图结果': '' };
  }

  private getHistoryArray(archive: Record<string, unknown>): Array<Record<string, unknown>> {
    const raw = archive[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory];
    return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object') : [];
  }

  private mutateSceneArchive(mutator: (archive: Record<string, unknown>) => Record<string, unknown>): void {
    const raw = this.stateManager.get<Record<string, unknown>>(SYSTEM_PATHS.image.sceneArchive) ?? { [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [], '当前壁纸图片ID': '' };
    const archive = typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [], '当前壁纸图片ID': '' };
    const updated = mutator(archive);
    this.stateManager.set(SYSTEM_PATHS.image.sceneArchive, updated, 'system');
    eventBus.emit('engine:request-save');
  }

  private generateRecordId(): string {
    return `npc_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
