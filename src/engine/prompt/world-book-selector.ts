// App doc: docs/user-guide/pages/game-prompts.md §4.8（双池预算/未注入原因）
/**
 * World Book entry selector and injection text builder.
 *
 * Ported from original worldbook utils (选择生效世界书条目 + 构建世界书注入文本),
 * adapted to AGA's English naming and EnginePathConfig-based field access.
 *
 * Engine-layer code: no hardcoded Chinese field names.
 */

import type {
  WorldBook,
  WorldBookEntry,
  WorldBookEntryType,
  WorldBookOrigin,
  WorldBookScope,
} from './world-book';
import { isCapturedBook, CAPTURED_BUDGET_RATIO_DEFAULT } from './world-book';
import type { EngineGameTimeFieldNames } from '../pipeline/types';

// ─── Corpus Building ─────────────────────────────────────────

export interface NpcFieldKeys {
  name?: string;
  identity?: string;
  relation?: string;
  location?: string;
}

export interface CorpusSources {
  environment?: { location?: string; weather?: unknown; time?: unknown };
  socialNpcs?: Array<Record<string, unknown>>;
  npcFieldKeys?: NpcFieldKeys;
  narrativeHistory?: Array<{ content: string }>;
  worldEvents?: unknown[];
  extraTexts?: string[];
}

/**
 * The two keyword corpora an entry can be matched against.
 *
 * Why two: the broad corpus contains EVERY social NPC's name, so a keyword like
 * "林月" is present from the moment that NPC exists anywhere in the save — which is
 * fine for a hand-authored lore entry the player deliberately keyed on a name, but
 * turns an auto-captured character setting into a permanent resident that silently
 * eats budget every round. `focused` is only this round's signal.
 */
export interface WorldBookCorpora {
  /** Location, ALL social NPCs, last 12 narrative entries, world events, current input. */
  broad: string;
  /** Current input, current location, PRESENT NPCs only, this round's triggered event. */
  focused: string;
}

/** Sources for the focused corpus. */
export interface FocusedCorpusSources {
  /** This round's player input (action-queue prefix included — it is real round content). */
  userInput?: string;
  /** Player's current location. */
  location?: string;
  /** Names of NPCs actually present in the scene this round. */
  presentNpcNames?: string[];
  /** Title/name of the world event triggered this round, if any. */
  triggeredEventTexts?: string[];
}

/** Build the focused corpus — deliberately narrow. See {@link WorldBookCorpora}. */
export function buildFocusedCorpus(sources: FocusedCorpusSources): string {
  const parts = [
    textOf(sources.userInput).trim(),
    textOf(sources.location).trim(),
    ...(Array.isArray(sources.presentNpcNames) ? sources.presentNpcNames : [])
      .map((n) => textOf(n).trim()),
    ...(Array.isArray(sources.triggeredEventTexts) ? sources.triggeredEventTexts : [])
      .map((t) => textOf(t).trim()),
  ].filter(Boolean);
  return parts.join('\n').toLowerCase();
}

/**
 * Extract the names of NPCs that are PRESENT in the scene.
 *
 * Engine-layer purity: both the name key and the presence key are injected
 * (`EnginePathConfig.npcFieldNames`), never hardcoded Chinese.
 */
export function extractPresentNpcNames(
  npcs: Array<Record<string, unknown>> | undefined,
  nameKey: string,
  isPresentKey: string,
): string[] {
  if (!Array.isArray(npcs)) return [];
  return npcs
    .filter((npc) => npc && typeof npc === 'object' && npc[isPresentKey] === true)
    .map((npc) => textOf(npc[nameKey]).trim())
    .filter(Boolean);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractEnvironmentTexts(env?: CorpusSources['environment']): string[] {
  if (!env || typeof env !== 'object') return [];
  return [env.location, env.weather, env.time]
    .map((v) => textOf(v).trim())
    .filter(Boolean);
}

function extractNpcTexts(
  npcs: Array<Record<string, unknown>>,
  keys: NpcFieldKeys,
): string[] {
  return npcs.flatMap((npc) => {
    if (!npc || typeof npc !== 'object') return [];
    const fieldNames = [
      keys.name ?? 'name',
      keys.identity ?? 'identity',
      keys.relation ?? 'relation',
      keys.location ?? 'location',
    ];
    return fieldNames
      .map((k) => textOf(npc[k]).trim())
      .filter(Boolean);
  });
}

function extractHistoryTexts(
  history?: Array<{ content: string }>,
): string[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-12)
    .map((item) => textOf(item?.content).trim())
    .filter(Boolean);
}

