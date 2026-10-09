/**
 * 伪向量 — 嵌入接口失败时的兜底向量（存档瘦身 D4A，2026-10-09）
 *
 * When an embedding call fails, the embedder falls back to pseudoEmbed: word counts hashed into 384 slots and scaled
 * to length 1, so no value is negative. Next to the vectors of a real model of another dimension such a vector is
 * never comparable (the cosine of vectors of different lengths is 0): its entry is never found by meaning, yet it is
 * marked embedded, so it is never embedded again. The PO save held 3 of them among 887.
 *
 * Taken for one here: a vector whose dimension is not the slot's own (the one most of its vectors have) and that has
 * no negative value. A real embedding has values of both signs, so a real vector is never taken for one, not even
 * when pseudo vectors outnumber the real ones and the slot's own dimension is theirs.
 *
 * EngramManager.repairVectorDims cleans them once per save, in two steps across opens of the save (see there); these
 * are the pure parts.
 */
import { VECTOR_TABLES, type VectorStoreData, type VectorTable } from './vector-store';
import { normalizeEngramBlock, type EngramStateData } from './engram-types';
import { readPath } from '../../persistence/save-format/path-copy';
import { isPlainRecord } from '../../persistence/save-format/plain-data';

/** Keys of each vector table. */
export type VectorKeysByTable = Record<VectorTable, string[]>;

/** The dimension most of the slot's vectors have (on a tie, the larger one); 0 when the slot holds none. */
export function mainVectorDim(data: VectorStoreData): number {
  const counts = new Map<number, number>();
  for (const table of VECTOR_TABLES) {
    for (const vector of Object.values(data[table])) {
      counts.set(vector.length, (counts.get(vector.length) ?? 0) + 1);
    }
  }
  let main = 0;
  let mainCount = 0;
  for (const [dim, count] of counts) {
    if (count > mainCount || (count === mainCount && dim > main)) {
      main = dim;
      mainCount = count;
    }
  }
  return main;
}

/** Whether no value of the vector is negative, as in every pseudo vector (a real embedding has both signs). */
export function hasNoNegativeValue(vector: ArrayLike<number>): boolean {
  for (let i = 0; i < vector.length; i++) {
    if (vector[i] < 0) return false;
  }
  return true;
}

/** The keys of each table whose vector is a pseudo vector next to the slot's own dimension `dim` (module comment). */
export function pseudoVectorKeys(data: VectorStoreData, dim: number): VectorKeysByTable {
  return keysByTable((table) => Object.entries(data[table])
    .filter(([, vector]) => vector.length !== dim && hasNoNegativeValue(vector))
    .map(([key]) => key));
}

/** How many keys in all. */
export function countKeys(keys: Partial<VectorKeysByTable>): number {
  return VECTOR_TABLES.reduce((n, table) => n + (keys[table]?.length ?? 0), 0);
}

/** Keys per table, made table by table. */
export function keysByTable(pick: (table: VectorTable) => string[]): VectorKeysByTable {
  return { eventVectors: pick('eventVectors'), entityVectors: pick('entityVectors'), edgeVectors: pick('edgeVectors') };
}

/** Sets of keys per vector table. */
export type KeySetsByTable = Record<VectorTable, Set<string>>;

/** The keys of the entries an engram block marks embedded, per vector table (events and edges by id, entities by name). */
export function embeddedKeys(engram: EngramStateData | null): KeySetsByTable {
  return {
    eventVectors: new Set((engram?.events ?? []).filter((e) => e.is_embedded).map((e) => e.id)),
    entityVectors: new Set((engram?.entities ?? []).filter((e) => e.is_embedded).map((e) => e.name)),
    edgeVectors: new Set((engram?.v2Edges ?? []).filter((e) => e.is_embedded).map((e) => e.id)),
  };
}

/** The engram block of a plain tree (a rollback snapshot) at a dot path, or null when it holds none. */
export function engramOf(tree: unknown, engramPath: string): EngramStateData | null {
  return normalizeEngramBlock(readPath(tree, engramPath));
}

/** The union of key sets, table by table. */
export function unionKeys(sets: readonly KeySetsByTable[]): KeySetsByTable {
  const union: KeySetsByTable = { eventVectors: new Set(), entityVectors: new Set(), edgeVectors: new Set() };
  for (const set of sets) for (const table of VECTOR_TABLES) for (const key of set[table]) union[table].add(key);
  return union;
}

/** Whether a save format marker records that the save's pseudo vectors were repaired. */
export function markerSaysRepaired(marker: unknown): boolean {
  return isPlainRecord(marker) && marker.vectorDimRepaired === true;
}
