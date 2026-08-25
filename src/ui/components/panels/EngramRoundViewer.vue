<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.8.4 (EngramRoundViewer modal + NPC filter)
/**
 * EngramRoundViewer — per-round Engram visualization showing write path
 * (what was extracted) and read path (what was recalled and why).
 *
 * Core design: every recalled candidate shows a stacked score bar with
 * color-coded components so users can see at a glance WHY a memory was
 * chosen (or rejected).
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import type {
  EngramWriteSnapshot,
  EngramReadSnapshot,
  ScoredCandidateTrace,
  ScoredComponent,
} from '@/engine/memory/engram/engram-types';

import type { NpcRelevanceMeta } from '@/engine/social/npc-relevance-scorer';

interface Props {
  modelValue: boolean;
  write?: EngramWriteSnapshot | null;
  read?: EngramReadSnapshot | null;
  npcRelevance?: NpcRelevanceMeta | null;
  roundNumber?: number;
}

const props = withDefaults(defineProps<Props>(), {
  write: null,
  read: null,
  npcRelevance: null,
  roundNumber: 0,
});

defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();

const expandedInjected = ref<number | null>(null);
const expandedFiltered = ref<number | null>(null);
const showFiltered = ref(false);

function toggleInjected(idx: number): void {
  expandedInjected.value = expandedInjected.value === idx ? null : idx;
  expandedFiltered.value = null;
}

function toggleFiltered(idx: number): void {
  expandedFiltered.value = expandedFiltered.value === idx ? null : idx;
  expandedInjected.value = null;
}

const title = computed(() =>
  props.roundNumber > 0
    ? t('mainGame.engram.title', { n: props.roundNumber })
    : t('mainGame.engram.titleGeneric'),
);

const injectedCandidates = computed(() =>
  (props.read?.candidates ?? []).filter((c) => c.outcome === 'injected'),
);

const filteredCandidates = computed(() =>
  (props.read?.candidates ?? []).filter((c) => c.outcome !== 'injected'),
);

const componentColorMap: Record<ScoredComponent['color'], string> = {
  blue: 'var(--color-viz-blue)',
  green: 'var(--color-viz-green)',
  orange: 'var(--color-viz-orange)',
  purple: 'var(--color-viz-purple)',
  red: 'var(--color-viz-red)',
  gray: 'var(--color-viz-gray)',
};

function barFillWidth(c: ScoredCandidateTrace): string {
  return `${Math.min(c.finalScore * 100, 100)}%`;
}

function sourceLabel(s: ScoredCandidateTrace['source']): string {
  const map: Record<string, string> = {
    'edge': t('mainGame.engram.source.edge'),
    'entity': t('mainGame.engram.source.entity'),
    'event': t('mainGame.engram.source.event'),
  };
  return map[s] ?? s;
}

function outcomeLabel(o: ScoredCandidateTrace['outcome']): string {
  const map: Record<string, string> = {
    'injected': t('mainGame.engram.outcome.injected'),
    'filtered-by-topK': t('mainGame.engram.outcome.filteredByTopK'),
    'filtered-by-rerank': t('mainGame.engram.outcome.filteredByRerank'),
    'filtered-as-redundant': t('mainGame.engram.outcome.filteredAsRedundant'),
  };
  return map[o] ?? o;
}

const showTier3 = ref(false);

const npcSignalLabel: Record<string, string> = {
  snapshot: '🔍 召回命中',
  recent: '🕐 近期互动',
  bfs: '🔗 NPC关联',
};

function fmtSignals(signals?: string[]): string {
  if (!signals?.length) return '';
  return signals.map(s => npcSignalLabel[s] ?? s).join(' + ');
}

function fmtTokenSaved(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}K` : `~${n}`;
}

function fmtScore(n: number): string {
  return n.toFixed(3);
}

</script>

<template>
  <Modal
    :model-value="props.modelValue"
    :title="title"
    width="720px"
    backdrop-close
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="erv">
      <!-- ═══ WRITE PATH ═══ -->
      <section v-if="props.write" class="erv__section">
        <h3 class="erv__heading erv__heading--write">{{ $t('mainGame.engram.headingWrite') }}</h3>

        <!-- Event -->
        <div v-if="props.write.event" class="erv__card">
          <div class="erv__card-label">{{ $t('mainGame.engram.eventExtraction') }}</div>
          <div class="erv__card-title">{{ props.write.event.title || $t('mainGame.engram.noTitle') }}</div>
          <div class="erv__card-meta">
            <span v-if="props.write.event.roles.length">{{ $t('mainGame.engram.roles') }}: {{ props.write.event.roles.join(', ') }}</span>
            <span v-if="props.write.event.location.length">{{ $t('mainGame.engram.location') }}: {{ props.write.event.location.join(', ') }}</span>
            <span v-if="props.write.event.timeAnchor">{{ $t('mainGame.engram.timeAnchor') }}: {{ props.write.event.timeAnchor }}</span>
          </div>
        </div>

        <!-- Entity deltas -->
        <div v-if="props.write.entities.deltas.length > 0" class="erv__card">
          <div class="erv__card-label">{{ $t('mainGame.engram.entityDeltas') }} <span class="erv__muted">({{ $t('mainGame.engram.entityTotal', { n: props.write.entities.total }) }})</span></div>
          <div v-for="d in props.write.entities.deltas" :key="d.name" class="erv__delta-row">
            <span class="erv__delta-badge" :class="d.isNew ? 'erv__delta-badge--new' : 'erv__delta-badge--update'">
              {{ d.isNew ? '+' : '↻' }}
            </span>
            <span class="erv__delta-name">{{ d.name }}</span>
            <span class="erv__muted">({{ d.type }}{{ d.descriptionUpdated ? ` · ${$t('mainGame.engram.descriptionUpdated')}` : '' }})</span>
          </div>
        </div>

        <!-- 事实边变化 -->
        <div v-if="props.write.edges" class="erv__card">
          <div class="erv__card-label">{{ $t('mainGame.engram.edgeDeltas') }} <span class="erv__muted">({{ $t('mainGame.engram.edgeSummary', { total: props.write.edges.total, newCount: props.write.edges.newCount, reinforcedCount: props.write.edges.reinforcedCount }) }})</span></div>
          <div v-for="e in props.write.edges.topNew" :key="`${e.sourceEntity}→${e.targetEntity}`" class="erv__delta-row">
            <span class="erv__delta-badge erv__delta-badge--new">+</span>
            <span>{{ e.sourceEntity }} → {{ e.targetEntity }}</span>
            <span class="erv__muted">{{ e.fact.length > 30 ? e.fact.slice(0, 30) + '…' : e.fact }}</span>
            <span class="erv__muted">({{ e.episodeCount }}ep)</span>
          </div>
        </div>

        <!-- Trim + vectorize summary -->
        <div class="erv__summary-row">
          <span v-if="props.write.trimmed.eventsBefore !== props.write.trimmed.eventsAfter">
            {{ $t('mainGame.engram.eventTrim', { before: props.write.trimmed.eventsBefore, after: props.write.trimmed.eventsAfter }) }}
          </span>
          <span v-if="props.write.edges?.prunedCount">{{ $t('mainGame.engram.edgePrune', { n: props.write.edges.prunedCount }) }}</span>
          <span v-if="props.write.vectorizeQueued > 0">{{ $t('mainGame.engram.vectorizeQueued', { n: props.write.vectorizeQueued }) }}</span>
          <span class="erv__muted">{{ props.write.totalDurationMs.toFixed(0) }}ms</span>
        </div>
      </section>

      <!-- ═══ WRITE PATH — Review Result ═══ -->
      <section v-if="props.write?.reviewResult" class="erv__section">
        <h3 class="erv__heading erv__heading--review">{{ $t('mainGame.engram.headingReview') }}</h3>
        <div class="erv__card">
          <div class="erv__card-label">{{ $t('mainGame.engram.reviewResult') }}</div>
          <div class="erv__review-stats">
            <span>{{ $t('mainGame.engram.reviewedCount', { n: props.write.reviewResult.reviewed }) }}</span>
            <span class="erv__review-invalidated">{{ $t('mainGame.engram.invalidatedCount', { n: props.write.reviewResult.invalidated }) }}</span>
            <span>{{ $t('mainGame.engram.keptCount', { n: props.write.reviewResult.kept }) }}</span>
          </div>
        </div>
        <template v-if="props.write.reviewResult.invalidatedEdges?.length">
          <div v-for="ie in props.write.reviewResult.invalidatedEdges" :key="ie.edgeId" class="erv__review-detail erv__review-detail--invalidated">
            <span class="erv__review-badge erv__review-badge--invalidated">{{ $t('mainGame.engram.badgeInvalidated') }}</span>
            <Tooltip class="erv__review-fact" :text="ie.fact"><span class="erv__review-clip">{{ ie.fact }}</span></Tooltip>
            <Tooltip v-if="ie.reason" class="erv__review-reason" :text="ie.reason"><span class="erv__review-clip">{{ ie.reason }}</span></Tooltip>
          </div>
        </template>
        <template v-if="props.write.reviewResult.keptEdges?.length">
          <div v-for="ke in props.write.reviewResult.keptEdges" :key="ke.edgeId" class="erv__review-detail erv__review-detail--kept">
            <span class="erv__review-badge erv__review-badge--kept">{{ $t('mainGame.engram.badgeKept') }}</span>
            <Tooltip class="erv__review-fact" :text="ke.fact"><span class="erv__review-clip">{{ ke.fact }}</span></Tooltip>
            <Tooltip v-if="ke.reason" class="erv__review-reason" :text="ke.reason"><span class="erv__review-clip">{{ ke.reason }}</span></Tooltip>
          </div>
        </template>
      </section>

      <!-- ═══ READ PATH ═══ -->
      <section v-if="props.read" class="erv__section">
        <h3 class="erv__heading erv__heading--read">{{ $t('mainGame.engram.headingRead') }}</h3>

        <!-- Pipeline summary -->
          <div class="erv__pipeline-bar">
            <span class="erv__pipeline-query">{{ $t('mainGame.engram.pipelineQuery') }}: "{{ props.read.query.length > 60 ? props.read.query.slice(0, 60) + '…' : props.read.query }}"</span>
            <div class="erv__pipeline-stats">
              <span>{{ $t('mainGame.engram.pipelineVectorEvent') }}{{ props.read.pipeline.vectorEventCount }}</span>
              <span>{{ $t('mainGame.engram.pipelineVectorEntity') }}{{ props.read.pipeline.vectorEntityCount }}</span>
              <span>{{ $t('mainGame.engram.pipelineGraph') }}{{ props.read.pipeline.graphCount }}</span>
              <span class="erv__pipeline-arrow">→</span>
              <span>{{ $t('mainGame.engram.pipelineMerge') }}{{ props.read.pipeline.afterMerge }}</span>
              <span v-if="props.read.config.rerankEnabled" class="erv__pipeline-arrow">→</span>
              <span v-if="props.read.config.rerankEnabled">{{ $t('mainGame.engram.pipelineRerank') }}{{ props.read.pipeline.afterRerank }}</span>
              <span class="erv__pipeline-arrow">→</span>
              <span class="erv__pipeline-injected">{{ $t('mainGame.engram.pipelineInjected') }}{{ props.read.pipeline.injectedCount }}</span>
              <span class="erv__muted">{{ props.read.totalDurationMs.toFixed(0) }}ms</span>
            </div>
          </div>

        <!-- Config context -->
        <div class="erv__config-row">
          {{ $t('mainGame.engram.configVector') }}{{ props.read.config.embeddingEnabled ? $t('mainGame.engram.configOn') : $t('mainGame.engram.configOff') }} · {{ $t('mainGame.engram.configThreshold') }} {{ fmtScore(props.read.config.minScore) }} · {{ $t('mainGame.engram.configCandidates') }} {{ props.read.config.maxCandidates }}（{{ $t('mainGame.engram.configEdgeBudget') }}{{ props.read.config.edgeBudget }}/{{ $t('mainGame.engram.configEntityBudget') }}{{ props.read.config.entityBudget }}/{{ $t('mainGame.engram.configEventBudget') }}{{ props.read.config.eventBudget }}）
          <span v-if="props.read.config.rerankEnabled"> · {{ $t('mainGame.engram.configRerankTopN') }} {{ props.read.config.rerankTopN }}</span>
        </div>

        <!-- Injected candidates -->
        <div
          v-for="(c, idx) in injectedCandidates"
          :key="'inj-' + idx"
          class="erv__candidate"
          :class="{ 'erv__candidate--expanded': expandedInjected === idx }"
          role="button"
          tabindex="0"
          :aria-expanded="expandedInjected === idx"
          @click="toggleInjected(idx)"
          @keydown.enter.prevent="toggleInjected(idx)"
          @keydown.space.prevent="toggleInjected(idx)"
        >
          <!-- Score bar: outer track (full width) → inner fill (proportional to finalScore) → segments (proportional to contribution) -->
          <div class="erv__bar-container">
            <div class="erv__bar-track">
              <div class="erv__bar-fill" :style="{ width: barFillWidth(c) }">
                <Tooltip
                  v-for="(comp, ci) in c.components"
                  :key="ci"
                  class="erv__bar-segment-tip"
                  :style="{ flex: `${comp.contribution} 0 0%` }"
                  :text="`${comp.label}: ${fmtScore(comp.rawValue)} × ${fmtScore(comp.weight)} = ${fmtScore(comp.contribution)}`"
                >
                  <div
                    class="erv__bar-segment"
                    :style="{ backgroundColor: componentColorMap[comp.color] }"
                  />
                </Tooltip>
              </div>
            </div>
            <span class="erv__bar-score">{{ fmtScore(c.finalScore) }}</span>
          </div>

          <!-- Text + source tag -->
          <div class="erv__candidate-text">{{ c.text }}</div>
          <div class="erv__candidate-tags">
            <span class="erv__tag" :class="'erv__tag--' + c.source">{{ sourceLabel(c.source) }}</span>
            <span v-if="c.roundNumber != null" class="erv__muted">R{{ c.roundNumber }}</span>
            <span v-if="c.rerankBlendedScore != null" class="erv__muted">{{ $t('mainGame.engram.rerank') }} {{ fmtScore(c.rerankBlendedScore) }}</span>
          </div>

          <!-- Expanded detail card -->
          <div v-if="expandedInjected === idx" class="erv__detail" @click.stop>
            <div class="erv__detail-title">{{ $t('mainGame.engram.scoreBreakdown') }}</div>
            <div v-for="(comp, ci) in c.components" :key="'d-' + ci" class="erv__detail-row">
              <span class="erv__detail-swatch" :style="{ backgroundColor: componentColorMap[comp.color] }" />
              <span class="erv__detail-label">{{ comp.label }}</span>
              <span class="erv__detail-formula">{{ fmtScore(comp.rawValue) }} × {{ fmtScore(comp.weight) }}</span>
              <span class="erv__detail-value">= {{ fmtScore(comp.contribution) }}</span>
            </div>
            <div v-if="c.preRerankScore != null" class="erv__detail-section">
              <div class="erv__detail-title">{{ $t('mainGame.engram.pipelineRerank') }}</div>
              <div class="erv__detail-row">
                <span class="erv__detail-label">{{ $t('mainGame.engram.preRerank') }}</span>
                <span class="erv__detail-value">{{ fmtScore(c.preRerankScore) }}</span>
              </div>
              <div class="erv__detail-row">
                <span class="erv__detail-label">{{ $t('mainGame.engram.postRerank') }}</span>
                <span class="erv__detail-value">{{ fmtScore(c.finalScore) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Filtered (collapsed by default) -->
        <div v-if="filteredCandidates.length > 0" class="erv__filtered-toggle">
          <button class="erv__filtered-btn" @click.stop="showFiltered = !showFiltered">
            {{ showFiltered ? $t('mainGame.engram.filteredToggle.collapse') : $t('mainGame.engram.filteredToggle.expand') }} {{ $t('mainGame.engram.filteredToggle.label', { n: filteredCandidates.length }) }}
          </button>
        </div>
        <template v-if="showFiltered">
          <div
            v-for="(c, idx) in filteredCandidates"
            :key="'fil-' + idx"
            class="erv__candidate erv__candidate--filtered"
            role="button"
            tabindex="0"
            :aria-expanded="expandedFiltered === idx"
            @click="toggleFiltered(idx)"
            @keydown.enter.prevent="toggleFiltered(idx)"
            @keydown.space.prevent="toggleFiltered(idx)"
          >
            <div class="erv__bar-container">
              <div class="erv__bar-track">
                <div class="erv__bar-fill erv__bar-fill--filtered" :style="{ width: barFillWidth(c) }">
                  <div
                    v-for="(comp, ci) in c.components"
                    :key="ci"
                    class="erv__bar-segment"
                    :style="{ flex: `${comp.contribution} 0 0%`, backgroundColor: componentColorMap[comp.color], opacity: 0.5 }"
                  />
                </div>
              </div>
              <span class="erv__bar-score">{{ fmtScore(c.finalScore) }}</span>
            </div>
            <div class="erv__candidate-text erv__candidate-text--filtered">{{ c.text }}</div>
            <div class="erv__candidate-tags">
              <span class="erv__tag erv__tag--filtered">{{ outcomeLabel(c.outcome) }}</span>
              <span class="erv__tag" :class="'erv__tag--' + c.source">{{ sourceLabel(c.source) }}</span>
            </div>
            <div v-if="expandedFiltered === idx" class="erv__detail" @click.stop>
              <div class="erv__detail-title">{{ $t('mainGame.engram.scoreBreakdown') }}</div>
              <div v-for="(comp, ci) in c.components" :key="'fd-' + ci" class="erv__detail-row">
                <span class="erv__detail-swatch" :style="{ backgroundColor: componentColorMap[comp.color] }" />
                <span class="erv__detail-label">{{ comp.label }}</span>
                <span class="erv__detail-formula">{{ fmtScore(comp.rawValue) }} × {{ fmtScore(comp.weight) }}</span>
                <span class="erv__detail-value">= {{ fmtScore(comp.contribution) }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- Legend -->
        <div class="erv__legend">
          <span v-for="(color, key) in { vectorSimilarity: 'blue', keywordHit: 'green', timeDecay: 'orange', characterHit: 'purple', graphWeight: 'red' } as Record<string, ScoredComponent['color']>" :key="key" class="erv__legend-item">
            <span class="erv__legend-swatch" :style="{ backgroundColor: componentColorMap[color] }" />
            {{ $t(`mainGame.engram.legend.${key}`) }}
          </span>
        </div>
      </section>

      <!-- ═══ NPC RELEVANCE FILTERING ═══ -->
      <section v-if="props.npcRelevance" class="erv__section">
        <h3 class="erv__heading erv__heading--npc">🎭 NPC 上下文过滤</h3>

        <div class="erv__npc-summary">
          <span>共 {{ props.npcRelevance.tier1Count + props.npcRelevance.tier2PresentCount + props.npcRelevance.tier2AbsentCount + props.npcRelevance.tier3Count }} NPC →
            {{ props.npcRelevance.tier1Count }} 详细 +
            {{ props.npcRelevance.tier2PresentCount + props.npcRelevance.tier2AbsentCount }} 精简 +
            {{ props.npcRelevance.tier3Count }} 略</span>
          <span class="erv__npc-saved">💰 预估节省 {{ fmtTokenSaved(props.npcRelevance.totalSaved) }} tokens</span>
        </div>

        <div v-if="props.npcRelevance.tiers.tier1.length" class="erv__npc-tier">
          <div class="erv__npc-tier-header erv__npc-tier-header--t1">Tier 1 — 详细档案（高相关）· {{ props.npcRelevance.tiers.tier1.length }} 人</div>
          <div v-for="npc in props.npcRelevance.tiers.tier1" :key="npc.name" class="erv__npc-row">
            <span class="erv__npc-dot erv__npc-dot--t1">●</span>
            <span class="erv__npc-name">{{ npc.name }}</span>
            <span v-if="npc.signals?.length" class="erv__npc-signals">{{ fmtSignals(npc.signals) }}</span>
          </div>
        </div>

        <div v-if="props.npcRelevance.tiers.tier2Present.length" class="erv__npc-tier">
          <div class="erv__npc-tier-header erv__npc-tier-header--t2">Tier 2a — 精简（在场但低相关）· {{ props.npcRelevance.tiers.tier2Present.length }} 人</div>
          <div v-for="npc in props.npcRelevance.tiers.tier2Present" :key="npc.name" class="erv__npc-row">
            <span class="erv__npc-dot erv__npc-dot--t2">○</span>
            <span class="erv__npc-name">{{ npc.name }}</span>
          </div>
        </div>

        <div v-if="props.npcRelevance.tiers.tier2Absent.length" class="erv__npc-tier">
          <div class="erv__npc-tier-header erv__npc-tier-header--t2">Tier 2b — 精简（离场但相关）· {{ props.npcRelevance.tiers.tier2Absent.length }} 人</div>
          <div v-for="npc in props.npcRelevance.tiers.tier2Absent" :key="npc.name" class="erv__npc-row">
            <span class="erv__npc-dot erv__npc-dot--t2a">◉</span>
            <span class="erv__npc-name">{{ npc.name }}</span>
            <span v-if="npc.signals?.length" class="erv__npc-signals">{{ fmtSignals(npc.signals) }}</span>
          </div>
        </div>

        <div v-if="props.npcRelevance.tiers.tier3.length" class="erv__npc-tier">
          <div class="erv__npc-tier-header erv__npc-tier-header--t3 erv__npc-tier-header--clickable" @click="showTier3 = !showTier3">
            {{ showTier3 ? '▾' : '▸' }} Tier 3 — 超精简 / 省略 · {{ props.npcRelevance.tiers.tier3.length }} 人
          </div>
          <div v-if="showTier3" class="erv__npc-tier3-list">
            {{ props.npcRelevance.tiers.tier3.map(n => n.name).join('、') }}
          </div>
        </div>

        <div class="erv__npc-legend">
          <span>🔍 召回命中 = Engram 检索中出现</span>
          <span>🕐 近期互动 = 主角边近期活跃</span>
          <span>🔗 NPC关联 = NPC↔NPC 边间接关联</span>
        </div>
      </section>

      <!-- Empty state -->
      <div v-if="!props.write && !props.read && !props.npcRelevance" class="erv__empty">
        {{ $t('mainGame.engram.empty') }}
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.erv {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  padding: var(--space-sm) 0;
}

.erv__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.erv__heading {
  font-family: var(--font-sans);
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin: 0;
  padding-bottom: var(--space-xs);
  border-bottom: 1px solid var(--color-border-subtle);
}

.erv__heading--write { color: var(--color-sage-400); }
.erv__heading--read { color: var(--color-amber-400); }

.erv__card {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-surface-elevated) 50%, transparent);
  border: 1px solid var(--color-border-subtle);
}

.erv__card-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-umber);
  margin-bottom: 4px;
}

.erv__card-title {
  font-family: var(--font-serif-cjk);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  margin-bottom: 4px;
}

.erv__card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  font-size: 11px;
  color: var(--color-text-umber);
}

.erv__delta-row {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: 12px;
  padding: 2px 0;
}

.erv__delta-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.erv__delta-badge--new {
  background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  color: var(--color-sage-400);
}

.erv__delta-badge--update {
  background: color-mix(in oklch, var(--color-amber-400) 15%, transparent);
  color: var(--color-amber-400);
}

.erv__delta-name { font-weight: 500; }

.erv__summary-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  font-size: 11px;
  color: var(--color-text-umber);
  padding: var(--space-xs) 0;
}

.erv__muted {
  color: var(--color-text-umber);
  opacity: 0.65;
}

/* ── Pipeline bar ── */
.erv__pipeline-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-surface-elevated) 50%, transparent);
  border: 1px solid var(--color-border-subtle);
}

