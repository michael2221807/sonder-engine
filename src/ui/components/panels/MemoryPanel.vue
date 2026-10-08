<script setup lang="ts">
// App doc: docs/user-guide/pages/game-memory.md
import { ref, computed, onMounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useGameState } from '@/ui/composables/useGameState';
import { useConfig } from '@/ui/composables/useConfig';
import { useLocale } from '@/ui/composables/useLocale';
import { useRoundJump } from '@/ui/composables/useRoundJump';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS, type BookmarkedRound } from '@/engine/pipeline/types';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import FormattedText from '@/ui/components/common/FormattedText.vue';

const { t } = useI18n();
const { locale } = useLocale();
const router = useRouter();
const { requestRoundJump } = useRoundJump();

const { isLoaded, useValue, setValue } = useGameState();
const { getConfig } = useConfig();

interface MemoryPathConfig {
  shortTerm: string;
  midTerm: string;
  longTerm: string;
}

const defaultMemoryPaths: MemoryPathConfig = {
  shortTerm: '记忆.短期',
  midTerm: '记忆.中期',
  longTerm: '记忆.长期',
};

const memoryConfig = computed<MemoryPathConfig>(() => {
  const cfg = getConfig<Partial<MemoryPathConfig>>('memory');
  return { ...defaultMemoryPaths, ...cfg };
});

interface MemoryEntry {
  id: string;
  content: string;
  timestamp?: string;
  tags?: string[];
  round?: number;
  [key: string]: unknown;
}

function normalizeMemoryEntries(raw: unknown): MemoryEntry[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((entry, idx) => {
      if (typeof entry === 'string') {
        return { id: `mem_${idx}`, content: entry };
      }
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        return {
          id: String(obj['id'] ?? `mem_${idx}`),
          content: String(obj['内容'] ?? obj['content'] ?? obj['记忆主体'] ?? obj['summary'] ?? JSON.stringify(obj)),
          timestamp: (() => {
            const ts = obj['时间'] ?? obj['事件时间'] ?? obj['timestamp'];
            if (typeof ts === 'number') return new Date(ts).toLocaleString(locale.value);
            return typeof ts === 'string' ? ts : undefined;
          })(),
          tags: Array.isArray(obj['标签']) ? obj['标签'] as string[] : undefined,
          round: typeof obj['round'] === 'number' ? obj['round'] : undefined,
        };
      }
      return { id: `mem_${idx}`, content: String(entry) };
    });
  }

  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([key, val]) => ({
      id: key,
      content: typeof val === 'string' ? val : JSON.stringify(val),
    }));
  }

  return [{ id: 'single', content: String(raw) }];
}

// ─── Reactive memory lists ───

const shortTermRaw = useValue<unknown>(memoryConfig.value.shortTerm);
const implicitMidTermRaw = useValue<unknown>(DEFAULT_ENGINE_PATHS.implicitMidTermMemory);
const midTermRaw = useValue<unknown>(memoryConfig.value.midTerm);
const longTermRaw = useValue<unknown>(memoryConfig.value.longTerm);

const shortTermEntries = computed(() => normalizeMemoryEntries(shortTermRaw.value));
const implicitMidTermEntries = computed(() => normalizeMemoryEntries(implicitMidTermRaw.value));
const midTermEntries = computed(() => normalizeMemoryEntries(midTermRaw.value));
const longTermEntries = computed(() => normalizeMemoryEntries(longTermRaw.value));

// ─── Narrative history ───

interface NarrativeMsg { role: string; content: string; _delta?: unknown }
const narrativeHistoryRaw = useValue<unknown>(DEFAULT_ENGINE_PATHS.narrativeHistory);
const narrativeEntries = computed<NarrativeMsg[]>(() => {
  const raw = narrativeHistoryRaw.value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is NarrativeMsg => m && typeof m === 'object' && typeof (m as NarrativeMsg).content === 'string');
});

// ─── Active tab ───

type TabKey = 'memory' | 'narrative' | 'config';
const activeTab = ref<TabKey>('memory');

// ─── Collapsible sections ───

interface TierConfig {
  key: string;
  title: string;
  hint: string;
  entries: typeof shortTermEntries;
  tierClass: string;
}

const tiers = computed<TierConfig[]>(() => [
  {
    key: 'short',
    title: t('memory.tier.short.title'),
    hint: t('memory.tier.short.hint'),
    entries: shortTermEntries,
    tierClass: 'tier--short',
  },
  {
    key: 'implicit',
    title: t('memory.tier.implicit.title'),
    hint: t('memory.tier.implicit.hint'),
    entries: implicitMidTermEntries,
    tierClass: 'tier--implicit',
  },
  {
    key: 'mid',
    title: t('memory.tier.mid.title'),
    hint: t('memory.tier.mid.hint'),
    entries: midTermEntries,
    tierClass: 'tier--mid',
  },
  {
    key: 'long',
    title: t('memory.tier.long.title'),
    hint: t('memory.tier.long.hint'),
    entries: longTermEntries,
    tierClass: 'tier--long',
  },
]);

