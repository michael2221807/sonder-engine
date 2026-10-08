<script setup lang="ts">
// App doc: docs/user-guide/pages/game-assistant.md
/**
 * AssistantPanel — AI 助手主面板（路由 /game/assistant）
 *
 * 通过左侧 Sidebar "系统" 区入口进入。设计参考 MainGamePanel + GameVariablePanel：
 * - 顶栏：模式 / 历史计数 / 清空 / 撤销
 * - 中部：附件 bar + 对话流（含流式渲染）
 * - 底部：textarea + 发送按钮
 *
 * 用户决策：
 * - 单一 panel 双模式（attach 决定 Mode A vs B）
 * - 清空对话有 confirm dialog
 * - 注入前 confirm dialog
 * - rollback 与主回合 UX 一致
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §6 + Phase 5b。
 */
import { ref, computed, nextTick, watch, onActivated } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import Modal from '@/ui/components/shared/Modal.vue';
import AttachmentPickerModal from '@/ui/components/assistant/AttachmentPickerModal.vue';
import PayloadPreviewModal from '@/ui/components/assistant/PayloadPreviewModal.vue';
import WeatherPickerModal from '@/ui/components/panels/WeatherPickerModal.vue';
import FestivalEditModal from '@/ui/components/panels/FestivalEditModal.vue';
import EnvironmentArrayEditorModal from '@/ui/components/panels/EnvironmentArrayEditorModal.vue';
import { useAssistant } from '@/ui/composables/useAssistant';
import { useGameState } from '@/ui/composables/useGameState';
import { useSessionMode } from '@/ui/composables/useSessionMode';
import { useConfig } from '@/ui/composables/useConfig';
import { getPathLabel } from '@/ui/composables/useStateTreeNavigation';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { eventBus } from '@/engine/core/event-bus';
import type { EnvTag } from '@/ui/components/panels/assistant-env-attachments';
import type {
  AssistantMessage,
  AttachmentSpec,
  PayloadDraft,
  WorldBuilderTask,
} from '@/engine/services/assistant/types';
import type { WorldBuilderPaths } from '@/engine/services/world-builder/world-builder-service';
import BatchSummaryView from '@/ui/components/assistant/BatchSummaryView.vue';
import CustomSelect from '@/ui/components/shared/CustomSelect.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const {
  messages,
  streamingContent,
  isSending,
  canRollback,
  settings,
  send,
  clear,
  applyPayload,
  rollback,
  updateSettings,
  refreshSession,
  suggestWorldBuilderAttachments,
} = useAssistant();

const { t, locale } = useI18n();
const { pack } = useConfig();

// Pack-level i18n data for translating path segments in attachment chip labels
const packI18n = computed<Record<string, string> | undefined>(() => {
  if (!pack?.i18n) return undefined;
  return pack.i18n[locale.value];
});

// ─── Local UI state ──────────────────────────────────

const userInput = ref('');
const attachments = ref<AttachmentSpec[]>([]);
/**
 * Story 3: paths of attachments auto-seeded by world-builder mode (vs. user-picked).
 * Lets toggling WB mode OFF remove only the auto context, never the user's own picks.
 * Read only imperatively (never in template/computed), so in-place Set
 * add/delete is safe — no reactive consumer depends on identity change.
 */
const autoAttachmentPaths = ref<Set<string>>(new Set());
const showPicker = ref(false);
const showClearConfirm = ref(false);
const showSettings = ref(false);
const showPayloadPreview = ref(false);
const previewMessage = ref<AssistantMessage | null>(null);

// P4 env-tags port (2026-04-19): quick-action modals for weather / festival
// / env array. These fire DIRECT state writes (not AI-mediated) — user
// experience: open → fill → apply → status-bar updates immediately.
const showWeatherPicker = ref(false);
const showFestivalEditor = ref(false);
const showEnvEditor = ref(false);

const { get, setValue } = useGameState();
const currentWeather = computed(() => get<string>(DEFAULT_ENGINE_PATHS.weather) ?? '');
const currentFestival = computed(() => get<EnvTag>(DEFAULT_ENGINE_PATHS.festival));
const currentEnvTags = computed(() => get<EnvTag[]>(DEFAULT_ENGINE_PATHS.environmentTags) ?? []);

const messagesContainer = ref<HTMLDivElement | null>(null);

// ─── Auto-attach from query (NPC AI edit) ───────────

const route = useRoute();
const router = useRouter();

function applyEditNpcQuery(): void {
  const npcName = route.query.editNpc as string | undefined;
  if (!npcName) return;

  // Drop any WB auto-markers before replacing the attachment list wholesale,
  // otherwise stale markers could point at the edit-NPC context chips and get
  // wrongly stripped when WB mode is later toggled off.
  clearWorldBuilderAttachments();

  const defaultContext: AttachmentSpec[] = [
    { path: '元数据.叙事历史', scope: 'context' },
    { path: '世界.描述', scope: 'context' },
    { path: '角色.基础信息', scope: 'context' },
  ];
  const target: AttachmentSpec = {
    path: `社交.关系[名称=${npcName}]`,
    scope: 'target',
  };
  attachments.value = [...defaultContext, target];
  userInput.value = t('assistant.editNpc.defaultPrompt', { name: npcName });

  router.replace({ query: {} });

  // Keep world context available for WB free-chat after the NPC edit.
  // Idempotent: skips paths already present in the edit-NPC set.
  reseedWorldBuilderContext();
}

