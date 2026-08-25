<script setup lang="ts">
// App doc: docs/user-guide/pages/management.md
/**
 * ManagementView — Profile and save management screen.
 *
 * Provides a complete CRUD interface for character profiles and their
 * save slots:
 *
 * 1. **List profiles**: Shows all profiles from ProfileManager with
 *    their associated save slots expanded underneath.
 *
 * 2. **Create new profile**: Routes to the creation view for a fresh
 *    character creation flow.
 *
 * 3. **Delete profile**: With a confirmation dialog to prevent
 *    accidental data loss. Deletes both the profile metadata and
 *    all associated save data.
 *
 * 4. **Switch to profile**: Loads a specific save slot into the engine
 *    state store and navigates to /game.
 *
 * 5. **Import/Export**: Allows downloading a save as a JSON file or
 *    importing a previously exported save file.
 *
 * Data flow:
 *   ProfileManager.listProfiles() → reactive display list
 *   SaveManager.loadGame/saveGame → load/export operations
 *   SaveManager.deleteGame + ProfileManager.deleteProfile → deletion
 *
 * Dependencies (inject):
 *   - 'profileManager' → ProfileManager
 *   - 'saveManager'    → SaveManager
 *   - 'backupService'  → BackupService（M5 全量备份）
 */
import { ref, inject, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ProfileManager } from '@/engine/persistence/profile-manager';
import type { SaveManager } from '@/engine/persistence/save-manager';
import type { BackupService } from '@/engine/persistence/backup-service';
import type { VectorStore } from '@/engine/memory/engram/vector-store';
import { adaptDemoSave } from '@/engine/persistence/demo-save-adapter';
import type { ProfileMeta, SaveSlotMeta } from '@/engine/types/persistence';
import type { GameStateTree } from '@/engine/types';
import type { AIService } from '@/engine/ai/ai-service';
import type { TtsService } from '@/engine/tts/tts-service';
import { applyPersistedAISettings } from '@/engine/ai/ai-service';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import { useActionQueueStore } from '@/engine/stores/engine-action-queue';
import { useLocale } from '@/ui/composables/useLocale';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const router = useRouter();
const { t } = useI18n();
const { formatDateTime: localeFormatDateTime } = useLocale();
const engineState = useEngineStateStore();

const profileManager = inject<ProfileManager>('profileManager');
const saveManager = inject<SaveManager>('saveManager');
const backupService = inject<BackupService>('backupService');
const vectorStore = inject<VectorStore>('vectorStore');
const aiService = inject<AIService | undefined>('aiService', undefined);
const ttsService = inject<TtsService | undefined>('ttsService', undefined);

// ─── Reactive state ───────────────────────────────────────────

const profiles = ref<ProfileMeta[]>([]);

/** Profile ID awaiting deletion confirmation */
const pendingDeleteId = ref<string | null>(null);

/** Tracks which profile cards are expanded to show save slots */
const expandedProfiles = ref<Set<string>>(new Set());

/** Global loading state for async operations */
const isLoading = ref(false);
const mgmtIncludeRefAssets = ref(false);

/** Error message */
const errorMessage = ref<string | null>(null);

/** Success message (auto-clears after a few seconds) */
const successMessage = ref<string | null>(null);

// ─── Computed ─────────────────────────────────────────────────

const hasProfiles = computed(() => profiles.value.length > 0);

/** The profile currently targeted by the delete confirmation dialog */
const pendingDeleteProfile = computed(() => {
  if (!pendingDeleteId.value) return null;
  return profiles.value.find((p) => p.profileId === pendingDeleteId.value) ?? null;
});

// ─── Data loading ─────────────────────────────────────────────

function refreshProfiles(): void {
  if (profileManager) {
    profiles.value = profileManager.listProfiles();
  }
}

onMounted(() => {
  refreshProfiles();
});

// ─── Navigation ───────────────────────────────────────────────

function goHome(): void {
  router.push('/');
}

function goToCreation(): void {
  router.push('/creation');
}

// ─── Profile expansion toggle ─────────────────────────────────

function toggleExpand(profileId: string): void {
  if (expandedProfiles.value.has(profileId)) {
    expandedProfiles.value.delete(profileId);
  } else {
    expandedProfiles.value.add(profileId);
  }
}

