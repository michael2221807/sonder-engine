<script setup lang="ts">
// App doc: docs/user-guide/pages/game-prompt-assembly.md
/**
 * PromptAssemblyPanel — debug panel showing prompt assembly snapshots.
 *
 * B.5 新增：
 * - 多快照 Tab（最近10次，环形缓冲从 engine-prompt store 读取）
 * - 清除全部快照（带确认）
 * - 导出当前快照 JSON
 */
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePromptDebugStore } from '@/engine/stores/engine-prompt';
import { contentToDebugText, messagesToDebugSafe } from '@/engine/ai/content-blocks';
import { eventBus } from '@/engine/core/event-bus';
import Modal from '@/ui/components/common/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t, te } = useI18n();

const debugStore = usePromptDebugStore();

// ─── Snapshot tabs ────────────────────────────────────────────

const snapshots = computed(() => debugStore.snapshots);
const activeIndex = computed({
  get: () => debugStore.activeSnapshotIndex,
  set: (v) => { debugStore.activeSnapshotIndex = v; },
});

const activeSnapshot = computed(() => snapshots.value[activeIndex.value] ?? null);
const hasData = computed(() => snapshots.value.length > 0);

// ─── Current snapshot data ────────────────────────────────────

const flowId = computed(() => activeSnapshot.value?.flowId ?? '');
const messages = computed(() => activeSnapshot.value?.messages ?? []);
const variables = computed(() => activeSnapshot.value?.variables ?? {});
const messageSources = computed(() => activeSnapshot.value?.messageSources ?? []);

// ─── Context Compiler trace (split-gen step2 only, 2026-09-04) ──
// Answers "why is X not in this request?" — the compiler projected / stripped
// it and recorded before→after tokens. Reasons are i18n keys emitted by the
// engine (`compiler.reason.*`); targets are state paths or well-known names.
const compileTrace = computed(() => activeSnapshot.value?.compileTrace ?? null);
function compileTargetLabel(target: string): string {
  const key = `promptAssembly.compile.target.${target}`;
  return te(key) ? t(key) : target;
}
/** One-line tooltip for the action badge: the entry's structured counts, labelled. */
function compileDetailText(detail: Record<string, number | boolean> | undefined): string {
  if (!detail) return '';
  return Object.entries(detail)
    .map(([k, v]) => {
      const key = `promptAssembly.compile.detail.${k}`;
      const label = te(key) ? t(key) : k;
      return `${label} ${typeof v === 'boolean' ? (v ? '✓' : '✗') : v.toLocaleString()}`;
    })
    .join(' · ');
}

// ─── Per-snapshot CoT (replaces old global "AI 推理历史" section) ──
// 2026-04-19: thinking is now attached to each snapshot via
// `ui:debug-prompt-response`. Different flows (mainRound / split-gen /
// image:imageCharacterTokenizer / image:imageSceneJudgeTokenizer / etc.)
// each carry their own CoT so the user can see "what the model reasoned
// about FOR THIS CALL" rather than a conflated global ring.
const thinkingText = computed(() => activeSnapshot.value?.thinking ?? '');
const rawResponseText = computed(() => activeSnapshot.value?.rawResponse ?? '');
const cotOpen = ref(true);
const rawOpen = ref(false);
watch(activeIndex, () => {
  cotOpen.value = true;
  rawOpen.value = false;
});

// ─── Snapshot metadata (breakdown by source, round info, etc.) ──
// Helps answer "what pieces are in this request?" without forcing the user
// to open every message manually.
interface SourceBreakdownRow {
  tag: string;
  count: number;
  display: SourceDisplay;
}
const sourceBreakdown = computed<SourceBreakdownRow[]>(() => {
  const tally = new Map<string, number>();
  for (const tag of messageSources.value) {
    const key = tag || '—';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  // Stable order: module/builder first, then history, then misc
  const orderOf = (t: string): number => {
    if (t.startsWith('module:') || t.startsWith('builder:')) return 0;
    if (t === 'short_term_memory') return 1;
    if (t.startsWith('history:')) return 2;
    if (t === 'current_input') return 3;
    return 4;
  };
  return Array.from(tally.entries())
    .map(([tag, count]) => ({ tag, count, display: parseSourceTag(tag) }))
    .sort((a, b) => orderOf(a.tag) - orderOf(b.tag) || a.tag.localeCompare(b.tag));
});

const capturedAt = computed(() => activeSnapshot.value?.capturedAt ?? '');
const roundNumber = computed(() => activeSnapshot.value?.roundNumber);
const generationIdLabel = computed(() => activeSnapshot.value?.generationId ?? '');

// ─── Token estimation ─────────────────────────────────────────

function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/g) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}

