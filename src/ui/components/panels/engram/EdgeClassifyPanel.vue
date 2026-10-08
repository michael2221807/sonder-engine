<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.7.2
/**
 * EdgeClassifyPanel — Story 7 (P6): the D5 edge-classification confirm panel,
 * injected into CardExportFlow's `pre-classify` slot by SaveToCardFlow.
 *
 * Flow: edges arrive (target save) → core:true edges are pre-checked with a
 * badge and never sent to the AI (U5) → "start AI sorting" runs
 * CardEdgeClassifyPipeline in batches (cancellable; progress per batch) →
 * worldview = checked, plot-event = unchecked, unclassified = unchecked in its
 * own group (U2) → every toggle re-emits the confirmed Set upward.
 * Manual ticking works at any time — before the AI run, after a partial
 * failure, or instead of the AI entirely (SC-11 degradation path).
 *
 * Bulk editing: global select-all / clear / invert, plus per-group pagination
 * with page-level select-all / clear (lists can run into the hundreds of edges).
 */
import { ref, computed, watch, onUnmounted } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import {
  CardEdgeClassifyPipeline,
  type EdgeCategory,
} from '@/engine/export/card-edge-classify-pipeline';
import { eventBus } from '@/engine/core/event-bus';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{
  edges: EngramEdge[];
  entities: EngramEntity[];
  worldBrief: string;
  /** Target save still loading (slot prop from CardExportFlow). */
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:selectedIds', v: Set<string>): void;
}>();

const { t } = useI18n();

const aiService = injectService('aiService', undefined);
const promptAssembler = injectService('promptAssembler', undefined);

const PAGE_SIZE = 20;
type GroupKey = 'worldview' | 'plotEvent' | 'pending';

type Phase = 'idle' | 'running' | 'done' | 'failed';
const phase = ref<Phase>('idle');
const progressDone = ref(0);
const progressTotal = ref(0);
const classification = ref<Map<string, EdgeCategory>>(new Map());
const checked = ref<Set<string>>(new Set());
const pageByGroup = ref<Record<GroupKey, number>>({ worldview: 1, plotEvent: 1, pending: 1 });
let controller: AbortController | null = null;

function resetPages(): void {
  pageByGroup.value = { worldview: 1, plotEvent: 1, pending: 1 };
}

// Edges arriving (async target load) or changing resets the whole panel state;
// core edges start checked (U5). Initial emit guarantees the owner always holds
// a confirmed Set before any export is possible.
watch(
  () => props.edges,
  (edges) => {
    controller?.abort();
    phase.value = 'idle';
    classification.value = new Map();
    progressDone.value = 0;
    progressTotal.value = 0;
    resetPages();
    checked.value = new Set(edges.filter((e) => e.core === true).map((e) => e.id));
    emitSelection();
  },
  { immediate: true },
);

// F4: closing the modal unmounts the slot content — abort any in-flight run.
onUnmounted(() => controller?.abort());

const candidates = computed(() => props.edges.filter((e) => e.core !== true));

const groups = computed(() => {
  const core: EngramEdge[] = [];
  const worldview: EngramEdge[] = [];
  const plotEvent: EngramEdge[] = [];
  const pending: EngramEdge[] = [];
  for (const e of props.edges) {
    if (e.core === true) { core.push(e); continue; }
    const cat = classification.value.get(e.id);
    if (cat === 'worldview') worldview.push(e);
    else if (cat === 'plot-event') plotEvent.push(e);
    else pending.push(e);
  }
  return { core, worldview, plotEvent, pending };
});

/** Groups + pagination metadata for rendering. */
const displayGroups = computed(() => {
  const g = groups.value;
  const defs: { key: GroupKey; edges: EngramEdge[] }[] = [
    { key: 'worldview', edges: [...g.core, ...g.worldview] },
    { key: 'plotEvent', edges: g.plotEvent },
    { key: 'pending', edges: g.pending },
  ];
  return defs.map((d) => {
    const totalPages = Math.max(1, Math.ceil(d.edges.length / PAGE_SIZE));
    const page = Math.min(pageByGroup.value[d.key], totalPages);
    const start = (page - 1) * PAGE_SIZE;
    return {
      key: d.key,
      edges: d.edges,
      pageEdges: d.edges.slice(start, start + PAGE_SIZE),
      page,
      totalPages,
      total: d.edges.length,
    };
  });
});

const selectedCount = computed(() => checked.value.size);

function emitSelection(): void {
  emit('update:selectedIds', new Set(checked.value));
}

function setMany(ids: string[], on: boolean): void {
  const next = new Set(checked.value);
  for (const id of ids) { if (on) next.add(id); else next.delete(id); }
  checked.value = next;
  emitSelection();
}

function toggle(id: string): void {
  setMany([id], !checked.value.has(id));
}

