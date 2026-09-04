<script setup lang="ts">
// App doc: docs/user-guide/pages/home.md §1.3.2
/**
 * SettingsPanel — game settings UI.
 *
 * B.2 扩展：行动选项深度 + 心跳高级参数 + NPC设置 + 高级(Debug/文本替换/导入导出)
 * Persists to localStorage / game state tree.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, inject, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { eventBus } from '@/engine/core/event-bus';
import { AI_SETTINGS_STORAGE_KEY } from '@/engine/ai/ai-service';
import Modal from '@/ui/components/common/Modal.vue';
import EngramSettingsSection from '../settings/EngramSettingsSection.vue';
import TtsSettingsSection from '../settings/TtsSettingsSection.vue';
import SttSettingsSection from '../settings/SttSettingsSection.vue';
import { useGameState } from '@/ui/composables/useGameState';
import type { ProfileManager } from '@/engine/persistence/profile-manager';
import type { SaveManager } from '@/engine/persistence/save-manager';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import { DEFAULT_MAX_ACTIVE_THREADS } from '@/engine/plot/types';
import type { AxisMode as PlotTimelineAxis } from '@/ui/components/panels/plot/scheduler-layout';
import { writePlotTimelineAxis } from '@/ui/composables/usePlotTimelineAxis';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useLocale } from '@/ui/composables/useLocale';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const SETTINGS_KEY = 'aga_user_settings';

/** User settings shape */
interface UserSettings {
  fontSize: number;
  showActionOptions: boolean;
  themeAccent: string;
  enableAnimations: boolean;
  autoSaveInterval: number;
  language: string;
}

interface AccentPreset {
  id: string;
  hue1: number;
  hue2: number;
  labelKey: string;
}

const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'sage-amber',      hue1: 150, hue2: 75,  labelKey: 'settings.ui.themeAccent.presets.sage' },
  { id: 'ocean-coral',     hue1: 220, hue2: 15,  labelKey: 'settings.ui.themeAccent.presets.ocean' },
  { id: 'lavender-gold',   hue1: 280, hue2: 55,  labelKey: 'settings.ui.themeAccent.presets.lavender' },
  { id: 'rose-teal',       hue1: 345, hue2: 175, labelKey: 'settings.ui.themeAccent.presets.rose' },
  { id: 'mint-peach',      hue1: 165, hue2: 40,  labelKey: 'settings.ui.themeAccent.presets.mint' },
  { id: 'indigo-amber',    hue1: 255, hue2: 70,  labelKey: 'settings.ui.themeAccent.presets.indigo' },
  { id: 'emerald-ruby',    hue1: 145, hue2: 5,   labelKey: 'settings.ui.themeAccent.presets.emerald' },
  { id: 'cyan-magenta',    hue1: 200, hue2: 330, labelKey: 'settings.ui.themeAccent.presets.cyan' },
  { id: 'copper-slate',    hue1: 35,  hue2: 240, labelKey: 'settings.ui.themeAccent.presets.copper' },
  { id: 'twilight-dawn',   hue1: 290, hue2: 25,  labelKey: 'settings.ui.themeAccent.presets.twilight' },
];

const defaultSettings: UserSettings = {
  fontSize: 14,
  showActionOptions: true,
  themeAccent: 'sage-amber',
  enableAnimations: true,
  autoSaveInterval: 5,
  language: 'zh-CN',
};

const settings = ref<UserSettings>({ ...defaultSettings });

// ─── Persistence ───

function loadSettings(): void {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<UserSettings>;
      settings.value = { ...defaultSettings, ...parsed };
    }
  } catch {
    settings.value = { ...defaultSettings };
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value));
  } catch (e) {
    console.error('[Settings] 保存失败:', e);
  }
}

// ─── Auto-save on changes ───

watch(settings, () => {
  saveSettings();
  applyRootMetrics(settings.value.fontSize, uiScale.value);
}, { deep: true });

const { setLocale } = useLocale();
let initialLanguage = '';
watch(() => settings.value.language, (newLang) => {
  if (initialLanguage && newLang !== initialLanguage) {
    saveSettings();
    void setLocale(newLang);
  }
});

// ─── Actions ───

function resetAll(): void {
  settings.value = { ...defaultSettings };
  saveSettings();
  document.documentElement.style.removeProperty('--hue-1');
  document.documentElement.style.removeProperty('--hue-2');
  actionOptions.value = { ...defaultActionOptions };
  localStorage.setItem(ACTION_OPTIONS_KEY, JSON.stringify(actionOptions.value));
  debugSettings.value = { ...defaultDebug };
  localStorage.setItem(DEBUG_KEY, JSON.stringify(debugSettings.value));
  textReplaceRules.value = [];
  localStorage.setItem(TEXT_REPLACE_KEY, JSON.stringify([]));
  eventBus.emit('ui:toast', { type: 'info', message: t('settings.resetAll.toast'), duration: 1500 });
}

function applyFontSize(): void {
  const size = settings.value.fontSize;
  applyRootMetrics(size, uiScale.value);
  eventBus.emit('ui:toast', { type: 'success', message: t('settings.ui.fontSize.toast', { size }), duration: 1200 });
}

// Font size × UI scale both drive the root font-size so rem units scale
// consistently. The `--narrative-font-size` var stays in sync for narrative
// text that explicitly opts in.
function applyRootMetrics(fontPx: number, scalePct: number): void {
  const rootPx = (fontPx * scalePct) / 100;
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.documentElement.style.setProperty('--base-font-size', `${fontPx}px`);
  document.documentElement.style.setProperty('--narrative-font-size', `${fontPx}px`);
  document.documentElement.style.setProperty('--ui-scale', `${scalePct}%`);
}

function applyThemeColor(): void {
  const preset = ACCENT_PRESETS.find(p => p.id === settings.value.themeAccent);
  if (!preset) return;
  const root = document.documentElement;
  root.style.setProperty('--hue-1', String(preset.hue1));
  root.style.setProperty('--hue-2', String(preset.hue2));
  eventBus.emit('ui:toast', { type: 'success', message: t('settings.ui.themeAccent.toast'), duration: 1200 });
}

function selectPreset(presetId: string): void {
  settings.value.themeAccent = presetId;
  applyThemeColor();
}

function presetSwatches(preset: AccentPreset): { primary: string; secondary: string } {
  return {
    primary: `oklch(0.78 0.08 ${preset.hue1})`,
    secondary: `oklch(0.80 0.09 ${preset.hue2})`,
  };
}

import { SUPPORTED_LOCALES } from '@/ui/i18n';

const localeDisplayNames: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en': 'English',
  'ja': '日本語',
};
const languageOptions = SUPPORTED_LOCALES.map(loc => ({
  value: loc,
  label: localeDisplayNames[loc] ?? loc,
}));

/** Whether settings differ from defaults */
const hasChanges = computed(() =>
  JSON.stringify(settings.value) !== JSON.stringify(defaultSettings),
);

// ─── B.2.1 Action Options deep settings ───────────────────────

const ACTION_OPTIONS_KEY = 'aga_action_options_settings';

interface ActionOptionsSettings {
  mode: 'action' | 'story';
  pace: 'fast' | 'slow';
  customPrompt: string;
}

const defaultActionOptions: ActionOptionsSettings = {
  mode: 'action',
  pace: 'fast',
  customPrompt: '',
};

const actionOptions = ref<ActionOptionsSettings>({ ...defaultActionOptions });

function loadActionOptions(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTION_OPTIONS_KEY) ?? '{}') as Partial<ActionOptionsSettings>;
    actionOptions.value = { ...defaultActionOptions, ...raw };
  } catch { actionOptions.value = { ...defaultActionOptions }; }
}

watch(actionOptions, () => {
  localStorage.setItem(ACTION_OPTIONS_KEY, JSON.stringify(actionOptions.value));
}, { deep: true });

// ─── Memory system settings (2026-04-11 Feature A) ───────────
//
// 四层记忆系统的用户可调阈值。写入 localStorage `aga_memory_settings`。
// MemoryManager.readSettingsOverride() 每次决策时实时读取，无需重启游戏。
//
// 每个字段有合理范围 cap（见 MemoryManager.getEffectiveConfig 的 clamp 逻辑）。
const MEMORY_SETTINGS_KEY = 'aga_memory_settings';

// 2026-09-04（Context Compiler v1，PO 决议 Q3）：`shortTermInjectionStyle` / `fewShotPairs`
// 两个控件已移除 —— few-shot 历史对数改为引擎常量（prompt/context-compiler.ts）。
// localStorage 里的旧键无人读取，loadMemorySettings 的展开合并会原样带着它们，无害。
interface MemorySettings {
  shortTermLimit: number;           // 1-50, default 5
  midTermRefineThreshold: number;   // 5-200, default 25
  longTermSummaryThreshold: number; // 10-500, default 50
  longTermSummarizeCount: number;   // 1-200, default 50
  midTermKeep: number;              // 0-200, default 0
  longTermCap: number;              // 5-200, default 30
}

const defaultMemorySettings: MemorySettings = {
  shortTermLimit: 5,
  midTermRefineThreshold: 25,
  longTermSummaryThreshold: 50,
  longTermSummarizeCount: 50,
  midTermKeep: 0,
  longTermCap: 30,
};

const memorySettings = ref<MemorySettings>({ ...defaultMemorySettings });

function loadMemorySettings(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY_SETTINGS_KEY) ?? '{}') as Partial<MemorySettings>;
    memorySettings.value = { ...defaultMemorySettings, ...raw };
  } catch { memorySettings.value = { ...defaultMemorySettings }; }
}

watch(memorySettings, () => {
  try {
    localStorage.setItem(MEMORY_SETTINGS_KEY, JSON.stringify(memorySettings.value));
  } catch { /* localStorage 不可用时静默忽略 */ }
}, { deep: true });

// ─── B.2.2 Heartbeat advanced settings (game state) ──────────

const { isLoaded, get, setValue, useValue } = useGameState();

// ─── Action Options → state tree sync (bugfix 2026-04-11) ───
//
// 原版 actionOptions 只存 localStorage，context-assembly 读不到，导致用户在
// UI 选的"剧情导向"模式永远不生效（prompt flow 不 branch）。修复：把
// actionOptions 的 mode/pace/customPrompt 同步写到状态树 `系统.actionOptions.*`，
// context-assembly 从状态树读取后注入条件变量让 prompt flow 按 mode 分支。
function syncActionOptionsToStateTree(): void {
  setValue('系统.actionOptions.mode', actionOptions.value.mode);
  setValue('系统.actionOptions.pace', actionOptions.value.pace);
  setValue('系统.actionOptions.customPrompt', actionOptions.value.customPrompt);
}

// 载入时和任何字段变化时都同步（仅当游戏已加载，否则无状态树可写）
watch(actionOptions, () => {
  if (isLoaded.value) syncActionOptionsToStateTree();
}, { deep: true });

// 游戏加载后也做一次同步（HomeView modal 里改了 localStorage 但 isLoaded=false
// 时没能写状态树，等游戏真正 load 后 watch 触发一次把 localStorage 的值推入）
watch(() => isLoaded.value, (loaded) => {
  if (loaded) syncActionOptionsToStateTree();
});

