// App doc: docs/user-guide/pages/game-prompts.md §4.8
/**
 * Canon Capture — the ONLY place that turns a validated candidate into world-book state.
 *
 * Every writer goes through here: `SettingCaptureStage` for automatic capture, and the
 * panel / toast (via `CapturedSettingCoordinator`) for player edits. Two implementations
 * of "retract" would drift, and the one that drifts is the one that leaves an Engram edge
 * alive after the entry is gone.
 *
 * All functions are PURE: they take a book and return a NEW book. Persistence, Engram
 * synchronisation and save-triggering are the coordinator's job, not theirs.
 *
 * Engine/content separation (CLAUDE.md §4): every piece of display text (book title,
 * per-kind labels) is injected via {@link CapturedSettingLabels}, sourced from
 * `GamePack.engineFragments`. Nothing here contains a hardcoded Chinese literal.
 */
import type {
  WorldBook,
  WorldBookEntry,
  CapturedSettingKind,
  CapturedSettingMetadata,
} from './world-book';
import { CAPTURED_SETTINGS_BOOK_ID } from './world-book';

// ─── Deterministic mapping (design §4.2) ────────────────────

/** Priority stored on every captured entry. Ordering inside the pool ignores it. */
export const CAPTURED_ENTRY_PRIORITY = 40;
/** Max active captured entries per slot (design §4.3 / D8). */
export const MAX_ACTIVE_CAPTURED_ENTRIES = 200;
/** Max characters of entry content (design §4.3 / D8). */
export const MAX_CAPTURED_CONTENT_CHARS = 240;
/** Max characters of stored evidence (design §4.3). */
export const MAX_CAPTURED_EVIDENCE_CHARS = 180;
/** Max candidates accepted per round — overflow is REPORTED, never silently dropped. */
export const MAX_CANDIDATES_PER_ROUND = 10;
/** Max anchors per candidate. */
export const MAX_ANCHORS = 5;
/** Max entities per candidate. */
export const MAX_ENTITIES = 2;

/** Display labels, injected from the pack so the engine stays content-free. */
export interface CapturedSettingLabels {
  bookTitle: string;
  kind: Record<CapturedSettingKind, string>;
}

export const FALLBACK_CAPTURED_LABELS: CapturedSettingLabels = {
  bookTitle: 'Captured Settings',
  kind: {
    character: 'Character',
    relationship: 'Relationship',
    world_fact: 'World',
  },
};

/** The validated candidate — what survives `SettingCaptureStage`'s gates. */
export interface SettingUpdateCandidate {
  kind: CapturedSettingKind;
  statement: string;
  /** The player's own words, sliced by the engine from the original input. */
  evidence: string;
  anchors: string[];
  entities: string[];
}

/**
 * FNV-1a 32-bit. Deterministic, dependency-free, and synchronous — the id must be
 * computable inside a pipeline stage without awaiting SubtleCrypto.
 *
 * Not a security hash: collisions are handled explicitly by {@link capturedEntryId}.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Normalize a string for hashing/comparison: NFKC, whitespace-folded, lowercased. */
