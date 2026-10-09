import { describe, it, expect } from 'vitest';
import { countKeys, hasNoNegativeValue, keysByTable, mainVectorDim, pseudoVectorKeys } from './vector-dim-repair';
import { pseudoEmbed } from './embedder';
import type { VectorStoreData } from './vector-store';
import type { StoredVector } from '../../persistence/save-format/vector-codec';

type Tables = Partial<Pick<VectorStoreData, 'eventVectors' | 'entityVectors' | 'edgeVectors'>>;

function slot(tables: Tables): VectorStoreData {
  return { eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: 'm', dim: 0, ...tables };
}

/** A real embedding: values of both signs. */
function real(dim: number, seed = 1): Float32Array {
  return Float32Array.from({ length: dim }, (_, i) => Math.fround(Math.sin(seed * 7 + i * 1.3)));
}

/** n entries named `<prefix><i>` holding the vector `make(i)`. */
function many(prefix: string, n: number, make: (i: number) => StoredVector): Record<string, StoredVector> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, make(i)]));
}

describe('pseudo vectors (存档瘦身 D4A)', () => {
  it('takes the dimension most of the slot\'s vectors have, over the three tables', () => {
    const data = slot({
      eventVectors: { ...many('e', 3, (i) => real(8, i)), p1: pseudoEmbed('a b c') },
      entityVectors: { p2: pseudoEmbed('d e') },
      edgeVectors: many('g', 2, (i) => real(8, i + 10)),
    });
    expect(mainVectorDim(data)).toBe(8);
  });

  it('on a tie takes the larger dimension; 0 for a slot without vectors', () => {
    expect(mainVectorDim(slot({ eventVectors: { a: real(4), b: real(6) } }))).toBe(6);
    expect(mainVectorDim(slot({ eventVectors: { a: real(6) }, entityVectors: { b: real(4) } }))).toBe(6);
    expect(mainVectorDim(slot({}))).toBe(0);
  });

  it('finds the pseudo vectors of each table, as on the PO save (2 events and 1 entity of 384 among 1024s)', () => {
    const data = slot({
      eventVectors: { ...many('e', 5, (i) => real(1024, i)), pe1: pseudoEmbed('round 61 , 2 items'), pe2: pseudoEmbed('x') },
      entityVectors: { ...many('n', 3, (i) => real(1024, i + 20)), pn1: pseudoEmbed('Alice') },
      edgeVectors: many('g', 6, (i) => real(1024, i + 40)),
    });
    expect(pseudoEmbed('x')).toHaveLength(384);
    expect(pseudoVectorKeys(data, mainVectorDim(data))).toEqual({ eventVectors: ['pe1', 'pe2'], entityVectors: ['pn1'], edgeVectors: [] });
  });

  it('never takes a real vector for one, not even when pseudo vectors are most of the slot', () => {
    const data = slot({
      eventVectors: { ...many('p', 5, (i) => pseudoEmbed(`word${i} other${i}`)), r1: real(1024, 1) },
      entityVectors: { r2: real(1024, 2) },
    });
    expect(mainVectorDim(data)).toBe(384);
    expect(pseudoVectorKeys(data, 384)).toEqual({ eventVectors: [], entityVectors: [], edgeVectors: [] });
  });

  it('takes a vector without tokens (all zeros) for one, and reads number lists as well', () => {
    const zeros = pseudoEmbed('林婉儿在青云城'); // CJK only: no token, the zero vector
    expect(Array.from(zeros).every((x) => x === 0)).toBe(true);
    const data = slot({ eventVectors: { a: Array.from(real(8)), b: Array.from(real(8, 2)), z: zeros } });
    expect(pseudoVectorKeys(data, 8).eventVectors).toEqual(['z']);
  });

  it('a vector is pseudo-shaped only without any negative value', () => {
    expect(hasNoNegativeValue(Float32Array.of(0, 0.6, 0.8))).toBe(true);
    expect(hasNoNegativeValue([0, -0, 1])).toBe(true);
    expect(hasNoNegativeValue([0.5, -0.0001, 0.5])).toBe(false);
    expect(hasNoNegativeValue([])).toBe(true);
  });

  it('counts keys and builds them table by table', () => {
    const keys = keysByTable((table) => (table === 'entityVectors' ? ['a', 'b'] : table === 'edgeVectors' ? ['c'] : []));
    expect(keys).toEqual({ eventVectors: [], entityVectors: ['a', 'b'], edgeVectors: ['c'] });
    expect(countKeys(keys)).toBe(3);
    expect(countKeys({ eventVectors: ['x'] })).toBe(1);
    expect(countKeys({})).toBe(0);
  });
});
