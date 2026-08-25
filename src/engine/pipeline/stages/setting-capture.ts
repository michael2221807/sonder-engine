// App doc: docs/user-guide/pages/game-main.md §3.15
/**
 * SettingCaptureStage — Canon Capture's deterministic gate.
 *
 * Runs between CommandExecution and PostProcess. The model proposes semantics; this
 * stage decides what is actually written. Nothing reaches the auto-settings book that
 * cannot be traced to text the player typed inside a `<设定>` tag THIS round.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **Fail-soft.** A narrative round that generated successfully must never fail
 *    because setting capture had a problem. Every internal error becomes a rejected
 *    candidate, not a thrown exception.
 * 2. **Four-way result, not pass/fail.** `accepted` / `noops` / `rejected` are
 *    reported separately so the UI can tell the player "already recorded" instead of
 *    "failed to record" when they re-state a setting they already have. Collapsing
 *    those two into "accepted === 0" produces a straight-up lie.
 *
 * Design: `docs/design/canon-ledger-setting-capture.md` §6.
 */
import { eventBus } from '../../core/event-bus';
import type { PipelineStage, PipelineContext, EnginePathConfig } from '../types';
import type { StateManager } from '../../core/state-manager';
import type { RawSettingUpdate } from '../../ai/types';
import type { WorldBook, WorldBookEntry, CapturedSettingKind } from '../../prompt/world-book';
import {
  scanSettingTags,
  normalizeForEvidence,
  type SettingTagSegment,
  type ScanSettingTagsResult,
} from '../../prompt/setting-tag-scanner';
import {
  addCapturedEntry,
  activeCapturedEntries,
  bumpInjectionCounters,
  createCapturedBook,
  findCapturedBook,
  filterAnchors,
  normalizeForIdentity,
  upsertCapturedBook,
  FALLBACK_CAPTURED_LABELS,
  MAX_ACTIVE_CAPTURED_ENTRIES,
  MAX_ANCHORS,
  MAX_CANDIDATES_PER_ROUND,
  MAX_CAPTURED_CONTENT_CHARS,
  MAX_CAPTURED_EVIDENCE_CHARS,
  MAX_ENTITIES,
  type CapturedSettingLabels,
  type SettingUpdateCandidate,
} from '../../prompt/captured-entry-mutations';

// ─── Result contract (design §6.3) ──────────────────────────

export type SettingRejectReason =
  | 'no_tag'
  | 'shape'
  | 'too_long'
  | 'no_evidence'
  | 'cross_segment'
  | 'bad_anchor'
  | 'bad_entity'
  | 'capacity'
  | 'overflow'
  | 'internal_error';

export interface AcceptedSettingMutation {
  entryId: string;
  candidate: SettingUpdateCandidate;
}

export interface SettingNoop {
  candidate: SettingUpdateCandidate;
  existingEntryId: string;
}

export interface SettingRejection {
  /** Null when the item was too malformed to even shape into a candidate. */
  candidate: SettingUpdateCandidate | null;
  reason: SettingRejectReason;
  /** Short machine-readable detail for the debug panel. Never shown raw to players. */
  detail?: string;
}

export interface SettingCaptureResult {
  accepted: AcceptedSettingMutation[];
  noops: SettingNoop[];
  rejected: SettingRejection[];
  /** This round's tag content — used to pre-fill the manual-add fallback. */
  segments: SettingTagSegment[];
  /** Scanner-level losses (segment cap / char cap / malformed tags). */
  scan: Omit<ScanSettingTagsResult, 'segments'>;
  /** True when the round carried at least one well-formed tag. */
  hadTag: boolean;
}

/**
 * Compact, persisted summary of the most recent capture round.
 *
 * Exists because a 10-second toast is the wrong medium for "your explicit request
 * failed": a player reading a long reply misses it, and then nothing anywhere tells
 * them what happened or offers the manual fallback. The world-book panel renders this
 * as a standing banner until the next tagged round overwrites it.
 *
 * Deliberately tiny (counts + a capped preview, no candidate objects): it lives in the
 * save and is cloned into the pre-round snapshot every round like the rest of the tree.
 */
