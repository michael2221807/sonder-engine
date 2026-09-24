/**
 * Plot Vector Lab — engine types.
 *
 * Implements the D59 v0.3 candidate contract from docs/research/plot-vector-framework.md.
 * This layer is content-agnostic: dimension ids, cell tags, card names and every number
 * come from a fixture. Nothing in `engine/` may reference a game-specific concept, and
 * nothing in `engine/` may import from `src/engine/**` (see engine-boundary.test.ts).
 */

// ─── Dimensions & channels ─────────────────────────────────────────────

export type DimensionId = string;
/** A channel is one non-negative quantity carried by the shuttle. Bipolar dims own two. */
export type ChannelId = string;
export type Pole = 'positive' | 'negative';

export interface LocalizedLabel {
  zh: string;
  en: string;
}

export interface DimensionDef {
  id: DimensionId;
  polarity: 'bipolar' | 'unipolar';
  label: LocalizedLabel;
  /** Optional pole words for bipolar dims (e.g. against / with), supplied by the fixture. */
  poleLabels?: { negative: LocalizedLabel; positive: LocalizedLabel };
}

export interface ChannelMeta {
  id: ChannelId;
  dimension: DimensionId;
  pole: Pole;
}

// ─── Provenance (contract inspector shows who proposed each rule) ─────

export type RuleSource = 'PO' | 'Codex' | 'Claude' | 'Model';

/**
 * Four separate questions the contract inspector must not conflate (redesign doc §5):
 * whose idea the mechanism is, who wrote these particular numbers, where the content
 * comes from, and whether its mapping is verified or a hand-made demo.
 */
export interface Provenance {
  /** Who proposed the mechanism. */
  concept: RuleSource;
  /** Who wrote these parameters / this wording. */
  params: RuleSource;
  /** Where the content comes from: a real save entry, or an invented demo. */
  content?: 'save' | 'demo';
  /** Whether the mapping from that content to these numbers is established. */
  binding?: 'verified' | 'manualDemo' | 'pending';
}

// ─── Accounts ──────────────────────────────────────────────────────────

export type OwnerKind = 'shuttle' | 'cell' | 'card' | 'edge' | 'talent' | 'item' | 'runner';

export interface OwnerRef {
  kind: OwnerKind;
  id: string;
}

export type AccountId = string;

/** `unbounded` must be written explicitly; it is never a default (D64 / D67). */
export type Cap = number | 'unbounded';

export interface AccountDef {
  id: AccountId;
  owner: OwnerRef;
  encoding: 'channelVector' | 'scalar';
  /** `run` accounts reset every settlement; `acrossRounds` accounts are carried by the host. */
  persist: 'run' | 'acrossRounds';
  /** Required for `acrossRounds` accounts (D67). */
  cap?: Cap;
  /** Rounds an entry survives; `unbounded` must be explicit. Required for `acrossRounds`. */
  lifetimeRounds?: Cap;
  /** Scalar accounts must authorise which shuttle channels may flow in / out (v0.3 §A). */
  allowedIn?: ChannelId[];
  allowedOut?: ChannelId[];
  /** What happens when a deposit does not fit under `cap`. */
  onFull?: 'dissipate' | 'stayAtSource';
  label?: LocalizedLabel;
}

/** Key used for the single quantity of a scalar account. */
export const SCALAR_KEY = '$';

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

// ─── Effects, operations, modifiers, policies ─────────────────────────

export type EffectEvent =
  | 'beforeCard'
  | 'onVisit'
  | 'afterCard'
  | 'onExit'
  | 'onTraverse'
  | 'modifyOperation';

export type PortId = string;

export interface TriggerPolicy {
  limitScope: 'run' | 'visit';
  maxTriggers: number | 'unlimited';
  /** Applied from the second trigger on; scales the operation delta (v0.3 §C). */
  repeatRule?: { kind: 'deltaFraction'; r: number };
}

export type AmountSpec =
  | { kind: 'fixed'; value: number }
  | { kind: 'fractionOfSource'; r: number }
  | { kind: 'all' };

