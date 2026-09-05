<script setup lang="ts">
// App doc: docs/user-guide/pages/game-prompts.md
/**
 * PromptPanel — 提示词管理面板（B.4 全功能版）
 *
 * 新增：
 * - 分类折叠分组（category-based grouping）
 * - 展开全部 / 折叠全部
 * - 每条 prompt 权重编辑（1–10），颜色区分（≥9红/≥6黄/其余绿）
 * - 导出单条 prompt（JSON 下载）
 * - 导出全部（仅已修改条目）
 * - 导入（选择 JSON，合并不清空）
 * - 权重持久化到 localStorage
 */
import { ref, computed, inject, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t } = useI18n();
import { eventBus } from '@/engine/core/event-bus';
import type { GamePack } from '@/engine/types/game-pack';
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_PROMPT_SETTINGS, resolveCapturedBudgetRatio, type PromptSettings } from '@/engine/prompt/world-book';
import { BUILTIN_SLOTS } from '@/engine/prompt/builtin-slots';
import { createEmptyHeroinePlan, type HeroinePlan, type HeroineEntry, type HeroineInteractionEvent } from '@/engine/story/heroine-plan';
import type { PromptRegistry } from '@/engine/prompt/prompt-registry';
import WorldBookTab from './WorldBookTab.vue';
import NarrativeContractTab from './NarrativeContractTab.vue';

const pack = inject<GamePack>('gamePack');
const promptRegistry = inject<PromptRegistry>('promptRegistry');
const { get, setValue } = useGameState();

// ─── Tab state ──────────────────────────────────────────────
type PanelTab = 'prompts' | 'settings' | 'heroine' | 'worldbook' | 'contract';
const route = useRoute();

/**
 * Opening tab, honouring `?tab=` so other surfaces can deep-link here.
 *
 * Canon Capture's toast uses it to land the player directly on the captured-settings
 * book: an "undo / view" affordance that dumps you on the wrong tab is barely better
 * than no affordance.
 */
const TAB_IDS: readonly PanelTab[] = ['prompts', 'settings', 'heroine', 'worldbook', 'contract'];
function initialTab(): PanelTab {
  const requested = route.query['tab'];
  const value = Array.isArray(requested) ? requested[0] : requested;
  return TAB_IDS.includes(value as PanelTab) ? (value as PanelTab) : 'prompts';
}

const activeTab = ref<PanelTab>(initialTab());

// Deep-links can arrive while the panel is already mounted (router keeps it alive).
watch(() => route.query['tab'], () => { activeTab.value = initialTab(); });

/**
 * Canon Capture budget share, shown as a whole percentage.
 *
 * Stored as a 0-1 ratio (`PromptSettings.capturedEntryBudgetRatio`) and clamped by
 * `resolveCapturedBudgetRatio` on read, so a hand-edited save with a nonsense value
 * still renders a sane slider instead of an empty track.
 */
const capturedBudgetPercent = computed(() =>
  Math.round(resolveCapturedBudgetRatio(promptSettings.value.capturedEntryBudgetRatio) * 100));

function onCapturedBudgetInput(event: Event): void {
  const percent = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(percent)) return;
  updatePromptSetting('capturedEntryBudgetRatio', resolveCapturedBudgetRatio(percent / 100));
}

// ─── Prompt Settings (from state tree) ──────────────────────
const promptSettings = computed<PromptSettings>(() => {
  const raw = get<Partial<PromptSettings>>('系统.设置.prompt');
  return { ...DEFAULT_PROMPT_SETTINGS, ...raw };
});

function updatePromptSetting<K extends keyof PromptSettings>(key: K, value: PromptSettings[K]) {
  const current = promptSettings.value;
  setValue('系统.设置.prompt', { ...current, [key]: value });
}

// ─── Action options select options ──────────────────────────
const actionModeOptions = computed(() => [
  { value: 'action', label: t('prompt.settings.actionModeAction') },
  { value: 'story', label: t('prompt.settings.actionModeStory') },
]);
const actionPaceOptions = computed(() => [
  { value: 'fast', label: t('prompt.settings.actionPaceFast') },
  { value: 'slow', label: t('prompt.settings.actionPaceSlow') },
]);

// ─── Edit-modal injection mode select options ───────────────
const injectionModeOptions = computed(() => [
  { value: 'always', label: t('prompt.modal.injectionAlways') },
  { value: 'match_any', label: t('prompt.modal.injectionKeyword') },
]);

// ─── Heroine Plan state ─────────────────────────────────────
const heroinePlan = computed<HeroinePlan>(() => {
  const raw = get<HeroinePlan>('元数据.女主规划');
  return raw ?? createEmptyHeroinePlan();
});

const heroineEditName = ref('');
const heroineEditType = ref('主线女主');
const heroineEditRelation = ref('');
const heroineEditStage = ref('');

// ─── Heroine type select options ────────────────────────────
const heroineTypeOptions = computed(() => [
  { value: '主线女主', label: t('prompt.heroine.typeMainHeroine') },
  { value: '支线女主', label: t('prompt.heroine.typeSubHeroine') },
  { value: '隐藏女主', label: t('prompt.heroine.typeHiddenHeroine') },
  { value: '主线男主', label: t('prompt.heroine.typeMainHero') },
  { value: '支线角色', label: t('prompt.heroine.typeSupportRole') },
]);

// ─── Heroine event target select options ────────────────────
const heroineEventTargetOptions = computed(() =>
  heroinePlan.value.heroineEntries.map((h) => ({ value: h.name, label: h.name })),
);

function addHeroineEntry() {
  if (!heroineEditName.value.trim()) return;
  const entry: HeroineEntry = {
    name: heroineEditName.value.trim(),
    type: heroineEditType.value,
    currentRelationStatus: heroineEditRelation.value || '陌生',
    currentStage: heroineEditStage.value || '初识期',
    establishedFacts: [],
    stageGoals: [],
    progressionMethods: [],
    blockingFactors: [],
    breakthroughConditions: [],
    failureRollback: [],
  };
  const plan = { ...heroinePlan.value };
  plan.heroineEntries = [...plan.heroineEntries, entry];
  setValue('元数据.女主规划', plan);
  heroineEditName.value = '';
  heroineEditRelation.value = '';
  heroineEditStage.value = '';
}

function removeHeroineEntry(name: string) {
  const plan = { ...heroinePlan.value };
  plan.heroineEntries = plan.heroineEntries.filter((e) => e.name !== name);
  plan.interactionEvents = plan.interactionEvents.filter((e) => e.heroineName !== name);
  plan.scenePlans = plan.scenePlans.filter((e) => e.heroineName !== name);
  setValue('元数据.女主规划', plan);
}

const heroineEventName = ref('');
const heroineEventDesc = ref('');
const heroineEventTarget = ref('');

