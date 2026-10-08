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
 *
 * 对应 STEP-03B M3.6 Engram 数据流（VectorStore 持久化）。
 */
import { idbAdapter } from '../../persistence/idb-adapter';

// ─── 类型定义 ───

/** 向量存储的持久化数据结构 */
export interface VectorStoreData {
  /** 事件向量（eventId → 向量数组） */
  eventVectors: Record<string, number[]>;
  /** 实体向量（entityName → 向量数组） */
  entityVectors: Record<string, number[]>;
  /** V2: 边向量（edgeId → fact embedding） */
  edgeVectors: Record<string, number[]>;
  /** 使用的 embedding 模型名（如果模型变更，需要重新向量化） */
  model: string;
  /** 向量维度（用于校验新向量与已有数据的兼容性） */
  dim: number;
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
    return (
      (await idbAdapter.get<VectorStoreData>(key)) ?? this.createEmpty()
    );
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
    vectors: number[][],
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
    vectors: number[][],
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
  cosineSimilarity(a: number[], b: number[]): number {
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
    vectors: number[][],
    model: string,
    storage: StorageIdentifier,
  ): Promise<void> {
    await this.mergeVectors('edgeVectors', edges, (e) => e.id, vectors, model, storage);
  }

  /**
   * Shared body of the three merge*Vectors methods. `items[i]` pairs with `vectors[i]`;
   * a falsy item or missing vector is skipped.
   * A different embedding model wipes all three tables first (vector spaces differ).
   */
  private async mergeVectors<T extends object>(
    kind: 'eventVectors' | 'entityVectors' | 'edgeVectors',
    items: T[],
    keyOf: (item: T) => string,
    vectors: number[][],
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
        data[kind][keyOf(item)] = vector;
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
