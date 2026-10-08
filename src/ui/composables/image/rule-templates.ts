/**
 * Rule template editor state, active-rule selection and import/export (R7 step 2).
 */
import { type Ref, ref, computed, watch } from 'vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import { eventBus } from '@/engine/core/event-bus';
import type { TransformerPreset } from './transformers';
import type { ModelRuleset } from './model-rulesets';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface RuleTemplate {
  id: string;
  name: string;
  scope: 'npc' | 'scene' | 'judge';
  baseRule: string;
  anchorRule: string;
  noAnchorFallback: string;
  outputFormat: string;
  transformerPresetId: string;
}

export interface UseRuleTemplatesDeps {
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
  transformerPresets: Readonly<Ref<TransformerPreset[]>>;
  modelRulesets: Readonly<Ref<ModelRuleset[]>>;
}

export function useRuleTemplates(deps: UseRuleTemplatesDeps) {
  const { get, setValue, t, transformerPresets, modelRulesets } = deps;

  const ruleScope = ref<'npc' | 'scene' | 'judge'>('npc');

  const ruleTemplates = computed<RuleTemplate[]>(() => {
    const raw = get('系统.扩展.image.ruleTemplates');
    return Array.isArray(raw) ? raw as RuleTemplate[] : [];
  });

  const scopedRuleTemplates = computed(() =>
    ruleTemplates.value.filter((r) => r.scope === ruleScope.value)
  );

  // "当前生效" — which rule is active per scope
  const activeNpcRuleId = ref(String(get('系统.扩展.image.rules.activeNpcRule') ?? ''));
  const activeSceneRuleId = ref(String(get('系统.扩展.image.rules.activeSceneRule') ?? ''));
  const activeJudgeRuleId = ref(String(get('系统.扩展.image.rules.activeJudgeRule') ?? ''));

  const currentActiveRuleId = computed({
    get: () => ruleScope.value === 'npc' ? activeNpcRuleId.value : ruleScope.value === 'scene' ? activeSceneRuleId.value : activeJudgeRuleId.value,
    set: (v: string) => {
      if (ruleScope.value === 'npc') activeNpcRuleId.value = v;
      else if (ruleScope.value === 'scene') activeSceneRuleId.value = v;
      else activeJudgeRuleId.value = v;
    },
  });

  // "当前编辑" — which rule is being edited
  const editingRuleId = ref('');

  const editingRule = computed(() =>
    ruleTemplates.value.find((r) => r.id === editingRuleId.value) ?? null
  );

  // Editor fields
  const editRuleName = ref('');
  const editBaseRule = ref('');
  const editAnchorRule = ref('');
  const editNoAnchorFallback = ref('');
  const editOutputFormat = ref('');
  const editRuleTransformerId = ref('');

  const activeRuleOptions = computed<SelectOption[]>(() => [
    { label: t('image.presets.notUsed'), value: '' },
    ...scopedRuleTemplates.value.map((r) => ({ label: r.name, value: r.id })),
  ]);

  const editRuleOptions = computed<SelectOption[]>(() =>
    scopedRuleTemplates.value.map((r) => ({ label: r.name, value: r.id }))
  );

  const npcTransformerOptions = computed<SelectOption[]>(() => [
    { label: t('image.presets.notUsed'), value: '' },
    ...transformerPresets.value.filter((p) => p.scope === 'npc').map((p) => ({ label: p.name, value: p.id })),
  ]);
  const sceneTransformerOptions = computed<SelectOption[]>(() => [
    { label: t('image.presets.notUsed'), value: '' },
    ...transformerPresets.value.filter((p) => p.scope === 'scene').map((p) => ({ label: p.name, value: p.id })),
  ]);

  const currentTransformerOptions = computed(() =>
    ruleScope.value === 'npc' ? npcTransformerOptions.value : sceneTransformerOptions.value
  );

  function loadRuleIntoEditor() {
    if (editingRule.value) {
      editRuleName.value = editingRule.value.name;
      editBaseRule.value = editingRule.value.baseRule;
      editAnchorRule.value = editingRule.value.anchorRule;
      editNoAnchorFallback.value = editingRule.value.noAnchorFallback;
      editOutputFormat.value = editingRule.value.outputFormat;
      editRuleTransformerId.value = editingRule.value.transformerPresetId;
    }
  }

  function selectEditRule(id: string) {
    editingRuleId.value = id;
    loadRuleIntoEditor();
  }

  // Auto-select first rule template when scope changes and nothing is selected
  watch([scopedRuleTemplates, ruleScope], ([templates]) => {
    if (editingRuleId.value && templates.some((t: RuleTemplate) => t.id === editingRuleId.value)) return;
    if (templates.length > 0) {
      selectEditRule(templates[0].id);
    }
  }, { immediate: true });

  function createRuleTemplate() {
    const rule: RuleTemplate = {
      id: `rule_${Date.now()}`,
      name: (ruleScope.value === 'npc' ? t('image.rules.npcRuleName', { n: scopedRuleTemplates.value.length + 1 }) : ruleScope.value === 'scene' ? t('image.rules.sceneRuleName', { n: scopedRuleTemplates.value.length + 1 }) : t('image.rules.judgeRuleName', { n: scopedRuleTemplates.value.length + 1 })),
      scope: ruleScope.value,
      baseRule: '', anchorRule: '', noAnchorFallback: '', outputFormat: '',
      transformerPresetId: '',
    };
    const list = [...ruleTemplates.value, rule];
    setValue('系统.扩展.image.ruleTemplates', list);
    editingRuleId.value = rule.id;
    loadRuleIntoEditor();
  }

  function saveRuleTemplate() {
    if (!editingRule.value) return;
    const list = ruleTemplates.value.map((r) =>
      r.id === editingRuleId.value
        ? { ...r, name: editRuleName.value, baseRule: editBaseRule.value, anchorRule: editAnchorRule.value, noAnchorFallback: editNoAnchorFallback.value, outputFormat: editOutputFormat.value, transformerPresetId: editRuleTransformerId.value }
        : r
    );
    setValue('系统.扩展.image.ruleTemplates', list);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.ruleSaved'), duration: 1500 });
  }

  function deleteRuleTemplate() {
    const list = ruleTemplates.value.filter((r) => r.id !== editingRuleId.value);
    setValue('系统.扩展.image.ruleTemplates', list);
    // Clear active if deleted
    if (currentActiveRuleId.value === editingRuleId.value) {
      currentActiveRuleId.value = '';
    }
    editingRuleId.value = '';
  }

  function saveActiveRules() {
    const existing = (get('系统.扩展.image.rules') as Record<string, unknown>) ?? {};
    setValue('系统.扩展.image.rules', {
      ...existing,
      activeNpcRule: activeNpcRuleId.value,
      activeSceneRule: activeSceneRuleId.value,
      activeJudgeRule: activeJudgeRuleId.value,
    });
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.activeRulesUpdated'), duration: 1500 });
  }

  // Rules import/export
  function exportRules() {
    const data = {
      ruleTemplates: ruleTemplates.value,
      modelRulesets: modelRulesets.value,
      rules: get('系统.扩展.image.rules'),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `image-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.rulesExported'), duration: 1500 });
  }

  function importRules(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (Array.isArray(data.ruleTemplates)) {
          setValue('系统.扩展.image.ruleTemplates', data.ruleTemplates);
        }
        if (Array.isArray(data.modelRulesets)) {
          setValue('系统.扩展.image.modelRulesets', data.modelRulesets);
        }
        if (data.rules && typeof data.rules === 'object') {
          setValue('系统.扩展.image.rules', data.rules);
        }
        eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.rulesImported'), duration: 1500 });
      } catch {
        eventBus.emit('ui:toast', { type: 'error', message: t('image.toast.importFailedInvalidJson'), duration: 2000 });
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  return {
    ruleScope,
    ruleTemplates,
    scopedRuleTemplates,
    activeNpcRuleId,
    activeSceneRuleId,
    activeJudgeRuleId,
    currentActiveRuleId,
    editingRuleId,
    editingRule,
    editRuleName,
    editBaseRule,
    editAnchorRule,
    editNoAnchorFallback,
    editOutputFormat,
    editRuleTransformerId,
    activeRuleOptions,
    editRuleOptions,
    npcTransformerOptions,
    sceneTransformerOptions,
    currentTransformerOptions,
    loadRuleIntoEditor,
    selectEditRule,
    createRuleTemplate,
    saveRuleTemplate,
    deleteRuleTemplate,
    saveActiveRules,
    exportRules,
    importRules,
  };
}