export type OperationDef =
  | { op: 'add'; target: AccountId; channel: ChannelId; amount: number; perStack?: number }
  | { op: 'addVisits'; amount: number }
  | { op: 'scaleRemainingVisits'; factor: number }
  | { op: 'scale'; target: AccountId; channel: ChannelId; factor: number }
  | ({ op: 'convert'; target: AccountId; from: ChannelId; to: ChannelId; efficiency: number }
      & ({ rate: number; amount?: never } | { amount: number; rate?: never }))
  | {
      op: 'transfer';
      from: AccountId;
      to: AccountId;
      /** Source channel (or SCALAR_KEY for scalar sources). */
      fromChannel: ChannelId;
      /** Destination channel (or SCALAR_KEY for scalar destinations). */
      toChannel: ChannelId;
      amount: AmountSpec;
      /** Extra gain after withdrawing the principal; default 0. */
      gainAsExtra?: number;
    }
  | { op: 'setLocal'; owner: OwnerRef; key: string; value: number }
  /** Switch the shuttle's finite mode (v0.3 section A: an enumerated state, never free text). */
  | { op: 'setMode'; mode: string }
  /**
   * The return card (D89): ask that the next hop leave by the port the shuttle came in
   * by, instead of the natural one. It is an operation like any other, so it passes the
   * same entry-port / mode / trigger gates, and it changes nothing already computed here.
   */
  | { op: 'turnShuttle' };

export type OperationKind = OperationDef['op'];

export interface ModifierSelector {
  ownerKind: OwnerKind;
  opKind: OperationKind;
}

export type ModifierDef =
  | {
      kind: 'adjacencyCount';
      selector: ModifierSelector;
      neighborTag: string;
      requiresCard: boolean;
      perNeighbor: number;
      maxCount: number;
    }
  | {
      kind: 'constant';
      selector: ModifierSelector;
      multiplier: number;
    };

export interface EffectDef {
  id: string;
  owner: OwnerRef;
  provenance?: Provenance;
  event: EffectEvent;
  order: number;
  /** Entry-port condition (direction mechanism, D25). */
  entryPort?: PortId;
  /** Extra declarative conditions; all must hold. */
  condition?: { mode?: string; test?: EffectCondition };
  operations: OperationDef[];
  /** Only for `modifyOperation` effects. */
  modifier?: ModifierDef;
  /** Omitted in a fixture = "use the compile default"; must be explicit after compile. */
  triggerPolicy?: TriggerPolicy;
  source: RuleSource;
  label: LocalizedLabel;
}

/** Bounded, read-only predicates. No arbitrary state paths or executable text. */
export type ConditionValue =
  | { kind: 'account'; account: AccountId; channel: ChannelId }
  | { kind: 'local'; key: string }
  | { kind: 'visitOrdinal' }
  | { kind: 'remainingVisits' };
export type EffectCondition =
  | { kind: 'compare'; value: ConditionValue; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; threshold: number }
  | { kind: 'neighborCard'; tag: string; minCount: number }
  | { kind: 'all'; tests: EffectCondition[] }
  | { kind: 'any'; tests: EffectCondition[] };

export interface CompiledEffect extends EffectDef {
  triggerPolicy: TriggerPolicy;
}

// ─── Board objects ─────────────────────────────────────────────────────

export type WindowKind = 'route' | 'talent';

export interface CapacityRule {
  cap: number;
  countedChannels: ChannelId[];
  transferableChannels: ChannelId[];
  destination: AccountId;
  order: number;
  source: RuleSource;
}

export interface CellDef {
  id: string;
  /** Fixed template role; never a scene or a story beat (redesign doc §3). */
  kind: CellKind;
  tags: string[];
  ports: PortId[];
  effects: EffectDef[];
  capacity?: CapacityRule;
  /** Cell-owned buffer account (receives overflow). */
  buffer?: AccountDef;
  windows?: WindowKind[];
  /** Layout: cannot receive a card (world cells). */
  locked: boolean;
  label: LocalizedLabel;
  source: RuleSource;
  provenance?: Provenance;
}

/** The template roles a cell can have. Cross-round, content-free. */
export type CellKind = 'resonance' | 'converter' | 'effectSlot' | 'control' | 'plain';

export interface EdgeEndpoint {
  cell: string;
  port: PortId;
}

export interface EdgeDef {
  id: string;
  from: EdgeEndpoint;
  /** `exit` edges leave the board (end rule `exitEdge`). */
  to: EdgeEndpoint | { exit: true };
  kind: 'forward' | 'reverse' | 'exit';
  cost?: Record<string, number>;
  lapBoundary?: boolean;
  effects?: EffectDef[];
  label: LocalizedLabel;
}

export type EndRule =
  | { kind: 'terminalVisitComplete' }
  | { kind: 'exitEdge' }
  | { kind: 'lapCount'; laps: number }
  | { kind: 'budgetExhausted' }
  /** The run stops when the settled trip length is used up (D89, PO). */
  | { kind: 'visitBudget' };

