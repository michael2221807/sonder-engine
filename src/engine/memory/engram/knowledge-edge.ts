/**
 * Engram V2 — Graphiti-aligned edge (fact-bearing)
 * Design doc: docs/architecture/engram-v2-graphiti-alignment.md §3.1
 */

export interface EngramEdge {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  fact: string;
  episodes: string[];
  is_embedded: boolean;
  createdAtRound: number;
  lastSeenRound: number;
  /** @deprecated Use invalidAtRound. Kept as alias for backward compatibility. */
  invalidatedAtRound?: number;
  /** When the engine first learned this fact (defaults to createdAtRound for old edges) */
  learnedAtRound?: number;
  /** When the fact became true in the story, if known */
  validAtRound?: number;
  /** When the fact stopped being true in the story */
  invalidAtRound?: number;
  /** AI confidence score (0-1) */
  confidence?: number;
  /** Edge status for temporal queries */
  temporalStatus?: 'historical' | 'superseded';

  /** D1: 核心设定标记 — 世界设定边 vs 游玩产生边 */
  core?: boolean;

  /**
   * 数据来源标记。
   * undefined = legacy 旧数据 / 主回合 AI 自动生成（迁移时视为 'ai'）
   *
   * `user-canon` — projected from a Canon Capture setting the player marked with a
   * `<设定>` tag. Distinguished from `user` (hand-authored directly in the graph editor)
   * because the world-book entry stays the AUTHORITY: retracting or editing that entry
   * has to be able to find and invalidate exactly the edges it produced.
   */
  source?: 'ai' | 'user' | 'opening' | 'card-import' | 'batch-sync' | 'user-canon';

  /**
   * Id of the captured world-book entry this edge was projected from.
   *
   * The join key for the whole lifecycle: undo / edit / restore in the panel look edges
   * up by this, not by fact text (which changes) or by edge id (which is derived from
   * the fact text and therefore also changes).
   */
  canonEntryId?: string;
}

export function isEdgeCurrentlyValid(edge: EngramEdge): boolean {
  if (edge.temporalStatus === 'historical' || edge.temporalStatus === 'superseded') return false;
  return edge.invalidAtRound == null && edge.invalidatedAtRound == null;
}

export function engramEdgeId(source: string, target: string, fact: string): string {
  const factSlug = fact.toLowerCase().replace(/\s+/g, '').slice(0, 40);
  return `${source.toLowerCase()}|${target.toLowerCase()}|${factSlug}`;
}
