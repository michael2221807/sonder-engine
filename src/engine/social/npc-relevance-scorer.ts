// App doc: docs/user-guide/pages/game-main.md §3.8.4 "NPC 上下文过滤区段"
/**
 * NpcRelevanceScorer — Engram-driven NPC relevance filtering
 *
 * Uses Engram recall results (ReadSnapshot) + state-tree data to identify
 * which NPCs are relevant to the current narrative context. Reduces prompt
 * token waste from injecting full dossiers for irrelevant NPCs.
 *
 * Three signals, fused conservatively (any hit = relevant):
 *   Signal 1 — Snapshot recall: NPC names extracted from injected candidates
 *   Signal 2 — Recent player interaction: player↔NPC edges with recent lastSeenRound
 *   Signal 3 — NPC↔NPC graph BFS: 1-hop expansion excluding the player hub node
 *
 * Design doc: docs/design/engram-npc-relevance-filter-plan.md
 */
import type { EngramReadSnapshot, ScoredCandidateTrace } from '../memory/engram/engram-types';
import type { EngramEdge } from '../memory/engram/knowledge-edge';
import type { EngramEntity } from '../memory/engram/entity-builder';

import type { NpcRelevanceConfig } from './npc-relevance-types';
export type { NpcRelevanceConfig } from './npc-relevance-types';

export const DEFAULT_NPC_RELEVANCE_CONFIG: NpcRelevanceConfig = {
  recentRoundWindow: 5,
  bfsHops: 1,
  minNpcCountForFilter: 10,
  playerAliases: [],
};

export interface NpcRelevanceResult {
  relevantNames: Set<string>;
  skipped: boolean;
  signals: {
    fromSnapshot: string[];
    fromRecentActivity: string[];
    fromBfsExpansion: string[];
  };
  /** Per-NPC count of how many distinct signals matched (0-3). */
  npcSignalCounts: Map<string, number>;
}

interface NpcTierEntry { name: string; signals?: string[] }

export interface NpcRelevanceMeta {
  tier1Count: number;
  tier2PresentCount: number;
  tier2AbsentCount: number;
  tier3Count: number;
  totalSaved: number;
  signals: NpcRelevanceResult['signals'];
  tiers: {
    tier1: NpcTierEntry[];
    tier2Present: NpcTierEntry[];
    tier2Absent: NpcTierEntry[];
    tier3: NpcTierEntry[];
  };
}

export class NpcRelevanceScorer {
  constructor(private config: NpcRelevanceConfig = DEFAULT_NPC_RELEVANCE_CONFIG) {}

  score(params: {
    readSnapshot: EngramReadSnapshot | null;
    engramEntities: EngramEntity[];
    engramEdges: EngramEdge[];
    currentRound: number;
    allNpcNames: string[];
    playerName: string;
  }): NpcRelevanceResult {
    const { readSnapshot, engramEntities, engramEdges, currentRound, allNpcNames, playerName } = params;

    const allRelevant: NpcRelevanceResult = {
      relevantNames: new Set(allNpcNames),
      skipped: true,
      signals: { fromSnapshot: [], fromRecentActivity: [], fromBfsExpansion: [] },
      npcSignalCounts: new Map(),
    };

    if (allNpcNames.length < this.config.minNpcCountForFilter) return allRelevant;
    if (!engramEntities.length && !engramEdges.length) return allRelevant;

    const npcNameSet = new Set(allNpcNames);
    const relevantNames = new Set<string>();

    const fromSnapshot = this.extractFromSnapshot(readSnapshot, npcNameSet, playerName);
    for (const name of fromSnapshot) relevantNames.add(name);

    const recentThreshold = currentRound - this.config.recentRoundWindow;
    const fromRecentActivity = this.findRecentPlayerNpcEdges(
      engramEdges, playerName, npcNameSet, recentThreshold,
    );
    for (const name of fromRecentActivity) relevantNames.add(name);

    const fromBfsExpansion = this.bfsExpandExcludingPlayer(
      relevantNames, engramEdges, npcNameSet, playerName, this.config.bfsHops,
    );
    for (const name of fromBfsExpansion) relevantNames.add(name);

    if (relevantNames.size === 0) return allRelevant;

    const npcSignalCounts = new Map<string, number>();
    for (const name of fromSnapshot) {
      npcSignalCounts.set(name, (npcSignalCounts.get(name) ?? 0) + 1);
    }
    for (const name of fromRecentActivity) {
      npcSignalCounts.set(name, (npcSignalCounts.get(name) ?? 0) + 1);
    }
    for (const name of fromBfsExpansion) {
      npcSignalCounts.set(name, (npcSignalCounts.get(name) ?? 0) + 1);
    }

    return {
      relevantNames,
      skipped: false,
      signals: { fromSnapshot, fromRecentActivity, fromBfsExpansion },
      npcSignalCounts,
    };
  }

