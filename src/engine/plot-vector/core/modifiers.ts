import type { CompiledBoard, ModifierDef, ModifierRecord, OperationKind, OwnerRef } from './types';

export interface AdjacencyNeighbor {
  cellId: string;
  tags: string[];
  hasCard: boolean;
}

/** Neighbour view frozen at visit start. */
export interface AdjacencyView {
  neighbors: AdjacencyNeighbor[];
}

export interface ActiveModifier {
  source: OwnerRef;
  def: ModifierDef;
}

export function adjacencyViewFor(board: CompiledBoard, cellId: string, placements: Record<string, string | null>): AdjacencyView {
  const neighbors: AdjacencyNeighbor[] = [];
  for (const [a, b] of board.adjacency) {
    const other = a === cellId ? b : b === cellId ? a : null;
    if (!other) continue;
    const cell = board.cells.find((c) => c.id === other);
    if (!cell) continue;
    neighbors.push({ cellId: other, tags: [...cell.tags], hasCard: board.cards.some((c) => c.id === placements[other]) });
  }
  return { neighbors };
}

function factorOf(def: ModifierDef, view: AdjacencyView): number {
  const n = view.neighbors.filter((nb) => nb.tags.includes(def.neighborTag) && (!def.requiresCard || nb.hasCard)).length;
  return 1 + def.perNeighbor * Math.min(def.maxCount, n);
}

/** The multiplier applied to one operation's delta. Modifiers never emit operations. */
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