export interface CardDef {
  usage?: CardUsage;
  growth?: CardProgressRule;
  id: string;
  tags: string[];
  effects: EffectDef[];
  accounts?: AccountDef[];
  label: LocalizedLabel;
  source: RuleSource;
  provenance?: Provenance;
  /** What kind of save entry (or demo) this card stands for. */
  origin?: CardOrigin;
  /** World-owned cards (an active environment entry) cannot be moved off the board. */
  removable?: boolean;
  /** The original save wording, shown next to the demo mapping. */
  originalText?: LocalizedLabel;
  /** Serializable pointer only. Executable code stays in a host-provided registry. */
  scriptProgram?: ScriptProgramRef;
}

export interface ScriptProgramRef {
  id: string;
  hash: string;
}

export type ScriptState = Readonly<Record<string, number | boolean>>;

export interface ScriptVisitInput {
  ref: ScriptProgramRef;
  cardId: string;
  cellId: string;
  entryPort: PortId;
  visitOrdinal: number;
  /** Per-card, per-cell, per-entry-port visits in this run. */
  directionVisitOrdinal?: number;
  totalVisitsSoFar: number;
  remainingVisits: number;
  mode: string;
  shuttle: Readonly<Record<ChannelId, number>>;
  /** Actual balance of this card instance's private store before the visit. */
  selfStore: Readonly<Record<ChannelId, number>>;
  neighbors: ReadonlyArray<{ cellId: string; occupied: boolean; publicTags: readonly string[] }>;
  runState: ScriptState;
  runStateKeys: readonly string[] | null;
  persistentState: ScriptState;
  seed: string;
}

export type ScriptVisitOutput =
  | { ok: true; operations: OperationDef[]; runState: ScriptState; runStateKeys: readonly string[]; effectSummary: string[] }
  | { ok: false; reason: string };

export interface ScriptAcceptanceInput {
  ref: ScriptProgramRef;
  cardId: string;
  wasEquipped: boolean;
  wasTriggered: boolean;
  triggerCount: number;
  visitCount: number;
  finalShuttle: Readonly<Record<ChannelId, number>>;
  /** Filled by the committing host from pendingAccounts; absent in older run records. */
  selfStore?: Readonly<Record<ChannelId, number>>;
  peakShuttle: Readonly<Record<ChannelId, number>>;
  minShuttle: Readonly<Record<ChannelId, number>>;
  /** Versioned host derivation; snippets never inspect raw trace. */
  derivationVersion: string;
  persistentState: ScriptState;
  /** Frozen final local state; reading it never commits persistent state early. */
  runState?: ScriptState;
  seed: string;
}

export type ScriptAcceptanceOutput =
  | { ok: true; persistentState: ScriptState }
  | { ok: false; reason: string };

/** Host service. Implementations may compile JS, but the runner only sees bounded operations. */
export interface ScriptProgramRuntime {
  initialState(ref: ScriptProgramRef): ScriptState | null;
  visit(input: ScriptVisitInput): ScriptVisitOutput;
  accept(input: ScriptAcceptanceInput): ScriptAcceptanceOutput;
}

export interface RunServices {
  scripts?: ScriptProgramRuntime;
}

/** `supply`: a basic small card the player owns independently of the story (host-issued, consumable). */
export type CardOrigin = 'talent' | 'item' | 'environment' | 'effect' | 'demo' | 'supply';

/** Evaluated at completed visits; awarded once on accepted round, never during replay. */
export interface CardProgressRule {
  scope: 'owned' | 'equipped';
  amount: number;
  condition?: { channel: ChannelId; atLeast: number };
}

/** A repeatable source that hands out ordinary consumable copies after an accepted round. */
export interface CardSupplyRule {
  trigger: 'roundAccepted';
  amount: number;
  sourceId: string;
  label: LocalizedLabel;
}

/** Inventory and rechargeable charges are deliberately separate player-facing resources. */
export type CardUsage =
  | { kind: 'consumable'; initialStock: number; maxStock: number; supply?: CardSupplyRule }
  | { kind: 'rechargeable'; initialCharges: number; maxCharges: number; recharge?: CardProgressRule };

export interface CardState { stacks: number; stock: number; charges: number; }
export type CardStates = Record<string, CardState>;

export interface TalentDef {
  id: string;
  /** Cell whose `talent` window offers this talent. */
  windowCell: string;
  modifier: ModifierDef;
  label: LocalizedLabel;
  source: RuleSource;
}

export interface ItemDef {
  id: string;
  operations: OperationDef[];
  label: LocalizedLabel;
  source: RuleSource;
}

