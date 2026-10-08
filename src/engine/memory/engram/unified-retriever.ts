// Architecture: docs/architecture/engram-v2-graphiti-alignment.md
/**
 * 统一检索器 — V2 Graphiti 对齐架构
 *
 * 3 scope × (Cosine + BM25) + RRF + BFS 二次展开
 * 设计文档: engram-v2-graphiti-alignment.md §3.3
 */
import type { StateManager } from '../../core/state-manager';
import type { VectorStore, VectorStoreData } from './vector-store';
import type { Embedder } from './embedder';
import type { Reranker, RerankCandidate } from './reranker';
import type { EngramEventNode } from './event-builder';
import type { EngramEntity } from './entity-builder';
import { isEdgeCurrentlyValid, type EngramEdge } from './knowledge-edge';
import { bm25Score, rrfMerge } from './search-utils';
import type {
  EngramEmbeddingConfig,
  EngramRerankConfig,
  EngramReadSnapshot,
  ScoredCandidateTrace,
  ScoredComponent,
} from './engram-types';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';

// ─── 类型定义 ───

/** 检索时的场景上下文 */
export interface RetrievalContext {
  playerName: string;
  locationDesc: string;
  recentNpcNames: string[];
}

/** Engram 状态数据结构（从状态树读取） */
interface EngramStateData {
  events?: EngramEventNode[];
  entities?: EngramEntity[];
  v2Edges?: EngramEdge[];
  meta?: Record<string, unknown>;
}

/** UnifiedRetriever 配置（来自 EngramConfig 的子集） */
export interface UnifiedRetrieverConfig {
  embedding: EngramEmbeddingConfig;
  rerank: EngramRerankConfig;
  shortTermWindow?: number;
  maxCandidates?: number;
}

/**
 * 调试记录器接口 — 解耦 UnifiedRetriever 与 Pinia store
 *
 * 生产环境注入 useEngramDebugStore()，测试中可注入 mock。
 * 使用接口而非直接导入 engram-debug.ts，避免引擎层依赖 UI store。
 */
export interface IDebugRecorder {
  recordRetrieve(info: {
    vectorCandidateCount: number;
    graphCandidateCount: number;
    afterMergeCount: number;
    afterRerankCount: number;
    rerankUsed: boolean;
    embeddingFallback: boolean;
    topScores: Array<{ text: string; score: number; source: string }>;
  }): void;
  recordReadSnapshot(snapshot: EngramReadSnapshot): void;
}

export class UnifiedRetriever {
  lastReadSnapshot: EngramReadSnapshot | null = null;
  private readonly engramPath: string;
  private readonly roundNumberPath: string;

  constructor(
    private vectorStore: VectorStore,
    private embedder: Embedder,
    private reranker?: Reranker,
    private configOrGetter?: UnifiedRetrieverConfig | (() => UnifiedRetrieverConfig | undefined),
    private debugRecorder?: IDebugRecorder,
    private getActiveSlot?: () => { profileId: string; slotId: string } | null,
    paths?: { engramMemory?: string; roundNumber?: string },
  ) {
    this.engramPath = paths?.engramMemory ?? DEFAULT_ENGINE_PATHS.engramMemory;
    this.roundNumberPath = paths?.roundNumber ?? DEFAULT_ENGINE_PATHS.roundNumber;
  }

  /** 动态读取配置：支持静态对象或 getter 函数（每次调用都读最新值） */
  private get config(): UnifiedRetrieverConfig | undefined {
    if (typeof this.configOrGetter === 'function') return this.configOrGetter();
    return this.configOrGetter;
  }

