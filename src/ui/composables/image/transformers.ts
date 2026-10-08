/**
 * Transformer preset CRUD state (R7 step 2).
 */
import { ref, computed } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface TransformerPreset {
  id: string;
  name: string;
  scope: 'npc' | 'scene' | 'secret';
  prompt: string;
}

export interface UseTransformerPresetsDeps {
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
}

export function useTransformerPresets(deps: UseTransformerPresetsDeps) {
  const { get, setValue, t } = deps;

  const transformerScope = ref<'npc' | 'scene' | 'secret'>('npc');
  const selectedTransformerId = ref('');
  const newTransformerName = ref('');
  const editTransformerPrompt = ref('');

  const transformerPresets = computed<TransformerPreset[]>(() => {
    const raw = get('系统.扩展.image.transformerPresets');
    return Array.isArray(raw) ? raw as TransformerPreset[] : [];
  });

  const scopedTransformers = computed(() =>
    transformerPresets.value.filter((p) => p.scope === transformerScope.value)
  );

  const selectedTransformer = computed(() =>
    transformerPresets.value.find((p) => p.id === selectedTransformerId.value) ?? null
  );

  function loadTransformerIntoEditor() {
    if (selectedTransformer.value) {
      editTransformerPrompt.value = selectedTransformer.value.prompt;
    }
  }

  function createTransformerPreset() {
    const name = newTransformerName.value.trim() || t('image.transformer.defaultName', { id: Date.now() });
    const preset: TransformerPreset = {
      id: `tf_${Date.now()}`,
      name,
      scope: transformerScope.value,
      prompt: '',
    };
    const list = [...transformerPresets.value, preset];
    setValue('系统.扩展.image.transformerPresets', list);
    selectedTransformerId.value = preset.id;
    newTransformerName.value = '';
    editTransformerPrompt.value = '';
  }

  function saveTransformerPreset() {
    if (!selectedTransformer.value) return;
    const list = transformerPresets.value.map((p) =>
      p.id === selectedTransformerId.value
        ? { ...p, prompt: editTransformerPrompt.value }
        : p
    );
    setValue('系统.扩展.image.transformerPresets', list);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.transformerPresetSaved'), duration: 1500 });
  }

  function deleteTransformerPreset() {
    const list = transformerPresets.value.filter((p) => p.id !== selectedTransformerId.value);
    setValue('系统.扩展.image.transformerPresets', list);
    selectedTransformerId.value = '';
    editTransformerPrompt.value = '';
  }

  return {
    transformerScope,
    selectedTransformerId,
    newTransformerName,
    editTransformerPrompt,
    transformerPresets,
    scopedTransformers,
    selectedTransformer,
    loadTransformerIntoEditor,
    createTransformerPreset,
    saveTransformerPreset,
    deleteTransformerPreset,
  };
}
