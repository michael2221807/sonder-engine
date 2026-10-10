<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.2 · Plot-vector card table
/**
 * The converter cell's rule (PO 2026-10-09, choice A): the player picks which quantity's half turns into which, the
 * same either way the shuttle passes. Two rows of the four quantities in the glyphs and colours of the bars; picking
 * the side already taken by the other row swaps them, so the rule can never turn something into itself. It opens
 * beside cell 03's mark, closes on Escape, a press outside, the focus leaving it, or the page moving under it, and
 * gives the focus back to the mark when it closes by the keyboard.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CHANNEL_NAMES, type ChannelName } from '@/features/plot-vector/contract/types';
import type { ConverterRule } from '@/features/plot-vector/vector-board';
import { CHANNEL_KEY, CHANNEL_MARK, MARK_COLOR, MARK_GLYPH } from './effect-marks';

const props = defineProps<{ rule: ConverterRule; anchor: HTMLElement }>();
const emit = defineEmits<{ (e: 'pick', rule: ConverterRule): void; (e: 'close'): void }>();
const { t } = useI18n();

const el = ref<HTMLElement>();
const pos = ref({ left: 0, top: 0 });
const placed = ref(false);

function choose(side: 'from' | 'to', ch: ChannelName): void {
  const other = side === 'from' ? 'to' : 'from';
  if (props.rule[side] === ch) return;
  // Taking the other row's quantity swaps the two.
  const next: ConverterRule = props.rule[other] === ch
    ? { from: props.rule.to, to: props.rule.from }
    : { ...props.rule, [side]: ch };
  emit('pick', next);
}

// Escape closes the picker only: caught first and kept from the table's own Escape (which would close the table).
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  props.anchor.focus();
  emit('close');
}
// A press on the mark itself is left to the mark, which toggles the picker (closing here would reopen it there).
function onPress(e: PointerEvent): void {
  const target = e.target as Node;
  if (el.value && !el.value.contains(target) && !props.anchor.contains(target)) emit('close');
}
// Tabbing out of it closes it; the focus goes on where the keyboard sent it.
function onFocusOut(e: FocusEvent): void {
  const next = e.relatedTarget as Node | null;
  if (next && el.value && !el.value.contains(next) && !props.anchor.contains(next)) emit('close');
}
// It is placed once beside the mark: when the page scrolls or resizes under it, it closes rather than drifts away.
const onMove = (e: Event) => { if (!(e.target instanceof Node && el.value?.contains(e.target))) emit('close'); };
const listen = () => {
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPress, true);
  window.addEventListener('resize', onMove);
  document.addEventListener('scroll', onMove, true);
};
const unlisten = () => {
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPress, true);
  window.removeEventListener('resize', onMove);
  document.removeEventListener('scroll', onMove, true);
};
// Listening starts at once, so an unmount before the first frame never leaves a listener behind (the press that
// opened it has already been handled: it opens on the click, after its pointerdown).
listen();
let gone = false;
onMounted(async () => {
  await nextTick();
  if (gone) return;
  const a = props.anchor.getBoundingClientRect();
  const w = el.value?.offsetWidth ?? 260, h = el.value?.offsetHeight ?? 120, m = 12;
  const left = Math.max(m, Math.min(window.innerWidth - w - m, a.left + a.width / 2 - w / 2));
  const below = a.bottom + 8;
  pos.value = { left, top: below + h + m <= window.innerHeight ? below : Math.max(m, a.top - h - 8) };
  placed.value = true;
  // Until it is placed it is only transparent (not hidden), so it can take the focus at once.
  el.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
});
onBeforeUnmount(() => { gone = true; unlisten(); });
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      @focusout="onFocusOut"
      class="vconv"
      role="dialog"
      :aria-label="t('mainGame.vectorTable.converter.title')"
      :class="{ 'vconv--unplaced': !placed }"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      data-testid="vector-converter-picker"
    >
      <h3 class="vconv__title">{{ t('mainGame.vectorTable.converter.title') }}</h3>
      <div v-for="side in (['from', 'to'] as const)" :key="side" class="vconv__row" role="group" :aria-label="t(`mainGame.vectorTable.converter.${side}`)">
        <span class="vconv__label">{{ t(`mainGame.vectorTable.converter.${side}`) }}</span>
        <button
          v-for="ch in CHANNEL_NAMES"
          :key="ch"
          type="button"
          class="vconv__ch"
          :style="{ '--c': MARK_COLOR[CHANNEL_MARK[ch]] }"
          :aria-pressed="rule[side] === ch"
          :data-testid="`vector-converter-${side}-${ch}`"
          @click="choose(side, ch)"
        >
          <b aria-hidden="true">{{ MARK_GLYPH[CHANNEL_MARK[ch]] }}</b>{{ t(`mainGame.vectorTable.channel.${CHANNEL_KEY[ch]}`) }}
        </button>
      </div>
      <p class="vconv__note">{{ t('mainGame.vectorTable.converter.note') }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.vconv {
  position: fixed;
  z-index: var(--z-floating);
  width: max-content;
  max-width: calc(100vw - 24px);
  padding: 12px 14px 10px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--color-surface-elevated) 92%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  font-size: 12.5px;
  color: var(--color-text-secondary);
  animation: vconv-in var(--duration-normal) var(--ease-out);
}
.vconv--unplaced { opacity: 0; pointer-events: none; animation: none; }
@keyframes vconv-in { from { opacity: 0; transform: translateY(-4px); } }
.vconv__title { margin: 0 0 8px; font-family: var(--font-serif-cjk); font-size: 14px; font-weight: 600; color: var(--color-text); }
.vconv__row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 4px 0; }
.vconv__label { min-width: 4.5em; color: var(--color-text-muted); }
.vconv__ch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 28%, transparent);
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.vconv__ch b { font-weight: 400; color: var(--c); }
.vconv__ch:hover { background: color-mix(in oklch, var(--c) 10%, transparent); }
.vconv__ch[aria-pressed='true'] { color: var(--c); background: color-mix(in oklch, var(--c) 18%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 60%, transparent); }
.vconv__ch:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vconv__note { margin: 6px 0 0; font-size: 11.5px; color: var(--color-text-muted); }
@media (prefers-reduced-motion: reduce) { .vconv { animation: none; } }
</style>