export interface BoardDef {
  id: string;
  /**
   * Boards that are the same cells and the same cards under a different edge set share
   * one layout draft, so a configuration can be carried between topologies without being
   * laid out twice (kernel plan K1). Defaults to `id`.
   */
  layoutKey?: string;
  dimensions: DimensionDef[];
  cells: CellDef[];
  edges: EdgeDef[];
  /** Spatial adjacency (for resonance), independent of traversal edges (D11-C). */
  adjacency: Array<[string, string]>;
  start: { cell: string; entryPort: PortId };
  endRules: EndRule[];
  /**
   * `maxVisits` is the gameplay budget: exceeding it ends the run by the `budgetExhausted`
   * end rule when declared, otherwise the run fails. `maxEvents` is a hard execution guard
   * and always fails (v0.3 section B: the two must not be confused).
   */
  budget: { maxVisits: number; maxEvents: number };
  /**
   * How far the shuttle travels and what happens when the way ahead runs out (D89).
   *
   * `nMax` is the initial input ceiling and must stay within `budget.maxVisits`,
   * which is the safety ceiling: a card that buys steps can never lift the safety limit.
   * `onDeadEnd: 'fold'` turns the shuttle around at an endpoint without re-executing that
   * cell, which is what makes a line board and a ring board differ only in how often each
   * cell is visited.
   */
  traversal: {
    nMax: number;
    nDefault: number;
    onDeadEnd: 'fold' | 'stop';
  };
  cards: CardDef[];
  talents: TalentDef[];
  items: ItemDef[];
  /** Initial shuttle payload per channel. */
  startPayload: Record<ChannelId, number>;
  /** Enumerated shuttle modes; the first is the start mode. Default: ['normal']. */
  modes?: string[];
  label: LocalizedLabel;
  /** Read-only panel describing which sample the demo content was taken from. */
  sampleData?: SampleData;
}

/**
 * The sample a board's cards were drawn from. Shown in its own read-only panel so
 * example data never masquerades as board structure (redesign doc §5).
 */
export interface SampleData {
  title: LocalizedLabel;
  note: LocalizedLabel;
  rows: SampleRow[];
}

export interface SampleRow {
  label: LocalizedLabel;
  value: LocalizedLabel;
  /** Whether this figure actually enters the computation or is shown for reference only. */
  used: 'computed' | 'reference';
}

export interface CompiledCell extends Omit<CellDef, 'effects'> {
  effects: CompiledEffect[];
}

export interface CompiledCard extends Omit<CardDef, 'effects'> {
  effects: CompiledEffect[];
}

export interface CompiledEdge extends Omit<EdgeDef, 'effects'> {
  effects: CompiledEffect[];
}

export interface CompiledBoard extends Omit<BoardDef, 'cells' | 'cards' | 'edges'> {
  cells: CompiledCell[];
  cards: CompiledCard[];
  edges: CompiledEdge[];
  channels: ChannelMeta[];
  compileOptions: CompileOptions;
}

export interface CompileOptions {
  /** Default trigger policy for effects that omit one: a = every pass, b = once per run, c = half delta on repeats. */
  triggerDefault: 'a' | 'b' | 'c';
}

// ─── Layout, settlement, run ───────────────────────────────────────────

export interface Layout {
  /** cellId → cardId (or null when empty). */
  placements: Record<string, string | null>;
  tray: string[];
}

export type ActionEntry =
  | { kind: 'route'; cellId: string; visitOrdinal: number; edgeId: string }
  | { kind: 'talent'; cellId: string; visitOrdinal: number; talentId: string; choice: 'activate' | 'skip' }
  | { kind: 'useItem'; cellId: string; visitOrdinal: number; itemId: string }
  /** Explicit buffer pickup at a cell visit (RunOptions.pickup === 'explicit'). */
  | { kind: 'pickup'; cellId: string; visitOrdinal: number };

export interface RunOptions {
  capacityEnabled: boolean;
  capacityScope: 'total' | 'positive';
  pickup: 'onEntry' | 'explicit' | 'none';
  readout: ReadoutOptions;
}

export interface Settlement {
  cardStates?: CardStates;
  id: string;
  round: number;
  seed: string;
  layout: Layout;
  actionLog: ActionEntry[];
  options: RunOptions;
  /** Carried `acrossRounds` accounts (already aged by the host). */
  carriedAccounts: AccountSnapshot;
  /** Host-owned consumables available this round. */
  talentCharges: Record<string, number>;
  itemUses: Record<string, number>;
  /** Budgets for edge costs (e.g. { returnChance: 1 }); an unaffordable edge cannot be taken. */
  resources: Record<string, number>;
  /**
   * Initial trip length, decided before departure and frozen with the settlement
   * (D89). Omitted means the board default. It is floored and clamped into [0, nMax] by
   * `resolveVisitBudget`; effects may extend it during the run. No pre-run model call.
   */
  visitBudget?: number;
  /** Last accepted per-program state. Keyed by immutable program hash. */
  scriptStates?: Record<string, ScriptState>;
}

