/**
 * Plot-vector engine types (rebuild plan v5 §1): the PO's board — a shuttle walking a trip of steps
 * over cells, folding at the ends of a line or going round a ring, turning, buying steps, resonance
 * between neighbouring cells, direction-dependent converter cells, an automatic status cell, and the
 * N1 readout. Cards are host programs: the runner feeds them live values and applies the bounded
 * operations they return.
 *
 * Content-agnostic: dimension ids, cell tags, card names and every number come from the host.
 */

// ─── Dimensions & channels ─────────────────────────────────────────────

export type DimensionId = string;
/** A channel is one non-negative quantity carried by the shuttle. Bipolar dims own two. */
export type ChannelId = string;
type Pole = 'positive' | 'negative';

export interface LocalizedLabel {
  zh: string;
  en: string;
}

export interface DimensionDef {
  id: DimensionId;
  polarity: 'bipolar' | 'unipolar';
  label: LocalizedLabel;
  /** Optional pole words for bipolar dims, supplied by the host. */
  poleLabels?: { negative: LocalizedLabel; positive: LocalizedLabel };
}

export interface ChannelMeta {
  id: ChannelId;
  dimension: DimensionId;
  pole: Pole;
}

// ─── Provenance ────────────────────────────────────────────────────────

type RuleSource = 'PO' | 'Codex' | 'Claude' | 'Model';

/** Whose idea a rule is and who wrote its numbers (kept apart on purpose). */
export interface Provenance {
  concept: RuleSource;
  params: RuleSource;
}

// ─── Accounts ──────────────────────────────────────────────────────────

type OwnerKind = 'shuttle' | 'cell' | 'card' | 'runner';

export interface OwnerRef {
  kind: OwnerKind;
  id: string;
}

export type AccountId = string;

/** `unbounded` must be written explicitly; it is never a default. */
export type Cap = number | 'unbounded';

export interface AccountDef {
  id: AccountId;
  owner: OwnerRef;
  encoding: 'channelVector' | 'scalar';
  /** `run` accounts reset every settlement; `acrossRounds` accounts are carried by the host. */
  persist: 'run' | 'acrossRounds';
  /** Required for `acrossRounds` accounts. */
  cap?: Cap;
  /** Rounds an entry survives; `unbounded` must be explicit. Required for `acrossRounds`. */
  lifetimeRounds?: Cap;
  /** Scalar accounts must authorise which shuttle channels may flow in / out. */
  allowedIn?: ChannelId[];
  allowedOut?: ChannelId[];
  label?: LocalizedLabel;
}

export interface AccountEntry {
  /** Round index in which the entry was created (for lifetime expiry). */
  round: number;
  amounts: Record<string, number>;
}

export interface AccountState {
  id: AccountId;
  entries: AccountEntry[];
}

/** Snapshot of every `acrossRounds` account, carried by the host between rounds. */
export type AccountSnapshot = Record<AccountId, AccountEntry[]>;

// ─── Effects & operations ──────────────────────────────────────────────

type EffectEvent = 'beforeCard' | 'onVisit' | 'afterCard' | 'onExit' | 'onTraverse' | 'modifyOperation';

export type PortId = string;

export type OperationDef =
  | { op: 'add'; target: AccountId; channel: ChannelId; amount: number }
  | { op: 'addVisits'; amount: number }
  | { op: 'scaleRemainingVisits'; factor: number }
  | { op: 'scale'; target: AccountId; channel: ChannelId; factor: number }
  | ({ op: 'convert'; target: AccountId; from: ChannelId; to: ChannelId; efficiency: number }
      & ({ rate: number; amount?: never } | { amount: number; rate?: never }))
  | {
      op: 'transfer';
      from: AccountId;
      to: AccountId;
      fromChannel: ChannelId;
      toChannel: ChannelId;
      amount: { kind: 'fixed'; value: number } | { kind: 'all' };
      /** Extra gain on top of the principal actually delivered; default 0. */
      gainAsExtra?: number;
    }
  /** Ask that the next hop leave by the port the shuttle came in by (the turn card, D89). */
  | { op: 'turnShuttle' };

export type OperationKind = OperationDef['op'];

interface ModifierSelector {
  ownerKind: OwnerKind;
  opKind: OperationKind;
}

