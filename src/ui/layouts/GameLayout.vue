<template>
  <!--
    Main game layout wrapper used by GameView.
    Structure: TopBar + (LeftSidebar | main content slot | RightSidebar) + MobileNavBar
    Uses CSS Grid for the body area with floating sidebars.
    Mobile: sidebars become off-screen drawers; MobileNavBar provides bottom navigation.

    Polanyi principle: the layout itself should be invisible to the user.
    It structures space so that focal awareness (game narrative/panels)
    naturally occupies the center, while navigation and status remain
    subsidiary at the periphery. The sidebars can collapse to give
    the content room to breathe.
  -->
  <div class="game-layout">
    <TopBar />

    <div class="game-layout__body">
      <LeftSidebar />

      <main class="game-layout__main" role="main" aria-label="游戏主内容区">
        <slot />
      </main>

      <RightSidebar />
    </div>

    <MobileNavBar />

    <div
      v-if="isMobile && (leftOpen || rightOpen)"
      class="mobile-drawer-backdrop"
      @click="closeAll"
    />
  </div>
</template>

<script setup lang="ts">
// App doc: docs/user-guide/pages/game-overview.md
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TopBar from '@/ui/components/layout/TopBar.vue';
import LeftSidebar from '@/ui/components/layout/LeftSidebar.vue';
import RightSidebar from '@/ui/components/layout/RightSidebar.vue';
import MobileNavBar from '@/ui/components/layout/MobileNavBar.vue';
import { useSidebarDrawer } from '@/ui/composables/useSidebarDrawer';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useSessionMode } from '@/ui/composables/useSessionMode';

const { isMobile, leftOpen, rightOpen, closeAll } = useSidebarDrawer();

/*
 * Story 9 — session-mode (play / worldBuilding) initialization point.
 * GameLayout is the session root (mounted for the whole /game session), so
 * the watchers here outlive any sub-panel mount/unmount.
 *   1. When the active save slot changes (load / switch), sync the reactive
 *      mode from that slot's persisted metadata.
 *   2. When entering worldBuilding mode, auto-open the card-writing guide
 *      panel (design 行1071 / U9). Guard against re-push and stealing nav.
 */
const engineState = useEngineStateStore();
const route = useRoute();
const router = useRouter();
const { isWorldBuilding, syncFromActiveSlot } = useSessionMode();

watch(() => engineState.activeSlotId, () => syncFromActiveSlot(), { immediate: true });

// `immediate` so RESUMING a save whose sessionType is already 'worldBuilding'
// also surfaces the guide (design 行1071 lists it as a state of being IN worldBuilding,
// not only the play→worldBuilding transition). The slot-sync watcher above is declared
// first and runs synchronously, so sessionType is settled before this fires.
// `!prev` covers both: the live play→worldBuilding flip (prev=false) and the
// immediate resume fire (prev=undefined). MainGamePanel also shows an in-panel
// writing-mode notice as a safety net if the user navigates back to it (JOURNEY-2).
watch(isWorldBuilding, (wb, prev) => {
  if (wb && !prev && route.path !== '/game/card-guide') {
    router.push('/game/card-guide').catch(() => {/* navigation guard / duplicate — ignore */});
  }
}, { immediate: true });
</script>

<style scoped>
/*
 * Full-viewport layout — sanctuary migration (Phase 2.1, 2026-04-20).
 *
 * Structural change: sidebars now float over the canvas as frosted droplet
 * panels (iPadOS Stage Manager style) instead of sitting as flex-row columns.
 * The body is `position: relative` so LeftSidebar / RightSidebar can use
 * `position: absolute` in their own scoped styles to float over `<main>`.
 *
 * Scrollbar tokens come from the global rule in tokens.css; no per-component
 * override needed anymore.
 *
 * Template untouched. <main class="game-layout__main"><slot/></main> still
 * renders every /game/* panel via <router-view>.
 */
.game-layout {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}

/*
 * Body = positioning context for floating sidebars.
 * The block layout lets <main> fill the full width; sidebars overlay via
 * their own absolute positioning.
 */
.game-layout__body {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
.game-layout__body::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: var(--grain-texture);
  background-repeat: repeat;
  opacity: var(--grain-opacity);
  mix-blend-mode: var(--grain-blend);
  pointer-events: none;
  z-index: 0;
}

/*
 * Main canvas: fills the full body; sidebars float over its edges.
 * Padding leaves breathing room so the narrative column (max-width 62ch,
 * centered via child CSS) stays clear of the floating sidebars when they
 * are open, and has generous whitespace when they are collapsed.
 */
/*
 * Main canvas fills the full body — NO sidebar reserve padding here.
 *
 * Correction 2026-04-20 (post-user-feedback): the earlier approach of
 * padding this container squeezed EVERY child (topbar status area,
 * MainGamePanel status-bar, messages, input-area) into an ugly
 * three-column layout. The user's intent is "hover over" — the
 * floating sidebars should visually overlap full-width bars (their
 * backgrounds extend edge-to-edge; sidebars just float on top), while
 * only the meaningful CONTENT inside those bars dynamically shifts
 * via per-element padding driven by the same `--sidebar-*-reserve`
 * CSS vars. See TopBar.vue + MainGamePanel.vue for the per-bar
 * implementation.
 */
.game-layout__main {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  /* `clip` (with `hidden` fallback) — iOS Safari can still touch-pan a
     `hidden` axis when descendants overflow (e.g. absolutely-positioned
     tooltip bubbles), which made the mobile page wobble horizontally during
     vertical pulls. `clip` removes the scrollable overflow region entirely.
     Inner wide content (tables/code) keeps its own overflow-x:auto wrapper. */
  overflow-x: hidden;
  overflow-x: clip;
  z-index: 1;
  background: linear-gradient(180deg,
    transparent 0%,
    color-mix(in oklch, var(--color-bg) 97%, oklch(0.10 0.005 95)) 100%);
}

/* ─── Mobile layout ─── */
@media (max-width: 767px) {
  .game-layout {
    grid-template-rows: auto 1fr auto;
  }
}

.mobile-drawer-backdrop {
  display: none;
}
@media (max-width: 767px) {
  .mobile-drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 199;
    background: var(--glass-overlay-bg);
    backdrop-filter: var(--glass-overlay-blur);
    -webkit-backdrop-filter: var(--glass-overlay-blur);
  }
}
</style>
