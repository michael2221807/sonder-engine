/**
 * 校验修复模块 — 根据 Game Pack 的 state-schema 校验并修复状态树
 *
 * 问题背景：
 * AI 可能生成不合规的状态修改（如数值越界、缺少必填字段、类型错误），
 * 本模块在关键时刻（加载、创角、每轮结束）校验状态树的合规性：
 *
 * 修复策略（按严重度）：
 * 1. 缺失字段 → 填入 schema 中的默认值
 * 2. 数值越界 → 钳制（clamp）到 min/max 范围；声明了 `x-maximum-field` 的字段不超过同级那个字段的当前值
 *    （如「当前」不超过「上限」——只在这里收尾，回合内命令先后顺序不影响结果）
 * 3. 类型错误 → 尝试类型转换，失败则替换为默认值
 *
 * 设计选择：
 * 本模块只做"安全修复"（不改变语义的修正），不做删除操作。
 * 未在 schema 中定义但存在于状态树中的额外字段保持原样，
 * 因为 AI 可能动态创建了 Game Pack 未预见的字段。
 *
 * 对应 STEP-02 §3.10.4（validation-repair 部分）。
 */
import { get as _get, set as _set } from 'lodash-es';
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';

/**
 * JSON Schema 子集 — 仅覆盖本模块需要的校验属性
 * Game Pack 的 state-schema.json 使用标准 JSON Schema，
 * 但本模块只关心 type/default/minimum/maximum/properties/items 几个字段。
 */
interface SchemaNode {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** Pack extension: the name of a sibling number field this value may not exceed (e.g. a current value and its max). */
  'x-maximum-field'?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}

export class ValidationRepairModule implements BehaviorModule {
  readonly id = 'validation-repair';

  /** Game Pack 的状态树 schema（JSON Schema 格式） */
  private schema: SchemaNode;

  constructor(stateSchema: Record<string, unknown>) {
    this.schema = stateSchema as SchemaNode;
  }

  onGameLoad(stateManager: StateManager): void {
    this.validateAndRepair(stateManager);
  }

  onCreation(stateManager: StateManager): void {
    this.validateAndRepair(stateManager);
  }

  onRoundEnd(stateManager: StateManager): void {
    this.validateAndRepair(stateManager);
  }

  /**
   * 递归遍历 schema，对状态树中的每个字段做校验和修复
   *
   * 遍历策略：深度优先，按 schema 的 properties 树走。
   * 只处理 schema 中声明的字段，跳过未声明的额外字段。
   */
  private validateAndRepair(stateManager: StateManager): void {
    if (!this.schema.properties) return;

    let repairCount = 0;

    const walk = (schemaNode: SchemaNode, currentPath: string): void => {
      if (!schemaNode.properties) return;

      for (const [key, childSchema] of Object.entries(schemaNode.properties)) {
        const fieldPath = currentPath ? `${currentPath}.${key}` : key;
        const value = stateManager.get<unknown>(fieldPath);

        // 检查 1: 缺失的必填字段
        if (value === undefined || value === null) {
          if (childSchema.default !== undefined) {
            stateManager.set(fieldPath, childSchema.default, 'system');
            repairCount++;
          }
          continue;
        }

        // 检查 2: 类型校验与修复
        if (childSchema.type) {
          const repaired = this.coerceType(value, childSchema.type, childSchema.default, childSchema.properties);
          if (repaired !== value) {
            stateManager.set(fieldPath, repaired, 'system');
            repairCount++;
          }
        }

        // 检查 3: 数值范围钳制
        if (childSchema.type === 'number' || childSchema.type === 'integer') {
          const numValue = Number(stateManager.get(fieldPath));
          const clamped = this.clampNumber(numValue, childSchema.minimum, this.maximumOf(stateManager, currentPath, childSchema));
          if (clamped !== numValue) {
            stateManager.set(fieldPath, clamped, 'system');
            repairCount++;
          }
        }

        // 递归处理嵌套对象
        if (childSchema.type === 'object' && childSchema.properties) {
          walk(childSchema, fieldPath);
        }

        // 数组元素校验
        if (childSchema.type === 'array' && childSchema.items) {
          this.validateArrayItems(stateManager, fieldPath, childSchema.items);
        }
      }
    };

    walk(this.schema, '');

    if (repairCount > 0) {
      console.log(`[ValidationRepair] Repaired ${repairCount} field(s)`);
    }
  }

