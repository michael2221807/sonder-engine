<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * The board in miniature beside the input (phase 7): six marks in a row, or in a ring on the ring board. A cell
 * holding a card is lit, the status cell warm; it glows while new cards wait, and replays the last trip once
 * after a round (animation A). The glow takes the colour of the rarest new card (phase 7 polish). While the table
 * is open it holds a quiet light (the table grew out of it); while the arrangement is written to the save a light
 * runs along its cells under a small "saving" note (PO 2026-09-30) — only opacity and rotation move, so both keep
 * moving while the write holds the page.
 */
import { useI18n } from 'vue-i18n';
import Tooltip from '../shared/Tooltip.vue';
import type { BoardShape } from '@/features/plot-vector/vector-board';
import type { CardTier } from '@/features/plot-vector/rating';

defineProps<{
  cells: Array<{ id: string; state: 'empty' | 'card' | 'status' }>;
  shape: BoardShape;
  count: number;
  /** The rarest card among the new ones. */
  tier?: CardTier;
  lit: string | null;
  /** The table is open (it grew out of this badge). */
  active?: boolean;
  /** The arrangement is being written to the save, or was just written. */
  saving?: 'saving' | 'saved' | null;
}>();
const emit = defineEmits<{ (e: 'open', event: MouseEvent): void }>();
const { t } = useI18n();
</script>

<template>
  <span class="vbadge-wrap">
  <Tooltip :text="t('mainGame.vectorTable.badge.hint')" interactive>
    <button
      type="button"
      class="vbadge"
      :class="[`vbadge--${shape}`, { 'vbadge--new': count > 0, [`vbadge--${tier}`]: count > 0 && !!tier, 'vbadge--active': active, 'vbadge--saving': saving === 'saving' }]"
      :aria-label="count ? `${t('mainGame.vectorTable.badge.open')} · ${t('mainGame.vectorTable.badge.newCards', { count })}` : t('mainGame.vectorTable.badge.open')"
      data-testid="vector-board-open"
      @click="emit('open', $event)"
    >
      <i
        v-for="cell in cells"
        :key="cell.id"
        class="vbadge__cell"
        :class="[`vbadge__cell--${cell.state}`, { 'vbadge__cell--lit': lit === cell.id }]"
      />
      <span v-if="count" class="vbadge__count" data-testid="vector-new-cards">{{ count }}</span>
    </button>
  </Tooltip>
  <!-- Beside the button, not inside it: a live region inside a control with a fixed name reads confusingly. -->
  <span class="vbadge__note" :class="{ 'vbadge__note--show': !!saving, 'vbadge__note--done': saving === 'saved' }" role="status" aria-live="polite" data-testid="vector-save-note">
    <span class="vbadge__arc" aria-hidden="true" />
    <svg class="vbadge__check" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" /></svg>
    <template v-if="saving">{{ saving === 'saved' ? t('mainGame.vectorTable.badge.saved') : t('mainGame.vectorTable.badge.saving') }}</template>
  </span>
  </span>
</template>

<style scoped>
.vbadge {
  position: relative;
  display: inline-grid;
  grid-template-columns: repeat(6, 6px);
  gap: 3px;
  align-content: center;
  justify-content: center;
  width: 64px;
  height: 42px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.vbadge:hover { border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent); background: var(--color-sage-muted); }
.vbadge:active { transform: scale(0.97); }
.vbadge:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vbadge__cell {
  display: block;
  width: 6px;
  height: 16px;
  border-radius: 2px;
  background: oklch(0.26 0.006 95);
  transition: background var(--duration-normal) var(--ease-out), box-shadow var(--duration-normal) var(--ease-out);
}
.vbadge__cell--card { background: var(--color-sage-600); }
.vbadge__cell--status { background: color-mix(in oklch, var(--color-danger) 70%, transparent); }
.vbadge__cell--lit { background: var(--color-amber-400); box-shadow: 0 0 8px var(--color-amber-400); }

/* The table is open: a quiet light holds on the badge it grew out of. */
.vbadge::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 60%, transparent), 0 0 16px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  transition: opacity var(--duration-slow) var(--ease-out);
}
.vbadge--active::before { opacity: 1; }