function addHeroineEvent() {
  if (!heroineEventName.value.trim() || !heroineEventTarget.value) return;
  const event: HeroineInteractionEvent = {
    heroineName: heroineEventTarget.value,
    eventName: heroineEventName.value.trim(),
    eventDescription: heroineEventDesc.value.trim(),
    plannedTriggerTime: '',
    earliestTriggerTime: '',
    latestTriggerTime: '',
    prerequisites: [],
    triggerConditions: [],
    blockConditions: [],
    successOutcomes: [],
    failureOutcomes: [],
    relatedQuests: [],
    status: '待触发',
  };
  const plan = { ...heroinePlan.value };
  plan.interactionEvents = [...plan.interactionEvents, event];
  setValue('元数据.女主规划', plan);
  heroineEventName.value = '';
  heroineEventDesc.value = '';
}

function removeHeroineEvent(idx: number) {
  const plan = { ...heroinePlan.value };
  plan.interactionEvents = plan.interactionEvents.filter((_, i) => i !== idx);
  setValue('元数据.女主规划', plan);
}

// ─── Prompt entry & persistence ──────────────────────────────

interface PromptEntry {
  id: string;
  category: string;
  content: string;
  defaultContent: string;
  enabled: boolean;
  modified: boolean;
  weight: number;
  scope: string[];
  injectionMode: 'always' | 'match_any';
  keywords: string[];
  type: 'world_lore' | 'system_rule' | 'command_rule' | 'output_rule';
}

const SCOPE_OPTION_KEYS = ['main', 'opening', 'all', 'world_evolution', 'story_plan', 'heroine_plan', 'recall'] as const;
const scopeOptions = computed(() => SCOPE_OPTION_KEYS.map((value) => ({
  value,
  label: t(`prompt.scope.${({ main: 'main', opening: 'opening', all: 'all', world_evolution: 'worldEvolution', story_plan: 'storyPlan', heroine_plan: 'heroinePlan', recall: 'recall' } as const)[value]}`),
})));

const TYPE_OPTION_KEYS = ['system_rule', 'world_lore', 'command_rule', 'output_rule'] as const;
const typeOptions = computed(() => TYPE_OPTION_KEYS.map((value) => ({
  value,
  label: t(`prompt.type.${({ system_rule: 'systemRule', world_lore: 'worldLore', command_rule: 'commandRule', output_rule: 'outputRule' } as const)[value]}`),
})));

function storageKey(id: string): string {
  const packId = pack?.manifest.id ?? 'unknown';
  return `aga_prompt_${packId}_${id}`;
}
function enabledKey(id: string): string {
  const packId = pack?.manifest.id ?? 'unknown';
  return `aga_prompt_enabled_${packId}_${id}`;
}
function weightKey(id: string): string {
  const packId = pack?.manifest.id ?? 'unknown';
  return `aga_prompt_weight_${packId}_${id}`;
}
function metaKey(id: string): string {
  const packId = pack?.manifest.id ?? 'unknown';
  return `aga_prompt_meta_${packId}_${id}`;
}

/** 读取高级字段（scope/injectionMode/keywords/type） */
function loadMeta(id: string): { scope: string[]; injectionMode: 'always' | 'match_any'; keywords: string[]; type: PromptEntry['type'] } {
  try {
    const raw = localStorage.getItem(metaKey(id));
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        scope: Array.isArray(parsed.scope) ? parsed.scope as string[] : ['all'],
        injectionMode: parsed.injectionMode === 'match_any' ? 'match_any' : 'always',
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords as string[] : [],
        type: (['world_lore', 'system_rule', 'command_rule', 'output_rule'].includes(parsed.type as string)
          ? parsed.type : 'system_rule') as PromptEntry['type'],
      };
    }
  } catch { /* ignore */ }
  return { scope: ['all'], injectionMode: 'always', keywords: [], type: 'system_rule' };
}

function saveMeta(id: string, meta: { scope: string[]; injectionMode: string; keywords: string[]; type: string }): void {
  localStorage.setItem(metaKey(id), JSON.stringify(meta));
}

/** Prompt ID → i18n key mapping for display names */
const PROMPT_DISPLAY_KEY_MAP: Record<string, string> = {
  narratorFrame: 'prompt.display.narratorFrame',
  narratorEnforcement: 'prompt.display.narratorEnforcement',
  core: 'prompt.display.core',
  mainRound: 'prompt.display.mainRound',
  opening: 'prompt.display.opening',
  memorySummary: 'prompt.display.memorySummary',
  midTermRefine: 'prompt.display.midTermRefine',
  longTermCompact: 'prompt.display.longTermCompact',
  splitGenStep1: 'prompt.display.splitGenStep1',
  splitGenStep2: 'prompt.display.splitGenStep2',
  splitGenContext: 'prompt.display.splitGenContext',
  worldGen: 'prompt.display.worldGen',
  worldHeartbeat: 'prompt.display.worldHeartbeat',
  actionOptions: 'prompt.display.actionOptions',
  actionOptionsStory: 'prompt.display.actionOptionsStory',
  historyFraming: 'prompt.display.historyFraming',
  assistantInjectionContract: 'prompt.display.assistantInjectionContract',
  privacyRepair: 'prompt.display.privacyRepair',
  npcChat: 'prompt.display.npcChat',
  npcMemorySummary: 'prompt.display.npcMemorySummary',
  presencePartition: 'prompt.display.presencePartition',
  'cot-preamble': 'prompt.display.cotPreamble',
  'cot-masquerade': 'prompt.display.cotMasquerade',
  'cot-judge': 'prompt.display.cotJudge',
  'cot-opening': 'prompt.display.cotOpening',
  'cot-no-thinking-guard': 'prompt.display.cotNoThinkingGuard',
  perspectiveFirst: 'prompt.display.perspectiveFirst',
  perspectiveSecond: 'prompt.display.perspectiveSecond',
  perspectiveThird: 'prompt.display.perspectiveThird',
  writeStyle: 'prompt.display.writeStyle',
  antiCliche: 'prompt.display.antiCliche',
  emotionGuard: 'prompt.display.emotionGuard',
  noControl: 'prompt.display.noControl',
  narrativeConstraints: 'prompt.display.narrativeConstraints',
  wordCountReq: 'prompt.display.wordCountReq',
  bodyPolish: 'prompt.display.bodyPolish',
  storyStyleGeneral: 'prompt.display.storyStyleGeneral',
  storyStyleHarem: 'prompt.display.storyStyleHarem',
  storyStylePureLove: 'prompt.display.storyStylePureLove',
  storyStyleCultivation: 'prompt.display.storyStyleCultivation',
  storyStyleShura: 'prompt.display.storyStyleShura',
  storyStyleNtlHarem: 'prompt.display.storyStyleNtlHarem',
  imageCharacterTokenizer: 'prompt.display.imageCharacterTokenizer',
  imageSceneTokenizer: 'prompt.display.imageSceneTokenizer',
  imageSceneJudge: 'prompt.display.imageSceneJudge',
  imageSecretPartTokenizer: 'prompt.display.imageSecretPartTokenizer',
  imageAnchorExtractor: 'prompt.display.imageAnchorExtractor',
  imageStyleRefinement: 'prompt.display.imageStyleRefinement',
  plotDirective: 'prompt.display.plotDirective',
  plotEvaluationStep2: 'prompt.display.plotEvaluationStep2',
  plotDecompose: 'prompt.display.plotDecompose',
};