// Single activation hook with explicit ordering: install the edit-NPC set
// first (it self-reseeds WB context), then cover the no-editNpc case. The
// second call is idempotent when the first already reseeded.
onActivated(() => {
  applyEditNpcQuery();
  reseedWorldBuilderContext();
});
watch(() => route.query.editNpc, (v) => { if (v) applyEditNpcQuery(); });

// ─── Derived ────────────────────────────────────────

const turnCount = computed<number>(() =>
  messages.value.filter((m) => m.role === 'user').length,
);

const currentMode = computed<'A' | 'B'>(() =>
  attachments.value.some((a) => a.scope === 'target') ? 'B' : 'A',
);

const modeLabel = computed(() =>
  currentMode.value === 'B' ? t('assistant.mode.dataAssistant') : t('assistant.mode.freeChat'),
);

const canSend = computed(() => userInput.value.trim().length > 0 && !isSending.value);

// ─── Auto-scroll on new messages ─────────────────────

function scrollToBottom(): void {
  nextTick(() => {
    const el = messagesContainer.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(messages, scrollToBottom, { deep: true, flush: 'post' });
watch(streamingContent, scrollToBottom);

// ─── Send ───────────────────────────────────────────

async function onSend(): Promise<void> {
  if (!canSend.value) return;
  const prompt = userInput.value;
  userInput.value = '';
  const att = [...attachments.value];
  // 注入成功后 target attachment 应自动 drop —— 在 useAssistant.send 后
  // refreshSession 会更新；但当前 turn 的 attachments 应该清空
  await send(prompt, att);
  // 用户拍板：drop target after send；context 也清空（与 demo Mode 一致）
  attachments.value = [];
  autoAttachmentPaths.value = new Set();
  // World-builder mode means "attach current world state to every message",
  // so re-seed the auto context for the next turn (snapshot is rebuilt at send).
  reseedWorldBuilderContext();
}

function onKeyDown(e: KeyboardEvent): void {
  // Cmd/Ctrl+Enter 发送
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    void onSend();
  }
}

// ─── Attachments ────────────────────────────────────

function openPicker(): void {
  showPicker.value = true;
}

function onPickerConfirm(picked: AttachmentSpec[]): void {
  attachments.value = picked;
  // Keep auto-marking only for paths that survived the explicit pick; any
  // new path the user added is treated as manual.
  const pickedPaths = new Set(picked.map((a) => a.path));
  for (const p of [...autoAttachmentPaths.value]) {
    if (!pickedPaths.has(p)) autoAttachmentPaths.value.delete(p);
  }
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((a) => a.path !== path);
  // If the user manually drops an auto chip, it stops being "auto".
  autoAttachmentPaths.value.delete(path);
}

// ─── Payload preview ────────────────────────────────

function openPayloadPreview(msg: AssistantMessage): void {
  previewMessage.value = msg;
  showPayloadPreview.value = true;
}

async function onInject(messageId: string, draft: PayloadDraft): Promise<void> {
  await applyPayload(messageId, draft);
}

function onDiscard(messageId: string): void {
  // 把对应消息的 draft 标 discarded —— UI 隐藏注入按钮
  const msg = messages.value.find((m) => m.id === messageId);
  if (msg?.payloadDraft) {
    msg.payloadDraft.status = 'discarded';
  }
}

// ─── Clear ──────────────────────────────────────────

function tryClear(): void {
  if (settings.value.confirmBeforeClear) {
    showClearConfirm.value = true;
  } else {
    void clear();
  }
}

async function doClear(): Promise<void> {
  await clear();
  showClearConfirm.value = false;
  attachments.value = [];
  autoAttachmentPaths.value = new Set();
  userInput.value = '';
  // Fresh conversation in WB mode still carries world context on its first turn.
  reseedWorldBuilderContext();
}

// ─── Rollback ───────────────────────────────────────

async function onRollback(): Promise<void> {
  await rollback();
}

// ─── Settings persistence ───────────────────────────

function onSettingChange(key: 'maxHistoryTurns' | 'confirmBeforeInject' | 'confirmBeforeClear', value: number | boolean): void {
  updateSettings({ [key]: value } as never);
}

// ─── Helpers ────────────────────────────────────────

function attachmentLabelFromPath(path: string): string {
  const i18nData = packI18n.value;
  return path.split('.').slice(-2).map((seg) => getPathLabel(seg, i18nData)).join('.');
}

// ─── Env quick-actions (P4 env-tags port 2026-04-19) ──────────
//
// Direct state writes (no AI round-trip). Rollback semantics note: these
// writes are immediate and live. `preRoundSnapshot` is only captured when
// `PreProcessStage` starts a new round — so if a user sets weather, then
// starts a round, the snapshot contains the post-write value and
// `Rollback` can't undo the quick action specifically. This is by design:
// the user performed a deliberate, direct edit (mirrors GameVariablePanel
// manual edits). If undo is needed, the next AI round's force-update
// overwrites anyway, and the user can just apply a new value.

function onApplyWeather(weather: string): void {
  setValue(DEFAULT_ENGINE_PATHS.weather, weather);
  eventBus.emit('ui:toast', {
    type: 'info',
    message: t('assistant.env.weatherSet', { weather }),
    duration: 1800,
  });
}

function onApplyFestival(festival: EnvTag): void {
  setValue(DEFAULT_ENGINE_PATHS.festival, festival);
  eventBus.emit('ui:toast', {
    type: 'info',
    message: t('assistant.env.festivalSet', { festival: festival.名称 }),
    duration: 1800,
  });
}

function onApplyEnvTags(tags: EnvTag[]): void {
  setValue(DEFAULT_ENGINE_PATHS.environmentTags, tags);
  const msg = tags.length === 0
    ? t('assistant.env.envTagsCleared')
    : t('assistant.env.envTagsUpdated', { count: tags.length });
  eventBus.emit('ui:toast', { type: 'info', message: msg, duration: 1800 });
}

function payloadButtonLabel(draft: PayloadDraft): string {
  const errs = draft.validated.filter((p) => p.status === 'error').length;
  const warns = draft.validated.filter((p) => p.status === 'warn').length;
  const oks = draft.validated.filter((p) => p.status === 'ok').length;
  if (errs > 0) return `📦 ${t('assistant.payload.errorsLabel', { total: draft.validated.length, errors: errs })}`;
  if (warns > 0) return `📦 ${t('assistant.payload.warningsLabel', { total: draft.validated.length, warnings: warns })}`;
  return `📦 ${t('assistant.payload.readyLabel', { count: oks })}`;
}

// ─── World Builder mode (Story 3 Phase 4) ──────────────

const worldBuilderService = injectService('worldBuilderService', null);

const isWorldBuilderMode = computed(() => settings.value.worldBuilderMode);
const isWorldBuilderBusy = ref(false);
const worldBuilderProgress = ref('');

function toggleWorldBuilderMode(): void {
  const next = !settings.value.worldBuilderMode;
  updateSettings({ worldBuilderMode: next });
  if (next) {
    applyWorldBuilderAttachments();
  } else {
    clearWorldBuilderAttachments();
  }
}

/**
 * Seed the recommended world-state context attachments (relationships /
 * locations / world description) so WB free-chat carries real world data.
 * Idempotent: skips paths already attached; records seeded paths as "auto".
 */
function applyWorldBuilderAttachments(): void {
  const suggestions = suggestWorldBuilderAttachments({
    relationships: worldBuilderPaths.relationships,
    locations: worldBuilderPaths.locations,
    worldDescription: worldBuilderPaths.worldDescription,
  });
  const existing = new Set(attachments.value.map((a) => a.path));
  const added: AttachmentSpec[] = [];
  for (const spec of suggestions) {
    if (!existing.has(spec.path)) {
      added.push(spec);
      autoAttachmentPaths.value.add(spec.path);
    }
  }
  if (added.length > 0) {
    attachments.value = [...attachments.value, ...added];
  }
}

/** Remove only the attachments that WB mode auto-seeded; keep user picks. */
function clearWorldBuilderAttachments(): void {
  if (autoAttachmentPaths.value.size === 0) return;
  attachments.value = attachments.value.filter((a) => !autoAttachmentPaths.value.has(a.path));
  autoAttachmentPaths.value = new Set();
}

/** Re-seed world context when still in WB mode (after send / clear). */
function reseedWorldBuilderContext(): void {
  if (isWorldBuilderMode.value) applyWorldBuilderAttachments();
}

/*
 * Story 9 — when the SESSION enters worldBuilding mode, default the assistant
 * into its (Story 3) worldBuilderMode so card-writing starts with batch tools
 * + world context ready (design 行1072).
 *
 * ⚠️ DISTINCT CONCEPTS (do NOT merge): `sessionType` (per-save, persisted) vs
 * `worldBuilderMode` (assistant panel, localStorage). The session only "raises"
 * the assistant mode on entry; the user can still toggle worldBuilderMode off
 * manually, and switching the session back to play does NOT force it off.
 */
const { isWorldBuilding: isWorldBuildingSession } = useSessionMode();
watch(isWorldBuildingSession, (wb) => {
  if (wb && !settings.value.worldBuilderMode) {
    updateSettings({ worldBuilderMode: true });
    applyWorldBuilderAttachments();
  }
}, { immediate: true });

const inputPlaceholder = computed(() =>
  isWorldBuilderMode.value ? t('assistant.worldBuilder.placeholder') : t('assistant.input.placeholder'),
);

const showRegionModal = ref(false);
const showNpcModal = ref(false);
const showDescModal = ref(false);

const regionInstruction = ref('');
const regionParent = ref('');
const regionGenerateNpcs = ref(true);
const regionNpcCount = ref(5);
const regionSubLocCount = ref(3);
const regionGenerateItems = ref(true);
const regionItemCount = ref(3);
const npcInstruction = ref('');
const npcCount = ref(5);
const descInstruction = ref('');

const locations = computed(() => get<Array<Record<string, unknown>>>(DEFAULT_ENGINE_PATHS.locations) ?? []);
const locationNames = computed(() => locations.value.map(l => (l['名称'] ?? l['name'] ?? '') as string).filter(Boolean));
const locationOptions = computed(() => [
  { value: '', label: t('assistant.worldBuilder.regionModal.parentNone') },
  ...locationNames.value.map(n => ({ value: n, label: n })),
]);

const worldBuilderPaths: WorldBuilderPaths = {
  relationships: DEFAULT_ENGINE_PATHS.relationships,
  locations: DEFAULT_ENGINE_PATHS.locations,
  worldDescription: DEFAULT_ENGINE_PATHS.worldDescription,
  inventory: DEFAULT_ENGINE_PATHS.inventoryItems,
  npcSummaryFields: DEFAULT_ENGINE_PATHS.npcFieldNames
    ? [DEFAULT_ENGINE_PATHS.npcFieldNames.name, DEFAULT_ENGINE_PATHS.npcFieldNames.type,
       DEFAULT_ENGINE_PATHS.npcFieldNames.location, DEFAULT_ENGINE_PATHS.npcFieldNames.description]
    : ['名称', '类型', '位置', '核心性格特征', '是否主要角色'],
  locationSummaryFields: ['名称', '类型', '上级', '连接'],
  itemNameField: DEFAULT_ENGINE_PATHS.npcFieldNames?.name ?? '名称',
};

async function executeWorldBuilder(task: WorldBuilderTask): Promise<void> {
  if (!worldBuilderService || isWorldBuilderBusy.value) return;

  isWorldBuilderBusy.value = true;
  worldBuilderProgress.value = t('assistant.worldBuilder.progress');
  try {
    const result = await worldBuilderService.execute(
      'default',
      task,
      worldBuilderPaths,
      (payload) => { worldBuilderProgress.value = payload.message; },
    );

    if (result.assistantMessage.systemKind === 'ai-error') {
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('assistant.toast.worldBuilderFailed', { error: result.assistantMessage.content }),
        duration: 4000,
      });
    }
  } catch (err) {
    eventBus.emit('ui:toast', {
      type: 'error',
      message: t('assistant.toast.worldBuilderFailed', { error: String(err) }),
      duration: 4000,
    });
  } finally {
    isWorldBuilderBusy.value = false;
    worldBuilderProgress.value = '';
    await refreshSession();
  }
}

