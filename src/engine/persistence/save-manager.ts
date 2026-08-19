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
import { cloneDeep } from 'lodash-es';
import { idbAdapter } from './idb-adapter';
import type { GameStateTree, SaveSlotMeta } from '../types';
import type { ProfileManager } from './profile-manager';
import { eventBus } from '../core/event-bus';
import { migrationRegistry, compareVersions } from './migration-registry';

/** 存档在 IndexedDB 中的 key 格式 */
function saveKey(profileId: string, slotId: string): string {
  return `save_${profileId}_${slotId}`;
}

export class SaveManager {
  /**
   * 当前 Game Pack 版本 —— §5.2 schema 迁移的目标版本号。
   * 由 `main.ts` 在 pack 加载后调用 `setCurrentPackVersion()` 设置。
   * 未设置时 loadGame 跳过迁移（保持旧行为）。
   */
  private currentPackVersion: string | null = null;

  constructor(private profileManager: ProfileManager) {}

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
  ): Promise<void> {
    const data = cloneDeep(stateTree);
    await idbAdapter.set(saveKey(profileId, slotId), data);

    // 5.3: 自动从状态树提取展示字段
    const jsonStr = JSON.stringify(data);
    const saveSize = jsonStr.length;

    // 安全读取 角色.可变属性.地位.名称（多层可选链）
    const root = data as Record<string, unknown>;
    const charAttrs = (root['角色'] as Record<string, unknown> | undefined)?.['可变属性'] as Record<string, unknown> | undefined;
    const statusObj = charAttrs?.['地位'] as Record<string, unknown> | undefined;
    const characterStatus = typeof statusObj?.['名称'] === 'string' ? statusObj['名称'] : undefined;

    // 联动更新 ProfileManager 中的存档元数据
    // §5.2：每次存档都把 slotMeta.packVersion 戳为当前 pack 版本，保证下次 loadGame
    // 的迁移比对基准是最新的。若 currentPackVersion 未设置（pack 加载失败等），
    // 保持原有行为（不写 packVersion 字段）。
    await this.profileManager.updateSlotMeta(profileId, slotId, {
      lastSavedAt: new Date().toISOString(),
      saveSize,
      characterStatus,
      ...(this.currentPackVersion ? { packVersion: this.currentPackVersion } : {}),
      ...meta,
    });
    eventBus.emit('engine:save-complete', { profileId, slotId });
  }

  /**
   * 加载存档 — 返回完整状态树（或 undefined 表示无存档）
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
    const raw = await idbAdapter.get<GameStateTree>(saveKey(profileId, slotId));
    if (!raw) return undefined;

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
        await idbAdapter.set(backupKey, raw);
        await idbAdapter.set(saveKey(profileId, slotId), result.data);
        await this.profileManager.updateSlotMeta(profileId, slotId, {
          packVersion: result.finalVersion,
        });
      } catch (err) {
        console.warn('[SaveManager] Failed to persist migrated save:', err);
      }
    }

    return result.data as unknown as GameStateTree;
  }

  /** 删除存档 */
  async deleteGame(profileId: string, slotId: string): Promise<void> {
    await idbAdapter.delete(saveKey(profileId, slotId));
  }

  /** 检查存档是否存在 */
  async hasSave(profileId: string, slotId: string): Promise<boolean> {
    const data = await idbAdapter.get(saveKey(profileId, slotId));
    return data !== undefined;
  }
}
