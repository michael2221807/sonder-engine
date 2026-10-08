/**
 * Engram 配置类型定义 — 独立类型文件
 *
 * 从 engram-manager.ts 提取至此，以打破
 * engram-manager.ts ↔ engram-config.ts 的循环导入（CR-8 修复）。
 *
 * 其他文件（engram-config.ts / unified-retriever.ts / 设置 UI 等）
 * 应从本文件导入类型，不再直接依赖 engram-manager.ts 的类型导出。
 */

import type { EngramEventNode } from './event-builder';
import type { EngramEntity } from './entity-builder';
import type { EngramEdge } from './knowledge-edge';

/**
 * Engram 状态 schema 版本 —— 单一事实来源。
 * engram-manager 与 Story 6 卡导入（engram-import）共用，避免魔法数漂移。
 * 注：bump 时 `EngramManager` 会在 solidify 时 `Math.max` 兜底，loadEngram 缺省回退 1。
 */
export const ENGRAM_SCHEMA_VERSION = 5;

/** Default cap on live EngramEdge entries (pruneEdgesV2 + DEFAULT_ENGRAM_CONFIG.edgeCapacity). */
export const EDGE_CAPACITY_DEFAULT = 800;

/** Minimum length of a knowledge-fact sentence (fact-builder pre-filter, editor validation). */
export const MIN_FACT_LENGTH = 10;

/** Engram 检索模式 */
export type EngramRetrievalMode = 'legacy' | 'hybrid';

/** Engram 向量检索配置 */
export interface EngramEmbeddingConfig {
  /** 是否启用向量相似度检索 */
  enabled: boolean;
  /** 向量检索返回的最大候选数量 */
  topK: number;
  /** 向量相似度最低阈值（低于此分数的结果丢弃） */
  minScore: number;
}

/** Engram 重排配置 */
export interface EngramRerankConfig {
  /** 是否启用 Rerank API（启用需要配置 FunctionType.RERANK 的 API） */
  enabled: boolean;
  /** Rerank 后保留的最大条目数 */
  topN: number;
}

/** Engram 修剪策略配置 */
export interface EngramTrimConfig {
  /**
   * 修剪触发方式
   * - 'count'：按事件数量上限修剪
   * - 'token'：按估算 token 数修剪（4字符≈1 token）
   */
  trigger: 'count' | 'token';
  /** token 触发模式下的 token 上限 */
  tokenLimit: number;
  /** count 触发模式下的事件数量上限（同时作为 maxEvents 的语义替代） */
  countLimit: number;
  /** 无论修剪多激进，始终保留最近 N 条事件 */
  keepRecent: number;
}

/**
 * Engram 子系统完整配置
 *
 * 设计原则：新增字段均提供合理默认值（通过 DEFAULT_ENGRAM_CONFIG），
 * 保证从旧版 config 对象升级时不会因缺字段而报错（配合 normalizeEngramConfig 使用）。
 */