// ─── §11.2 NSFW settings ─────────────────────────────────────
//
// 必须放在 `useGameState()` 解构之后，因为 loadNsfwSettings / saveNsfwSettings /
// syncNsfwToStateTree / watch(isLoaded) 都引用 `isLoaded` 和 `setValue`。
// 若放在前面会触发 TDZ（ReferenceError: Cannot access 'isLoaded' before initialization）。
//
// 双层存储：
// - localStorage 'aga_nsfw_settings' 保存 user-level 偏好（跨存档持久化）
// - 状态树 系统.nsfwMode / 系统.nsfwGenderFilter 是 save-level（本次游戏覆盖）
//
// UI 切换时同时写两处：
// - localStorage 立即保存，未来游戏加载后默认读此值
// - setValue() 即时写入当前状态树，使本次游戏立即生效（ContextAssemblyStage
//   的 nsfwMode 判断、CommandExecutionStage 的私密信息校验、ContentFilter 的
//   tag 剥离都读状态树）
//
// 读取顺序（与 privacy-profile-validator.readNsfwSettings 一致）：
//   状态树 → localStorage → 硬编码默认 false / 'female'

const NSFW_KEY = 'aga_nsfw_settings';
type NsfwGenderFilter = 'all' | 'male' | 'female';

interface NsfwSettings {
  nsfwMode: boolean;
  nsfwGenderFilter: NsfwGenderFilter;
}

const defaultNsfw: NsfwSettings = {
  nsfwMode: false,
  nsfwGenderFilter: 'female',
};

const nsfwSettings = ref<NsfwSettings>({ ...defaultNsfw });

const nsfwGenderOptions = computed<Array<{ value: NsfwGenderFilter; label: string }>>(() => [
  { value: 'all',    label: t('settings.nsfw.genderFilter.all') },
  { value: 'male',   label: t('settings.nsfw.genderFilter.male') },
  { value: 'female', label: t('settings.nsfw.genderFilter.female') },
]);

function loadNsfwSettings(): void {
  try {
    const raw = localStorage.getItem(NSFW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NsfwSettings>;
      nsfwSettings.value = {
        nsfwMode: typeof parsed.nsfwMode === 'boolean' ? parsed.nsfwMode : defaultNsfw.nsfwMode,
        nsfwGenderFilter:
          parsed.nsfwGenderFilter === 'all' ||
          parsed.nsfwGenderFilter === 'male' ||
          parsed.nsfwGenderFilter === 'female'
            ? parsed.nsfwGenderFilter
            : defaultNsfw.nsfwGenderFilter,
      };
    }
  } catch {
    nsfwSettings.value = { ...defaultNsfw };
  }

  // 启动时把 localStorage 值同步到状态树（若游戏已加载）
  if (isLoaded.value) {
    syncNsfwToStateTree();
  }
}

function saveNsfwSettings(): void {
  try {
    localStorage.setItem(NSFW_KEY, JSON.stringify(nsfwSettings.value));
  } catch (e) {
    console.error('[NSFW] 保存失败:', e);
  }
  // 同时写入状态树 — 立即生效
  if (isLoaded.value) {
    syncNsfwToStateTree();
  }
}

function syncNsfwToStateTree(): void {
  setValue('系统.nsfwMode', nsfwSettings.value.nsfwMode);
  setValue('系统.nsfwGenderFilter', nsfwSettings.value.nsfwGenderFilter);
  eventBus.emit('engine:request-save');
}

// 启动时和游戏加载时都要同步（游戏加载后 isLoaded 变 true，此时再 sync 一次）
watch(() => isLoaded.value, (loaded) => {
  if (loaded) {
    syncNsfwToStateTree();
    loadCotSettings();
    loadPresenceEnabled();
    loadBodyPolish();
    loadImageGen();
    featureToggles.value.cot = cotSettings.value.enabled;
    featureToggles.value.bodyPolish = bodyPolishEnabled.value;
    featureToggles.value.imageGeneration = imageGenEnabled.value;
    saveFeatureToggles();
    saveCotToLocalStorage();
    savePresenceToLocalStorage();
    saveBodyPolishToLocalStorage();
    saveImageGenToLocalStorage();
  }
});

watch(nsfwSettings, () => saveNsfwSettings(), { deep: true });

const HEARTBEAT_BASE = '世界.状态.心跳';

const heartbeatHistoryLimit = computed(() => {
  const v = get<number>(`${HEARTBEAT_BASE}.历史条数`);
  return typeof v === 'number' ? v : 20;
});
const heartbeatForgetRounds = computed(() => {
  const v = get<number>(`${HEARTBEAT_BASE}.遗忘回合数`);
  return typeof v === 'number' ? v : 30;
});

function setHeartbeatHistoryLimit(v: number): void {
  setValue(`${HEARTBEAT_BASE}.历史条数`, Math.max(5, Math.min(100, v)));
  eventBus.emit('engine:request-save');
}
function setHeartbeatForgetRounds(v: number): void {
  setValue(`${HEARTBEAT_BASE}.遗忘回合数`, Math.max(0, Math.min(999, v)));
  eventBus.emit('engine:request-save');
}

// ─── B.2.3 NPC settings (game state) ─────────────────────────

const npcDemotionThreshold = computed(() => {
  const v = get<number>('系统.npcDemotionThreshold');
  return typeof v === 'number' ? v : 5;
});
const npcRangeMin = computed(() => {
  const v = get<number>('系统.importantNpcGenerationRange.min');
  return typeof v === 'number' ? v : 0;
});
const npcRangeMax = computed(() => {
  const v = get<number>('系统.importantNpcGenerationRange.max');
  return typeof v === 'number' ? v : 1;
});

function setNpcDemotion(v: number): void {
  setValue('系统.npcDemotionThreshold', Math.max(1, Math.min(999, v)));
  eventBus.emit('engine:request-save');
}
function setNpcRangeMin(v: number): void {
  const clamped = Math.max(0, Math.min(npcRangeMax.value, v));
  setValue('系统.importantNpcGenerationRange.min', clamped);
  eventBus.emit('engine:request-save');
}
function setNpcRangeMax(v: number): void {
  const clamped = Math.max(npcRangeMin.value, Math.min(10, v));
  setValue('系统.importantNpcGenerationRange.max', clamped);
  eventBus.emit('engine:request-save');
}

// ─── B.2.4 Advanced settings ──────────────────────────────────

const DEBUG_KEY = 'aga_debug_settings';

interface DebugSettings {
  debugMode: boolean;
  consoleDebug: boolean;
  aiLogging: boolean;
}

const defaultDebug: DebugSettings = {
  debugMode: false,
  consoleDebug: false,
  aiLogging: false,
};

const debugSettings = ref<DebugSettings>({ ...defaultDebug });

function loadDebugSettings(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(DEBUG_KEY) ?? '{}') as Partial<DebugSettings>;
    debugSettings.value = { ...defaultDebug, ...raw };
  } catch { debugSettings.value = { ...defaultDebug }; }
}

watch(debugSettings, () => {
  localStorage.setItem(DEBUG_KEY, JSON.stringify(debugSettings.value));
  eventBus.emit('settings:debug-mode-changed', debugSettings.value.debugMode);
}, { deep: true });

// ─── Plot Direction Settings (Sprint Plot-1 P6) ─────────────

const PLOT_SETTINGS_KEY = 'aga_plot_settings';

interface PlotSettings {
  enabled: boolean;
  criticalConfirmGate: boolean;
  confidenceThreshold: number;
  showGaugesInMainPanel: boolean;
  opportunityMaxTier: 1 | 2 | 3;
  autoAdvanceSkippable: boolean;
  showEvalLog: boolean;
  /** Plot Threads D2: how many threads may be active at once (1-5). */
  maxActiveThreads: number;
  /**
   * Plot Threads D4: scheduler view axis. Persisted in this blob for reload, but
   * the LIVE value is the state tree (`系统.设置.plot.timelineAxis`) — both this
   * panel and the scheduler's own toggle write it through `writePlotTimelineAxis`,
   * so the two controls never hold two copies (review fix, 2026-08-22).
   */
  timelineAxis: PlotTimelineAxis;
}

const defaultPlotSettings: PlotSettings = {
  enabled: true,
  criticalConfirmGate: true,
  confidenceThreshold: 0.7,
  showGaugesInMainPanel: true,
  opportunityMaxTier: 3,
  autoAdvanceSkippable: true,
  showEvalLog: false,
  maxActiveThreads: DEFAULT_MAX_ACTIVE_THREADS,
  timelineAxis: 'round',
};

const plotSettings = ref<PlotSettings>({ ...defaultPlotSettings });

const timelineAxisOptions = computed<Array<{ value: PlotTimelineAxis; label: string }>>(() => [
  { value: 'round', label: t('settings.plot.timelineAxis.round') },
  { value: 'date',  label: t('settings.plot.timelineAxis.date') },
]);
/** Live axis value — the state tree is the single source of truth (scheduler toggle writes the same key). */
const timelineAxisLive = useValue<PlotTimelineAxis | undefined>('系统.设置.plot.timelineAxis');
const timelineAxisValue = computed<PlotTimelineAxis>(() => timelineAxisLive.value === 'date' ? 'date' : plotSettings.value.timelineAxis);
function setTimelineAxisSetting(mode: PlotTimelineAxis): void {
  plotSettings.value.timelineAxis = mode;            // keeps the persisted blob + this panel in step
  writePlotTimelineAxis(setValue, mode);             // state tree + localStorage blob (shared writer)
}

function loadPlotSettings(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(PLOT_SETTINGS_KEY) ?? '{}') as Partial<PlotSettings>;
    // Plot Threads: validate on load (same discipline as loadLowLoadSettings) — a
    // NaN cap would silently disable the concurrency limit in plot-store.activateArc.
    const cap = typeof raw.maxActiveThreads === 'number' && Number.isFinite(raw.maxActiveThreads)
      ? Math.max(1, Math.min(5, Math.round(raw.maxActiveThreads)))
      : defaultPlotSettings.maxActiveThreads;
    const axis: PlotTimelineAxis = raw.timelineAxis === 'date' ? 'date' : 'round';
    plotSettings.value = { ...defaultPlotSettings, ...raw, maxActiveThreads: cap, timelineAxis: axis };
  } catch { plotSettings.value = { ...defaultPlotSettings }; }
}

function syncPlotSettingsToStateTree(): void {
  setValue('系统.设置.plot.enabled', plotSettings.value.enabled);
  setValue('系统.设置.plot.criticalConfirmGate', plotSettings.value.criticalConfirmGate);
  setValue('系统.设置.plot.confidenceThreshold', plotSettings.value.confidenceThreshold);
  setValue('系统.设置.plot.showGaugesInMainPanel', plotSettings.value.showGaugesInMainPanel);
  setValue('系统.设置.plot.opportunityMaxTier', plotSettings.value.opportunityMaxTier);
  setValue('系统.设置.plot.autoAdvanceSkippable', plotSettings.value.autoAdvanceSkippable);
  setValue('系统.设置.plot.showEvalLog', plotSettings.value.showEvalLog);
  setValue('系统.设置.plot.maxActiveThreads', plotSettings.value.maxActiveThreads);
  setValue('系统.设置.plot.timelineAxis', plotSettings.value.timelineAxis);
}

