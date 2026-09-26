<script setup lang="ts">
// App doc: docs/user-guide/pages/game-relationships.md
/**
 * RelationshipPanel — NPC 关系列表，路径见 `DEFAULT_ENGINE_PATHS.relationships`。
 *
 * Phase 6.2：
 * - 关注 toggle（眼睛图标）：标记为关注的 NPC 在列表置顶
 * - 心跳锁定 toggle（锁图标）：锁定后世界心跳不更新此 NPC 的状态
 * - 底部类型统计汇总
 *
 * §7.2（2026-04-11）：
 * - 每张 NPC 卡片底部新增 "💬 私聊" 快捷按钮 → 打开 NpcChatModal 异步对话
 * - 扩展 NPC edit Modal 字段：性别 / 年龄 / 背景 / 内心想法 / 在做事项 / 性格特征（tag） / 记忆（list）
 *   对齐 demo design note §70 "人物关系中的所有页面都在每项数据上增加一编辑按键"
 */
import { ref, computed, onActivated, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { useMobile } from '@/ui/composables/useMobile';
import Modal from '@/ui/components/common/Modal.vue';
import NpcChatModal from '@/ui/components/shared/NpcChatModal.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { formatMemoryEntry } from '@/engine/social/npc-memory-format';
import NpcMemoryTimeline from '@/ui/components/shared/NpcMemoryTimeline.vue';
import type { MemorySummary } from '@/ui/components/shared/NpcMemoryTimeline.vue';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import ImageViewer from '@/ui/components/image/ImageViewer.vue';
import { useRouter, useRoute } from 'vue-router';
import { useNpcEditor } from '@/ui/composables/editors';

const { t } = useI18n();
const { isLoaded, useValue, get } = useGameState();
const npcEditor = useNpcEditor();

/** 身体部位条目 */
interface BodyPartEntry {
  部位名称?: string;
  敏感度?: number;
  开发度?: number;
  特征描述?: string;
  特殊印记?: string;
  已选背景图片ID?: string;
}

/** NPC 私密信息子对象 */
interface PrivacyProfile {
  '是否为处女/处男'?: boolean;
  身体部位?: BodyPartEntry[];
  性格倾向?: string;
  性取向?: string;
  性癖好?: string[];
  性渴望程度?: number;
  当前性状态?: string;
  体液分泌状态?: string;
  性交总次数?: number;
  性伴侣名单?: string[];
  最近一次性行为时间?: string;
  特殊体质?: string[];
  /** 初夜夺取者（非处女/处男时必填）— 人名或 '未知'/情境描述 */
  初夜夺取者?: string;
  /** 初夜时间（非处女/处男时必填）— 游戏内时间戳或自然描述 */
  初夜时间?: string;
  /** 初夜描述（非处女/处男时必填）— 50-200 字情境描写 */
  初夜描述?: string;
  [key: string]: unknown;
}

/** 私聊历史条目（与 NpcChatMessage 对齐） */
interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** NPC relationship entry shape */
interface NpcRelation {
  名称: string;
  类型?: string;
  好感度?: number;
  位置?: string;
  描述?: string;
  外貌描述?: string;
  身材描写?: string;
  衣着风格?: string;
  性别?: string;
  年龄?: number;
  背景?: string;
  内心想法?: string;
  在做事项?: string;
  性格特征?: string[];
  记忆?: string[];
  私密信息?: PrivacyProfile;
  私聊历史?: ChatHistoryEntry[];
  图片档案?: Record<string, string | undefined>;
  总结记忆?: MemorySummary[];
  关注?: boolean;
  心跳锁定?: boolean;
  [key: string]: unknown;
}

/** NSFW 是否开启（读状态树） */
const nsfwEnabled = computed(() => get<boolean>('系统.nsfwMode') === true);

const relationships = useValue<NpcRelation[]>(DEFAULT_ENGINE_PATHS.relationships);

// ─── Search & sort ───

const searchQuery = ref('');

type SortMode = 'name' | 'affinity' | 'gender' | 'importance' | 'recent' | 'location' | 'presence';
const SORT_KEY = 'aga_rel_sort';
const SORT_DIR_KEY = 'aga_rel_sort_dir';

const sortOptions = computed<Array<{ label: string; value: SortMode }>>(() => [
  { label: t('relationship.sort.name'), value: 'name' },
  { label: t('relationship.sort.affinity'), value: 'affinity' },
  { label: t('relationship.sort.gender'), value: 'gender' },
  { label: t('relationship.sort.importance'), value: 'importance' },
  { label: t('relationship.sort.recent'), value: 'recent' },
  { label: t('relationship.sort.location'), value: 'location' },
  { label: t('relationship.sort.presence'), value: 'presence' },
]);

const sortMode = ref<SortMode>(
  (localStorage.getItem(SORT_KEY) as SortMode) || 'name',
);
const sortAsc = ref<boolean>(
  localStorage.getItem(SORT_DIR_KEY) !== 'desc',
);

function setSortMode(mode: SortMode): void {
  if (sortMode.value === mode) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortMode.value = mode;
    sortAsc.value = true;
  }
  localStorage.setItem(SORT_KEY, mode);
  localStorage.setItem(SORT_DIR_KEY, sortAsc.value ? 'asc' : 'desc');
}