// ─── Bulk selection ───────────────────────────────────────────
function selectAll(): void { setMany(props.edges.map((e) => e.id), true); }
function selectNone(): void { checked.value = new Set(); emitSelection(); }
function invertAll(): void {
  const next = new Set<string>();
  for (const e of props.edges) { if (!checked.value.has(e.id)) next.add(e.id); }
  checked.value = next;
  emitSelection();
}
function setPage(key: GroupKey, p: number): void {
  pageByGroup.value = { ...pageByGroup.value, [key]: p };
}

async function runClassify(): Promise<void> {
  if (candidates.value.length === 0) return;
  if (!aiService || !promptAssembler) {
    // HIGH #3: never let the button no-op silently — tell the user AI isn't wired,
    // they can still tick manually (SC-11 degradation path).
    eventBus.emit('ui:toast', { type: 'error', i18nKey: 'save.toCard.classify.noAi', message: t('save.toCard.classify.noAi') });
    return;
  }
  phase.value = 'running';
  progressDone.value = 0;
  progressTotal.value = candidates.value.length;
  controller = new AbortController();
  try {
    const pipeline = new CardEdgeClassifyPipeline(aiService, promptAssembler);
    const result = await pipeline.run(
      { edges: candidates.value, entities: props.entities, worldBrief: props.worldBrief },
      (p) => {
        const params = p.i18nParams as { done?: number; total?: number } | undefined;
        progressDone.value = params?.done ?? 0;
        progressTotal.value = params?.total ?? candidates.value.length;
      },
      controller.signal,
    );
    classification.value = result.classified;
    resetPages();
    // Default selection (U2/U5): core stays checked; worldview checked; plot-event/unclassified unchecked.
    const next = new Set(props.edges.filter((e) => e.core === true).map((e) => e.id));
    for (const [id, cat] of result.classified) {
      if (cat === 'worldview') next.add(id);
    }
    checked.value = next;
    emitSelection();
    phase.value =
      result.totalBatches > 0 && result.failedBatches === result.totalBatches ? 'failed' : 'done';
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      phase.value = 'idle';
      return;
    }
    console.warn('[EdgeClassifyPanel] classification failed:', err);
    phase.value = 'failed';
  } finally {
    controller = null;
  }
}

function cancelClassify(): void {
  controller?.abort();
}
</script>

