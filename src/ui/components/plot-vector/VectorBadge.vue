<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * The board in miniature beside the input (phase 7): six marks in a row, or in a ring on the ring board. A cell
 * holding a card is lit, the status cell warm; it glows while new cards wait, and replays the last trip once
 * after a round (animation A).
 */
import { useI18n } from 'vue-i18n';
import Tooltip from '../shared/Tooltip.vue';
import type { BoardShape } from '@/features/plot-vector/vector-board';

defineProps<{
  cells: Array<{ id: string; state: 'empty' | 'card' | 'status' }>;
  shape: BoardShape;
  count: number;
  lit: string | null;
}>();
const emit = defineEmits<{ (e: 'open', event: MouseEvent): void }>();
const { t } = useI18n();
</script>

<template>
  <Tooltip :text="t('mainGame.vectorTable.badge.hint')" interactive>
    <button
      type="button"
      class="vbadge"
      :class="[`vbadge--${shape}`, { 'vbadge--new': count > 0 }]"
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
  background: var(--color-amber-400);
}
.vbadge--new { animation: vbadge-breathe var(--duration-breath) var(--ease-in-out) infinite; }
@keyframes vbadge-breathe {
  50% { border-color: var(--color-amber-600); box-shadow: 0 0 16px color-mix(in oklch, var(--color-amber-400) 35%, transparent); }
}
@media (max-width: 767px) {
  .vbadge { height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .vbadge--new { animation: none; border-color: var(--color-amber-600); }
  .vbadge__cell { transition: none; }
}
</style>