function compareBySortMode(a: NpcRelation, b: NpcRelation): number {
  switch (sortMode.value) {
    case 'affinity':
      return (b.好感度 ?? 0) - (a.好感度 ?? 0);
    case 'gender': {
      const ga = a.性别 ?? '';
      const gb = b.性别 ?? '';
      if (ga !== gb) return ga.localeCompare(gb);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'importance': {
      const am = a['是否主要角色'] ? 1 : 0;
      const bm = b['是否主要角色'] ? 1 : 0;
      if (am !== bm) return bm - am;
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'recent': {
      const ta = a['最后互动时间'] as string | undefined;
      const tb = b['最后互动时间'] as string | undefined;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      if (ta && tb) return tb.localeCompare(ta);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'location': {
      const la = (a.位置 ?? '') as string;
      const lb = (b.位置 ?? '') as string;
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      if (la !== lb) return la.localeCompare(lb);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'presence': {
      const pa = a['是否在场'] ? 1 : 0;
      const pb = b['是否在场'] ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    default:
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
  }
}

const filteredRelations = computed<NpcRelation[]>(() => {
  const list = Array.isArray(relationships.value) ? [...relationships.value] : [];
  const dir = sortAsc.value ? 1 : -1;
  list.sort((a, b) => {
    if (a.关注 && !b.关注) return -1;
    if (!a.关注 && b.关注) return 1;
    return compareBySortMode(a, b) * dir;
  });
  if (!searchQuery.value.trim()) return list;
  const q = searchQuery.value.trim().toLowerCase();
  return list.filter(
    (npc) =>
      npc.名称.toLowerCase().includes(q) ||
      (npc.类型 ?? '').toLowerCase().includes(q) ||
      (npc.位置 ?? '').toLowerCase().includes(q),
  );
});

// ─── Phase 6.2: Attention + Heartbeat lock toggles ───────────

function findNpcIndex(npc: NpcRelation): number {
  const list = Array.isArray(relationships.value) ? relationships.value : [];
  return list.findIndex((r) => r.名称 === npc.名称);
}

function toggleAttention(npc: NpcRelation, event: Event): void {
  event.stopPropagation();
  const idx = findNpcIndex(npc);
  if (idx < 0) return;
  npcEditor.toggleFlag(idx, '关注');
}

function toggleHeartbeatLock(npc: NpcRelation, event: Event): void {
  event.stopPropagation();
  const idx = findNpcIndex(npc);
  if (idx < 0) return;
  const wasLocked = npc.心跳锁定 === true;
  npcEditor.toggleFlag(idx, '心跳锁定');
  const locked = !wasLocked;
  eventBus.emit('ui:toast', {
    type: locked ? 'info' : 'success',
    message: locked ? t('relationship.toast.heartbeatLockOn', { name: npc.名称 }) : t('relationship.toast.heartbeatLockOff', { name: npc.名称 }),
    duration: 1200,
  });
}

// ─── Sprint Social-3: Presence toggles ───────────────────────

const router = useRouter();
const route = useRoute();
const { isMobile } = useMobile();
const npcFields = DEFAULT_ENGINE_PATHS.npcFieldNames;

function openImageWorkbench(npcName: string, event: Event): void {
  event.stopPropagation();
  router.push({ path: '/game/image', query: { npc: npcName } });
}

function openAiEdit(npc: NpcRelation): void {
  router.push({ path: '/game/assistant', query: { editNpc: npc.名称 } });
}

function togglePresence(npc: NpcRelation, event: Event): void {
  event.stopPropagation();
  const idx = findNpcIndex(npc);
  if (idx < 0) return;
  npcEditor.toggleFlag(idx, '是否在场');
}

function toggleMajorRole(npc: NpcRelation, event: Event): void {
  event.stopPropagation();
  const idx = findNpcIndex(npc);
  if (idx < 0) return;
  npcEditor.toggleFlag(idx, '是否主要角色');
}


// ─── Phase 6.2: Type summary stats ───────────────────────────

const typeSummary = computed<Array<[string, number]>>(() => {
  const list = Array.isArray(relationships.value) ? relationships.value : [];
  const counts: Record<string, number> = {};
  for (const r of list) {
    const tp = r.类型 ?? t('relationship.typeSummary.uncategorized');
    counts[tp] = (counts[tp] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});

// ─── NPC detail / edit ───

const selectedNpc = ref<NpcRelation | null>(null);
const detailNpcIdx = ref<number>(-1);
const showEditModal = ref(false);
type DetailTab = 'basic' | 'status' | 'memory' | 'nsfw';
const detailTab = ref<DetailTab>('basic');

// Secret archive image/text toggle per body part (§4.2)
const bodyPartViewMode = ref<Record<string, 'text' | 'image'>>({});

// Portrait full-screen viewer
const portraitViewerOpen = ref(false);
const portraitViewerSrc = ref('');

async function openPortraitViewer(assetId: string) {
  if (!assetId) return;
  try {
    const { ImageAssetCache } = await import('@/engine/image/asset-cache');
    const cache = new ImageAssetCache();
    const result = await cache.retrieve(assetId);
    if (result) {
      portraitViewerSrc.value = URL.createObjectURL(result.blob);
      portraitViewerOpen.value = true;
    }
  } catch { /* silent */ }
}

function closePortraitViewer() {
  portraitViewerOpen.value = false;
  if (portraitViewerSrc.value) {
    URL.revokeObjectURL(portraitViewerSrc.value);
    portraitViewerSrc.value = '';
  }
}

function toggleDetail(npc: NpcRelation, index: number): void {
  if (isMobile.value && selectedNpc.value?.名称 === npc.名称) {
    selectedNpc.value = null;
    return;
  }
  detailNpcIdx.value = index;
  selectedNpc.value = npc;
  detailTab.value = 'basic';
}

function selectNpcByName(name: string): void {
  const list = filteredRelations.value;
  const idx = list.findIndex((r) => r.名称 === name);
  if (idx >= 0) toggleDetail(list[idx], idx);
}

onActivated(() => {
  const npcQuery = route.query.npc as string | undefined;
  if (npcQuery) {
    selectNpcByName(npcQuery);
    router.replace({ query: {} });
  }
});

watch(() => route.query.npc, (name) => {
  if (name && typeof name === 'string') {
    selectNpcByName(name);
    router.replace({ query: {} });
  }
});

// §7.2: NPC 私聊 modal 状态 — 独立于 edit modal，可以同时触发但通常用户只会看一个
const showChatModal = ref(false);
const chatNpc = ref<NpcRelation | null>(null);

interface RelationNetworkEntry {
  对象: string;
  关系: string;
  备注: string;
}

interface MemorySummaryEntry {
  摘要: string;
  涵盖范围: string;
  生成时间: string;
}

interface NpcEditForm {
  名称: string;
  类型: string;
  好感度: number;
  位置: string;
  描述: string;
  外貌描述: string;
  身材描写: string;
  衣着风格: string;
  性别: string;
  年龄: number;
  背景: string;
  内心想法: string;
  在做事项: string;
  性格特征: string[];
  记忆: string[];
  关注: boolean;
  心跳锁定: boolean;
  私密信息: PrivacyProfile;
  核心性格特征: string;
  关系状态: string;
  好感度突破条件: string;
  关系突破条件: string;
  关系网变量: RelationNetworkEntry[];
  总结记忆: MemorySummaryEntry[];
}

function clonePrivacy(p?: PrivacyProfile): PrivacyProfile {
  if (!p) return {};
  return JSON.parse(JSON.stringify(p)) as PrivacyProfile;
}

/** The 4 mandatory body-part names (matches PrivacyProfileValidator contract). */
const REQUIRED_BODY_PARTS = ['嘴', '胸部', '小穴', '屁穴'] as const;

/** Seed the 4 mandatory parts on the current editForm (idempotent).
 *  Called from openEdit / openAddNew so the template can bind via index
 *  without mutating state during render. */
function seedRequiredBodyParts(): void {
  if (!Array.isArray(editForm.value.私密信息.身体部位)) {
    editForm.value.私密信息.身体部位 = [];
  }
  const list = editForm.value.私密信息.身体部位!;
  for (const name of REQUIRED_BODY_PARTS) {
    if (!list.some((p) => p.部位名称 === name)) {
      list.push({ 部位名称: name, 敏感度: 0, 开发度: 0, 特征描述: '', 特殊印记: '' });
    }
  }
}

/** Index of an existing required part (for v-model path stability); -1 if absent. */
function indexOfBodyPart(name: string): number {
  const list = editForm.value.私密信息.身体部位;
  if (!Array.isArray(list)) return -1;
  return list.findIndex((p) => p.部位名称 === name);
}

/** Extras: entries whose 部位名称 is NOT one of the fixed 4. */
function extraBodyPartIndices(): number[] {
  const list = editForm.value.私密信息.身体部位;
  if (!Array.isArray(list)) return [];
  const required = new Set<string>(REQUIRED_BODY_PARTS);
  const out: number[] = [];
  list.forEach((p, i) => {
    if (!required.has(String(p.部位名称 ?? ''))) out.push(i);
  });
  return out;
}

function addExtraBodyPart(): void {
  if (!Array.isArray(editForm.value.私密信息.身体部位)) {
    editForm.value.私密信息.身体部位 = [];
  }
  editForm.value.私密信息.身体部位!.push({
    部位名称: '',
    敏感度: 0,
    开发度: 0,
    特征描述: '',
    特殊印记: '',
  });
}

function removeBodyPart(index: number): void {
  const list = editForm.value.私密信息.身体部位;
  if (!Array.isArray(list)) return;
  list.splice(index, 1);
}

/** True when NPC is explicitly non-virgin → 初夜 fields become required. */
function isNonVirgin(): boolean {
  return editForm.value.私密信息['是否为处女/处男'] === false;
}

const editForm = ref<NpcEditForm>({
  名称: '',
  类型: '',
  好感度: 50,
  位置: '',
  描述: '',
  外貌描述: '',
  身材描写: '',
  衣着风格: '',
  性别: '',
  年龄: 20,
  背景: '',
  内心想法: '',
  在做事项: '',
  性格特征: [],
  记忆: [],
  关注: false,
  心跳锁定: false,
  私密信息: {},
  核心性格特征: '',
  关系状态: '',
  好感度突破条件: '',
  关系突破条件: '',
  关系网变量: [],
  总结记忆: [],
});
const editIndex = ref<number>(-1);

/** 新增性格特征输入缓冲 — UI 独立字段，不存入 form */
const newTraitInput = ref('');
/** 新增记忆输入缓冲 */
const newMemoryInput = ref('');

function openEdit(npc: NpcRelation, _filteredIdx: number): void {
  selectedNpc.value = npc;
  const rawList = Array.isArray(relationships.value) ? relationships.value : [];
  editIndex.value = rawList.findIndex((r) => r.名称 === npc.名称);
  editForm.value = {
    名称: npc.名称 ?? '',
    类型: npc.类型 ?? '',
    好感度: typeof npc.好感度 === 'number' ? npc.好感度 : 50,
    位置: npc.位置 ?? '',
    描述: npc.描述 ?? '',
    外貌描述: npc.外貌描述 ?? '',
    身材描写: npc.身材描写 ?? '',
    衣着风格: npc.衣着风格 ?? '',
    性别: npc.性别 ?? '',
    年龄: typeof npc.年龄 === 'number' ? npc.年龄 : 20,
    背景: npc.背景 ?? '',
    内心想法: npc.内心想法 ?? '',
    在做事项: npc.在做事项 ?? '',
    性格特征: Array.isArray(npc.性格特征) ? [...npc.性格特征] : [],
    记忆: Array.isArray(npc.记忆) ? [...npc.记忆] : [],
    关注: npc.关注 === true,
    心跳锁定: npc.心跳锁定 === true,
    私密信息: clonePrivacy(npc.私密信息),
    核心性格特征: (npc[npcFields.corePersonality] as string) ?? '',
    关系状态: (npc[npcFields.relationshipStatus] as string) ?? '',
    好感度突破条件: (npc[npcFields.affinityBreakthrough] as string) ?? '',
    关系突破条件: (npc[npcFields.relationshipBreakthrough] as string) ?? '',
    关系网变量: Array.isArray(npc[npcFields.relationshipNetwork])
      ? (npc[npcFields.relationshipNetwork] as RelationNetworkEntry[]).map(e => ({ ...e, 备注: e.备注 ?? '' }))
      : [],
    总结记忆: Array.isArray(npc[npcFields.memorySummaries])
      ? (npc[npcFields.memorySummaries] as MemorySummaryEntry[]).map(e => ({ ...e }))
      : [],
  };
  if (nsfwEnabled.value) seedRequiredBodyParts();
  newTraitInput.value = '';
  newMemoryInput.value = '';
  showEditModal.value = true;
}

function openAddNew(): void {
  selectedNpc.value = null;
  editIndex.value = -1;
  editForm.value = {
    名称: '',
    类型: '普通',
    好感度: 50,
    位置: '',
    描述: '',
    外貌描述: '',
    身材描写: '',
    衣着风格: '',
    性别: '',
    年龄: 20,
    背景: '',
    内心想法: '',
    在做事项: '',
    性格特征: [],
    记忆: [],
    关注: false,
    心跳锁定: false,
    私密信息: {},
    核心性格特征: '',
    关系状态: '',
    好感度突破条件: '',
    关系突破条件: '',
    关系网变量: [],
    总结记忆: [],
  };
  if (nsfwEnabled.value) seedRequiredBodyParts();
  newTraitInput.value = '';
  newMemoryInput.value = '';
  showEditModal.value = true;
}

function saveNpc(): void {
  const f = editForm.value;
  const formData: Record<string, unknown> = {
    名称: f.名称,
    类型: f.类型,
    好感度: f.好感度,
    位置: f.位置,
    描述: f.描述,
    外貌描述: f.外貌描述,
    身材描写: f.身材描写,
    衣着风格: f.衣着风格,
    性别: f.性别,
    年龄: f.年龄,
    背景: f.背景,
    内心想法: f.内心想法,
    在做事项: f.在做事项,
    性格特征: f.性格特征,
    记忆: f.记忆,
    关注: f.关注,
    心跳锁定: f.心跳锁定,
    私密信息: f.私密信息,
    [npcFields.corePersonality]: f.核心性格特征,
    [npcFields.relationshipStatus]: f.关系状态,
    [npcFields.affinityBreakthrough]: f.好感度突破条件,
    [npcFields.relationshipBreakthrough]: f.关系突破条件,
    [npcFields.relationshipNetwork]: f.关系网变量,
    [npcFields.memorySummaries]: f.总结记忆,
  };
  const result = npcEditor.save(editIndex.value, formData as import('@/ui/composables/editors').NpcFormData);
  if (result.ok) {
    showEditModal.value = false;
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error',
      i18nKey: result.error.i18nKey,
      message: result.error.message,
      duration: 3000,
    });
  }
}

// §7.2: 打开 NPC 私聊 modal — 直接打开，不经过 edit modal
//
// CR-R26 修复（2026-04-11）：仅当 NPC.名称 非空时允许打开私聊。
// 原因：NpcChatPipeline.chat 的唯一标识是 `名称`；空字符串会导致 find 匹配多个
// "未命名" NPC 或全部失败，产生不可预测的越权写入风险。
// UI 层拦在源头最便宜：点击按钮直接 toast 提示，不进入 pipeline。
function openChat(npc: NpcRelation, event: Event): void {
  event.stopPropagation(); // 防止冒泡触发卡片的 openEdit
  const name = typeof npc.名称 === 'string' ? npc.名称.trim() : '';
  if (!name) {
    eventBus.emit('ui:toast', {
      type: 'warning',
      message: t('relationship.toast.noName'),
      duration: 2500,
    });
    return;
  }
  chatNpc.value = npc;
  showChatModal.value = true;
}

// §7.2: 性格特征 tag 管理
function addTrait(): void {
  const v = newTraitInput.value.trim();
  if (!v) return;
  if (editForm.value.性格特征.includes(v)) return;
  editForm.value.性格特征.push(v);
  newTraitInput.value = '';
}

function removeTrait(idx: number): void {
  editForm.value.性格特征.splice(idx, 1);
}

// §7.2: 记忆条目管理
function addMemory(): void {
  const v = newMemoryInput.value.trim();
  if (!v) return;
  editForm.value.记忆.push(v);
  newMemoryInput.value = '';
}

function removeMemory(idx: number): void {
  editForm.value.记忆.splice(idx, 1);
}

function addNetworkEntry(): void {
  editForm.value.关系网变量.push({ 对象: '', 关系: '', 备注: '' });
}

function removeNetworkEntry(idx: number): void {
  editForm.value.关系网变量.splice(idx, 1);
}

function addSummaryEntry(): void {
  editForm.value.总结记忆.push({ 摘要: '', 涵盖范围: '', 生成时间: '' });
}

function removeSummaryEntry(idx: number): void {
  editForm.value.总结记忆.splice(idx, 1);
}

function openAdvancedEditor(): void {
  if (editIndex.value < 0) return;
  router.push({ name: 'GameVariables', query: { path: `社交.关系`, from: 'relationships' } });
}

function openInEngramEditor(): void {
  if (!selectedNpc.value) return;
  router.push({ name: 'RelationshipGraph', query: { entity: selectedNpc.value.名称 } });
}

const hasEngramRoute = computed(() => router.hasRoute('RelationshipGraph'));

const showDeleteConfirm = ref(false);
const deleteImpact = ref<import('@/ui/composables/editors').DeleteImpact | null>(null);

function requestDeleteNpc(): void {
  if (editIndex.value < 0) return;
  deleteImpact.value = npcEditor.analyzeDeleteImpact(editIndex.value);
  showDeleteConfirm.value = true;
}

function confirmDeleteNpc(): void {
  if (editIndex.value < 0) return;
  const result = npcEditor.delete(editIndex.value);
  if (result.ok) {
    showDeleteConfirm.value = false;
    showEditModal.value = false;
    selectedNpc.value = null;
    detailNpcIdx.value = -1;
  }
}

function cancelDeleteNpc(): void {
  showDeleteConfirm.value = false;
  deleteImpact.value = null;
}

/** Affinity color gradient: red → yellow → green */
function shortLocation(loc: string): string {
  const parts = loc.split('·');
  return parts.length > 2 ? parts.slice(-2).join('·') : loc;
}

function affinityColor(value: number): string {
  if (value <= 30) return 'var(--color-danger, #ef4444)';
  if (value <= 60) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-success, #22c55e)';
}

/** NPC type label colors */
function typeClass(type: string | undefined): string {
  const map: Record<string, string> = {
    同伴: 'type--companion',
    商人: 'type--merchant',
    敌对: 'type--hostile',
    中立: 'type--neutral',
  };
  return map[type ?? ''] ?? 'type--default';
}

/** Map state-tree NPC type value (always Chinese) to translated display label. */
function displayType(type: string | undefined): string {
  if (!type) return '—';
  const map: Record<string, string> = {
    重点: t('relationship.editForm.typeOption.key'),
    同伴: t('relationship.editForm.typeOption.companion'),
    商人: t('relationship.editForm.typeOption.merchant'),
    中立: t('relationship.editForm.typeOption.neutral'),
    敌对: t('relationship.editForm.typeOption.hostile'),
    普通: t('relationship.editForm.typeOption.normal'),
  };
  return map[type] ?? type;
}

/** Map state-tree body-part name (always Chinese) to translated display label. */
function displayBodyPartName(name: string | undefined): string {
  if (!name) return '';
  const map: Record<string, string> = {
    嘴: t('relationship.bodyPart.mouth'),
    胸部: t('relationship.bodyPart.breast'),
    小穴: t('relationship.bodyPart.vagina'),
    屁穴: t('relationship.bodyPart.anus'),
  };
  return map[name] ?? name;
}

/** NPC type options for the edit-modal AgaSelect (placeholder = uncategorized). */
const typeSelectOptions = computed<SelectOption[]>(() => [
  { label: t('relationship.editForm.typeOption.key'), value: '重点' },
  { label: t('relationship.editForm.typeOption.companion'), value: '同伴' },
  { label: t('relationship.editForm.typeOption.merchant'), value: '商人' },
  { label: t('relationship.editForm.typeOption.neutral'), value: '中立' },
  { label: t('relationship.editForm.typeOption.hostile'), value: '敌对' },
  { label: t('relationship.editForm.typeOption.normal'), value: '普通' },
]);

/** NPC gender options for the edit-modal AgaSelect (placeholder = unset). */
const genderSelectOptions = computed<SelectOption[]>(() => [
  { label: t('relationship.editForm.genderOption.male'), value: '男' },
  { label: t('relationship.editForm.genderOption.female'), value: '女' },
  { label: t('relationship.editForm.genderOption.other'), value: '其他' },
]);
</script>

<template>
  <div class="relationship-panel">
    <template v-if="isLoaded">
      <div class="rel-layout">
        <!-- ══ LEFT: Character Roster ══ -->
        <aside class="rel-roster">
          <div class="roster-header">
            <div class="roster-title">
              {{ $t('relationship.roster.title') }}
              <span v-if="relationships?.length" class="badge">{{ relationships.length }}</span>
            </div>
            <Tooltip :text="$t('relationship.roster.add')" interactive>
              <button class="btn-add" :aria-label="$t('relationship.roster.add')" @click="openAddNew">+</button>
            </Tooltip>
          </div>
          <input
            v-model="searchQuery"
            type="text"
            class="roster-search"
            :placeholder="$t('relationship.search.placeholder')"
          />
          <div class="sort-bar">
            <button
              v-for="opt in sortOptions"
              :key="opt.value"
              :class="['sort-chip', { 'sort-chip--active': sortMode === opt.value }]"
              @click="setSortMode(opt.value)"
            >{{ opt.label }}<span v-if="sortMode === opt.value" class="sort-arrow">{{ sortAsc ? '↑' : '↓' }}</span></button>
          </div>
          <div class="roster-list">
            <template v-if="filteredRelations.length">
              <div
                v-for="(npc, idx) in filteredRelations"
                :key="npc.名称 ?? idx"
                :class="['rc', { 'rc--selected': detailNpcIdx === idx, 'rc--attention': npc.关注 }]"
                @click="toggleDetail(npc, idx)"
              >
                <div class="rc-avatar-wrap">
                  <ImageDisplay
                    :asset-id="npc['图片档案']?.['已选头像图片ID']"
                    :fallback-letter="npc.名称?.charAt(0) ?? '?'"
                    :alt="npc.名称"
                    size="sm"
                    class="rc-avatar-img"
                  />
                </div>
                <div class="rc-body">
                  <span class="rc-name">{{ npc.名称 }}</span>
                  <div class="rc-meta">
                    <span :class="['rc-presence', npc['是否在场'] ? 'rc-presence--on' : 'rc-presence--off']">
                      {{ npc['是否在场'] ? $t('relationship.card.present') : $t('relationship.card.offline') }}
                    </span>
                    <span v-if="npc.类型" :class="['rc-type-label', typeClass(npc.类型)]">{{ displayType(npc.类型) }}</span>
                  </div>
                  <span v-if="npc.位置" class="rc-location">{{ shortLocation(npc.位置) }}</span>
                </div>
                <div class="rc-right">
                  <span class="rc-affinity" :style="{ color: affinityColor(npc.好感度 ?? 50) }">♡ {{ npc.好感度 ?? '—' }}</span>
                  <span v-if="npc['是否主要角色']" class="rc-badge-main">{{ $t('relationship.card.mainBadge') }}</span>
                </div>
              </div>
            </template>
            <div v-else class="roster-empty">
              <p>{{ searchQuery ? $t('relationship.card.noMatch') : $t('relationship.card.empty') }}</p>
            </div>
          </div>
          <div v-if="typeSummary.length" class="roster-stats">
            <span
              v-for="([type, count]) in typeSummary"
              :key="type"
              :class="['type-stat', typeClass(type)]"
            >{{ displayType(type) }} {{ count }}</span>
          </div>
        </aside>

        <!-- ══ RIGHT: Detail Pane ══ -->
        <main class="rel-detail">
          <template v-if="selectedNpc">
            <!-- Hero header -->
            <div class="rd-hero">
              <Tooltip :text="$t('relationship.detail.avatarTitle')" interactive>
                <button class="rd-hero-avatar-btn" :aria-label="$t('relationship.detail.avatarTitle')" @click="openImageWorkbench(selectedNpc.名称, $event)">
                  <ImageDisplay
                    :asset-id="selectedNpc['图片档案']?.['已选头像图片ID']"
                    :fallback-letter="selectedNpc.名称?.charAt(0) ?? '?'"
                    size="fill"
                    class="rd-hero-avatar-img"
                  />
                </button>
              </Tooltip>
              <div class="rd-hero-info">
                <h2 class="rd-hero-name">{{ selectedNpc.名称 }}</h2>
                <div class="rd-hero-chips">
                  <span v-if="selectedNpc.性别 || selectedNpc.年龄" class="rd-chip">{{ [selectedNpc.性别, selectedNpc.年龄 ? selectedNpc.年龄 + $t('relationship.detail.ageSuffix') : ''].filter(Boolean).join(' | ') }}</span>
                  <span v-if="selectedNpc.描述" class="rd-chip">{{ selectedNpc.描述 }}</span>
                  <span v-if="selectedNpc['是否在场']" class="rd-chip rd-chip--presence">{{ $t('relationship.detail.presenceOn') }}</span>
                </div>
                <div class="rd-hero-actions">
                  <button class="rd-action-btn" @click="togglePresence(selectedNpc, $event)">◎ {{ selectedNpc['是否在场'] ? $t('relationship.detail.markLeave') : $t('relationship.detail.markPresent') }}</button>
                  <button class="rd-action-btn" @click="toggleMajorRole(selectedNpc, $event)">☆ {{ selectedNpc['是否主要角色'] ? $t('relationship.detail.cancelMajor') : $t('relationship.detail.setMajor') }}</button>
                  <button class="rd-action-btn" @click="toggleAttention(selectedNpc, $event)">👁 {{ selectedNpc.关注 ? $t('relationship.detail.unwatch') : $t('relationship.detail.watch') }}</button>
                  <button class="rd-action-btn" @click="toggleHeartbeatLock(selectedNpc, $event)">{{ selectedNpc.心跳锁定 ? '🔓 ' + $t('relationship.detail.unlockHeartbeat') : '🔒 ' + $t('relationship.detail.lockHeartbeat') }}</button>
                  <button v-if="hasEngramRoute" class="rd-action-btn" @click="openInEngramEditor">🔗 {{ $t('relationship.detail.viewInEngram') }}</button>
                  <button class="rd-action-btn" @click="openChat(selectedNpc, $event)">💬 {{ $t('relationship.detail.privateChat') }}</button>
                  <button class="rd-action-btn" @click="openEdit(selectedNpc, detailNpcIdx)">✏ {{ $t('relationship.detail.edit') }}</button>
                  <button class="rd-action-btn" @click="openAiEdit(selectedNpc)">🤖 {{ $t('relationship.detail.aiEdit') }}</button>
                  <button class="rd-action-btn" @click="openImageWorkbench(selectedNpc.名称, $event)">🖼 {{ $t('relationship.detail.generateImage') }}</button>
                </div>
              </div>
              <div class="rd-affinity-block">
                <div class="rd-affinity-label">AFFECTION POINT</div>
                <div class="rd-affinity-num" :style="{ color: affinityColor(selectedNpc.好感度 ?? 50) }">{{ selectedNpc.好感度 ?? '—' }}</div>
                <span v-if="selectedNpc.类型" :class="['rd-affinity-type', typeClass(selectedNpc.类型)]">{{ displayType(selectedNpc.类型) }}</span>
              </div>
            </div>

            <!-- 2-column flowing detail body (no tabs — matches demo layout) -->
            <div class="rd-body">
              <!-- ── Main Column ── -->
              <div class="rd-main">
                <!-- 人物生平 -->
                <div v-if="selectedNpc.描述 || selectedNpc.背景" class="rd-section">
                  <div class="rd-section-title">{{ $t('relationship.detail.sectionBiography') }}</div>
                  <p v-if="selectedNpc.描述" class="prose prose--focal">{{ selectedNpc.描述 }}</p>
                  <p v-if="selectedNpc.背景" class="prose">{{ selectedNpc.背景 }}</p>
                </div>

                <!-- 性格特征 -->
                <div v-if="selectedNpc.性格特征?.length" class="trait-cloud">
                  <span v-for="t in selectedNpc.性格特征" :key="t" class="trait">{{ t }}</span>
                </div>

                <!-- 内心想法 -->
                <div v-if="selectedNpc.内心想法" class="thought-cloud">
                  <span class="section-hint">{{ $t('relationship.detail.innerThoughts') }}</span>
                  <p class="thought-text">{{ selectedNpc.内心想法 }}</p>
                </div>

                <!-- 在做事项 -->
                <div v-if="selectedNpc.在做事项" class="action-strip">
                  <span class="section-hint">{{ $t('relationship.detail.currentActivity') }}</span>
                  <p class="action-text">{{ selectedNpc.在做事项 }}</p>
                </div>

                <!-- 最近对话 -->
                <div v-if="selectedNpc.私聊历史?.length" class="chat-section">
                  <div class="rd-section-title">{{ $t('relationship.detail.sectionRecentChat') }}</div>
                  <div class="chat-list">
                    <div v-for="(msg, ci) in selectedNpc.私聊历史.slice(-8)" :key="ci" :class="['chat-bubble', `chat-bubble--${msg.role}`]">
                      <span class="chat-who">{{ msg.role === 'user' ? $t('relationship.detail.chatYou') : selectedNpc.名称 }}</span>
                      <span>{{ msg.content }}</span>
                    </div>
                  </div>
                  <p v-if="selectedNpc.私聊历史.length > 8" class="hint">{{ $t('relationship.detail.recentChatSummary', { shown: 8, total: selectedNpc.私聊历史.length }) }}</p>
                </div>

                <!-- 共同记忆 -->
                <div v-if="selectedNpc.记忆?.length" class="rd-section">
                  <div class="rd-section-title">{{ $t('relationship.detail.sectionSharedMemory') }}</div>
                  <NpcMemoryTimeline :memories="selectedNpc.记忆 ?? []" :summaries="selectedNpc.总结记忆" />
                </div>

                <p v-if="!selectedNpc.描述 && !selectedNpc.背景 && !selectedNpc.内心想法 && !selectedNpc.在做事项 && !selectedNpc.私聊历史?.length && !selectedNpc.记忆?.length && !selectedNpc.性格特征?.length" class="hint">{{ $t('relationship.detail.noDetail') }}</p>

                <!-- Portrait gallery (bottom of main column) -->
                <div v-if="selectedNpc['图片档案']?.['已选立绘图片ID']" class="portrait-gallery">
                  <Tooltip :text="$t('relationship.detail.clickFullImage')" interactive>
                    <div class="portrait-frame" role="button" :aria-label="$t('relationship.detail.clickFullImage')" @click="openPortraitViewer(selectedNpc['图片档案']['已选立绘图片ID'])">
                      <ImageDisplay :asset-id="selectedNpc['图片档案']['已选立绘图片ID']" :fallback-letter="selectedNpc.名称?.charAt(0) ?? '?'" size="lg" class="portrait-image" />
                      <div class="portrait-vignette" />
                    </div>
                  </Tooltip>
                </div>
              </div>

              <!-- ── Side Column ── -->
              <div class="rd-side">
                <!-- 外貌/容颜 -->
                <div v-if="selectedNpc.外貌描述" class="rd-section">
                  <div class="rd-section-title">{{ $t('relationship.detail.sectionAppearance') }}</div>
                  <div class="rd-quote">{{ selectedNpc.外貌描述 }}</div>
                </div>

                <!-- 身材/衣着 info -->
                <div v-if="selectedNpc.性别 || selectedNpc.年龄 || selectedNpc.身材描写 || selectedNpc.衣着风格" class="rd-side-info">
                  <div v-if="selectedNpc.性别 || selectedNpc.年龄" class="rd-side-row">
                    <span class="rd-side-label">{{ $t('relationship.detail.birthday') }}</span><span class="rd-side-val">{{ $t('relationship.detail.birthdayUnknown') }}</span>
                    <span class="rd-side-label" style="margin-left:16px">{{ $t('relationship.detail.titleLabel') }}</span><span class="rd-side-val">{{ displayType(selectedNpc.类型) }}</span>
                  </div>
                  <div v-if="selectedNpc.身材描写" class="rd-side-row">
                    <span class="rd-side-label">{{ $t('relationship.detail.physique') }}</span><span class="rd-side-val">{{ selectedNpc.身材描写 }}</span>
                  </div>
                  <div v-if="selectedNpc.衣着风格" class="rd-side-row">
                    <span class="rd-side-label">{{ $t('relationship.detail.attire') }}</span><span class="rd-side-val">{{ selectedNpc.衣着风格 }}</span>
                  </div>
                </div>

                <!-- 香闺秘档 (NSFW) -->
                <div v-if="nsfwEnabled && selectedNpc.私密信息" class="nsfw-card">
                  <div class="rd-section-title rd-section-title--nsfw">♥ {{ $t('relationship.nsfw.sectionTitle') }} <span class="nsfw-badge">TOP SECRET</span></div>

                  <div v-if="selectedNpc.私密信息.性格倾向 || selectedNpc.私密信息.性取向" class="nsfw-row">
                    <div v-if="selectedNpc.私密信息.性格倾向" class="nsfw-field"><span class="section-hint">{{ $t('relationship.nsfw.personalityDisposition') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.性格倾向 }}</span></div>
                    <div v-if="selectedNpc.私密信息.性取向" class="nsfw-field"><span class="section-hint">{{ $t('relationship.nsfw.sexualOrientation') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.性取向 }}</span></div>
                  </div>
                  <div v-if="selectedNpc.私密信息.当前性状态" class="nsfw-field" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.currentStatus') }}</span><p class="nsfw-status">{{ selectedNpc.私密信息.当前性状态 }}</p></div>
                  <div v-if="selectedNpc.私密信息.性渴望程度 != null" style="margin-top:10px">
                    <span class="section-hint">{{ $t('relationship.nsfw.desireLevel') }}</span>
                    <div class="desire-bar-wrap"><div class="desire-bar"><div class="desire-fill" :style="{ width: selectedNpc.私密信息.性渴望程度 + '%' }" /></div><span class="desire-num">{{ selectedNpc.私密信息.性渴望程度 }}</span></div>
                  </div>
                  <div v-if="selectedNpc.私密信息.体液分泌状态" class="nsfw-field" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.fluidStatus') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.体液分泌状态 }}</span></div>
                  <div v-if="selectedNpc.私密信息.性交总次数 != null" class="nsfw-field" style="margin-top:6px"><span class="section-hint">{{ $t('relationship.nsfw.sexualEncounters') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.性交总次数 }}</span></div>

                  <!-- 身体部位 -->
                  <div v-if="selectedNpc.私密信息.身体部位?.length" style="margin-top:10px"><span class="section-hint" style="display:block;margin-bottom:6px">{{ $t('relationship.nsfw.bodyParts') }}</span><div class="bp-grid">
                    <div v-for="(bp, bi) in selectedNpc.私密信息.身体部位" :key="bi" class="bp-card">
                      <div class="bp-head">
                        {{ displayBodyPartName(bp.部位名称) }}
                        <span v-if="bp.特殊印记" class="bp-mark">{{ bp.特殊印记 }}</span>
                        <button v-if="bp.已选背景图片ID" class="bp-view-toggle" @click="bodyPartViewMode[`${selectedNpc.名称}_${bi}`] = bodyPartViewMode[`${selectedNpc.名称}_${bi}`] === 'image' ? 'text' : 'image'">{{ bodyPartViewMode[`${selectedNpc.名称}_${bi}`] === 'image' ? $t('relationship.detail.viewText') : $t('relationship.detail.viewImage') }}</button>
                      </div>
                      <template v-if="bodyPartViewMode[`${selectedNpc.名称}_${bi}`] === 'image' && bp.已选背景图片ID">
                        <ImageDisplay :asset-id="bp.已选背景图片ID" :fallback-letter="bp.部位名称?.charAt(0) ?? '?'" size="lg" class="bp-image" />
                      </template>
                      <template v-else><p v-if="bp.特征描述" class="bp-desc">{{ bp.特征描述 }}</p></template>
                      <div class="bp-meters">
                        <div class="bp-meter"><span>{{ $t('relationship.nsfw.sensitivity') }}</span><div class="bp-bar"><div class="bp-fill" :style="{width:(bp.敏感度??0)+'%'}" /></div><span>{{bp.敏感度??0}}</span></div>
                        <div class="bp-meter"><span>{{ $t('relationship.nsfw.development') }}</span><div class="bp-bar"><div class="bp-fill bp-fill--dev" :style="{width:(bp.开发度??0)+'%'}" /></div><span>{{bp.开发度??0}}</span></div>
                      </div>
                    </div>
                  </div></div>

                  <!-- 处女状态 -->
                  <div v-if="selectedNpc.私密信息['是否为处女/处男'] !== undefined" class="nsfw-field" style="margin-top:10px">
                    <span class="section-hint">{{ $t('relationship.nsfw.virginStatus') }}</span>
                    <span class="nsfw-val">{{ selectedNpc.私密信息['是否为处女/处男'] === true ? $t('relationship.detail.virginYes') : selectedNpc.私密信息['是否为处女/处男'] === false ? $t('relationship.detail.virginNo') : $t('relationship.detail.virginUnset') }}</span>
                  </div>
                  <template v-if="selectedNpc.私密信息['是否为处女/处男'] === false || selectedNpc.私密信息.初夜夺取者">
                    <div v-if="selectedNpc.私密信息.初夜夺取者" class="nsfw-field" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.firstNightTaker') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.初夜夺取者 }}</span></div>
                    <div v-if="selectedNpc.私密信息.初夜时间" class="nsfw-field" style="margin-top:6px"><span class="section-hint">{{ $t('relationship.nsfw.firstNightTime') }}</span><span class="nsfw-val">{{ selectedNpc.私密信息.初夜时间 }}</span></div>
                    <div v-if="selectedNpc.私密信息.初夜描述" class="nsfw-field" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.firstNightDescription') }}</span><p class="nsfw-status">{{ selectedNpc.私密信息.初夜描述 }}</p></div>
                  </template>

                  <!-- 偏好 -->
                  <div v-if="selectedNpc.私密信息.性癖好?.length" style="margin-top:10px"><span class="section-hint">{{ $t('relationship.nsfw.fetishes') }}</span><div class="tag-row"><span v-for="f in selectedNpc.私密信息.性癖好" :key="f" class="detail-tag detail-tag--nsfw">{{ f }}</span></div></div>
                  <div v-if="selectedNpc.私密信息.特殊体质?.length" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.specialPhysique') }}</span><div class="tag-row"><span v-for="t in selectedNpc.私密信息.特殊体质" :key="t" class="detail-tag detail-tag--trait">{{ t }}</span></div></div>
                  <div v-if="selectedNpc.私密信息.性伴侣名单?.length" style="margin-top:8px"><span class="section-hint">{{ $t('relationship.nsfw.sexualPartners') }}</span><div class="tag-row"><span v-for="p in selectedNpc.私密信息.性伴侣名单" :key="p" class="detail-tag">{{ p }}</span></div></div>
                </div>
              </div>
            </div>
          </template>

          <!-- Empty state when no NPC selected -->
          <div v-else class="detail-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <p>{{ $t('relationship.detail.emptyState') }}</p>
          </div>
        </main>
      </div>
    </template>

    <div v-else class="empty-state">
      <p>{{ $t('map.notLoaded') }}</p>
    </div>

    <!-- ─── NPC Edit Modal ─── -->
    <Modal v-model="showEditModal" :title="editIndex >= 0 ? $t('relationship.edit.titleEdit') : $t('relationship.edit.titleAdd')" width="520px">
      <div class="edit-form">
        <!-- 基本信息 -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionBasic') }}</h4>

          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.label.name') }}</label>
              <input v-model="editForm.名称" type="text" class="form-input" :placeholder="$t('relationship.editForm.placeholder.npcName')" />
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.label.type') }}</label>
              <AgaSelect
                v-model="editForm.类型"
                :options="typeSelectOptions"
                :placeholder="$t('relationship.editForm.typeOption.uncategorized')"
                :aria-label="$t('relationship.editForm.label.type')"
              />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.label.gender') }}</label>
              <AgaSelect
                v-model="editForm.性别"
                :options="genderSelectOptions"
                :placeholder="$t('relationship.editForm.genderOption.unset')"
                :aria-label="$t('relationship.editForm.label.gender')"
              />
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.label.age') }}</label>
              <input v-model.number="editForm.年龄" type="number" inputmode="numeric" class="form-input" min="0" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.affinity') }} ({{ editForm.好感度 }})</label>
            <input v-model.number="editForm.好感度" type="range" min="-100" max="100" class="form-range" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.edit.placeholder.location') }}</label>
            <input v-model="editForm.位置" type="text" class="form-input" :placeholder="$t('relationship.edit.placeholder.location')" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.relationshipStatus') }}</label>
            <input v-model="editForm.关系状态" type="text" class="form-input" />
            <span class="form-hint form-hint--d26">ⓘ {{ $t('relationship.editForm.d26Hint') }}</span>
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.corePersonality') }}</label>
            <textarea v-model="editForm.核心性格特征" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.corePersonality')" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.affinityBreak') }}</label>
            <textarea v-model="editForm.好感度突破条件" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.breakCondition')" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.relationBreak') }}</label>
            <textarea v-model="editForm.关系突破条件" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.breakCondition')" />
          </div>
        </div>

        <!-- 关系网 (Story 2 新增) -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionRelationNetwork') }}</h4>
          <span class="form-hint form-hint--d26">ⓘ {{ $t('relationship.editForm.d26Hint') }}</span>

          <div v-for="(entry, idx) in editForm.关系网变量" :key="idx" class="network-row">
            <input v-model="entry.对象" type="text" class="form-input network-input" :placeholder="$t('relationship.editForm.label.networkTarget')" />
            <input v-model="entry.关系" type="text" class="form-input network-input" :placeholder="$t('relationship.editForm.label.networkRelation')" />
            <input v-model="entry.备注" type="text" class="form-input network-input" :placeholder="$t('relationship.editForm.label.networkNote')" />
            <button class="tag-delete" @click="removeNetworkEntry(idx)" :aria-label="$t('common.actions.delete')">&times;</button>
          </div>
          <button class="btn-secondary btn-sm" @click="addNetworkEntry">{{ $t('relationship.editForm.addNetworkEntry') }}</button>
        </div>

        <!-- 外貌与描述 -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionVisual') }}</h4>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.edit.placeholder.description') }}</label>
            <input v-model="editForm.描述" type="text" class="form-input" :placeholder="$t('relationship.edit.placeholder.description')" />
            <span class="form-hint">{{ $t('relationship.editForm.hint.descriptionUsage') }}</span>
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.appearance') }}</label>
            <textarea v-model="editForm.外貌描述" class="form-textarea" rows="3" :placeholder="$t('relationship.editForm.placeholder.appearance')" />
            <span class="form-hint">{{ $t('relationship.editForm.hint.appearanceUsage') }}</span>
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.physique') }}</label>
            <textarea v-model="editForm.身材描写" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.physique')" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.attire') }}</label>
            <textarea v-model="editForm.衣着风格" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.attire')" />
            <span class="form-hint">{{ $t('relationship.editForm.hint.attire') }}</span>
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.background') }}</label>
            <textarea v-model="editForm.背景" class="form-textarea" rows="3" :placeholder="$t('relationship.editForm.placeholder.background')" />
          </div>
        </div>

        <!-- 当前状态 -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionStatus') }}</h4>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.innerThoughts') }}</label>
            <textarea v-model="editForm.内心想法" class="form-textarea" rows="2" :placeholder="$t('relationship.editForm.placeholder.innerThoughts')" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('relationship.editForm.label.currentActivity') }}</label>
            <input v-model="editForm.在做事项" type="text" class="form-input" :placeholder="$t('relationship.editForm.placeholder.currentActivity')" />
          </div>
        </div>

        <!-- 性格特征 tag list -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionTraits') }}</h4>

          <div class="tag-list">
            <span v-for="(trait, idx) in editForm.性格特征" :key="idx" class="tag-item">
              {{ trait }}
              <button class="tag-delete" @click="removeTrait(idx)" :aria-label="$t('common.actions.delete')">&times;</button>
            </span>
            <span v-if="editForm.性格特征.length === 0" class="tag-empty">{{ $t('relationship.editForm.traits.empty') }}</span>
          </div>
          <div class="tag-input-row">
            <input
              v-model="newTraitInput"
              type="text"
              class="form-input tag-input"
              :placeholder="$t('relationship.editForm.traits.placeholder')"
              @keyup.enter="addTrait"
            />
            <button class="btn-secondary btn-sm" @click="addTrait">{{ $t('relationship.editForm.traits.add') }}</button>
          </div>
        </div>

        <!-- 记忆 list -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionMemory') }}</h4>

          <div class="memory-list">
            <div v-for="(mem, idx) in editForm.记忆" :key="idx" class="memory-item">
              <!-- Social-1: 同 display 侧，混合 string/{内容,时间} 形态 — 统一渲染。 -->
              <span class="memory-text">{{ formatMemoryEntry(mem) }}</span>
              <button class="memory-delete" @click="removeMemory(idx)" :aria-label="$t('common.actions.delete')">&times;</button>
            </div>
            <div v-if="editForm.记忆.length === 0" class="memory-empty">{{ $t('relationship.editForm.memory.empty') }}</div>
          </div>
          <div class="tag-input-row">
            <input
              v-model="newMemoryInput"
              type="text"
              class="form-input tag-input"
              :placeholder="$t('relationship.editForm.memory.placeholder')"
              @keyup.enter="addMemory"
            />
            <button class="btn-secondary btn-sm" @click="addMemory">{{ $t('relationship.editForm.memory.add') }}</button>
          </div>
        </div>

        <!-- 总结记忆 (Story 2 新增) -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionMemorySummary') }}</h4>

          <div v-for="(entry, idx) in editForm.总结记忆" :key="idx" class="summary-entry">
            <div class="form-group">
              <label class="form-label">{{ $t('relationship.editForm.label.summaryText') }}</label>
              <textarea v-model="entry.摘要" class="form-textarea" rows="3" />
            </div>
            <div class="form-row">
              <div class="form-group form-group--half">
                <label class="form-label">{{ $t('relationship.editForm.label.summaryRange') }}</label>
                <input v-model="entry.涵盖范围" type="text" class="form-input" />
              </div>
              <div class="form-group form-group--half">
                <label class="form-label">{{ $t('relationship.editForm.label.summaryTime') }}</label>
                <input v-model="entry.生成时间" type="text" class="form-input" />
              </div>
            </div>
            <button class="btn-danger btn-sm" @click="removeSummaryEntry(idx)" style="align-self:flex-end">{{ $t('common.actions.delete') }}</button>
          </div>
          <button class="btn-secondary btn-sm" @click="addSummaryEntry">{{ $t('relationship.editForm.addSummary') }}</button>
        </div>

        <!-- 私密信息（NSFW 开启时显示） -->
        <div v-if="nsfwEnabled" class="form-section">
          <h4 class="form-section-title form-section-title--nsfw">{{ $t('relationship.editForm.sectionNsfw') }}</h4>

          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.personalityDisposition') }}</label>
              <input v-model="editForm.私密信息.性格倾向" type="text" class="form-input" :placeholder="$t('relationship.editForm.nsfw.placeholder.disposition')" />
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.sexualOrientation') }}</label>
              <input v-model="editForm.私密信息.性取向" type="text" class="form-input" :placeholder="$t('relationship.editForm.nsfw.placeholder.orientation')" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.currentStatus') }}</label>
              <input v-model="editForm.私密信息.当前性状态" type="text" class="form-input" />
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.fluidStatus') }}</label>
              <input v-model="editForm.私密信息.体液分泌状态" type="text" class="form-input" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.desireLevel') }} ({{ editForm.私密信息.性渴望程度 ?? 0 }})</label>
              <input type="range" min="0" max="100" v-model.number="editForm.私密信息.性渴望程度" class="form-range" />
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.sexualEncounters') }}</label>
              <input v-model.number="editForm.私密信息.性交总次数" type="number" inputmode="numeric" min="0" class="form-input" />
            </div>
          </div>

          <!-- 处女状态 + 初夜（非处女时显示） -->
          <div class="form-group">
            <AgaToggle
              :model-value="editForm.私密信息['是否为处女/处男'] === true"
              :label="$t('relationship.editForm.nsfw.virginCheckbox')"
              show-label
              @update:model-value="(v) => editForm.私密信息['是否为处女/处男'] = v"
            />
            <span class="form-hint">{{ $t('relationship.editForm.nsfw.virginHint') }}</span>
          </div>

          <div v-if="isNonVirgin()" class="nested-block">
            <h5 class="nested-title">{{ $t('relationship.editForm.nsfw.firstNightTitle') }}</h5>
            <div class="form-row">
              <div class="form-group form-group--half">
                <label class="form-label">{{ $t('relationship.editForm.nsfw.firstNightTaker') }}</label>
                <input
                  v-model="editForm.私密信息.初夜夺取者"
                  type="text"
                  class="form-input"
                  :placeholder="$t('relationship.editForm.nsfw.placeholder.firstNightTaker')"
                />
              </div>
              <div class="form-group form-group--half">
                <label class="form-label">{{ $t('relationship.editForm.nsfw.firstNightTime') }}</label>
                <input
                  v-model="editForm.私密信息.初夜时间"
                  type="text"
                  class="form-input"
                  :placeholder="$t('relationship.editForm.nsfw.placeholder.firstNightTime')"
                />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ $t('relationship.editForm.nsfw.firstNightDescription') }}</label>
              <textarea
                v-model="editForm.私密信息.初夜描述"
                class="form-textarea"
                rows="3"
                :placeholder="$t('relationship.editForm.nsfw.placeholder.firstNightDescription')"
              />
            </div>
          </div>

          <!-- 身体部位编辑器 — 4 个固定部位 + 可追加的其他部位 -->
          <div class="nested-block">
            <h5 class="nested-title">{{ $t('relationship.editForm.nsfw.bodyPartsTitle') }}</h5>
            <span class="form-hint">{{ $t('relationship.editForm.nsfw.bodyPartsHint') }}</span>

            <div
              v-for="partName in REQUIRED_BODY_PARTS"
              :key="'req-' + partName"
              class="bp-edit-card"
            >
              <div class="bp-edit-head">
                <span class="bp-edit-name bp-edit-name--fixed">{{ displayBodyPartName(partName) }}</span>
                <span class="bp-edit-badge">{{ $t('relationship.editForm.nsfw.required') }}</span>
              </div>
              <template v-if="indexOfBodyPart(partName) >= 0">
                <div class="form-group">
                  <label class="form-label">{{ $t('relationship.editForm.nsfw.featureDescription') }}</label>
                  <textarea
                    v-model="editForm.私密信息.身体部位![indexOfBodyPart(partName)].特征描述"
                    class="form-textarea"
                    rows="2"
                    :placeholder="$t('relationship.editForm.nsfw.placeholder.featureDescription')"
                  />
                </div>
                <div class="form-row">
                  <div class="form-group form-group--half">
                    <label class="form-label">{{ $t('relationship.editForm.nsfw.specialMark') }}</label>
                    <input
                      v-model="editForm.私密信息.身体部位![indexOfBodyPart(partName)].特殊印记"
                      type="text"
                      class="form-input"
                      :placeholder="$t('relationship.editForm.nsfw.placeholder.specialMark')"
                    />
                  </div>
                </div>
                <div class="form-row">
                  <div class="form-group form-group--half">
                    <label class="form-label">{{ $t('relationship.editForm.nsfw.sensitivity') }} ({{ editForm.私密信息.身体部位![indexOfBodyPart(partName)].敏感度 ?? 0 }})</label>
                    <input
                      type="range" min="0" max="100"
                      v-model.number="editForm.私密信息.身体部位![indexOfBodyPart(partName)].敏感度"
                      class="form-range"
                    />
                  </div>
                  <div class="form-group form-group--half">
                    <label class="form-label">{{ $t('relationship.editForm.nsfw.development') }} ({{ editForm.私密信息.身体部位![indexOfBodyPart(partName)].开发度 ?? 0 }})</label>
                    <input
                      type="range" min="0" max="100"
                      v-model.number="editForm.私密信息.身体部位![indexOfBodyPart(partName)].开发度"
                      class="form-range"
                    />
                  </div>
                </div>
              </template>
            </div>

            <!-- 额外部位 — 可自由命名与删除 -->
            <div
              v-for="idx in extraBodyPartIndices()"
              :key="'extra-' + idx"
              class="bp-edit-card bp-edit-card--extra"
            >
              <div class="bp-edit-head">
                <input
                  v-model="editForm.私密信息.身体部位![idx].部位名称"
                  type="text"
                  class="form-input bp-name-input"
                  :placeholder="$t('relationship.editForm.nsfw.placeholder.partName')"
                />
                <button
                  type="button"
                  class="bp-remove-btn"
                  @click="removeBodyPart(idx)"
                  :aria-label="$t('common.actions.delete')"
                >{{ $t('relationship.editForm.nsfw.removeBodyPart') }}</button>
              </div>
              <div class="form-group">
                <label class="form-label">{{ $t('relationship.editForm.nsfw.featureDescription') }}</label>
                <textarea
                  v-model="editForm.私密信息.身体部位![idx].特征描述"
                  class="form-textarea"
                  rows="2"
                />
              </div>
              <div class="form-row">
                <div class="form-group form-group--half">
                  <label class="form-label">{{ $t('relationship.editForm.nsfw.specialMark') }}</label>
                  <input v-model="editForm.私密信息.身体部位![idx].特殊印记" type="text" class="form-input" />
                </div>
              </div>
              <div class="form-row">
                <div class="form-group form-group--half">
                  <label class="form-label">{{ $t('relationship.editForm.nsfw.sensitivity') }} ({{ editForm.私密信息.身体部位![idx].敏感度 ?? 0 }})</label>
                  <input type="range" min="0" max="100" v-model.number="editForm.私密信息.身体部位![idx].敏感度" class="form-range" />
                </div>
                <div class="form-group form-group--half">
                  <label class="form-label">{{ $t('relationship.editForm.nsfw.development') }} ({{ editForm.私密信息.身体部位![idx].开发度 ?? 0 }})</label>
                  <input type="range" min="0" max="100" v-model.number="editForm.私密信息.身体部位![idx].开发度" class="form-range" />
                </div>
              </div>
            </div>

            <button type="button" class="btn-secondary btn-sm bp-add-btn" @click="addExtraBodyPart">
              {{ $t('relationship.editForm.nsfw.addBodyPart') }}
            </button>
          </div>
        </div>

        <!-- Flags -->
        <div class="form-section">
          <h4 class="form-section-title">{{ $t('relationship.editForm.sectionFlags') }}</h4>

          <div class="form-group form-group--row">
            <AgaToggle v-model="editForm.关注" :label="$t('relationship.editForm.flags.watch')" show-label />
            <AgaToggle v-model="editForm.心跳锁定" :label="$t('relationship.editForm.flags.heartbeatLock')" show-label />
          </div>
        </div>
      </div>
      <template #footer>
        <button v-if="editIndex >= 0" class="btn-danger" @click="requestDeleteNpc">{{ $t('common.actions.delete') }}</button>
        <button v-if="editIndex >= 0" class="btn-secondary" @click="openAdvancedEditor">⚙ {{ $t('character.edit.advancedEdit') }}</button>
        <div style="flex: 1" />
        <button class="btn-secondary" @click="showEditModal = false">{{ $t('common.actions.cancel') }}</button>
        <button class="btn-primary" :disabled="!editForm.名称?.trim()" @click="saveNpc">{{ $t('common.actions.save') }}</button>
      </template>
    </Modal>

    <!-- Delete cascade confirmation dialog -->
    <Modal v-model="showDeleteConfirm" :title="$t('common.actions.delete')" width="400px">
      <div v-if="deleteImpact" class="delete-impact">
        <p style="margin-bottom: 12px">{{ $t('relationship.delete.cascadeWarning') }}</p>
        <ul class="impact-list">
          <li>{{ deleteImpact.npcName }}</li>
          <li v-if="deleteImpact.locationRefs.length">
            {{ $t('relationship.delete.locationRefs') }}:
            <span class="impact-refs">{{ deleteImpact.locationRefs.join(', ') }}</span>
          </li>
          <li v-if="deleteImpact.hasEngramEntity">
            {{ $t('relationship.delete.engramEntity') }}
          </li>
        </ul>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="cancelDeleteNpc">{{ $t('common.actions.cancel') }}</button>
        <button class="btn-danger" @click="confirmDeleteNpc">{{ $t('common.actions.delete') }}</button>
      </template>
    </Modal>

    <!-- §7.2: NPC 私聊 modal -->
    <NpcChatModal v-model="showChatModal" :npc="chatNpc" />

    <!-- Portrait full-screen viewer -->
    <ImageViewer v-if="portraitViewerOpen" :src="portraitViewerSrc" @close="closePortraitViewer" />
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   RelationshipPanel — Master-Detail Sanctuary Layout
   Left roster sidebar (280px) + right scrollable detail pane.
   All tokens from tokens.css; NO #fff, NO indigo, NO raw rgba.
   ══════════════════════════════════════════════════════════════ */

