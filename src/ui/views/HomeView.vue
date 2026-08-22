<script setup lang="ts">
// App doc: docs/user-guide/pages/home.md
/**
 * HomeView — Application entry screen.
 *
 * Responsibilities:
 * 1. Display the 众生 Sonder brand and the active Game Pack information
 * 2. Offer three primary actions: New Character, Continue Game, Manage Saves
 * 3. List recently played profiles (sourced from ProfileManager) so the
 *    user can jump back into a previous session with one click
 *
 * "Continue Game" loads the most recent save (by lastSavedAt) and navigates
 * to /game. Clicking a specific profile entry loads that profile's active
 * save slot and navigates similarly.
 *
 * Dependencies injected via Vue provide/inject:
 *   - 'profileManager' → ProfileManager (persistence layer)
 *   - 'saveManager'     → SaveManager    (state tree persistence)
 *   - 'gamePack'        → GamePack       (active game pack metadata)
 *
 * The engine state store is used to push the loaded state tree into the
 * reactive layer before navigating to the game view.
 */
import { ref, computed, onMounted, inject } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ProfileManager } from '@/engine/persistence/profile-manager';
import type { SaveManager } from '@/engine/persistence/save-manager';
import type { GamePack, GamePackManifest } from '@/engine/types/game-pack';
import type { ProfileMeta, SaveSlotMeta } from '@/engine/types/persistence';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import Modal from '@/ui/components/common/Modal.vue';
import APIPanel from '@/ui/components/panels/APIPanel.vue';
import SettingsPanel from '@/ui/components/panels/SettingsPanel.vue';
import CardImportFlow from '@/ui/components/panels/CardImportFlow.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import type { GitHubSyncService, SyncStatus, CloudFormat } from '@/engine/sync/github-sync';
import CloudSlotsSection from '@/ui/components/cloud/CloudSlotsSection.vue';
import { eventBus } from '@/engine/core/event-bus';
import { useLocale } from '@/ui/composables/useLocale';
import { useCloudAutoSyncToggle } from '@/ui/composables/useCloudAutoSyncToggle';

const router = useRouter();
const { t } = useI18n();
const { formatRelativeTime, formatDateTime } = useLocale();
const engineState = useEngineStateStore();

const profileManager = inject<ProfileManager>('profileManager');
const saveManager = inject<SaveManager>('saveManager');
const gamePack = inject<GamePack>('gamePack');

// ─── Reactive data ────────────────────────────────────────────

/** All profiles fetched from the persistence layer */
const profiles = ref<ProfileMeta[]>([]);

/** Loading state for async save operations (prevents double-clicks) */
const isLoading = ref(false);

/** Error message surfaced to the user when a load operation fails */
const loadError = ref<string | null>(null);

/**
 * 2026-04-11：HomeView 内嵌 API/设置 modal 开关
 *
 * 玩家在游戏启动前还没有办法进入 /game/api 或 /game/settings（这些路由都在
 * GameView 下），但玩家又必须先配置 API 才能开局。所以在 HomeView 直接以
 * modal 形式打开 APIPanel / SettingsPanel —— 两个组件本身不强依赖 engine
 * 状态树（APIPanel 纯 localStorage；SettingsPanel 的状态树相关 section 已用
 * `v-if="isLoaded"` 自行隐藏，模态里只显示外观/数据管理等 localStorage 部分）。
 */
const showApiModal = ref(false);
const showSettingsModal = ref(false);
const showImportCard = ref(false);

/** Re-list profiles so a freshly-imported save appears immediately (Story 6 SC-UI-A). */
function onCardImported(): void {
  if (profileManager) profiles.value = profileManager.listProfiles();
}

// ─── Computed helpers ─────────────────────────────────────────

/** Pack display info — falls back to sensible defaults when no pack is loaded */
const packInfo = computed(() => {
  if (!gamePack?.manifest) {
    return { name: 'Sonder', version: '', description: 'AI Narrative Engine' };
  }
  const m: GamePackManifest = gamePack.manifest;
  return {
    name: m.name ?? m.id ?? 'Sonder',
    version: m.version ?? '',
    description: m.description ?? 'AI Narrative Engine',
  };
});

/**
 * Profiles sorted by most-recently-played first.
 * "Most recent" is determined by the latest lastSavedAt across all slots.
 */
const sortedProfiles = computed(() => {
  return [...profiles.value].sort((a, b) => {
    const latestA = getLatestSaveTime(a);
    const latestB = getLatestSaveTime(b);
    return latestB - latestA;
  });
});

/** Whether there's at least one profile with a saved game to continue */
const canContinue = computed(() => {
  return sortedProfiles.value.some((p) => {
    return Object.values(p.slots).some((s) => s.lastSavedAt !== null);
  });
});

// ─── Helpers ──────────────────────────────────────────────────

/** Extract the most recent save timestamp (as epoch ms) from a profile */
function getLatestSaveTime(profile: ProfileMeta): number {
  let latest = 0;
  for (const slot of Object.values(profile.slots)) {
    if (slot.lastSavedAt) {
      const ts = new Date(slot.lastSavedAt).getTime();
      if (ts > latest) latest = ts;
    }
  }
  return latest;
}

