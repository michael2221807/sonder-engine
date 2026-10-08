<template>
  <!--
    Game view top bar.
    Left:   back-to-home + game pack title + character name
    Center: location · game time · round number + AI status badge
    Right:  fullscreen toggle + quick save + settings gear

    Polanyi principle: the top bar is pure subsidiary awareness —
    it provides orientation context without competing with the main
    game content for focal attention.
  -->
  <header class="topbar" :class="{ 'topbar--writing': isWorldBuilding }" role="banner" :aria-label="$t('layout.topbar.ariaHeader')">
    <!-- ── Left: navigation + identity ── -->
    <div class="topbar__left">
      <Tooltip :text="$t('layout.topbar.ariaBackHome')" interactive>
        <button
          class="topbar__btn topbar__back"
          :aria-label="$t('layout.topbar.ariaBackHome')"
          @click="navigateHome"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
          </svg>
        </button>
      </Tooltip>

      <div class="topbar__title-group">
        <h1 class="topbar__game-title">{{ displayPackName }}</h1>
        <span class="topbar__character-name">{{ displayCharacterName }}</span>
      </div>
    </div>

    <!-- ── Center: location · time · round · status ── -->
    <div class="topbar__center" :aria-label="$t('layout.topbar.ariaStatusInfo')">
      <!-- Location -->
      <span
        v-if="engineState.currentLocation && engineState.currentLocation !== '未知'"
        class="topbar__info-item topbar__location"
        :title="engineState.currentLocation"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" aria-hidden="true">
          <path fill-rule="evenodd" d="M8 1a5 5 0 00-5 5c0 2.761 3.125 6.714 4.594 8.285a.549.549 0 00.812 0C9.875 12.714 13 8.761 13 6a5 5 0 00-5-5zm0 6.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" clip-rule="evenodd" />
        </svg>
        <span class="topbar__info-text">{{ locationShort }}</span>
      </span>

      <!-- Separator -->
      <span v-if="engineState.currentLocation && engineState.currentLocation !== '未知'" class="topbar__sep" aria-hidden="true">·</span>

      <!-- Game time -->
      <span
        v-if="hasGameTime"
        class="topbar__info-item topbar__time"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" aria-hidden="true">
          <path fill-rule="evenodd" d="M8 1a7 7 0 100 14A7 7 0 008 1zm.5 3.5a.5.5 0 00-1 0V8a.5.5 0 00.146.354l2.5 2.5a.5.5 0 00.708-.708L8.5 7.793V4.5z" clip-rule="evenodd" />
        </svg>
        <span class="topbar__info-text">{{ localizedGameTime }}</span>
      </span>

      <!-- Separator -->
      <span v-if="hasGameTime && engineState.roundNumber > 0" class="topbar__sep" aria-hidden="true">·</span>

      <!-- Round number -->
      <Tooltip
        v-if="engineState.roundNumber > 0"
        :text="$t('layout.topbar.roundTooltip', { n: engineState.roundNumber })"
      >
        <span class="topbar__info-item topbar__round">
          <span class="topbar__info-text">{{ $t('layout.topbar.roundText', { n: engineState.roundNumber }) }}</span>
        </span>
      </Tooltip>

      <!-- AI status badge -->
      <span
        :class="['topbar__status-badge', isGenerating ? 'topbar__status-badge--generating' : 'topbar__status-badge--idle']"
        :aria-label="isGenerating ? $t('layout.topbar.ariaAiGenerating') : $t('layout.topbar.ariaAiIdle')"
        role="status"
      >
        <span v-if="isGenerating" class="topbar__status-dot topbar__status-dot--pulse" aria-hidden="true" />
        <span v-else class="topbar__status-dot" aria-hidden="true" />
        <span class="topbar__status-text">{{ isGenerating ? $t('layout.topbar.statusGenerating') : $t('layout.topbar.statusIdle') }}</span>
      </span>
    </div>

    <!-- ── Right: actions ── -->
    <div class="topbar__right">
      <!--
        Session mode badge + toggle (Story 9 v2): play ⇄ worldBuilding. Hidden
        until a save slot is active. A LABELED pill (not an icon) so the current
        mode is unmistakable on every panel; clicking toggles. Renders the shared
        SessionModeBadge — the exact same visual the card-writing guide uses, so
        the persistent indicator and the guide read as one system (PM P-A 联动).
        Explanatory mode hint routed through the unified Tooltip primitive (§8.1).
      -->
      <Tooltip
        v-if="engineState.activeSlotId"
        :text="isWorldBuilding ? $t('layout.topbar.modeToggleWorldBuildingTooltip') : $t('layout.topbar.modeTogglePlayTooltip')"
        interactive
      >
        <button
          class="topbar__mode-toggle"
          data-testid="mode-toggle"
          :aria-label="$t('layout.topbar.modeToggleAria')"
          :aria-pressed="isWorldBuilding"
          :disabled="isModePersisting"
          @click="handleModeToggle"
        >
          <SessionModeBadge :mode="isWorldBuilding ? 'worldBuilding' : 'play'" size="sm" />
        </button>
      </Tooltip>

      <!-- Fullscreen toggle -->
      <Tooltip
        :text="isFullscreen ? $t('layout.topbar.ariaExitFullscreen') : $t('layout.topbar.ariaEnterFullscreen')"
        interactive
      >
        <button
          class="topbar__btn"
          :aria-label="isFullscreen ? $t('layout.topbar.ariaExitFullscreen') : $t('layout.topbar.ariaEnterFullscreen')"
          @click="toggleFullscreen"
        >
          <!-- Enter fullscreen icon -->
          <svg v-if="!isFullscreen" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path d="M3 3h5v2H5v3H3V3zm9 0h5v5h-2V5h-3V3zM3 12h2v3h3v2H3v-5zm12 3h-3v2h5v-5h-2v3z" />
          </svg>
          <!-- Exit fullscreen icon -->
          <svg v-else viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path d="M3 8h2V5h3V3H3v5zm9-5v2h3v3h2V3h-5zM3 12v5h5v-2H5v-3H3zm12 3h-3v2h5v-5h-2v3z" />
          </svg>
        </button>
      </Tooltip>

      <!-- Quick save -->
      <Tooltip :text="$t('layout.topbar.ariaQuickSave')" interactive>
        <button
          class="topbar__btn"
          :class="{ 'topbar__btn--saving': isSaving }"
          :aria-label="$t('layout.topbar.ariaQuickSave')"
          :disabled="isSaving"
          @click="handleQuickSave"
        >
          <svg v-if="!isSaving" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path d="M5.5 2A1.5 1.5 0 004 3.5v13A1.5 1.5 0 005.5 18h9a1.5 1.5 0 001.5-1.5V6.621a1.5 1.5 0 00-.44-1.06l-3.12-3.122A1.5 1.5 0 0011.378 2H5.5zM10 12a2 2 0 100-4 2 2 0 000 4z" />
          </svg>
          <svg v-else class="topbar__spin" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
          </svg>
        </button>
      </Tooltip>

      <!-- Settings gear -->
      <Tooltip :text="$t('layout.topbar.ariaSettings')" interactive>
        <button
          class="topbar__btn"
          :aria-label="$t('layout.topbar.ariaSettings')"
          @click="navigateSettings"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
          </svg>
        </button>
      </Tooltip>
    </div>
  </header>

  <!-- Exit dialog -->
  <Modal v-model="exitModalOpen" :title="$t('layout.topbar.exitModalTitle')" width="360px" :closable="!exitIsSaving">
    <p class="exit-msg">{{ $t('layout.topbar.exitConfirmMessage') }}</p>
    <p v-if="exitSaveError" class="exit-err">{{ exitSaveError }}</p>
    <template #footer>
      <button class="btn btn--secondary" :disabled="exitIsSaving" @click="exitModalOpen = false">{{ $t('layout.topbar.exitCancel') }}</button>
      <button class="btn btn--danger" :disabled="exitIsSaving" @click="handleDiscardExit">
        {{ exitSaveError ? $t('layout.topbar.exitIgnoreError') : $t('layout.topbar.exitDiscard') }}
      </button>
      <button v-if="!exitSaveError" class="btn btn--primary" :disabled="exitIsSaving" @click="handleSaveAndExit">
        <span v-if="exitIsSaving" class="btn-spinner" />
        {{ exitIsSaving ? $t('layout.topbar.savingInProgress') : $t('layout.topbar.saveAndExit') }}
      </button>
      <button v-else class="btn btn--primary" @click="handleSaveAndExit">{{ $t('layout.topbar.retrySave') }}</button>
    </template>
  </Modal>
