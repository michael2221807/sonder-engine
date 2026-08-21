// App doc: docs/user-guide/pages/game-prompts.md §4.8
/**
 * World Book data model — ported from original worldbook model
 *
 * The world book system allows users to manage prompt entries that get
 * injected into the AI context. Entries can override built-in prompts
 * via slot ID matching, or inject additional lore/rules by scope + keywords.
 */

// ─── Entry Types ────────────────────────────────────────────

export type WorldBookEntryType = 'world_lore' | 'system_rule' | 'command_rule' | 'output_rule';

export type WorldBookScope =
  | 'main'
  | 'opening'
  | 'world_evolution'
  | 'variable_calibration'
  | 'story_plan'
  | 'heroine_plan'
  | 'recall'
  | 'all';

export type WorldBookInjectionMode = 'always' | 'match_any';

export type WorldBookEntryShape = 'normal' | 'timeline_outline' | 'time_injection';

export type BuiltinPromptCategory =
  | '常驻'
  | '开局'
  | '主剧情'
  | '变量生成'
  | '文章优化'
  | '回忆'
  | '世界演变';

// ─── Ownership / Origin (Canon Capture) ─────────────────────

/**
 * Where a world book LIVES.
 *
 * - `profile` — persisted in `WorldBookStorage` (IndexedDB, keyed `profileId:book.id`).
 *   Shared by every save slot of that profile. This is what hand-authored books are.
 * - `slot`   — persisted inside the game state tree at
 *   `EnginePathConfig.slotWorldBooks`. Scoped to ONE save slot, and therefore rolls
 *   back with the round and travels with save / backup / cloud sync for free.
 *
 * Absent on legacy data → treat as `profile`.
 */
export type WorldBookOwnership = 'profile' | 'slot';

/**
 * WHO wrote a world book.
 *
 * - `user-authored`    — the player created it (or imported a SillyTavern lorebook).
 * - `system-captured`  — the engine captured it from `<设定>` tags (Canon Capture).
 *
 * Absent on legacy data → treat as `user-authored`.
 *
 * This drives the two-pool budget in `world-book-selector.ts`: hand-authored entries
 * are admitted first from the FULL budget, captured entries only from a capped share.
 */
export type WorldBookOrigin = 'user-authored' | 'system-captured';

/** Kinds of setting a `<设定>` tag can produce. Model-facing; deliberately only three. */
export type CapturedSettingKind = 'character' | 'relationship' | 'world_fact';

/**
 * Provenance + audit metadata attached to an auto-captured entry.
 *
 * The injectable content itself stays in the standard `WorldBookEntry` fields
 * (`content` / `keywords` / `enabled` / `injectionMode`) — this block never holds a
 * second copy, it only records where the entry came from and how it has performed.
 */
export interface CapturedSettingMetadata {
  schemaVersion: 1;
  /** `user-captured` on creation; flips to `user-edited` once the player edits it. */
  source: 'user-captured' | 'user-edited';
  kind: CapturedSettingKind;
  /**
   * The player's own words, sliced by the ENGINE out of the original input using the
   * matched offsets — never the model's paraphrase (see design §6.2 rule 10).
   */
  evidence: string;
  capturedRound: number;
  /** Hash of the normalized tag content — used to detect same-round resubmission. */
  inputHash: string;
  status: 'active' | 'retracted';
  /** Entity names this setting is about (0-2). Drives the Engram relationship bridge. */
  entityRefs: string[];
  /** How many times this entry has actually been injected into a prompt. */
  injectedCount: number;
  /** Round of the most recent injection (absent = never injected). */
  lastInjectedRound?: number;
  /** Player pinned it to always-inject (mirrors `injectionMode === 'always'`). */
  pinnedByUser?: boolean;
  /**
   * The content as first captured. Written ONCE at creation and never overwritten,
   * so the player can always see what was originally recorded. Not a version chain —
   * `revise` was deliberately cut from the MVP.
   */
  originalContent?: string;
}

// ─── Entry Interface ────────────────────────────────────────