function extractWorldEventTexts(events?: unknown[]): string[] {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event: unknown) => {
    if (!event || typeof event !== 'object') return [];
    const e = event as Record<string, unknown>;
    return [e['title'], e['location'], e['type']]
      .map((v) => textOf(v).trim())
      .filter(Boolean);
  });
}

export function buildCorpus(sources: CorpusSources): string {
  const parts: string[] = [
    ...extractEnvironmentTexts(sources.environment),
    ...extractNpcTexts(
      Array.isArray(sources.socialNpcs) ? sources.socialNpcs : [],
      sources.npcFieldKeys ?? {},
    ),
    ...extractHistoryTexts(sources.narrativeHistory),
    ...extractWorldEventTexts(sources.worldEvents),
    ...(Array.isArray(sources.extraTexts)
      ? sources.extraTexts.map((t) => textOf(t).trim()).filter(Boolean)
      : []),
  ];
  return parts.join('\n').toLowerCase();
}

// ─── Game Time Formatting ────────────────────────────────────

/**
 * Format the game-time state object into the `YYYY:MM:DD:HH:MM` string that
 * {@link timeToOrdinal} / {@link isTimelineMatch} accept.
 *
 * B0-2 (2026-08-20) — why this exists:
 * `DEFAULT_ENGINE_PATHS.gameTime` points at an OBJECT (`{年, 月, 日, 小时, 分钟}`),
 * but `SystemPromptBuilder` used to pass it through as
 * `typeof gameTime === 'string' ? gameTime : ''`, i.e. always the empty string.
 * `isTimelineMatch()` rejects every entry that HAS a start/end when the current
 * time cannot be parsed, so **every timeline-scoped world book entry was silently
 * disabled in the main round** (including lorebooks imported from SillyTavern).
 *
 * Engine-layer purity: field keys come from `EngineGameTimeFieldNames`, never
 * hardcoded Chinese (CLAUDE.md §4).
 *
 * @returns `YYYY:MM:DD:HH:MM`, or `''` when the value is missing/unparseable —
 *          an empty string means "unknown time", and timeline entries then do
 *          not match (existing `isTimelineMatch` contract, unchanged).
 */