function onGenerateRegion(): void {
  if (!regionInstruction.value.trim()) return;
  const task: WorldBuilderTask = {
    type: 'region',
    userInstruction: regionInstruction.value,
    config: {
      parentLocation: regionParent.value || undefined,
      npcCount: regionGenerateNpcs.value ? regionNpcCount.value : 0,
      subLocationCount: regionSubLocCount.value,
      generateItems: regionGenerateItems.value,
      itemCount: regionGenerateItems.value ? regionItemCount.value : 0,
    },
  };
  showRegionModal.value = false;
  regionInstruction.value = '';
  regionParent.value = '';
  regionGenerateNpcs.value = true;
  regionNpcCount.value = 5;
  regionSubLocCount.value = 3;
  regionGenerateItems.value = true;
  regionItemCount.value = 3;
  void executeWorldBuilder(task);
}

function onGenerateNpcs(): void {
  if (!npcInstruction.value.trim()) return;
  const task: WorldBuilderTask = {
    type: 'npcs',
    userInstruction: npcInstruction.value,
    config: { npcCount: npcCount.value },
  };
  showNpcModal.value = false;
  npcInstruction.value = '';
  npcCount.value = 5;
  void executeWorldBuilder(task);
}

function onExtractFromDescription(): void {
  if (!descInstruction.value.trim()) return;
  const task: WorldBuilderTask = {
    type: 'from-description',
    userInstruction: descInstruction.value,
  };
  showDescModal.value = false;
  descInstruction.value = '';
  void executeWorldBuilder(task);
}
</script>

