<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.5 (卫星按钮，含 ★ 收藏)
// Archived plan: docs/research/mrjh-migration/archive/06-round-divider-plan.md
/**
 * RoundDivider — a visual break between rounds in the MainGamePanel message
 * stream. Shows a horizontal rule with a centered "第 N 回合" badge, and an
 * optional token/duration stats pill below.
 *
 * Basic badge + metrics pill; the satellite buttons (thinking / commands / raw-view / bookmark)
 * are rendered inline.
 *
 * Layout reference: TurnItem's outer wrapper pattern.
 * AGA uses its own design tokens — no Tailwind.
 *
 * Data contract: `metrics` maps to `narrativeHistory[i]._metrics` on the
 * assistant entry. `_metrics` is UI-private; it never reaches the AI prompt
 * (see src/engine/pipeline/stages/context-assembly.ts `wrap()` and
 * src/engine/memory/snapshot-sanitizer.ts `PROMPT_ALWAYS_STRIP_PATHS`).
 */
import {
  formatDuration,
  formatTokens,
  type DisplayMetrics,
} from './round-divider-helpers';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

interface Props {
  /** Which round this divider precedes. */
  roundNumber: number;
  /**
   * Display-ready metrics (either Phase 1 `_metrics` or a legacy-synthesized
   * subset with `'unknown'` placeholders for un-recoverable fields).
   * Caller uses `deriveDisplayMetrics()` to normalize both cases.
   */
  metrics?: DisplayMetrics;
  /**
   * Whether this divider sits above the latest assistant message.
   * Controls satellite-button visibility asymmetry:
   *   - Commands button: shown iff `isCurrent && hasCommands`
   *   - Thinking / Raw buttons: always shown when their data is present
   */
  isCurrent?: boolean;
  /** Show the 🌐 thinking button (left cluster). */
  hasThinking?: boolean;
  /** Show the ☰ commands button (right cluster, current-round only). */
  hasCommands?: boolean;
  /** Show the ⮂ raw-response button (right cluster). */
  hasRaw?: boolean;
  /** Show the 🧠 Engram button (right cluster). */
  hasEngram?: boolean;
  /**
   * Polish state for this round (Phase 4, 2026-04-19).
   * `applied === true` means the round was polished — badge becomes clickable
   * and shows the 已自动优化 / 已手动优化 subtitle. Toggle state lives in
   * MainGamePanel (see `showingOriginalForRound`).
   */
  polish?: {
    applied: boolean;
    manual?: boolean;
    model?: string;
  };
  /** True when parent is currently showing the pre-polish original text. */
  showingOriginal?: boolean;
  /**
   * Whether this round is bookmarked (收藏楼层, 2026-07-18).
   * Filled ★ when true, outline ☆ when false. Shown for every round
   * (current + past) so any floor can be collected in place.
   */
  isBookmarked?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isCurrent: false,
  hasThinking: false,
  hasCommands: false,
  hasRaw: false,
  hasEngram: false,
  showingOriginal: false,
  isBookmarked: false,
});

const emit = defineEmits<{
  /** Left cluster — 🌐: open CoT viewer for this round */
  'view-thinking': [];
  /** Right cluster — ☰: open commands + delta viewer (current round only) */
  'view-commands': [];
  /** Right cluster — ⮂: open raw-response viewer */
  'view-raw': [];
  /** Right cluster — 🧠: open Engram round viewer */
  'view-engram': [];
  /** Center badge click — request parent to flip the 优化/原文 view for this round. */
  'toggle-original': [];
  /** Right cluster — ★: toggle bookmark (收藏楼层) for this round. */
  'toggle-bookmark': [];
}>();

function onBadgeClick(): void {
  if (props.polish?.applied) emit('toggle-original');
}
</script>

