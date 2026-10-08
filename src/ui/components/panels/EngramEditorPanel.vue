<script setup lang="ts">
/**
 * EngramEditorPanel — Full CRUD editor for Engram entities and knowledge edges.
 *
 * Story 1 of Game Card Epic (plan section 5.3).
 *
 * Layout:
 *   - EngramGraphView (350px, read-only)
 *   - Stats bar (entity/edge/core/pending counts)
 *   - Coverage bar (NPC coverage %, missing names)
 *   - Entity list with pagination, inline edit/delete
 *   - Edge list with pagination, inline edit/delete
 *   - Operations bar (vectorize all)
 */
// App doc: docs/user-guide/pages/game-relationship-graph.md
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import { useEngramEditor } from '@/ui/composables/useEngramEditor';
import { useBatchSolidify } from '@/ui/composables/useBatchSolidify';
import { loadEngramConfig } from '@/engine/memory/engram/engram-config';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type { CoverageStats } from '@/engine/memory/engram/engram-editor';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import EngramGraphView from '@/ui/components/engram/EngramGraphView.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t } = useI18n();

// ─── Engram enabled check (reactive via eventBus) ───
const engramEnabled = ref(loadEngramConfig().enabled);
let offEngramConfig: (() => void) | null = null;

// ─── State manager + composable ───
const stateManager = injectService('stateManager');

let editor: ReturnType<typeof useEngramEditor> | null = null;
try {
  editor = useEngramEditor();
} catch {
  // EngramEditor not provided — panel will show not-enabled state
}

const batchSolidify = useBatchSolidify();

// ─── Reactive data ───
const entities = ref<EngramEntity[]>([]);
const edges = ref<EngramEdge[]>([]);
const coverage = ref<CoverageStats>({
  totalNpcs: 0,
  npcsWithEntity: 0,
  missingNpcNames: [],
  coveragePercent: 100,
  totalLocations: 0,
  locationsWithEntity: 0,
  missingLocationNames: [],
  locationCoveragePercent: 100,
  totalEdges: 0,
  edgesBySource: { opening: 0, user: 0, 'batch-sync': 0, 'card-import': 0, legacy: 0 },
});

function loadData(): void {
  if (!stateManager) return;
  const engram = stateManager.get<{
    entities: EngramEntity[];
    v2Edges: EngramEdge[];
  }>(DEFAULT_ENGINE_PATHS.engramMemory);
  entities.value = engram?.entities ?? [];
  edges.value = engram?.v2Edges ?? [];
  if (editor) {
    coverage.value = editor.getCoverageStats();
  }
}

// ─── Event bus listener for state changes ───
function onStateChanged(): void {
  loadData();
}

onMounted(() => {
  loadData();
  eventBus.on('engine:state-changed', onStateChanged);
  offEngramConfig = eventBus.on('engram:config-changed', () => {
    engramEnabled.value = loadEngramConfig().enabled;
  });
});

onUnmounted(() => {
  eventBus.off('engine:state-changed', onStateChanged);
  offEngramConfig?.();
});

// ─── Stats ───
const entityCount = computed(() => entities.value.length);
const edgeCount = computed(() => edges.value.length);
const coreCount = computed(() => edges.value.filter((e) => e.core).length);
const pendingCount = computed(() => {
  const unembeddedEntities = entities.value.filter((e) => !e.is_embedded).length;
  const unembeddedEdges = edges.value.filter((e) => !e.is_embedded).length;
  return unembeddedEntities + unembeddedEdges;
});

// ─── Entity type badge helpers ───
// Badge fills reference design tokens (sage/amber/umber family) so they stay
// on-palette; resolved at render time via CSS var() in the inline :style.
const ENTITY_TYPE_COLORS: Record<string, string> = {
  npc: 'var(--color-text-umber)',
  location: 'var(--color-amber-400)',
  item: 'var(--color-sage-300)',
  player: 'var(--color-sage-500)',
};