/** Find the save slot with the most recent lastSavedAt */
function getMostRecentSlot(profile: ProfileMeta): SaveSlotMeta | null {
  let best: SaveSlotMeta | null = null;
  let bestTs = 0;
  for (const slot of Object.values(profile.slots)) {
    if (slot.lastSavedAt) {
      const ts = new Date(slot.lastSavedAt).getTime();
      if (ts > bestTs) {
        bestTs = ts;
        best = slot;
      }
    }
  }
  return best;
}

/** Format an ISO date string to a user-friendly relative/absolute display */
function formatDate(iso: string | null): string {
  if (!iso) return t('common.time.neverSaved');
  return formatRelativeTime(iso);
}

// ─── Actions ──────────────────────────────────────────────────

function goToCreation(): void {
  router.push('/creation');
}

function goToManagement(): void {
  router.push('/management');
}

/**
 * "Continue Game" — loads the most recent save across all profiles
 * and navigates to the game view. If no saves exist, this is a no-op
 * (the button is disabled via canContinue).
 */
async function continueGame(): Promise<void> {
  if (!profileManager || !saveManager) return;
  if (isLoading.value) return;

  const allProfiles = sortedProfiles.value;
  for (const profile of allProfiles) {
    const slot = getMostRecentSlot(profile);
    if (slot) {
      await loadProfileSlot(profile, slot);
      return;
    }
  }
}

/**
 * Load a specific profile's save slot into the engine state store,
 * then navigate to the game view.
 */
async function loadProfileSlot(
  profile: ProfileMeta,
  slot: SaveSlotMeta,
): Promise<void> {
  if (!saveManager || !profileManager) return;
  if (isLoading.value) return;

  isLoading.value = true;
  loadError.value = null;

  try {
    const stateTree = await saveManager.loadGame(profile.profileId, slot.slotId);
    if (!stateTree) {
      loadError.value = t('home.errors.saveCorrupted');
      return;
    }

    await profileManager.setActiveProfile(profile.profileId, slot.slotId);
    engineState.loadGame(stateTree, profile.packId, profile.profileId, slot.slotId);
    router.push('/game');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loadError.value = t('home.errors.loadFailed', { error: msg });
    console.error('[HomeView] Failed to load save:', err);
  } finally {
    isLoading.value = false;
  }
}

/**
 * Click handler for a profile card — loads the profile's active slot
 * (or most recent slot as fallback).
 */
async function onProfileClick(profile: ProfileMeta): Promise<void> {
  const slotId = profile.activeSlotId;
  const slot = slotId
    ? profile.slots[slotId]
    : getMostRecentSlot(profile);

  if (!slot) {
    loadError.value = t('home.errors.noSaveForCharacter');
    return;
  }

  await loadProfileSlot(profile, slot);
}

// ─── Lifecycle ────────────────────────────────────────────────

/**
 * 全量备份导入后的自动恢复钩子
 *
 * 用户点"恢复完整备份"成功后，SavePanel.executeImport 会设置
 * sessionStorage['aga_post_import_resume']='1' 并 reload 页面。
 * 刷新后路由会回到 HomeView（因为引擎状态未加载），此处检测到标志：
 *   1. 读取 ProfileManager 刚刚从 IDB 加载的 activeProfile 根指针
 *   2. 查找对应 profile + slot 对象
 *   3. 模拟用户点击"继续游戏"，直接加载该 slot 并跳转到 /game
 *   4. 清除 sessionStorage 标志（防止下次无关刷新又触发）
 *
 * 若备份不含 activeProfile 或对应 slot 已失效 → 静默回退到正常 Home 页面
 */
async function tryAutoResumeAfterImport(): Promise<void> {
  if (sessionStorage.getItem('aga_post_import_resume') !== '1') return;
  sessionStorage.removeItem('aga_post_import_resume');

  if (!profileManager) return;
  const root = profileManager.getRoot();
  const activeRef = root.activeProfile;
  if (!activeRef) return;

  const profile = profileManager.getProfile(activeRef.profileId);
  if (!profile) return;
  const slot = profile.slots[activeRef.slotId];
  if (!slot) return;

  await loadProfileSlot(profile, slot);
}

// ─── GitHub Cloud Sync ───────────────────────────────────────

const githubSync = inject<GitHubSyncService>('githubSync');
const showSyncModal = ref(false);
const ghToken = ref(githubSync?.getToken() ?? '');
const ghRepoName = ref(githubSync?.getRepoName() ?? 'aga-cloud-save');
const ghStatus = ref<SyncStatus>({ stage: 'idle', message: '' });
const ghConnected = ref(false);
const ghOwner = ref('');
const ghCloudInfo = ref<{ exists: boolean; updatedAt?: string; sizeKB?: number } | null>(null);
const ghShowToken = ref(false);

function ghCopyToken(): void {
  const token = githubSync?.getToken() ?? ghToken.value;
  if (!token.trim()) return;
  const ta = document.createElement('textarea');
  ta.value = token;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  eventBus.emit('ui:toast', { type: 'success', message: t('home.github.tokenCopied'), duration: 1200 });
}