<template>
  <section class="ecp">
    <h3 class="ecp-title">{{ t('save.toCard.classify.sectionTitle') }}</h3>

    <!-- empty / loading states (F6) -->
    <p v-if="props.loading" class="ecp-hint">{{ t('save.toCard.loading') }}</p>
    <p v-else-if="props.edges.length === 0" class="ecp-hint">{{ t('save.toCard.classify.emptyEdges') }}</p>

    <template v-else>
      <p class="ecp-hint">{{ t('save.toCard.classify.hint') }}</p>

      <!-- run controls -->
      <div class="ecp-run">
        <template v-if="phase === 'running'">
          <span class="ecp-progress">
            <span class="spinner spinner--sm" aria-hidden="true" />
            {{ t('save.toCard.classify.progress', { done: progressDone, total: progressTotal }) }}
          </span>
          <button type="button" class="ecp-btn" @click="cancelClassify">{{ t('save.toCard.classify.cancel') }}</button>
        </template>
        <template v-else>
          <button
            v-if="candidates.length > 0"
            type="button"
            class="ecp-btn ecp-btn--primary"
            @click="runClassify"
          >
            {{ t(phase === 'idle' ? 'save.toCard.classify.startBtn' : 'save.toCard.classify.rerunBtn', { n: candidates.length }) }}
          </button>
          <p v-if="phase === 'failed'" class="ecp-fail">{{ t('save.toCard.classify.failed') }}</p>
        </template>
        <span class="ecp-count">{{ t('save.toCard.classify.selectedCount', { sel: selectedCount, total: props.edges.length }) }}</span>
      </div>

      <!-- global bulk selection -->
      <div class="ecp-bulk">
        <span class="ecp-bulk__label">{{ t('save.toCard.classify.bulkLabel') }}</span>
        <button type="button" class="ecp-chip" data-testid="edge-select-all" @click="selectAll">{{ t('save.toCard.classify.selectAll') }}</button>
        <button type="button" class="ecp-chip" @click="selectNone">{{ t('save.toCard.classify.selectNone') }}</button>
        <button type="button" class="ecp-chip" @click="invertAll">{{ t('save.toCard.classify.invert') }}</button>
      </div>

      <!-- groups -->
      <div class="ecp-groups">
        <div v-for="group in displayGroups" :key="group.key" v-show="group.total > 0" class="ecp-group">
          <div class="ecp-group__head">
            <p class="ecp-group__title" :class="`ecp-group__title--${group.key}`">
              {{ t(`save.toCard.classify.group.${group.key}`) }} · {{ group.total }}
            </p>
            <div class="ecp-group__bulk">
              <button type="button" class="ecp-chip ecp-chip--sm" @click="setMany(group.pageEdges.map((e) => e.id), true)">{{ t('save.toCard.classify.pageAll') }}</button>
              <button type="button" class="ecp-chip ecp-chip--sm" @click="setMany(group.pageEdges.map((e) => e.id), false)">{{ t('save.toCard.classify.pageNone') }}</button>
            </div>
          </div>

          <label v-for="edge in group.pageEdges" :key="edge.id" class="ecp-row">
            <input
              type="checkbox"
              class="ecp-row__box"
              :checked="checked.has(edge.id)"
              @change="toggle(edge.id)"
            />
            <span class="ecp-row__body">
              <span class="ecp-row__fact">
                {{ edge.fact }}
                <span v-if="edge.core === true" class="ecp-core">{{ t('save.toCard.classify.coreBadge') }}</span>
              </span>
              <span class="ecp-row__pair">{{ edge.sourceEntity }} → {{ edge.targetEntity }}</span>
            </span>
          </label>

          <!-- pagination -->
          <div v-if="group.totalPages > 1" class="ecp-page">
            <Tooltip :text="t('save.toCard.classify.prevPage')" interactive>
              <button
                type="button"
                class="ecp-page__btn"
                :disabled="group.page <= 1"
                :aria-label="t('save.toCard.classify.prevPage')"
                @click="setPage(group.key, group.page - 1)"
              >‹</button>
            </Tooltip>
            <span class="ecp-page__label">{{ group.page }} / {{ group.totalPages }}</span>
            <Tooltip :text="t('save.toCard.classify.nextPage')" interactive>
              <button
                type="button"
                class="ecp-page__btn"
                :disabled="group.page >= group.totalPages"
                :aria-label="t('save.toCard.classify.nextPage')"
                @click="setPage(group.key, group.page + 1)"
              >›</button>
            </Tooltip>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ecp { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ecp :where(p, span, button) { overflow-wrap: anywhere; }
.ecp-title {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.98rem;
  font-weight: 500;
  color: var(--color-text);
}
.ecp-hint { margin: 0; font-size: 0.82rem; color: var(--color-text-secondary); }

.ecp-run { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ecp-btn {
  padding: 6px 14px;
  font-size: 0.84rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 14%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.16s var(--ease-out);
}
.ecp-btn--primary {
  color: var(--color-bg);
  background: var(--color-sage-400);
  box-shadow: none;
}
.ecp-progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.84rem;
  color: var(--color-text);
}
.ecp-fail { margin: 0; font-size: 0.8rem; color: var(--color-amber-400); }
.ecp-count { margin-left: auto; font-size: 0.8rem; color: var(--color-text-secondary); }

/* bulk selection chips */
.ecp-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ecp-bulk__label { font-size: 0.78rem; color: var(--color-text-secondary); margin-right: 2px; }
.ecp-chip {
  padding: 3px 10px;
  font-size: 0.76rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 12%, transparent);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background 0.14s var(--ease-out), color 0.14s var(--ease-out);
}
.ecp-chip:hover { color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); }
.ecp-chip--sm { padding: 2px 8px; font-size: 0.72rem; }

.ecp-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 320px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}
.ecp-groups::-webkit-scrollbar { width: 4px; }
.ecp-groups::-webkit-scrollbar-track { background: transparent; }
.ecp-groups::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 2px; }
.ecp-groups::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }

.ecp-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.ecp-group__title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  min-width: 0;
}
.ecp-group__title--worldview { color: var(--color-sage-400); }
.ecp-group__title--pending { color: var(--color-amber-400); }
.ecp-group__bulk { display: flex; gap: 4px; flex-shrink: 0; }

.ecp-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.14s var(--ease-out);
}
.ecp-row:hover { background: color-mix(in oklch, var(--color-text) 5%, transparent); }
.ecp-row__box { margin-top: 3px; flex-shrink: 0; accent-color: var(--color-sage-400); }
.ecp-row__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ecp-row__fact {
  font-size: 0.84rem;
  color: var(--color-text);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ecp-row__pair { font-size: 0.74rem; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.ecp-core {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  font-size: 0.7rem;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
  border-radius: var(--radius-full);
  vertical-align: 1px;
}

/* pagination */
.ecp-page {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}
.ecp-page__btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 12%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ecp-page__btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ecp-page__btn:not(:disabled):hover { color: var(--color-sage-300); }
.ecp-page__label { font-size: 0.78rem; color: var(--color-text-secondary); }

.spinner--sm {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in oklch, var(--color-text) 20%, transparent);
  border-top-color: var(--color-sage-400);
  border-radius: 50%;
  animation: ecp-spin 0.8s linear infinite;
}
@keyframes ecp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spinner--sm { animation: none; }
}
</style>