/** Prompt ID → category key (stable internal key, NOT translated) */
function inferCategoryKey(id: string): string {
  // Check builtin slots first — find which slot references this promptId
  for (const slot of Object.values(BUILTIN_SLOTS)) {
    if (slot.defaultPromptId === id) return slot.category;
  }
  // Fallback pattern matching — returns the same Chinese key used by BUILTIN_SLOTS.category
  if (id.startsWith('core') || id === 'narratorFrame' || id === 'narratorEnforcement') return '常驻';
  if (id.startsWith('main') || id.includes('Round') || id.includes('round')) return '主剧情';
  if (id.startsWith('open') || id.includes('Opening') || id.includes('opening')) return '开局';
  if (id.includes('memory') || id.includes('Memory') || id.includes('midTerm') || id.includes('MidTerm')) return '记忆';
  if (id.includes('heartbeat') || id.includes('Heartbeat')) return '世界';
  if (id.includes('npc') || id.includes('Npc') || id.includes('NPC') || id.includes('presence')) return 'NPC';
  if (id.includes('split') || id.includes('Split')) return '分步生成';
  if (id.includes('cot') || id.startsWith('cot-')) return 'COT';
  if (id.includes('perspective') || id.includes('write') || id.includes('Write') || id.includes('emotion') || id.includes('noControl') || id.includes('narrative') || id.includes('wordCount')) return '写作';
  if (id.includes('storyStyle')) return '剧情风格';
  if (id.includes('image') || id.includes('Image') || id.includes('anchor') || id.includes('Anchor')) return '生图';
  if (id.includes('action') || id.includes('Action')) return '行动选项';
  if (id.includes('privacy') || id.includes('Privacy')) return 'NSFW';
  if (id.includes('bodyPolish')) return '文章优化';
  return '其他';
}

/** Map internal category key to i18n display name */
const CATEGORY_I18N_MAP: Record<string, string> = {
  '常驻': 'prompt.category.resident',
  '主剧情': 'prompt.category.mainStory',
  '剧情导向': 'prompt.category.plotDirection',
  'COT': 'prompt.category.cot',
  '写作': 'prompt.category.writing',
  '剧情风格': 'prompt.category.storyStyle',
  '开局': 'prompt.category.opening',
  '记忆': 'prompt.category.memory',
  'NPC': 'prompt.category.npc',
  '世界': 'prompt.category.world',
  '分步生成': 'prompt.category.splitGen',
  '行动选项': 'prompt.category.actionOptions',
  '生图': 'prompt.category.imageGen',
  '文章优化': 'prompt.category.bodyPolish',
  'NSFW': 'prompt.category.nsfw',
  '其他': 'prompt.category.other',
};

function categoryDisplayName(key: string): string {
  const i18nKey = CATEGORY_I18N_MAP[key];
  return i18nKey ? t(i18nKey) : key;
}

function getDisplayName(id: string): string {
  const i18nKey = PROMPT_DISPLAY_KEY_MAP[id];
  return i18nKey ? t(i18nKey) : id;
}

// ─── Pluggable radio-group options ──────────────────────────
// Style options are data-driven: built-in + any pack prompt whose ID starts with 'storyStyle'
interface RadioOption { value: string; label: string; desc: string }

const BUILTIN_STYLE_KEYS = ['general', 'harem', 'pureLove', 'cultivation', 'shura', 'ntlHarem'] as const;

const builtinStyleOptions = computed<RadioOption[]>(() =>
  BUILTIN_STYLE_KEYS.map((key) => ({
    value: key,
    label: t(`prompt.storyStyle.${key}`),
    desc: t(`prompt.storyStyle.${key}Desc`),
  })),
);

const storyStyleOptions = computed<RadioOption[]>(() => {
  const builtinValues = new Set(BUILTIN_STYLE_KEYS as readonly string[]);
  const extra: RadioOption[] = [];
  // Discover additional style prompts from pack (any ID starting with 'storyStyle' not in builtins)
  if (pack) {
    for (const id of Object.keys(pack.prompts)) {
      if (id.startsWith('storyStyle') && !builtinValues.has(id.replace('storyStyle', '').replace(/^./, (c) => c.toLowerCase()))) {
        const displayName = getDisplayName(id);
        const value = id.replace('storyStyle', '');
        // Only add if not already a builtin
        if (!builtinValues.has(value) && !builtinValues.has(value.charAt(0).toLowerCase() + value.slice(1))) {
          extra.push({ value: id, label: displayName, desc: t('prompt.storyStyle.customDesc') });
        }
      }
    }
  }
  return [...builtinStyleOptions.value, ...extra];
});

// Perspective options (also pluggable)
const perspectiveOptions = computed<RadioOption[]>(() => [
  { value: '第一人称', label: t('prompt.perspective.first'), desc: t('prompt.perspective.firstDesc') },
  { value: '第二人称', label: t('prompt.perspective.second'), desc: t('prompt.perspective.secondDesc') },
  { value: '第三人称', label: t('prompt.perspective.third'), desc: t('prompt.perspective.thirdDesc') },
]);

/**
 * Determine if a prompt is active based on radio-group settings.
 * For mutually-exclusive prompts (perspective, style), only the selected one is "on".
 */
function isPromptActiveByRadio(id: string): boolean | null {
  // Perspective prompts — only selected one is active
  const perspectiveMap: Record<string, string> = {
    perspectiveFirst: '第一人称',
    perspectiveSecond: '第��人称',
    perspectiveThird: '第三人称',
  };
  if (id in perspectiveMap) {
    return promptSettings.value.perspective === perspectiveMap[id];
  }

  // Style prompts — only selected one is active
  const styleReverseMap: Record<string, string> = {
    storyStyleGeneral: 'general',
    storyStyleHarem: 'harem',
    storyStylePureLove: 'pureLove',
    storyStyleCultivation: 'cultivation',
    storyStyleShura: 'shura',
    storyStyleNtlHarem: 'ntlHarem',
  };
  if (id in styleReverseMap) {
    return promptSettings.value.storyStyle === styleReverseMap[id];
  }

  // Not a radio-group prompt
  return null;
}

