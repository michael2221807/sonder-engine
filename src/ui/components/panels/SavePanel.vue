<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md
/**
 * SavePanel — 完整存档管理面板
 *
 * 功能：
 * - 多槽存档：保存 / 读取 / 删除 / 新建槽
 * - 存档卡片：地位、大小、类型徽章显示
 * - 单存档导出（JSON 下载）
 * - 向量索引重建（E.5.4）
 * - 自动存档设置：时间点存档间隔
 * - 完整备份导出 / 恢复（BackupService）
 */
import { ref, computed, watch, onUnmounted, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { useLocale } from '@/ui/composables/useLocale';
import { useCloudAutoSyncToggle } from '@/ui/composables/useCloudAutoSyncToggle';
import Modal from '@/ui/components/common/Modal.vue';
import CardExportFlow from '@/ui/components/panels/CardExportFlow.vue';
import SaveToCardFlow from '@/ui/components/panels/SaveToCardFlow.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import type { SaveSlotMeta } from '@/engine/types/persistence';
import type { GameStateTree } from '@/engine/types';
import type { ProfileManager } from '@/engine/persistence/profile-manager';
import type { SaveManager } from '@/engine/persistence/save-manager';
import type { VectorStore } from '@/engine/memory/engram/vector-store';
import type { Embedder } from '@/engine/memory/engram/embedder';
import type { BackupService } from '@/engine/persistence/backup-service';
import type { CustomPresetStore } from '@/engine/persistence/custom-preset-store';
import { loadEngramConfig } from '@/engine/memory/engram/engram-config';

const { t } = useI18n();
const { formatDateTime } = useLocale();
const { isLoaded, activePackId, activeProfileId, activeSlotId, store } = useGameState();

const profileManager = inject<ProfileManager>('profileManager');
const saveManager = inject<SaveManager>('saveManager');
const vectorStore = inject<VectorStore>('vectorStore');
const embedder = inject<Embedder>('embedder');
const backupService = inject<BackupService>('backupService');
const customPresetStore = inject<CustomPresetStore | undefined>('customPresetStore', undefined);

// Story 5: game-card export modal
const showCardExport = ref(false);

// Story 9: the card-writing guide's "导出" step deep-links here via
// ?action=export. Open the export flow, then consume the query so navigating
// back to /game/save later doesn't spuriously re-open it.
const route = useRoute();
const router = useRouter();
watch(() => route.query.action, (raw) => {
  // route.query values are string | string[] | null — narrow to a single string.
  const action = Array.isArray(raw) ? raw[0] : raw;
  if (action === 'export') {
    showCardExport.value = true;
    router.replace({ path: route.path, query: {} }).catch(() => { /* duplicate nav — ignore */ });
  }
}, { immediate: true });

// Story 7: save-to-card wizard (any saved slot of the current profile)
const showToCard = ref(false);
const toCardTarget = ref<{ profileId: string; slotId: string } | null>(null);

function openToCard(slotId: string): void {
  const pid = activeProfileId.value;
  if (!pid) return;
  toCardTarget.value = { profileId: pid, slotId };
  showToCard.value = true;
}

// Clear the target once the wizard closes so a stale slot can never re-mount the flow.
watch(showToCard, (open) => { if (!open) toCardTarget.value = null; });

// ─── Slot list ────────────────────────────────────────────────

const slots = ref<SaveSlotMeta[]>([]);

function refreshSlots(): void {
  const pid = activeProfileId.value;
  if (!profileManager || !pid) {
    slots.value = [];
    return;
  }
  const profile = profileManager.getProfile(pid);
  slots.value = profile ? Object.values(profile.slots) : [];
}

watch([isLoaded, activeProfileId], () => { refreshSlots(); }, { immediate: true });

// ─── Save / Load / Delete ─────────────────────────────────────

const confirmOverwrite = ref(false);
const pendingSaveSlotId = ref('');

function initiatesSave(slotId: string): void {
  const slot = slots.value.find((s) => s.slotId === slotId);
  if (slot?.lastSavedAt) {
    pendingSaveSlotId.value = slotId;
    confirmOverwrite.value = true;
  } else {
    void performSave(slotId);
  }
}

async function performSave(slotId: string): Promise<void> {
  const pid = activeProfileId.value;
  const packId = activePackId.value ?? '';
  if (!saveManager || !pid || !profileManager) return;

  const snapshot = store.toSnapshot() as GameStateTree;
  const slotMeta = slots.value.find((s) => s.slotId === slotId);

  await saveManager.saveGame(pid, slotId, snapshot, {
    slotId,
    slotName: slotMeta?.slotName ?? slotId,
    lastSavedAt: new Date().toISOString(),
    packId: slotMeta?.packId ?? packId,
    packVersion: slotMeta?.packVersion ?? '',
    characterName: store.characterName,
    currentLocation: store.currentLocation,
    gameTime: store.gameTime,
    saveType: 'manual',
  });

  refreshSlots();
  confirmOverwrite.value = false;
  pendingSaveSlotId.value = '';

  eventBus.emit('engine:save-complete', { profileId: pid, slotId });
  eventBus.emit('ui:toast', { type: 'success', message: t('save.toast.saveSuccess'), duration: 1500 });
}

function confirmSave(): void {
  if (pendingSaveSlotId.value) void performSave(pendingSaveSlotId.value);
}

async function loadSlot(slotId: string): Promise<void> {
  const pid = activeProfileId.value;
  const slot = slots.value.find((s) => s.slotId === slotId);
  const packId = slot?.packId ?? activePackId.value ?? '';
  if (!saveManager || !profileManager || !pid) return;

  try {
    const data = await saveManager.loadGame(pid, slotId);
    if (!data) {
      eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.loadEmpty'), duration: 2000 });
      return;
    }
    await profileManager.setActiveProfile(pid, slotId);
    store.loadGame(data as GameStateTree, packId, pid, slotId);
    eventBus.emit('ui:toast', { type: 'success', message: t('save.toast.loadSuccess'), duration: 1500 });
  } catch (err) {
    console.error('[SavePanel] loadSlot failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.loadFailed'), duration: 2500 });
  }
}

const showNewSlotModal = ref(false);
const newSlotName = ref('');

function openNewSlotModal(): void {
  newSlotName.value = t('save.newSlotModal.defaultName', { n: slots.value.length + 1 });
  showNewSlotModal.value = true;
}

