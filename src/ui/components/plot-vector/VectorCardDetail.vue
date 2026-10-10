<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.5 · Plot-vector card table
/**
 * A card's details (phase 7; PO 2026-10-01, demo docs/demo/plot-vector-effect-and-start.html): hover 0.8 s or
 * long-press. Effect — the model's sentence, then each case the engine read from the card's code (PO 2026-10-09):
 * its condition in words and what it does as bubbles, and, on the board, whether it acted on this trip; Growth — how it grows and what a
 * level does, one sentence with bubbles; Origin — the entry's own text; then what is left, and with exact numbers
 * what it brought this trip. Every explanation comes from the engine and a fixed glossary, never from the model's
 * wording. An entry whose ability is still forming offers its retry here and nowhere else (4A).
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FormingCard, TableCard } from '@/features/plot-vector/table-model';
import type { CardTripReceipt } from '@/features/plot-vector/card-trip-receipt';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import Tooltip from '../shared/Tooltip.vue';
import VectorTok from './VectorTok.vue';
import { useCardWords } from './card-words';

const props = defineProps<{
  card?: TableCard;
  forming?: FormingCard;
  anchor: DOMRect;
  exact: boolean;
  receipt?: CardTripReceipt | null;
  retrying?: boolean;
  retryNote?: 'bound' | 'failed' | 'error' | null;
  /** On the board and did not act once on this trip. */
  idle?: boolean;
}>();
const emit = defineEmits<{ (e: 'retry'): void; (e: 'enter'): void; (e: 'leave'): void }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);

const el = ref<HTMLElement>();
const pos = ref({ left: 0, top: 0 });
/**
 * Hidden until placed: measured at the corner first, it would otherwise sit for a frame over whatever is there —
 * on a phone the first cell — catch the pointer, and close as soon as it moves away (2026-10-01).
 */
const placed = ref(false);
onMounted(async () => {
  await nextTick();
  const w = el.value?.offsetWidth ?? 300, h = el.value?.offsetHeight ?? 160, m = 12;
  const left = Math.max(m, Math.min(window.innerWidth - w - m, props.anchor.left + props.anchor.width / 2 - w / 2));
  const above = props.anchor.top - h - 10;
  pos.value = { left, top: above >= m ? above : Math.max(m, Math.min(window.innerHeight - h - m, props.anchor.bottom + 10)) };
  placed.value = true;
});