</template>

<script setup lang="ts">
// App doc: docs/user-guide/pages/game-overview.md §4.0.1
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { eventBus } from '@/engine/core/event-bus';
import Modal from '@/ui/components/common/Modal.vue';
import SessionModeBadge from '@/ui/components/shared/SessionModeBadge.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useSessionMode } from '@/ui/composables/useSessionMode';
import type { GameStateTree } from '@/engine/types';

const router = useRouter();
const { t } = useI18n();
const engineState = useEngineStateStore();
const saveManager = injectService('saveManager');

// Story 9 — session mode toggle (play ⇄ worldBuilding). Persisted per-slot via composable.
const { isWorldBuilding, isPersisting: isModePersisting, toggle: toggleSessionMode } = useSessionMode();
async function handleModeToggle(): Promise<void> {
  try {
    await toggleSessionMode();
  } catch {
    /* persistence failure toast already emitted by useSessionMode */
  }
}

const isSaving = ref(false);
const isGenerating = ref(false);
const isFullscreen = ref(false);

// ── Exit dialog ───────────────────────────────────────────────────
const exitModalOpen = ref(false);
const exitIsSaving = ref(false);
const exitSaveError = ref('');

/** Show only the innermost location segment to keep the bar compact */
const locationShort = computed(() => {
  const loc = engineState.currentLocation;
  if (!loc || loc === '未知') return '';
  const parts = loc.split('·');
  return parts[parts.length - 1].trim();
});