<template>
  <div class="assistant-panel">
    <!-- ── Header ── -->
    <header class="ap-header">
      <div class="header-left">
        <h2 class="title">🪄 {{ t('assistant.title') }}</h2>
        <div class="mode-toggle" role="group" aria-label="Assistant mode">
          <button
            class="mode-seg"
            :class="{ active: !isWorldBuilderMode }"
            :aria-pressed="!isWorldBuilderMode"
            @click="isWorldBuilderMode && toggleWorldBuilderMode()"
          >{{ t('assistant.mode.chat') }}</button>
          <button
            class="mode-seg"
            :class="{ active: isWorldBuilderMode }"
            :aria-pressed="isWorldBuilderMode"
            @click="!isWorldBuilderMode && toggleWorldBuilderMode()"
          >{{ t('assistant.mode.worldBuilder') }}</button>
        </div>
        <span class="mode-tag" :data-mode="currentMode">{{ modeLabel }}</span>
        <span class="history-count">{{ t('assistant.historyCount', { current: turnCount, max: settings.maxHistoryTurns }) }}</span>
      </div>
      <div class="header-right">
        <button v-if="canRollback" class="action-btn rollback" @click="onRollback">
          ↶ {{ t('assistant.rollback') }}
        </button>
        <Tooltip :text="t('assistant.settingsTitle')" interactive>
          <button class="action-btn" :aria-label="t('assistant.settingsTitle')" @click="showSettings = true">⚙</button>
        </Tooltip>
        <Tooltip :text="t('assistant.clearTitle')" interactive>
          <button class="action-btn danger" :aria-label="t('assistant.clearTitle')" :disabled="messages.length === 0" @click="tryClear">
            🗑
          </button>
        </Tooltip>
      </div>
    </header>

    <!--
      Env quick actions (P4 env-tags port 2026-04-19).
      Disabled during assistant AI turns (`isSending`) to prevent concurrent
      state mutation with a payload-inject. Main-game round state is NOT
      guarded here — if a main-game round is mid-flight, a quick-action
      write is still allowed; the next AI round's force-update will
      reconcile (§四.5 in core.md).
    -->
    <div class="ap-quick-actions">
      <span class="qa-label">{{ t('assistant.env.quickLabel') }}</span>
      <Tooltip :text="t('assistant.env.weatherTitle')" interactive>
        <button
          type="button"
          class="qa-chip"
          :disabled="isSending"
          @click="showWeatherPicker = true"
        >
          {{ t('assistant.setWeather') }}
        </button>
      </Tooltip>
      <Tooltip :text="t('assistant.env.festivalTitle')" interactive>
        <button
          type="button"
          class="qa-chip"
          :disabled="isSending"
          @click="showFestivalEditor = true"
        >
          {{ t('assistant.setFestival') }}
        </button>
      </Tooltip>
      <Tooltip :text="t('assistant.env.envTagsTitle')" interactive>
        <button
          type="button"
          class="qa-chip"
          :disabled="isSending"
          @click="showEnvEditor = true"
        >
          {{ t('assistant.editEnvTags') }}
        </button>
      </Tooltip>
    </div>

    <!-- World builder quick-actions (Story 3 Phase 4) — visible only in build mode -->
    <div v-if="isWorldBuilderMode" class="ap-quick-actions wb-actions">
      <span class="qa-label">{{ t('assistant.worldBuilder.quickLabel') }}</span>
      <button
        type="button"
        class="qa-chip wb-chip"
        :disabled="isSending || isWorldBuilderBusy"
        @click="showRegionModal = true"
      >🏘 {{ t('assistant.worldBuilder.generateRegion') }}</button>
      <button
        type="button"
        class="qa-chip wb-chip"
        :disabled="isSending || isWorldBuilderBusy"
        @click="showNpcModal = true"
      >👥 {{ t('assistant.worldBuilder.batchNpcs') }}</button>
      <button
        type="button"
        class="qa-chip wb-chip"
        :disabled="isSending || isWorldBuilderBusy"
        @click="showDescModal = true"
      >📝 {{ t('assistant.worldBuilder.fromDescription') }}</button>
    </div>

    <!-- ── Attachments bar ── -->
    <div class="ap-attachments">
      <div class="att-list">
        <div v-if="attachments.length === 0" class="att-empty">
          {{ t('assistant.noAttachment') }}
        </div>
        <div
          v-for="att in attachments"
          :key="att.path"
          class="att-chip"
          :class="{ 'is-target': att.scope === 'target' }"
        >
          <span class="att-icon">{{ att.scope === 'target' ? '✏' : '📖' }}</span>
          <span class="att-label">{{ attachmentLabelFromPath(att.path) }}</span>
          <span class="att-scope">{{ att.scope === 'target' ? t('assistant.attachment.scopeTarget') : t('assistant.attachment.scopeContext') }}</span>
          <Tooltip :text="t('assistant.attachment.remove')" interactive>
            <button class="att-remove" :aria-label="t('assistant.attachment.remove')" @click="removeAttachment(att.path)">×</button>
          </Tooltip>
        </div>
      </div>
      <button class="att-add" @click="openPicker" :disabled="isSending">{{ t('assistant.addAttachment') }}</button>
    </div>

    <!-- ── Conversation ── -->
    <div ref="messagesContainer" class="ap-messages">
      <div v-if="messages.length === 0 && !isSending" class="msg-empty">
        {{ t('assistant.emptyHint') }}<br/>
        {{ t('assistant.emptyHintSub') }}
      </div>

      <article
        v-for="msg in messages"
        :key="msg.id"
        class="msg"
        :class="['msg-' + msg.role, msg.systemKind ? 'sys-' + msg.systemKind : '']"
      >
        <div class="msg-header">
          <span class="msg-role">
            {{ msg.role === 'user' ? t('assistant.roleUser') : msg.role === 'assistant' ? t('assistant.roleAssistant') : t('assistant.roleSystem') }}
          </span>
          <span class="msg-time">{{ new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
        </div>

        <div class="msg-content">{{ msg.content }}</div>

        <!-- user message: attachment chips -->
        <div v-if="msg.role === 'user' && msg.attachments && msg.attachments.length > 0" class="msg-attachments">
          <span
            v-for="a in msg.attachments"
            :key="a.path"
            class="msg-att-chip"
            :class="{ 'is-target': a.scope === 'target' }"
          >
            {{ a.scope === 'target' ? '✏' : '📖' }} {{ a.label }}
          </span>
        </div>

        <!-- assistant message: payload draft button + batch summary -->
        <div v-if="msg.role === 'assistant' && msg.payloadDraft" class="msg-payload">
          <BatchSummaryView
            v-if="msg.payloadDraft.validated.length > 5"
            :patches="msg.payloadDraft.validated"
            :knowledge-facts="msg.payloadDraft.raw.knowledgeFacts"
          />
          <button
            v-if="msg.payloadDraft.status === 'pending'"
            class="payload-btn"
            @click="openPayloadPreview(msg)"
          >
            {{ payloadButtonLabel(msg.payloadDraft) }}
            <span class="payload-summary">{{ msg.payloadDraft.raw.summary }}</span>
          </button>
          <div v-else-if="msg.payloadDraft.status === 'injected'" class="payload-status injected">
            {{ t('assistant.payloadInjected', { count: msg.payloadDraft.validated.length }) }}
            <span v-if="msg.payloadDraft.rolledBackAt">{{ t('assistant.payloadRolledBack') }}</span>
          </div>
          <div v-else class="payload-status discarded">
            {{ t('assistant.payloadDiscarded') }}
          </div>
        </div>
      </article>

      <!-- streaming bubble -->
      <article v-if="isSending" class="msg msg-assistant streaming">
        <div class="msg-header">
          <span class="msg-role">{{ t('assistant.roleAssistant') }}</span>
          <span class="msg-time">{{ t('assistant.streamingTime') }}</span>
        </div>
        <div class="msg-content">{{ streamingContent || t('assistant.streamingWait') }}</div>
      </article>

      <!-- World builder progress bubble -->
      <article v-if="isWorldBuilderBusy" class="msg msg-assistant streaming wb-progress">
        <div class="msg-header">
          <span class="msg-role">{{ t('assistant.roleAssistant') }}</span>
          <span class="msg-time">{{ t('assistant.streamingTime') }}</span>
        </div>
        <div class="msg-content">⌛ {{ worldBuilderProgress || t('assistant.worldBuilder.progress') }}</div>
      </article>
    </div>

    <!-- ── Input bar ── -->
    <div class="ap-input">
      <textarea
        v-model="userInput"
        class="input-textarea"
        :placeholder="inputPlaceholder"
        :disabled="isSending || isWorldBuilderBusy"
        rows="3"
        @keydown="onKeyDown"
      />
      <button class="send-btn" :disabled="!canSend || isWorldBuilderBusy" @click="onSend">
        {{ isSending ? t('assistant.input.sending') : t('assistant.input.send') }}
      </button>
    </div>

    <!-- ── Sub-modals ── -->
    <AttachmentPickerModal
      v-model="showPicker"
      :already-attached="attachments"
      @confirm="onPickerConfirm"
    />

    <PayloadPreviewModal
      v-model="showPayloadPreview"
      :message="previewMessage"
      :confirm-before-inject="settings.confirmBeforeInject"
      @inject="onInject"
      @discard="onDiscard"
    />

    <!-- Env quick-action modals (P4 env-tags port 2026-04-19) -->
    <WeatherPickerModal
      v-model="showWeatherPicker"
      :current="currentWeather"
      @apply="onApplyWeather"
    />
    <FestivalEditModal
      v-model="showFestivalEditor"
      :current="currentFestival"
      @apply="onApplyFestival"
    />
    <EnvironmentArrayEditorModal
      v-model="showEnvEditor"
      :current="currentEnvTags"
      @apply="onApplyEnvTags"
    />

    <Modal v-model="showClearConfirm" :title="t('assistant.clear.modalTitle')" width="450px">
      <p>{{ t('assistant.clear.body') }}</p>
      <p class="confirm-hint">{{ t('assistant.clear.hint') }}</p>
      <template #footer>
        <AgaButton variant="secondary" @click="showClearConfirm = false">{{ t('assistant.clear.cancel') }}</AgaButton>
        <AgaButton variant="danger" @click="doClear">{{ t('assistant.clear.confirm') }}</AgaButton>
      </template>
    </Modal>

    <Modal v-model="showSettings" :title="t('assistant.settings.modalTitle')" width="500px">
      <div class="settings-form">
        <div class="setting-row">
          <label>{{ t('assistant.settings.historyLabel') }}</label>
          <input
            type="number"
            min="1"
            max="50"
            :value="settings.maxHistoryTurns"
            @input="onSettingChange('maxHistoryTurns', Math.max(1, Math.min(50, Number(($event.target as HTMLInputElement).value))))"
          />
          <span class="setting-hint">{{ t('assistant.settings.historyHint') }}</span>
        </div>
        <div class="setting-row">
          <label>
            <input
              type="checkbox"
              :checked="settings.confirmBeforeInject"
              @change="onSettingChange('confirmBeforeInject', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('assistant.settings.confirmInject') }}
          </label>
        </div>
        <div class="setting-row">
          <label>
            <input
              type="checkbox"
              :checked="settings.confirmBeforeClear"
              @change="onSettingChange('confirmBeforeClear', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('assistant.settings.confirmClear') }}
          </label>
        </div>
      </div>
      <template #footer>
        <AgaButton variant="primary" @click="showSettings = false">{{ t('assistant.settings.close') }}</AgaButton>
      </template>
    </Modal>

    <!-- World Builder batch modals (Story 3 Phase 4) -->
    <Modal v-model="showRegionModal" :title="t('assistant.worldBuilder.regionModal.title')" width="560px">
      <div class="wb-modal-form">
        <label class="wb-form-label">{{ t('assistant.worldBuilder.regionModal.description') }}</label>
        <textarea
          v-model="regionInstruction"
          class="wb-textarea"
          rows="4"
          :placeholder="t('assistant.worldBuilder.regionModal.description')"
        />
        <label class="wb-form-label">{{ t('assistant.worldBuilder.regionModal.parentLocation') }}</label>
        <CustomSelect
          v-model="regionParent"
          :options="locationOptions"
          :placeholder="t('assistant.worldBuilder.regionModal.parentNone')"
        />
        <div class="wb-config-grid">
          <div class="wb-config-line">
            <span class="wb-config-label">{{ t('assistant.worldBuilder.regionModal.subLocations') }}</span>
            <input v-model.number="regionSubLocCount" type="number" min="1" max="8" class="wb-number-input" />
          </div>
          <div class="wb-config-line">
            <label class="wb-config-toggle">
              <input v-model="regionGenerateNpcs" type="checkbox" class="setting-row-checkbox" />
              <span>{{ t('assistant.worldBuilder.regionModal.generateNpcs') }}</span>
            </label>
            <input v-if="regionGenerateNpcs" v-model.number="regionNpcCount" type="number" min="1" max="15" class="wb-number-input" />
          </div>
          <div class="wb-config-line">
            <label class="wb-config-toggle">
              <input v-model="regionGenerateItems" type="checkbox" class="setting-row-checkbox" />
              <span>{{ t('assistant.worldBuilder.regionModal.generateItems') }}</span>
            </label>
            <input v-if="regionGenerateItems" v-model.number="regionItemCount" type="number" min="1" max="5" class="wb-number-input" />
          </div>
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showRegionModal = false">{{ t('assistant.worldBuilder.cancel') }}</AgaButton>
        <AgaButton variant="primary" :disabled="!regionInstruction.trim()" @click="onGenerateRegion">{{ t('assistant.worldBuilder.regionModal.generate') }}</AgaButton>
      </template>
    </Modal>

    <Modal v-model="showNpcModal" :title="t('assistant.worldBuilder.npcModal.title')" width="520px">
      <div class="wb-modal-form">
        <label class="wb-form-label">{{ t('assistant.worldBuilder.npcModal.description') }}</label>
        <textarea
          v-model="npcInstruction"
          class="wb-textarea"
          rows="4"
          :placeholder="t('assistant.worldBuilder.npcModal.description')"
        />
        <label class="wb-form-label">{{ t('assistant.worldBuilder.npcModal.count') }}</label>
        <input v-model.number="npcCount" type="number" min="1" max="20" class="wb-number-input" />
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showNpcModal = false">{{ t('assistant.worldBuilder.cancel') }}</AgaButton>
        <AgaButton variant="primary" :disabled="!npcInstruction.trim()" @click="onGenerateNpcs">{{ t('assistant.worldBuilder.npcModal.generate') }}</AgaButton>
      </template>
    </Modal>

    <Modal v-model="showDescModal" :title="t('assistant.worldBuilder.descModal.title')" width="600px">
      <div class="wb-modal-form">
        <label class="wb-form-label">{{ t('assistant.worldBuilder.descModal.description') }}</label>
        <textarea
          v-model="descInstruction"
          class="wb-textarea large"
          rows="8"
          :placeholder="t('assistant.worldBuilder.descModal.description')"
        />
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showDescModal = false">{{ t('assistant.worldBuilder.cancel') }}</AgaButton>
        <AgaButton variant="primary" :disabled="!descInstruction.trim()" @click="onExtractFromDescription">{{ t('assistant.worldBuilder.descModal.extract') }}</AgaButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.assistant-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 var(--sidebar-right-reserve, 40px) 0 var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet);
  background: var(--color-bg);
  color: var(--color-text);
}