export function normalizeForIdentity(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * Stable id derived from the statement + anchors.
 *
 * Stable so that re-capturing the same setting produces the same id (making exact
 * duplicates a deterministic no-op rather than a growing pile of near-identical
 * entries). Collisions get a numeric suffix chosen by scanning existing ids in
 * lexicographic order, so the outcome does not depend on insertion timing.
 */
export function capturedEntryId(
  statement: string,
  anchors: string[],
  existingIds: Iterable<string> = [],
): string {
  const seed = [
    normalizeForIdentity(statement),
    ...anchors.map(normalizeForIdentity).filter(Boolean).sort(),
  ].join('|');
  const base = `cap_${fnv1a32(seed)}`;

  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable; keep it total rather than throwing inside a stage.
  return `${base}_${taken.size}`;
}

/** Longest title generated for a captured entry before it is elided. */
const CAPTURED_TITLE_MAX = 16;

/**
 * Deterministic title.
 *
 * With a named entity: `<entity> · <kind label>` — the name is what the player scans for.
 * Without one (most `world_fact` settings): a short excerpt of the statement rather than
 * the bare kind label. Falling back to the label alone produced list rows that all read
 * "世界设定", which is also what the type badge beside them says — two identical-looking
 * entries the player has to click to tell apart.
 */
export function buildCapturedTitle(
  candidate: SettingUpdateCandidate,
  labels: CapturedSettingLabels,
): string {
  const kindLabel = labels.kind[candidate.kind] ?? FALLBACK_CAPTURED_LABELS.kind[candidate.kind];
  const entity = candidate.entities[0]?.trim();
  if (entity) return `${entity} · ${kindLabel}`;

  const excerpt = candidate.statement
    .trim()
    .replace(/[。．.!！?？；;，,\s]+$/u, '');
  if (!excerpt) return kindLabel;
  return excerpt.length > CAPTURED_TITLE_MAX
    ? `${excerpt.slice(0, CAPTURED_TITLE_MAX)}…`
    : excerpt;
}

/**
 * Minimum normalized length for an anchor to be usable as a retrieval keyword.
 *
 * A one-character anchor (especially a single CJK character or a particle) appears in
 * almost any sentence about anything, so it turns keyword matching into "always on" —
 * the entry becomes a permanent budget resident and the anchor gate stops constraining
 * anything. Design §6.2 rule 6 requires filtering these out.
 */
export const MIN_ANCHOR_LENGTH = 2;

/**
 * Drop anchors that cannot function as retrieval keywords.
 *
 * Two filters, both required by design §6.2 rule 6:
 * - **single characters** — structural rule, language-neutral, lives in the engine;
 * - **common stopwords** — CONTENT, so the list is injected from the pack
 *   (`engineFragments.settingAnchorStopwords`). The engine ships no word list of its
 *   own; an empty list simply means "no stopword filtering for this pack".
 *
 * Returns the kept anchors plus the dropped ones, so the caller can explain a rejection
 * instead of silently shrinking the player's input.
 */
export function filterAnchors(
  anchors: readonly string[],
  stopwords: readonly string[] = [],
): { kept: string[]; dropped: string[] } {
  const stop = new Set(stopwords.map(normalizeForIdentity).filter(Boolean));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const anchor of anchors) {
    const normalized = normalizeForIdentity(anchor);
    if (!normalized || normalized.length < MIN_ANCHOR_LENGTH || stop.has(normalized)) {
      dropped.push(anchor);
      continue;
    }
    kept.push(anchor);
  }
  return { kept, dropped };
}

/** Parse the pack's separated stopword fragment into a list. */
export function parseAnchorStopwords(fragment: string | undefined): string[] {
  if (!fragment || typeof fragment !== 'string') return [];
  return fragment.split(/[,，\s]+/u).map((w) => w.trim()).filter(Boolean);
}

/** Anchors → world-book keywords: NFKC, trimmed, lowercased, de-duplicated. */
export function anchorsToKeywords(anchors: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const normalized = normalizeForIdentity(anchor);
    if (!normalized || normalized.length < 2) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, MAX_ANCHORS);
}

// ─── Book helpers ───────────────────────────────────────────