.erv__pipeline-query {
  font-size: 11px;
  color: var(--color-text-umber);
  font-style: italic;
}

.erv__pipeline-stats {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text);
}

.erv__pipeline-arrow {
  color: var(--color-text-umber);
  opacity: 0.5;
}

.erv__pipeline-injected {
  font-weight: 700;
  color: var(--color-sage-400);
}

.erv__config-row {
  font-size: 10px;
  color: var(--color-text-umber);
  opacity: 0.7;
}

/* ── Candidate rows ── */
.erv__candidate {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out);
}

.erv__candidate:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}

.erv__candidate--expanded {
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, var(--color-border));
}

.erv__candidate--filtered {
  opacity: 0.55;
}

.erv__candidate--filtered:hover { opacity: 0.8; }

/* ── Score bar ── */
.erv__bar-container {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: 4px;
}

.erv__bar-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: color-mix(in oklch, var(--color-text-umber) 10%, transparent);
  position: relative;
  overflow: hidden;
}

.erv__bar-fill {
  height: 100%;
  display: flex;
  border-radius: 3px;
  overflow: hidden;
}

.erv__bar-fill--filtered { opacity: 0.5; }

.erv__bar-segment-tip {
  display: block;
  min-width: 1px;
  height: 100%;
  /* the bubble follows the tip wrapper; keep cursor inherited from the row */
  cursor: inherit;
}

