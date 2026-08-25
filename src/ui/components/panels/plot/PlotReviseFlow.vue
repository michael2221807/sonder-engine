<script setup lang="ts">
// App doc: docs/user-guide/pages/game-plot.md §续写 / 改写
// Design: docs/design/plot-arc-revise-extend.md §3.5 (revise flow modal)
//
// One modal, four states: request input → generating (cancellable) → diff
// preview (kept/modified/added/removed badges, seam highlight, dangling
// warnings BEFORE apply) → applied. The engine owns all rules: PlotReviser
// generates, previewRevise computes the diff, commitRevise applies with the
// optimistic pending-id lock taken at generation time.
import { ref, computed, watch, inject, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePlotStore } from '@/engine/plot/plot-store';
import type { PlotArc } from '@/engine/plot/types';
import type { PlotReviser, ReviseResult, ReviseNodeChainItem } from '@/engine/plot/plot-reviser';
import { previewRevise, commitRevise, type CommitReviseReport } from '@/engine/plot/plot-revise-commit';
import Modal from '@/ui/components/common/Modal.vue';
import AgaLoader from '@/ui/components/shared/AgaLoader.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{
  modelValue: boolean;
  arc: PlotArc | null;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'applied', report: CommitReviseReport): void;
}>();

const { t } = useI18n();
const plotStore = usePlotStore();
const plotReviser = inject<PlotReviser | null>('plotReviser', null);

const request = ref('');
const generating = ref(false);
const error = ref('');
const proposal = ref<ReviseResult | null>(null);
/** Optimistic lock (§3.5): pending-node ids at generation time. */
const pendingSnapshot = ref<string[]>([]);
/** Per-run choice: may the AI adjust the in-progress node's guidance this time? (D1 default: yes) */
const allowActiveUpdate = ref(true);
/** Row indexes the player expanded to read the proposed content. */
const expandedRows = ref<Set<number>>(new Set());
const activeExpanded = ref(false);
let abortController: AbortController | null = null;

const hasActiveNode = computed(() => !!props.arc?.nodes.some(n => n.status === 'active'));

// The proposal was generated under the scope chosen at generate() time —
// flipping the switch afterwards must visibly void it (otherwise Apply would
// silently use the old scope), same contract as editing the request text
// except a switch LOOKS instantaneous, so we enforce it.
watch(allowActiveUpdate, () => {
  if (proposal.value) {
    proposal.value = null;
    expandedRows.value = new Set();
    activeExpanded.value = false;
  }
});