const collapsedSections = ref<Set<string>>(new Set(['implicit', 'mid', 'long']));

function toggleSection(key: string): void {
  const next = new Set(collapsedSections.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedSections.value = next;
}

function isSectionOpen(key: string): boolean {
  return !collapsedSections.value.has(key);
}

// ─── Expanded entry ───

const expandedEntryId = ref<string | null>(null);

function toggleEntry(sectionKey: string, entryId: string): void {
  const compositeId = `${sectionKey}:${entryId}`;
  expandedEntryId.value = expandedEntryId.value === compositeId ? null : compositeId;
}

function isEntryExpanded(sectionKey: string, entryId: string): boolean {
  return expandedEntryId.value === `${sectionKey}:${entryId}`;
}

// ─── 收藏楼层 (Bookmarked rounds, 2026-07-18) ───
// Second surface for the same 元数据.收藏楼层 state the game panel manages.
// Provides read / select (→ inject next round) / rename / jump / remove.

const bookmarksRaw = useValue<BookmarkedRound[]>(DEFAULT_ENGINE_PATHS.bookmarkedRounds);
const bookmarks = computed<BookmarkedRound[]>(() =>
  Array.isArray(bookmarksRaw.value) ? bookmarksRaw.value : [],
);
const editingBookmarkId = ref<string | null>(null);
const bookmarksCollapsed = ref(false);
const selectedBookmarkCount = computed(() => bookmarks.value.filter((b) => b.pending).length);

function writeBookmarks(next: BookmarkedRound[]): void {
  setValue(DEFAULT_ENGINE_PATHS.bookmarkedRounds, next);
}
function toggleBookmarkPending(id: string, checked: boolean): void {
  writeBookmarks(bookmarks.value.map((b) => (b.id === id ? { ...b, pending: checked } : b)));
}
function removeBookmark(id: string): void {
  writeBookmarks(bookmarks.value.filter((b) => b.id !== id));
  if (editingBookmarkId.value === id) editingBookmarkId.value = null;
}
function startRenameBookmark(id: string): void {
  editingBookmarkId.value = id;
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>(`[data-mem-bm-edit="${id}"]`);
    if (el) { el.focus(); el.select(); }
  });
}
function commitRenameBookmark(id: string, value: string): void {
  const name = value.trim();
  if (name) writeBookmarks(bookmarks.value.map((b) => (b.id === id ? { ...b, name } : b)));
  editingBookmarkId.value = null;
}
/** Record a cross-panel jump target, then navigate to the main game panel, which
 *  consumes it on activation (see useRoundJump — module-level, race-free). */
function jumpToBookmark(round: number): void {
  requestRoundJump(round);
  router.push('/game').catch(() => { /* duplicate / guard — ignore */ });
}

// ─── Memory config (read from localStorage + defaults) ───

const MEMORY_SETTINGS_KEY = 'aga_memory_settings';

interface MemoryEffectiveConfig {
  shortTermLimit: number;
  midTermRefineThreshold: number;
  longTermSummaryThreshold: number;
  longTermSummarizeCount: number;
  midTermKeep: number;
  longTermCap: number;
}

const defaultConfig: MemoryEffectiveConfig = {
  shortTermLimit: 5,
  midTermRefineThreshold: 25,
  longTermSummaryThreshold: 50,
  longTermSummarizeCount: 50,
  midTermKeep: 0,
  longTermCap: 30,
};

const effectiveConfig = ref<MemoryEffectiveConfig>({ ...defaultConfig });

function loadEffectiveConfig(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    const safeNum = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    effectiveConfig.value = {
      shortTermLimit:          safeNum(raw.shortTermLimit,          defaultConfig.shortTermLimit),
      midTermRefineThreshold:  safeNum(raw.midTermRefineThreshold,  defaultConfig.midTermRefineThreshold),
      longTermSummaryThreshold: safeNum(raw.longTermSummaryThreshold, defaultConfig.longTermSummaryThreshold),
      longTermSummarizeCount:  safeNum(raw.longTermSummarizeCount,  defaultConfig.longTermSummarizeCount),
      midTermKeep:             safeNum(raw.midTermKeep,             defaultConfig.midTermKeep),
      longTermCap:             safeNum(raw.longTermCap,             defaultConfig.longTermCap),
    };
  } catch {
    effectiveConfig.value = { ...defaultConfig };
  }
}

onMounted(loadEffectiveConfig);

interface ConfigDisplayRow {
  key: string;
  label: string;
  desc: string;
  value: number;
  group: 'capacity' | 'threshold';
}