.erv__bar-segment {
  width: 100%;
  height: 100%;
  min-width: 1px;
  transition: width 0.3s ease;
}

.erv__bar-score {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
  flex-shrink: 0;
  width: 40px;
  text-align: right;
}

.erv__candidate-text {
  font-size: 12px;
  color: var(--color-text);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 4px;
}

.erv__candidate-text--filtered { color: var(--color-text-umber); }

.erv__candidate-tags {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: 10px;
}

.erv__tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  letter-spacing: 0.05em;
}

.erv__tag--edge { background: color-mix(in oklch, var(--color-sage-400) 15%, transparent); color: var(--color-sage-400); }
.erv__tag--entity { background: color-mix(in oklch, var(--color-viz-purple) 15%, transparent); color: var(--color-viz-purple); }
.erv__tag--event { background: color-mix(in oklch, var(--color-viz-blue) 15%, transparent); color: var(--color-viz-blue); }
.erv__tag--filtered { background: color-mix(in oklch, var(--color-text-umber) 10%, transparent); color: var(--color-text-umber); }

/* ── Detail card ── */
.erv__detail {
  margin-top: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-surface) 80%, transparent);
  border: 1px solid var(--color-border-subtle);
}

.erv__detail-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-umber);
  margin-bottom: 4px;
}