const ghEditingRepo = ref(false);
const ghBusy = () => ['checking', 'uploading', 'downloading'].includes(ghStatus.value.stage);

// 云端格式（CloudSlotsSection 探测上报）：v3/empty → 插槽列表接管下载动作
const ghCloudFormat = ref<CloudFormat | 'unknown'>('unknown');
const ghClassicVisible = computed(() => ghCloudFormat.value === 'v2' || ghCloudFormat.value === 'unknown');

async function ghSwitchRepo(): Promise<void> {
  if (!githubSync || ghBusy()) return;
  githubSync.setRepoName(ghRepoName.value);
  ghEditingRepo.value = false;
  ghCloudInfo.value = null;
  ghStatus.value = { stage: 'checking', message: t('home.github.checkingRepo') };
  const result = await githubSync.validate();
  if (result.ok) {
    ghStatus.value = { stage: 'idle', message: '' };
    try { ghCloudInfo.value = await githubSync.getCloudInfo(); } catch { ghCloudInfo.value = null; }
  } else {
    ghStatus.value = { stage: 'error', message: result.error ?? t('home.github.repoInaccessible') };
  }
}

async function ghConnect(): Promise<void> {
  if (!githubSync || !ghToken.value.trim()) return;
  githubSync.setToken(ghToken.value);
  githubSync.setRepoName(ghRepoName.value);
  ghStatus.value = { stage: 'checking', message: t('home.github.verifyingConnection') };
  const result = await githubSync.validate();
  if (result.ok) {
    ghConnected.value = true;
    ghOwner.value = githubSync.getOwner();
    ghStatus.value = { stage: 'idle', message: '' };
    try { ghCloudInfo.value = await githubSync.getCloudInfo(); } catch { ghCloudInfo.value = null; }
  } else {
    ghStatus.value = { stage: 'error', message: result.error ?? t('home.github.connectionFailed') };
  }
}

async function ghDownloadToLocal(): Promise<void> {
  if (!githubSync || ghBusy()) return;
  try {
    await githubSync.download((s) => { ghStatus.value = s; });
    sessionStorage.setItem('aga_post_import_resume', '1');
    eventBus.emit('ui:toast', { type: 'success', message: t('home.github.restoreSuccess'), duration: 2000 });
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    ghStatus.value = { stage: 'error', message: err instanceof Error ? err.message : t('home.github.downloadFailed') };
  }
}

// Auto-connect on mount if previously configured
if (githubSync?.isConfigured()) {
  void (async () => {
    const result = await githubSync.validate();
    if (result.ok) {
      ghConnected.value = true;
      ghOwner.value = githubSync.getOwner();
      try { ghCloudInfo.value = await githubSync.getCloudInfo(); } catch { /* */ }
    }
  })();
}

// ── GitHub auto cloud-sync toggle (shared composable; engine runs in CloudSyncManager.vue) ──
const {
  autoSyncOn: ghAutoSync,
  lastSynced: ghLastSync,
  toggle: ghToggleAutoSync,
} = useCloudAutoSyncToggle(githubSync);

onMounted(async () => {
  if (profileManager) {
    profiles.value = profileManager.listProfiles();
  }
  // 若刚完成全量导入 → 自动继续到活跃游戏
  await tryAutoResumeAfterImport();
});
</script>

