// Archived plan: docs/status/archive/full-backup-plan-2026-04-13.md
// App doc: docs/user-guide/pages/game-save.md §3.2 (完整备份), §2.5 (游戏卡导出复用 collectAssetIdsFromTree)
/**
 * 全量备份与恢复服务 — 跨模块数据导出/导入
 *
 * 将引擎中所有持久化数据（角色档案、存档、向量、配置、prompt、引擎设置）
 * 打包为单一 JSON Blob，用于备份导出和恢复导入。
 *
 * 设计决策：
 * - 使用 JSON 序列化（而非二进制格式），便于调试和手动修复
 * - 导入采用"尽力恢复"策略：某模块失败不中断其他模块的导入
 * - 引擎设置从 localStorage 中以 `aga_` / `aga-` 前缀筛选，避免采集无关数据
 * - 使用 structuredClone 深拷贝，切断响应式 proxy 和原始数据的引用
 * - 单档案导出 exportProfile 仅包含该角色相关数据（不含全局配置/prompt）
 *
 * 对应 STEP-03B M5 全量备份/恢复。
 */
import { idbAdapter } from './idb-adapter';
import { eventBus } from '../core/event-bus';
import type { ProfileManager } from './profile-manager';
import type { SaveManager } from './save-manager';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import type { VectorStore } from '../memory/engram/vector-store';
import type { CustomPresetStore, CustomPresetEntry } from './custom-preset-store';
import type { ImageAssetCache } from '../image/asset-cache';
import type { ImageAsset } from '../image/types';
import type { ProfileMeta } from '../types';

// ─── 常量 ───

/** 备份文件的格式版本 — 导入时用于兼容性校验和未来的格式迁移 */
const BACKUP_FORMAT_VERSION = 1;

/**
 * 引擎版本 — 标记导出时的引擎代码版本
 * 导入时可据此判断是否需要对备份数据做迁移变换
 */
const ENGINE_VERSION = '0.1.0';

/**
 * localStorage 中引擎相关 key 的前缀集合
 *
 * 正式版混用 `aga_`（下划线，如 `aga_api_management`）与历史 `aga-`（横杠）；
 * 备份须同时采集，否则恢复后 API / 设置 / Action Queue 会丢失。
 * 对应 STEP-03B M5.2 engineSettings。
 */
const LS_KEY_PREFIXES = ['aga_', 'aga-'] as const;

/**
 * Device-local localStorage keys that must NEVER travel in a backup / cloud sync.
 *
 * These hold per-device sync bookkeeping, not user content or portable settings.
 * Exporting them and restoring on another device would corrupt that device's own
 * state. Concretely `aga_github_sync_baseline` is *this* device's view of the
 * last-synced cloud manifest `createdAt` — the multi-device conflict token
 * (github-sync.ts). If device A's baseline landed on device B, B would either
 * miss a real conflict or raise a false one.
 *
 * Excluded from FOUR places: collect (never exported), wipe (a foreign
 * full-restore must not erase this device's sync state), restore (a bundle must
 * never write it), and the import-rollback snapshot write-back (restoreFromSnapshot).
 * Keys here still match LS_KEY_PREFIXES — the Set is the override that carves them
 * back out.
 *
 * Members (both from github-sync.ts):
 * - aga_github_sync_baseline — last-synced cloud manifest createdAt (conflict token)
 * - aga_github_sync_pending  — "this device has a local save not yet auto-uploaded"
 *   (survives across sessions so a failed tail-flush is retried next session)
 */
const LS_DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set([
  'aga_github_sync_baseline',
  'aga_github_sync_pending',
  // 存档插槽 epic（2026-07-23）：插槽化后基线/待传标志变为 per-slot JSON map，
  // 语义仍是"本设备的同步记账"，同样绝不随备份/云同步迁移。旧两个标量键保留在
  // 排除集——升级期间旧客户端仍在写它们。
  'aga_github_sync_baselines',
  'aga_github_sync_pending_map',
  // 设备指纹（2026-08-21）：云上传审计用的本设备稳定 ID（device-identity.ts）。
  // 若随备份迁移，恢复方会继承源设备的指纹，"这个存档是哪台设备传的"就失去意义。
  'aga_device_id',
]);

// ─── 类型 ───

/**
 * 备份数据包 — 包含引擎所有可恢复数据
 *
 * 各字段使用 `Record<string, unknown>` 而非强类型，
 * 因为备份包需要跨版本兼容：导入端的类型可能已发生变化，
 * 实际类型校验由各子模块在 importAll 时自行处理。
 */
export interface BackupBundle {
  /** 备份格式版本号 — 用于兼容性校验 */
  version: number;
  /** 导出时间（ISO 8601 字符串） */
  exportedAt: string;
  /** 导出时的引擎代码版本 */
  engineVersion: string;
  /**
   * 备份类型标记（v1.1 新增，optional）
   * - 'full' — 完整备份：所有 profiles + configs + prompts + engineSettings
   * - 'profile' — 单角色备份：仅该 profile 的数据，不含全局设置
   * - 'global' — 全局设置包（2026-07-23 存档插槽 epic 新增）：仅 configs/prompts/
   *   engineSettings/customPresets/builtinPromptOverrides，profiles/saves/vectors 为空。
   *   云端 `global/` 设置插槽的载荷（docs/design/github-save-slots-design.md §5.1）。
   * 旧 v1 备份无此字段，由 isFullBackup() 通过其他字段推断
   */
  bundleType?: 'full' | 'profile' | 'global';
  /**
   * StorageRoot.activeProfile 根指针（v1.1 新增，optional）
   * 完整备份时包含，单角色备份时为 null
   * 导入时用于恢复"当前活跃游戏"的指针，使用户刷新后能直接继续
   */
  activeProfile?: { profileId: string; slotId: string } | null;
  /** 角色档案元数据 — key = profileId */
  profiles: Record<string, unknown>;
  /** 存档状态树 — key = "profileId/slotId" */
  saves: Record<string, unknown>;
  /** 向量存储数据 — key = "profileId/slotId" */
  vectors: Record<string, unknown>;
  /** 配置覆盖数据 — { overlays: ConfigOverlay[] } */
  configs: Record<string, unknown>;
  /** Prompt 用户覆盖 — { entries: { key, value }[] } */
  prompts: Record<string, unknown>;
  /** localStorage：`aga_*` / `aga-*`（见 collectLocalStorageSettings） */
  engineSettings: Record<string, string | null>;
  /**
   * 2026-04-14 新增：用户自定义创角预设
   *
   * 结构：`{ packId: { presetType: CustomPresetEntry[] } }`
   * 例：`{ "tianming": { "worlds": [...], "origins": [...] } }`
   *
   * 全量备份时收集所有 pack 的 user 数据；导入时逐 pack 调
   * `customPresetStore.replaceAll`。Optional —— 旧 bundle 不含此字段时
   * 不影响导入，导入后用户预设保持空（与"新装机用户"等效）。
   */
  customPresets?: Record<string, Record<string, CustomPresetEntry[]>>;
  /**
   * 2026-04-25 新增：图片资产（base64 编码）
   *
   * 默认仅导出"已选用"的图片（头像、立绘、壁纸、香闺秘档），
   * 可选导出全部生图历史。
   * Optional —— 旧 bundle 不含此字段时不影响导入。
   */
  imageAssets?: Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }>;
  /** 2026-05-19 新增：世界书数据 */
  worldBooks?: import('../prompt/world-book').WorldBookExportData;
  /** 2026-05-19 新增：内置提示词覆盖 */
  builtinPromptOverrides?: import('../prompt/world-book').BuiltinPromptExportData;
}

/**
 * 图片导出完整性 — 记录最近一次 exportAll/exportProfile 的图片引用与实际导出数量。
 *
 * `referencedAssets`：导出的存档树中引用到的不同图片资产 ID 数。
 * `exportedAssets`：其中实际在 ImageAssetCache 中找到并写入备份的数量。
 *
 * 当 `referencedAssets > 0` 而 `exportedAssets` 远小于它（尤其为 0）时，说明本地图片缓存
 * 已被浏览器驱逐/清空，本次备份缺图。GitHubSyncService 依此拦截"用缺图存档覆盖云端好备份"。
 */
export interface ExportImageIntegrity {
  referencedAssets: number;
  exportedAssets: number;
}

/**
 * 档案元数据声明的存档槽与实际存档记录不一致。
 *
 * 这种状态不是“合法空档案”：继续导出会得到 `saves: {}`，继而让图片完整性
 * 检查退化成 0 === 0，并可能用结构性空壳覆盖健康云存档。
 */
export class ProfileSaveIntegrityError extends Error {
  constructor(
    public readonly profileId: string,
    public readonly missingSlotIds: string[],
    public readonly orphanSaveSlotIds: string[] = [],
  ) {
    const problems = [
      missingSlotIds.length > 0
        ? `元数据有槽但存档数据缺失：${missingSlotIds.join(', ')}`
        : '',
      orphanSaveSlotIds.length > 0
        ? `存档数据有槽但元数据缺失：${orphanSaveSlotIds.join(', ')}`
        : '',
    ].filter(Boolean).join('；');
    super(
      `档案“${profileId}”的存档结构不完整（${problems}）。` +
      '已阻止导出/上传/导入，请先从健康备份恢复，勿覆盖现有数据。',
    );
    this.name = 'ProfileSaveIntegrityError';
  }
}

/**
 * 档案展示元信息 — 随 exportProfileForSync 返回，供云端插槽 manifest 携带
 * （插槽列表 UI 无需下载整包即可显示档案名/槽数等）。
 */
export interface ProfileDisplayMeta {
  profileId: string;
  profileName: string;
  packId: string;
  slotCount: number;
  /** 各槽 lastSavedAt 的最大值（ISO），全部未保存过则为 null */
  lastPlayedAt: string | null;
}

/**
 * 导入结果报告 — 逐模块记录恢复状态（仅单角色合并流程使用）
 *
 * 布尔字段标记对应模块是否导入成功，
 * errors 收集所有失败模块的错误消息。
 */
