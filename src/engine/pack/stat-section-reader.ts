/**
 * stat-section-reader — 从 Game Pack schema 元数据读取属性字段定义
 *
 * 设计原则（STEP-04）：
 * 属性字段名（体魄/灵根/STR 等）是 Game Pack 自定义的内容。
 * 引擎通过扫描 schema 中 `x-display: "stat-bar"` 注解来发现这些字段，
 * 而不是硬编码字段名。
 *
 * 使用方式：
 *   const fields = readStatFields(schema, '角色.属性');
 *   // → [{ key: '体魄', max: 20, order: 1 }, ...]
 */

export interface StatFieldDef {
  /** 字段名（Game Pack 自定义，如 "体魄"、"STR"） */
  key: string;
  /** 最大值（来自 x-max，默认 100） */
  max: number;
  /** Numeric lower bound used by deterministic creation settlement. */
  minimum: number;
  /** Numeric upper bound used by deterministic creation settlement. */
  maximum: number;
  /** 显示顺序（来自 x-order，默认 999） */
  order: number;
}

/**
 * 从 state schema 的指定路径读取所有 stat-bar 字段定义，按 x-order 排序。
 *
 * @param schema   完整 state schema 对象
 * @param dotPath  属性子树路径（如 "角色.属性"）
 */
export function readStatFields(
  schema: Record<string, unknown>,
  dotPath: string,
): StatFieldDef[] {
  // 遍历路径找到子 schema
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = schema;
  for (const seg of segments) {
    const props = current['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props?.[seg]) {
      current = props[seg];
    } else {
      return [];
    }
  }

  const properties = current['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];

  const fields: StatFieldDef[] = [];
  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema['x-display'] !== 'stat-bar') continue;
    fields.push({
      key,
      max: typeof fieldSchema['x-max'] === 'number' ? fieldSchema['x-max'] : 100,
      minimum: typeof fieldSchema['x-creation-min'] === 'number'
        ? fieldSchema['x-creation-min']
        : typeof fieldSchema.minimum === 'number'
          ? fieldSchema.minimum
          : 0,
      maximum: typeof fieldSchema['x-creation-max'] === 'number'
        ? fieldSchema['x-creation-max']
        : typeof fieldSchema.maximum === 'number'
        ? fieldSchema.maximum
        : typeof fieldSchema['x-max'] === 'number'
          ? fieldSchema['x-max']
          : 100,
      order: typeof fieldSchema['x-order'] === 'number' ? fieldSchema['x-order'] : 999,
    });
  }

  return fields.sort((a, b) => a.order - b.order);
}
