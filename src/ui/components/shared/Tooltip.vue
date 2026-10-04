<script setup lang="ts">
// App doc: docs/user-guide/pages/game-overview.md §设计系统原语 (Tooltip · fixed 模式)
/**
 * Tooltip — the project's single hover-hint primitive (Story 5 / U12).
 *
 * Per CLAUDE.md §8: ALL hover hints must use this component. Do NOT stack bare
 * `title=` attributes or hand-roll tooltips. Glass chip-grade surface (light blur,
 * no full glass recipe). The 800ms reveal delay is CSS-only (no JS timers) so it
 * stays smooth on low-end devices.
 *
 * Two modes:
 *  - default (non-interactive): wraps a static element (icon, badge, label). The
 *    wrapper is itself focusable (tabindex=0) + `cursor: help` so keyboard users
 *    can surface the hint.
 *  - interactive: wraps a focusable control (button / a / input). The wrapper does
 *    NOT add its own tabindex (avoids a nested-focusable a11y anti-pattern) and
 *    inherits the trigger's cursor; the hint reveals on :focus-within so focusing
 *    the inner control still shows it. Use this when wrapping any clickable element.
 *
 * Usage:
 *   <Tooltip :text="$t('save.export.nsfw.hint')"><InfoIcon /></Tooltip>
 *   <Tooltip :text="$t('layout.topbar.ariaSettings')" interactive>
 *     <button @click="open">⚙</button>
 *   </Tooltip>
 */
import { computed, nextTick, ref, useId, watch, onBeforeUnmount } from 'vue';
import { placeFixedTip, FIXED_TIP_MARGIN } from './tooltip-placement';

const props = withDefaults(
  defineProps<{
    /** Single-sentence hint (Polanyi: one sentence, ≤ ~100 chars). */
    text: string;
    /**
     * Bubble side relative to the trigger. In `fixed` mode it is the preferred side, above or below only
     * (`bottom` prefers below, anything else above); the bubble flips when it does not fit there.
     */
    position?: 'top' | 'bottom' | 'left' | 'right';
    /** Reveal delay in ms (default 800 — appears only on a deliberate hover). */
    delay?: number;
    /** Set when the slot is a focusable control (button/a/input). */
    interactive?: boolean;
    /**
     * Render the bubble teleported to <body>, viewport-fixed and clamped to the
     * viewport. Use inside clipping/scrolling containers (overflow:hidden/auto)
     * or under sticky/z-indexed siblings where the in-flow bubble would be cut
     * off or covered (plot timeline track, 2026-08-23). Reveal is still the
     * CSS delay — only the position is measured in JS, on hover/focus start,
     * from the bubble's real size (`tooltip-placement.ts`). Focus shows it
     * only when it is keyboard focus (`:focus-visible`).
     */
    fixed?: boolean;
    /** Suppress the hint entirely (e.g. while the wrapped control is mid-drag). */
    disabled?: boolean;
  }>(),
  { position: 'top', delay: 800, interactive: false, fixed: false, disabled: false },
);

// Vue 3.5 useId() → collision-free, SSR/HMR-safe id for aria-describedby (no globalThis mutation).
const tipId = `tt-${useId()}`;

const styleVars = computed(() => ({ '--tt-delay': `${props.delay}ms` }));

// ─── fixed mode ───
const wrapEl = ref<HTMLElement | null>(null);
const bubbleEl = ref<HTMLElement | null>(null);
const hot = ref(false);
const fixedPos = ref({ left: 0, top: 0 });
function place(): void {
  const r = wrapEl.value?.getBoundingClientRect();
  const bubble = bubbleEl.value;
  if (!r || !bubble) return;
  // The hidden bubble is laid out already (visibility, not display), so its real size is known before it shows.
  const size = { width: bubble.offsetWidth, height: bubble.offsetHeight };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const p = placeFixedTip(r, size, viewport, props.position === 'bottom' ? 'bottom' : 'top');
  fixedPos.value = { left: p.left, top: p.top };
}
function enter(): void { if (!props.fixed) return; place(); hot.value = true; }
function leave(): void { hot.value = false; }
/**
 * Keyboard focus shows the hint. Focus a script hands back (a dialog closing onto the control that opened it)
 * does not: that hint showed with the pointer elsewhere and stayed until the control lost focus (2026-10-04).
 */
function focusEnter(e: FocusEvent): void {
  if (!props.fixed || (e.target instanceof Element && !focusVisible(e.target))) return;
  enter();
}
/** A browser without `:focus-visible` shows the hint on any focus, as before. */
function focusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return true; }
}
/**
 * A scroll that can move the trigger (the page, or a scroller around it) closes the hint; any other scroll
 * leaves it be. The story keeps scrolling while text streams in, and that closed every status-bar hint
 * before it could show (2026-10-04).
 */