interface ImportReport {
  profiles: boolean;
  saves: boolean;
  vectors: boolean;
  configs: boolean;
  prompts: boolean;
  engineSettings: boolean;
  errors: string[];
}

/**
 * 导入前状态快照 —— 用于全替换流程失败时回滚
 *
 * 包含：
 * - idb: idbAdapter 全部 key → 值（主 IDB store 完整镜像）
 * - ls: 所有 aga_* / aga-* localStorage 键值
 * - configOverlays: ConfigStore 独立存储中的全部 overlays
 * - promptEntries: PromptStorage 独立存储中的全部 entries
 */
interface PreImportSnapshot {
  idb: Record<string, unknown>;
  ls: Record<string, string | null>;
  configOverlays: unknown;
  promptEntries: unknown;
  /**
   * 2026-04-14 新增：用户自定义预设按 packId 索引
   * 结构：{ packId: { presetType: CustomPresetEntry[] } }
   * 失败回滚时整组写回；为 null 表示快照阶段未取到（视为空）。
   */
  customPresets: Record<string, Record<string, CustomPresetEntry[]>> | null;
  worldBooksSnapshot: import('../prompt/world-book').WorldBookExportData | null;
}

/**
 * 档案级快照 — importProfileReplace 失败回滚用（仅该档案的数据，不做全库快照）。
 * saves/vectors 按 slotId 索引（不含 profileId 前缀——档案已定）。
 */
interface ProfileSnapshot {
  /** null = 导入前该档案不存在（回滚 = 删除新建的一切） */
  profileMeta: ProfileMeta | null;
  saves: Record<string, unknown>;
  vectors: Record<string, unknown>;
  worldBooks: import('../prompt/world-book').WorldBook[];
  activeProfile: { profileId: string; slotId: string } | null;
}

/** 全局区快照 — importGlobal 失败回滚用（不含任何档案数据）。 */
interface GlobalSnapshot {
  configOverlays: unknown;
  promptEntries: unknown;
  ls: Record<string, string | null>;
  customPresets: Record<string, Record<string, CustomPresetEntry[]>>;
  builtinOverrides: Record<string, import('../prompt/world-book').BuiltinPromptEntry[]>;
}

/**
 * 派生类型 — 从 ConfigStore.importAll 参数中提取配置覆盖数组类型
 *
 * 通过 Parameters 工具类型从已导入的 ConfigStore 推导，
 * 避免单独导入 ConfigOverlay 而产生跨模块的脆弱依赖。
 */
type ConfigImportData = Parameters<ConfigStore['importAll']>[0];

/**
 * 派生类型 — 从 PromptStorage.importAll 参数中提取 prompt 条目数组类型
 */
type PromptImportData = Parameters<PromptStorage['importAll']>[0];

/**
 * 派生类型 — 从 VectorStore.save 的第三个参数中提取向量数据类型
 */
type VectorSaveData = Parameters<VectorStore['save']>[2];

// ─── 服务实现 ───

export class BackupService {
  constructor(
    private profileManager: ProfileManager,
    private saveManager: SaveManager,
    private configStore: ConfigStore,
    private promptStorage: PromptStorage,
    private vectorStore: VectorStore,
    /**
     * 2026-04-14 新增：用户自定义创角预设仓库（按 packId 隔离）。
     * Optional —— 旧测试或最小集成不传时，customPresets 字段在 bundle 中始终为空。
     */
    private customPresetStore?: CustomPresetStore,
    private imageAssetCache?: ImageAssetCache,
    private worldBookStorage?: import('../prompt/world-book-storage').WorldBookStorage,
  ) {}

  // ─── 公开 API ───

  /**
   * 全量导出 — 将所有持久化数据打包为 JSON Blob
   *
   * 导出流程：
   * 1. 读取所有角色档案元数据（ProfileManager）
   * 2. 遍历每个档案的每个存档槽，加载存档数据（SaveManager）
   * 3. 加载每个存档槽对应的向量数据（VectorStore）
   * 4. 导出全局配置覆盖（ConfigStore）
   * 5. 导出全局 Prompt 覆盖（PromptStorage）
   * 6. 收集 localStorage 中的引擎设置
   * 7. 组装为 BackupBundle 并序列化为 Blob
   *
   * 所有数据使用 structuredClone 深拷贝，确保：
   * - 导出数据与运行时状态完全解耦
   * - 切断 Vue reactive proxy，避免序列化异常
   *
   * @returns 包含 JSON 数据的 Blob（MIME: application/json）
   */
  async exportAll(options?: { includeReferenceAssets?: boolean }): Promise<Blob> {
    return (await this.buildFullBundle(options)).blob;
  }

  /**
   * 供云同步使用的导出：一次调用**原子地**返回 Blob 与图片完整性，供 upload 的覆盖防护
   * 判定"引用图却没导出全"。不经共享实例字段，避免并发导出造成的 TOCTOU 误判。
   */
  async exportForSync(
    options?: { includeReferenceAssets?: boolean },
  ): Promise<{ blob: Blob; imageIntegrity: ExportImageIntegrity }> {
    return this.buildFullBundle(options);
  }