export interface SettingCaptureLastRecord {
  round: number;
  at: number;
  accepted: number;
  noops: number;
  rejected: Array<{ reason: SettingRejectReason; count: number }>;
  /** The tag content the player wrote, capped — pre-fills the manual-add draft. */
  segmentsPreview: string;
}

/** Cap on the persisted preview — enough to re-add by hand, small enough for a save. */
export const SEGMENTS_PREVIEW_MAX_CHARS = 600;

export const EMPTY_CAPTURE_RESULT: SettingCaptureResult = {
  accepted: [],
  noops: [],
  rejected: [],
  segments: [],
  scan: { droppedBySegmentCap: 0, droppedByCharCap: 0, hadMalformedTag: false },
  hadTag: false,
};

const VALID_KINDS: ReadonlySet<string> = new Set<CapturedSettingKind>([
  'character',
  'relationship',
  'world_fact',
]);

/** Control markers a statement must never smuggle in. */
const CONTROL_MARKER_RE = /[<>]|\{\{|\}\}/u;

export interface SettingCaptureDeps {
  /** Whether capture is active this round (world book master switch AND the feature switch). */
  isEnabled: () => boolean;
  /** Accepted tag names, from the pack. */
  getTagNames: () => string[];
  /** Display labels, from the pack. */
  getLabels: () => CapturedSettingLabels;
  /**
   * Anchor stopwords, from the pack. Word lists are CONTENT, so the engine ships none;
   * an absent dep simply means no stopword filtering (single-char filtering still runs).
   */
  getAnchorStopwords?: () => string[];
}

// ─── Helpers ────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Locate `needle` inside exactly ONE segment and return the ORIGINAL text spanning it.
 *
 * Cross-segment matching is forbidden: with `<设定>林月</设定>…<设定>怕水</设定>`, a
 * concatenated haystack makes "林月怕水" a valid substring even though the player never
 * wrote it — which is precisely the fabrication the evidence gate exists to stop.
 *
 * The stored evidence is sliced from the player's ORIGINAL text (not the model's
 * normalized echo), because the panel promises to show "the player's own words".
 */
/**
 * Punctuation-insensitive normalization — the SECOND matching tier.
 *
 * Why it exists (2026-08-25, the structural fix): the strict tier demands a verbatim
 * contiguous substring, and over a long Chinese passage the model routinely drifts on
 * punctuation alone — a half-width comma for a full-width one, dropped quote marks,
 * "……" vs "…". Each such drift used to kill the candidate as `no_evidence`, which
 * punished the player for marking a LONG setting — the exact case the feature is for.
 *
 * Safety is unchanged in kind: the quote must still be a contiguous substring of ONE
 * segment after the same transform. Ignoring punctuation cannot fabricate content the
 * player never wrote — it only stops punctuation from vetoing content they did write.
 */
export function normalizeLoose(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
}

/**
 * Map a range in the LOOSE-normalized text back to the raw text.
 *
 * Builds an explicit loose-index → raw-index table (each kept character records where
 * it came from), so the recovered quote is the player's original writing including its
 * own punctuation. Falls back to null when the range cannot be mapped.
 */
function sliceOriginalForLooseRange(
  raw: string,
  looseStart: number,
  looseLength: number,
): string | null {
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i].normalize('NFKC');
    if (/[\p{P}\p{S}\s]/u.test(ch)) continue;
    for (let k = 0; k < ch.length; k++) map.push(i);
  }
  const endIdx = looseStart + looseLength - 1;
  if (looseStart < 0 || endIdx >= map.length) return null;
  const sliced = raw.slice(map[looseStart], map[endIdx] + 1).trim();
  return sliced || null;
}