async function createSlot(): Promise<void> {
  const pid = activeProfileId.value;
  const packId = activePackId.value ?? '';
  if (!newSlotName.value.trim() || !profileManager || !pid) return;

  const id = `slot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await profileManager.updateSlotMeta(pid, id, {
    slotId: id,
    slotName: newSlotName.value.trim(),
    lastSavedAt: null,
    packId,
    packVersion: '',
    saveType: 'manual',
  });
  refreshSlots();
  showNewSlotModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('save.toast.newSlot'), duration: 1500 });
}

async function deleteSlot(slotId: string): Promise<void> {
  const pid = activeProfileId.value;
  if (slotId === 'auto') {
    eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.deleteAutoForbidden'), duration: 2000 });
    return;
  }
  if (!saveManager || !profileManager || !pid) return;

  try {
    await saveManager.deleteGame(pid, slotId);
    if (vectorStore) await vectorStore.deleteForSlot(pid, slotId);
    await profileManager.removeSaveSlot(pid, slotId);
    refreshSlots();
    if (activeSlotId.value === slotId) store.clearGame();
    eventBus.emit('ui:toast', { type: 'warning', message: t('save.toast.deleteSuccess'), duration: 1500 });
  } catch (err) {
    console.error('[SavePanel] deleteSlot failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.deleteFailed'), duration: 2000 });
  }
}

function isActiveSlot(slotId: string): boolean {
  return slotId === activeSlotId.value;
}

function formatTime(isoStr: string | null): string {
  if (!isoStr) return t('save.slot.neverSaved');
  try {
    return formatDateTime(isoStr);
  } catch { return isoStr; }
}

function saveTypeBadge(type: SaveSlotMeta['saveType']): { label: string; cls: string } | null {
  switch (type) {
    case 'pre-round': return { label: t('save.badge.preRound'), cls: 'badge--info' };
    case 'timepoint': return { label: t('save.badge.timepoint'), cls: 'badge--warning' };
    case 'exit':      return { label: t('save.badge.exit'), cls: 'badge--exit' };
    default:          return null; // manual — no badge
  }
}

// ─── E.5.4 Rebuild vector index ───────────────────────────────

const rebuildingSlotId = ref<string | null>(null);

async function rebuildVectors(slotId: string): Promise<void> {
  const pid = activeProfileId.value;
  if (!saveManager || !vectorStore || !embedder || !pid) return;
  if (rebuildingSlotId.value) return;

  rebuildingSlotId.value = slotId;
  try {
    const saveData = await saveManager.loadGame(pid, slotId);
    if (!saveData) {
      eventBus.emit('ui:toast', { type: 'error', message: t('save.vectors.rebuildEmptySlot'), duration: 2000 });
      return;
    }

    const root = saveData as Record<string, unknown>;
    const sysExt = (root['系统'] as Record<string, unknown> | undefined)?.['扩展'] as Record<string, unknown> | undefined;
    const engramMemory = sysExt?.['engramMemory'] as Record<string, unknown> | undefined;
    const events = Array.isArray(engramMemory?.['events'])
      ? (engramMemory!['events'] as Array<{ id: string; text: string }>)
      : [];

    if (events.length === 0) {
      eventBus.emit('ui:toast', { type: 'info', message: t('save.vectors.rebuildEmpty'), duration: 2500 });
      return;
    }

    eventBus.emit('ui:toast', { type: 'info', message: t('save.vectors.rebuildStart', { count: events.length }), duration: 3000 });

    const texts = events.map((e) => e.text ?? '');
    const vectors = await embedder.embed(texts);
    const model = loadEngramConfig().embeddingModel ?? 'unknown';
    await vectorStore.mergeEventVectors(events, vectors, model, { profileId: pid, slotId });

    eventBus.emit('ui:toast', { type: 'success', message: t('save.vectors.rebuildSuccess', { count: events.length }), duration: 2500 });
  } catch (err) {
    console.error('[SavePanel] rebuildVectors failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.vectors.rebuildFailed'), duration: 2500 });
  } finally {
    rebuildingSlotId.value = null;
  }
}

// ─── B.3.3 Export single save (角色级备份) ─────────────────────
//
// 2026-04-13 重构：单存档导出改走 backupService.exportProfile，
// 产出的文件是标准 BackupBundle 格式（bundleType='profile'），
// 可直接被"恢复备份"按钮读入，打破以前"只写不能读"的断链。
// 注意：exportProfile 会导出该 profile 的**全部** slot，不是只导出单个 slot
//       —— 这是刻意的行为，因为角色数据天然以 profile 为粒度划分。

async function exportSingleSave(_slot: SaveSlotMeta): Promise<void> {
  const pid = activeProfileId.value;
  if (!backupService || !pid) return;
  try {
    // Flush current state to IDB before exporting
    const sid = activeSlotId.value;
    if (saveManager && sid) {
      await saveManager.saveGame(pid, sid, store.toSnapshot() as GameStateTree);
    }
    const blob = await backupService.exportProfile(pid, { includeReferenceAssets: includeReferenceAssets.value });
    const charName = store.characterName || pid;
    const safeName = String(charName).replace(/[\\/:*?"<>|]/g, '_');
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `profile-${safeName}-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    eventBus.emit('ui:toast', {
      type: 'success',
      message: t('save.toast.exportSuccess', { name: charName }),
      duration: 2500,
    });
  } catch (err) {
    console.error('[SavePanel] exportSingleSave failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.exportFailed'), duration: 2000 });
  }
}

// ─── B.3.1 Auto-save settings ────────────────────────────────

const AUTO_SAVE_KEY = 'aga_autosave_settings';

interface AutoSaveSettings {
  timepointEnabled: boolean;
  timepointInterval: number; // minutes
}

function loadAutoSaveSettings(): AutoSaveSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_SAVE_KEY) ?? '{}') as Partial<AutoSaveSettings>;
    return {
      timepointEnabled: raw.timepointEnabled === true,
      timepointInterval: typeof raw.timepointInterval === 'number' && raw.timepointInterval >= 1
        ? raw.timepointInterval
        : 15,
    };
  } catch { return { timepointEnabled: false, timepointInterval: 15 }; }
}

const autoSaveSettings = ref<AutoSaveSettings>(loadAutoSaveSettings());

function saveAutoSaveSettings(): void {
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(autoSaveSettings.value));
}

watch(autoSaveSettings, saveAutoSaveSettings, { deep: true });

// Time-based save timer
let timepointTimer: ReturnType<typeof setInterval> | null = null;
let isTimepointSaving = false;

function startTimepointSave(intervalMinutes: number): void {
  if (timepointTimer) clearInterval(timepointTimer);
  timepointTimer = setInterval(async () => {
    if (isTimepointSaving) return; // prevent concurrent saves
    const pid = activeProfileId.value;
    if (!isLoaded.value || !saveManager || !profileManager || !pid) return;
    isTimepointSaving = true;
    try {
      const slotId = 'timepoint';
      const packId = activePackId.value ?? '';
      const snapshot = store.toSnapshot() as GameStateTree;
      const existing = slots.value.find((s) => s.slotId === slotId);
      await saveManager.saveGame(pid, slotId, snapshot, {
        slotId,
        slotName: t('save.autoSave.timepoint.slotName'),
        lastSavedAt: new Date().toISOString(),
        packId: existing?.packId ?? packId,
        packVersion: existing?.packVersion ?? '',
        characterName: store.characterName,
        currentLocation: store.currentLocation,
        gameTime: store.gameTime,
        saveType: 'timepoint',
      });
      refreshSlots();
    } finally {
      isTimepointSaving = false;
    }
  }, intervalMinutes * 60 * 1000);
}

