/**
 * 持久化层类型定义
 *
 * 定义存档、角色档案和存储根结构。
 * 对应 STEP-02 §3.8 Persistence Engine 和 demo 的 indexedDBManager 模式。
 *
 * 数据层级：StorageRoot → ProfileMeta → SaveSlotMeta → GameStateTree(存档数据)
 */

/**
 * 会话模式（Story 9 / D17）
 * - 'play': 游玩模式（默认）
 * - 'worldBuilding': 写卡模式（造世界/做游戏卡）
 *
 * 纯 UI 层可见性开关：引擎管线**不读**此字段，仅 UI 据此调整控件可见性。
 * 缺省 / 旧存档（undefined）一律视为 'play'。不进入 GameStateTree，不进 .aga-card。
 */
export type SessionType = 'play' | 'worldBuilding';

/**
 * 存档槽位元数据
 * 轻量数据，用于存档列表的快速展示（无需加载完整状态树）
 */
export interface SaveSlotMeta {
  /** 槽位 ID */
  slotId: string;
  /** 槽位显示名称 */
  slotName: string;
  /** 最后保存时间（ISO 字符串），未保存过则为 null */
  lastSavedAt: string | null;
  /** 游戏内时间快照（展示用） */
  gameTime?: string;
  /** 角色名快照（展示用） */
  characterName?: string;
  /** 当前位置快照（展示用） */
  currentLocation?: string;
  /** 所属游戏包 ID */
  packId: string;
  /** 存档时的游戏包版本 */
  packVersion: string;
  /** 角色社会地位快照（展示用，来自 角色.可变属性.地位.名称） */
  characterStatus?: string;
  /** 存档大小估算（字节，JSON.stringify().length） */
  saveSize?: number;
  /** 存档类型：手动、回合前快照、时间点、退出前 */
  saveType?: 'manual' | 'pre-round' | 'timepoint' | 'exit' | 'auto';
  /**
   * 存档时的回合序号快照（展示 / 云端新鲜度比较用，2026-09-12）。
   * `SaveManager.saveGame` 每次落盘从状态树 `DEFAULT_ENGINE_PATHS.roundNumber` 读取；
   * 状态树没有该字段（写卡会话等）时写 `null`。旧存档缺省 ⇒ 视为未知。
   * 见 docs/design/cloud-slot-freshness.md §3。
   */
  roundNumber?: number | null;
  /**
   * 会话模式（Story 9 / D17）：'play' 游玩 | 'worldBuilding' 写卡。
   * UI 层可见性开关，引擎管线不读。缺省 / 旧存档视为 'play'。
   */
  sessionType?: SessionType;
}

/**
 * 角色档案元数据
 * 一个档案对应一个角色，包含该角色的所有存档槽
 */
export interface ProfileMeta {
  /** 档案 ID（如 "profile_1712345678"） */
  profileId: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 所用游戏包 ID */
  packId: string;
  /** 角色名（展示用） */
  characterName: string;
  /** 存档槽位集合（key = slotId） */
  slots: Record<string, SaveSlotMeta>;
  /** 当前活跃的存档槽 ID */
  activeSlotId: string | null;
}

/**
 * 持久化层顶层结构
 * 存储在 IndexedDB 的 "storage_root" key 下
 */
export interface StorageRoot {
  /** 当前活跃的角色和存档 */
  activeProfile: { profileId: string; slotId: string } | null;
  /** 所有角色档案（key = profileId） */
  profiles: Record<string, ProfileMeta>;
}

/**
 * 版本迁移定义
 * 用于存档格式升级（如 Game Pack 版本更新后的数据迁移）
 */
export interface Migration {
  /** 源版本号 */
  fromVersion: number;
  /** 目标版本号 */
  toVersion: number;
  /** 迁移函数 — 接收旧数据返回新数据 */
  migrate: (data: unknown) => unknown;
}