function onScroll(e: Event): void {
  const scrolled = e.target;
  if (hot.value && (!(scrolled instanceof Node) || scrolled.contains(wrapEl.value))) hot.value = false;
}
function onResize(): void { if (hot.value) place(); }
watch(hot, (on) => {
  if (!props.fixed) return;
  if (on) {
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
  } else {
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onResize);
  }
});
// A hint whose words change while it shows is measured again, so it still fits.
watch(() => props.text, () => { if (hot.value) void nextTick(place); });
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, { capture: true });
  window.removeEventListener('resize', onResize);
});
const fixedStyle = computed(() => ({
  left: `${fixedPos.value.left}px`,
  top: `${fixedPos.value.top}px`,
  // Never taller than the viewport less its margins, so placement can always keep the bubble whole on screen:
  // some hints show data with no length cap, such as a plot gauge's description.
  maxHeight: `calc(100vh - ${2 * FIXED_TIP_MARGIN}px)`,
}));
</script>

<template>
  <span
    ref="wrapEl"
    class="tt-wrap"
    :class="[`tt-wrap--${position}`, { 'tt-wrap--interactive': interactive, 'tt-wrap--fixed': fixed, 'tt-wrap--off': disabled }]"
    :tabindex="interactive ? undefined : 0"
    :aria-describedby="tipId"
    :style="styleVars"
    @pointerenter="enter"
    @pointerleave="leave"
    @focusin="focusEnter"
    @focusout="leave"
  >
    <slot />
    <Teleport v-if="fixed" to="body">
      <span :id="tipId" ref="bubbleEl" class="tt-bubble tt-bubble--fixed" :class="{ 'tt-bubble--hot': hot && !disabled }" :style="[styleVars, fixedStyle]" role="tooltip">{{ text }}</span>
    </Teleport>
    <span v-else :id="tipId" class="tt-bubble" role="tooltip">{{ text }}</span>
  </span>
</template>

<style scoped>
.tt-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: help;
  outline: none;
}

/* Interactive trigger: let the inner control own focus + cursor. */
.tt-wrap--interactive {
  cursor: inherit;
}

.tt-bubble {
  position: absolute;
  z-index: var(--z-tooltip);
  width: max-content;
  max-width: 240px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text, #ece7df);
  /* chip-grade: readable dark surface + light blur, no full glass recipe */
  background: rgba(25, 24, 22, 0.92);
  backdrop-filter: blur(6px) saturate(1.2);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  /* hide is immediate; show waits --tt-delay (CSS-only, no JS timer) */
  transition: opacity 0.14s var(--ease-out), visibility 0s linear 0.14s;
}

.tt-wrap:hover .tt-bubble,
.tt-wrap:focus-visible .tt-bubble,
.tt-wrap--interactive:focus-within .tt-bubble {
  opacity: 1;
  visibility: visible;
  transition:
    opacity 0.14s var(--ease-out) var(--tt-delay, 800ms),
    visibility 0s linear var(--tt-delay, 800ms);
}

/* fixed mode: the bubble lives on <body>, positioned from the trigger rect
   (see `place()`); same chip surface, same CSS reveal delay via the class. */
.tt-bubble--fixed {
  position: fixed;
  z-index: var(--z-floating, 9100);
  /* the height cap is set inline with the placement margin (`fixedStyle`); text past it is cut */
  overflow: hidden;
}
.tt-bubble--fixed.tt-bubble--hot {
  opacity: 1;
  visibility: visible;
  transition:
    opacity 0.14s var(--ease-out) var(--tt-delay, 800ms),
    visibility 0s linear var(--tt-delay, 800ms);
}

.tt-wrap--off .tt-bubble { display: none; }

.tt-wrap--top .tt-bubble    { bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.tt-wrap--bottom .tt-bubble { top: calc(100% + 6px);    left: 50%; transform: translateX(-50%); }
.tt-wrap--left .tt-bubble   { right: calc(100% + 6px);  top: 50%;  transform: translateY(-50%); }
.tt-wrap--right .tt-bubble  { left: calc(100% + 6px);   top: 50%;  transform: translateY(-50%); }

@media (prefers-reduced-motion: reduce) {
  .tt-bubble,
  .tt-wrap:hover .tt-bubble,
  .tt-wrap:focus-visible .tt-bubble,
  .tt-wrap--interactive:focus-within .tt-bubble,
  .tt-bubble--fixed.tt-bubble--hot {
    transition: none;
  }
}

/* Touch-only devices have no hover, so the bubble can never legitimately
   reveal — but as a hidden absolutely-positioned box (`visibility: hidden`
   still occupies scrollable overflow) it widened scroll containers past the
   viewport and let iOS Safari pan the page horizontally during vertical
   pulls (2026-08-21 mobile bug). `display: none` removes it from layout. */
@media (hover: none) and (pointer: coarse) {
  .tt-bubble {
    display: none;
  }
}
</style>