watch(
  () => [autoSaveSettings.value.timepointEnabled, autoSaveSettings.value.timepointInterval] as const,
  ([enabled, interval]) => {
    if (enabled) {
      startTimepointSave(interval);
    } else {
      if (timepointTimer) { clearInterval(timepointTimer); timepointTimer = null; }
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (timepointTimer) clearInterval(timepointTimer);
});

// ─── B.3.6 Full backup export / import ───────────────────────

const isExportingBackup = ref(false);
const isImportingBackup = ref(false);
const backupImportError = ref('');
const showBackupConfirm = ref(false);
const pendingImportBlob = ref<Blob | null>(null);

// 新增：导入预览的详细信息，用于在对话框中呈现不同 UI
const pendingImportInfo = ref<{
  bundleType: 'full' | 'profile';
  profileCount: number;
  saveCount: number;
  vectorCount: number;
  hasActiveProfile: boolean;
  profileNames: string[];
  exportedAt: string;
} | null>(null);

// 仅全量导入时需要用户勾选确认（破坏性操作）
const fullImportAcknowledged = ref(false);
const includeReferenceAssets = ref(false);

async function exportFullBackup(): Promise<void> {
  if (!backupService || isExportingBackup.value) return;
  isExportingBackup.value = true;
  try {
    // Flush current in-memory state tree to IDB before exporting,
    // so toggled settings that haven't been auto-saved yet are included.
    const pid = activeProfileId.value;
    const sid = activeSlotId.value;
    if (saveManager && pid && sid) {
      await saveManager.saveGame(pid, sid, store.toSnapshot() as GameStateTree);
    }
    const blob = await backupService.exportAll({ includeReferenceAssets: includeReferenceAssets.value });
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `full-backup-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    eventBus.emit('ui:toast', { type: 'success', message: t('save.backup.exportToast'), duration: 2000 });
  } catch (err) {
    console.error('[SavePanel] exportFullBackup failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.backup.exportError'), duration: 2500 });
  } finally {
    isExportingBackup.value = false;
  }
}

// ─── 2026-04-14 Phase 5：自定义预设包独立 export / import ───
//
// 只导出/导入用户自定义创角预设（worlds / origins / traits / talents...）
// 不含存档/向量/API 配置，体积小，便于用户分享"创意素材包"。

const isExportingPresets = ref(false);
const isImportingPresets = ref(false);

interface CustomPresetsExportFile {
  /** 固定为 1，未来字段变化时升版 */
  version: number;
  /** 区分文件类型与全量备份 */
  type: 'custom_presets';
  /** 与导出时的 packId 绑定，导入时校验 */
  packId: string;
  /** ISO 时间戳 */
  exportedAt: string;
  /** 各 preset 类型的用户条目数组（结构与 BackupBundle.customPresets[packId] 一致） */
  presets: Record<string, unknown[]>;
}

async function exportCustomPresets(): Promise<void> {
  if (!customPresetStore || isExportingPresets.value) return;
  const pid = activePackId.value;
  if (!pid) {
    eventBus.emit('ui:toast', { type: 'warning', message: t('save.presets.noActivePack'), duration: 2500 });
    return;
  }
  isExportingPresets.value = true;
  try {
    const data = await customPresetStore.load(pid);
    const totalCount = Object.values(data.presets ?? {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    );
    if (totalCount === 0) {
      eventBus.emit('ui:toast', { type: 'info', message: t('save.presets.exportEmpty'), duration: 2500 });
      return;
    }
    const payload: CustomPresetsExportFile = {
      version: 1,
      type: 'custom_presets',
      packId: pid,
      exportedAt: new Date().toISOString(),
      presets: data.presets ?? {},
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `presets-${pid}-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    eventBus.emit('ui:toast', {
      type: 'success',
      message: t('save.presets.exportToast', { count: totalCount }),
      duration: 2500,
    });
  } catch (err) {
    console.error('[SavePanel] exportCustomPresets failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('save.toast.exportFailed'), duration: 2500 });
  } finally {
    isExportingPresets.value = false;
  }
}

function openCustomPresetImportPicker(): void {
  if (!customPresetStore) {
    eventBus.emit('ui:toast', { type: 'error', message: t('save.presets.notEnabled'), duration: 2500 });
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await importCustomPresets(file);
  };
  input.click();
}

/**
 * 导入自定义预设包
 *
 * 行为：
 * - 校验 type === 'custom_presets'
 * - 校验 packId 与当前 activePackId 一致（不一致弹确认）
 * - 调 customPresetStore.add(...) 逐条追加（不覆盖现有 user 项，靠 user_xxx ID 防冲突）
 *   —— 注意：不用 replaceAll，因为不应清掉用户已有的内容
 * - 成功后 toast 显示导入数量，并刷新创角面板（如打开）
 */
async function importCustomPresets(file: File): Promise<void> {
  if (!customPresetStore || isImportingPresets.value) return;
  isImportingPresets.value = true;
  try {
    const text = await file.text();
    const payload = JSON.parse(text) as CustomPresetsExportFile;
    if (payload.type !== 'custom_presets') {
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('save.presets.importFormatError'),
        duration: 3500,
      });
      return;
    }
    // CR-2026-04-14 P2-8：校验文件版本 —— 高于当前支持版本时拒绝
    const SUPPORTED_VERSION = 1;
    if (typeof payload.version !== 'number' || payload.version > SUPPORTED_VERSION) {
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('save.presets.importVersionError', { version: payload.version, supported: SUPPORTED_VERSION }),
        duration: 4000,
      });
      return;
    }
    const pid = activePackId.value || payload.packId;
    if (!pid) {
      eventBus.emit('ui:toast', { type: 'error', message: t('save.presets.noPack'), duration: 2500 });
      return;
    }
    if (payload.packId !== pid) {
      const confirmed = window.confirm(
        t('save.presets.importPackMismatch', { source: payload.packId, target: pid }),
      );
      if (!confirmed) return;
    }

    // CR-2026-04-14 P2-1：用 bulkAppend 取代逐条 add，N 条 → 单次 IDB load+save
    const presetsByType: Record<string, Record<string, unknown>[]> = {};
    for (const [presetType, list] of Object.entries(payload.presets ?? {})) {
      if (!Array.isArray(list)) continue;
      const cleaned: Record<string, unknown>[] = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        cleaned.push(raw as Record<string, unknown>);
      }
      if (cleaned.length > 0) presetsByType[presetType] = cleaned;
    }
    const added = await customPresetStore.bulkAppend(pid, presetsByType);
    const importedCount = added.length;

    eventBus.emit('ui:toast', {
      type: 'success',
      message: t('save.presets.importToast', { count: importedCount }),
      duration: 3000,
    });
    // 让创角面板等监听 customPresetStore 的组件刷新
    eventBus.emit('engine:custom-presets-changed', { packId: pid });
  } catch (err) {
    console.error('[SavePanel] importCustomPresets failed:', err);
    const msg = err instanceof Error ? err.message : String(err);
    eventBus.emit('ui:toast', {
      type: 'error',
      message: t('save.presets.importFailed', { error: msg.slice(0, 80) }),
      duration: 3500,
    });
  } finally {
    isImportingPresets.value = false;
  }
}

function openImportFilePicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await prepareImport(file);
  };
  input.click();
}

async function prepareImport(file: File): Promise<void> {
  backupImportError.value = '';
  fullImportAcknowledged.value = false;
  try {
    const text = await file.text();
    const raw = JSON.parse(text) as Record<string, unknown>;
    // Basic shape check — backupService.importAll does the full check
    if (typeof raw.version !== 'number' || typeof raw.exportedAt !== 'string') {
      backupImportError.value = t('save.backup.importError');
      eventBus.emit('ui:toast', { type: 'error', message: t('save.backup.importError'), duration: 2500 });
      return;
    }

    // 解析 bundleType：显式字段优先，否则根据 configs/prompts/engineSettings 推断
    const configs = (raw.configs as { overlays?: unknown[] } | undefined);
    const prompts = (raw.prompts as { entries?: unknown[] } | undefined);
    const engineSettings = (raw.engineSettings as Record<string, unknown> | undefined);
    const hasGlobalData =
      (Array.isArray(configs?.overlays) && configs!.overlays!.length > 0) ||
      (Array.isArray(prompts?.entries) && prompts!.entries!.length > 0) ||
      (engineSettings && Object.keys(engineSettings).length > 0);

    const bundleType: 'full' | 'profile' =
      raw.bundleType === 'full' || raw.bundleType === 'profile'
        ? raw.bundleType
        : hasGlobalData ? 'full' : 'profile';

    // 收集 profile 名称用于显示
    const profilesObj = (raw.profiles as Record<string, { characterName?: string; profileId?: string }>) ?? {};
    const profileNames = Object.entries(profilesObj).map(([pid, meta]) =>
      meta?.characterName || pid,
    );

    pendingImportInfo.value = {
      bundleType,
      profileCount: Object.keys(profilesObj).length,
      saveCount: Object.keys((raw.saves as Record<string, unknown>) ?? {}).length,
      vectorCount: Object.keys((raw.vectors as Record<string, unknown>) ?? {}).length,
      hasActiveProfile: !!(raw.activeProfile && typeof raw.activeProfile === 'object'),
      profileNames,
      exportedAt: raw.exportedAt as string,
    };

    pendingImportBlob.value = new Blob([text], { type: 'application/json' });
    showBackupConfirm.value = true;
  } catch (err) {
    console.error('[SavePanel] prepareImport failed:', err);
    backupImportError.value = t('save.backup.parseError');
    eventBus.emit('ui:toast', { type: 'error', message: t('save.backup.parseError'), duration: 2500 });
  }
}

async function executeImport(): Promise<void> {
  const blob = pendingImportBlob.value;
  const info = pendingImportInfo.value;
  if (!blob || !backupService || isImportingBackup.value || !info) return;

  // 全量导入需要用户明确勾选确认（破坏性操作）
  if (info.bundleType === 'full' && !fullImportAcknowledged.value) {
    eventBus.emit('ui:toast', {
      type: 'warning',
      message: t('save.import.acknowledgeRequired'),
      duration: 2500,
    });
    return;
  }

  isImportingBackup.value = true;
  showBackupConfirm.value = false;
  try {
    await backupService.importAll(blob);

    if (info.bundleType === 'full') {
      // 全量导入成功：标记自动恢复 + 提示 + 刷新页面
      sessionStorage.setItem('aga_post_import_resume', '1');
      eventBus.emit('ui:toast', {
        type: 'success',
        message: t('save.import.fullSuccess'),
        duration: 2000,
      });
      // 给 toast 一点时间显示，然后刷新
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      // 单角色合并导入：无需刷新页面，原地刷新 UI
      refreshSlots();
      eventBus.emit('ui:toast', {
        type: 'success',
        message: t('save.import.profileSuccess'),
        duration: 2500,
      });
    }
  } catch (err) {
    console.error('[SavePanel] executeImport failed:', err);
    const msg = err instanceof Error ? err.message : t('common.fallback.unknownError');
    eventBus.emit('ui:toast', { type: 'error', message: t('save.import.failed', { error: msg.slice(0, 120) }), duration: 5000 });
  } finally {
    isImportingBackup.value = false;
    pendingImportBlob.value = null;
    pendingImportInfo.value = null;
    fullImportAcknowledged.value = false;
  }
}

// ─── GitHub Cloud Sync ───────────────────────────────────────

import type { GitHubSyncService, SyncStatus, DegradedUploadDetail, CloudFormat, CloudInfo } from '@/engine/sync/github-sync';
import { DegradedUploadError } from '@/engine/sync/github-sync';
import CloudSlotsSection from '@/ui/components/cloud/CloudSlotsSection.vue';

const githubSync = inject<GitHubSyncService>('githubSync');

