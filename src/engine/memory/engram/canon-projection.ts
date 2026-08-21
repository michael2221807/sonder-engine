// App doc: docs/user-guide/pages/game-prompts.md §4.8.1
/**
 * Canon Capture → Engram projection.
 *
 * The world book is the AUTHORITY for captured settings; the graph is a projection that
 * exists only to make relationships retrievable semantically. That asymmetry decides
 * every rule here:
 *
 * - only `relationship` settings project at all — a character trait ("林月怕水") has one
 *   entity, and inventing a second ("林月的性格") to satisfy the edge shape would put a
 *   fake node in the graph that retrieval would then happily return;
 * - a projection failure is never fatal, because the setting still works via the world
 *   book;
 * - retraction invalidates rather than deletes, so the row stays auditable and a later
 *   restore has something to find.
 *
 * Design: `docs/design/canon-ledger-setting-capture.md` §8.
 */
import type { EngramEdge } from './knowledge-edge';
import { isEdgeCurrentlyValid } from './knowledge-edge';
import type { KnowledgeFact } from './fact-builder';

/**
 * One accepted capture, in the shape the graph side needs.
 *
 * Structural rather than importing `AcceptedSettingMutation` from the pipeline stage:
 * memory/ must not depend on pipeline/, and this is the whole contract.
 */
export interface CanonMutationInput {
  entryId: string;
  kind: string;
  statement: string;
  entities: string[];
  /** `retract` arrives from the panel / toast, not from the model. */
  op?: 'add' | 'retract';
}

/** True when this capture describes a genuine link between two distinct entities. */
export function isProjectableRelationship(m: CanonMutationInput): boolean {
  if (m.kind !== 'relationship') return false;
  const entities = (m.entities ?? []).map((e) => e?.trim()).filter(Boolean);
  if (entities.length !== 2) return false;
  return entities[0] !== entities[1];
}

/**
 * Turn accepted captures into facts the FactBuilder can consume.
 *
 * Every produced fact carries its own provenance (`user-canon`, `core`, the entry id,
 * and the length-filter exemption) so a mixed batch of AI facts and canon facts keeps
 * both straight — the batch-level `defaultSource` / `defaultCore` options cannot.
 */
export function buildCanonFacts(mutations?: readonly CanonMutationInput[]): KnowledgeFact[] {
  if (!Array.isArray(mutations) || mutations.length === 0) return [];

  const out: KnowledgeFact[] = [];
  for (const m of mutations) {
    if (m.op === 'retract') continue;
    if (!isProjectableRelationship(m)) continue;
    const fact = m.statement?.trim();
    if (!fact) continue;

    out.push({
      fact,
      sourceEntity: m.entities[0].trim(),
      targetEntity: m.entities[1].trim(),
      provenance: {
        source: 'user-canon',
        core: true,
        canonEntryId: m.entryId,
        // The player wrote it and the engine verified it against their own words.
        // The length heuristic exists to filter MODEL guesses, and canon relationship
        // statements are routinely under it ("林月是玩家的妹妹" is 8 characters).
        exemptFromLengthFilter: true,
      },
    });
  }
  return out;
}

/**
 * Invalidate the live edges belonging to specific captured entry ids.
 *
 * Retraction is always player-initiated and therefore always happens outside a round —
 * there is deliberately no in-round retraction path, so "undo" cannot come to mean two
 * different things depending on where it was triggered.
 */
export function invalidateEdgesForEntries(
  edges: EngramEdge[],
  entryIds: readonly string[],
  currentRound: number,
): string[] {
  const wanted = new Set(entryIds.filter(Boolean));
  if (wanted.size === 0) return [];

  const touched: string[] = [];
  for (const edge of edges) {
    if (!edge.canonEntryId || !wanted.has(edge.canonEntryId)) continue;
    if (!isEdgeCurrentlyValid(edge)) continue;
    edge.invalidAtRound = currentRound;
    edge.temporalStatus = 'superseded';
    touched.push(edge.id);
  }
  return touched;
}

/** Live edges projected from a given captured entry. */
export function findCanonEdges(edges: readonly EngramEdge[], entryId: string): EngramEdge[] {
  if (!Array.isArray(edges) || !entryId) return [];
  return edges.filter((e) => e.canonEntryId === entryId && isEdgeCurrentlyValid(e));
}
