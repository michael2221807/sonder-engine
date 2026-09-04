// App doc: docs/user-guide/pages/game-main.md §3.5（回合分隔线 · token 药丸 = 分步两次调用合计）
/**
 * Pure helpers for the RoundDivider + MainGamePanel divider placement.
 * Extracted from the .vue files so unit tests don't need @vue/test-utils.
 *
 * No Vue / reactive imports here — stays tree-shakeable and fast to test.
 */
import { estimateTextTokens } from '@/engine/core/metrics-helpers';

export interface RoundMetrics {
  roundNumber: number;
  durationMs: number;
  /** step1 / narrative-call input (historical meaning kept for old saves). */
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  /** Split-gen second call (R1 P0, 2026-09-03). Absent on single-call rounds and old saves. */
  step2InputTokens?: number;
  step2OutputTokens?: number;
  /** Whole-round totals (step1 + step2). What the divider pill shows when present. */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /**
   * Per-message provenance → tokens for each API call of the round (R1 P0). Not rendered
   * by the divider; consumed by the research helper `research-cloud-save-readonly.mjs
   * breakdown` to build the per-source budget report the Context Compiler needs.
   */
  breakdown?: {
    step1: Array<{ source: string; tokens: number }>;
    step2?: Array<{ source: string; tokens: number }>;
  };
}

export interface DividerMsg {
  role: 'user' | 'assistant' | 'system';
  content?: string;
  _metrics?: Partial<RoundMetrics> | undefined;
}

/**
 * Metrics for display — includes which fields are known vs recovered from content.
 * For rounds saved before Phase 1 landed, `inputTokens` and `durationMs` are
 * genuinely unrecoverable; `outputTokens` can still be estimated from `content`.
 * The divider UI shows `—` for `unknown` fields instead of faking a zero.
 */
export interface DisplayMetrics {
  roundNumber: number;
  durationMs: number | 'unknown';
  inputTokens: number | 'unknown';
  outputTokens: number | 'unknown';
}

/**
 * Count CJK (Chinese/Japanese/Korean) characters in a string.
 * Covers CJK Unified Ideographs
 * (U+4E00–U+9FFF), Extension A (U+3400–U+4DBF), and Compatibility
 * Ideographs (U+F900–U+FAFF). Used for the per-turn hover word-count.
 */
export function countCjkChars(text: string | null | undefined): number {
  if (!text) return 0;
  const match = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return match ? match.length : 0;
}

/** Truncate to N chars with ellipsis suffix when longer. */
export function truncate(text: string | null | undefined, n: number): string {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) + '…' : text;
}

/**
 * "139s" for whole seconds, "1.5s" when under 10s for precision.
 * `'unknown'` → `—` (em-dash) to distinguish "genuinely not recorded"
 * from a real 0s value.
 */
export function formatDuration(ms: number | 'unknown'): string {
  if (ms === 'unknown') return '—';
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

/**
 * en-US thousands separator via `toLocaleString('en-US')`.
 * `'unknown'` → `—` (em-dash).
 */
export function formatTokens(n: number | 'unknown'): string {
  if (n === 'unknown') return '—';
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.floor(n).toLocaleString('en-US');
}

/**
 * Derive the metrics to display for a given assistant message.
 *
 * - Modern entries (Phase 1 and later): return `_metrics` as-is.
 * - Legacy entries (no `_metrics`): return a synthetic `DisplayMetrics` with:
 *   - `outputTokens` estimated from `content` (we always have this)
 *   - `inputTokens` and `durationMs` flagged `'unknown'` (not recoverable)
 *   - `roundNumber` from the fallback counter
 *
 * This gives old saves parity: they still show a pill with the
 * output-tokens stat populated, with em-dash placeholders for the two
 * genuinely-missing fields.
 */
export function deriveDisplayMetrics(
  msg: DividerMsg,
  fallbackRoundNumber: number,
): DisplayMetrics {
  const metrics = msg._metrics;
  const hasFullMetrics =
    metrics != null &&
    typeof metrics.roundNumber === 'number' &&
    typeof metrics.durationMs === 'number' &&
    typeof metrics.inputTokens === 'number' &&
    typeof metrics.outputTokens === 'number';
  if (hasFullMetrics) {
    // Prefer whole-round totals: a split-gen round is two API calls and the player pays
    // for both. Old saves only carry the step1 figure, which is the best we have there.
    return {
      roundNumber: metrics.roundNumber as number,
      durationMs: metrics.durationMs as number,
      inputTokens: typeof metrics.totalInputTokens === 'number' ? metrics.totalInputTokens : (metrics.inputTokens as number),
      outputTokens: typeof metrics.totalOutputTokens === 'number' ? metrics.totalOutputTokens : (metrics.outputTokens as number),
    };
  }
  // Legacy / partial entry — recover what we can from content, mark the rest as unknown.
  const content = msg.content ?? '';
  const fallbackOutput = content ? estimateTextTokens(content) : ('unknown' as const);
  return {
    roundNumber: metrics?.roundNumber ?? fallbackRoundNumber,
    durationMs: typeof metrics?.durationMs === 'number' ? metrics.durationMs : 'unknown',
    inputTokens: typeof metrics?.inputTokens === 'number' ? metrics.inputTokens : 'unknown',
    outputTokens:
      typeof metrics?.outputTokens === 'number' ? metrics.outputTokens : fallbackOutput,
  };
}

/**
 * Index of the first assistant message. The opening round's divider is
 * suppressed (user directive: no divider before the opening scene). Returns
 * -1 when no assistant exists yet, which makes the "skip first" check a
 * no-op on empty/early game state.
 */
export function findFirstAssistantIdx(msgs: ReadonlyArray<DividerMsg>): number {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === 'assistant') return i;
  }
  return -1;
}

/**
 * Index of the latest assistant message. Drives the `isCurrent` prop —
 * Phase 3 uses this for current-vs-non-current asymmetry (commands button
 * is current-only per TurnItem convention).
 */
export function findLatestAssistantIdx(msgs: ReadonlyArray<DividerMsg>): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant') return i;
  }
  return -1;
}

/**
 * Round number to show on the divider for the assistant message at `idx`.
 * Prefers the persisted `_metrics.roundNumber` (Phase 1 stores this at
 * post-process time); falls back to counting assistant messages from the
 * start for legacy entries saved before Phase 1 landed.
 */
export function roundForAssistantAt(
  msgs: ReadonlyArray<DividerMsg>,
  idx: number,
): number {
  if (idx < 0 || idx >= msgs.length) return 0;
  const metricsRound = msgs[idx]?._metrics?.roundNumber;
  if (typeof metricsRound === 'number' && metricsRound > 0) return metricsRound;
  // Fallback: count assistant messages up through this index.
  let count = 0;
  for (let i = 0; i <= idx; i++) {
    if (msgs[i]?.role === 'assistant') count++;
  }
  return count;
}