// 云端格式（由 CloudSlotsSection 探测上报）：v3/empty → 插槽列表接管，
// 经典整包上传/下载行隐藏；v2/unknown → 维持现状 UI（+ v2 时插槽区渲染迁移入口）
const ghCloudFormat = ref<CloudFormat | 'unknown'>('unknown');
const ghClassicVisible = computed(() => ghCloudFormat.value === 'v2' || ghCloudFormat.value === 'unknown');
const ghToken = ref(githubSync?.getToken() ?? '');
const ghOwner = ref(githubSync?.getOwner() ?? '');
const ghRepoName = ref(githubSync?.getRepoName() ?? 'aga-cloud-save');
const ghStatus = ref<SyncStatus>({ stage: 'idle', message: '' });
const ghUsername = ref('');
const ghShowToken = ref(false);
const ghCloudInfo = ref<CloudInfo | null>(null);

async function ghSaveToken(): Promise<void> {
  if (!githubSync) return;
  githubSync.setToken(ghToken.value);
  if (ghOwner.value.trim()) githubSync.setOwner(ghOwner.value);
  githubSync.setRepoName(ghRepoName.value);
  if (!ghToken.value.trim()) {
    ghUsername.value = '';
    ghCloudInfo.value = null;
    return;
  }
  ghStatus.value = { stage: 'checking', message: t('save.github.validating') };
  const result = await githubSync.validate();
  if (result.ok) {
    ghUsername.value = githubSync.getOwner();
    ghOwner.value = ghUsername.value;
    ghStatus.value = { stage: 'idle', message: '' };
    eventBus.emit('ui:toast', { type: 'success', message: t('save.github.connectedToast', { username: ghUsername.value }), duration: 2000 });
    void ghRefreshCloudInfo();
  } else {
    ghUsername.value = '';
    ghStatus.value = { stage: 'error', message: result.error ?? t('save.github.connectFailed') };
  }
}

async function ghRefreshCloudInfo(): Promise<void> {
  if (!githubSync || !ghToken.value) return;
  try {
    ghCloudInfo.value = await githubSync.getCloudInfo();
  } catch {
    ghCloudInfo.value = null;
  }
}

const ghBusy = () => ['checking', 'uploading', 'downloading'].includes(ghStatus.value.stage);

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
  eventBus.emit('ui:toast', { type: 'success', message: t('save.github.tokenCopied'), duration: 1200 });
}

const ghShowUploadConfirm = ref(false);
const ghUploadConfirmDetail = ref<DegradedUploadDetail | null>(null);

async function ghUpload(force = false): Promise<void> {
  if (!githubSync || ghBusy()) return;
  ghShowUploadConfirm.value = false;
  try {
    // Auto-save current state before uploading so cloud gets the latest data
    const pid = activeProfileId.value;
    const sid = activeSlotId.value;
    if (saveManager && pid && sid && store) {
      const snapshot = store.toSnapshot() as GameStateTree;
      await saveManager.saveGame(pid, sid, snapshot, {
        slotId: sid,
        slotName: sid,
        lastSavedAt: new Date().toISOString(),
        packId: activePackId.value ?? '',
        characterName: store.characterName,
        currentLocation: store.currentLocation,
        gameTime: store.gameTime,
        saveType: 'auto',
      });
    }
    await githubSync.upload((s) => { ghStatus.value = s; }, { force });
    void ghRefreshCloudInfo();
    refreshGhLastSync(); // manual upload moved the baseline → reflect it in the last-synced label
  } catch (err) {
    // Guardrail: the export would overwrite a healthy cloud backup with a degraded
    // (imageless) one. Do NOT auto-proceed — surface the specifics and require an
    // explicit second confirmation before re-uploading with force.
    if (err instanceof DegradedUploadError) {
      ghUploadConfirmDetail.value = err.detail;
      ghShowUploadConfirm.value = true;
      ghStatus.value = { stage: 'idle', message: '' };
      return;
    }
    ghStatus.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.github.uploadFailed') };
  }
}

function ghConfirmForcedUpload(): void {
  void ghUpload(true);
}

const ghShowDownloadConfirm = ref(false);

async function ghDownload(): Promise<void> {
  if (!githubSync || ghBusy()) return;
  ghShowDownloadConfirm.value = false;
  try {
    await githubSync.download((s) => { ghStatus.value = s; });
    sessionStorage.setItem('aga_post_import_resume', '1');
    eventBus.emit('ui:toast', { type: 'success', message: t('save.github.downloadSuccess'), duration: 2000 });
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    ghStatus.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.github.downloadFailed') };
  }
}

// Auto-validate on mount if token exists
if (githubSync?.isConfigured()) {
  void (async () => {
    const result = await githubSync.validate();
    if (result.ok) {
      ghUsername.value = githubSync.getOwner();
      void ghRefreshCloudInfo();
    }
  })();
}

// ── GitHub auto cloud-sync toggle (shared composable; engine runs in CloudSyncManager.vue) ──
const {
  autoSyncOn: ghAutoSync,
  lastSynced: ghLastSync,
  toggle: ghToggleAutoSync,
  refreshLastSync: refreshGhLastSync,
} = useCloudAutoSyncToggle(githubSync);

// ─── LAN Sync ────────────────────────────────────────────────

import type { LanSyncService } from '@/engine/sync/lan-sync';

const lanSync = inject<LanSyncService>('lanSync');
const lanAvailable = ref(false);
const lanEnabled = ref(lanSync?.isEnabled() ?? true);
const lanStatus = ref('');
const lanBusy = ref(false);

if (lanSync) {
  void lanSync.isAvailable().then((v) => { lanAvailable.value = v; });
}

function lanToggle(): void {
  lanEnabled.value = !lanEnabled.value;
  lanSync?.setEnabled(lanEnabled.value);
}

async function lanUpload(): Promise<void> {
  if (!lanSync || lanBusy.value) return;
  lanBusy.value = true;
  lanStatus.value = '';
  try {
    const result = await lanSync.upload();
    const kb = Math.round(result.size / 1024);
    lanStatus.value = t('save.github.uploadUploaded', { size: kb });
    eventBus.emit('ui:toast', { type: 'success', message: t('save.lan.uploadToast', { size: kb }), duration: 2000 });
  } catch (err) {
    lanStatus.value = err instanceof Error ? err.message : t('save.github.uploadFailed');
  } finally {
    lanBusy.value = false;
  }
}

async function lanDownload(): Promise<void> {
  if (!lanSync || lanBusy.value) return;
  lanBusy.value = true;
  lanStatus.value = '';
  try {
    await lanSync.download();
    sessionStorage.setItem('aga_post_import_resume', '1');
    eventBus.emit('ui:toast', { type: 'success', message: t('save.lan.downloadSuccess'), duration: 2000 });
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    lanStatus.value = err instanceof Error ? err.message : t('save.github.downloadFailed');
  } finally {
    lanBusy.value = false;
  }
}

// ─── UI state ─────────────────────────────────────────────────

const showSettings = ref(false);
</script>