export interface WorldBookEntry {
  id: string;
  /** Display title */
  title: string;
  /** Prompt content (template variables like ${playerName} are supported) */
  content: string;
  /** Entry shape — normal text, timeline outline, or time-based injection */
  shape?: WorldBookEntryShape;
  /** Entry type — determines how it's categorized in the UI */
  type: WorldBookEntryType;
  /** Which flows/contexts this entry applies to */
  scope: WorldBookScope[];
  /** If set, this entry overrides the built-in prompt with this slot ID */
  builtinSlotId?: string;
  /** Category for built-in entries (UI grouping) */
  builtinCategory?: BuiltinPromptCategory;
  /** Condition description for built-in entries */
  builtinCondition?: string;
  /** Injection description (shown in UI) */
  injectionNote?: string;
  /** Injection mode — always inject, or only when keywords match */
  injectionMode: WorldBookInjectionMode;
  /** For timeline entries: start time */
  timelineStart?: string;
  /** For timeline entries: end time */
  timelineEnd?: string;
  /** Keywords for match_any injection mode */
  keywords?: string[];
  /** Priority (higher = injected earlier in prompt) */
  priority?: number;
  /** Whether this entry is enabled */
  enabled?: boolean;
  /** Whether this is a built-in (non-deletable) entry */
  builtin?: boolean;
  /** Creation timestamp */
  createdAt?: number;
  /** Last update timestamp */
  updatedAt?: number;
  /**
   * Which corpus this entry's keywords are matched against.
   *
   * - `broad`   — the wide corpus (location, ALL social NPCs, last 12 narrative
   *               entries, world events, current input). Legacy default.
   * - `focused` — only the current round's signal (current input, current location,
   *               NPCs actually PRESENT, the event triggered this round).
   *
   * Auto-captured entries are always `focused`: matching them against the full NPC
   * table would make a character setting fire permanently just because that NPC
   * exists somewhere in `社交.关系`.
   *
   * Absent → `broad` (every pre-existing entry keeps its behavior).
   */
  matchSource?: 'broad' | 'focused';
  /** Present only on auto-captured entries. See {@link CapturedSettingMetadata}. */
  capturedSetting?: CapturedSettingMetadata;
}

// ─── World Book (Collection of Entries) ─────────────────────

export interface WorldBook {
  id: string;
  title: string;
  description?: string;
  /** Persistent outline injected as lore context */
  outline?: string;
  enabled?: boolean;
  builtin?: boolean;
  entries: WorldBookEntry[];
  createdAt?: number;
  updatedAt?: number;
  /** Where this book is persisted. Absent → `profile` (see {@link WorldBookOwnership}). */
  ownership?: WorldBookOwnership;
  /** Who wrote it. Absent → `user-authored` (see {@link WorldBookOrigin}). */
  origin?: WorldBookOrigin;
}

/** The id of the single system-owned book that holds auto-captured settings. */
export const CAPTURED_SETTINGS_BOOK_ID = 'system_captured_settings';

/** True when the book holds engine-captured settings (drives the two-pool budget). */
export function isCapturedBook(book: Pick<WorldBook, 'origin'>): boolean {
  return book.origin === 'system-captured';
}

// ─── Built-in Prompt Entry ──────────────────────────────────
// These are the "default prompts" that ship with the pack.
// Users can override them via the world book system.

