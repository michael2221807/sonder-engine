<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.8 · Plot-vector card table
/**
 * The round's opening (PO 2026-10-01 C; demo docs/demo/plot-vector-effect-and-start.html): a glass ribbon rises out
 * of the badge above the input, plays this round's trip in miniature (about 1.4 s: the shuttle with its trail, the
 * cards that act flashing their marks), then folds into the three tendency bars in the table's marks and colours,
 * the round's push landing like a stamp. It floats up and a thin light rises into the story, where the writing
 * indicator glows once. A press puts it away at once; it never covers the input. Without the walk (reduced motion,
 * or the automatic walk turned off) only the result shows. The badge walks the same cells at the same moments
 * (PO A: `step`).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RoundOpening } from '@/features/plot-vector/table-model';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import { MARK_COLOR, MARK_GLYPH, SIGN_MARK } from './effect-marks';
import { prefersReducedMotion } from './use-trip-walk';

const props = defineProps<{
  opening: RoundOpening;
  /** Where it floats: the story column above the input row, and the badge's middle (it grows out of it). */
  place: { left: number; width: number; bottom: number; badgeX: number };
  /** Play the walk; otherwise only the result. */
  walk: boolean;
}>();
const emit = defineEmits<{ (e: 'step', cell: string | null): void; (e: 'done'): void }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';

const WIDTH = 460;
const width = computed(() => Math.min(WIDTH, props.place.width));
const style = computed(() => ({
  left: `${props.place.left + (props.place.width - width.value) / 2}px`,
  width: `${width.value}px`,
  bottom: `${props.place.bottom}px`,
  '--ox': `${Math.round(props.place.badgeX - (props.place.left + (props.place.width - width.value) / 2))}px`,
}));

const phase = ref<'rising' | 'walk' | 'result' | 'leaving'>('rising');
const shown = ref(false);
const flash = ref(false);
const dotX = ref<number | null>(null);
const jump = ref(false);
const root = ref<HTMLElement>();
const rail = ref<HTMLElement>();
const cellEls = new Map<string, HTMLElement>();
const bindCell = (id: string) => (el: unknown) => { if (el instanceof HTMLElement) cellEls.set(id, el); else cellEls.delete(id); };

const tendency = computed(() => props.opening.walk.tendency);
const sBar = computed(() => {
  const v = Math.max(-1, Math.min(1, tendency.value.s));
  return { left: v >= 0 ? '50%' : `${50 + v * 50}%`, width: `${Math.abs(v) * 50}%`, background: v >= 0 ? MARK_COLOR.up : MARK_COLOR.down };
});
const bar = (v: number) => ({ width: `${Math.max(0, Math.min(1, v)) * 100}%` });
const words = computed(() => {
  const i = props.opening.impulse;
  if (!i) return '';
  const tone = t(`mainGame.vectorTable.impulse.tone.${i.tone}`);
  return i.lean ? `${tone} · ${t(`mainGame.vectorTable.impulse.lean.${i.lean}`)}` : tone;
});
const wordsColor = computed(() => {
  const tone = props.opening.impulse?.tone;
  return tone === 'with' ? 'var(--color-sage-300)' : tone === 'even' ? 'var(--color-text-secondary)' : 'var(--color-amber-300)';
});
const fills = ref(false);

// Every wait belongs to this run; a press or unmount stops it, and a stopped wait resolves at once (the walk then
// sees it is no longer alive and returns). `later` runs what follows the leave, cleared on unmount too.
let alive = true;
const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
const wait = (ms: number) => new Promise<void>(resolve => {
  if (!alive) { resolve(); return; }
  const id = setTimeout(() => { waits.delete(id); resolve(); }, ms);
  waits.set(id, resolve);
});
function stopWaits(): void {
  for (const [id, resolve] of waits) { clearTimeout(id); resolve(); }
  waits.clear();
}
const afters = new Set<ReturnType<typeof setTimeout>>();
function later(fn: () => void, ms: number): void {
  const id = setTimeout(() => { afters.delete(id); fn(); }, ms);
  afters.add(id);
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

function cellX(cell: string): number | null {
  const el = cellEls.get(cell), r = rail.value;
  if (!el || !r) return null;
  const a = el.getBoundingClientRect(), b = r.getBoundingClientRect();
  return a.left + a.width / 2 - b.left;
}
/** A mark rising from a cell (or from the start, for what acts at departure). */
function sign(at: HTMLElement, mark: keyof typeof MARK_GLYPH, x?: number): void {
  if (!root.value) return;
  const s = document.createElement('span');
  s.className = 'vopen__sign';
  s.textContent = MARK_GLYPH[mark];
  s.style.color = MARK_COLOR[mark];
  if (x !== undefined) s.style.left = `${x}px`;
  at.appendChild(s);
  s.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, offset: 0.3 }, { opacity: 0, transform: 'translateY(-10px)' }],
    { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).onfinish = () => s.remove();
}
function trail(x: number): void {
  const r = rail.value;
  if (!r) return;
  const dot = document.createElement('span');
  dot.className = 'vopen__trail';
  dot.style.left = `${x}px`;
  r.appendChild(dot);
  dot.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => dot.remove();
}

