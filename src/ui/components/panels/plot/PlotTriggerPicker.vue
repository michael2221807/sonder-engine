<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md D3 (trigger types) §5.3 (picker)
// App doc: docs/user-guide/pages/game-plot.md §时间线视图 · 开始条件弹窗
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { PlotArc, ThreadActivation, ThreadTrigger, GaugeOperator } from '@/engine/plot/types';

const { t } = useI18n();

const props = defineProps<{
  modelValue: boolean;
  /** The thread being scheduled. */
  arc: PlotArc | null;
  /** Every thread (targets exclude `arc` itself). */
  arcs: PlotArc[];
  maxActiveThreads: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'save', activation: ThreadActivation): void;
  (e: 'unschedule'): void;
}>();

type Kind = ThreadTrigger['type'];

const triggers = ref<ThreadTrigger[]>([]);
const mode = ref<ThreadActivation['mode']>('auto');
const kind = ref<Kind>('node_completed');
const targetArcId = ref('');
const targetNodeId = ref('');
const roundValue = ref(10);
const gaugeId = ref('');
const gaugeOp = ref<GaugeOperator>('gte');
const gaugeValue = ref(50);

const otherArcs = computed(() => props.arcs.filter(a => a.id !== props.arc?.id));
const activeGauges = computed(() => props.arcs.filter(a => a.status === 'active').flatMap(a => a.gauges.map(g => ({ g, arc: a }))));

const kindOptions = computed<Array<{ value: Kind; label: string }>>(() => [
  { value: 'node_completed', label: t('plot.trigger.nodeCompleted') },
  { value: 'thread_completed', label: t('plot.trigger.threadCompleted') },
  { value: 'round_reached', label: t('plot.trigger.roundReached') },
  { value: 'gauge', label: t('plot.trigger.gauge') },
]);
const arcOptions = computed(() => otherArcs.value.map(a => ({ value: a.id, label: a.title || t('plot.arc.untitled') })));
const nodeOptions = computed(() => (otherArcs.value.find(a => a.id === targetArcId.value)?.nodes ?? []).map(n => ({ value: n.id, label: n.title })));
const gaugeOptions = computed(() => activeGauges.value.map(({ g, arc }) => ({ value: g.id, label: `${arc.title}·${g.name}` })));
const opOptions: Array<{ value: GaugeOperator; label: string }> = [
  { value: 'gte', label: '≥' }, { value: 'gt', label: '>' }, { value: 'lte', label: '≤' }, { value: 'lt', label: '<' }, { value: 'eq', label: '=' }, { value: 'neq', label: '≠' },
];
const modeOptions = computed<Array<{ value: ThreadActivation['mode']; label: string }>>(() => [
  { value: 'auto', label: t('plot.trigger.modeAuto') },
  { value: 'manual', label: t('plot.trigger.modeManual') },
]);

watch(() => props.modelValue, (open) => {
  if (!open) return;
  triggers.value = [...(props.arc?.activation?.triggers ?? [])];
  mode.value = props.arc?.activation?.mode ?? 'auto';
  targetArcId.value = otherArcs.value[0]?.id ?? '';
  targetNodeId.value = otherArcs.value[0]?.nodes[0]?.id ?? '';
  gaugeId.value = activeGauges.value[0]?.g.id ?? '';
});
watch(targetArcId, (id) => {
  targetNodeId.value = otherArcs.value.find(a => a.id === id)?.nodes[0]?.id ?? '';
});

const canAdd = computed(() => {
  switch (kind.value) {
    case 'node_completed': return !!targetArcId.value && !!targetNodeId.value;
    case 'thread_completed': return !!targetArcId.value;
    case 'round_reached': return Number.isFinite(roundValue.value) && roundValue.value >= 1;
    case 'gauge': return !!gaugeId.value;
    default: return false;
  }
});

function add(): void {
  if (!canAdd.value) return;
  let trig: ThreadTrigger;
  switch (kind.value) {
    case 'node_completed': trig = { type: 'node_completed', arcId: targetArcId.value, nodeId: targetNodeId.value }; break;
    case 'thread_completed': trig = { type: 'thread_completed', arcId: targetArcId.value }; break;
    case 'round_reached': trig = { type: 'round_reached', round: Math.round(roundValue.value) }; break;
    default: trig = { type: 'gauge', condition: { gaugeId: gaugeId.value, operator: gaugeOp.value, value: Number(gaugeValue.value) } };
  }
  triggers.value.push(trig);
}
function remove(i: number): void { triggers.value.splice(i, 1); }

function describe(trig: ThreadTrigger): string {
  if (trig.type === 'round_reached') return t('plot.scheduler.waitingRound', { round: trig.round });
  if (trig.type === 'gauge') {
    const g = activeGauges.value.find(x => x.g.id === trig.condition.gaugeId);
    const op = opOptions.find(o => o.value === trig.condition.operator)?.label ?? '?';
    return `${g ? g.g.name : trig.condition.gaugeId} ${op} ${trig.condition.value}`;
  }
  const target = props.arcs.find(a => a.id === trig.arcId);
  const nodeTitle = trig.type === 'node_completed' ? target?.nodes.find(n => n.id === trig.nodeId)?.title : undefined;
  return t('plot.scheduler.waitingAfter', { target: target ? (nodeTitle ? `${target.title}·${nodeTitle}` : target.title) : '?' });
}