// \u591a\u6a21\u6001\u6d88\u606f\uff08\u56fe\u7247\u63d0\u70bc epic\uff09\uff1a\u56fe\u7247\u5757\u6e32\u67d3\u4e3a [\u56fe\u7247 \u2026] \u5360\u4f4d\uff0c\u4e0d\u5c55\u793a base64
function messageText(msg: { content: string | import('@/engine/ai/types').AIContentBlock[] }): string {
  return contentToDebugText(msg.content);
}

const totalTokens = computed(() => {
  return messages.value.reduce((sum, msg) => sum + estimateTokens(messageText(msg)), 0);
});

const perMessageTokens = computed(() => {
  return messages.value.map((msg) => estimateTokens(messageText(msg)));
});

// ─── Collapsible sections ─────────────────────────────────────

const collapsedMessages = ref<Set<number>>(new Set());

// Reset collapsed state when switching snapshot
watch(activeIndex, () => { collapsedMessages.value = new Set(); });

function toggleMessage(index: number): void {
  if (collapsedMessages.value.has(index)) {
    collapsedMessages.value.delete(index);
  } else {
    collapsedMessages.value.add(index);
  }
}

function isMessageOpen(index: number): boolean {
  return !collapsedMessages.value.has(index);
}

function expandAll(): void { collapsedMessages.value = new Set(); }
function collapseAll(): void {
  collapsedMessages.value = new Set(messages.value.map((_, i) => i));
}

// ─── Variables section ────────────────────────────────────────

const showVariables = ref(false);
const variableEntries = computed(() => {
  return Object.entries(variables.value).map(([key, value]) => ({ key, value }));
});

// ─── Snapshot tab label ───────────────────────────────────────

function snapshotLabel(idx: number): string {
  const s = snapshots.value[idx];
  if (!s) return `#${idx + 1}`;
  const time = new Date(s.capturedAt).toLocaleTimeString('zh-CN', { hour12: false });
  return `#${idx + 1} ${time}`;
}

// ─── Clear snapshots ──────────────────────────────────────────

const showClearConfirm = ref(false);

function clearAll(): void {
  debugStore.clearSnapshots();
  showClearConfirm.value = false;
  eventBus.emit('ui:toast', { type: 'info', message: t('promptAssembly.toast.snapshotsCleared'), duration: 1500 });
}

// ─── Export current snapshot ──────────────────────────────────

