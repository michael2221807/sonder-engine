<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.2.1 (存档插槽), docs/user-guide/pages/home.md §1.3.3, docs/user-guide/cloud-sync.md (存档插槽章节)
// Design doc: docs/design/github-save-slots-design.md §7
/**
 * CloudSlotsSection — 云端存档插槽区（v3）
 *
 * 消费方：SavePanel（GitHub 区）+ HomeView（云弹窗）。仅在 GitHub 已连接时渲染。
 * 职责（docs/design/github-save-slots-design.md §7）：
 * - 探测云端格式：v2 → 显示"升级云端为插槽格式"入口 + 迁移进度弹窗（父级保留经典
 *   整包上传/下载 UI）；v3/empty → 插槽列表接管
 * - 插槽列表 = 本地档案 ∪ 云端插槽：本地有→可上传；云端有→可下载/删除（二次确认，
 *   Q6）；global 设置插槽单独一行
 * - 下载成功 → 询问是否切换到该档案（Q3）；新设备（本地零档案首次下载）追加
 *   "是否同时恢复设置"提示
 * - 退化上传拦截：显示缺图明细 + 显式二次确认后才 force
 * - v3 模式下检测 v2 复活（另一台设备仍在用旧版）→ 显著警告条
 */
import { ref, computed, inject, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import {
  DegradedUploadError, GLOBAL_SLOT_KEY,
  type GitHubSyncService, type CloudFormat, type CloudSlotInfo, type SyncStatus, type DegradedUploadDetail,
} from '@/engine/sync/github-sync';
import type { ProfileManager } from '@/engine/persistence/profile-manager';

const { t } = useI18n();
const githubSync = inject<GitHubSyncService>('githubSync');
const profileManager = inject<ProfileManager>('profileManager');

const emit = defineEmits<{
  /** 云端格式探测结果，父级据此隐藏/显示经典 v2 整包 UI */
  (e: 'format', format: CloudFormat): void;
}>();

// ── 状态 ──

const format = ref<CloudFormat | 'unknown'>('unknown');
const cloudSlots = ref<CloudSlotInfo[]>([]);
const status = ref<SyncStatus>({ stage: 'idle', message: '' });
/** 正在进行云操作的行（profileId / 'global' / 'migrate'），用于按行禁用与 spinner */
const busyKey = ref<string | null>(null);
const v2Revived = ref(false);

const localProfiles = computed(() => {
  try {
    return (profileManager?.listProfiles() ?? []).map((p) => ({
      profileId: p.profileId,
      name: p.characterName || p.profileId,
      slotCount: Object.keys(p.slots).length,
    }));
  } catch {
    return [];
  }
});

interface SlotRow {
  slotKey: string;
  name: string;
  local: boolean;
  cloud: CloudSlotInfo | null;
}

/** 本地档案 ∪ 云端插槽（global 行单列，不进这里） */
const rows = computed<SlotRow[]>(() => {
  const cloudByKey = new Map(cloudSlots.value.filter((s) => s.slotKey !== GLOBAL_SLOT_KEY).map((s) => [s.slotKey, s]));
  const out: SlotRow[] = [];
  for (const p of localProfiles.value) {
    out.push({ slotKey: p.profileId, name: p.name, local: true, cloud: cloudByKey.get(p.profileId) ?? null });
    cloudByKey.delete(p.profileId);
  }
  for (const [, s] of cloudByKey) {
    out.push({ slotKey: s.slotKey, name: s.profileName || s.slotKey, local: false, cloud: s });
  }
  return out;
});

const globalSlot = computed(() => cloudSlots.value.find((s) => s.slotKey === GLOBAL_SLOT_KEY) ?? null);
const isBusy = computed(() => busyKey.value !== null);

// ── 刷新 ──

async function refresh(): Promise<void> {
  if (!githubSync?.isConfigured()) return;
  try {
    const f = await githubSync.detectCloudFormat();
    format.value = f;
    emit('format', f);
    if (f === 'v3' || f === 'empty') {
      cloudSlots.value = f === 'v3' ? await githubSync.listCloudSlots() : [];
    }
    if (f === 'v3') {
      void githubSync.checkV2Revival().then((r) => { v2Revived.value = r.revived; }).catch(() => { /* 探测失败不打扰 */ });
    }
  } catch (err) {
    status.value = { stage: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

onMounted(() => { void refresh(); });
defineExpose({ refresh });

// ── 上传（含退化拦截二次确认）──

const degradedDetail = ref<DegradedUploadDetail | null>(null);
const degradedSlotKey = ref<string | null>(null);

async function uploadSlotUi(profileId: string, force = false): Promise<void> {
  if (!githubSync || isBusy.value) return;
  degradedDetail.value = null;
  busyKey.value = profileId;
  try {
    await githubSync.uploadSlot(profileId, (s) => { status.value = s; }, { force });
    eventBus.emit('ui:toast', { type: 'success', message: t('save.cloudSlots.uploadDone'), duration: 2000 });
    await refresh();
    status.value = { stage: 'idle', message: '' };
  } catch (err) {
    if (err instanceof DegradedUploadError) {
      degradedDetail.value = err.detail;
      degradedSlotKey.value = profileId;
      status.value = { stage: 'idle', message: '' };
    } else {
      status.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.cloudSlots.uploadFailed') };
    }
  } finally {
    busyKey.value = null;
  }
}

function confirmDegradedUpload(): void {
  const key = degradedSlotKey.value;
  degradedDetail.value = null;
  degradedSlotKey.value = null;
  if (key) void uploadSlotUi(key, true);
}

async function uploadGlobalUi(): Promise<void> {
  if (!githubSync || isBusy.value) return;
  busyKey.value = GLOBAL_SLOT_KEY;
  try {
    const { skipped } = await githubSync.uploadGlobal((s) => { status.value = s; });
    eventBus.emit('ui:toast', {
      type: 'success',
      message: skipped ? t('save.cloudSlots.globalUnchanged') : t('save.cloudSlots.globalUploaded'),
      duration: 2000,
    });
    await refresh();
    status.value = { stage: 'idle', message: '' };
  } catch (err) {
    status.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.cloudSlots.uploadFailed') };
  } finally {
    busyKey.value = null;
  }
}

// ── 下载（Q3 切换询问 + 新设备设置提示）──

const downloadConfirmKey = ref<string | null>(null);
const switchAskProfile = ref<{ profileId: string; name: string } | null>(null);
const askRestoreSettings = ref(false);

async function downloadSlotUi(profileId: string): Promise<void> {
  if (!githubSync || isBusy.value) return;
  downloadConfirmKey.value = null;
  // 新设备判定要在导入**之前**取样：导入后本地就有档案了
  const wasFreshDevice = localProfiles.value.length === 0;
  busyKey.value = profileId;
  try {
    await githubSync.downloadSlot(profileId, (s) => { status.value = s; });
    status.value = { stage: 'idle', message: '' };
    const name = cloudSlots.value.find((s) => s.slotKey === profileId)?.profileName || profileId;
    askRestoreSettings.value = wasFreshDevice && !!globalSlot.value;
    switchAskProfile.value = { profileId, name };
  } catch (err) {
    status.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.cloudSlots.downloadFailed') };
  } finally {
    busyKey.value = null;
  }
}

/**
 * 该档案"最近游玩"的槽位（lastSavedAt 最大者）——与 HomeView.getMostRecentSlot
 * 的既有约定一致；绝不能用 Object.keys()[0]（插入序），否则多槽档案切换后会掉进
 * 最旧的槽（审查 2026-07-23 Imp#3）。
 */
function mostRecentSlotId(profileId: string): string | undefined {
  const meta = profileManager?.getProfile(profileId);
  if (!meta) return undefined;
  let best: string | undefined;
  let bestAt = '';
  for (const [sid, slot] of Object.entries(meta.slots)) {
    const at = slot.lastSavedAt ?? '';
    if (best === undefined || at > bestAt) { best = sid; bestAt = at; }
  }
  return best;
}

/** Q3 弹窗动作：切换与否都需 reload（档案数据已被替换），切换先改活跃指针。 */
async function finishDownload(switchTo: boolean): Promise<void> {
  const target = switchAskProfile.value;
  switchAskProfile.value = null;
  askRestoreSettings.value = false; // 仅关提示；"先恢复设置"走独立按钮 restoreSettingsThenFinish
  if (switchTo && target && profileManager) {
    try {
      const slotId = mostRecentSlotId(target.profileId);
      if (slotId) await profileManager.setActiveProfile(target.profileId, slotId);
    } catch { /* 指针切换失败不阻塞 reload */ }
  }
  sessionStorage.setItem('aga_post_import_resume', '1');
  window.location.reload();
}

async function downloadGlobalUi(): Promise<void> {
  if (!githubSync || isBusy.value) return;
  busyKey.value = GLOBAL_SLOT_KEY;
  try {
    await githubSync.downloadGlobal((s) => { status.value = s; });
    eventBus.emit('ui:toast', { type: 'success', message: t('save.cloudSlots.globalDownloaded'), duration: 2000 });
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    status.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.cloudSlots.downloadFailed') };
  } finally {
    busyKey.value = null;
  }
}

/** 新设备下载档案后的"同时恢复设置"确认：先下设置，再进入切换流程。 */
async function restoreSettingsThenFinish(): Promise<void> {
  askRestoreSettings.value = false;
  if (!githubSync) return;
  const target = switchAskProfile.value;
  switchAskProfile.value = null;
  busyKey.value = GLOBAL_SLOT_KEY;
  try {
    await githubSync.downloadGlobal((s) => { status.value = s; });
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'warning', message: err instanceof Error ? err.message : t('save.cloudSlots.downloadFailed'), duration: 4000 });
  } finally {
    busyKey.value = null;
  }
  if (target && profileManager) {
    try {
      const slotId = mostRecentSlotId(target.profileId);
      if (slotId) await profileManager.setActiveProfile(target.profileId, slotId);
    } catch { /* 不阻塞 */ }
  }
  sessionStorage.setItem('aga_post_import_resume', '1');
  window.location.reload();
}

// ── 删除（Q6 显式二次确认）──

const deleteConfirmKey = ref<string | null>(null);

async function deleteSlotUi(profileId: string): Promise<void> {
  if (!githubSync || isBusy.value) return;
  deleteConfirmKey.value = null;
  busyKey.value = profileId;
  try {
    await githubSync.deleteCloudSlot(profileId, (s) => { status.value = s; });
    eventBus.emit('ui:toast', { type: 'success', message: t('save.cloudSlots.deleteDone'), duration: 2000 });
    await refresh();
    status.value = { stage: 'idle', message: '' };
  } catch (err) {
    status.value = { stage: 'error', message: err instanceof Error ? err.message : t('save.cloudSlots.deleteFailed') };
  } finally {
    busyKey.value = null;
  }
}

// ── 迁移（v2 → v3，显式触发）──

const showMigrateConfirm = ref(false);
const migrateProgress = ref<Array<{ slotKey: string; phase: 'uploading' | 'verifying' | 'verified' }>>([]);
const migrating = ref(false);
const migrateError = ref('');
const migrateDone = ref<{ v2Cleaned: boolean } | null>(null);

function slotDisplayName(slotKey: string): string {
  if (slotKey === GLOBAL_SLOT_KEY) return t('save.cloudSlots.globalRow');
  return localProfiles.value.find((p) => p.profileId === slotKey)?.name ?? slotKey;
}

async function runMigration(): Promise<void> {
  if (!githubSync || isBusy.value) return;
  showMigrateConfirm.value = false;
  migrating.value = true;
  migrateError.value = '';
  migrateDone.value = null;
  migrateProgress.value = [];
  busyKey.value = 'migrate';
  try {
    const result = await githubSync.migrateToSlots(
      (s) => { status.value = s; },
      (p) => {
        const existing = migrateProgress.value.find((x) => x.slotKey === p.slotKey);
        if (existing) existing.phase = p.phase;
        else migrateProgress.value.push({ ...p });
      },
    );
    migrateDone.value = { v2Cleaned: result.v2Cleaned };
    status.value = { stage: 'idle', message: '' };
    // 广播格式切换：CloudSyncManager 即时改走 v3 插槽管线，无需刷新页面
    eventBus.emit('ui:cloud-format-changed', { format: 'v3' });
    await refresh();
  } catch (err) {
    migrateError.value = err instanceof DegradedUploadError
      ? t('save.cloudSlots.migrateDegraded', { missing: err.detail.missingAssets, total: err.detail.referencedAssets })
      : (err instanceof Error ? err.message : String(err));
  } finally {
    migrating.value = false;
    busyKey.value = null;
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
</script>

<template>
  <div v-if="githubSync?.isConfigured()" class="cloud-slots" data-testid="cloud-slots-section">
    <!-- v2：迁移入口（经典整包 UI 由父级继续渲染） -->
    <div v-if="format === 'v2'" class="cs-migrate-card">
      <div class="cs-migrate-text">
        <p class="cs-migrate-title">{{ t('save.cloudSlots.migrateTitle') }}</p>
        <p class="cs-migrate-hint">{{ t('save.cloudSlots.migrateHint') }}</p>
      </div>
      <AgaButton variant="secondary" size="sm" :disabled="isBusy" data-testid="cs-migrate-btn" @click="showMigrateConfirm = true">
        {{ t('save.cloudSlots.migrateBtn') }}
      </AgaButton>
    </div>

    <!-- v3 / empty：插槽列表 -->
    <template v-else-if="format === 'v3' || format === 'empty'">
      <div v-if="v2Revived" class="cs-revival-warning" data-testid="cs-revival-warning">
        {{ t('save.cloudSlots.v2Revived') }}
      </div>

      <ul class="cs-list" data-testid="cs-slot-list">
        <li v-for="row in rows" :key="row.slotKey" class="cs-row" :data-testid="`cs-row-${row.slotKey}`">
          <div class="cs-row-main">
            <span class="cs-name">{{ row.name }}</span>
            <span v-if="row.cloud" class="cs-meta">
              {{ t('save.cloudSlots.cloudMeta', { time: formatTime(row.cloud.updatedAt), size: row.cloud.sizeKB }) }}
            </span>
            <span v-else class="cs-meta cs-meta--none">{{ t('save.cloudSlots.notInCloud') }}</span>
            <Tooltip v-if="row.cloud?.uploadedByLabel" :text="t('save.cloudSlots.uploadedByTip', { id: row.cloud.uploadedByDeviceId ?? '?' })">
              <span class="cs-meta cs-meta--device">{{ t('save.cloudSlots.uploadedBy', { device: row.cloud.uploadedByLabel }) }}</span>
            </Tooltip>
            <span v-if="!row.local" class="cs-chip">{{ t('save.cloudSlots.cloudOnly') }}</span>
          </div>
          <div class="cs-row-actions">
            <AgaButton v-if="row.local" variant="primary" size="sm" :disabled="isBusy" :data-testid="`cs-upload-${row.slotKey}`" @click="uploadSlotUi(row.slotKey)">
              {{ busyKey === row.slotKey && status.stage === 'uploading' ? t('save.cloudSlots.uploading') : t('save.cloudSlots.uploadBtn') }}
            </AgaButton>
            <AgaButton v-if="row.cloud" variant="secondary" size="sm" :disabled="isBusy" :data-testid="`cs-download-${row.slotKey}`" @click="downloadConfirmKey = row.slotKey">
              {{ busyKey === row.slotKey && status.stage === 'downloading' ? t('save.cloudSlots.downloading') : t('save.cloudSlots.downloadBtn') }}
            </AgaButton>
            <Tooltip v-if="row.cloud" :text="t('save.cloudSlots.deleteTip')" interactive>
              <AgaButton class="cs-icon-btn" variant="danger" size="sm" :disabled="isBusy" :data-testid="`cs-delete-${row.slotKey}`" @click="deleteConfirmKey = row.slotKey">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75M4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.75 1.75 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25"/></svg>
              </AgaButton>
            </Tooltip>
          </div>
        </li>

        <!-- global 设置插槽行 -->
        <li class="cs-row cs-row--global" data-testid="cs-row-global">
          <div class="cs-row-main">
            <span class="cs-name">{{ t('save.cloudSlots.globalRow') }}</span>
            <span v-if="globalSlot" class="cs-meta">
              {{ t('save.cloudSlots.cloudMeta', { time: formatTime(globalSlot.updatedAt), size: globalSlot.sizeKB }) }}
            </span>
            <span v-else class="cs-meta cs-meta--none">{{ t('save.cloudSlots.notInCloud') }}</span>
            <Tooltip v-if="globalSlot?.uploadedByLabel" :text="t('save.cloudSlots.uploadedByTip', { id: globalSlot.uploadedByDeviceId ?? '?' })">
              <span class="cs-meta cs-meta--device">{{ t('save.cloudSlots.uploadedBy', { device: globalSlot.uploadedByLabel }) }}</span>
            </Tooltip>
          </div>
          <div class="cs-row-actions">
            <AgaButton variant="primary" size="sm" :disabled="isBusy" data-testid="cs-upload-global" @click="uploadGlobalUi">
              {{ t('save.cloudSlots.uploadSettingsBtn') }}
            </AgaButton>
            <AgaButton v-if="globalSlot" variant="secondary" size="sm" :disabled="isBusy" data-testid="cs-download-global" @click="downloadGlobalUi">
              {{ t('save.cloudSlots.downloadSettingsBtn') }}
            </AgaButton>
          </div>
        </li>
      </ul>
    </template>

    <p v-if="status.stage === 'error'" class="cs-error">{{ status.message }}</p>
    <p v-else-if="status.stage !== 'idle' && status.message" class="cs-status">{{ status.message }}</p>

    <!-- 下载确认（覆盖本地该档案） -->
    <Modal :modelValue="!!downloadConfirmKey" @update:modelValue="downloadConfirmKey = null" :title="t('save.cloudSlots.downloadConfirmTitle')" width="420px">
      <p class="cs-modal-text">{{ t('save.cloudSlots.downloadConfirmText', { name: slotDisplayName(downloadConfirmKey ?? '') }) }}</p>
      <div class="cs-modal-actions">
        <AgaButton variant="secondary" @click="downloadConfirmKey = null">{{ t('common.actions.cancel') }}</AgaButton>
        <AgaButton variant="danger" data-testid="cs-download-confirm" @click="downloadSlotUi(downloadConfirmKey!)">{{ t('save.cloudSlots.downloadConfirmOk') }}</AgaButton>
      </div>
    </Modal>

    <!-- 删除云端插槽（Q6 二次确认） -->
    <Modal :modelValue="!!deleteConfirmKey" @update:modelValue="deleteConfirmKey = null" :title="t('save.cloudSlots.deleteConfirmTitle')" width="420px">
      <p class="cs-modal-text">{{ t('save.cloudSlots.deleteConfirmText', { name: slotDisplayName(deleteConfirmKey ?? '') }) }}</p>
      <div class="cs-modal-actions">
        <AgaButton variant="secondary" @click="deleteConfirmKey = null">{{ t('common.actions.cancel') }}</AgaButton>
        <AgaButton variant="danger" data-testid="cs-delete-confirm" @click="deleteSlotUi(deleteConfirmKey!)">{{ t('save.cloudSlots.deleteConfirmOk') }}</AgaButton>
      </div>
    </Modal>

    <!-- 退化上传拦截：显式二次确认 -->
    <Modal :modelValue="!!degradedDetail" @update:modelValue="degradedDetail = null" :title="t('save.cloudSlots.degradedTitle')" width="440px">
      <p class="cs-modal-text">
        {{ t('save.cloudSlots.degradedText', {
          missing: degradedDetail?.missingAssets ?? 0,
          total: degradedDetail?.referencedAssets ?? 0,
        }) }}
      </p>
      <div class="cs-modal-actions">
        <AgaButton variant="secondary" @click="degradedDetail = null">{{ t('common.actions.cancel') }}</AgaButton>
        <AgaButton variant="danger" data-testid="cs-degraded-force" @click="confirmDegradedUpload">{{ t('save.cloudSlots.degradedForceOk') }}</AgaButton>
      </div>
    </Modal>

    <!-- 下载成功 → Q3 切换询问（含新设备"恢复设置"提示） -->
    <Modal :modelValue="!!switchAskProfile" @update:modelValue="finishDownload(false)" :title="t('save.cloudSlots.switchTitle')" width="420px">
      <p class="cs-modal-text">{{ t('save.cloudSlots.switchText', { name: switchAskProfile?.name ?? '' }) }}</p>
      <p v-if="askRestoreSettings" class="cs-modal-subtext">{{ t('save.cloudSlots.freshDeviceHint') }}</p>
      <div class="cs-modal-actions">
        <AgaButton v-if="askRestoreSettings" variant="secondary" data-testid="cs-restore-settings" @click="restoreSettingsThenFinish">
          {{ t('save.cloudSlots.restoreSettingsBtn') }}
        </AgaButton>
        <AgaButton variant="secondary" data-testid="cs-switch-no" @click="finishDownload(false)">{{ t('save.cloudSlots.switchNo') }}</AgaButton>
        <AgaButton variant="primary" data-testid="cs-switch-yes" @click="finishDownload(true)">{{ t('save.cloudSlots.switchYes') }}</AgaButton>
      </div>
    </Modal>

    <!-- 迁移确认 + 进度 -->
    <Modal :modelValue="showMigrateConfirm || migrating || !!migrateError || !!migrateDone" @update:modelValue="showMigrateConfirm = false; migrateError = ''; migrateDone = null" :title="t('save.cloudSlots.migrateModalTitle')" width="460px">
      <template v-if="showMigrateConfirm && !migrating && !migrateDone && !migrateError">
        <p class="cs-modal-text">{{ t('save.cloudSlots.migrateConfirmText') }}</p>
        <p class="cs-modal-subtext">{{ t('save.cloudSlots.migrateSafetyHint') }}</p>
        <div class="cs-modal-actions">
          <AgaButton variant="secondary" @click="showMigrateConfirm = false">{{ t('common.actions.cancel') }}</AgaButton>
          <AgaButton variant="primary" data-testid="cs-migrate-run" @click="runMigration">{{ t('save.cloudSlots.migrateRunBtn') }}</AgaButton>
        </div>
      </template>
      <template v-else>
        <ul class="cs-migrate-progress">
          <li v-for="p in migrateProgress" :key="p.slotKey" class="cs-migrate-item">
            <span>{{ slotDisplayName(p.slotKey) }}</span>
            <span :class="['cs-migrate-phase', `cs-migrate-phase--${p.phase}`]">
              {{ p.phase === 'verified' ? t('save.cloudSlots.phaseVerified') : p.phase === 'verifying' ? t('save.cloudSlots.phaseVerifying') : t('save.cloudSlots.phaseUploading') }}
            </span>
          </li>
        </ul>
        <p v-if="migrating" class="cs-status">{{ status.message }}</p>
        <p v-if="migrateError" class="cs-error" data-testid="cs-migrate-error">{{ migrateError }}</p>
        <template v-if="migrateDone">
          <p class="cs-modal-text" data-testid="cs-migrate-done">
            {{ migrateDone.v2Cleaned ? t('save.cloudSlots.migrateDone') : t('save.cloudSlots.migrateDoneDirty') }}
          </p>
          <div class="cs-modal-actions">
            <AgaButton variant="primary" @click="migrateDone = null">{{ t('common.actions.confirm') }}</AgaButton>
          </div>
        </template>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.cloud-slots { display: flex; flex-direction: column; gap: 10px; }

.cs-migrate-card {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px; border-radius: 10px;
  background: var(--glass-bg); backdrop-filter: var(--glass-blur);
}
.cs-migrate-title { font-size: 13px; color: var(--text-primary, #e8e4da); margin: 0 0 2px; }
.cs-migrate-hint { font-size: 11.5px; color: var(--text-tertiary, #8a8577); margin: 0; }

.cs-revival-warning {
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
  color: var(--warning-fg, #f0b95e); background: rgba(240, 185, 94, 0.08);
}

.cs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cs-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 10px; border-radius: 10px;
  background: var(--glass-bg); backdrop-filter: var(--glass-blur);
}
.cs-row--global { margin-top: 4px; }
.cs-row-main { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.cs-name { font-size: 13px; color: var(--text-primary, #e8e4da); }
.cs-meta { font-size: 11px; color: var(--text-tertiary, #8a8577); }
.cs-meta--none { font-style: italic; opacity: 0.8; }
.cs-meta--device { opacity: 0.75; }
.cs-chip {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  color: var(--accent-fg, #9ec49a); background: rgba(158, 196, 154, 0.12);
  backdrop-filter: blur(6px);
}
.cs-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cs-icon-btn { padding-inline: 8px; }

.cs-error { font-size: 12px; color: var(--danger-fg, #e08585); margin: 0; }
.cs-status { font-size: 12px; color: var(--text-tertiary, #8a8577); margin: 0; }

.cs-modal-text { font-size: 13px; line-height: 1.6; margin: 0 0 8px; }
.cs-modal-subtext { font-size: 12px; color: var(--text-tertiary, #8a8577); margin: 0 0 8px; }
.cs-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

.cs-migrate-progress { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cs-migrate-item { display: flex; justify-content: space-between; font-size: 12.5px; }
.cs-migrate-phase--verified { color: var(--accent-fg, #9ec49a); }
.cs-migrate-phase--verifying { color: var(--warning-fg, #f0b95e); }
.cs-migrate-phase--uploading { color: var(--text-tertiary, #8a8577); }
</style>