const promptEntries = computed<PromptEntry[]>(() => {
  if (!pack) return [];
  const entries: PromptEntry[] = [];
  for (const [id, defaultContent] of Object.entries(pack.prompts)) {
    const savedContent = localStorage.getItem(storageKey(id));
    const savedEnabled = localStorage.getItem(enabledKey(id));
    const savedWeight = localStorage.getItem(weightKey(id));
    const content = savedContent ?? defaultContent;

    // Radio-group override: if this prompt is part of a mutually-exclusive group,
    // its enabled state is determined by settings, not localStorage
    const radioState = isPromptActiveByRadio(id);
    const enabled = radioState !== null
      ? radioState
      : (savedEnabled !== null ? savedEnabled === 'true' : true);

    const weight = savedWeight !== null ? Math.min(10, Math.max(1, Number(savedWeight))) : 5;
    const meta = loadMeta(id);
    entries.push({
      id,
      category: inferCategoryKey(id),
      content,
      defaultContent,
      enabled,
      modified: content !== defaultContent,
      weight,
      scope: meta.scope,
      injectionMode: meta.injectionMode,
      keywords: meta.keywords,
      type: meta.type,
    });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
});

// ─── Category grouping ────────────────────────────────────────

const CATEGORY_ORDER = ['常驻', '主剧情', '剧情导向', 'COT', '写作', '剧情风格', '开局', '记忆', 'NPC', '世界', '分步生成', '行动选项', '生图', '文章优化', 'NSFW', '其他'];

interface CategoryGroup {
  name: string;
  entries: PromptEntry[];
  collapsed: boolean;
}

const collapsedCategories = ref<Set<string>>(new Set());

const categoryGroups = computed<CategoryGroup[]>(() => {
  const filtered = filteredPrompts.value;
  const groupMap = new Map<string, PromptEntry[]>();

  for (const entry of filtered) {
    const cat = entry.category;
    if (!groupMap.has(cat)) groupMap.set(cat, []);
    groupMap.get(cat)!.push(entry);
  }

  const groups: CategoryGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    if (groupMap.has(cat)) {
      groups.push({ name: cat, entries: groupMap.get(cat)!, collapsed: collapsedCategories.value.has(cat) });
    }
  }
  // Any category not in CATEGORY_ORDER (shouldn't happen but safe)
  for (const [cat, entries] of groupMap.entries()) {
    if (!CATEGORY_ORDER.includes(cat)) {
      groups.push({ name: cat, entries, collapsed: collapsedCategories.value.has(cat) });
    }
  }
  return groups;
});

function toggleCategory(cat: string): void {
  if (collapsedCategories.value.has(cat)) {
    collapsedCategories.value.delete(cat);
  } else {
    collapsedCategories.value.add(cat);
  }
  collapsedCategories.value = new Set(collapsedCategories.value); // trigger reactivity
}

function expandAll(): void {
  collapsedCategories.value = new Set();
}

function collapseAll(): void {
  collapsedCategories.value = new Set(categoryGroups.value.map((g) => g.name));
}

// ─── Search & filter ──────────────────────────────────────────

const searchQuery = ref('');
const filterMode = ref<'all' | 'enabled' | 'disabled' | 'modified'>('all');

const filterModeOptions = computed(() => [
  { value: 'all', label: t('prompt.filter.all') },
  { value: 'enabled', label: t('prompt.filter.enabled') },
  { value: 'disabled', label: t('prompt.filter.disabled') },
  { value: 'modified', label: t('prompt.filter.modified') },
]);

const filteredPrompts = computed<PromptEntry[]>(() => {
  let list = promptEntries.value;
  if (filterMode.value === 'enabled') list = list.filter((p) => p.enabled);
  if (filterMode.value === 'disabled') list = list.filter((p) => !p.enabled);
  if (filterMode.value === 'modified') list = list.filter((p) => p.modified);
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    list = list.filter(
      (p) => p.id.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
    );
  }
  return list;
});

// ─── Toggle enabled ───────────────────────────────────────────

function toggleEnabled(entry: PromptEntry): void {
  const newVal = !entry.enabled;
  localStorage.setItem(enabledKey(entry.id), String(newVal));
  promptRegistry?.setEnabled(entry.id, newVal);
  eventBus.emit('ui:toast', {
    type: newVal ? 'success' : 'warning',
    message: newVal ? t('prompt.toast.enabled', { id: entry.id }) : t('prompt.toast.disabled', { id: entry.id }),
    duration: 1200,
  });
}

// ─── Weight editing ───────────────────────────────────────────

function setWeight(entry: PromptEntry, val: number): void {
  const clamped = Math.min(10, Math.max(1, val));
  localStorage.setItem(weightKey(entry.id), String(clamped));
}

function weightColor(w: number): string {
  if (w >= 9) return 'var(--color-danger, #ef4444)';
  if (w >= 6) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-success, #22c55e)';
}

// ─── View/edit modal ─────────────────────────────────────────

const showModal = ref(false);
const editingPrompt = ref<PromptEntry | null>(null);
const editContent = ref('');
const editScope = ref<string[]>(['all']);
const editInjectionMode = ref<'always' | 'match_any'>('always');
const editKeywordsText = ref('');
const editType = ref<PromptEntry['type']>('system_rule');

function openPrompt(entry: PromptEntry): void {
  editingPrompt.value = entry;
  editContent.value = entry.content;
  editScope.value = [...entry.scope];
  editInjectionMode.value = entry.injectionMode;
  editKeywordsText.value = entry.keywords.join(', ');
  editType.value = entry.type;
  showModal.value = true;
}

function savePrompt(): void {
  if (!editingPrompt.value) return;
  const id = editingPrompt.value.id;
  localStorage.setItem(storageKey(id), editContent.value);
  saveMeta(id, {
    scope: editScope.value,
    injectionMode: editInjectionMode.value,
    keywords: editKeywordsText.value.split(',').map((s) => s.trim()).filter(Boolean),
    type: editType.value,
  });
  promptRegistry?.setUserContent(id, editContent.value);
  showModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('prompt.toast.saved'), duration: 1500 });
}

function resetPrompt(): void {
  if (!editingPrompt.value) return;
  const id = editingPrompt.value.id;
  editContent.value = editingPrompt.value.defaultContent;
  localStorage.removeItem(storageKey(id));
  localStorage.removeItem(enabledKey(id));
  localStorage.removeItem(weightKey(id));
  localStorage.removeItem(metaKey(id));
  promptRegistry?.resetToDefault(id);
  promptRegistry?.setEnabled(id, true);
  editScope.value = ['all'];
  editInjectionMode.value = 'always';
  editKeywordsText.value = '';
  editType.value = 'system_rule';
  showModal.value = false;
  eventBus.emit('ui:toast', { type: 'info', message: t('prompt.toast.reset'), duration: 1500 });
}

function toggleScope(val: string): void {
  const idx = editScope.value.indexOf(val);
  if (idx >= 0) editScope.value.splice(idx, 1);
  else editScope.value.push(val);
}

// ─── Export single prompt ─────────────────────────────────────

function exportSingle(entry: PromptEntry, event: Event): void {
  event.stopPropagation();
  const data = { id: entry.id, content: entry.content, weight: entry.weight, enabled: entry.enabled, exportedAt: new Date().toISOString() };
  downloadJson(data, `prompt-${entry.id}-${Date.now()}.json`);
}

// ─── Export all modified prompts ──────────────────────────────

function exportAll(): void {
  const modified = promptEntries.value.filter((p) => p.modified || !p.enabled || p.weight !== 5);
  if (!modified.length) {
    eventBus.emit('ui:toast', { type: 'info', message: t('prompt.toast.noModified'), duration: 2000 });
    return;
  }
  const data = {
    packId: pack?.manifest.id ?? 'unknown',
    prompts: modified.map((p) => ({ id: p.id, content: p.content, weight: p.weight, enabled: p.enabled })),
    exportedAt: new Date().toISOString(),
  };
  downloadJson(data, `prompts-export-${Date.now()}.json`);
  eventBus.emit('ui:toast', { type: 'success', message: t('prompt.toast.exportCount', { count: modified.length }), duration: 2000 });
}

