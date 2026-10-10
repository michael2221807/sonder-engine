<script setup lang="ts">
/**
 * Engram 记忆增强设置区 — SettingsPanel 的折叠子节
 *
 * 展示并持久化 EngramConfig 的所有配置项。
 * 每次用户修改时立即写入 localStorage（aga_engram_config），
 * EngramManager 在下一回合调用时会读取最新配置，无需重启游戏。
 *
 * 功能区：
 * - 主开关（enabled）
 * - 检索模式（retrievalMode: legacy / hybrid）
 * - 向量嵌入配置（embedding: enabled / topK / minScore）
 * - 重排序配置（rerank: enabled / topN）
 * - 事件修剪配置（trim: trigger / countLimit / tokenLimit / keepRecent）
 * - 杂项（pruneToImportantNpcs / maxEntities / debug）
 *
 * 对应 Phase E.4.1 — see docs/history/parity-impl-plan-addendum.md
 */
import { ref, watch, onMounted, computed } from 'vue';
import { loadEngramConfig, saveEngramConfig } from '@/engine/memory/engram/engram-config';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import type { EngramConfig } from '@/engine/memory/engram/engram-types';
// App doc: docs/user-guide/pages/home.md §1.3.2 § Engram 记忆增强

const props = defineProps<{
  /** The settings search matched this section: open the fold so the matching rows show. */
  forceExpanded?: boolean;
}>();

// ─── State ───

const apiStore = useAPIManagementStore();

// 2026-04-11 fix：默认展开 Engram 设置区。
// 原版默认 `false` 导致折叠标题栏下的主开关 + 所有配置都隐藏，用户（尤其是
// 在较长的 SettingsPanel 中滚动到底部时）经常把折叠栏认成"静态标签"，以为
// Engram 开关根本不存在。默认展开后主开关立即可见，避免此困惑。
const expanded = ref(true);
const config = ref<EngramConfig>(loadEngramConfig());

watch(() => props.forceExpanded, (open) => {
  if (open) expanded.value = true;
});

// ─── Read-only API assignment display ───

const embeddingApiName = computed(() => {
  const api = apiStore.getAPIForType('embedding');
  return api ? api.id : null;
});

const rerankApiName = computed(() => {
  const api = apiStore.getAPIForType('rerank');
  return api ? api.id : null;
});

// ─── Persistence ───

onMounted(() => {
  config.value = loadEngramConfig();
});

watch(config, () => {
  saveEngramConfig(config.value);
}, { deep: true });
</script>