const localizedGameTime = computed(() => {
  const year = engineState.get<number>('世界.时间.年') ?? 0;
  const month = engineState.get<number>('世界.时间.月') ?? 0;
  const day = engineState.get<number>('世界.时间.日') ?? 0;
  if (!year && !month && !day) return '';
  const hour = engineState.get<number>('世界.时间.小时') ?? null;
  const minute = engineState.get<number>('世界.时间.分钟') ?? null;
  const timePart = (hour !== null && minute !== null)
    ? ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : '';
  return timePart
    ? t('layout.topbar.gameTime', { year, month, day, time: timePart })
    : t('layout.topbar.gameTimeNoTime', { year, month, day });
});

const hasGameTime = computed(() => localizedGameTime.value !== '');

const displayPackName = computed(() =>
  engineState.packName === '未知游戏包' ? t('common.fallback.unknownPack') : engineState.packName,
);

const displayCharacterName = computed(() =>
  engineState.characterName === '未命名角色' ? t('common.fallback.unnamedCharacter') : engineState.characterName,
);

// ── Generation status via event bus ──────────────────────────────
function onGenerationStart() { isGenerating.value = true; }
function onGenerationEnd() { isGenerating.value = false; }

// ── Fullscreen ───────────────────────────────────────────────────
function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
}

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {/* ignore permission errors */});
  } else {
    document.exitFullscreen().catch(() => {/* ignore */});
  }
}

// ── Lifecycle ────────────────────────────────────────────────────
onMounted(() => {
  eventBus.on('engine:round-start', onGenerationStart);
  eventBus.on('engine:round-complete', onGenerationEnd);
  eventBus.on('ai:error', onGenerationEnd);
  eventBus.on('ai:retrying', onGenerationStart);
  eventBus.on('engine:sub-pipelines-done', onGenerationEnd);
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onUnmounted(() => {
  eventBus.off('engine:round-start', onGenerationStart);
  eventBus.off('engine:round-complete', onGenerationEnd);
  eventBus.off('ai:error', onGenerationEnd);
  eventBus.off('ai:retrying', onGenerationStart);
  eventBus.off('engine:sub-pipelines-done', onGenerationEnd);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});

// ── Navigation ───────────────────────────────────────────────────
function navigateHome(): void {
  exitSaveError.value = '';
  exitModalOpen.value = true;
}

async function handleSaveAndExit(): Promise<void> {
  if (exitIsSaving.value) return;
  exitIsSaving.value = true;
  exitSaveError.value = '';
  try {
    const profileId = engineState.activeProfileId;
    const slotId = engineState.activeSlotId;
    if (saveManager && profileId && slotId) {
      const snapshot = engineState.toSnapshot() as GameStateTree;
      await saveManager.saveGame(profileId, slotId, snapshot);
    }
    exitModalOpen.value = false;
    router.push('/');
  } catch (err) {
    console.error('[TopBar] Save before exit failed:', err);
    exitSaveError.value = err instanceof Error ? err.message : t('layout.topbar.saveFailedRetry');
  } finally {
    exitIsSaving.value = false;
  }
}

function handleDiscardExit(): void {
  exitModalOpen.value = false;
  router.push('/');
}

function navigateSettings(): void {
  router.push('/game/settings');
}

function handleQuickSave(): void {
  if (isSaving.value) return;
  isSaving.value = true;

  // 等待引擎侧回调而非立即报告成功；设置 3s 超时兜底
  const cleanup = (success: boolean, msg: string, errMsg?: string) => {
    isSaving.value = false;
    if (success) {
      eventBus.emit('ui:toast', { type: 'success', message: msg, duration: 2000 });
    } else {
      eventBus.emit('ui:toast', { type: 'error', message: errMsg ?? msg });
    }
  };

  // One-shot listeners for save result
  let resolved = false;
  const offComplete = eventBus.on('engine:save-complete', () => {
    if (resolved) return;
    resolved = true;
    offComplete();
    offError();
    cleanup(true, t('layout.topbar.quickSaveSuccess'));
  });
  const offError = eventBus.on('engine:save-error', (payload: unknown) => {
    if (resolved) return;
    resolved = true;
    offComplete();
    offError();
    const msg = (payload as { error?: string })?.error ?? t('layout.topbar.saveFailed');
    cleanup(false, msg);
  });
  // 3s fallback — if neither event fires (e.g. no active slot), release loading state
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      offComplete();
      offError();
      isSaving.value = false;
    }
  }, 3000);

  eventBus.emit('engine:request-save', {
    profileId: engineState.activeProfileId,
    slotId: engineState.activeSlotId,
  });
}
</script>