/* Header */
.ap-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: rgba(255, 255, 255, 0.02);
}
.header-left { display: flex; align-items: center; gap: 12px; }
.title { margin: 0; font-size: 1.1rem; font-weight: 600; }
.mode-tag {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.74rem;
  font-weight: 500;
}
.mode-tag[data-mode="A"] { background: color-mix(in oklch, var(--color-sage-400) 15%, transparent); color: var(--color-sage-400); }
.mode-tag[data-mode="B"] { background: color-mix(in oklch, var(--color-success) 15%, transparent); color: var(--color-success); }
.history-count { font-size: 0.78rem; color: var(--color-text-secondary); }

.header-right { display: flex; gap: 6px; }
.action-btn {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text);
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.82rem;
  transition: background 0.15s;
}
.action-btn:hover:not(:disabled) { background: color-mix(in oklch, var(--color-text-bone) 6%, transparent); }
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.action-btn.rollback { color: var(--color-amber-400); border-color: color-mix(in oklch, var(--color-amber-400) 40%, transparent); }
.action-btn.danger:hover:not(:disabled) { background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: var(--color-danger-hover); border-color: color-mix(in oklch, var(--color-danger) 30%, transparent); }

/* Attachments bar */
/* P4 env-tags port (2026-04-19): quick-action row for weather / festival / env.
   Sits above the AI-attachment bar; deterministic state writes (no AI). */
