<script setup lang="ts">
// App doc: docs/user-guide/pages/home.md §1.3.2 · 剧情动能
import { ref, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AgaToggle from '../shared/AgaToggle.vue';
import { plotVectorAvailable, readPlotVectorControl, writePlotVectorControl,
  subscribePlotVectorControl } from '@/engine/plot-vector/feature-control';
const { t } = useI18n();
const enabled = ref(readPlotVectorControl().enabled);
const error = ref('');
onUnmounted(subscribePlotVectorControl(() => { enabled.value = readPlotVectorControl().enabled; }));
function toggle(value: boolean) {
  try { writePlotVectorControl(value); error.value = ''; }
  catch { error.value = t('settings.plotVector.storageError'); }
}
</script>
<template>
  <div class="vector-setting" data-testid="plot-vector-control">
    <div>
      <strong>{{ t('settings.plotVector.title') }}</strong>
      <p>{{ t('settings.plotVector.description') }}</p>
      <p>{{ t('settings.plotVector.rollback') }}</p>
      <p v-if="!plotVectorAvailable">{{ t('settings.plotVector.releaseGate') }}</p>
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
</style>