<style scoped>
/*
 * TopBar — sanctuary migration (Phase 2.2, 2026-04-20).
 * Scoped style only; template + <script setup> untouched.
 *
 * Brand title in literary serif, character name beside in warm secondary.
 * AI-status pill uses the approved glass exception (the 4th glass surface
 * per memory project_modal_and_list_design) — LED under frosted glass,
 * sage when generating, amber when completing.
 */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  /*
   * Static 12px padding — topbar does NOT need dynamic sidebar reserves
   * because the floating sidebars start at `top: 12px` of the body area
   * (i.e. BELOW the topbar) and never vertically overlap it.
   * Correction 2026-04-20: removed an incorrect dynamic padding that
   * uselessly shifted topbar icons when sidebars toggled.
   */
  padding: 0 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  z-index: 100;
  gap: 8px;
}

/* ── Left region ── */
.topbar__left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-shrink: 0;
}

.topbar__title-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-family: var(--font-serif-cjk);
}

.topbar__game-title {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 500;
  color: var(--color-text);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar__character-name {
  font-size: 0.78rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Center region ── */
.topbar__center {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
}

.topbar__info-item {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.topbar__info-text {
  font-size: 0.76rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar__location svg,
.topbar__time svg {
  color: var(--color-text-umber);
  opacity: 0.7;
  flex-shrink: 0;
}

.topbar__sep {
  font-size: 0.72rem;
  color: var(--color-text-muted);
  opacity: 0.5;
  flex-shrink: 0;
  user-select: none;
}

/*
 * AI status badge — THE 4th-class glass exception per project_glass_policy
 * memo. Frosted pill, sage ring idle, sage-pulse when generating.
 */
.topbar__status-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 999px;
  flex-shrink: 0;
  background: color-mix(in oklch, var(--color-surface) 70%, transparent);
  backdrop-filter: blur(8px) saturate(0.9);
  -webkit-backdrop-filter: blur(8px) saturate(0.9);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  transition: box-shadow var(--duration-normal) var(--ease-out),
              color var(--duration-normal) var(--ease-out);
  margin-left: 4px;
}

.topbar__status-badge--idle {
  /* uses default sage ring */
}

.topbar__status-badge--generating {
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 45%, transparent);
}

.topbar__status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
  flex-shrink: 0;
  transition: background var(--duration-normal) var(--ease-out),
              box-shadow var(--duration-normal) var(--ease-out);
}

.topbar__status-badge--generating .topbar__status-dot {
  background: var(--color-sage-400);
  box-shadow:
    0 0 8px color-mix(in oklch, var(--color-sage-400) 45%, transparent),
    0 0 12px color-mix(in oklch, var(--color-sage-400) 20%, transparent);
}

.topbar__status-dot--pulse {
  animation: topbar-pulse var(--duration-breath) ease-in-out infinite;
}

@keyframes topbar-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(0.75); }
}

.topbar__status-text {
  font-size: 0.74rem;
  font-weight: 500;
}