// ─── Import prompts ───────────────────────────────────────────

function importPrompts(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as { prompts?: Array<{ id: string; content?: string; weight?: number; enabled?: boolean }> };
      if (!Array.isArray(raw.prompts)) throw new Error(t('prompt.toast.importInvalidFormat'));
      let count = 0;
      for (const item of raw.prompts) {
        if (!item.id) continue;
        if (item.content !== undefined) {
          localStorage.setItem(storageKey(item.id), item.content);
          promptRegistry?.setUserContent(item.id, item.content);
        }
        if (item.weight !== undefined) localStorage.setItem(weightKey(item.id), String(item.weight));
        if (item.enabled !== undefined) {
          localStorage.setItem(enabledKey(item.id), String(item.enabled));
          promptRegistry?.setEnabled(item.id, item.enabled);
        }
        count++;
      }
      eventBus.emit('ui:toast', { type: 'success', message: t('prompt.toast.importCount', { count }), duration: 2000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('prompt.toast.importError');
      eventBus.emit('ui:toast', { type: 'error', message: msg, duration: 3000 });
    }
  };
  input.click();
}

// ─── Utilities ────────────────────────────────────────────────

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function previewContent(content: string, maxLen = 100): string {
  const stripped = content.replace(/\n/g, ' ').trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '…' : stripped;
}
</script>