/* ── Root container ── */
.relationship-panel {
  height: 100%;
  overflow: hidden;
  min-width: 0;
}

.rel-layout {
  display: flex;
  flex-direction: row;
  height: 100%;
  overflow: hidden;
  min-width: 0;
  padding-left: var(--sidebar-left-reserve, 40px);
  padding-right: var(--sidebar-right-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

/* ══════════════════════════════════════════════════════════════
   LEFT ROSTER SIDEBAR
   ══════════════════════════════════════════════════════════════ */
.rel-roster {
  width: 280px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
  overflow: hidden;
}

/* ── Roster header ── */
.roster-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
}

.roster-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  font-family: var(--font-serif-cjk);
  letter-spacing: 0.15em;
  color: var(--color-text-bone);
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: var(--color-sage-400);
  border-radius: var(--radius-full);
}

.btn-add {
  min-width: 28px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 1.1rem;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: 50%;
  cursor: pointer;
  transition: all var(--duration-fast) ease;
}
.btn-add:hover {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border-color: var(--color-sage-400);
}

/* ── Roster search ── */
.roster-search {
  width: calc(100% - 24px);
  height: 34px;
  margin: 0 12px 10px;
  padding: 0 12px;
  font-size: 0.82rem;
  color: var(--color-text-bone);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--duration-fast) ease;
}
.roster-search:focus {
  border-color: var(--color-sage-400);
}