<template>
  <div class="engram-section">
    <!-- ── 折叠标题栏 ── -->
    <button class="engram-header" @click="expanded = !expanded">
      <span class="engram-title">{{ $t('settings.engram.sectionTitle') }}</span>
      <span class="engram-status-badge" :class="config.enabled ? 'badge--on' : 'badge--off'">
        {{ config.enabled ? $t('settings.engram.statusOn') : $t('settings.engram.statusOff') }}
      </span>
      <span class="expand-icon">{{ expanded ? '▲' : '▼' }}</span>
    </button>

    <!-- ── 折叠内容区 ── -->
    <div v-if="expanded" class="engram-body">

      <!-- ─ 主开关 ─ -->
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">{{ $t('settings.engram.enabled.label') }}</span>
          <span class="setting-desc">{{ $t('settings.engram.enabled.desc') }}</span>
        </div>
        <button
          :class="['toggle-switch', { 'toggle-switch--on': config.enabled }]"
          @click="config.enabled = !config.enabled"
        >
          <span class="toggle-track"><span class="toggle-thumb" /></span>
        </button>
      </div>

      <!-- 主开关关闭时隐藏所有子项 -->
      <template v-if="config.enabled">

        <!-- ─ 检索模式 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.retrieval.title') }}</div>
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.retrieval.strategy.label') }}</span>
              <span class="setting-desc">
                {{ $t('settings.engram.retrieval.strategy.desc') }}
              </span>
            </div>
            <div class="radio-group">
              <label class="radio-option">
                <input
                  v-model="config.retrievalMode"
                  type="radio"
                  value="legacy"
                />
                <span>{{ $t('settings.engram.retrieval.strategy.legacy') }}</span>
              </label>
              <label class="radio-option">
                <input
                  v-model="config.retrievalMode"
                  type="radio"
                  value="hybrid"
                />
                <span>{{ $t('settings.engram.retrieval.strategy.hybrid') }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- ─ 向量嵌入 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.embedding.title') }}</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.embedding.enabled.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.embedding.enabled.desc') }}</span>
            </div>
            <button
              :class="['toggle-switch', { 'toggle-switch--on': config.embedding.enabled }]"
              @click="config.embedding.enabled = !config.embedding.enabled"
            >
              <span class="toggle-track"><span class="toggle-thumb" /></span>
            </button>
          </div>

          <div class="setting-row readonly-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.embedding.assignedApi.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.embedding.assignedApi.desc') }}</span>
            </div>
            <span class="api-badge">{{ embeddingApiName ?? $t('settings.engram.embedding.assignedApi.none') }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.embedding.topK.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.embedding.topK.desc') }}</span>
            </div>
            <input
              v-model.number="config.embedding.topK"
              type="number"
              min="1"
              max="200"
              class="number-input"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.embedding.minScore.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.embedding.minScore.desc') }}</span>
            </div>
            <div class="slider-group">
              <input
                v-model.number="config.embedding.minScore"
                type="range"
                min="0"
                max="1"
                step="0.05"
                class="range-slider"
              />
              <span class="range-value">{{ (config.embedding.minScore ?? 0).toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <!-- ─ 重排序 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.rerank.title') }}</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.rerank.enabled.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.rerank.enabled.desc') }}</span>
            </div>
            <button
              :class="['toggle-switch', { 'toggle-switch--on': config.rerank.enabled }]"
              @click="config.rerank.enabled = !config.rerank.enabled"
            >
              <span class="toggle-track"><span class="toggle-thumb" /></span>
            </button>
          </div>

          <div class="setting-row readonly-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.rerank.assignedApi.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.rerank.assignedApi.desc') }}</span>
            </div>
            <span class="api-badge">{{ rerankApiName ?? $t('settings.engram.embedding.assignedApi.none') }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.rerank.topN.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.rerank.topN.desc') }}</span>
            </div>
            <input
              v-model.number="config.rerank.topN"
              type="number"
              min="1"
              max="50"
              class="number-input"
            />
          </div>
        </div>

        <!-- ─ 检索预算 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.budget.title') }}</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.budget.maxCandidates.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.budget.maxCandidates.desc') }}</span>
            </div>
            <input
              v-model.number="config.maxCandidates"
              type="number"
              min="5"
              max="100"
              class="number-input"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.budget.shortTermWindow.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.budget.shortTermWindow.desc') }}</span>
            </div>
            <input
              v-model.number="config.shortTermWindow"
              type="number"
              min="0"
              max="20"
              class="number-input"
            />
          </div>
        </div>

        <!-- ─ 事件修剪 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.trim.title') }}</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.trim.trigger.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.trim.trigger.desc') }}</span>
            </div>
            <div class="radio-group">
              <label class="radio-option">
                <input
                  v-model="config.trim.trigger"
                  type="radio"
                  value="count"
                />
                <span>{{ $t('settings.engram.trim.trigger.count') }}</span>
              </label>
              <label class="radio-option">
                <input
                  v-model="config.trim.trigger"
                  type="radio"
                  value="token"
                />
                <span>{{ $t('settings.engram.trim.trigger.token') }}</span>
              </label>
            </div>
          </div>

          <div v-if="config.trim.trigger === 'count'" class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.trim.countLimit.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.trim.countLimit.desc') }}</span>
            </div>
            <input
              v-model.number="config.trim.countLimit"
              type="number"
              min="10"
              max="500"
              class="number-input"
            />
          </div>

          <div v-if="config.trim.trigger === 'token'" class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.trim.tokenLimit.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.trim.tokenLimit.desc') }}</span>
            </div>
            <input
              v-model.number="config.trim.tokenLimit"
              type="number"
              min="500"
              max="50000"
              step="500"
              class="number-input number-input--wide"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.trim.keepRecent.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.trim.keepRecent.desc') }}</span>
            </div>
            <input
              v-model.number="config.trim.keepRecent"
              type="number"
              min="1"
              max="100"
              class="number-input"
            />
          </div>
        </div>

        <!-- ─ 杂项 ─ -->
        <div class="sub-section">
          <div class="sub-section-title">{{ $t('settings.engram.advanced.title') }}</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.advanced.pruneToImportant.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.advanced.pruneToImportant.desc') }}</span>
            </div>
            <button
              :class="['toggle-switch', { 'toggle-switch--on': config.pruneToImportantNpcs }]"
              @click="config.pruneToImportantNpcs = !config.pruneToImportantNpcs"
            >
              <span class="toggle-track"><span class="toggle-thumb" /></span>
            </button>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.advanced.maxEntities.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.advanced.maxEntities.desc') }}</span>
            </div>
            <input
              v-model.number="config.maxEntities"
              type="number"
              min="5"
              max="200"
              class="number-input"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.advanced.debug.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.advanced.debug.desc') }}</span>
            </div>
            <button
              :class="['toggle-switch', { 'toggle-switch--on': config.debug }]"
              @click="config.debug = !config.debug"
            >
              <span class="toggle-track"><span class="toggle-thumb" /></span>
            </button>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ $t('settings.engram.advanced.knowledgeEdge.label') }}</span>
              <span class="setting-desc">{{ $t('settings.engram.advanced.knowledgeEdge.desc') }}</span>
            </div>
            <button
              :class="['toggle-switch', { 'toggle-switch--on': config.knowledgeEdgeMode === 'active' }]"
              @click="config.knowledgeEdgeMode = config.knowledgeEdgeMode === 'active' ? 'off' : 'active'"
            >
              <span class="toggle-track"><span class="toggle-thumb" /></span>
            </button>
          </div>
        </div>

      </template>
    </div>
  </div>