/** Create the (single) slot-owned book that holds captured settings. */
export function createCapturedBook(labels: CapturedSettingLabels): WorldBook {
  return {
    id: CAPTURED_SETTINGS_BOOK_ID,
    title: labels.bookTitle,
    ownership: 'slot',
    origin: 'system-captured',
    enabled: true,
    // Guards the BOOK against deletion; individual entries stay fully editable.
    builtin: true,
    entries: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Find the captured book in a slot book list, if it exists yet. */
export function findCapturedBook(books: WorldBook[] | undefined): WorldBook | undefined {
  if (!Array.isArray(books)) return undefined;
  return books.find((b) => b.id === CAPTURED_SETTINGS_BOOK_ID || b.origin === 'system-captured');
}

/** Entries that currently count toward the capacity cap. */
export function activeCapturedEntries(book: WorldBook | undefined): WorldBookEntry[] {
  if (!book) return [];
  return book.entries.filter((e) => e.capturedSetting?.status !== 'retracted');
}

function replaceEntry(book: WorldBook, entryId: string, mapper: (e: WorldBookEntry) => WorldBookEntry): WorldBook {
  let changed = false;
  const entries = book.entries.map((e) => {
    if (e.id !== entryId) return e;
    changed = true;
    return mapper(e);
  });
  if (!changed) return book;
  return { ...book, entries, updatedAt: Date.now() };
}

// ─── Mutations ──────────────────────────────────────────────

export interface AddCapturedContext {
  round: number;
  /** Hash of this round's normalized tag content — audit trail for same-round dupes. */
  inputHash: string;
  labels: CapturedSettingLabels;
}

/**
 * Append a new captured entry. Returns the new book and the entry that was created.
 *
 * The caller is responsible for having already rejected duplicates and capacity
 * overflow — this function does the deterministic field mapping, nothing else.
 */
export function addCapturedEntry(
  book: WorldBook,
  candidate: SettingUpdateCandidate,
  ctx: AddCapturedContext,
): { book: WorldBook; entry: WorldBookEntry } {
  const id = capturedEntryId(candidate.statement, candidate.anchors, book.entries.map((e) => e.id));
  const content = candidate.statement.trim();

  const metadata: CapturedSettingMetadata = {
    schemaVersion: 1,
    source: 'user-captured',
    kind: candidate.kind,
    evidence: candidate.evidence,
    capturedRound: ctx.round,
    inputHash: ctx.inputHash,
    status: 'active',
    entityRefs: [...candidate.entities],
    injectedCount: 0,
    originalContent: content,
  };

  const entry: WorldBookEntry = {
    id,
    title: buildCapturedTitle(candidate, ctx.labels),
    content,
    type: 'world_lore',
    scope: ['main'],
    injectionMode: 'match_any',
    keywords: anchorsToKeywords(candidate.anchors),
    priority: CAPTURED_ENTRY_PRIORITY,
    enabled: true,
    matchSource: 'focused',
    capturedSetting: metadata,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    book: { ...book, entries: [...book.entries, entry], updatedAt: Date.now() },
    entry,
  };
}

/**
 * Add a setting the PLAYER typed by hand into the panel.
 *
 * This is the fallback when automatic capture could not record a tagged round (design
 * §6.4): the player asked for something to be remembered, and refusing to remember it
 * because the model produced malformed JSON would be the feature failing at its one job.
 *
 * Differences from an auto-captured entry, all of them honest bookkeeping:
 * - `source` is `user-edited` from birth — nothing was extracted;
 * - `evidence` IS the content, because the player's words are the content;
 * - `kind` defaults to `world_fact`, the least presumptuous of the three.
 */
export function addManualCapturedEntry(
  book: WorldBook,
  input: { content: string; title?: string; keywords?: string[]; kind?: CapturedSettingKind },
  ctx: { round: number; labels: CapturedSettingLabels },
): { book: WorldBook; entry: WorldBookEntry } {
  const content = input.content.trim().slice(0, MAX_CAPTURED_CONTENT_CHARS);
  const kind = input.kind ?? 'world_fact';
  const keywords = anchorsToKeywords(input.keywords ?? []);
  const id = capturedEntryId(content, keywords, book.entries.map((e) => e.id));

  const entry: WorldBookEntry = {
    id,
    // Same excerpt fallback as an auto-captured entry: the bare kind label duplicates
    // the type badge shown beside it, making every nameless row look identical.
    title: input.title?.trim()
      || buildCapturedTitle({ kind, statement: content, evidence: content, anchors: [], entities: [] }, ctx.labels),
    content,
    type: 'world_lore',
    scope: ['main'],
    // No anchors means keyword matching could never fire, so a manual entry with no
    // keywords is pinned to always — otherwise the player would "save" something that
    // silently never reaches the model.
    injectionMode: keywords.length > 0 ? 'match_any' : 'always',
    keywords,
    priority: CAPTURED_ENTRY_PRIORITY,
    enabled: true,
    matchSource: 'focused',
    capturedSetting: {
      schemaVersion: 1,
      source: 'user-edited',
      kind,
      evidence: content.slice(0, MAX_CAPTURED_EVIDENCE_CHARS),
      capturedRound: ctx.round,
      inputHash: '',
      status: 'active',
      entityRefs: [],
      injectedCount: 0,
      pinnedByUser: keywords.length === 0 ? true : undefined,
      originalContent: content,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    book: { ...book, entries: [...book.entries, entry], updatedAt: Date.now() },
    entry,
  };
}

/**
 * Retract an entry: disabled + marked retracted, never physically deleted.
 *
 * Keeping the row means the player can restore it, and the Engram bridge can find the
 * edge to invalidate by `canonEntryId` afterwards.
 */
export function retractCapturedEntry(book: WorldBook, entryId: string): WorldBook {
  return replaceEntry(book, entryId, (e) => ({
    ...e,
    enabled: false,
    updatedAt: Date.now(),
    capturedSetting: e.capturedSetting
      ? { ...e.capturedSetting, status: 'retracted' }
      : e.capturedSetting,
  }));
}

export interface RestoreResult {
  book: WorldBook;
  ok: boolean;
  /** Set when `ok` is false. `capacity` = the active cap is full. */
  reason?: 'not_found' | 'capacity' | 'not_retracted';
}

/**
 * Restore a retracted entry — subject to the SAME capacity cap as a fresh capture.
 *
 * Without this check, restoring would be a hole straight through the 200-entry limit.
 */
export function restoreCapturedEntry(book: WorldBook, entryId: string): RestoreResult {
  const target = book.entries.find((e) => e.id === entryId);
  if (!target) return { book, ok: false, reason: 'not_found' };
  if (target.capturedSetting?.status !== 'retracted') {
    return { book, ok: false, reason: 'not_retracted' };
  }
  if (activeCapturedEntries(book).length >= MAX_ACTIVE_CAPTURED_ENTRIES) {
    return { book, ok: false, reason: 'capacity' };
  }
  return {
    book: replaceEntry(book, entryId, (e) => ({
      ...e,
      enabled: true,
      updatedAt: Date.now(),
      capturedSetting: e.capturedSetting
        ? { ...e.capturedSetting, status: 'active' }
        : e.capturedSetting,
    })),
    ok: true,
  };
}

export interface CapturedEntryPatch {
  content?: string;
  title?: string;
  keywords?: string[];
  entityRefs?: string[];
}

/**
 * Player edit from the panel.
 *
 * `originalContent` is written once at capture time and is NEVER overwritten here —
 * it exists so the player can always see what was originally recorded. (There is no
 * version chain: `revise` was deliberately cut from the MVP.)
 */
export function editCapturedEntry(
  book: WorldBook,
  entryId: string,
  patch: CapturedEntryPatch,
): WorldBook {
  return replaceEntry(book, entryId, (e) => {
    const nextContent = patch.content !== undefined
      ? patch.content.trim().slice(0, MAX_CAPTURED_CONTENT_CHARS)
      : e.content;
    return {
      ...e,
      content: nextContent,
      title: patch.title !== undefined ? patch.title.trim() || e.title : e.title,
      keywords: patch.keywords !== undefined ? anchorsToKeywords(patch.keywords) : e.keywords,
      updatedAt: Date.now(),
      capturedSetting: e.capturedSetting
        ? {
            ...e.capturedSetting,
            source: 'user-edited',
            entityRefs: patch.entityRefs !== undefined
              ? patch.entityRefs.slice(0, MAX_ENTITIES)
              : e.capturedSetting.entityRefs,
          }
        : e.capturedSetting,
    };
  });
}

/**
 * Pin / unpin an entry to always-inject.
 *
 * Only the PLAYER may set `always`; the model can never produce it. An always-mode
 * entry bypasses keyword matching entirely, which is the right escape hatch for a
 * setting with no natural anchor ("this world has two moons") and completely the
 * wrong default for machine-captured text.
 */
export function pinCapturedEntry(book: WorldBook, entryId: string, pinned: boolean): WorldBook {
  return replaceEntry(book, entryId, (e) => ({
    ...e,
    injectionMode: pinned ? 'always' : 'match_any',
    updatedAt: Date.now(),
    capturedSetting: e.capturedSetting
      ? { ...e.capturedSetting, pinnedByUser: pinned }
      : e.capturedSetting,
  }));
}

/**
 * Fold this round's injection hits into the entries' counters.
 *
 * Called by `SettingCaptureStage`, NOT by the prompt builder: the builder is a pure
 * read of state, and doing the write in one stage keeps the whole round's mutations
 * inside a single rollback unit.
 */
export function bumpInjectionCounters(
  book: WorldBook,
  entryIds: readonly string[],
  round: number,
): WorldBook {
  if (entryIds.length === 0) return book;
  const hit = new Set(entryIds);
  let changed = false;
  const entries = book.entries.map((e) => {
    if (!hit.has(e.id) || !e.capturedSetting) return e;
    changed = true;
    return {
      ...e,
      capturedSetting: {
        ...e.capturedSetting,
        injectedCount: (e.capturedSetting.injectedCount ?? 0) + 1,
        lastInjectedRound: round,
      },
    };
  });
  return changed ? { ...book, entries, updatedAt: Date.now() } : book;
}

/** Replace (or insert) the captured book inside a slot book list. */
export function upsertCapturedBook(books: WorldBook[] | undefined, next: WorldBook): WorldBook[] {
  const list = Array.isArray(books) ? books : [];
  const idx = list.findIndex((b) => b.id === next.id);
  if (idx === -1) return [...list, next];
  const copy = [...list];
  copy[idx] = next;
  return copy;
}
