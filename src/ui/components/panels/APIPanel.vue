<script setup lang="ts">
/**
 * APIPanel — API 管理面板（B.1 全功能实现）
 *
 * B.1.1 真实连通测试：status dot（idle/testing/ok/error）+ 延迟显示
 * B.1.2 模型列表拉取：编辑 Modal 中"获取模型"按钮 + datalist 选择
 * B.1.3 功能分配：按类别分组的 usageType → API 指派（per-usageType ON/OFF 开关列已移除——
 *        曾为死控件，引擎不读 aga_feature_toggles；功能开关由 SettingsPanel 负责）
 * B.1.4 AI 生成全局设置：流式输出开关 + 最大重试次数
 */
// App doc: docs/user-guide/pages/home.md §1.3.1
import { ref, reactive, computed, inject, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import Modal from '@/ui/components/common/Modal.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import { API_PROVIDER_PRESETS, requestTimeoutMinutesToMs, REQUEST_TIMEOUT_MIN_MINUTES, REQUEST_TIMEOUT_MAX_MINUTES, REQUEST_TIMEOUT_DEFAULT_MINUTES } from '@/engine/ai/types';
import { AI_SETTINGS_STORAGE_KEY } from '@/engine/ai/ai-service';
import type { AIService } from '@/engine/ai/ai-service';
import type { APIConfig, APIProviderType, UsageType, APICategory } from '@/engine/ai/types';
import { providerCatalog } from '@/engine/providers';

const { t } = useI18n();
const apiStore = useAPIManagementStore();
const aiService = inject<AIService | undefined>('aiService', undefined);

onMounted(() => {
  apiStore.loadFromStorage();
});

// ─── Usage type config ───

type AssignCategory = 'narrative' | 'world_memory' | 'npc_social' | 'plot' | 'repair' | 'image' | 'rag' | 'utility' | 'audio';

interface UsageTypeMeta {
  label: string;
  category: AssignCategory;
  tip: string;
}

/**
 * Per-backend usage types (`imageGen_*` / `ttsGen_*` / `sttGen_*`) are the
 * assignment table's multi-config switcher rows; their list derives from the
 * provider catalog (epic P0 §3.3) so a new vendor's rows appear without
 * touching this file. The template-literal Exclude keeps the static part
 * exhaustively checked by TS for every non-backend usage.
 */
type PerBackendUsage = `imageGen_${string}` | `ttsGen_${string}` | `sttGen_${string}`;

const STATIC_USAGE_CATEGORIES: Record<Exclude<UsageType, PerBackendUsage>, AssignCategory> = {
  main: 'narrative',
  cot: 'narrative',
  bodyPolish: 'narrative',
  text_optimization: 'narrative',
  memory_summary: 'world_memory',
  world_generation: 'world_memory',
  event_generation: 'world_memory',
  world_heartbeat: 'world_memory',
  npc_chat: 'npc_social',
  location_npc_generation: 'npc_social',
  plot_decompose: 'plot',
  instruction_generation: 'plot',
  privacy_repair: 'repair',
  field_repair: 'repair',
  imageGeneration: 'image',
  imageCharacterTokenizer: 'image',
  imageSceneTokenizer: 'image',
  imageSecretTokenizer: 'image',
  embedding: 'rag',
  rerank: 'rag',
  assistant: 'utility',
  world_builder: 'utility',
  engram_batch_solidify: 'repair',
  card_edge_classify: 'repair',
};

const USAGE_TYPE_CATEGORIES: Record<UsageType, AssignCategory> = {
  ...STATIC_USAGE_CATEGORIES,
  ...Object.fromEntries([
    ...providerCatalog.byCategory('image').map((d) => [`imageGen_${d.id}`, 'image'] as const),
    ...providerCatalog.byCategory('tts').map((d) => [`ttsGen_${d.id}`, 'audio'] as const),
    ...providerCatalog.byCategory('stt').map((d) => [`sttGen_${d.id}`, 'audio'] as const),
  ]),
} as Record<UsageType, AssignCategory>;

/** Split a per-backend usage key into its kind + backend id (null for static usages). */
function parsePerBackendUsage(key: string): { kind: 'image' | 'tts' | 'stt'; backend: string } | null {
  if (key.startsWith('imageGen_')) return { kind: 'image', backend: key.slice('imageGen_'.length) };
  if (key.startsWith('ttsGen_')) return { kind: 'tts', backend: key.slice('ttsGen_'.length) };
  if (key.startsWith('sttGen_')) return { kind: 'stt', backend: key.slice('sttGen_'.length) };
  return null;
}

function getUsageTypeMeta(key: UsageType): UsageTypeMeta {
  const perBackend = parsePerBackendUsage(key);
  if (perBackend) {
    const name = t(`api.backend.${perBackend.backend}`);
    return {
      label: t(`api.usage.byBackend.${perBackend.kind}`, { name }),
      category: USAGE_TYPE_CATEGORIES[key],
      tip: t(`api.usage.tip.byBackend.${perBackend.kind}`, { name }),
    };
  }
  return {
    label: t(`api.usage.${key}`),
    category: USAGE_TYPE_CATEGORIES[key],
    tip: t(`api.usage.tip.${key}`),
  };
}

function getAssignCategoryMeta(cat: AssignCategory): { label: string; hint?: string } {
  const label = t(`api.category.${cat}`);
  const hintKey = `api.category.${cat}.hint`;
  // Only image and rag have hints in locale
  const hint = (cat === 'image' || cat === 'rag') ? t(hintKey) : undefined;
  return { label, hint };
}

const CATEGORY_ORDER: AssignCategory[] = [
  'narrative', 'world_memory', 'npc_social', 'plot', 'repair', 'image', 'rag', 'audio', 'utility',
];

// ─── Feature toggles (preset snapshot only) ───
//
// The per-usageType ON/OFF switch column was removed from the assignment modal: it
// was a dead control (the engine never reads `aga_feature_toggles`; real feature
// on/off lives in SettingsPanel via dedicated keys). `featureToggles` is retained
// solely so assignment presets can snapshot/restore the feature on/off state that
// SettingsPanel owns (see onSavePreset / onApplyPreset).

const FEATURE_TOGGLES_KEY = 'aga_feature_toggles';

function loadFeatureToggles(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FEATURE_TOGGLES_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const featureToggles = ref<Record<string, boolean>>(loadFeatureToggles());

function typesForCategory(cat: AssignCategory): UsageType[] {
  return (Object.entries(USAGE_TYPE_CATEGORIES) as [UsageType, AssignCategory][])
    .filter(([, c]) => c === cat)
    .map(([key]) => key);
}

// ─── AI generation settings (B.1.4) ───

// Single source of truth for the key shared with SettingsPanel (see ai-service.ts).
const AI_SETTINGS_KEY = AI_SETTINGS_STORAGE_KEY;

function loadAISettings() {
  try {
    return JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const savedSettings = loadAISettings();
const streamingEnabled = ref<boolean>(savedSettings.streaming !== false);
const splitGenEnabled = ref<boolean>(savedSettings.splitGen === true);
/**
 * Context Compiler v1 (2026-09-04): dedup + projection of the split-gen SECOND call's
 * context. Default ON (PO decision Q2); absent key = on. Read every round by
 * game-orchestrator.ts `readAISettings` → ctx.meta.contextCompiler → ContextAssemblyStage.
 */
const contextCompilerEnabled = ref<boolean>(savedSettings.contextCompiler !== false);
const maxRetries = ref<number>(savedSettings.maxRetries ?? 1);
/**
 * §11.2 B: NSFW 私密信息修复重试次数（0-3）
 * 首次调用是必定的（下方 PrivacyProfileRepairPipeline 首次扫描到缺失时总会调一次），
 * 此值控制失败/不完整时额外再调几次。默认 1（= 最多 2 次调用）。
 */
const privacyRepairRetries = ref<number>(
  typeof savedSettings.privacyRepairRetries === 'number' ? savedSettings.privacyRepairRetries : 1,
);
/**
 * 主 generate 请求超时（分钟，1–30，默认 10）。仅作用于 AI 回合/生成主请求，
 * 不影响连通测试 / embedding / rerank / 图像生成的专用短超时。
 */
const requestTimeoutMinutes = ref<number>(
  typeof savedSettings.requestTimeoutMinutes === 'number'
    ? savedSettings.requestTimeoutMinutes
    : REQUEST_TIMEOUT_DEFAULT_MINUTES,
);

function saveAISettings() {
  try {
    // Read-merge: `aga_ai_settings` is co-owned with SettingsPanel (lowLoadMode /
    // lowLoadMaxRequests). A full-object overwrite here would silently drop those
    // keys on every toggle. Preserve any co-tenant keys and only write the fields
    // this panel owns (streaming / splitGen / contextCompiler / maxRetries /
    // privacyRepairRetries / requestTimeoutMinutes). (Mirrors SettingsPanel.saveLowLoadSettings's read-merge.)
    // Clamp timeout to the legal range so localStorage / backups never hold an
    // out-of-bounds value even if the number input is bypassed. Route through the
    // engine's canonical clamp helper (single source of truth) instead of a hand-rolled
    // copy — this keeps edge cases (0, NaN, out-of-range) identical to the restore path
    // in applyPersistedAISettings. Reflect the clamped value back into the ref so the
    // UI shows what was actually stored.
    const clampedTimeoutMs = requestTimeoutMinutesToMs(Number(requestTimeoutMinutes.value));
    const clampedTimeout = clampedTimeoutMs / 60_000;
    requestTimeoutMinutes.value = clampedTimeout;

    const existing = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({
      ...existing,
      streaming: streamingEnabled.value,
      splitGen: splitGenEnabled.value,
      contextCompiler: contextCompilerEnabled.value,
      maxRetries: maxRetries.value,
      privacyRepairRetries: privacyRepairRetries.value,
      requestTimeoutMinutes: clampedTimeout,
    }));
    // Sync to aiService if available
    if (aiService) {
      aiService.maxRetries = maxRetries.value;
      aiService.requestTimeoutMs = clampedTimeoutMs;
    }
  } catch { /* ignore */ }
}

// ─── Connection test (B.1.1) ───

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
const testStatuses = ref<Record<string, TestStatus>>({});
const testLatencies = ref<Record<string, number>>({});

async function testConnection(api: APIConfig): Promise<void> {
  if (testStatuses.value[api.id] === 'testing') return;
  if (!aiService) {
    eventBus.emit('ui:toast', { type: 'warning', message: t('api.test.noService'), duration: 2000 });
    return;
  }
  // TTS / STT (CosyVoice) need neither apiKey nor model — only a reachable URL.
  const preflightOk = (api.apiCategory === 'tts' || api.apiCategory === 'stt')
    ? !!api.url
    : !!(api.url && api.apiKey && api.model);
  if (!preflightOk) {
    eventBus.emit('ui:toast', { type: 'warning', message: t('api.test.preflight'), duration: 2000 });
    return;
  }

  testStatuses.value[api.id] = 'testing';
  // CR-R18: 在 toast 中展示正在测试的类别（LLM/Embedding/Rerank），让用户
  // 明确知道走的是哪条端点路径 —— 特别在配置 SiliconFlow 这类多端点 provider 时
  // 能一眼看出 "我点的是 Rerank 按钮，走的确实是 /rerank 端点"。
  const categoryForToast = getCategoryMeta(api.apiCategory ?? 'llm').label;
  try {
    // §11.3: 按 apiCategory 测试对应的端点（LLM → chat/completions，
    // Embedding → /v1/embeddings，Rerank → /v1/rerank）
    const result = await aiService.testConnection({
      url: api.url,
      apiKey: api.apiKey,
      model: api.model,
      apiCategory: api.apiCategory ?? 'llm',
      backend: api.backend,
      customRoutingPath: api.useCustomRouting ? api.customRoutingPath : undefined,
      credentials: api.credentials,
    });
    testStatuses.value[api.id] = result.ok ? 'ok' : 'error';
    testLatencies.value[api.id] = result.latencyMs;
    if (result.ok) {
      eventBus.emit('ui:toast', {
        type: 'success',
        message: t('api.test.success', { name: api.name, category: categoryForToast, latency: result.latencyMs }),
        duration: 2500,
      });
    } else {
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('api.test.failed', { name: api.name, category: categoryForToast, error: result.error }),
        duration: 4000,
      });
    }
  } catch (e) {
    testStatuses.value[api.id] = 'error';
    eventBus.emit('ui:toast', {
      type: 'error',
      message: t('api.test.exception', { name: api.name, category: categoryForToast }),
      duration: 3000,
    });
  }
}

// ─── Model fetch (B.1.2) ───

const availableModels = ref<string[]>([]);
const isFetchingModels = ref(false);
const MODEL_DATALIST_ID = 'api-model-list';

async function fetchModelsForForm(): Promise<void> {
  if (!aiService) return;
  if (!form.value.url || !form.value.apiKey) {
    eventBus.emit('ui:toast', { type: 'warning', message: t('api.fetchModels.preflight'), duration: 2000 });
    return;
  }
  isFetchingModels.value = true;
  try {
    const models = await aiService.fetchModels({ url: form.value.url, apiKey: form.value.apiKey, provider: form.value.provider, backend: form.value.backend || undefined });
    availableModels.value = models;
    if (models.length === 0) {
      eventBus.emit('ui:toast', { type: 'warning', message: t('api.fetchModels.empty'), duration: 2000 });
    } else {
      eventBus.emit('ui:toast', { type: 'success', message: t('api.fetchModels.success', { count: models.length }), duration: 2000 });
    }
  } catch (e) {
    eventBus.emit('ui:toast', { type: 'error', message: t('api.fetchModels.error', { error: (e as Error).message?.slice(0, 60) }), duration: 3000 });
  } finally {
    isFetchingModels.value = false;
  }
}

// ─── Add/Edit modal ───

const showEditModal = ref(false);
const isNewAPI = ref(false);
const editingId = ref('');

interface APIFormData {
  name: string;
  /** §11.3: API 类别 — 决定调用时走哪条路径 */
  apiCategory: APICategory;
  provider: APIProviderType;
  url: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  enabled: boolean;
  /** §11.3: 高级 — 使用自定义路径覆盖默认 /v1/embeddings 或 /v1/rerank */
  useCustomRouting: boolean;
  /** §11.3: 高级 — 自定义路径内容（如 "/v2/embeddings"） */
  customRoutingPath: string;
  /** 禁用 assistant prefill — 部分反代理不支持 */
  disablePrefill: boolean;
  /** 严格消息格式兼容 — 中途 system 转 user + 强制 user 结尾（如经 gproxy 的 Opus） */
  strictMessageFormat: boolean;
  /** gproxy 缓存 — 主回合把静态规则块提到最前 + 埋魔法串触发 prompt 缓存 */
  gproxyPromptCache: boolean;
  /** 强制流式 — 所有请求（含后台/非正文）走流式传输，适配只支持流式的供应商 */
  forceStreaming: boolean;
  /** 非 llm 类别的 backend 身份（目录描述符 id；'custom' = 未识别/自定义）——落盘持久化 */
  backend: string;
  /** 多凭证 backend 的附加凭证（键由描述符 credentialFields 声明） */
  credentials: Record<string, string>;
}

/**
 * 三选一类别定义 — 用于编辑弹窗顶部的 segment 控件
 */
function getCategoryMeta(cat: APICategory): { label: string; desc: string } {
  return {
    label: t(`api.apiCategory.${cat}`),
    desc: t(`api.apiCategory.${cat}.desc`),
  };
}

const CATEGORY_OPTIONS: APICategory[] = ['llm', 'embedding', 'rerank', 'image', 'tts', 'stt'];

/** Provider picker options for the edit modal (AgaSelect). */
const PROVIDER_VALUES: APIProviderType[] = ['openai', 'claude', 'gemini', 'deepseek', 'custom'];
/**
 * llm 目录预设（epic P4 / D4）：目录里不属于 APIProviderType 的 llm 条目
 * （如 volcano_ark）。选中后以 provider:'custom' + backend:<id> 落盘，
 * OpenAIProvider / 连测 / fetchModels 据 backend 解析该预设的端点路径。
 */
const LLM_PRESET_IDS: string[] = providerCatalog
  .byCategory('llm')
  .map((d) => d.id)
  .filter((id) => !(PROVIDER_VALUES as string[]).includes(id));
const providerOptions = computed<SelectOption[]>(() => [
  ...PROVIDER_VALUES.map((p) => ({ label: t(`api.form.provider.${p}`), value: p })),
  ...LLM_PRESET_IDS.map((id) => ({ label: t(`api.backend.${id}`), value: id })),
]);
/** 下拉显示值：llm 预设配置显示预设名，其余显示 provider。 */
const providerSelectValue = computed(() =>
  (form.value.apiCategory === 'llm' && LLM_PRESET_IDS.includes(form.value.backend))
    ? form.value.backend
    : form.value.provider,
);
function onProviderSelect(v: string): void {
  availableModels.value = [];
  if (LLM_PRESET_IDS.includes(v)) {
    const d = providerCatalog.get('llm', v);
    form.value.provider = 'custom';
    form.value.backend = v;
    form.value.url = d?.urlPreset ?? '';
    form.value.model = d?.defaultModel ?? '';
    return;
  }
  form.value.provider = v as APIProviderType;
  form.value.backend = '';
  onProviderChange();
}
/** llm 预设可能声明"无模型列表端点"（modelsPath 缺省）→ 隐藏获取模型按钮。 */
const modelsFetchAvailable = computed(() => {
  if (form.value.apiCategory === 'image') return false;
  if (form.value.apiCategory === 'llm' && LLM_PRESET_IDS.includes(form.value.backend)) {
    return !!providerCatalog.get('llm', form.value.backend)?.modelsPath;
  }
  return true;
});

/**
 * Backend selector (image today, voice from epic P2) — derived from the
 * provider catalog (epic P0 §3.3): options, URL presets, model placeholders
 * and hints all come from the descriptors; the chosen id persists on the
 * config as `backend` (no more URL sniffing on edit).
 */
const imageBackendOptions = computed<SelectOption[]>(() => [
  ...providerCatalog.byCategory('image').map((d) => ({ label: t(`api.backend.${d.id}`), value: d.id })),
  { label: t('api.backend.custom'), value: 'custom' },
]);

/** 三个需要 backend 身份的类别共用的选择器选项（epic P2 起 tts/stt 也多后端）。 */
const backendSelectorOptions = computed<SelectOption[]>(() => {
  const cat = form.value.apiCategory;
  if (cat === 'image') return imageBackendOptions.value;
  if (cat === 'tts' || cat === 'stt') {
    return providerCatalog.byCategory(cat).map((d) => ({ label: t(`api.backend.${d.id}`), value: d.id }));
  }
  return [];
});

function onBackendChange(): void {
  const cat = form.value.apiCategory;
  if (cat !== 'image' && cat !== 'tts' && cat !== 'stt') return;
  const d = providerCatalog.get(cat, form.value.backend);
  form.value.url = d?.urlPreset ?? '';
  form.value.model = cat === 'image' ? '' : (d?.defaultModel ?? '');
  availableModels.value = [];
}

/**
 * apiKey 输入框按所选 backend 的凭证声明显隐：声明里没有 'apiKey' 的
 * backend（豆包语音——三凭证走 extraCredentialFields）隐藏通用 Key 框。
 */
const apiKeyFieldVisible = computed(() => {
  const cat = form.value.apiCategory;
  if (cat !== 'image' && cat !== 'tts' && cat !== 'stt') return true;
  const d = providerCatalog.get(cat, form.value.backend);
  if (!d) return true; // 'custom' / 未知 → 保留通用 Key 框
  return d.credentialFields.some((f) => f.key === 'apiKey');
});

const activeImagePreset = computed(() => {
  const id = form.value.backend || 'custom';
  const d = providerCatalog.get('image', id);
  return {
    label: t(`api.backend.${id}`),
    url: d?.urlPreset ?? '',
    modelPlaceholder: d?.defaultModel ?? '',
    modelHint: t(`api.backend.hint.${id}`),
  };
});

/**
 * Extra credential inputs beyond the shared apiKey field — declared by the
 * selected backend's descriptor (epic P0 multi-credential mechanism; consumed
 * by Doubao voice, which declares appId/accessToken/resourceId — epic P2).
 */
const extraCredentialFields = computed(() => {
  const cat = form.value.apiCategory;
  if (cat !== 'image' && cat !== 'tts' && cat !== 'stt') return [];
  const d = providerCatalog.get(cat, form.value.backend);
  return (d?.credentialFields ?? []).filter((f) => f.key !== 'apiKey');
});

const form = ref<APIFormData>({
  name: '',
  apiCategory: 'llm',
  provider: 'openai',
  url: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 16000,
  enabled: true,
  useCustomRouting: false,
  customRoutingPath: '',
  disablePrefill: false,
  strictMessageFormat: false,
  gproxyPromptCache: false,
  forceStreaming: false,
  backend: '',
  credentials: {},
});

function openAddModal(): void {
  isNewAPI.value = true;
  editingId.value = '';
  availableModels.value = [];
  // CR-R10: 每次打开弹窗都清空类别缓存
  categoryFormCache.value = {};
  form.value = {
    name: '',
    apiCategory: 'llm',
    provider: 'openai',
    url: API_PROVIDER_PRESETS.openai.url,
    apiKey: '',
    model: API_PROVIDER_PRESETS.openai.defaultModel,
    temperature: 0.7,
    maxTokens: 16000,
    enabled: true,
    useCustomRouting: false,
    customRoutingPath: '',
    disablePrefill: false,
    strictMessageFormat: false,
    gproxyPromptCache: false,
    forceStreaming: false,
    backend: '',
    credentials: {},
  };
  showEditModal.value = true;
}

/** 把一份已有配置铺进弹窗表单（编辑与复制共用的字段映射）。 */
function fillFormFromConfig(api: APIConfig): void {
  availableModels.value = [];
  // CR-R10: 每次打开弹窗都清空类别缓存
  categoryFormCache.value = {};
  form.value = {
    name: api.name,
    apiCategory: api.apiCategory ?? 'llm', // 向后兼容旧配置
    provider: api.provider,
    url: api.url,
    apiKey: api.apiKey,
    model: api.model,
    temperature: api.temperature,
    maxTokens: api.maxTokens,
    enabled: api.enabled,
    useCustomRouting: api.useCustomRouting ?? false,
    customRoutingPath: api.customRoutingPath ?? '',
    disablePrefill: api.disablePrefill ?? false,
    strictMessageFormat: api.strictMessageFormat ?? false,
    gproxyPromptCache: api.gproxyPromptCache ?? false,
    forceStreaming: api.forceStreaming ?? false,
    // 落盘的显式选择（loadFromStorage 的回填迁移保证旧配置也有值）；
    // 兜底 'custom'/'cosyvoice' 仅防御手工改过 localStorage 的极端情况。
    backend: api.backend
      ?? ((api.apiCategory === 'tts' || api.apiCategory === 'stt') ? 'cosyvoice'
        : api.apiCategory === 'image' ? 'custom' : ''),
    credentials: { ...(api.credentials ?? {}) },
  };
}

function openEditModal(api: APIConfig): void {
  isNewAPI.value = false;
  editingId.value = api.id;
  fillFormFromConfig(api);
  showEditModal.value = true;
}

/**
 * 复制一份已有配置：以"新增"模式打开弹窗并预填克隆值（名称加"副本"后缀）。
 * 用户可先改再保存；取消则什么都不会创建 —— 不产生未确认的孤儿副本。
 */
function duplicateAPI(api: APIConfig): void {
  isNewAPI.value = true;
  editingId.value = '';
  fillFormFromConfig(api);
  form.value.name = t('api.card.copyName', { name: api.name });
  showEditModal.value = true;
}

/**
 * §11.3: 切换 API 类别时的字段处理
 *
 * CR-R10 (2026-04-11)：升级为 per-category 缓存模式。
 * 之前版本会把 temperature/maxTokens/provider 强制重置到类别默认值，
 * 导致用户如果"LLM 填了一半 → 切 Embedding 看一眼 → 切回 LLM"时
 * 已经填好的 temperature/maxTokens 被清零，体验很糟。
 *
 * 新策略：
 * 1. 切出时把"当前类别相关字段"存到 `categoryFormCache[旧类别]`
 * 2. 切入时若 `categoryFormCache[新类别]` 存在则恢复，否则用默认值
 * 3. name / apiKey 不属于任何类别 —— 始终保留（用户角度"它们是全局的"）
 *
 * 每个类别相关的字段集合：
 * - llm:       provider, url, model, temperature, maxTokens
 * - embedding: url, model, useCustomRouting, customRoutingPath
 * - rerank:    url, model, useCustomRouting, customRoutingPath
 */
interface CategorySlice {
  provider: APIProviderType;
  url: string;
  model: string;
  temperature: number;
  maxTokens: number;
  useCustomRouting: boolean;
  customRoutingPath: string;
  /** 非 llm 类别的 backend 身份 + 附加凭证（epic P0）——随类别切换一起缓存/恢复 */
  backend: string;
  credentials: Record<string, string>;
}

/**
 * 每个类别对应的字段缓存。切换时先把当前表单字段存入当前类别的 slot，
 * 再从目标类别 slot 恢复（或使用默认值）。跟随 form 的生命周期 —
 * 关闭弹窗时 reset（见 openAddModal / openEditModal）。
 */
const categoryFormCache = ref<Partial<Record<APICategory, CategorySlice>>>({});

/** 类别默认值 —— 仅在首次切入且无缓存时使用 */
const CATEGORY_DEFAULTS: Record<APICategory, CategorySlice> = {
  llm: {
    provider: 'openai',
    url: API_PROVIDER_PRESETS.openai.url,
    model: API_PROVIDER_PRESETS.openai.defaultModel,
    temperature: 0.7,
    maxTokens: 16000,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: '',
    credentials: {},
  },
  embedding: {
    provider: 'custom',
    url: '',
    model: '',
    temperature: 0,
    maxTokens: 0,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: '',
    credentials: {},
  },
  rerank: {
    provider: 'custom',
    url: '',
    model: '',
    temperature: 0,
    maxTokens: 0,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: '',
    credentials: {},
  },
  // 首次切入 image 默认选 Civitai 并预填其 URL（与旧行为一致，来源改为目录）
  image: {
    provider: 'custom',
    url: providerCatalog.get('image', 'civitai')?.urlPreset ?? '',
    model: '',
    temperature: 0,
    maxTokens: 0,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: 'civitai',
    credentials: {},
  },
  // tts/stt 默认值取目录当前唯一语音条目的预设（epic P0 派生；P2 起由 backend 选择器主导）
  tts: {
    provider: 'custom',
    url: providerCatalog.byCategory('tts')[0]?.urlPreset ?? '',
    model: providerCatalog.byCategory('tts')[0]?.defaultModel ?? '',
    temperature: 0,
    maxTokens: 0,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: providerCatalog.byCategory('tts')[0]?.id ?? '',
    credentials: {},
  },
  stt: {
    provider: 'custom',
    url: providerCatalog.byCategory('stt')[0]?.urlPreset ?? '',
    model: providerCatalog.byCategory('stt')[0]?.defaultModel ?? '',
    temperature: 0,
    maxTokens: 0,
    useCustomRouting: false,
    customRoutingPath: '',
    backend: providerCatalog.byCategory('stt')[0]?.id ?? '',
    credentials: {},
  },
};

/** 当前表单字段 → CategorySlice */
function snapshotCurrentSlice(): CategorySlice {
  return {
    provider: form.value.provider,
    url: form.value.url,
    model: form.value.model,
    temperature: form.value.temperature,
    maxTokens: form.value.maxTokens,
    useCustomRouting: form.value.useCustomRouting,
    customRoutingPath: form.value.customRoutingPath,
    backend: form.value.backend,
    credentials: { ...form.value.credentials },
  };
}

/** CategorySlice → 当前表单字段 */
function applySlice(slice: CategorySlice): void {
  form.value.provider = slice.provider;
  form.value.url = slice.url;
  form.value.model = slice.model;
  form.value.temperature = slice.temperature;
  form.value.maxTokens = slice.maxTokens;
  form.value.useCustomRouting = slice.useCustomRouting;
  form.value.customRoutingPath = slice.customRoutingPath;
  form.value.backend = slice.backend;
  form.value.credentials = { ...slice.credentials };
}

/**
 * 切换类别时的主处理：缓存 + 恢复
 *
 * previousCategory 参数来自 segment 控件的 @click，
 * 因为 v-model 已经把 form.apiCategory 切到新值之后才触发 onCategoryChange，
 * 单独参数能让我们正确寻找"切出"的类别 slot。
 */
function onCategoryChange(previousCategory: APICategory): void {
  const newCat = form.value.apiCategory;
  if (newCat === previousCategory) return;
  availableModels.value = [];
  // 1. 把当前表单字段存到"切出"类别的 slot
  categoryFormCache.value[previousCategory] = snapshotCurrentSlice();
  // 2. 从"切入"类别恢复，或用默认值（slice 已含 backend/credentials —— image 默认
  //    civitai + 预填 URL、tts/stt 默认目录唯一语音条目,与旧行为一致,来源改为目录）
  const cached = categoryFormCache.value[newCat];
  applySlice(cached ?? CATEGORY_DEFAULTS[newCat]);
}

function onProviderChange(): void {
  const preset = API_PROVIDER_PRESETS[form.value.provider];
  if (preset) {
    form.value.url = preset.url;
    form.value.model = preset.defaultModel;
  }
  availableModels.value = [];
}

/**
 * 表单保存级校验：仅 name + url 必填。
 *
 * apiKey / model 在保存时可留空 —— 部分本地或企业网关不需要 key，
 * model 也可以留到实际调用时再填（或走 provider 默认）。测试连接 /
 * 拉取模型列表仍在各自按钮上做更严格的 preflight 检查。
 */
const formValidationError = computed<string | null>(() => {
  if (!form.value.name.trim()) return t('api.form.validationNameRequired');
  if (!form.value.url.trim()) return t('api.form.validationUrlRequired');
  // 多凭证 backend 的必填附加凭证（epic P2 checklist ④：三字段缺一有校验提示）。
  // 通用 apiKey 沿既有政策保存时可留空，不在此强制。
  for (const field of extraCredentialFields.value) {
    if (field.required && !(form.value.credentials[field.key] ?? '').trim()) {
      return t('api.form.validationCredentialRequired', { name: t(field.i18nKey) });
    }
  }
  return null;
});

function saveAPI(): void {
  // CR-R3: 服务端兜底校验（即使按钮被误点也不会保存不完整配置）
  const err = formValidationError.value;
  if (err) {
    eventBus.emit('ui:toast', { type: 'error', message: err, duration: 2000 });
    return;
  }
  // Epic P0：backend 仅对需要身份的类别落盘（P4 起 llm 目录预设也落盘）；
  // credentials 剔除空值、无内容不落字段
  const needsBackend = form.value.apiCategory === 'image' || form.value.apiCategory === 'tts' || form.value.apiCategory === 'stt';
  const isLlmPreset = form.value.apiCategory === 'llm' && LLM_PRESET_IDS.includes(form.value.backend);
  const cleanedCredentials = Object.fromEntries(
    Object.entries(form.value.credentials).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
  );
  const payload = {
    ...form.value,
    backend: needsBackend ? (form.value.backend || 'custom') : (isLlmPreset ? form.value.backend : undefined),
    credentials: Object.keys(cleanedCredentials).length > 0 ? cleanedCredentials : undefined,
  };
  if (isNewAPI.value) {
    apiStore.addAPI(payload);
    eventBus.emit('ui:toast', { type: 'success', message: t('api.toast.added'), duration: 1500 });
  } else {
    apiStore.updateAPI(editingId.value, payload);
    // Reset test status when config is updated
    delete testStatuses.value[editingId.value];
    eventBus.emit('ui:toast', { type: 'success', message: t('api.toast.updated'), duration: 1500 });
  }
  showEditModal.value = false;
}

function deleteAPI(id: string): void {
  try {
    apiStore.deleteAPI(id);
    delete testStatuses.value[id];
    eventBus.emit('ui:toast', { type: 'warning', message: t('api.toast.deleted'), duration: 1500 });
  } catch (e) {
    eventBus.emit('ui:toast', { type: 'error', message: (e as Error).message, duration: 2500 });
  }
}

// ─── Assignment modal ───

const showAssignModal = ref(false);

watch(showAssignModal, (open) => {
  if (open) {
    featureToggles.value = loadFeatureToggles();
    const saved = localStorage.getItem(ACTIVE_PRESET_KEY) ?? '';
    const exists = !saved || apiStore.assignmentPresets.some((p) => p.id === saved);
    selectedPresetId.value = exists ? saved : '';
  }
});

/**
 * CR-R11 (2026-04-11)：功能分配弹窗 "显示全部 API" 开关
 *
 * 默认（false）：下拉框按 usageType 的 requiredCategoryFor 过滤 —
 *   例如 embedding 槽位只显示 apiCategory='embedding' 的 API，
 *   避免用户误把 LLM 分给向量化。
 * 开启（true）：绕过类别过滤，显示所有 API（即使类别不匹配也能选）。
 *   用户角度："我就是要强制分配一个类别不符的 API，别拦我。"
 *   适用场景：自建网关把不同类别路由到同一个 endpoint，
 *   或用户想让一个 LLM 勉强跑 rerank 任务。
 * 类别不匹配的选项仍然带 "⚠ 类别不匹配" 标记，保留警示效果。
 */
const showAllInAssign = ref(false);

// ─── Assignment presets ───

const ACTIVE_PRESET_KEY = 'aga_active_preset_id';
const selectedPresetId = ref(localStorage.getItem(ACTIVE_PRESET_KEY) ?? '');
const showPresetNameModal = ref(false);
const presetNameInput = ref('');
const staleAssignmentTypes = reactive(new Set<string>());

const presetDropdownOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [
    { label: t('api.preset.new'), value: '' },
  ];
  for (const p of apiStore.assignmentPresets) {
    opts.push({ label: p.name, value: p.id });
  }
  return opts;
});