async function play(): Promise<void> {
  await nextTick();
  await frame();
  await frame();
  if (!alive) return;
  shown.value = true;
  const motion = props.walk && !prefersReducedMotion();
  if (motion) {
    phase.value = 'walk';
    await wait(420);
    if (!alive) return;
    const { steps, departure } = props.opening.walk;
    const start = cellX(steps[0]?.cell ?? '01');
    if (departure.length && rail.value && start !== null) {
      dotX.value = start;
      // Up to three signs side by side above the start.
      const shown = departure.slice(0, 3);
      shown.forEach((d, i) => sign(rail.value!, SIGN_MARK[d.sign], start + (i - (shown.length - 1) / 2) * 12));
      await wait(220);
      if (!alive) return;
    }
    // About 1.4 s however long the trip.
    const stepMs = Math.min(150, 1400 / Math.max(1, steps.length));
    let last: string | null = null;
    for (const step of steps) {
      if (!alive) return;
      const x = cellX(step.cell);
      if (x === null) continue;
      // Around the ring the shuttle comes back to 01 from 06: it jumps there instead of sliding back over the row.
      jump.value = last !== null && Math.abs(Number(step.cell) - Number(last)) > 1;
      dotX.value = x;
      emit('step', step.cell);
      trail(x);
      const acted = step.acted[0];
      const el = cellEls.get(step.cell);
      if (acted && el) {
        const mark = SIGN_MARK[acted.sign];
        el.animate([{ boxShadow: `0 0 0 1px ${MARK_COLOR[mark]}, 0 0 18px ${MARK_COLOR[mark]}` }, { boxShadow: '0 0 0 0 transparent' }],
          { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        sign(el, mark);
      }
      last = step.cell;
      await wait(stepMs);
    }
    await wait(260);
    if (!alive) return;
    emit('step', null);
  }
  if (!alive) return;
  // The board steps back; the three leanings light up; the push lands.
  phase.value = 'result';
  await frame();
  if (!alive) return;
  fills.value = true;
  flash.value = motion;
  await wait(motion ? 2300 : 2600);
  if (!alive) return;
  leave(true);
}

const streak = ref<{ x: number; y: number; rise: number } | null>(null);
/** Float up and fade; after the round's own result, a light rises into the story and the writing indicator glows. */
function leave(flow: boolean): void {
  if (phase.value === 'leaving') return;
  alive = false;
  stopWaits();
  emit('step', null);
  phase.value = 'leaving';
  const box = root.value?.getBoundingClientRect();
  if (flow && box && !prefersReducedMotion()) {
    const writing = document.querySelector<HTMLElement>('[data-story-writing]');
    const target = writing?.getBoundingClientRect();
    const rise = target && target.bottom < box.top ? Math.max(80, box.top - target.bottom) : 160;
    streak.value = { x: box.left + box.width / 2, y: box.top, rise };
    if (writing) {
      later(() => {
        if (writing.isConnected) writing.animate(
          [{ filter: 'none' }, { filter: 'drop-shadow(0 0 6px var(--color-amber-400)) brightness(1.5)' }, { filter: 'none' }],
          { duration: 900, easing: 'ease-out' });
      }, 420);
    }
  }
  later(() => emit('done'), prefersReducedMotion() ? 0 : 950);
}
/** Esc puts it away, as a press does. */
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') leave(false); }

onMounted(() => {
  window.addEventListener('keydown', onKey);
  void play();
});
onBeforeUnmount(() => {
  alive = false;
  stopWaits();
  for (const id of afters) clearTimeout(id);
  afters.clear();
  window.removeEventListener('keydown', onKey);
  // A ribbon taken away in the middle of its walk leaves no badge cell lit.
  emit('step', null);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="vopen"
      :class="[`vopen--${phase}`, { 'vopen--in': shown && phase !== 'leaving', 'vopen--flash': flash }]"
      :style="style"
      role="status"
      :aria-label="`${t('mainGame.vectorTable.opening.label')}${words ? `：${words}` : ''}`"
      data-testid="vector-opening"
      @click="leave(false)"
    >
      <div class="vopen__mini" aria-hidden="true">
        <div class="vopen__cells">
          <div
            v-for="cell in opening.cells"
            :key="cell.id"
            :ref="bindCell(cell.id)"
            class="vopen__cell"
            :class="{ 'vopen__cell--held': cell.card && !cell.status, 'vopen__cell--status': cell.status && cell.card }"
            :style="cell.card?.tier && cell.card.tier !== 'common' ? { '--edge': `var(--tier-${cell.card.tier})` } : undefined"
          >
            <span v-if="cell.card">{{ label(cell.card.name) }}</span>
          </div>
        </div>
        <div ref="rail" class="vopen__rail">
          <span v-if="dotX !== null" class="vopen__dot" :class="{ 'vopen__dot--jump': jump }" :style="{ left: `${dotX}px` }" />
        </div>
      </div>
      <div class="vopen__result" :class="{ 'vopen__result--fill': fills }" data-testid="vector-opening-result">
        <div class="vopen__meters">
          <div class="vopen__meter">
            <div class="vopen__track vopen__track--bi"><i class="vopen__fill" :style="fills ? sBar : undefined" /><i class="vopen__shine" /></div>
            <span class="vopen__ends">
              <span :style="{ color: MARK_COLOR.down }">{{ MARK_GLYPH.down }} {{ t('mainGame.vectorTable.legend.strain') }}</span>
              <span :style="{ color: MARK_COLOR.up }">{{ t('mainGame.vectorTable.legend.ease') }} {{ MARK_GLYPH.up }}</span>
            </span>
          </div>
          <div class="vopen__meter">
            <div class="vopen__track"><i class="vopen__fill" :style="[{ background: MARK_COLOR.social }, fills ? bar(tendency.y) : {}]" /><i class="vopen__shine" /></div>
            <span :style="{ color: MARK_COLOR.social }">{{ MARK_GLYPH.social }} {{ t('mainGame.vectorTable.tendency.y') }}</span>
          </div>
          <div class="vopen__meter">
            <div class="vopen__track"><i class="vopen__fill" :style="[{ background: MARK_COLOR.chance }, fills ? bar(tendency.j) : {}]" /><i class="vopen__shine" /></div>
            <span :style="{ color: MARK_COLOR.chance }">{{ MARK_GLYPH.chance }} {{ t('mainGame.vectorTable.tendency.j') }}</span>
          </div>
        </div>
        <span v-if="words" class="vopen__words" :style="{ color: wordsColor }" data-testid="vector-opening-words">{{ words }}</span>
      </div>
    </div>
    <span
      v-if="streak"
      class="vopen__streak"
      :style="{ left: `${streak.x}px`, top: `${streak.y - 120}px`, '--rise': `-${streak.rise}px` }"
      aria-hidden="true"
    />
  </Teleport>
</template>

<style scoped>
.vopen {
  position: fixed;
  z-index: var(--z-floating);
  height: 98px;
  padding: 14px 20px;
  border-radius: 20px;
  border: none;
  background: linear-gradient(var(--glass-bg), var(--glass-bg)), color-mix(in oklch, var(--color-bg) 80%, transparent);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), 0 18px 44px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transform: translateY(14px) scale(0.92);
  transform-origin: var(--ox, 88%) 140%;
  pointer-events: none;
  cursor: pointer;
  overflow: hidden;
}
.vopen::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.vopen--in { opacity: 1; transform: none; pointer-events: auto; transition: opacity 320ms var(--ease-out), transform 460ms var(--ease-out); }
.vopen--leaving { opacity: 0; transform: translateY(-60px) scale(0.96); transition: opacity 700ms var(--ease-in-out), transform 900ms var(--ease-in-out); }

/* The board in miniature. */
.vopen__mini { position: absolute; inset: 14px 20px; transition: opacity 360ms var(--ease-in-out), transform 420ms var(--ease-in-out); }
.vopen--result .vopen__mini, .vopen--leaving .vopen__mini { opacity: 0; transform: translateY(-8px) scale(0.98); }
.vopen__cells { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.vopen__cell { position: relative; height: 34px; border-radius: 8px; background: oklch(0.17 0.008 95); box-shadow: inset 0 0 0 1px oklch(0.22 0.006 95); overflow: hidden; }
.vopen__cell--held { background: linear-gradient(180deg, oklch(0.23 0.01 90), oklch(0.19 0.008 90)); box-shadow: none; }
.vopen__cell--held::before { content: ''; position: absolute; top: 0; left: 6px; right: 6px; height: 2px; background: var(--edge, transparent); }
.vopen__cell--status { background: color-mix(in oklch, var(--color-danger) 16%, oklch(0.18 0.01 60)); box-shadow: none; }
.vopen__cell span { position: absolute; left: 6px; right: 4px; bottom: 4px; font-family: var(--font-serif-cjk); font-size: 10.5px; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vopen__cell :deep(.vopen__sign), .vopen__rail :deep(.vopen__sign) { position: absolute; right: 6px; top: 3px; font-size: 11px; pointer-events: none; }
.vopen__rail :deep(.vopen__sign) { right: auto; top: -10px; margin-left: -4px; }
.vopen__rail { position: relative; height: 18px; margin-top: 6px; }
.vopen__rail::before { content: ''; position: absolute; left: 4%; right: 4%; top: 8px; height: 1px; background: linear-gradient(90deg, transparent, oklch(0.34 0.02 95) 10%, oklch(0.34 0.02 95) 90%, transparent); }
.vopen__dot { position: absolute; top: 3px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: var(--color-amber-300); box-shadow: 0 0 12px var(--color-amber-400); transition: left 90ms linear; }
.vopen__dot--jump { transition: none; }
.vopen__rail :deep(.vopen__trail) { position: absolute; top: 5px; width: 7px; height: 7px; margin-left: -3.5px; border-radius: 50%; background: var(--color-amber-400); box-shadow: 0 0 6px var(--color-amber-400); pointer-events: none; }

/* The result, lit. */
.vopen__result { position: absolute; inset: 14px 20px; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 16px; opacity: 0; pointer-events: none; }
.vopen--result .vopen__result, .vopen--leaving .vopen__result { opacity: 1; transition: opacity 260ms var(--ease-in-out) 80ms; }
.vopen__meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.vopen__meter { display: grid; gap: 8px; justify-items: center; font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }
.vopen__track { position: relative; width: 100%; height: 6px; border-radius: 3px; background: oklch(0.22 0.006 95); overflow: hidden; }
.vopen__track--bi::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: oklch(0.32 0.006 95); }
.vopen__fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0; border-radius: 3px; background: var(--ch-push); }
.vopen__result--fill .vopen__fill { transition: width 700ms var(--ease-out), left 700ms var(--ease-out); }
.vopen__shine { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent); transform: translateX(-100%); }
.vopen--flash .vopen__shine { animation: vopen-shine 700ms var(--ease-in-out) 650ms; }
@keyframes vopen-shine { to { transform: translateX(100%); } }
.vopen--flash .vopen__meter > span { animation: vopen-lit 900ms var(--ease-in-out) 650ms; }
@keyframes vopen-lit { 30% { filter: brightness(1.5); } }
.vopen__ends { display: flex; justify-content: space-between; width: 100%; gap: 6px; }
.vopen__words { font-family: var(--font-serif-cjk); font-size: 15px; white-space: nowrap; }
.vopen--flash .vopen__words { opacity: 0; transform: scale(1.18); animation: vopen-stamp 520ms var(--ease-out) 900ms forwards; }
@keyframes vopen-stamp {
  0% { opacity: 0; transform: scale(1.18); clip-path: circle(0% at 50% 50%); }
  45% { opacity: 1; transform: scale(0.98); clip-path: circle(90% at 50% 50%); }
  100% { opacity: 1; transform: none; clip-path: circle(120% at 50% 50%); }
}

/* Where the push goes: a thin light rising from the ribbon into the story. */
.vopen__streak {
  position: fixed;
  z-index: var(--z-floating);
  width: 2px;
  height: 120px;
  margin-left: -1px;
  border-radius: 2px;
  opacity: 0;
  pointer-events: none;
  background: linear-gradient(to top, transparent, var(--color-amber-400), transparent);
  animation: vopen-streak 900ms var(--ease-in-out) forwards;
}
@keyframes vopen-streak {
  0% { opacity: 0; transform: translateY(40px) scaleY(0.4); }
  40% { opacity: 0.9; }
  100% { opacity: 0; transform: translateY(var(--rise, -160px)) scaleY(1); }
}

/* A narrow phone: the ribbon keeps its height, the cells their order; the words go under the bars. */
@media (max-width: 480px) {
  .vopen { height: 112px; padding: 12px 14px; }
  .vopen__mini, .vopen__result { inset: 12px 14px; }
  .vopen__cells { gap: 6px; }
  .vopen__result { grid-template-columns: 1fr; gap: 8px; align-content: center; }
  .vopen__meters { gap: 10px; }
  .vopen__meter { font-size: 11px; }
  .vopen__words { justify-self: center; font-size: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .vopen--in, .vopen--leaving, .vopen__mini, .vopen__result--fill .vopen__fill, .vopen--result .vopen__result { transition: none !important; }
  .vopen--flash .vopen__shine, .vopen--flash .vopen__words, .vopen--flash .vopen__meter > span, .vopen__streak { animation: none !important; }
  .vopen__words { opacity: 1; transform: none; }
}
</style>
