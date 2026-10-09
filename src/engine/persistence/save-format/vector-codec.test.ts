import { describe, it, expect } from 'vitest';
import { decodeVector, decodeVectorMap, encodeVectorBase64, encodeVectorMap, toFloat32 } from './vector-codec';

function seeded(length: number, seed: number): Float32Array {
  let s = seed;
  return Float32Array.from({ length }, () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  });
}

describe('vector codec (D4A)', () => {
  it('writes little-endian float32 bytes, whatever the machine', () => {
    // 1.0f = 0x3F800000 → little-endian bytes 00 00 80 3F; -2.5f = 0xC0200000 → 00 00 20 C0
    expect(encodeVectorBase64([1, -2.5])).toBe(btoa(String.fromCharCode(0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0xc0)));
    expect(encodeVectorBase64([])).toBe('');
  });

  it('reads back exactly the float32 values it wrote, also past one encoding chunk', () => {
    for (const length of [1024, 8191, 8192, 8193, 20001]) {
      const vector = seeded(length, length);
      expect(decodeVector(encodeVectorBase64(vector))).toStrictEqual(vector);
      expect(decodeVector(encodeVectorBase64(Array.from(vector)))).toStrictEqual(vector);
    }
  });

  it('rounds decimal numbers to float32, and keeps numbers that are float32 already exactly', () => {
    const exact = [0.1, -0.25, 3].map(Math.fround);
    expect(Array.from(decodeVector(exact) ?? [])).toEqual(exact);
    expect(Array.from(decodeVector([0.1]) ?? [])).toEqual([Math.fround(0.1)]);
  });

  it('reads every form a vector has been stored in', () => {
    const f32 = Float32Array.from([0.5, -1, 2]);
    expect(decodeVector(f32)).toBe(f32);
    expect(decodeVector([0.5, -1, 2])).toStrictEqual(f32);
    expect(decodeVector(encodeVectorBase64(f32))).toStrictEqual(f32);
    expect(decodeVector(JSON.parse(JSON.stringify(f32)))).toStrictEqual(f32);
    expect(decodeVector([])).toStrictEqual(new Float32Array(0));
  });

  it('turns down what is not a vector', () => {
    for (const bad of [null, undefined, 1, true, ['1', 2], [1, null], 'not base64 %%', btoa('abc'), { 0: 1, 2: 3 }, { 0: 1, x: 2 }, { 0: 'a' }]) {
      expect(decodeVector(bad)).toBeUndefined();
    }
    // Only the object's own index keys count, never ones it inherits.
    expect(decodeVector(Object.assign(Object.create({ 1: 2 }) as object, { 0: 1, x: 1 }))).toBeUndefined();
  });

  it('gives a view into a larger buffer back as a copy of its own (structured clone would store the whole buffer)', () => {
    const big = Float32Array.from([1, 2, 3, 4]);
    for (const [view, values] of [[big.subarray(1, 3), [2, 3]], [big.subarray(0, 2), [1, 2]]] as const) {
      for (const out of [toFloat32(view), decodeVector(view)]) {
        expect(out).toStrictEqual(Float32Array.from(values));
        expect(out?.buffer.byteLength).toBe(8);
        expect(out).not.toBe(view);
      }
    }
    const own = Float32Array.from([1]);
    expect(toFloat32(own)).toBe(own);
    expect(toFloat32([1, 2])).toStrictEqual(Float32Array.from([1, 2]));
  });

  it('decodes a stored map, keeping entries that are not vectors apart as they were', () => {
    const map = { 事件1: [1, 2], 事件2: encodeVectorBase64([3, 4]), 坏的: 'x', 也坏: [1, 'a'] };
    expect(decodeVectorMap(map)).toStrictEqual({
      vectors: { 事件1: Float32Array.from([1, 2]), 事件2: Float32Array.from([3, 4]) },
      invalid: { 坏的: 'x', 也坏: [1, 'a'] },
    });
    expect(decodeVectorMap(null)).toStrictEqual({ vectors: {}, invalid: {} });
    expect(decodeVectorMap([[1]])).toStrictEqual({ vectors: {}, invalid: {} });
  });

  it('keeps an id named like an object key as a plain entry, both ways', () => {
    const map = JSON.parse('{"__proto__":[1,2],"constructor":[3]}') as Record<string, number[]>;
    const encoded = encodeVectorMap(map);
    expect(Object.keys(encoded)).toEqual(['__proto__', 'constructor']);
    const { vectors } = decodeVectorMap(encoded);
    expect(Object.keys(vectors)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(vectors)).toBe(Object.prototype);
    expect(Array.from(vectors['__proto__'])).toEqual([1, 2]);
  });

  it('encodes a map, an empty vector included', () => {
    const encoded = encodeVectorMap({ a: [1, 2], b: Float32Array.from([3]), 空: [] });
    expect(encoded['空']).toBe('');
    expect(decodeVectorMap(encoded)).toStrictEqual({
      vectors: { a: Float32Array.from([1, 2]), b: Float32Array.from([3]), 空: new Float32Array(0) },
      invalid: {},
    });
  });
});