function setActivePreset(id: string): void {
  selectedPresetId.value = id;
  try { localStorage.setItem(ACTIVE_PRESET_KEY, id); } catch { /* ignore */ }
}

function onPresetSelect(value: string): void {
  setActivePreset(value);
  staleAssignmentTypes.clear();
}

function onApplyPreset(): void {
  const preset = apiStore.assignmentPresets.find((p) => p.id === selectedPresetId.value);
  if (!preset) return;

  staleAssignmentTypes.clear();
  const existingIds = new Set(apiStore.apiConfigs.map((c) => c.id));

  for (const a of preset.assignments) {
    if (!(a.type in USAGE_TYPE_CATEGORIES)) continue;
    const usageType = a.type as UsageType;
    if (a.apiId === 'default' || existingIds.has(a.apiId)) {
      apiStore.assignAPI(usageType, a.apiId);
    } else {
      apiStore.assignAPI(usageType, 'default');
      staleAssignmentTypes.add(a.type);
    }
  }

  // Merge over current toggles instead of full-replace: an older preset (saved
  // before a newer toggle key existed) does not carry that key, and a full-replace
  // would drop it — silently flipping the newer feature back to its default. Keep
  // current values for keys the preset doesn't mention.
  featureToggles.value = { ...featureToggles.value, ...preset.featureToggles };
  try {
    localStorage.setItem(FEATURE_TOGGLES_KEY, JSON.stringify(featureToggles.value));
  } catch { /* ignore */ }

  if (staleAssignmentTypes.size > 0) {
    eventBus.emit('ui:toast', {
      type: 'warning',
      message: t('api.preset.staleWarning', { count: staleAssignmentTypes.size }),
      duration: 4000,
    });
  } else {
    eventBus.emit('ui:toast', { type: 'success', message: t('api.preset.applied'), duration: 1500 });
  }
}