  /**
   * V2 检索入口 — 3 scope × (Cosine + BM25) + RRF + BFS
   */
  async retrieve(
    query: string,
    context: RetrievalContext,
    stateManager: StateManager,
  ): Promise<string> {
    const retrieveStart = performance.now();
    const engram = stateManager.get<EngramStateData>(this.engramPath);
    if (!engram?.events?.length) return '';

    const events = engram.events;
    const entities = engram.entities ?? [];
    const v2Edges = engram.v2Edges ?? [];
    const currentRound = stateManager.get<number>(this.roundNumberPath) ?? 0;

    return this.retrieveV2(
      query, context, events, entities, v2Edges, currentRound, retrieveStart, stateManager,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  V2 retrieval: 3 scope × (Cosine + BM25) + RRF + BFS
  //  Design doc: engram-v2-graphiti-alignment.md §3.3
  // ═══════════════════════════════════════════════════════════════

  private async retrieveV2(
    query: string,
    context: RetrievalContext,
    events: EngramEventNode[],
    entities: EngramEntity[],
    v2Edges: EngramEdge[],
    currentRound: number,
    retrieveStart: number,
    _stateManager: StateManager,
  ): Promise<string> {
    const topK = this.config?.embedding?.topK ?? 20;
    const minScore = this.config?.embedding?.minScore ?? 0.3;
    const shortTermWindow = this.config?.shortTermWindow ?? 5;
    const maxCandidates = this.config?.maxCandidates ?? 20;
    const embeddingEnabled = this.config?.embedding?.enabled !== false;

    // One embedding call for the query, reused by all scopes
    let queryVec: number[] | null = null;
    let vectorData: VectorStoreData | undefined;
    if (embeddingEnabled) {
      try {
        const slot = this.getActiveSlot?.();
        if (slot?.profileId && slot?.slotId) {
          vectorData = await this.vectorStore.load(slot.profileId, slot.slotId);
        }
        const vecs = await this.embedder.embed([query]);
        queryVec = vecs[0]?.length > 0 ? vecs[0] : null;
      } catch { /* embedding failure → cosine paths produce empty lists */ }
    }

    const validEdges = v2Edges.filter(isEdgeCurrentlyValid);

    // Score tracing: RRF rank contributions per retrieval method
    const bfsHitIds = new Set<string>();
    const rrfContributions = new Map<string, Array<{ method: string; rank: number; contribution: number }>>();

    // ── Scope 1: Edge search (Cosine + BM25 + BFS) ──
    const edgeCosineIds: string[] = [];
    const edgeBm25Ids: string[] = [];

    if (queryVec && vectorData?.edgeVectors) {
      const scored = validEdges
        .map((e) => {
          const vec = vectorData!.edgeVectors[e.id];
          if (!vec) return null;
          return { id: e.id, score: this.vectorStore.cosineSimilarity(queryVec!, vec) };
        })
        .filter((x): x is { id: string; score: number } => x != null && x.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      edgeCosineIds.push(...scored.map((s) => s.id));
    }

    const bm25Scored = validEdges
      .map((e) => ({ id: e.id, score: bm25Score(query, e.fact) }))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    edgeBm25Ids.push(...bm25Scored.map((s) => s.id));

    // BFS expansion from Cosine + BM25 seed entities
    const bfsSeedEntities = new Set<string>();
    const edgeMap = new Map(validEdges.map((e) => [e.id, e]));
    for (const id of [...edgeCosineIds, ...edgeBm25Ids]) {
      const edge = edgeMap.get(id);
      if (edge) {
        bfsSeedEntities.add(edge.sourceEntity);
        bfsSeedEntities.add(edge.targetEntity);
      }
    }
    // Always include player + recent NPCs as seeds
    bfsSeedEntities.add(context.playerName);
    for (const npc of context.recentNpcNames) bfsSeedEntities.add(npc);

    const bfsEdgeIdSet = new Set<string>();
    const cosineAndBm25Set = new Set([...edgeCosineIds, ...edgeBm25Ids]);
    const visited = new Set(bfsSeedEntities);
    let frontier = Array.from(bfsSeedEntities);
    const adjacency = new Map<string, EngramEdge[]>();
    for (const e of validEdges) {
      const addTo = (n: string) => {
        const list = adjacency.get(n);
        if (list) list.push(e); else adjacency.set(n, [e]);
      };
      addTo(e.sourceEntity);
      addTo(e.targetEntity);
    }

    for (let depth = 0; depth < 2; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const edge of (adjacency.get(node) ?? [])) {
          if (!bfsEdgeIdSet.has(edge.id) && !cosineAndBm25Set.has(edge.id)) {
            bfsEdgeIdSet.add(edge.id);
          }
          const neighbor = edge.sourceEntity === node ? edge.targetEntity : edge.sourceEntity;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }

    const bfsEdgeIds = Array.from(bfsEdgeIdSet).slice(0, topK);
    for (const id of bfsEdgeIds) bfsHitIds.add(id);
    const edgeRrf = rrfMerge([edgeCosineIds, edgeBm25Ids, bfsEdgeIds]);
    const edgeMethodNames = ['余弦', 'BM25', '图展开'];
    for (const [li, list] of [edgeCosineIds, edgeBm25Ids, bfsEdgeIds].entries()) {
      for (let r = 0; r < list.length; r++) {
        const c = rrfContributions.get(list[r]) ?? [];
        c.push({ method: edgeMethodNames[li], rank: r + 1, contribution: 1 / (r + 2) });
        rrfContributions.set(list[r], c);
      }
    }
    const edgeBudget = Math.max(1, Math.floor(maxCandidates * 0.5));
    let topEdges = edgeRrf.slice(0, edgeBudget);

    // ── Scope 2: Entity search (Cosine + BM25) ──
    const entityCosineIds: string[] = [];
    const entityBm25Ids: string[] = [];

    if (queryVec && vectorData?.entityVectors) {
      const scored = entities
        .map((e) => {
          const vec = vectorData!.entityVectors[e.name];
          if (!vec) return null;
          return { id: e.name, score: this.vectorStore.cosineSimilarity(queryVec!, vec) };
        })
        .filter((x): x is { id: string; score: number } => x != null && x.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      entityCosineIds.push(...scored.map((s) => s.id));
    }

    const entityBm25 = entities
      .map((e) => ({ id: e.name, score: bm25Score(query, `${e.name} ${e.summary}`) }))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    entityBm25Ids.push(...entityBm25.map((s) => s.id));

    const entityRrf = rrfMerge([entityCosineIds, entityBm25Ids]);
    for (const [li, list] of [entityCosineIds, entityBm25Ids].entries()) {
      const mn = li === 0 ? '余弦' : 'BM25';
      for (let r = 0; r < list.length; r++) {
        const c = rrfContributions.get(list[r]) ?? [];
        c.push({ method: mn, rank: r + 1, contribution: 1 / (r + 2) });
        rrfContributions.set(list[r], c);
      }
    }
    const entityBudget = Math.max(1, Math.floor(maxCandidates * 0.25));
    let topEntities = entityRrf.slice(0, entityBudget);

    // ── Scope 3: Event search (Cosine + BM25) ──
    const searchableEvents = events.filter(
      (e) => e.roundNumber == null || currentRound - e.roundNumber >= shortTermWindow,
    );
    const eventCosineIds: string[] = [];
    const eventBm25Ids: string[] = [];

    if (queryVec && vectorData?.eventVectors) {
      const scored = searchableEvents
        .map((e) => {
          const vec = vectorData!.eventVectors[e.id];
          if (!vec) return null;
          return { id: e.id, score: this.vectorStore.cosineSimilarity(queryVec!, vec) };
        })
        .filter((x): x is { id: string; score: number } => x != null && x.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      eventCosineIds.push(...scored.map((s) => s.id));
    }

    const eventBm25 = searchableEvents
      .map((e) => ({ id: e.id, score: bm25Score(query, e.summary || e.text) }))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    eventBm25Ids.push(...eventBm25.map((s) => s.id));

    const eventRrf = rrfMerge([eventCosineIds, eventBm25Ids]);
    for (const [li, list] of [eventCosineIds, eventBm25Ids].entries()) {
      const mn = li === 0 ? '余弦' : 'BM25';
      for (let r = 0; r < list.length; r++) {
        const c = rrfContributions.get(list[r]) ?? [];
        c.push({ method: mn, rank: r + 1, contribution: 1 / (r + 2) });
        rrfContributions.set(list[r], c);
      }
    }
    const eventBudget = Math.max(1, Math.floor(maxCandidates * 0.25));
    let topEvents = eventRrf.slice(0, eventBudget);

    // Capture pre-rerank counts for snapshot
    const afterMergeCount = topEdges.length + topEntities.length + topEvents.length;

    // ── Optional rerank (blends RRF base score with rerank relevance) ──
    const rerankEnabled = this.config?.rerank?.enabled === true && this.reranker != null;
    const rerankTopN = this.config?.rerank?.topN ?? maxCandidates;
    let rerankUsed = false;
    const rerankScoresMap = new Map<string, number>();

    const entityMap = new Map(entities.map((e) => [e.name, e]));
    const eventMap = new Map(events.map((e) => [e.id, e]));

    const rerankSurvivorIds = new Set<string>();

    if (rerankEnabled && this.reranker && this.reranker.isAvailable()) {
      interface ScopedCandidate extends RerankCandidate { scope: 'edge' | 'entity' | 'event'; originalId: string }
      const allCandidates: ScopedCandidate[] = [];
      for (const te of topEdges) {
        const edge = edgeMap.get(te.id);
        if (edge) allCandidates.push({ text: `[${edge.sourceEntity}→${edge.targetEntity}] ${edge.fact}`, score: te.score, source: 'edge', originalId: te.id, scope: 'edge' });
      }
      for (const te of topEntities) {
        const ent = entityMap.get(te.id);
        if (ent) allCandidates.push({ text: `${ent.name}: ${ent.summary ?? ''}`, score: te.score, source: 'entity', originalId: te.id, scope: 'entity' });
      }
      for (const te of topEvents) {
        const evt = eventMap.get(te.id);
        if (evt) allCandidates.push({ text: (evt.midTermSummary || evt.text).slice(0, 300), score: te.score, source: 'event', originalId: te.id, scope: 'event' });
      }

      try {
        const { results: reranked, actuallyReranked } = await this.reranker.rerank(query, allCandidates, rerankTopN);
        rerankUsed = actuallyReranked;

        if (actuallyReranked) {
          for (const r of reranked) {
            const c = r as ScopedCandidate & { rerankScore: number };
            rerankScoresMap.set(c.originalId, c.rerankScore);
            rerankSurvivorIds.add(c.originalId);
          }
          const filterAndBlend = (items: Array<{ id: string; score: number }>) =>
            items
              .filter((e) => rerankSurvivorIds.has(e.id))
              .map((e) => {
                const rs = rerankScoresMap.get(e.id)!;
                return { ...e, score: e.score * 0.6 + rs * 0.4 };
              })
              .sort((a, b) => b.score - a.score);

          topEdges = filterAndBlend(topEdges);
          topEntities = filterAndBlend(topEntities);
          topEvents = filterAndBlend(topEvents);
        }
      } catch (err) {
        console.warn('[UnifiedRetriever] Rerank failed, using RRF order:', err);
      }
    }

    // ── Format output ──
    const lines: string[] = [];

    const MAX_CHARS = 3000;
    const mentionedEntities = new Set<string>();

    if (topEdges.length > 0) {
      lines.push('相关事实：');
      for (let i = 0; i < topEdges.length; i++) {
        const edge = edgeMap.get(topEdges[i].id);
        if (!edge) continue;
        lines.push(`${i + 1}. [${edge.sourceEntity}→${edge.targetEntity}] ${edge.fact}（第${edge.lastSeenRound}轮）`);
        mentionedEntities.add(edge.sourceEntity);
        mentionedEntities.add(edge.targetEntity);
      }
    }

    const usefulEntities = topEntities.filter((te) => {
      const entity = entityMap.get(te.id);
      return entity && entity.summary && !mentionedEntities.has(entity.name);
    });
    if (usefulEntities.length > 0) {
      lines.push('');
      lines.push('相关角色：');
      for (const te of usefulEntities) {
        const entity = entityMap.get(te.id)!;
        lines.push(`- ${entity.name}：${entity.summary}`);
      }
    }

    if (topEvents.length > 0) {
      lines.push('');
      lines.push('相关事件：');
      for (const te of topEvents) {
        const evt = eventMap.get(te.id);
        if (evt) {
          const text = (evt.midTermSummary || evt.text).slice(0, 150);
          lines.push(`- ${text}（第${evt.roundNumber ?? 0}轮）`);
        }
      }
    }

    // C3: Historical/superseded facts — BM25 match against invalidated edges
    const historicalEdges = v2Edges.filter((e) => !isEdgeCurrentlyValid(e));
    const injectedHistorical: Array<{ edge: EngramEdge; score: number }> = [];
    if (historicalEdges.length > 0) {
      const historicalBm25 = historicalEdges
        .map((e) => ({ edge: e, score: bm25Score(query, e.fact) }))
        .filter((s) => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

      if (historicalBm25.length > 0) {
        lines.push('');
        lines.push('历史事实（已不再成立）：');
        for (const h of historicalBm25) {
          const status = h.edge.temporalStatus === 'superseded' ? '已被取代' : '已失效';
          lines.push(`- [${status}] [${h.edge.sourceEntity}→${h.edge.targetEntity}] ${h.edge.fact}（第${h.edge.invalidAtRound ?? h.edge.invalidatedAtRound ?? '?'}轮失效）`);
          injectedHistorical.push(h);
        }
      }
    }

    let result = lines.join('\n').trim();
    if (result.length > MAX_CHARS) {
      const lastNewline = result.lastIndexOf('\n', MAX_CHARS);
      result = lastNewline > 0 ? result.slice(0, lastNewline) : result.slice(0, MAX_CHARS);
      const resultLines = result.split('\n');
      while (resultLines.length > 0 && resultLines[resultLines.length - 1].trim().endsWith('：')) {
        resultLines.pop();
      }
      result = resultLines.join('\n');
      if (!result.includes('已不再成立')) {
        injectedHistorical.length = 0;
      }
    }

    // Build candidates for debug snapshot — components show RRF rank contributions + rerank
    const buildComponents = (id: string, scope: 'edge' | 'entity' | 'event'): ScoredComponent[] => {
      const comps: ScoredComponent[] = [];
      const contribs = rrfContributions.get(id);
      const rr = rerankScoresMap.get(id);
      const baseWeight = (rerankUsed && rr != null) ? 0.6 : 1;
      if (contribs) {
        const colors: Record<string, ScoredComponent['color']> = { '余弦': 'blue', 'BM25': 'green', '图展开': 'purple' };
        for (const c of contribs) {
          comps.push({
            label: `${scope === 'edge' ? '边' : scope === 'entity' ? '实体' : '事件'}${c.method}`,
            rawValue: c.contribution,
            weight: baseWeight,
            contribution: c.contribution * baseWeight,
            color: colors[c.method] ?? 'gray',
          });
        }
      }
      if (rr != null) {
        comps.push({ label: '精排', rawValue: rr, weight: 0.4, contribution: rr * 0.4, color: 'orange' });
      }
      return comps;
    };

    const candidates: ScoredCandidateTrace[] = [];
    const injectedEntityIds = new Set(usefulEntities.map((te) => te.id));
    const actualInjectedCount = topEdges.length + usefulEntities.length + topEvents.length + injectedHistorical.length;

    const makeRerankFields = (id: string): Pick<ScoredCandidateTrace, 'preRerankScore' | 'rerankBlendedScore'> => {
      const rr = rerankScoresMap.get(id);
      if (!rerankUsed || rr == null) return {};
      const pre = (edgeRrf.find((e) => e.id === id) ?? entityRrf.find((e) => e.id === id) ?? eventRrf.find((e) => e.id === id))?.score;
      return pre != null ? { preRerankScore: pre, rerankBlendedScore: pre * 0.6 + rr * 0.4 } : {};
    };

    for (const te of topEdges) {
      const edge = edgeMap.get(te.id);
      if (edge) candidates.push({
        text: `[${edge.sourceEntity}→${edge.targetEntity}] ${edge.fact}`.slice(0, 150),
        finalScore: te.score, source: 'edge', components: buildComponents(te.id, 'edge'), outcome: 'injected',
        roundNumber: edge.lastSeenRound, ...makeRerankFields(te.id),
      });
    }
    for (const te of topEntities) {
      const entity = entityMap.get(te.id);
      if (entity) candidates.push({
        text: `${entity.name}: ${entity.summary ?? ''}`.slice(0, 150),
        finalScore: te.score, source: 'entity', components: buildComponents(te.id, 'entity'),
        outcome: injectedEntityIds.has(te.id) ? 'injected' : 'filtered-as-redundant',
        entityName: entity.name, ...makeRerankFields(te.id),
      });
    }
    for (const te of topEvents) {
      const evt = eventMap.get(te.id);
      if (evt) candidates.push({
        text: (evt.midTermSummary || evt.text).slice(0, 150),
        finalScore: te.score, source: 'event', components: buildComponents(te.id, 'event'), outcome: 'injected',
        eventId: evt.id, roundNumber: evt.roundNumber, ...makeRerankFields(te.id),
      });
    }

    // Add budget-cut and rerank-filtered candidates to trace
    const topEdgeIds = new Set(topEdges.map((e) => e.id));
    const topEntityIds = new Set(topEntities.map((e) => e.id));
    const topEventIds = new Set(topEvents.map((e) => e.id));

    for (const te of edgeRrf) {
      if (topEdgeIds.has(te.id)) continue;
      const edge = edgeMap.get(te.id);
      if (!edge) continue;
      const outcome: ScoredCandidateTrace['outcome'] = (rerankUsed && !rerankSurvivorIds.has(te.id)) ? 'filtered-by-rerank' : 'filtered-by-topK';
      candidates.push({
        text: `[${edge.sourceEntity}→${edge.targetEntity}] ${edge.fact}`.slice(0, 150),
        finalScore: te.score, source: 'edge', components: buildComponents(te.id, 'edge'), outcome,
        roundNumber: edge.lastSeenRound,
      });
    }
    for (const te of entityRrf) {
      if (topEntityIds.has(te.id)) continue;
      const entity = entityMap.get(te.id);
      if (!entity) continue;
      const outcome: ScoredCandidateTrace['outcome'] = (rerankUsed && !rerankSurvivorIds.has(te.id)) ? 'filtered-by-rerank' : 'filtered-by-topK';
      candidates.push({
        text: `${entity.name}: ${entity.summary ?? ''}`.slice(0, 150),
        finalScore: te.score, source: 'entity', components: buildComponents(te.id, 'entity'), outcome,
        entityName: entity.name,
      });
    }
    for (const te of eventRrf) {
      if (topEventIds.has(te.id)) continue;
      const evt = eventMap.get(te.id);
      if (!evt) continue;
      const outcome: ScoredCandidateTrace['outcome'] = (rerankUsed && !rerankSurvivorIds.has(te.id)) ? 'filtered-by-rerank' : 'filtered-by-topK';
      candidates.push({
        text: (evt.midTermSummary || evt.text).slice(0, 150),
        finalScore: te.score, source: 'event', components: buildComponents(te.id, 'event'), outcome,
        eventId: evt.id, roundNumber: evt.roundNumber,
      });
    }

    for (const h of injectedHistorical) {
      candidates.push({
        text: `[历史] [${h.edge.sourceEntity}→${h.edge.targetEntity}] ${h.edge.fact}`.slice(0, 150),
        finalScore: h.score, source: 'edge', components: [{ label: '历史BM25', rawValue: h.score, weight: 1, contribution: h.score, color: 'gray' }],
        outcome: 'injected', roundNumber: h.edge.invalidAtRound ?? h.edge.invalidatedAtRound,
      });
    }

    const readSnapshot: EngramReadSnapshot = {
      query,
      capturedAt: Date.now(),
      totalDurationMs: performance.now() - retrieveStart,
      candidates,
      pipeline: {
        vectorEventCount: eventCosineIds.length,
        vectorEntityCount: entityCosineIds.length,
        graphCount: edgeCosineIds.length + edgeBm25Ids.length,
        afterMerge: afterMergeCount,
        afterRerank: topEdges.length + topEntities.length + topEvents.length,
        injectedCount: actualInjectedCount,
      },
      config: {
        minScore,
        topK,
        rerankEnabled,
        rerankTopN: rerankUsed ? rerankTopN : 0,
        embeddingEnabled,
        shortTermWindow,
        maxCandidates,
        edgeBudget,
        entityBudget,
        eventBudget,
      },
    };
    this.lastReadSnapshot = readSnapshot;
    this.debugRecorder?.recordReadSnapshot(readSnapshot);

    this.debugRecorder?.recordRetrieve({
      vectorCandidateCount: eventCosineIds.length + entityCosineIds.length,
      graphCandidateCount: edgeCosineIds.length + edgeBm25Ids.length + bfsEdgeIds.length,
      afterMergeCount: afterMergeCount,
      afterRerankCount: topEdges.length + topEntities.length + topEvents.length,
      rerankUsed,
      embeddingFallback: embeddingEnabled && eventCosineIds.length === 0 && entityCosineIds.length === 0,
      topScores: topEdges.slice(0, 5).map((e) => {
        const edge = edgeMap.get(e.id);
        return { text: edge?.fact.slice(0, 80) ?? e.id, score: e.score, source: 'edge' };
      }),
    });

    return result;
  }

}