<template>
  <div class="prompt-panel">
    <template v-if="pack">
      <header class="panel-header">
        <h2 class="panel-title">{{ $t('prompt.title') }}</h2>
        <div class="panel-tabs">
          <button :class="['tab-btn', { 'tab-btn--active': activeTab === 'prompts' }]" @click="activeTab = 'prompts'">{{ $t('prompt.tab.prompts') }}</button>
          <button :class="['tab-btn', { 'tab-btn--active': activeTab === 'settings' }]" @click="activeTab = 'settings'">{{ $t('prompt.tab.settings') }}</button>
          <button :class="['tab-btn', { 'tab-btn--active': activeTab === 'heroine' }]" @click="activeTab = 'heroine'">{{ $t('prompt.tab.heroine') }}</button>
          <button :class="['tab-btn', { 'tab-btn--active': activeTab === 'worldbook' }]" @click="activeTab = 'worldbook'">{{ $t('prompt.tab.worldbook') }}</button>
          <button :class="['tab-btn', { 'tab-btn--active': activeTab === 'contract' }]" data-testid="prompt-tab-contract" @click="activeTab = 'contract'">{{ $t('prompt.tab.contract') }}</button>
        </div>
      </header>

      <!-- ═══ Tab: 游戏设定 ═══ -->
      <div v-if="activeTab === 'settings'" class="settings-tab">
        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.perspectiveTitle') }}</h3>
          <p class="settings-desc">{{ $t('prompt.settings.perspectiveDesc') }}</p>
          <div class="style-radio-group">
            <label v-for="opt in perspectiveOptions" :key="opt.value" :class="['style-radio-item', { 'style-radio-item--active': promptSettings.perspective === opt.value }]">
              <input type="radio" name="perspective" :value="opt.value" :checked="promptSettings.perspective === opt.value" @change="updatePromptSetting('perspective', opt.value as PromptSettings['perspective'])" />
              <div class="style-radio-info">
                <span class="style-radio-label">{{ opt.label }}</span>
                <span class="style-radio-desc">{{ opt.desc }}</span>
              </div>
            </label>
          </div>
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.wordCountTitle') }}</h3>
          <p class="settings-desc">{{ $t('prompt.settings.wordCountDesc') }}</p>
          <input type="number" class="settings-input" min="200" max="3000" step="50"
            :value="promptSettings.wordCountRequirement"
            @change="updatePromptSetting('wordCountRequirement', Number(($event.target as HTMLInputElement).value))"
          />
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.storyStyleTitle') }}</h3>
          <p class="settings-desc">{{ $t('prompt.settings.storyStyleDesc') }}</p>
          <div class="style-radio-group">
            <label v-for="opt in storyStyleOptions" :key="opt.value" :class="['style-radio-item', { 'style-radio-item--active': promptSettings.storyStyle === opt.value }]">
              <input type="radio" name="storyStyle" :value="opt.value" :checked="promptSettings.storyStyle === opt.value" @change="updatePromptSetting('storyStyle', opt.value as PromptSettings['storyStyle'])" />
              <div class="style-radio-info">
                <span class="style-radio-label">{{ opt.label }}</span>
                <span class="style-radio-desc">{{ opt.desc }}</span>
              </div>
            </label>
          </div>
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.roleBoundaryTitle') }}</h3>
          <div class="settings-row">
            <AgaToggle
              :modelValue="promptSettings.enableNoControl"
              :label="$t('prompt.settings.enableNoControl')"
              show-label
              @update:modelValue="v => updatePromptSetting('enableNoControl', v)"
            />
          </div>
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.worldBookTitle') }}</h3>
          <div class="settings-row">
            <AgaToggle
              :modelValue="promptSettings.enableWorldBook !== false"
              :label="$t('prompt.settings.enableWorldBook')"
              show-label
              @update:modelValue="v => updatePromptSetting('enableWorldBook', v)"
            />
          </div>
          <p class="settings-desc">{{ $t('prompt.settings.enableWorldBookDesc') }}</p>

          <!-- Canon Capture: extraction switch. Nested under the world-book group
               because the master switch above gates it — turning world books off stops
               capture too, and the disabled state says so instead of failing silently. -->
          <div class="settings-row">
            <AgaToggle
              :modelValue="promptSettings.enableSettingCapture !== false"
              :disabled="promptSettings.enableWorldBook === false"
              :label="$t('prompt.settingCapture.enable')"
              show-label
              @update:modelValue="v => updatePromptSetting('enableSettingCapture', v)"
            />
          </div>
          <p class="settings-desc">{{ $t('prompt.settingCapture.enableDesc') }}</p>

          <!-- Budget share. Hand-written entries are always admitted first; this caps
               how much of what remains auto-captured settings may take. -->
          <div class="settings-row settings-row--slider">
            <label class="settings-slider-label" for="captured-budget-ratio">
              {{ $t('prompt.settingCapture.budgetTitle') }}
            </label>
            <input
              id="captured-budget-ratio"
              type="range"
              class="settings-slider"
              min="20" max="80" step="5"
              :disabled="promptSettings.enableWorldBook === false"
              :value="capturedBudgetPercent"
              @input="onCapturedBudgetInput"
            />
            <span class="settings-slider-value">
              {{ $t('prompt.settingCapture.budgetValue', { percent: capturedBudgetPercent }) }}
            </span>
          </div>
          <p class="settings-desc">{{ $t('prompt.settingCapture.budgetDesc') }}</p>
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.actionOptionsTitle') }}</h3>
          <div class="settings-row">
            <AgaToggle
              :modelValue="promptSettings.enableActionOptions"
              :label="$t('prompt.settings.enableActionOptions')"
              show-label
              @update:modelValue="v => updatePromptSetting('enableActionOptions', v)"
            />
          </div>
          <div v-if="promptSettings.enableActionOptions" class="settings-row">
            <AgaSelect
              class="settings-select-control"
              :modelValue="promptSettings.actionOptionsMode"
              :options="actionModeOptions"
              @update:modelValue="v => updatePromptSetting('actionOptionsMode', v as 'action' | 'story')"
            />
            <AgaSelect
              class="settings-select-control"
              :modelValue="promptSettings.actionPace"
              :options="actionPaceOptions"
              @update:modelValue="v => updatePromptSetting('actionPace', v as 'fast' | 'slow')"
            />
          </div>
        </div>

        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.settings.customPromptTitle') }}</h3>
          <p class="settings-desc">{{ $t('prompt.settings.customPromptDesc') }}</p>
          <textarea class="settings-textarea" rows="4"
            :value="promptSettings.customSystemPrompt"
            @input="updatePromptSetting('customSystemPrompt', ($event.target as HTMLTextAreaElement).value)"
            :placeholder="$t('prompt.settings.customPromptPlaceholder')"
          />
        </div>
      </div>

      <!-- ═══ Tab: 剧情规划 ═══ -->
      <div v-if="activeTab === 'heroine'" class="heroine-tab">
        <p class="settings-desc">{{ $t('prompt.heroine.desc') }}</p>

        <!-- Heroine Entries -->
        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.heroine.entriesTitle', { count: heroinePlan.heroineEntries.length }) }}</h3>

          <div v-for="entry in heroinePlan.heroineEntries" :key="entry.name" class="heroine-card">
            <div class="heroine-card-header">
              <span class="heroine-card-name">{{ entry.name }}</span>
              <span class="heroine-card-type">{{ entry.type }}</span>
              <span class="heroine-card-stage">{{ entry.currentStage }}</span>
              <AgaButton variant="danger" size="sm" class="heroine-delete-btn" @click="removeHeroineEntry(entry.name)">{{ $t('prompt.heroine.delete') }}</AgaButton>
            </div>
            <div class="heroine-card-meta">
              {{ $t('prompt.heroine.relation') }}: {{ entry.currentRelationStatus }}
            </div>
          </div>

          <div v-if="heroinePlan.heroineEntries.length === 0" class="heroine-empty">{{ $t('prompt.heroine.noEntries') }}</div>

          <div class="heroine-add-form">
            <input v-model="heroineEditName" class="settings-input" :placeholder="$t('prompt.heroine.namePlaceholder')" style="flex:1" />
            <AgaSelect v-model="heroineEditType" class="heroine-type-select" :options="heroineTypeOptions" />
            <input v-model="heroineEditRelation" class="settings-input" :placeholder="$t('prompt.heroine.relationPlaceholder')" style="width:100px" />
            <input v-model="heroineEditStage" class="settings-input" :placeholder="$t('prompt.heroine.stagePlaceholder')" style="width:100px" />
            <AgaButton variant="primary" size="sm" @click="addHeroineEntry">{{ $t('prompt.heroine.add') }}</AgaButton>
          </div>
        </div>

        <!-- Interaction Events -->
        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.heroine.eventsTitle', { count: heroinePlan.interactionEvents.length }) }}</h3>

          <div v-for="(evt, idx) in heroinePlan.interactionEvents" :key="idx" class="heroine-card">
            <div class="heroine-card-header">
              <span class="heroine-card-name">[{{ evt.heroineName }}] {{ evt.eventName }}</span>
              <span :class="['heroine-status', `heroine-status--${evt.status === '待触发' ? 'pending' : evt.status === '已完成' ? 'done' : 'active'}`]">{{ evt.status }}</span>
              <AgaButton variant="danger" size="sm" class="heroine-delete-btn" @click="removeHeroineEvent(idx)">{{ $t('prompt.heroine.delete') }}</AgaButton>
            </div>
            <div v-if="evt.eventDescription" class="heroine-card-meta">{{ evt.eventDescription }}</div>
          </div>

          <div v-if="heroinePlan.interactionEvents.length === 0" class="heroine-empty">{{ $t('prompt.heroine.noEvents') }}</div>

          <div class="heroine-add-form">
            <AgaSelect
              v-model="heroineEventTarget"
              class="heroine-type-select"
              :options="heroineEventTargetOptions"
              :placeholder="$t('prompt.heroine.selectCharacter')"
            />
            <input v-model="heroineEventName" class="settings-input" :placeholder="$t('prompt.heroine.eventNamePlaceholder')" style="flex:1" />
            <input v-model="heroineEventDesc" class="settings-input" :placeholder="$t('prompt.heroine.eventDescPlaceholder')" style="flex:2" />
            <AgaButton variant="primary" size="sm" @click="addHeroineEvent">{{ $t('prompt.heroine.add') }}</AgaButton>
          </div>
        </div>

        <!-- Stage Progression (read-only summary for now) -->
        <div class="settings-group">
          <h3 class="settings-group-title">{{ $t('prompt.heroine.stageTitle', { count: heroinePlan.stageProgression.length }) }}</h3>
          <div v-for="(stage, idx) in heroinePlan.stageProgression" :key="idx" class="heroine-card">
            <div class="heroine-card-header">
              <span class="heroine-card-name">{{ stage.stageName }}</span>
            </div>
            <div class="heroine-card-meta">{{ $t('prompt.heroine.stageGoals') }}: {{ stage.stageGoals.join('、') || $t('prompt.heroine.stageGoalsNone') }}</div>
          </div>
          <div v-if="heroinePlan.stageProgression.length === 0" class="heroine-empty">{{ $t('prompt.heroine.noStages') }}</div>
        </div>
      </div>

      <!-- ═══ Tab: 世界书 ═══ -->
      <WorldBookTab v-if="activeTab === 'worldbook'" />

      <!-- ═══ Tab: 叙事契约 (R2) ═══ -->
      <NarrativeContractTab v-if="activeTab === 'contract'" />

      <!-- ═══ Tab: 内置提示词 ═══ -->
      <template v-if="activeTab === 'prompts'">
      <div class="prompts-header-actions">
        <div class="header-actions">
          <AgaButton variant="ghost" size="sm" @click="expandAll">{{ $t('prompt.actions.expand') }}</AgaButton>
          <AgaButton variant="ghost" size="sm" @click="collapseAll">{{ $t('prompt.actions.collapse') }}</AgaButton>
          <AgaButton variant="ghost" size="sm" @click="importPrompts">{{ $t('prompt.actions.import') }}</AgaButton>
          <AgaButton variant="primary" size="sm" @click="exportAll">{{ $t('prompt.actions.export') }}</AgaButton>
        </div>
      </div>

      <!-- ─── Toolbar ─── -->
      <div class="toolbar">
        <input
          v-model="searchQuery"
          type="text"
          class="search-field"
          :placeholder="$t('prompt.search.placeholder')"
          :aria-label="$t('prompt.search.ariaLabel')"
        />
        <AgaSelect
          :modelValue="filterMode"
          class="filter-select-control"
          :options="filterModeOptions"
          :placeholder="$t('prompt.filter.ariaLabel')"
          :ariaLabel="$t('prompt.filter.ariaLabel')"
          @update:modelValue="v => filterMode = v as 'all' | 'enabled' | 'disabled' | 'modified'"
        />
      </div>

      <!-- ─── Category groups ─── -->
      <div v-if="filteredPrompts.length" class="groups-list">
        <div
          v-for="group in categoryGroups"
          :key="group.name"
          class="category-group"
        >
          <!-- Category header -->
          <button
            class="category-header"
            @click="toggleCategory(group.name)"
            :aria-expanded="!group.collapsed"
          >
            <svg
              :class="['chevron', { 'chevron--collapsed': group.collapsed }]"
              viewBox="0 0 20 20"
              fill="currentColor"
              width="14"
              height="14"
            >
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
            <span class="category-name">{{ categoryDisplayName(group.name) }}</span>
            <span class="category-count">{{ group.entries.length }}</span>
          </button>

          <!-- Entries -->
          <Transition name="group-expand">
            <div v-if="!group.collapsed" class="prompt-list">
              <div
                v-for="entry in group.entries"
                :key="entry.id"
                :class="['prompt-card', { 'prompt-card--disabled': !entry.enabled }]"
              >
                <div class="prompt-header">
                  <div class="prompt-title-area" @click="openPrompt(entry)">
                    <Tooltip :text="entry.id">
                      <span class="prompt-id">{{ getDisplayName(entry.id) }}</span>
                    </Tooltip>
                    <span v-if="entry.modified" class="modified-badge">{{ $t('prompt.entry.modifiedBadge') }}</span>
                  </div>
                  <div class="prompt-controls">
                    <!-- Weight input -->
                    <Tooltip :text="$t('prompt.entry.weightTitle')" interactive>
                      <div class="weight-control">
                        <span class="weight-label" :style="{ color: weightColor(entry.weight) }">W</span>
                        <input
                          type="number"
                          min="1"
                          max="10"
                          :value="entry.weight"
                          class="weight-input"
                          :style="{ color: weightColor(entry.weight) }"
                          @change="setWeight(entry, Number(($event.target as HTMLInputElement).value))"
                          @click.stop
                          :aria-label="$t('prompt.entry.weightAriaLabel')"
                        />
                      </div>
                    </Tooltip>
                    <!-- Export single -->
                    <Tooltip :text="$t('prompt.entry.exportTitle')" interactive>
                      <button class="icon-btn" :aria-label="$t('prompt.entry.exportTitle')" @click="exportSingle(entry, $event)">
                        <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
                          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
                        </svg>
                      </button>
                    </Tooltip>
                    <!-- Enable toggle -->
                    <Tooltip :text="entry.enabled ? $t('prompt.entry.enableTitle') : $t('prompt.entry.disableTitle')" interactive>
                      <AgaToggle
                        :modelValue="entry.enabled"
                        :label="entry.enabled ? $t('prompt.entry.enableTitle') : $t('prompt.entry.disableTitle')"
                        @update:modelValue="() => toggleEnabled(entry)"
                        @click.stop
                      />
                    </Tooltip>
                  </div>
                </div>
                <p class="prompt-preview" @click="openPrompt(entry)">
                  {{ previewContent(entry.content) }}
                </p>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <div v-else class="empty-state">
        <p>{{ $t('prompt.empty.noMatch') }}</p>
      </div>
      </template><!-- end activeTab === 'prompts' -->
    </template><!-- end v-if="pack" -->

    <div v-else class="empty-state">
      <p>{{ $t('prompt.empty.noPack') }}</p>
    </div>

    <!-- ─── Edit Modal ─── -->
    <Modal v-model="showModal" :title="editingPrompt ? $t('prompt.modal.editPrefix', { name: getDisplayName(editingPrompt.id) }) : ''" width="720px">
      <!-- 高级字段区域 -->
      <div class="meta-fields">
        <div class="meta-row">
          <label class="meta-label">{{ $t('prompt.modal.type') }}</label>
          <AgaSelect
            :modelValue="editType"
            class="meta-select-control"
            :options="typeOptions"
            @update:modelValue="v => editType = v as PromptEntry['type']"
          />

          <label class="meta-label">{{ $t('prompt.modal.injectionMode') }}</label>
          <AgaSelect
            :modelValue="editInjectionMode"
            class="meta-select-control"
            :options="injectionModeOptions"
            @update:modelValue="v => editInjectionMode = v as 'always' | 'match_any'"
          />
        </div>

        <div class="meta-row">
          <label class="meta-label">{{ $t('prompt.modal.scope') }}</label>
          <div class="scope-checks">
            <label v-for="opt in scopeOptions" :key="opt.value" class="scope-check">
              <input type="checkbox" :checked="editScope.includes(opt.value)" @change="toggleScope(opt.value)" />
              {{ opt.label }}
            </label>
          </div>
        </div>

        <div v-if="editInjectionMode === 'match_any'" class="meta-row">
          <label class="meta-label">{{ $t('prompt.modal.keywords') }}</label>
          <input v-model="editKeywordsText" class="meta-input" :placeholder="$t('prompt.modal.keywordsPlaceholder')" />
        </div>
      </div>

      <!-- 内容编辑 -->
      <div class="edit-area">
        <textarea
          v-model="editContent"
          class="prompt-editor"
          rows="18"
          spellcheck="false"
          :aria-label="$t('prompt.modal.editorAriaLabel')"
        />
      </div>
      <template #footer>
        <AgaButton
          v-if="editingPrompt?.modified"
          variant="warning"
          @click="resetPrompt"
        >
          {{ $t('prompt.modal.resetDefault') }}
        </AgaButton>
        <div style="flex: 1" />
        <AgaButton variant="secondary" @click="showModal = false">{{ $t('prompt.modal.cancel') }}</AgaButton>
        <AgaButton variant="primary" @click="savePrompt">{{ $t('prompt.modal.save') }}</AgaButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.prompt-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet);
  height: 100%;
  overflow-y: auto;
}

