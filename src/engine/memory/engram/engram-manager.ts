// Architecture: docs/architecture/engram-v2-graphiti-alignment.md
// App doc: docs/user-guide/pages/game-relationship-graph.md
/**
 * Engram 管理器 — V2 Graphiti 对齐架构（2026-04-27 重构）
 *
 * 将 AI 生成的叙事转化为：
 * - 事件节点（每回合 1 个，含 mentionedEntities + burned summary）
 * - 实体节点（玩家 + 非普通 NPC + 事件 role/location，含 summary + is_embedded）
 * - 事实边 EngramEdge（完整句子 fact + factEmbedding，对齐 Graphiti EntityEdge）
 * - 向量表示（events/entities/edges 嵌入，存 IDB）
 *
 * 编排流程（每回合 PostProcessStage 触发）：
 * 1. 检查是否启用
 * 2. EventBuilder → 1 新事件
 * 3. EntityBuilder → 实体列表
 * 4. FactBuilder → EdgeResolver 5 步去重/矛盾检测 → v2Edges
 * 5. 修剪（重点 NPC 过滤 + trim strategy）
 * 6. 写入状态树 + 异步向量化
 */
import type { StateManager } from '../../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';
import type { AIService } from '../../ai/ai-service';
import type { AIResponse } from '../../ai/types';
import { EventBuilder } from './event-builder';
import type { EngramEventNode } from './event-builder';
import { EntityBuilder } from './entity-builder';
import type { EngramEntity } from './entity-builder';
import { inferEntityType, isSentenceLikeName, makeFactStubEntity } from './entity-builder';
import { VectorStore } from './vector-store';
import type { StoredVector } from '../../persistence/save-format/vector-codec';
import { countKeys, keysByTable, mainVectorDim, pseudoVectorKeys, type VectorKeysByTable } from './vector-dim-repair';
import { SAVE_FORMAT_VERSION } from '../../persistence/save-format/save-format-migration';
import { isPlainRecord } from '../../persistence/save-format/plain-data';
import { canWritePath } from '../../persistence/save-format/path-copy';
import { eventBus } from '../../core/event-bus';
import { Embedder } from './embedder';
import { loadEngramConfig } from './engram-config';
import type { EngramEdge } from './knowledge-edge';
import { buildFacts, pruneEdgesV2 } from './fact-builder';
import type { KnowledgeFact } from './fact-builder';
import { buildCanonFacts, invalidateEdgesForEntries } from './canon-projection';
import type { CanonMutationInput } from './canon-projection';

/**
 * Options for one `processResponse()` write.
 *
 * `defaultEdgeCore` / `defaultEdgeSource` are BATCH-level and stay for the callers that
 * genuinely write a homogeneous batch (opening, card import, batch solidify). Canon
 * Capture cannot use them — its facts ride in the same batch as the main model's, with
 * different provenance — so those travel per-fact instead (`FactProvenance`).
 */
export interface ProcessResponseOptions {
  /** Validate the caller's loaded state after asynchronous work; never sent to a model. */
  guard?: () => void;
  defaultEdgeCore?: boolean;
  defaultEdgeSource?: EngramEdge['source'];
  includeAllNpcTypes?: boolean;
  /**
   * Captured settings accepted (or retracted) this round.
   *
   * Merged into the SAME graph write as the response's own facts — a second
   * `processResponse()` call would rebuild every Event and Entity and re-run embedding
   * for the round just to add one edge.
   *
   * ADDITIONS only. Retraction is always player-initiated and therefore happens outside
   * a round — it goes through {@link EngramManager.invalidateCanonEntries}. Keeping one
   * retraction path means "undo" cannot mean two different things.
   */
  canonMutations?: CanonMutationInput[];
}
// CR-8: 类型定义已迁移到 engram-types.ts
export type {
  EngramConfig,
  EngramWriteSnapshot,
} from './engram-types';
import { ENGRAM_SCHEMA_VERSION, EDGE_CAPACITY_DEFAULT } from './engram-types';
import type { EngramStateData } from './engram-types';
import {
  loadEngramBlock,
  isLegacyEngramData,
  migrateLegacyEngram,
  migrateEngramSchema,
  preserveEmbeddingFlags,
} from './engram-state';
import { trimEvents, pruneToImportant, pruneEdgesToImportant } from './engram-prune';
import type { ImportantNpcScope, PrunedData } from './engram-prune';
import type {
  EngramConfig,
  EngramWriteSnapshot,
  EngramWriteEventDetail,
  EngramWriteEntityDelta,
} from './engram-types';

/** 当前 engramMemory schema 版本（取自 engram-types.ts 的 ENGRAM_SCHEMA_VERSION） */
const CURRENT_SCHEMA_VERSION = ENGRAM_SCHEMA_VERSION;

/** What EngramManager.repairVectorDims did. */
export interface VectorDimRepair {
  /** The dimension most of the slot's vectors have. */
  mainDim: number;
  /** Entries marked not embedded (the first time only). */
  unmarked: number;
  /** Vectors removed. */
  removed: number;
}

export class EngramManager {
  private eventBuilder = new EventBuilder();
  private entityBuilder = new EntityBuilder();
  private vectorStore: VectorStore;
  private embedder: Embedder;

