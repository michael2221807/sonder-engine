import type { CompiledBoard, ModifierDef, ModifierRecord, OperationKind, OwnerRef } from './types';

export interface AdjacencyNeighbor {
  cellId: string;
  tags: string[];
  hasCard: boolean;
  cardTags: string[];
}

/** Neighbour view frozen at visit start (D11-C / v0.3 section B). */
export interface AdjacencyView {
  neighbors: AdjacencyNeighbor[];
}

export interface ActiveModifier {
  source: OwnerRef;
  def: ModifierDef;
}

export function adjacencyViewFor(
  board: CompiledBoard,
  cellId: string,
  placements: Record<string, string | null>,
): AdjacencyView {
  const neighbors: AdjacencyNeighbor[] = [];
  for (const [a, b] of board.adjacency) {
    const other = a === cellId ? b : b === cellId ? a : null;
    if (!other) continue;
    const cell = board.cells.find((c) => c.id === other);
    if (!cell) continue;
    const card = board.cards.find((c) => c.id === placements[other]);
    neighbors.push({ cellId: other, tags: [...cell.tags], hasCard: !!card, cardTags: [...(card?.tags ?? [])] });
  }
  return { neighbors };
}

function factorOf(def: ModifierDef, view: AdjacencyView): number {
  if (def.kind === 'constant') return def.multiplier;
  const tag = def.neighborTag;
  const n = view.neighbors.filter((nb) => nb.tags.includes(tag) && (!def.requiresCard || nb.hasCard)).length;
  return 1 + def.perNeighbor * Math.min(def.maxCount, n);
}

/**
 * modifyOperation sub-phase: the multiplier applied to one operation's delta.
 * Modifiers never emit operations and never modify themselves.
 */
export function multiplierFor(
  active: ActiveModifier[],
  opOwnerKind: OwnerRef['kind'],
  opKind: OperationKind,
  view: AdjacencyView,
): { multiplier: number; records: ModifierRecord[] } {
  let multiplier = 1;
  const records: ModifierRecord[] = [];
  for (const m of active) {
    if (m.def.selector.ownerKind !== opOwnerKind || m.def.selector.opKind !== opKind) continue;
    const factor = factorOf(m.def, view);
    if (factor !== 1) records.push({ source: m.source, multiplier: factor });
    multiplier *= factor;
  }
  return { multiplier, records };
}