.ap-quick-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.qa-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-right: 4px;
  letter-spacing: 0.05em;
}
.qa-chip {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-size: 0.78rem;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}
.qa-chip:hover:not(:disabled) {
  border-color: var(--color-sage-400);
  transform: translateY(-1px);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}
.qa-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ap-attachments {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  min-height: 48px;
}
.att-list { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; }
.att-empty { font-size: 0.8rem; color: var(--color-text-secondary); opacity: 0.7; }

.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-radius: 14px;
  font-size: 0.78rem;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.att-chip.is-target {
  background: color-mix(in oklch, var(--color-success) 10%, transparent);
  border-color: color-mix(in oklch, var(--color-success) 40%, transparent);
}
.att-icon { font-size: 0.86rem; }
.att-scope { font-size: 0.7rem; opacity: 0.7; }
.att-remove {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  border-radius: 50%;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
}

.att-add {
  flex-shrink: 0;
  padding: 5px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed var(--color-border);
  color: var(--color-text-secondary);
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.78rem;
}
.att-add:hover:not(:disabled) { background: color-mix(in oklch, var(--color-text-bone) 6%, transparent); color: var(--color-text); }
.att-add:disabled { opacity: 0.4; cursor: not-allowed; }

/* Messages */
.ap-messages {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.msg-empty {
  margin: auto;
  padding: 40px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 0.92rem;
  line-height: 1.6;
}

.msg {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border-subtle);
}
.msg-user { align-self: flex-end; background: color-mix(in oklch, var(--color-sage-400) 8%, transparent); border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.msg-assistant { align-self: flex-start; }
.msg-system {
  align-self: center;
  background: color-mix(in oklch, var(--color-amber-400) 6%, transparent);
  border-color: color-mix(in oklch, var(--color-amber-400) 20%, transparent);
  font-size: 0.82rem;
  max-width: 70%;
  text-align: center;
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-amber-400) 5%, transparent);
}
.msg.streaming { opacity: 0.85; }
.msg.sys-inject-success { background: color-mix(in oklch, var(--color-success) 8%, transparent); border-color: color-mix(in oklch, var(--color-success) 25%, transparent); }
.msg.sys-inject-failed, .msg.sys-ai-error { background: color-mix(in oklch, var(--color-danger) 8%, transparent); border-color: color-mix(in oklch, var(--color-danger) 25%, transparent); }
.msg.sys-inject-rolled-back { background: color-mix(in oklch, var(--color-amber-400) 10%, transparent); border-color: color-mix(in oklch, var(--color-amber-400) 30%, transparent); }