<template>
  <div class="save-panel">
    <template v-if="isLoaded">
      <header class="panel-header">
        <h2 class="panel-title">{{ $t('save.title') }}</h2>
        <div class="header-actions">
          <Tooltip :text="$t('save.settingsTitle')" interactive>
            <button class="btn btn--ghost btn--sm" data-testid="save-settings-toggle" @click="showSettings = !showSettings" :class="{ 'btn--ghost-active': showSettings }">
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" /></svg>
            </button>
          </Tooltip>
          <AgaButton variant="primary" size="sm" type="button" @click="openNewSlotModal">{{ $t('save.newSlot') }}</AgaButton>
        </div>
      </header>

      <!-- ── GitHub Cloud Sync (always visible) ── -->
      <div class="gh-section gh-section--top">
        <div class="gh-header">
          <p class="settings-title">{{ $t('save.github.sectionTitle') }}</p>
          <span v-if="ghUsername" class="gh-badge">{{ ghUsername }}</span>
        </div>

        <!-- Not connected: config form -->
        <template v-if="!ghUsername">
          <p class="gh-hint">
            {{ $t('save.github.hintBefore') }}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="link-subtle">Personal Access Token</a>
            {{ $t('save.github.hintAfter') }}
          </p>
          <div class="gh-form">
            <div class="gh-field">
              <label class="gh-label">{{ $t('save.github.tokenLabel') }}</label>
              <div class="gh-token-row">
                <input :type="ghShowToken ? 'text' : 'password'" class="gh-input gh-input--mono" v-model="ghToken" :placeholder="$t('save.github.tokenPlaceholder')" spellcheck="false" autocomplete="off" />
                <Tooltip :text="ghShowToken ? $t('save.github.hideToken') : $t('save.github.showToken')" interactive>
                  <button class="gh-eye" @click="ghShowToken = !ghShowToken">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path v-if="ghShowToken" d="M.143 2.31a.75.75 0 0 1 1.047-.167l14 10a.75.75 0 1 1-.88 1.214l-2.248-1.606A7.4 7.4 0 0 1 8 13C3.353 13 .2 9.2.014 8.436a.8.8 0 0 1 0-.872A10.2 10.2 0 0 1 3.28 4.63L.31 3.357A.75.75 0 0 1 .143 2.31M5.09 5.92A3 3 0 0 0 8.91 10.08z" /><path v-else d="M8 2c4.647 0 7.8 3.8 7.986 4.564a.8.8 0 0 1 0 .872C15.8 8.2 12.647 12 8 12S.2 8.2.014 7.436a.8.8 0 0 1 0-.872C.2 5.8 3.353 2 8 2m0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4" /></svg>
                  </button>
                </Tooltip>
              </div>
            </div>
            <div class="gh-field">
              <label class="gh-label">{{ $t('save.github.repoLabel') }}</label>
              <input class="gh-input" v-model="ghRepoName" :placeholder="$t('save.github.repoPlaceholder')" spellcheck="false" />
            </div>
            <AgaButton class="gh-connect-btn" variant="primary" size="sm" @click="ghSaveToken" :disabled="ghStatus.stage === 'checking' || !ghToken.trim()">
              {{ ghStatus.stage === 'checking' ? $t('save.github.connecting') : $t('save.github.connectBtn') }}
            </AgaButton>
          </div>
        </template>

        <!-- Connected: sync actions -->
        <template v-else>
          <div v-if="ghClassicVisible" class="gh-cloud-row">
            <div class="gh-cloud-meta">
              <span v-if="ghCloudInfo?.exists" class="gh-cloud-info">
                {{ $t('save.github.cloudInfo', { time: ghCloudInfo.updatedAt ? formatDateTime(ghCloudInfo.updatedAt) : $t('common.fallback.unknown'), size: ghCloudInfo.sizeKB ?? 0 }) }}
                <template v-if="ghCloudInfo.uploadedByLabel"> · {{ $t('save.cloudSlots.uploadedBy', { device: ghCloudInfo.uploadedByLabel }) }}</template>
              </span>
              <span v-else-if="ghCloudInfo" class="gh-cloud-info gh-cloud-empty">{{ $t('save.github.cloudEmpty') }}</span>
            </div>
            <Tooltip :text="$t('save.github.copyToken')" interactive>
              <AgaButton class="gh-icon-btn" variant="ghost" size="sm" @click="ghCopyToken">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25z"/></svg>
              </AgaButton>
            </Tooltip>
            <div class="gh-actions">
              <AgaButton variant="primary" size="sm" :disabled="ghBusy()" @click="ghUpload()">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14zM8.53 1.22a.75.75 0 0 0-1.06 0L3.72 4.97a.75.75 0 0 0 1.06 1.06l2.47-2.47v6.69a.75.75 0 0 0 1.5 0V3.56l2.47 2.47a.75.75 0 1 0 1.06-1.06z"/></svg>
                {{ ghStatus.stage === 'uploading' ? $t('save.github.uploading') : $t('save.github.uploadBtn') }}
              </AgaButton>
              <AgaButton variant="secondary" size="sm" :disabled="ghBusy() || !ghCloudInfo?.exists" @click="ghShowDownloadConfirm = true">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14zM7.25 1.75a.75.75 0 0 1 1.5 0v6.69l2.47-2.47a.75.75 0 1 1 1.06 1.06L8.53 10.78a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 1.06-1.06l2.47 2.47z"/></svg>
                {{ ghStatus.stage === 'downloading' ? $t('save.github.downloading') : $t('save.github.downloadBtn') }}
              </AgaButton>
              <Tooltip :text="$t('save.github.disconnect')" interactive>
                <AgaButton class="gh-icon-btn" variant="danger" size="sm" @click="ghUsername = ''; ghToken = ''; githubSync?.setToken(''); ghCloudInfo = null">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06"/></svg>
                </AgaButton>
              </Tooltip>
            </div>
          </div>

          <!-- v3 存档插槽区（插槽列表 / v2 迁移入口 / 全部弹窗），格式上报驱动经典行显隐 -->
          <CloudSlotsSection @format="(f) => { ghCloudFormat = f; }" />

          <!-- Auto cloud-sync toggle — engine runs app-wide in CloudSyncManager.vue -->
          <div class="gh-autosync-row">
            <AgaToggle
              :modelValue="ghAutoSync"
              @update:modelValue="ghToggleAutoSync"
              :label="$t('save.autoSyncCloud.toggleLabel')"
              show-label
              data-testid="gh-autosync-toggle"
            />
            <span v-if="ghAutoSync && ghLastSync" class="gh-autosync-time">{{ $t('save.autoSyncCloud.lastSynced', { time: ghLastSync }) }}</span>
          </div>
          <p class="gh-autosync-hint">{{ $t('save.autoSyncCloud.toggleHint') }}</p>
        </template>

        <p v-if="ghStatus.stage === 'error'" class="gh-error">{{ ghStatus.message }}</p>
        <p v-else-if="ghStatus.stage !== 'idle' && ghStatus.stage !== 'done' && ghStatus.message" class="gh-status-msg">{{ ghStatus.message }}</p>
      </div>

      <!-- Story 5: game-card export — ALWAYS visible (this page's headline feature, not behind the gear) -->
      <section class="settings-section card-export-cta">
        <div class="card-export-cta__text">
          <p class="settings-title">{{ $t('save.export.entryTitle') }}</p>
          <p class="settings-hint">{{ $t('save.export.entryHint') }}</p>
        </div>
        <button class="btn btn--primary btn--sm card-export-cta__btn" @click="showCardExport = true">
          {{ $t('save.export.openBtn') }}
        </button>
      </section>

      <!-- ── Settings section (toggled) ── -->
      <Transition name="cfg-expand">
        <section v-if="showSettings" class="settings-section">
          <p class="settings-title">{{ $t('save.settingsTitle') }}</p>
          <div class="settings-row">
            <AgaToggle v-model="autoSaveSettings.timepointEnabled" :label="$t('save.autoSave.timepoint.label')" show-label />
            <Transition name="fade-in">
              <div v-if="autoSaveSettings.timepointEnabled" class="inline-row">
                <span class="cfg-label">{{ $t('save.autoSave.timepoint.every') }}</span>
                <input
                  class="cfg-num"
                  type="number"
                  min="1"
                  max="999"
                  v-model.number="autoSaveSettings.timepointInterval"
                />
                <span class="cfg-label">{{ $t('save.autoSave.timepoint.unit') }}</span>
              </div>
            </Transition>
          </div>
          <p class="settings-hint">{{ $t('save.autoSave.timepoint.hint') }}</p>

          <div class="backup-row">
            <p class="settings-title">{{ $t('save.backup.sectionTitle') }}</p>
            <p class="settings-hint backup-hint--full-width">{{ $t('save.backup.hint') }}</p>
            <p class="settings-hint backup-hint--full-width" style="color: var(--color-amber-400);">{{ $t('save.backup.fullBackup.secretWarning') }}</p>
            <AgaToggle class="backup-include-ref" v-model="includeReferenceAssets" :label="$t('save.backup.includeRef')" show-label />
            <p class="settings-hint backup-hint--full-width">{{ $t('save.backup.includeRefHint') }}</p>
            <div class="backup-btns">
              <button class="btn btn--secondary btn--sm" data-testid="backup-export" :disabled="isExportingBackup" @click="exportFullBackup">
                <span v-if="isExportingBackup" class="spinner" />
                {{ isExportingBackup ? $t('save.backup.exportBusy') : $t('save.backup.exportBtn') }}
              </button>
              <button class="btn btn--secondary btn--sm" data-testid="backup-import" :disabled="isImportingBackup" @click="openImportFilePicker">
                <span v-if="isImportingBackup" class="spinner" />
                {{ isImportingBackup ? $t('save.backup.restoreBusy') : $t('save.backup.restoreBtn') }}
              </button>
            </div>
            <p v-if="backupImportError" class="backup-error">{{ backupImportError }}</p>
          </div>

          <!-- ── LAN Sync (dev mode only) ── -->
          <div v-if="lanAvailable" class="gh-section">
            <div class="gh-header">
              <p class="settings-title">{{ $t('save.lan.sectionTitle') }}</p>
              <AgaToggle class="lan-toggle-label" :modelValue="lanEnabled" @update:modelValue="() => lanToggle()" :label="lanEnabled ? $t('save.lan.enabled') : $t('save.lan.disabled')" show-label />
            </div>
            <template v-if="lanEnabled">
              <p class="settings-hint">
                {{ $t('save.lan.hint') }}
              </p>
              <div class="gh-actions" style="margin-top: 8px">
                <AgaButton variant="primary" size="sm" :disabled="lanBusy" @click="lanUpload">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14zM8.53 1.22a.75.75 0 0 0-1.06 0L3.72 4.97a.75.75 0 0 0 1.06 1.06l2.47-2.47v6.69a.75.75 0 0 0 1.5 0V3.56l2.47 2.47a.75.75 0 1 0 1.06-1.06z"/></svg>
                  {{ lanBusy ? $t('save.lan.busy') : $t('save.lan.uploadBtn') }}
                </AgaButton>
                <AgaButton variant="secondary" size="sm" :disabled="lanBusy" @click="lanDownload">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14zM7.25 1.75a.75.75 0 0 1 1.5 0v6.69l2.47-2.47a.75.75 0 1 1 1.06 1.06L8.53 10.78a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 1.06-1.06l2.47 2.47z"/></svg>
                  {{ lanBusy ? $t('save.lan.busy') : $t('save.lan.downloadBtn') }}
                </AgaButton>
              </div>
              <p v-if="lanStatus" class="gh-status-msg">{{ lanStatus }}</p>
            </template>
          </div>

          <div class="backup-row">
            <p class="settings-title">{{ $t('save.presets.sectionTitle') }}</p>
            <p class="settings-hint">
              {{ $t('save.presets.hint') }}
            </p>
            <div class="backup-btns">
              <button
                class="btn btn--secondary btn--sm"
                :disabled="isExportingPresets || !customPresetStore"
                @click="exportCustomPresets"
              >
                <span v-if="isExportingPresets" class="spinner" />
                {{ isExportingPresets ? $t('save.presets.exportBusy') : $t('save.presets.exportBtn') }}
              </button>
              <button
                class="btn btn--secondary btn--sm"
                :disabled="isImportingPresets || !customPresetStore"
                @click="openCustomPresetImportPicker"
              >
                <span v-if="isImportingPresets" class="spinner" />
                {{ isImportingPresets ? $t('save.presets.importBusy') : $t('save.presets.importBtn') }}
              </button>
            </div>
          </div>
        </section>
      </Transition>

      <!-- ── Slot list ── -->
      <div class="slot-list">
        <div
          v-for="slot in slots"
          :key="slot.slotId"
          :data-testid="`save-slot-${slot.slotId}`"
          :class="['slot-card', { 'slot-card--active': isActiveSlot(slot.slotId) }]"
        >
          <div class="slot-header">
            <div class="slot-title-area">
              <span class="slot-name">{{ slot.slotName }}</span>
              <span v-if="isActiveSlot(slot.slotId)" class="badge badge--active">{{ $t('save.badge.active') }}</span>
              <span
                v-if="saveTypeBadge(slot.saveType)"
                :class="['badge', saveTypeBadge(slot.saveType)!.cls]"
              >{{ saveTypeBadge(slot.saveType)!.label }}</span>
            </div>
            <span class="slot-time">{{ formatTime(slot.lastSavedAt) }}</span>
          </div>

          <div v-if="slot.lastSavedAt" class="slot-info">
            <span v-if="slot.characterName" class="slot-detail">{{ slot.characterName }}</span>
            <span v-if="slot.characterStatus" class="slot-detail slot-detail--status">{{ slot.characterStatus }}</span>
            <span v-if="slot.currentLocation" class="slot-detail">{{ slot.currentLocation }}</span>
            <span v-if="slot.gameTime" class="slot-detail">{{ slot.gameTime }}</span>
            <span v-if="slot.saveSize" class="slot-detail slot-detail--size">{{ Math.round(slot.saveSize / 1024) }}KB</span>
          </div>

          <div class="slot-actions">
            <button class="action-btn action-btn--save" type="button" @click="initiatesSave(slot.slotId)">{{ $t('save.slot.save') }}</button>
            <button class="action-btn action-btn--load" type="button" :disabled="!slot.lastSavedAt" @click="loadSlot(slot.slotId)">{{ $t('save.slot.load') }}</button>
            <button
              class="action-btn action-btn--export"
              type="button"
              :disabled="!slot.lastSavedAt"
              @click="exportSingleSave(slot)"
            >{{ $t('save.slot.export') }}</button>
            <button
              class="action-btn action-btn--tocard"
              type="button"
              :data-testid="`save-slot-tocard-${slot.slotId}`"
              :disabled="!slot.lastSavedAt"
              @click="openToCard(slot.slotId)"
            >{{ $t('save.slot.toCard') }}</button>
            <Tooltip v-if="vectorStore && embedder" :text="$t('save.slot.vectors')" interactive>
              <button
                class="action-btn action-btn--rebuild"
                type="button"
                :disabled="!slot.lastSavedAt || rebuildingSlotId === slot.slotId"
                @click="rebuildVectors(slot.slotId)"
              >
                <span v-if="rebuildingSlotId === slot.slotId" class="spinner spinner--sm" />
                <span v-else>{{ $t('save.slot.vectors') }}</span>
              </button>
            </Tooltip>
            <button
              v-if="slot.slotId !== 'auto'"
              class="action-btn action-btn--delete"
              type="button"
              @click="deleteSlot(slot.slotId)"
            >{{ $t('save.slot.delete') }}</button>
          </div>
        </div>

        <p v-if="slots.length === 0" class="slots-empty-hint">
          {{ $t('save.emptySlots') }}
        </p>
      </div>
    </template>

    <div v-else class="empty-state">
      <p>{{ $t('save.noGame') }}</p>
    </div>

    <!-- Overwrite confirm -->
    <Modal v-model="confirmOverwrite" :title="$t('save.overwrite.title')" width="380px">
      <p class="confirm-text">{{ $t('save.overwrite.text') }}</p>
      <template #footer>
        <button class="btn btn--secondary" type="button" @click="confirmOverwrite = false">{{ $t('save.overwrite.cancel') }}</button>
        <button class="btn btn--danger" type="button" @click="confirmSave">{{ $t('save.overwrite.confirm') }}</button>
      </template>
    </Modal>

    <!-- New slot -->
    <Modal v-model="showNewSlotModal" :title="$t('save.newSlotModal.title')" width="380px">
      <div class="form-group">
        <label class="form-label">{{ $t('save.newSlotModal.nameLabel') }}</label>
        <input v-model="newSlotName" type="text" class="form-input" :placeholder="$t('save.newSlotModal.namePlaceholder')" @keydown.enter="createSlot" />
      </div>
      <template #footer>
        <button class="btn btn--secondary" type="button" @click="showNewSlotModal = false">{{ $t('save.newSlotModal.cancel') }}</button>
        <button class="btn btn--primary" type="button" @click="createSlot">{{ $t('save.newSlotModal.create') }}</button>
      </template>
    </Modal>

    <!-- Backup import confirm -->
    <Modal
      v-model="showBackupConfirm"
      :title="pendingImportInfo?.bundleType === 'full' ? $t('save.import.fullBackupTitle') : $t('save.import.profileTitle')"
      width="460px"
    >
      <div v-if="pendingImportInfo" class="import-preview">
        <!-- 备份类型标签 -->
        <div class="import-badge-row">
          <span
            v-if="pendingImportInfo.bundleType === 'full'"
            class="import-badge import-badge--full"
          >{{ $t('save.import.badgeFull') }}</span>
          <span v-else class="import-badge import-badge--profile">{{ $t('save.import.badgeProfile') }}</span>
        </div>

        <!-- 基本信息 -->
        <div class="import-info">
          <div class="import-info__row">
            <span class="import-info__label">{{ $t('save.import.exportedAt') }}</span>
            <span class="import-info__value">{{ formatDateTime(pendingImportInfo.exportedAt) }}</span>
          </div>
          <div class="import-info__row">
            <span class="import-info__label">{{ $t('save.import.profileCount') }}</span>
            <span class="import-info__value">{{ $t('save.import.profileCountValue', { count: pendingImportInfo.profileCount }) }}</span>
          </div>
          <div class="import-info__row">
            <span class="import-info__label">{{ $t('save.import.saveCount') }}</span>
            <span class="import-info__value">{{ $t('save.import.saveCountValue', { count: pendingImportInfo.saveCount }) }}</span>
          </div>
          <div v-if="pendingImportInfo.vectorCount > 0" class="import-info__row">
            <span class="import-info__label">{{ $t('save.import.vectorCount') }}</span>
            <span class="import-info__value">{{ $t('save.import.vectorCountValue', { count: pendingImportInfo.vectorCount }) }}</span>
          </div>
          <div v-if="pendingImportInfo.hasActiveProfile" class="import-info__row">
            <span class="import-info__label">{{ $t('save.import.activeGame') }}</span>
            <span class="import-info__value">{{ $t('save.import.activeGameValue') }}</span>
          </div>
        </div>

        <!-- 角色列表 -->
        <div v-if="pendingImportInfo.profileNames.length > 0" class="import-profiles">
          <span class="import-profiles__label">{{ pendingImportInfo.bundleType === 'full' ? $t('save.import.profileListFull') : $t('save.import.profileListProfile') }}</span>
          <div class="import-profiles__list">
            <span
              v-for="name in pendingImportInfo.profileNames"
              :key="name"
              class="import-profile-chip"
            >{{ name }}</span>
          </div>
        </div>

        <!-- 警告 -->
        <div
          v-if="pendingImportInfo.bundleType === 'full'"
          class="import-warning import-warning--danger"
        >
          <strong>⚠ {{ $t('save.import.warningFull') }}</strong>
          <ul class="import-warning__list">
            <li>{{ $t('save.import.warningFullList1') }}</li>
            <li>{{ $t('save.import.warningFullList2') }}</li>
            <li>{{ $t('save.import.warningFullList3') }}</li>
            <li>{{ $t('save.import.warningFullList4') }}</li>
          </ul>
          <AgaToggle class="import-acknowledge" v-model="fullImportAcknowledged" data-testid="backup-acknowledge" :label="$t('save.import.acknowledge')" show-label />
        </div>
        <div v-else class="import-warning import-warning--info">
          <strong>{{ $t('save.import.warningProfile') }}</strong>
          <p class="import-warning__text">{{ $t('save.import.warningProfileHint') }}</p>
        </div>
      </div>

      <template #footer>
        <button
          class="btn btn--secondary"
          :disabled="isImportingBackup"
          @click="showBackupConfirm = false"
        >{{ $t('save.import.cancel') }}</button>
        <button
          class="btn"
          data-testid="backup-confirm"
          :class="pendingImportInfo?.bundleType === 'full' ? 'btn--danger' : 'btn--primary'"
          :disabled="isImportingBackup || (pendingImportInfo?.bundleType === 'full' && !fullImportAcknowledged)"
          @click="executeImport"
        >
          <span v-if="isImportingBackup" class="spinner" />
          {{ isImportingBackup ? $t('save.import.restoring') : (pendingImportInfo?.bundleType === 'full' ? $t('save.import.confirmFull') : $t('save.import.confirmProfile')) }}
        </button>
      </template>
    </Modal>

    <!-- GitHub download confirm -->
    <Modal v-model="ghShowDownloadConfirm" :title="$t('save.github.downloadConfirmTitle')" width="400px">
      <p class="confirm-text confirm-text--danger">
        {{ $t('save.github.downloadConfirmText') }}
      </p>
      <template #footer>
        <AgaButton variant="secondary" @click="ghShowDownloadConfirm = false">{{ $t('save.github.downloadConfirmCancel') }}</AgaButton>
        <AgaButton variant="danger" @click="ghDownload">{{ $t('save.github.downloadConfirmOk') }}</AgaButton>
      </template>
    </Modal>

    <!-- GitHub degraded-upload guard: hard block + explicit second confirmation -->
    <Modal v-model="ghShowUploadConfirm" :title="$t('save.github.uploadGuardTitle')" width="440px">
      <p class="confirm-text confirm-text--danger">
        {{ $t('save.github.uploadGuardText') }}
      </p>
      <p v-if="ghUploadConfirmDetail" class="upload-guard-detail">
        {{ $t('save.github.uploadGuardMissing', { referenced: ghUploadConfirmDetail.referencedAssets, missing: ghUploadConfirmDetail.missingAssets }) }}
      </p>
      <p class="confirm-warning">{{ $t('save.github.uploadGuardHint') }}</p>
      <template #footer>
        <AgaButton variant="secondary" @click="ghShowUploadConfirm = false">{{ $t('save.github.uploadGuardCancel') }}</AgaButton>
        <AgaButton variant="danger" @click="ghConfirmForcedUpload">{{ $t('save.github.uploadGuardConfirm') }}</AgaButton>
      </template>
    </Modal>

    <!-- Story 5: game-card export flow (self-contained modal) -->
    <CardExportFlow v-model="showCardExport" />
    <SaveToCardFlow v-model="showToCard" :target="toCardTarget" />
  </div>
</template>

<style scoped>
.save-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet);
  height: 100%;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── Settings section ── */
