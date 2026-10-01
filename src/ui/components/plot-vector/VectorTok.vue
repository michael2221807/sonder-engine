<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.5 · Plot-vector card table
/**
 * A keyword in a small bubble (PO 2026-10-01): its mark and colour, its name, up to three strength strokes and,
 * with exact numbers, its number. Hovering 0.8 s explains it in one sentence (the shared Tooltip).
 */
import Tooltip from '../shared/Tooltip.vue';
import { MARK_GLYPH } from './effect-marks';
import type { Tok } from './card-words';

defineProps<{ tok: Tok; fixed?: boolean }>();
</script>

<template>
  <Tooltip :text="tok.tip" :fixed="fixed" class="vtok-wrap">
    <span class="vtok" :class="{ 'vtok--plain': !tok.color }" :style="tok.color ? { '--c': tok.color } : undefined" data-testid="vector-tok">
      <span v-if="tok.mark" class="vtok__mark" aria-hidden="true">{{ MARK_GLYPH[tok.mark] }}</span>
      <span>{{ tok.label }}</span>
      <span v-if="tok.strength" class="vtok__strokes" aria-hidden="true"><i v-for="i in 3" :key="i" :class="{ off: i > (tok.strength ?? 0) }" /></span>
      <span v-if="tok.num" class="vtok__num">{{ tok.num }}</span>
    </span>
  </Tooltip>
</template>

<style scoped>
.vtok-wrap { vertical-align: baseline; }
.vtok {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 1px 2px;
  padding: 0 8px 0 7px;
  border-radius: 999px;
  line-height: 21px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--c);
  background: color-mix(in oklch, var(--c) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 24%, transparent);
  transition: background var(--duration-fast) var(--ease-out);
}
.vtok--plain { --c: var(--color-text-secondary); }
.vtok-wrap:hover .vtok { background: color-mix(in oklch, var(--c) 20%, transparent); }
.vtok__mark { font-size: 12px; }
.vtok__strokes { display: inline-flex; align-items: center; gap: 1.5px; margin-left: 1px; }
.vtok__strokes i { display: block; width: 2px; height: 8px; border-radius: 1px; background: currentColor; opacity: 0.9; }
.vtok__strokes i.off { opacity: 0.22; }
.vtok__num { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--color-text-muted); }
</style>