export function formatGameTimeForWorldBook(
  value: unknown,
  fields: EngineGameTimeFieldNames,
): string {
  // Already a formatted string (some packs may store it that way) — validate & pass through.
  if (typeof value === 'string') {
    return timeToOrdinal(value) !== null ? value.trim() : '';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const obj = value as Record<string, unknown>;
  const num = (key: string, fallback: number): number | null => {
    const raw = obj[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  };

  // Year/month/day are required; hour/minute default to 0 so a pack that only
  // tracks calendar days still gets working timeline matching.
  const year = num(fields.year, NaN);
  const month = num(fields.month, NaN);
  const day = num(fields.day, NaN);
  const hour = num(fields.hour, 0);
  const minute = num(fields.minute, 0);

  if (year === null || month === null || day === null) return '';
  if (hour === null || minute === null) return '';
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';

  // timeToOrdinal accepts 1-6 year digits; pad the rest to fixed width.
  const pad = (n: number): string => String(n).padStart(2, '0');
  const formatted = `${String(year).padStart(4, '0')}:${pad(month)}:${pad(day)}:${pad(hour)}:${pad(minute)}`;

  // Round-trip guard: never emit something the matcher cannot parse.
  return timeToOrdinal(formatted) !== null ? formatted : '';
}

// ─── Timeline Matching ───────────────────────────────────────

/**
 * Convert a game time string (YYYY:MM:DD:HH:MM) to an ordinal number
 * for range comparison. Returns null for invalid/empty strings.
 */
export function timeToOrdinal(timeStr?: string): number | null {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{1,6}):(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match.map(Number);
  return ((((year * 12) + month) * 31 + day) * 24 + hour) * 60 + minute;
}

/**
 * Check if a world book entry's timeline range matches the current game time.
 *
 * - Entries with no start/end times always match.
 * - If current time cannot be parsed but entry has time constraints, entry does NOT match.
 * - If current time is parseable, checks [start, end] range inclusively.
 */
export function isTimelineMatch(
  entry: Pick<WorldBookEntry, 'timelineStart' | 'timelineEnd' | 'shape'>,
  currentGameTime: string,
): boolean {
  const hasStart = !!entry.timelineStart?.trim();
  const hasEnd = !!entry.timelineEnd?.trim();

  if (!hasStart && !hasEnd) return true;

  const current = timeToOrdinal(currentGameTime);
  if (current === null) return false;

  const start = timeToOrdinal(entry.timelineStart);
  const end = timeToOrdinal(entry.timelineEnd);

  if (start !== null && current < start) return false;
  if (end !== null && current > end) return false;
  return true;
}

// ─── Scope Matching ──────────────────────────────────────────

function isScopeMatch(
  entryScopes: WorldBookScope[],
  activeScopes: WorldBookScope[],
): boolean {
  if (entryScopes.includes('all')) return true;
  return activeScopes.some((s) => entryScopes.includes(s));
}

// ─── Budget Constants ────────────────────────────────────────

/** Per-scope character budget. 0 means no limit (all matched entries are injected). */
export const WORLD_BOOK_BUDGET: Record<WorldBookScope, number> = {
  main: 6000,
  opening: 7000,
  world_evolution: 4000,
  variable_calibration: 5000,
  story_plan: 5000,
  heroine_plan: 5000,
  recall: 0, // 0 = unlimited — recall scope injects all matched entries
  all: 7000,
};

// ─── Entry Selection ─────────────────────────────────────────

export interface WorldBookSelectionParams {
  books: WorldBook[];
  activeScopes: WorldBookScope[];
  /**
   * Legacy single corpus. Treated as the BROAD corpus; when `corpora` is absent the
   * focused corpus falls back to it too, so old callers keep their exact behavior.
   */
  corpus?: string;
  /** Preferred: the broad/focused pair. See {@link WorldBookCorpora}. */
  corpora?: WorldBookCorpora;
  currentGameTime?: string;
  maxChars?: number;
  /**
   * Share of the budget auto-captured entries may occupy (see
   * `PromptSettings.capturedEntryBudgetRatio`). Defaults to 0.6.
   */
  capturedBudgetRatio?: number;
}

/** Why an entry that passed the filters did not make it into the prompt. */
export type WorldBookSkipReason =
  | 'book_disabled'
  | 'entry_disabled'
  | 'empty_content'
  | 'scope'
  | 'timeline'
  | 'no_keyword'
  | 'budget'
  | 'captured_quota';

export interface WorldBookSkippedEntry {
  entryId: string;
  bookId: string;
  title: string;
  reason: WorldBookSkipReason;
  /** Characters this entry WOULD have cost — makes budget pressure explainable in the UI. */
  estimatedChars: number;
}

/** One injected entry together with the book it came from. */
export interface SelectedEntryInfo {
  entry: WorldBookEntry;
  bookId: string;
  origin: WorldBookOrigin;
  matchSource: 'broad' | 'focused';
}

export interface WorldBookSelectionResult {
  selected: WorldBookEntry[];
  /**
   * Same entries as {@link WorldBookSelectionResult.selected}, in the same order, but
   * carrying their source book.
   *
   * Callers MUST use this instead of re-deriving the book from `entry.id`: entry ids are
   * only unique within a book (`wb_${Date.now()}_${rand}` from the storage layer, or
   * whatever a SillyTavern import brought in), so an id-keyed lookup silently
   * mis-attributes `origin` / `bookId` when two books happen to collide.
   */
  selectedInfo: SelectedEntryInfo[];
  /** Entries that were considered but not injected, with the reason. */
  skipped: WorldBookSkippedEntry[];
  /** Ids of the auto-captured entries that WERE injected — the hit-counter write-back list. */
  capturedHits: string[];
  /** Characters consumed by hand-authored entries. */
  userChars: number;
  /** Characters consumed by auto-captured entries. */
  capturedChars: number;
  /** The effective cap applied to the captured pool this round. */
  capturedCap: number;
  /** The scope budget in force (0 = unlimited). */
  budget: number;
  /**
   * True when no character budget applies at all (the `recall` scope).
   * `capturedCap` is meaningless in that case — read this flag instead of
   * comparing `capturedChars` against it.
   */
  unlimited: boolean;
}

/** An entry paired with the book it came from — pool assignment needs the book. */
interface EntryWithBook {
  entry: WorldBookEntry;
  book: WorldBook;
}

function estimateEntryChars(entry: WorldBookEntry): number {
  return `${entry.title ?? ''}\n${entry.content ?? ''}`.length;
}

/** Pair an entry with its book attribution — computed while we still HAVE the book. */
function toInfo({ entry, book }: EntryWithBook): SelectedEntryInfo {
  return {
    entry,
    bookId: book.id,
    origin: book.origin ?? 'user-authored',
    matchSource: entry.matchSource ?? 'broad',
  };
}

/**
 * Sort key for hand-authored entries.
 *
 * BEHAVIOR CHANGE (2026-08-21, deliberate): previously the selector sorted by
 * `priority` alone and leaned on `Array.prototype.sort` being stable, so ties fell
 * back to "book order, then insertion order". Merging profile books with slot-owned
 * books means that implicit order is no longer meaningful, so the tie-break is now
 * explicit. This CAN reorder an existing player's prompt; it is covered by a
 * regression test and recorded in the prompt change log.
 */
function compareUserEntries(a: EntryWithBook, b: EntryWithBook): number {
  const pa = a.entry.priority ?? 0;
  const pb = b.entry.priority ?? 0;
  if (pa !== pb) return pb - pa;
  if (a.book.id !== b.book.id) return a.book.id < b.book.id ? -1 : 1;
  if (a.entry.id !== b.entry.id) return a.entry.id < b.entry.id ? -1 : 1;
  return 0;
}

/**
 * Sort key for auto-captured entries. `priority` is deliberately NOT used — every
 * captured entry stores the same value and the panel does not expose it.
 *
 * 1. Entries the player pinned to always-inject come first (explicit intent wins).
 * 2. Then most-recently-captured first — the setting you just wrote is the one most
 *    likely to matter right now.
 * 3. Then entry id, for total determinism.
 */
function compareCapturedEntries(a: EntryWithBook, b: EntryWithBook): number {
  const pinnedA = a.entry.injectionMode === 'always' ? 1 : 0;
  const pinnedB = b.entry.injectionMode === 'always' ? 1 : 0;
  if (pinnedA !== pinnedB) return pinnedB - pinnedA;

  const roundA = a.entry.capturedSetting?.capturedRound ?? 0;
  const roundB = b.entry.capturedSetting?.capturedRound ?? 0;
  if (roundA !== roundB) return roundB - roundA;

  if (a.entry.id !== b.entry.id) return a.entry.id < b.entry.id ? -1 : 1;
  return 0;
}

/**
 * Select world book entries that should be injected for the given context.
 *
 * Filter chain (unchanged):
 * 1. Book enabled
 * 2. Entry enabled + non-empty content
 * 3. Scope match
 * 4. Timeline match (time_injection and timeline_outline shapes)
 * 5. Keyword match (match_any mode) against the entry's `matchSource` corpus
 *
 * Then the TWO-POOL budget (2026-08-21):
 * 6. Hand-authored entries are admitted first, from the FULL budget.
 * 7. Auto-captured entries are admitted from `min(budget * ratio, budget - usedByUser)`.
 *
 * Semantics: the player's own writing can never be pushed out by machine-captured
 * text, AND captured text never eats the whole budget even when there is room left.
 *
 * Also removed here: the old "the first entry is always admitted regardless of
 * budget" exception. It let a single oversized top-priority entry blow past the
 * cap, and with two pools there is no longer a meaningful "first" entry.
 */
export function selectActiveEntriesDetailed(
  params: WorldBookSelectionParams,
): WorldBookSelectionResult {
  const {
    books,
    activeScopes,
    corpus: legacyCorpus,
    corpora,
    currentGameTime = '',
    maxChars,
    capturedBudgetRatio = CAPTURED_BUDGET_RATIO_DEFAULT,
  } = params;

  const broadCorpus = (corpora?.broad ?? legacyCorpus ?? '').toLowerCase();
  // Old callers pass a single corpus — keep their entries matching exactly as before.
  const focusedCorpus = (corpora?.focused ?? legacyCorpus ?? '').toLowerCase();

  const effectiveScopes = activeScopes.length > 0 ? activeScopes : (['main'] as WorldBookScope[]);

  const budget = typeof maxChars === 'number' && Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : Math.max(0, ...effectiveScopes.map((s) => WORLD_BOOK_BUDGET[s]));

  const skipped: WorldBookSkippedEntry[] = [];
  const userPool: EntryWithBook[] = [];
  const capturedPool: EntryWithBook[] = [];

  const skip = (entry: WorldBookEntry, book: WorldBook, reason: WorldBookSkipReason): void => {
    skipped.push({
      entryId: entry.id,
      bookId: book.id,
      title: entry.title ?? '',
      reason,
      estimatedChars: estimateEntryChars(entry),
    });
  };

  for (const book of books) {
    if (book.enabled === false) {
      for (const entry of book.entries ?? []) skip(entry, book, 'book_disabled');
      continue;
    }
    const captured = isCapturedBook(book);

    for (const entry of book.entries ?? []) {
      if (entry.enabled === false) { skip(entry, book, 'entry_disabled'); continue; }
      if (!(entry.content ?? '').trim()) { skip(entry, book, 'empty_content'); continue; }
      if (!isScopeMatch(entry.scope ?? ['main'], effectiveScopes)) { skip(entry, book, 'scope'); continue; }

      if (entry.shape === 'time_injection' || entry.shape === 'timeline_outline') {
        if (!isTimelineMatch(entry, currentGameTime)) { skip(entry, book, 'timeline'); continue; }
      }

      if (entry.injectionMode === 'match_any') {
        const corpus = entry.matchSource === 'focused' ? focusedCorpus : broadCorpus;
        const keywords = Array.isArray(entry.keywords)
          ? entry.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)
          : [];
        if (keywords.length === 0) { skip(entry, book, 'no_keyword'); continue; }
        if (!keywords.some((kw) => corpus.includes(kw))) { skip(entry, book, 'no_keyword'); continue; }
      }

      (captured ? capturedPool : userPool).push({ entry, book });
    }
  }

  userPool.sort(compareUserEntries);
  capturedPool.sort(compareCapturedEntries);

  // Budget 0 = unlimited (the `recall` scope) — the quota is meaningless there.
  if (budget <= 0) {
    const all = [...userPool, ...capturedPool];
    const capturedCharsAll = capturedPool.reduce((n, x) => n + estimateEntryChars(x.entry), 0);
    return {
      selected: all.map((x) => x.entry),
      selectedInfo: all.map(toInfo),
      skipped,
      capturedHits: capturedPool.map((x) => x.entry.id),
      userChars: userPool.reduce((n, x) => n + estimateEntryChars(x.entry), 0),
      capturedChars: capturedCharsAll,
      // No cap was applied. Report it as fully consumed rather than 0, so a UI that
      // renders `capturedChars / capturedCap` never shows "150 / 0"; `unlimited`
      // is the field to branch on.
      capturedCap: capturedCharsAll,
      budget: 0,
      unlimited: true,
    };
  }

  const selected: WorldBookEntry[] = [];
  const selectedInfo: SelectedEntryInfo[] = [];

  // ── Pool 1: hand-authored, full budget ──
  let userChars = 0;
  for (const pair of userPool) {
    const { entry, book } = pair;
    const cost = estimateEntryChars(entry);
    if (userChars + cost > budget) { skip(entry, book, 'budget'); continue; }
    selected.push(entry);
    selectedInfo.push(toInfo(pair));
    userChars += cost;
  }

  // ── Pool 2: auto-captured, capped share of what is left ──
  // A NaN ratio would propagate through Math.min/max into `capturedCap`, and every
  // `x > NaN` comparison is false — the captured pool would become COMPLETELY
  // unbounded (not merely uncapped by ratio). Guard it like `maxChars` is guarded.
  const ratio = Number.isFinite(capturedBudgetRatio)
    ? Math.min(1, Math.max(0, capturedBudgetRatio))
    : CAPTURED_BUDGET_RATIO_DEFAULT;
  const capturedCap = Math.max(0, Math.min(Math.floor(budget * ratio), budget - userChars));

  let capturedChars = 0;
  const capturedHits: string[] = [];
  for (const pair of capturedPool) {
    const { entry, book } = pair;
    const cost = estimateEntryChars(entry);
    if (capturedChars + cost > capturedCap) {
      // Distinguish "the quota is the wall" from "the whole budget is the wall" —
      // the panel shows the player which one they need to act on.
      skip(entry, book, capturedChars + cost > budget - userChars ? 'budget' : 'captured_quota');
      continue;
    }
    selected.push(entry);
    selectedInfo.push(toInfo(pair));
    capturedChars += cost;
    capturedHits.push(entry.id);
  }

  return {
    selected, selectedInfo, skipped, capturedHits,
    userChars, capturedChars, capturedCap, budget, unlimited: false,
  };
}

/**
 * Backwards-compatible wrapper — returns just the injected entries.
 * Callers that need skip reasons or the hit list use
 * {@link selectActiveEntriesDetailed}.
 */
export function selectActiveEntries(
  params: WorldBookSelectionParams,
): WorldBookEntry[] {
  return selectActiveEntriesDetailed(params).selected;
}

// ─── Injection Text Building ─────────────────────────────────

export interface WorldBookInjectionResult {
  selectedEntries: WorldBookEntry[];
  worldLoreText: string;
  systemRuleText: string;
  commandRuleText: string;
  outputRuleText: string;
}

const TYPE_LABELS: Record<WorldBookEntryType, string> = {
  world_lore: 'World Book Lore',
  system_rule: 'World Book System Rules',
  command_rule: 'World Book Command Rules',
  output_rule: 'World Book Output Rules',
};

function buildGroupText(label: string, entries: WorldBookEntry[]): string {
  const sections = entries
    .map((e) => {
      const title = (e.title ?? '').trim();
      const body = (e.content ?? '').trim();
      if (!body) return '';
      return title ? `### ${title}\n${body}` : body;
    })
    .filter(Boolean);
  if (sections.length === 0) return '';
  return `<${label.replace(/\s+/g, '_').toLowerCase()}>\n${sections.join('\n\n')}\n</${label.replace(/\s+/g, '_').toLowerCase()}>`;
}

/**
 * Build formatted injection text from selected entries, grouped by type.
 */
export function buildWorldBookInjectionText(
  selectedEntries: WorldBookEntry[],
): WorldBookInjectionResult {
  const grouped: Record<WorldBookEntryType, WorldBookEntry[]> = {
    world_lore: [],
    system_rule: [],
    command_rule: [],
    output_rule: [],
  };

  for (const entry of selectedEntries) {
    const type = entry.type ?? 'world_lore';
    if (type in grouped) {
      grouped[type].push(entry);
    }
  }

  return {
    selectedEntries,
    worldLoreText: buildGroupText(TYPE_LABELS.world_lore, grouped.world_lore),
    systemRuleText: buildGroupText(TYPE_LABELS.system_rule, grouped.system_rule),
    commandRuleText: buildGroupText(TYPE_LABELS.command_rule, grouped.command_rule),
    outputRuleText: buildGroupText(TYPE_LABELS.output_rule, grouped.output_rule),
  };
}
