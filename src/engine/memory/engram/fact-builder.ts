// Architecture: docs/architecture/engram-v2-graphiti-alignment.md
/**
 * FactBuilder — V2 knowledge fact extraction, validation, and dedup.
 *
 * Replaces KnowledgeEdgeBuilder for Engram V2 (Graphiti alignment).
 * Each fact is a complete natural-language sentence connecting two entities.
 *
 * Design doc: docs/architecture/engram-v2-graphiti-alignment.md §3.2.4
 */
import type { EngramEdge } from './knowledge-edge';
import { engramEdgeId, isEdgeCurrentlyValid } from './knowledge-edge';
import type { EngramEntity } from './entity-builder';
import { isSentenceLikeName } from './entity-builder';
import { EDGE_CAPACITY_DEFAULT, MIN_FACT_LENGTH } from './engram-types';
import type { VectorStore } from './vector-store';

/**
 * Where a single fact came from.
 *
 * Per-FACT rather than per-batch: one `processResponse()` call can carry both the main
 * model's `knowledge_facts` (source `ai`, not core) and Canon Capture projections
 * (source `user-canon`, core, exempt from the length filter). The batch-level
 * `defaultCore` / `defaultSource` options cannot express that difference, so anything
 * with its own provenance carries it here and wins over the defaults.
 */
interface FactProvenance {
  source: EngramEdge['source'];
  core?: boolean;
  canonEntryId?: string;
  /**
   * Skip the minimum-length pre-filter.
   *
   * That filter exists to drop fragments the MODEL guessed at. A canon fact is a
   * sentence the PLAYER wrote inside a `<设定>` tag and the engine already proved
   * against the original text — and it is often short ("林月是玩家的妹妹" is 8
   * characters), so applying a heuristic meant for model noise would silently discard
   * exactly the facts with the strongest evidence behind them.
   */
  exemptFromLengthFilter?: boolean;
}

export interface KnowledgeFact {
  fact: string;
  sourceEntity: string;
  targetEntity: string;
  /** Absent → the batch defaults apply (ordinary AI-produced facts). */
  provenance?: FactProvenance;
}

export interface FactBuilderParams {
  knowledgeFacts: KnowledgeFact[];
  entities: EngramEntity[];
  currentEventId: string | null;
  currentRound: number;
}

export interface FactBuildResult {
  newEdges: EngramEdge[];
  reinforcedIds: string[];
  pendingReviewPairs: Array<{ newFact: string; oldEdgeId: string; similarity: number }>;
  renamedEdgeIds: Array<{ oldId: string; newId: string }>;
}

export interface FactBuilderOptions {
  reviewThreshold?: number;
  perFactCap?: number;
  defaultCore?: boolean;
  defaultSource?: EngramEdge['source'];
}

/**
 * Promote an existing edge when the same fact arrives with stronger provenance.
 *
 * The main model and Canon Capture can produce the SAME fact in one round: the model
 * notices "林月是玩家的妹妹" from the narrative while the player also marks it. Creating
 * two edges would double-count it in retrieval, and leaving the AI-sourced one alone
 * would strand the world-book entry with no edge to invalidate when it is undone.
 * Merging upward keeps one edge that the panel can still find by `canonEntryId`.
 *
 * Only ever upgrades — an ordinary AI re-mention must never downgrade a canon edge.
 */
function upgradeProvenance(edge: EngramEdge, provenance?: FactProvenance): void {
  if (!provenance) return;
  if (provenance.source === 'user-canon') {
    edge.source = 'user-canon';
    // Never steal ownership from a DIFFERENT captured entry. Two entries that happen to
    // produce near-identical facts would otherwise fight over this field, and the loser's
    // `findCanonEdges` would silently return nothing forever — making its undo a no-op.
    // First claim wins; the second entry simply has no edge of its own, which is the
    // honest outcome for a duplicate.
    if (!edge.canonEntryId) edge.canonEntryId = provenance.canonEntryId;
  }
  if (provenance.core) edge.core = true;
}