.erv__detail-section { margin-top: var(--space-sm); }

.erv__detail-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 0;
}

.erv__detail-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.erv__detail-label {
  flex: 1;
  font-family: var(--font-sans);
  color: var(--color-text);
}

.erv__detail-formula {
  color: var(--color-text-umber);
  opacity: 0.7;
}

.erv__detail-value {
  font-weight: 600;
  color: var(--color-text);
  text-align: right;
  min-width: 50px;
}

/* ── Filtered toggle ── */
.erv__filtered-toggle {
  display: flex;
  justify-content: center;
  padding: var(--space-xs) 0;
}

.erv__filtered-btn {
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  padding: 3px 12px;
  font-size: 11px;
  color: var(--color-text-umber);
  cursor: pointer;
  transition: border-color var(--duration-normal) var(--ease-out);
}

.erv__filtered-btn:hover {
  border-color: var(--color-text-umber);
}

/* ── Legend ── */
.erv__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-border-subtle);
}

.erv__legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--color-text-umber);
}

.erv__legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.erv__empty {
  text-align: center;
  color: var(--color-text-umber);
  font-size: var(--font-size-sm);
  padding: var(--space-xl) 0;
}

/* ── Review result ── */
.erv__heading--review { color: var(--color-danger); }
.erv__review-stats { display: flex; gap: 12px; font-size: var(--font-size-sm); color: var(--color-text-umber); }
.erv__review-invalidated { color: var(--color-danger); font-weight: 600; }

