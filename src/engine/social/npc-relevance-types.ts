/**
 * NPC relevance filter — config type.
 *
 * Zero-import leaf: lives apart from npc-relevance-scorer.ts so that
 * memory/engram/engram-types.ts (the Engram config) can embed it without
 * importing the social layer back (the scorer imports engram-types for its snapshot types).
 */
export interface NpcRelevanceConfig {
  /** Signal 2: rounds within which a player↔NPC edge counts as "recent" */
  recentRoundWindow: number;
  /** Signal 3: BFS hop count along NPC↔NPC edges */
  bfsHops: number;
  /** Skip filtering entirely when total NPC count is below this */
  minNpcCountForFilter: number;
  /** Additional player name aliases to exclude from BFS (pack-specific, e.g. ['玩家']) */
  playerAliases?: string[];
}
