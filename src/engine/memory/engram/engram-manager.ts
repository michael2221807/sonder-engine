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
import type { AIService } from '../../ai/ai-service';
import type { AIResponse } from '../../ai/types';
import { EventBuilder } from './event-builder';
import type { EngramEventNode } from './event-builder';
import { EntityBuilder } from './entity-builder';
import type { EngramEntity } from './entity-builder';
import { inferEntityType } from './entity-builder';
import type { EngramRelation } from './engram-types';
import { VectorStore } from './vector-store';
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
  EngramRetrievalMode,
  EngramEmbeddingConfig,
  EngramRerankConfig,
  EngramTrimConfig,
  EngramConfig,
  EngramWriteSnapshot,
} from './engram-types';
export { DEFAULT_ENGRAM_CONFIG } from './engram-types';
import { ENGRAM_SCHEMA_VERSION } from './engram-types';
import type {
  EngramConfig,
  EngramTrimConfig,
  EngramWriteSnapshot,
  EngramWriteEventDetail,
  EngramWriteEntityDelta,
} from './engram-types';

/**
 * Engram 状态数据结构
 * 存储在状态树 "系统.扩展.engramMemory" 路径下。
 */
interface EngramStateData {
  events: EngramEventNode[];
  entities: EngramEntity[];
  relations: EngramRelation[];
  v2Edges: EngramEdge[];
  meta: {
    lastUpdated: number;
    eventCount: number;
    embeddedEventCount: number;
    embeddedEntityCount: number;
    schemaVersion: number;
    v2PendingReview?: Array<{ newFact: string; oldEdgeId: string; similarity: number }> | null;
  };
}

/** 修剪后的数据集 */
interface PrunedData {
  events: EngramEventNode[];
  entities: EngramEntity[];
  relations: EngramRelation[];
}

type NpcRelationshipEntry = Record<string, unknown>;