function toggleRow(i: number): void {
  const next = new Set(expandedRows.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  expandedRows.value = next;
}

// ─── Single-node rewrite (user decision 2026-08-24: one extra call that sees
// the surrounding nodes so the arc stays coherent) ───
const nodeEditIndex = ref<number | null>(null);
const nodeEditRequest = ref('');
const nodeRevising = ref(false);
const nodeReviseError = ref('');

function openNodeEdit(i: number): void {
  if (generating.value || nodeRevising.value) return;
  nodeEditIndex.value = nodeEditIndex.value === i ? null : i;
  nodeEditRequest.value = '';
  nodeReviseError.value = '';
}

/** Full chain for the rewrite call: history (immutable, with evidence) + every proposal node. */
function buildChain(): { chain: ReviseNodeChainItem[]; offset: number } {
  const arc = props.arc;
  const nodes = proposal.value?.nodes ?? [];
  const prefix: ReviseNodeChainItem[] = (arc?.nodes ?? [])
    .filter(n => n.status !== 'pending')
    .map(n => ({
      title: n.title,
      premise: n.premise,
      narrativeGoal: n.narrativeGoal,
      directive: n.directive,
      stakes: n.stakes,
      completionHint: n.completionHint,
      emotionalTone: n.emotionalTone,
      importance: n.importance,
      maxRounds: n.maxRounds,
      kind: n.status === 'active' ? 'active' as const : 'done' as const,
      evidence: n.completionEvidence,
    }));
  const planned: ReviseNodeChainItem[] = nodes.map(p => ({
    title: p.title,
    premise: p.premise,
    narrativeGoal: p.narrativeGoal,
    directive: p.directive,
    stakes: p.stakes,
    completionHint: p.completionHint,
    emotionalTone: p.emotionalTone,
    importance: p.importance,
    maxRounds: p.maxRounds,
    kind: 'planned' as const,
  }));
  return { chain: [...prefix, ...planned], offset: prefix.length };
}

async function reviseSingleNode(): Promise<void> {
  const arc = props.arc;
  const i = nodeEditIndex.value;
  const req = nodeEditRequest.value.trim();
  if (!arc || !proposal.value || i === null || !req || !plotReviser || nodeRevising.value) return;
  nodeRevising.value = true;
  nodeReviseError.value = '';
  const ctrl = new AbortController();
  abortController = ctrl;
  try {
    const { chain, offset } = buildChain();
    const res = await plotReviser.reviseNode(
      { title: arc.title, synopsis: arc.synopsis, status: arc.status },
      chain, offset + i, req, { signal: ctrl.signal },
    );
    if (ctrl.signal.aborted) return;
    if (res && proposal.value) {
      proposal.value = {
        ...proposal.value,
        nodes: proposal.value.nodes.map((n, j) => (j === i ? res : n)),
      };
      // Show the result immediately: expand the row the player just rewrote.
      expandedRows.value = new Set(expandedRows.value).add(i);
      nodeEditIndex.value = null;
    } else if (res === null) {
      nodeReviseError.value = t('plot.revise.errNoResult');
    }
  } catch (err) {
    if (!ctrl.signal.aborted) {
      nodeReviseError.value = t('plot.revise.errFailed', { error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (!ctrl.signal.aborted) nodeRevising.value = false;
    if (abortController === ctrl) abortController = null;
  }
}

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

// A fresh target thread resets the whole flow (stale proposals must not
// survive a target switch) — including aborting an in-flight generation, so a
// proposal for arc A can never land under arc B's title.
watch(() => [props.modelValue, props.arc?.id], () => {
  abortController?.abort();
  abortController = null;
  request.value = '';
  proposal.value = null;
  error.value = '';
  generating.value = false;
  allowActiveUpdate.value = true;
  expandedRows.value = new Set();
  activeExpanded.value = false;
  nodeEditIndex.value = null;
  nodeEditRequest.value = '';
  nodeRevising.value = false;
  nodeReviseError.value = '';
});

// KeepAlive LRU eviction (mobile caps the cache) can destroy the panel
// mid-generation — don't leave the request running with no consumer.
onBeforeUnmount(() => abortController?.abort());

const preview = computed(() => {
  if (!proposal.value || !props.arc) return null;
  return previewRevise(plotStore.arcs, props.arc, proposal.value);
});

/** Prefix rows (history + in-progress) shown dimmed above the proposal rows. */
const prefixRows = computed(() =>
  (props.arc?.nodes ?? [])
    .filter(n => n.status !== 'pending')
    .map(n => ({ title: n.title, status: n.status })),
);

const synopsisChanged = computed(() =>
  proposal.value?.synopsis !== undefined && proposal.value.synopsis !== props.arc?.synopsis);

async function generate(): Promise<void> {
  const arc = props.arc;
  const req = request.value.trim();
  if (!arc || !req || !plotReviser || generating.value) return;
  generating.value = true;
  error.value = '';
  proposal.value = null;
  pendingSnapshot.value = arc.nodes.filter(n => n.status === 'pending').map(n => n.id);
  expandedRows.value = new Set();
  activeExpanded.value = false;
  // A regenerate voids any open node-edit panel too — a stale index would
  // point into the NEW proposal (or nowhere) and break the ✎ toggle.
  nodeEditIndex.value = null;
  nodeEditRequest.value = '';
  nodeReviseError.value = '';
  // Capture the controller locally: every post-await check must look at THIS
  // call's controller, never the shared slot (Cancel → Generate reassigns it,
  // and a settled first call must not clobber the second's state).
  const ctrl = new AbortController();
  abortController = ctrl;
  try {
    const res = await plotReviser.revise(arc.id, req, {
      signal: ctrl.signal,
      allowActiveNodeUpdate: allowActiveUpdate.value,
    });
    if (ctrl.signal.aborted) return;
    if (res) proposal.value = res;
    else error.value = t('plot.revise.errNoResult');
  } catch (err) {
    if (!ctrl.signal.aborted) {
      error.value = t('plot.revise.errFailed', { error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (!ctrl.signal.aborted) generating.value = false;
    if (abortController === ctrl) abortController = null;
  }
}

function cancelGenerate(): void {
  // Shared by both flows' Cancel buttons — the aborted call's finally skips
  // its own flag reset (signal.aborted), so BOTH flags reset here or a
  // cancelled node-rewrite would leave nodeRevising=true and gate every
  // button in the modal (review 2026-08-24 I1).
  abortController?.abort();
  generating.value = false;
  nodeRevising.value = false;
}

function apply(): void {
  const arc = props.arc;
  if (!arc || !proposal.value) return;
  const report = commitRevise(plotStore, arc.id, proposal.value, {
    expectedPendingIds: pendingSnapshot.value,
  });
  if (!report.ok) {
    // Each rejection means a different next step: stale → regenerate (proposal
    // voided); empty_nodes → this proposal is unusable for a draft thread;
    // busy → transient, just retry; the rest → the thread itself changed state.
    switch (report.error) {
      case 'stale':
        error.value = t('plot.revise.errStale');
        proposal.value = null;
        break;
      case 'empty_nodes':
        error.value = t('plot.revise.errEmptyNodes');
        break;
      case 'busy':
        error.value = t('plot.revise.errBusy');
        break;
      default:
        error.value = t('plot.revise.errApply');
    }
    return;
  }
  emit('applied', report);
  open.value = false;
}
</script>

<template>
  <Modal v-model="open" :title="t('plot.revise.title', { title: arc?.title ?? '' })" width="560px">
    <div class="revise-flow">
      <!-- Request -->
      <label class="rev-label">
        {{ t('plot.revise.requestLabel') }}
        <textarea
          v-model="request"
          class="rev-textarea"
          rows="3"
          :placeholder="t('plot.revise.requestPlaceholder')"
          :disabled="generating"
          data-testid="plot-revise-request"
        />
      </label>

      <!-- Per-run scope switch: only meaningful when a node is in progress -->
      <div v-if="hasActiveNode" class="rev-scope">
        <span
          :class="['rev-switch', { 'rev-switch--on': allowActiveUpdate }]"
          role="switch"
          tabindex="0"
          :aria-checked="allowActiveUpdate"
          :aria-label="t('plot.revise.allowActive')"
          data-testid="plot-revise-allow-active"
          @click="allowActiveUpdate = !allowActiveUpdate"
          @keydown.enter.prevent="allowActiveUpdate = !allowActiveUpdate"
          @keydown.space.prevent="allowActiveUpdate = !allowActiveUpdate"
        />
        <span class="rev-scope__label" @click="allowActiveUpdate = !allowActiveUpdate">
          {{ t('plot.revise.allowActive') }}
        </span>
      </div>

      <div class="rev-actions">
        <button
          v-if="!generating"
          class="rev-btn rev-btn--primary"
          :disabled="!request.trim() || !plotReviser || nodeRevising"
          data-testid="plot-revise-generate"
          @click="generate"
        >{{ proposal ? t('plot.revise.regenerate') : t('plot.revise.generate') }}</button>
        <template v-else>
          <AgaLoader size="sm" />
          <span class="rev-generating">{{ t('plot.revise.generating') }}</span>
          <button class="rev-btn" @click="cancelGenerate">{{ t('plot.revise.cancel') }}</button>
        </template>
      </div>

      <p v-if="error" class="rev-error" data-testid="plot-revise-error">{{ error }}</p>

      <!-- Preview -->
      <div v-if="proposal && preview" class="rev-preview" data-testid="plot-revise-preview">
        <p v-if="synopsisChanged" class="rev-synopsis">
          <span class="rev-badge rev-badge--modified">{{ t('plot.revise.badgeModified') }}</span>
          {{ t('plot.revise.synopsisLabel') }} {{ proposal.synopsis }}
        </p>

        <ul class="rev-chain">
          <li v-for="(row, i) in prefixRows" :key="'p' + i" class="rev-row-wrap">
            <div
              :class="['rev-row', 'rev-row--history', { 'rev-row--expandable': row.status === 'active' && preview.activeNodeDetails.length > 0 }]"
              @click="row.status === 'active' && preview.activeNodeDetails.length > 0 && (activeExpanded = !activeExpanded)"
            >
              <span class="rev-icon">{{ row.status === 'active' ? '●' : row.status === 'skipped' ? '⏭' : '✓' }}</span>
              <span class="rev-row__title">{{ row.title }}</span>
              <span
                v-if="row.status === 'active' && preview.activeNodeDetails.length > 0"
                class="rev-badge rev-badge--modified"
                data-testid="plot-revise-active-updated"
              >{{ t('plot.revise.activeUpdated') }}</span>
              <span v-if="row.status === 'active' && preview.activeNodeDetails.length > 0" class="rev-chevron">{{ activeExpanded ? '▾' : '▸' }}</span>
            </div>
            <dl v-if="row.status === 'active' && activeExpanded" class="rev-details" data-testid="plot-revise-active-details">
              <template v-for="d in preview.activeNodeDetails" :key="d.field">
                <dt>{{ t(`plot.revise.field.${d.field}`) }}</dt>
                <dd>
                  <s v-if="d.before" class="rev-details__before">{{ d.before }}</s>
                  <span class="rev-details__after">{{ d.after }}</span>
                </dd>
              </template>
            </dl>
          </li>
          <li v-for="(row, i) in preview.rows" :key="'r' + i" class="rev-row-wrap">
            <div
              :class="['rev-row', `rev-row--${row.kind}`, { 'rev-row--seam': i === 0, 'rev-row--expandable': row.details.length > 0 }]"
              :data-testid="`plot-revise-row-${row.kind}`"
              @click="row.details.length > 0 && toggleRow(i)"
            >
              <span class="rev-icon">○</span>
              <span class="rev-row__title">{{ row.title }}</span>
              <span :class="['rev-badge', `rev-badge--${row.kind}`]">{{ t(`plot.revise.badge${row.kind === 'kept' ? 'Kept' : row.kind === 'modified' ? 'Modified' : 'Added'}`) }}</span>
              <Tooltip :text="t('plot.revise.nodeEditTip')" fixed interactive>
                <button
                  class="rev-node-edit-btn"
                  :disabled="generating || nodeRevising"
                  :aria-label="t('plot.revise.nodeEdit')"
                  data-testid="plot-revise-node-edit"
                  @click.stop="openNodeEdit(i)"
                >✎</button>
              </Tooltip>
              <span v-if="row.details.length > 0" class="rev-chevron">{{ expandedRows.has(i) ? '▾' : '▸' }}</span>
              <span v-if="i === 0 && proposal.nodes[0]?.premise" class="rev-seam">
                {{ t('plot.revise.seamLabel') }} {{ proposal.nodes[0].premise }}
              </span>
            </div>
            <div v-if="nodeEditIndex === i" class="rev-node-edit" data-testid="plot-revise-node-edit-area">
              <textarea
                v-model="nodeEditRequest"
                class="rev-textarea"
                rows="2"
                :placeholder="t('plot.revise.nodeEditPlaceholder')"
                :disabled="nodeRevising"
                data-testid="plot-revise-node-request"
              />
              <div class="rev-node-edit__actions">
                <template v-if="!nodeRevising">
                  <button
                    class="rev-btn rev-btn--primary"
                    :disabled="!nodeEditRequest.trim()"
                    data-testid="plot-revise-node-run"
                    @click="reviseSingleNode"
                  >{{ t('plot.revise.nodeEditRun') }}</button>
                  <button class="rev-btn" @click="nodeEditIndex = null">{{ t('plot.revise.cancel') }}</button>
                </template>
                <template v-else>
                  <AgaLoader size="sm" />
                  <span class="rev-generating">{{ t('plot.revise.nodeEditRunning') }}</span>
                  <button class="rev-btn" @click="cancelGenerate">{{ t('plot.revise.cancel') }}</button>
                </template>
              </div>
              <p v-if="nodeReviseError" class="rev-error" data-testid="plot-revise-node-error">{{ nodeReviseError }}</p>
            </div>
            <dl v-if="expandedRows.has(i)" class="rev-details" data-testid="plot-revise-row-details">
              <template v-for="d in row.details" :key="d.field">
                <dt>{{ t(`plot.revise.field.${d.field}`) }}</dt>
                <dd>
                  <s v-if="d.before" class="rev-details__before">{{ d.before }}</s>
                  <span class="rev-details__after">{{ d.after }}</span>
                </dd>
              </template>
            </dl>
          </li>
          <li v-for="(title, i) in preview.removedTitles" :key="'d' + i" class="rev-row-wrap">
            <div class="rev-row rev-row--removed" data-testid="plot-revise-row-removed">
              <span class="rev-icon">×</span>
              <span class="rev-row__title rev-row__title--removed">{{ title }}</span>
              <span class="rev-badge rev-badge--removed">{{ t('plot.revise.badgeRemoved') }}</span>
            </div>
          </li>
        </ul>

        <div
          v-if="preview.gaugeAdded.length || preview.gaugeUpdated.length || preview.gaugeRemoved.length"
          class="rev-gauges"
        >
          <span class="rev-gauges__label">{{ t('plot.revise.gaugeChanges') }}</span>
          <span v-for="g in preview.gaugeAdded" :key="'ga' + g" class="rev-badge rev-badge--added">+ {{ g }}</span>
          <span v-for="g in preview.gaugeUpdated" :key="'gu' + g" class="rev-badge rev-badge--modified">~ {{ g }}</span>
          <span v-for="g in preview.gaugeRemoved" :key="'gr' + g" class="rev-badge rev-badge--removed">− {{ g }}</span>
        </div>

        <p v-if="preview.danglingTriggerArcs.length" class="rev-warn" data-testid="plot-revise-warn-triggers">
          ⚠ {{ t('plot.revise.warnTriggers', { arcs: preview.danglingTriggerArcs.join(t('plot.revise.listSep')) }) }}
        </p>
        <p v-if="preview.danglingGaugeArcs.length" class="rev-warn" data-testid="plot-revise-warn-gauges">
          ⚠ {{ t('plot.revise.warnGauges', { arcs: preview.danglingGaugeArcs.join(t('plot.revise.listSep')) }) }}
        </p>
      </div>
    </div>

    <template #footer>
      <button
        class="rev-btn rev-btn--primary"
        :disabled="!proposal || nodeRevising"
        data-testid="plot-revise-apply"
        @click="apply"
      >{{ t('plot.revise.apply') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.revise-flow {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}
.rev-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.rev-textarea {
  box-sizing: border-box;
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: none;
  box-shadow: inset 0 0 0 1px var(--color-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--color-text, #e0e0e6);
  font-size: 13px;
  font-family: var(--font-serif-cjk, serif);
  resize: vertical;
  outline: none;
  transition: box-shadow 0.15s;
}
.rev-textarea:focus { box-shadow: inset 0 0 0 1px var(--color-sage-400); }

.rev-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.rev-scope__label { cursor: pointer; user-select: none; }
.rev-switch {
  position: relative;
  width: 30px;
  height: 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}
.rev-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-text-secondary);
  transition: transform 0.2s, background 0.2s;
}
.rev-switch--on { background: color-mix(in oklch, var(--color-sage-400, #8cb88c) 45%, transparent); }
.rev-switch--on::after {
  transform: translateX(14px);
  background: var(--color-sage-400, #8cb88c);
}

.rev-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}
.rev-generating {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.rev-btn {
  padding: 5px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text-secondary);
  transition: opacity 0.15s, background 0.15s;
  min-height: 28px;
}
.rev-btn--primary { background: var(--color-sage-400, #8cb88c); color: #1a1a1a; }
.rev-btn:hover { opacity: 0.85; }
.rev-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.rev-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger, #e07a6a);
}

.rev-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 42vh;
  overflow-y: auto;
}
.rev-synopsis {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.6;
}
.rev-chain {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rev-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13px;
}
.rev-row-wrap { display: flex; flex-direction: column; }
.rev-row--history { opacity: 0.55; }
.rev-row--expandable { cursor: pointer; }
.rev-row--expandable:hover { background: rgba(255, 255, 255, 0.04); }
.rev-chevron {
  color: var(--color-text-secondary);
  font-size: 10px;
  margin-left: auto;
}
.rev-node-edit-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 0 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.rev-row:hover .rev-node-edit-btn,
.rev-node-edit-btn:focus-visible { opacity: 1; }
.rev-node-edit-btn:hover { color: var(--color-amber-400, #d9a85c); }
.rev-node-edit-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.rev-node-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 0 6px 22px;
  padding: 8px 10px;
  border-left: 1px solid color-mix(in oklch, var(--color-amber-400, #d9a85c) 45%, transparent);
}
.rev-node-edit__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (hover: none) and (pointer: coarse) {
  .rev-node-edit-btn { opacity: 0.5; min-width: 44px; min-height: 32px; }
}
.rev-details {
  margin: 2px 0 6px 22px;
  padding: 6px 10px;
  border-left: 1px solid var(--color-border, rgba(255,255,255,0.08));
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px 10px;
  font-size: 12px;
  line-height: 1.6;
}
.rev-details dt { color: var(--color-text-secondary); white-space: nowrap; }
.rev-details dd { margin: 0; color: var(--color-text, #e0e0e6); }
.rev-details__before {
  display: block;
  color: var(--color-text-secondary);
  opacity: 0.7;
}
.rev-details__after { display: block; }
.rev-row--added { background: rgba(140, 184, 140, 0.08); }
.rev-row--modified { background: rgba(217, 168, 92, 0.07); }
.rev-row--removed { opacity: 0.7; }
.rev-row--seam { box-shadow: inset 2px 0 0 var(--color-amber-400, #d9a85c); }
.rev-icon {
  width: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.rev-row__title { color: var(--color-text, #e0e0e6); }
.rev-row__title--removed { text-decoration: line-through; color: var(--color-text-secondary); }
.rev-seam {
  flex-basis: 100%;
  padding-left: 22px;
  font-size: 11px;
  color: var(--color-amber-400, #d9a85c);
  line-height: 1.5;
}
.rev-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  backdrop-filter: blur(6px);
  white-space: nowrap;
}
.rev-badge--kept { color: var(--color-text-secondary); box-shadow: inset 0 0 0 1px var(--color-border); }
.rev-badge--modified { color: var(--color-amber-400, #d9a85c); box-shadow: inset 0 0 0 1px var(--color-amber-400, #d9a85c); }
.rev-badge--added { color: var(--color-sage-400, #8cb88c); box-shadow: inset 0 0 0 1px var(--color-sage-400, #8cb88c); }
.rev-badge--removed { color: var(--color-danger, #e07a6a); box-shadow: inset 0 0 0 1px var(--color-danger, #e07a6a); }

.rev-gauges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
}
.rev-gauges__label { color: var(--color-text-secondary); }

.rev-warn {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-amber-400, #d9a85c);
}

@media (hover: none) and (pointer: coarse) {
  .rev-btn { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .rev-btn, .rev-textarea { transition: none; }
}
</style>