/* ── Tabs ── */
.panel-tabs { display: flex; gap: 4px; margin-left: auto; }
.tab-btn {
  padding: 4px 12px; border: 1px solid var(--color-border);
  border-radius: 6px; background: transparent; color: var(--color-text-secondary);
  font-size: 13px; cursor: pointer; transition: all 0.15s;
}
.tab-btn:hover { background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); }
.tab-btn--active { background: color-mix(in oklch, var(--color-sage-400) 22%, transparent); color: var(--color-sage-100); border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent); box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 15%, transparent); }

.prompts-header-actions { display: flex; justify-content: flex-end; }

/* ── Settings Tab ── */
.settings-tab { display: flex; flex-direction: column; gap: 16px; padding-top: 8px; }
.settings-group {
  padding: 12px 16px; background: var(--color-surface);
  border: 1px solid var(--color-border); border-radius: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.settings-group-title { font-size: 14px; font-weight: 600; color: var(--color-text); margin: 0; }
.settings-desc { font-size: 12px; color: var(--color-text-muted); margin: 0; }
.settings-input {
  padding: 5px 10px; background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: 6px;
  color: var(--color-text); font-size: 13px; max-width: 300px;
}
.settings-input:focus { outline: none; border-color: var(--color-sage-400); }
.settings-textarea {
  padding: 8px 10px; background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: 6px;
  color: var(--color-text); font-size: 13px; resize: vertical;
  font-family: inherit;
}
.settings-textarea:focus { outline: none; border-color: var(--color-sage-400); }
.settings-row { display: flex; gap: 8px; align-items: center; }
.settings-label { font-size: 13px; color: var(--color-text-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer; }

/* AgaSelect sizing on chrome surfaces */
.settings-select-control { max-width: 300px; min-width: 160px; }
.heroine-type-select { width: 130px; }
.filter-select-control { min-width: 140px; }
.meta-select-control { min-width: 140px; }

/* Style radio group */
.style-radio-group { display: flex; flex-direction: column; gap: 4px; }
.style-radio-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px;
  border: 1px solid var(--color-border); border-radius: 6px;
  cursor: pointer; transition: all 0.15s;
}
.style-radio-item:hover { border-color: var(--color-sage-400); }
.style-radio-item--active { border-color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 6%, transparent); }
.style-radio-item input[type="radio"] { margin-top: 3px; accent-color: var(--color-sage-400); }
.style-radio-info { display: flex; flex-direction: column; }
.style-radio-label { font-size: 13px; font-weight: 500; color: var(--color-text); }
.style-radio-desc { font-size: 11px; color: var(--color-text-muted); }

