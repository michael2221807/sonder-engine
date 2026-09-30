<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * One card's face (phase 7): the name and one sentence; everything else is a mark, never a number (PO 2A) —
 * dots for uses left, diamonds for growth, a ring for recharge, a light along the top edge for a supply card's
 * rarity. A card whose ability is still forming is shown faded and cannot be placed (4A).
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FormingCard, TableCard } from '@/features/plot-vector/table-model';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';

const props = defineProps<{
  card?: TableCard;
  forming?: FormingCard;
  fresh?: boolean;
  selected?: boolean;
  acting?: boolean;
  /** Sitting in a cell rather than in the hand. */
  placed?: boolean;
  /** The drag ghost following the pointer. */
  ghost?: boolean;
}>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';

const kind = computed(() => props.card?.kind ?? props.forming?.kind ?? 'item');
const name = computed(() => props.card ? label(props.card.name) : props.forming?.name ?? '');
const line = computed(() => props.card ? label(props.card.line) : t('mainGame.vectorTable.detail.forming'));
const tier = computed(() => props.card?.kind === 'supply' ? props.card.tier : undefined);
const dots = computed(() => {
  const uses = props.card?.uses;
  if (!uses || uses.max > 5) return [];
  return Array.from({ length: uses.max }, (_, i) => i < uses.left);
});
const diamonds = computed(() => Math.min(3, props.card?.level?.value ?? 0));
const charge = computed(() => {
  const c = props.card;
  return c?.resting && c.charge ? Math.min(1, c.charge.progress / c.charge.every) : null;
});
</script>

<template>
  <div
    class="vcard"
    :class="[
      `vcard--${kind}`,
      tier && tier !== 'common' ? `vcard--${tier}` : '',
      {
        'vcard--forming': !!forming,
        'vcard--resting': card?.resting,
        'vcard--selected': selected,
        'vcard--acting': acting,
        'vcard--placed': placed,
        'vcard--ghost': ghost,
        'vcard--fresh': fresh,
      },
    ]"
  >
    <span class="vcard__kind">{{ t(`mainGame.vectorTable.kind.${kind}`) }}</span>
    <span class="vcard__marks" aria-hidden="true">
      <i v-for="(full, i) in dots" :key="`d${i}`" class="vcard__dot" :class="{ 'vcard__dot--spent': !full }" />
      <i v-if="charge !== null" class="vcard__charge" :style="{ '--p': `${Math.round(charge * 100)}%` }" />
      <i v-for="i in diamonds" :key="`l${i}`" class="vcard__level" />
      <i v-if="card?.stored" class="vcard__stored" />
    </span>
    <strong class="vcard__name">{{ name }}</strong>
    <span class="vcard__line">{{ line }}</span>
    <span v-if="fresh" class="vcard__fresh">{{ t('mainGame.vectorTable.fresh') }}</span>
  </div>
</template>

<style scoped>
.vcard {
  position: relative;
  display: grid;
  align-content: start;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 22px 10px 9px;
  border-radius: 11px;
  background: linear-gradient(180deg, oklch(0.235 0.01 90), oklch(0.19 0.008 90));
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: var(--color-text);
  text-align: left;
  user-select: none;
  -webkit-user-select: none;
  transition: transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-normal) var(--ease-out), opacity var(--duration-normal) var(--ease-out);
}
.vcard__kind {
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
.vcard__marks {
  position: absolute;
  top: 7px;
  right: 9px;
  display: flex;
  align-items: center;
  gap: 3px;
}
.vcard__dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-sage-400); }
.vcard__dot--spent { background: oklch(0.3 0.006 95); }
.vcard__level {
  width: 6px;
  height: 6px;
  background: var(--color-amber-300);
  transform: rotate(45deg) scale(0.85);
  border-radius: 1px;
}
.vcard__stored { width: 6px; height: 6px; border-radius: 1.5px; background: var(--color-amber-400); opacity: 0.8; }
.vcard__charge {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: conic-gradient(var(--color-sage-400) var(--p, 0%), oklch(0.28 0.006 95) 0);
  -webkit-mask: radial-gradient(circle 3.5px, transparent 98%, #000 100%);
  mask: radial-gradient(circle 3.5px, transparent 98%, #000 100%);
}
.vcard__name {
  font-family: var(--font-serif-cjk);
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.vcard__line {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--color-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.vcard__fresh {
  position: absolute;
  right: 8px;
  bottom: 6px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  color: oklch(0.2 0.02 75);
  background: var(--color-amber-400);
}

/* Kinds: a status reads warm and heavy; weather never sits in the hand. */
.vcard--status { background: linear-gradient(180deg, color-mix(in oklch, var(--color-danger) 16%, oklch(0.21 0.01 60)), oklch(0.18 0.01 60)); }

/* Rarity: a thin light along the top edge, not a frame (a frame reads as "selected"). */
.vcard--uncommon::before,
.vcard--rare::before,
.vcard--legendary::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  height: 2px;
  border-radius: 0 0 2px 2px;
}
.vcard--uncommon::before { background: var(--color-sage-400); opacity: 0.8; }
.vcard--rare::before { background: var(--color-amber-400); box-shadow: 0 0 8px var(--color-amber-400); }
.vcard--legendary::before { left: 6px; right: 6px; background: oklch(0.86 0.11 85); box-shadow: 0 0 12px oklch(0.86 0.11 85); }
.vcard--legendary { background: linear-gradient(180deg, oklch(0.25 0.02 85), oklch(0.19 0.008 90)); }

.vcard--resting { opacity: 0.55; }
.vcard--forming {
  opacity: 0.5;
  background: repeating-linear-gradient(135deg, oklch(0.19 0.008 90) 0 6px, oklch(0.21 0.008 90) 6px 12px);
}
.vcard--forming .vcard__line { font-style: italic; }
.vcard--selected {
  transform: translateY(-6px);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--color-sage-400), 0 0 18px color-mix(in oklch, var(--color-sage-400) 35%, transparent);
}
.vcard--acting { box-shadow: 0 0 0 1px var(--color-amber-400), 0 0 24px color-mix(in oklch, var(--color-amber-400) 45%, transparent); }
.vcard--fresh { animation: vcard-arrive 1.8s var(--ease-out) 2; }
.vcard--ghost {
  transform: rotate(-2deg) scale(1.04);
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--color-sage-400);
}
@keyframes vcard-arrive {
  50% { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35), 0 0 22px color-mix(in oklch, var(--color-amber-400) 45%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .vcard { transition: none; }
  .vcard--fresh { animation: none; }
}
</style>
