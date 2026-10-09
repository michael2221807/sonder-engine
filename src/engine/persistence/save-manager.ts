// App doc: docs/user-guide/pages/creation.md §2.10
/**
 * 存档管理器 — 处理游戏状态树的存取
 *
 * 存档数据（完整 GameStateTree）存储在 IndexedDB 中，
 * key 格式为 "save_{profileId}_{slotId}"。
 * 存档时同步更新 ProfileManager 中的元数据。
 *
 * 对应 STEP-03 M1.6。
 * 参照 demo: indexedDBManager.ts 中的 save/load 逻辑。
 */
import { cloneDeep, get as _get } from 'lodash-es';
import { idbAdapter } from './idb-adapter';
import type { GameStateTree, SaveSlotMeta } from '../types';
import type { ProfileManager } from './profile-manager';
import { eventBus } from '../core/event-bus';
import type { SaveReplacedEvent } from '../types/event-bus';
import { migrationRegistry, compareVersions } from './migration-registry';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { SAVE_FORMAT_VERSION, upgradeSaveFormat, type SaveFormatPaths } from './save-format/save-format-migration';
import { readPath } from './save-format/path-copy';
import { isPlainRecord } from './save-format/plain-data';

/** The engine paths the save format upgrade reads and writes. */
const SAVE_FORMAT_PATHS: SaveFormatPaths = {
  narrativeHistory: DEFAULT_ENGINE_PATHS.narrativeHistory,
  preRoundSnapshot: DEFAULT_ENGINE_PATHS.preRoundSnapshot,
  rollbackPatch: DEFAULT_ENGINE_PATHS.rollbackPatch,
  roundNumber: DEFAULT_ENGINE_PATHS.roundNumber,
  saveFormat: DEFAULT_ENGINE_PATHS.saveFormat,
};

/** An upgrade that held the page longer than this is explained to the player once it is done. */
const SLOW_UPGRADE_MS = 1000;

/**
 * 从状态树读取回合序号快照（`DEFAULT_ENGINE_PATHS.roundNumber`）。
 * 非有限数字（缺字段 / 写卡会话 / 脏数据）一律返回 null，避免把陈旧值留在槽元数据里。
 */
