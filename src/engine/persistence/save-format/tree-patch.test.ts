import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { applyTreePatch, diffTree, isTreePatch, TreePatchMismatchError, type TreePatch } from './tree-patch';

/**
 * Round trip: the patch from `current` to `target`, applied to `current`, gives `target` exactly — key order included
 * (same JSON text), undefined values apart from missing keys (toStrictEqual) — also after the patch is stored as JSON.
 */
function roundTrip(current: unknown, target: unknown): TreePatch {
  const patch = diffTree(current, target);
  const rebuilt = applyTreePatch(current, patch);
  expect(rebuilt).toStrictEqual(target);
  expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(target));
  expect(JSON.stringify(applyTreePatch(current, JSON.parse(JSON.stringify(patch))))).toBe(JSON.stringify(target));
  return patch;
}

/** Nothing a patch does may reach the shared prototypes. */
function expectPrototypesUntouched(): void {
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(([] as unknown[])[0]).toBeUndefined();
  expect(typeof Object.prototype.toString).toBe('function');
}

describe('tree patch (D1A)', () => {

  it('is empty for equal trees', () => {
    const tree = { a: 1, b: [1, { c: 'x' }], d: { e: null } };
    expect(diffTree(tree, cloneDeep(tree))).toEqual([]);
  });

  it('sets changed and added fields, deletes the fields the target does not have', () => {
    const patch = roundTrip({ a: 1, b: 2, gone: true }, { a: 1, b: 3, added: { x: 1 } });
    expect(patch).toEqual([
      { op: 'del', path: ['gone'] },
      { op: 'set', path: ['b'], value: 3 },
      { op: 'set', path: ['added'], value: { x: 1 } },
    ]);
  });

  it('cuts a list back when the current list is the target list with entries appended', () => {
    const history = [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }];
    const current = { 元数据: { 叙事历史: [...history, { role: 'user', content: '三' }, { role: 'assistant', content: '四' }] } };
    const patch = roundTrip(current, { 元数据: { 叙事历史: history } });
    expect(patch).toEqual([{ op: 'trunc', path: ['元数据', '叙事历史'], length: 2 }]);
  });

  it('compares lists of the same length entry by entry, and replaces a list that is neither', () => {
    expect(roundTrip([1, { a: 1 }, 3], [1, { a: 2 }, 3])).toEqual([{ op: 'set', path: [1, 'a'], value: 2 }]);
    expect(roundTrip([1, 2], [1, 2, 3])).toEqual([{ op: 'set', path: [], value: [1, 2, 3] }]);
    expect(roundTrip({ list: [9, 2, 3] }, { list: [1, 2] })).toEqual([{ op: 'set', path: ['list'], value: [1, 2] }]);
  });

  it('puts keys added back where the target had them, and restores an order that alone changed', () => {
    // The round used the sword; rolling back must give the inventory in its old order, not sword last.
    const patch = roundTrip({ 物品: { 药水: 1, 地图: 1 } }, { 物品: { 宝剑: 1, 药水: 1, 地图: 1 } });
    expect(patch).toEqual([
      { op: 'set', path: ['物品', '宝剑'], value: 1 },
      { op: 'order', path: ['物品'], keys: ['宝剑', '药水', '地图'] },
    ]);
    expect(roundTrip({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([{ op: 'order', path: [], keys: ['b', 'a'] }]);
    expect(roundTrip({ x: [{ a: 1, b: 2 }] }, { x: [{ b: 2, a: 1 }] })).toEqual([{ op: 'order', path: ['x', 0], keys: ['b', 'a'] }]);
    expect(diffTree({ 2: 'b', 1: 'a' }, { 1: 'a', 2: 'b' })).toEqual([]);
  });

  it('replaces a value whose type changed, and works at the root', () => {
    expect(roundTrip({ a: [1] }, { a: { 0: 1 } })).toEqual([{ op: 'set', path: ['a'], value: { 0: 1 } }]);
    roundTrip('text', { a: 1 });
    roundTrip({ a: 1 }, null);
    expect(applyTreePatch([1, 2, 3], [{ op: 'trunc', path: [], length: 1 }])).toEqual([1]);
    expect(applyTreePatch({ a: 1 }, [{ op: 'del', path: [] }])).toBeUndefined();
    expect(() => applyTreePatch([1], [{ op: 'trunc', path: [], length: 2 }])).toThrow(TreePatchMismatchError);
  });

  it('keeps a field holding undefined apart from a missing one', () => {
    expect(roundTrip({ a: 1 }, { a: 1, b: undefined })).toEqual([{ op: 'set', path: ['b'], value: undefined }]);
    expect(roundTrip({ a: 1, b: undefined }, { a: 1 })).toEqual([{ op: 'del', path: ['b'] }]);
  });

  it('replaces whole what is not a plain object or list, and lists with holes', () => {
    expect(roundTrip({ d: new Date(1) }, { d: new Date(2) })).toEqual([{ op: 'set', path: ['d'], value: new Date(2) }]);
    const sparse = [, 1];
    expect(diffTree(['X', 1, 2], sparse)).toEqual([{ op: 'set', path: [], value: sparse }]);
    // A hole is not an undefined entry: the longer list does not start with the sparse one.
    expect(diffTree([undefined, 1, 2], sparse)).toEqual([{ op: 'set', path: [], value: sparse }]);
  });

  it('deletes an own key named like an inherited one, and patches an own __proto__ key as plain data', () => {
    roundTrip({ constructor: 1, toString: 2, a: 1 }, { a: 1 });
    const target = JSON.parse('{"a":{"__proto__":{"polluted":true},"constructor":1}}') as Record<string, unknown>;
    const out = applyTreePatch({ a: {} }, diffTree({ a: {} }, target)) as { a: Record<string, unknown> };
    expect(Object.keys(out.a)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    const own = JSON.parse('{"a":{"__proto__":{"x":1}}}') as unknown;
    expect(applyTreePatch(own, [{ op: 'set', path: ['a', '__proto__', 'x'], value: 2 }])).toEqual(JSON.parse('{"a":{"__proto__":{"x":2}}}'));
    expectPrototypesUntouched();
  });

  it('cannot reach the shared prototypes through a path, whatever a stored patch says', () => {
    const attacks: Array<[unknown, unknown]> = [
      [{ a: {} }, [{ op: 'set', path: ['a', '__proto__', 'polluted'], value: true }]],
      [{ list: [1, 2] }, [{ op: 'set', path: ['list', '__proto__', 0], value: 'EVIL' }]],
      [{ a: 1 }, [{ op: 'del', path: ['__proto__', 'toString'] }]],
      [{ a: 1 }, [{ op: 'trunc', path: ['constructor', 'prototype'], length: 0 }]],
      [{ a: 1 }, [{ op: 'order', path: ['__proto__'], keys: [] }]],
      // Array.prototype is itself a list: a trunc must not reach it through an inherited key either.
      [{ list: [1, 2] }, [{ op: 'trunc', path: ['list', '__proto__'], length: 0 }]],
    ];
    for (const [base, patch] of attacks) {
      expect(() => applyTreePatch(base, patch)).toThrow(TreePatchMismatchError);
      expectPrototypesUntouched();
    }
    // Removing a key the object does not hold itself does nothing, also for inherited names.
    expect(applyTreePatch({ a: 1 }, [{ op: 'del', path: ['toString'] }, { op: 'del', path: ['__proto__'] }])).toEqual({ a: 1 });
    expectPrototypesUntouched();
  });

  it('still applies to a tree that went through JSON, which drops keys holding undefined', () => {
    const throughJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ x: 1, u: undefined, y: 2 }, { y: 2, u: undefined, x: 1 }],
      [{ x: 1, part: undefined }, { x: 1 }],
      // An image task list rotated by one new task, its optional fields stored as undefined (task-queue create()).
      [{ tasks: [{ id: 't3', anchorId: undefined }, { id: 't2', presetId: undefined }, { id: 't1' }] },
        { tasks: [{ id: 't2', presetId: undefined }, { id: 't1' }, { id: 't0', anchorId: undefined }] }],
    ];
    for (const [live, snapshot] of cases) {
      const patch = diffTree(live, snapshot);
      const rebuilt = applyTreePatch(throughJson(live), throughJson(patch));
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(snapshot));
    }
  });

  it('never grows a list through a set: an entry must already be there', () => {
    expect(() => applyTreePatch({ list: [1] }, [{ op: 'set', path: ['list', 1], value: 2 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ list: [1] }, [{ op: 'set', path: ['list', 30_000_000], value: 1 }])).toThrow(TreePatchMismatchError);
    expect(isTreePatch([{ op: 'set', path: ['list', 2 ** 53], value: 1 }])).toBe(false);
    expect(applyTreePatch({ list: [1, 2] }, [{ op: 'set', path: ['list', 1], value: 9 }])).toEqual({ list: [1, 9] });
  });

  it('changes neither the base nor the patch, and the result shares nothing with either', () => {
    const base = { a: { b: [1, 2, 3] }, c: 1 };
    const target = { a: { b: [1, 2] }, c: { d: [1] } };
    const patch = diffTree(base, target);
    const before = { base: cloneDeep(base), patch: cloneDeep(patch) };
    const out = applyTreePatch(base, patch) as { c: { d: number[] } };
    expect(base).toStrictEqual(before.base);
    expect(patch).toStrictEqual(before.patch);
    out.c.d.push(2);
    expect(target.c.d).toEqual([1]);
  });

  it('refuses a patch that is not one or does not fit the tree', () => {
    for (const notAPatch of [null, {}, 'ops', [{ op: 'move', path: [] }]]) {
      expect(() => applyTreePatch({ a: 1 }, notAPatch)).toThrow(TreePatchMismatchError);
    }
    expect(() => applyTreePatch({ a: 1 }, [{ op: 'set', path: ['missing', 'x'], value: 1 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ a: [1] }, [{ op: 'trunc', path: ['a'], length: 3 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ a: [1, 2] }, [{ op: 'del', path: ['a', 0] }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ a: [1, 2] }, [{ op: 'set', path: ['a', 'x'], value: 1 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ a: 1 }, [{ op: 'set', path: ['a', 'b'], value: 1 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ v: new Float32Array(2) }, [{ op: 'set', path: ['v', 0], value: 1 }])).toThrow(TreePatchMismatchError);
    // Only plain objects and lists are stepped through, not other objects that happen to have own fields.
    class Box { inner = { x: 1 }; }
    expect(() => applyTreePatch({ b: new Box() }, [{ op: 'set', path: ['b', 'inner', 'x'], value: 2 }])).toThrow(TreePatchMismatchError);
    expect(() => applyTreePatch({ a: [1] }, [{ op: 'order', path: ['a'], keys: [] }])).toThrow(TreePatchMismatchError);
  });

  it('moves the keys it names that the object holds to the end in that order, leaving the others, never losing one', () => {
    const out = applyTreePatch({ a: { x: 1, y: 2, z: 3 } }, [{ op: 'order', path: ['a'], keys: ['z', 'gone', 'x'] }]) as { a: object };
    expect(Object.keys(out.a)).toEqual(['y', 'z', 'x']);
    expect(out.a).toEqual({ x: 1, y: 2, z: 3 });
    expect(applyTreePatch({ a: { x: 1 } }, [{ op: 'order', path: ['a'], keys: ['y'] }])).toEqual({ a: { x: 1 } });
    // An integer-like key is ordered first by the engine either way: no needless order operation.
    expect(diffTree({ b: 1 }, { 1: 'a', b: 1 })).toEqual([{ op: 'set', path: ['1'], value: 'a' }]);
  });

  it('costs what the patch names, not the size of the object: an order naming nothing touches nothing', () => {
    const big = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]));
    const patch = Array.from({ length: 2_000 }, () => ({ op: 'order', path: ['d'], keys: [] as string[] }));
    const started = performance.now();
    const out = applyTreePatch({ d: big }, patch) as { d: Record<string, number> };
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(Object.keys(out.d)).toEqual(Object.keys(big));
    const named = applyTreePatch({ d: big }, [{ op: 'order', path: ['d'], keys: ['k0'] }]) as { d: Record<string, number> };
    expect(Object.keys(named.d).at(-1)).toBe('k0');
    expect(Object.keys(named.d)[0]).toBe('k1');
  });

  it('tells a well-formed stored patch from anything else', () => {
    expect(isTreePatch([])).toBe(true);
    expect(isTreePatch([{ op: 'set', path: ['a', 0], value: 1 }, { op: 'set', path: ['b'] }, { op: 'del', path: ['c'] },
      { op: 'trunc', path: [], length: 0 }, { op: 'order', path: ['d'], keys: ['x', 'y'] }])).toBe(true);
    for (const bad of [null, {}, [{ op: 'set' }], [{ op: 'move', path: [] }], [{ op: 'trunc', path: ['a'], length: -1 }],
      [{ op: 'trunc', path: ['a'], length: 1.5 }], [{ op: 'del', path: [1.5] }], [{ op: 'del', path: [-1] }],
      [{ op: 'del', path: [null] }], [{ op: 'order', path: [], keys: ['a', 'a'] }], [{ op: 'order', path: [], keys: [1] }],
      // Lists with holes (only in-process data has them):
      new Array(1), [{ op: 'del', path: [, 'a'] }], [{ op: 'order', path: [], keys: ['x', , 'y'] }]]) {
      expect(isTreePatch(bad)).toBe(false);
    }
  });

  it('round-trips random trees, including appended lists, removed keys, replaced values and reordered keys', () => {
    let seed = 20261009;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const leaf = () => [() => Math.floor(random() * 5), () => `s${Math.floor(random() * 4)}`, () => null, () => random() < 0.5][Math.floor(random() * 4)]();
    const tree = (depth: number): unknown => {
      const r = random();
      if (depth === 0 || r < 0.3) return leaf();
      if (r < 0.65) return Array.from({ length: Math.floor(random() * 4) }, () => tree(depth - 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, i) => [`k${i}`, tree(depth - 1)]));
    };
    const mutate = (value: unknown, depth: number): unknown => {
      const r = random();
      if (r < 0.15) return tree(depth);
      if (Array.isArray(value)) {
        const next = value.map((entry) => (random() < 0.3 ? mutate(entry, depth - 1) : entry));
        if (random() < 0.3) next.push(tree(depth - 1));
        return next;
      }
      if (value !== null && typeof value === 'object') {
        let entries = Object.entries(value).filter(() => random() >= 0.15)
          .map(([key, entry]) => [key, random() < 0.4 ? mutate(entry, depth - 1) : entry] as [string, unknown]);
        if (random() < 0.2) entries = entries.reverse();
        if (random() < 0.3) entries.push([`n${Math.floor(random() * 9)}`, tree(depth - 1)]);
        return Object.fromEntries(entries);
      }
      return r < 0.5 ? leaf() : value;
    };
    const kinds = new Set<string>();
    let changedPairs = 0;
    let nestedOps = 0;
    for (let n = 0; n < 500; n++) {
      const target = tree(4);
      const current = mutate(cloneDeep(target), 4);
      const patch = roundTrip(current, target);
      if (patch.length > 0) changedPairs++;
      for (const op of patch) {
        kinds.add(op.op);
        if (op.path.length >= 2) nestedOps++;
      }
    }
    // The generator really exercises the algorithm: every kind of operation, nested paths, most pairs differing.
    expect([...kinds].sort()).toEqual(['del', 'order', 'set', 'trunc']);
    expect(nestedOps).toBeGreaterThan(20);
    expect(changedPairs).toBeGreaterThan(200);
  });
});