.settings-section {
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

.settings-title {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-secondary, #8888a0);
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.inline-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.cfg-label {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
}

.cfg-num {
  width: 54px;
  padding: 3px 7px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 5px;
  color: var(--color-text, #e0e0e6);
  font-size: 0.82rem;
  text-align: center;
}
.cfg-num:focus { outline: none; border-color: var(--color-primary, #6366f1); }

.settings-hint {
  margin: 0;
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  font-style: italic;
}

.backup-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.05);
}

.backup-btns {
  display: flex;
  gap: 6px;
}

.backup-error {
  margin: 6px 0 0;
  font-size: 0.75rem;
  color: var(--color-danger, #e05c5c);
  width: 100%;
}

/* ── Include-ref toggle row ── */
.backup-include-ref {
  width: 100%;
}
.backup-hint--full-width {
  width: 100%;
  margin: 0;
}

/* ── GitHub Sync ── */
.gh-section {
  padding: 12px 14px;
  border-radius: 8px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  margin-top: 10px;
  box-shadow: var(--lumi-inset-highlight);
}
.gh-section--top {
  margin-top: 0;
  position: relative;
  z-index: 1;
}
.gh-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.gh-header .settings-title { margin: 0; }
.gh-hint {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  line-height: 1.5;
  margin: 0 0 10px;
}
.gh-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 8px;
  align-items: center;
}
.gh-field {
  display: contents;
}
.gh-label {
  grid-column: 1;
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  margin-bottom: -4px;
}
.gh-input {
  grid-column: 1;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px;
  padding: 5px 8px;
  font-size: 0.78rem;
  color: inherit;
  outline: none;
  transition: border-color 0.2s;
}
.gh-input:focus { border-color: rgba(255,255,255,0.25); }
.gh-input--mono { font-family: monospace; font-size: 0.72rem; }
.gh-token-row {
  grid-column: 1;
  display: flex;
  gap: 4px;
}
.gh-token-row .gh-input { flex: 1; }
.gh-eye {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px;
  color: var(--color-text-secondary, #8888a0);
  cursor: pointer;
  transition: background 0.15s;
}
.gh-eye:hover { background: rgba(255,255,255,0.1); }
/* Layout-only: AgaButton provides the primary visual treatment; this just
   places the button in the GitHub config grid. */
.gh-connect-btn {
  grid-column: 2;
  grid-row: 2 / 4;
  align-self: stretch;
  white-space: nowrap;
}
.gh-badge {
  font-size: 0.7rem;
  color: var(--color-success, #22c55e);
  background: rgba(34,197,94,0.1);
  border-radius: 10px;
  padding: 2px 10px;
  letter-spacing: 0.02em;
}
.gh-cloud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.gh-cloud-meta { flex: 1; min-width: 0; }
.gh-cloud-info {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}
.gh-cloud-empty { font-style: italic; }
.gh-actions {
  display: flex;
  gap: 4px;
}
/* icon-only AgaButton: tighten padding so the X / copy glyph reads as a compact chip */
.gh-icon-btn { padding: var(--space-2xs) var(--space-xs); }
.gh-autosync-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.gh-autosync-time {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}
.gh-autosync-hint {
  margin: 4px 0 0;
  font-size: 0.72rem;
  font-style: italic;
  color: var(--color-text-secondary, #8888a0);
}
.lan-toggle-label {
  font-size: 0.72rem;
}
.gh-error {
  margin: 6px 0 0;
  font-size: 0.72rem;
  color: var(--color-danger, #e05c5c);
}
.gh-status-msg {
  margin: 6px 0 0;
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}
.link-subtle {
  color: var(--color-accent, #60a5fa);
  text-decoration: none;
}
.link-subtle:hover { text-decoration: underline; }

/* ── Slot list ── */
.slot-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.slots-empty-hint {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #8888a0);
  margin: 0.5rem 0 0;
}

.slot-card {
  padding: 14px 16px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 10px;
  transition: border-color 0.15s ease;
}
.slot-card:hover { border-color: color-mix(in oklch, var(--color-sage-400) 30%, transparent); background: linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 3%, transparent), transparent 60%); }
.slot-card--active {
  border-color: var(--color-sage-400);
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 6%, transparent),
    color-mix(in oklch, var(--color-sage-400) 3%, transparent));
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

.slot-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.slot-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slot-name {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
}

/* ── Badges ── */
.badge {
  font-size: 0.6rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.badge--active   { color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-400) 15%, transparent); }
.badge--info     { color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-300) 12%, transparent); }
.badge--warning  { color: var(--color-amber-400); background: color-mix(in oklch, var(--color-amber-400) 12%, transparent); }
/* exit-state save: neutral umber (a muted "terminal/past" tone, distinct from the
   amber warning badge — the sanctuary palette has no violet). */
.badge--exit     { color: var(--color-text-umber); background: color-mix(in oklch, var(--color-text-umber) 14%, transparent); }

.slot-time {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}

.slot-info {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.slot-detail {
  font-size: 0.75rem;
  color: var(--color-text-secondary, #8888a0);
}
.slot-detail--status { color: var(--color-sage-300); font-weight: 500; }
.slot-detail--size { font-family: 'JetBrains Mono','Fira Code',monospace; margin-left: auto; }

.slot-actions {
  display: flex;
  gap: 6px;
  border-top: 1px solid rgba(255,255,255,0.04);
  padding-top: 10px;
}

.action-btn {
  padding: 5px 12px;
  font-size: 0.76rem;
  font-weight: 600;
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
  color: var(--color-text-secondary, #8888a0);
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}
.action-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.action-btn--save:hover:not(:disabled)    { color: var(--color-success,#22c55e); border-color: var(--color-success,#22c55e); background: color-mix(in oklch, var(--color-success) 8%, transparent); box-shadow: 0 0 10px color-mix(in oklch, var(--color-success) 15%, transparent); }
.action-btn--load:hover:not(:disabled)    { color: var(--color-sage-300); border-color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-400) 15%, transparent); }
.action-btn--export:hover:not(:disabled)  { color: var(--color-sage-300); border-color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-300) 8%, transparent); box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-300) 15%, transparent); }
.action-btn--tocard:hover:not(:disabled)  { color: var(--color-amber-400); border-color: var(--color-amber-400); background: color-mix(in oklch, var(--color-amber-400) 8%, transparent); box-shadow: 0 0 10px color-mix(in oklch, var(--color-amber-400) 15%, transparent); }
.action-btn--rebuild:hover:not(:disabled) { color: var(--color-amber-300); border-color: var(--color-amber-300); background: color-mix(in oklch, var(--color-amber-400) 8%, transparent); }
.action-btn--delete:hover:not(:disabled)  { color: var(--color-danger,#ef4444); border-color: var(--color-danger,#ef4444); background: color-mix(in oklch, var(--color-danger) 8%, transparent); }

/* ── Buttons ── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 14px;
  border: none;
  border-radius: 8px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--primary   { background: var(--color-sage-muted); color: var(--color-sage-100); border: 1px solid color-mix(in oklch, var(--color-sage-400) 35%, transparent); }
.btn--primary:not(:disabled):hover { opacity: 0.88; }
.btn--secondary { background: rgba(255,255,255,0.06); color: var(--color-text); border: 1px solid var(--color-border); }
.btn--secondary:not(:disabled):hover { background: rgba(255,255,255,0.1); }
.btn--danger    { background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text)); border: 1px solid color-mix(in oklch, var(--color-danger) 40%, transparent); }
.btn--danger:not(:disabled):hover { opacity: 0.88; }
.btn--ghost     { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: 7px; padding: 5px; }
.btn--ghost:hover, .btn--ghost-active { color: var(--color-sage-300); border-color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); }
.btn--sm { padding: 4px 10px; font-size: 0.76rem; border-radius: 6px; }

/* ── Spinner ── */
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255,255,255,0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}
.spinner--sm { width: 10px; height: 10px; }

@keyframes spin { to { transform: rotate(360deg); } }

/* ── Modal form ── */
.confirm-text {
  font-size: 0.88rem;
  color: var(--color-text, #e0e0e6);
  line-height: 1.6;
  margin: 0 0 8px;
}
.confirm-text--danger { color: var(--color-danger); }
.upload-guard-detail {
  margin: 4px 0 8px;
  padding-left: 18px;
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  line-height: 1.5;
}
.upload-guard-detail li { margin: 2px 0; }
.confirm-warning {
  font-size: 0.78rem;
  color: var(--color-amber-400);
  margin: 0;
  padding: 7px 10px;
  background: color-mix(in oklch, var(--color-amber-400) 7%, transparent);
  border-radius: 6px;
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--color-amber-400) 40%, transparent);
}
.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 0.78rem; font-weight: 600; color: var(--color-text-secondary,#8888a0); }
.form-input {
  padding: 8px 12px;
  font-size: 0.85rem;
  color: var(--color-text,#e0e0e6);
  background: var(--color-bg,#0f0f14);
  border: 1px solid var(--color-border,#2a2a3a);
  border-radius: 6px;
  outline: none;
  font-family: inherit;
}
.form-input:focus { border-color: var(--color-primary,#6366f1); }

/* ── Story 5: game-card export CTA (always-visible, accented) ── */
.card-export-cta {
  /* override .settings-section's column so text sits left, button right */
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 28%, transparent);
}
.card-export-cta__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
}
.card-export-cta__btn { flex-shrink: 0; }

/* ── Transitions ── */
.cfg-expand-enter-active { transition: all 0.2s ease; }
.cfg-expand-leave-active { transition: all 0.15s ease; }
.cfg-expand-enter-from,
.cfg-expand-leave-to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; }
.cfg-expand-enter-to,
.cfg-expand-leave-from { opacity: 1; max-height: 400px; }

.fade-in-enter-active { transition: opacity 0.15s ease; }
.fade-in-leave-active { transition: opacity 0.1s ease; }
.fade-in-enter-from, .fade-in-leave-to { opacity: 0; }

/* ── Empty ── */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.88rem;
}

/* ── Scrollbar ── */
.save-panel::-webkit-scrollbar { width: 5px; }
.save-panel::-webkit-scrollbar-track { background: transparent; }
.save-panel::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

/* ── Backup import preview dialog ── */
.import-preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import-badge-row {
  display: flex;
}

.import-badge {
  display: inline-flex;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.import-badge--full {
  background: color-mix(in oklch, var(--color-danger) 12%, transparent);
  color: var(--color-danger-hover);
  border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-danger) 15%, transparent);
}
.import-badge--profile {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  color: var(--color-sage-300);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}

.import-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border: 1px solid var(--color-border, #2a2a3a);
}
.import-info__row {
  display: flex;
  justify-content: space-between;
  font-size: 0.82rem;
}
.import-info__label {
  color: var(--color-text-secondary, #8888a0);
}
.import-info__value {
  color: var(--color-text, #e0e0e6);
  font-weight: 500;
}

.import-profiles {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-profiles__label {
  font-size: 0.74rem;
  color: var(--color-text-secondary, #8888a0);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.import-profiles__list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.import-profile-chip {
  display: inline-flex;
  padding: 3px 9px;
  font-size: 0.76rem;
  color: var(--color-text, #e0e0e6);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 12px;
}

.import-warning {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 0.82rem;
  line-height: 1.5;
}
.import-warning--danger {
  background: color-mix(in oklch, var(--color-danger) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 25%, transparent);
  color: var(--color-danger-hover);
}
.import-warning--danger strong {
  color: var(--color-danger-hover);
}
.import-warning--info {
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  color: var(--color-text, #e0e0e6);
}
.import-warning--info strong {
  color: var(--color-sage-300);
}
.import-warning__list {
  margin: 0;
  padding-left: 18px;
  font-size: 0.78rem;
  color: var(--color-text-secondary, #c5c5d0);
}
.import-warning__list li {
  margin-bottom: 2px;
}
.import-warning__text {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
}

.import-acknowledge {
  padding-top: 6px;
  border-top: 1px dashed color-mix(in oklch, var(--color-danger) 25%, transparent);
}

/* ─── Mobile: sidebar reserve is 0px — provide minimum padding ─── */
@media (max-width: 767px) {
  .save-panel {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
  .gh-cloud-row {
    flex-wrap: wrap;
  }
  .gh-cloud-meta {
    width: 100%;
    margin-bottom: 6px;
  }
  .gh-actions {
    flex-wrap: wrap;
  }
  .gh-form {
    grid-template-columns: 1fr;
  }
  .gh-connect-btn {
    grid-column: 1;
    grid-row: auto;
    margin-top: 4px;
  }
  .backup-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .slot-actions {
    flex-wrap: wrap;
  }
}
</style>