</template>

<style scoped>
/* ── 折叠容器 ── */
/*
 * 2026-04-11 fix (round 2)：在上一轮的 background/border 视觉对齐之上，再加
 * `flex-shrink: 0` 解决 flex 压缩陷阱。
 *
 * ### 陷阱机制
 *
 * `SettingsPanel.vue` 用 `display: flex; flex-direction: column; height: 100%;
 * overflow-y: auto;` 作为外层容器。按 CSS Flexbox 规范：
 *
 * > "By default, flex items won't shrink below their minimum content size.
 * >  **However, `overflow: hidden / scroll / auto` implicitly sets
 * >   `min-height: 0` on the item, allowing it to shrink to zero.**"
 *
 * `.engram-section` 有 `overflow: hidden`（为了裁剪 border-radius），于是它的
 * `min-height` 被隐式降为 0。当 SettingsPanel 内容总高度超过容器时，浏览器
 * 按 `flex-shrink: 1` 从可压缩项里抢空间 —— 其他 `.settings-section` 都没有
 * `overflow`，它们的 `min-height: auto` 保护着不被压，而 `.engram-section`
 * 孤零零地被压成 0 × 707 的"零高幽灵"。
 *
 * 用户在 in-game SettingsPanel 里看到的 devtools 读数就是 `div.engram-section
 * 707.67 × 0` —— 元素还在，但高度为 0，内部全部看不见。HomeView modal 的
 * 父容器链不同，碰巧没触发这种压缩所以 modal 里看起来正常。
 *
 * ### 修复
 *
 * `flex-shrink: 0` —— 明确告诉 flex 父容器：永远不要压缩本项。于是无论父级
 * 空间如何紧张，`.engram-section` 始终按内容高度显示，不会塌到 0。
 *
 * 保留 `overflow: hidden` 是必要的（裁剪 border-radius 内的子元素背景），
 * `flex-shrink: 0` 正是为了抵消这个 overflow 引入的副作用。
 */
.engram-section {
  flex-shrink: 0;
  background: color-mix(in oklch, var(--color-text-umber) 4%, transparent), linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 2%, transparent), transparent 50%);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}

/* ── 标题栏（点击展开/折叠） ── */
.engram-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}
.engram-header:hover {
  background: color-mix(in oklch, var(--color-text-umber) 5%, transparent);
}

.engram-title {
  flex: 1;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
}

.engram-status-badge {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}
.badge--on  { background: color-mix(in oklch, var(--color-success) 15%, transparent); color: var(--color-success); text-shadow: 0 0 4px color-mix(in oklch, var(--color-success) 35%, transparent); }
.badge--off { background: color-mix(in oklch, var(--color-text-umber) 10%, transparent); color: var(--color-text-secondary); }

.expand-icon {
  font-size: 0.65rem;
  color: var(--color-text-secondary);
}

/* ── 内容区 ── */
.engram-body {
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── 子节 ── */
.sub-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in oklch, var(--color-text-umber) 6%, transparent);
}

.sub-section-title {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-sage-400);
  margin-bottom: 8px;
  opacity: 0.8;
}

/* ── Setting rows（复用 SettingsPanel 样式） ── */
.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0;
  gap: 14px;
}
.setting-row + .setting-row {
  border-top: 1px solid color-mix(in oklch, var(--color-text-umber) 5%, transparent);
}
.readonly-row { opacity: 0.65; pointer-events: none; }

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.setting-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-text);
}
.setting-desc {
  font-size: 0.7rem;
  color: var(--color-text-secondary);
  line-height: 1.3;
}

/* ── 只读 API 徽章 ── */
.api-badge {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text-umber) 8%, transparent);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 3px 8px;
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Toggle switch ── */
.toggle-switch {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
}
.toggle-track {
  position: relative;
  width: 36px;
  height: 20px;
  background: color-mix(in oklch, var(--color-text-umber) 15%, transparent);
  border-radius: 10px;
  transition: background 0.2s ease;
}
.toggle-switch--on .toggle-track { background: var(--color-sage-400); }
.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--color-text-bone);
  border-radius: 50%;
  transition: transform 0.2s ease;
}
.toggle-switch--on .toggle-thumb { transform: translateX(16px); }

/* ── Radio group ── */
.radio-group {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}
.radio-option {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.82rem;
  color: var(--color-text);
  cursor: pointer;
}
.radio-option input[type="radio"] {
  accent-color: var(--color-sage-400);
  cursor: pointer;
}

/* ── Number input ── */
.number-input {
  width: 70px;
  height: 28px;
  padding: 0 8px;
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: none;
  text-align: center;
  flex-shrink: 0;
}
.number-input--wide { width: 90px; }
.number-input:focus { border-color: var(--color-sage-400); }

/* ── Range slider ── */
.slider-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.range-slider {
  width: 100px;
  accent-color: var(--color-sage-400);
  cursor: pointer;
}
.range-value {
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text);
  min-width: 34px;
  text-align: right;
}
</style>