/** Mutable working state shared by the per-fact steps of {@link buildFacts}. */
interface BuildContext {
  existingEdges: EngramEdge[];
  edgeVectors: Record<string, number[]>;
  newFactVectors: Map<string, number[]>;
  options?: FactBuilderOptions;
  entityNames: Set<string>;
  currentEventId: string | null;
  currentRound: number;
  reviewThreshold: number;
  perFactCap: number;
  edgeMap: Map<string, EngramEdge>;
  newEdges: EngramEdge[];
  reinforcedIds: string[];
  pendingReviewPairs: FactBuildResult['pendingReviewPairs'];
  renamedEdgeIds: FactBuildResult['renamedEdgeIds'];
  reviewedEdgeIds: Set<string>;
}

export function buildFacts(
  params: FactBuilderParams,
  existingEdges: EngramEdge[],
  vectorStore: VectorStore | null,
  edgeVectors: Record<string, number[]>,
  newFactVectors: Map<string, number[]>,
  options?: FactBuilderOptions,
): FactBuildResult {
  const { knowledgeFacts, entities, currentEventId, currentRound } = params;
  const ctx: BuildContext = {
    existingEdges,
    edgeVectors,
    newFactVectors,
    options,
    entityNames: new Set(entities.map((e) => e.name)),
    currentEventId,
    currentRound,
    reviewThreshold: options?.reviewThreshold ?? 0.65,
    perFactCap: options?.perFactCap ?? 5,
    edgeMap: new Map(existingEdges.map((e) => [e.id, e])),
    newEdges: [],
    reinforcedIds: [],
    pendingReviewPairs: [],
    renamedEdgeIds: [],
    reviewedEdgeIds: new Set<string>(),
  };

  for (const kf of knowledgeFacts) {
    // Step 1: Pre-filter
    if (!passesPreFilter(kf, ctx)) continue;

    const id = engramEdgeId(kf.sourceEntity, kf.targetEntity, kf.fact);

    // Step 2: Exact dedup
    if (reinforceExactDuplicate(kf, id, ctx)) continue;

    const newVec = ctx.newFactVectors.get(kf.fact);
    if (newVec && vectorStore) {
      // Step 3: Same-entity-pair semantic dedup
      if (dedupSameEntityPair(kf, newVec, vectorStore, ctx)) continue;

      // Step 4: Broader semantic search (all edges, not just same entity pair) — top-10 cap
      flagBroadReviewCandidates(kf, newVec, vectorStore, ctx);

      // Step 4.5: Intra-round dedup — check against edges created earlier THIS round
      if (dedupIntraRound(kf, newVec, vectorStore, ctx)) continue;
    }

    // Step 5: Create new edge
    ctx.newEdges.push({
      id,
      sourceEntity: kf.sourceEntity,
      targetEntity: kf.targetEntity,
      fact: kf.fact,
      episodes: currentEventId ? [currentEventId] : [],
      is_embedded: false,
      createdAtRound: currentRound,
      lastSeenRound: currentRound,
      learnedAtRound: currentRound,
      // Per-fact provenance wins over the batch defaults so a mixed batch stays honest.
      core: kf.provenance?.core ?? options?.defaultCore,
      source: kf.provenance?.source ?? options?.defaultSource,
      canonEntryId: kf.provenance?.canonEntryId,
    });
  }

  return {
    newEdges: ctx.newEdges,
    reinforcedIds: ctx.reinforcedIds,
    pendingReviewPairs: ctx.pendingReviewPairs,
    renamedEdgeIds: ctx.renamedEdgeIds,
  };
}