function isExpanded(profileId: string): boolean {
  return expandedProfiles.value.has(profileId);
}

// ─── Delete flow ──────────────────────────────────────────────

/** Show the delete confirmation dialog for a profile */
function requestDelete(profileId: string): void {
  pendingDeleteId.value = profileId;
}

/** Cancel the pending deletion */
function cancelDelete(): void {
  pendingDeleteId.value = null;
}

const deleteBackdrop = useBackdropClose(cancelDelete);

/**
 * Confirm and execute the deletion.
 * Deletes all save slot data first, then the profile metadata.
 */
async function confirmDelete(): Promise<void> {
  const profileId = pendingDeleteId.value;
  if (!profileId || !profileManager || !saveManager) return;

  isLoading.value = true;
  errorMessage.value = null;

  try {
    const profile: ProfileMeta | undefined = profileManager.getProfile(profileId);
    if (profile) {
      const slots: SaveSlotMeta[] = Object.values(profile.slots);
      for (const slot of slots) {
        await saveManager.deleteGame(profileId, slot.slotId);
        if (vectorStore) {
          await vectorStore.deleteForSlot(profileId, slot.slotId);
        }
      }
    }
    await profileManager.deleteProfile(profileId);

    /* If the deleted profile was the active one, clear the game state */
    if (engineState.activeProfileId === profileId) {
      engineState.clearGame();
    }

    showSuccess(t('management.messages.characterDeleted', { name: profile?.characterName ?? profileId }));
    refreshProfiles();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = t('management.errors.deleteFailed', { error: msg });
    console.error('[ManagementView] Delete failed:', err);
  } finally {
    pendingDeleteId.value = null;
    isLoading.value = false;
  }
}

// ─── Load / switch to profile ─────────────────────────────────

/**
 * Load a specific save slot and navigate to the game view.
 */
async function loadSlot(profile: ProfileMeta, slot: SaveSlotMeta): Promise<void> {
  if (!saveManager || !profileManager || isLoading.value) return;

  isLoading.value = true;
  errorMessage.value = null;

  try {
    const stateTree = await saveManager.loadGame(profile.profileId, slot.slotId);
    if (!stateTree) {
      errorMessage.value = t('management.errors.saveCorrupted');
      return;
    }

    await profileManager.setActiveProfile(profile.profileId, slot.slotId);
    engineState.loadGame(stateTree, profile.packId, profile.profileId, slot.slotId);
    router.push('/game');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = t('management.errors.loadFailed', { error: msg });
    console.error('[ManagementView] Load slot failed:', err);
  } finally {
    isLoading.value = false;
  }
}

// ─── Export ───────────────────────────────────────────────────

/**
 * Export a save slot as a downloadable JSON file.
 * The filename encodes the character name, slot, and timestamp for clarity.
 */
