/**
 * 回退差异 — 把「存下的树」改回「回合开始时的快照」要改哪些地方（存档瘦身 D1A，2026-10-09）
 *
 * The rollback snapshot (the whole tree at round start) used to sit inside the save tree — 41% of a large save. The save
 * now keeps the reverse patch from the tree as saved to that snapshot instead, and the snapshot is rebuilt on load as
 * applyTreePatch(tree, patch). On the PO save: 261 operations, 0.10 MiB compressed, the rebuilt snapshot identical to
 * the original down to the order of its keys (its JSON text is the same).
 *
 * Operations apply in order; a path runs from the root through object keys (strings) and list indices (numbers):
 * - `set` puts the value at the path (a changed or added field, or a value replaced whole);
 * - `del` removes the field at the path (one the snapshot does not have);
 * - `trunc` cuts the list at the path to the length (entries appended after the snapshot);
 * - `order` puts the keys of the object at the path in the snapshot's order (keys added back go to the end otherwise).
 * Plain objects are compared key by key, their key order included; a list that is the snapshot's list with entries
 * added at the end is cut back; lists of the same length are compared entry by entry; anything else is replaced whole.
 *
 * Pass plain trees (StateManager.liveTree): through Vue's reactive proxies both directions run several times slower,
 * and `set` values would be proxies.
 *
 * A patch read back from a save is untrusted: applyTreePatch takes it as unknown, checks its shape, and walks only
 * through keys the tree holds itself — no step can reach Object.prototype, and no list index can grow a list.
 *
 * A key the patch removes or puts in order but the tree no longer holds is skipped: JSON drops keys holding undefined,
 * so a tree that went through an export or a cloud copy can lack keys the live tree had when the patch was made.
 */
import { cloneDeep, isEqualWith } from 'lodash-es';

export type PatchPath = ReadonlyArray<string | number>;

export type TreePatchOp =
  | { op: 'set'; path: PatchPath; value: unknown }
  | { op: 'del'; path: PatchPath }
  | { op: 'trunc'; path: PatchPath; length: number }
  | { op: 'order'; path: PatchPath; keys: readonly string[] };

export type TreePatch = TreePatchOp[];

/** The patch is not one, or does not fit the tree it is applied to. Treat it as "no snapshot". */
export class TreePatchMismatchError extends Error {
  constructor(readonly path: PatchPath, reason: string) {
    super(`Tree patch does not fit at ${JSON.stringify(path)}: ${reason}`);
    this.name = 'TreePatchMismatchError';
  }
}

/** The operations that turn `current` into `target`. Neither is changed; `set` values refer into `target`. */
export function diffTree(current: unknown, target: unknown): TreePatch {
  const ops: TreePatchOp[] = [];
  diffInto(current, target, [], ops);
  return ops;
}

function diffInto(current: unknown, target: unknown, path: Array<string | number>, ops: TreePatchOp[]): void {
  if (sameValue(current, target)) return;
  if (isPlainRecord(current) && isPlainRecord(target)) {
    diffRecords(current, target, path, ops);
    return;
  }
  if (Array.isArray(current) && Array.isArray(target)) {
    if (current.length > target.length && isPrefix(target, current)) {
      ops.push({ op: 'trunc', path, length: target.length });
      return;
    }
    if (current.length === target.length) {
      for (let i = 0; i < current.length; i++) diffInto(current[i], target[i], [...path, i], ops);
      return;
    }
  }
  ops.push({ op: 'set', path, value: target });
}

/** Two plain objects: delete, recurse into or set each key, then restore the key order when it would differ. */
function diffRecords(current: Record<string, unknown>, target: Record<string, unknown>, path: Array<string | number>, ops: TreePatchOp[]): void {
  for (const key of Object.keys(current)) {
    if (!hasOwn(target, key)) ops.push({ op: 'del', path: [...path, key] });
  }
  for (const key of Object.keys(target)) {
    if (hasOwn(current, key)) diffInto(current[key], target[key], [...path, key], ops);
    else ops.push({ op: 'set', path: [...path, key], value: target[key] });
  }
  const keys = Object.keys(target);
  if (!sameKeys(keysAfterPatch(current, target), keys)) ops.push({ op: 'order', path, keys });
}

/** The key order the dels and sets of one object leave: kept keys where they were, added keys after them. */
function keysAfterPatch(current: Record<string, unknown>, target: Record<string, unknown>): string[] {
  const simulated: Record<string, true> = {};
  for (const key of Object.keys(current)) if (hasOwn(target, key)) defineOwn(simulated, key, true);
  for (const key of Object.keys(target)) if (!hasOwn(current, key)) defineOwn(simulated, key, true);
  return Object.keys(simulated);
}

/** Whether the first entries of `longer` equal `prefix`, entry by entry (holes included). */
function isPrefix(prefix: readonly unknown[], longer: readonly unknown[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (hasOwn(prefix, i) !== hasOwn(longer, i) || !sameValue(prefix[i], longer[i])) return false;
  }
  return true;
}