export interface DecisionOption {
  id: string;
  label: LocalizedLabel;
  /** Set when the option cannot be taken (e.g. insufficient resource); `reason` says why. */
  disabled?: boolean;
  reason?: string;
  reasonCode?: ReasonCode;
  reasonArgs?: ReasonArgs;
}

/**
 * Machine-readable reason for a status, so the UI can phrase it in the player's
 * language. `reason` stays as an English developer fallback.
 */
export type ReasonCode =
  | 'conditionNotMet'
  | 'entryPortMismatch'
  | 'modeMismatch'
  | 'maxTriggers'
  | 'skipped'
  | 'noCharges'
  | 'noUses'
  | 'unknownItem'
  | 'withinCap'
  | 'destinationFull'
  | 'stayedAtSource'
  | 'insufficientResource'
  | 'notAuthorised'
  | 'nothingToTransfer'
  | 'repeatDiscount'
  | 'capReached'
  | 'activated'
  /** Traversal (D89): why the next hop left by the port it did. */
  | 'foldedAtEndpoint'
  | 'turnRequested'
  | 'turnRedundantAtEndpoint'
  | 'turnImpossibleHere';

export type ReasonArgs = Record<string, string | number>;

export interface DecisionPoint {
  settlementId: string;
  cellId: string;
  visitOrdinal: number;
  windowType: WindowKind;
  /** Route: edge ids. Talent: talent ids (choice is activate / skip). */
  options: DecisionOption[];
  talentId?: string;
  chargesLeft?: number;
}

export type EventStatus = 'applied' | 'suppressed' | 'notTriggered' | 'info';

export type TraceEventType =
  | 'visit'
  | 'window'
  | 'effect'
  | 'pickup'
  | 'capacity'
  | 'item'
  | 'route'
  | 'traverse'
  | 'visitComplete'
  | 'end';

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
  programId?: string;
  programHash?: string;
  scriptEffects?: string[];
  /** Net vector after this event (for sparse payload display). */
  netAfter: Record<DimensionId, number>;
}

export interface PendingCosts {
  edgeCosts: Record<string, number>;
  talentCharges: Record<string, number>;
  itemUses: Record<string, number>;
}

export type NetVector = Record<DimensionId, number>;

export interface AggregationResult {
  /** Net vector sampled at every `visitComplete` (N5 contract sample point, D50). */
  visitSamples: NetVector[];
  visitMean: NetVector;
  visitCount: number;
}

export type ReadoutKind = 'N1' | 'N2' | 'N3';

export interface ReadoutOptions {
  kind: ReadoutKind;
  kappa: number;
}

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
  optionalComposition?: Record<ChannelId, number>;
  optionalIntensity?: number;
  optionalConflict?: Record<DimensionId, BipolarReadout>;
  sourceSummary: Array<{ owner: OwnerRef; effectId: string; label: LocalizedLabel; magnitude: number }>;
}

export interface FinalState {
  shuttle: Record<ChannelId, number>;
  mode: string;
  net: NetVector;
  accounts: Record<AccountId, { total: number; byChannel: Record<string, number> }>;
}

export interface RunDone {
  pendingCardStates?: CardStates;
  status: 'done';
  /** The settlement this result belongs to; hosts use it to commit idempotently. */
  settlementId: string;
  endedBy: EndRule['kind'];
  finalState: FinalState;
  aggregation: AggregationResult;
  vectorPacket: VectorPacket;
  pendingCosts: PendingCosts;
  /** New snapshot of `acrossRounds` accounts (host commits on acceptance). */
  pendingAccounts: AccountSnapshot;
  trace: TraceEvent[];
  visits: number;
  /** The trip length this run was settled with, and how often each cell was entered (D89). */
  visitBudget: number;
  visitCounts: Record<string, number>;
  /** Serializable inputs for hooks that may run only when the host accepts this result. */
  pendingScriptAcceptances?: ScriptAcceptanceInput[];
}

export interface RunAwaiting {
  status: 'awaiting';
  decisionPoint: DecisionPoint;
  partialTrace: TraceEvent[];
}

export interface RunFailed {
  status: 'failed';
  reason: string;
  partialTrace: TraceEvent[];
}

export type RunResult = RunDone | RunAwaiting | RunFailed;