export function matchEvidenceInSegments(
  evidence: string,
  segments: readonly SettingTagSegment[],
): { segmentIndex: number; originalText: string } | null {
  const needle = normalizeForEvidence(evidence);
  if (!needle) return null;

  // Tier 2 needle, computed once. Empty when the evidence is all punctuation —
  // such a "quote" locates nothing and must not match everything.
  const needleLoose = normalizeLoose(evidence);

  for (const segment of segments) {
    const at = segment.normalizedText.indexOf(needle);
    if (at === -1) {
      // ── Tier 2: punctuation-insensitive, same-segment, still contiguous ──
      if (needleLoose.length >= 4) {
        const segLoose = normalizeLoose(segment.rawText);
        const looseAt = segLoose.indexOf(needleLoose);
        if (looseAt !== -1) {
          const sliced = sliceOriginalForLooseRange(segment.rawText, looseAt, needleLoose.length);
          // Verify the recovery round-trips; a wide fallback is fine, a wrong one is not.
          const trustworthy = sliced !== null && normalizeLoose(sliced).includes(needleLoose);
          return {
            segmentIndex: segment.index,
            originalText: trustworthy && sliced ? sliced : segment.rawText.trim(),
          };
        }
      }
      continue;
    }

    const sliced = sliceOriginalForNormalizedRange(segment, at, needle.length);
    // VERIFY before trusting the walk below. `normalizeForEvidence` normalizes the
    // whole string at once, while the walk normalizes one code unit at a time — and
    // NFKC composition is context-dependent (a base char + a following combining mark
    // compose only when normalized together, e.g. NFD-form "e"+U+0301 → "é"). When the
    // two disagree the walk's offsets drift and can return a DIFFERENT fragment, which
    // would be persisted as "the player's own words". A slightly wide quote is fine;
    // a wrong one is not — so fall back to the whole segment when the slice does not
    // round-trip.
    const trustworthy = normalizeForEvidence(sliced).includes(needle);
    return {
      segmentIndex: segment.index,
      originalText: trustworthy ? sliced : segment.rawText.trim(),
    };
  }
  return null;
}

/**
 * Map a range in the NORMALIZED text back to the raw text.
 *
 * Normalization folds whitespace runs, so offsets are not 1:1. Walk the raw string
 * while re-deriving the normalized position, which keeps the mapping exact instead of
 * approximating with index arithmetic. Falls back to the whole segment if the walk
 * cannot land cleanly — a slightly wide quote is acceptable; a WRONG one is not.
 */
function sliceOriginalForNormalizedRange(
  segment: SettingTagSegment,
  normalizedStart: number,
  normalizedLength: number,
): string {
  const raw = segment.rawText;
  const normalizedEnd = normalizedStart + normalizedLength;

  let normPos = 0;
  let rawStart = -1;
  let rawEnd = -1;
  let pendingSpace = false;

  for (let i = 0; i <= raw.length; i++) {
    if (normPos === normalizedStart && rawStart === -1) rawStart = i;
    if (normPos === normalizedEnd) { rawEnd = i; break; }
    if (i === raw.length) break;

    const chunk = raw[i].normalize('NFKC');
    if (/\s/u.test(chunk)) {
      // A whitespace run collapses to a single space, and leading whitespace vanishes.
      if (normPos > 0 && !pendingSpace) { pendingSpace = true; }
      continue;
    }
    if (pendingSpace) { normPos += 1; pendingSpace = false; if (normPos === normalizedEnd) { rawEnd = i; break; } }
    if (normPos === normalizedStart && rawStart === -1) rawStart = i;
    normPos += chunk.length;
  }

  if (rawStart === -1) return raw.trim();
  if (rawEnd === -1) rawEnd = raw.length;
  const sliced = raw.slice(rawStart, rawEnd).trim();
  return sliced || raw.trim();
}

/**
 * Tell a cross-segment stitch apart from an outright fabrication.
 *
 * `cross_segment` means: the evidence WOULD have matched if the separate tag segments
 * were (illegally) concatenated — the model stitched two different tags together.
 * Anything else is the model quoting something the player never wrote inside a tag.
 * Picking the label from "did this round have more than one tag" mislabels plain
 * fabrication as stitching and hides the more serious failure.
 */
export function classifyEvidenceFailure(
  evidence: string,
  segments: readonly SettingTagSegment[],
): 'cross_segment' | 'no_evidence' {
  if (segments.length < 2) return 'no_evidence';
  const needle = normalizeForEvidence(evidence);
  if (!needle) return 'no_evidence';
  const stitched = segments.map((sgm) => sgm.normalizedText).join('');
  if (stitched.includes(needle)) return 'cross_segment';
  // Mirror the matcher's loose tier so the label stays honest at both strictness levels.
  const needleLoose = normalizeLoose(evidence);
  if (needleLoose.length >= 4) {
    const stitchedLoose = segments.map((sgm) => normalizeLoose(sgm.rawText)).join('');
    if (stitchedLoose.includes(needleLoose)) return 'cross_segment';
  }
  return 'no_evidence';
}