<template>
  <div class="round-divider" :class="{ 'round-divider--current': props.isCurrent }">
    <!-- Top row: horizontal rule + left cluster + centered badge + right cluster + horizontal rule -->
    <div class="round-divider__top">
      <span class="round-divider__line" aria-hidden="true" />

      <div class="round-divider__actions round-divider__actions--left">
        <!-- 🌐 Thinking button — shown whenever this round has CoT data (both current + past rounds). -->
        <Tooltip
          v-if="props.hasThinking"
          :text="$t('mainGame.roundDivider.thinkingTitle')"
          interactive
        >
          <button
            type="button"
            class="round-divider__icon-btn"
            :aria-label="$t('mainGame.roundDivider.thinkingAriaLabel')"
            @click="$emit('view-thinking')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A8.959 8.959 0 0 1 3 12c0-.778.099-1.533.284-2.253" />
            </svg>
          </button>
        </Tooltip>
        <!-- 🧠 Engram button — moved to left cluster for visual balance. -->
        <Tooltip
          v-if="props.hasEngram"
          :text="$t('mainGame.roundDivider.engramTitle')"
          interactive
        >
          <button
            type="button"
            class="round-divider__icon-btn round-divider__icon-btn--engram"
            :aria-label="$t('mainGame.roundDivider.engramAriaLabel')"
            @click="$emit('view-engram')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <Tooltip
        v-if="props.polish?.applied"
        :text="$t(props.showingOriginal ? 'mainGame.roundDivider.toggleToPolished' : 'mainGame.roundDivider.toggleToOriginal')"
        interactive
      >
        <button
          type="button"
          class="round-divider__badge round-divider__badge--clickable"
          :aria-pressed="props.showingOriginal"
          @click="onBadgeClick"
        >
          <span class="round-divider__badge-main">{{ $t('mainGame.roundDivider.badge', { n: props.roundNumber }) }}</span>
          <span class="round-divider__badge-sub">
            {{ props.polish.manual ? $t('mainGame.roundDivider.polishManual') : $t('mainGame.roundDivider.polishAuto') }}
            ·
            {{ props.showingOriginal ? $t('mainGame.roundDivider.viewOriginal') : $t('mainGame.roundDivider.viewPolished') }}
          </span>
        </button>
      </Tooltip>
      <div v-else class="round-divider__badge">
        <span class="round-divider__badge-main">{{ $t('mainGame.roundDivider.badge', { n: props.roundNumber }) }}</span>
      </div>

      <div class="round-divider__actions round-divider__actions--right">
        <!-- ☰ Commands button — current round only. -->
        <Tooltip
          v-if="props.isCurrent && props.hasCommands"
          :text="$t('mainGame.roundDivider.commandsTitle')"
          interactive
        >
          <button
            type="button"
            class="round-divider__icon-btn round-divider__icon-btn--commands"
            :aria-label="$t('mainGame.roundDivider.commandsAriaLabel')"
            @click="$emit('view-commands')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 5.25h16.5m-16.5 6.75h16.5m-16.5 6.75h16.5" />
            </svg>
          </button>
        </Tooltip>
        <!-- ⮂ Raw-response button — shown whenever this round has raw text (both current + past rounds). -->
        <Tooltip
          v-if="props.hasRaw"
          :text="$t('mainGame.roundDivider.rawTitle')"
          interactive
        >
          <button
            type="button"
            class="round-divider__icon-btn"
            :aria-label="$t('mainGame.roundDivider.rawAriaLabel')"
            @click="$emit('view-raw')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
            </svg>
          </button>
        </Tooltip>
        <!-- ★ Bookmark button — shown for every round (current + past) so any floor
             can be collected in place (收藏楼层, 2026-07-18). -->
        <Tooltip
          :text="$t(props.isBookmarked ? 'mainGame.roundDivider.bookmarkRemoveTitle' : 'mainGame.roundDivider.bookmarkAddTitle')"
          interactive
        >
          <button
            type="button"
            class="round-divider__icon-btn round-divider__icon-btn--bookmark"
            :class="{ 'round-divider__icon-btn--bookmarked': props.isBookmarked }"
            data-testid="round-bookmark-btn"
            :aria-pressed="props.isBookmarked"
            :aria-label="$t(props.isBookmarked ? 'mainGame.roundDivider.bookmarkRemoveAriaLabel' : 'mainGame.roundDivider.bookmarkAddAriaLabel')"
            @click="$emit('toggle-bookmark')"
          >
            <svg v-if="props.isBookmarked" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <span class="round-divider__line" aria-hidden="true" />
    </div>

    <!-- Token / duration pill, only when metrics available -->
    <Tooltip
      v-if="props.metrics"
      :text="$t('mainGame.roundDivider.metricsTitle', { n: props.metrics.roundNumber })"
    >
      <div class="round-divider__pill">
        <span class="round-divider__stat round-divider__stat--input" :aria-label="$t('mainGame.roundDivider.inputTokensLabel')">
          <span class="round-divider__stat-icon">↑</span>
          <span class="round-divider__stat-value">{{ formatTokens(props.metrics.inputTokens) }}</span>
        </span>
        <span class="round-divider__sep" aria-hidden="true" />
        <span class="round-divider__stat round-divider__stat--duration" :aria-label="$t('mainGame.roundDivider.durationLabel')">
          <span class="round-divider__stat-icon">◷</span>
          <span class="round-divider__stat-value">{{ formatDuration(props.metrics.durationMs) }}</span>
        </span>
        <span class="round-divider__sep" aria-hidden="true" />
        <span class="round-divider__stat round-divider__stat--output" :aria-label="$t('mainGame.roundDivider.outputTokensLabel')">
          <span class="round-divider__stat-icon">↓</span>
          <span class="round-divider__stat-value">{{ formatTokens(props.metrics.outputTokens) }}</span>
        </span>
      </div>
    </Tooltip>
  </div>
