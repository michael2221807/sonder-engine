// App doc: docs/user-guide/pages/game-main.md §3.15
/**
 * `<设定>…</设定>` tag scanner — Canon Capture's input side.
 *
 * The player marks long-term settings explicitly (the "设定" button in the composer
 * wraps the selection). Everything the capture pipeline is allowed to persist must be
 * traceable to text INSIDE one of these tags, so this scanner is the single source of
 * truth for "what did the player actually mark this round".
 *
 * Design contract (`docs/design/canon-ledger-setting-capture.md` §5.1, §6.1):
 * - Implemented as a linear state machine, NOT one greedy regex. A greedy match would
 *   swallow everything between the first open tag and the last close tag, silently
 *   turning unmarked narrative into "evidence".
 * - **No nesting.** A second open tag before the first closed one discards the first
 *   (it was never closed) and restarts from the new one.
 * - Unclosed opens and orphan closes are ignored, never an error.
 * - Empty tags are ignored and do not count toward the segment cap.
 * - Partially malformed input still yields its well-formed segments.
 * - Segments are kept SEPARATE. They must never be concatenated: with
 *   `<设定>林月</设定>…<设定>怕水</设定>`, a joined string makes "林月怕水" a valid
 *   contiguous substring even though the player never wrote it, which would let a
 *   model-invented statement pass the evidence gate.
 *
 * Engine/content separation (CLAUDE.md §4): the tag NAME is content, not engine
 * vocabulary. It is injected via `GamePack.engineFragments.settingTagNames` so an
 * English pack can use `<setting>`; nothing here hardcodes a Chinese literal.
 */

/** One well-formed `<tag>…</tag>` region found in the raw input. */
export interface SettingTagSegment {
  /** 0-based index among the well-formed segments. */
  index: number;
  /** The content EXACTLY as the player typed it (offsets below slice back to this). */
  rawText: string;
  /** NFKC-normalized + whitespace-folded. Matching only — never persisted as evidence. */
  normalizedText: string;
  /** Start offset of the content (exclusive of the open tag) in the original input. */
  startOffset: number;
  /** End offset of the content (exclusive of the close tag) in the original input. */
  endOffset: number;
}

export interface ScanSettingTagsResult {
  segments: SettingTagSegment[];
  /** Well-formed segments dropped because the per-round segment cap was hit. */
  droppedBySegmentCap: number;
  /** Characters dropped because the combined character cap was hit. */
  droppedByCharCap: number;
  /** True when at least one open tag was never closed (or a close had no open). */
  hadMalformedTag: boolean;
}

export interface ScanSettingTagsOptions {
  /** Accepted tag names (case-insensitive). Sourced from the pack, never hardcoded. */
  tagNames?: string[];
  /** Max well-formed segments kept per round. */
  maxSegments?: number;
  /** Max combined characters across kept segments. */
  maxTotalChars?: number;
}

export const DEFAULT_SETTING_TAG_NAMES: readonly string[] = ['设定', 'setting'];
export const MAX_SETTING_SEGMENTS = 5;
/**
 * Combined evidence-domain cap across a round's segments.
 *
 * This does NOT limit what the model reads — the tagged text travels to the model
 * inside `userInput` regardless. It only bounds how much text the engine will run
 * evidence verification against. 1200 was too tight for the product promise that a
 * marked setting may be ANY length: everything past the cap had its summaries
 * auto-rejected as `no_evidence`, punishing the player for writing a long passage.
 * 4000 covers any realistic marked passage while still stopping a paste-bomb.
 */
export const MAX_SETTING_TOTAL_CHARS = 4000;

/**
 * Soft advisory line, NOT a gate. Past this combined tag length the model's
 * decomposition quality tends to drop (more facts to keep straight while also writing
 * the narrative), so the composer shows a heads-up toast on send — generation itself
 * is never blocked, and the player can always rollback and regenerate (PM decision
 * 2026-08-25: the marked setting is part of the story; length must not stop a turn).
 */
export const SETTING_QUALITY_WARN_CHARS = 1000;

/**
 * Normalize text for matching: NFKC (so full-width punctuation and half-width forms
 * compare equal) then collapse every whitespace run to a single space, then trim.
 *
 * Whitespace is COLLAPSED rather than stripped: stripping it entirely would let
 * "林月 怕水" match a claimed evidence of "林月怕水", which is a smaller version of
 * the same fabrication the per-segment rule exists to prevent.
 */