/** 当前 engramMemory schema 版本 —— v3 = KnowledgeEdge, v4 = EngramEdge (V2 Graphiti) */
const CURRENT_SCHEMA_VERSION = ENGRAM_SCHEMA_VERSION;

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
      npcBackgroundField?: string;
      npcAppearanceField?: string;
      npcDescriptionField?: string;
    },
    getActiveSlot?: () => { profileId: string; slotId: string } | null,
  ) {
    this.engramPath = pathOverrides?.engramMemory ?? '系统.扩展.engramMemory';
    this.roundNumberPath = pathOverrides?.roundNumber ?? '元数据.回合序号';
    this.relationshipsPath = pathOverrides?.relationships ?? '社交.关系';
    this.playerNamePath = pathOverrides?.playerName ?? '角色.基础信息.姓名';
    this.playerLocationPath = pathOverrides?.playerLocation ?? '角色.基础信息.当前位置';
    this.gameTimePath = pathOverrides?.gameTime ?? '世界.时间';
    this.npcNameField = pathOverrides?.npcNameField ?? '名称';
    this.npcTypeField = pathOverrides?.npcTypeField ?? '类型';
    this.npcBackgroundField = pathOverrides?.npcBackgroundField ?? '背景';
    this.npcAppearanceField = pathOverrides?.npcAppearanceField ?? '外貌描述';
    this.npcDescriptionField = pathOverrides?.npcDescriptionField ?? '描述';
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
      const touched = invalidateEdgesForEntries(engram.v2Edges ?? [], entryIds, round);
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
      const edges = engram.v2Edges ?? [];

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
      const isSentenceLike = (s: string) => s.length > 6 && /[，。了的被在过着得让把将与从]/.test(s);
      for (const fact of facts) {
        for (const name of [fact.sourceEntity, fact.targetEntity]) {
          if (!name || entityNames.has(name)) continue;
          if (isSentenceLike(name)) continue;
          engram.entities.push({
            name,
            type: inferEntityType(name, new Set(
              engram.entities.filter((e) => e.type === 'location').map((e) => e.name),
            )),
            summary: '',
            attributes: {},
            firstSeen: round,
            lastSeen: round,
            mentionCount: 1,
            is_embedded: false,
            _pendingEnrichment: true,
          });
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
    const keptEdgeIds = new Set((engram.v2Edges ?? []).map((e) => e.id));
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

    const startTime = performance.now();
    const currentRound = stateManager.get<number>(this.roundNumberPath) ?? 0;

    // ── Step 0: Legacy migration ──
    const existing = this.loadEngram(stateManager);
    const isLegacy = this.isLegacyData(existing);
    const engram = isLegacy ? this.migrateLegacy(stateManager) : existing;

    // ── Step 0.5: V2 Graphiti migration — ensure v2Edges initialized ──
    if (engram.meta.schemaVersion < 4) {
      engram.v2Edges = engram.v2Edges ?? [];
      engram.meta.schemaVersion = 4;
      console.info('[Engram] Migrated to v4: initialized v2Edges');
    }

    if (engram.meta.schemaVersion < 5) {
      for (const edge of engram.v2Edges) {
        if (edge.learnedAtRound == null) edge.learnedAtRound = edge.createdAtRound;
        if (edge.invalidatedAtRound != null && edge.invalidAtRound == null) {
          edge.invalidAtRound = edge.invalidatedAtRound;
        }
      }
      engram.meta.schemaVersion = 5;
      console.info('[Engram] Migrated to v5: temporal fields (learnedAtRound, invalidAtRound)');
    }

    // Snapshot previous state for delta detection
    const prevEntityMap = new Map(engram.entities.map((e) => [e.name, e]));

    // ── Step 1: 事件提取 ──
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

    const allEvents: EngramEventNode[] = [...engram.events, ...newEvents];

    // ── Step 2: 实体构建（双源） ──
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
      const entityNames = new Set(entities.map((e) => e.name));
      // Derived from EntityBuilder.build()'s pre-scan — both sites must stay in sync
      const knownLocationNames = new Set(
        entities.filter((e) => e.type === 'location').map((e) => e.name),
      );
      const isSentenceLike = (s: string) => s.length > 6 && /[，。了的被在过着得让把将与从]/.test(s);
      // Scans `combinedFacts`, so a captured relationship whose entity does not exist yet
      // gets the same stub treatment as an AI-produced one. Without this the fact would
      // be rejected outright (`buildFacts` drops facts with two unknown endpoints) and
      // the design's "at most one live edge per canonEntryId" metric would pass vacuously
      // by never creating an edge at all.
      for (const kf of combinedFacts) {
        for (const name of [kf.sourceEntity, kf.targetEntity]) {
          if (!name || entityNames.has(name)) continue;
          if (isSentenceLike(name)) continue;
          entities.push({
            name,
            type: inferEntityType(name, knownLocationNames),
            summary: '',
            attributes: {},
            firstSeen: currentRound,
            lastSeen: currentRound,
            mentionCount: 1,
            is_embedded: false,
            _pendingEnrichment: true,
          });
          entityNames.add(name);
        }
      }
    }

    // ── Step 3: 关系（V2 不再构建，仅保留历史数据） ──
    const relations = engram.relations;

    // ── Step 3b: Knowledge edge build ──
    let edgesPrunedCount = 0;
    const edgeActive = config.knowledgeEdgeMode === 'active';
    if (edgeActive && combinedFacts.length > 0) {
      // V2 path: use FactBuilder with knowledge_facts + captured relationships
      const kfacts: KnowledgeFact[] = combinedFacts;

      // Load edge vectors for dedup (skip embedding if no existing edges to compare against)
      let edgeVectors: Record<string, number[]> = {};
      let newFactVectors = new Map<string, number[]>();
      const slot = this.getActiveSlot();
      const hasExistingEdges = (engram.v2Edges ?? []).length > 0;
      if (slot?.profileId && slot?.slotId && hasExistingEdges) {
        try {
          const vectorData = await this.vectorStore.load(slot.profileId, slot.slotId);
          edgeVectors = vectorData.edgeVectors ?? {};
          // Only embed for dedup when there are existing edges to compare against
          if (Object.keys(edgeVectors).length > 0) {
            const factsToEmbed = kfacts.map((kf) => kf.fact);
            if (factsToEmbed.length > 0) {
              const vectors = await this.embedder.embed(factsToEmbed);
              for (let i = 0; i < kfacts.length; i++) {
                if (vectors[i]?.length > 0) newFactVectors.set(kfacts[i].fact, vectors[i]);
              }
            }
          }
        } catch {
          // Embedding failure is non-blocking — dedup will skip cosine checks
        }
      }

      const result = buildFacts(
        { knowledgeFacts: kfacts, entities, currentEventId: newEvents[0]?.id ?? null, currentRound },
        engram.v2Edges ?? [],
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
      engram.v2Edges = pruneEdgesV2(allEdges, currentRound, config.edgeCapacity ?? 800);
      edgesPrunedCount = beforePruneCount - engram.v2Edges.length;

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
    }

    // ── Step 4: 修剪（重点 NPC 过滤） ──
    const data: PrunedData = config.pruneToImportantNpcs
      ? this.pruneToImportant(allEvents, entities, relations, stateManager)
      : { events: allEvents, entities, relations };

    // Apply NPC importance filter to V2 edges (episodes >= 3 exempt)
    if (config.pruneToImportantNpcs && engram.v2Edges.length > 0) {
      const importantNames = this.collectImportantNpcNames(stateManager);
      const playerName = stateManager.get<string>(this.playerNamePath) || '玩家';
      const isRelevant = (n: string) => importantNames.has(n) || n === playerName || n === '玩家';

      engram.v2Edges = engram.v2Edges.filter((e) =>
        e.episodes.length >= 3
        || isRelevant(e.sourceEntity)
        || isRelevant(e.targetEntity)
        || e.source === 'batch-sync'
        || e.source === 'user'
        || e.source === 'user-canon'
        || e.source === 'opening'
        || e.source === 'card-import'
        || e.core === true,
      );
    }

    const eventsBeforeTrim = data.events.length;
    const entitiesBeforeTrim = data.entities.length;

    // ── Step 5: trim 策略 ──
    const trimmedEvents = this.trimEvents(data.events, config.trim);
    const trimmedEntities = data.entities.slice(-config.maxEntities);

    // 保留已有向量化状态（通过 name / id 合并）
    const preserveEmbedFlags = this.preserveEmbeddingFlags(
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
      this.vectorizeAsync(newEvents, unembeddedEntities, stateManager, unembeddedEdges).catch((err) =>
        console.warn('[Engram] Vectorization failed (non-blocking):', err),
      );
    }

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

    const entityDeltas: EngramWriteEntityDelta[] = preserveEmbedFlags.entities.map((e) => {
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
      entities: { total: preserveEmbedFlags.entities.length, deltas: entityDeltas.slice(0, 20) },
      relations: { total: data.relations.length, deltas: [] },
      snapshotVersion: 2,
      trimmed: {
        eventsBefore: eventsBeforeTrim,
        eventsAfter: trimmedEvents.length,
        entitiesBefore: entitiesBeforeTrim,
        entitiesAfter: trimmedEntities.length,
      },
      vectorizeQueued,
      edges: edgesSnapshot,
    };
  }

  // ─── Legacy migration（A8） ───

  /**
   * 检测旧版本 events —— 缺 `summary` 字段或 `structured_kv` 对象
   * 返回 true 表示需要清空 engramMemory 并重新开始（clean state）
   */
  private isLegacyData(engram: EngramStateData): boolean {
    if (!engram.events || engram.events.length === 0) return false;
    // 任意一条 event 缺 summary 或 structured_kv → 视为旧版本
    return engram.events.some(
      (e) => typeof (e as { summary?: unknown }).summary !== 'string'
        || typeof (e as { structured_kv?: unknown }).structured_kv !== 'object',
    );
  }

  /**
   * 清空 engramMemory + 对应的 IDB 向量数据，返回干净的空结构
   *
   * 用户确认过：可以直接清空老的 events 重置为 clean state（无需保留）。
   */
  private migrateLegacy(stateManager: StateManager): EngramStateData {
    console.info(
      '[Engram] Legacy data detected (events lack summary/structured_kv). ' +
      'Clearing engramMemory and vectors to clean state (2026-04-14 migration).',
    );
    const empty = this.createEmpty();
    stateManager.set(this.engramPath, empty, 'system');

    // 异步清空 IDB 向量（fire-and-forget，不阻塞 migration）
    const slot = this.getActiveSlot();
    if (slot?.profileId && slot?.slotId) {
      this.vectorStore
        .deleteForSlot(slot.profileId, slot.slotId)
        .catch((err) =>
          console.warn('[Engram] Failed to clear legacy vectors (non-blocking):', err),
        );
    }

    return empty;
  }

  /**
   * 保留已有事件/实体的 is_embedded 标记
   *
   * trim 后生成的新事件列表中，已存在于 prevEngram 且原本已向量化的，
   * 保持 is_embedded=true；新生成的事件/实体一律 false。
   */
  private preserveEmbeddingFlags(
    events: EngramEventNode[],
    entities: EngramEntity[],
    prev: EngramStateData,
  ): { events: EngramEventNode[]; entities: EngramEntity[] } {
    const prevEventMap = new Map(prev.events.map((e) => [e.id, e.is_embedded]));
    const prevEntityMap = new Map(prev.entities.map((e) => [e.name, e.is_embedded]));
    return {
      events: events.map((e) => ({ ...e, is_embedded: prevEventMap.get(e.id) ?? e.is_embedded })),
      entities: entities.map((e) => ({ ...e, is_embedded: prevEntityMap.get(e.name) ?? e.is_embedded })),
    };
  }

  /**
   * 完整 Trim 策略
   */
  private trimEvents(events: EngramEventNode[], config: EngramTrimConfig): EngramEventNode[] {
    const { trigger, tokenLimit, countLimit, keepRecent } = config;

    const recent = events.slice(-keepRecent);
    const older = events.slice(0, -keepRecent);

    if (trigger === 'count') {
      const budget = Math.max(0, countLimit - recent.length);
      return [...(budget > 0 ? older.slice(-budget) : []), ...recent];
    }

    const recentTokens = recent.reduce((sum, e) => sum + Math.ceil(e.text.length / 4), 0);
    let remaining = tokenLimit - recentTokens;

    const selected: EngramEventNode[] = [];
    for (let i = older.length - 1; i >= 0 && remaining > 0; i--) {
      const cost = Math.ceil(older[i].text.length / 4);
      if (cost <= remaining) {
        selected.unshift(older[i]);
        remaining -= cost;
      }
    }
    return [...selected, ...recent];
  }

  private loadEngram(stateManager: StateManager): EngramStateData {
    const raw = stateManager.get<Partial<EngramStateData>>(this.engramPath);
    if (raw && Array.isArray(raw.events)) {
      return {
        events: raw.events,
        entities: Array.isArray(raw.entities) ? raw.entities : [],
        relations: Array.isArray(raw.relations) ? raw.relations : [],
        v2Edges: Array.isArray(raw.v2Edges) ? raw.v2Edges : [],
        meta: {
          lastUpdated: raw.meta?.lastUpdated ?? 0,
          eventCount: raw.meta?.eventCount ?? raw.events.length,
          embeddedEventCount: raw.meta?.embeddedEventCount ?? 0,
          embeddedEntityCount: raw.meta?.embeddedEntityCount ?? 0,
          schemaVersion: raw.meta?.schemaVersion ?? 1,
          v2PendingReview: raw.meta?.v2PendingReview ?? null,
        },
      };
    }
    return this.createEmpty();
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

  /**
   * 修剪到重点 NPC 相关数据
   */
  private pruneToImportant(
    events: EngramEventNode[],
    entities: EngramEntity[],
    relations: EngramRelation[],
    stateManager: StateManager,
  ): PrunedData {
    const importantNames = this.collectImportantNpcNames(stateManager);
    const playerName = stateManager.get<string>(this.playerNamePath) || '玩家';
    const isRelevant = (name: string): boolean =>
      importantNames.has(name) || name === playerName || name === '玩家' || name === 'player';

    return {
      events: events.filter((e) => {
        const kv = e.structured_kv;
        const rolesRelevant = kv && Array.isArray(kv.role)
          ? kv.role.some((r) => typeof r === 'string' && isRelevant(r))
          : false;
        return (
          !e.subject
          || isRelevant(e.subject)
          || (e.object !== undefined && isRelevant(e.object))
          || rolesRelevant
        );
      }),
      entities: entities.filter((e) => isRelevant(e.name) || e.type === 'location' || e._pendingEnrichment),
      relations: relations.filter((r) => isRelevant(r.fromName) || isRelevant(r.toName)),
    };
  }

  private collectImportantNpcNames(stateManager: StateManager): Set<string> {
    const raw = stateManager.get<NpcRelationshipEntry[]>(this.relationshipsPath);
    const relationships = Array.isArray(raw) ? raw : [];
    const names = new Set<string>();
    for (const npc of relationships) {
      const name = npc[this.npcNameField];
      if (typeof name !== 'string' || !name) continue;
      const npcType = npc[this.npcTypeField];
      if (npcType === '重点' || !npcType) {
        names.add(name);
      }
    }
    return names;
  }

  private createEmpty(): EngramStateData {
    return {
      events: [],
      entities: [],
      relations: [],
      v2Edges: [],
      meta: {
        lastUpdated: 0,
        eventCount: 0,
        embeddedEventCount: 0,
        embeddedEntityCount: 0,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      },
    };
  }

}