async function exportSlot(profile: ProfileMeta, slot: SaveSlotMeta): Promise<void> {
  if (!saveManager) return;

  isLoading.value = true;
  errorMessage.value = null;

  try {
    const data = await saveManager.loadGame(profile.profileId, slot.slotId);
    if (!data) {
      errorMessage.value = t('management.errors.exportNoData');
      return;
    }

    const exportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      profileMeta: {
        profileId: profile.profileId,
        characterName: profile.characterName,
        packId: profile.packId,
      },
      slotMeta: slot,
      stateTree: data,
    };

    const jsonString = JSON.stringify(exportPayload, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const safeName = profile.characterName.replace(/[<>:"/\\|?*]/g, '_');
    const filename = `AGA_${safeName}_${slot.slotId}_${Date.now()}.json`;

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();

    URL.revokeObjectURL(url);
    showSuccess(t('management.messages.saveExported'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = t('management.errors.exportFailed', { error: msg });
    console.error('[ManagementView] Export failed:', err);
  } finally {
    isLoading.value = false;
  }
}

// ─── Import ───────────────────────────────────────────────────

/**
 * Import a save file from disk.
 * Creates or updates the profile and save slot from the imported data.
 */
function triggerImport(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await handleImportFile(file);
  };
  input.click();
}

/** Parsed import payload structure */
interface ImportPayload {
  version: number;
  profileMeta: {
    profileId: string;
    characterName: string;
    packId: string;
  };
  slotMeta: SaveSlotMeta;
  stateTree: GameStateTree;
}

async function handleImportFile(file: File): Promise<void> {
  if (!profileManager || !saveManager) return;

  isLoading.value = true;
  errorMessage.value = null;

  try {
    const text = await file.text();
    const payload = JSON.parse(text) as unknown;

    if (!isValidImportPayload(payload)) {
      errorMessage.value = t('management.errors.invalidFileFormat');
      return;
    }

    const { profileMeta, slotMeta, stateTree: rawTree } = payload;

    /** 兼容 ming demo 导出的旧树结构 — 幂等适配 */
    const stateTree = adaptDemoSave(
      rawTree as Record<string, unknown>,
    ) as GameStateTree;

    /* Ensure the profile exists */
    const existing = profileManager.getProfile(profileMeta.profileId);
    if (!existing) {
      await profileManager.createProfile({
        profileId: profileMeta.profileId,
        characterName: profileMeta.characterName,
        packId: profileMeta.packId,
        createdAt: new Date().toISOString(),
        slots: {},
        activeSlotId: null,
      });
    }

    /* Save the imported state tree */
    await saveManager.saveGame(
      profileMeta.profileId,
      slotMeta.slotId,
      stateTree,
      slotMeta,
    );

    showSuccess(t('management.messages.characterImported', { name: profileMeta.characterName }));
    refreshProfiles();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = t('management.errors.importFailed', { error: msg });
    console.error('[ManagementView] Import failed:', err);
  } finally {
    isLoading.value = false;
  }
}

/**
 * Runtime validation for imported JSON data.
 * Checks the structural shape without using `any`.
 */
function isValidImportPayload(data: unknown): data is ImportPayload {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;

  if (typeof obj.version !== 'number') return false;
  if (typeof obj.stateTree !== 'object' || obj.stateTree === null) return false;

  const meta = obj.profileMeta;
  if (typeof meta !== 'object' || meta === null) return false;
  const metaObj = meta as Record<string, unknown>;
  if (typeof metaObj.profileId !== 'string') return false;
  if (typeof metaObj.characterName !== 'string') return false;
  if (typeof metaObj.packId !== 'string') return false;

  const slot = obj.slotMeta;
  if (typeof slot !== 'object' || slot === null) return false;
  const slotObj = slot as Record<string, unknown>;
  if (typeof slotObj.slotId !== 'string') return false;

  return true;
}

// ─── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return t('common.time.neverSaved');
  return localeFormatDateTime(iso);
}

function showSuccess(msg: string): void {
  successMessage.value = msg;
  setTimeout(() => {
    if (successMessage.value === msg) {
      successMessage.value = null;
    }
  }, 3000);
}

function getSlotsArray(profile: ProfileMeta): SaveSlotMeta[] {
  return Object.values(profile.slots);
}

/**
 * 全量备份已把 `aga_*` 写回 localStorage，但 Pinia / AIService 仍保留旧内存态。
 * 必须重新 load，否则界面与内存中的 API、Action Queue 与磁盘不一致。
 */
function syncEngineAfterBackupImport(): void {
  const apiStore = useAPIManagementStore();
  apiStore.loadFromStorage();
  if (aiService) {
    aiService.setConfigs([...apiStore.apiConfigs]);
    aiService.setAssignments([...apiStore.apiAssignments]);
    // Re-apply the imported aga_ai_settings to AIService memory (maxRetries +
    // low-load rate limiter). Without this the in-memory limiter/retries keep the
    // pre-import values until a full page reload, and the user can enter a game via
    // loadSlot (no reload) right after importing — running the whole session stale.
    applyPersistedAISettings(aiService);
  }
  // Re-load imported aga_tts_settings into the live TtsService so orchestrator
  // auto-narrate + main-panel play use the imported config without a page reload.
  ttsService?.reloadSettings();
  useActionQueueStore().loadFromLocalStorage();
}

// ─── M5 全量备份 / 旧版状态树导入 ─────────────────────────────

/** 判断 JSON 是否像游戏状态树根（而非单槽导出包） */
function looksLikeStateTreeRoot(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const o = data as Record<string, unknown>;
  return '元数据' in o || '角色' in o;
}

/**
 * 导出全部持久化数据（档案 + IDB 存档 + 向量 + 配置 + Prompt + localStorage aga_*）
 * 对应 STEP-03B M5.2
 */
async function exportFullBackup(): Promise<void> {
  if (!backupService || isLoading.value) return;
  isLoading.value = true;
  errorMessage.value = null;
  try {
    // Flush current in-memory state to IDB before exporting
    const pid = engineState.activeProfileId;
    const sid = engineState.activeSlotId;
    if (saveManager && pid && sid) {
      await saveManager.saveGame(pid, sid, engineState.toSnapshot() as import('@/engine/types').GameStateTree);
    }
    const blob = await backupService.exportAll({ includeReferenceAssets: mgmtIncludeRefAssets.value });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `AGA_full_backup_${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showSuccess(t('management.messages.fullBackupExported'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = t('management.errors.fullExportFailed', { error: msg });
    console.error('[ManagementView] Full backup export failed:', err);
  } finally {
    isLoading.value = false;
  }
}

/**
 * 从全量备份 JSON 恢复 — 覆盖式合并（同 profileId 会被备份中的数据覆盖）
 */
async function importFullBackup(): Promise<void> {
  if (!backupService || isLoading.value) return;
  const ok = window.confirm(
    t('management.dialogs.importFullBackupConfirm'),
  );
  if (!ok) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    isLoading.value = true;
    errorMessage.value = null;
    try {
      await backupService.importAll(file);
      syncEngineAfterBackupImport();
      refreshProfiles();
      engineState.clearGame();
      showSuccess(t('management.messages.fullBackupImported'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorMessage.value = t('management.errors.fullImportFailed', { error: msg });
      console.error('[ManagementView] Full backup import failed:', err);
    } finally {
      isLoading.value = false;
    }
  };
  input.click();
}

/**
 * 导入「仅根状态树」的 demo / ming 导出 JSON（无 profileMeta 包装）
 * 写入列表中第一个角色的新槽位，便于快速验证 M5.3 适配器
 */
function triggerImportRawStateTree(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file || !profileManager || !saveManager) return;
    isLoading.value = true;
    errorMessage.value = null;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!looksLikeStateTreeRoot(parsed)) {
        errorMessage.value = t('management.errors.invalidStateTree');
        return;
      }
      const adapted = adaptDemoSave(parsed as Record<string, unknown>) as GameStateTree;
      const list = profileManager.listProfiles();
      if (list.length === 0) {
        errorMessage.value = t('management.errors.noProfilesForImport');
        return;
      }
      const target = list[0];
      const slotId = `demo_${Date.now()}`;
      await saveManager.saveGame(target.profileId, slotId, adapted, {
        slotId,
        slotName: t('management.slots.demoImport'),
        lastSavedAt: new Date().toISOString(),
        packId: target.packId,
        packVersion: '',
        characterName:
          (adapted as { 角色?: { 基础信息?: { 姓名?: string } } })?.角色?.基础信息?.姓名,
      });
      showSuccess(t('management.messages.importedToSlot', { name: target.characterName }));
      refreshProfiles();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorMessage.value = t('management.errors.rawImportFailed', { error: msg });
      console.error('[ManagementView] Raw state import failed:', err);
    } finally {
      isLoading.value = false;
    }
  };
  input.click();
}
</script>

<template>
  <div class="management-view">
    <!-- Header -->
    <header class="mgmt-header">
      <Tooltip :text="$t('management.buttons.home')" interactive>
        <button class="btn-back" @click="goHome" :aria-label="$t('management.buttons.home')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </Tooltip>
      <h1 class="mgmt-title">{{ $t('management.title') }}</h1>
      <div class="header-actions">
        <AgaToggle v-model="mgmtIncludeRefAssets" :label="$t('management.options.includeRefAssets')" show-label />
        <Tooltip :text="$t('management.buttons.exportFullTitle')" interactive>
          <button
            class="btn btn-small btn-outline"
            type="button"
            @click="exportFullBackup"
            :disabled="isLoading || !backupService"
          >
            {{ $t('management.buttons.exportFull') }}
          </button>
        </Tooltip>
        <button
          class="btn btn-small btn-outline"
          type="button"
          @click="importFullBackup"
          :disabled="isLoading || !backupService"
        >
          {{ $t('management.buttons.importFull') }}
        </button>
        <button class="btn btn-small btn-outline" @click="triggerImport" :disabled="isLoading">
          {{ $t('management.buttons.importSave') }}
        </button>
        <Tooltip :text="$t('management.buttons.importDemoTreeTitle')" interactive>
          <button
            class="btn btn-small btn-outline"
            type="button"
            @click="triggerImportRawStateTree"
            :disabled="isLoading"
          >
            {{ $t('management.buttons.importDemoTree') }}
          </button>
        </Tooltip>
        <button class="btn btn-small btn-primary" @click="goToCreation" :disabled="isLoading">
          {{ $t('management.buttons.newCharacter') }}
        </button>
      </div>
    </header>

    <!-- Success / error messages -->
    <Transition name="fade">
      <div v-if="successMessage" class="msg-banner msg-success" role="status">
        {{ successMessage }}
      </div>
    </Transition>
    <Transition name="fade">
      <div v-if="errorMessage" class="msg-banner msg-error" role="alert">
        <span>{{ errorMessage }}</span>
        <button class="msg-dismiss" @click="errorMessage = null">&times;</button>
      </div>
    </Transition>

    <!-- Profile list -->
    <main class="profile-list" v-if="hasProfiles">
      <div
        v-for="profile in profiles"
        :key="profile.profileId"
        class="profile-card"
      >
        <!-- Profile header row -->
        <div
          class="profile-header"
          @click="toggleExpand(profile.profileId)"
          role="button"
          tabindex="0"
          :aria-expanded="isExpanded(profile.profileId)"
          @keydown.enter="toggleExpand(profile.profileId)"
        >
          <div class="profile-avatar">
            {{ profile.characterName?.charAt(0) ?? '?' }}
          </div>
          <div class="profile-info">
            <span class="profile-name">{{ profile.characterName }}</span>
            <span class="profile-sub">
              {{ $t('management.profileCard.packCreated', { packId: profile.packId, date: formatDate(profile.createdAt) }) }}
            </span>
          </div>
          <div class="profile-slot-count">
            {{ $t('management.profileCard.saveCount', { count: getSlotsArray(profile).length }) }}
          </div>
          <svg
            class="expand-icon"
            :class="{ rotated: isExpanded(profile.profileId) }"
            width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        <!-- Expanded: save slots list -->
        <Transition name="expand">
          <div v-if="isExpanded(profile.profileId)" class="slots-panel">
            <div
              v-for="slot in getSlotsArray(profile)"
              :key="slot.slotId"
              class="slot-row"
            >
              <div class="slot-info">
                <span class="slot-name">{{ slot.slotName }}</span>
                <span class="slot-meta">
                  {{ formatDate(slot.lastSavedAt) }}
                  <template v-if="slot.characterName"> · {{ slot.characterName }}</template>
                  <template v-if="slot.currentLocation"> · {{ slot.currentLocation }}</template>
                </span>
              </div>
              <div class="slot-actions">
                <button
                  class="btn btn-tiny btn-primary"
                  @click.stop="loadSlot(profile, slot)"
                  :disabled="isLoading"
                >
                  {{ $t('management.slots.load') }}
                </button>
                <button
                  class="btn btn-tiny btn-outline"
                  @click.stop="exportSlot(profile, slot)"
                  :disabled="isLoading"
                >
                  {{ $t('management.slots.export') }}
                </button>
              </div>
            </div>

            <div v-if="getSlotsArray(profile).length === 0" class="slots-empty">
              {{ $t('management.slots.empty') }}
            </div>

            <!-- Profile-level actions -->
            <div class="profile-actions">
              <button
                class="btn btn-tiny btn-danger"
                @click.stop="requestDelete(profile.profileId)"
                :disabled="isLoading"
              >
                {{ $t('management.buttons.deleteCharacter') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </main>

    <!-- Empty state -->
    <div v-else class="empty-state">
      <p class="empty-text">{{ $t('management.empty.noProfiles') }}</p>
      <button class="btn btn-primary" @click="goToCreation">{{ $t('management.buttons.createFirst') }}</button>
    </div>

    <!--
      Delete confirmation modal.
      Rendered via Teleport to body so it overlays everything.
    -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="pendingDeleteProfile"
          class="modal-overlay"
          @pointerdown="deleteBackdrop.onPointerdown"
          @pointerup="deleteBackdrop.onPointerup"
          role="dialog"
          aria-modal="true"
          :aria-label="$t('management.modals.deleteAriaLabel', { name: pendingDeleteProfile.characterName })"
        >
          <div class="modal-card">
            <h3 class="modal-title">{{ $t('management.modals.deleteTitle') }}</h3>
            <p class="modal-body">
              {{ $t('management.modals.deleteMessage', { name: pendingDeleteProfile.characterName }) }}
            </p>
            <div class="modal-actions">
              <button class="btn btn-secondary" @click="cancelDelete">{{ $t('management.modals.cancel') }}</button>
              <button class="btn btn-danger" @click="confirmDelete" :disabled="isLoading">
                {{ $t('management.modals.confirmDelete') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * ManagementView — sanctuary migration 2026-04-21.
 * Template + script untouched; only `<style scoped>` rewritten.
 *
 * Key changes:
 *   - All `#fff` removed (avatar circle, primary/danger btns)
 *   - Tailwind msg-banner rgba → tokenized color-mix (success = sage, error = rust)
 *   - Cold `rgba(0,0,0,0.55)` modal overlay → warm-charcoal fog matching Phase 3.1
 *   - Delete modal dialog: solid surface → frosted cabin-glass panel
 *   - Profile header hover `rgba(255,255,255,0.03)` → tokenized color-mix
 *   - Header title: sanctuary serif + letter-spacing
 *   - All btn variants reworked to match AgaButton sanctuary language
 */
.management-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  overflow: hidden;
}

/* ── Header ─────────────────────────────────────────────────── */

.mgmt-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1.25rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.btn-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.btn-back:hover {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.mgmt-title {
  flex: 1;
  font-family: var(--font-serif-cjk);
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: var(--color-text);
  min-width: 200px;
}

.header-actions {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}

/* ── Buttons ─────────────────────────────────────────────────
   Note: `.btn-small`, `.btn-tiny` are size modifiers used alongside a
   variant class (btn-primary/outline/danger/secondary). */

.btn {
  padding: 0.4rem 0.875rem;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-small {
  padding: 0.375rem 0.875rem;
  font-size: 0.78rem;
}

.btn-tiny {
  padding: 0.25rem 0.625rem;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  border-radius: var(--radius-sm);
}

/* Primary — sage beacon */
.btn-primary {
  background: var(--color-sage-muted);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  color: var(--color-sage-100);
}
.btn-primary:hover:not(:disabled) {
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  border-color: var(--color-sage-400);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 28%, transparent);
}

/* Secondary — neutral outline */
.btn-secondary {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text);
}
.btn-secondary:hover:not(:disabled) {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  color: var(--color-sage-100);
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
}

/* Outline — same visual as secondary; kept alias for template */
.btn-outline {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text);
}
.btn-outline:hover:not(:disabled) {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
}

/* Danger — warm rust muted, never filled + #fff */
.btn-danger {
  background: color-mix(in oklch, var(--color-danger) 12%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 40%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
}
.btn-danger:hover:not(:disabled) {
  background: color-mix(in oklch, var(--color-danger) 22%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 60%, transparent);
}

/* ── Messages ───────────────────────────────────────────────── */

.msg-banner {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0.75rem 1.25rem 0;
  padding: 0.5rem 0.875rem;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.82rem;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.msg-success {
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  color: var(--color-sage-300);
}

.msg-error {
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 40%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
}

.msg-dismiss {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 1.1rem;
  cursor: pointer;
  line-height: 1;
  margin-left: auto;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out);
}
.msg-dismiss:hover {
  background: color-mix(in oklch, currentColor 18%, transparent);
}

/* ── Profile list ───────────────────────────────────────────── */

.profile-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.875rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.profile-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--color-surface);
  transition: border-color var(--duration-fast) var(--ease-out);
}
.profile-card:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, var(--color-border));
}