  /** 组装完整备份包，返回 Blob 及本次导出的图片完整性（referenced vs exported）。 */
  private async buildFullBundle(
    options?: { includeReferenceAssets?: boolean },
  ): Promise<{ blob: Blob; imageIntegrity: ExportImageIntegrity }> {
    const root = this.profileManager.getRoot();

    /* ── 1. 角色档案元数据 ── */
    const profiles: Record<string, unknown> = structuredClone(root.profiles);

    /* ── 2 & 3. 存档数据 + 向量数据 ── */
    const saves: Record<string, unknown> = {};
    const vectors: Record<string, unknown> = {};

    for (const profile of Object.values(root.profiles)) {
      for (const slotId of Object.keys(profile.slots)) {
        const compositeKey = compositeSlotKey(profile.profileId, slotId);

        const saveData = await this.saveManager.loadGame(
          profile.profileId,
          slotId,
        );
        if (saveData !== undefined) {
          saves[compositeKey] = structuredClone(saveData);
        }

        const vectorData = await this.vectorStore.load(
          profile.profileId,
          slotId,
        );
        if (hasVectorContent(vectorData)) {
          vectors[compositeKey] = structuredClone(vectorData);
        }
      }
    }

    /* ── 4. 配置覆盖 ── */
    const configExport = await this.configStore.exportAll();
    const configs: Record<string, unknown> = {
      overlays: structuredClone(configExport),
    };

    /* ── 5. Prompt 覆盖 ── */
    const promptExport = await this.promptStorage.exportAll();
    const prompts: Record<string, unknown> = {
      entries: structuredClone(promptExport),
    };

    /* ── 6. localStorage 引擎设置 ── */
    const engineSettings = collectLocalStorageSettings();

    /* ── 7. 用户自定义创角预设（按 packId 索引） ── */
    // 2026-04-14：遍历所有有 user 数据的 pack，导出每个的全量 customPresets
    const customPresets = await this.collectCustomPresets();

    /* ── 8. 图片资产（已选用的头像/立绘/壁纸/秘档 + opt-in 参考素材） ── */
    const { assets: imageAssets, integrity: imageIntegrity } =
      await this.collectSelectedImageAssets(saves, options?.includeReferenceAssets === true);

    // World book export — collect from all profiles
    let worldBooksExport: BackupBundle['worldBooks'];
    let builtinOverridesExport: BackupBundle['builtinPromptOverrides'];
    if (this.worldBookStorage) {
      const allProfileIds = Object.keys(profiles);
      const allBooks: import('../prompt/world-book').WorldBook[] = [];
      for (const pid of allProfileIds) {
        const books = await this.worldBookStorage.loadWorldBooks(pid);
        for (const b of books) {
          (b as unknown as Record<string, unknown>)['_exportProfileId'] = pid;
        }
        allBooks.push(...books);
      }
      if (allBooks.length > 0) {
        worldBooksExport = { version: 1, exportedAt: new Date().toISOString(), books: allBooks };
      }
      // Builtin overrides are per-pack; use the first pack found in configs or skip
      const packIds = Object.keys(customPresets);
      if (packIds.length > 0) {
        const overrides = await this.worldBookStorage.loadAllBuiltinOverrides(packIds[0]);
        if (overrides.length > 0) {
          builtinOverridesExport = { version: 1, exportedAt: new Date().toISOString(), entries: overrides, packId: packIds[0] };
        }
      }
    }

    /* ── 组装备份包 ── */
    const bundle: BackupBundle = {
      version: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      bundleType: 'full',
      activeProfile: root.activeProfile
        ? { ...root.activeProfile }
        : null,
      profiles,
      saves,
      vectors,
      configs,
      prompts,
      engineSettings,
      customPresets,
      imageAssets,
      worldBooks: worldBooksExport,
      builtinPromptOverrides: builtinOverridesExport,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    return { blob, imageIntegrity };
  }

  /**
   * 全量导入 — 从 JSON Blob 恢复所有持久化数据
   *
   * 2026-04-13 重构：根据 bundleType 区分两种流程：
   *
   * **全量备份（bundleType='full'）或含全局设置的 v1 备份：**
   * - 采用"**全替换**"语义，满足"一模一样"规格
   * - 导入前捕获全部 IDB + localStorage 快照到内存
   * - 擦除本地全部数据（idbAdapter.clear() + 清除所有 aga_* localStorage 键）
   * - 逐模块恢复备份内容
   * - 任何一步失败 → 从内存快照完整回滚
   * - 最后设置 ProfileManager.activeProfile 根指针
   *
   * **单角色备份（bundleType='profile'）或空 configs 的 v1 备份：**
   * - 采用"**合并**"语义，仅新增/覆盖该角色数据
   * - 不擦除其他 profile、不触碰全局设置
   * - 失败时不回滚（影响范围小）
   *
   * 导入校验：
   * - 检查备份包基本结构（必要字段存在性和类型）
   * - 检查版本号：高于当前支持版本则拒绝导入
   *
   * @param blob 由 exportAll() 或 exportProfile() 生成的 JSON Blob
   * @throws 备份包无效、版本不兼容、或导入失败时抛出
   */
  async importAll(blob: Blob): Promise<void> {
    const text = await blob.text();
    const raw: unknown = JSON.parse(text);

    /* ── 结构校验 ── */
    if (!isValidBundleShape(raw)) {
      throw new Error(
        '备份文件格式无效：缺少必需字段或结构不正确',
      );
    }

    const bundle = raw as BackupBundle;

    /* ── 版本兼容性检查 ── */
    if (bundle.version > BACKUP_FORMAT_VERSION) {
      throw new Error(
        `备份版本 ${bundle.version} 高于当前支持的版本 ` +
          `${BACKUP_FORMAT_VERSION}，请先升级引擎再导入`,
      );
    }

    /* ── 判断备份类型 ── */
    // bundleType 显式标记优先，否则根据 configs/prompts/engineSettings 是否为空推断。
    // 'global' 包（云端设置插槽）只替换全局区；'full'/'profile' 路径行为不变。
    if (bundle.bundleType === 'global') {
      await this.importGlobal(bundle);
      return;
    }
    const isFull =
      bundle.bundleType === 'full' ||
      (bundle.bundleType === undefined && this.hasGlobalData(bundle));

    if (isFull) {
      await this.importFullReplace(bundle);
    } else {
      await this.importProfileMerge(bundle);
    }
  }

  /**
   * 判断 bundle 是否包含全局数据（configs/prompts/engineSettings 非空）
   * 用于旧 v1 备份无 bundleType 字段时的类型推断
   */
  private hasGlobalData(bundle: BackupBundle): boolean {
    const configsNonEmpty =
      bundle.configs &&
      Object.keys(bundle.configs).length > 0 &&
      Array.isArray((bundle.configs as { overlays?: unknown }).overlays) &&
      ((bundle.configs as { overlays: unknown[] }).overlays.length > 0);
    const promptsNonEmpty =
      bundle.prompts &&
      Object.keys(bundle.prompts).length > 0 &&
      Array.isArray((bundle.prompts as { entries?: unknown }).entries) &&
      ((bundle.prompts as { entries: unknown[] }).entries.length > 0);
    const settingsNonEmpty =
      bundle.engineSettings &&
      Object.keys(bundle.engineSettings).length > 0;
    return !!(configsNonEmpty || promptsNonEmpty || settingsNonEmpty);
  }

  /**
   * 全替换导入 —— 擦除本地所有数据并以 bundle 替换
   *
   * 原子性保证：
   * 1. 先捕获当前状态到内存快照
   * 2. 擦除本地数据
   * 3. 恢复 bundle 内容
   * 4. 任一步失败 → 从快照回滚
   * 5. 成功则更新 ProfileManager.activeProfile
   */
  private async importFullReplace(bundle: BackupBundle): Promise<void> {
    /* ── 0. 反放大检测：来档引用了图片却不含图片数据 → 保留本地现有图片，不连锁清空 ── */
    const imagesLookDropped = bundleImagesLookDropped(bundle);

    /* ── 1. 捕获当前状态快照，供失败时回滚 ── */
    const snapshot = await this.captureCurrentState();

    try {
      /* ── 2. 擦除本地数据（图片缓存不在此清，见 restoreImageAssets） ── */
      await this.wipeAll();

      /* ── 3. 恢复各模块 ── */
      await this.restoreProfiles(bundle.profiles);
      await this.restoreSaves(bundle.saves);
      await this.restoreVectors(bundle.vectors);
      await this.restoreConfigs(bundle.configs);
      await this.restorePrompts(bundle.prompts);
      restoreLocalStorageSettings(bundle.engineSettings);

      /* ── 4. 恢复用户自定义创角预设（2026-04-14 新增） ── */
      await this.restoreCustomPresets(bundle.customPresets);

      /* ── 4c. 恢复世界书（2026-05-19 新增） ── */
      await this.restoreWorldBooks(bundle);

      /* ── 5. 恢复 activeProfile 根指针 ── */
      if (bundle.activeProfile) {
        const { profileId, slotId } = bundle.activeProfile;
        const exists = this.profileManager.getRoot().profiles[profileId];
        if (exists) {
          await this.profileManager.setActiveProfile(profileId, slotId);
        }
      }

      /* ── 6. 图片资产恢复放到最后（merge-then-prune），使前序任一失败都不会丢图；
             protectIds 保护"来档引用但未携带"的图片不被误删（防部分退化档删掉本地独有图）。 ── */
      await this.restoreImageAssets(bundle.imageAssets, {
        preserve: imagesLookDropped,
        protectIds: collectBundleReferencedIds(bundle),
      });
      if (imagesLookDropped) {
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.importPreservedImages',
          message: '导入的备份引用了图片却不含任何图片数据，已保留本地现有图片以防丢失。',
          id: 'import-preserved-images',
          duration: 9000,
        });
      }
    } catch (err) {
      /* ── 失败 → 从快照回滚 ── */
      try {
        await this.restoreFromSnapshot(snapshot);
      } catch (rollbackErr) {
        throw new Error(
          `导入失败且回滚失败：${extractErrorMessage(err)} | ` +
            `回滚错误：${extractErrorMessage(rollbackErr)}`,
        );
      }
      throw new Error(`导入失败，本地数据已回滚：${extractErrorMessage(err)}`);
    }
  }

  /**
   * 单角色合并导入 —— 仅新增/覆盖 bundle 中的 profile 数据
   *
   * 不擦除其他 profile、不触碰全局配置。
   * 失败时不回滚（影响局部）。
   */
  private async importProfileMerge(bundle: BackupBundle): Promise<void> {
    const report: ImportReport = {
      profiles: false,
      saves: false,
      vectors: false,
      configs: false,
      prompts: false,
      engineSettings: false,
      errors: [],
    };

    try {
      await this.restoreProfiles(bundle.profiles);
      report.profiles = true;
    } catch (err) {
      report.errors.push(`Profiles: ${extractErrorMessage(err)}`);
    }

    try {
      await this.restoreSaves(bundle.saves);
      report.saves = true;
    } catch (err) {
      report.errors.push(`Saves: ${extractErrorMessage(err)}`);
    }

    try {
      await this.restoreVectors(bundle.vectors);
      report.vectors = true;
    } catch (err) {
      report.errors.push(`Vectors: ${extractErrorMessage(err)}`);
    }

    if (report.errors.length > 0) {
      throw new Error(
        `单角色导入完成但有 ${report.errors.length} 个错误：\n` +
          report.errors.map((e) => `  - ${e}`).join('\n'),
      );
    }
  }

  // ─── 存档插槽 epic：档案级替换 / 全局区替换（docs/design/github-save-slots-design.md §5.1）───

  /**
   * 档案级替换导入 — 云端存档插槽下载的落地路径。
   *
   * 与 {@link importProfileMerge}（只增不删、无回滚）的三点差异：
   * 1. **真替换**：本地该档案有、来包没有的存档槽会被删除（含其向量）；
   * 2. **世界书**：按 profileId 整组替换；
   * 3. **图片受保护剪枝**：merge 后仅删除"旧版该档案独占引用、新版与其他任何
   *    本地存档均不引用"的图（全库引用计数），绝不触碰其他档案的图。
   *
   * 只影响这一个档案 —— 其他档案、全局设置（configs/prompts/engineSettings/
   * customPresets）完全不动。失败时从**档案级快照**回滚（仅该档案的数据）。
   */
  async importProfileReplace(blob: Blob): Promise<void> {
    const text = await blob.text();
    const raw: unknown = JSON.parse(text);
    if (!isValidBundleShape(raw)) {
      throw new Error('备份文件格式无效：缺少必需字段或结构不正确');
    }
    const bundle = raw as BackupBundle;
    if (bundle.version > BACKUP_FORMAT_VERSION) {
      throw new Error(
        `备份版本 ${bundle.version} 高于当前支持的版本 ${BACKUP_FORMAT_VERSION}，请先升级引擎再导入`,
      );
    }

    // 与 importGlobal 对称的类型闸：档案级替换只吃显式 'profile' 包。
    // 'full' 包哪怕恰好只含一个档案也拒绝——它的语义是全替换，不是插槽下载。
    if (bundle.bundleType !== 'profile') {
      throw new Error(
        `档案级导入只接受 bundleType='profile' 的包，实际 '${bundle.bundleType ?? '(无标记)'}'`,
      );
    }
    const profileIds = Object.keys(bundle.profiles ?? {});
    if (profileIds.length !== 1) {
      throw new Error(
        `档案级导入要求包内恰好一个档案，实际 ${profileIds.length} 个`,
      );
    }
    const profileId = profileIds[0];
    const incomingMeta = bundle.profiles[profileId] as ProfileMeta | undefined;
    const incomingSlotIds = new Set(Object.keys(incomingMeta?.slots ?? {}));
    const incomingSaves = filterCompositeByProfile(bundle.saves, profileId);
    const incomingSaveSlotIds = new Set(
      Object.keys(incomingSaves).map((key) => parseCompositeKey(key).slotId),
    );
    const missingSlotIds = [...incomingSlotIds].filter((slotId) => !incomingSaveSlotIds.has(slotId));
    const orphanSaveSlotIds = [...incomingSaveSlotIds].filter((slotId) => !incomingSlotIds.has(slotId));
    if (missingSlotIds.length > 0 || orphanSaveSlotIds.length > 0) {
      throw new ProfileSaveIntegrityError(profileId, missingSlotIds, orphanSaveSlotIds);
    }

    // 退化包检测（与全替换同一指纹）：来包引用图片却一张不带 ⇒ 本地图片缓存被清后
    // 做的备份。此时跳过一切图片删除（宁留孤图），并提示。
    const imagesLookDropped = bundleImagesLookDropped(bundle);

    /* ── 1. 档案级快照（仅该档案） ── */
    const snapshot = await this.captureProfileState(profileId);

    try {
      /* ── 2. 删除"本地有、来包无"的存档槽（真替换语义） ── */
      const localProfile = this.profileManager.getProfile(profileId);
      if (localProfile) {
        for (const slotId of Object.keys(localProfile.slots)) {
          if (!incomingSlotIds.has(slotId)) {
            await this.saveManager.deleteGame(profileId, slotId);
            await this.vectorStore.deleteForSlot(profileId, slotId);
          }
        }
      }

      /* ── 3. 档案元数据 + 存档 + 向量 ──
         saves/vectors 先按 profileId 过滤：档案包内出现其他档案的复合 key 属于
         损坏/恶意数据，绝不能写进别的档案。 */
      await this.restoreProfiles({ [profileId]: bundle.profiles[profileId] });
      const saves = incomingSaves;
      const vectors = filterCompositeByProfile(bundle.vectors, profileId);
      await this.restoreSaves(saves);
      // 来包未携带向量的槽，本地旧向量已过时（对应旧存档内容）→ 先清后写
      for (const slotId of incomingSlotIds) {
        if (!(compositeSlotKey(profileId, slotId) in vectors)) {
          await this.vectorStore.deleteForSlot(profileId, slotId);
        }
      }
      await this.restoreVectors(vectors);

      /* ── 4. 世界书整组替换（档案级） ── */
      if (this.worldBookStorage) {
        const existingBooks = await this.worldBookStorage.loadWorldBooks(profileId);
        for (const b of existingBooks) {
          await this.worldBookStorage.deleteWorldBook(profileId, b.id);
        }
        for (const book of bundle.worldBooks?.books ?? []) {
          await this.worldBookStorage.saveWorldBook(profileId, book);
        }
      }

      /* ── 5. activeProfile 指针自愈：指向本档案已被删除的槽 → 指到来包首个槽；
         来包一个槽都没有（零存档新档案）→ 清空指针，绝不留悬空引用 ── */
      const active = this.profileManager.getRoot().activeProfile;
      if (active?.profileId === profileId && !incomingSlotIds.has(active.slotId)) {
        const firstSlot = [...incomingSlotIds][0];
        if (firstSlot) {
          await this.profileManager.setActiveProfile(profileId, firstSlot);
        } else {
          await this.profileManager.clearActiveProfile();
        }
      }
    } catch (err) {
      try {
        await this.rollbackProfileState(profileId, snapshot);
      } catch (rollbackErr) {
        throw new Error(
          `档案导入失败且回滚失败：${extractErrorMessage(err)} | ` +
            `回滚错误：${extractErrorMessage(rollbackErr)}`,
        );
      }
      throw new Error(`档案导入失败，该档案已回滚：${extractErrorMessage(err)}`);
    }

    /* ── 6. 图片：merge-then-protected-prune（放最后，与全替换同策略：任何前序
       失败都不会动图；本步失败仅提示，不触发回滚） ── */
    await this.mergeAndPruneProfileImages(bundle, snapshot, imagesLookDropped);
  }

  /**
   * 全局区替换导入 — 云端 `global/` 设置插槽下载的落地路径。
   *
   * 只替换跨档案共享的全局区（configs / prompts / engineSettings / customPresets /
   * builtinPromptOverrides），**不触碰**任何档案数据（profiles/saves/vectors/
   * worldBooks/图片/activeProfile）。失败时从全局区快照回滚。
   */
  async importGlobal(bundle: BackupBundle): Promise<void> {
    if (bundle.bundleType !== 'global') {
      throw new Error(`importGlobal 只接受 bundleType='global' 的包，实际 '${bundle.bundleType}'`);
    }

    const snapshot = await this.captureGlobalState();

    try {
      /* ── 擦除全局区（保持设备本地键；绝不碰档案数据） ── */
      await this.configStore.clear();
      await this.promptStorage.clear();
      wipeLocalStorageSettings();

      /* ── 恢复 ── */
      await this.restoreConfigs(bundle.configs);
      await this.restorePrompts(bundle.prompts);
      restoreLocalStorageSettings(bundle.engineSettings);

      // 自定义预设：来包各 pack 整组替换；本地有、来包没有的 pack 清空（真替换）。
      // 本地 pack 清单必须在清理**之前**捕获——清理后 listPackIds 不再返回被清的
      // pack，下方 overrides 清理会漏掉它们。
      const localPackIds = this.customPresetStore
        ? await this.customPresetStore.listPackIds()
        : [];
      if (this.customPresetStore) {
        const bundlePacks = new Set(Object.keys(bundle.customPresets ?? {}));
        for (const pid of localPackIds) {
          if (!bundlePacks.has(pid)) await this.customPresetStore.clear(pid);
        }
        await this.restoreCustomPresets(bundle.customPresets);
      }

      // 内置提示词覆盖：来包 pack 整组替换。来包不带时，按已知 pack 清空。
      // （pack 枚举以 customPresetStore.listPackIds 为近似 —— overrides 存储无
      //   pack 枚举接口；本应用单 pack，实践上完全覆盖。）
      // targetPack 的兜底链与 restoreWorldBooks 一致，末位 'default' 保证
      // "无 packId 且无 customPresets" 的畸形/旧包也不会被静默丢弃。
      if (this.worldBookStorage) {
        const data = bundle.builtinPromptOverrides;
        const targetPack = data
          ? (data.packId ?? Object.keys(bundle.customPresets ?? {})[0] ?? 'default')
          : undefined;
        const knownPacks = new Set([
          ...localPackIds,
          ...Object.keys(bundle.customPresets ?? {}),
        ]);
        if (targetPack) knownPacks.add(targetPack);
        for (const pid of knownPacks) {
          if (data && pid === targetPack) {
            await this.worldBookStorage.replaceBuiltinOverrides(pid, data);
          } else {
            await this.worldBookStorage.clearBuiltinOverrides(pid);
          }
        }
      }
    } catch (err) {
      try {
        await this.rollbackGlobalState(snapshot);
      } catch (rollbackErr) {
        throw new Error(
          `设置导入失败且回滚失败：${extractErrorMessage(err)} | ` +
            `回滚错误：${extractErrorMessage(rollbackErr)}`,
        );
      }
      throw new Error(`设置导入失败，全局设置已回滚：${extractErrorMessage(err)}`);
    }
  }

  /** 档案级快照 — 仅该档案的元数据/存档/向量/世界书 + activeProfile 指针。 */
  private async captureProfileState(profileId: string): Promise<ProfileSnapshot> {
    const root = this.profileManager.getRoot();
    const meta = root.profiles[profileId];
    const saves: Record<string, unknown> = {};
    const vectors: Record<string, unknown> = {};
    if (meta) {
      for (const slotId of Object.keys(meta.slots)) {
        // 原始 IDB 读：快照要的是"当前落盘的字节"，且不得触发 loadGame 的
        // 惰性迁移回写（快照本身不能改变被快照的数据）。
        const saveData = await idbAdapter.get(`save_${profileId}_${slotId}`);
        if (saveData !== undefined) saves[slotId] = structuredClone(saveData);
        const vectorData = await this.vectorStore.load(profileId, slotId);
        if (hasVectorContent(vectorData)) vectors[slotId] = structuredClone(vectorData);
      }
    }
    let worldBooks: import('../prompt/world-book').WorldBook[] = [];
    if (this.worldBookStorage) {
      try {
        worldBooks = await this.worldBookStorage.loadWorldBooks(profileId);
      } catch { /* best effort */ }
    }
    return {
      profileMeta: meta ? structuredClone(meta) : null,
      saves,
      vectors,
      worldBooks,
      activeProfile: root.activeProfile ? { ...root.activeProfile } : null,
    };
  }

  /** 从档案级快照回滚该档案（快照为 null 档案 = 导入前不存在 → 删除新建的一切）。 */
  private async rollbackProfileState(profileId: string, snapshot: ProfileSnapshot): Promise<void> {
    // 1. 清掉当前（可能半写入的）该档案数据
    const current = this.profileManager.getProfile(profileId);
    if (current) {
      for (const slotId of Object.keys(current.slots)) {
        await this.saveManager.deleteGame(profileId, slotId);
        await this.vectorStore.deleteForSlot(profileId, slotId);
      }
    }
    if (this.worldBookStorage) {
      try {
        for (const b of await this.worldBookStorage.loadWorldBooks(profileId)) {
          await this.worldBookStorage.deleteWorldBook(profileId, b.id);
        }
      } catch { /* best effort */ }
    }

    if (!snapshot.profileMeta) {
      // 导入前档案不存在 → 恢复为不存在
      await this.profileManager.deleteProfile(profileId);
      return;
    }

    // 2. 回写快照
    await this.profileManager.createProfile(snapshot.profileMeta);
    for (const [slotId, data] of Object.entries(snapshot.saves)) {
      await idbAdapter.set(`save_${profileId}_${slotId}`, structuredClone(data));
    }
    for (const [slotId, data] of Object.entries(snapshot.vectors)) {
      await this.vectorStore.save(profileId, slotId, structuredClone(data) as VectorSaveData);
    }
    if (this.worldBookStorage) {
      try {
        for (const book of snapshot.worldBooks) {
          await this.worldBookStorage.saveWorldBook(profileId, book);
        }
      } catch { /* best effort */ }
    }
    if (snapshot.activeProfile?.profileId === profileId) {
      await this.profileManager.setActiveProfile(profileId, snapshot.activeProfile.slotId);
    }
  }

  /**
   * 图片 merge + 受保护剪枝（importProfileReplace 第 6 步）。
   *
   * keep 集合 = 来包携带的图 ∪ **全部本地存档树**（所有档案所有槽，导入后状态）
   * 引用的图。删除候选 = 旧版该档案引用的图 − keep —— 即只删"旧版独占、新版与
   * 其他档案都不再引用"的图。退化包（引用了图却一张不带）完全跳过删除。
   */
  private async mergeAndPruneProfileImages(
    bundle: BackupBundle,
    snapshot: ProfileSnapshot,
    imagesLookDropped: boolean,
  ): Promise<void> {
    if (!this.imageAssetCache) return;

    try {
      if (bundle.imageAssets && bundle.imageAssets.length > 0) {
        await this.imageAssetCache.importEntries(bundle.imageAssets);
      }
      if (imagesLookDropped) {
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.importPreservedImages',
          message: '导入的备份引用了图片却不含任何图片数据，已保留本地现有图片以防丢失。',
          id: 'import-preserved-images',
          duration: 9000,
        });
        return; // 退化包：只 merge（本次为空），绝不删图
      }

      // 旧版该档案引用的图（快照存档树，保护面取最大：含参考素材）
      const oldRefs = new Set<string>();
      for (const save of Object.values(snapshot.saves)) {
        if (save && typeof save === 'object') {
          collectAssetIdsFromTree(save as Record<string, unknown>, oldRefs, true);
        }
      }
      if (oldRefs.size === 0) return; // 旧版无引用 → 无候选，纯 merge 结束

      // keep：携带的图 + 导入后全库（所有档案所有槽）引用的图。
      // 读**原始 IDB**而非 saveManager.loadGame —— loadGame 会对版本落后的存档
      // 惰性迁移并回写，纯计数扫描绝不能对其他档案产生写副作用
      // （档案级导入的"只影响这一个档案"承诺）。
      const keep = new Set<string>();
      for (const entry of bundle.imageAssets ?? []) {
        keep.add(entry.metadata?.id ?? entry.id);
      }
      const root = this.profileManager.getRoot();
      for (const profile of Object.values(root.profiles)) {
        for (const slotId of Object.keys(profile.slots)) {
          const saveData = await idbAdapter.get(`save_${profile.profileId}_${slotId}`);
          if (saveData && typeof saveData === 'object') {
            collectAssetIdsFromTree(saveData as Record<string, unknown>, keep, true);
          }
        }
      }

      for (const id of oldRefs) {
        if (!keep.has(id)) {
          try { await this.imageAssetCache.delete(id); } catch { /* best effort */ }
        }
      }
    } catch (err) {
      this.warnImageRestoreFailed(err);
    }
  }

  /** 全局区快照 — configs/prompts/localStorage/customPresets/builtinOverrides。 */
  private async captureGlobalState(): Promise<GlobalSnapshot> {
    let configOverlays: unknown = null;
    let promptEntries: unknown = null;
    try { configOverlays = await this.configStore.exportAll(); } catch { /* best effort */ }
    try { promptEntries = await this.promptStorage.exportAll(); } catch { /* best effort */ }
    const ls = collectLocalStorageSettings();
    const customPresets = await this.collectCustomPresets();

    const builtinOverrides: Record<string, import('../prompt/world-book').BuiltinPromptEntry[]> = {};
    if (this.worldBookStorage && this.customPresetStore) {
      try {
        for (const pid of await this.customPresetStore.listPackIds()) {
          const entries = await this.worldBookStorage.loadAllBuiltinOverrides(pid);
          if (entries.length > 0) builtinOverrides[pid] = entries;
        }
      } catch { /* best effort */ }
    }
    return { configOverlays, promptEntries, ls, customPresets, builtinOverrides };
  }

  /** 从全局区快照回滚（不触碰任何档案数据）。 */
  private async rollbackGlobalState(snapshot: GlobalSnapshot): Promise<void> {
    try { await this.configStore.clear(); } catch { /* ignore */ }
    try { await this.promptStorage.clear(); } catch { /* ignore */ }
    wipeLocalStorageSettings();

    if (Array.isArray(snapshot.configOverlays)) {
      try { await this.configStore.importAll(snapshot.configOverlays as ConfigImportData); } catch { /* best effort */ }
    }
    if (Array.isArray(snapshot.promptEntries)) {
      try { await this.promptStorage.importAll(snapshot.promptEntries as PromptImportData); } catch { /* best effort */ }
    }
    for (const [key, value] of Object.entries(snapshot.ls)) {
      if (!LS_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
      if (LS_DEVICE_LOCAL_KEYS.has(key)) continue;
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    if (this.customPresetStore) {
      const snapPacks = new Set(Object.keys(snapshot.customPresets));
      for (const pid of await this.customPresetStore.listPackIds()) {
        if (!snapPacks.has(pid)) await this.customPresetStore.clear(pid);
      }
      await this.restoreCustomPresets(snapshot.customPresets);
    }
    if (this.worldBookStorage) {
      for (const [pid, entries] of Object.entries(snapshot.builtinOverrides)) {
        try {
          await this.worldBookStorage.replaceBuiltinOverrides(pid, {
            version: 1,
            exportedAt: new Date().toISOString(),
            entries,
          });
        } catch { /* best effort */ }
      }
    }
  }

  // ─── 快照 / 擦除 / 回滚 ───

  /**
   * 捕获当前完整持久化状态到内存对象，供失败回滚使用
   */
  private async captureCurrentState(): Promise<PreImportSnapshot> {
    const idbKeys = await idbAdapter.keys();
    const idb: Record<string, unknown> = {};
    for (const key of idbKeys) {
      const value = await idbAdapter.get(key);
      if (value !== undefined) {
        idb[key] = structuredClone(value);
      }
    }

    const ls: Record<string, string | null> = collectLocalStorageSettings();

    // ConfigStore 和 PromptStorage 可能使用独立 IDB store，
    // 通过各自的 exportAll 接口抓取当前完整状态
    let configOverlays: unknown = null;
    let promptEntries: unknown = null;
    try {
      configOverlays = await this.configStore.exportAll();
    } catch {
      /* 如果 configStore 未初始化或读取失败，快照仍可用 idb 兜底 */
    }
    try {
      promptEntries = await this.promptStorage.exportAll();
    } catch {
      /* 同上 */
    }

    // 2026-04-14：用户自定义预设
    // 注：customPresets 实际存在主 IDB store，已经被上面的 idb 全 key dump 覆盖。
    // 这里再独立 capture 一份，方便回滚时有结构化数据可走 customPresetStore.replaceAll
    // 路径（避免依赖 idbAdapter.set 时数据格式微妙变化）。
    const customPresets = await this.collectCustomPresets();

    // World book snapshot — collect from all known profiles
    let worldBooksSnapshot: PreImportSnapshot['worldBooksSnapshot'] = null;
    if (this.worldBookStorage) {
      try {
        const root = this.profileManager.getRoot();
        const profileIds = Object.keys(root.profiles ?? {});
        const allBooks: import('../prompt/world-book').WorldBook[] = [];
        for (const pid of profileIds) {
          const books = await this.worldBookStorage.loadWorldBooks(pid);
          for (const b of books) {
            (b as unknown as Record<string, unknown>)['_exportProfileId'] = pid;
          }
          allBooks.push(...books);
        }
        if (allBooks.length > 0) {
          worldBooksSnapshot = { version: 1, exportedAt: new Date().toISOString(), books: allBooks };
        }
      } catch {
        /* snapshot is best-effort */
      }
    }

    return { idb, ls, configOverlays, promptEntries, customPresets, worldBooksSnapshot };
  }

  /**
   * 收集所有 pack 的用户自定义预设（按 packId 索引）
   *
   * 调用方：exportAll、captureCurrentState
   * 失败时返回 null（保留与 PreImportSnapshot.customPresets 类型一致）
   */
  private async collectCustomPresets(): Promise<
    Record<string, Record<string, CustomPresetEntry[]>>
  > {
    const result: Record<string, Record<string, CustomPresetEntry[]>> = {};
    if (!this.customPresetStore) return result;
    try {
      const packIds = await this.customPresetStore.listPackIds();
      for (const pid of packIds) {
        const data = await this.customPresetStore.load(pid);
        if (data && Object.keys(data.presets ?? {}).length > 0) {
          result[pid] = structuredClone(data.presets);
        }
      }
    } catch (err) {
      console.warn('[BackupService] collectCustomPresets failed:', err);
    }
    return result;
  }

  /**
   * 恢复用户自定义预设到 IDB（按 packId）
   *
   * 调用方：importFullReplace、importProfileMerge
   * Optional —— bundle 可能不带 customPresets（旧 backup），此时静默跳过。
   */
  private async restoreCustomPresets(
    data: BackupBundle['customPresets'],
  ): Promise<void> {
    if (!this.customPresetStore || !data) return;
    for (const [packId, presetsByType] of Object.entries(data)) {
      try {
        await this.customPresetStore.replaceAll(packId, presetsByType);
      } catch (err) {
        console.warn(`[BackupService] restoreCustomPresets failed for "${packId}":`, err);
      }
    }
  }

  /**
   * 从所有存档的状态树中收集全部被引用的图片 asset ID，
   * 然后从 ImageAssetCache 导出对应的 blob。
   *
   * 包含：
   * - 玩家/NPC 的 已选头像图片ID、已选立绘图片ID、已选背景图片ID
   * - 生图历史中每条记录的 id（未被选用但仍在档案中的图片）
   * - 最近生图结果
   * - 香闺秘档中各 part 的 assetId
   * - 场景壁纸 当前壁纸图片ID + 场景生图历史
   */
  private async collectSelectedImageAssets(
    saves: Record<string, unknown>,
    includeReferenceAssets = false,
  ): Promise<{ assets: Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }>; integrity: ExportImageIntegrity }> {
    // Integrity travels back WITH the assets (not via shared instance state) so the
    // sync guard evaluates exactly this export — no TOCTOU with a concurrent export.
    const integrity: ExportImageIntegrity = { referencedAssets: 0, exportedAssets: 0 };
    if (!this.imageAssetCache) return { assets: [], integrity };
    const assetIds = new Set<string>();

    for (const saveData of Object.values(saves)) {
      if (!saveData || typeof saveData !== 'object') continue;
      collectAssetIdsFromTree(saveData as Record<string, unknown>, assetIds, includeReferenceAssets);
    }

    integrity.referencedAssets = assetIds.size;
    if (assetIds.size === 0) return { assets: [], integrity };

    let exported: Array<{ id: string; metadata: ImageAsset; base64: string; mimeType: string }> = [];
    try {
      exported = await this.imageAssetCache.exportByIds(assetIds);
    } catch (err) {
      console.warn('[BackupService] collectSelectedImageAssets failed:', err);
      exported = [];
    }
    integrity.exportedAssets = exported.length;

    // Loudness: the state references image assets but the cache returned fewer (or
    // none). The local image cache was evicted/cleared (separate `aga_image_cache`
    // IndexedDB). Surface it NOW so the user sees the loss BEFORE this degraded
    // backup overwrites a healthy cloud/file backup. This is the exact fingerprint
    // of the 2026-07-10 corruption incident (126 refs, 0 exported), and also fires
    // on PARTIAL eviction (e.g. 15/21) — which the sync guard now hard-blocks too.
    if (exported.length < assetIds.size) {
      const missing = assetIds.size - exported.length;
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.imageAssetsMissingOnExport',
        i18nParams: { missing, total: assetIds.size },
        message: `本次备份有 ${missing}/${assetIds.size} 张已引用图片在本地缓存中找不到（可能被浏览器清除），备份将缺图。请勿用它覆盖含图的云端/旧备份。`,
        id: 'image-assets-missing-on-export',
        duration: 10000,
      });
    }
    return { assets: exported, integrity };
  }

  /** 恢复世界书数据 — 从 BackupBundle 的 worldBooks 字段恢复 */
  private async restoreWorldBooks(bundle: BackupBundle): Promise<void> {
    if (!this.worldBookStorage) return;
    if (bundle.worldBooks?.books && Array.isArray(bundle.worldBooks.books)) {
      try {
        const profileIds = Object.keys(bundle.profiles ?? {});
        for (const book of bundle.worldBooks.books) {
          const pid = (book as unknown as Record<string, unknown>)['_exportProfileId'] as string
            ?? profileIds[0] ?? 'default';
          await this.worldBookStorage.saveWorldBook(pid, book);
        }
      } catch (err) {
        console.warn('[BackupService] restoreWorldBooks failed:', err);
      }
    }
    if (bundle.builtinPromptOverrides?.entries && Array.isArray(bundle.builtinPromptOverrides.entries)) {
      try {
        const packId = bundle.builtinPromptOverrides.packId
          ?? Object.keys(bundle.customPresets ?? {})[0] ?? 'default';
        for (const entry of bundle.builtinPromptOverrides.entries) {
          await this.worldBookStorage.saveBuiltinOverride(packId, entry);
        }
      } catch (err) {
        console.warn('[BackupService] restoreBuiltinOverrides failed:', err);
      }
    }
  }

  /**
   * 恢复图片资产到 ImageAssetCache（全替换语义：clear-then-import）。
   *
   * 作为全替换导入的**最后一步**执行——此前 wipeAll 不再清图片缓存，任一较早
   * restore 失败时图片仍原样保留，回滚不会丢图。
   *
   * @param opts.preserve 为 true 时完全跳过（既不清空也不导入），保留本地现有图片。
   *   用于"来档引用了图片却不含任何图片数据"的可疑损坏备份，避免连锁清空本地图片
   *   （2026-07-10 事故的放大环节）。
   */
  private async restoreImageAssets(
    data: BackupBundle['imageAssets'],
    opts?: { preserve?: boolean; protectIds?: Set<string> },
  ): Promise<void> {
    if (!this.imageAssetCache) return;
    if (opts?.preserve) return; // keep whatever images the user still has locally

    // Never prune an image the INCOMING save still references but the bundle
    // happened not to carry (a partially-degraded bundle, e.g. 15 of 21) — keep the
    // local copy rather than destroying an image the restored state still points at.
    const protectIds = opts?.protectIds ?? new Set<string>();

    // No images carried → drop only images that are ALSO not referenced by the
    // incoming state (truly orphaned); protected refs are kept.
    if (!data || data.length === 0) {
      try {
        const existing = await this.imageAssetCache.listAll();
        for (const meta of existing) {
          if (!protectIds.has(meta.id)) {
            try { await this.imageAssetCache.delete(meta.id); } catch { /* best effort */ }
          }
        }
      } catch (err) {
        this.warnImageRestoreFailed(err);
      }
      return;
    }

    // Merge-then-prune (crash-safe, no memory-heavy snapshot): import the new set
    // FIRST (so the cache is never momentarily empty), THEN delete any image that is
    // neither carried NOR referenced by the incoming save. A mid-way failure leaves
    // EXTRA (harmless) images rather than wiping everything — which, combined with
    // running this as the LAST import step, means a failed/rolled-back import can
    // never lose the user's image library (audit 2026-07-09: rollback had no image
    // snapshot to restore from).
    try {
      await this.imageAssetCache.importEntries(data);
      const keepIds = new Set<string>(protectIds);
      for (const d of data) keepIds.add(d.metadata?.id ?? d.id);
      const existing = await this.imageAssetCache.listAll();
      for (const meta of existing) {
        if (!keepIds.has(meta.id)) {
          try { await this.imageAssetCache.delete(meta.id); } catch { /* best effort */ }
        }
      }
    } catch (err) {
      this.warnImageRestoreFailed(err);
    }
  }

  /**
   * Warn (console + visible toast) when image restore fails. It is the LAST import
   * step and does not trigger snapshot rollback, so a silent failure would leave
   * the user believing "import succeeded" while images were never restored.
   */
  private warnImageRestoreFailed(err: unknown): void {
    console.warn('[BackupService] restoreImageAssets failed:', err);
    eventBus.emit('ui:toast', {
      type: 'warning',
      i18nKey: 'engine.toast.imageRestoreFailed',
      message: '存档已恢复，但图片写入本地失败（可能存储空间不足），部分图片可能缺失。',
      id: 'image-restore-failed',
      duration: 9000,
    });
  }


  /**
   * 擦除本地所有数据（IDB 全部 key + 所有 aga_* localStorage 键）
   *
   * configs/prompts 使用独立 IDB DB（aga-config / aga-prompts），
   * 通过各自的 clear() 接口清空存储区。
   */
  private async wipeAll(): Promise<void> {
    // 1. 清空主 IDB store（profiles + saves + vectors）
    await idbAdapter.clear();

    // 2. 清空 localStorage 中的 aga_* / aga- 键
    wipeLocalStorageSettings();

    // 3. 清空 configs / prompts 各自独立的 IDB DB
    await this.configStore.clear();
    await this.promptStorage.clear();

    // 4. 图片缓存不在此清空 —— 移到 restoreImageAssets（导入的最后一步）做
    //    clear-then-import，确保任一较早步骤失败时图片仍在，回滚不会丢图。
    //    （历史：wipeAll 曾在此 clear()，一旦后续 restore 失败，captureCurrentState
    //    没有快照图片缓存 → 回滚也补不回图片 → 图片永久丢失。）

    // 5. 清空世界书 IDB (aga-worldbook)
    if (this.worldBookStorage) {
      try { await this.worldBookStorage.clearAll(); } catch { /* best effort */ }
    }

    // 6. 重置 ProfileManager 内存缓存（防止后续 getRoot 返回 stale 数据）
    await this.profileManager.initialize();
  }

  /**
   * 从内存快照完整恢复状态
   *
   * 回滚顺序：先擦除当前（可能已部分写入的）数据，再回写快照
   */
  private async restoreFromSnapshot(
    snapshot: PreImportSnapshot,
  ): Promise<void> {
    // 1. 清空当前（可能已污染的）状态
    await idbAdapter.clear();
    wipeLocalStorageSettings();
    try {
      await this.configStore.clear();
    } catch { /* ignore */ }
    try {
      await this.promptStorage.clear();
    } catch { /* ignore */ }

    // 2. 回写 IDB
    for (const [key, value] of Object.entries(snapshot.idb)) {
      await idbAdapter.set(key, value);
    }

    // 3. 回写 localStorage
    for (const [key, value] of Object.entries(snapshot.ls)) {
      if (!LS_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
      if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // never restore device-local sync state (defense-in-depth; source already excludes it)
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    }

    // 4. 回写 configs / prompts
    if (Array.isArray(snapshot.configOverlays)) {
      try {
        await this.configStore.importAll(
          snapshot.configOverlays as ConfigImportData,
        );
      } catch {
        /* 快照中的数据格式可能已损坏，尽力恢复 */
      }
    }
    if (Array.isArray(snapshot.promptEntries)) {
      try {
        await this.promptStorage.importAll(
          snapshot.promptEntries as PromptImportData,
        );
      } catch {
        /* 同上 */
      }
    }

    // 4b. 回写 user 自定义预设（2026-04-14）
    // idbAdapter 全 key dump 已经包含 custom_presets_*，但走 customPresetStore
    // 的 replaceAll 路径能保证字段被规范化（id 前缀、source、createdAt 缺省补齐）。
    if (snapshot.customPresets) {
      await this.restoreCustomPresets(snapshot.customPresets);
    }

    // 4c. 回写世界书（2026-05-19）
    if (this.worldBookStorage) {
      try {
        await this.worldBookStorage.clearAll();
        if (snapshot.worldBooksSnapshot?.books) {
          const root = this.profileManager.getRoot();
          const fallbackPid = Object.keys(root.profiles ?? {})[0] ?? 'default';
          for (const book of snapshot.worldBooksSnapshot.books) {
            const pid = (book as unknown as Record<string, unknown>)['_exportProfileId'] as string
              ?? fallbackPid;
            await this.worldBookStorage.saveWorldBook(pid, book);
          }
        }
      } catch { /* best effort */ }
    }

    // 5. 重置 ProfileManager 缓存
    await this.profileManager.initialize();
  }

  /**
   * 单档案导出 — 仅导出指定角色的档案、存档和向量数据
   *
   * 不包含全局配置 / Prompt / 引擎设置（这些是跨档案共享的），
   * 对应字段设为空对象。适用于分享单个角色或部分备份场景。
   *
   * @param profileId 要导出的角色档案 ID
   * @returns 仅包含该角色数据的 JSON Blob
   * @throws 角色不存在时抛出
   */
  async exportProfile(profileId: string, options?: { includeReferenceAssets?: boolean }): Promise<Blob> {
    return (await this.buildProfileBundle(profileId, options)).blob;
  }

  /**
   * 档案级 sync 导出 — 供云端存档插槽上传使用（docs/design/github-save-slots-design.md §5.1）。
   *
   * 与 {@link exportProfile} 同源，但**原子地**返回图片完整性：插槽上传必须像全量
   * 上传一样过退化拦截闸（referencedAssets > exportedAssets ⇒ DegradedUploadError），
   * 否则缺图存档会在插槽粒度覆盖云端好备份（2026-07-10 事故类别）。
   */
  async exportProfileForSync(
    profileId: string,
    options?: { includeReferenceAssets?: boolean },
  ): Promise<{ blob: Blob; imageIntegrity: ExportImageIntegrity; displayMeta: ProfileDisplayMeta }> {
    const { blob, imageIntegrity } = await this.buildProfileBundle(profileId, options);
    const meta = this.profileManager.getRoot().profiles[profileId];
    const slotIds = Object.keys(meta.slots);
    let lastPlayedAt: string | null = null;
    for (const s of slotIds) {
      const t = meta.slots[s].lastSavedAt;
      if (t && (!lastPlayedAt || t > lastPlayedAt)) lastPlayedAt = t;
    }
    return {
      blob,
      imageIntegrity,
      displayMeta: {
        profileId,
        profileName: meta.characterName,
        packId: meta.packId,
        slotCount: slotIds.length,
        lastPlayedAt,
      },
    };
  }

  /** 组装单档案备份包（含该档案的世界书），返回 Blob 及图片完整性。 */
  private async buildProfileBundle(
    profileId: string,
    options?: { includeReferenceAssets?: boolean },
  ): Promise<{ blob: Blob; imageIntegrity: ExportImageIntegrity }> {
    const profile = this.profileManager.getRoot().profiles[profileId];
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }

    const profiles: Record<string, unknown> = {
      [profileId]: structuredClone(profile),
    };

    const saves: Record<string, unknown> = {};
    const vectors: Record<string, unknown> = {};
    const missingSlotIds: string[] = [];

    for (const slotId of Object.keys(profile.slots)) {
      const compositeKey = compositeSlotKey(profileId, slotId);

      const saveData = await this.saveManager.loadGame(profileId, slotId);
      if (saveData !== undefined) {
        saves[compositeKey] = structuredClone(saveData);
      } else {
        missingSlotIds.push(slotId);
      }

      const vectorData = await this.vectorStore.load(profileId, slotId);
      if (hasVectorContent(vectorData)) {
        vectors[compositeKey] = structuredClone(vectorData);
      }
    }

    // Structural integrity gate: profile metadata and actual save records must
    // agree before image integrity is calculated. Without this, a missing save
    // record produces zero image references and bypasses the 2026-07-10
    // degraded-image guard as a seemingly legitimate image-free profile.
    if (missingSlotIds.length > 0) {
      throw new ProfileSaveIntegrityError(profileId, missingSlotIds);
    }

    const { assets: imageAssets, integrity: imageIntegrity } =
      await this.collectSelectedImageAssets(saves, options?.includeReferenceAssets === true);

    // 世界书是档案级数据，必须随档案包走（插槽下载后该档案的检索增强才完整）。
    // _exportProfileId 标记与全量导出一致，restore 侧按其归位。
    let worldBooksExport: BackupBundle['worldBooks'];
    if (this.worldBookStorage) {
      try {
        const books = await this.worldBookStorage.loadWorldBooks(profileId);
        for (const b of books) {
          (b as unknown as Record<string, unknown>)['_exportProfileId'] = profileId;
        }
        if (books.length > 0) {
          worldBooksExport = { version: 1, exportedAt: new Date().toISOString(), books };
        }
      } catch (err) {
        console.warn('[BackupService] buildProfileBundle worldBooks failed:', err);
      }
    }

    const bundle: BackupBundle = {
      version: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      bundleType: 'profile',
      activeProfile: null,
      profiles,
      saves,
      vectors,
      configs: {},
      prompts: {},
      engineSettings: {},
      imageAssets,
      worldBooks: worldBooksExport,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    return { blob, imageIntegrity };
  }

  /** 本地全部档案 ID（供云端插槽迁移/自动同步枚举，避免上层直接依赖 ProfileManager）。 */
  listProfileIds(): string[] {
    return Object.keys(this.profileManager.getRoot().profiles);
  }

  /**
   * 全局设置包导出 — 云端 `global/` 设置插槽的载荷。
   *
   * 仅含跨档案共享的全局区：configs / prompts / engineSettings / customPresets /
   * builtinPromptOverrides。profiles/saves/vectors 为空对象（保持
   * isValidBundleShape 兼容），不含 imageAssets / worldBooks / activeProfile
   * （activeProfile 指向的档案在目标设备未必存在，指针绝不随包走）。
   */
  async exportGlobalForSync(): Promise<{ blob: Blob }> {
    const configExport = await this.configStore.exportAll();
    const configs: Record<string, unknown> = { overlays: structuredClone(configExport) };

    const promptExport = await this.promptStorage.exportAll();
    const prompts: Record<string, unknown> = { entries: structuredClone(promptExport) };

    const engineSettings = collectLocalStorageSettings();
    const customPresets = await this.collectCustomPresets();

    // Builtin prompt overrides — 沿用全量导出的单 pack 现状（BuiltinPromptExportData
    // 结构只承载一个 packId；本应用当前单 pack）。多 pack 支持需先改导出数据格式。
    let builtinOverridesExport: BackupBundle['builtinPromptOverrides'];
    if (this.worldBookStorage) {
      const packIds = Object.keys(customPresets);
      if (packIds.length > 0) {
        const overrides = await this.worldBookStorage.loadAllBuiltinOverrides(packIds[0]);
        if (overrides.length > 0) {
          builtinOverridesExport = { version: 1, exportedAt: new Date().toISOString(), entries: overrides, packId: packIds[0] };
        }
      }
    }

    const bundle: BackupBundle = {
      version: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      bundleType: 'global',
      activeProfile: null,
      profiles: {},
      saves: {},
      vectors: {},
      configs,
      prompts,
      engineSettings,
      customPresets,
      builtinPromptOverrides: builtinOverridesExport,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    return { blob };
  }

  // ─── 内部恢复方法 ───

  /**
   * 恢复角色档案 — 将备份中的每个角色写入 ProfileManager
   *
   * 调用 createProfile 逐条写入，已存在的同 ID 档案会被覆盖。
   * 确保 profileId 字段与 key 一致，防止序列化中 key 被篡改。
   */
  private async restoreProfiles(
    profilesData: Record<string, unknown>,
  ): Promise<void> {
    for (const [profileId, rawMeta] of Object.entries(profilesData)) {
      const meta = structuredClone(rawMeta) as ProfileMeta;
      meta.profileId = profileId;
      await this.profileManager.createProfile(meta);
    }
  }

  /**
   * 恢复存档数据 — 通过 idbAdapter 直接写入 IndexedDB
   *
   * 使用 idbAdapter 而非 SaveManager.saveGame 的原因：
   * - 避免触发 engine:save-complete 事件（这不是真正的游戏保存操作）
   * - 避免重复更新元数据（元数据已在 restoreProfiles 中恢复）
   * - 保持导出时的原始数据不被修改（saveGame 会写入当前时间戳）
   *
   * compositeKey 格式: "profileId/slotId" → IDB key: "save_profileId_slotId"
   */
  private async restoreSaves(
    savesData: Record<string, unknown>,
  ): Promise<void> {
    for (const [compositeKey, data] of Object.entries(savesData)) {
      const { profileId, slotId } = parseCompositeKey(compositeKey);
      const idbKey = `save_${profileId}_${slotId}`;
      await idbAdapter.set(idbKey, structuredClone(data));
    }
  }

  /**
   * 恢复向量数据 — 通过 VectorStore.save 写入
   *
   * compositeKey 格式同存档: "profileId/slotId"
   * 数据结构需与 VectorStoreData 兼容（eventVectors, entityVectors, model, dim）
   */
  private async restoreVectors(
    vectorsData: Record<string, unknown>,
  ): Promise<void> {
    for (const [compositeKey, data] of Object.entries(vectorsData)) {
      const { profileId, slotId } = parseCompositeKey(compositeKey);
      await this.vectorStore.save(
        profileId,
        slotId,
        structuredClone(data) as VectorSaveData,
      );
    }
  }

  /**
   * 恢复配置覆盖 — 调用 ConfigStore.importAll
   *
   * 备份中 configs.overlays 是 ConfigOverlay[] 的序列化形式。
   * 若 overlays 不存在或不是数组则跳过（兼容单档案导出的空 configs）。
   */
  private async restoreConfigs(
    configsData: Record<string, unknown>,
  ): Promise<void> {
    const overlays = configsData['overlays'];
    if (!Array.isArray(overlays)) return;
    await this.configStore.importAll(overlays as ConfigImportData);
  }

  /**
   * 恢复 Prompt 覆盖 — 调用 PromptStorage.importAll
   *
   * 备份中 prompts.entries 是 { key, value }[] 的序列化形式。
   * 若 entries 不存在或不是数组则跳过。
   */
  private async restorePrompts(
    promptsData: Record<string, unknown>,
  ): Promise<void> {
    const entries = promptsData['entries'];
    if (!Array.isArray(entries)) return;
    await this.promptStorage.importAll(entries as PromptImportData);
  }
}

// ─── 模块级工具函数 ───

/**
 * 生成存档/向量数据的复合 key
 *
 * 使用 "/" 分隔而非 "_"，与 idbAdapter 中的 save key 格式区分：
 * - 备份包内: "profileId/slotId"（人类可读、方便 JSON 查看）
 * - IndexedDB: "save_profileId_slotId"（兼容旧格式、无特殊字符歧义）
 */
function compositeSlotKey(profileId: string, slotId: string): string {
  return `${profileId}/${slotId}`;
}

/**
 * 从复合 key 索引的 saves/vectors 中过滤出指定档案的条目。
 *
 * 档案级导入的防线：档案包内出现**其他**档案的复合 key（损坏或恶意数据）时
 * 静默丢弃，绝不写进别的档案。格式非法的 key 同样丢弃。
 */
function filterCompositeByProfile(
  data: Record<string, unknown>,
  profileId: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    try {
      if (parseCompositeKey(key).profileId === profileId) result[key] = value;
    } catch { /* malformed key — drop */ }
  }
  return result;
}