export interface BuiltinPromptEntry {
  id: string;
  /** Links to a built-in slot — world book entries with matching builtinSlotId override this */
  slotId: string;
  title: string;
  category: BuiltinPromptCategory;
  /** Default content (from pack prompt files) */
  content: string;
  /** User-edited content (overrides default when set) */
  userContent?: string;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

// ─── Preset Groups ──────────────────────────────────────────

export interface WorldBookPresetGroup {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  /** Snapshot of books at the time this preset was created */
  bookSnapshots: WorldBook[];
  createdAt?: number;
  updatedAt?: number;
}

// ─── Export/Import Structures ────────────────────────────────

export interface WorldBookExportData {
  version: number;
  exportedAt: string;
  books: WorldBook[];
}

export interface BuiltinPromptExportData {
  version: number;
  exportedAt: string;
  entries: BuiltinPromptEntry[];
  /**
   * 覆盖所属的 pack（2026-07-23 补类型）：备份/云同步一直在写这个字段，
   * 此前靠 `as ... & { packId: string }` 野转型携带，现收编进正式类型。
   * Optional —— 旧导出文件可能没有。
   */
  packId?: string;
}

export interface PresetGroupExportData {
  version: number;
  exportedAt: string;
  groups: WorldBookPresetGroup[];
}

// ─── Context Piece (output of SystemPromptBuilder) ──────────

export interface ContextPiece {
  id: string;
  title: string;
  category: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
  /** Estimated token count (rough: chars / 3 for Chinese, chars / 4 for English) */
  tokenEstimate?: number;
}

export interface MessageEntry {
  id: string;
  title: string;
  category: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Whether this entry contains the user's current input */
  isUserInput?: boolean;
}

export interface SystemPromptBuildResult {
  /** Named context pieces for debugging/display */
  contextPieces: Record<string, string>;
  /** Ordered messages for the API call */
  messageEntries: MessageEntry[];
  /** Short-term memory context (injected separately as assistant message) */
  shortMemoryContext: string;
  /** Runtime prompt enable/disable states for tracking */
  runtimePromptStates: Record<string, boolean>;
  /** World book entries that were injected (for debug panel) */
  worldBookHits?: Array<{
    entryId: string;
    title: string;
    type: string;
    matchedKeywords?: string[];
    bookId: string;
    origin: WorldBookOrigin;
    matchSource: 'broad' | 'focused';
  }>;
  /**
   * Entries considered but NOT injected, with the reason.
   *
   * Surfaced in the debug panel AND the world-book settings UI: an entry that silently
   * loses to the budget is indistinguishable from a broken entry, which is exactly the
   * kind of invisible failure this project treats as a defect.
   *
   * Typed structurally to avoid a circular import with `world-book-selector.ts`.
   */
  worldBookSkipped?: Array<{
    entryId: string;
    bookId: string;
    title: string;
    reason: string;
    estimatedChars: number;
  }>;
  /**
   * Ids of the auto-captured entries injected this round.
   *
   * `buildSystemPrompt` is a PURE read of state — it must not write. The caller
   * (`ContextAssemblyStage`) parks this on `ctx.meta.capturedHits`, and
   * `SettingCaptureStage` folds the `injectedCount` / `lastInjectedRound` bump into
   * the round's single state write so it rolls back with everything else.
   */
  capturedHits?: string[];
  /** Budget accounting for the world-book block (debug panel + settings UI). */
  worldBookBudget?: {
    budget: number;
    userChars: number;
    capturedChars: number;
    capturedCap: number;
    /** True for scopes with no character budget (`recall`) — `capturedCap` is moot. */
    unlimited: boolean;
  };
}

// ─── Prompt Settings (stored in state tree at 系统.设置.prompt) ──

export interface PromptSettings {
  /** Narrator perspective — 第一人称 (I), 第二人称 (you), 第三人称 (he/she/name) */
  perspective: '第一人称' | '第二人称' | '第三人称';
  /** Minimum word count for narrative output */
  wordCountRequirement: number;
  /** Story style preference */
  storyStyle: 'general' | 'harem' | 'pureLove' | 'cultivation' | 'shura' | 'ntlHarem';
  /** NTL harem tier (only when storyStyle = 'ntlHarem') */
  ntlTier?: '禁止乱伦' | '假乱伦' | '无限制';
  /** Enable NoControl directive (prevents AI from controlling player actions) */
  enableNoControl: boolean;
  /** Enable action options generation */
  enableActionOptions: boolean;
  /** Action options mode */
  actionOptionsMode: 'action' | 'story';
  /** Action pace */
  actionPace: 'fast' | 'slow';
  /** Custom additional system prompt */
  customSystemPrompt: string;
  /** Master switch for world book injection */
  enableWorldBook: boolean;
  /**
   * Canon Capture — whether `<设定>` tags are extracted into the auto-settings book.
   *
   * Turning this OFF stops extraction (and disables the composer's 设定 button) but
   * leaves already-captured entries in place and still injected. Turning off
   * `enableWorldBook` stops BOTH extraction and injection, without deleting anything.
   */
  enableSettingCapture: boolean;
  /**
   * Share of the world-book character budget that auto-captured entries may occupy.
   *
   * Hand-authored entries are always admitted FIRST from the full budget; captured
   * entries then take at most `floor(budget * ratio)` of whatever the budget was —
   * so the player's own writing can never be pushed out by machine-captured text,
   * and captured entries never eat the whole budget even when there is room.
   *
   * Clamped to [0.2, 0.8] by `resolveCapturedBudgetRatio()`.
   */
  capturedEntryBudgetRatio: number;
}

/** Bounds for {@link PromptSettings.capturedEntryBudgetRatio}. */
export const CAPTURED_BUDGET_RATIO_MIN = 0.2;
export const CAPTURED_BUDGET_RATIO_MAX = 0.8;
export const CAPTURED_BUDGET_RATIO_DEFAULT = 0.6;

/** Clamp an arbitrary stored value into the supported ratio range. */
export function resolveCapturedBudgetRatio(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return CAPTURED_BUDGET_RATIO_DEFAULT;
  return Math.min(CAPTURED_BUDGET_RATIO_MAX, Math.max(CAPTURED_BUDGET_RATIO_MIN, n));
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  perspective: '第二人称',
  wordCountRequirement: 650,
  storyStyle: 'general',
  enableNoControl: true,
  enableActionOptions: true,
  actionOptionsMode: 'action',
  actionPace: 'fast',
  customSystemPrompt: '',
  enableWorldBook: true,
  enableSettingCapture: true,
  capturedEntryBudgetRatio: CAPTURED_BUDGET_RATIO_DEFAULT,
};