.topbar__status-badge--idle .topbar__status-text {
  color: var(--color-text-secondary);
}

.topbar__status-badge--generating .topbar__status-text {
  color: var(--color-sage-400);
}

/* ── Right region ── */
.topbar__right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/* ── Shared button style ── */
.topbar__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out);
}
@media (hover: hover) {
  .topbar__btn:hover:not(:disabled) {
    color: var(--color-sage-400);
    background: linear-gradient(180deg,
      color-mix(in oklch, var(--color-sage-400) 8%, transparent),
      color-mix(in oklch, var(--color-sage-400) 4%, transparent));
  }
}
@media (hover: none) and (pointer: coarse) {
  .topbar__btn:active:not(:disabled) {
    color: var(--color-sage-400);
    background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
  }
}
.topbar__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.topbar__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.topbar__back {
  margin-left: -4px;
}

/* ── Exit dialog ── */
.exit-msg {
  margin: 0;
  font-size: 0.9rem;
  color: var(--color-text);
  line-height: 1.5;
}

.exit-err {
  margin: 8px 0 0;
  font-size: 0.85rem;
  color: oklch(0.82 0.09 30);
  line-height: 1.4;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 0.86rem;
  font-weight: 500;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: background var(--duration-normal) var(--ease-out),
              border-color var(--duration-normal) var(--ease-out),
              color var(--duration-normal) var(--ease-out);
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn--primary  { background: var(--color-sage-400); color: var(--color-bg); font-weight: 600; }
@media (hover: hover) {
  .btn--primary:not(:disabled):hover { background: var(--color-sage-300); }
}
.btn--secondary {
  background: transparent;
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}
@media (hover: hover) {
  .btn--secondary:not(:disabled):hover {
    color: var(--color-text);
    background: var(--color-surface-elevated);
  }
}
@media (hover: none) and (pointer: coarse) {
  .btn--secondary:not(:disabled):active {
    color: var(--color-text);
    background: var(--color-surface-elevated);
  }
}
.btn--danger   { background: var(--color-danger); color: var(--color-text); }
@media (hover: hover) {
  .btn--danger:not(:disabled):hover { filter: brightness(1.12); }
}
@media (hover: none) and (pointer: coarse) {
  .btn--danger:not(:disabled):active { filter: brightness(1.12); }
}

.btn-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in oklch, var(--color-text) 25%, transparent);
  border-top-color: var(--color-text);
  border-radius: 50%;
  animation: topbar-spin 1s linear infinite;
  flex-shrink: 0;
}

.topbar__btn--saving {
  color: var(--color-sage-400);
}

/*
 * Story 9 v2 — session mode toggle is a LABELED pill (wraps SessionModeBadge),
 * not a square icon button. Transparent wrapper; the badge supplies the colour
 * so the writing-mode beacon is unmistakable on every panel.
 */
.topbar__mode-toggle {
  display: inline-flex;
  align-items: center;
  padding: 0;
  margin-right: 2px;
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: opacity var(--duration-normal) var(--ease-out);
}
@media (hover: hover) {
  .topbar__mode-toggle:hover:not(:disabled) { opacity: 0.85; }
}
.topbar__mode-toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.topbar__mode-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

/*
 * Writing-mode global cue: the top bar's bottom edge turns sage so EVERY panel
 * (the bar is always visible) carries a quiet "you are authoring" signal,
 * reinforcing the lit badge. Resolves the v1 "mode is invisible on most panels".
 */
.topbar--writing {
  border-bottom-color: color-mix(in oklch, var(--color-sage-400) 55%, transparent);
  box-shadow: 0 1px 0 color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}

.topbar__spin {
  animation: topbar-spin 1.2s linear infinite;
  filter: drop-shadow(0 0 4px color-mix(in oklch, var(--color-sage-400) 35%, transparent));
  will-change: transform;
}

@keyframes topbar-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Responsive ── */
@media (max-width: 900px) {
  .topbar__center {
    display: none;
  }
}

@media (max-width: 640px) {
  .topbar {
    padding: 0 8px;
    height: 48px;
  }
  .topbar__character-name {
    display: none;
  }
}

/* ─── Mobile: enlarge touch targets (641-767px range) ─── */
@media (min-width: 641px) and (max-width: 767px) {
  .topbar {
    padding: 0 var(--space-sm);
  }
}
@media (max-width: 767px) {
  .topbar__btn {
    width: 44px;
    height: 44px;
  }
}
</style>