/** Deep equality that also requires plain objects to hold their keys in the same order. */
function sameValue(a: unknown, b: unknown): boolean {
  return isEqualWith(a, b, (x: unknown, y: unknown) => {
    if (isPlainRecord(x) && isPlainRecord(y) && !sameKeys(Object.keys(x), Object.keys(y))) return false;
    return undefined;
  });
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * `base` with the patch applied, as a new value (`base` and the patch are not changed). Throws TreePatchMismatchError
 * when `patch` is not a well-formed patch or does not fit `base`.
 */
export function applyTreePatch(base: unknown, patch: unknown): unknown {
  if (!isTreePatch(patch)) throw new TreePatchMismatchError([], 'not a well-formed patch');
  let out: unknown = cloneDeep(base);
  for (const op of patch) {
    if (op.path.length === 0) {
      out = applyAtRoot(out, op);
      continue;
    }
    const parent = containerAt(out, op.path.slice(0, -1), op.path);
    const key = op.path[op.path.length - 1];
    if (op.op === 'set') {
      setOwn(parent, key, cloneDeep(op.value), op.path);
    } else if (op.op === 'del') {
      if (Array.isArray(parent)) throw new TreePatchMismatchError(op.path, 'del on a list entry');
      // A key already gone is fine: JSON drops a key holding undefined, so a tree that went through an export or a
      // cloud copy lacks keys the live tree had when the patch was made.
      if (hasOwn(parent, key)) delete (parent as Record<string, unknown>)[String(key)];
    } else if (op.op === 'trunc') {
      truncate(hasOwn(parent, key) ? (parent as Record<string | number, unknown>)[key] : undefined, op.length, op.path);
    } else {
      reorder(hasOwn(parent, key) ? (parent as Record<string | number, unknown>)[key] : undefined, op.keys, op.path);
    }
  }
  return out;
}

function applyAtRoot(value: unknown, op: TreePatchOp): unknown {
  if (op.op === 'set') return cloneDeep(op.value);
  if (op.op === 'del') return undefined;
  if (op.op === 'trunc') {
    truncate(value, op.length, op.path);
    return value;
  }
  reorder(value, op.keys, op.path);
  return value;
}

function truncate(list: unknown, length: number, path: PatchPath): void {
  if (!Array.isArray(list) || list.length < length) throw new TreePatchMismatchError(path, 'trunc needs a list at least that long');
  list.length = length;
}

/**
 * Move the named keys the object holds to its end, in the given order; keys it does not name stay where they are. A
 * patch names every key of the object, so this puts them all in order. A named key it does not hold is skipped (JSON
 * drops keys holding undefined), and no key is ever lost. Only the named keys are touched: the cost follows the patch,
 * never the size of the object it is applied to.
 */
function reorder(value: unknown, keys: readonly string[], path: PatchPath): void {
  if (!isPlainRecord(value)) throw new TreePatchMismatchError(path, 'order needs a plain object');
  const present = keys.filter((key) => hasOwn(value, key));
  const values = present.map((key) => value[key]);
  for (const key of present) delete value[key];
  present.forEach((key, i) => defineOwn(value, key, values[i]));
}

/**
 * The object or list a path leads to, stepping only through keys each node holds itself; throws otherwise. Only plain
 * objects and lists hold fields a patch may change (a typed array or a date does not).
 */
function containerAt(root: unknown, steps: PatchPath, fullPath: PatchPath): object {
  let node: unknown = root;
  for (const step of steps) {
    if (!isContainer(node) || !hasOwn(node, step)) throw new TreePatchMismatchError(fullPath, `nothing held at ${String(step)}`);
    node = (node as Record<string | number, unknown>)[step];
  }
  if (!isContainer(node)) throw new TreePatchMismatchError(fullPath, 'the field holding it is not a plain object or a list');
  return node;
}

function isContainer(value: unknown): value is object {
  return Array.isArray(value) || isPlainRecord(value);
}

/** Set a key: a list entry only within the list, an object key as the object's own data property. */
function setOwn(container: object, key: string | number, value: unknown, fullPath: PatchPath): void {
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key >= container.length) throw new TreePatchMismatchError(fullPath, 'a list entry must already be there');
    container[key] = value;
    return;
  }
  defineOwn(container, String(key), value);
}

/** An own data property, also for a key named like `__proto__` (it stays data, as JSON reads it). */
function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Whether a value is a well-formed patch (data read back from a save is not trusted). */
export function isTreePatch(value: unknown): value is TreePatch {
  return isDenseList(value) && value.every(isTreePatchOp);
}

function isTreePatchOp(value: unknown): value is TreePatchOp {
  if (!isPlainRecord(value) || !isDenseList(value.path) || !value.path.every(isPathStep)) return false;
  // A set of undefined loses its `value` key in JSON; it still reads as setting undefined.
  if (value.op === 'set' || value.op === 'del') return true;
  if (value.op === 'trunc') return isIndex(value.length);
  return value.op === 'order' && isDenseList(value.keys) && value.keys.every((key) => typeof key === 'string')
    && new Set(value.keys).size === value.keys.length;
}

/** A list with no holes (`every` would skip them); JSON never gives one, IndexedDB only if a list with holes was stored. */
function isDenseList(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isPathStep(step: unknown): boolean {
  return typeof step === 'string' || isIndex(step);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOwn(target: object, key: string | number): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** A plain object (prototype Object.prototype or null); anything else — lists, dates, maps — is compared whole. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