/* ── Sort bar ── */
.sort-bar {
  display: flex;
  gap: 4px;
  padding: 0 12px 8px;
  flex-wrap: wrap;
}
.sort-chip {
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all var(--duration-fast) ease;
  white-space: nowrap;
}
.sort-chip:hover {
  color: var(--color-text-bone);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}
.sort-chip--active {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
}
.sort-arrow {
  margin-left: 2px;
  font-size: 0.6rem;
}

/* ── Roster list ── */
.roster-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.roster-list::-webkit-scrollbar { width: 4px; }
.roster-list::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 2px; }
.rel-detail::-webkit-scrollbar { width: 5px; }
.rel-detail::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

/* ── Roster card (NPC row) ── */
.rc {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--duration-fast) ease,
              box-shadow var(--duration-fast) ease;
  border: 1px solid transparent;
}
.rc:hover {
  background: color-mix(in oklch, var(--color-text-bone) 4%, transparent);
}
.rc--selected {
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 10%, transparent),
    color-mix(in oklch, var(--color-sage-400) 5%, transparent));
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}
.rc--attention {
  box-shadow: inset 3px 0 0 var(--color-sage-400);
}

/* ── Roster card: avatar ── */
.rc-avatar-wrap {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-sage-400);
  font-weight: 700;
  font-size: 0.88rem;
}
.rc-avatar-img :deep(.img-display) {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}
.rc-avatar-img :deep(.img-display__img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rc-avatar-img :deep(.img-display__fallback) {
  font-size: 0.9rem;
}

/* ── Roster card: body ── */
.rc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rc-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rc-presence {
  font-size: 0.62rem;
  font-weight: 500;
  flex-shrink: 0;
}
.rc-presence--on {
  color: var(--color-success);
  text-shadow: 0 0 4px color-mix(in oklch, var(--color-success) 40%, transparent);
}
.rc-presence--off {
  color: var(--color-text-muted);
}
.rc-location {
  font-size: 0.6rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.7;
}
.rc-type-label {
  font-size: 0.62rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* ── Roster card: right column ── */
.rc-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.rc-affinity {
  font-size: 0.78rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
}
.rc-badge-main {
  font-size: 0.55rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-amber-400) 15%, transparent);
  color: var(--color-amber-400);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* ── Roster stats (bottom summary) ── */
.roster-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.roster-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 0.82rem;
  padding: 32px 16px;
  text-align: center;
}