function readRoundNumber(stateTree: GameStateTree): number | null {
  const raw: unknown = _get(stateTree, DEFAULT_ENGINE_PATHS.roundNumber);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 存档在 IndexedDB 中的 key 格式 */
export function saveKey(profileId: string, slotId: string): string {
  return `save_${profileId}_${slotId}`;
}

/**
 * The copy of a save's old-format record, kept from the first write of the upgraded tree until the new format has
 * proved itself: a later session read it back in the new format and a round was played past the upgrade (存档瘦身
 * P1 §2.1).
 */
export function formatBackupKey(profileId: string, slotId: string): string {
  return `${saveKey(profileId, slotId)}:pre-format-${SAVE_FORMAT_VERSION}`;
}

/** The round of the first upgrade a tree's format marker records (null: none); undefined when it is not in the format. */
function migratedAtRoundOf(tree: unknown): number | null | undefined {
  const marker = readPath(tree, SAVE_FORMAT_PATHS.saveFormat);
  if (!isPlainRecord(marker) || marker.version !== SAVE_FORMAT_VERSION) return undefined;
  const round = marker.migratedAtRound;
  return typeof round === 'number' && Number.isFinite(round) ? round : null;
}

/** Whether a stored tree is in the current save format (it carries the marker an upgrade leaves). */
function isCurrentFormat(tree: unknown): boolean {
  return migratedAtRoundOf(tree) !== undefined;
}

export class SaveManager {
  /**
   * 当前 Game Pack 版本 —— §5.2 schema 迁移的目标版本号。
   * 由 `main.ts` 在 pack 加载后调用 `setCurrentPackVersion()` 设置。
   * 未设置时 loadGame 跳过迁移（保持旧行为）。
   */
  private currentPackVersion: string | null = null;

  /**
   * Save format upgrade bookkeeping, per save key, for this session:
   * - upgraded in memory on load, old record still in IndexedDB (copy it aside before the first write);
   * - how this session met the save in the current format: upgraded here (its later reads of what this session wrote
   *   prove nothing), or read back already in the current format, as an earlier session wrote it (the format works);
   * - the old-format copy dropped — no need to try again;
   * - an upgrade failure already reported to the player.
   */
  private readonly formatUpgradedUnsaved = new Set<string>();
  private readonly formatSeen = new Map<string, 'upgraded' | 'read-back'>();
  private readonly formatBackupSettled = new Set<string>();
  private readonly formatFailureReported = new Set<string>();

  /**
   * The writes of a slot that wait, in the order they were asked for. The first write of an upgraded slot waits while
   * the old record is copied aside; a save or delete of the slot asked for meanwhile goes after it, so a later write
   * never lands under an earlier one (the order idb-adapter keeps for writes waiting on the connection).
   */
  private readonly slotQueues = new Map<string, Promise<void>>();

  /** Rewrites a tree on its way into the database, at the call (存档瘦身 D1A: the rollback record). */
  private treeToSave: ((tree: GameStateTree) => GameStateTree) | undefined;

  constructor(private profileManager: ProfileManager) {}

  /**
   * Set at startup (bootstrap/game-loop.ts): every save passes the tree through `transform` before anything else, in
   * the same moment it is handed over — RollbackSnapshot.treeToSave puts the rollback record in the place of the
   * tree's marker. The transform copies only what it changes and never throws.
   */
  setTreeToSave(transform: (tree: GameStateTree) => GameStateTree): void {
    this.treeToSave = transform;
  }

  /**
   * The tree as a save would write it at this moment (the rollback record in the place of its marker), for a caller
   * that keeps a tree to write later: once another tree is loaded, the marker names nothing any more and the save
   * would go without its rollback (VectorBoardAccess, an arrangement kept for the previous save).
   */
  prepareTree(tree: GameStateTree): GameStateTree {
    return this.treeToSave ? this.treeToSave(tree) : tree;
  }

  /**
   * §5.2 Gap fix：设置当前 Game Pack 的版本号
   *
   * 必须在 `main.ts` 的 pack 加载之后、任何 loadGame 调用之前调用。
   * SaveManager 实例化时 pack 尚未加载，所以用 setter 而非构造参数。
   */
  setCurrentPackVersion(version: string): void {
    this.currentPackVersion = version;
  }

  /**
   * 保存游戏
   * @param meta 可选的展示信息更新（角色名、位置、游戏时间等）
   */
  async saveGame(
    profileId: string,
    slotId: string,
    stateTree: GameStateTree,
    meta?: Partial<SaveSlotMeta>,
    commit?: { guard: () => void; committed: () => void },
  ): Promise<void> {
    const key = saveKey(profileId, slotId);
    // 5.3: 自动从状态树提取展示字段 — read before the write starts, from the same tree it writes. The save's size is
    // not measured here (a whole-tree serialisation each round, 存档瘦身 D9A): the save panel measures the save in play
    // when it opens.
    // 安全读取 角色.可变属性.地位.名称（多层可选链）
    const root = stateTree as Record<string, unknown>;
    const charAttrs = (root['角色'] as Record<string, unknown> | undefined)?.['可变属性'] as Record<string, unknown> | undefined;
    const statusObj = charAttrs?.['地位'] as Record<string, unknown> | undefined;
    const characterStatus = typeof statusObj?.['名称'] === 'string' ? statusObj['名称'] : undefined;
    const roundNumber = readRoundNumber(stateTree);

    // No copy here: the adapter writes the tree as it is at this call (the browser copies it into the database),
    // so a caller may hand over the live tree (P1 存档写入提速, docs/design/plot-vector-rebuild-plan.md §13.1).
    // The rollback record is made now too, from the same tree (it shares everything else with it).
    let written = this.treeToSave ? this.treeToSave(stateTree) : stateTree;
    // The first write of a tree upgraded in memory replaces the old-format record, which is copied aside first; a save
    // asked for while that runs goes after it. Either waits on the database, so what it writes is frozen now, as the
    // caller handed it over.
    const first = this.formatUpgradedUnsaved.delete(key);
    if (first || this.slotQueues.has(key)) written = cloneDeep(written);
    const upgradedAt = migratedAtRoundOf(written);
    await this.inSlotOrder(key, first, async () => {
      if (first) await this.keepOldFormatRecord(profileId, slotId);
      await this.writeRecord(key, written, commit);
    });
    await this.dropOldFormatRecordOnceProved(profileId, slotId, upgradedAt, roundNumber);

    // 联动更新 ProfileManager 中的存档元数据
    // §5.2：每次存档都把 slotMeta.packVersion 戳为当前 pack 版本，保证下次 loadGame
    // 的迁移比对基准是最新的。若 currentPackVersion 未设置（pack 加载失败等），
    // 保持原有行为（不写 packVersion 字段）。
    await this.profileManager.updateSlotMeta(profileId, slotId, {
      lastSavedAt: new Date().toISOString(),
      characterStatus,
      // 云端插槽新鲜度比较的回合依据（docs/design/cloud-slot-freshness.md §3）
      roundNumber,
      ...(this.currentPackVersion ? { packVersion: this.currentPackVersion } : {}),
      ...meta,
    });
    eventBus.emit('engine:save-complete', { profileId, slotId });
  }

  /**
   * 加载存档 — 返回完整状态树（或 undefined 表示无存档）
   *
   * 存档瘦身 P1：先把引擎存档格式升级到当前版本（save-format-migration.ts）——只在内存里，读取时不写库；
   * 打开的游戏第一次存档时写成新格式（写前把库里的旧记录复制到备份键）。升级失败按原样返回（只提示一次）。
   *
   * §5.2 Gap fix：在读取后自动应用 schema 迁移。
   * - 读 `slotMeta.packVersion` 得到存档创建/上次迁移时的 pack 版本
   * - 若 `currentPackVersion` 已设置且严格大于存档版本，调 `migrationRegistry.apply()`
   * - 迁移成功时把 `slotMeta.packVersion` 更新为目标版本（幂等）
   * - 迁移失败（某条 migrate 抛错）时 surface warning，返回 **部分** 迁移后的数据
   *   —— 宁可让用户看到半熟数据也比崩掉游戏好；真正的破坏性 schema 变更应该在
   *   对应 migrate 函数内部做自我校验
   * - 迁移中途写存档失败不影响返回值：当前进程内仍用新数据继续游戏，下次加载
   *   会重新迁移一次（幂等）
   */
  async loadGame(profileId: string, slotId: string): Promise<GameStateTree | undefined> {
    const stored = await idbAdapter.get<GameStateTree>(saveKey(profileId, slotId));
    if (!stored) return undefined;
    // Engine save format first (in memory, no write), then the pack's migrations on the upgraded tree.
    const raw = this.upgradeFormat(profileId, slotId, stored);

    // Fast-path: 未设置 currentPackVersion（例如 pack 加载失败）→ 跳过迁移
    if (!this.currentPackVersion) return raw;

    const slotMeta = this.profileManager.getSlotMeta(profileId, slotId);
    const fromVersion = slotMeta?.packVersion ?? '';

    // Fast-path: 存档版本等于或超过当前版本 → 无需迁移
    if (fromVersion && compareVersions(fromVersion, this.currentPackVersion) >= 0) {
      return raw;
    }

    // 应用迁移链
    const result = migrationRegistry.apply(
      raw as unknown as Record<string, unknown>,
      fromVersion || '0',
      this.currentPackVersion,
    );

    if (result.applied.length === 0) {
      // 无可用迁移 —— 可能是注册表为空，也可能是没有覆盖此版本区间的迁移。
      // 两种情况都让旧存档按原样加载（ValidationRepair 会尽力修复）。
      if (fromVersion !== this.currentPackVersion) {
        console.warn(
          `[SaveManager] No migration path ${fromVersion || '(empty)'} → ${this.currentPackVersion}; ` +
          'loading save as-is. ValidationRepair will attempt field-level recovery.',
        );
      }
      return raw;
    }

    console.log(
      `[SaveManager] Applied ${result.applied.length} migration(s) ` +
      `${fromVersion || '0'} → ${result.finalVersion}: ` +
      result.applied.map((m) => m.description).join(' → '),
    );

    if (result.error) {
      console.warn(
        `[SaveManager] Migration chain interrupted at ${result.finalVersion}:`,
        result.error,
      );
    }

    // A migration prefix is not a valid target-version save. Returning or
    // persisting it would silently turn one compatible old save into a
    // half-migrated save when the registry has a gap (for example 0 → 0.5
    // while the installed pack is 0.6). Keep both IDB and runtime data intact.
    if (!result.error && compareVersions(result.finalVersion, this.currentPackVersion) < 0) {
      console.warn(
        `[SaveManager] Incomplete migration path ${fromVersion || '0'} → ${this.currentPackVersion}; ` +
        `stopped at ${result.finalVersion}. Loading the original save without rewriting it.`,
      );
      return raw;
    }

    // Persist migrated data + version to IDB so next load doesn't re-migrate
    if (!result.error && result.finalVersion !== fromVersion) {
      try {
        const backupKey = saveKey(profileId, slotId) + ':pre-migration';
        // The record as it was stored: the pack migration's backup also stands for the old engine format.
        await idbAdapter.set(backupKey, stored);
        await idbAdapter.set(saveKey(profileId, slotId), result.data);
        this.formatUpgradedUnsaved.delete(saveKey(profileId, slotId));
        await this.profileManager.updateSlotMeta(profileId, slotId, {
          packVersion: result.finalVersion,
        });
      } catch (err) {
        console.warn('[SaveManager] Failed to persist migrated save:', err);
      }
    }

    return result.data as unknown as GameStateTree;
  }

  /**
   * The stored tree in the current engine save format, upgraded in memory (save-format-migration.ts): nothing is
   * written here — the first save of the opened game writes the new format. An upgrade that fails is reported once and
   * the tree is used as it was (every reader still understands the old format). An upgrade that held the page for more
   * than a second (a large old save, the first time) is explained once it is done: it runs in one go, so a notice put up
   * before it could not be relied on to show while it runs.
   */
  private upgradeFormat(profileId: string, slotId: string, stored: GameStateTree): GameStateTree {
    const key = saveKey(profileId, slotId);
    const started = Date.now();
    try {
      const upgrade = upgradeSaveFormat(stored, SAVE_FORMAT_PATHS);
      const ms = Date.now() - started;
      if (upgrade.changed) {
        // A tree already in this format changes again only when older code wrote old-shaped data into it (a tab left
        // open across the update) or the round-time trim disagrees with the upgrade; either way its old-format copy is
        // kept until a later session reads the tree back unchanged.
        if (isCurrentFormat(stored)) console.warn(`[SaveManager] ${key} is in save format ${SAVE_FORMAT_VERSION} yet needed upgrading again`);
        this.formatUpgradedUnsaved.add(key);
        this.formatSeen.set(key, 'upgraded');
        console.info(
          `[SaveManager] Upgraded ${key} to save format ${SAVE_FORMAT_VERSION} in memory (${ms} ms): ` +
          `${upgrade.tracesTrimmed} trace(s) trimmed, change records ${upgrade.recordsCompacted ? 'compacted' : 'already compact'}, ` +
          (upgrade.snapshotToPatch ? 'snapshot turned into a rollback patch' : 'no old snapshot'),
        );
        if (ms > SLOW_UPGRADE_MS) {
          eventBus.emit('ui:toast', {
            type: 'info',
            i18nKey: 'engine.toast.saveFormatUpgradedSlow',
            message: '存档格式已升级（较大的旧存档第一次打开会慢一些）',
            duration: 5000,
          });
        }
      } else if (isCurrentFormat(stored) && this.formatSeen.get(key) !== 'upgraded') {
        this.formatSeen.set(key, 'read-back');
      }
      return upgrade.tree;
    } catch (err) {
      console.warn(`[SaveManager] Save format upgrade of ${key} failed; loading the save as it was:`, err);
      if (!this.formatFailureReported.has(key)) {
        this.formatFailureReported.add(key);
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.saveFormatUpgradeFailed',
          message: '存档格式升级失败，已按原格式载入（不影响游玩）',
          duration: 6000,
        });
      }
      return stored;
    }
  }

  /**
   * Run a write of the slot now, or after the slot's waiting writes when there are any. `opensQueue`: this write itself
   * waits (it copies first), so the writes asked for meanwhile go after it.
   */
  private inSlotOrder(key: string, opensQueue: boolean, write: () => Promise<void>): Promise<void> {
    const ahead = this.slotQueues.get(key);
    if (ahead === undefined && !opensQueue) return write();
    const done = ahead === undefined ? write() : ahead.then(write);
    const settled = done.then(() => undefined, () => undefined);
    this.slotQueues.set(key, settled);
    void settled.then(() => { if (this.slotQueues.get(key) === settled) this.slotQueues.delete(key); });
    return done;
  }

  /** One write of the save record; a round save rechecks inside the write that it still belongs to the active slot. */
  private async writeRecord(key: string, tree: GameStateTree, commit?: { guard: () => void; committed: () => void }): Promise<void> {
    if (commit) {
      await idbAdapter.setGuarded(key, tree, commit.guard);
      commit.committed();
    } else {
      await idbAdapter.set(key, tree);
    }
  }

  /**
   * Before the first write of an upgraded tree: copy the old-format record still in IndexedDB aside. A copy that fails
   * (storage full, a read error) never stops the save itself — the new tree is smaller than the old record — and is not
   * tried again.
   */
  private async keepOldFormatRecord(profileId: string, slotId: string): Promise<void> {
    const key = saveKey(profileId, slotId);
    try {
      const old = await idbAdapter.get<GameStateTree>(key);
      if (old && !isCurrentFormat(old)) await idbAdapter.set(formatBackupKey(profileId, slotId), old);
    } catch (err) {
      console.warn(`[SaveManager] Could not keep a copy of the old-format record of ${key}; saving on without it:`, err);
    }
  }

  /**
   * After a write: drop the copy of the old-format record once the new format has proved itself — a later session read
   * the slot back already in the new format, and the tree written (`upgradedAt`, `round`: read from it at the call) is
   * in the new format with a round played past the upgrade. A save upgraded without a round number needs no round.
   */
  private async dropOldFormatRecordOnceProved(
    profileId: string,
    slotId: string,
    upgradedAt: number | null | undefined,
    round: number | null,
  ): Promise<void> {
    const key = saveKey(profileId, slotId);
    if (this.formatBackupSettled.has(key) || this.formatSeen.get(key) !== 'read-back') return;
    if (upgradedAt === undefined || (upgradedAt !== null && (round === null || round <= upgradedAt))) return;
    try {
      await idbAdapter.delete(formatBackupKey(profileId, slotId));
      this.formatBackupSettled.add(key);
    } catch (err) {
      console.warn('[SaveManager] Could not drop the old-format copy (it will be tried again):', err);
    }
  }

  /** 删除存档 */
  async deleteGame(profileId: string, slotId: string): Promise<void> {
    // A board arrangement still waiting for this profile must not bring the save back (§13.1).
    eventBus.emit('engine:save-replaced', { profileId } satisfies SaveReplacedEvent);
    const key = saveKey(profileId, slotId);
    // After a write of the slot still waiting (the first write of an upgraded save): it must not bring the save back.
    await this.inSlotOrder(key, false, async () => {
      await idbAdapter.delete(key);
      // The old-format copy goes with its save (it is never read back by the game).
      await idbAdapter.delete(formatBackupKey(profileId, slotId));
    });
    this.formatUpgradedUnsaved.delete(key);
    this.formatSeen.delete(key);
    this.formatBackupSettled.delete(key);
    this.formatFailureReported.delete(key);
  }

  /** 检查存档是否存在 */
  async hasSave(profileId: string, slotId: string): Promise<boolean> {
    const data = await idbAdapter.get(saveKey(profileId, slotId));
    return data !== undefined;
  }
}