<template>
  <div class="home-view">
    <!-- Brand header — 众生 Sonder bilingual lockup (the 众-mark: 众 = three 人) -->
    <header class="home-header">
      <svg class="brand-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M15 19 L24 7 L33 19" class="brand-mark__lit" />
        <path d="M4.5 41 L13.5 29 L22.5 41" class="brand-mark__many" />
        <path d="M25.5 41 L34.5 29 L43.5 41" class="brand-mark__many" />
      </svg>
      <h1 class="brand-title">众生</h1>
      <p class="brand-latin" aria-hidden="true">Sonder</p>
      <p class="brand-tagline">{{ $t('home.brand.tagline') }}</p>
      <Tooltip v-if="packInfo.version" :text="packInfo.description">
        <div class="pack-badge">
          <span class="pack-name">{{ packInfo.name }}</span>
          <span class="pack-version">v{{ packInfo.version }}</span>
        </div>
      </Tooltip>
    </header>

    <!-- Primary action buttons -->
    <nav class="actions" :aria-label="$t('home.nav.primaryActions')">
      <button class="btn btn-primary" @click="goToCreation" :disabled="isLoading">
        {{ $t('home.buttons.newCharacter') }}
      </button>
      <button
        class="btn btn-accent"
        :disabled="!canContinue || isLoading"
        @click="continueGame"
      >
        {{ $t('home.buttons.continueGame') }}
      </button>
      <button class="btn btn-secondary" @click="goToManagement" :disabled="isLoading">
        {{ $t('home.buttons.manageSaves') }}
      </button>
      <button class="btn btn-secondary" @click="showImportCard = true" :disabled="isLoading">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
        </svg>
        {{ $t('home.buttons.importCard') }}
      </button>
    </nav>

    <!--
      2026-04-11：开局前配置入口 —— 首次使用时玩家必须先配置 API 才能开局，
      所以在 HomeView 提供直接入口。二级操作行，视觉上从属于主操作但常驻可见。
    -->
    <nav class="actions actions--secondary" :aria-label="$t('home.nav.configActions')">
      <button class="btn btn-ghost" @click="showApiModal = true" :disabled="isLoading">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
        {{ $t('home.buttons.apiConfig') }}
      </button>
      <button class="btn btn-ghost" @click="showSettingsModal = true" :disabled="isLoading">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
        {{ $t('home.buttons.settings') }}
      </button>
      <button class="btn btn-ghost" @click="showSyncModal = true" :disabled="isLoading">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M8 0a8.2 8.2 0 0 0-2.6.4.75.75 0 0 0 .5 1.42A6.7 6.7 0 0 1 8 1.5a6.5 6.5 0 0 1 0 13 6.7 6.7 0 0 1-2.1-.34.75.75 0 0 0-.5 1.42A8.2 8.2 0 0 0 8 16a8 8 0 1 0 0-16"/>
          <path d="M5.97 4.22a.75.75 0 0 0-1.06 1.06L6.44 6.8H.75a.75.75 0 0 0 0 1.5h5.69L4.91 9.84a.75.75 0 1 0 1.06 1.06l2.75-2.75a.75.75 0 0 0 .22-.53V7.5a.75.75 0 0 0-.22-.53z"/>
        </svg>
        {{ $t('home.buttons.cloudSync') }}
        <span v-if="ghConnected" class="sync-dot" />
      </button>
    </nav>

    <!-- Error banner -->
    <Transition name="fade">
      <div v-if="loadError" class="error-banner" role="alert">
        <span class="error-text">{{ loadError }}</span>
        <button class="error-dismiss" @click="loadError = null" :aria-label="$t('home.buttons.close')">
          &times;
        </button>
      </div>
    </Transition>

    <!-- Loading overlay for save operations -->
    <div v-if="isLoading" class="inline-loading" role="status" :aria-label="$t('home.status.loading')">
      <div class="spinner" aria-hidden="true" />
      <span>{{ $t('home.status.loadingSave') }}</span>
    </div>

    <!-- Recent profiles list -->
    <section v-if="sortedProfiles.length > 0" class="profiles-section">
      <h2 class="section-title">{{ $t('home.sections.recentProfiles') }}</h2>
      <ul class="profile-list">
        <li
          v-for="profile in sortedProfiles"
          :key="profile.profileId"
          class="profile-card"
          tabindex="0"
          role="button"
          :aria-label="$t('home.profileCard.loadAria', { name: profile.characterName })"
          @click="onProfileClick(profile)"
          @keydown.enter="onProfileClick(profile)"
        >
          <!-- Avatar initial -->
          <div class="profile-avatar">
            {{ profile.characterName?.charAt(0) ?? '?' }}
          </div>

          <!-- Profile info -->
          <div class="profile-info">
            <span class="profile-name">{{ profile.characterName }}</span>
            <span class="profile-pack">{{ profile.packId }}</span>
          </div>

          <!-- Save meta (most recent slot) -->
          <div class="profile-meta">
            <span class="profile-time">
              {{ formatDate(getMostRecentSlot(profile)?.lastSavedAt ?? null) }}
            </span>
            <span
              v-if="getMostRecentSlot(profile)?.currentLocation"
              class="profile-location"
            >
              {{ getMostRecentSlot(profile)?.currentLocation }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Empty state when no profiles exist -->
    <section v-else class="empty-state">
      <p class="empty-text">{{ $t('home.emptyState.noProfiles') }}</p>
    </section>

    <!--
      开局前配置 modal：API / 设置
      APIPanel 完全不依赖 engine 状态树（只读 localStorage + aiService），可以无游戏加载。
      SettingsPanel 的状态树依赖 section 已用 `v-if="isLoaded"` 自行隐藏，无游戏时只显示
      外观/数据管理等 localStorage-only 的部分。两者都能在 HomeView 正确渲染。
    -->
    <!--
      两个内嵌面板本身都带 panel-header + 标题，所以这里不给 Modal 传 title
      避免视觉上双重标题。Modal 仍有右上角关闭按钮（closable 默认 true）。
    -->
    <Modal v-model="showApiModal" width="760px">
      <div class="modal-panel-wrap">
        <APIPanel />
      </div>
    </Modal>
    <Modal v-model="showSettingsModal" width="760px">
      <div class="modal-panel-wrap">
        <SettingsPanel />
      </div>
    </Modal>

    <!-- Story 6: Game-card import (self-contained Modal inside) -->
    <CardImportFlow v-model="showImportCard" @imported="onCardImported" />

    <!-- Cloud Sync modal -->
    <Modal v-model="showSyncModal" width="420px">
      <div class="sync-modal">
        <!-- Header -->
        <div class="sync-modal-header">
          <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" class="sync-modal-icon">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <div>
            <h3 class="sync-modal-title">{{ $t('home.cloudSync.title') }}</h3>
            <p class="sync-modal-sub">{{ $t('home.cloudSync.subtitle') }}</p>
          </div>
        </div>

        <!-- Not connected: config form -->
        <template v-if="!ghConnected">
          <div class="sync-form">
            <div class="sync-field">
              <label class="sync-label">Personal Access Token</label>
              <div class="sync-token-row">
                <input
                  :type="ghShowToken ? 'text' : 'password'"
                  class="sync-input sync-input--mono"
                  v-model="ghToken"
                  placeholder="github_pat_..."
                  spellcheck="false"
                  autocomplete="off"
                />
                <Tooltip :text="$t('home.github.toggleVisibility')" interactive>
                  <button class="sync-eye" @click="ghShowToken = !ghShowToken" tabindex="-1">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path v-if="ghShowToken" d="M.143 2.31a.75.75 0 0 1 1.047-.167l14 10a.75.75 0 1 1-.88 1.214l-2.248-1.606A7.4 7.4 0 0 1 8 13C3.353 13 .2 9.2.014 8.436a.8.8 0 0 1 0-.872A10.2 10.2 0 0 1 3.28 4.63L.31 3.357A.75.75 0 0 1 .143 2.31M5.09 5.92A3 3 0 0 0 8.91 10.08z"/><path v-else d="M8 2c4.647 0 7.8 3.8 7.986 4.564a.8.8 0 0 1 0 .872C15.8 8.2 12.647 12 8 12S.2 8.2.014 7.436a.8.8 0 0 1 0-.872C.2 5.8 3.353 2 8 2m0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4"/></svg>
                  </button>
                </Tooltip>
                <Tooltip :text="$t('home.github.copyToken')" interactive>
                  <button class="sync-eye" @click="ghCopyToken()" tabindex="-1" :disabled="!ghToken.trim()">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25z"/></svg>
                  </button>
                </Tooltip>
              </div>
            </div>
            <div class="sync-field">
              <label class="sync-label">{{ $t('home.github.repoNameLabel') }}</label>
              <input class="sync-input" v-model="ghRepoName" placeholder="aga-cloud-save" spellcheck="false" />
            </div>
          </div>
          <p class="sync-footnote">
            {{ $t('home.github.tokenHint') }}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="sync-link">GitHub &rarr;</a>
          </p>
          <button class="sync-connect-btn" @click="ghConnect" :disabled="ghBusy() || !ghToken.trim()">
            <template v-if="ghStatus.stage === 'checking'">
              <span class="sync-spinner" /> {{ $t('home.github.verifying') }}
            </template>
            <template v-else>{{ $t('home.github.connectButton') }}</template>
          </button>
        </template>

        <!-- Connected: sync actions -->
        <template v-else>
          <div class="sync-status-card">
            <div class="sync-status-left">
              <div class="sync-avatar">{{ ghOwner.charAt(0).toUpperCase() }}</div>
              <div class="sync-meta">
                <span class="sync-username">{{ ghOwner }}</span>
                <div class="sync-repo-row">
                  <template v-if="!ghEditingRepo">
                    <span class="sync-reponame">{{ ghRepoName }}</span>
                    <Tooltip :text="$t('home.github.switchRepo')" interactive>
                      <button class="sync-repo-edit" @click="ghEditingRepo = true">
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758z"/></svg>
                      </button>
                    </Tooltip>
                  </template>
                  <template v-else>
                    <input class="sync-repo-input" v-model="ghRepoName" spellcheck="false" @keydown.enter="ghSwitchRepo" />
                    <Tooltip :text="$t('home.github.confirmRepo')" interactive>
                      <button class="sync-repo-confirm" @click="ghSwitchRepo" :disabled="ghBusy()">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0"/></svg>
                      </button>
                    </Tooltip>
                  </template>
                </div>
              </div>
            </div>
            <button class="sync-disconnect" @click="ghConnected = false; ghToken = ''; githubSync?.setToken(''); ghCloudInfo = null">
              {{ $t('home.github.disconnectButton') }}
            </button>
          </div>

          <div class="sync-token-copy-row">
            <span class="sync-token-preview">Token: {{ ghToken.slice(0, 10) }}···{{ ghToken.slice(-4) }}</span>
            <button class="sync-token-copy-btn" @click="ghCopyToken()">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25z"/></svg>
              {{ $t('home.github.copyTokenButton') }}
            </button>
          </div>

          <div class="sync-cloud-card">
            <template v-if="ghCloudInfo?.exists">
              <div class="sync-cloud-label">{{ $t('home.cloudStatus.hasArchive') }}</div>
              <div class="sync-cloud-detail">
                {{ ghCloudInfo.updatedAt ? $t('home.cloudStatus.updatedAt', { date: formatDateTime(ghCloudInfo.updatedAt) }) : $t('home.cloudStatus.unknownTime') }}
                <span class="sync-cloud-size">{{ ghCloudInfo.sizeKB ?? 0 }} KB</span>
              </div>
            </template>
            <template v-else-if="ghCloudInfo">
              <div class="sync-cloud-label">{{ $t('home.cloudStatus.noArchive') }}</div>
              <div class="sync-cloud-detail">{{ $t('home.cloudStatus.uploadToSync') }}</div>
            </template>
            <template v-else>
              <div class="sync-cloud-label">{{ $t('home.cloudStatus.checking') }}</div>
            </template>
          </div>

          <!-- Auto cloud-sync toggle — engine runs app-wide in CloudSyncManager.vue -->
          <div class="sync-autosync">
            <AgaToggle
              :modelValue="ghAutoSync"
              @update:modelValue="ghToggleAutoSync"
              :label="$t('save.autoSyncCloud.toggleLabel')"
              show-label
              data-testid="home-autosync-toggle"
            />
            <span v-if="ghAutoSync && ghLastSync" class="sync-autosync-time">{{ $t('save.autoSyncCloud.lastSynced', { time: ghLastSync }) }}</span>
            <p class="sync-autosync-hint">{{ $t('save.autoSyncCloud.toggleHint') }}</p>
          </div>

          <!-- v3 存档插槽区（插槽列表 / v2 迁移入口），格式上报驱动经典下载按钮显隐 -->
          <CloudSlotsSection @format="(f) => { ghCloudFormat = f; }" />

          <div v-if="ghClassicVisible" class="sync-actions">
            <button class="sync-action sync-action--download" :disabled="ghBusy() || !ghCloudInfo?.exists" @click="ghDownloadToLocal">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14zM7.25 1.75a.75.75 0 0 1 1.5 0v6.69l2.47-2.47a.75.75 0 1 1 1.06 1.06L8.53 10.78a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 1.06-1.06l2.47 2.47z"/></svg>
              {{ ghStatus.stage === 'downloading' ? $t('home.cloudSync.downloading') : $t('home.cloudSync.downloadToLocal') }}
            </button>
          </div>
        </template>

        <!-- Status / error -->
        <p v-if="ghStatus.stage === 'error'" class="sync-error">{{ ghStatus.message }}</p>
        <p v-else-if="!['idle','done'].includes(ghStatus.stage) && ghStatus.message" class="sync-progress">{{ ghStatus.message }}</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/*
 * HomeView layout — sanctuary entry (migrated 2026-04-20 Phase 4.1).
 *
 * Design brief:  .impeccable.md (sanctuary · first exhale).
 * Approved demo: docs/demo/home-view.html.
 * Changelog:     docs/status/ui-migration-changelog.md.
 *
 * Migration scope: scoped-style ONLY. Template and <script setup> are
 * untouched. Every template class name is preserved; every ref / computed
 * / handler / emit / v-if condition is intact. This is a value-swap +
 * literal-replace + additive-animation change — zero logic mutation.
 */
.home-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 2rem 1.5rem;
  gap: 1.5rem;
  background: var(--color-bg);
  overflow-y: auto;
  /* Exhale on arrival — the first frame feels like the cabin door closing. */
  animation: home-exhale var(--duration-slow) var(--ease-out);
}

