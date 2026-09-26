/**
 * 角色档案管理器 — 管理多角色、多存档槽的元数据
 *
 * 数据层级：StorageRoot → ProfileMeta → SaveSlotMeta
 * 元数据存储在 IndexedDB 的 "storage_root" key 下，
 * 实际存档数据由 SaveManager 单独管理。
 *
 * 对应 STEP-03 M1.6。
 * 参照 demo: indexedDBManager.ts 中的 profile/save 管理逻辑。
 */
import { cloneDeep } from 'lodash-es';
import { idbAdapter } from './idb-adapter';
import type { ProfileMeta, SaveSlotMeta, StorageRoot } from '../types';

/** IndexedDB 中存储根数据的 key */
const ROOT_KEY = 'storage_root';

export class ProfileManager {
  /** 运行时缓存的存储根 — 初始化后始终与 IndexedDB 保持同步 */
  private root: StorageRoot | null = null;

  /**
   * 初始化 — 从 IndexedDB 加载已有数据或创建空根
   * 必须在应用启动时调用一次
   */
  async initialize(): Promise<void> {
    const stored = await idbAdapter.get<StorageRoot>(ROOT_KEY);
    this.root = stored ?? { activeProfile: null, profiles: {} };
  }

  /** 将内存中的根数据持久化到 IndexedDB */
  private async persist(): Promise<void> {
    if (this.root) {
      await idbAdapter.set(ROOT_KEY, cloneDeep(this.root));
    }
  }

  /** 获取存储根（未初始化时抛出错误） */
  getRoot(): StorageRoot {
    if (!this.root) throw new Error('ProfileManager not initialized');
    return this.root;
  }

  /** 创建新角色档案 */
  async createProfile(meta: ProfileMeta): Promise<void> {
    this.getRoot().profiles[meta.profileId] = cloneDeep(meta);
    await this.persist();
  }

  /**
   * 删除角色档案
   * 注意：此方法只删除元数据，实际存档数据需由调用方通过 SaveManager 清理
   */
  async deleteProfile(profileId: string): Promise<void> {
    delete this.getRoot().profiles[profileId];
    // 若删除的是当前活跃角色，清空活跃标记
    if (this.root?.activeProfile?.profileId === profileId) {
      this.root.activeProfile = null;
    }
    await this.persist();
  }

  /**
   * 清空活跃档案指针 — 供档案级导入在"来包档案零槽位"时消除悬空引用
   * （backup-service.importProfileReplace 第 5 步）。
   */
  async clearActiveProfile(): Promise<void> {
    this.getRoot().activeProfile = null;
    await this.persist();
  }

  /** 设置当前活跃角色及存档槽 — 校验 profile 必须存在 */
  async setActiveProfile(profileId: string, slotId: string): Promise<void> {
    const root = this.getRoot();
    if (!root.profiles[profileId]) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }
    root.activeProfile = { profileId, slotId };
    await this.persist();
  }

  /**
   * 更新存档槽元数据
   * 由 SaveManager.saveGame 调用，同步更新最后保存时间等展示信息
   */
  async updateSlotMeta(
    profileId: string,
    slotId: string,
    update: Partial<SaveSlotMeta>,
  ): Promise<void> {
    const profile = this.getRoot().profiles[profileId];
    if (!profile) return;

    const existing = profile.slots[slotId];
    if (existing) {
      // 已有 slot → 部分更新
      profile.slots[slotId] = { ...existing, ...update };
    } else {
      // 新 slot → 以安全默认值创建，再覆盖传入字段
      profile.slots[slotId] = {
        slotId,
        slotName: slotId,
        lastSavedAt: null,
        packId: profile.packId,
        packVersion: '',
        ...update,
      };
    }
    await this.persist();
  }

  /** 列出所有角色档案 */
  listProfiles(): ProfileMeta[] {
    return Object.values(this.getRoot().profiles);
  }

  /** 按 ID 获取角色档案 */
  getProfile(profileId: string): ProfileMeta | undefined {
    return this.getRoot().profiles[profileId];
  }

  /**
   * 获取指定存档槽的元数据
   *
   * §5.2 Gap fix：SaveManager.loadGame 需要读 packVersion 来决定是否应用迁移。
   * 直接暴露便捷 getter，避免调用方重复做 `getProfile → slots[slotId]` 的空值检查。
   */
  getSlotMeta(profileId: string, slotId: string): SaveSlotMeta | undefined {
    return this.getRoot().profiles[profileId]?.slots[slotId];
  }

  /**
   * 从档案元数据中移除某一存档槽（不删 IDB 中的存档字节）
   *
   * 调用方须先 `SaveManager.deleteGame(profileId, slotId)` 再调用本方法，
   * 以免出现「元数据无槽但 IDB 仍有 save key」的不一致。
   */
  async removeSaveSlot(profileId: string, slotId: string): Promise<void> {
    const profile = this.getRoot().profiles[profileId];
    if (!profile) return;
    delete profile.slots[slotId];
    if (profile.activeSlotId === slotId) {
      profile.activeSlotId = null;
    }
    await this.persist();
  }

  /**
   * 清除全部数据 — 清空 IndexedDB 整个 store（包含所有档案元数据、存档数据、向量数据）
   * 并重置内存缓存。
   *
   * 供 SettingsPanel "清除所有数据" 功能调用。
   * 调用后应用应导航到首页，避免 UI 继续依赖已清空的状态。
   */
  async clearAll(): Promise<void> {
    await idbAdapter.clear();
    // 重置内存缓存，防止持久化残留数据
    this.root = { activeProfile: null, profiles: {} };
  }
}