function entityTypeLabel(type: string): string {
  const key = `engram.entity.type${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  return t(key);
}

function entityTypeBgColor(type: string): string {
  return ENTITY_TYPE_COLORS[type] ?? 'var(--color-text-umber)';
}

// ─── Pagination — Entities ───
const PAGE_SIZE = 20;
const entityPage = ref(0);

const entityPageCount = computed(() =>
  Math.max(1, Math.ceil(entities.value.length / PAGE_SIZE)),
);
const pagedEntities = computed(() => {
  const start = entityPage.value * PAGE_SIZE;
  return entities.value.slice(start, start + PAGE_SIZE);
});

// ─── Pagination — Edges ───
const edgePage = ref(0);
const edgePageCount = computed(() =>
  Math.max(1, Math.ceil(edges.value.length / PAGE_SIZE)),
);
const pagedEdges = computed(() => {
  const start = edgePage.value * PAGE_SIZE;
  return edges.value.slice(start, start + PAGE_SIZE);
});

// ─── Entity CRUD state ───
const showEntityForm = ref(false);
const entityFormMode = ref<'create' | 'edit'>('create');
const entityFormName = ref('');
const entityFormType = ref<EngramEntity['type']>('npc');
const entityFormSummary = ref('');
const editingEntityOriginalName = ref('');

function openCreateEntity(): void {
  entityFormMode.value = 'create';
  entityFormName.value = '';
  entityFormType.value = 'npc';
  entityFormSummary.value = '';
  editingEntityOriginalName.value = '';
  showEntityForm.value = true;
}

function openEditEntity(entity: EngramEntity): void {
  entityFormMode.value = 'edit';
  entityFormName.value = entity.name;
  entityFormType.value = entity.type;
  entityFormSummary.value = entity.summary;
  editingEntityOriginalName.value = entity.name;
  showEntityForm.value = true;
}

function cancelEntityForm(): void {
  showEntityForm.value = false;
}

async function saveEntity(): Promise<void> {
  if (!editor) return;
  const name = entityFormName.value.trim();
  if (!name) return;

  if (entityFormMode.value === 'create') {
    await editor.createEntity({
      name,
      type: entityFormType.value,
      summary: entityFormSummary.value,
    });
  } else {
    const original = editingEntityOriginalName.value;
    // Update type + summary
    await editor.updateEntity(original, {
      type: entityFormType.value,
      summary: entityFormSummary.value,
    });
    // If name changed, rename
    if (name !== original) {
      await editor.renameEntity(original, name);
    }
  }
  showEntityForm.value = false;
  loadData();
}

// ─── Entity delete ───
const deletingEntityName = ref<string | null>(null);
const deleteEntityCascadeCount = ref(0);
const deleteEntityConfirmText = ref('');

function openDeleteEntity(entity: EngramEntity): void {
  const count = edges.value.filter(
    (e) => e.sourceEntity === entity.name || e.targetEntity === entity.name,
  ).length;
  deletingEntityName.value = entity.name;
  deleteEntityCascadeCount.value = count;
  deleteEntityConfirmText.value = '';
}

function cancelDeleteEntity(): void {
  deletingEntityName.value = null;
}

async function confirmDeleteEntity(): Promise<void> {
  if (!editor || !deletingEntityName.value) return;
  if (deleteEntityCascadeCount.value >= 5 && deleteEntityConfirmText.value !== deletingEntityName.value) {
    return;
  }
  await editor.deleteEntity(deletingEntityName.value, { cascade: true });
  deletingEntityName.value = null;
  loadData();
}

// ─── Edge CRUD state ───
const showEdgeForm = ref(false);
const edgeFormMode = ref<'create' | 'edit'>('create');
const edgeFormSource = ref('');
const edgeFormTarget = ref('');
const edgeFormFact = ref('');
const edgeFormCore = ref(false);
const editingEdgeId = ref('');

function openCreateEdge(): void {
  edgeFormMode.value = 'create';
  edgeFormSource.value = '';
  edgeFormTarget.value = '';
  edgeFormFact.value = '';
  edgeFormCore.value = false;
  editingEdgeId.value = '';
  showEdgeForm.value = true;
}

function openEditEdge(edge: EngramEdge): void {
  edgeFormMode.value = 'edit';
  edgeFormSource.value = edge.sourceEntity;
  edgeFormTarget.value = edge.targetEntity;
  edgeFormFact.value = edge.fact;
  edgeFormCore.value = edge.core === true;
  editingEdgeId.value = edge.id;
  showEdgeForm.value = true;
}

function cancelEdgeForm(): void {
  showEdgeForm.value = false;
}

async function saveEdge(): Promise<void> {
  if (!editor) return;

  if (edgeFormMode.value === 'create') {
    const result = await editor.createEdge({
      sourceEntity: edgeFormSource.value,
      targetEntity: edgeFormTarget.value,
      fact: edgeFormFact.value,
      core: edgeFormCore.value || undefined,
      source: 'user',
    });
    // Toast auto-stubbed entities
    if (result?.autoStubbed) {
      for (const name of result.autoStubbed) {
        eventBus.emit('ui:toast', {
          type: 'info',
          message: t('engram.editor.autoStubbed', { name }),
          duration: 2500,
        });
      }
    }
  } else {
    await editor.updateEdge(editingEdgeId.value, {
      sourceEntity: edgeFormSource.value,
      targetEntity: edgeFormTarget.value,
      fact: edgeFormFact.value,
      core: edgeFormCore.value || undefined,
    });
  }
  showEdgeForm.value = false;
  loadData();
}

// ─── Edge delete ───
const deletingEdgeId = ref<string | null>(null);

function openDeleteEdge(edgeId: string): void {
  deletingEdgeId.value = edgeId;
}

function cancelDeleteEdge(): void {
  deletingEdgeId.value = null;
}

async function confirmDeleteEdge(): Promise<void> {
  if (!editor || !deletingEdgeId.value) return;
  await editor.deleteEdge(deletingEdgeId.value);
  deletingEdgeId.value = null;
  loadData();
}

// ─── Edge entity dropdown options (AgaSelect) ───
const entitySelectOptions = computed<{ label: string; value: string }[]>(() =>
  entities.value.map((e) => ({ label: e.name, value: e.name })),
);

// ─── Entity type radio options (custom token-styled segmented control) ───
const entityTypeOptions = computed<{ label: string; value: EngramEntity['type'] }[]>(() => [
  { label: 'NPC', value: 'npc' },
  { label: t('engram.entity.typeLocation'), value: 'location' },
  { label: t('engram.entity.typeItem'), value: 'item' },
]);

// WAI-ARIA radiogroup keyboard nav for the entity-type segmented control:
// arrow keys move both selection and focus (roving tabindex in the template).
function onEntityTypeKeydown(e: KeyboardEvent): void {
  const opts = entityTypeOptions.value;
  const cur = opts.findIndex((o) => o.value === entityFormType.value);
  let next = cur;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % opts.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + opts.length) % opts.length;
  else return;
  e.preventDefault();
  entityFormType.value = opts[next].value;
  const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.segmented__item');
  btns[next]?.focus();
}

// ─── Edge source label helper ───
function edgeSourceLabel(source?: string): string {
  if (!source) return t('engram.editor.edge.sourceLabel.ai');
  const key = `engram.editor.edge.sourceLabel.${source}`;
  return t(key);
}

// ─── Vectorize ───
const vectorizing = ref(false);

async function vectorizeAll(): Promise<void> {
  if (!editor || vectorizing.value) return;
  vectorizing.value = true;
  try {
    const result = await editor.vectorize();
    eventBus.emit('ui:toast', {
      type: 'success',
      message: t('engram.editor.vectorize.done', { count: result.vectorized }),
      duration: 2500,
    });
    loadData();
  } finally {
    vectorizing.value = false;
  }
}

// ─── Batch solidify ───
async function runBatchSolidify(): Promise<void> {
  if (!batchSolidify) return;
  await batchSolidify.run();
  loadData();
}

// ─── Coverage source distribution (non-zero buckets only) ───
const nonZeroSources = computed(() => {
  const src = coverage.value.edgesBySource;
  const labels: Array<{ key: string; count: number }> = [];
  if (src.opening > 0) labels.push({ key: 'engram.batchSolidify.stats.sourceOpening', count: src.opening });
  if (src.user > 0) labels.push({ key: 'engram.batchSolidify.stats.sourceUser', count: src.user });
  if (src['batch-sync'] > 0) labels.push({ key: 'engram.batchSolidify.stats.sourceBatchSync', count: src['batch-sync'] });
  if (src['card-import'] > 0) labels.push({ key: 'engram.batchSolidify.stats.sourceCardImport', count: src['card-import'] });
  if (src.legacy > 0) labels.push({ key: 'engram.batchSolidify.stats.sourceLegacy', count: src.legacy });
  return labels;
});

// ─── Graph interaction placeholders ───
const highlightedEntityName = ref<string | null>(null);
const highlightedEdgeId = ref<string | null>(null);

function onEntityHover(name: string | null): void {
  highlightedEntityName.value = name;
}

function onEdgeHover(id: string | null): void {
  highlightedEdgeId.value = id;
}

// Scroll-to helpers (graph click → list scroll)
const entityListRef = ref<HTMLElement | null>(null);
const edgeListRef = ref<HTMLElement | null>(null);

function scrollToEntity(name: string): void {
  if (!entityListRef.value) return;
  // Find the page containing this entity
  const idx = entities.value.findIndex((e) => e.name === name);
  if (idx < 0) return;
  const page = Math.floor(idx / PAGE_SIZE);
  entityPage.value = page;
  highlightedEntityName.value = name;
  nextTick(() => {
    const el = entityListRef.value?.querySelector(`[data-entity-name="${name}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function scrollToEdge(edgeId: string): void {
  if (!edgeListRef.value) return;
  const idx = edges.value.findIndex((e) => e.id === edgeId);
  if (idx < 0) return;
  const page = Math.floor(idx / PAGE_SIZE);
  edgePage.value = page;
  highlightedEdgeId.value = edgeId;
  nextTick(() => {
    const el = edgeListRef.value?.querySelector(`[data-edge-id="${edgeId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ─── Entity core-edge count helper ───
function entityCoreEdgeCount(entityName: string): number {
  return edges.value.filter(
    (e) => e.core && (e.sourceEntity === entityName || e.targetEntity === entityName),
  ).length;
}

// ─── Panel + section collapse ───
const collapsed = ref(false);
const entitySectionOpen = ref(true);
const edgeSectionOpen = ref(true);
</script>

<template>
  <div class="engram-editor-panel">
    <!-- Not-enabled state -->
    <template v-if="!engramEnabled">
      <div class="not-enabled">
        <h3 class="not-enabled__title">{{ t('engram.editor.notEnabled.title') }}</h3>
        <p class="not-enabled__hint">{{ t('engram.editor.notEnabled.hint') }}</p>
      </div>
    </template>

    <template v-else>
      <!-- Header -->
      <div class="panel-header">
        <h2 class="panel-title">{{ t('engram.editor.title') }}</h2>
        <Tooltip :text="collapsed ? t('common.actions.expand') : t('common.actions.collapse')" interactive>
          <AgaButton variant="ghost" size="sm" class="collapse-btn" @click="collapsed = !collapsed">
            {{ collapsed ? '+' : '−' }}
          </AgaButton>
        </Tooltip>
      </div>

      <div v-show="!collapsed" class="panel-body">
        <!-- ── Graph view ── -->
        <div class="graph-area">
          <EngramGraphView
            :entities="entities"
            :edges="edges"
            :highlighted-entity-name="highlightedEntityName ?? undefined"
            :highlighted-edge-id="highlightedEdgeId ?? undefined"
            :stats="{ entities: entityCount, edges: edgeCount, core: coreCount, pending: pendingCount }"
            @click-node="scrollToEntity"
            @click-edge="scrollToEdge"
          />
        </div>

        <!-- ── Coverage & Batch Solidify ── -->
        <div v-if="coverage.totalNpcs > 0 || coverage.totalLocations > 0" class="coverage-section">
          <div class="coverage-header">
            <span class="coverage-title">{{ t('engram.batchSolidify.title') }}</span>
          </div>

          <!-- NPC coverage bar -->
          <Tooltip
            v-if="coverage.totalNpcs > 0"
            :text="t('engram.batchSolidify.npcCoverageTooltip', { with: coverage.npcsWithEntity, total: coverage.totalNpcs })"
          >
            <div class="coverage-row">
              <span class="coverage-label">{{ t('engram.batchSolidify.stats.npc') }}</span>
              <div class="coverage-bar-track">
                <div class="coverage-bar-fill" :style="{ width: coverage.coveragePercent + '%' }" />
              </div>
              <span class="coverage-ratio">{{ coverage.npcsWithEntity }}/{{ coverage.totalNpcs }} ({{ coverage.coveragePercent }}%)</span>
            </div>
          </Tooltip>

          <!-- Location coverage bar -->
          <Tooltip
            v-if="coverage.totalLocations > 0"
            :text="t('engram.batchSolidify.locationCoverageTooltip', { with: coverage.locationsWithEntity, total: coverage.totalLocations })"
          >
            <div class="coverage-row">
              <span class="coverage-label">{{ t('engram.batchSolidify.stats.location') }}</span>
              <div class="coverage-bar-track">
                <div class="coverage-bar-fill" :style="{ width: coverage.locationCoveragePercent + '%' }" />
              </div>
              <span class="coverage-ratio">{{ coverage.locationsWithEntity }}/{{ coverage.totalLocations }} ({{ coverage.locationCoveragePercent }}%)</span>
            </div>
          </Tooltip>

          <!-- Coverage formula annotation -->
          <div class="coverage-formula">
            = Engram proper entities / state tree entries (stubs excluded)
          </div>

          <!-- Edge count + source distribution -->
          <div v-if="coverage.totalEdges > 0" class="coverage-edge-stats">
            <span class="coverage-edge-count">{{ t('engram.batchSolidify.stats.edges') }} {{ coverage.totalEdges }}</span>
            <span
              v-for="src in nonZeroSources"
              :key="src.key"
              class="source-chip"
            >{{ t(src.key) }} {{ src.count }}</span>
          </div>

          <!-- Operations row: solidify + vectorize side by side -->
          <div class="ops-row">
            <!-- Batch solidify (AI edge generation) -->
            <Tooltip
              v-if="batchSolidify.available"
              :text="t('engram.batchSolidify.buttonTooltip')"
              interactive
            >
              <AgaButton
                variant="secondary"
                size="sm"
                :disabled="batchSolidify.isRunning.value"
                @click="runBatchSolidify"
              >
                <span v-if="batchSolidify.isRunning.value" class="spinner-sm" />
                <span v-else class="op-icon">&#9889;</span>
                {{ batchSolidify.isRunning.value ? batchSolidify.getProgressMessage() : t('engram.batchSolidify.buttonLabel') }}
              </AgaButton>
            </Tooltip>
            <AgaButton
              v-if="batchSolidify.available && batchSolidify.lastError.value"
              variant="warning"
              size="sm"
              :disabled="batchSolidify.isRunning.value"
              @click="runBatchSolidify"
            >{{ t('engram.batchSolidify.retry') }}</AgaButton>

            <!-- Vectorize (embedding computation, no AI) -->
            <AgaButton
              variant="ghost"
              size="sm"
              :disabled="vectorizing || pendingCount === 0"
              @click="vectorizeAll"
            >
              <span v-if="vectorizing" class="spinner-sm" />
              {{ vectorizing ? t('engram.editor.vectorize.running') : t('engram.editor.vectorize.button') }}
            </AgaButton>
            <span v-if="pendingCount > 0" class="pending-hint">{{ pendingCount }} {{ t('engram.editor.stats.pending') }}</span>
          </div>

          <!-- Missing names -->
          <div v-if="coverage.missingNpcNames.length > 0 || coverage.missingLocationNames.length > 0" class="coverage-missing">
            <span class="coverage-missing-label">{{ t('engram.batchSolidify.stats.missing') }}:</span>
            <span class="coverage-missing-names">
              {{ [...coverage.missingNpcNames, ...coverage.missingLocationNames].slice(0, 5).join(', ') }}
              <template v-if="coverage.missingNpcNames.length + coverage.missingLocationNames.length > 5">
                ... (+{{ coverage.missingNpcNames.length + coverage.missingLocationNames.length - 5 }})
              </template>
            </span>
          </div>
        </div>

        <!-- ══════════════════════════════════════════════════════
             ENTITY LIST
             ══════════════════════════════════════════════════════ -->
        <section class="debug-section">
          <div
            class="section-header"
            role="button"
            tabindex="0"
            :aria-expanded="entitySectionOpen"
            @click="entitySectionOpen = !entitySectionOpen"
            @keydown.enter.self.prevent="entitySectionOpen = !entitySectionOpen"
            @keydown.space.self.prevent="entitySectionOpen = !entitySectionOpen"
          >
            <span class="section-title">{{ t('engram.section.entityList') }}</span>
            <span class="section-badge">{{ entityCount }}</span>
            <span class="section-header__spacer" />
            <button class="btn-create" @click.stop="openCreateEntity">+ {{ t('engram.editor.entity.create') }}</button>
            <svg :class="['chevron', { 'chevron--open': entitySectionOpen }]" viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </div>
          <Transition name="section-expand">
          <div v-if="entitySectionOpen" class="section-body">

          <!-- Entity create/edit form -->
          <div v-if="showEntityForm" class="inline-form">
            <h4 class="inline-form__title">
              {{ entityFormMode === 'create' ? t('engram.editor.entity.create') : t('engram.editor.entity.edit') }}
            </h4>
            <div class="form-field">
              <label class="form-label">{{ t('engram.editor.entity.name') }}</label>
              <input
                v-model="entityFormName"
                type="text"
                class="form-input"
                :readonly="entityFormMode === 'edit'"
                :class="{ 'form-input--readonly': entityFormMode === 'edit' }"
              />
            </div>
            <div class="form-field">
              <label class="form-label">{{ t('engram.editor.entity.type') }}</label>
              <div class="segmented" role="radiogroup" :aria-label="t('engram.editor.entity.type')" @keydown="onEntityTypeKeydown">
                <button
                  v-for="opt in entityTypeOptions"
                  :key="opt.value"
                  type="button"
                  class="segmented__item"
                  :class="{ 'segmented__item--active': entityFormType === opt.value }"
                  role="radio"
                  :aria-checked="entityFormType === opt.value"
                  :tabindex="entityFormType === opt.value ? 0 : -1"
                  @click="entityFormType = opt.value"
                >{{ opt.label }}</button>
              </div>
            </div>
            <div class="form-field">
              <label class="form-label">{{ t('engram.editor.entity.summary') }}</label>
              <textarea v-model="entityFormSummary" class="form-textarea" rows="3" />
            </div>
            <div class="inline-form__actions">
              <AgaButton variant="secondary" size="sm" @click="cancelEntityForm">{{ t('engram.editor.entity.cancel') }}</AgaButton>
              <AgaButton
                variant="primary"
                size="sm"
                :disabled="!entityFormName.trim()"
                @click="saveEntity"
              >{{ t('engram.editor.entity.save') }}</AgaButton>
            </div>
          </div>

          <!-- Entity list -->
          <div ref="entityListRef" class="item-list">
            <template v-if="pagedEntities.length > 0">
              <TransitionGroup name="list">
                <div
                  v-for="entity in pagedEntities"
                  :key="entity.name"
                  :data-entity-name="entity.name"
                  :class="['entity-card', { 'entity-card--highlighted': highlightedEntityName === entity.name }]"
                  @mouseenter="onEntityHover(entity.name)"
                  @mouseleave="onEntityHover(null)"
                >
                  <!-- Delete confirmation inline -->
                  <div v-if="deletingEntityName === entity.name" class="delete-confirm">
                    <p class="delete-confirm__msg">
                      {{ t('engram.editor.confirm.deleteEntity', { name: entity.name }) }}
                    </p>
                    <p v-if="deleteEntityCascadeCount > 0 && deleteEntityCascadeCount < 5" class="delete-confirm__warn">
                      {{ t('engram.editor.confirm.cascadeWarning', { count: deleteEntityCascadeCount }) }}
                    </p>
                    <template v-if="deleteEntityCascadeCount >= 5">
                      <p class="delete-confirm__warn delete-confirm__warn--heavy">
                        {{ t('engram.editor.confirm.cascadeHeavy', { count: deleteEntityCascadeCount }) }}
                      </p>
                      <input
                        v-model="deleteEntityConfirmText"
                        type="text"
                        class="form-input delete-confirm__input"
                        :placeholder="deletingEntityName ?? ''"
                      />
                    </template>
                    <div class="delete-confirm__actions">
                      <AgaButton variant="secondary" size="sm" @click="cancelDeleteEntity">{{ t('engram.editor.entity.cancel') }}</AgaButton>
                      <AgaButton
                        variant="danger"
                        size="sm"
                        :disabled="deleteEntityCascadeCount >= 5 && deleteEntityConfirmText !== deletingEntityName"
                        @click="confirmDeleteEntity"
                      >{{ t('engram.editor.entity.delete') }}</AgaButton>
                    </div>
                  </div>

                  <!-- Normal entity display -->
                  <template v-else>
                    <div class="entity-card__header">
                      <span
                        class="type-badge"
                        :style="{ background: entityTypeBgColor(entity.type) }"
                      >{{ entityTypeLabel(entity.type) }}</span>
                      <span class="entity-card__name">{{ entity.name }}</span>
                      <span v-if="entityCoreEdgeCount(entity.name) > 0" class="core-count">
                        {{ t('engram.editor.entity.coreEdges', { count: entityCoreEdgeCount(entity.name) }) }}
                      </span>
                      <div class="entity-card__actions">
                        <Tooltip :text="t('engram.editor.entity.edit')" interactive>
                          <button class="btn-icon" @click.stop="openEditEntity(entity)">&#9998;</button>
                        </Tooltip>
                        <Tooltip :text="t('engram.editor.entity.delete')" interactive>
                          <button class="btn-icon btn-icon--danger" @click.stop="openDeleteEntity(entity)">&times;</button>
                        </Tooltip>
                      </div>
                    </div>
                    <p v-if="entity.summary" class="entity-card__summary">{{ entity.summary }}</p>
                  </template>
                </div>
              </TransitionGroup>
            </template>
            <div v-else class="empty-hint">{{ t('engram.editor.entity.empty') }}</div>
          </div>

          <!-- Entity pagination -->
          <div v-if="entityPageCount > 1" class="pagination">
            <Tooltip :text="t('common.actions.previous')" interactive>
              <button
                class="btn-page"
                :disabled="entityPage <= 0"
                @click="entityPage--"
              >&laquo;</button>
            </Tooltip>
            <span class="page-info">{{ entityPage + 1 }} / {{ entityPageCount }}</span>
            <Tooltip :text="t('common.actions.next')" interactive>
              <button
                class="btn-page"
                :disabled="entityPage >= entityPageCount - 1"
                @click="entityPage++"
              >&raquo;</button>
            </Tooltip>
          </div>
          </div>
          </Transition>
        </section>

        <!-- ══════════════════════════════════════════════════════
             EDGE LIST
             ══════════════════════════════════════════════════════ -->
        <section class="debug-section">
          <div
            class="section-header"
            role="button"
            tabindex="0"
            :aria-expanded="edgeSectionOpen"
            @click="edgeSectionOpen = !edgeSectionOpen"
            @keydown.enter.self.prevent="edgeSectionOpen = !edgeSectionOpen"
            @keydown.space.self.prevent="edgeSectionOpen = !edgeSectionOpen"
          >
            <span class="section-title">{{ t('engram.section.factEdges') }}</span>
            <span class="section-badge">{{ edgeCount }}</span>
            <span class="section-header__spacer" />
            <button class="btn-create" @click.stop="openCreateEdge">+ {{ t('engram.editor.edge.create') }}</button>
            <svg :class="['chevron', { 'chevron--open': edgeSectionOpen }]" viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </div>
          <Transition name="section-expand">
          <div v-if="edgeSectionOpen" class="section-body">

          <!-- Edge create/edit form -->
          <div v-if="showEdgeForm" class="inline-form">
            <h4 class="inline-form__title">
              {{ edgeFormMode === 'create' ? t('engram.editor.edge.create') : t('engram.editor.edge.edit') }}
            </h4>
            <p v-if="edgeFormMode === 'edit'" class="inline-form__hint">
              {{ t('engram.editor.edge.idChangeWarning') }}
            </p>
            <div class="form-row-half">
              <div class="form-field">
                <label class="form-label">{{ t('engram.editor.edge.source') }}</label>
                <AgaSelect
                  v-model="edgeFormSource"
                  class="form-select-aga"
                  :options="entitySelectOptions"
                  :placeholder="t('engram.editor.edge.source')"
                  :ariaLabel="t('engram.editor.edge.source')"
                />
              </div>
              <div class="form-field">
                <label class="form-label">{{ t('engram.editor.edge.target') }}</label>
                <AgaSelect
                  v-model="edgeFormTarget"
                  class="form-select-aga"
                  :options="entitySelectOptions"
                  :placeholder="t('engram.editor.edge.target')"
                  :ariaLabel="t('engram.editor.edge.target')"
                />
              </div>
            </div>
            <div class="form-field">
              <label class="form-label">{{ t('engram.editor.edge.fact') }}</label>
              <textarea v-model="edgeFormFact" class="form-textarea" rows="3" />
            </div>
            <AgaToggle v-model="edgeFormCore" :label="t('engram.editor.edge.core')" show-label />
            <div class="inline-form__actions">
              <AgaButton variant="secondary" size="sm" @click="cancelEdgeForm">{{ t('engram.editor.edge.cancel') }}</AgaButton>
              <AgaButton
                variant="primary"
                size="sm"
                :disabled="!edgeFormSource || !edgeFormTarget || edgeFormFact.length < 10"
                @click="saveEdge"
              >{{ t('engram.editor.edge.save') }}</AgaButton>
            </div>
          </div>

          <!-- Edge list -->
          <div ref="edgeListRef" class="item-list">
            <template v-if="pagedEdges.length > 0">
              <TransitionGroup name="list">
                <div
                  v-for="edge in pagedEdges"
                  :key="edge.id"
                  :data-edge-id="edge.id"
                  :class="['edge-card', { 'edge-card--highlighted': highlightedEdgeId === edge.id }]"
                  @mouseenter="onEdgeHover(edge.id)"
                  @mouseleave="onEdgeHover(null)"
                >
                  <!-- Delete confirmation -->
                  <div v-if="deletingEdgeId === edge.id" class="delete-confirm">
                    <p class="delete-confirm__msg">{{ t('engram.editor.confirm.deleteEdge') }}</p>
                    <div class="delete-confirm__actions">
                      <AgaButton variant="secondary" size="sm" @click="cancelDeleteEdge">{{ t('engram.editor.edge.cancel') }}</AgaButton>
                      <AgaButton variant="danger" size="sm" @click="confirmDeleteEdge">{{ t('engram.editor.edge.delete') }}</AgaButton>
                    </div>
                  </div>

                  <!-- Normal edge display -->
                  <template v-else>
                    <div class="edge-card__header">
                      <span v-if="edge.core" class="core-badge">{{ t('engram.editor.edge.core') }}</span>
                      <span class="edge-card__path">
                        <span class="edge-card__entity">{{ edge.sourceEntity }}</span>
                        <span class="edge-card__arrow">&rarr;</span>
                        <span class="edge-card__entity">{{ edge.targetEntity }}</span>
                      </span>
                      <div class="edge-card__actions">
                        <Tooltip :text="t('engram.editor.edge.edit')" interactive>
                          <button class="btn-icon" @click.stop="openEditEdge(edge)">&#9998;</button>
                        </Tooltip>
                        <Tooltip :text="t('engram.editor.edge.delete')" interactive>
                          <button class="btn-icon btn-icon--danger" @click.stop="openDeleteEdge(edge.id)">&times;</button>
                        </Tooltip>
                      </div>
                    </div>
                    <p class="edge-card__fact">{{ edge.fact }}</p>
                    <div class="edge-card__meta">
                      <span class="meta-chip">{{ edgeSourceLabel(edge.source) }}</span>
                      <span class="meta-chip">{{ t('engram.edge.createdAt', { round: edge.createdAtRound }) }}</span>
                      <span :class="['meta-chip', edge.is_embedded ? 'meta-chip--ok' : 'meta-chip--pending']">
                        {{ edge.is_embedded ? t('engram.embed.vectorized') : t('engram.embed.notVectorized') }}
                      </span>
                    </div>
                  </template>
                </div>
              </TransitionGroup>
            </template>
            <div v-else class="empty-hint">{{ t('engram.editor.edge.empty') }}</div>
          </div>

          <!-- Edge pagination -->
          <div v-if="edgePageCount > 1" class="pagination">
            <Tooltip :text="t('common.actions.previous')" interactive>
              <button
                class="btn-page"
                :disabled="edgePage <= 0"
                @click="edgePage--"
              >&laquo;</button>
            </Tooltip>
            <span class="page-info">{{ edgePage + 1 }} / {{ edgePageCount }}</span>
            <Tooltip :text="t('common.actions.next')" interactive>
              <button
                class="btn-page"
                :disabled="edgePage >= edgePageCount - 1"
                @click="edgePage++"
              >&raquo;</button>
            </Tooltip>
          </div>
          </div>
          </Transition>
        </section>

        <!-- Operations bar removed — buttons moved to coverage card -->
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   EngramEditorPanel — Glass surface with sanctuary aesthetics
   All tokens from tokens.css; consistent with RelationshipPanel.
   ══════════════════════════════════════════════════════════════ */

.engram-editor-panel {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  padding-left: var(--sidebar-left-reserve, 40px);
  padding-right: var(--sidebar-right-reserve, 40px);
  transition: padding-left var(--duration-open, 0.3s) var(--ease-droplet, ease),
              padding-right var(--duration-open, 0.3s) var(--ease-droplet, ease);
}

/* ── Not-enabled state ── */
.not-enabled {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 40px;
}

.not-enabled__title {
  font-size: 1.1rem;
  font-weight: 700;
  font-family: var(--font-serif-cjk);
  color: var(--color-text-bone);
  margin: 0 0 12px;
}

.not-enabled__hint {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  margin: 0;
  line-height: 1.6;
}

/* ── Panel header ── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  font-family: var(--font-serif-cjk);
  letter-spacing: 0.15em;
  color: var(--color-text-bone);
}

/* AgaButton ghost override: keep the compact square +/− toggle dimensions */
.collapse-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 1.1rem;
}

/* ── Graph area ── */
.graph-area {
  margin-bottom: 0;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
  border-radius: var(--radius-lg, 12px);
  position: relative;
  overflow: hidden;
}

.graph-area::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

.graph-empty,
.graph-placeholder-label {
  font-size: 0.82rem;
  color: var(--color-text-muted);
}

.graph-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── Stats bar ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  margin-bottom: 12px;
  background: var(--color-surface);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border-subtle);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.stat-label {
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}

.stat-value {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--color-text-bone);
}

.stat-value--core {
  color: var(--color-amber-400);
}

.stat-value--pending {
  color: var(--color-sage-400);
}

.stat-sep {
  width: 1px;
  height: 16px;
  background: var(--color-border);
}

/* ── Coverage section ── */
.coverage-section {
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--color-surface);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border-subtle);
}

.coverage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.coverage-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/* Coverage rows are wrapped in <Tooltip> — make the wrapper span full width
   so the bar track still flexes to fill the section. */
.coverage-section > :deep(.tt-wrap) {
  display: flex;
  width: 100%;
  margin-bottom: 6px;
}

.coverage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 6px;
}

:deep(.tt-wrap) > .coverage-row {
  margin-bottom: 0;
}

.coverage-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  min-width: 36px;
  flex-shrink: 0;
}

.coverage-ratio {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-bone);
  white-space: nowrap;
  flex-shrink: 0;
}

.coverage-bar-track {
  flex: 1;
  height: 6px;
  background: var(--color-surface-elevated);
  border-radius: 3px;
  overflow: hidden;
}

.coverage-bar-fill {
  height: 100%;
  background: var(--color-sage-400);
  border-radius: 3px;
  transition: width var(--duration-normal, 0.3s) ease;
}

.coverage-edge-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
  margin-bottom: 8px;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.coverage-edge-count {
  font-weight: 600;
  color: var(--color-text-secondary);
}

.source-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 0.72rem;
  color: var(--color-text-muted);
}

/* ── Compact operations row (solidify + vectorize side by side) ── */
.ops-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.op-icon {
  font-size: 0.85rem;
}

.spinner-sm {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--color-sage-400, #8a9e6c);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.pending-hint {
  font-size: 0.72rem;
  color: var(--color-amber-400, #c9a040);
}

.coverage-formula {
  font-size: 0.68rem;
  color: var(--color-text-muted, #555);
  font-style: italic;
  margin-top: 2px;
  margin-bottom: 4px;
}

.coverage-missing {
  margin-top: 8px;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}

.coverage-missing-label {
  font-weight: 600;
  margin-right: 4px;
}

.coverage-missing-names {
  color: var(--color-text-umber);
}

@media (max-width: 640px) {
  .coverage-row {
    flex-wrap: wrap;
  }
  .coverage-bar-track {
    width: 100%;
    flex: none;
  }
  .coverage-edge-stats {
    flex-direction: column;
    align-items: flex-start;
  }
}

/* ── Collapsible sections (debug-section pattern) ── */
/* §8: glass-grade container — no hard 1px border; edge-gradient ::before instead. */
.debug-section {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 12px;
}

.debug-section::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  z-index: 1;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: rgba(255,255,255,0.02);
  border: none;
  cursor: pointer;
  color: var(--color-text);
  transition: background 0.15s ease;
}
.section-header:hover { background: rgba(255,255,255,0.04); }

.section-title { font-size: 0.85rem; font-weight: 600; }

.section-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 18px; padding: 0 5px;
  font-size: 0.62rem; font-weight: 700; color: var(--color-text-bone);
  background: var(--color-sage-400); border-radius: 9px;
}

.section-header__spacer { flex: 1; }

.chevron { transition: transform 0.2s; color: var(--color-text-secondary); }
.chevron--open { transform: rotate(0deg); }
.chevron:not(.chevron--open) { transform: rotate(-90deg); }

.section-body { padding: 8px; display: flex; flex-direction: column; gap: 4px; }

.section-expand-enter-active { transition: all 0.2s ease; }
.section-expand-leave-active { transition: all 0.12s ease; }
.section-expand-enter-from,
.section-expand-leave-to { opacity: 0; max-height: 0; padding: 0 8px; }

.btn-create {
  padding: 4px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: all var(--duration-fast, 0.15s) ease;
}

.btn-create:hover {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border-color: var(--color-sage-400);
}

/* ── Inline forms ── */
.inline-form {
  padding: 16px;
  margin-bottom: 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
}

.inline-form__title {
  margin: 0 0 12px;
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--color-text-bone);
}

.inline-form__hint {
  font-size: 0.75rem;
  color: var(--color-text-umber);
  margin: 0 0 10px;
}

.inline-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.form-field {
  margin-bottom: 10px;
}

.form-label {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}

.form-input,
.form-textarea {
  width: 100%;
  font-size: 0.82rem;
  color: var(--color-text-bone);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm, 4px);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--duration-fast, 0.15s) ease,
              box-shadow var(--duration-fast, 0.15s) ease;
}

.form-input {
  height: 34px;
  padding: 0 10px;
}

.form-input:focus,
.form-textarea:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.form-input--readonly {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-textarea {
  padding: 8px 10px;
  resize: vertical;
  font-family: inherit;
}

/* AgaSelect fills the form column width */
.form-select-aga {
  display: block;
  width: 100%;
}

.form-row-half {
  display: flex;
  gap: 12px;
}

.form-row-half > .form-field {
  flex: 1;
}

/* ── Token-styled segmented radio control (entity type) ── */
.segmented {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  background: var(--color-surface-input);
  border-radius: var(--radius-md, 8px);
}

.segmented__item {
  padding: 4px 14px;
  font-size: 0.82rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: color var(--duration-fast, 0.15s) ease,
              background var(--duration-fast, 0.15s) ease,
              border-color var(--duration-fast, 0.15s) ease;
}

.segmented__item:hover:not(.segmented__item--active) {
  color: var(--color-text-bone);
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.segmented__item--active {
  color: var(--color-sage-100);
  background: var(--color-sage-muted);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}

.segmented__item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}

/* ── Item list ── */
.item-list {
  max-height: 420px;
  overflow-y: auto;
}

/* ── Entity card ── */
.entity-card {
  padding: 10px 14px;
  margin-bottom: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm, 4px);
  transition: all var(--duration-fast, 0.15s) ease;
}

.entity-card:hover {
  border-color: var(--color-border);
}

.entity-card--highlighted {
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}

.entity-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.type-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: 0.68rem;
  font-weight: 700;
  color: #fff;
  border-radius: var(--radius-full, 9999px);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.entity-card__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text-bone);
}

.core-count {
  font-size: 0.72rem;
  color: var(--color-amber-400);
  margin-left: auto;
}

.entity-card__actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--duration-fast, 0.15s) ease;
}

.entity-card:hover .entity-card__actions {
  opacity: 1;
}

.entity-card__summary {
  margin: 6px 0 0;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ── Edge card ── */
.edge-card {
  padding: 10px 14px;
  margin-bottom: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm, 4px);
  transition: all var(--duration-fast, 0.15s) ease;
}

.edge-card:hover {
  border-color: var(--color-border);
}

.edge-card--highlighted {
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}

.edge-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.core-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--color-bg);
  background: var(--color-amber-400);
  border-radius: var(--radius-full, 9999px);
  letter-spacing: 0.05em;
}

.edge-card__path {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85rem;
}

.edge-card__entity {
  font-weight: 600;
  color: var(--color-text-bone);
}

.edge-card__arrow {
  color: var(--color-text-muted);
  font-size: 0.8rem;
}

.edge-card__actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--duration-fast, 0.15s) ease;
}

.edge-card:hover .edge-card__actions {
  opacity: 1;
}

.edge-card__fact {
  margin: 6px 0 4px;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.edge-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.meta-chip {
  padding: 1px 8px;
  font-size: 0.68rem;
  color: var(--color-text-muted);
  background: var(--color-surface-elevated);
  border-radius: var(--radius-full, 9999px);
}

.meta-chip--ok {
  color: var(--color-sage-400);
}

.meta-chip--pending {
  color: var(--color-text-umber);
}

/* ── Shared icon button ── */
.btn-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: all var(--duration-fast, 0.15s) ease;
}

.btn-icon:hover {
  color: var(--color-text-bone);
  background: var(--color-surface-elevated);
}

.btn-icon--danger:hover {
  color: var(--color-danger, #ef4444);
}

/* ── Delete confirmation inline ── */
.delete-confirm {
  padding: 8px 0;
}

.delete-confirm__msg {
  margin: 0 0 6px;
  font-size: 0.82rem;
  color: var(--color-text-bone);
}

.delete-confirm__warn {
  margin: 0 0 6px;
  font-size: 0.78rem;
  color: var(--color-warning, #f59e0b);
}

.delete-confirm__warn--heavy {
  color: var(--color-danger, #ef4444);
}

.delete-confirm__input {
  width: 200px;
  margin-bottom: 8px;
}

.delete-confirm__actions {
  display: flex;
  gap: 8px;
}

/* ── Pagination ── */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 0;
}

.btn-page {
  width: 30px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: all var(--duration-fast, 0.15s) ease;
}

.btn-page:hover:not(:disabled) {
  color: var(--color-text-bone);
  border-color: var(--color-sage-400);
}

.btn-page:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}

/* ── Operations bar ── */
.operations-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0 8px;
  border-top: 1px solid var(--color-border-subtle);
}

.btn-vectorize {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  transition: all var(--duration-fast, 0.15s) ease;
}

.btn-vectorize:hover:not(:disabled) {
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  border-color: var(--color-sage-400);
}

.btn-vectorize:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.vectorize-hint {
  font-size: 0.75rem;
  color: var(--color-text-umber);
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-sage-400);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Empty hint ── */
.empty-hint {
  padding: 24px 0;
  text-align: center;
  font-size: 0.82rem;
  color: var(--color-text-muted);
}

/* ── TransitionGroup list animation ── */
.list-enter-active,
.list-leave-active {
  transition: all var(--duration-normal, 0.3s) ease;
}

.list-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.list-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* ── Scrollbar styling ── */
.item-list::-webkit-scrollbar {
  width: 4px;
}

.item-list::-webkit-scrollbar-track {
  background: transparent;
}

.item-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.item-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

.engram-editor-panel::-webkit-scrollbar {
  width: 4px;
}

.engram-editor-panel::-webkit-scrollbar-track {
  background: transparent;
}

.engram-editor-panel::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.engram-editor-panel::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}
</style>