</template>

<style scoped>
/*
 * RoundDivider — sanctuary migration (Phase 2.5, 2026-04-20).
 * Scoped style only; template + script untouched.
 *
 * Current round: sage inner-ring glow on the center badge (not indigo).
 * Polish badge: amber subtitle (not Tailwind amber-400/0.5).
 * Satellite buttons: sage hover for thinking/raw, amber hover for
 * commands (signals "state change" semantic with the warm beacon).
 * Metrics pill: sage/amber/sage for ↑ input / ◷ duration / ↓ output —
 * replaces the violet/cyan/yellow Tailwind trio.
 */
.round-divider {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: var(--space-xl) 0 var(--space-lg);
  gap: var(--space-xs);
}

.round-divider__top {
  display: flex;
  align-items: center;
  width: 100%;
  gap: var(--space-sm);
}

/* Horizontal rules — sage accent gradient with slow breath */
.round-divider__line {
  flex: 1;
  height: 1px;
  background: var(--accent-sage);
  opacity: 0.5;
  animation: lumi-pulse calc(var(--lumi-pulse) * 1.6) ease-in-out infinite;
}

.round-divider__actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-shrink: 0;
}

.round-divider__actions:empty {
  display: none;
}

/* Satellite icon buttons (🌐 thinking / ☰ commands / ⮂ raw) */
.round-divider__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  color: var(--color-text-umber);
  cursor: pointer;
  transition:
    color var(--duration-normal) var(--ease-out),
    border-color var(--duration-normal) var(--ease-out),
    background var(--duration-normal) var(--ease-out);
}