  /** Engram 数据在状态树中的路径 */
  private readonly engramPath: string;
  /** 回合序号在状态树中的路径 */
  private readonly roundNumberPath: string;
  /** 社交关系在状态树中的路径 */
  private readonly relationshipsPath: string;
  /** 玩家名在状态树中的路径（2026-04-14 新增） */
  private readonly playerNamePath: string;
  /** 玩家当前位置路径（2026-04-14 新增） */
  private readonly playerLocationPath: string;
  /** 游戏时间对象路径（2026-04-14 新增） */
  private readonly gameTimePath: string;
  private readonly npcNameField: string;
  private readonly npcTypeField: string;
  /** The NPC type that counts as key (重点); an NPC of this type or with no type is always in the entity set. */
  private readonly npcTypeKey: string;
  /** NPC summary 来源字段名（M-3：注入给 EntityBuilder，避免硬编码中文字段名） */
  private readonly npcBackgroundField: string;
  private readonly npcAppearanceField: string;
  private readonly npcDescriptionField: string;

  /**
   * 获取当前活跃存档的 profileId + slotId
   */
  private getActiveSlot: () => { profileId: string; slotId: string } | null;
  /** R-02: 当前飞行中的 vectorizeAsync */
  private _vectorizeAbort: AbortController | null = null;
  /** Serialize processResponse calls to prevent concurrent read-modify-write races */
  private _processMutex: Promise<void> = Promise.resolve();

  constructor(
    aiService: AIService,
    pathOverrides?: {
      engramMemory?: string;
      roundNumber?: string;
      relationships?: string;
      playerName?: string;
      playerLocation?: string;
      gameTime?: string;
      npcNameField?: string;
      npcTypeField?: string;
      npcTypeKey?: string;
      npcBackgroundField?: string;
      npcAppearanceField?: string;
      npcDescriptionField?: string;
    },
    getActiveSlot?: () => { profileId: string; slotId: string } | null,
  ) {
    const paths = DEFAULT_ENGINE_PATHS;
    const fields = paths.npcFieldNames;
    this.engramPath = pathOverrides?.engramMemory ?? paths.engramMemory;
    this.roundNumberPath = pathOverrides?.roundNumber ?? paths.roundNumber;
    this.relationshipsPath = pathOverrides?.relationships ?? paths.relationships;
    this.playerNamePath = pathOverrides?.playerName ?? paths.playerName;
    this.playerLocationPath = pathOverrides?.playerLocation ?? paths.playerLocation;
    this.gameTimePath = pathOverrides?.gameTime ?? paths.gameTime;
    this.npcNameField = pathOverrides?.npcNameField ?? fields.name;
    this.npcTypeField = pathOverrides?.npcTypeField ?? fields.type;
    this.npcTypeKey = pathOverrides?.npcTypeKey ?? paths.npcTypeKey;
    this.npcBackgroundField = pathOverrides?.npcBackgroundField ?? fields.background;
    this.npcAppearanceField = pathOverrides?.npcAppearanceField ?? fields.appearance;
    this.npcDescriptionField = pathOverrides?.npcDescriptionField ?? fields.description;
    this.vectorStore = new VectorStore();
    this.embedder = new Embedder(aiService);
    this.getActiveSlot = getActiveSlot ?? (() => null);
  }