function onSavePreset(): void {
  if (selectedPresetId.value) {
    const preset = apiStore.assignmentPresets.find((p) => p.id === selectedPresetId.value);
    presetNameInput.value = preset?.name ?? '';
  } else {
    presetNameInput.value = '';
  }
  showPresetNameModal.value = true;
}

function confirmSavePreset(): void {
  const name = presetNameInput.value.trim();
  if (!name) return;

  const newId = apiStore.savePreset(
    name,
    apiStore.apiAssignments,
    featureToggles.value,
    selectedPresetId.value || undefined,
  );
  setActivePreset(newId);
  showPresetNameModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('api.preset.saved'), duration: 1500 });
}

function onDeletePreset(): void {
  if (!selectedPresetId.value) return;
  apiStore.deletePreset(selectedPresetId.value);
  setActivePreset('');
  eventBus.emit('ui:toast', { type: 'info', message: t('api.preset.deleted'), duration: 1500 });
}

function assignAPI(type: UsageType, apiId: string): void {
  apiStore.assignAPI(type, apiId);
  staleAssignmentTypes.delete(type);
  eventBus.emit('ui:toast', { type: 'info', message: t('api.assign.updated'), duration: 1000 });
}



function getAssignedApiId(type: UsageType): string {
  return apiStore.apiAssignments.find((a) => a.type === type)?.apiId ?? 'default';
}

