/**
 * 不改原树的点路径读写 — 存档格式升级与回退差异用（存档瘦身 P1，2026-10-09）
 *
 * The format upgrade must leave the tree it read untouched (a failed upgrade returns it as it was, and a tree with
 * nothing to upgrade comes back as the same object), so a write copies only the objects on the way to the field.
 * Paths are plain dot paths of object keys (engine paths such as `元数据.叙事历史`), no filters or list indices.
 */
import { defineOwn, hasOwn, isPlainRecord } from './plain-data';

type Tree = Record<string, unknown>;

/** A field on the way to a write holds something other than a plain object: the tree is not shaped as expected. */
export class PathShapeError extends Error {
  constructor(readonly path: string, readonly key: string) {
    super(`Cannot write ${path}: "${key}" holds something other than a plain object`);
    this.name = 'PathShapeError';
  }
}

/** The value at a dot path, or undefined when a step is missing or not a plain object. */
export function readPath(tree: unknown, path: string): unknown {
  let node: unknown = tree;
  for (const key of path.split('.')) {
    if (!isPlainRecord(node) || !hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * A copy of the tree with the value at the dot path; the objects on the way are copied, missing ones created. Throws
 * PathShapeError when a field on the way holds something else (it is never replaced).
 */
export function writePath(tree: Tree, path: string, value: unknown): Tree {
  const [key, ...rest] = path.split('.');
  return writeAt(tree, key, rest, path, value);
}

function writeAt(tree: Tree, key: string, rest: string[], path: string, value: unknown): Tree {
  const next = { ...tree };
  if (rest.length === 0) {
    defineOwn(next, key, value);
    return next;
  }
  const held = hasOwn(tree, key) ? tree[key] : undefined;
  if (held !== undefined && !isPlainRecord(held)) throw new PathShapeError(path, key);
  defineOwn(next, key, writeAt(held ?? {}, rest[0], rest.slice(1), path, value));
  return next;
}

/** A copy of the tree without the field at the dot path, or the tree itself when the field is not there. */
export function removePath(tree: Tree, path: string): Tree {
  const [key, ...rest] = path.split('.');
  if (!hasOwn(tree, key)) return tree;
  if (rest.length === 0) {
    const next = { ...tree };
    delete next[key];
    return next;
  }
  const child = tree[key];
  if (!isPlainRecord(child)) return tree;
  const nextChild = removePath(child, rest.join('.'));
  if (nextChild === child) return tree;
  const next = { ...tree };
  defineOwn(next, key, nextChild);
  return next;
}