export interface EngramConfig {
  /** 是否启用 Engram（关闭后完全跳过所有处理） */
  enabled: boolean;
  /**
   * 检索模式
   * - 'legacy'：仅使用传统关键词+时间衰减检索（memory-retriever）
   * - 'hybrid'：向量检索 + 图遍历 + 语义三元组 + NPC 位置规则（unified-retriever）
   */
  retrievalMode: EngramRetrievalMode;
  /** 向量检索配置（retrievalMode='hybrid' 时生效） */
  embedding: EngramEmbeddingConfig;
  /** Rerank 配置（需要独立的 FunctionType.RERANK API 分配） */
  rerank: EngramRerankConfig;
  /** 修剪策略 */
  trim: EngramTrimConfig;
  /**
   * 事件节点最大保留数量（count trigger 时与 trim.countLimit 同义）
   * @deprecated 请使用 trim.countLimit；本字段保留以兼容 E.2 之前的逻辑
   */
  maxEvents: number;
  /** 实体节点最大保留数量 */
  maxEntities: number;
  /** 是否只保留与重点 NPC 相关的数据（减少噪音） */
  pruneToImportantNpcs: boolean;
  /**
   * Embedding 提供商标识（对应 AIService 的 API 配置）
   * E.3 阶段接入 FunctionType.EMBEDDING 后此字段由 APIAssignment 管理。
   */
  embeddingProvider?: string;
  /** Embedding 模型名（用于检测模型变更时清空旧向量） */
  embeddingModel?: string;
  /** 是否开启 debug 模式（开启后 EngramDebugPanel 可见） */
  debug: boolean;
  /** 事实边系统: 'off' = 不构建边, 'active' = V2 Graphiti 边 */
  knowledgeEdgeMode: 'off' | 'active';
  /** Recency decay base per round (default 0.997, half-life ~230 rounds) */
  recencyDecayBase?: number;
  /** Minimum recency score floor (default 0.05) */
  recencyDecayFloor?: number;
  /** Maximum number of EngramEdge entries (default 800) */
  edgeCapacity?: number;
  /** Rounds to exclude from event retrieval (overlap with short-term memory, default 5) */
  shortTermWindow?: number;
  /** Maximum candidate count per retrieval (split 50/25/25 across edge/entity/event, default 20) */
  maxCandidates?: number;
  /** Minimum cosine similarity for an existing edge to be flagged for contradiction review (default 0.65) */
  edgeReviewThreshold?: number;
  /** Maximum old edges matched per new fact during review candidate selection (default 5) */
  edgeReviewPerFactCap?: number;
  /** Maximum total review pairs sent to AI per combine-repair round (default 40) */
  edgeReviewGlobalCap?: number;
  /** NPC relevance filter: tiers NPC prompt injection by Engram relevance to reduce token waste */
  npcRelevanceFilter?: import('../../social/npc-relevance-types').NpcRelevanceConfig & { enabled: boolean };
}

/**
 * Engram 默认配置
 *
 * 生产环境建议从此对象出发，通过 normalizeEngramConfig() 合并用户设置。
 * enabled 默认关闭，需要用户在 Settings → Engram 中显式开启。
 */
// ═══════════════════════════════════════════════════════════════
//  Per-round Engram visualization snapshots
// ═══════════════════════════════════════════════════════════════

/** 单个评分分量——描述一条记忆为什么得了这个分的一个因素 */
export interface ScoredComponent {
  /** 人话标签 */
  label: string;
  /** 原始值 (0-1) */
  rawValue: number;
  /** 该分量在公式中的有效权重 */
  weight: number;
  /** rawValue × weight = 对最终得分的贡献 */
  contribution: number;
  /** UI 颜色提示 */
  color: 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'gray';
}

/** 一条候选记忆的完整评分档案 */
export interface ScoredCandidateTrace {
  /** 记忆文本（截断到 150 字） */
  text: string;
  /** 最终得分 */
  finalScore: number;
  /** 召回来源 scope（V2: edge/entity/event 三路，RRF 融合后） */
  source: 'edge' | 'entity' | 'event';
  /** 评分分量分解 */
  components: ScoredComponent[];
  /** 重排后的混合分数（base×0.6 + rerankScore×0.4），仅重排生效时有值 */
  rerankBlendedScore?: number;
  /** 重排前的 RRF 分数 */
  preRerankScore?: number;
  /**
   * 最终是注入还是淘汰。
   * 注意：低于 minScore 的候选在 vectorSearch 内部就被丢弃，不会进入 trace 列表。
   */
  outcome: 'injected' | 'filtered-by-topK' | 'filtered-by-rerank' | 'filtered-as-redundant';
  /** 溯源 */
  eventId?: string;
  entityName?: string;
  roundNumber?: number;
}

/** 写入路径——单个事件提取快照 */
export interface EngramWriteEventDetail {
  eventId: string;
  title: string;
  roles: string[];
  location: string[];
  timeAnchor: string;
}

/** 写入路径——实体变化记录 */
export interface EngramWriteEntityDelta {
  name: string;
  type: string;
  isNew: boolean;
  descriptionUpdated: boolean;
  mentionCount: number;
}

/** 关系边 — 知识图谱中连接两个实体的有向边（V1 legacy，V2 不再构建新边） */
export interface EngramRelation {
  fromName: string;
  toName: string;
  type: string;
  label: string;
  weight: number;
  lastUpdated: number;
  sourceEventId?: string;
}

/** @deprecated V2 不再构建关系边 — 保留仅为 EngramWriteSnapshot 结构兼容 */
export interface EngramWriteRelationDelta {
  from: string;
  to: string;
  type: string;
  isNew: boolean;
  weight: number;
}

