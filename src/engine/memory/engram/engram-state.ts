/**
 * Engram state-block helpers — moved out of engram-manager.ts (R6 step 7).
 *
 * Load / empty / legacy-detection / schema-migration / embedding-flag preservation for the
 * engramMemory block. The manager owns the paths and the vector store and passes them in.
 */
import type { StateManager } from '../../core/state-manager';
import type { EngramEventNode } from './event-builder';
import type { EngramEntity } from './entity-builder';
import type { VectorStore } from './vector-store';
import { ENGRAM_SCHEMA_VERSION, normalizeEngramBlock } from './engram-types';
import type { EngramStateData } from './engram-types';

/** Empty block. NOTE: no `v2PendingReview` key (the editor's empty block has one; do not share). */
export function createEmptyEngram(): EngramStateData {
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
      schemaVersion: ENGRAM_SCHEMA_VERSION,
    },
  };
}

export function loadEngramBlock(stateManager: StateManager, engramPath: string): EngramStateData {
  return normalizeEngramBlock(stateManager.get<unknown>(engramPath)) ?? createEmptyEngram();
}

// ─── Legacy migration（A8） ───

/**
 * 检测旧版本 events —— 缺 `summary` 字段或 `structured_kv` 对象
 * 返回 true 表示需要清空 engramMemory 并重新开始（clean state）
 */
export function isLegacyEngramData(engram: EngramStateData): boolean {
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
export function migrateLegacyEngram(
  stateManager: StateManager,
  engramPath: string,
  vectorStore: VectorStore,
  getActiveSlot: () => { profileId: string; slotId: string } | null,
): EngramStateData {
  console.info(
    '[Engram] Legacy data detected (events lack summary/structured_kv). ' +
    'Clearing engramMemory and vectors to clean state (2026-04-14 migration).',
  );
  const empty = createEmptyEngram();
  stateManager.set(engramPath, empty, 'system');

  // 异步清空 IDB 向量（fire-and-forget，不阻塞 migration）
  const slot = getActiveSlot();
  if (slot?.profileId && slot?.slotId) {
    vectorStore
      .deleteForSlot(slot.profileId, slot.slotId)
      .catch((err) =>
        console.warn('[Engram] Failed to clear legacy vectors (non-blocking):', err),
      );
  }

  return empty;
}

/** V2 Graphiti schema steps (v4: v2Edges exists; v5: temporal fields). Mutates `engram`. */
export function migrateEngramSchema(engram: EngramStateData): void {
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
}

/**
 * 保留已有事件/实体的 is_embedded 标记
 *
 * trim 后生成的新事件列表中，已存在于 prevEngram 且原本已向量化的，
 * 保持 is_embedded=true；新生成的事件/实体一律 false。
 */
export function preserveEmbeddingFlags(
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