function providerName(provider: APIProviderType): string {
  return API_PROVIDER_PRESETS[provider]?.name ?? provider;
}

/**
 * §11.3: 根据 UsageType 确定应该使用哪个 apiCategory 的 API
 *
 * - embedding → 'embedding'
 * - rerank    → 'rerank'
 * - 其他所有 → 'llm'
 */
function requiredCategoryFor(type: UsageType): APICategory {
  if (type === 'embedding') return 'embedding';
  if (type === 'rerank') return 'rerank';
  if (type === 'imageGeneration' || type.startsWith('imageGen_')) return 'image';
  if (type.startsWith('ttsGen_')) return 'tts';
  if (type.startsWith('sttGen_')) return 'stt';
  return 'llm';
}

/**
 * §11.3: 按 UsageType 过滤可用的 API 列表
 *
 * 只返回 apiCategory 与 usageType 匹配的 API，防止用户把 LLM 分配给 embedding
 * 或把 rerank 分配给 main 等错误配置。
 *
 * 特殊处理：当前分配的 API 即使类别不匹配也要保留在列表中（否则 dropdown 显示为空），
 * 但额外加一个"（类别不匹配）"标记，让用户有机会看到并自行修正。
 */
function getAssignableAPIs(type: UsageType): APIConfig[] {
  // CR-R11: "显示全部" 开关开启时直接返回所有 API（带 mismatch 标记）
  if (showAllInAssign.value) return [...apiStore.apiConfigs];

  const required = requiredCategoryFor(type);
  const currentAssigned = getAssignedApiId(type);
  return apiStore.apiConfigs.filter((api) => {
    const cat = api.apiCategory ?? 'llm';
    if (cat === required) return true;
    // 保留已分配但类别不符的 API（显示警告）
    if (api.id === currentAssigned) return true;
    return false;
  });
}