@keyframes home-exhale {
  from { opacity: 0; transform: scale(0.988); }
  to   { opacity: 1; transform: scale(1); }
}

/* ── Header / branding ── */

.home-header {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

/*
 * Brand lockup — the 众-mark above a bilingual 众生 / SONDER pair.
 * Solid warm-bone + literary serif carries the identity (the old
 * gradient-fill-text ban from .impeccable.md §absolute_bans still holds).
 */
.brand-mark {
  width: 42px;
  height: 42px;
  margin-bottom: 0.35rem;
}

.brand-mark path {
  stroke-width: 5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.brand-mark__lit {
  stroke: var(--color-amber-400);
}

.brand-mark__many {
  stroke: var(--color-sage-400);
  opacity: 0.75;
}

.brand-title {
  font-family: var(--font-serif-cjk);
  font-size: clamp(2.4rem, 4.5vw, 3.1rem);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-indent: 0.14em;
  color: var(--color-text);
  text-shadow: 0 0 40px color-mix(in oklch, var(--color-sage-400) 15%, transparent), 0 0 40px color-mix(in oklch, var(--color-amber-400) 10%, transparent);
}

.brand-latin {
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.6em;
  text-indent: 0.6em;
  text-transform: uppercase;
  color: color-mix(in oklch, var(--color-sage-400) 75%, var(--color-text-secondary));
}

.brand-tagline {
  font-family: var(--font-serif-cjk);
  color: var(--color-text-secondary);
  font-size: 0.95rem;
  margin-top: 0.35rem;
}

.pack-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.8rem;
  background: var(--color-surface);
  border: 1px solid color-mix(in oklch, var(--color-amber-400) 25%, var(--color-border));
  border-radius: 999px;
  font-size: 0.8rem;
}

.pack-name {
  color: var(--color-text);
  font-family: var(--font-serif-cjk);
  font-weight: 500;
}

.pack-version {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 0.74rem;
}

/* ── Action buttons ── */

.actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* 次级操作行（API 配置 / 设置） — 视觉上从属于主操作但常驻可见 */
.actions--secondary {
  gap: 0.5rem;
  margin-top: -0.5rem;
}

.btn {
  padding: 0.65rem 1.8rem;
  border: 1px solid transparent;
  border-radius: 10px;
  font-size: 0.92rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--duration-normal) var(--ease-out),
              border-color var(--duration-normal) var(--ease-out),
              color var(--duration-normal) var(--ease-out),
              opacity var(--duration-normal) var(--ease-out),
              transform var(--duration-fast) var(--ease-out);
  white-space: nowrap;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}