/* ── Type badges (shared: roster + detail) ── */
.type-stat {
  padding: 2px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: var(--radius-full);
}

.type--companion {
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
.type--merchant {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}
.type--hostile {
  color: var(--color-danger);
  background: color-mix(in oklch, var(--color-danger) 12%, transparent);
}
.type--neutral {
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text-secondary) 12%, transparent);
}
.type--default {
  color: var(--color-sage-600);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

/* ══════════════════════════════════════════════════════════════
   RIGHT DETAIL PANE
   ══════════════════════════════════════════════════════════════ */
.rel-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--color-bg);
  container-type: inline-size;
}

/* ── Detail empty state ── */
.detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 0.88rem;
  gap: 8px;
  padding: 48px;
}

/* ── Hero header ── */
.rd-hero {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  min-width: 0;
  padding: 24px 28px 20px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
}

.rd-hero-avatar-btn {
  width: 120px;
  height: 120px;
  background: none;
  border: 2px solid transparent;
  border-radius: var(--radius-lg);
  padding: 0;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color var(--duration-fast) ease,
              box-shadow var(--duration-fast) ease;
}
.rd-hero-avatar-btn:hover {
  border-color: var(--color-sage-400);
  box-shadow: var(--shadow-glow), 0 0 20px color-mix(in oklch, var(--color-sage-400) 18%, transparent);
}
.rd-hero-avatar-img :deep(.img-display) {
  border-radius: var(--radius-lg);
}
.rd-hero-avatar-img :deep(.img-display--fill .img-display__img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rd-hero-avatar-img :deep(.img-display__fallback) {
  font-size: 2.4rem;
}

/* ── Hero info ── */
.rd-hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rd-hero-name {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  font-family: var(--font-serif-cjk);
  color: var(--color-text-bone);
  letter-spacing: 0.04em;
}
.rd-hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.rd-chip {
  max-width: 100%;
  padding: 2px 10px;
  font-size: 0.7rem;
  font-weight: 500;
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text-secondary) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-text-secondary) 12%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd-chip--presence {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rd-hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
  max-width: 100%;
  min-width: 0;
}
.rd-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  max-width: 100%;
  min-width: 0;
  padding: 5px 12px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast) ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rd-action-btn:hover {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border-color: var(--color-sage-400);
  transform: translateY(-1px);
}