  async withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const ticket = this._processMutex.then(() => fn());
    this._processMutex = ticket.then(() => {}, () => {});
    return ticket;
  }

  isEnabled(): boolean {
    return loadEngramConfig().enabled;
  }

  getConfig(): EngramConfig {
    return loadEngramConfig();
  }

  /**
   * Manually trigger vectorization of all unembedded entities and edges.
   * Holds the write lock during the entire embedding API call (5-30s typical).
   * @returns vectorized count = number of items queued, not actual successes
   *          (partial embedding failures leave is_embedded=false for retry).
   */
  async vectorizePending(stateManager: StateManager): Promise<{ vectorized: number }> {
    return this.withWriteLock(async () => {
      const engram = this.loadEngram(stateManager);
      const unembeddedEntities = engram.entities.filter((e) => !e.is_embedded);
      const unembeddedEdges = engram.v2Edges.filter((e) => !e.is_embedded);
      const count = unembeddedEntities.length + unembeddedEdges.length;
      if (count === 0) return { vectorized: 0 };
      await this.vectorizeAsync([], unembeddedEntities, stateManager, unembeddedEdges);
      return { vectorized: count };
    });
  }

  /**
   * Invalidate every live edge projected from the given captured entries.
   *
   * The out-of-round half of the Canon Capture lifecycle: undo / disable / edit happen
   * from the panel and toast, outside any pipeline run, so they cannot ride the round's
   * `processResponse()` write. Runs under the same write lock so it cannot interleave
   * with a round that is mid-flight.
   *
   * Invalidates rather than deletes — the row stays auditable and a later restore has
   * something to find. Vectors are left in place for the same reason; an invalidated
   * edge is filtered out of retrieval by `isEdgeCurrentlyValid`.
   */
  async invalidateCanonEntries(
    stateManager: StateManager,
    entryIds: string[],
  ): Promise<{ invalidated: number }> {
    if (!Array.isArray(entryIds) || entryIds.length === 0) return { invalidated: 0 };
    return this.withWriteLock(async () => {
      const engram = this.loadEngram(stateManager);
      const round = stateManager.get<number>(this.roundNumberPath) ?? 0;
      const touched = invalidateEdgesForEntries(engram.v2Edges, entryIds, round);
      if (touched.length > 0) stateManager.set(this.engramPath, engram, 'system');
      return { invalidated: touched.length };
    });
  }

  /**
   * (Re)project a captured relationship after a restore or a semantic edit.
   *
   * Invalidates whatever the entry produced before, then builds a fresh edge from the
   * current meaning. Rebuild rather than in-place update because the edge ID is derived
   * from `source|target|fact` — changing the statement necessarily changes the id, so an
   * "update" would silently orphan the old row.
   *
   * Non-relationship settings are a deliberate no-op: the world book is the authority,
   * and inventing a second entity to make a one-entity setting fit the edge shape would
   * put a fake node into the graph.
   */
  async reprojectCanonEntry(
    stateManager: StateManager,
    mutation: CanonMutationInput,
  ): Promise<{ projected: boolean }> {
    const config = loadEngramConfig();
    if (!config.enabled || config.knowledgeEdgeMode !== 'active') return { projected: false };

    return this.withWriteLock(async () => {
      const engram = this.loadEngram(stateManager);
      const round = stateManager.get<number>(this.roundNumberPath) ?? 0;
      const edges = engram.v2Edges;

      // Old projection goes first, whether or not a new one follows: an edit that turns a
      // relationship into a plain character trait must not leave the old edge alive.
      const invalidated = invalidateEdgesForEntries(edges, [mutation.entryId], round);

      const facts = buildCanonFacts([mutation]);
      if (facts.length === 0) {
        if (invalidated.length > 0) stateManager.set(this.engramPath, engram, 'system');
        return { projected: false };
      }

      const entityNames = new Set(engram.entities.map((e) => e.name));
      // Same junk-name guard the in-round stub scan uses. Without it, a name the capture
      // pipeline would have rejected as sentence-like could sneak a garbage node into the
      // graph via the restore path — the same setting behaving differently depending on
      // which path it took.
      for (const fact of facts) {
        for (const name of [fact.sourceEntity, fact.targetEntity]) {
          if (!name || entityNames.has(name)) continue;
          if (isSentenceLikeName(name)) continue;
          engram.entities.push(makeFactStubEntity(name, inferEntityType(name, new Set(
            engram.entities.filter((e) => e.type === 'location').map((e) => e.name),
          )), round));
          entityNames.add(name);
        }
      }

      const result = buildFacts(
        { knowledgeFacts: facts, entities: engram.entities, currentEventId: null, currentRound: round },
        edges,
        this.vectorStore,
        {},
        new Map(),
        { reviewThreshold: config.edgeReviewThreshold, perFactCap: config.edgeReviewPerFactCap },
      );

      engram.v2Edges = [...edges, ...result.newEdges];
      stateManager.set(this.engramPath, engram, 'system');

      // Embed the new edge now instead of leaving it semantically unsearchable until the
      // player's next round happens to run the pipeline's vectorization sweep. Fire and
      // forget: an embedding failure leaves `is_embedded: false` for the normal retry,
      // and must not fail the player's panel action.
      if (result.newEdges.length > 0) {
        void this.vectorizeAsync([], [], stateManager, result.newEdges)
          .catch((err) => console.warn('[Engram] canon reproject vectorize failed (non-blocking):', err));
      }

      return { projected: result.newEdges.length > 0 || result.reinforcedIds.length > 0 };
    });
  }

  async deleteEdgeVectors(edgeIds: string[]): Promise<void> {
    const slot = this.getActiveSlot();
    if (!slot?.profileId || !slot?.slotId || edgeIds.length === 0) return;
    await this.vectorStore.deleteEdgeVectorsByIds(edgeIds, slot.profileId, slot.slotId);
  }

  async deleteEntityVectors(names: string[]): Promise<void> {
    const slot = this.getActiveSlot();
    if (!slot?.profileId || !slot?.slotId || names.length === 0) return;
    await this.vectorStore.deleteEntityVectorsByNames(names, slot.profileId, slot.slotId);
  }

  /**
   * 存档瘦身 D4A — a save's pseudo vectors (vector-dim-repair.ts), cleaned right after the save is opened
   * (bootstrap/engram-stack.ts, on 'engine:game-opened'), in two steps that never leave an entry marked embedded
   * without its vector in the stored save (the save check would read that as lost vectors):
   * 1. a pseudo vector whose entry is not marked embedded in the save as opened is removed;
   * 2. once per save (no `vectorDimRepaired` in the save format marker yet): the entries still marked embedded with
   *    a pseudo vector are marked not embedded (entities and edges are embedded again by the next round), the marker
   *    records it and a save is asked for. Their vectors go when the save is next opened, by step 1.
   * Pseudo vectors that come later stay as they are (their entries are marked embedded). A tree where the marker
   * cannot go (a field on its way is not an object: a damaged save, its format upgrade failed as well) is left as it
   * is: only step 1 runs. Runs under the write lock, as every engram write outside a round does. Never throws.
   */
  async repairVectorDims(stateManager: StateManager, saveFormatPath: string): Promise<VectorDimRepair | null> {
    try {
      return await this.withWriteLock(() => this.repairVectorDimsLocked(stateManager, saveFormatPath));
    } catch (err) {
      console.warn('[Engram] Pseudo-vector repair failed (non-blocking):', err);
      return null;
    }
  }

  private async repairVectorDimsLocked(stateManager: StateManager, saveFormatPath: string): Promise<VectorDimRepair | null> {
    const slot = this.getActiveSlot();
    if (!slot?.profileId || !slot.slotId) return null;
    const data = await this.vectorStore.load(slot.profileId, slot.slotId);
    const now = this.getActiveSlot();
    if (now?.profileId !== slot.profileId || now.slotId !== slot.slotId) return null; // another save was opened

    const mainDim = mainVectorDim(data);
    const pseudo = pseudoVectorKeys(data, mainDim);
    const engram = this.loadEngram(stateManager);
    const embedded = {
      eventVectors: new Set(engram.events.filter((e) => e.is_embedded).map((e) => e.id)),
      entityVectors: new Set(engram.entities.filter((e) => e.is_embedded).map((e) => e.name)),
      edgeVectors: new Set(engram.v2Edges.filter((e) => e.is_embedded).map((e) => e.id)),
    };
    const removable = keysByTable((table) => pseudo[table].filter((key) => !embedded[table].has(key)));

    const marker = stateManager.get<unknown>(saveFormatPath);
    const writable = canWritePath(stateManager.liveTree(), saveFormatPath);
    if (!writable) console.warn('[Engram] Pseudo-vector repair: the save format marker has no place in this tree; entries left as they are');
    const repaired = !writable || (isPlainRecord(marker) && marker.vectorDimRepaired === true);
    const unmarked = repaired
      ? keysByTable(() => [])
      : keysByTable((table) => pseudo[table].filter((key) => embedded[table].has(key)));
    if (!repaired) {
      this.markNotEmbedded(stateManager, unmarked);
      const base = isPlainRecord(marker) ? { ...marker } : { version: SAVE_FORMAT_VERSION, migratedAtRound: null };
      stateManager.set(saveFormatPath, { ...base, vectorDimRepaired: true }, 'system');
      if (countKeys(unmarked) > 0) eventBus.emit('engine:request-save');
    }

    const removed = countKeys(removable) > 0
      ? await this.vectorStore.removeVectors(removable, slot.profileId, slot.slotId)
      : 0;
    if (removed > 0 || countKeys(unmarked) > 0) {
      console.info(`[Engram] Pseudo vectors (the save's own dimension is ${mainDim}): ${countKeys(unmarked)} entr${countKeys(unmarked) === 1 ? 'y' : 'ies'} marked not embedded, ${removed} vector(s) removed`);
    }
    return { mainDim, unmarked: countKeys(unmarked), removed };
  }

  /** Mark the given events / entities / edges not embedded (path-level writes and counts, as vectorizeAsync does). */
  private markNotEmbedded(stateManager: StateManager, keys: VectorKeysByTable): void {
    if (countKeys(keys) === 0) return;
    const current = this.loadEngram(stateManager);
    const events = new Set(keys.eventVectors);
    const entities = new Set(keys.entityVectors);
    const edges = new Set(keys.edgeVectors);
    if (events.size > 0) {
      const updated = current.events.map((e) => (events.has(e.id) && e.is_embedded ? { ...e, is_embedded: false } : e));
      stateManager.set(`${this.engramPath}.events`, updated, 'system');
      stateManager.set(`${this.engramPath}.meta.embeddedEventCount`, updated.filter((e) => e.is_embedded).length, 'system');
    }
    if (entities.size > 0) {
      const updated = current.entities.map((e) => (entities.has(e.name) && e.is_embedded ? { ...e, is_embedded: false } : e));
      stateManager.set(`${this.engramPath}.entities`, updated, 'system');
      stateManager.set(`${this.engramPath}.meta.embeddedEntityCount`, updated.filter((e) => e.is_embedded).length, 'system');
    }
    if (edges.size > 0) {
      stateManager.set(`${this.engramPath}.v2Edges`,
        current.v2Edges.map((e) => (edges.has(e.id) && e.is_embedded ? { ...e, is_embedded: false } : e)), 'system');
    }
  }

  /**
   * 将 IDB 向量数据同步到当前状态树中的 Engram 元数据
   * 用于 rollback 场景
   */
  async syncVectorsToState(stateManager: StateManager): Promise<void> {
    this._vectorizeAbort?.abort();
    this._vectorizeAbort = null;

    const slot = this.getActiveSlot();
    if (!slot?.profileId || !slot?.slotId) return;

    const engram = this.loadEngram(stateManager);
    const keptEventIds = new Set(engram.events.map((e) => e.id));
    const keptEntityNames = new Set(engram.entities.map((e) => e.name));

    await this.vectorStore.trimToMatchEvents(
      keptEventIds,
      keptEntityNames,
      slot.profileId,
      slot.slotId,
    );

    // V2: trim orphaned edge vectors on rollback (always run, even if v2Edges is empty)
    const keptEdgeIds = new Set(engram.v2Edges.map((e) => e.id));
    await this.vectorStore.trimEdgeVectors(keptEdgeIds, slot.profileId, slot.slotId);
  }

  /**
   * 处理 AI 响应 — Engram 的主入口
   *
   * 返回写入快照（供 UI 可视化），Engram 未启用时返回 null。
   */
  async processResponse(
    response: AIResponse,
    stateManager: StateManager,
    options?: ProcessResponseOptions,
  ): Promise<EngramWriteSnapshot | null> {
    const config = loadEngramConfig();
    if (!config.enabled) return null;

    return this.withWriteLock(() => this._processResponseInner(response, stateManager, config, options));
  }

  private async _processResponseInner(
    response: AIResponse,
    stateManager: StateManager,
    config: EngramConfig,
    options?: ProcessResponseOptions,
  ): Promise<EngramWriteSnapshot | null> {

    options?.guard?.();
    const startTime = performance.now();
    const currentRound = stateManager.get<number>(this.roundNumberPath) ?? 0;

    // ── Step 0 / 0.5: legacy + schema migration ──
    const engram = this.loadMigrated(stateManager);

    // Snapshot previous state for delta detection
    const prevEntityMap = new Map(engram.entities.map((e) => [e.name, e]));

    // ── Step 1: 事件提取 ──
    const newEvents = this.buildRoundEvents(response, stateManager, currentRound);

    const allEvents: EngramEventNode[] = [...engram.events, ...newEvents];

    // ── Step 2 / 2.3 / 2.25: 实体构建（双源）+ 恢复用户实体与桩实体 ──
    const entities = this.buildRoundEntities(allEvents, engram, stateManager, currentRound, options);

    // ── Canon Capture: fold this round's captured relationships into the same batch ──
    //
    // Deliberately merged into the EXISTING write rather than given its own
    // `processResponse()` call: a second call would rebuild every Event and Entity and
    // re-run embedding for the round, doubling the cost to add one edge.
    // Canon facts go FIRST. When the model and the player describe the same relationship
    // in one round, whichever is processed first becomes the edge and the other dedupes
    // into it — so leading with canon means the surviving edge carries the PLAYER's
    // wording (and their `canonEntryId`), not the model's paraphrase of it.
    const canonFacts = buildCanonFacts(options?.canonMutations);
    const combinedFacts: KnowledgeFact[] = [
      ...canonFacts,
      ...(response.knowledgeFacts ?? []).map((kf) => ({
        fact: kf.fact,
        sourceEntity: kf.sourceEntity,
        targetEntity: kf.targetEntity,
      })),
    ];

    // ── Step 2.5: Tier 1 — 自动补桩缺失实体（事实边端点） ──
    if (config.knowledgeEdgeMode === 'active' && combinedFacts.length > 0) {
      this.stubMissingFactEndpoints(entities, combinedFacts, currentRound);
    }

    // ── Step 3: 关系（V2 不再构建，仅保留历史数据） ──
    const relations = engram.relations;

    // ── Step 3b: Knowledge edge build ──
    let edgesPrunedCount = 0;
    const edgeActive = config.knowledgeEdgeMode === 'active';
    if (edgeActive && combinedFacts.length > 0) {
      edgesPrunedCount = await this.buildKnowledgeEdges(
        engram, entities, combinedFacts, newEvents, currentRound, config, options,
      );
    }

    // ── Step 4: 修剪（重点 NPC 过滤） ──
    const data: PrunedData = config.pruneToImportantNpcs
      ? pruneToImportant(allEvents, entities, relations, stateManager, this.importantNpcScope())
      : { events: allEvents, entities, relations };

    // Apply NPC importance filter to V2 edges (episodes >= 3 exempt)
    if (config.pruneToImportantNpcs && engram.v2Edges.length > 0) {
      engram.v2Edges = pruneEdgesToImportant(engram.v2Edges, stateManager, this.importantNpcScope());
    }

    const eventsBeforeTrim = data.events.length;
    const entitiesBeforeTrim = data.entities.length;

    // ── Step 5: trim 策略 ──
    const trimmedEvents = trimEvents(data.events, config.trim);
    const trimmedEntities = data.entities.slice(-config.maxEntities);

    // 保留已有向量化状态（通过 name / id 合并）
    const preserveEmbedFlags = preserveEmbeddingFlags(
      trimmedEvents,
      trimmedEntities,
      engram,
    );

    const updatedEngram: EngramStateData = {
      events: preserveEmbedFlags.events,
      entities: preserveEmbedFlags.entities,
      relations: data.relations,
      v2Edges: engram.v2Edges,
      meta: {
        lastUpdated: Date.now(),
        eventCount: preserveEmbedFlags.events.length,
        embeddedEventCount: preserveEmbedFlags.events.filter((e) => e.is_embedded).length,
        embeddedEntityCount: preserveEmbedFlags.entities.filter((e) => e.is_embedded).length,
        schemaVersion: Math.max(engram.meta.schemaVersion, CURRENT_SCHEMA_VERSION),
        v2PendingReview: engram.meta.v2PendingReview ?? null,
      },
    };
    options?.guard?.();
    stateManager.set(this.engramPath, updatedEngram, 'system');

    // ── Step 6: 向量 trim 同步 ──
    const keptEventIds = new Set(preserveEmbedFlags.events.map((e) => e.id));
    const keptEntityNames = new Set(preserveEmbedFlags.entities.map((e) => e.name));
    const slot = this.getActiveSlot();
    if (slot?.profileId && slot?.slotId) {
      this.vectorStore
        .trimToMatchEvents(keptEventIds, keptEntityNames, slot.profileId, slot.slotId)
        .catch((err) => console.warn('[Engram] trimToMatchEvents failed (non-blocking):', err));
    }

    // ── Step 7: 异步向量化（events + entities + v2Edges 合批） ──
    const unembeddedEntities = preserveEmbedFlags.entities.filter((e) => !e.is_embedded);
    const unembeddedEdges = engram.v2Edges.filter((e) => !e.is_embedded);
    const vectorizeQueued = newEvents.length + unembeddedEntities.length + unembeddedEdges.length;
    if (newEvents.length > 0 || unembeddedEntities.length > 0 || unembeddedEdges.length > 0) {
      this.vectorizeAsync(newEvents, unembeddedEntities, stateManager, unembeddedEdges, options?.guard).catch((err) =>
        console.warn('[Engram] Vectorization failed (non-blocking):', err),
      );
    }

    return this.buildWriteSnapshot({
      engram,
      newEvents,
      prevEntityMap,
      finalEntities: preserveEmbedFlags.entities,
      relationsTotal: data.relations.length,
      currentRound,
      startTime,
      edgesPrunedCount,
      trim: {
        eventsBefore: eventsBeforeTrim,
        eventsAfter: trimmedEvents.length,
        entitiesBefore: entitiesBeforeTrim,
        entitiesAfter: trimmedEntities.length,
      },
      vectorizeQueued,
    });
  }

  /** Step 0 + 0.5: load the block, clear legacy data, run the v4/v5 schema steps. */
  private loadMigrated(stateManager: StateManager): EngramStateData {
    const existing = this.loadEngram(stateManager);
    const isLegacy = isLegacyEngramData(existing);
    const engram = isLegacy
      ? migrateLegacyEngram(stateManager, this.engramPath, this.vectorStore, this.getActiveSlot)
      : existing;
    migrateEngramSchema(engram);
    return engram;
  }

  /** Step 1: this round's event node (+ the model's mid-term summary on the first one). */
  private buildRoundEvents(
    response: AIResponse,
    stateManager: StateManager,
    currentRound: number,
  ): EngramEventNode[] {
    const eventPaths = {
      playerName: this.playerNamePath,
      playerLocation: this.playerLocationPath,
      gameTime: this.gameTimePath,
    };
    const newEvents = this.eventBuilder.build(response, stateManager, currentRound, eventPaths);

    if (newEvents.length > 0) {
      const mid = response.midTermMemory;
      if (mid && typeof mid === 'object' && !Array.isArray(mid) && typeof mid.记忆主体 === 'string') {
        const summary = mid.记忆主体.trim();
        if (summary) {
          newEvents[0] = { ...newEvents[0], midTermSummary: summary };
        }
      }
    }
    return newEvents;
  }

  /** Step 2 + 2.3 + 2.25: build entities, then restore user-created and pending-enrichment ones. */
  private buildRoundEntities(
    allEvents: EngramEventNode[],
    engram: EngramStateData,
    stateManager: StateManager,
    currentRound: number,
    options?: ProcessResponseOptions,
  ): EngramEntity[] {
    const entityPaths = {
      playerName: this.playerNamePath,
      relationships: this.relationshipsPath,
      npcDescriptionFields: {
        background: this.npcBackgroundField,
        appearance: this.npcAppearanceField,
        description: this.npcDescriptionField,
      },
    };
    const entities = this.entityBuilder.build(allEvents, stateManager, entityPaths, {
      includeAllNpcTypes: options?.includeAllNpcTypes,
    });

    // -- Step 2.3 (Story 1): 恢复用户手动创建的实体 --
    // ORDERING: must run BEFORE Step 2.25 (_pendingEnrichment). User entities are
    // restored first so their names appear in the builtNames set that Step 2.25 uses,
    // preventing duplicate pushes. Do not reorder these two blocks.
    {
      const builtNames = new Set(entities.map((e) => e.name));
      for (const prev of engram.entities) {
        if (prev.source === 'user' && !builtNames.has(prev.name)) {
          entities.push({ ...prev, lastSeen: currentRound });
        } else if (prev.source === 'user' && builtNames.has(prev.name)) {
          const derived = entities.find((e) => e.name === prev.name);
          if (derived && prev.summary && prev.summary !== derived.summary) {
            derived.summary = prev.summary;
            derived.source = 'user';
            derived.userEditedAtRound = prev.userEditedAtRound;
          }
        }
      }
    }

    // ── Step 2.25: 恢复上一轮的 _pendingEnrichment 桩实体 ──
    // EntityBuilder 每轮从零构建，会丢失 Tier 1 补的桩实体。
    // 从 persisted engram 中把还没被 Tier 2 补全的实体恢复回来。
    {
      const builtNames = new Set(entities.map((e) => e.name));
      for (const prev of engram.entities) {
        if (prev._pendingEnrichment && !builtNames.has(prev.name)) {
          entities.push({ ...prev, lastSeen: currentRound });
        }
      }
    }
    return entities;
  }

  /** Step 2.5 (Tier 1): stub entities for fact endpoints that do not exist yet. Mutates `entities`. */
  private stubMissingFactEndpoints(
    entities: EngramEntity[],
    combinedFacts: KnowledgeFact[],
    currentRound: number,
  ): void {
    const entityNames = new Set(entities.map((e) => e.name));
    // Derived from EntityBuilder.build()'s pre-scan — both sites must stay in sync
    const knownLocationNames = new Set(
      entities.filter((e) => e.type === 'location').map((e) => e.name),
    );
    // Scans `combinedFacts`, so a captured relationship whose entity does not exist yet
    // gets the same stub treatment as an AI-produced one. Without this the fact would
    // be rejected outright (`buildFacts` drops facts with two unknown endpoints) and
    // the design's "at most one live edge per canonEntryId" metric would pass vacuously
    // by never creating an edge at all.
    for (const kf of combinedFacts) {
      for (const name of [kf.sourceEntity, kf.targetEntity]) {
        if (!name || entityNames.has(name)) continue;
        if (isSentenceLikeName(name)) continue;
        entities.push(makeFactStubEntity(name, inferEntityType(name, knownLocationNames), currentRound));
        entityNames.add(name);
      }
    }
  }

  /**
   * Step 3b: FactBuilder + prune + pending-review merge. Mutates `engram.v2Edges` /
   * `engram.meta.v2PendingReview`; returns how many edges the capacity prune dropped.
   * The awaits and `guard()` calls keep their original order.
   */
  private async buildKnowledgeEdges(
    engram: EngramStateData,
    entities: EngramEntity[],
    combinedFacts: KnowledgeFact[],
    newEvents: EngramEventNode[],
    currentRound: number,
    config: EngramConfig,
    options?: ProcessResponseOptions,
  ): Promise<number> {
    // V2 path: use FactBuilder with knowledge_facts + captured relationships
    const kfacts: KnowledgeFact[] = combinedFacts;

    // Load edge vectors for dedup (skip embedding if no existing edges to compare against)
    let edgeVectors: Record<string, StoredVector> = {};
    let newFactVectors = new Map<string, number[]>();
    const slot = this.getActiveSlot();
    const hasExistingEdges = engram.v2Edges.length > 0;
    if (slot?.profileId && slot?.slotId && hasExistingEdges) {
      try {
        const vectorData = await this.vectorStore.load(slot.profileId, slot.slotId);
        options?.guard?.();
        edgeVectors = vectorData.edgeVectors ?? {};
        // Only embed for dedup when there are existing edges to compare against
        if (Object.keys(edgeVectors).length > 0) {
          const factsToEmbed = kfacts.map((kf) => kf.fact);
          if (factsToEmbed.length > 0) {
            const vectors = await this.embedder.embed(factsToEmbed);
            options?.guard?.();
            for (let i = 0; i < kfacts.length; i++) {
              if (vectors[i]?.length > 0) newFactVectors.set(kfacts[i].fact, vectors[i]);
            }
          }
        }
      } catch {
        // Embedding failure is non-blocking — dedup will skip cosine checks
      }
    }

    // Do not swallow a stale-round error as an optional embedding failure.
    options?.guard?.();
    const result = buildFacts(
      { knowledgeFacts: kfacts, entities, currentEventId: newEvents[0]?.id ?? null, currentRound },
      engram.v2Edges,
      this.vectorStore,
      edgeVectors,
      newFactVectors,
      {
        reviewThreshold: config.edgeReviewThreshold!,
        perFactCap: config.edgeReviewPerFactCap!,
        defaultCore: options?.defaultEdgeCore,
        defaultSource: options?.defaultEdgeSource,
      },
    );

    const allEdges = [...engram.v2Edges, ...result.newEdges];
    const beforePruneCount = allEdges.length;
    engram.v2Edges = pruneEdgesV2(allEdges, currentRound, config.edgeCapacity ?? EDGE_CAPACITY_DEFAULT);
    const edgesPrunedCount = beforePruneCount - engram.v2Edges.length;

    if (result.pendingReviewPairs.length > 0) {
      console.log(`[Engram V2] ${result.pendingReviewPairs.length} edge pair(s) flagged for contradiction review`);
      const existingPending = engram.meta.v2PendingReview ?? [];
      const currentEdgeIds = new Set(engram.v2Edges.map((e) => e.id));
      const merged = [...existingPending, ...result.pendingReviewPairs]
        .filter((p) => currentEdgeIds.has(p.oldEdgeId));
      const seen = new Set<string>();
      const MAX_PENDING_REVIEW = 200;
      engram.meta.v2PendingReview = merged.filter((p) => {
        const key = `${p.newFact}::${p.oldEdgeId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(-MAX_PENDING_REVIEW);
    }

    // Clean up orphaned IDB vectors from renamed edges
    if (result.renamedEdgeIds.length > 0 && slot?.profileId && slot?.slotId) {
      const oldIds = result.renamedEdgeIds.map((r) => r.oldId);
      this.vectorStore
        .deleteEdgeVectorsByIds(oldIds, slot.profileId, slot.slotId)
        .catch((err) => console.warn('[Engram] deleteEdgeVectorsByIds failed (non-blocking):', err));
    }

    return edgesPrunedCount;
  }

  /** The write snapshot handed to the UI (event / entity deltas / edge stats / trim stats). */
  private buildWriteSnapshot(input: {
    engram: EngramStateData;
    newEvents: EngramEventNode[];
    prevEntityMap: Map<string, EngramEntity>;
    finalEntities: EngramEntity[];
    relationsTotal: number;
    currentRound: number;
    startTime: number;
    edgesPrunedCount: number;
    trim: NonNullable<EngramWriteSnapshot['trimmed']>;
    vectorizeQueued: number;
  }): EngramWriteSnapshot {
    const {
      engram, newEvents, prevEntityMap, finalEntities, relationsTotal,
      currentRound, startTime, edgesPrunedCount, trim, vectorizeQueued,
    } = input;

    // ── Build write snapshot ──
    const eventDetail: EngramWriteEventDetail | null = newEvents.length > 0
      ? {
          eventId: newEvents[0].id,
          title: newEvents[0].structured_kv?.event ?? '',
          roles: newEvents[0].structured_kv?.role ?? [],
          location: newEvents[0].structured_kv?.location ?? [],
          timeAnchor: newEvents[0].structured_kv?.time_anchor ?? '',
        }
      : null;

    const entityDeltas: EngramWriteEntityDelta[] = finalEntities.map((e) => {
      const prev = prevEntityMap.get(e.name);
      return {
        name: e.name,
        type: e.type,
        isNew: !prev,
        descriptionUpdated: prev != null && prev.summary !== e.summary && e.summary !== '',
        mentionCount: e.mentionCount,
      };
    }).filter((d) => d.isNew || d.descriptionUpdated);

    // Build V2 edge snapshot
    const edgesSnapshot = (() => {
      if (engram.v2Edges.length === 0) return undefined;
      const v2 = engram.v2Edges;
      const newV2 = v2.filter((e) => e.createdAtRound === currentRound);
      const reinforcedV2 = v2.filter((e) => e.lastSeenRound === currentRound && e.createdAtRound < currentRound);
      return {
        total: v2.length,
        newCount: newV2.length,
        reinforcedCount: reinforcedV2.length,
        prunedCount: edgesPrunedCount,
        topNew: newV2.slice(0, 10).map((e) => ({
          sourceEntity: e.sourceEntity,
          targetEntity: e.targetEntity,
          fact: e.fact,
          episodeCount: e.episodes.length,
          isNew: true,
        })),
      };
    })();

    return {
      roundNumber: currentRound,
      capturedAt: Date.now(),
      totalDurationMs: performance.now() - startTime,
      event: eventDetail,
      entities: { total: finalEntities.length, deltas: entityDeltas.slice(0, 20) },
      relations: { total: relationsTotal, deltas: [] },
      snapshotVersion: 2,
      trimmed: trim,
      vectorizeQueued,
      edges: edgesSnapshot,
    };
  }

  /** The configured paths / field names the NPC-importance filter reads. */
  private importantNpcScope(): ImportantNpcScope {
    return {
      relationshipsPath: this.relationshipsPath,
      playerNamePath: this.playerNamePath,
      npcNameField: this.npcNameField,
      npcTypeField: this.npcTypeField,
      npcTypeKey: this.npcTypeKey,
    };
  }

  private loadEngram(stateManager: StateManager): EngramStateData {
    return loadEngramBlock(stateManager, this.engramPath);
  }

  /**
   * 异步向量化 events + entities（2026-04-14 重构：双路合批）
   *
   * 流程：
   * 1. 构造嵌入输入：
   *    - event: summary（burned 格式，含元数据）
   *    - entity: name + description
   * 2. 单次 embed() 调用（批量，利用缓存）
   * 3. 切片分发到 mergeEventVectors + mergeEntityVectors
   * 4. 回写状态树：把 events[i].is_embedded / entities[i].is_embedded 置 true
   * 5. abort signal 检查：rollback 场景下放弃回写
   */
  private async vectorizeAsync(
    newEvents: EngramEventNode[],
    unembeddedEntities: EngramEntity[],
    stateManager: StateManager,
    unembeddedEdges: EngramEdge[] = [],
    guard?: () => void,
  ): Promise<void> {
    const slot = this.getActiveSlot();
    if (!slot?.profileId || !slot?.slotId) return;
    const { profileId, slotId } = slot;

    this._vectorizeAbort?.abort();
    const ac = new AbortController();
    this._vectorizeAbort = ac;

    // 构造嵌入输入
    const eventInputs = newEvents.map((e) => {
      const summary = typeof e.summary === 'string' ? e.summary.trim() : '';
      return summary || e.text || JSON.stringify(e.structured_kv ?? {});
    });
    const entityInputs = unembeddedEntities.map((e) => {
      const name = e.name.trim();
      const desc = (e.summary ?? '').trim();
      return desc ? `${name} ${desc}` : name;
    });
    const edgeInputs = unembeddedEdges.map((e) => e.fact);

    // 合批调用
    const allInputs = [...eventInputs, ...entityInputs, ...edgeInputs];
    if (allInputs.length === 0) {
      this._vectorizeAbort = null;
      return;
    }
    const vectors = await this.embedder.embed(allInputs);
    if (ac.signal.aborted) return;
    guard?.();

    const model = loadEngramConfig().embeddingModel ?? 'unknown';
    const eventVectors = vectors.slice(0, eventInputs.length);
    const entityVectors = vectors.slice(eventInputs.length, eventInputs.length + entityInputs.length);
    const edgeVectorsSlice = vectors.slice(eventInputs.length + entityInputs.length);

    // 持久化到 IDB
    if (newEvents.length > 0) {
      await this.vectorStore.mergeEventVectors(
        newEvents.map((e) => ({ id: e.id })),
        eventVectors,
        model,
        { profileId, slotId },
      );
    }
    if (unembeddedEntities.length > 0) {
      await this.vectorStore.mergeEntityVectors(
        unembeddedEntities.map((e) => ({ name: e.name })),
        entityVectors,
        model,
        { profileId, slotId },
      );
    }
    if (unembeddedEdges.length > 0) {
      await this.vectorStore.mergeEdgeVectors(
        unembeddedEdges.map((e) => ({ id: e.id })),
        edgeVectorsSlice,
        model,
        { profileId, slotId },
      );
    }

    if (ac.signal.aborted) return;
    guard?.();

    // ── 回写 is_embedded 标记到状态树 ──
    // 只标记有非空向量的条目
    const embeddedEventIds = new Set<string>();
    for (let i = 0; i < newEvents.length; i++) {
      if (eventVectors[i] && eventVectors[i].length > 0) {
        embeddedEventIds.add(newEvents[i].id);
      }
    }
    const embeddedEntityNames = new Set<string>();
    for (let i = 0; i < unembeddedEntities.length; i++) {
      if (entityVectors[i] && entityVectors[i].length > 0) {
        embeddedEntityNames.add(unembeddedEntities[i].name);
      }
    }

    if (ac.signal.aborted) return;

    // Re-read current state and apply is_embedded flags via path-level writes.
    // Avoid whole-object replacement — a late vectorizeAsync from Round N must
    // not overwrite meta/entities/edges written by Round N+1.
    const current = this.loadEngram(stateManager);

    let eventsChanged = false;
    const updatedEvents = current.events.map((e) => {
      if (embeddedEventIds.has(e.id) && !e.is_embedded) {
        eventsChanged = true;
        return { ...e, is_embedded: true };
      }
      return e;
    });

    let entitiesChanged = false;
    const updatedEntities = current.entities.map((e) => {
      if (embeddedEntityNames.has(e.name) && !e.is_embedded) {
        entitiesChanged = true;
        return { ...e, is_embedded: true };
      }
      return e;
    });

    const embeddedEdgeIds = new Set<string>();
    for (let i = 0; i < unembeddedEdges.length; i++) {
      if (edgeVectorsSlice[i] && edgeVectorsSlice[i].length > 0) {
        embeddedEdgeIds.add(unembeddedEdges[i].id);
      }
    }
    let edgesChanged = false;
    const updatedV2Edges = (current.v2Edges ?? []).map((e) => {
      if (embeddedEdgeIds.has(e.id) && !e.is_embedded) {
        edgesChanged = true;
        return { ...e, is_embedded: true };
      }
      return e;
    });

    if (ac.signal.aborted) return;

    if (eventsChanged) {
      stateManager.set(this.engramPath + '.events', updatedEvents, 'system');
      stateManager.set(
        this.engramPath + '.meta.embeddedEventCount',
        updatedEvents.filter((e) => e.is_embedded).length,
        'system',
      );
    }
    if (entitiesChanged) {
      stateManager.set(this.engramPath + '.entities', updatedEntities, 'system');
      stateManager.set(
        this.engramPath + '.meta.embeddedEntityCount',
        updatedEntities.filter((e) => e.is_embedded).length,
        'system',
      );
    }
    if (edgesChanged) {
      stateManager.set(this.engramPath + '.v2Edges', updatedV2Edges, 'system');
    }

    this._vectorizeAbort = null;
  }
}