const words = useCardWords(() => props.exact);
const clauses = computed(() => (props.card?.behavior ? words.value.clauses(props.card.behavior) : []));
const growth = computed(() => {
  const g = props.card?.growth;
  return g ? { rule: words.value.growth(g), ...words.value.level(g) } : null;
});
const trip = computed(() => (props.exact && props.receipt ? words.value.trip(props.receipt) : undefined));
const uses = computed(() => props.card?.uses);
const chargeLeft = computed(() => {
  const c = props.card;
  return c?.resting && c.charge ? Math.max(1, c.charge.every - c.charge.progress) : null;
});
const hasStatus = computed(() => !!props.card && (!!uses.value || chargeLeft.value !== null || !!props.card.stored));
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="vdetail"
      role="dialog"
      :aria-label="card ? label(card.name) : forming?.name"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, visibility: placed ? 'visible' : 'hidden' }"
      data-testid="vector-card-detail"
      @pointerenter="emit('enter')"
      @pointerleave="emit('leave')"
    >
      <h3 class="vdetail__name">
        {{ card ? label(card.name) : forming?.name }}
        <span v-if="card?.tier" class="vdetail__tier" :class="`vdetail__tier--${card.tier}`">{{ t(`mainGame.vectorTable.tier.${card.tier}`) }}</span>
      </h3>
      <template v-if="card">
        <section class="vdetail__block" data-testid="vector-card-effects">
          <span class="vdetail__label">{{ t('mainGame.vectorTable.fx.label') }}</span>
          <p v-if="card.line" class="vdetail__say">{{ label(card.line) }}</p>
          <div v-for="(c, i) in clauses" :key="i" class="vdetail__case" data-testid="vector-card-case">
            <span v-if="c.when" class="vdetail__when">{{ c.when }}<span class="vdetail__when-sep">{{ t('mainGame.vectorTable.do.whenSep') }}</span></span>
            <span class="vdetail__toks"><VectorTok v-for="(tok, j) in c.toks" :key="j" :tok="tok" /></span>
          </div>
          <p v-if="card.behavior?.complex" class="vdetail__quiet">{{ t('mainGame.vectorTable.do.complexTip') }}</p>
          <p v-if="idle" class="vdetail__idle" data-testid="vector-card-idle">{{ t('mainGame.vectorTable.do.idleTip') }}</p>
        </section>
        <section v-if="growth" class="vdetail__block" data-testid="vector-card-growth">
          <div class="vdetail__grow-head">
            <span class="vdetail__label">{{ t('mainGame.vectorTable.grow.label') }}</span>
            <VectorTok :tok="growth.tok" />
            <Tooltip class="vdetail__prog-wrap" :text="growth.next">
              <span class="vdetail__prog" :style="{ '--w': `${Math.round(growth.fill * 100)}%` }"><i /></span>
            </Tooltip>
          </div>
          <p class="vdetail__rule">
            <template v-for="(seg, i) in growth.rule" :key="i">
              <span v-if="'text' in seg">{{ seg.text }}</span>
              <VectorTok v-else :tok="seg.tok" />
            </template>
          </p>
        </section>
        <section v-if="card.story" class="vdetail__block">
          <span class="vdetail__label">{{ t('mainGame.vectorTable.story.label') }}</span>
          <p class="vdetail__story">{{ label(card.story) }}</p>
        </section>
        <div v-if="hasStatus" class="vdetail__status">
          <span v-if="uses && uses.max <= 5">
            {{ t('mainGame.vectorTable.detail.uses') }}
            <span class="vdetail__dots" aria-hidden="true"><i v-for="i in uses.max" :key="i" :class="{ spent: i > uses.left }" /></span>
            <span v-if="exact" class="vdetail__tab" data-testid="vector-card-exact">{{ uses.left }}/{{ uses.max }}</span>
          </span>
          <span v-else-if="uses && exact" data-testid="vector-card-exact">{{ t('mainGame.vectorTable.exact.uses', { left: uses.left, max: uses.max }) }}</span>
          <span v-if="chargeLeft !== null && card.charge">{{ t(card.charge.on === 'round' ? 'mainGame.vectorTable.detail.chargeRound' : 'mainGame.vectorTable.detail.chargeTrigger', { n: chargeLeft }) }}</span>
          <span v-if="card.stored">
            {{ t('mainGame.vectorTable.detail.stored') }}
            <span v-if="exact" class="vdetail__tab">{{ number(card.stored) }}</span>
          </span>
        </div>
        <section v-if="trip !== undefined" class="vdetail__trip" data-testid="vector-card-trip">
          <span class="vdetail__label">{{ t('mainGame.vectorTable.trip.label') }}</span>
          <div v-if="trip && trip.length" class="vdetail__toks"><VectorTok v-for="(tok, i) in trip" :key="i" :tok="tok" /></div>
          <p v-else class="vdetail__quiet">{{ t('mainGame.vectorTable.trip.none') }}</p>
        </section>
      </template>
      <template v-else-if="forming">
        <p class="vdetail__say">{{ t(forming.failed ? 'mainGame.vectorTable.detail.formingFailed' : 'mainGame.vectorTable.detail.forming') }}</p>
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
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 14px 16px 12px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--color-surface-elevated) 92%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  animation: vdetail-in var(--duration-normal) var(--ease-out);
}
@keyframes vdetail-in { from { opacity: 0; transform: translateY(6px); } }
.vdetail__name { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font-family: var(--font-serif-cjk); font-size: 16px; font-weight: 600; color: var(--color-text); }
.vdetail__tier { font-family: var(--font-sans); font-size: 11px; font-weight: 400; letter-spacing: 0.08em; }
.vdetail__tier--common { color: var(--tier-common); }
.vdetail__tier--uncommon { color: var(--tier-uncommon); }
.vdetail__tier--rare { color: var(--tier-rare); }
.vdetail__tier--epic { color: var(--tier-epic); }
.vdetail__tier--legendary { color: var(--tier-legendary); }
.vdetail__tier--mythic { color: var(--tier-mythic); text-shadow: 0 0 10px color-mix(in oklch, var(--tier-mythic) 50%, transparent); }
.vdetail__block { margin: 0 0 10px; }
.vdetail__label { display: block; margin-bottom: 4px; font-size: 10.5px; letter-spacing: 0.14em; color: var(--color-text-muted); }
.vdetail__say { margin: 0 0 6px; color: var(--color-text); }
.vdetail__toks { display: flex; flex-wrap: wrap; gap: 2px 4px; margin-left: -2px; }
.vdetail__case { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin: 2px 0; }
.vdetail__case .vdetail__toks { flex: 1; min-width: 0; }
.vdetail__when { flex: none; font-size: 12px; color: var(--color-text); }
.vdetail__when-sep { color: var(--color-text-muted); }
.vdetail__idle { margin: 6px 0 0; font-size: 12px; color: var(--color-text-muted); }
.vdetail__grow-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.vdetail__grow-head .vdetail__label { margin: 0; }
.vdetail__prog-wrap { flex: 1; }
.vdetail__prog { display: block; width: 100%; height: 3px; border-radius: 2px; background: oklch(0.24 0.006 95); overflow: hidden; }
.vdetail__prog i { display: block; height: 100%; width: var(--w); border-radius: 2px; background: var(--ch-chance); transition: width var(--duration-slow) var(--ease-out); }
.vdetail__rule { margin: 0; line-height: 1.85; }
.vdetail__story { margin: 0; font-family: var(--font-serif-cjk); font-size: 12.5px; line-height: 1.75; color: var(--color-text-muted); }
.vdetail__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  padding-top: 9px;
  margin-top: 4px;
  border-top: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent);
  font-size: 12px;
  color: var(--color-text-muted);
}
.vdetail__status > span { display: inline-flex; align-items: center; gap: 5px; }
.vdetail__dots { display: inline-flex; align-items: center; gap: 3px; }
.vdetail__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--color-sage-400); }
.vdetail__dots i.spent { background: oklch(0.3 0.006 95); }
.vdetail__tab { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--color-text-muted); }
.vdetail__trip { margin-top: 10px; padding-top: 9px; border-top: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent); }
.vdetail__quiet { margin: 0; font-size: 12px; color: var(--color-text-muted); }
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
@media (prefers-reduced-motion: reduce) { .vdetail { animation: none; } .vdetail__prog i { transition: none; } }
</style>
