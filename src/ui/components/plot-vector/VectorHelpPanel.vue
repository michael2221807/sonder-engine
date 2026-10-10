<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.6 · Plot-vector card table
/**
 * The "?" on the table (phase 7; PO 2026-10-01, demo docs/demo/plot-vector-effect-and-start.html): how it works in a
 * few lines, the legend the cards and the bars share — the four quantities, how a card changes them (PO 2026-10-09:
 * an add filled, a multiplier outlined, a move an arrow) and its conditions — the starting force the attributes give as four
 * gauges, and the two switches — exact numbers (PO 2A: only here) and the automatic walk (animation A). With exact
 * numbers the gauges carry their values, the steps show as a row of ticks and each attribute's share is a ledger
 * line.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeInput } from '@/features/plot-vector/native-input';
import type { BoardShape } from '@/features/plot-vector/vector-board';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import { CHANNEL_NAMES } from '@/features/plot-vector/contract/types';
import { CHANNEL_KEY, CHANNEL_MARK, CHANNEL_OF_ID, ID_OF_CHANNEL, MARK_COLOR, MARK_GLYPH, OP_GLYPH } from './effect-marks';
import VectorTok from './VectorTok.vue';
import type { Tok } from './card-words';

const props = defineProps<{ starting?: NativeInput; shape: BoardShape; exact: boolean; animate: boolean }>();
const emit = defineEmits<{ (e: 'update:exact', value: boolean): void; (e: 'update:animate', value: boolean): void }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);

/** The four quantities, in the bars' glyphs and colours. */
const legend = computed<Tok[]>(() => CHANNEL_NAMES.map(ch => ({
  mark: CHANNEL_MARK[ch], color: MARK_COLOR[CHANNEL_MARK[ch]], label: t(`mainGame.vectorTable.channel.${CHANNEL_KEY[ch]}`), tip: t(`mainGame.vectorTable.fx.means.${ch}`),
})));
const G = (ch: 'push' | 'drag' | 'social' | 'chance') => MARK_GLYPH[CHANNEL_MARK[ch]];
const C = (ch: 'push' | 'drag' | 'social' | 'chance') => MARK_COLOR[CHANNEL_MARK[ch]];
/** Conditions as the card face shows them. */
const whenSamples = computed(() => [
  t('mainGame.vectorTable.do.when.back'), t('mainGame.vectorTable.do.when.firstPass'),
  t('mainGame.vectorTable.do.when.below', { g: G('chance'), n: 3 }), t('mainGame.vectorTable.do.when.some', { g: G('drag') }),
  t('mainGame.vectorTable.do.when.chance', { n: 50 }),
]);
/** How a card changes them: a sample chip as the card face shows it, and its words. */
const ops = computed(() => [
  { text: `${G('push')}+`, color: C('push'), frame: 'fill', words: t('mainGame.vectorTable.legend.opAdd') },
  { text: `${G('drag')}−`, color: C('drag'), frame: 'fill', words: t('mainGame.vectorTable.legend.opLess') },
  { text: `${G('social')}× ${G('push')}÷`, color: C('social'), frame: 'line', words: t('mainGame.vectorTable.legend.opScale') },
  { text: `${G('drag')}0`, color: C('drag'), frame: 'line', words: t('mainGame.vectorTable.legend.opClear') },
  { text: `${G('drag')}→${G('social')}`, color: C('social'), frame: 'plain', words: t('mainGame.vectorTable.legend.opMove') },
  { text: `+${t('mainGame.vectorTable.do.stepGlyph').trim()} ${OP_GLYPH.turn}`, color: 'var(--color-text-secondary)', frame: 'plain', words: t('mainGame.vectorTable.legend.opRoute') },
  { text: `${OP_GLYPH.store} ${OP_GLYPH.relay}`, color: 'var(--color-text-secondary)', frame: 'plain', words: t('mainGame.vectorTable.legend.opStore') },
]);