/** 写入路径——事实边变化记录（V2 Graphiti） */
export interface EngramWriteEdgeDelta {
  sourceEntity: string;
  targetEntity: string;
  fact: string;
  episodeCount: number;
  isNew: boolean;
}

/** 写入路径——完整快照 */
export interface EngramWriteSnapshot {
  roundNumber: number;
  capturedAt: number;
  totalDurationMs: number;
  event: EngramWriteEventDetail | null;
  entities: {
    total: number;
    deltas: EngramWriteEntityDelta[];
  };
  relations: {
    total: number;
    deltas: EngramWriteRelationDelta[];
  };
  /** V2 快照版本（2 = Graphiti alignment） */
  snapshotVersion: 2;
  trimmed: {
    eventsBefore: number;
    eventsAfter: number;
    entitiesBefore: number;
    entitiesAfter: number;
  };
  vectorizeQueued: number;
  /** Edge review results (from FieldRepairPipeline combined step) */
  reviewResult?: {
    reviewed: number;
    invalidated: number;
    kept: number;
    invalidatedEdges?: Array<{ edgeId: string; fact: string; reason: string }>;
    keptEdges?: Array<{ edgeId: string; fact: string; reason: string }>;
  };
  /** 事实边统计（V2 Graphiti） */
  edges?: {
    total: number;
    newCount: number;
    reinforcedCount: number;
    prunedCount: number;
    topNew: EngramWriteEdgeDelta[];
  };
}

/** 读取路径——完整快照（以候选列表为核心） */
export interface EngramReadSnapshot {
  query: string;
  capturedAt: number;
  totalDurationMs: number;
  /** 所有参与过评分的候选（含被淘汰的） */
  candidates: ScoredCandidateTrace[];
  /** 管线统计 */
  pipeline: {
    vectorEventCount: number;
    vectorEntityCount: number;
    graphCount: number;
    afterMerge: number;
    afterRerank: number;
    injectedCount: number;
  };
  /** 当时的检索配置 */
  config: {
    minScore: number;
    topK: number;
    rerankEnabled: boolean;
    rerankTopN: number;
    embeddingEnabled: boolean;
    shortTermWindow: number;
    maxCandidates: number;
    edgeBudget: number;
    entityBudget: number;
    eventBudget: number;
  };
}

export const DEFAULT_ENGRAM_CONFIG: EngramConfig = {
  enabled: false,
  retrievalMode: 'hybrid',
  embedding: {
    enabled: true,
    topK: 20,
    minScore: 0.3,
  },
  rerank: {
    enabled: false,
    topN: 10,
  },
  trim: {
    trigger: 'count',
    tokenLimit: 6000,
    countLimit: 120,
    keepRecent: 20,
  },
  maxEvents: 120,
  maxEntities: 60,
  pruneToImportantNpcs: true,
  embeddingProvider: undefined,
  embeddingModel: undefined,
  debug: false,
  knowledgeEdgeMode: 'off',
  recencyDecayBase: 0.997,
  recencyDecayFloor: 0.05,
  edgeCapacity: EDGE_CAPACITY_DEFAULT,
  shortTermWindow: 5,
  maxCandidates: 20,
  edgeReviewThreshold: 0.65,
  edgeReviewPerFactCap: 5,
  edgeReviewGlobalCap: 40,
};

/**
 * Engram 状态数据结构
 * 存储在状态树 "系统.扩展.engramMemory" 路径下（manager / editor 共用）。
 */
export interface EngramStateData {
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

/**
 * Normalize a raw engramMemory block read from the state tree.
 *
 * Returns the normalized block when raw is an object with an events array, otherwise
 * null - each caller supplies its own empty structure (the manager's has no
 * v2PendingReview key, the editor's has v2PendingReview: null; the persisted shapes differ,
 * so the two empties are intentionally NOT shared).
 */
export function normalizeEngramBlock(rawValue: unknown): EngramStateData | null {
  const raw =
    rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
      ? (rawValue as Partial<EngramStateData>)
      : undefined;
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
  return null;
}

/**
 * Normalize location data - 世界.地点信息 can be an Array or Record<id, LocationItem>.
 * Production data is an array; Record shape supported for legacy compatibility.
 */
export function normalizeLocationRecords(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(x => x && typeof x === 'object');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.values(raw as Record<string, unknown>)
      .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v));
  }
  return [];
}