watch(plotSettings, () => {
  // Merge over the on-disk blob: the scheduler's axis toggle may have written a
  // fresher `timelineAxis` while this panel sat inactive under <KeepAlive>.
  try {
    const onDisk = JSON.parse(localStorage.getItem(PLOT_SETTINGS_KEY) ?? '{}') as Partial<PlotSettings>;
    if (onDisk.timelineAxis === 'date' || onDisk.timelineAxis === 'round') plotSettings.value.timelineAxis = onDisk.timelineAxis;
  } catch { /* ignore a corrupt blob; defaults apply */ }
  localStorage.setItem(PLOT_SETTINGS_KEY, JSON.stringify(plotSettings.value));
  if (isLoaded.value) syncPlotSettingsToStateTree();
}, { deep: true });

watch(() => isLoaded.value, (loaded) => {
  if (loaded) syncPlotSettingsToStateTree();
});

// ─── B.2.4.2 Text replace rules ──────────────────────────────

const TEXT_REPLACE_KEY = 'aga_text_replace_rules';

interface TextReplaceRule {
  id: string;
  enabled: boolean;
  mode: 'regex' | 'text';
  pattern: string;
  replacement: string;
  ignoreCase: boolean;
  global: boolean;
}

const textReplaceRules = ref<TextReplaceRule[]>([]);
const showReplaceModal = ref(false);

function loadTextRules(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(TEXT_REPLACE_KEY) ?? '[]');
    textReplaceRules.value = Array.isArray(raw) ? raw : [];
  } catch { textReplaceRules.value = []; }
}

function saveTextRules(): void {
  localStorage.setItem(TEXT_REPLACE_KEY, JSON.stringify(textReplaceRules.value));
}

const editingRule = ref<TextReplaceRule | null>(null);
const ruleForm = ref<Omit<TextReplaceRule, 'id'>>({
  enabled: true, mode: 'text', pattern: '', replacement: '', ignoreCase: false, global: true,
});
const ruleFormError = ref('');
const showRuleEditor = ref(false);

function openNewRule(): void {
  editingRule.value = null;
  ruleForm.value = { enabled: true, mode: 'text', pattern: '', replacement: '', ignoreCase: false, global: true };
  ruleFormError.value = '';
  showRuleEditor.value = true;
}

function openEditRule(rule: TextReplaceRule): void {
  editingRule.value = rule;
  ruleForm.value = { ...rule };
  ruleFormError.value = '';
  showRuleEditor.value = true;
}

function submitRuleForm(): void {
  if (!ruleForm.value.pattern.trim()) {
    ruleFormError.value = t('settings.textReplace.patternRequired');
    return;
  }
  if (ruleForm.value.mode === 'regex') {
    try { new RegExp(ruleForm.value.pattern); }
    catch { ruleFormError.value = t('settings.textReplace.regexInvalid'); return; }
  }
  if (editingRule.value) {
    const idx = textReplaceRules.value.findIndex((r) => r.id === editingRule.value!.id);
    if (idx >= 0) textReplaceRules.value[idx] = { id: editingRule.value.id, ...ruleForm.value };
  } else {
    textReplaceRules.value.push({ id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...ruleForm.value });
  }
  saveTextRules();
  showRuleEditor.value = false;
}

function deleteRule(id: string): void {
  textReplaceRules.value = textReplaceRules.value.filter((r) => r.id !== id);
  saveTextRules();
}

function toggleRule(id: string): void {
  const rule = textReplaceRules.value.find((r) => r.id === id);
  if (rule) { rule.enabled = !rule.enabled; saveTextRules(); }
}

// ─── B.2.4.3 Import / Export settings ────────────────────────

function exportSettings(): void {
  const data = {
    settings: settings.value,
    actionOptions: actionOptions.value,
    debugSettings: debugSettings.value,
    textReplaceRules: textReplaceRules.value,
    exportedAt: new Date().toISOString(),
    version: 1,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aga-settings-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  eventBus.emit('ui:toast', { type: 'success', message: t('settings.advanced.importExport.exportToast'), duration: 1500 });
}

function openImportSettings(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as Record<string, unknown>;
      if (raw.settings) settings.value = { ...defaultSettings, ...(raw.settings as Partial<typeof settings.value>) };
      if (raw.actionOptions) actionOptions.value = { ...defaultActionOptions, ...(raw.actionOptions as Partial<ActionOptionsSettings>) };
      if (raw.debugSettings) debugSettings.value = { ...defaultDebug, ...(raw.debugSettings as Partial<DebugSettings>) };
      if (Array.isArray(raw.textReplaceRules)) {
        textReplaceRules.value = (raw.textReplaceRules as unknown[]).filter(
          (item): item is TextReplaceRule =>
            typeof (item as TextReplaceRule).id === 'string' &&
            typeof (item as TextReplaceRule).pattern === 'string' &&
            typeof (item as TextReplaceRule).replacement === 'string',
        );
        saveTextRules();
      }
      eventBus.emit('ui:toast', { type: 'success', message: t('settings.advanced.importExport.importToast'), duration: 1500 });
    } catch {
      eventBus.emit('ui:toast', { type: 'error', message: t('settings.advanced.importExport.importError'), duration: 2000 });
    }
  };
  input.click();
}

// ─── B.2.4.4 Clear cache ─────────────────────────────────────

const showClearCacheConfirm = ref(false);

/** Keys that must never be cleared by "clear cache" — they hold user config, not transient caches */
const CACHE_PROTECTED_KEYS = new Set([
  'aga_api_management',
  'aga_ai_settings',
  'aga_engram_config',
  'aga_user_settings',
  'aga_action_options_settings',
  'aga_debug_settings',
  'aga_text_replace_rules',
  'aga_autosave_settings',
  'aga_feature_toggles',
  'aga_memory_settings',
  'aga_nsfw_settings',
  'aga_plot_settings',
  'aga_heartbeat_settings',
  'aga_assistant_settings',
  'aga_ui_scale',
  'aga_text_speed',
]);

function clearCache(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('aga_') || k.startsWith('aga-')) && !CACHE_PROTECTED_KEYS.has(k)) {
      keysToRemove.push(k);
    }
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
  showClearCacheConfirm.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('settings.advanced.clearCache.toast', { count: keysToRemove.length }), duration: 2000 });
}

// ─── 6.1 UI 缩放 ─────────────────────────────────────────────

const UI_SCALE_KEY = 'aga_ui_scale';
const uiScale = ref(Number(localStorage.getItem(UI_SCALE_KEY) ?? 100));

function applyUiScale(val: number): void {
  applyRootMetrics(settings.value.fontSize, val);
}

watch(uiScale, (val) => {
  applyUiScale(val);
  localStorage.setItem(UI_SCALE_KEY, String(val));
});

// ─── 6.1 文本速度 ─────────────────────────────────────────────

const TEXT_SPEED_KEY = 'aga_text_speed';
type TextSpeed = '0.5x' | '1x' | '2x' | 'max';
const textSpeed = ref<TextSpeed>((localStorage.getItem(TEXT_SPEED_KEY) as TextSpeed) ?? '1x');
const textSpeedOptions: TextSpeed[] = ['0.5x', '1x', '2x', 'max'];

watch(textSpeed, (val) => {
  localStorage.setItem(TEXT_SPEED_KEY, val);
});

// ─── 6.1 数据管理 ─────────────────────────────────────────────

const profileManager = inject<ProfileManager>('profileManager');
const saveManager = inject<SaveManager>('saveManager');
const router = useRouter();

const isExportingAllSaves = ref(false);
const showClearAllConfirm = ref(false);
const clearAllStep = ref<1 | 2>(1);

