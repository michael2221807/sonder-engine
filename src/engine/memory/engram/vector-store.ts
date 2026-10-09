/**
 * 向量存储 — IndexedDB 持久化的向量数据库
 *
 * Engram 系统的持久化层：将事件和实体的向量表示存储在 IndexedDB 中，
 * 支持语义相似度检索（通过 cosine similarity）。
 *
 * 设计决策：
 * - 使用 idbAdapter 而非独立的 IndexedDB 数据库，保持全引擎一致的存储入口
 * - key 格式: engram_vectors_{profileId}_{slotId}，与存档系统绑定
 * - 向量数据与状态树分离存储（因为向量数据量大且不需要响应式），
 *   状态树中只存事件/实体/关系的元数据
 * - cosine similarity 是纯数学计算，不依赖外部库
 * - 存档瘦身 D4A (2026-10-09): vectors are kept as Float32Arrays (4 bytes a value; an embedding API gives float32
 *   values anyway). Reading turns the number lists of older records and the objects of indices an older tab writes
 *   into Float32Arrays, in memory only (the record takes the new form with its next write); the embedder's number
 *   lists are converted before they are written. A backup bundle holds the base64 of the little-endian float32 bytes
 *   (vectorDataForBundle / vectorDataFromBundle).
 *
 * 对应 STEP-03B M3.6 Engram 数据流（VectorStore 持久化）。
 */
import { idbAdapter } from '../../persistence/idb-adapter';
import {
  decodeVectorMap,
  encodeVectorMap,
  toFloat32,
  type StoredVector,
} from '../../persistence/save-format/vector-codec';

// ─── 类型定义 ───

/** The three vector tables of a slot. */
export type VectorTable = 'eventVectors' | 'entityVectors' | 'edgeVectors';
export const VECTOR_TABLES: readonly VectorTable[] = ['eventVectors', 'entityVectors', 'edgeVectors'];

/** 向量存储的持久化数据结构 */
export interface VectorStoreData {
  /** 事件向量 (eventId → vector: a Float32Array once loaded, a number list in an older record) */
  eventVectors: Record<string, StoredVector>;
  /** 实体向量 (entityName → vector) */
  entityVectors: Record<string, StoredVector>;
  /** V2: 边向量（edgeId → fact embedding） */
  edgeVectors: Record<string, StoredVector>;
  /** 使用的 embedding 模型名（如果模型变更，需要重新向量化） */
  model: string;
  /** 向量维度（用于校验新向量与已有数据的兼容性） */
  dim: number;
}

/** A slot's vectors as a backup bundle carries them: each vector as the base64 of its little-endian float32 bytes. */
export interface BundleVectorData {
  eventVectors: Record<string, string>;
  entityVectors: Record<string, string>;
  edgeVectors: Record<string, string>;
  model: string;
  dim: number;
}

/**
 * A slot's vectors for a backup bundle (JSON cannot hold a Float32Array: it would become an object of indices). A record
 * from before edge vectors existed has none.
 */
export function vectorDataForBundle(data: Omit<VectorStoreData, 'edgeVectors'> & Partial<Pick<VectorStoreData, 'edgeVectors'>>): BundleVectorData {
  return {
    eventVectors: encodeVectorMap(data.eventVectors),
    entityVectors: encodeVectorMap(data.entityVectors),
    edgeVectors: encodeVectorMap(data.edgeVectors ?? {}),
    model: data.model,
    dim: data.dim,
  };
}

/**
 * A slot's vectors from a backup bundle or a stored record, in any form a vector has been kept in (a number list, the
 * base64 of a bundle, a Float32Array, an object of indices), as Float32Arrays. An entry that is no vector is left out
 * (and logged): it never served a search.
 */
export function vectorDataFromBundle(raw: unknown): VectorStoreData {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const data: VectorStoreData = {
    eventVectors: {},
    entityVectors: {},
    edgeVectors: {},
    model: typeof record.model === 'string' ? record.model : '',
    dim: typeof record.dim === 'number' && Number.isFinite(record.dim) ? record.dim : 0,
  };
  for (const table of VECTOR_TABLES) {
    const { vectors, invalid } = decodeVectorMap(record[table]);
    data[table] = vectors;
    const dropped = Object.keys(invalid).length;
    if (dropped > 0) console.warn(`[VectorStore] ${table}: ${dropped === 1 ? '1 entry is not a vector' : `${dropped} entries are not vectors`}; left out`);
  }
  return data;
}