/* Primary — sage "new character": the main action. */
.btn-primary {
  background: var(--color-sage-400);
  color: var(--color-bg);
  font-weight: 600;
}
.btn-primary:hover:not(:disabled) {
  background: var(--color-sage-300);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 20%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

/* Accent — amber "continue game": warm "come back in". */
.btn-accent {
  background: var(--color-amber-400);
  color: var(--color-bg);
  font-weight: 600;
}
.btn-accent:hover:not(:disabled) {
  background: var(--color-amber-300);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-amber-400) 20%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-amber-400) 8%, transparent);
}

.btn-secondary {
  /* inline-flex so the import button's icon + label vertically center with a consistent gap
     (matches the .btn-ghost row); harmless for the text-only "manage saves" button. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  background: var(--color-surface);
  color: var(--color-text);
  border-color: var(--color-border);
}
.btn-secondary:hover:not(:disabled) {
  background: var(--color-surface-elevated);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
}

/* Ghost — tertiary, transparent + tinted border on hover */
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 1.1rem;
  font-size: 0.82rem;
  font-weight: 500;
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.btn-ghost:hover:not(:disabled) {
  color: var(--color-text);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}
.btn-ghost svg {
  opacity: 0.75;
}

/* ── Error banner — warm rust wash ── */

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  background: var(--color-danger-muted);
  border: 1px solid color-mix(in oklch, var(--color-danger) 35%, var(--color-border));
  border-radius: 10px;
  width: 100%;
  max-width: 480px;
}