/** Every token must actually appear in the statement or the evidence. */
function tokenAppears(token: string, statement: string, evidence: string): boolean {
  const t = normalizeForIdentity(token);
  if (!t) return false;
  return normalizeForIdentity(statement).includes(t) || normalizeForIdentity(evidence).includes(t);
}

// ─── The stage ──────────────────────────────────────────────

export class SettingCaptureStage implements PipelineStage {
  name = 'SettingCapture';

  constructor(
    private stateManager: StateManager,
    private paths: EnginePathConfig,
    private deps: SettingCaptureDeps,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    let result: SettingCaptureResult = EMPTY_CAPTURE_RESULT;
    try {
      result = this.capture(ctx);
    } catch (err) {
      // Fail-soft: a capture problem must never sink a narrative round that worked.
      console.warn('[SettingCapture] failed (non-blocking):', err);
      result = {
        ...EMPTY_CAPTURE_RESULT,
        rejected: [{
          candidate: null,
          reason: 'internal_error',
          detail: err instanceof Error ? err.message : String(err),
        }],
      };
    }

    // Injection counters ride the same write as the capture itself, so a rollback
    // takes both back together.
    try {
      this.bumpHitCounters(ctx);
    } catch (err) {
      console.warn('[SettingCapture] hit-counter write failed (non-blocking):', err);
    }

    // Persist the round summary for the panel's standing banner — but ONLY on tagged
    // rounds, so a save that never touches the feature stays byte-identical.
    if (result.hadTag) {
      try {
        this.writeLastRecord(ctx, result);
      } catch (err) {
        console.warn('[SettingCapture] last-record write failed (non-blocking):', err);
      }
    }

    // Tell the UI what happened. Only when the round actually carried a tag — an
    // ordinary round must produce no notification at all.
    if (result.hadTag) {
      try {
        eventBus.emit('settingCapture:result', result);
      } catch (err) {
        console.warn('[SettingCapture] result event failed (non-blocking):', err);
      }
    }

    return { ...ctx, meta: { ...ctx.meta, settingCapture: result } };
  }

  // ── Core ──

