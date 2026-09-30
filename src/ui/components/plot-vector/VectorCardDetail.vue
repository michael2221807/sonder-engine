<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * A card's details (phase 7): hover 0.8 s or long-press. The story text, what is left, how it grew, its rarity;
 * exact numbers only when the player turned them on (PO 2A). An entry whose ability is still forming offers
 * its retry here and nowhere else (4A).
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FormingCard, TableCard } from '@/features/plot-vector/table-model';
import type { CardTripReceipt } from '@/features/plot-vector/card-trip-receipt';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';

const props = defineProps<{
  card?: TableCard;
  forming?: FormingCard;
  anchor: DOMRect;
  exact: boolean;
  receipt?: CardTripReceipt | null;
  retrying?: boolean;
  retryNote?: 'bound' | 'failed' | 'error' | null;
}>();
const emit = defineEmits<{ (e: 'retry'): void; (e: 'enter'): void; (e: 'leave'): void }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);

const el = ref<HTMLElement>();
const pos = ref({ left: 0, top: 0 });
onMounted(async () => {
  await nextTick();
  const w = el.value?.offsetWidth ?? 280, h = el.value?.offsetHeight ?? 160, m = 12;
  const left = Math.max(m, Math.min(window.innerWidth - w - m, props.anchor.left + props.anchor.width / 2 - w / 2));
  const above = props.anchor.top - h - 10;
  pos.value = { left, top: above >= m ? above : Math.min(window.innerHeight - h - m, props.anchor.bottom + 10) };
});