/** Resonance: an operation's delta grows for each neighbouring cell with the tag that holds a card. */
export interface ModifierDef {
  kind: 'adjacencyCount';
  selector: ModifierSelector;
  neighborTag: string;
  requiresCard: boolean;
  perNeighbor: number;
  maxCount: number;
}

export interface EffectDef {
  id: string;
  owner: OwnerRef;
  provenance?: Provenance;
  event: EffectEvent;
  order: number;
  /** Entry-port condition (direction mechanism, D25). */
  entryPort?: PortId;
  operations: OperationDef[];
  /** Only for `modifyOperation` effects. */
  modifier?: ModifierDef;
  source: RuleSource;
  label: LocalizedLabel;
}

// ─── Board objects ─────────────────────────────────────────────────────

/** The template roles a cell can have. Cross-round, content-free. */
type CellKind = 'resonance' | 'converter' | 'effectSlot' | 'plain';

export interface CellDef {
  id: string;
  kind: CellKind;
  tags: string[];
  ports: PortId[];
  effects: EffectDef[];
  /** Layout: cannot receive a card. */
  locked: boolean;
  label: LocalizedLabel;
  source: RuleSource;
  provenance?: Provenance;
}

interface EdgeEndpoint {
  cell: string;
  port: PortId;
}

export interface EdgeDef {
  id: string;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  kind: 'forward' | 'reverse';
  effects?: EffectDef[];
  label: LocalizedLabel;
}

/** A repeatable source that hands out uses after an accepted round. */
interface CardSupplyRule {
  trigger: 'roundAccepted';
  amount: number;
  sourceId: string;
  label: LocalizedLabel;
}

/** Only the basic filler cards have uses; story cards are unlimited (charter I12). */
interface CardUsage {
  kind: 'consumable';
  initialStock: number;
  maxStock: number;
  supply?: CardSupplyRule;
}

export interface CardState { stock: number }
export type CardStates = Record<string, CardState>;

/** What kind of save entry (or engine supply) a card stands for. */
export type CardOrigin = 'talent' | 'item' | 'environment' | 'effect' | 'supply';

export interface CardDef {
  id: string;
  tags: string[];
  label: LocalizedLabel;
  source: RuleSource;
  origin?: CardOrigin;
  usage?: CardUsage;
  /** Accounts the card owns (its store). */
  accounts?: AccountDef[];
  /** The original save wording. */
  originalText?: LocalizedLabel;
  /** One sentence on what the card does, written with it. */
  summary?: LocalizedLabel;
}

export interface BoardDef {
  id: string;
  /** Boards that share cells and cards under another edge set share one layout. Defaults to `id`. */
  layoutKey?: string;
  dimensions: DimensionDef[];
  cells: CellDef[];
  edges: EdgeDef[];
  /** Spatial adjacency (for resonance), independent of traversal edges. */
  adjacency: Array<[string, string]>;
  start: { cell: string; entryPort: PortId };
  /** `maxVisits` is the safety ceiling of a trip; `maxEvents` a hard execution guard. */
  budget: { maxVisits: number; maxEvents: number };
  /**
   * How far the shuttle travels (D89): the trip is counted in visits and ends when used up. `nMax`
   * limits the initial trip and stays within `budget.maxVisits`; at an endpoint the shuttle folds.
   */
  traversal: { nMax: number; nDefault: number };
  cards: CardDef[];
  /** Initial shuttle payload per channel. */
  startPayload: Record<ChannelId, number>;
  label: LocalizedLabel;
}

export type CompiledBoard = BoardDef & { channels: ChannelMeta[] };

// ─── Cards as host programs ────────────────────────────────────────────

/** A set of operations one card carries out at once, and a short description for the trace. */
export interface CardAction {
  /** The card that owns these operations (a relay may act for the card that armed it). */
  owner: string;
  operations: OperationDef[];
  summary: string[];
}

/** What the runner tells a card on a pass. */
export interface CardPassInput {
  cardId: string;
  cellId: string;
  entryPort: PortId;
  /** This card's pass number in this trip (1-based). */
  pass: number;
  /** The trip step (1-based). */
  step: number;
  shuttle: Readonly<Record<ChannelId, number>>;
  /** Total held in the card's store account. */
  stored: number;
}

export interface CardPassOutput {
  actions: CardAction[];
  /** Whether the card acted on this pass (spends a use of a consumable card). */
  triggered: boolean;
  /** Why the card did not act because its own code failed (the pass is dropped, the run goes on). */
  error?: string;
}