async function exportAllSaves(): Promise<void> {
  if (!profileManager || !saveManager) return;
  isExportingAllSaves.value = true;
  try {
    const profiles = profileManager.listProfiles();
    const data = await Promise.all(
      profiles.map(async (p) => {
        const slots: Record<string, unknown> = {};
        for (const slotId of Object.keys(p.slots)) {
          const state = await saveManager.loadGame(p.profileId, slotId);
          slots[slotId] = { meta: p.slots[slotId], state };
        }
        return { profile: p, slots };
      }),
    );
    const bundle = { profiles: data, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `autogame-all-saves-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    eventBus.emit('ui:toast', { type: 'success', message: t('settings.data.exportAllSaves.toast'), duration: 2000 });
  } catch (err) {
    console.error('[Settings] exportAllSaves failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('settings.data.exportAllSaves.error'), duration: 2500 });
  } finally {
    isExportingAllSaves.value = false;
  }
}

function openImportSaves(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as { profiles?: unknown[] };
      if (!Array.isArray(raw.profiles)) throw new Error(t('settings.data.importInvalidFormat'));
      eventBus.emit('ui:toast', { type: 'info', message: t('settings.data.importProfilesFound', { count: raw.profiles.length }), duration: 3000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.data.importParseFailed');
      eventBus.emit('ui:toast', { type: 'error', message: msg, duration: 3000 });
    }
  };
  input.click();
}

async function clearAllData(): Promise<void> {
  try {
    if (profileManager) {
      await profileManager.clearAll();
    }
    // Delete independent IDB databases that profileManager.clearAll doesn't cover
    for (const dbName of ['aga-config', 'aga-prompts', 'aga_image_cache']) {
      try { indexedDB.deleteDatabase(dbName); } catch { /* best effort */ }
    }
    localStorage.clear();
    eventBus.emit('ui:toast', { type: 'success', message: t('settings.data.clearAll.toast'), duration: 2000 });
    showClearAllConfirm.value = false;
    void router.push('/');
  } catch (err) {
    console.error('[Settings] clearAllData failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('settings.data.clearAll.error'), duration: 2500 });
  }
}

// ─── Mount ────────────────────────────────────────────────────

onMounted(() => {
  loadSettings();
  initialLanguage = settings.value.language;
  loadActionOptions();
  loadDebugSettings();
  loadPlotSettings();
  loadTextRules();
  loadNsfwSettings();
  loadMemorySettings();
  loadFeatureToggles();
  loadCotSettings();
  loadPresenceEnabled();
  loadBodyPolish();
  loadLowLoadSettings();
  loadImageGen();
  // Sync state-tree toggles → localStorage only when game is already loaded;
  // otherwise defer to the isLoaded watcher to avoid overwriting user settings with defaults.
  if (isLoaded.value) {
    featureToggles.value.cot = cotSettings.value.enabled;
    featureToggles.value.bodyPolish = bodyPolishEnabled.value;
    featureToggles.value.imageGeneration = imageGenEnabled.value;
    saveFeatureToggles();
    saveCotToLocalStorage();
    savePresenceToLocalStorage();
    saveBodyPolishToLocalStorage();
    saveImageGenToLocalStorage();
  }
  // fontSize × uiScale are coupled — apply together so rem units scale correctly
  applyRootMetrics(settings.value.fontSize, uiScale.value);
  // Migrate legacy hex/old ID values to new dual-hue preset IDs
  if (settings.value.themeAccent.startsWith('#') || settings.value.themeAccent === 'sage') {
    settings.value.themeAccent = 'sage-amber';
  }
  if (settings.value.themeAccent !== 'sage-amber') {
    applyThemeColor();
  }
});

// ─── Feature toggles ─────────────────────────────────────────
//
// Consolidated toggles for all optional AI features.
// Each is stored in the game state tree and synced to localStorage
// where appropriate so the engine can read them at runtime.

const FEATURE_TOGGLES_KEY = 'aga_feature_toggles';

interface FeatureToggles {
  text_optimization: boolean;
  world_heartbeat: boolean;
  location_npc_generation: boolean;
  npc_chat: boolean;
  field_repair: boolean;
  plot_decompose: boolean;
  assistant: boolean;
  cot: boolean;
  bodyPolish: boolean;
  imageGeneration: boolean;
  privacy_repair: boolean;
}

const defaultFeatureToggles: FeatureToggles = {
  text_optimization: false,
  world_heartbeat: true,
  location_npc_generation: true,
  npc_chat: true,
  field_repair: true,
  plot_decompose: true,
  assistant: true,
  cot: false,
  bodyPolish: false,
  imageGeneration: false,
  privacy_repair: true,
};

const featureToggles = ref<FeatureToggles>({ ...defaultFeatureToggles });

function loadFeatureToggles(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(FEATURE_TOGGLES_KEY) ?? '{}') as Partial<FeatureToggles>;
    featureToggles.value = { ...defaultFeatureToggles, ...raw };
  } catch {
    featureToggles.value = { ...defaultFeatureToggles };
  }
}

function saveFeatureToggles(): void {
  try {
    // Read-merge: `aga_feature_toggles` is co-owned with APIPanel, which writes
    // panel-exclusive usageType keys (imageGen_*, world_builder, engram_batch_solidify,
    // card_edge_classify, image*Tokenizer …). This panel's ref is loaded once on mount
    // and (under <KeepAlive>) never refreshed, so a plain overwrite with this panel's
    // stale, narrow shape would erase any key APIPanel added afterward. Merge over the
    // current on-disk value to preserve foreign keys.
    const existing = JSON.parse(localStorage.getItem(FEATURE_TOGGLES_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(FEATURE_TOGGLES_KEY, JSON.stringify({ ...existing, ...featureToggles.value }));
  } catch { /* ignore */ }
}

function toggleFeature(key: keyof FeatureToggles): void {
  featureToggles.value[key] = !featureToggles.value[key];
  saveFeatureToggles();
}

watch(featureToggles, () => saveFeatureToggles(), { deep: true });

const COT_LS_KEY = 'aga_cot_settings';
const BODY_POLISH_LS_KEY = 'aga_body_polish_settings';
const PRESENCE_LS_KEY = 'aga_presence_settings';
const IMAGE_GEN_LS_KEY = 'aga_image_gen_settings';

const cotSettings = ref({
  enabled: false,
  judgeEnabled: false,
  injectStep2: true,
  ringSize: 3,
});

function loadCotSettings(): void {
  cotSettings.value = {
    enabled: get('系统.设置.cot.enabled') === true,
    judgeEnabled: get('系统.设置.cot.judgeEnabled') === true,
    injectStep2: get('系统.设置.cot.injectStep2') !== false,
    ringSize: typeof get('系统.设置.cot.reasoningRingSize') === 'number'
      ? (get('系统.设置.cot.reasoningRingSize') as number)
      : 3,
  };
}

function saveCotToLocalStorage(): void {
  try {
    localStorage.setItem(COT_LS_KEY, JSON.stringify(cotSettings.value));
  } catch { /* ignore */ }
}

function toggleCotSetting(key: 'enabled' | 'judgeEnabled' | 'injectStep2'): void {
  cotSettings.value[key] = !cotSettings.value[key];
  setValue(`系统.设置.cot.${key}`, cotSettings.value[key]);
  if (key === 'enabled') {
    featureToggles.value.cot = cotSettings.value.enabled;
    saveFeatureToggles();
  }
  saveCotToLocalStorage();
  eventBus.emit('engine:request-save');
}

function updateCotRingSize(val: string): void {
  const n = Math.min(10, Math.max(1, parseInt(val) || 3));
  cotSettings.value.ringSize = n;
  setValue('系统.设置.cot.reasoningRingSize', n);
  saveCotToLocalStorage();
  eventBus.emit('engine:request-save');
}

const presenceEnabled = ref(false);
function loadPresenceEnabled(): void {
  presenceEnabled.value = get('系统.设置.social.presenceEnabled') === true;
}
function savePresenceToLocalStorage(): void {
  try {
    localStorage.setItem(PRESENCE_LS_KEY, JSON.stringify({ presenceEnabled: presenceEnabled.value }));
  } catch { /* ignore */ }
}
function togglePresenceEnabled(): void {
  presenceEnabled.value = !presenceEnabled.value;
  setValue('系统.设置.social.presenceEnabled', presenceEnabled.value);
  savePresenceToLocalStorage();
  eventBus.emit('engine:request-save');
}

const bodyPolishEnabled = ref(false);
function loadBodyPolish(): void {
  bodyPolishEnabled.value = get('系统.设置.bodyPolish') === true;
}
function saveBodyPolishToLocalStorage(): void {
  try {
    localStorage.setItem(BODY_POLISH_LS_KEY, JSON.stringify({ enabled: bodyPolishEnabled.value }));
  } catch { /* ignore */ }
}
function toggleBodyPolish(): void {
  bodyPolishEnabled.value = !bodyPolishEnabled.value;
  setValue('系统.设置.bodyPolish', bodyPolishEnabled.value);
  featureToggles.value.bodyPolish = bodyPolishEnabled.value;
  saveFeatureToggles();
  saveBodyPolishToLocalStorage();
  eventBus.emit('engine:request-save');
}

const lowLoadEnabled = ref(false);
const lowLoadMaxRequests = ref(3);
// Single source of truth for the key shared with APIPanel (see ai-service.ts).
const AI_SETTINGS_KEY_SETTINGS = AI_SETTINGS_STORAGE_KEY;

function loadLowLoadSettings(): void {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY_SETTINGS);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    lowLoadEnabled.value = parsed.lowLoadMode === true;
    if (typeof parsed.lowLoadMaxRequests === 'number') {
      lowLoadMaxRequests.value = Math.max(1, Math.min(10, parsed.lowLoadMaxRequests));
    }
  } catch { /* ignore */ }
}

function saveLowLoadSettings(): void {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY_SETTINGS);
    const existing = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    existing.lowLoadMode = lowLoadEnabled.value;
    existing.lowLoadMaxRequests = lowLoadMaxRequests.value;
    localStorage.setItem(AI_SETTINGS_KEY_SETTINGS, JSON.stringify(existing));
    eventBus.emit('ai:rate-limiter-config', {
      enabled: lowLoadEnabled.value,
      maxRequests: lowLoadMaxRequests.value,
    });
  } catch { /* ignore */ }
}

function toggleLowLoad(): void {
  lowLoadEnabled.value = !lowLoadEnabled.value;
  saveLowLoadSettings();
}

function updateLowLoadMaxRequests(val: string): void {
  const n = parseInt(val, 10);
  if (isFinite(n) && n >= 1 && n <= 10) {
    lowLoadMaxRequests.value = n;
    saveLowLoadSettings();
  }
}

const imageGenEnabled = ref(false);
function loadImageGen(): void {
  imageGenEnabled.value = get('系统.扩展.image.enabled') === true;
}
function saveImageGenToLocalStorage(): void {
  try {
    localStorage.setItem(IMAGE_GEN_LS_KEY, JSON.stringify({ enabled: imageGenEnabled.value }));
  } catch { /* ignore */ }
}
function toggleImageGen(): void {
  imageGenEnabled.value = !imageGenEnabled.value;
  setValue('系统.扩展.image.enabled', imageGenEnabled.value);
  featureToggles.value.imageGeneration = imageGenEnabled.value;
  saveFeatureToggles();
  saveImageGenToLocalStorage();
  eventBus.emit('engine:request-save');
}

// ─── Sprint UI-3: VSCode-style navigation infrastructure ──────

const settingsSearch = ref('');
const settingsContentRef = ref<HTMLElement | null>(null);
const activeNavId = ref('settings-nsfw');

interface NavCategory {
  id: string;
  label: string;
}

const navCategories = computed<NavCategory[]>(() => [
  { id: 'settings-nsfw', label: t('settings.nav.nsfw') },
  { id: 'settings-ai-features', label: t('settings.nav.aiFeatures') },
  { id: 'settings-audio', label: t('settings.nav.audio') },
  { id: 'settings-voice-input', label: t('settings.nav.voiceInput') },
  { id: 'settings-ui', label: t('settings.nav.ui') },
  { id: 'settings-game', label: t('settings.nav.game') },
  { id: 'settings-action', label: t('settings.nav.action') },
  { id: 'settings-heartbeat', label: t('settings.nav.heartbeat') },
  { id: 'settings-npc', label: t('settings.nav.npc') },
  { id: 'settings-plot', label: t('settings.nav.plot') },
  { id: 'settings-memory', label: t('settings.nav.memory') },
  { id: 'settings-advanced', label: t('settings.nav.advanced') },
  { id: 'settings-scale', label: t('settings.nav.scale') },
  { id: 'settings-data', label: t('settings.nav.data') },
]);

function sectionMatchesSearch(sectionId: string): boolean {
  const q = settingsSearch.value.trim().toLowerCase();
  if (!q) return true;
  const cat = navCategories.value.find((c) => c.id === sectionId);
  if (cat && cat.label.toLowerCase().includes(q)) return true;
  const container = settingsContentRef.value;
  if (!container) return true;
  const el = container.querySelector(`#${sectionId}`);
  if (!el) return true;
  return el.textContent?.toLowerCase().includes(q) ?? true;
}

const visibleCategoryIds = computed(() => {
  const q = settingsSearch.value.trim().toLowerCase();
  if (!q) return new Set(navCategories.value.map((c) => c.id));
  return new Set(navCategories.value.filter((c) => sectionMatchesSearch(c.id)).map((c) => c.id));
});

let scrollSuppressed = false;

function scrollToSection(sectionId: string): void {
  activeNavId.value = sectionId;
  const container = settingsContentRef.value;
  if (!container) return;
  const el = container.querySelector(`#${sectionId}`) as HTMLElement | null;
  if (!el) return;
  scrollSuppressed = true;
  container.scrollTo({
    top: el.offsetTop - container.offsetTop,
    behavior: 'smooth',
  });
  setTimeout(() => { scrollSuppressed = false; }, 600);
}

let scrollSpyObserver: IntersectionObserver | null = null;

function setupScrollSpy(): void {
  const container = settingsContentRef.value;
  if (!container) return;
  scrollSpyObserver?.disconnect();

  const visibleSections = new Set<string>();

  scrollSpyObserver = new IntersectionObserver(
    (entries) => {
      if (scrollSuppressed) return;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibleSections.add(entry.target.id);
        } else {
          visibleSections.delete(entry.target.id);
        }
      }
      for (const cat of navCategories.value) {
        if (visibleSections.has(cat.id)) {
          activeNavId.value = cat.id;
          break;
        }
      }
    },
    { root: container, rootMargin: '0px 0px -70% 0px', threshold: 0 },
  );

  for (const cat of navCategories.value) {
    const el = container.querySelector(`#${cat.id}`);
    if (el) scrollSpyObserver.observe(el);
  }
}

