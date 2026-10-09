import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { PathShapeError, readPath, removePath, writePath } from './path-copy';

describe('path copy', () => {
  const tree = () => ({ 元数据: { 叙事历史: [1, 2], 回合序号: 3 }, 系统: { 扩展: { a: 1 } }, 社交: {} });

  it('reads a dot path, undefined when a step is missing or not a plain object', () => {
    const t = tree();
    expect(readPath(t, '元数据.回合序号')).toBe(3);
    expect(readPath(t, '元数据.叙事历史')).toBe(t.元数据.叙事历史);
    expect(readPath(t, '元数据.缺失.x')).toBeUndefined();
    expect(readPath(t, '元数据.叙事历史.0')).toBeUndefined();
    expect(readPath({ a: { toString: 1 } }, 'a.constructor')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });

  it('writes a copy, copying only the objects on the way and creating missing ones', () => {
    const t = tree();
    const before = cloneDeep(t);
    const next = writePath(t, '系统.扩展.saveFormat', { version: 2 });
    expect(t).toStrictEqual(before);
    expect(next.系统).not.toBe(t.系统);
    expect((next.系统 as { 扩展: unknown }).扩展).not.toBe(t.系统.扩展);
    expect(next.元数据).toBe(t.元数据);
    expect(next.社交).toBe(t.社交);
    expect(readPath(next, '系统.扩展.saveFormat')).toEqual({ version: 2 });
    expect(readPath(next, '系统.扩展.a')).toBe(1);
    expect(readPath(writePath({}, 'x.y.z', 1), 'x.y.z')).toBe(1);
    expect(readPath(writePath({ x: undefined }, 'x.y', 1), 'x.y')).toBe(1);
    expect(readPath(writePath({ x: 'old leaf' }, 'x', 1), 'x')).toBe(1);
  });

  it('refuses to write through a field that holds something other than a plain object, and changes nothing', () => {
    const t = { x: 'not an object', 系统: { 扩展: [1] }, a: null, d: new Date(0) };
    const before = cloneDeep(t);
    expect(() => writePath(t, 'x.y', 1)).toThrow(PathShapeError);
    expect(() => writePath(t, '系统.扩展.saveFormat', 1)).toThrow(expect.objectContaining({ path: '系统.扩展.saveFormat', key: '扩展' }));
    expect(() => writePath(t, 'a.b', 1)).toThrow(PathShapeError);
    expect(() => writePath(t, 'd.b', 1)).toThrow(PathShapeError);
    expect(t).toStrictEqual(before);
  });

  it('removes a field into a copy, or returns the tree itself when the field is not there', () => {
    const t = { 元数据: { 上次对话前快照: { big: true }, 回合序号: 3 }, other: {} };
    const next = removePath(t, '元数据.上次对话前快照');
    expect(next).toEqual({ 元数据: { 回合序号: 3 }, other: {} });
    expect(t.元数据.上次对话前快照).toEqual({ big: true });
    expect(next.other).toBe(t.other);
    expect(removePath(t, '元数据.不存在')).toBe(t);
    expect(removePath(t, '不存在.x')).toBe(t);
    expect(removePath({ a: 'text' }, 'a.b')).toEqual({ a: 'text' });
  });

  it('keeps a key named like an object prototype as plain data', () => {
    const next = writePath({}, '__proto__.polluted', true);
    expect(Object.keys(next)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // A name the object only inherits is a missing field: created as data, not stepped through.
    expect(readPath(writePath({}, 'constructor.x', 1), 'constructor.x')).toBe(1);
    expect(readPath(writePath({}, 'toString.x', 1), 'toString.x')).toBe(1);
  });
});