/** Step 1: false when the fact is dropped before any dedup. */
function passesPreFilter(kf: KnowledgeFact, ctx: BuildContext): boolean {
  const { entityNames } = ctx;
  if (kf.fact.length < MIN_FACT_LENGTH && !kf.provenance?.exemptFromLengthFilter) return false;
  // Both entities unknown → reject
  if (!entityNames.has(kf.sourceEntity) && !entityNames.has(kf.targetEntity)) return false;
  // Reject descriptive phrases masquerading as entity names
  // Heuristic: unknown entity + contains sentence-like markers (commas, verbs, particles)
  if (!entityNames.has(kf.sourceEntity) && isSentenceLikeName(kf.sourceEntity)) return false;
  if (!entityNames.has(kf.targetEntity) && isSentenceLikeName(kf.targetEntity)) return false;
  return true;
}

/** Step 2: same id already exists → reinforce it. Returns true when handled. */
function reinforceExactDuplicate(kf: KnowledgeFact, id: string, ctx: BuildContext): boolean {
  const { edgeMap, currentEventId, currentRound, reinforcedIds } = ctx;
  const existing = edgeMap.get(id);
  if (!existing) return false;
  if (currentEventId && !existing.episodes.includes(currentEventId)) {
    existing.episodes.push(currentEventId);
  }
  existing.lastSeenRound = currentRound;
  if (!isEdgeCurrentlyValid(existing)) {
    existing.invalidatedAtRound = undefined;
    existing.invalidAtRound = undefined;
    existing.temporalStatus = undefined;
  }
  upgradeProvenance(existing, kf.provenance);
  reinforcedIds.push(id);
  return true;
}

/** Step 3: >0.85 on a same-entity-pair edge → duplicate (true); >reviewThreshold → queue a review pair. */
function dedupSameEntityPair(
  kf: KnowledgeFact,
  newVec: number[],
  vectorStore: VectorStore,
  ctx: BuildContext,
): boolean {
  const {
    existingEdges, edgeVectors, edgeMap, currentEventId, currentRound,
    reviewThreshold, renamedEdgeIds, reinforcedIds, pendingReviewPairs, reviewedEdgeIds,
  } = ctx;
  const srcLower = kf.sourceEntity.toLowerCase();
  const tgtLower = kf.targetEntity.toLowerCase();

  for (const edge of existingEdges) {
    if (!isEdgeCurrentlyValid(edge)) continue;
    const eSrc = edge.sourceEntity.toLowerCase();
    const eTgt = edge.targetEntity.toLowerCase();
    const sameEntityPair = (eSrc === srcLower && eTgt === tgtLower) || (eSrc === tgtLower && eTgt === srcLower);
    if (!sameEntityPair) continue;

    const oldVec = edgeVectors[edge.id];
    if (!oldVec) continue;

    const sim = vectorStore.cosineSimilarity(newVec, oldVec);
    if (sim > 0.85) {
      // Duplicate — reinforce existing, use longer fact text
      if (kf.fact.length > edge.fact.length) {
        const oldId = edge.id;
        edge.fact = kf.fact;
        edge.id = engramEdgeId(edge.sourceEntity, edge.targetEntity, edge.fact);
        edge.is_embedded = false;
        edgeMap.delete(oldId);
        edgeMap.set(edge.id, edge);
        renamedEdgeIds.push({ oldId, newId: edge.id });
        delete edgeVectors[oldId];
      }
      if (currentEventId && !edge.episodes.includes(currentEventId)) {
        edge.episodes.push(currentEventId);
      }
      edge.lastSeenRound = currentRound;
      upgradeProvenance(edge, kf.provenance);
      reinforcedIds.push(edge.id);
      return true;
    } else if (sim > reviewThreshold) {
      if (!reviewedEdgeIds.has(edge.id)) {
        pendingReviewPairs.push({ newFact: kf.fact, oldEdgeId: edge.id, similarity: sim });
        reviewedEdgeIds.add(edge.id);
      }
    }
  }
  return false;
}