/** The four starting forces as gauges on one scale (at least 4, so a small force reads small). */
const gauges = computed(() => {
  const p = props.starting?.payload ?? {};
  const rows = (['push', 'drag', 'social', 'chance'] as const).map(ch => ({ ch, mark: CHANNEL_MARK[ch], value: Math.max(0, p[ID_OF_CHANNEL[ch]] ?? 0) }));
  const scale = Math.max(4, ...rows.map(r => r.value));
  return rows.map(r => ({ ...r, width: `${Math.round((r.value / scale) * 100)}%` }));
});
const steps = computed(() => props.starting?.visitBudget ?? 0);
const ledger = computed(() => (props.starting?.contributions ?? []).map(row => {
  const ch = CHANNEL_OF_ID[row.target];
  return {
    source: label(row.label),
    value: row.value === null ? t('mainGame.vectorTable.exact.missing') : number(row.value),
    mark: ch ? CHANNEL_MARK[ch] : undefined,
    target: ch ? t(`mainGame.vectorTable.channel.${CHANNEL_KEY[ch]}`) : t('mainGame.vectorTable.channel.steps'),
    gain: `+${number(row.amount)}`,
  };
}));
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
      <li>{{ t('mainGame.vectorTable.helpPanel.converter') }}</li>
    </ul>

    <h4 class="vhelp__head">{{ t('mainGame.vectorTable.legend.title') }}</h4>
    <div class="vhelp__legend" data-testid="vector-legend"><VectorTok v-for="tok in legend" :key="tok.mark" :tok="tok" fixed /></div>
    <p class="vhelp__balance">{{ t('mainGame.vectorTable.legend.balance') }}</p>
    <div class="vhelp__ops" data-testid="vector-legend-ops">
      <template v-for="(op, i) in ops" :key="i">
        <span class="vhelp__chip" :class="`vhelp__chip--${op.frame}`" :style="{ '--c': op.color }">{{ op.text }}</span>
        <span class="vhelp__opwords">{{ op.words }}</span>
      </template>
    </div>
    <p class="vhelp__when"><span v-for="w in whenSamples" :key="w" class="vhelp__whentag">{{ w }}</span>{{ t('mainGame.vectorTable.legend.when') }}</p>

    <h4 class="vhelp__head">{{ t('mainGame.vectorTable.legend.start') }}</h4>
    <div class="vhelp__gauges" data-testid="vector-start">
      <div v-for="g in gauges" :key="g.ch" class="vhelp__gauge" :style="{ '--c': MARK_COLOR[g.mark] }">
        <span class="vhelp__gname"><b>{{ MARK_GLYPH[g.mark] }}</b>{{ t(`mainGame.vectorTable.channel.${CHANNEL_KEY[g.ch]}`) }}</span>
        <span class="vhelp__bar"><i :style="{ width: g.width }" /></span>
        <span v-if="exact" class="vhelp__n">{{ number(g.value) }}</span>
      </div>
      <div v-if="exact && starting" class="vhelp__gauge vhelp__steps" data-testid="vector-native">
        <span class="vhelp__gname">{{ t('mainGame.vectorTable.channel.steps') }}</span>
        <span class="vhelp__ticks" aria-hidden="true"><i v-for="i in Math.min(steps, 24)" :key="i" /></span>
        <span class="vhelp__n">{{ steps }}</span>
      </div>
    </div>
    <div v-if="exact && ledger.length" class="vhelp__ledger" data-testid="vector-ledger">
      <span class="vhelp__ledger-title">{{ t('mainGame.vectorTable.legend.ledger') }}</span>
      <div v-for="(row, i) in ledger" :key="i" class="vhelp__line" :style="row.mark ? { '--c': MARK_COLOR[row.mark] } : undefined">
        <span class="vhelp__src">{{ row.source }}<span class="vhelp__tab">{{ row.value }}</span></span>
        <span class="vhelp__to">→ <b v-if="row.mark">{{ MARK_GLYPH[row.mark] }}</b> {{ row.target }}</span>
        <span class="vhelp__gain">{{ row.gain }}</span>
      </div>
    </div>

    <div class="vhelp__toggle vhelp__toggle--first">
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
.vhelp__head { margin: 12px 0 6px; font-size: 10.5px; font-weight: 400; letter-spacing: 0.14em; color: var(--color-text-muted); }
.vhelp__legend { display: flex; flex-wrap: wrap; gap: 2px 4px; margin-left: -2px; }
.vhelp__balance { margin: 6px 0 8px; font-size: 12px; color: var(--color-text-muted); }
.vhelp__ops { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 4px 8px; font-size: 12px; }
.vhelp__chip { justify-self: start; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px; color: var(--c); white-space: nowrap; }
.vhelp__chip--fill { background: color-mix(in oklch, var(--c) 16%, transparent); }
.vhelp__chip--line { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 55%, transparent); }
.vhelp__opwords { color: var(--color-text-secondary); }
.vhelp__when { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 8px 0 0; font-size: 12px; color: var(--color-text-muted); }
.vhelp__whentag { padding: 0 4px; border-radius: 3px; font-size: 10.5px; line-height: 15px; color: var(--color-text-secondary); background: oklch(0.28 0.006 95); }
.vhelp__gauges { display: grid; gap: 7px; }
.vhelp__gauge { display: grid; grid-template-columns: minmax(58px, auto) 1fr 30px; align-items: center; gap: 8px; font-size: 12px; }
.vhelp__gname { color: var(--color-text-muted); white-space: nowrap; }
.vhelp__gname b { margin-right: 4px; font-weight: 400; color: var(--c); }
.vhelp__bar { height: 5px; border-radius: 3px; background: oklch(0.24 0.006 95); overflow: hidden; }
.vhelp__bar i { display: block; height: 100%; border-radius: 3px; background: var(--c); opacity: 0.85; transition: width var(--duration-slow) var(--ease-out); }
.vhelp__n { text-align: right; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.vhelp__ticks { display: flex; flex-wrap: wrap; gap: 3px; }
.vhelp__ticks i { width: 5px; height: 9px; border-radius: 2px; background: color-mix(in oklch, var(--color-sage-400) 60%, transparent); }
.vhelp__ledger { display: grid; gap: 4px; margin-top: 10px; padding-top: 9px; border-top: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent); font-size: 12px; }
.vhelp__ledger-title { font-size: 10.5px; letter-spacing: 0.14em; color: var(--color-text-muted); }
.vhelp__line { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; }
.vhelp__src { color: var(--color-text-secondary); }
.vhelp__tab { margin-left: 4px; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--color-text-muted); }
.vhelp__to { color: var(--color-text-muted); }
.vhelp__to b { font-weight: 400; color: var(--c); }
.vhelp__gain { min-width: 32px; text-align: right; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.vhelp__toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; font-size: 12.5px; }
.vhelp__toggle--first { margin-top: 14px; }
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
@media (prefers-reduced-motion: reduce) { .vhelp { animation: none; } .vhelp__bar i { transition: none; } }
</style>