.profile-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.profile-header:hover {
  background: linear-gradient(90deg, color-mix(in oklch, var(--color-sage-400) 4%, transparent), transparent 60%);
}

.profile-avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklch, var(--color-sage-400) 12%, var(--color-surface-elevated));
  color: var(--color-sage-100);
  font-family: var(--font-serif-cjk);
  font-weight: 500;
  font-size: 1.1rem;
  letter-spacing: 0.02em;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, var(--color-border));
  border-radius: 50%;
}

.profile-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.profile-name {
  font-family: var(--font-serif-cjk);
  font-size: 0.96rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-sub {
  font-family: var(--font-sans);
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}

.profile-slot-count {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-text-muted);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
  flex-shrink: 0;
}

.expand-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform var(--duration-normal) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.profile-header:hover .expand-icon { color: var(--color-sage-300); }
.expand-icon.rotated { transform: rotate(180deg); }

/* ── Slots panel (expanded) ─────────────────────────────────── */

.slots-panel {
  border-top: 1px solid var(--color-border-subtle);
  padding: 0.5rem 0.875rem 0.625rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  background: color-mix(in oklch, var(--color-surface) 50%, var(--color-bg));
}

.slot-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  transition: border-color var(--duration-fast) var(--ease-out);
}
.slot-row:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 32%, var(--color-border));
  background: linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 3%, transparent), transparent 50%);
}