/** Step 4: similar edges on OTHER entity pairs become review candidates (top perFactCap). */
function flagBroadReviewCandidates(
  kf: KnowledgeFact,
  newVec: number[],
  vectorStore: VectorStore,
  ctx: BuildContext,
): void {
  const { existingEdges, edgeVectors, reviewThreshold, perFactCap, pendingReviewPairs, reviewedEdgeIds } = ctx;
  const broadCandidates: Array<{ edgeId: string; sim: number }> = [];
  for (const edge of existingEdges) {
    if (!isEdgeCurrentlyValid(edge)) continue;
    const oldVec = edgeVectors[edge.id];
    if (!oldVec) continue;
    const srcLower = kf.sourceEntity.toLowerCase();
    const tgtLower = kf.targetEntity.toLowerCase();
    const eSrc = edge.sourceEntity.toLowerCase();
    const eTgt = edge.targetEntity.toLowerCase();
    if ((eSrc === srcLower && eTgt === tgtLower) || (eSrc === tgtLower && eTgt === srcLower)) continue;

    const sim = vectorStore.cosineSimilarity(newVec, oldVec);
    if (sim > reviewThreshold) {
      broadCandidates.push({ edgeId: edge.id, sim });
    }
  }
  broadCandidates.sort((a, b) => b.sim - a.sim);
  for (const bc of broadCandidates.slice(0, perFactCap)) {
    if (!reviewedEdgeIds.has(bc.edgeId)) {
      pendingReviewPairs.push({ newFact: kf.fact, oldEdgeId: bc.edgeId, similarity: bc.sim });
      reviewedEdgeIds.add(bc.edgeId);
    }
  }
}

/** Step 4.5: >0.85 against an edge created earlier THIS call → merge into it (true). */
function dedupIntraRound(
  kf: KnowledgeFact,
  newVec: number[],
  vectorStore: VectorStore,
  ctx: BuildContext,
): boolean {
  const { newEdges, newFactVectors, currentEventId, reinforcedIds } = ctx;
  for (const ne of newEdges) {
    const neVec = newFactVectors.get(ne.fact);
    if (!neVec) continue;
    const sim = vectorStore.cosineSimilarity(newVec, neVec);
    if (sim > 0.85) {
      if (kf.fact.length > ne.fact.length) {
        ne.fact = kf.fact;
        ne.id = engramEdgeId(ne.sourceEntity, ne.targetEntity, ne.fact);
        ne.is_embedded = false;
      }
      if (currentEventId && !ne.episodes.includes(currentEventId)) {
        ne.episodes.push(currentEventId);
      }
      // MUST upgrade here too, not just in Steps 2 and 3. This is the branch a
      // captured fact takes when it dedupes against an edge the MAIN MODEL created
      // earlier in the SAME call — which is the normal shape, since the round's AI
      // facts and canon facts go through one `buildFacts()`. Skipping it leaves the
      // surviving edge with `canonEntryId: undefined`, and then the entry can never
      // be found for retraction and its status chip is stuck on "not in the graph yet"
      // forever.
      upgradeProvenance(ne, kf.provenance);
      reinforcedIds.push(ne.id);
      return true;
    }
  }
  return false;
}

export function pruneEdgesV2(
  edges: EngramEdge[],
  currentRound: number,
  capacity: number = EDGE_CAPACITY_DEFAULT,
): EngramEdge[] {
  // Invalidated edges decay faster
  const scored = edges.map((e) => {
    const age = Math.max(0, currentRound - e.lastSeenRound);
    const isInvalidated = !isEdgeCurrentlyValid(e);
    const decayRate = isInvalidated ? 0.9 : 0.97;
    const invalidPenalty = isInvalidated ? 0.3 : 1.0;
    const score = Math.pow(decayRate, age / 10) * (e.episodes.length > 1 ? 1.2 : 1.0) * invalidPenalty;
    return { edge: e, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, capacity).map((s) => s.edge);
}