/** 用于 idbAdapter key 生成的存档标识 */
interface StorageIdentifier {
  profileId: string;
  slotId: string;
}

export class VectorStore {
  /**
   * 从 IndexedDB 加载向量数据
   *
   * 如果不存在（新存档或首次使用 Engram），返回空的初始结构。
   * 这样调用方不需要处理 undefined —— 总是拿到一个有效的数据对象。
   */
  async load(profileId: string, slotId: string): Promise<VectorStoreData> {
    const key = this.buildKey({ profileId, slotId });
    const stored = await idbAdapter.get<unknown>(key);
    // 存档瘦身 D4A: every form a vector was stored in becomes a Float32Array here, in memory only (the export reads
    // through this too, and must not write); the record takes the new form with its next write.
    return stored === undefined ? this.createEmpty() : vectorDataFromBundle(stored);
  }

  /**
   * The slot's record exactly as it is stored, unconverted (load converts every vector to a Float32Array); undefined
   * when there is none. For a rollback snapshot that must put back what was there, byte for byte.
   */
  async loadStored(profileId: string, slotId: string): Promise<unknown> {
    return idbAdapter.get<unknown>(this.buildKey({ profileId, slotId }));
  }

  /** Put back a record loadStored gave, as it was. */
  async restoreStored(profileId: string, slotId: string, stored: unknown): Promise<void> {
    await idbAdapter.set(this.buildKey({ profileId, slotId }), stored);
  }

  /** 将向量数据写入 IndexedDB */
  async save(profileId: string, slotId: string, data: VectorStoreData): Promise<void> {
    const key = this.buildKey({ profileId, slotId });
    await idbAdapter.set(key, data);
  }

  /** 删除某槽位的向量数据（与 SaveManager.deleteGame 配对，避免残留 Engram） */
  async deleteForSlot(profileId: string, slotId: string): Promise<void> {
    const key = this.buildKey({ profileId, slotId });
    await idbAdapter.delete(key);
  }

  /**
   * 合并新的事件向量到已有存储
   *
   * 每次 Engram 处理新事件后调用，将新产生的向量追加到存储中。
   * events 和 vectors 按索引一一对应。
   *
   * 如果 embedding 模型发生变更（model 不匹配），会清空旧向量重新开始，
   * 因为不同模型的向量空间不可比较。
   *
   * @param events 新事件节点（需要有 id 字段）
   * @param vectors 对应的向量数组
   * @param model 使用的 embedding 模型名
   * @param storage 存档标识（profileId + slotId）
   */
  async mergeEventVectors(
    events: Array<{ id: string }>,
    vectors: ReadonlyArray<ArrayLike<number>>,
    model: string,
    storage: StorageIdentifier,
  ): Promise<void> {
    await this.mergeVectors('eventVectors', events, (e) => e.id, vectors, model, storage);
  }

  /**
   * 合并实体向量
   *
   * 与 mergeEventVectors 类似，但以 entity name 为键。
   */
  async mergeEntityVectors(
    entities: Array<{ name: string }>,
    vectors: ReadonlyArray<ArrayLike<number>>,
    model: string,
    storage: StorageIdentifier,
  ): Promise<void> {
    await this.mergeVectors('entityVectors', entities, (e) => e.name, vectors, model, storage);
  }

