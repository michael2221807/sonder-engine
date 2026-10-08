/**
 * 配置系统类型定义
 *
 * 实现 STEP-02 §3.7 的双层配置模型：
 * Game Pack Default (read-only) + User Overlay (IndexedDB) = Resolved Config
 *
 * 配置域（ConfigDomain）按功能分类注册，
 * 用户修改只存 diff（ConfigOverlay），合并后得到运行时生效值。
 */

/** 配置域标识符 — 如 "memory", "calendar", "heartbeat" 等 */
export type ConfigDomainId = string;

/**
 * 配置域注册信息
 * 每个 Game Pack 规则文件对应一个配置域
 */
export interface ConfigDomain {
  /** 唯一标识 */
  id: ConfigDomainId;
  /** 显示名称（用于 UI） */
  name: string;
  /** 描述文字（用于 UI） */
  description?: string;
  /** JSON Schema 对象 — 用于校验用户修改的合法性 */
  schema: Record<string, unknown>;
  /** 配置版本号 — 用于迁移 */
  version: number;
  /** Game Pack 中的源文件路径（如 "rules/memory-config.json"） */
  defaultSource: string;
}

/**
 * 用户对某个配置域的修改
 * 只存储与默认值不同的字段（diff），不存全量
 */
export interface ConfigOverlay {
  /** 配置域 ID */
  domainId: ConfigDomainId;
  /** 所属游戏包 ID — 不同包的用户配置互不干扰 */
  packId: string;
  /** 用户修改的字段（深合并到默认值上，数组整体替换，见 core/config-system.ts） */
  patches: Record<string, unknown>;
  /** 配置版本号 — 与 ConfigDomain.version 对应 */
  version: number;
  /** 最后修改时间 */
  updatedAt: number;
}

/**
 * 运行时生效的配置
 * 由 ConfigResolver 合并 default + overlay 后生成
 */
export interface ResolvedConfig {
  /** 配置域 ID */
  domainId: ConfigDomainId;
  /** 合并后的完整配置数据 */
  data: Record<string, unknown>;
  /** 是否包含用户修改（用于 UI 显示"已修改"标记） */
  isModified: boolean;
}
