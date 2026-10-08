/**
 * Character anchor editor state, AI extraction and CRUD (R7 step 2).
 */
import { type Ref, ref, computed } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import { extractAnchorViaAI } from '@/engine/image/anchor-extractor';
import type { AIService } from '@/engine/ai/ai-service';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface CharacterAnchor {
  id: string;
  name: string;
  npcName: string;
  enabled: boolean;
  defaultAppend: boolean;
  sceneLink: boolean;
  positive: string;
  negative: string;
  structuredFeatures?: import('@/engine/image/types').AnchorStructuredFeatures;
  source?: string;
  model?: string;
}

export interface UseAnchorsDeps {
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
  aiService: AIService | undefined;
  relationships: Readonly<Ref<Array<Record<string, unknown>> | undefined>>;
}

export function useAnchors(deps: UseAnchorsDeps) {
  const { get, setValue, t, aiService, relationships } = deps;

  const selectedAnchorId = ref('');
  const anchorExtractRequirements = ref('');
  const anchorExtracting = ref(false);
  const anchorExtractMessage = ref('');
  const anchorExtractStage = ref<'idle' | 'extracting' | 'done' | 'error'>('idle');

  const characterAnchors = computed<CharacterAnchor[]>(() => {
    const raw = get('系统.扩展.image.characterAnchors');
    return Array.isArray(raw) ? raw as CharacterAnchor[] : [];
  });

  const selectedAnchor = computed(() =>
    characterAnchors.value.find((a) => a.id === selectedAnchorId.value) ?? null
  );

  // Editor state for anchor
  const editAnchorName = ref('');
  const editAnchorNpc = ref('');
  const editAnchorPositive = ref('');
  const editAnchorNegative = ref('');

  function selectAnchor(id: string) {
    selectedAnchorId.value = id;
    const a = characterAnchors.value.find((x) => x.id === id);
    if (a) {
      editAnchorName.value = a.name;
      editAnchorNpc.value = a.npcName;
      editAnchorPositive.value = a.positive;
      editAnchorNegative.value = a.negative;
    }
  }

  async function extractAnchor() {
    if (!editAnchorNpc.value || !aiService) {
      anchorExtractStage.value = 'error';
      anchorExtractMessage.value = !aiService ? t('image.toast.anchorAiNotReady') : t('image.toast.anchorSelectNpcFirst');
      return;
    }
    anchorExtracting.value = true;
    anchorExtractStage.value = 'extracting';
    anchorExtractMessage.value = t('image.toast.anchorExtracting', { name: editAnchorNpc.value });
    try {
      const npc = (relationships.value as Array<Record<string, unknown>>)?.find(
        (n) => n['名称'] === editAnchorNpc.value
      );
      if (!npc) throw new Error('NPC not found');

      const npcData: Record<string, unknown> = { 姓名: editAnchorNpc.value };
      const pick = (key: string) => { const v = npc[key]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      if (pick('性别')) npcData['性别'] = pick('性别');
      if (npc['年龄']) npcData['年龄'] = npc['年龄'];
      if (pick('描述')) npcData['描述'] = pick('描述');
      if (pick('外貌描述')) npcData['外貌描述'] = pick('外貌描述');
      if (pick('身材描写')) npcData['身材描写'] = pick('身材描写');
      if (pick('衣着风格')) npcData['衣着风格'] = pick('衣着风格');
      if (Array.isArray(npc['性格特征'])) npcData['性格特征'] = npc['性格特征'];

      const result = await extractAnchorViaAI(
        aiService,
        JSON.stringify(npcData, null, 2),
        {
          displayName: editAnchorNpc.value,
          extraRequirements: anchorExtractRequirements.value.trim() || undefined,
        },
      );

      const anchor: CharacterAnchor = {
        id: `anchor_${Date.now()}`,
        name: t('image.anchor.defaultName', { name: editAnchorNpc.value }),
        npcName: editAnchorNpc.value,
        enabled: true,
        defaultAppend: true,
        sceneLink: false,
        positive: result.positivePrompt,
        negative: result.negativePrompt,
        structuredFeatures: result.structuredFeatures,
        source: t('image.anchor.sourceAI'),
      };
      const list = [...characterAnchors.value.filter((a) => a.npcName !== editAnchorNpc.value), anchor];
      setValue('系统.扩展.image.characterAnchors', list);
      selectAnchor(anchor.id);
      anchorExtractStage.value = 'done';
      anchorExtractMessage.value = t('image.toast.anchorExtracted', { name: anchor.name });
    } catch (err) {
      anchorExtractStage.value = 'error';
      anchorExtractMessage.value = t('image.toast.anchorExtractFailed', { error: (err as Error).message });
    } finally {
      anchorExtracting.value = false;
    }
  }

  function saveAnchor() {
    if (!selectedAnchor.value) return;
    const list = characterAnchors.value.map((a) =>
      a.id === selectedAnchorId.value
        ? { ...a, name: editAnchorName.value, positive: editAnchorPositive.value, negative: editAnchorNegative.value }
        : a
    );
    setValue('系统.扩展.image.characterAnchors', list);
    eventBus.emit('ui:toast', { type: 'success', message: t('image.toast.anchorSaved'), duration: 1500 });
  }

  function deleteAnchor() {
    const list = characterAnchors.value.filter((a) => a.id !== selectedAnchorId.value);
    setValue('系统.扩展.image.characterAnchors', list);
    selectedAnchorId.value = '';
  }

  function toggleAnchorProp(prop: 'enabled' | 'defaultAppend' | 'sceneLink', value: boolean) {
    const list = characterAnchors.value.map((a) =>
      a.id === selectedAnchorId.value ? { ...a, [prop]: value } : a
    );
    setValue('系统.扩展.image.characterAnchors', list);
  }

  return {
    selectedAnchorId,
    anchorExtractRequirements,
    anchorExtracting,
    anchorExtractMessage,
    anchorExtractStage,
    characterAnchors,
    selectedAnchor,
    editAnchorName,
    editAnchorNpc,
    editAnchorPositive,
    editAnchorNegative,
    selectAnchor,
    extractAnchor,
    saveAnchor,
    deleteAnchor,
    toggleAnchorProp,
  };
}
