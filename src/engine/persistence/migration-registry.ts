/**
 * 存档 schema 迁移注册表 — §5.2 Gap fix
 *
 * 背景：Game Pack 升级后（例如 `tianming` 从 0.3.0 → 0.3.1），旧存档的状态树
 * 结构可能与新 schema 不一致（字段新增 / 重命名 / 类型变化）。如果不做迁移，
 * 旧存档要么报错、要么被 ValidationRepairModule 部分修复、要么在 UI 上显示
 * 错误数据。本模块提供一个最小的 "注册 + 按 packVersion 链式应用" 迁移框架。
 *
 * 设计原则：
 * 1. **最小介入**：注册表为空时运行时行为 = 旧行为（直接返回原数据）。
 * 2. **声明式**：每个迁移只声明 `fromVersion` → `toVersion` 和一个纯函数。
 * 3. **链式应用**：如果存档版本是 0.1.0，当前 pack 是 0.3.0，注册表里有
 *    0.1.0→0.2.0 和 0.2.0→0.3.0 两条迁移，会按顺序应用。
 * 4. **幂等保证**：迁移成功后 SaveManager 会更新 slotMeta.packVersion，下次加载
 *    同一存档不会重复应用。
 * 5. **失败即停**：如果某条迁移抛异常，中断链并返回已应用的部分 —— 调用方
 *    （SaveManager）决定是否继续加载或 surface 错误。
 *
 * 使用示例（未来添加迁移时）：
 *
 *     import { migrationRegistry } from './migration-registry';
 *     migrationRegistry.register({
 *       fromVersion: '0.2.0',
 *       toVersion: '0.3.0',
 *       description: '将 角色.属性 子字段拆出到 角色.可变属性',
 *       migrate: (data) => {
 *         const root = { ...data } as Record<string, unknown>;
 *         // ... schema 变换逻辑
 *         return root;
 *       },
 *     });
 *
 * 内置迁移在启动序列里注册（见 bootstrap/pack-and-migrations.ts 对
 * `migrationRegistry.register()` 的调用）；新增迁移时在那里加。
 */

/**
 * 一条迁移函数的声明
 *
 * @param fromVersion  源版本 —— 应用的存档 `packVersion` 需 **大于等于** 此值且 **小于** toVersion
 * @param toVersion    目标版本 —— 应用后的存档 packVersion 会被更新为此值
 * @param description  人类可读的简短描述（中文），用于加载日志
 * @param migrate      纯函数 —— 接收旧状态树的 plain object，返回新状态树
 */
export interface Migration {
  fromVersion: string;
  toVersion: string;
  description: string;
  migrate: (data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * 比较两个 semver-风格版本号（仅支持 "a.b.c" 形式的整数段）
 *
 * @returns 负数 a<b，正数 a>b，0 相等
 *
 * 非数字段按 0 处理（例："0.3.1-beta" 的 "1-beta" 段会当 0 —— 够用，不追求
 * 完整 semver 语义）。空字符串视为 "0"。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function parseVersion(v: string): number[] {
  // typeof guard: an untrusted card's cardMeta.packVersion could be a number/array at runtime
  // (the field is typed string but JSON is untyped) — keep compareVersions TOTAL, never throw.
  if (typeof v !== 'string' || !v) return [0];
  return v.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** 迁移应用结果 */
export interface MigrationResult {
  /** 最终迁移后的数据（若无迁移应用则原样返回） */
  data: Record<string, unknown>;
  /** 实际应用的迁移列表（按顺序） */
  applied: Migration[];
  /** 链路终点版本 —— 成功时等于 toVersion，失败时等于最后一条成功迁移的 toVersion */
  finalVersion: string;
  /** 应用过程中抛出的错误（中断时才有） */
  error?: Error;
}

/**
 * 全局迁移注册表单例
 *
 * 使用单例而非构造函数注入，因为迁移是全局只读配置，无需每个 SaveManager 实例
 * 持有一份拷贝。并发写入不是问题：注册仅在 `main.ts` 启动序列中进行。
 */
export class MigrationRegistry {
  private migrations: Migration[] = [];

  /**
   * 注册一条迁移
   *
   * 不做重复检测 —— 同一 fromVersion 可以有多条迁移（理论上应该只有一条，
   * 但注册表不强制）。应用时按 fromVersion 排序，找第一条可用的。
   */
  register(migration: Migration): void {
    this.migrations.push(migration);
    // 按 fromVersion 升序稳定排序，保证应用链的确定性
    this.migrations.sort((a, b) => compareVersions(a.fromVersion, b.fromVersion));
  }

  /** 当前已注册的迁移总数（测试/调试用） */
  size(): number {
    return this.migrations.length;
  }

  /**
   * 按 `fromVersion → toVersion` 应用所有可用的迁移
   *
   * 算法：
   * 1. 维护 "currentVersion"，初始 = fromVersion
   * 2. 循环：找出第一条 `m.fromVersion <= currentVersion < m.toVersion` 的迁移
   * 3. 应用 m.migrate，currentVersion 前进到 m.toVersion
   * 4. 重复直到 currentVersion >= toVersion 或找不到下一条迁移
   *
   * 不保证一定到达 toVersion —— 如果注册表里缺某一段（如 0.2.0→0.3.0 缺失），
   * 链会停在 0.2.0。调用方读 `finalVersion` 判断。
   *
   * 带一个 100 次的安全上限防止恶意循环迁移。
   */
  apply(
    data: Record<string, unknown>,
    fromVersion: string,
    toVersion: string,
  ): MigrationResult {
    const applied: Migration[] = [];
    let current: Record<string, unknown> = data;
    let currentVersion = fromVersion || '0';

    // Fast path: already at or past target
    if (compareVersions(currentVersion, toVersion) >= 0) {
      return { data: current, applied: [], finalVersion: currentVersion };
    }

    let safety = 100;
    while (compareVersions(currentVersion, toVersion) < 0 && safety-- > 0) {
      const next = this.migrations.find(
        (m) =>
          compareVersions(m.fromVersion, currentVersion) <= 0 &&
          compareVersions(currentVersion, m.toVersion) < 0,
      );
      if (!next) break;

      try {
        current = next.migrate(current);
      } catch (err) {
        return {
          data: current,
          applied,
          finalVersion: currentVersion,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      applied.push(next);
      currentVersion = next.toVersion;
    }

    return { data: current, applied, finalVersion: currentVersion };
  }

  /** 清空注册表（仅测试用） */
  clear(): void {
    this.migrations = [];
  }
}

/**
 * 全局单例 —— 从 `SaveManager.loadGame` 引用，在 `main.ts` 启动时可添加迁移
 */
export const migrationRegistry = new MigrationRegistry();