  /**
   * 类型强制转换 — 尽力将值转换为期望类型
   *
   * 转换规则：
   * - string → number: Number() 转换，NaN 时回退默认值
   * - number → string: String() 转换
   * - 其他不兼容类型 → 使用默认值
   */
  private coerceType(
    value: unknown,
    expectedType: string,
    defaultValue: unknown,
    schemaProperties?: Record<string, SchemaNode>,
  ): unknown {
    switch (expectedType) {
      case 'number':
      case 'integer': {
        if (typeof value === 'number') return value;
        const num = Number(value);
        return Number.isNaN(num) ? (defaultValue ?? 0) : num;
      }
      case 'string':
        return typeof value === 'string' ? value : String(value);
      case 'boolean':
        return typeof value === 'boolean' ? value : Boolean(value);
      case 'array':
        return Array.isArray(value) ? value : (defaultValue ?? []);
      case 'object':
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
        if (typeof value === 'string' && value && schemaProperties) {
          const propKeys = Object.keys(schemaProperties);
          if (propKeys.length === 2 && propKeys.every((k) => schemaProperties[k]?.type === 'string')) {
            return { [propKeys[0]]: value, [propKeys[1]]: '' };
          }
        }
        return (defaultValue ?? {});
      default:
        return value;
    }
  }

  /**
   * The effective maximum of a number field: its declared `maximum`, lowered to the value of the sibling
   * field named by `x-maximum-field` when that sibling holds a number. A sibling that is missing or not a
   * number leaves the declared maximum (if any) in force.
   */
  private maximumOf(stateManager: StateManager, parentPath: string, node: SchemaNode): number | undefined {
    const field = node['x-maximum-field'];
    if (!field) return node.maximum;
    const sibling = Number(stateManager.get(parentPath ? `${parentPath}.${field}` : field));
    if (!Number.isFinite(sibling)) return node.maximum;
    return node.maximum === undefined ? sibling : Math.min(node.maximum, sibling);
  }

  /**
   * 数值钳制 — 将值限制在 [min, max] 范围内
   * undefined 的边界视为无限制
   */
  private clampNumber(value: number, min?: number, max?: number): number {
    let result = value;
    if (min !== undefined && result < min) result = min;
    if (max !== undefined && result > max) result = max;
    return result;
  }