.error-text {
  flex: 1;
  font-size: 0.85rem;
  color: oklch(0.82 0.09 30); /* brighter rust for readability on the muted bg */
}

.error-dismiss {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 1.3rem;
  cursor: pointer;
  line-height: 1;
  padding: 0 0.25rem;
  transition: color var(--duration-normal) var(--ease-out);
}
.error-dismiss:hover {
  color: var(--color-text);
}

/* ── Inline loading — single breathing sage arc ── */

.inline-loading {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid transparent;
  border-top-color: var(--color-sage-400);
  border-radius: 50%;
  animation: home-spin 1.6s linear infinite;
}

@keyframes home-spin {
  to { transform: rotate(360deg); }
}

/* ── Profiles section ── */

.profiles-section {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  padding-left: 0.15rem;
}

.profile-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

/*
 * Profile card — horizontal row with avatar, name/pack, save meta.
 * Hover/focus: sage tint + sage-muted border. No indigo anywhere.
 */
.profile-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out),
              background-color var(--duration-normal) var(--ease-out),
              box-shadow var(--duration-normal) var(--ease-out);
  box-shadow: var(--lumi-inset-highlight);
}

.profile-card:hover,
.profile-card:focus-visible {
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  background: color-mix(in oklch, var(--color-sage-400) 4%, var(--color-surface));
  outline: none;
  box-shadow: 0 0 12px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.profile-card:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 20%, transparent);
}

/*
 * Avatar — identity, not state. Warm surface + bone text, not sage/indigo.
 * The sage/amber beacons are reserved for actionable / warm-state surfaces.
 */
.profile-avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  font-family: var(--font-serif-cjk);
  font-weight: 500;
  font-size: 1.1rem;
  border-radius: 999px;
}