.msg-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.74rem;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}
.msg-role { font-weight: 600; }

.msg-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.86rem;
  line-height: 1.55;
  color: var(--color-text);
}

.msg-attachments {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.msg-att-chip {
  padding: 2px 8px;
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  border-radius: 10px;
  font-size: 0.72rem;
}
.msg-att-chip.is-target {
  background: color-mix(in oklch, var(--color-success) 10%, transparent);
  border-color: color-mix(in oklch, var(--color-success) 30%, transparent);
}

.msg-payload { margin-top: 10px; }

.payload-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 10px 14px;
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid var(--color-sage-400);
  color: var(--color-text);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.84rem;
  text-align: left;
  font-weight: 500;
  transition: background 0.15s;
}
.payload-btn:hover { background: color-mix(in oklch, var(--color-sage-400) 18%, transparent); box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent); }
.payload-summary {
  font-size: 0.76rem;
  font-weight: 400;
  color: var(--color-text-secondary);
}

.payload-status {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.78rem;
}
.payload-status.injected { background: color-mix(in oklch, var(--color-success) 12%, transparent); color: var(--color-success); }
.payload-status.discarded { background: rgba(255, 255, 255, 0.04); color: var(--color-text-secondary); }

/* Input bar */
.ap-input {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border-subtle);
  background: rgba(255, 255, 255, 0.02);
}