function exportSnapshot(): void {
  if (!activeSnapshot.value) return;
  // 导出与屏显同源：图片块以占位符出现，base64 不落文件
  const safeSnapshot = {
    ...activeSnapshot.value,
    messages: messagesToDebugSafe(activeSnapshot.value.messages ?? []),
  };
  const blob = new Blob([JSON.stringify(safeSnapshot, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prompt-snapshot-${activeIndex.value + 1}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Copy to clipboard ────────────────────────────────────────

function copyToClipboard(): void {
  // 复制与屏显同源：图片块以占位符出现，base64 不进剪贴板
  const data = JSON.stringify(messagesToDebugSafe(messages.value), null, 2);
  navigator.clipboard.writeText(data).then(() => {
    eventBus.emit('ui:toast', { type: 'success', message: t('promptAssembly.toast.jsonCopied'), duration: 1200 });
  }).catch(() => {});
}

// ─── Role styling ─────────────────────────────────────────────

function roleColor(role: string): string {
  switch (role) {
    case 'system': return 'var(--color-warning, #f59e0b)';
    case 'user': return 'var(--color-primary, #6366f1)';
    case 'assistant': return 'var(--color-success, #22c55e)';
    default: return 'var(--color-text-secondary, #8888a0)';
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case 'system': return 'SYSTEM';
    case 'user': return 'USER';
    case 'assistant': return 'ASSISTANT';
    default: return role.toUpperCase();
  }
}

// ─── Message source tag 解析（2026-04-14 新增） ─────────────────
//
// 每条消息的出处标签由 prompt-assembler + context-assembly 生成并存入快照：
//   - `module:<promptId>`    → prompt flow 的某个模块（mainRound / core / ...）
//   - `history:user`         → 来自 narrativeHistory 的用户对话
//   - `history:assistant`    → 来自 narrativeHistory 的 AI 叙事
//   - `current_input`        → 当前回合用户输入（含 narratorEnforcement 前缀）
//   - `placeholder`          → Gemini 系统消息兜底占位

interface SourceDisplay {
  /** 展示用短文案 */
  label: string;
  /** 主色（CSS color） */
  color: string;
  /** 补充说明，tooltip 里显示 */
  tooltip: string;
}

/** Map builder piece IDs to i18n keys */
const BUILDER_I18N_MAP: Record<string, string> = {
  narrative_contract: 'promptAssembly.builder.narrativeContract',
  ai_role: 'promptAssembly.builder.aiRole', world_prompt: 'promptAssembly.builder.worldPrompt',
  world_map: 'promptAssembly.builder.worldMap', npc_away: 'promptAssembly.builder.npcAway',
  other_prompts: 'promptAssembly.builder.otherPrompts', write_style: 'promptAssembly.builder.writeStyle',
  write_anti_cliche: 'promptAssembly.builder.writeAntiCliche',
  write_emotion_guard: 'promptAssembly.builder.writeEmotionGuard', write_no_control: 'promptAssembly.builder.writeNoControl',
  perspective_prompt: 'promptAssembly.builder.perspectivePrompt', length_prompt: 'promptAssembly.builder.lengthPrompt',
  memory_long: 'promptAssembly.builder.memoryLong', memory_mid: 'promptAssembly.builder.memoryMid',
  memory_implicit: 'promptAssembly.builder.memoryImplicit', memory_engram: 'promptAssembly.builder.memoryEngram',
  story_plan: 'promptAssembly.builder.storyPlan', npc_present: 'promptAssembly.builder.npcPresent',
  heroine_plan: 'promptAssembly.builder.heroinePlan', state_world: 'promptAssembly.builder.stateWorld',
  state_environment: 'promptAssembly.builder.stateEnvironment', state_role: 'promptAssembly.builder.stateRole',
  state_tasks: 'promptAssembly.builder.stateTasks', state_agreements: 'promptAssembly.builder.stateAgreements',
  narrative_constraints: 'promptAssembly.builder.narrativeConstraints', extra_prompt: 'promptAssembly.builder.extraPrompt',
  format_prompt: 'promptAssembly.builder.formatPrompt', cot_core: 'promptAssembly.builder.cotCore',
  cot_judge: 'promptAssembly.builder.cotJudge', player_input: 'promptAssembly.builder.playerInput',
  start_task: 'promptAssembly.builder.startTask', cot_masquerade: 'promptAssembly.builder.cotMasquerade',
  bodyPolish_system: 'promptAssembly.builder.bodyPolishSystem', bodyPolish_user: 'promptAssembly.builder.bodyPolishUser',
};

function parseSourceTag(tag: string | undefined): SourceDisplay {
  if (!tag) {
    return { label: '—', color: 'var(--color-text-secondary, #8888a0)', tooltip: t('promptAssembly.source.noInfo') };
  }
  if (tag.startsWith('module:')) {
    const id = tag.slice('module:'.length);
    return {
      label: id,
      color: '#f59e0b',
      tooltip: t('promptAssembly.source.promptModule', { id }),
    };
  }
  if (tag.startsWith('builder:')) {
    const pieceId = tag.slice('builder:'.length);
    const i18nKey = BUILDER_I18N_MAP[pieceId];
    const label = i18nKey ? t(i18nKey) : pieceId;
    return {
      label,
      color: '#8b5cf6',
      tooltip: t('promptAssembly.source.contextPiece', { label }),
    };
  }
  if (tag === 'short_term_memory') {
    return {
      label: t('promptAssembly.source.shortTermMemory'),
      color: '#06b6d4',
      tooltip: t('promptAssembly.source.shortTermMemoryTooltip'),
    };
  }
  if (tag === 'history:user') {
    return {
      label: t('promptAssembly.source.historyUser'),
      color: '#6366f1',
      tooltip: t('promptAssembly.source.historyUserTooltip'),
    };
  }
  if (tag === 'history:assistant') {
    return {
      label: t('promptAssembly.source.historyAssistant'),
      color: '#22c55e',
      tooltip: t('promptAssembly.source.historyAssistantTooltip'),
    };
  }
  if (tag === 'current_input') {
    return {
      label: t('promptAssembly.source.currentInput'),
      color: '#ec4899',
      tooltip: t('promptAssembly.source.currentInputTooltip'),
    };
  }
  if (tag === 'placeholder') {
    return {
      label: t('promptAssembly.source.placeholder'),
      color: '#64748b',
      tooltip: t('promptAssembly.source.placeholderTooltip'),
    };
  }
  if (tag === 'step1_thinking_context') {
    return {
      label: t('promptAssembly.source.step1Thinking'),
      color: '#a855f7',
      tooltip: t('promptAssembly.source.step1ThinkingTooltip'),
    };
  }
  if (tag === 'step1_response') {
    return {
      label: t('promptAssembly.source.step1Response'),
      color: '#14b8a6',
      tooltip: t('promptAssembly.source.step1ResponseTooltip'),
    };
  }
  if (tag === 'step2_followup') {
    return {
      label: t('promptAssembly.source.step2Followup'),
      color: '#f97316',
      tooltip: t('promptAssembly.source.step2FollowupTooltip'),
    };
  }
  if (tag.startsWith('tokenizer:')) {
    const sub = tag.slice('tokenizer:'.length);
    const TOKEN_I18N: Record<string, { labelKey: string; tooltipKey: string }> = {
      preset: { labelKey: 'promptAssembly.source.tokenizerPreset', tooltipKey: 'promptAssembly.source.tokenizerPresetTooltip' },
      task_context: { labelKey: 'promptAssembly.source.tokenizerTaskContext', tooltipKey: 'promptAssembly.source.tokenizerTaskContextTooltip' },
      task_data: { labelKey: 'promptAssembly.source.tokenizerTaskData', tooltipKey: 'promptAssembly.source.tokenizerTaskDataTooltip' },
      start_task: { labelKey: 'promptAssembly.source.tokenizerStartTask', tooltipKey: 'promptAssembly.source.tokenizerStartTaskTooltip' },
    };
    const entry = TOKEN_I18N[sub];
    if (entry) {
      return { label: t(entry.labelKey), color: '#84cc16', tooltip: t(entry.tooltipKey) };
    }
    return { label: sub, color: '#84cc16', tooltip: `tokenizer:${sub}` };
  }
  return { label: tag, color: 'var(--color-text-secondary, #8888a0)', tooltip: tag };
}

function sourceFor(index: number): SourceDisplay {
  return parseSourceTag(messageSources.value[index]);
}

// ─── Memory block 段落识别（记忆子类出处高亮） ─────────────────
//
// `module:mainRound` 的消息里嵌了 `{{MEMORY_BLOCK}}` 变量（memory-retriever /
// unified-retriever 产出），包含四层记忆 + Engram 子段。通过 markdown 级别的
// header 判断每一行来自哪个子源：
//   - `### 长期记忆…`         → long_term
//   - `### 中期记忆…`         → mid_term
//   - `### 隐式记忆…`         → implicit_mid_term
//   - `### 短期记忆…`         → short_term
//   - `#### 相关事件记忆`     → engram_events
//   - `#### 相关角色/实体`    → engram_entities
//   - `#### 关系网络`         → engram_relations
//   - `#### 相关规则`         → engram_rules

interface MemorySegment {
  /** 当前段的分类 */
  kind: 'long_term' | 'mid_term' | 'implicit_mid_term' | 'short_term'
    | 'engram_events' | 'engram_entities' | 'engram_relations' | 'engram_rules'
    | 'none';
  /** 显示标签 */
  label: string;
  /** 主色 */
  color: string;
  /** 起止行号（闭区间 [startLine, endLine]，0-indexed） */
  startLine: number;
  endLine: number;
}

interface MemoryHeaderRule {
  pattern: RegExp;
  kind: MemorySegment['kind'];
  label: string;
  color: string;
}

/** i18n key mapping for memory segment labels */
const MEMORY_I18N_MAP: Record<MemorySegment['kind'], string> = {
  long_term: 'promptAssembly.memory.longTerm',
  mid_term: 'promptAssembly.memory.midTerm',
  implicit_mid_term: 'promptAssembly.memory.implicitMidTerm',
  short_term: 'promptAssembly.memory.shortTerm',
  engram_events: 'promptAssembly.memory.engramEvents',
  engram_entities: 'promptAssembly.memory.engramEntities',
  engram_relations: 'promptAssembly.memory.engramRelations',
  engram_rules: 'promptAssembly.memory.engramRules',
  none: '',
};

const MEMORY_HEADER_RULES: MemoryHeaderRule[] = [
  { pattern: /^###\s*长期记忆/, kind: 'long_term', label: '', color: '#8b5cf6' },
  { pattern: /^###\s*中期记忆/, kind: 'mid_term', label: '', color: '#0ea5e9' },
  { pattern: /^###\s*隐式记忆/, kind: 'implicit_mid_term', label: '', color: '#06b6d4' },
  { pattern: /^###\s*短期记忆/, kind: 'short_term', label: '', color: '#22c55e' },
  { pattern: /^####\s*相关事件记忆/, kind: 'engram_events', label: '', color: '#f97316' },
  { pattern: /^####\s*相关角色\/实体/, kind: 'engram_entities', label: '', color: '#d946ef' },
  { pattern: /^####\s*关系网络/, kind: 'engram_relations', label: '', color: '#ec4899' },
  { pattern: /^####\s*相关规则/, kind: 'engram_rules', label: '', color: '#eab308' },
];

/**
 * 从消息文本中提取记忆子段（仅对 system 模块消息有效）。
 * 返回所有检测到的 markdown header 段落及其起止行号。
 */
function detectMemorySegments(content: string): MemorySegment[] {
  const lines = content.split('\n');
  const segments: MemorySegment[] = [];

  // 先找到所有 header 行 + 对应 kind
  const headers: Array<{ line: number; rule: MemoryHeaderRule }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of MEMORY_HEADER_RULES) {
      if (rule.pattern.test(lines[i])) {
        headers.push({ line: i, rule });
        break;
      }
    }
  }

  // 每个 header 的结束行 = 下一个 header 的前一行，或文件末尾
  for (let idx = 0; idx < headers.length; idx++) {
    const { line, rule } = headers[idx];
    const endLine = idx + 1 < headers.length ? headers[idx + 1].line - 1 : lines.length - 1;
    segments.push({
      kind: rule.kind,
      label: MEMORY_I18N_MAP[rule.kind] ? t(MEMORY_I18N_MAP[rule.kind]) : rule.kind,
      color: rule.color,
      startLine: line,
      endLine,
    });
  }

  return segments;
}

function memorySegmentsFor(index: number): MemorySegment[] {
  const msg = messages.value[index];
  if (!msg || msg.role !== 'system') return [];
  return detectMemorySegments(messageText(msg));
}
</script>

<template>
  <div class="assembly-panel">
    <header class="panel-header">
      <h2 class="panel-title">{{ $t('promptAssembly.title') }}</h2>
      <div class="header-actions">
        <AgaButton variant="secondary" size="sm" :disabled="!hasData" @click="exportSnapshot">{{ $t('promptAssembly.exportSnapshot') }}</AgaButton>
        <AgaButton variant="danger" size="sm" :disabled="!hasData" @click="showClearConfirm = true">{{ $t('promptAssembly.clearAll') }}</AgaButton>
      </div>
    </header>

    <template v-if="hasData">
      <!-- ─── Snapshot tabs (only visible when multiple) ─── -->
      <div v-if="snapshots.length > 1" class="snapshot-tabs">
        <button
          v-for="(_, idx) in snapshots"
          :key="idx"
          :class="['snapshot-tab', { 'snapshot-tab--active': activeIndex === idx }]"
          @click="activeIndex = idx"
        >
          {{ snapshotLabel(idx) }}
        </button>
      </div>

      <!-- ─── Summary bar ─── -->
      <div class="summary-bar">
        <div class="summary-item">
          <span class="summary-label">Flow</span>
          <span class="summary-value summary-value--mono">{{ flowId || '—' }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">{{ $t('promptAssembly.info.messages') }}</span>
          <span class="summary-value summary-value--mono">{{ messages.length }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">{{ $t('promptAssembly.info.tokens') }}</span>
          <span class="summary-value summary-value--mono">~{{ totalTokens.toLocaleString() }}</span>
        </div>
        <div v-if="thinkingText" class="summary-item">
          <span class="summary-label">CoT</span>
          <span class="summary-value summary-value--mono" style="color: var(--color-sage-400)">{{ $t('promptAssembly.info.hasCot') }}</span>
        </div>
      </div>

      <!-- ─── Snapshot meta (round, time, generationId) ─── -->
      <div class="snapshot-meta">
        <span v-if="roundNumber !== undefined" class="snapshot-meta-chip">Round {{ roundNumber }}</span>
        <span v-if="capturedAt" class="snapshot-meta-chip">{{ new Date(capturedAt).toLocaleString() }}</span>
        <span v-if="generationIdLabel" class="snapshot-meta-chip snapshot-meta-chip--mono">gen: {{ generationIdLabel }}</span>
      </div>

      <!-- ─── Source breakdown (what pieces are in this request?) ─── -->
      <section v-if="sourceBreakdown.length > 0" class="source-breakdown">
        <div class="source-breakdown-header">{{ $t('promptAssembly.source.breakdown', { count: messages.length }) }}</div>
        <div class="source-breakdown-list">
          <Tooltip
            v-for="row in sourceBreakdown"
            :key="row.tag"
            :text="row.display.tooltip"
          >
            <span
              class="source-breakdown-chip"
              :style="{ color: row.display.color, borderColor: row.display.color + '55', background: row.display.color + '14' }"
            >
              {{ row.display.label }}
              <span class="source-breakdown-count">×{{ row.count }}</span>
            </span>
          </Tooltip>
        </div>
      </section>

      <!-- ─── Context Compiler trace (what step2 did NOT get, and why) ─── -->
      <section
        v-if="compileTrace && compileTrace.entries.length > 0"
        class="compile-trace"
        data-testid="prompt-compile-trace"
      >
        <div class="compile-trace-header">
          <Tooltip :text="$t('promptAssembly.compile.tooltip')">
            <span class="compile-trace-title">{{ $t('promptAssembly.compile.title') }}</span>
          </Tooltip>
          <span class="compile-trace-saved">{{ $t('promptAssembly.compile.saved', { tokens: compileTrace.savedTokens.toLocaleString() }) }}</span>
        </div>
        <ul class="compile-trace-list">
          <li v-for="(entry, i) in compileTrace.entries" :key="`${entry.target}-${i}`" class="compile-trace-row">
            <Tooltip :text="compileDetailText(entry.detail)" :disabled="!entry.detail">
              <span class="compile-trace-action" :data-action="entry.action">{{ $t(`promptAssembly.compile.action.${entry.action}`) }}</span>
            </Tooltip>
            <span class="compile-trace-target">{{ compileTargetLabel(entry.target) }}</span>
            <span class="compile-trace-reason">{{ $t(entry.reason) }}</span>
            <span class="compile-trace-tokens">{{ $t('promptAssembly.compile.tokens', { before: entry.before.toLocaleString(), after: entry.after.toLocaleString() }) }}</span>
          </li>
        </ul>
      </section>

      <!-- ─── Per-snapshot CoT (thinking) ─── -->
      <section v-if="thinkingText" class="snapshot-cot">
        <button class="snapshot-cot-header" @click="cotOpen = !cotOpen">
          <span class="snapshot-cot-title">{{ $t('promptAssembly.cot.title') }}</span>
          <span class="snapshot-cot-flow-chip">{{ flowId }}</span>
          <span class="snapshot-cot-chevron">{{ cotOpen ? '▾' : '▸' }}</span>
        </button>
        <pre v-if="cotOpen" class="snapshot-cot-content">{{ thinkingText }}</pre>
      </section>

      <!-- ─── Raw response (debug-only, hidden by default) ─── -->
      <section v-if="rawResponseText" class="snapshot-raw">
        <button class="snapshot-raw-header" @click="rawOpen = !rawOpen">
          <span class="snapshot-raw-title">{{ $t('promptAssembly.raw.title') }}</span>
          <span class="snapshot-cot-chevron">{{ rawOpen ? '▾' : '▸' }}</span>
        </button>
        <pre v-if="rawOpen" class="snapshot-raw-content">{{ rawResponseText }}</pre>
      </section>

      <!-- ─── Toolbar ─── -->
      <div class="toolbar">
        <AgaButton variant="ghost" size="sm" @click="expandAll">{{ $t('promptAssembly.expandAll') }}</AgaButton>
        <AgaButton variant="ghost" size="sm" @click="collapseAll">{{ $t('promptAssembly.collapseAll') }}</AgaButton>
        <AgaButton variant="ghost" size="sm" @click="showVariables = !showVariables">
          {{ showVariables ? $t('promptAssembly.hideVariables') : $t('promptAssembly.showVariables') }}
        </AgaButton>
        <div style="flex: 1" />
        <AgaButton variant="secondary" size="sm" @click="copyToClipboard">{{ $t('promptAssembly.copyJson') }}</AgaButton>
      </div>

      <!-- ─── Template variables ─── -->
      <Transition name="vars-expand">
        <div v-if="showVariables" class="variables-section">
          <h3 class="section-title">{{ $t('promptAssembly.templateVariables') }}</h3>
          <div v-if="variableEntries.length" class="var-list">
            <div v-for="v in variableEntries" :key="v.key" class="var-row">
              <span class="var-key">{{ v.key }}</span>
              <span class="var-value">{{ v.value }}</span>
            </div>
          </div>
          <p v-else class="empty-hint">{{ $t('promptAssembly.noTemplateVariables') }}</p>
        </div>
      </Transition>

      <!-- ─── Messages list ─── -->
      <div class="messages-list">
        <div
          v-for="(msg, idx) in messages"
          :key="idx"
          class="message-block"
        >
          <!-- Message header (collapsible) -->
          <button
            class="message-header"
            @click="toggleMessage(idx)"
          >
            <div class="message-title-area">
              <span class="message-role" :style="{ color: roleColor(msg.role) }">
                {{ roleLabel(msg.role) }}
              </span>
              <span class="message-index">#{{ idx + 1 }}</span>
              <!-- 2026-04-14：消息来源标签 -->
              <Tooltip :text="sourceFor(idx).tooltip">
                <span
                  class="source-badge"
                  :style="{ color: sourceFor(idx).color, borderColor: sourceFor(idx).color + '55', background: sourceFor(idx).color + '14' }"
                >{{ sourceFor(idx).label }}</span>
              </Tooltip>
              <!-- 若是 system 模块 + 含记忆段，横向列出所有记忆子段 -->
              <template v-if="memorySegmentsFor(idx).length > 0">
                <span class="memory-seg-sep">·</span>
                <Tooltip
                  v-for="seg in memorySegmentsFor(idx)"
                  :key="seg.kind + seg.startLine"
                  :text="`${seg.label} (${$t('promptAssembly.memory.lineRange', { start: seg.startLine + 1, end: seg.endLine + 1 })})`"
                >
                  <span
                    class="memory-seg-chip"
                    :style="{ color: seg.color, borderColor: seg.color + '55', background: seg.color + '10' }"
                  >{{ seg.label }}</span>
                </Tooltip>
              </template>
              <span class="message-tokens">~{{ perMessageTokens[idx] }} tokens</span>
            </div>
            <svg
              :class="['chevron', { 'chevron--open': isMessageOpen(idx) }]"
              viewBox="0 0 20 20"
              fill="currentColor"
              width="14"
              height="14"
            >
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>

          <!-- Message content -->
          <Transition name="content-expand">
            <div v-if="isMessageOpen(idx)" class="message-content">
              <!-- 若含记忆段，在内容顶部显示行号导航 -->
              <div v-if="memorySegmentsFor(idx).length > 0" class="memory-seg-legend">
                <div
                  v-for="seg in memorySegmentsFor(idx)"
                  :key="'leg-' + seg.kind + seg.startLine"
                  class="memory-seg-legend-row"
                  :style="{ borderLeftColor: seg.color }"
                >
                  <span class="memory-seg-legend-dot" :style="{ background: seg.color }" />
                  <span class="memory-seg-legend-label" :style="{ color: seg.color }">{{ seg.label }}</span>
                  <span class="memory-seg-legend-range">{{ $t('promptAssembly.memory.lineRange', { start: seg.startLine + 1, end: seg.endLine + 1 }) }}</span>
                </div>
              </div>
              <pre class="message-text">{{ messageText(msg) }}</pre>
            </div>
          </Transition>
        </div>
      </div>
    </template>

    <div v-else class="empty-state">
      <div class="empty-icon">📋</div>
      <p class="empty-text">{{ $t('promptAssembly.noData') }}</p>
      <p class="empty-hint">{{ $t('promptAssembly.noDataHint') }}</p>
    </div>

    <!-- ─── Clear confirm modal ─── -->
    <Modal v-model="showClearConfirm" :title="$t('promptAssembly.clear.title')" width="360px">
      <p style="margin: 0; color: var(--color-text, #e0e0e6);">
        {{ $t('promptAssembly.clear.text', { count: snapshots.length }) }}
      </p>
      <template #footer>
        <AgaButton variant="secondary" size="sm" @click="showClearConfirm = false">{{ $t('promptAssembly.clear.cancel') }}</AgaButton>
        <AgaButton variant="danger" size="sm" @click="clearAll">{{ $t('promptAssembly.clear.confirm') }}</AgaButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* Snapshot metadata row */
.snapshot-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.snapshot-meta-chip {
  font-size: 0.7rem;
  padding: 2px 8px;
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-text-secondary, #8888a0);
}
.snapshot-meta-chip--mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.65rem;
  color: var(--color-text-muted, #55556a);
}

/* Source-breakdown card: shows at a glance WHICH pieces made up the request.
   The user complaint was "很多部件缺失" — they couldn't tell whether a given
   prompt piece (memory_long / state_world / etc.) was actually included.
   This chip row lets them see the breakdown in one scan without expanding
   each of ~20 message cards. */
.source-breakdown {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
}
.source-breakdown-header {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
  margin-bottom: 6px;
  text-transform: none;
}
.source-breakdown-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.source-breakdown-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.68rem;
  font-weight: 500;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  cursor: help;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.source-breakdown-count {
  font-weight: 400;
  opacity: 0.65;
}

/* Context Compiler trace (2026-09-04). Sits right under the source chips: the
   chips say what IS in the request, this card says what was projected or left
   out and why — the two together let the user audit the second call without
   opening every message. Same quiet surface as .source-breakdown. */
.compile-trace {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
}
.compile-trace-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.compile-trace-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
  cursor: help;
}
.compile-trace-saved {
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-300, #9fbf9a);
}
.compile-trace-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.compile-trace-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'action target tokens'
    'reason reason reason';
  column-gap: 8px;
  row-gap: 2px;
  align-items: baseline;
  font-size: 0.68rem;
}
/* The action badge is wrapped in <Tooltip> (its root span is the grid child). */
.compile-trace-row > .tt-wrap {
  grid-area: action;
}
.compile-trace-action {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  border-radius: 4px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-300, #9fbf9a);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}
.compile-trace-action[data-action='strip'] {
  border-color: color-mix(in oklch, var(--color-amber-400, #d9a441) 45%, transparent);
  color: var(--color-amber-300, #e2b968);
  background: color-mix(in oklch, var(--color-amber-400, #d9a441) 8%, transparent);
}
.compile-trace-target {
  grid-area: target;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e6e6f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compile-trace-tokens {
  grid-area: tokens;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
  white-space: nowrap;
}
.compile-trace-reason {
  grid-area: reason;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.85;
}

/* Per-snapshot CoT card. Replaces the old global 推理历史 section — the CoT
   now lives alongside the prompts that produced it, so each snapshot tab
   shows "what the model reasoned about FOR THIS CALL". */
.snapshot-cot {
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  border-radius: var(--radius-md, 8px);
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
  overflow: hidden;
}
.snapshot-cot-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: none;
  border-bottom: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  cursor: pointer;
  color: var(--color-sage-400);
  font-size: 0.82rem;
  font-weight: 600;
  transition: background 0.15s ease;
}
.snapshot-cot-header:hover { background: color-mix(in oklch, var(--color-sage-400) 14%, transparent); }
.snapshot-cot-title { letter-spacing: 0.02em; }
.snapshot-cot-flow-chip {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.68rem;
  font-weight: 500;
  padding: 1px 6px;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-radius: 3px;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}
.snapshot-cot-chevron {
  margin-left: auto;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-400);
  opacity: 0.7;
}
.snapshot-cot-content {
  margin: 0;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.76rem;
  color: var(--color-text, #e0e0e6);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.2);
}

/* Raw response — rarely-needed debug panel, collapsed by default */
.snapshot-raw {
  border: 1px dashed var(--color-border, #2a2a3a);
  border-radius: var(--radius-md, 8px);
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.snapshot-raw-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.78rem;
  font-weight: 500;
}
.snapshot-raw-header:hover { color: var(--color-text, #e0e0e6); }
.snapshot-raw-title { letter-spacing: 0.01em; }
.snapshot-raw-content {
  margin: 0;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.74rem;
  color: var(--color-text-secondary, #8888a0);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.15);
  border-top: 1px dashed var(--color-border, #2a2a3a);
}
.snapshot-cot-content::-webkit-scrollbar,
.snapshot-raw-content::-webkit-scrollbar { width: 4px; }
.snapshot-cot-content::-webkit-scrollbar-track,
.snapshot-raw-content::-webkit-scrollbar-track { background: transparent; }
.snapshot-cot-content::-webkit-scrollbar-thumb,
.snapshot-raw-content::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 2px; }

.assembly-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  gap: 6px;
}

/* ── Snapshot tabs ── */
.snapshot-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.snapshot-tab {
  padding: 4px 10px;
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--color-border-subtle);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.snapshot-tab:hover {
  color: var(--color-text);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}
.snapshot-tab--active {
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 55%, transparent);
  box-shadow: inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

/* ── Summary bar ── */
.summary-bar {
  display: flex;
  gap: 16px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.summary-label {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.summary-value {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
}

.summary-value--mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

/* ── Toolbar ── */
.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* ── Variables section ── */
.variables-section {
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary, #8888a0);
}

.var-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.var-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 0.78rem;
}

.var-key {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-primary, #6366f1);
  min-width: 100px;
  flex-shrink: 0;
}

.var-value {
  color: var(--color-text, #e0e0e6);
  word-break: break-all;
}

/* ── Messages list ── */
.messages-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-block {
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
  overflow: hidden;
}

.message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: none;
  cursor: pointer;
  color: var(--color-text, #e0e0e6);
  transition: background 0.15s ease;
}
.message-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.message-title-area {
  display: flex;
  align-items: center;
  gap: 10px;
}

.message-role {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.message-index {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
}

.message-tokens {
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.7;
  margin-left: auto;
}

/* ── 2026-04-14：消息来源标签 + 记忆子段 chip ── */

.source-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  cursor: help;
}

.memory-seg-sep {
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.4;
  margin: 0 2px;
}

.memory-seg-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 0.64rem;
  font-weight: 500;
  white-space: nowrap;
  cursor: help;
  text-shadow: 0 0 3px currentColor;
}

.memory-seg-legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.memory-seg-legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 8px;
  border-left: 3px solid transparent;
  font-size: 0.7rem;
}
.memory-seg-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.memory-seg-legend-label {
  font-weight: 600;
  min-width: 90px;
}
.memory-seg-legend-range {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.68rem;
}

.chevron {
  transition: transform 0.2s ease;
  color: var(--color-text-secondary, #8888a0);
}
.chevron--open {
  transform: rotate(0deg);
}
.chevron:not(.chevron--open) {
  transform: rotate(-90deg);
}

/* ── Message content ── */
.message-content {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.message-text {
  margin: 0;
  padding: 12px;
  font-size: 0.78rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0, 0, 0, 0.15);
  max-height: 400px;
  overflow-y: auto;
}

/* ── Transitions ── */
.content-expand-enter-active { transition: all 0.2s ease; }
.content-expand-leave-active { transition: all 0.15s ease; }
.content-expand-enter-from,
.content-expand-leave-to { opacity: 0; max-height: 0; }

.vars-expand-enter-active { transition: all 0.25s ease; }
.vars-expand-leave-active { transition: all 0.15s ease; }
.vars-expand-enter-from,
.vars-expand-leave-to { opacity: 0; }

/* ── Empty state ── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
}

.empty-icon {
  font-size: 2.5rem;
  opacity: 0.3;
}

.empty-text {
  font-size: 0.92rem;
  color: var(--color-text, #e0e0e6);
  margin: 0;
}

.empty-hint {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.6;
  text-align: center;
  margin: 0;
}

/* ── Scrollbar ── */
.assembly-panel::-webkit-scrollbar { width: 5px; }
.assembly-panel::-webkit-scrollbar-track { background: transparent; }
.assembly-panel::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

.message-text::-webkit-scrollbar { width: 4px; }
.message-text::-webkit-scrollbar-track { background: transparent; }
.message-text::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 2px; }

@media (max-width: 767px) {
  .assembly-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
}
</style>