/* Saving: a light runs along the cells. */
.vbadge__cell { position: relative; }
.vbadge__cell::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--color-amber-400);
  box-shadow: 0 0 8px var(--color-amber-400);
  opacity: 0;
}
.vbadge--saving .vbadge__cell::after { animation: vbadge-run 1.1s linear infinite; }
.vbadge--saving .vbadge__cell:nth-of-type(2)::after { animation-delay: 0.1s; }
.vbadge--saving .vbadge__cell:nth-of-type(3)::after { animation-delay: 0.2s; }
.vbadge--saving .vbadge__cell:nth-of-type(4)::after { animation-delay: 0.3s; }
.vbadge--saving .vbadge__cell:nth-of-type(5)::after { animation-delay: 0.4s; }
.vbadge--saving .vbadge__cell:nth-of-type(6)::after { animation-delay: 0.5s; }
@keyframes vbadge-run { 0%, 100% { opacity: 0; } 18% { opacity: 0.95; } 45% { opacity: 0; } }
/* The note above the badge (beside the button, not inside it): "saving" with a turning arc, then "saved". */
.vbadge-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
.vbadge__note {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-bg) 78%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  opacity: 0;
  transform: translate(-50%, 4px);
  pointer-events: none;
  transition: opacity var(--duration-normal) var(--ease-out), transform var(--duration-normal) var(--ease-out);
}
.vbadge__note--show { opacity: 1; transform: translate(-50%, 0); }
.vbadge__arc {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in oklch, var(--color-amber-400) 25%, transparent);
  border-top-color: var(--color-amber-400);
  animation: vbadge-spin 0.8s linear infinite;
  will-change: transform;
}
@keyframes vbadge-spin { to { transform: rotate(360deg); } }
.vbadge__check { display: none; color: var(--color-sage-400); }
.vbadge__note--done .vbadge__arc { display: none; }
.vbadge__note--done .vbadge__check { display: block; }

/* The ring board: six dots round a small circle, clockwise from the top left like the board itself. */
.vbadge--ring { display: inline-block; width: 48px; }
.vbadge--ring .vbadge__cell { position: absolute; width: 8px; height: 8px; border-radius: 50%; }
.vbadge--ring .vbadge__cell:nth-of-type(1) { left: 14px; top: 8px; }
.vbadge--ring .vbadge__cell:nth-of-type(2) { left: 25px; top: 8px; }
.vbadge--ring .vbadge__cell:nth-of-type(3) { left: 31px; top: 17px; }
.vbadge--ring .vbadge__cell:nth-of-type(4) { left: 25px; top: 26px; }
.vbadge--ring .vbadge__cell:nth-of-type(5) { left: 14px; top: 26px; }
.vbadge--ring .vbadge__cell:nth-of-type(6) { left: 8px; top: 17px; }

.vbadge__count {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  color: oklch(0.2 0.02 75);
  background: var(--vbadge-glow);
}
.vbadge { --vbadge-glow: var(--color-amber-400); }
.vbadge--uncommon { --vbadge-glow: var(--tier-uncommon); }
.vbadge--rare { --vbadge-glow: var(--tier-rare); }
.vbadge--epic { --vbadge-glow: var(--tier-epic); }
.vbadge--legendary { --vbadge-glow: var(--tier-legendary); }
.vbadge--mythic { --vbadge-glow: var(--tier-mythic); }
/* New cards waiting: a glow ring breathes (only its opacity moves, so the page is not repainted every frame). */
.vbadge::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--vbadge-glow) 70%, transparent), 0 0 16px color-mix(in oklch, var(--vbadge-glow) 40%, transparent);
}
.vbadge--new::after { animation: vbadge-breathe var(--duration-breath) var(--ease-in-out) infinite; }
/* A legendary or mythic card waiting: the breath is quicker. */
.vbadge--legendary.vbadge--new::after, .vbadge--mythic.vbadge--new::after { animation-duration: calc(var(--duration-breath) * 0.6); }
.vbadge--mythic .vbadge__count { color: oklch(0.97 0.01 90); }
@keyframes vbadge-breathe { 50% { opacity: 1; } }
@media (max-width: 767px) {
  .vbadge { height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .vbadge--new::after { animation: none; opacity: 1; }
  .vbadge__cell { transition: none; }
  .vbadge--saving .vbadge__cell::after, .vbadge__arc { animation: none; }
  .vbadge--saving .vbadge__cell::after { opacity: 0.6; }
}
</style>
