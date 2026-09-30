<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * The "?" on the table (phase 7): how it works in a few lines, the starting force the attributes give (as dots),
 * and the two switches — exact numbers (PO 2A: only here) and the automatic walk (animation A, can be turned off).
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeInput } from '@/features/plot-vector/native-input';
import type { BoardShape } from '@/features/plot-vector/vector-board';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';

const props = defineProps<{ starting?: NativeInput; shape: BoardShape; exact: boolean; animate: boolean }>();
const emit = defineEmits<{ (e: 'update:exact', value: boolean): void; (e: 'update:animate', value: boolean): void }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);

/** 0–3 dots: how strong a starting force is, without the number. */
const level = (value: number) => (value <= 0 ? 0 : value < 1.5 ? 1 : value < 3 ? 2 : 3);
const forces = computed(() => {
  const p = props.starting?.payload ?? {};
  return [
    { key: 'push', dots: level(p['S+'] ?? 0) },
    { key: 'relations', dots: level(p.Y ?? 0) },
    { key: 'chances', dots: level(p.J ?? 0) },
  ];
});
const target = (value: string) => {
  const key = ({ 'S+': 'push', 'S-': 'drag', Y: 'relations', J: 'chances', visits: 'steps' } as Record<string, string>)[value];
  return key ? t(`mainGame.vectorTable.channel.${key}`) : value;
};
</script>

<template>
  <section class="vhelp" data-testid="vector-help" :aria-label="t('mainGame.vectorTable.help')">
    <h3 class="vhelp__title">{{ t('mainGame.vectorTable.help') }}</h3>
    <ul class="vhelp__list">
      <li>{{ t('mainGame.vectorTable.helpPanel.move') }}</li>
      <li>{{ t(shape === 'ring' ? 'mainGame.vectorTable.helpPanel.pathRing' : 'mainGame.vectorTable.helpPanel.pathLine') }}</li>
      <li>{{ t('mainGame.vectorTable.helpPanel.auto') }}</li>
      <li>{{ t('mainGame.vectorTable.helpPanel.supply') }}</li>
      <li>{{ t('mainGame.vectorTable.helpPanel.keep') }}</li>
      <li>{{ t('mainGame.vectorTable.helpPanel.shape') }}</li>
    </ul>
    <div class="vhelp__row">
      <span>{{ t('mainGame.vectorTable.helpPanel.start') }}</span>
      <span class="vhelp__forces">
        <span v-for="f in forces" :key="f.key" class="vhelp__force">
          <em>{{ t(`mainGame.vectorTable.channel.${f.key}`) }}</em>
          <i v-for="i in 3" :key="i" :class="{ on: i <= f.dots }" aria-hidden="true" />
        </span>
      </span>
    </div>
    <div v-if="exact && starting" class="vhelp__exact" data-testid="vector-native">
      <p>{{ t('mainGame.vectorTable.exact.start', { push: number(starting.payload['S+'] ?? 0), drag: number(starting.payload['S-'] ?? 0), relations: number(starting.payload.Y ?? 0), chances: number(starting.payload.J ?? 0), steps: starting.visitBudget }) }}</p>
      <p v-for="(row, i) in starting.contributions" :key="i">
        {{ t('mainGame.vectorTable.exact.contribution', { label: label(row.label), value: row.value === null ? t('mainGame.vectorTable.exact.missing') : number(row.value), target: target(row.target), amount: number(row.amount) }) }}
      </p>
    </div>
    <div class="vhelp__toggle">
      <span>{{ t('mainGame.vectorTable.helpPanel.exact') }}</span>
      <button type="button" :aria-pressed="exact" data-testid="vector-exact-toggle" @click="emit('update:exact', !exact)">
        {{ exact ? t('mainGame.vectorTable.helpPanel.on') : t('mainGame.vectorTable.helpPanel.off') }}
      </button>
    </div>
    <div class="vhelp__toggle">
      <span>{{ t('mainGame.vectorTable.helpPanel.animate') }}</span>
      <button type="button" :aria-pressed="animate" data-testid="vector-animate-toggle" @click="emit('update:animate', !animate)">
        {{ animate ? t('mainGame.vectorTable.helpPanel.on') : t('mainGame.vectorTable.helpPanel.off') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.vhelp {
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 100%;
  overflow-y: auto;
  padding: 14px 16px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--color-surface-elevated) 94%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  font-size: 13px;
  line-height: 1.65;
  color: var(--color-text-secondary);
  scrollbar-width: thin;
  scrollbar-color: oklch(0.3 0.006 95) transparent;
  animation: vhelp-in var(--duration-normal) var(--ease-out);
}
@keyframes vhelp-in { from { opacity: 0; transform: translateY(6px); } }
.vhelp__title { margin: 0 0 6px; font-family: var(--font-serif-cjk); font-size: 16px; font-weight: 600; color: var(--color-text); }
.vhelp__list { margin: 0 0 10px; padding-left: 18px; }
.vhelp__list li { margin: 3px 0; }
.vhelp__row, .vhelp__toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.vhelp__forces { display: inline-flex; gap: 10px; }
.vhelp__force { display: inline-flex; align-items: center; gap: 3px; }
.vhelp__force em { font-style: normal; color: var(--color-text-muted); margin-right: 2px; }
.vhelp__force i { width: 5px; height: 5px; border-radius: 50%; background: oklch(0.3 0.006 95); }
.vhelp__force i.on { background: var(--color-sage-400); }
.vhelp__exact { margin-top: 8px; padding-top: 8px; border-top: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent); font-size: 12px; font-variant-numeric: tabular-nums; }
.vhelp__exact p { margin: 0; }
.vhelp__toggle { margin-top: 8px; }
.vhelp__toggle button {
  min-width: 42px;
  padding: 4px 10px;
  border: 0;
  border-radius: 999px;
  background: oklch(0.24 0.006 95);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.vhelp__toggle button[aria-pressed='true'] { background: color-mix(in oklch, var(--color-sage-400) 22%, transparent); color: var(--color-sage-300); }
.vhelp__toggle button:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .vhelp { animation: none; } }
</style>