/**
 * 解析复合 key — 从 "profileId/slotId" 中提取两段标识
 *
 * @throws key 格式不合法时抛出
 */
function parseCompositeKey(key: string): {
  profileId: string;
  slotId: string;
} {
  const separatorIndex = key.indexOf('/');
  if (separatorIndex === -1 || separatorIndex === 0 || separatorIndex === key.length - 1) {
    throw new Error(
      `Invalid composite key format: "${key}" (expected "profileId/slotId")`,
    );
  }
  return {
    profileId: key.slice(0, separatorIndex),
    slotId: key.slice(separatorIndex + 1),
  };
}

/**
 * 检查向量数据是否包含实际内容（非空向量）
 *
 * 空向量存储（新存档、从未使用 Engram）不值得写入备份包，
 * 跳过它们可减小备份文件体积。
 */
function hasVectorContent(data: {
  eventVectors: Record<string, number[]>;
  entityVectors: Record<string, number[]>;
}): boolean {
  return (
    Object.keys(data.eventVectors).length > 0 ||
    Object.keys(data.entityVectors).length > 0
  );
}

/**
 * 校验备份包的基本结构 — 纯形状检查
 *
 * 只验证顶层字段的存在性和基本类型，不深入校验子结构。
 * 子结构的校验由各 restore 方法在实际使用时处理。
 */
