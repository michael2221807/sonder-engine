/**
 * The card contract (rebuild plan v5 §2, charter I18/I19): like the Balatro PoC, the model is given a
 * domain — which values a card can read and which operations it can return — and writes the `onPass`
 * JS freely inside it. It never sees live values; the engine feeds them at run time and keeps control
 * (bind-time check, clamps, an error drops only that pass).
 */

/** Where a card comes from; decides how it takes part (rebuild plan §3). */
export type CardType = 'item' | 'talent' | 'status' | 'environment';
export const CARD_TYPES: readonly CardType[] = ['item', 'talent', 'status', 'environment'];

/** The four quantities the shuttle carries, by their domain names. */
export const CHANNEL_NAMES = ['push', 'drag', 'social', 'chance'] as const;
export type ChannelName = typeof CHANNEL_NAMES[number];

/** The multiplier return for each quantity. */
export const MULTIPLIER_OF = { push: 'xPush', drag: 'xDrag', social: 'xSocial', chance: 'xChance' } as const;
export type MultiplierName = typeof MULTIPLIER_OF[ChannelName];

/** What `onPass` may return, after the engine has read and bounded it (§2.4). Absent = not used. */
export interface CardReturn {
  push?: number;
  drag?: number;
  social?: number;
  chance?: number;
  xPush?: number;
  xDrag?: number;
  xSocial?: number;
  xChance?: number;
  convert?: { from: ChannelName; to: ChannelName; amount: number };
  steps?: number;
  xSteps?: number;
  turn?: boolean;
  store?: { from: ChannelName; amount: number };
  release?: boolean;
  /** Applied to the return of the next card that triggers in the same trip, not to the shuttle. */
  relay?: RelayReturn;
}

/** A relay carries the same operations (never another relay) plus `echo`: the next card acts once more. */
export type RelayReturn = Omit<CardReturn, 'relay'> & { echo?: boolean };

/** When a card grows (§2.5). */
export type GrowthTrigger = 'trigger' | 'round' | 'placedRound';

/**
 * Growth the model declares; the engine keeps and persists level and progress. `add` and `burst` are
 * written in the same shape as a return (any return may grow). They stay plain data until use.
 */
export interface GrowthSpec {
  on: GrowthTrigger;
  every: number;
  max: number;
  add?: Readonly<Record<string, unknown>>;
  burst?: Readonly<Record<string, unknown>>;
}

/** One card as the model writes it for one new entry (§2.2). */
export interface CardSpec {
  /** The entry's name. */
  for: string;
  type: CardType;
  /** One sentence for the player. */
  summary: string;
  /** Body of the function the engine calls on every pass. */
  onPass: string;
  growth?: GrowthSpec;
}

/** The values a card reads while running (§2.3); all read-only. */
export interface PassValues {
  push: number;
  drag: number;
  social: number;
  chance: number;
  /** This card's pass number in this trip (1-based; 0 for an environment at departure). */
  pass: number;
  /** Which step of the trip this is (1-based; 0 at departure). */
  step: number;
  /** Passed while the shuttle travels backward. */
  back: boolean;
  level: number;
  stored: number;
}

/** Engine-owned growth record of one card; persisted only when a round is accepted. */
export interface GrowthState {
  level: number;
  progress: number;
  /** Level-ups from round growth whose bursts fire at the next departure. */
  pendingBursts: number;
}

/** Safety bounds (§2.6). They guard against broken code, not against strong cards (C1). */
export const LIMITS = {
  amount: 50,
  multiplier: { min: 0, max: 5 },
  steps: { min: 0, max: 8 },
  xSteps: { min: 1, max: 3 },
  stored: 30,
  growthMax: 50,
  sourceChars: 1500,
  summaryChars: 200,
  nameChars: 60,
} as const;

/** Extra given on a release (C5): the stored amount comes back with half again on top. */
export const RELEASE_BONUS = 0.5;