.erv__review-detail {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-umber);
}
.erv__review-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.erv__review-badge--invalidated {
  background: var(--color-danger-muted);
  color: var(--color-danger);
}
.erv__review-badge--kept {
  background: var(--color-success-muted);
  color: var(--color-success);
}
.erv__review-fact {
  flex: 1;
  min-width: 0;
}
.erv__review-reason {
  flex-shrink: 0;
  max-width: 200px;
  opacity: 0.7;
  font-style: italic;
}
.erv__review-clip {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── NPC Relevance Section ── */
.erv__heading--npc { color: var(--color-viz-purple); }

.erv__npc-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-sm);
  color: var(--color-text-umber);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-border-subtle);
}

.erv__npc-saved {
  color: var(--color-success);
  font-weight: 600;
}

.erv__npc-tier {
  padding: var(--space-xs) 0;
}

.erv__npc-tier-header {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 0;
  color: var(--color-text-umber);
}
.erv__npc-tier-header--t1 { color: var(--color-success); }
.erv__npc-tier-header--t2 { color: var(--color-amber-400); }
.erv__npc-tier-header--t3 { color: var(--color-text-umber); opacity: 0.7; }
.erv__npc-tier-header--clickable { cursor: pointer; }

.erv__npc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 8px;
  font-size: var(--font-size-sm);
}

.erv__npc-dot { font-size: 10px; flex-shrink: 0; width: 14px; text-align: center; }
.erv__npc-dot--t1 { color: var(--color-success); }
.erv__npc-dot--t2 { color: var(--color-amber-400); }
.erv__npc-dot--t2a { color: var(--color-viz-blue); }

.erv__npc-name {
  font-weight: 500;
  color: var(--color-text);
}

.erv__npc-signals {
  font-size: 11px;
  color: var(--color-text-umber);
  opacity: 0.8;
}

.erv__npc-tier3-list {
  font-size: 12px;
  color: var(--color-text-umber);
  opacity: 0.7;
  padding: 4px 0 4px 8px;
  line-height: 1.6;
}

.erv__npc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-border-subtle);
  font-size: 10px;
  color: var(--color-text-umber);
}
</style>