/**
 * 判断某个 API 是否与指定 usageType 的类别匹配（用于 UI 警告显示）
 */
function isApiCategoryMismatch(api: APIConfig, type: UsageType): boolean {
  const required = requiredCategoryFor(type);
  return (api.apiCategory ?? 'llm') !== required;
}

/**
 * per-backend 行（imageGen_* / ttsGen_* / sttGen_*）的 backend 不匹配判断
 * （2026-08-26 review：类别匹配但 backend 不同——如把 CosyVoice 配置分给
 * "豆包配音"行——也必须给 ⚠ 警告，否则会用 A 家配置去造 B 家 provider）。
 */
function isApiBackendMismatch(api: APIConfig, type: UsageType): boolean {
  const perBackend = parsePerBackendUsage(type);
  if (!perBackend) return false;
  if (isApiCategoryMismatch(api, type)) return false; // 类别警告已覆盖
  return (api.backend ?? '') !== perBackend.backend;
}

/**
 * Build the per-usageType assignment dropdown options as SelectOption[] for AgaSelect.
 * PRESERVES the exact label logic from the prior native <select>:
 *  - empty placeholder when no assignable API matches
 *  - ' (disabled)' suffix for disabled APIs
 *  - ' ⚠ mismatch' suffix when the API's category does not match the slot
 */
function getAssignableAPIOptions(type: UsageType): SelectOption[] {
  const apis = getAssignableAPIs(type);
  if (apis.length === 0) {
    return [{ label: t('api.assign.noMatch'), value: '' }];
  }
  return apis.map((api) => ({
    value: api.id,
    label:
      api.name +
      (!api.enabled ? ' ' + t('api.assign.disabled') : '') +
      (isApiCategoryMismatch(api, type) ? ' ⚠ ' + t('api.assign.mismatch')
        : isApiBackendMismatch(api, type) ? ' ⚠ ' + t('api.assign.backendMismatch') : ''),
  }));
}
</script>

