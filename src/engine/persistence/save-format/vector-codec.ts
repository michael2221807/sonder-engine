/**
 * 向量编码 — 本地存 Float32Array，备份包里存小端 float32 的 base64（存档瘦身 D4A，2026-10-09）
 *
 * Every embedding is float32 (906k values on the PO save, all exactly representable), but vectors were stored as lists
 * of JSON decimal numbers. Now IndexedDB holds a Float32Array (structured clone keeps it, 4 bytes a value) and a backup
 * bundle holds the base64 of the little-endian float32 bytes, written through DataView so the byte order never depends
 * on the machine.
 *
 * Reading accepts every form a vector has been stored in:
 * - a list of numbers (older saves and backups);
 * - a base64 string (backups from this version on);
 * - a Float32Array (IndexedDB from this version on);
 * - an object with index keys `{"0": …, "1": …}` — what a Float32Array becomes when a tab still running older code
 *   writes it to JSON.
 *
 * A Float32Array that is a view into a larger buffer comes back as a copy of its own: structured clone would store the
 * whole buffer with it.
 */

/** A vector as the local vector store holds it: Float32Array from this version on, a number list from older saves. */
export type StoredVector = Float32Array | number[];

/** A stored vector map read back: the vectors, and the entries that are not vectors (kept apart, not dropped). */
export interface DecodedVectorMap {
  vectors: Record<string, Float32Array>;
  invalid: Record<string, unknown>;
}

const BYTES_PER_VALUE = 4;
const BINARY_CHUNK = 0x8000;

/** The vector as float32 values with a buffer of its own (a standalone Float32Array is returned as it is). */
export function toFloat32(vector: ArrayLike<number>): Float32Array {
  if (vector instanceof Float32Array) return ownsBuffer(vector) ? vector : vector.slice();
  return Float32Array.from(vector);
}

/** The base64 of the vector's little-endian float32 bytes. */
export function encodeVectorBase64(vector: ArrayLike<number>): string {
  const bytes = new Uint8Array(vector.length * BYTES_PER_VALUE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * BYTES_PER_VALUE, vector[i], true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  }
  return btoa(binary);
}

/** A stored vector in any of its forms (see the module comment) as float32 values; undefined when it is not one. */
export function decodeVector(value: unknown): Float32Array | undefined {
  if (value instanceof Float32Array) return toFloat32(value);
  if (Array.isArray(value)) return value.every((x) => typeof x === 'number') ? Float32Array.from(value) : undefined;
  if (typeof value === 'string') return decodeBase64(value);
  if (value !== null && typeof value === 'object') return decodeIndexObject(value as Record<string, unknown>);
  return undefined;
}

/** Each entry of a stored vector map, decoded; entries that are not vectors are returned apart, as they were. */
export function decodeVectorMap(map: unknown): DecodedVectorMap {
  const vectors: Array<[string, Float32Array]> = [];
  const invalid: Array<[string, unknown]> = [];
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    for (const [id, value] of Object.entries(map)) {
      const vector = decodeVector(value);
      if (vector) vectors.push([id, vector]);
      else invalid.push([id, value]);
    }
  }
  return { vectors: Object.fromEntries(vectors), invalid: Object.fromEntries(invalid) };
}

/** Each vector of a map as base64 (for a backup bundle). */
export function encodeVectorMap(map: Readonly<Record<string, ArrayLike<number>>>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([id, vector]) => [id, encodeVectorBase64(vector)]));
}

function ownsBuffer(vector: Float32Array): boolean {
  return vector.byteOffset === 0 && vector.byteLength === vector.buffer.byteLength;
}

function decodeBase64(text: string): Float32Array | undefined {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  if (binary.length % BYTES_PER_VALUE !== 0) return undefined;
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(binary.length / BYTES_PER_VALUE);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * BYTES_PER_VALUE, true);
  return out;
}

function decodeIndexObject(value: Record<string, unknown>): Float32Array | undefined {
  const keys = Object.keys(value);
  const out = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const x = value[String(i)];
    if (typeof x !== 'number' || !Object.prototype.hasOwnProperty.call(value, String(i))) return undefined;
    out[i] = x;
  }
  return out;
}