function save(): void {
  if (triggers.value.length === 0) return;
  emit('save', { mode: mode.value, triggers: [...triggers.value] });
  emit('update:modelValue', false);
}
function unschedule(): void {
  emit('unschedule');
  emit('update:modelValue', false);
}
</script>

<template>
  <Modal :model-value="modelValue" :title="$t('plot.trigger.title', { title: arc?.title ?? '' })" width="520px" @update:model-value="emit('update:modelValue', $event)">
    <p class="tp-desc">{{ $t('plot.trigger.desc', { max: maxActiveThreads }) }}</p>

    <ul v-if="triggers.length" class="tp-list" data-testid="plot-trigger-list">
      <li v-for="(trig, i) in triggers" :key="i" class="tp-item">
        <span>{{ describe(trig) }}</span>
        <button class="tp-remove" type="button" :aria-label="$t('plot.trigger.remove')" @click="remove(i)">×</button>
      </li>
    </ul>
    <p v-else class="tp-empty">{{ $t('plot.trigger.emptyHint') }}</p>

    <div class="tp-add">
      <AgaSelect :model-value="kind" :options="kindOptions" @update:model-value="kind = $event as Kind" />
      <template v-if="kind === 'node_completed' || kind === 'thread_completed'">
        <AgaSelect v-if="arcOptions.length" :model-value="targetArcId" :options="arcOptions" @update:model-value="targetArcId = String($event)" />
        <span v-else class="tp-empty">{{ $t('plot.trigger.noTargets') }}</span>
        <AgaSelect v-if="kind === 'node_completed' && nodeOptions.length" :model-value="targetNodeId" :options="nodeOptions" @update:model-value="targetNodeId = String($event)" />
      </template>
      <input v-else-if="kind === 'round_reached'" v-model.number="roundValue" type="number" min="1" class="tp-num" />
      <template v-else>
        <AgaSelect v-if="gaugeOptions.length" :model-value="gaugeId" :options="gaugeOptions" @update:model-value="gaugeId = String($event)" />
        <span v-else class="tp-empty">{{ $t('plot.trigger.noTargets') }}</span>
        <AgaSelect :model-value="gaugeOp" :options="opOptions" @update:model-value="gaugeOp = $event as GaugeOperator" />
        <input v-model.number="gaugeValue" type="number" class="tp-num" />
      </template>
      <button class="tp-btn" type="button" :disabled="!canAdd" data-testid="plot-trigger-add" @click="add">{{ $t('plot.trigger.add') }}</button>
    </div>

    <div class="tp-mode">
      <AgaSelect :model-value="mode" :options="modeOptions" @update:model-value="mode = $event as ThreadActivation['mode']" />
    </div>

    <template #footer>
      <button v-if="arc?.status === 'scheduled'" class="tp-btn" type="button" @click="unschedule">{{ $t('plot.trigger.unschedule') }}</button>
      <button class="tp-btn tp-btn--primary" type="button" :disabled="triggers.length === 0" data-testid="plot-trigger-save" @click="save">{{ $t('plot.trigger.save') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.tp-desc { margin: 0 0 12px; font-size: var(--font-size-xs, 12px); color: var(--color-text-muted, #888); }
.tp-list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in oklch, var(--color-sage-400, #8cb88c) 10%, transparent);
  font-size: var(--font-size-sm, 13px);
}
.tp-remove { border: none; background: transparent; color: var(--color-text-muted, #888); cursor: pointer; font-size: 1rem; }
.tp-remove:hover { color: var(--color-danger, #b85c4a); }
.tp-empty { font-size: var(--font-size-xs, 12px); color: var(--color-text-muted, #888); margin: 0 0 10px; }
.tp-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.tp-num {
  width: 80px;
  background: rgba(0, 0, 0, 0.25);
  border: none;
  border-radius: 6px;
  color: var(--color-text, #e0e0e6);
  font-family: inherit;
  padding: 6px 8px;
  outline: none;
}
.tp-num:focus { box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-sage-400, #8cb88c) 40%, transparent); }
.tp-mode { margin-top: 4px; }
.tp-btn {
  border: none;
  border-radius: 7px;
  padding: 6px 12px;
  font-size: var(--font-size-xs, 12px);
  cursor: pointer;
  font-family: inherit;
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text-secondary, #aaa);
  transition: background 0.2s, color 0.2s;
}
.tp-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); color: var(--color-text, #e0e0e6); }
.tp-btn--primary { background: color-mix(in oklch, var(--color-sage-400, #8cb88c) 22%, transparent); color: var(--color-sage-300, #a9cca9); }
.tp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