function isValidBundleShape(data: unknown): data is BackupBundle {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;
  return (
    typeof obj['version'] === 'number' &&
    typeof obj['exportedAt'] === 'string' &&
    typeof obj['engineVersion'] === 'string' &&
    typeof obj['profiles'] === 'object' &&
    obj['profiles'] !== null &&
    typeof obj['saves'] === 'object' &&
    obj['saves'] !== null &&
    typeof obj['vectors'] === 'object' &&
    obj['vectors'] !== null &&
    typeof obj['configs'] === 'object' &&
    obj['configs'] !== null &&
    typeof obj['prompts'] === 'object' &&
    obj['prompts'] !== null &&
    typeof obj['engineSettings'] === 'object' &&
    obj['engineSettings'] !== null
  );
}

/**
 * 从 localStorage 收集引擎设置
 *
 * 收集以 `aga_` 或 `aga-` 开头的 key，
 * 避免采集其他库或应用的无关数据。
 */
function collectLocalStorageSettings(): Record<string, string | null> {
  const settings: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // device-local sync state never travels
    if (LS_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      settings[key] = localStorage.getItem(key);
    }
  }
  return settings;
}

/**
 * 擦除 localStorage 中所有 aga_* / aga-* 键
 *
 * 用于全替换导入前的清理阶段，确保备份中不存在的设置在本地也被移除。
 * 必须先收集再删除，避免边遍历边删除导致索引错位。
 */