const configRows = computed<ConfigDisplayRow[]>(() => {
  const c = effectiveConfig.value;
  return [
    { key: 'shortTermLimit',          label: t('memory.config.row.shortTermLimit.label'),          desc: t('memory.config.row.shortTermLimit.desc'),          value: c.shortTermLimit,          group: 'capacity' },
    { key: 'longTermCap',             label: t('memory.config.row.longTermCap.label'),             desc: t('memory.config.row.longTermCap.desc'),             value: c.longTermCap,             group: 'capacity' },
    { key: 'midTermRefineThreshold',  label: t('memory.config.row.midTermRefineThreshold.label'),  desc: t('memory.config.row.midTermRefineThreshold.desc'),  value: c.midTermRefineThreshold,  group: 'threshold' },
    { key: 'longTermSummaryThreshold', label: t('memory.config.row.longTermSummaryThreshold.label'), desc: t('memory.config.row.longTermSummaryThreshold.desc'), value: c.longTermSummaryThreshold, group: 'threshold' },
    { key: 'longTermSummarizeCount',  label: t('memory.config.row.longTermSummarizeCount.label'),  desc: t('memory.config.row.longTermSummarizeCount.desc'),  value: c.longTermSummarizeCount,  group: 'threshold' },
    { key: 'midTermKeep',             label: t('memory.config.row.midTermKeep.label'),             desc: t('memory.config.row.midTermKeep.desc'),             value: c.midTermKeep,             group: 'threshold' },
  ];
});

const capacityRows = computed(() => configRows.value.filter(r => r.group === 'capacity'));
const thresholdRows = computed(() => configRows.value.filter(r => r.group === 'threshold'));

// ─── Tab badge counts ───

const totalNarrativeCount = computed(() => narrativeEntries.value.length);

// ─── Config row radius helper ───

function configRowRadiusClass(idx: number, total: number): string {
  if (total === 1) return 'config-row--solo';
  if (idx === 0) return 'config-row--first';
  if (idx === total - 1) return 'config-row--last';
  return 'config-row--mid';
}

// ─── Export ───