/* ── Hero affinity block ── */
.rd-affinity-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
  min-width: 72px;
  padding-top: 4px;
}
.rd-affinity-label {
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
.rd-affinity-num {
  font-size: 1.4rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-text-bone);
  line-height: 1.1;
}
.rd-affinity-type {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--color-text-secondary);
}

/* ══════════════════════════════════════════════════════════════
   DETAIL TABS
   ══════════════════════════════════════════════════════════════ */
/* ── 2-Column Detail Body ── */
.rd-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0;
  min-height: 0;
  min-width: 0;
}
.rd-main {
  min-width: 0;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  border-right: 1px solid var(--color-border-subtle);
}
.rd-side {
  min-width: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.rd-section {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: color-mix(in oklch, var(--color-surface) 60%, transparent);
}
.rd-section-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone);
  margin: 0 0 10px;
}
.rd-section-title--nsfw {
  color: var(--color-nsfw);
  display: flex;
  align-items: center;
  gap: 8px;
}
.nsfw-badge {
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in oklch, var(--color-nsfw) 12%, transparent);
  color: var(--color-nsfw);
  border: 1px solid color-mix(in oklch, var(--color-nsfw) 25%, transparent);
}
.rd-quote {
  padding: 14px 18px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  line-height: 1.8;
  color: color-mix(in oklch, var(--color-text) 80%, transparent);
  font-style: italic;
  position: relative;
}
.rd-quote::before {
  content: '\201C';
  position: absolute;
  top: 4px;
  left: 8px;
  font-size: 2rem;
  opacity: 0.1;
  color: var(--color-sage-400);
  font-style: normal;
}
.rd-side-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
}
.rd-side-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 0.82rem;
  line-height: 1.5;
}
.rd-side-label {
  color: var(--color-sage-400);
  font-size: 0.72rem;
  font-weight: 600;
  min-width: 36px;
  flex-shrink: 0;
}
.rd-side-val {
  color: var(--color-text-bone);
  flex: 1;
  min-width: 0;
}