const uses = computed(() => props.card?.uses);
const chargeLeft = computed(() => {
  const c = props.card;
  return c?.resting && c.charge ? Math.max(1, c.charge.every - c.charge.progress) : null;
});
const receiptText = computed(() => {
  const r = props.receipt;
  if (!r) return '';
  if (!r.activations) return t('mainGame.vectorTable.exact.receiptNone');
  const names: Record<string, string> = { 'S+': 'push', 'S-': 'drag', Y: 'relations', J: 'chances' };
  const parts = [t('mainGame.vectorTable.exact.receipt', { count: r.activations })];
  for (const [channel, change] of Object.entries(r.shuttleChanges)) {
    if (Math.abs(change) < 1e-9 || !names[channel]) continue;
    parts.push(`${t(`mainGame.vectorTable.channel.${names[channel]}`)} ${change > 0 ? '+' : '−'}${number(Math.abs(change))}`);
  }
  if (r.stored > 1e-9) parts.push(t('mainGame.vectorTable.exact.stored', { amount: number(r.stored) }));
  if (r.released > 1e-9) parts.push(t('mainGame.vectorTable.exact.released', { amount: number(r.released) }));
  if (r.otherEffects.includes('route')) parts.push(t('mainGame.vectorTable.exact.route'));
  return parts.join(' · ');
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="vdetail"
      role="dialog"
      :aria-label="card ? label(card.name) : forming?.name"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      data-testid="vector-card-detail"
      @pointerenter="emit('enter')"
      @pointerleave="emit('leave')"
    >
      <h3 class="vdetail__name">{{ card ? label(card.name) : forming?.name }}</h3>
      <template v-if="card">
        <p v-if="card.line" class="vdetail__line">{{ label(card.line) }}</p>
        <p v-if="card.story" class="vdetail__story">{{ label(card.story) }}</p>
        <dl class="vdetail__rows">
          <div v-if="card.tier"><dt>{{ t('mainGame.vectorTable.detail.tier') }}</dt><dd :class="`vdetail__tier--${card.tier}`">{{ t(`mainGame.vectorTable.tier.${card.tier}`) }}</dd></div>
          <div v-if="uses && uses.max <= 5">
            <dt>{{ t('mainGame.vectorTable.detail.uses') }}</dt>
            <dd class="vdetail__dots" aria-hidden="true"><i v-for="i in uses.max" :key="i" :class="{ spent: i > uses.left }" /></dd>
          </div>
          <div v-if="chargeLeft !== null && card.charge">
            <dt />
            <dd>{{ t(card.charge.on === 'round' ? 'mainGame.vectorTable.detail.chargeRound' : 'mainGame.vectorTable.detail.chargeTrigger', { n: chargeLeft }) }}</dd>
          </div>
          <div v-if="card.level && card.level.value > 0">
            <dt>{{ t('mainGame.vectorTable.detail.level') }}</dt>
            <dd class="vdetail__level" aria-hidden="true"><i v-for="i in Math.min(5, card.level.value)" :key="i" /></dd>
          </div>
          <div v-if="card.stored"><dt>{{ t('mainGame.vectorTable.detail.stored') }}</dt><dd /></div>
        </dl>
        <p v-if="exact" class="vdetail__exact" data-testid="vector-card-exact">
          <span v-if="uses">{{ t('mainGame.vectorTable.exact.uses', { left: uses.left, max: uses.max }) }}</span>
          <span v-if="card.level">{{ card.level.max !== undefined ? t('mainGame.vectorTable.exact.levelMax', { value: card.level.value, max: card.level.max }) : t('mainGame.vectorTable.exact.level', { value: card.level.value }) }}</span>
          <span v-if="receiptText">{{ receiptText }}</span>
        </p>
      </template>
      <template v-else-if="forming">
        <p class="vdetail__line">{{ t(forming.failed ? 'mainGame.vectorTable.detail.formingFailed' : 'mainGame.vectorTable.detail.forming') }}</p>
        <button type="button" class="vdetail__retry" :disabled="retrying" data-testid="vector-ability-retry" @click="emit('retry')">
          {{ retrying ? t('mainGame.vectorTable.detail.retrying') : t('mainGame.vectorTable.detail.retry') }}
        </button>
        <p v-if="retryNote" class="vdetail__note" role="status">{{ t(`mainGame.vectorTable.retry.${retryNote}`) }}</p>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.vdetail {
  position: fixed;
  z-index: var(--z-floating);
  width: 280px;
  padding: 14px 16px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--color-surface-elevated) 92%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  font-size: 13px;
  line-height: 1.65;
  color: var(--color-text-secondary);
  animation: vdetail-in var(--duration-normal) var(--ease-out);
}
@keyframes vdetail-in { from { opacity: 0; transform: translateY(6px); } }
.vdetail__name { margin: 0 0 6px; font-family: var(--font-serif-cjk); font-size: 16px; font-weight: 600; color: var(--color-text); }
.vdetail__line { margin: 0; }
.vdetail__story { margin: 6px 0 0; font-family: var(--font-serif-cjk); font-size: 12.5px; color: var(--color-text-muted); }
.vdetail__rows { margin: 8px 0 0; display: grid; gap: 2px; }
.vdetail__rows div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.vdetail__rows dt { color: var(--color-text-muted); }
.vdetail__rows dd { margin: 0; }
.vdetail__dots, .vdetail__level { display: inline-flex; align-items: center; gap: 4px; }
.vdetail__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--color-sage-400); }
.vdetail__dots i.spent { background: oklch(0.3 0.006 95); }
.vdetail__level i { width: 6px; height: 6px; border-radius: 1px; background: var(--color-amber-300); transform: rotate(45deg); }
.vdetail__tier--common { color: var(--tier-common); }
.vdetail__tier--uncommon { color: var(--tier-uncommon); }
.vdetail__tier--rare { color: var(--tier-rare); }
.vdetail__tier--epic { color: var(--tier-epic); }
.vdetail__tier--legendary { color: var(--tier-legendary); }
.vdetail__tier--mythic { color: var(--tier-mythic); text-shadow: 0 0 10px color-mix(in oklch, var(--tier-mythic) 50%, transparent); }
.vdetail__exact {
  display: grid;
  gap: 2px;
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.vdetail__retry {
  margin-top: 10px;
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: color-mix(in oklch, var(--color-sage-400) 16%, transparent);
  color: var(--color-sage-300);
  font: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.vdetail__retry:hover:not(:disabled) { background: color-mix(in oklch, var(--color-sage-400) 26%, transparent); }
.vdetail__retry:disabled { opacity: 0.6; cursor: default; }
.vdetail__retry:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vdetail__note { margin: 6px 0 0; font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .vdetail { animation: none; } }
</style>