.slot-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.slot-name {
  font-family: var(--font-serif-cjk);
  font-size: 0.84rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  color: var(--color-text);
}

.slot-meta {
  font-family: var(--font-sans);
  font-size: 0.68rem;
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}

.slot-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.slots-empty {
  text-align: center;
  padding: 1rem;
  font-family: var(--font-serif-cjk);
  font-style: italic;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.profile-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.375rem;
  border-top: 1px dashed var(--color-border-subtle);
  margin-top: 0.25rem;
}

/* ── Empty state ────────────────────────────────────────────── */

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 3.5rem 1.25rem;
}

.empty-text {
  font-family: var(--font-serif-cjk);
  font-size: 0.95rem;
  letter-spacing: 0.08em;
  color: var(--color-text-umber);
}

/* ── Modal overlay (delete confirm — frosted cabin-glass) ─────
   2026-04-21 tuning matches Modal.vue: lower overlay α so page is
   softly visible through, vertical gradient on card + top/bottom
   edge highlights for glass refraction. */

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
  background: var(--glass-overlay-bg);
  backdrop-filter: var(--glass-overlay-blur);
  -webkit-backdrop-filter: var(--glass-overlay-blur);
}

.modal-card {
  position: relative;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: none;
  border-radius: var(--radius-xl);
  padding: 1.5rem;
  width: 90%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: var(--glass-shadow);
}
.modal-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 10%;
  right: 10%;
  height: 1px;
  background: var(--accent-sage);
  opacity: 0.5;
  pointer-events: none;
}

.modal-title {
  font-family: var(--font-serif-cjk);
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  color: color-mix(in oklch, var(--color-danger) 90%, var(--color-text));
}

.modal-body {
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  letter-spacing: 0.01em;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* ── Transitions ── */

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}
.fade-enter-from,
.fade-leave-to { opacity: 0; }

.expand-enter-active {
  transition: max-height var(--duration-slow) var(--ease-out),
              opacity var(--duration-normal) var(--ease-out);
  overflow: hidden;
}
.expand-leave-active {
  transition: max-height var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
  overflow: hidden;
}
.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}
.expand-enter-to,
.expand-leave-from {
  max-height: 600px;
  opacity: 1;
}

/* ── Responsive ── */

@media (max-width: 767px) {
  .mgmt-header {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .header-actions .btn {
    min-height: 44px;
  }
}

/* Small phone refinements — mgmt-header/header-actions already handled by 767px block above */
@media (max-width: 480px) {
  .profile-list {
    padding: 0.75rem;
  }
  .slot-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .slot-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