.profile-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.profile-name {
  font-size: 0.95rem;
  font-weight: 500;
  font-family: var(--font-serif-cjk);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-pack {
  font-size: 0.74rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.profile-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.15rem;
  flex-shrink: 0;
}

.profile-time {
  font-size: 0.76rem;
  color: var(--color-text-secondary);
}

.profile-location {
  font-size: 0.72rem;
  color: var(--color-text-muted);
}

/* ── Empty state ── */

.empty-state {
  text-align: center;
  padding: 2rem;
}

.empty-text {
  font-size: 0.92rem;
  color: var(--color-text-secondary);
  font-family: var(--font-serif-cjk);
  line-height: 1.6;
}

/* ── Transitions (Vue <Transition name="fade">) ── */

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── Responsive ── */

@media (max-width: 767px) {
  .home-view {
    justify-content: flex-start;
    padding-top: 2rem;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .profiles-section {
    max-width: 100%;
    flex-shrink: 0;
  }
  .profile-card {
    word-break: break-word;
  }
  .actions:not(.actions--secondary) {
    flex-direction: column;
    width: 100%;
    max-width: 340px;
  }
  .actions:not(.actions--secondary) .btn {
    width: 100%;
    text-align: center;
  }
  .modal-panel-wrap {
    height: calc(100dvh - 120px);
  }
}

@media (max-width: 480px) {
  .brand-title {
    font-size: 1.9rem;
  }
  .actions {
    max-width: 320px;
  }
}

/* ── Panel-in-modal override ──
   SettingsPanel/APIPanel use `position: absolute; inset: 0` for the game layout.
   Inside a modal we need them to flow normally instead. */
.modal-panel-wrap {
  position: relative;
  height: 70vh;
}
.modal-panel-wrap :deep(.settings-panel),
.modal-panel-wrap :deep(.api-panel) {
  position: absolute;
  inset: 0;
  padding-left: 0;
  padding-right: 0;
}

/* ── Cloud Sync ── */
.sync-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-sage-400);
  margin-left: 2px;
  vertical-align: middle;
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-sage-400) 50%, transparent);
}
.sync-modal {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sync-modal-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sync-modal-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.sync-modal-title {
  font-family: var(--font-serif-cjk);
  font-size: 1.15rem;
  font-weight: 500;
  color: var(--color-text);
  margin: 0;
}
.sync-modal-sub {
  font-size: 0.78rem;
  color: var(--color-text-muted);
  margin: 2px 0 0;
}
.sync-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sync-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-label {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--color-text-muted);
  letter-spacing: 0.03em;
}
.sync-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 0.82rem;
  color: var(--color-text);
  outline: none;
  transition: border-color var(--duration-normal) var(--ease-out);
}
.sync-input:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, var(--color-border));
}
.sync-input--mono { font-family: var(--font-mono); font-size: 0.78rem; }
.sync-token-row {
  display: flex;
  gap: 4px;
}
.sync-token-row .sync-input { flex: 1; }
.sync-eye {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out), color var(--duration-normal) var(--ease-out);
}
.sync-eye:hover { border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border)); color: var(--color-text-secondary); }
.sync-footnote {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  line-height: 1.6;
  margin: 0;
}
.sync-link {
  color: var(--color-sage-400);
  text-decoration: none;
}
.sync-link:hover { text-decoration: underline; }
.sync-connect-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px;
  border-radius: 10px;
  border: none;
  background: var(--color-sage-400);
  color: var(--color-bg);
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--duration-normal) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.sync-connect-btn:hover:not(:disabled) { background: var(--color-sage-300); box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-400) 18%, transparent); }
.sync-connect-btn:active:not(:disabled) { transform: scale(0.98); }
.sync-connect-btn:disabled { opacity: 0.4; cursor: default; }

/* Connected state */
.sync-status-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: var(--lumi-inset-highlight);
}
.sync-status-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sync-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: color-mix(in oklch, var(--color-sage-400) 15%, var(--color-surface));
  color: var(--color-sage-400);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-serif-cjk);
  font-size: 0.9rem;
  font-weight: 600;
}
.sync-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sync-username {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-text);
}
.sync-reponame {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}
.sync-repo-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sync-repo-edit {
  display: flex;
  align-items: center;
  padding: 2px;
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: color var(--duration-normal) var(--ease-out);
}
.sync-repo-edit:hover { color: var(--color-text-secondary); }
.sync-repo-input {
  width: 130px;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  background: var(--color-bg);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  border-radius: 5px;
  color: var(--color-text);
  outline: none;
}
.sync-repo-confirm {
  display: flex;
  align-items: center;
  padding: 3px;
  background: none;
  border: none;
  color: var(--color-sage-400);
  cursor: pointer;
  border-radius: 4px;
  transition: color var(--duration-normal) var(--ease-out);
}
.sync-repo-confirm:hover { color: var(--color-sage-300); }
.sync-repo-confirm:disabled { opacity: 0.4; cursor: default; }
.sync-disconnect {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out), color var(--duration-normal) var(--ease-out);
}
.sync-disconnect:hover {
  border-color: color-mix(in oklch, var(--color-danger) 40%, var(--color-border));
  color: var(--color-danger);
}

/* Token copy row (connected state) */
.sync-token-copy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.sync-token-preview {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-text-muted);
  user-select: none;
}
.sync-token-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 0.72rem;
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out), color var(--duration-normal) var(--ease-out);
}
.sync-token-copy-btn:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  color: var(--color-text);
}

/* Cloud info card */
.sync-cloud-card {
  padding: 10px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: var(--lumi-inset-highlight);
}
.sync-cloud-label {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--color-text-muted);
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.sync-cloud-detail {
  font-size: 0.82rem;
  color: var(--color-text-secondary);
  margin-top: 2px;
}

/* Auto cloud-sync toggle */
.sync-autosync {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.sync-autosync-time {
  font-size: 0.72rem;
  color: var(--color-text-muted);
}
.sync-autosync-hint {
  flex-basis: 100%;
  margin: 0;
  font-size: 0.72rem;
  font-style: italic;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.sync-cloud-size {
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-text-muted);
}

/* Action buttons */
.sync-actions {
  display: flex;
  gap: 8px;
}
.sync-action {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out),
              transform var(--duration-fast) var(--ease-out);
}
.sync-action:hover:not(:disabled) {
  background: var(--color-surface-elevated);
}
.sync-action:active:not(:disabled) { transform: scale(0.98); }
.sync-action:disabled { opacity: 0.35; cursor: default; }
.sync-action--download:hover:not(:disabled) {
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, var(--color-border));
}
.sync-action--download svg { color: var(--color-sage-400); }

/* Status messages */
.sync-error {
  font-size: 0.78rem;
  color: var(--color-danger, #e05c5c);
  margin: 0;
}
.sync-progress {
  font-size: 0.78rem;
  color: var(--color-text-muted);
  margin: 0;
}
.sync-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: home-spin 1.2s linear infinite;
}
</style>