  private capture(ctx: PipelineContext): SettingCaptureResult {
    if (!this.deps.isEnabled()) return EMPTY_CAPTURE_RESULT;

    const original = ctx.originalUserInput ?? ctx.userInput ?? '';
    const scan = scanSettingTags(original, { tagNames: this.deps.getTagNames() });
    const { segments, ...scanMeta } = scan;

    const raw = ctx.parsedResponse?.settingUpdates;
    const hadTag = segments.length > 0;

    if (!hadTag) {
      // No tag → nothing is capturable, whatever the model emitted. Report the model's
      // items as rejected rather than pretending they never existed, so a prompt bug
      // that makes the model volunteer settings every round is visible in debug.
      const rejected: SettingRejection[] = (raw ?? []).map(() => ({
        candidate: null,
        reason: 'no_tag' as const,
      }));
      return { ...EMPTY_CAPTURE_RESULT, rejected, scan: scanMeta, hadTag: false };
    }

    if (!raw || raw.length === 0) {
      return { ...EMPTY_CAPTURE_RESULT, segments, scan: scanMeta, hadTag: true };
    }

    const round = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
    const labels = this.deps.getLabels();
    const stopwords = this.deps.getAnchorStopwords?.() ?? [];
    const inputHash = normalizeForIdentity(segments.map((s) => s.normalizedText).join(''));

    const slotBooks = this.readSlotBooks();
    let book = findCapturedBook(slotBooks) ?? createCapturedBook(labels);

    const accepted: AcceptedSettingMutation[] = [];
    const noops: SettingNoop[] = [];
    const rejected: SettingRejection[] = [];

    // Statement → entry id for active entries, for the deterministic no-op check.
    const activeByStatement = new Map<string, string>();
    for (const entry of activeCapturedEntries(book)) {
      activeByStatement.set(normalizeForIdentity(entry.content), entry.id);
    }
    let activeCount = activeCapturedEntries(book).length;

    for (let i = 0; i < raw.length; i++) {
      if (i >= MAX_CANDIDATES_PER_ROUND) {
        // Visible, not silent: the player typed these by hand.
        rejected.push({ candidate: null, reason: 'overflow' });
        continue;
      }

      const shaped = this.shape(raw[i]);
      if (!shaped.ok) {
        rejected.push({ candidate: null, reason: shaped.reason, detail: shaped.detail });
        continue;
      }
      const candidate = shaped.candidate;

      const evidenceHit = matchEvidenceInSegments(candidate.evidence, segments);
      if (!evidenceHit) {
        // Distinguish the two failures honestly: `cross_segment` means the evidence
        // WOULD have matched if the segments were (illegally) concatenated — i.e. the
        // model stitched across two separate tags. Anything else is plain fabrication.
        // Choosing by "did this round have >1 tag" mislabels fabrication as stitching.
        rejected.push({ candidate, reason: classifyEvidenceFailure(candidate.evidence, segments) });
        continue;
      }
      // Persist the PLAYER's original words, not the model's paraphrase. Rebuilt rather
      // than mutated in place, to keep candidates immutable like everything else here.
      const validated: SettingUpdateCandidate = {
        ...candidate,
        evidence: evidenceHit.originalText.slice(0, MAX_CAPTURED_EVIDENCE_CHARS),
      };

      // Anchor quality (design §6.2 rule 6). Two separate concerns:
      //  a) every anchor must actually occur in the statement or the evidence —
      //     otherwise the model invented a retrieval key out of thin air;
      //  b) single characters and pack-declared stopwords are dropped, because such an
      //     anchor matches almost any sentence and would make the entry a permanent
      //     resident of the prompt budget while contributing nothing to relevance.
      // If (b) leaves nothing behind, the entry could never be retrieved → reject it
      // rather than silently storing something unreachable.
      const badAnchor = validated.anchors.find(
        (a) => !tokenAppears(a, validated.statement, validated.evidence),
      );
      if (validated.anchors.length === 0 || badAnchor !== undefined) {
        rejected.push({ candidate: validated, reason: 'bad_anchor', detail: badAnchor });
        continue;
      }
      const { kept: usableAnchors, dropped: weakAnchors } =
        filterAnchors(validated.anchors, stopwords);
      if (usableAnchors.length === 0) {
        rejected.push({
          candidate: validated,
          reason: 'bad_anchor',
          detail: `weak:${weakAnchors.join('/')}`,
        });
        continue;
      }
      const withAnchors: SettingUpdateCandidate = { ...validated, anchors: usableAnchors };

      const badEntity = withAnchors.entities.find(
        (e) => !tokenAppears(e, withAnchors.statement, withAnchors.evidence),
      );
      if (badEntity !== undefined) {
        rejected.push({ candidate: withAnchors, reason: 'bad_entity', detail: badEntity });
        continue;
      }

      const identity = normalizeForIdentity(withAnchors.statement);
      const existingId = activeByStatement.get(identity);
      if (existingId) {
        // Deterministic no-op — NOT a failure. Telling the player "could not record"
        // when the setting is already recorded is worse than saying nothing.
        noops.push({ candidate: withAnchors, existingEntryId: existingId });
        continue;
      }

      if (activeCount >= MAX_ACTIVE_CAPTURED_ENTRIES) {
        rejected.push({ candidate: withAnchors, reason: 'capacity' });
        continue;
      }

      const added = addCapturedEntry(book, withAnchors, { round, inputHash, labels });
      book = added.book;
      activeByStatement.set(identity, added.entry.id);
      activeCount += 1;
      accepted.push({ entryId: added.entry.id, candidate: withAnchors });
    }

    if (accepted.length > 0) {
      this.writeSlotBooks(upsertCapturedBook(slotBooks, book));
    }

    return { accepted, noops, rejected, segments, scan: scanMeta, hadTag: true };
  }