.input-textarea {
  flex: 1;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.86rem;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: border-color 0.15s;
}
.input-textarea:focus { border-color: var(--color-sage-400); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.input-textarea:disabled { opacity: 0.6; }

.send-btn {
  padding: 0 24px;
  background: var(--color-sage-400);
  color: var(--color-text-bone);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.86rem;
  font-weight: 500;
}
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Settings modal */
.settings-form { display: flex; flex-direction: column; gap: 14px; }
.setting-row { display: flex; flex-direction: column; gap: 4px; }
.setting-row label { font-size: 0.84rem; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.setting-row input[type="number"] {
  width: 80px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.84rem;
  font-family: inherit;
  outline: none;
}
.setting-row input[type="number"]:focus { border-color: var(--color-sage-400); }
.setting-row input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}
.setting-row input[type="checkbox"]:checked {
  background: color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-color: var(--color-sage-400);
}
.setting-row input[type="checkbox"]:checked::after {
  content: '✓';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  color: var(--color-text);
}
.setting-hint { font-size: 0.74rem; color: var(--color-text-secondary); }

.confirm-hint { margin-top: 8px; font-size: 0.8rem; color: var(--color-text-secondary); }

/* Mode toggle (Story 3) */
.mode-toggle {
  display: inline-flex;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.03);
  margin-left: 8px;
}
.mode-seg {
  padding: 4px 14px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  min-height: 28px;
}
.mode-seg.active {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  color: var(--color-text);
}
.mode-seg:hover:not(.active) {
  background: rgba(255, 255, 255, 0.06);
}

/* World builder quick actions */
.wb-actions {
  border-bottom: 1px solid color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}
.wb-chip {
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* World builder modal forms */
.wb-modal-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wb-form-label {
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--color-text);
}
.wb-textarea {
  width: 100%;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.86rem;
  font-family: inherit;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.wb-textarea:focus {
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.wb-textarea.large { min-height: 180px; }
.wb-config-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.wb-config-line {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 34px;
}
.wb-config-label {
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--color-text);
  min-width: 100px;
}
.wb-config-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--color-text);
  min-width: 100px;
}
.wb-config-line .wb-number-input {
  max-width: 70px;
}
.setting-row-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}
.setting-row-checkbox:checked {
  background: color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-color: var(--color-sage-400);
}
.setting-row-checkbox:checked::after {
  content: '✓';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  color: var(--color-text);
}
.wb-select,
.wb-number-input {
  width: 100%;
  max-width: 240px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.84rem;
  font-family: inherit;
  outline: none;
}
.wb-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238888a0' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  cursor: pointer;
}
.wb-select option {
  background: var(--color-bg);
  color: var(--color-text);
}
.wb-select:focus,
.wb-number-input:focus {
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

/* World builder progress bubble */
.wb-progress { border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent); }

@media (max-width: 767px) {
  .assistant-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
  .mode-seg { padding: 4px 10px; font-size: 0.72rem; min-height: 36px; }
  .wb-actions { overflow-x: auto; flex-wrap: nowrap; }
}
</style>
