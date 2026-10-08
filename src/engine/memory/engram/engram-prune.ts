/**
 * Engram write-time pruning — moved out of engram-manager.ts (R6 step 7).
 *
 * Pure functions over the state tree: the NPC-importance filter (key NPCs +
 * the player) and the event trim strategy. The manager supplies its configured
 * paths / field names through {@link ImportantNpcScope}.
 */
import type { StateManager } from '../../core/state-manager';
import type { EngramEventNode } from './event-builder';
import type { EngramEntity } from './entity-builder';
import type { EngramEdge } from './knowledge-edge';
import type { EngramRelation, EngramTrimConfig } from './engram-types';

/** 修剪后的数据集 */
export interface PrunedData {
  events: EngramEventNode[];
  entities: EngramEntity[];
  relations: EngramRelation[];
}

type NpcRelationshipEntry = Record<string, unknown>;

/** The manager's configured paths / field names the importance filter reads. */
export interface ImportantNpcScope {
  relationshipsPath: string;
  playerNamePath: string;
  npcNameField: string;
  npcTypeField: string;
  /** The NPC type that counts as key (重点); an NPC of this type or with no type is always kept. */
  npcTypeKey: string;
}

/**
 * 完整 Trim 策略
 */
export function trimEvents(events: EngramEventNode[], config: EngramTrimConfig): EngramEventNode[] {
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

/**
 * 修剪到重点 NPC 相关数据
 */
export function pruneToImportant(
  events: EngramEventNode[],
  entities: EngramEntity[],
  relations: EngramRelation[],
  stateManager: StateManager,
  scope: ImportantNpcScope,
): PrunedData {
  const importantNames = collectImportantNpcNames(stateManager, scope);
  const playerName = stateManager.get<string>(scope.playerNamePath) || '玩家';
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

/**
 * Apply the NPC importance filter to V2 edges (episodes >= 3 exempt).
 * Note the relevance test here deliberately has no `'player'` alias, unlike {@link pruneToImportant}.
 */
export function pruneEdgesToImportant(
  edges: EngramEdge[],
  stateManager: StateManager,
  scope: ImportantNpcScope,
): EngramEdge[] {
  const importantNames = collectImportantNpcNames(stateManager, scope);
  const playerName = stateManager.get<string>(scope.playerNamePath) || '玩家';
  const isRelevant = (n: string) => importantNames.has(n) || n === playerName || n === '玩家';

  return edges.filter((e) =>
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

export function collectImportantNpcNames(stateManager: StateManager, scope: ImportantNpcScope): Set<string> {
  const raw = stateManager.get<NpcRelationshipEntry[]>(scope.relationshipsPath);
  const relationships = Array.isArray(raw) ? raw : [];
  const names = new Set<string>();
  for (const npc of relationships) {
    const name = npc[scope.npcNameField];
    if (typeof name !== 'string' || !name) continue;
    const npcType = npc[scope.npcTypeField];
    if (npcType === scope.npcTypeKey || !npcType) {
      names.add(name);
    }
  }
  return names;
}