  /**
   * 数组元素校验 — 对数组中的每个对象元素递归校验
   *
   * CR-R4 修复（2026-04-11）：
   * 原实现只处理 items.properties 的**顶层**字段（default 填充 + number clamp）。
   * 嵌套对象属性（如 `社交.关系.items.私密信息.身体部位[].敏感度`）不被递归，
   * 导致 NSFW 完整 schema 校验失效。
   *
   * 修复后：对每个数组元素字段，若该字段的 schema 是嵌套 object 且有 properties，
   * 递归调用 `validateAndRepairNode`；若是嵌套 array，递归调用本方法。
   *
   * 注意不要递归时无限循环 — schema 没有 `$ref` 所以不会有环（CR-R21 另记）。
   */
  private validateArrayItems(
    stateManager: StateManager,
    arrayPath: string,
    itemSchema: SchemaNode,
  ): void {
    if (itemSchema.type !== 'object' || !itemSchema.properties) return;

    const arr = stateManager.get<unknown[]>(arrayPath);
    if (!Array.isArray(arr)) return;

    let needsRewrite = false;
    const propKeys = itemSchema.properties ? Object.keys(itemSchema.properties) : [];
    const isTwoStringProps = propKeys.length === 2
      && propKeys.every((k) => itemSchema.properties![k]?.type === 'string');
    const converted = arr.map((item) => {
      if (typeof item === 'string' && isTwoStringProps) {
        needsRewrite = true;
        return { [propKeys[0]]: item, [propKeys[1]]: '' };
      }
      return item;
    });
    if (needsRewrite) {
      stateManager.set(arrayPath, converted, 'system');
    }

    for (let i = 0; i < converted.length; i++) {
      const itemPath = `${arrayPath}[${i}]`;
      for (const [key, propSchema] of Object.entries(itemSchema.properties)) {
        const fieldPath = `${itemPath}.${key}`;
        const value = stateManager.get<unknown>(fieldPath);

        // 1. 缺失字段填 default
        if (value === undefined && propSchema.default !== undefined) {
          stateManager.set(fieldPath, propSchema.default, 'system');
        }

        // 2. 数值范围 clamp
        if (propSchema.type === 'number' || propSchema.type === 'integer') {
          const numVal = Number(stateManager.get(fieldPath) ?? propSchema.default ?? 0);
          if (!Number.isNaN(numVal)) {
            const clamped = this.clampNumber(numVal, propSchema.minimum, this.maximumOf(stateManager, itemPath, propSchema));
            if (clamped !== numVal) {
              stateManager.set(fieldPath, clamped, 'system');
            }
          }
        }

        // 3. CR-R4: 嵌套对象 → 递归处理其 properties
        //    例：社交.关系[i].私密信息 是嵌套 object，需要递归到 身体部位 等子字段
        if (propSchema.type === 'object' && propSchema.properties) {
          this.validateNestedObject(stateManager, fieldPath, propSchema);
        }

        // 4. CR-R4: 嵌套数组 → 递归调用本方法处理其 items
        //    例：社交.关系[i].私密信息.身体部位 是嵌套 array
        if (propSchema.type === 'array' && propSchema.items) {
          this.validateArrayItems(stateManager, fieldPath, propSchema.items);
        }
      }
    }
  }

  /**
   * CR-R4 新增：校验嵌套对象的每个属性字段
   *
   * 与 `validateAndRepair` 的主要 `walk` 类似，但接收任意起始路径（而非 root）。
   * 递归终止条件：没有 properties 或 type 不是 object。
   */
  private validateNestedObject(
    stateManager: StateManager,
    basePath: string,
    nodeSchema: SchemaNode,
  ): void {
    if (nodeSchema.type !== 'object' || !nodeSchema.properties) return;

    for (const [key, childSchema] of Object.entries(nodeSchema.properties)) {
      const fieldPath = `${basePath}.${key}`;
      const value = stateManager.get<unknown>(fieldPath);

      // 1. 缺失字段填 default
      if ((value === undefined || value === null) && childSchema.default !== undefined) {
        stateManager.set(fieldPath, childSchema.default, 'system');
      }

      // 2. 数值范围 clamp
      if (childSchema.type === 'number' || childSchema.type === 'integer') {
        const numVal = Number(stateManager.get(fieldPath) ?? childSchema.default ?? 0);
        if (!Number.isNaN(numVal)) {
          const clamped = this.clampNumber(numVal, childSchema.minimum, this.maximumOf(stateManager, basePath, childSchema));
          if (clamped !== numVal) {
            stateManager.set(fieldPath, clamped, 'system');
          }
        }
      }

      // 3. 继续向下递归
      if (childSchema.type === 'object' && childSchema.properties) {
        this.validateNestedObject(stateManager, fieldPath, childSchema);
      }

      if (childSchema.type === 'array' && childSchema.items) {
        this.validateArrayItems(stateManager, fieldPath, childSchema.items);
      }
    }
  }
}