/* Heroine plan tab */
.heroine-tab { display: flex; flex-direction: column; gap: 16px; padding-top: 8px; }
.heroine-card {
  padding: 8px 12px; background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: 6px;
  margin-bottom: 4px;
}
.heroine-card-header { display: flex; align-items: center; gap: 8px; }
.heroine-card-name { font-size: 13px; font-weight: 600; color: var(--color-text); }
.heroine-card-type { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklch, var(--color-sage-400) 14%, transparent); color: var(--color-sage-300); }
.heroine-card-stage { font-size: 11px; color: var(--color-text-muted); }
.heroine-card-meta { font-size: 12px; color: var(--color-text-secondary); margin-top: 4px; }
.heroine-delete-btn { margin-left: auto; }
.heroine-status { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
.heroine-status--pending { background: color-mix(in oklch, var(--color-amber-400) 10%, transparent); color: var(--color-amber-400); }
.heroine-status--active { background: color-mix(in oklch, var(--color-sage-300) 10%, transparent); color: var(--color-sage-300); }
.heroine-status--done { background: color-mix(in oklch, var(--color-success) 10%, transparent); color: var(--color-success); }
.heroine-empty { font-size: 12px; color: var(--color-text-muted, #55556a); padding: 8px; text-align: center; }
.heroine-add-form { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; }

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
  display: flex;
  align-items: center;
  gap: 8px;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: color-mix(in oklch, var(--color-sage-400) 50%, transparent);
  border-radius: 10px;
}

.header-actions {
  display: flex;
  gap: 6px;
}

/* ── Toolbar ── */
.toolbar {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.search-field {
  flex: 1;
  height: 36px;
  padding: 0 12px;
  font-size: 0.85rem;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  outline: none;
}
.search-field:focus { border-color: var(--color-sage-400); }

/* ── Category groups ── */
.groups-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.category-group {
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 10px;
  overflow: hidden;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  background: rgba(255,255,255,0.02);
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}
.category-header:hover { background: rgba(255,255,255,0.04); }

.chevron {
  color: var(--color-text-secondary, #8888a0);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
.chevron--collapsed { transform: rotate(-90deg); }

.category-name {
  flex: 1;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.category-count {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255,255,255,0.06);
  padding: 1px 7px;
  border-radius: 8px;
}

/* ── Prompt list ── */
.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-top: 1px solid var(--color-border, #2a2a3a);
}

.prompt-card {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.01);
  transition: background 0.15s ease;
}
.prompt-card:hover { background: linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02) 60%); }
.prompt-card--disabled { opacity: 0.45; }

.prompt-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.prompt-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}

.prompt-id {
  font-size: 0.84rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.modified-badge {
  font-size: 0.62rem;
  font-weight: 600;
  padding: 1px 6px;
  color: var(--color-warning, #f59e0b);
  background: color-mix(in oklch, var(--color-amber-400) 10%, transparent);
  border-radius: 8px;
  flex-shrink: 0;
  text-shadow: 0 0 4px color-mix(in oklch, var(--color-amber-400) 30%, transparent);
}

/* ── Prompt controls ── */
.prompt-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.weight-control {
  display: flex;
  align-items: center;
  gap: 2px;
}

.weight-label {
  font-size: 0.7rem;
  font-weight: 700;
  width: 14px;
}

.weight-input {
  width: 34px;
  height: 24px;
  padding: 0 4px;
  font-size: 0.78rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 4px;
  outline: none;
  text-align: center;
  -moz-appearance: textfield;
}
.weight-input::-webkit-inner-spin-button,
.weight-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.weight-input:focus { border-color: var(--color-sage-400); text-shadow: 0 0 4px currentColor; }

.icon-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.icon-btn:hover { color: var(--color-text, #e0e0e6); background: rgba(255,255,255,0.06); }

.prompt-preview {
  margin: 5px 0 0;
  font-size: 0.76rem;
  color: var(--color-text-secondary, #8888a0);
  line-height: 1.5;
  cursor: pointer;
}

/* ── Meta fields (advanced world book fields) ── */
.meta-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  border-radius: 8px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.meta-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
  flex-shrink: 0;
}
.meta-input {
  flex: 1;
  padding: 4px 8px;
  font-size: 0.75rem;
  background: rgba(255,255,255,0.06);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  min-width: 200px;
}
.scope-checks {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.scope-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.scope-check input { accent-color: var(--color-sage-400); }

/* ── Edit area ── */
.edit-area {
  display: flex;
  flex-direction: column;
}

.prompt-editor {
  width: 100%;
  min-height: 400px;
  padding: 12px;
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
  outline: none;
  resize: vertical;
  line-height: 1.6;
  box-sizing: border-box;
}
.prompt-editor:focus { border-color: var(--color-sage-400); }

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

/* ── Transitions ── */
.group-expand-enter-active { transition: all 0.2s ease; }
.group-expand-leave-active { transition: all 0.15s ease; }
.group-expand-enter-from, .group-expand-leave-to { opacity: 0; max-height: 0; overflow: hidden; }
.group-expand-enter-to, .group-expand-leave-from { opacity: 1; max-height: 2000px; }

/* ── Scrollbar ── */
.prompt-panel::-webkit-scrollbar { width: 5px; }
.prompt-panel::-webkit-scrollbar-track { background: transparent; }
.prompt-panel::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

@media (max-width: 767px) {
  .prompt-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
}

/* ── Canon Capture: budget share slider ── */
.settings-row--slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.settings-slider-label {
  flex-shrink: 0;
  font-size: 0.85rem;
  color: var(--color-text);
}

.settings-slider {
  flex: 1;
  min-width: 120px;
  max-width: 260px;
}

.settings-slider-value {
  flex-shrink: 0;
  min-width: 3.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}
</style>