  /** Shape + enum + length checks. Produces a candidate or a typed rejection. */
  private shape(raw: RawSettingUpdate):
    | { ok: true; candidate: SettingUpdateCandidate }
    | { ok: false; reason: SettingRejectReason; detail?: string } {
    // Guard the item itself, not just its fields. A `null` / non-object slipping through
    // would throw here, and the fail-soft wrapper would then discard the WHOLE batch —
    // turning one malformed item into the loss of every other setting the player marked
    // that round. The contract is per-candidate rejection.
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'shape', detail: 'item' };

    const kind = asString(raw.kind);
    if (!kind || !VALID_KINDS.has(kind)) return { ok: false, reason: 'shape', detail: 'kind' };

    const statement = asString(raw.statement)?.trim();
    if (!statement) return { ok: false, reason: 'shape', detail: 'statement' };
    if (CONTROL_MARKER_RE.test(statement)) return { ok: false, reason: 'shape', detail: 'control_marker' };
    // Reject rather than truncate: a half-sentence rule is worse than no rule.
    if (statement.length > MAX_CAPTURED_CONTENT_CHARS) return { ok: false, reason: 'too_long', detail: 'statement' };

    const evidence = asString(raw.evidence)?.trim();
    if (!evidence) return { ok: false, reason: 'shape', detail: 'evidence' };
    if (evidence.length > MAX_CAPTURED_EVIDENCE_CHARS) return { ok: false, reason: 'too_long', detail: 'evidence' };

    const anchors = asStringArray(raw.anchors);
    if (anchors === null) return { ok: false, reason: 'shape', detail: 'anchors' };
    if (anchors.length > MAX_ANCHORS) return { ok: false, reason: 'too_long', detail: 'anchors' };

    const entities = asStringArray(raw.entities);
    if (entities === null) return { ok: false, reason: 'shape', detail: 'entities' };
    if (entities.length > MAX_ENTITIES) return { ok: false, reason: 'too_long', detail: 'entities' };
    const deduped = [...new Set(entities.map((e) => e.trim()).filter(Boolean))];
    if (deduped.length !== entities.length) return { ok: false, reason: 'bad_entity', detail: 'duplicate' };

    return {
      ok: true,
      candidate: {
        kind: kind as CapturedSettingKind,
        statement,
        evidence,
        anchors,
        entities: deduped,
      },
    };
  }

  /** Fold this round's injection hits into the captured entries' counters. */
  private bumpHitCounters(ctx: PipelineContext): void {
    const hits = ctx.meta['capturedHits'];
    if (!Array.isArray(hits) || hits.length === 0) return;
    const ids = hits.filter((h): h is string => typeof h === 'string');
    if (ids.length === 0) return;

    const books = this.readSlotBooks();
    const book = findCapturedBook(books);
    if (!book) return;

    const round = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
    const next = bumpInjectionCounters(book, ids, round);
    if (next !== book) this.writeSlotBooks(upsertCapturedBook(books, next));
  }

  /** Fold the round result into the persisted `settingCaptureLast` summary. */
  private writeLastRecord(ctx: PipelineContext, result: SettingCaptureResult): void {
    const reasonCounts = new Map<SettingRejectReason, number>();
    for (const r of result.rejected) {
      reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
    }
    const record: SettingCaptureLastRecord = {
      round: this.stateManager.get<number>(this.paths.roundNumber) ?? ctx.roundNumber ?? 0,
      at: Date.now(),
      accepted: result.accepted.length,
      noops: result.noops.length,
      rejected: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
      segmentsPreview: result.segments
        .map((seg) => seg.rawText)
        .join('\n')
        .slice(0, SEGMENTS_PREVIEW_MAX_CHARS),
    };
    this.stateManager.set(this.paths.settingCaptureLast, record, 'system');
  }

  private readSlotBooks(): WorldBook[] {
    const raw = this.stateManager.get<WorldBook[]>(this.paths.slotWorldBooks);
    return Array.isArray(raw) ? raw : [];
  }

  private writeSlotBooks(books: WorldBook[]): void {
    this.stateManager.set(this.paths.slotWorldBooks, books, 'system');
  }
}

/** Entries of the captured book in a slot book list — small helper for consumers. */
export function readCapturedEntries(books: WorldBook[] | undefined): WorldBookEntry[] {
  return findCapturedBook(books)?.entries ?? [];
}

export { FALLBACK_CAPTURED_LABELS };