  private findRecentPlayerNpcEdges(
    edges: EngramEdge[],
    playerName: string,
    npcNameSet: Set<string>,
    recentThreshold: number,
  ): string[] {
    const playerNames = this.buildPlayerNameSet(playerName);
    const names = new Set<string>();

    for (const edge of edges) {
      if (edge.invalidatedAtRound != null || edge.invalidAtRound != null) continue;
      if (edge.lastSeenRound < recentThreshold) continue;

      const srcIsPlayer = playerNames.has(edge.sourceEntity);
      const tgtIsPlayer = playerNames.has(edge.targetEntity);
      if (!srcIsPlayer && !tgtIsPlayer) continue;

      const otherEntity = srcIsPlayer ? edge.targetEntity : edge.sourceEntity;
      if (npcNameSet.has(otherEntity)) names.add(otherEntity);
    }

    return [...names];
  }

  /**
   * Extract NPC names from injected candidates in the ReadSnapshot.
   *
   * For edge candidates: parse `[source→target]` prefix from text field.
   * For entity candidates: use entityName field.
   * For event candidates: not yet supported (needs eventMentionedEntities extension).
   *
   * Only considers candidates with outcome='injected'.
   */
  private extractFromSnapshot(
    snapshot: EngramReadSnapshot | null,
    npcNameSet: Set<string>,
    playerName: string,
  ): string[] {
    if (!snapshot?.candidates) return [];
    const playerNames = this.buildPlayerNameSet(playerName);
    const names = new Set<string>();

    for (const c of snapshot.candidates) {
      if (c.outcome !== 'injected') continue;

      if (c.source === 'edge') {
        const extracted = this.extractEdgeEntities(c, playerNames);
        for (const name of extracted) {
          if (npcNameSet.has(name)) names.add(name);
        }
      } else if (c.source === 'entity') {
        if (c.entityName && npcNameSet.has(c.entityName)) {
          names.add(c.entityName);
        }
      }
      // event candidates: skip for now (no mentionedEntities on trace)
    }

    return [...names];
  }

  private extractEdgeEntities(
    candidate: ScoredCandidateTrace,
    playerNames: Set<string>,
  ): string[] {
    // Try extended fields first (Phase 3 will add these)
    const extended = candidate as ScoredCandidateTrace & {
      edgeSourceEntity?: string;
      edgeTargetEntity?: string;
    };

    if (extended.edgeSourceEntity != null || extended.edgeTargetEntity != null) {
      const result: string[] = [];
      if (extended.edgeSourceEntity && !playerNames.has(extended.edgeSourceEntity)) {
        result.push(extended.edgeSourceEntity);
      }
      if (extended.edgeTargetEntity && !playerNames.has(extended.edgeTargetEntity)) {
        result.push(extended.edgeTargetEntity);
      }
      return result;
    }

    // Fallback: parse from text "[source→target] fact"
    const match = candidate.text.match(/^\[(.+?)→(.+?)\]/);
    if (!match) return [];

    const result: string[] = [];
    if (!playerNames.has(match[1])) result.push(match[1]);
    if (!playerNames.has(match[2])) result.push(match[2]);
    return result;
  }

  /**
   * BFS from seed NPCs along NPC↔NPC edges only.
   * The player node is excluded as both a transit node and from the adjacency
   * graph entirely, preventing hub fan-out.
   */
  private bfsExpandExcludingPlayer(
    seedNames: Set<string>,
    edges: EngramEdge[],
    npcNameSet: Set<string>,
    playerName: string,
    hops: number,
  ): string[] {
    if (seedNames.size === 0 || hops <= 0) return [];

    const playerNames = this.buildPlayerNameSet(playerName);

    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.invalidatedAtRound != null || edge.invalidAtRound != null) continue;
      if (playerNames.has(edge.sourceEntity) || playerNames.has(edge.targetEntity)) continue;

      if (!adjacency.has(edge.sourceEntity)) adjacency.set(edge.sourceEntity, new Set());
      if (!adjacency.has(edge.targetEntity)) adjacency.set(edge.targetEntity, new Set());
      adjacency.get(edge.sourceEntity)!.add(edge.targetEntity);
      adjacency.get(edge.targetEntity)!.add(edge.sourceEntity);
    }

    const visited = new Set(seedNames);
    let frontier = [...seedNames];
    const discovered: string[] = [];

    for (let hop = 0; hop < hops; hop++) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        if (playerNames.has(name)) continue;
        const neighbors = adjacency.get(name);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
            if (npcNameSet.has(neighbor)) discovered.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return discovered;
  }

  private buildPlayerNameSet(playerName: string): Set<string> {
    const set = new Set<string>();
    if (playerName) set.add(playerName);
    for (const alias of this.config.playerAliases ?? []) {
      if (alias) set.add(alias);
    }
    return set;
  }
}