function wipeLocalStorageSettings(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // keep this device's own sync bookkeeping across a foreign restore
    if (LS_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

/**
 * 恢复 localStorage 引擎设置
 *
 * 处理 null 值的语义：
 * - null → 删除该 key（localStorage.removeItem）
 * - string → 写入该值（localStorage.setItem）
 *
 * 安全限制：只允许写入 `aga_` / `aga-` 前缀的 key，防止恶意备份覆盖无关数据。
 */
function restoreLocalStorageSettings(
  settings: Record<string, string | null>,
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (!LS_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (LS_DEVICE_LOCAL_KEYS.has(key)) continue; // a bundle must never overwrite device-local sync state
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  }
}

/**
 * 从 unknown 错误中安全提取消息字符串
 *
 * catch 块捕获的是 unknown 类型（strict TS 要求），
 * 此函数统一处理 Error 实例和非 Error 抛出值。
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 从 GameStateTree 中提取所有被引用的图片 asset ID。
 *
 * 扫描路径：
 * - 角色.图片档案.已选头像图片ID / 已选立绘图片ID / 已选背景图片ID
 * - 角色.图片档案.生图历史[].id + 最近生图结果
 * - 社交.关系[].图片档案 — 同上
 * - 社交.关系[].图片档案.香闺秘档.{胸部|小穴|屁穴}.assetId
 * - 系统.扩展.image.sceneArchive.当前壁纸图片ID + 生图历史[].id
 */
export function collectAssetIdsFromTree(tree: Record<string, unknown>, ids: Set<string>, includeReferenceAssets = false): void {
  const addIfValid = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) ids.add(val.trim());
  };

  const SELECTION_FIELDS = ['已选头像图片ID', '已选立绘图片ID', '已选背景图片ID'];

  const extractFromArchive = (archive: unknown) => {
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return;
    const a = archive as Record<string, unknown>;
    for (const f of SELECTION_FIELDS) addIfValid(a[f]);
    addIfValid(a['最近生图结果']);
    // 生图历史 — every entry's id is an asset reference
    const history = a['生图历史'];
    if (Array.isArray(history)) {
      for (const entry of history) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
      }
    }
    // 香闺秘档
    const secret = a['香闺秘档'];
    if (secret && typeof secret === 'object') {
      for (const part of Object.values(secret as Record<string, unknown>)) {
        if (part && typeof part === 'object') addIfValid((part as Record<string, unknown>).assetId);
      }
    }
  };

  // Player archive
  const player = tree['角色'] as Record<string, unknown> | undefined;
  if (player) extractFromArchive(player['图片档案']);

  // NPC archives
  const social = tree['社交'] as Record<string, unknown> | undefined;
  const relationships = social?.['关系'];
  if (Array.isArray(relationships)) {
    for (const npc of relationships) {
      if (npc && typeof npc === 'object') extractFromArchive((npc as Record<string, unknown>)['图片档案']);
    }
  }

  // Scene archive
  const system = tree['系统'] as Record<string, unknown> | undefined;
  const ext = system?.['扩展'] as Record<string, unknown> | undefined;
  const image = ext?.['image'] as Record<string, unknown> | undefined;
  const sceneArchive = image?.['sceneArchive'] as Record<string, unknown> | undefined;
  if (sceneArchive) {
    addIfValid(sceneArchive['当前壁纸图片ID']);
    addIfValid(sceneArchive['最近生图结果']);
    const sceneHistory = sceneArchive['生图历史'];
    if (Array.isArray(sceneHistory)) {
      for (const entry of sceneHistory) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
      }
    }
  }

  // Reference library assets (opt-in — large blobs, user chooses at export time)
  if (includeReferenceAssets) {
    const referenceLib = image?.['referenceLibrary'];
    if (Array.isArray(referenceLib)) {
      for (const entry of referenceLib) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).assetId);
      }
    }
  }
}

