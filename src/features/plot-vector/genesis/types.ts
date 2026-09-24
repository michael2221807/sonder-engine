export type GenesisEntryKind = 'item' | 'talent' | 'environment' | 'effect' | 'other';

export interface AnchorCandidateV1 {
  commandIndex: number;
  entrySelector: string;
  entryKind: GenesisEntryKind;
  entryLabel: string;
  storyEvidence: string;
}

export interface CardGenesisCandidateV1 {
  version: 1;
  anchor: AnchorCandidateV1;
  card: {
    name: string;
    description: string;
    behaviorSummary: string;
    hooks: { onVisit: string | null; onRoundAccepted: string | null };
    selfStore?: {
      cap: number;
      lifetimeRounds: number;
      allowedIn: readonly string[];
      allowedOut: readonly string[];
    };
    initialPersistentState: Readonly<Record<string, number | boolean>>;
    /** Optional presentation hints. Missing/invalid hints do not invalidate an ability. */
    stateDisplay?: Array<{ key: string; label: string; max?: number }>;
  };
}

export type ScriptEffectRequestV1 =
  | { kind: 'add'; channel: string; amount: number }
  | { kind: 'scale'; channel: string; factor: number }
  | { kind: 'convert'; from: string; to: string; amount: number; efficiency: number }
  | { kind: 'store'; store: 'self'; channel: string; amount: number }
  | { kind: 'release'; store: 'self'; channel: string; amount: number; gainAsExtra?: number }
  | { kind: 'addVisits'; amount: number }
  | { kind: 'scaleRemainingVisits'; factor: number }
  | { kind: 'turnShuttle' }
  | { kind: 'setMode'; mode: string };

export type ScriptStateV1 = Readonly<Record<string, number | boolean>>;

export interface ScriptVisitContextV1 {
  readonly contractVersion: 'plot-card-js-v1';
  readonly cardId: string;
  readonly cellId: string;
  readonly entryPort: 'L' | 'R';
  readonly visitOrdinal: number;
  readonly directionVisitOrdinal: number;
  readonly totalVisitsSoFar: number;
  readonly remainingVisits: number;
  readonly mode: string;
  readonly shuttle: Readonly<Record<string, number>>;
  /** Engine-owned balance before this visit; empty when no private store exists. */
  readonly selfStore: Readonly<Record<string, number>>;
  readonly neighbors: ReadonlyArray<{
    readonly cellId: string;
    readonly occupied: boolean;
    readonly publicTags: ReadonlyArray<string>;
  }>;
  readonly runState: ScriptStateV1;
  readonly persistentState: ScriptStateV1;
  readonly rng: () => number;
}

export interface ScriptVisitResultV1 {
  readonly effects?: ReadonlyArray<ScriptEffectRequestV1>;
  readonly runState?: ScriptStateV1;
}

export interface ScriptRoundAcceptedContextV1 {
  readonly contractVersion: 'plot-card-js-v1';
  readonly cardId: string;
  readonly wasEquipped: boolean;
  readonly wasTriggered: boolean;
  readonly triggerCount: number;
  readonly visitCount: number;
  readonly finalShuttle: Readonly<Record<string, number>>;
  /** Engine-owned balance after the run, before next-round ageing. */
  readonly selfStore: Readonly<Record<string, number>>;
  readonly peakShuttle: Readonly<Record<string, number>>;
  readonly minShuttle: Readonly<Record<string, number>>;
  readonly persistentState: ScriptStateV1;
  readonly runState: ScriptStateV1;
  readonly rng: () => number;
}

export interface ScriptRoundAcceptedResultV1 {
  readonly persistentState?: ScriptStateV1;
}