/**
 * The host service that runs cards. The runner never sees card code: it asks for operations and applies
 * them within its own bounds. `depart` runs once before the first step (weather-like cards, waiting
 * growth bursts).
 */
export interface CardRuntime {
  depart(shuttle: Readonly<Record<ChannelId, number>>): CardAction[];
  pass(input: CardPassInput): CardPassOutput;
}

export interface RunServices {
  cards?: CardRuntime;
}

// ─── Layout, settlement, run ───────────────────────────────────────────

export interface Layout {
  /** cellId → cardId (or null when empty). */
  placements: Record<string, string | null>;
  tray: string[];
}

export interface ReadoutOptions {
  kind: 'N1';
  kappa: number;
}

export interface RunOptions {
  readout: ReadoutOptions;
}

export interface Settlement {
  id: string;
  round: number;
  seed: string;
  layout: Layout;
  options: RunOptions;
  cardStates?: CardStates;
  /** Carried `acrossRounds` accounts (already aged by the host). */
  carriedAccounts: AccountSnapshot;
  /** Initial trip length, frozen with the settlement; floored and clamped into [0, nMax]. */
  visitBudget?: number;
}

/** Machine-readable reason for a status, so the UI can phrase it; `reason` stays an English fallback. */
export type ReasonCode =
  | 'entryPortMismatch'
  | 'noUses'
  | 'cardError'
  | 'nothingToTransfer'
  | 'capReached'
  | 'destinationFull'
  | 'foldedAtEndpoint'
  | 'turnRequested'
  | 'turnRedundantAtEndpoint'
  | 'turnImpossibleHere';

export type ReasonArgs = Record<string, string | number>;

export type EventStatus = 'applied' | 'notTriggered' | 'info';

export type TraceEventType = 'departure' | 'visit' | 'effect' | 'route' | 'traverse' | 'visitComplete' | 'end';

export interface Delta {
  account: AccountId;
  channelOrField: string;
  before: number;
  after: number;
}

export interface ModifierRecord {
  source: OwnerRef;
  multiplier: number;
}

export interface TraceEvent {
  eventId: number;
  eventType: TraceEventType;
  visitId: string;
  cellId?: string;
  edgeId?: string;
  entryPort?: PortId;
  owner?: OwnerRef;
  effectId?: string;
  status: EventStatus;
  deltas: Delta[];
  modifiers: ModifierRecord[];
  reason?: string;
  reasonCode?: ReasonCode;
  reasonArgs?: ReasonArgs;
  /** Card actions: what the card did, in words the host chose. */
  cardEffects?: string[];
  /** Net vector after this event. */
  netAfter: Record<DimensionId, number>;
}

export type NetVector = Record<DimensionId, number>;

export interface BipolarReadout {
  direction: number;
  activity: number;
  conflict: number;
}

export interface VectorPacket {
  settlementId: string;
  dimensionSchemaVersion: string;
  representationVersion: string;
  readoutVersion: string;
  dimensions: Record<DimensionId, number>;
  optionalConflict?: Record<DimensionId, BipolarReadout>;
  sourceSummary: Array<{ owner: OwnerRef; effectId: string; label: LocalizedLabel; magnitude: number }>;
}

interface FinalState {
  shuttle: Record<ChannelId, number>;
  net: NetVector;
  accounts: Record<AccountId, { total: number; byChannel: Record<string, number> }>;
}

export interface RunDone {
  status: 'done';
  /** The settlement this result belongs to; hosts use it to commit idempotently. */
  settlementId: string;
  finalState: FinalState;
  vectorPacket: VectorPacket;
  /** Card uses after this trip (host commits on acceptance). */
  pendingCardStates: CardStates;
  /** New snapshot of `acrossRounds` accounts (host commits on acceptance). */
  pendingAccounts: AccountSnapshot;
  trace: TraceEvent[];
  visits: number;
  /** The trip length this run was settled with, and how often each cell was entered. */
  visitBudget: number;
  visitCounts: Record<string, number>;
  /** Cards that acted at least once in this trip. */
  triggeredCards: string[];
}

interface RunFailed {
  status: 'failed';
  reason: string;
  partialTrace: TraceEvent[];
}

export type RunResult = RunDone | RunFailed;