<template>
  <div class="api-panel">
    <!-- ─── Header ─── -->
    <header class="panel-header">
      <h2 class="panel-title">{{ $t('api.title') }}</h2>
      <div class="header-actions">
        <AgaButton variant="secondary" size="sm" @click="showAssignModal = true">{{ $t('api.assignBtn') }}</AgaButton>
        <AgaButton variant="primary" size="sm" @click="openAddModal">{{ $t('api.addApi') }}</AgaButton>
      </div>
    </header>

    <!-- ─── API list ─── -->
    <div v-if="apiStore.apiConfigs.length" class="api-list">
      <div
        v-for="api in apiStore.apiConfigs"
        :key="api.id"
        :class="['api-card', { 'api-card--disabled': !api.enabled }]"
      >
        <div class="api-header">
          <div class="api-title-area">
            <!-- Status dot (B.1.1) -->
            <Tooltip :text="testStatuses[api.id] === 'ok' ? `${testLatencies[api.id]}ms` : (testStatuses[api.id] ?? $t('api.test.untested'))">
              <span :class="['status-dot', `status-dot--${testStatuses[api.id] ?? 'idle'}`]" />
            </Tooltip>
            <span class="api-name">{{ api.name }}</span>
            <!-- §11.3: API 类别 badge -->
            <Tooltip :text="getCategoryMeta(api.apiCategory ?? 'llm').desc">
              <span :class="['api-category-badge', `api-category-badge--${api.apiCategory ?? 'llm'}`]">
                {{ getCategoryMeta(api.apiCategory ?? 'llm').label }}
              </span>
            </Tooltip>
            <span v-if="(api.apiCategory ?? 'llm') === 'llm'" class="api-provider">{{ providerName(api.provider) }}</span>
            <span v-if="testStatuses[api.id] === 'ok'" class="latency-badge">
              {{ testLatencies[api.id] }}ms
            </span>
          </div>
          <div class="api-actions">
            <Tooltip :text="api.enabled ? $t('api.card.disable') : $t('api.card.enable')" interactive>
              <AgaToggle
                :modelValue="api.enabled"
                :label="api.enabled ? $t('api.card.disable') : $t('api.card.enable')"
                @update:modelValue="() => apiStore.toggleAPI(api.id)"
              />
            </Tooltip>
          </div>
        </div>

        <div class="api-details">
          <div class="detail-item">
            <span class="detail-label">{{ $t('api.card.url') }}</span>
            <span class="detail-value detail-value--mono">{{ api.url || $t('api.card.notSet') }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">{{ $t('api.card.model') }}</span>
            <span class="detail-value">{{ api.model || $t('api.card.notSet') }}</span>
          </div>
          <!-- §11.3: 温度仅 LLM 类别显示 -->
          <div v-if="(api.apiCategory ?? 'llm') === 'llm'" class="detail-item">
            <span class="detail-label">{{ $t('api.card.temperature') }}</span>
            <span class="detail-value detail-value--mono">{{ api.temperature }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">{{ $t('api.card.key') }}</span>
            <span class="detail-value detail-value--mono">
              {{ api.apiKey ? $t('api.card.keyMasked') + api.apiKey.slice(-4) : $t('api.card.notSet') }}
            </span>
          </div>
        </div>

        <div class="api-footer">
          <button
            :class="['btn-sm', { 'btn-sm--testing': testStatuses[api.id] === 'testing' }]"
            :disabled="testStatuses[api.id] === 'testing'"
            @click="testConnection(api)"
          >
            {{ testStatuses[api.id] === 'testing' ? $t('api.test.testing') : $t('api.test.testConnection') }}
          </button>
          <button class="btn-sm" @click="openEditModal(api)">{{ $t('common.actions.edit') }}</button>
          <button class="btn-sm" @click="duplicateAPI(api)">{{ $t('api.card.duplicate') }}</button>
          <button
            v-if="api.id !== 'default'"
            class="btn-sm btn-sm--danger"
            @click="deleteAPI(api.id)"
          >
            {{ $t('common.actions.delete') }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="empty-state">
      <p>{{ $t('api.empty') }}</p>
    </div>

    <!-- ─── AI 生成全局设置 (B.1.4) ─── -->
    <section class="ai-settings-section">
      <h3 class="settings-title">{{ $t('api.aiSettings.title') }}</h3>
      <div class="settings-grid">
        <!-- Streaming toggle -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.streaming.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.streaming.desc') }}</span>
          </div>
          <AgaToggle
            :modelValue="streamingEnabled"
            :label="$t('api.aiSettings.streaming.label')"
            @update:modelValue="v => { streamingEnabled = v; saveAISettings(); }"
          />
        </div>

        <!-- Split generation toggle -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.splitGen.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.splitGen.desc') }}</span>
          </div>
          <AgaToggle
            :modelValue="splitGenEnabled"
            :label="$t('api.aiSettings.splitGen.label')"
            @update:modelValue="v => { splitGenEnabled = v; saveAISettings(); }"
          />
        </div>

        <!-- Context Compiler (split-gen step2 dedup + projection; docs/design/context-compiler-positioning.md) -->
        <div class="setting-row" data-testid="api-context-compiler-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.contextCompiler.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.contextCompiler.desc') }}</span>
          </div>
          <AgaToggle
            :modelValue="contextCompilerEnabled"
            :label="$t('api.aiSettings.contextCompiler.label')"
            @update:modelValue="v => { contextCompilerEnabled = v; saveAISettings(); }"
          />
        </div>

        <!-- Max retries -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.maxRetries.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.maxRetries.desc') }}</span>
          </div>
          <input
            v-model.number="maxRetries"
            type="number"
            min="0"
            max="5"
            class="retry-input"
            @change="saveAISettings()"
          />
        </div>

        <!-- §11.2 B: Privacy repair retries -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.privacyRepairRetries.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.privacyRepairRetries.desc') }}</span>
          </div>
          <input
            v-model.number="privacyRepairRetries"
            type="number"
            min="0"
            max="3"
            class="retry-input"
            @change="saveAISettings()"
          />
        </div>

        <!-- Request timeout (main generate) -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('api.aiSettings.requestTimeout.label') }}</span>
            <span class="setting-desc">{{ $t('api.aiSettings.requestTimeout.desc') }}</span>
          </div>
          <input
            v-model.number="requestTimeoutMinutes"
            type="number"
            :min="REQUEST_TIMEOUT_MIN_MINUTES"
            :max="REQUEST_TIMEOUT_MAX_MINUTES"
            class="retry-input"
            @change="saveAISettings()"
          />
        </div>
      </div>
    </section>

    <!-- ─── Add/Edit Modal ─── -->
    <Modal v-model="showEditModal" :title="isNewAPI ? $t('api.modal.addTitle') : $t('api.modal.editTitle')" width="520px">
      <div class="edit-form">

        <!-- §11.3: Three-way category segment -->
        <div class="form-group">
          <label class="form-label">{{ $t('api.form.apiCategory') }}</label>
          <div class="category-segment">
            <button
              v-for="cat in CATEGORY_OPTIONS"
              :key="cat"
              type="button"
              class="category-segment__btn"
              :class="{ 'category-segment__btn--active': form.apiCategory === cat }"
              @click="(() => { const prev = form.apiCategory; form.apiCategory = cat; onCategoryChange(prev); })()"
            >
              {{ getCategoryMeta(cat).label }}
            </button>
          </div>
          <span class="form-hint">{{ getCategoryMeta(form.apiCategory).desc }}</span>
        </div>

        <div class="form-group">
          <label class="form-label">{{ $t('api.form.name') }}</label>
          <input v-model="form.name" type="text" class="form-input" :placeholder="$t('api.form.namePlaceholder')" />
        </div>

        <!-- Provider only for LLM category (includes catalog presets like 火山方舟) -->
        <div v-if="form.apiCategory === 'llm'" class="form-group">
          <label class="form-label">{{ $t('api.form.provider') }}</label>
          <AgaSelect
            :modelValue="providerSelectValue"
            :options="providerOptions"
            @update:modelValue="v => onProviderSelect(v as string)"
          />
        </div>

        <!-- Backend selector for image / tts / stt (catalog-derived; choice persists on the config) -->
        <div v-if="form.apiCategory === 'image' || form.apiCategory === 'tts' || form.apiCategory === 'stt'" class="form-group">
          <label class="form-label">{{ form.apiCategory === 'image' ? $t('api.form.imageBackend') : $t('api.form.backend') }}</label>
          <AgaSelect
            :modelValue="form.backend"
            :options="backendSelectorOptions"
            @update:modelValue="v => { form.backend = v as string; onBackendChange(); }"
          />
        </div>

        <div class="form-group">
          <label class="form-label">{{ $t('api.form.url') }}</label>
          <input
            v-model="form.url"
            type="text"
            class="form-input"
            :placeholder="form.apiCategory === 'rerank' || form.apiCategory === 'embedding'
              ? 'https://api.siliconflow.cn'
              : form.apiCategory === 'image'
                ? activeImagePreset.url || 'https://example.com'
                : (form.apiCategory === 'tts' || form.apiCategory === 'stt')
                  ? (providerCatalog.get(form.apiCategory, form.backend)?.urlPreset || 'https://api.example.com')
                  : 'https://api.example.com'"
          />
          <span v-if="form.apiCategory === 'embedding' || form.apiCategory === 'rerank'" class="form-hint">
            {{ $t('api.form.urlHintEmbedding') }}
            <code>{{ form.apiCategory === 'rerank' ? '/v1/rerank' : '/v1/embeddings' }}</code>
          </span>
          <span v-else-if="form.apiCategory === 'image'" class="form-hint">
            {{ activeImagePreset.label }}{{ $t('api.form.urlHintImage') }}
          </span>
          <span v-else-if="form.apiCategory === 'tts' || form.apiCategory === 'stt'" class="form-hint">
            {{ $t(`api.backend.hint.${form.backend || 'cosyvoice'}`) }}
          </span>
        </div>

        <div v-if="apiKeyFieldVisible" class="form-group">
          <label class="form-label">{{ $t('api.form.apiKey') }}</label>
          <input
            v-model="form.apiKey"
            type="password"
            class="form-input"
            :placeholder="(form.apiCategory === 'tts' || form.apiCategory === 'stt') ? $t('api.form.apiKeyOptional') : 'sk-...'"
          />
          <span v-if="form.apiCategory === 'tts'" class="form-hint">{{ $t('api.form.apiKeyHintTts') }}</span>
          <span v-else-if="form.apiCategory === 'stt'" class="form-hint">{{ $t('api.form.apiKeyHintStt') }}</span>
        </div>

        <!-- Extra credentials beyond apiKey — declared by the backend's descriptor
             (epic P0 mechanism; Doubao voice renders appId/accessToken/resourceId here) -->
        <div v-for="field in extraCredentialFields" :key="field.key" class="form-group">
          <label class="form-label">{{ $t(field.i18nKey) }}</label>
          <input
            :value="form.credentials[field.key] ?? ''"
            :type="field.secret ? 'password' : 'text'"
            class="form-input"
            @input="e => { form.credentials[field.key] = (e.target as HTMLInputElement).value; }"
          />
        </div>

        <!-- Model with fetch button (B.1.2) — hidden for TTS/STT (CosyVoice needs no model) -->
        <div v-if="form.apiCategory !== 'tts' && form.apiCategory !== 'stt'" class="form-group">
          <label class="form-label">{{ $t('api.form.model') }}</label>
          <div class="model-input-row">
            <input
              v-model="form.model"
              type="text"
              list="api-model-list"
              class="form-input model-input"
              :placeholder="form.apiCategory === 'rerank'
                ? 'BAAI/bge-reranker-v2-m3'
                : form.apiCategory === 'embedding'
                  ? 'BAAI/bge-m3'
                  : form.apiCategory === 'image'
                    ? activeImagePreset.modelPlaceholder
                    : 'gpt-4o'"
            />
            <button
              v-if="modelsFetchAvailable"
              class="btn-fetch-models"
              :disabled="isFetchingModels"
              @click="fetchModelsForForm"
            >
              {{ isFetchingModels ? $t('api.form.fetchModelsBusy') : $t('api.form.fetchModels') }}
            </button>
          </div>
          <span v-if="form.apiCategory === 'image'" class="form-hint">
            {{ activeImagePreset.modelHint }}
          </span>
          <datalist :id="MODEL_DATALIST_ID">
            <option v-for="m in availableModels" :key="m" :value="m" />
          </datalist>
          <span v-if="availableModels.length > 0" class="model-hint">
            {{ $t('api.form.modelsAvailable', { count: availableModels.length }) }}
          </span>
        </div>

        <!-- Temperature + maxTokens only for LLM category -->
        <div v-if="form.apiCategory === 'llm'" class="form-row">
          <div class="form-group form-group--half">
            <label class="form-label">{{ $t('api.form.temperature') }} ({{ form.temperature }})</label>
            <input v-model.number="form.temperature" type="range" min="0" max="2" step="0.1" class="form-range" />
          </div>
          <div class="form-group form-group--half">
            <label class="form-label">{{ $t('api.form.maxTokens') }}</label>
            <input v-model.number="form.maxTokens" type="number" min="100" class="form-input" />
          </div>
        </div>

        <!-- Disable prefill toggle (LLM only) -->
        <div v-if="form.apiCategory === 'llm'" class="form-group">
          <AgaToggle v-model="form.disablePrefill" :label="$t('api.form.disablePrefill')" show-label />
          <span class="form-hint">
            {{ $t('api.form.disablePrefillHint') }}
          </span>
        </div>

        <!-- Strict message format toggle (LLM only) — mid-conv system → user + user ending -->
        <div v-if="form.apiCategory === 'llm'" class="form-group">
          <AgaToggle v-model="form.strictMessageFormat" :label="$t('api.form.strictMessageFormat')" show-label />
          <span class="form-hint">
            {{ $t('api.form.strictMessageFormatHint') }}
          </span>
        </div>

        <!-- gproxy prompt cache toggle (LLM only) — hoist static prefix + magic-cache trigger -->
        <div v-if="form.apiCategory === 'llm'" class="form-group">
          <AgaToggle v-model="form.gproxyPromptCache" :label="$t('api.form.gproxyPromptCache')" show-label />
          <span class="form-hint">
            {{ $t('api.form.gproxyPromptCacheHint') }}
          </span>
        </div>

        <!-- Force streaming toggle (LLM only) — every request uses SSE transport; for streaming-only providers -->
        <div v-if="form.apiCategory === 'llm'" class="form-group">
          <AgaToggle v-model="form.forceStreaming" :label="$t('api.form.forceStreaming')" show-label />
          <span class="form-hint">
            {{ $t('api.form.forceStreamingHint') }}
          </span>
        </div>

        <!-- §11.3: Advanced — custom routing path (embedding/rerank/tts/stt) -->
        <details v-if="form.apiCategory === 'embedding' || form.apiCategory === 'rerank' || form.apiCategory === 'tts' || form.apiCategory === 'stt'" class="form-advanced">
          <summary>{{ $t('api.form.advancedOptions') }}</summary>
          <div class="form-group">
            <AgaToggle v-model="form.useCustomRouting" :label="$t('api.form.useCustomRouting')" show-label />
            <span class="form-hint">
              {{ form.apiCategory === 'tts' ? $t('api.form.customRoutingHintTts')
                : form.apiCategory === 'stt' ? $t('api.form.customRoutingHintStt')
                : $t('api.form.customRoutingHint') }}
            </span>
          </div>
          <div v-if="form.useCustomRouting" class="form-group">
            <label class="form-label">{{ $t('api.form.customRoutingPath') }}</label>
            <input
              v-model="form.customRoutingPath"
              type="text"
              class="form-input"
              :placeholder="form.apiCategory === 'rerank' ? '/v1/rerank' : form.apiCategory === 'tts' ? '/' : form.apiCategory === 'stt' ? '/v1/audio/transcriptions' : '/v1/embeddings'"
            />
          </div>
        </details>
      </div>
      <template #footer>
        <!-- CR-R3: 错误提示 + 禁用保存按钮 -->
        <span v-if="formValidationError" class="form-validation-error">
          {{ formValidationError }}
        </span>
        <div style="flex: 1" />
        <AgaButton variant="secondary" @click="showEditModal = false">{{ $t('api.modal.cancel') }}</AgaButton>
        <AgaButton
          variant="primary"
          :disabled="!!formValidationError"
          @click="saveAPI"
        >
          {{ $t('api.modal.save') }}
        </AgaButton>
      </template>
    </Modal>

    <!-- ─── Assignment Modal (B.1.3 → categorized) ─── -->
    <Modal v-model="showAssignModal" :title="$t('api.assign.title')" width="620px">
      <div class="assign-content">
        <!-- Preset toolbar -->
        <div class="preset-toolbar">
          <AgaSelect
            class="preset-dropdown"
            :modelValue="selectedPresetId"
            :options="presetDropdownOptions"
            @update:modelValue="onPresetSelect"
          />
          <div class="preset-actions">
            <button class="btn-sm btn-sm--preset" :disabled="!selectedPresetId" @click="onApplyPreset">
              {{ $t('api.preset.apply') }}
            </button>
            <button class="btn-sm btn-sm--preset" @click="onSavePreset">
              {{ $t('api.preset.save') }}
            </button>
            <button
              class="btn-sm btn-sm--danger"
              :disabled="!selectedPresetId"
              @click="onDeletePreset"
            >
              {{ $t('common.actions.delete') }}
            </button>
          </div>
        </div>

        <div class="assign-show-all">
          <AgaToggle v-model="showAllInAssign" :label="$t('api.assign.showAll')" />
          <span>{{ $t('api.assign.showAll') }}</span>
          <span class="assign-show-all-hint">
            {{ showAllInAssign
              ? $t('api.assign.showAllHintOn')
              : $t('api.assign.showAllHintOff') }}
          </span>
        </div>

        <div v-for="cat in CATEGORY_ORDER" :key="cat" class="assign-group">
          <div class="assign-group-label">{{ getAssignCategoryMeta(cat).label }}</div>
          <span v-if="getAssignCategoryMeta(cat).hint" class="assign-group-hint">{{ getAssignCategoryMeta(cat).hint }}</span>
          <div class="assign-list">
            <div
              v-for="type in typesForCategory(cat)"
              :key="type"
              :class="['assign-row', { 'assign-row--stale': staleAssignmentTypes.has(type) }]"
            >
              <Tooltip v-if="staleAssignmentTypes.has(type)" :text="$t('api.preset.staleHint')">
                <span class="assign-stale-dot" aria-hidden="true" />
              </Tooltip>
              <span class="assign-label">
                {{ getUsageTypeMeta(type).label }}
                <Tooltip :text="getUsageTypeMeta(type).tip" position="right">
                  <span class="assign-tip-icon">?</span>
                </Tooltip>
              </span>
              <AgaSelect
                class="assign-select"
                :modelValue="getAssignedApiId(type)"
                :options="getAssignableAPIOptions(type)"
                @update:modelValue="v => assignAPI(type, v)"
              />
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-primary" @click="showAssignModal = false">{{ $t('api.assign.done') }}</button>
      </template>
    </Modal>

    <!-- ─── Preset name modal ─── -->
    <Modal v-model="showPresetNameModal" :title="$t('api.preset.saveTitle')" width="380px">
      <div class="preset-name-form">
        <label class="form-label">{{ $t('api.preset.nameLabel') }}</label>
        <input
          class="form-input preset-name-input"
          v-model="presetNameInput"
          :placeholder="$t('api.preset.namePlaceholder')"
          @keydown.enter="confirmSavePreset"
        />
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showPresetNameModal = false">{{ $t('api.modal.cancel') }}</button>
        <button class="btn-primary" :disabled="!presetNameInput.trim()" @click="confirmSavePreset">
          {{ $t('api.modal.save') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.api-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  gap: 8px;
}

/* ── API list ── */
.api-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.api-card {
  padding: 14px 16px;
  background: var(--glass-bg);
  border: none;
  border-radius: 10px;
  transition: opacity 0.15s ease;
  box-shadow: var(--lumi-inset-highlight);
}
.api-card--disabled {
  opacity: 0.5;
}

.api-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.api-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* ── Status dot (B.1.1) ── */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--idle    { background: var(--color-text-secondary, #6b7280); }
.status-dot--testing { background: var(--color-amber-400); animation: pulse 1s infinite; box-shadow: 0 0 6px color-mix(in oklch, var(--color-amber-400) 40%, transparent); }
.status-dot--ok      { background: var(--color-success); box-shadow: 0 0 6px color-mix(in oklch, var(--color-success) 40%, transparent), 0 0 12px color-mix(in oklch, var(--color-success) 15%, transparent); }
.status-dot--error   { background: var(--color-danger); box-shadow: 0 0 6px color-mix(in oklch, var(--color-danger) 40%, transparent); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.25; }
}

.latency-badge {
  font-size: 0.65rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-success, #22c55e);
  background: color-mix(in oklch, var(--color-success) 10%, transparent);
  padding: 1px 6px;
  border-radius: 8px;
}

.api-name {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-provider {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 8px;
  color: var(--color-primary);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border-radius: 8px;
  text-transform: uppercase;
  flex-shrink: 0;
}

/* §11.3: API 类别 badge — 三色主题（LLM 紫 / Embedding 蓝 / Rerank 金） */
.api-category-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 8px;
  flex-shrink: 0;
  letter-spacing: 0.03em;
  text-shadow: 0 0 4px currentColor;
}
.api-category-badge--llm {
  color: var(--color-primary);
  background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}
.api-category-badge--embedding {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-300) 15%, transparent);
}
.api-category-badge--rerank {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 15%, transparent);
}
.api-category-badge--tts {
  color: var(--color-viz-purple);
  background: color-mix(in oklch, var(--color-viz-purple) 15%, transparent);
}
.api-category-badge--stt {
  color: var(--color-viz-blue, #5b9bd5);
  background: color-mix(in oklch, var(--color-viz-blue, #5b9bd5) 15%, transparent);
}

.api-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.api-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  margin-bottom: 10px;
}

.detail-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.detail-label {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  min-width: 28px;
  flex-shrink: 0;
}

.detail-value {
  font-size: 0.78rem;
  color: var(--color-text, #e0e0e6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-value--mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
}

.api-footer {
  display: flex;
  gap: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  padding-top: 10px;
}

/* ── Small buttons ── */
.btn-sm {
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-sm:hover:not(:disabled) {
  color: var(--color-text, #e0e0e6);
  border-color: var(--color-primary);
}
.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-sm--danger:hover:not(:disabled) {
  color: var(--color-danger, #ef4444);
  border-color: var(--color-danger, #ef4444);
  background: color-mix(in oklch, var(--color-danger) 8%, transparent);
}
.btn-sm--testing {
  color: var(--color-warning, #f59e0b) !important;
  border-color: color-mix(in oklch, var(--color-amber-400) 30%, transparent) !important;
}

/* ── AI Generation Settings (B.1.4) ── */
.ai-settings-section {
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 10px;
}

.settings-title {
  margin: 0 0 12px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary, #8888a0);
}

.settings-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-text, #e0e0e6);
}

.setting-desc {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}

.retry-input {
  width: 60px;
  padding: 4px 8px;
  font-size: 0.85rem;
  text-align: center;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  outline: none;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}
.retry-input:focus { border-color: var(--color-primary); }

/* ── Edit form ── */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group--half {
  flex: 1;
}

.form-row {
  display: flex;
  gap: 14px;
}

.form-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
}

.form-input {
  padding: 8px 12px;
  font-size: 0.85rem;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  outline: none;
  font-family: inherit;
}
.form-input:focus { border-color: var(--color-primary); }

.form-range {
  width: 100%;
  accent-color: var(--color-primary);
}

/* ── Model input (B.1.2) ── */
.model-input-row {
  display: flex;
  gap: 8px;
}

.model-input {
  flex: 1;
}

.btn-fetch-models {
  flex-shrink: 0;
  padding: 8px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-primary);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-fetch-models:hover:not(:disabled) {
  background: color-mix(in oklch, var(--color-sage-400) 20%, transparent);
}
.btn-fetch-models:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-hint {
  font-size: 0.72rem;
  color: var(--color-success, #22c55e);
  opacity: 0.8;
}

/* §11.3: form-hint — 说明文本（灰色，带 code 内嵌） */
.form-hint {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  margin-top: 4px;
  line-height: 1.5;
}
.form-hint code {
  padding: 1px 5px;
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-radius: 3px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.7rem;
  color: var(--color-primary);
}

/* §11.3: 三选一类别 segment */
.category-segment {
  display: flex;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.category-segment__btn {
  flex: 1;
  padding: 10px 14px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.category-segment__btn:last-child { border-right: none; }
.category-segment__btn:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text, #e0e0e6);
}
.category-segment__btn--active {
  background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  color: var(--color-primary);
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.category-segment__btn--active:hover {
  background: color-mix(in oklch, var(--color-sage-400) 20%, transparent);
}

/* §11.3: 高级选项折叠区 */
.form-advanced {
  margin-top: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px dashed var(--color-border, #2a2a3a);
  border-radius: 6px;
}
.form-advanced > summary {
  cursor: pointer;
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  user-select: none;
}
.form-advanced[open] > summary {
  margin-bottom: 8px;
  color: var(--color-text, #e0e0e6);
}
/* ── Preset toolbar ── */
.preset-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
}
.preset-dropdown {
  flex: 1;
  min-width: 120px;
}
.preset-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.btn-sm--preset {
  color: var(--color-sage-300, #8888a0);
}
.btn-sm--preset:hover:not(:disabled) {
  color: var(--color-sage-100, #e0e0e6);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

/* Preset name modal */
.preset-name-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preset-name-input {
  width: 100%;
}

/* ── Stale assignment row (missing API warning) ── */
.assign-row--stale :deep(.assign-select) {
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-amber-400) 20%, transparent);
  border-radius: 5px;
  animation: stale-pulse 2s ease-in-out infinite;
}
.assign-row--stale :deep(.aga-select__trigger) {
  border-color: var(--color-amber-400);
}
.assign-stale-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-amber-400);
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-amber-400) 50%, transparent);
  animation: stale-pulse 2s ease-in-out infinite;
}
@keyframes stale-pulse {
  0%, 100% { box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-amber-400) 20%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-amber-400) 30%, transparent), 0 0 8px color-mix(in oklch, var(--color-amber-400) 10%, transparent); }
}

/* ── Assignment (B.1.3) ── */
.assign-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* CR-R11: 显示全部 API 开关行 */
.assign-show-all {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--glass-bg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  user-select: none;
}
.assign-show-all-hint {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  margin-left: auto;
}

.assign-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assign-group-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary, #8888a0);
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

/* §11.3: RAG 分组说明提示 */
.assign-group-hint {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.8;
  padding: 4px 0;
  line-height: 1.5;
}
.assign-group-hint code {
  padding: 1px 5px;
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-radius: 3px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.7rem;
  color: var(--color-primary);
}

.assign-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.assign-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  gap: 12px;
}

.assign-label {
  flex: 1;
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  transition: opacity 0.15s ease;
}

.assign-select {
  min-width: 150px;
}

.assign-tip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--color-text-secondary, #8888a0);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  margin-left: 4px;
  opacity: 0.5;
  transition: opacity 0.15s ease;
  vertical-align: middle;
  cursor: help;
}
.assign-label:hover .assign-tip-icon,
.assign-tip-icon:hover {
  opacity: 1;
}

/* ── Buttons ── */
.btn-primary {
  padding: 6px 16px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone);
  background: var(--color-primary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { background: var(--color-primary-hover, #4f46e5); }
.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* CR-R3: 表单校验错误提示（显示在 modal footer 左侧） */
.form-validation-error {
  font-size: 0.75rem;
  color: var(--color-danger, #ef4444);
  align-self: center;
  opacity: 0.9;
}

.btn-secondary {
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  cursor: pointer;
}
.btn-secondary:hover { color: var(--color-text, #e0e0e6); border-color: var(--color-primary); }

/* ── Empty ── */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.88rem;
}

/* ── Scrollbar ── */
.api-panel::-webkit-scrollbar { width: 5px; }
.api-panel::-webkit-scrollbar-track { background: transparent; }
.api-panel::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

@media (max-width: 767px) {
  .api-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
}
</style>