@media (max-width: 900px) {
  .rd-body { grid-template-columns: 1fr; }
  .rd-main { border-right: none; }
  .rd-side { border-top: 1px solid var(--color-border-subtle); }
}

@container (max-width: 640px) {
  .rd-hero {
    flex-wrap: wrap;
    gap: 14px;
    padding-inline: 20px;
  }

  .rd-hero-info {
    flex-basis: calc(100% - 92px);
  }

  .rd-affinity-block {
    width: 100%;
    min-width: 0;
    align-items: flex-start;
    padding-top: 0;
  }

  .rd-hero-actions {
    gap: 6px;
  }
}

/* ══════════════════════════════════════════════════════════════
   BASIC TAB — bio, prose, traits
   ══════════════════════════════════════════════════════════════ */
.bio-line {
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.prose {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  line-height: 1.75;
  letter-spacing: var(--narrative-letter-spacing, 0.01em);
  color: color-mix(in oklch, var(--color-text-bone) 85%, transparent);
  white-space: pre-wrap;
}
.prose--focal {
  font-size: 0.95rem;
  color: var(--color-text-bone);
  line-height: 1.8;
}

.section-hint {
  display: block;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  opacity: 0.55;
  margin-bottom: 4px;
}

.trait-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}
.trait {
  padding: 4px 14px;
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 7%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-radius: var(--radius-full);
  transition: background var(--duration-fast), border-color var(--duration-fast);
}
.trait:hover {
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  text-shadow: 0 0 4px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ══════════════════════════════════════════════════════════════
   STATUS TAB — thoughts, actions, chat preview
   ══════════════════════════════════════════════════════════════ */
.thought-cloud {
  padding: 14px 18px;
  border-radius: var(--radius-lg);
  background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  position: relative;
}
.thought-cloud::before {
  content: '\201C';
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 1.8rem;
  line-height: 1;
  opacity: 0.12;
  color: var(--color-sage-400);
}
.thought-text {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  line-height: 1.75;
  font-style: italic;
  color: color-mix(in oklch, var(--color-text-bone) 80%, transparent);
  padding-left: 8px;
}

.action-strip {
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in oklch, var(--color-success) 15%, transparent);
  background: color-mix(in oklch, var(--color-success) 4%, transparent);
  box-shadow: inset 3px 0 0 var(--color-success);
}
.action-text {
  margin: 0;
  font-size: 0.86rem;
  line-height: 1.6;
  color: var(--color-text-bone);
}

.chat-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: color-mix(in oklch, var(--color-surface) 60%, transparent);
}
.chat-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 240px;
  overflow-y: auto;
}
.chat-bubble {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  font-size: 0.82rem;
  line-height: 1.5;
}
.chat-bubble--user {
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.chat-bubble--assistant {
  background: color-mix(in oklch, var(--color-success) 3%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in oklch, var(--color-success) 30%, transparent);
}
.chat-who {
  font-size: 0.62rem;
  font-weight: 600;
  opacity: 0.4;
  display: block;
  margin-bottom: 2px;
}

/* ══════════════════════════════════════════════════════════════
   MEMORY TAB — timeline
   ══════════════════════════════════════════════════════════════ */
.memory-timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-left: 16px;
  position: relative;
}
.memory-timeline::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-radius: 1px;
}

.tl-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid color-mix(in oklch, var(--color-text-bone) 3%, transparent);
}
.tl-item:last-child {
  border-bottom: none;
}
.tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
  background: var(--color-sage-400);
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.tl-text {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.6;
  color: var(--color-text-bone);
}

/* ══════════════════════════════════════════════════════════════
   NSFW TAB — cards, desire meters, tags
   ══════════════════════════════════════════════════════════════ */
.nsfw-card {
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-nsfw) 4%, transparent),
    color-mix(in oklch, var(--color-nsfw) 2%, transparent) 60%);
  border: 1px solid color-mix(in oklch, var(--color-nsfw) 8%, transparent);
}

.nsfw-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.nsfw-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nsfw-val {
  font-size: 0.86rem;
  color: var(--color-text-bone);
}
.nsfw-status {
  margin: 6px 0 0;
  font-size: 0.82rem;
  line-height: 1.5;
  color: color-mix(in oklch, var(--color-text-bone) 65%, transparent);
  font-style: italic;
}

.desire-bar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.desire-bar {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: color-mix(in oklch, var(--color-nsfw) 10%, transparent);
  overflow: hidden;
}
.desire-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--color-nsfw), var(--color-nsfw-bright));
  transition: width 0.4s ease;
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-nsfw) 35%, transparent);
}
.desire-num {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-nsfw);
  min-width: 20px;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.detail-tag {
  padding: 3px 12px;
  font-size: 0.72rem;
  font-weight: 500;
  background: color-mix(in oklch, var(--color-sage-400) 7%, transparent);
  color: var(--color-sage-400);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border-radius: var(--radius-full);
}
.detail-tag--nsfw {
  background: color-mix(in oklch, var(--color-nsfw) 7%, transparent);
  color: var(--color-nsfw);
  border-color: color-mix(in oklch, var(--color-nsfw) 12%, transparent);
}
.detail-tag--trait {
  background: color-mix(in oklch, var(--color-sage-600) 10%, transparent);
  color: var(--color-sage-600);
  border-color: color-mix(in oklch, var(--color-sage-600) 15%, transparent);
}