  /**
   * 余弦相似度计算
   *
   * 两个向量的夹角余弦值，范围 [-1, 1]：
   * - 1.0 = 完全相同方向
   * - 0.0 = 正交（不相关）
   * - -1.0 = 完全相反方向
   *
   * 除零保护：当任一向量的范数为 0 时返回 0（而非 NaN），
   * 因为零向量表示"无语义信息"，与任何向量的相似度应为 0。
   */
  cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dot / denominator;
  }

  /**
   * 删除孤立向量（trim 后同步）
   *
   * EngramManager 在每次修剪事件/实体后调用此方法，
   * 确保 IndexedDB 中不残留已被裁剪的向量数据。
   *
   * @param eventIds 当前保留的事件 ID 集合
   * @param entityNames 当前保留的实体名集合
   * @param profileId 存档 profile ID
   * @param slotId 存档 slot ID
   */
  async trimToMatchEvents(
    eventIds: Set<string>,
    entityNames: Set<string>,
    profileId: string,
    slotId: string,
  ): Promise<void> {
    const data = await this.load(profileId, slotId);
    let changed = false;

    for (const id of Object.keys(data.eventVectors)) {
      if (!eventIds.has(id)) {
        delete data.eventVectors[id];
        changed = true;
      }
    }

    for (const name of Object.keys(data.entityVectors)) {
      if (!entityNames.has(name)) {
        delete data.entityVectors[name];
        changed = true;
      }
    }

    // Note: edgeVectors are NOT trimmed here — they use separate trimEdgeVectors()
    // with a dedicated keptEdgeIds set (edge IDs don't overlap with event/entity IDs).

    if (changed) {
      await this.save(profileId, slotId, data);
    }
  }

  async trimEdgeVectors(
    keptEdgeIds: Set<string>,
    profileId: string,
    slotId: string,
  ): Promise<void> {
    const data = await this.load(profileId, slotId);
    let changed = false;
    for (const id of Object.keys(data.edgeVectors ?? {})) {
      if (!keptEdgeIds.has(id)) {
        delete data.edgeVectors[id];
        changed = true;
      }
    }
    if (changed) await this.save(profileId, slotId, data);
  }

  async deleteEdgeVectorsByIds(
    ids: string[],
    profileId: string,
    slotId: string,
  ): Promise<void> {
    await this.deleteKeys('edgeVectors', ids, profileId, slotId);
  }

  async deleteEntityVectorsByNames(
    names: string[],
    profileId: string,
    slotId: string,
  ): Promise<void> {
    await this.deleteKeys('entityVectors', names, profileId, slotId);
  }

  async mergeEdgeVectors(
    edges: Array<{ id: string }>,
    vectors: ReadonlyArray<ArrayLike<number>>,
    model: string,
    storage: StorageIdentifier,
  ): Promise<void> {
    await this.mergeVectors('edgeVectors', edges, (e) => e.id, vectors, model, storage);
  }

  /**
   * Remove the given vectors of a slot in one write (存档瘦身 D4A: a save's pseudo vectors,
   * EngramManager.repairVectorDims). Keys a table does not hold are skipped; nothing is written when none is held.
   */
  async removeVectors(
    keys: Partial<Record<VectorTable, readonly string[]>>,
    profileId: string,
    slotId: string,
  ): Promise<number> {
    const data = await this.load(profileId, slotId);
    let removed = 0;
    for (const table of VECTOR_TABLES) {
      for (const key of keys[table] ?? []) {
        if (Object.prototype.hasOwnProperty.call(data[table], key)) {
          delete data[table][key];
          removed++;
        }
      }
    }
    if (removed > 0) await this.save(profileId, slotId, data);
    return removed;
  }

  /**
   * Shared body of the three merge*Vectors methods. `items[i]` pairs with `vectors[i]`;
   * a falsy item or missing vector is skipped. Each vector is stored as a Float32Array (存档瘦身 D4A).
   * A different embedding model wipes all three tables first (vector spaces differ).
   */
  private async mergeVectors<T extends object>(
    kind: VectorTable,
    items: T[],
    keyOf: (item: T) => string,
    vectors: ReadonlyArray<ArrayLike<number>>,
    model: string,
    storage: StorageIdentifier,
  ): Promise<void> {
    const data = await this.load(storage.profileId, storage.slotId);

    if (data.model && data.model !== model) {
      data.eventVectors = {};
      data.entityVectors = {};
      data.edgeVectors = {};
    }

    data.model = model;
    data.dim = vectors[0]?.length ?? 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vector = vectors[i];
      if (item && vector) {
        data[kind][keyOf(item)] = toFloat32(vector);
      }
    }

    await this.save(storage.profileId, storage.slotId, data);
  }

  /** Shared body of the two delete-by-key methods (truthy-vector check preserved). */
  private async deleteKeys(
    kind: 'entityVectors' | 'edgeVectors',
    keys: string[],
    profileId: string,
    slotId: string,
  ): Promise<void> {
    if (keys.length === 0) return;
    const data = await this.load(profileId, slotId);
    let changed = false;
    for (const key of keys) {
      if (data[kind][key]) {
        delete data[kind][key];
        changed = true;
      }
    }
    if (changed) await this.save(profileId, slotId, data);
  }

  /** 生成 IndexedDB 存储键 */
  private buildKey(storage: StorageIdentifier): string {
    return `engram_vectors_${storage.profileId}_${storage.slotId}`;
  }

  /** 创建空的初始数据结构 */
  private createEmpty(): VectorStoreData {
    return { eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: '', dim: 0 };
  }
}