function exportNarrative(): void {
  const entries = narrativeEntries.value;
  if (entries.length === 0) {
    eventBus.emit('ui:toast', { type: 'info', message: t('memory.export.emptyToast'), duration: 1500 });
    return;
  }
  const lines: string[] = [t('memory.export.fileHeader'), ''];
  for (const msg of entries) {
    lines.push(msg.role === 'user' ? `${t('memory.narrative.exportPlayerPrefix')}${msg.content}` : msg.content);
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `narrative-export-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 100);
}
</script>

<template>
  <div class="memory-panel">
    <template v-if="isLoaded">
      <!-- ── Header ── -->
      <header class="panel-header">
        <h2 class="panel-title">{{ $t('memory.title') }}</h2>
        <div class="header-actions">
          <Tooltip :text="$t('memory.export.buttonTitle')" interactive>
            <AgaButton variant="ghost" size="sm" @click="exportNarrative">
              {{ $t('memory.export.button') }}
            </AgaButton>
          </Tooltip>
        </div>
      </header>

      <!-- ── Tab Bar (pill-segmented) ── -->
      <div class="tab-bar">
        <button
          :class="['tab-btn', { 'tab-btn--active': activeTab === 'memory' }]"
          @click="activeTab = 'memory'"
        >
          {{ $t('memory.tab.memoryList') }}
        </button>
        <button
          :class="['tab-btn', { 'tab-btn--active': activeTab === 'narrative' }]"
          @click="activeTab = 'narrative'"
        >
          {{ $t('memory.tab.narrative') }}
          <span v-if="totalNarrativeCount > 0" class="tab-badge">{{ totalNarrativeCount }}</span>
        </button>
        <button
          :class="['tab-btn', { 'tab-btn--active': activeTab === 'config' }]"
          @click="activeTab = 'config'; loadEffectiveConfig()"
        >
          {{ $t('memory.tab.config') }}
        </button>
      </div>

      <!-- ═══ Tab 1: Memory List ═══ -->
      <div v-if="activeTab === 'memory'" class="memory-sections">
        <section
          v-for="tier in tiers"
          :key="tier.key"
          :class="['memory-tier', tier.tierClass]"
        >
          <button
            class="tier-header"
            :aria-expanded="isSectionOpen(tier.key)"
            @click="toggleSection(tier.key)"
          >
            <div class="tier-title-group">
              <span :class="['tier-indicator', `tier-indicator--${tier.key}`]" />
              <span class="tier-label">{{ tier.title }}</span>
              <span class="tier-count">{{ $t('memory.tier.countSuffix', { n: tier.entries.value.length }) }}</span>
            </div>
            <svg
              :class="['tier-chevron', { 'tier-chevron--open': isSectionOpen(tier.key) }]"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>

          <Transition name="tier-expand">
            <div v-if="isSectionOpen(tier.key)" class="tier-body">
              <!-- Tier hint — helps the user understand what this layer does -->
              <p class="tier-hint">{{ tier.hint }}</p>

              <template v-if="tier.entries.value.length">
                <div
                  v-for="entry in tier.entries.value"
                  :key="entry.id"
                  :class="['mem-entry', { 'mem-entry--expanded': isEntryExpanded(tier.key, entry.id) }]"
                  @click="toggleEntry(tier.key, entry.id)"
                >
                  <div class="mem-text"><FormattedText :text="entry.content" /></div>
                  <div v-if="isEntryExpanded(tier.key, entry.id)" class="mem-meta">
                    <span v-if="entry.round != null" class="mem-round-badge">Round {{ entry.round }}</span>
                    <span v-if="entry.timestamp" class="mem-time">{{ entry.timestamp }}</span>
                    <template v-if="entry.tags?.length">
                      <span v-for="tag in entry.tags" :key="tag" class="mem-tag">{{ tag }}</span>
                    </template>
                  </div>
                </div>
              </template>

              <div v-else class="tier-empty">
                <p class="tier-empty-text">{{ $t('memory.tier.emptyState') }}</p>
              </div>
            </div>
          </Transition>
        </section>

        <!-- ═══ 收藏楼层 (Bookmarked rounds, 2026-07-18) — 5th section ═══ -->
        <section class="memory-tier tier--bookmark" data-testid="memory-bookmark-section">
          <button
            class="tier-header"
            :aria-expanded="!bookmarksCollapsed"
            @click="bookmarksCollapsed = !bookmarksCollapsed"
          >
            <div class="tier-title-group">
              <span class="tier-indicator tier-indicator--bookmark" />
              <span class="tier-label">{{ $t('memory.bookmark.title') }}</span>
              <span class="tier-count">{{ $t('memory.tier.countSuffix', { n: bookmarks.length }) }}</span>
              <span v-if="selectedBookmarkCount > 0" class="bm-pending-flag">{{ $t('memory.bookmark.pendingFlag', { n: selectedBookmarkCount }) }}</span>
            </div>
            <svg
              :class="['tier-chevron', { 'tier-chevron--open': !bookmarksCollapsed }]"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>

          <Transition name="tier-expand">
            <div v-if="!bookmarksCollapsed" class="tier-body">
              <p class="tier-hint">{{ $t('memory.bookmark.hint') }}</p>

              <template v-if="bookmarks.length">
                <div v-for="bm in bookmarks" :key="bm.id" class="bm-entry" :class="{ 'bm-entry--pending': bm.pending }">
                  <Tooltip :text="$t('memory.bookmark.selectHint')">
                    <input
                      type="checkbox"
                      class="bm-check"
                      :checked="bm.pending"
                      :aria-label="$t('memory.bookmark.selectHint')"
                      @change="toggleBookmarkPending(bm.id, ($event.target as HTMLInputElement).checked)"
                    />
                  </Tooltip>
                  <div class="bm-main">
                    <div class="bm-namerow">
                      <span class="mem-round-badge">{{ $t('memory.bookmark.roundLabel', { n: bm.round }) }}</span>
                      <input
                        v-if="editingBookmarkId === bm.id"
                        :data-mem-bm-edit="bm.id"
                        class="bm-name-input"
                        :value="bm.name"
                        @blur="commitRenameBookmark(bm.id, ($event.target as HTMLInputElement).value)"
                        @keydown.enter="($event.target as HTMLInputElement).blur()"
                        @keydown.escape="editingBookmarkId = null"
                      />
                      <Tooltip v-else :text="$t('memory.bookmark.renameHint')">
                        <button class="bm-name" @click="startRenameBookmark(bm.id)">{{ bm.name }}</button>
                      </Tooltip>
                    </div>
                    <div class="bm-content"><FormattedText :text="bm.content" /></div>
                    <div class="bm-actions">
                      <Tooltip :text="$t('memory.bookmark.jump')">
                        <button class="bm-action-btn" @click="jumpToBookmark(bm.round)">{{ $t('memory.bookmark.jump') }}</button>
                      </Tooltip>
                      <Tooltip :text="$t('memory.bookmark.delete')">
                        <button class="bm-action-btn bm-action-btn--del" @click="removeBookmark(bm.id)">{{ $t('memory.bookmark.delete') }}</button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              </template>

              <div v-else class="tier-empty">
                <p class="tier-empty-text">{{ $t('memory.bookmark.emptyState') }}</p>
              </div>
            </div>
          </Transition>
        </section>
      </div>

      <!-- ═══ Tab 2: Narrative History ═══ -->
      <div v-else-if="activeTab === 'narrative'" class="narrative-container">
        <template v-if="narrativeEntries.length">
          <template v-for="(msg, idx) in narrativeEntries" :key="idx">
            <div :class="['narrative-block', `narrative-block--${msg.role}`]">
              <div :class="['narrative-role', { 'narrative-role--user': msg.role === 'user' }]">
                <span class="narrative-role-dot" />
                {{ msg.role === 'user' ? $t('memory.narrative.rolePlayer') : $t('memory.narrative.roleNarrator') }}
              </div>
              <div class="narrative-prose"><FormattedText :text="msg.content" /></div>
            </div>
            <div
              v-if="idx < narrativeEntries.length - 1 && msg.role === 'assistant' && narrativeEntries[idx + 1]?.role === 'user'"
              class="narrative-divider"
            />
          </template>
        </template>

        <div v-else class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p class="empty-title">{{ $t('memory.narrative.emptyTitle') }}</p>
          <p class="empty-hint">{{ $t('memory.narrative.emptyHint') }}</p>
        </div>
      </div>

      <!-- ═══ Tab 3: Configuration ═══ -->
      <div v-else-if="activeTab === 'config'" class="config-container">
        <!-- Memory flow visualization -->
        <div class="config-visual-header">
          <div class="memory-flow">
            <div class="flow-node">
              <div class="flow-dot flow-dot--short">{{ effectiveConfig.shortTermLimit }}</div>
              <span class="flow-label">{{ $t('memory.config.flowLabel.short') }}</span>
            </div>
            <div class="flow-arrow" />
            <div class="flow-node">
              <div class="flow-dot flow-dot--implicit">1:1</div>
              <span class="flow-label">{{ $t('memory.config.flowLabel.implicit') }}</span>
            </div>
            <div class="flow-arrow" />
            <div class="flow-node">
              <div class="flow-dot flow-dot--mid">{{ effectiveConfig.midTermRefineThreshold }}</div>
              <span class="flow-label">{{ $t('memory.config.flowLabel.mid') }}</span>
            </div>
            <div class="flow-arrow" />
            <div class="flow-node">
              <div class="flow-dot flow-dot--long">{{ effectiveConfig.longTermCap }}</div>
              <span class="flow-label">{{ $t('memory.config.flowLabel.long') }}</span>
            </div>
          </div>
          <p class="flow-caption">{{ $t('memory.config.flowCaption') }}</p>
        </div>

        <!-- Capacity group -->
        <div class="config-group">
          <div class="config-group-label">{{ $t('memory.config.group.capacity') }}</div>
          <div
            v-for="(row, idx) in capacityRows"
            :key="row.key"
            :class="['config-row', configRowRadiusClass(idx, capacityRows.length)]"
          >
            <div class="config-label">
              <span class="config-key">{{ row.label }}</span>
              <span class="config-desc">{{ row.desc }}</span>
            </div>
            <span class="config-value config-value--number">{{ row.value }}</span>
          </div>
        </div>

        <!-- Threshold group -->
        <div class="config-group">
          <div class="config-group-label">{{ $t('memory.config.group.threshold') }}</div>
          <div
            v-for="(row, idx) in thresholdRows"
            :key="row.key"
            :class="['config-row', configRowRadiusClass(idx, thresholdRows.length)]"
          >
            <div class="config-label">
              <span class="config-key">{{ row.label }}</span>
              <span class="config-desc">{{ row.desc }}</span>
            </div>
            <span class="config-value config-value--number">{{ row.value }}</span>
          </div>
        </div>

        <!-- Footer hint -->
        <div class="config-footer">
          <svg class="config-footer-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
          </svg>
          {{ $t('memory.config.footerHint') }}
        </div>
      </div>
    </template>

    <!-- Not loaded state -->
    <div v-else class="empty-state">
      <p class="empty-title">{{ $t('memory.notLoaded') }}</p>
    </div>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════
   MEMORY PANEL — Sanctuary Aesthetic
   Glass panels, beacon indicators, CJK serif typography.
   ═══════════════════════════════════════════════════════════ */
.memory-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  height: 100%;
  overflow-y: auto;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.panel-title {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 1.1rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* ── Tab Bar (pill-segmented) ── */
.tab-bar {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: rgba(255, 255, 255, 0.025);
  border-radius: var(--radius-lg);
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: calc(var(--radius-lg) - 2px);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-out);
  letter-spacing: 0.02em;
}
.tab-btn:hover {
  color: var(--color-text-secondary);
}
.tab-btn--active {
  color: var(--color-text);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 17px;
  padding: 0 5px;
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: var(--color-sage-600);
  border-radius: var(--radius-full);
  letter-spacing: -0.02em;
  transition: background var(--duration-fast) var(--ease-out);
}
.tab-btn--active .tab-badge {
  background: var(--color-sage-400);
}

/* ═══════════════════════════════════════════════════════════
   TAB 1: MEMORY TIERS
   ═══════════════════════════════════════════════════════════ */
.memory-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Glass panel per tier */
.memory-tier {
  position: relative;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
}
.memory-tier::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: var(--grain-texture);
  background-repeat: repeat;
  opacity: var(--grain-opacity);
  mix-blend-mode: var(--grain-blend);
  pointer-events: none;
  border-radius: inherit;
  z-index: 1;
}

/* Gradient edge (replaces hard 1px border) */
.memory-tier::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 1;
}

/* Tier header */
.tier-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text);
  user-select: none;
  transition: background var(--duration-fast) var(--ease-out);
}
.tier-header:hover {
  background: rgba(255, 255, 255, 0.02);
}

.tier-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Beacon-style indicator with glow halo */
.tier-indicator {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  position: relative;
  flex-shrink: 0;
}
.tier-indicator::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: var(--radius-full);
  background: inherit;
  opacity: 0.4;
  filter: blur(5px);
}

.tier-indicator--short    { background: var(--color-success); }
.tier-indicator--implicit { background: var(--color-info); }
.tier-indicator--mid      { background: var(--color-amber-400); }
.tier-indicator--long     { background: var(--color-sage-400); }
.tier-indicator--bookmark { background: var(--color-amber-300); }

.tier-label {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.tier-count {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--color-text-muted);
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: var(--radius-full);
  letter-spacing: 0.02em;
}

.tier-chevron {
  color: var(--color-text-muted);
  width: 14px;
  height: 14px;
  transition: transform var(--duration-normal) var(--ease-out);
  transform: rotate(-90deg);
}
.tier-chevron--open {
  transform: rotate(0deg);
}

/* Tier body */
.tier-body {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tier-hint {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  padding: 0 4px 4px;
  line-height: 1.5;
  margin: 0;
}

/* Memory entry */
.mem-entry {
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  position: relative;
}
.mem-entry:hover {
  background: rgba(255, 255, 255, 0.045);
  box-shadow: var(--lumi-inset-highlight);
}

/* Left accent bar (tier-colored) */
.mem-entry::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  opacity: 0.35;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.mem-entry:hover::before {
  opacity: 0.8;
}
.tier--short .mem-entry::before    { background: var(--color-success); }
.tier--implicit .mem-entry::before { background: var(--color-info); }
.tier--mid .mem-entry::before      { background: var(--color-amber-400); }
.tier--long .mem-entry::before     { background: var(--color-sage-400); }

/* ── 收藏楼层 section rows (2026-07-18) ── */
.bm-pending-flag {
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--color-bg);
  background: var(--color-amber-400);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  letter-spacing: 0.02em;
}
.bm-entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-md);
  transition: background var(--duration-fast) var(--ease-out);
}
.bm-entry:hover { background: rgba(255, 255, 255, 0.045); }
.bm-entry--pending { background: color-mix(in oklch, var(--color-amber-400) 8%, transparent); }
.bm-check {
  margin-top: 3px;
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  accent-color: var(--color-amber-400);
  cursor: pointer;
}
.bm-main { flex: 1; min-width: 0; }
.bm-namerow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.bm-name {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-radius: 3px;
  padding: 1px 4px;
  cursor: text;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}
.bm-name:hover {
  background: rgba(255, 255, 255, 0.05);
  outline: 1px dashed color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}
.bm-name-input {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  color: var(--color-text);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--color-sage-400);
  border-radius: 3px;
  padding: 1px 4px;
  outline: none;
  min-width: 0;
  flex: 1;
}
.bm-content {
  font-family: var(--font-serif-cjk);
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
.bm-content :deep(.formatted-text) {
  font-size: inherit;
  line-height: inherit;
}
.bm-actions { display: flex; gap: 8px; margin-top: 8px; }
.bm-action-btn {
  font-size: 0.68rem;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}
.bm-action-btn:hover {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
}
.bm-action-btn--del:hover {
  color: var(--color-danger);
  border-color: color-mix(in oklch, var(--color-danger) 30%, var(--color-border));
}

.mem-text {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  line-height: 1.75;
  color: var(--color-text);
  /* max-height collapse (not -webkit-line-clamp) so rendered markdown blocks
     — headings, lists, quotes — clamp reliably in the 3-line preview. */
  max-height: 4.6em;
  overflow: hidden;
  letter-spacing: 0.01em;
}
.mem-entry--expanded .mem-text {
  max-height: none;
}
/* FormattedText emits block <p>; strip its font styling so memory typography wins */
.mem-text :deep(.formatted-text) {
  font-size: inherit;
  line-height: inherit;
  letter-spacing: inherit;
}

/* Entry metadata (shown on expand) */
.mem-meta {
  display: flex;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.mem-round-badge {
  font-size: 0.65rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-sage-400);
  padding: 1px 7px;
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border-radius: var(--radius-full);
}

.mem-time {
  font-size: 0.68rem;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.mem-tag {
  font-size: 0.65rem;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

/* Empty tier */
.tier-empty {
  padding: 20px 16px;
  text-align: center;
}
.tier-empty-text {
  font-size: 0.78rem;
  color: var(--color-text-muted);
  font-style: italic;
  margin: 0;
}

/* Tier expand transition */
.tier-expand-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out),
              max-height var(--duration-normal) var(--ease-out);
  overflow: hidden;
  max-height: 2000px;
}
.tier-expand-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
              max-height var(--duration-fast) var(--ease-out);
  overflow: hidden;
}
.tier-expand-enter-from,
.tier-expand-leave-to {
  opacity: 0;
  max-height: 0;
  padding: 0 12px;
}

/* ═══════════════════════════════════════════════════════════
   TAB 2: NARRATIVE HISTORY
   ═══════════════════════════════════════════════════════════ */
.narrative-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.narrative-block {
  position: relative;
  padding: 16px 18px;
  border-radius: var(--radius-md);
  transition: background var(--duration-fast) var(--ease-out);
}
.narrative-block:hover {
  background: rgba(255, 255, 255, 0.015);
}

/* Player input — subsidiary awareness */
.narrative-block--user {
  background: rgba(255, 255, 255, 0.02);
  border-left: 2px solid color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}
.narrative-block--user:hover {
  border-left-color: color-mix(in oklch, var(--color-sage-400) 65%, transparent);
}

/* AI narration — focal awareness, given more breathing room */
.narrative-block--assistant {
  padding: 20px 18px;
}

.narrative-role {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.narrative-role--user {
  color: var(--color-sage-600);
}

.narrative-role-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}

.narrative-prose {
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  line-height: var(--narrative-line-height, 1.88);
  letter-spacing: var(--narrative-letter-spacing, 0.015em);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Pair divider — gradient fade, not hard line */
.narrative-divider {
  height: 1px;
  margin: 8px 18px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 20%,
    rgba(255, 255, 255, 0.04) 80%,
    transparent 100%
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB 3: CONFIGURATION
   ═══════════════════════════════════════════════════════════ */
.config-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Flow visualization header — glass panel */
.config-visual-header {
  position: relative;
  padding: 20px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.config-visual-header::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

.memory-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 8px 0 4px;
}

.flow-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 72px;
}

.flow-dot {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.68rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-text);
  position: relative;
}
.flow-dot::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: var(--radius-full);
  background: inherit;
  opacity: 0.25;
  filter: blur(7px);
}
.flow-dot--short    { background: var(--color-success); }
.flow-dot--implicit { background: var(--color-info); }
.flow-dot--mid      { background: var(--color-amber-400); }
.flow-dot--long     { background: var(--color-sage-400); }

.flow-label {
  font-size: 0.65rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.flow-arrow {
  width: 36px;
  height: 1px;
  background: linear-gradient(90deg, var(--color-border), var(--color-text-muted), var(--color-border));
  position: relative;
  margin: 0 -4px;
  margin-bottom: 20px;
}
.flow-arrow::after {
  content: '';
  position: absolute;
  right: -3px;
  top: -3px;
  width: 6px;
  height: 6px;
  border-top: 1px solid var(--color-text-muted);
  border-right: 1px solid var(--color-text-muted);
  transform: rotate(45deg);
}

.flow-caption {
  margin: 8px 0 0;
  text-align: center;
  font-size: 0.68rem;
  color: var(--color-text-muted);
}

/* Config group */
.config-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.config-group-label {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  padding: 0 4px 8px;
}

/* Config rows — iOS-style single column */
.config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.02);
  transition: background var(--duration-fast) var(--ease-out);
}
.config-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.config-row + .config-row {
  margin-top: 1px;
}

/* Rounded corner variants for grouped rows */
.config-row--solo  { border-radius: var(--radius-md); }
.config-row--first { border-radius: var(--radius-md) var(--radius-md) var(--radius-sm) var(--radius-sm); }
.config-row--last  { border-radius: var(--radius-sm) var(--radius-sm) var(--radius-md) var(--radius-md); }
.config-row--mid   { border-radius: var(--radius-sm); }

.config-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.config-key {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-text);
}

.config-desc {
  font-size: 0.68rem;
  color: var(--color-text-muted);
}

.config-value {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  min-width: 48px;
  text-align: center;
  flex-shrink: 0;
}
.config-value--number {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 6%, transparent);
  text-shadow: 0 0 6px color-mix(in oklch, var(--color-amber-400) 30%, transparent);
}

/* Footer hint */
.config-footer {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 4px;
  font-size: 0.7rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.config-footer-icon {
  width: 14px;
  height: 14px;
  color: var(--color-sage-600);
  flex-shrink: 0;
  margin-top: 1px;
}

/* ═══════════════════════════════════════════════════════════
   EMPTY STATES
   ═══════════════════════════════════════════════════════════ */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  gap: 8px;
}

.empty-icon {
  width: 40px;
  height: 40px;
  color: var(--color-text-muted);
  opacity: 0.3;
  margin-bottom: 4px;
}

.empty-title {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  margin: 0;
}

.empty-hint {
  font-size: 0.72rem;
  color: var(--color-text-muted);
  opacity: 0.6;
  text-align: center;
  margin: 0;
  max-width: 320px;
  line-height: 1.5;
}

/* ═══════════════════════════════════════════════════════════
   MOBILE RESPONSIVE (max-width: 767px)
   Touch-friendly targets, adapted typography, safe-area.
   Glass blur is globally reduced to 8px by mobile.css.
   ═══════════════════════════════════════════════════════════ */
@media (max-width: 767px) {
  /* ── Panel shell ── */
  .memory-panel {
    padding: 16px var(--space-md);
    padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px));
    gap: 12px;
    transition: none;
  }

  /* ── Header ── */
  .panel-header { padding: 0; }
  .panel-title { font-size: 1rem; }

  /* ── Tab bar — larger touch targets ── */
  .tab-bar {
    padding: 3px;
    border-radius: var(--radius-md);
  }
  .tab-btn {
    padding: 10px 8px;
    font-size: 0.78rem;
    min-height: 40px;
    border-radius: calc(var(--radius-md) - 2px);
  }
  .tab-badge {
    min-width: 16px;
    height: 16px;
    font-size: 0.58rem;
  }

  /* ── Memory tiers ── */
  .memory-sections { gap: 10px; }

  .memory-tier {
    border-radius: var(--radius-md);
  }

  .tier-header {
    padding: 14px;
    min-height: 48px;
  }
  .tier-label { font-size: 0.82rem; }

  .tier-body {
    padding: 0 10px 10px;
    gap: 6px;
  }
  .tier-hint {
    font-size: 0.68rem;
    padding: 0 2px 2px;
  }

  /* ── Memory entries — touch-friendly ── */
  .mem-entry {
    padding: 14px 12px;
    min-height: 44px;
  }
  .mem-entry::before {
    width: 3px;
    top: 10px;
    bottom: 10px;
  }
  .mem-text {
    font-size: 0.82rem;
    line-height: 1.7;
  }
  .mem-meta {
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
  }

  /* ── Narrative tab ── */
  .narrative-block {
    padding: 12px 14px;
  }
  .narrative-block--assistant {
    padding: 16px 14px;
  }
  .narrative-prose {
    font-size: 0.86rem;
    line-height: 1.82;
  }
  .narrative-divider {
    margin: 6px 14px;
  }

  /* ── Config tab ── */
  .config-visual-header {
    padding: 16px 12px;
  }

  /* Flow diagram — compact for narrow screens */
  .flow-node { min-width: 52px; }
  .flow-dot {
    width: 28px;
    height: 28px;
    font-size: 0.6rem;
  }
  .flow-arrow {
    width: 20px;
    margin-bottom: 18px;
  }
  .flow-label { font-size: 0.6rem; }
  .flow-caption { font-size: 0.64rem; }

  /* Config rows — stack label/value vertically on tight screens */
  .config-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 12px;
    min-height: 44px;
  }
  .config-value {
    align-self: flex-end;
    font-size: 0.78rem;
  }
  .config-key { font-size: 0.78rem; }
  .config-desc { font-size: 0.66rem; }
  .config-footer { font-size: 0.66rem; }

  /* ── Empty states ── */
  .empty-state { padding: 36px 16px; }
  .empty-icon { width: 32px; height: 32px; }
  .empty-hint { max-width: 260px; }
}

/* ── Extra-narrow (< 380px, e.g. iPhone SE) ── */
@media (max-width: 380px) {
  .memory-panel { padding: 12px var(--space-sm); }
  .tab-btn { padding: 10px 4px; font-size: 0.72rem; }
  .flow-node { min-width: 44px; }
  .flow-dot { width: 24px; height: 24px; font-size: 0.55rem; }
  .flow-arrow { width: 14px; }
  .config-row { padding: 10px; }
}

/* ── Touch device scrollbar hiding (matches mobile.css pattern) ── */
@media (hover: none) and (pointer: coarse) {
  .memory-panel { scrollbar-width: none; }
  .memory-panel::-webkit-scrollbar { display: none; }
}
</style>