/* ══════════════════════════════════════════════════════════════
   BODY PARTS — grid, cards, meters
   ══════════════════════════════════════════════════════════════ */
.bp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
}
.bp-card {
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-nsfw) 2.5%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-nsfw) 8%, transparent);
  transition: border-color var(--duration-fast);
}
.bp-card:hover {
  border-color: color-mix(in oklch, var(--color-nsfw) 20%, transparent);
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-nsfw) 6%, transparent);
}
.bp-head {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text-bone);
  display: flex;
  align-items: center;
  gap: 4px;
}
.bp-mark {
  font-size: 0.65rem;
  color: var(--color-nsfw);
  opacity: 0.8;
}
.bp-view-toggle {
  margin-left: auto;
  font-size: 0.6rem;
  color: var(--color-nsfw);
  background: transparent;
  border: 1px solid color-mix(in oklch, var(--color-nsfw) 30%, transparent);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.bp-view-toggle:hover {
  background: color-mix(in oklch, var(--color-nsfw) 10%, transparent);
}
.bp-image :deep(.img-display) {
  width: 100%;
  height: auto;
  aspect-ratio: 3/4;
  border-radius: var(--radius-md);
  margin: 4px 0;
}
.bp-desc {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  margin: 3px 0 6px;
  line-height: 1.4;
}
.bp-meters {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bp-meter {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.62rem;
  color: var(--color-text-secondary);
}
.bp-bar {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in oklch, var(--color-text-bone) 6%, transparent);
  overflow: hidden;
}
.bp-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--color-nsfw);
  transition: width 0.3s;
}
.bp-fill--dev {
  background: var(--color-sage-600);
}

/* ── Portrait display ── */
/* ── Portrait gallery — character showcase at bottom of main column ── */
.portrait-gallery {
  animation: portrait-enter 600ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)) both;
}
@keyframes portrait-enter {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.portrait-frame {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  background: var(--color-surface);
  box-shadow: var(--glass-shadow);
  transition: box-shadow var(--duration-normal) var(--ease-out);
}
.portrait-frame:hover {
  box-shadow: var(--glass-shadow), var(--lumi-inset-highlight);
}
.portrait-image :deep(.img-display) {
  width: 100%;
  height: auto;
  min-height: 300px;
  max-height: 600px;
  border-radius: 0;
  object-fit: cover;
  transition: transform 800ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
}
.portrait-frame:hover .portrait-image :deep(.img-display) {
  transform: scale(1.03);
}
.portrait-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    ellipse at 50% 30%,
    transparent 50%,
    color-mix(in oklch, var(--color-bg) 60%, transparent) 100%
  );
  box-shadow: inset 0 -48px 40px -24px var(--color-bg);
}

/* ══════════════════════════════════════════════════════════════
   SHARED — hints, empty states
   ══════════════════════════════════════════════════════════════ */
.hint {
  font-size: 0.78rem;
  opacity: 0.35;
  margin: 0;
}
.hint--center {
  text-align: center;
  padding: 20px 0;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  color: var(--color-text-secondary);
  font-size: 0.88rem;
}

/* ══════════════════════════════════════════════════════════════
   EDIT MODAL — form elements
   ══════════════════════════════════════════════════════════════ */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 68vh;
  overflow-y: auto;
  padding-right: 4px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: color-mix(in oklch, var(--color-text-bone) 2%, transparent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.form-section-title {
  margin: 0 0 2px;
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.form-section-title--nsfw {
  color: var(--color-nsfw);
}

.form-row {
  display: flex;
  gap: 10px;
}
.form-group--half {
  flex: 1;
  min-width: 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-group--row {
  flex-direction: row;
  gap: 16px;
  flex-wrap: wrap;
}

.form-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.form-input,
.form-textarea {
  padding: 8px 12px;
  font-size: 0.85rem;
  color: var(--color-text-bone);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--duration-fast) ease;
  font-family: inherit;
}
.form-input:focus,
.form-textarea:focus {
  border-color: var(--color-sage-400);
}

.form-textarea {
  resize: vertical;
  min-height: 60px;
}

.form-range {
  width: 100%;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: color-mix(in oklch, var(--color-text-bone) 8%, transparent);
  border-radius: 2px;
  outline: none;
}
.form-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-nsfw);
  cursor: pointer;
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-nsfw) 40%, transparent);
}
.form-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: var(--color-nsfw);
  cursor: pointer;
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-nsfw) 40%, transparent);
}
.form-range::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in oklch, var(--color-text-bone) 8%, transparent);
}
.form-range:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

.form-hint {
  display: block;
  margin-top: 4px;
  font-size: 0.72rem;
  color: var(--color-text-muted);
  line-height: 1.4;
}

/* ── NSFW form nested blocks ── */
.nested-block {
  margin-top: 14px;
  padding: 12px 12px 10px;
  background: color-mix(in oklch, var(--color-nsfw) 4%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-nsfw) 18%, transparent);
  border-radius: var(--radius-md);
}
.nested-title {
  margin: 0 0 8px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-nsfw);
  letter-spacing: 0.04em;
}

/* ── Body part edit cards ── */
.bp-edit-card {
  margin-top: 10px;
  padding: 10px 12px;
  background: color-mix(in oklch, var(--color-text-bone) 2%, transparent);
  border: 1px solid var(--color-border);
  border-radius: 7px;
}
.bp-edit-card--extra {
  border-style: dashed;
}
.bp-edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.bp-edit-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text-bone);
}
.bp-edit-name--fixed {
  color: var(--color-nsfw);
}
.bp-edit-badge {
  font-size: 0.64rem;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-nsfw) 12%, transparent);
  color: var(--color-nsfw);
  letter-spacing: 0.05em;
}
.bp-name-input {
  flex: 1;
  font-size: 0.85rem;
}
.bp-remove-btn {
  padding: 3px 10px;
  font-size: 0.72rem;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast), border-color var(--duration-fast), background var(--duration-fast);
}
.bp-remove-btn:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
  background: color-mix(in oklch, var(--color-danger) 6%, transparent);
}
.bp-add-btn {
  margin-top: 12px;
}

/* ── Tag list ── */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 26px;
  padding: 4px 0;
}
.tag-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 0.78rem;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 28%, transparent);
  border-radius: 12px;
  font-weight: 500;
}
.tag-delete {
  background: none;
  border: none;
  color: var(--color-sage-400);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  opacity: 0.7;
  transition: opacity var(--duration-fast) ease;
}
.tag-delete:hover {
  opacity: 1;
  color: var(--color-danger);
}
.tag-empty {
  font-size: 0.76rem;
  color: var(--color-text-secondary);
  opacity: 0.5;
  font-style: italic;
}
.tag-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tag-input {
  flex: 1;
}

/* ── Memory list (edit modal) ── */
.memory-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  padding-right: 4px;
}
.memory-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: 5px;
}
.memory-text {
  flex: 1;
  font-size: 0.78rem;
  color: var(--color-text-bone);
  line-height: 1.45;
}
.memory-delete {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 3px;
  opacity: 0.5;
  transition: all var(--duration-fast) ease;
  flex-shrink: 0;
}
.memory-delete:hover {
  opacity: 1;
  color: var(--color-danger);
}
.memory-empty {
  font-size: 0.76rem;
  color: var(--color-text-secondary);
  opacity: 0.5;
  font-style: italic;
  text-align: center;
  padding: 10px;
}

/* ══════════════════════════════════════════════════════════════
   BUTTONS
   ══════════════════════════════════════════════════════════════ */
.btn-primary {
  padding: 6px 16px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone);
  background: var(--color-sage-400);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--duration-fast) ease;
}
.btn-primary:hover {
  background: var(--color-sage-300);
}

.btn-secondary {
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text-bone) 4%, transparent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast) ease;
}
.btn-secondary:hover {
  color: var(--color-text-bone);
  border-color: var(--color-sage-400);
}

.btn-danger {
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-danger);
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 25%, transparent);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast) ease;
}
.btn-danger:hover {
  background: var(--color-danger);
  color: var(--color-text-bone);
}

.btn-sm {
  padding: 6px 14px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast) ease;
}
.btn-sm:hover {
  background: var(--color-sage-400);
  color: var(--color-text-bone);
}

/* ─── Mobile: master-detail stack ─── */
@media (max-width: 767px) {
  .rel-layout {
    flex-direction: column;
    padding-left: 0;
    padding-right: 0;
    transition: none;
  }
  .rel-roster {
    width: 100%;
    min-width: 0;
    border-right: none;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .rel-detail {
    flex: 0;
    overflow: hidden;
  }
  /* When an NPC is selected, detail-empty is replaced by actual content.
     Use :has() to auto-expand — supported iOS 15.4+ / Chrome 105+.
     Fallback: detail stays collapsed, user taps NPC name to navigate. */
  .rel-detail:has(.rd-hero) {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--color-border);
  }
  .detail-empty {
    display: none;
  }
  .rd-action-btn {
    min-height: 44px;
    font-size: 0.78rem;
  }
  .edit-form {
    max-height: calc(100dvh - 200px);
  }
  /* Story 2: mobile touch targets */
  .btn-add { min-width: 44px; min-height: 44px; }
  .btn-secondary { min-height: 44px; }
  .btn-primary { min-height: 44px; }
  .btn-danger { min-height: 44px; }
  .form-input { height: 44px; }
  .form-textarea { min-height: 44px; }
  .network-row { flex-direction: column; }
  .summary-entry .form-input { height: 44px; }
}

@media (hover: none) and (pointer: coarse) {
  .rd-detail .edit-icon { opacity: 0.5; }
  .npc-name:active { background: rgba(163, 190, 140, 0.08); }
}

/* ── Story 2: Relationship Network rows ── */
.network-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.network-input {
  flex: 1;
  min-width: 0;
}

/* ── Story 2: Memory Summary entries ── */
.summary-entry {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
}

/* ── Story 2: D26 hint style ── */
.form-hint--d26 {
  color: var(--color-sage-400);
  font-style: italic;
  font-size: 0.72rem;
  padding: 4px 8px;
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
  border-radius: var(--radius-sm);
  display: block;
  margin-top: 4px;
}

/* ── Story 2: Delete impact dialog ── */
.delete-impact {
  font-size: 0.84rem;
  color: var(--color-text-bone);
}
.impact-list {
  list-style: disc;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.impact-refs {
  color: var(--color-warning);
  font-weight: 500;
}
</style>
