/**
 * Model ruleset editor state, CRUD and import/export (R7 step 2).
 */
import { ref, computed, watch } from 'vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import { eventBus } from '@/engine/core/event-bus';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface ModelRuleset {
  id: string;
  name: string;
  enabled: boolean;
  compatMode: boolean;
  baseModelRule: string;
  anchorModeModelRule: string;
  serializationStrategy: string;
  npcTemplateId: string;
  sceneTemplateId: string;
  judgeTemplateId: string;
}

export interface UseModelRulesetsDeps {
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
}

export function useModelRulesets(deps: UseModelRulesetsDeps) {
  const { get, setValue, t } = deps;

  const modelRulesetExpanded = ref(false);
  const editingModelRulesetId = ref('');
  const editModelRulesetName = ref('');
  const editModelRulesetBase = ref('');
  const editModelRulesetAnchor = ref('');

  const modelRulesets = computed<ModelRuleset[]>(() => {
    const raw = get('系统.扩展.image.modelRulesets');
    return Array.isArray(raw) ? raw as ModelRuleset[] : [];
  });

  const editingModelRuleset = computed(() =>
    modelRulesets.value.find((r) => r.id === editingModelRulesetId.value) ?? null
  );

  const activeModelRuleset = computed(() =>
    modelRulesets.value.find((r) => r.enabled) ?? null
  );

  const modelRulesetOptions = computed<SelectOption[]>(() =>
    modelRulesets.value.map((r) => ({ label: `${r.name}${r.enabled ? t('image.rules.enabledSuffix') : ''}`, value: r.id }))
  );

  // Auto-select the enabled model ruleset when rulesets are seeded
  watch(modelRulesets, (list) => {
    if (editingModelRulesetId.value) return;
    const enabled = list.find((r) => r.enabled);
    if (enabled) selectModelRuleset(enabled.id);
  }, { immediate: true });

  function selectModelRuleset(id: string) {
    editingModelRulesetId.value = id;
    const r = modelRulesets.value.find((x) => x.id === id);
    if (r) {
      editModelRulesetName.value = r.name;
      editModelRulesetBase.value = r.baseModelRule;
      editModelRulesetAnchor.value = r.anchorModeModelRule;
    }
  }

  function createModelRuleset() {
    const ruleset: ModelRuleset = {
      id: `mrs_${Date.now()}`,
      name: t('image.rules.rulesetDefaultName', { n: modelRulesets.value.length + 1 }),
      enabled: false,
      compatMode: false,
      baseModelRule: '',
      anchorModeModelRule: '',
      serializationStrategy: 'nai_character_segments',
      npcTemplateId: '',
      sceneTemplateId: '',
      judgeTemplateId: '',
    };
    const list = [...modelRulesets.value, ruleset];
    setValue('系统.扩展.image.modelRulesets', list);
    selectModelRuleset(ruleset.id);
  }

  function saveModelRuleset() {
    if (!editingModelRuleset.value) return;
    const list = modelRulesets.value.map((r) =>
      r.id === editingModelRulesetId.value
        ? { ...r, name: editModelRulesetName.value, baseModelRule: editModelRulesetBase.value, anchorModeModelRule: editModelRulesetAnchor.value }
        : r
    );
    setValue('系统.扩展.image.modelRulesets', list);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetSaved'), duration: 1500 });
  }

  function deleteModelRuleset() {
    const list = modelRulesets.value.filter((r) => r.id !== editingModelRulesetId.value);
    setValue('系统.扩展.image.modelRulesets', list);
    editingModelRulesetId.value = '';
  }

  function toggleModelRulesetEnabled(value: boolean) {
    // Only one ruleset can be enabled — disable others first
    const list = modelRulesets.value.map((r) => ({
      ...r,
      enabled: r.id === editingModelRulesetId.value ? value : (value ? false : r.enabled),
    }));
    setValue('系统.扩展.image.modelRulesets', list);
  }

  function toggleModelRulesetCompat(value: boolean) {
    const list = modelRulesets.value.map((r) =>
      r.id === editingModelRulesetId.value ? { ...r, compatMode: value } : r
    );
    setValue('系统.扩展.image.modelRulesets', list);
  }

  function exportModelRulesets() {
    const data = modelRulesets.value;
    if (data.length === 0) {
      eventBus.emit('ui:toast', { type: 'info', message: t('image.toast.noModelRulesetsToExport'), duration: 1500 });
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-rulesets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetsExported', { n: data.length }), duration: 1500 });
  }

  function importModelRulesets(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
          (r: unknown): r is ModelRuleset => typeof r === 'object' && r !== null && 'name' in r
        ).map((r) => ({
          ...r,
          id: `mrs_import_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          enabled: false,
        }));
        if (items.length === 0) {
          eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.noValidRulesetData'), duration: 2000 });
          return;
        }
        setValue('系统.扩展.image.modelRulesets', [...modelRulesets.value, ...items]);
        eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.modelRulesetsImported', { n: items.length }), duration: 1500 });
      } catch {
        eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  return {
    modelRulesetExpanded,
    editingModelRulesetId,
    editModelRulesetName,
    editModelRulesetBase,
    editModelRulesetAnchor,
    modelRulesets,
    editingModelRuleset,
    activeModelRuleset,
    modelRulesetOptions,
    selectModelRuleset,
    createModelRuleset,
    saveModelRuleset,
    deleteModelRuleset,
    toggleModelRulesetEnabled,
    toggleModelRulesetCompat,
    exportModelRulesets,
    importModelRulesets,
  };
}
