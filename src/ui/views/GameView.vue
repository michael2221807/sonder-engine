<script setup lang="ts">
// App doc: docs/user-guide/pages/game-overview.md
/**
 * GameView — Main game shell view.
 *
 * This view is the parent route for all in-game panels (/game/*).
 * Its responsibilities are deliberately narrow:
 *
 * 1. **Guard**: Check that a game is loaded (via useGameState); if not,
 *    redirect to the home page. This prevents users from manually
 *    navigating to /game without having loaded a save.
 *
 * 2. **Layout**: Wrap <router-view> inside GameLayout, which provides
 *    the three-column structure (TopBar + LeftSidebar + content + RightSidebar).
 *
 * 3. **Theme**: Apply the Game Pack's theme on mount via useTheme.
 *    Theme variables cascade to all child panel components.
 *
 * 4. **Dependency provision**: Provide game-scoped dependencies via
 *    Vue's provide() so deeply nested panel components can inject them
 *    without prop-drilling. This includes the engine state store reference
 *    and any game-session-specific services.
 *
 * The actual panel content is rendered by <router-view> inside the
 * GameLayout's default slot. Panel routing is defined in the router
 * config as children of the /game route.
 *
 * Design note: GameView intentionally does NOT contain panel logic,
 * sidebar collapse state, or panel action handling. Those concerns
 * belong to GameLayout and the individual panel components respectively.
 * This separation keeps GameView thin and focused on its guard/provision role.
 */
import { watch, provide, onMounted, computed } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useRouter } from 'vue-router';
import { useGameState } from '@/ui/composables/useGameState';
import { useTheme } from '@/ui/composables/useTheme';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useMobile } from '@/ui/composables/useMobile';
import GameLayout from '@/ui/layouts/GameLayout.vue';

const router = useRouter();
const { isLoaded } = useGameState();
const { isMobile } = useMobile();
const keepAliveMax = computed(() => isMobile.value ? 4 : undefined);
const engineState = useEngineStateStore();

// ─── Injected dependencies ────────────────────────────────────
const eventBus = injectService('eventBus');
const gamePack = injectService('gamePack');

// ─── Theme application ───────────────────────────────────────
// useTheme reads the injected gamePack's theme config and applies
// it as CSS variables on the document root.
useTheme();

// ─── Game-scoped dependency provision ─────────────────────────
// Re-provide dependencies at the game view level so that deeply
// nested panel components can rely on them being available when
// a game session is active.
provide('engineState', engineState);
if (eventBus) provide('eventBus', eventBus);
if (gamePack) provide('gamePack', gamePack);

// ─── Navigation guard ─────────────────────────────────────────
// If no game is loaded, redirect back to the home page.
// This runs on mount and reactively whenever isLoaded changes.

onMounted(() => {
  if (!isLoaded.value) {
    router.replace('/');
  }
  // Root-metrics preload lives in main.ts so it fires before any route mounts.
});

watch(isLoaded, (loaded) => {
  if (!loaded) {
    router.replace('/');
  }
});
</script>

<template>
  <!--
    Only render the game layout when a game is actually loaded.
    The brief moment between mount and the watcher redirect is
    covered by the v-if to prevent layout flash with empty data.
  -->
  <GameLayout v-if="isLoaded">
    <router-view v-slot="{ Component }">
      <KeepAlive :max="keepAliveMax">
        <component :is="Component" />
      </KeepAlive>
    </router-view>
  </GameLayout>

  <!--
    Fallback loading state shown during the redirect grace period.
    In practice this is visible for < 100ms before the router navigates away.
  -->
  <div v-else class="game-guard-loading" role="status" aria-label="加载中">
    <div class="guard-spinner" aria-hidden="true" />
    <p class="guard-message">正在验证游戏状态…</p>
  </div>
</template>

<style scoped>
/*
 * The GameView itself has no visual footprint — GameLayout handles
 * all the layout rendering. These styles only cover the guard
 * fallback state shown before redirect.
 */

.game-guard-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 1rem;
  background: var(--color-bg);
}

.guard-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: guard-spin 0.8s linear infinite;
}

@keyframes guard-spin {
  to {
    transform: rotate(360deg);
  }
}

.guard-message {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
}
</style>