onMounted(() => {
  nextTick(() => setupScrollSpy());
});

onBeforeUnmount(() => {
  scrollSpyObserver?.disconnect();
});
</script>

<template>
  <div class="settings-panel settings-panel--vscode">
    <header class="panel-header">
      <h2 class="panel-title">{{ $t('settings.title') }}</h2>
      <input
        v-model="settingsSearch"
        type="text"
        class="settings-search"
        :placeholder="$t('settings.search.placeholder')"
      />
      <AgaButton v-if="hasChanges" variant="secondary" size="sm" @click="resetAll">{{ $t('settings.resetAll') }}</AgaButton>
    </header>

    <div class="settings-layout">
      <!-- VSCode-style left navigation -->
      <nav class="settings-nav">
        <button
          v-for="cat in navCategories"
          v-show="visibleCategoryIds.has(cat.id)"
          :key="cat.id"
          :class="['settings-nav__item', { 'settings-nav__item--active': activeNavId === cat.id }]"
          @click="scrollToSection(cat.id)"
        >
          {{ cat.label }}
        </button>
      </nav>

      <!-- Scrollable content area -->
      <div ref="settingsContentRef" class="settings-content">

    <!-- ─── NSFW 内容开关 ─── -->
    <section id="settings-nsfw" v-show="visibleCategoryIds.has('settings-nsfw')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.nsfw.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.nsfw.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.nsfw.desc') }}
          </span>
        </div>
        <AgaToggle
          :model-value="nsfwSettings.nsfwMode"
          :label="$t('settings.nsfw.ariaLabel')"
          @update:model-value="nsfwSettings.nsfwMode = $event"
        />
      </div>

      <div class="setting-row" :class="{ 'setting-row--disabled': !nsfwSettings.nsfwMode }">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.nsfw.genderFilter.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.nsfw.genderFilter.desc') }}
          </span>
        </div>
        <AgaSelect
          :model-value="nsfwSettings.nsfwGenderFilter"
          :options="nsfwGenderOptions"
          :disabled="!nsfwSettings.nsfwMode"
          @update:model-value="nsfwSettings.nsfwGenderFilter = $event as typeof nsfwSettings.nsfwGenderFilter"
        />
      </div>
    </section>

    <!-- ─── AI 功能开关 ─── -->
    <section id="settings-ai-features" v-show="visibleCategoryIds.has('settings-ai-features')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.aiFeatures.sectionTitle') }}</h3>
      <p class="setting-desc" style="margin-bottom: 12px; opacity: 0.7">
        {{ $t('settings.aiFeatures.desc') }}
      </p>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.narrative') }}</div>

      <div v-if="isLoaded" class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.cot.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.cot.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="cotSettings.enabled" @update:model-value="toggleCotSetting('enabled')" />
      </div>

      <template v-if="cotSettings.enabled && isLoaded">
        <div class="setting-row setting-row--indent">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.aiFeatures.cot.judge.label') }}</span>
            <span class="setting-desc">{{ $t('settings.aiFeatures.cot.judge.desc') }}</span>
          </div>
          <AgaToggle :model-value="cotSettings.judgeEnabled" @update:model-value="toggleCotSetting('judgeEnabled')" />
        </div>
        <div class="setting-row setting-row--indent">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.aiFeatures.cot.injectStep2.label') }}</span>
            <span class="setting-desc">{{ $t('settings.aiFeatures.cot.injectStep2.desc') }}</span>
          </div>
          <AgaToggle :model-value="cotSettings.injectStep2" @update:model-value="toggleCotSetting('injectStep2')" />
        </div>
        <div class="setting-row setting-row--indent">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.aiFeatures.cot.ringSize.label') }}</span>
            <span class="setting-desc">{{ $t('settings.aiFeatures.cot.ringSize.desc') }}</span>
          </div>
          <input
            type="number"
            class="form-input form-input--sm"
            :value="cotSettings.ringSize"
            min="1"
            max="10"
            style="width: 70px"
            @change="updateCotRingSize(($event.target as HTMLInputElement).value)"
          />
        </div>
      </template>

      <div v-if="isLoaded" class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.bodyPolish.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.bodyPolish.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="bodyPolishEnabled" @update:model-value="toggleBodyPolish" />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.textOptimization.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.textOptimization.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.text_optimization" @update:model-value="toggleFeature('text_optimization')" />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.lowLoad.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.lowLoad.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="lowLoadEnabled" @update:model-value="toggleLowLoad" />
      </div>

      <template v-if="lowLoadEnabled">
        <div class="setting-row setting-row--indent">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.aiFeatures.lowLoad.maxRequests.label') }}</span>
            <span class="setting-desc">{{ $t('settings.aiFeatures.lowLoad.maxRequests.desc') }}</span>
          </div>
          <input
            type="number"
            class="form-input form-input--sm"
            :value="lowLoadMaxRequests"
            min="1"
            max="10"
            step="1"
            style="width: 70px"
            @change="updateLowLoadMaxRequests(($event.target as HTMLInputElement).value)"
          />
        </div>
      </template>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.worldMemory') }}</div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.worldHeartbeat.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.worldHeartbeat.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.world_heartbeat" @update:model-value="toggleFeature('world_heartbeat')" />
      </div>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.npcSocial') }}</div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.npcChat.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.npcChat.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.npc_chat" @update:model-value="toggleFeature('npc_chat')" />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.locationNpcGen.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.locationNpcGen.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.location_npc_generation" @update:model-value="toggleFeature('location_npc_generation')" />
      </div>

      <div v-if="isLoaded" class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.presence.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.presence.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="presenceEnabled" @update:model-value="togglePresenceEnabled" />
      </div>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.plotDirective') }}</div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.plotDecompose.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.plotDecompose.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.plot_decompose" @update:model-value="toggleFeature('plot_decompose')" />
      </div>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.repair') }}</div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.fieldRepair.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.fieldRepair.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.field_repair" @update:model-value="toggleFeature('field_repair')" />
      </div>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.image') }}</div>

      <div v-if="isLoaded" class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.imageGen.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.imageGen.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="imageGenEnabled" @update:model-value="toggleImageGen" />
      </div>

      <template v-if="imageGenEnabled">
        <p class="setting-desc setting-row--indent" style="padding: var(--space-sm) 0">
          {{ $t('settings.aiFeatures.imageGen.migratedHint') }}
          <router-link to="/game?panel=image&tab=settings" class="settings-link">{{ $t('settings.aiFeatures.imageGen.migratedLink') }}</router-link>
        </p>
      </template>

      <div class="setting-subsection-header">{{ $t('settings.aiFeatures.subsection.utility') }}</div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.aiFeatures.assistant.label') }}</span>
          <span class="setting-desc">
            {{ $t('settings.aiFeatures.assistant.desc') }}
          </span>
        </div>
        <AgaToggle :model-value="featureToggles.assistant" @update:model-value="toggleFeature('assistant')" />
      </div>
    </section>

    <!-- ─── 配音 / TTS ─── -->
    <TtsSettingsSection v-show="visibleCategoryIds.has('settings-audio')" />

    <!-- ─── 语音输入 / STT ─── -->
    <SttSettingsSection v-show="visibleCategoryIds.has('settings-voice-input')" />

    <!-- ─── UI preferences ─── -->
    <section id="settings-ui" v-show="visibleCategoryIds.has('settings-ui')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.ui.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.ui.fontSize.label') }}</span>
          <span class="setting-desc">{{ $t('settings.ui.fontSize.desc') }}</span>
        </div>
        <div class="font-size-control">
          <Tooltip :text="$t('settings.ui.fontSize.decrease')" interactive>
            <button class="adj-btn" :aria-label="$t('settings.ui.fontSize.decrease')" @click="settings.fontSize = Math.max(10, settings.fontSize - 1)">−</button>
          </Tooltip>
          <span class="font-size-value">{{ settings.fontSize }}px</span>
          <Tooltip :text="$t('settings.ui.fontSize.increase')" interactive>
            <button class="adj-btn" :aria-label="$t('settings.ui.fontSize.increase')" @click="settings.fontSize = Math.min(24, settings.fontSize + 1)">+</button>
          </Tooltip>
          <AgaButton variant="primary" size="sm" @click="applyFontSize">{{ $t('settings.ui.fontSize.apply') }}</AgaButton>
          <AgaButton variant="ghost" size="sm" @click="settings.fontSize = 14; applyFontSize()">{{ $t('settings.ui.fontSize.reset') }}</AgaButton>
        </div>
      </div>

      <div class="setting-row setting-row--col">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.ui.themeAccent.label') }}</span>
          <span class="setting-desc">{{ $t('settings.ui.themeAccent.desc') }}</span>
        </div>
        <div class="accent-presets">
          <button
            v-for="preset in ACCENT_PRESETS"
            :key="preset.id"
            class="accent-swatch"
            :class="{ 'accent-swatch--active': settings.themeAccent === preset.id }"
            :aria-label="$t(preset.labelKey)"
            :aria-pressed="settings.themeAccent === preset.id"
            :style="{
              '--swatch-primary': presetSwatches(preset).primary,
              '--swatch-secondary': presetSwatches(preset).secondary,
            }"
            @click="selectPreset(preset.id)"
          >
            <span class="accent-swatch__dots">
              <span class="accent-swatch__dot accent-swatch__dot--1" />
              <span class="accent-swatch__dot accent-swatch__dot--2" />
            </span>
            <span class="accent-swatch__label">{{ $t(preset.labelKey) }}</span>
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.ui.showActions.label') }}</span>
          <span class="setting-desc">{{ $t('settings.ui.showActions.desc') }}</span>
        </div>
        <AgaToggle
          :model-value="settings.showActionOptions"
          @update:model-value="settings.showActionOptions = $event"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.ui.enableAnimations.label') }}</span>
          <span class="setting-desc">{{ $t('settings.ui.enableAnimations.desc') }}</span>
        </div>
        <AgaToggle
          :model-value="settings.enableAnimations"
          @update:model-value="settings.enableAnimations = $event"
        />
      </div>
    </section>

    <!-- ─── Game settings ─── -->
    <section id="settings-game" v-show="visibleCategoryIds.has('settings-game')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.game.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.game.autoSaveInterval.label') }}</span>
          <span class="setting-desc">{{ $t('settings.game.autoSaveInterval.desc') }}</span>
        </div>
        <div class="number-control">
          <input
            v-model.number="settings.autoSaveInterval"
            type="number"
            min="0"
            max="50"
            class="number-input"
          />
          <span class="number-unit">{{ $t('settings.game.autoSaveInterval.unit') }}</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.game.language.label') }}</span>
          <span class="setting-desc">{{ $t('settings.game.language.desc') }}</span>
        </div>
        <AgaSelect
          :model-value="settings.language"
          :options="languageOptions"
          @update:model-value="settings.language = $event"
        />
      </div>
    </section>

    <!-- ─── B.2.1 行动选项深度设置 ─── -->
    <section v-if="settings.showActionOptions" v-show="visibleCategoryIds.has('settings-action')" id="settings-action" class="settings-section">
      <h3 class="section-title">{{ $t('settings.action.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.action.mode.label') }}</span>
          <span class="setting-desc">{{ $t('settings.action.mode.desc') }}</span>
        </div>
        <div class="radio-group">
          <label class="radio-opt">
            <input type="radio" v-model="actionOptions.mode" value="action" />
            <span>{{ $t('settings.action.mode.action') }}</span>
          </label>
          <label class="radio-opt">
            <input type="radio" v-model="actionOptions.mode" value="story" />
            <span>{{ $t('settings.action.mode.story') }}</span>
          </label>
        </div>
      </div>

      <Transition name="fade-row">
        <div v-if="actionOptions.mode === 'action'" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.action.pace.label') }}</span>
            <span class="setting-desc">{{ $t('settings.action.pace.desc') }}</span>
          </div>
          <div class="radio-group">
            <label class="radio-opt">
              <input type="radio" v-model="actionOptions.pace" value="fast" />
              <span>{{ $t('settings.action.pace.fast') }}</span>
            </label>
            <label class="radio-opt">
              <input type="radio" v-model="actionOptions.pace" value="slow" />
              <span>{{ $t('settings.action.pace.slow') }}</span>
            </label>
          </div>
        </div>
      </Transition>

      <div class="setting-row setting-row--column">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.action.customPrompt.label') }}</span>
          <span class="setting-desc">{{ $t('settings.action.customPrompt.desc') }}</span>
        </div>
        <textarea
          v-model="actionOptions.customPrompt"
          class="setting-textarea"
          :placeholder="$t('settings.action.customPrompt.placeholder')"
          rows="3"
          maxlength="500"
        />
        <span class="char-count">{{ actionOptions.customPrompt.length }}/500</span>
      </div>
    </section>

    <!-- ─── B.2.2 世界心跳高级设置 ─── -->
    <section v-if="isLoaded" v-show="visibleCategoryIds.has('settings-heartbeat')" id="settings-heartbeat" class="settings-section">
      <h3 class="section-title">{{ $t('settings.heartbeat.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.heartbeat.historyLimit.label') }}</span>
          <span class="setting-desc">{{ $t('settings.heartbeat.historyLimit.desc') }}</span>
        </div>
        <div class="number-control">
          <input
            type="number" class="number-input" min="5" max="100"
            :value="heartbeatHistoryLimit"
            @change="setHeartbeatHistoryLimit(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="number-unit">{{ $t('settings.heartbeat.historyLimit.unit') }}</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.heartbeat.forgetRounds.label') }}</span>
          <span class="setting-desc">{{ $t('settings.heartbeat.forgetRounds.desc') }}</span>
        </div>
        <div class="number-control">
          <input
            type="number" class="number-input" min="0" max="999"
            :value="heartbeatForgetRounds"
            @change="setHeartbeatForgetRounds(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="number-unit">{{ $t('settings.heartbeat.forgetRounds.unit') }}</span>
        </div>
      </div>
    </section>

    <!-- ─── B.2.3 NPC 设置 ─── -->
    <section v-if="isLoaded" v-show="visibleCategoryIds.has('settings-npc')" id="settings-npc" class="settings-section">
      <h3 class="section-title">{{ $t('settings.npc.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.npc.demotionThreshold.label') }}</span>
          <span class="setting-desc">{{ $t('settings.npc.demotionThreshold.desc') }}</span>
        </div>
        <div class="number-control">
          <input
            type="number" class="number-input" min="1" max="999"
            :value="npcDemotionThreshold"
            @change="setNpcDemotion(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="number-unit">{{ $t('settings.npc.demotionThreshold.unit') }}</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.npc.generationRange.label') }}</span>
          <span class="setting-desc">{{ $t('settings.npc.generationRange.desc') }}</span>
        </div>
        <div class="range-pair">
          <input
            type="number" class="number-input" min="0" max="10"
            :value="npcRangeMin"
            @change="setNpcRangeMin(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="range-sep">–</span>
          <input
            type="number" class="number-input" min="0" max="10"
            :value="npcRangeMax"
            @change="setNpcRangeMax(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
    </section>

    <!-- ─── Plot Direction Settings (Sprint Plot-1 P6) ─── -->
    <section v-if="isLoaded" v-show="visibleCategoryIds.has('settings-plot')" id="settings-plot" class="settings-section">
      <h3 class="section-title">{{ $t('settings.plot.sectionTitle') }}</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.plot.enabled.label') }}</span>
          <span class="setting-desc">{{ $t('settings.plot.enabled.desc') }}</span>
        </div>
        <AgaToggle
          :model-value="plotSettings.enabled"
          @update:model-value="plotSettings.enabled = $event"
        />
      </div>

      <template v-if="plotSettings.enabled">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.criticalConfirm.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.criticalConfirm.desc') }}</span>
          </div>
          <AgaToggle
            :model-value="plotSettings.criticalConfirmGate"
            @update:model-value="plotSettings.criticalConfirmGate = $event"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.confidenceThreshold.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.confidenceThreshold.desc') }}</span>
          </div>
          <input
            type="number"
            class="number-input"
            min="0.1" max="1.0" step="0.05"
            :value="plotSettings.confidenceThreshold"
            @change="plotSettings.confidenceThreshold = Math.max(0.1, Math.min(1, Number(($event.target as HTMLInputElement).value)))"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.opportunityMaxTier.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.opportunityMaxTier.desc') }}</span>
          </div>
          <input
            type="number"
            class="number-input"
            min="1" max="3" step="1"
            :value="plotSettings.opportunityMaxTier"
            @change="plotSettings.opportunityMaxTier = Math.max(1, Math.min(3, Math.round(Number(($event.target as HTMLInputElement).value)))) as 1 | 2 | 3"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.showGauges.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.showGauges.desc') }}</span>
          </div>
          <AgaToggle
            :model-value="plotSettings.showGaugesInMainPanel"
            @update:model-value="plotSettings.showGaugesInMainPanel = $event"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.showEvalLog.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.showEvalLog.desc') }}</span>
          </div>
          <AgaToggle
            :model-value="plotSettings.showEvalLog"
            @update:model-value="plotSettings.showEvalLog = $event"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.maxActiveThreads.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.maxActiveThreads.desc') }}</span>
          </div>
          <input
            type="number"
            class="number-input"
            min="1" max="5" step="1"
            :value="plotSettings.maxActiveThreads"
            @change="plotSettings.maxActiveThreads = Math.max(1, Math.min(5, Math.round(Number(($event.target as HTMLInputElement).value)) || 1))"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ $t('settings.plot.timelineAxis.label') }}</span>
            <span class="setting-desc">{{ $t('settings.plot.timelineAxis.desc') }}</span>
          </div>
          <AgaSelect
            :model-value="timelineAxisValue"
            :options="timelineAxisOptions"
            @update:model-value="setTimelineAxisSetting($event as PlotTimelineAxis)"
          />
        </div>
      </template>
    </section>

    <!-- ─── B.2.4 高级设置 ─── -->
    <section id="settings-advanced" v-show="visibleCategoryIds.has('settings-advanced')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.advanced.sectionTitle') }}</h3>

      <!-- Debug mode -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.advanced.debugMode.label') }}</span>
          <span class="setting-desc">{{ $t('settings.advanced.debugMode.desc') }}</span>
        </div>
        <AgaToggle
          :model-value="debugSettings.debugMode"
          @update:model-value="debugSettings.debugMode = $event"
        />
      </div>

      <Transition name="fade-row">
        <div v-if="debugSettings.debugMode" class="debug-sub">
          <AgaToggle v-model="debugSettings.consoleDebug" :label="$t('settings.advanced.consoleDebug.label')" show-label />
          <AgaToggle v-model="debugSettings.aiLogging" :label="$t('settings.advanced.aiLogging.label')" show-label />
        </div>
      </Transition>

      <!-- Text replace rules -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.advanced.textReplace.label') }}</span>
          <span class="setting-desc">{{ $t('settings.advanced.textReplace.desc', { count: textReplaceRules.length }) }}</span>
        </div>
        <AgaButton variant="primary" size="sm" @click="showReplaceModal = true">{{ $t('settings.advanced.textReplace.editRules') }}</AgaButton>
      </div>

      <!-- Import / Export settings -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.advanced.importExport.label') }}</span>
          <span class="setting-desc">{{ $t('settings.advanced.importExport.desc') }}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <AgaButton variant="primary" size="sm" @click="exportSettings">{{ $t('settings.advanced.importExport.export') }}</AgaButton>
          <AgaButton variant="primary" size="sm" @click="openImportSettings">{{ $t('settings.advanced.importExport.import') }}</AgaButton>
        </div>
      </div>

      <!-- Clear cache -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.advanced.clearCache.label') }}</span>
          <span class="setting-desc">{{ $t('settings.advanced.clearCache.desc') }}</span>
        </div>
        <AgaButton variant="danger" size="sm" @click="showClearCacheConfirm = true">{{ $t('settings.advanced.clearCache.btn') }}</AgaButton>
      </div>
    </section>

    <!-- ─── 6.1 界面缩放 + 文本速度 ─── -->
    <section id="settings-scale" v-show="visibleCategoryIds.has('settings-scale')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.scale.sectionTitle') }}</h3>

      <!-- UI Scale -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.scale.uiScale.label', { value: uiScale }) }}</span>
          <span class="setting-desc">{{ $t('settings.scale.uiScale.desc') }}</span>
        </div>
        <div class="scale-control">
          <Tooltip :text="$t('settings.scale.uiScale.decrease')" interactive>
            <button class="adj-btn" :aria-label="$t('settings.scale.uiScale.decrease')" @click="uiScale = Math.max(80, uiScale - 5)">−</button>
          </Tooltip>
          <input
            type="range"
            min="80"
            max="120"
            step="5"
            v-model.number="uiScale"
            class="scale-slider"
            :aria-label="$t('settings.scale.uiScale.ariaLabel')"
          />
          <Tooltip :text="$t('settings.scale.uiScale.increase')" interactive>
            <button class="adj-btn" :aria-label="$t('settings.scale.uiScale.increase')" @click="uiScale = Math.min(120, uiScale + 5)">+</button>
          </Tooltip>
          <AgaButton variant="primary" size="sm" @click="uiScale = 100">{{ $t('settings.scale.uiScale.reset') }}</AgaButton>
        </div>
      </div>

      <!-- Text speed -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.scale.textSpeed.label') }}</span>
          <span class="setting-desc">{{ $t('settings.scale.textSpeed.desc') }}</span>
        </div>
        <div class="radio-group">
          <label
            v-for="opt in textSpeedOptions"
            :key="opt"
            :class="['speed-opt', { 'speed-opt--active': textSpeed === opt }]"
          >
            <input type="radio" :value="opt" v-model="textSpeed" class="sr-only" />
            {{ opt }}
          </label>
        </div>
      </div>
    </section>

    <!-- ─── 6.1 数据管理 ─── -->
    <section id="settings-data" v-show="visibleCategoryIds.has('settings-data')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.data.sectionTitle') }}</h3>

      <!-- Export all saves -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.data.exportAllSaves.label') }}</span>
          <span class="setting-desc">{{ $t('settings.data.exportAllSaves.desc') }}</span>
        </div>
        <AgaButton variant="primary" size="sm" :disabled="isExportingAllSaves" :loading="isExportingAllSaves" @click="exportAllSaves">
          {{ isExportingAllSaves ? $t('settings.data.exportAllSaves.btnBusy') : $t('settings.data.exportAllSaves.btn') }}
        </AgaButton>
      </div>

      <!-- Import saves -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.data.importSaves.label') }}</span>
          <span class="setting-desc">{{ $t('settings.data.importSaves.desc') }}</span>
        </div>
        <AgaButton variant="primary" size="sm" @click="openImportSaves">{{ $t('settings.data.importSaves.btn') }}</AgaButton>
      </div>

      <!-- Clear all data -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.data.clearAll.label') }}</span>
          <span class="setting-desc" style="color: var(--color-danger, #ef4444);">{{ $t('settings.data.clearAll.desc') }}</span>
        </div>
        <AgaButton variant="danger" size="sm" @click="showClearAllConfirm = true; clearAllStep = 1">
          {{ $t('settings.data.clearAll.btn') }}
        </AgaButton>
      </div>
    </section>

    <!-- ─── 记忆系统阈值（2026-04-11 四层记忆） ─── -->
    <section id="settings-memory" v-show="visibleCategoryIds.has('settings-memory')" class="settings-section">
      <h3 class="section-title">{{ $t('settings.memory.sectionTitle') }}</h3>
      <p class="section-subtitle" style="color: var(--color-text-muted, #888); font-size: 12px; margin: -4px 0 10px;">
        {{ $t('settings.memory.sectionDesc') }}
      </p>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.shortTermLimit.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.shortTermLimit.desc') }}</span>
        </div>
        <input
          type="number"
          min="1"
          max="20"
          step="1"
          v-model.number="memorySettings.shortTermLimit"
          class="num-input"
          :aria-label="$t('settings.memory.shortTermLimit.label')"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.midTermRefineThreshold.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.midTermRefineThreshold.desc') }}</span>
        </div>
        <input
          type="number"
          min="5"
          max="200"
          step="1"
          v-model.number="memorySettings.midTermRefineThreshold"
          class="num-input"
          :aria-label="$t('settings.memory.midTermRefineThreshold.label')"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.longTermSummaryThreshold.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.longTermSummaryThreshold.desc') }}</span>
        </div>
        <input
          type="number"
          min="10"
          max="500"
          step="1"
          v-model.number="memorySettings.longTermSummaryThreshold"
          class="num-input"
          :aria-label="$t('settings.memory.longTermSummaryThreshold.label')"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.longTermSummarizeCount.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.longTermSummarizeCount.desc') }}</span>
        </div>
        <input
          type="number"
          min="5"
          max="500"
          step="1"
          v-model.number="memorySettings.longTermSummarizeCount"
          class="num-input"
          :aria-label="$t('settings.memory.longTermSummarizeCount.label')"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.midTermKeep.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.midTermKeep.desc') }}</span>
        </div>
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          v-model.number="memorySettings.midTermKeep"
          class="num-input"
          :aria-label="$t('settings.memory.midTermKeep.label')"
        />
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.longTermCap.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.longTermCap.desc') }}</span>
        </div>
        <input
          type="number"
          min="10"
          max="200"
          step="1"
          v-model.number="memorySettings.longTermCap"
          class="num-input"
          :aria-label="$t('settings.memory.longTermCap.label')"
        />
      </div>

      <!-- 短期记忆注入方式 / few-shot 对数两行已于 2026-09-04 移除（Context Compiler v1，PO 决议 Q3）：
           分步第二步固定 2 对历史，子流程固定 3 对，见 src/engine/prompt/context-compiler.ts -->

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.memory.resetDefaults.label') }}</span>
          <span class="setting-desc">{{ $t('settings.memory.resetDefaults.desc') }}</span>
        </div>
        <AgaButton variant="primary" size="sm" @click="memorySettings = { ...defaultMemorySettings }">{{ $t('settings.memory.resetDefaults.label') }}</AgaButton>
      </div>
    </section>

    <!-- ─── Engram 记忆增强 ─── -->
    <EngramSettingsSection />

    <!-- ─── About ─── -->
    <section class="settings-section settings-section--about">
      <h3 class="section-title">{{ $t('settings.about.sectionTitle') }}</h3>
      <div class="about-info">
        <div class="about-row">
          <span class="about-label">{{ $t('settings.about.version') }}</span>
          <span class="about-value">0.1.0</span>
        </div>
        <div class="about-row">
          <span class="about-label">{{ $t('settings.about.engine') }}</span>
          <span class="about-value">众生 Sonder</span>
        </div>
      </div>
    </section>

      </div><!-- end settings-content -->
    </div><!-- end settings-layout -->
  </div>

  <!-- Text replace rules modal -->
  <Modal v-model="showReplaceModal" :title="$t('settings.textReplace.modalTitle')" width="600px">
    <div class="rules-header">
      <span class="rules-count">{{ $t('settings.textReplace.count', { count: textReplaceRules.length }) }}</span>
      <AgaButton variant="primary" size="sm" @click="openNewRule">{{ $t('settings.textReplace.addRule') }}</AgaButton>
    </div>
    <div v-if="textReplaceRules.length" class="rules-list">
      <div v-for="rule in textReplaceRules" :key="rule.id" class="rule-row">
        <Tooltip :text="rule.enabled ? $t('settings.textReplace.enabled') : $t('settings.textReplace.disabled')" interactive>
          <button
            :class="['rule-toggle', { 'rule-toggle--on': rule.enabled }]"
            :aria-label="rule.enabled ? $t('settings.textReplace.enabled') : $t('settings.textReplace.disabled')"
            @click="toggleRule(rule.id)"
          >{{ rule.enabled ? '●' : '○' }}</button>
        </Tooltip>
        <div class="rule-info">
          <code class="rule-pattern">{{ rule.pattern }}</code>
          <span class="rule-arrow">→</span>
          <span class="rule-replacement">{{ rule.replacement || $t('settings.textReplace.emptyReplacement') }}</span>
        </div>
        <span :class="['rule-mode', `rule-mode--${rule.mode}`]">{{ rule.mode }}</span>
        <div class="rule-flags">
          <span v-if="rule.ignoreCase" class="rule-flag">i</span>
          <span v-if="rule.global" class="rule-flag">g</span>
        </div>
        <Tooltip :text="$t('settings.textReplace.editRule')" interactive>
          <button class="btn-icon-sm" :aria-label="$t('settings.textReplace.editRule')" @click="openEditRule(rule)">✏️</button>
        </Tooltip>
        <Tooltip :text="$t('settings.textReplace.deleteRule')" interactive>
          <button class="btn-icon-sm btn-icon-sm--danger" :aria-label="$t('settings.textReplace.deleteRule')" @click="deleteRule(rule.id)">🗑️</button>
        </Tooltip>
      </div>
    </div>
    <p v-else class="rules-empty">{{ $t('settings.textReplace.empty') }}</p>
  </Modal>

  <!-- Rule editor modal -->
  <Modal v-model="showRuleEditor" :title="editingRule ? $t('settings.textReplace.editTitle') : $t('settings.textReplace.newTitle')" width="480px">
    <div class="form-field">
      <label class="form-label">{{ $t('settings.textReplace.patternLabel') }} <span class="req">*</span></label>
      <input v-model="ruleForm.pattern" class="form-input" :placeholder="$t('settings.textReplace.patternPlaceholder')" maxlength="500" />
    </div>
    <div class="form-field">
      <label class="form-label">{{ $t('settings.textReplace.replacementLabel') }}</label>
      <input v-model="ruleForm.replacement" class="form-input" :placeholder="$t('settings.textReplace.replacementPlaceholder')" maxlength="1500" />
    </div>
    <div class="form-row">
      <label class="form-label">{{ $t('settings.textReplace.modeLabel') }}</label>
      <div class="radio-group">
        <label class="radio-opt"><input type="radio" v-model="ruleForm.mode" value="text" /> {{ $t('settings.textReplace.modeText') }}</label>
        <label class="radio-opt"><input type="radio" v-model="ruleForm.mode" value="regex" /> {{ $t('settings.textReplace.modeRegex') }}</label>
      </div>
    </div>
    <div class="form-checks">
      <label class="check-opt"><input type="checkbox" v-model="ruleForm.ignoreCase" /> {{ $t('settings.textReplace.ignoreCase') }}</label>
      <label class="check-opt"><input type="checkbox" v-model="ruleForm.global" /> {{ $t('settings.textReplace.global') }}</label>
    </div>
    <p v-if="ruleFormError" class="form-error">{{ ruleFormError }}</p>
    <template #footer>
      <AgaButton variant="secondary" size="md" @click="showRuleEditor = false">{{ $t('settings.textReplace.cancelBtn') }}</AgaButton>
      <AgaButton variant="primary" size="md" @click="submitRuleForm">{{ editingRule ? $t('settings.textReplace.saveBtn') : $t('settings.textReplace.addBtn') }}</AgaButton>
    </template>
  </Modal>

  <!-- Clear cache confirm -->
  <Modal v-model="showClearCacheConfirm" :title="$t('settings.advanced.clearCache.confirmTitle')" width="360px">
    <p class="confirm-text">{{ $t('settings.advanced.clearCache.confirmText') }}</p>
    <template #footer>
      <AgaButton variant="secondary" size="md" @click="showClearCacheConfirm = false">{{ $t('settings.advanced.clearCache.confirmCancel') }}</AgaButton>
      <AgaButton variant="danger" size="md" @click="clearCache">{{ $t('settings.advanced.clearCache.confirmOk') }}</AgaButton>
    </template>
  </Modal>

  <!-- Clear ALL data confirm (2-step) -->
  <Modal v-model="showClearAllConfirm" :title="'⚠️ ' + $t('settings.data.clearAll.modalTitle')" width="400px">
    <template v-if="clearAllStep === 1">
      <p class="confirm-text danger-text">{{ $t('settings.data.clearAll.step1Text') }}</p>
      <ul class="danger-list">
        <li>{{ $t('settings.data.clearAll.step1List1') }}</li>
        <li>{{ $t('settings.data.clearAll.step1List2') }}</li>
        <li>{{ $t('settings.data.clearAll.step1List3') }}</li>
      </ul>
      <p class="confirm-text">{{ $t('settings.data.clearAll.step1Confirm') }}</p>
    </template>
    <template v-else>
      <p class="confirm-text danger-text">{{ $t('settings.data.clearAll.step2Text') }}</p>
      <p class="confirm-text">{{ $t('settings.data.clearAll.step2Hint') }}</p>
    </template>
    <template #footer>
      <AgaButton variant="secondary" size="md" @click="showClearAllConfirm = false">{{ $t('settings.data.clearAll.step1Cancel') }}</AgaButton>
      <AgaButton v-if="clearAllStep === 1" variant="danger" size="md" @click="clearAllStep = 2">
        {{ $t('settings.data.clearAll.step1Continue') }}
      </AgaButton>
      <AgaButton v-else variant="danger" size="md" @click="clearAllData">
        {{ $t('settings.data.clearAll.step2Confirm') }}
      </AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  position: absolute;
  inset: 0;
  overflow: hidden;
  padding-left: var(--sidebar-left-reserve, 40px);
  padding-right: var(--sidebar-right-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

.settings-panel--vscode .panel-header {
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.settings-search {
  flex: 1;
  max-width: 300px;
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
}
.settings-search:focus { outline: none; border-color: var(--color-primary); }
.settings-search::placeholder { color: var(--color-text-muted); }

.settings-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.settings-nav {
  width: clamp(200px, 18%, 260px);
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  padding: var(--space-md) var(--space-sm);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-nav__item {
  display: block;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 6px;
  text-align: left;
  color: var(--color-text-secondary);
  font-size: 0.88rem;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: color var(--duration-fast), border-color var(--duration-fast), background var(--duration-fast);
}
.settings-nav__item:hover {
  color: var(--color-text);
  background: var(--color-primary-muted);
}
.settings-nav__item--active {
  color: var(--color-primary);
  border-left-color: var(--color-primary);
  background: var(--color-primary-muted);
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg);
  padding-bottom: 40vh;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.setting-subsection-header {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-border-subtle);
  margin-top: var(--space-xs);
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
}

/* ── Sections ── */
/*
 * 2026-04-11 defensive fix: `flex-shrink: 0` 防止 flex 压缩陷阱。
 *
 * `.settings-panel` 是 `display: flex; flex-direction: column`，子项默认
 * `flex-shrink: 1`。若任何 section 有 `overflow: hidden/scroll/auto`，其
 * 隐式 `min-height` 会从 `auto` 变成 `0`，在内容超出容器时被压成 0 高度
 * （EngramSettingsSection 的 `.engram-section` 曾因此"消失"于游戏内 —
 *  见 2026-04-11 changelog）。当前 `.settings-section` 本身没有 overflow，
 *  不受影响，但加 `flex-shrink: 0` 作为防御 —— 未来任何 section 加了
 *  overflow 都不会再踩坑。
 */
.settings-section {
  flex-shrink: 0;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  position: relative;
}
.settings-section + .settings-section::after {
  content: '';
  position: absolute;
  top: -9px;
  left: 10%;
  right: 10%;
  height: 1px;
  background: var(--accent-sage);
  opacity: 0.35;
  pointer-events: none;
}

.section-title {
  margin: 0 0 14px;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary, #8888a0);
}

/* ── Setting rows ── */
.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  gap: 16px;
}
.setting-row + .setting-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.setting-row--indent {
  padding-left: 20px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 0.88rem;
  font-weight: 500;
  color: var(--color-text, #e0e0e6);
}

.setting-desc {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}

/* ── Font size control ── */
.font-size-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.adj-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.adj-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--color-primary, #91c49b);
}

.font-size-value {
  font-size: 0.88rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  min-width: 36px;
  text-align: center;
}

/* ── Color picker ── */
.setting-row--col {
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.accent-presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.accent-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.accent-swatch:hover {
  border-color: var(--swatch-primary);
}
.accent-swatch--active {
  border-color: var(--swatch-primary);
  box-shadow:
    0 0 10px color-mix(in oklch, var(--swatch-primary) 25%, transparent),
    inset 0 0 8px color-mix(in oklch, var(--swatch-primary) 10%, transparent);
}
.accent-swatch__dots {
  display: flex;
  gap: 4px;
}
.accent-swatch__dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  transition: box-shadow var(--duration-fast) var(--ease-out);
}
.accent-swatch__dot--1 {
  background: var(--swatch-primary);
  box-shadow: 0 0 6px color-mix(in oklch, var(--swatch-primary) 40%, transparent);
}
.accent-swatch__dot--2 {
  background: var(--swatch-secondary);
  box-shadow: 0 0 6px color-mix(in oklch, var(--swatch-secondary) 40%, transparent);
}
.accent-swatch--active .accent-swatch__dot--1 {
  box-shadow: 0 0 8px color-mix(in oklch, var(--swatch-primary) 55%, transparent);
}
.accent-swatch--active .accent-swatch__dot--2 {
  box-shadow: 0 0 8px color-mix(in oklch, var(--swatch-secondary) 55%, transparent);
}
.accent-swatch__label {
  font-size: 0.68rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.accent-swatch--active .accent-swatch__label {
  color: var(--color-text);
}

/* ── Number control ── */
.number-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.number-input {
  width: 60px;
  height: 30px;
  padding: 0 8px;
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  outline: none;
  text-align: center;
}
.number-input:focus { border-color: var(--color-primary, #91c49b); }

.number-unit {
  font-size: 0.75rem;
  color: var(--color-text-secondary, #8888a0);
}

.num-input {
  width: 72px;
  padding: 5px 8px;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text, #e8e8f0);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 5px;
  text-align: right;
  transition: border-color 0.15s ease;
}
.num-input:focus {
  outline: none;
  border-color: var(--color-primary, #91c49b);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}

/* ── About ── */
.about-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.about-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 0.82rem;
}

.about-label {
  color: var(--color-text-secondary, #8888a0);
}

.about-value {
  color: var(--color-text, #e0e0e6);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

/* ── Slim themed scrollbar for every scrollable region inside settings ── */
.settings-panel ::-webkit-scrollbar { width: 6px; height: 6px; }
.settings-panel ::-webkit-scrollbar-track { background: transparent; }
.settings-panel ::-webkit-scrollbar-thumb {
  background: color-mix(in oklch, var(--color-text-umber) 35%, transparent);
  border-radius: 3px;
}
.settings-panel ::-webkit-scrollbar-thumb:hover { background: color-mix(in oklch, var(--color-text-umber) 55%, transparent); }
.settings-panel { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--color-text-umber) 35%, transparent) transparent; }
.settings-panel * { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--color-text-umber) 35%, transparent) transparent; }

/* ── B.2 additions ── */

.setting-row--column {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.setting-textarea {
  width: 100%;
  padding: 8px 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 7px;
  color: var(--color-text, #e0e0e6);
  font-size: 0.82rem;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;
}
.setting-textarea:focus { outline: none; border-color: var(--color-primary, #91c49b); }

.char-count {
  font-size: 0.68rem;
  color: var(--color-text-secondary, #8888a0);
  align-self: flex-end;
}

.radio-group {
  display: flex;
  gap: 14px;
}

.radio-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  cursor: pointer;
  user-select: none;
}
.radio-opt input { accent-color: var(--color-primary, #91c49b); }

.check-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  cursor: pointer;
  user-select: none;
}
.check-opt input { accent-color: var(--color-primary, #91c49b); }

.debug-sub {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(255,255,255,0.02);
  border-radius: 7px;
  margin: -4px 0 4px;
}

.range-pair {
  display: flex;
  align-items: center;
  gap: 6px;
}

.range-sep {
  font-size: 0.88rem;
  color: var(--color-text-secondary, #8888a0);
}

/* ── Text replace modal ── */
.rules-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.rules-count {
  font-size: 0.8rem;
  color: var(--color-text-secondary, #8888a0);
}
.rules-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 7px;
}
.rule-toggle {
  background: none;
  border: none;
  font-size: 0.9rem;
  cursor: pointer;
  color: var(--color-text-secondary, #8888a0);
  flex-shrink: 0;
}
.rule-toggle--on { color: var(--color-success, #22c55e); text-shadow: 0 0 4px color-mix(in oklch, var(--color-success) 35%, transparent); }
.rule-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.rule-pattern {
  font-size: 0.78rem;
  font-family: 'JetBrains Mono','Fira Code',monospace;
  color: var(--color-text, #e0e0e6);
  background: rgba(255,255,255,0.05);
  padding: 1px 5px;
  border-radius: 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-arrow { font-size: 0.75rem; color: var(--color-text-secondary, #8888a0); flex-shrink: 0; }
.rule-replacement {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}
.rule-mode {
  font-size: 0.64rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
  flex-shrink: 0;
}
.rule-mode--text  { background: color-mix(in oklch, var(--color-success) 12%, transparent); color: var(--color-success); }
.rule-mode--regex { background: color-mix(in oklch, var(--color-warning) 12%, transparent); color: var(--color-warning); }
.rule-flags { display: flex; gap: 3px; flex-shrink: 0; }
.rule-flag {
  font-size: 0.6rem;
  font-family: monospace;
  padding: 1px 4px;
  background: rgba(255,255,255,0.06);
  border-radius: 3px;
  color: var(--color-text-secondary, #8888a0);
}
.rules-empty {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #8888a0);
  text-align: center;
  padding: 12px 0;
  margin: 0;
}
.btn-icon-sm {
  background: none;
  border: none;
  font-size: 0.78rem;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background 0.15s;
  flex-shrink: 0;
}
.btn-icon-sm:hover { background: rgba(255,255,255,0.08); }
.btn-icon-sm--danger:hover { background: color-mix(in oklch, var(--color-danger) 15%, transparent); }

/* ── Rule editor form ── */
.form-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.form-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.form-label { font-size: 0.78rem; font-weight: 600; color: var(--color-text-secondary, #8888a0); }
.req { color: var(--color-danger, #ef4444); }
.form-input {
  padding: 7px 10px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 7px;
  color: var(--color-text, #e0e0e6);
  font-size: 0.84rem;
  font-family: inherit;
}
.form-input:focus { outline: none; border-color: var(--color-primary, #91c49b); box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent), inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent); }
.form-checks { display: flex; gap: 16px; margin-bottom: 8px; }
.form-error { font-size: 0.78rem; color: var(--color-danger, #ef4444); margin: 0 0 6px; }
.confirm-text { font-size: 0.88rem; color: var(--color-text, #e0e0e6); line-height: 1.5; margin: 0; }

/* ── Transitions ── */
.fade-row-enter-active { transition: all 0.15s ease; }
.fade-row-leave-active { transition: all 0.1s ease; }
.fade-row-enter-from, .fade-row-leave-to { opacity: 0; max-height: 0; }
.fade-row-enter-to, .fade-row-leave-from { opacity: 1; max-height: 200px; }

/* ── UI scale control ── */
.scale-control {
  display: flex;
  align-items: center;
  gap: 6px;
}
.scale-slider {
  width: 110px;
  accent-color: var(--color-primary, #91c49b);
}

/* ── Text speed radio buttons ── */
.speed-opt {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 0.78rem;
  font-weight: 600;
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255,255,255,0.02);
  transition: all 0.15s ease;
}
.speed-opt:first-child { border-radius: 6px 0 0 6px; }
.speed-opt:last-child { border-radius: 0 6px 6px 0; }
.speed-opt + .speed-opt { border-left: none; }
.speed-opt--active {
  color: var(--color-primary, #91c49b);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

/* ── sr-only ── */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border: 0;
}

/* ── Danger styles for data management modal ── */
.danger-text { color: var(--color-danger, #ef4444); font-weight: 600; }
.danger-list {
  margin: 8px 0 12px 0;
  padding-left: 20px;
  font-size: 0.85rem;
  color: var(--color-text, #e0e0e6);
  line-height: 1.8;
}

/* ─── Mobile: side nav → horizontal scroll strip ─── */
@media (max-width: 767px) {
  .settings-nav {
    display: none;
  }
  .settings-content {
    padding: var(--space-md);
    padding-bottom: 30vh;
  }
}
</style>