.round-divider__icon-btn:hover {
  color: var(--color-sage-400);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, var(--color-border));
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    color-mix(in oklch, var(--color-sage-400) 4%, transparent));
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.round-divider__icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* Engram button: teal-ish hover (knowledge-graph semantic, distinct from sage/amber) */
.round-divider__icon-btn--engram:hover {
  color: #5ba8a0;
  border-color: color-mix(in oklch, #5ba8a0 35%, var(--color-border));
  background: color-mix(in oklch, #5ba8a0 6%, transparent);
}

/*
 * Commands button gets AMBER hover — "state change" is a warm beacon
 * per the sanctuary brief (sage = everyday state, amber = confirmation
 * / narrative emphasis / "something settled"). Replaces the old green.
 */
.round-divider__icon-btn--commands:hover {
  color: var(--color-amber-400);
  border-color: color-mix(in oklch, var(--color-amber-400) 35%, var(--color-border));
  background: color-mix(in oklch, var(--color-amber-400) 6%, transparent);
}

/*
 * Bookmark button (★) — amber beacon, matching the "something the player
 * chose to keep" warmth (sanctuary brief: amber = rare, deliberate). Resting
 * state is a neutral outline ☆; hover previews amber; the bookmarked state
 * fills the star and lights the amber wash so a collected floor reads at a glance.
 */
.round-divider__icon-btn--bookmark:hover {
  color: var(--color-amber-400);
  border-color: color-mix(in oklch, var(--color-amber-400) 35%, var(--color-border));
  background: color-mix(in oklch, var(--color-amber-400) 6%, transparent);
}
.round-divider__icon-btn--bookmarked {
  color: var(--color-amber-400);
  border-color: color-mix(in oklch, var(--color-amber-400) 45%, var(--color-border));
  background: color-mix(in oklch, var(--color-amber-400) 10%, transparent);
}
.round-divider__icon-btn--bookmarked:hover {
  color: var(--color-amber-300);
}
/*
 * Center badge — serif pill, warm translucent bg (not cold black).
 * The subtle backdrop-filter helps it sit against either sidebar canvas
 * or narrative prose without a hard edge.
 */
.round-divider__badge {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  padding: var(--space-xs) var(--space-lg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-surface-elevated) 60%, transparent);
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
  box-shadow: var(--lumi-inset-highlight);
  color: var(--color-text-umber);
  font-family: var(--font-serif-cjk);
  font-size: var(--font-size-xs);
  font-weight: 500;
  letter-spacing: 0.2em;
  line-height: 1.2;
  white-space: nowrap;
}

/* Clickable variant — toggles 优化/原文 when polish applied */
.round-divider__badge--clickable {
  cursor: pointer;
  border-style: dashed;
  transition: border-color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out);
  font: inherit;
  font-family: var(--font-serif-cjk);
}
.round-divider__badge--clickable:hover {
  border-color: var(--color-amber-400);
  background: var(--color-amber-muted);
}
.round-divider__badge--clickable:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-amber-400) 25%, transparent);
}

.round-divider__badge-sub {
  margin-top: 2px;
  font-family: var(--font-sans);
  font-size: 0.6rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-amber-400);
  opacity: 0.72;
}

/* Current round: sage double inset ring + enhanced glow + breathing pulse */
.round-divider--current .round-divider__badge {
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, var(--color-border));
  color: var(--color-text);
  box-shadow:
    inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 15%, transparent),
    inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    0 0 18px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  animation: lumi-pulse var(--lumi-pulse) ease-in-out infinite;
}

/* Token / duration pill below the badge — warm, translucent */
.round-divider__pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 3px var(--space-md);
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-surface-elevated) 45%, transparent);
  backdrop-filter: blur(8px) saturate(1.1);
  -webkit-backdrop-filter: blur(8px) saturate(1.1);
  border: 1px solid var(--color-border-subtle);
  box-shadow: var(--lumi-inset-highlight);
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.72;
  transition: opacity var(--duration-normal) var(--ease-out);
}

.round-divider__pill:hover {
  opacity: 1;
}

.round-divider__stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/*
 * Metric colors stay on the sage/amber axis — no cold violet or cyan.
 * Input tokens = sage-300 (lighter, "knowledge in"),
 * Duration     = amber-400 (warm timer),
 * Output       = sage-500 (darker, "story flowing out").
 */
.round-divider__stat--input    { color: var(--color-sage-300); }
.round-divider__stat--duration { color: var(--color-amber-400); }
.round-divider__stat--output   { color: var(--color-sage-500); }

.round-divider__stat-icon {
  font-size: 11px;
  line-height: 1;
  opacity: 0.82;
}

.round-divider__stat-value {
  font-weight: 600;
  text-shadow: 0 0 6px currentColor;
}

/* Thin vertical separator between stat segments — warm umber */
.round-divider__sep {
  width: 1px;
  height: 10px;
  background: color-mix(in oklch, var(--color-text-umber) 30%, transparent);
}

/* Mobile: shrink the pill slightly */
@media (max-width: 640px) {
  .round-divider__pill {
    font-size: 9px;
    gap: var(--space-xs);
    padding: 2px var(--space-sm);
  }
}
</style>
