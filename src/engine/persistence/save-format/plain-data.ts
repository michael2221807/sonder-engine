/**
 * 存档数据的形状判断与写入 — save-format 各模块共用（存档瘦身 P1，2026-10-09）
 *
 * Save data is JSON-shaped: plain objects, lists and primitives. A plain object is one whose prototype is
 * Object.prototype or null; anything else (a date, a map, a class instance) is never stepped into or rebuilt key by key.
 * Keys are written as own data properties, so a key named like `__proto__` stays data, as JSON reads it.
 */

/** A plain object (prototype Object.prototype or null). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Set a key as the object's own data property. */
export function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Whether the object holds the key itself (not through its prototype). */
export function hasOwn(target: object, key: string | number): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}
