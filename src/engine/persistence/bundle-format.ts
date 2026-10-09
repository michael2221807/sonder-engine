/**
 * Backup bundle format — types, shape / version validation and composite-key helpers.
 *
 * Pure (no IDB, no localStorage, no event bus): moved out of backup-service.ts (R6 step 4)
 * so the format can be read and tested without the service. backup-service re-exports the
 * public names it used to define.
 */
import type { CustomPresetEntry } from './custom-preset-store';
import type { ImageAsset } from '../image/types';
import type { WorldBook } from '../prompt/world-book';
import { collectAssetIdsFromTree } from '../image/asset-refs';

// ─── 常量 ───

/**
 * 备份文件的格式版本 — 导入时用于兼容性校验和未来的格式迁移。
 * 2 (存档瘦身 D4A, 2026-10-09): vectors are the base64 of their little-endian float32 bytes; version 1 bundles (number
 * lists) import as before, and code from before refuses version 2.
 */
export const BACKUP_FORMAT_VERSION = 2;

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
  /**
   * `lastPlayedAt` 对应那个槽的回合序号（云端插槽新鲜度比较，2026-09-12）。
   * 与 UI 本地戳同源：都由 `deriveProfileSaveStamp` 推导。旧 manifest 无此字段。
   */
  lastRound?: number | null;
}

/**
 * A world book as exported: the exporter tags every book with the profile it belongs to
 * (`_exportProfileId`) so the importer can put it back under the right profile.
 */
export type TaggedWorldBook = WorldBook & { _exportProfileId?: string };

/** Tag every book with its owning profile (mutates in place, like the original exporters). */
export function tagWorldBooks(books: WorldBook[], profileId: string): TaggedWorldBook[] {
  for (const b of books) {
    (b as TaggedWorldBook)._exportProfileId = profileId;
  }
  return books;
}

/**
 * Parse bundle text, check its shape and refuse a version newer than this engine.
 * Shared by importAll and importProfileReplace (their messages were identical).
 *
 * @throws 形状无效或版本过高
 */
export function parseBundleText(text: string): BackupBundle {
  const raw: unknown = JSON.parse(text);
  if (!isValidBundleShape(raw)) {
    throw new Error('备份文件格式无效：缺少必需字段或结构不正确');
  }
  const bundle = raw as BackupBundle;
  if (bundle.version > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `备份版本 ${bundle.version} 高于当前支持的版本 ` +
        `${BACKUP_FORMAT_VERSION}，请先升级引擎再导入`,
    );
  }
  return bundle;
}

// ─── 函数 ───

/**
 * 生成存档/向量数据的复合 key
 *
 * 使用 "/" 分隔而非 "_"，与 idbAdapter 中的 save key 格式区分：
 * - 备份包内: "profileId/slotId"（人类可读、方便 JSON 查看）
 * - IndexedDB: "save_profileId_slotId"（兼容旧格式、无特殊字符歧义）
 */
export function compositeSlotKey(profileId: string, slotId: string): string {
  return `${profileId}/${slotId}`;
}

/**
 * 从复合 key 索引的 saves/vectors 中过滤出指定档案的条目。
 *
 * 档案级导入的防线：档案包内出现**其他**档案的复合 key（损坏或恶意数据）时
 * 静默丢弃，绝不写进别的档案。格式非法的 key 同样丢弃。
 */
export function filterCompositeByProfile(
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
export function parseCompositeKey(key: string): {
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
export function hasVectorContent(data: {
  eventVectors: Readonly<Record<string, unknown>>;
  entityVectors: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    Object.keys(data.eventVectors).length > 0 ||
    Object.keys(data.entityVectors).length > 0
  );
}

/**
 * True when the bundle carries an explicit world-book section (possibly an empty list).
 *
 * Absent section ⇒ the importer must NOT touch local hand-written books: exporters before
 * 2026-09-09 omitted the key whenever a machine had zero books, so "absent" cannot be
 * told apart from "older format" — and the safe reading of an unknown is "keep".
 */
export function bundleCarriesWorldBooks(
  bundle: BackupBundle,
): bundle is BackupBundle & { worldBooks: import('../prompt/world-book').WorldBookExportData } {
  return !!bundle.worldBooks && Array.isArray(bundle.worldBooks.books);
}

/**
 * 校验备份包的基本结构 — 纯形状检查
 *
 * 只验证顶层字段的存在性和基本类型，不深入校验子结构。
 * 子结构的校验由各 restore 方法在实际使用时处理。
 */
export function isValidBundleShape(data: unknown): data is BackupBundle {
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
