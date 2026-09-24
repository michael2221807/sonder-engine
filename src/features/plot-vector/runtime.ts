import { buildSixCellBoard } from './default-board';
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../engine/plot-vector/core/session';
import { ScriptProgramRegistry, createScriptCardDef } from './genesis/script-runtime';
import { GENESIS_CATALOG } from './genesis/catalog';
import { probeGenerated } from './genesis/probe-generated';
import { activeSavedCards } from './saved-elements';
import { toRuntimeCandidate, type BoundCard, type GenesisTask, type GenesisOutput, type SavedElement } from './genesis/post-save';
import { buildNarrativeInputV2 } from './decoder/narrative-input-v2';
import type { BoardDef, CompiledBoard, Layout, RunDone, RunOptions, VectorPacket } from '../../engine/plot-vector/core/types';
import { projectNativeInput, type NativeInput } from './native-input';
import { readCardProgress, type CardProgress } from './card-progress';

export interface VectorState {
  version: 1;
  session: VectorSession;
  cards: BoundCard[];
  tasks: Array<{ task: GenesisTask; status: 'pending' | 'sending' | 'failed' | 'bound'; error?: string; raw?: string; validationRevision?: number }>;
  layout?: Layout;
  last?: { id: string; board: CompiledBoard; result: RunDone; layout: Layout; starting?: NativeInput; progress?: CardProgress[] };
}
export interface PreparedVector { id: string; board: CompiledBoard; result: RunDone; layout: Layout; prompt: string; starting?: NativeInput; progress?: CardProgress[] }
export type VectorOperation =
  | { kind: 'prepare'; state: VectorState; entries: SavedElement[]; id: string; native?: NativeInput }
  | { kind: 'accept'; state: VectorState; prepared: PreparedVector }
  | { kind: 'validate'; task: GenesisTask; output: GenesisOutput; attempts: number };
export type VectorResult = PreparedVector | VectorState | BoundCard;
export function initialVectorState(): VectorState { return { version: 1, session: createSession(), cards: [], tasks: [] }; }

/** The single board, run options and narrative strength every AGA vector round uses. The host
 * result guard reads these same values, so a Worker result cannot bring its own rules. */
export const VECTOR_RUN_OPTIONS: RunOptions = { capacityEnabled: false, capacityScope: 'total', pickup: 'none', readout: { kind: 'N1', kappa: 10 } };
export const VECTOR_NARRATIVE_STRENGTH = 0.25;
export function vectorBaseBoard(): BoardDef { return buildSixCellBoard({ topology: 'line' }); }
/** Pure: the narrative prompt a prepared round injects, derived only from its checked inputs and packet. */
export function narrativePromptFor(starting: NativeInput, layout: Layout, packet: VectorPacket): string {
  const hasInput = Object.values(starting.payload).some(n => n > 0) || Object.values(layout.placements).some(Boolean);
  return hasInput ? buildNarrativeInputV2(packet, undefined, VECTOR_NARRATIVE_STRENGTH).prompt : '';
}

async function registryFor(cards: BoundCard[]): Promise<ScriptProgramRegistry> {
  const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
  for (const card of cards) {
    try {
      const probe = new ScriptProgramRegistry(GENESIS_CATALOG);
      const ref = await probe.register(card.candidate);
      if (ref.hash !== card.ref.hash || ref.id !== card.ref.id || probeGenerated(probe, card.candidate, ref).length) continue;
      await registry.register(card.candidate);
    } catch { /* An unavailable ability does not invalidate the saved item. */ }
  }
  return registry;
}
/** Worker only in production. Pure inputs contain no story, model credentials or state manager. */
export async function executeVectorOperation(op: VectorOperation): Promise<VectorResult> {
  if (op.kind === 'validate') {
    const candidate = toRuntimeCandidate(op.task, op.output);
    const registry = new ScriptProgramRegistry(GENESIS_CATALOG);
    const ref = await registry.register(candidate);
    const issues = probeGenerated(registry, candidate, ref);
    if (issues.length) throw new Error(issues.join('; '));
    return { task: op.task, candidate, ref, attempts: op.attempts };
  }
  const registry = await registryFor(op.state.cards);
  if (op.kind === 'accept') {
    if (op.state.session.committed.includes(op.prepared.result.settlementId)) return op.state;
    const session = commitRun(op.state.session, op.prepared.board, op.prepared.result, registry);
    const active = op.state.cards.filter(c => op.prepared.board.cards.some(b => b.id === c.task.entry.id));
    return { ...op.state, session, layout: op.prepared.layout,
      last: { ...op.prepared, progress: readCardProgress(active, session, op.state.session) } };
  }
  const bound = activeSavedCards(op.entries, op.state.cards.map(bound => ({ task: bound.task, bound })))
    .filter(card => registry.initialState(card.ref) !== null);
  const automatic = (card: BoundCard) => card.task.entry.kind === 'effect' || card.task.entry.kind === 'environment';
  const items = bound.filter(card => !automatic(card));
  const effects = bound.filter(automatic);
  const seed = [...op.id].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 0);
  const effect = effects.length ? effects[seed % effects.length] : undefined;
  const placements: Record<string, string | null> = {};
  const used = new Set<string>();
  for (let i = 1; i <= 5; i++) {
    const cell = String(i).padStart(2, '0');
    const previous = op.state.layout?.placements[cell];
    // Selection is opt-in, including the first run. Missing/removed cards leave
    // their slots empty; acquiring an ability must never spend it automatically.
    const card = items.find(c => c.task.entry.id === previous && !used.has(c.task.entry.id));
    placements[cell] = card?.task.entry.id ?? null;
    if (card) used.add(card.task.entry.id);
  }
  placements['06'] = effect?.task.entry.id ?? null;
  const layout: Layout = { placements, tray: items.filter(c => !used.has(c.task.entry.id)).map(c => c.task.entry.id) };
  const base = vectorBaseBoard();
  const starting = op.native ?? projectNativeInput(undefined);
  const board = compileBoard({ ...base, startPayload: starting.payload, talents: [], items: [], cards: bound.map(c => {
    const card = createScriptCardDef(c.candidate, c.ref,
      { id: c.task.entry.id, tags: [], source: 'Model', origin: c.task.entry.kind === 'other' ? 'item' : c.task.entry.kind });
    // The saved element supplies story flavor. Numeric mechanics shown to the player
    // come from this run's trace, because generated prose can diverge from generated JS.
    const description = c.task.entry.capability.description;
    return { ...card, originalText: typeof description === 'string' && description.trim()
      ? { zh: description, en: description } : undefined };
  }) }, { triggerDefault: 'a' });
  const result = run(board, { ...op.state.session, id: op.id, seed: op.id, layout, actionLog: [], visitBudget: starting.visitBudget,
    options: VECTOR_RUN_OPTIONS }, { scripts: registry });
  if (result.status !== 'done') throw new Error('请先完成棋盘选择');
  return { id: op.id, board, result, layout, starting, progress: readCardProgress(bound, op.state.session),
    prompt: narrativePromptFor(starting, layout, result.vectorPacket) };
}