/**
 * 收集来档存档树中引用到的全部图片 asset ID（含参考素材库）。
 *
 * 用于 restoreImageAssets 的 `protectIds`：全替换导入 merge-then-prune 时，绝不删除
 * "来档引用了却没携带"的本地图片（防部分退化档误删本地独有图，审计 2026-07-09 #3）。
 * 这里用 includeReferenceAssets=true（保护面尽量大，宁可多留不可误删）。
 */
export function collectBundleReferencedIds(bundle: BackupBundle): Set<string> {
  const ids = new Set<string>();
  for (const save of Object.values(bundle.saves ?? {})) {
    if (save && typeof save === 'object') {
      collectAssetIdsFromTree(save as Record<string, unknown>, ids, true);
    }
  }
  return ids;
}

/**
 * 判断来档是否"引用了图片却不含任何图片数据"——即在图片缓存被清空后所做的备份指纹。
 *
 * 命中时 importFullReplace 保留本地现有图片并提示（保守跳过 clear/import）。
 * 这里用 includeReferenceAssets=false，与导出默认（`SavePanel` 参考素材开关默认关）
 * 对齐：仅"选用类"引用（头像/立绘/壁纸/秘档）算数，避免把"仅引用参考素材库、
 * 合法未携带"的正常导出误判为损坏而不必要地进入保留模式（审计 2026-07-09 #6）。
 *
 * 纯函数（不触达 IDB），供 importFullReplace 与单元测试复用。
 */
export function bundleImagesLookDropped(bundle: BackupBundle): boolean {
  const carried = bundle.imageAssets?.length ?? 0;
  if (carried > 0) return false;
  const ids = new Set<string>();
  for (const save of Object.values(bundle.saves ?? {})) {
    if (save && typeof save === 'object') {
      collectAssetIdsFromTree(save as Record<string, unknown>, ids, false);
    }
  }
  return ids.size > 0;
}

/**
 * 测试用导出 —— 公开模块内部的纯函数供单元测试使用
 *
 * 不是公共 API，仅供 `backup-service.test.ts` 导入。
 * 生产代码不应依赖此导出。
 */
export const _testExports = {
  isValidBundleShape,
  collectLocalStorageSettings,
  wipeLocalStorageSettings,
  compositeSlotKey,
  parseCompositeKey,
  hasVectorContent,
  collectAssetIdsFromTree,
  bundleImagesLookDropped,
  BACKUP_FORMAT_VERSION,
  LS_KEY_PREFIXES,
};