export function normalizeForEvidence(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** Escape a tag name for use inside a RegExp character-safe context. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface TagToken {
  kind: 'open' | 'close';
  /** Index of the '<' character. */
  start: number;
  /** Index just past the '>' character. */
  end: number;
}

/**
 * Find every open/close tag token, tolerating whitespace inside the delimiters
 * (`< 设定 >`) and matching the tag name case-insensitively.
 */
function tokenize(raw: string, tagNames: string[]): TagToken[] {
  const names = tagNames
    .map((n) => n.trim())
    .filter(Boolean)
    .map(escapeRegExp);
  if (names.length === 0) return [];

  const pattern = new RegExp(`<\\s*(/?)\\s*(?:${names.join('|')})\\s*>`, 'giu');
  const tokens: TagToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    tokens.push({
      kind: m[1] === '/' ? 'close' : 'open',
      start: m.index,
      end: m.index + m[0].length,
    });
    // Zero-length matches are impossible here (the pattern always consumes `<…>`),
    // but guard anyway so a future pattern edit cannot hang the round.
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return tokens;
}

/**
 * Scan the raw player input for well-formed setting tags.
 *
 * Never throws: malformed input degrades to "fewer segments", because a parsing
 * error here would fail an otherwise perfectly good narrative round.
 */
export function scanSettingTags(
  raw: string,
  options: ScanSettingTagsOptions = {},
): ScanSettingTagsResult {
  const empty: ScanSettingTagsResult = {
    segments: [],
    droppedBySegmentCap: 0,
    droppedByCharCap: 0,
    hadMalformedTag: false,
  };
  if (typeof raw !== 'string' || !raw) return empty;

  const tagNames = options.tagNames?.length ? options.tagNames : [...DEFAULT_SETTING_TAG_NAMES];
  const maxSegments = options.maxSegments ?? MAX_SETTING_SEGMENTS;
  const maxTotalChars = options.maxTotalChars ?? MAX_SETTING_TOTAL_CHARS;

  const tokens = tokenize(raw, tagNames);
  if (tokens.length === 0) return empty;

  const found: Array<{ start: number; end: number }> = [];
  let hadMalformedTag = false;
  let openAt: number | null = null; // content start offset of the pending open tag

  for (const token of tokens) {
    if (token.kind === 'open') {
      // No nesting: a second open discards the pending one (it was never closed).
      if (openAt !== null) hadMalformedTag = true;
      openAt = token.end;
      continue;
    }
    // close
    if (openAt === null) {
      hadMalformedTag = true; // orphan close
      continue;
    }
    found.push({ start: openAt, end: token.start });
    openAt = null;
  }
  if (openAt !== null) hadMalformedTag = true; // trailing unclosed open

  const segments: SettingTagSegment[] = [];
  let droppedBySegmentCap = 0;
  let droppedByCharCap = 0;
  let usedChars = 0;

  for (const region of found) {
    const rawText = raw.slice(region.start, region.end);
    const normalizedText = normalizeForEvidence(rawText);
    if (!normalizedText) continue; // empty tag — ignored, does not consume the cap

    if (segments.length >= maxSegments) {
      droppedBySegmentCap += 1;
      continue;
    }

    const remaining = maxTotalChars - usedChars;
    if (remaining <= 0) {
      droppedByCharCap += rawText.length;
      continue;
    }

    if (rawText.length > remaining) {
      // Truncate at the segment boundary rather than dropping the whole segment, so a
      // player who wrote one long setting still gets most of it captured — and the
      // shortfall is reported so the UI can say so out loud.
      droppedByCharCap += rawText.length - remaining;
      const clippedRaw = rawText.slice(0, remaining);
      const clippedNormalized = normalizeForEvidence(clippedRaw);
      if (clippedNormalized) {
        segments.push({
          index: segments.length,
          rawText: clippedRaw,
          normalizedText: clippedNormalized,
          startOffset: region.start,
          endOffset: region.start + clippedRaw.length,
        });
        usedChars += clippedRaw.length;
      }
      continue;
    }

    segments.push({
      index: segments.length,
      rawText,
      normalizedText,
      startOffset: region.start,
      endOffset: region.end,
    });
    usedChars += rawText.length;
  }

  return { segments, droppedBySegmentCap, droppedByCharCap, hadMalformedTag };
}

/** Cheap predicate for "does this round carry a setting tag at all". */
export function hasSettingTag(raw: string, tagNames?: string[]): boolean {
  return scanSettingTags(raw, tagNames ? { tagNames } : undefined).segments.length > 0;
}

/** Parse the pack's comma/whitespace-separated tag-name fragment into a list. */
export function parseSettingTagNames(fragment: string | undefined): string[] {
  if (!fragment || typeof fragment !== 'string') return [...DEFAULT_SETTING_TAG_NAMES];
  const names = fragment
    .split(/[,，\s]+/u)
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 ? names : [...DEFAULT_SETTING_TAG_NAMES];
}
