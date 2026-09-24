<script setup lang="ts">
// App doc: docs/user-guide/pages/home.md §1.3.2 · 剧情动能
import { ref, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AgaToggle from '../shared/AgaToggle.vue';
import AgaButton from '../shared/AgaButton.vue';
import { BrowserRequestStore } from '@/features/plot-vector/request-journal';
import { plotVectorAvailable, readPlotVectorControl, writePlotVectorControl, writePlotVectorSettlementMode,
  subscribePlotVectorControl, type StateSettlementMode } from '@/engine/plot-vector/feature-control';
const { t } = useI18n();
const enabled = ref(readPlotVectorControl().enabled);
const settlement = ref<StateSettlementMode>(readPlotVectorControl().settlement);
const error = ref('');
const records = new BrowserRequestStore();
const summary = ref<{ completed: number; unknown: number; expired: number }>();
const acknowledged = ref(false), busy = ref(false);
async function refreshRecords() {
  if (busy.value) return;
  busy.value = true;
  try { summary.value = await records.summary(); error.value = ''; }
  catch { error.value = t('settings.plotVector.recordsError'); }
  finally { busy.value = false; }
}
async function clearRecords() {
  if (busy.value || enabled.value || readPlotVectorControl().enabled || !acknowledged.value) return;
  busy.value = true;
  try {
    writePlotVectorControl(false);
    const epoch = readPlotVectorControl().epoch;
    await records.clear(() => {
      const live = readPlotVectorControl();
      if (live.enabled || live.epoch !== epoch) throw new Error('control changed');
    });
    summary.value = await records.summary(); acknowledged.value = false; error.value = '';
  } catch { error.value = t('settings.plotVector.recordsError'); }
  finally { busy.value = false; }
}
onUnmounted(subscribePlotVectorControl(() => {
  const control = readPlotVectorControl(); enabled.value = control.enabled; settlement.value = control.settlement;
  acknowledged.value = false;
}));
function toggle(value: boolean) {
  try { writePlotVectorControl(value); error.value = ''; }
  catch { error.value = t('settings.plotVector.storageError'); }
}
function changeSettlement(event: Event) {
  const value = (event.target as HTMLSelectElement).value as StateSettlementMode;
  try { writePlotVectorSettlementMode(value); error.value = ''; }
  catch { settlement.value = readPlotVectorControl().settlement; error.value = t('settings.plotVector.storageError'); }
}
</script>
<template>
  <div class="vector-setting" data-testid="plot-vector-control">
    <div>
      <strong>{{ t('settings.plotVector.title') }}</strong>
      <p>{{ t('settings.plotVector.description') }}</p>
      <p>{{ t('settings.plotVector.rollback') }}</p>
      <p v-if="!plotVectorAvailable">{{ t('settings.plotVector.releaseGate') }}</p>
      <details v-if="plotVectorAvailable" data-testid="plot-vector-settlement">
        <summary>{{ t('settings.plotVector.settlementTitle') }}</summary>
        <label class="settlement-choice">
          {{ t('settings.plotVector.settlementLabel') }}
          <select :value="settlement" @change="changeSettlement">
            <option value="inline">{{ t('settings.plotVector.settlementInline') }}</option>
            <option value="separate">{{ t('settings.plotVector.settlementSeparate') }}</option>
          </select>
        </label>
        <p>{{ t('settings.plotVector.settlementHelp') }}</p>
      </details>
      <details data-testid="plot-vector-recovery" @toggle="($event.target as HTMLDetailsElement).open && refreshRecords()">
        <summary>{{ t('settings.plotVector.recordsTitle') }}</summary>
        <p>{{ t('settings.plotVector.recordsHelp') }}</p>
        <p v-if="summary" role="status">{{ t('settings.plotVector.recordsCount', summary) }}</p>
        <p>{{ t('settings.plotVector.recordsWarning') }}</p>
        <label><input v-model="acknowledged" type="checkbox" :disabled="enabled || busy"> {{ t('settings.plotVector.recordsAck') }}</label>
        <div class="record-actions">
          <AgaButton size="sm" variant="secondary" :disabled="busy" @click="refreshRecords">{{ t('settings.plotVector.recordsRefresh') }}</AgaButton>
          <AgaButton size="sm" variant="danger" :disabled="enabled || busy || !acknowledged" @click="clearRecords">{{ t('settings.plotVector.recordsClear') }}</AgaButton>
        </div>
      </details>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
    <AgaToggle :model-value="enabled" :disabled="!plotVectorAvailable" :label="t('settings.plotVector.label')" @update:model-value="toggle" />
  </div>
</template>
<style scoped>
.vector-setting { display: flex; align-items: center; gap: 1rem; padding: 1rem 0; }
.vector-setting > div { flex: 1; min-width: 0; }
strong { font-size: .875rem; font-weight: 500; }
p { margin: .35rem 0 0; font-size: .75rem; line-height: 1.6; opacity: .72; }
details { margin-top: .75rem; font-size: .75rem; }
summary { cursor: pointer; }
label { display: block; margin-top: .5rem; }
.settlement-choice select { display: block; margin-top: .3rem; padding: .35rem .5rem; border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); border: 1px solid var(--color-border-subtle); }
.record-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .5rem; }
</style>
