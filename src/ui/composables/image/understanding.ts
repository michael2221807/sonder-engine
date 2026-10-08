/**
 * Image understanding (提炼) state, engine gating and save-as-preset flow (R7 step 2).
 */
import { type Ref, ref, computed, watch } from 'vue';
import type { ArtistPreset } from '@/engine/image/types';
import { generateReferenceId } from '@/engine/image/utils';
import { eventBus } from '@/engine/core/event-bus';
import type { ImageService } from '@/engine/image/image-service';
import type { AIService } from '@/engine/ai/ai-service';
import type { useAPIManagementStore } from '@/engine/stores/engine-api';
import type { PanelTranslate, GetState, SetState } from './panel-deps';

export interface UseUnderstandingDeps {
  imageService: ImageService | undefined;
  aiService: AIService | undefined;
  apiStore: ReturnType<typeof useAPIManagementStore>;
  get: GetState;
  setValue: SetState;
  t: PanelTranslate;
  artistPresets: Readonly<Ref<ArtistPreset[]>>;
  selectedPresetId: Ref<string>;
  loadPresetIntoEditor: () => void;
  validateUploadSize: (file: File) => boolean;
}

export function useUnderstanding(deps: UseUnderstandingDeps) {
  const { imageService, aiService, apiStore, get, setValue, t, artistPresets, selectedPresetId, loadPresetIntoEditor, validateUploadSize } = deps;

  // Image understanding (提炼) state
  const understandingMode = ref(false);
  const understandingFile = ref<File | null>(null);
  const understandingCoverDataUrl = ref<string | null>(null);
  const understandingTask = ref<'tags' | 'caption' | 'both'>('both');
  // 额外要求（可选）：原样附加到提炼提示词末尾，用来指定关注点/提醒细节/解释易误读的画面。
  // 刻意**不随新图片清空**——连续提炼同一批图时同一条要求通常要复用（与 understandingEngine
  // 的「会话内记忆」同类）。
  const understandingExtra = ref('');
  // 提炼引擎（重建 epic D1）：默认取设置值，面板内可切换，会话内记忆
  const understandingEngine = ref<import('@/engine/image/types').ImageUnderstandingEngine>(
    imageService?.getUnderstandingConfig().defaultEngine ?? 'civitai_vlm',
  );

  // 能力门控（参照 c1c3463 重绘幅度先例：不可用 = 禁用 + 说明，不留死控件）
  const understandingCivitaiAvailable = computed(() => {
    apiStore.apiConfigs; apiStore.apiAssignments; // reactivity deps
    return Boolean(aiService?.getImageConfigForBackend('civitai'));
  });
  // D3B「必须标明」：通用 LLM 引擎复用主对话配置，选项与设置区都显示当前模型名
  const understandingLlmInfo = computed(() => {
    apiStore.apiConfigs; apiStore.apiAssignments; // reactivity deps
    return imageService?.getGeneralLlmInfo();
  });
  // Civitai 视觉模型速查清单（设置区「支持哪些模型？」）。
  // 模型 id 是 API 标识符，不翻译；备注走 i18n。三项均为 2026-08-27 真实探测过的
  // 名字，计量差异见 docs/status/image-understanding-api-verification-2026-08-27.md。
  const UNDERSTANDING_MODEL_PRESETS: ReadonlyArray<{ id: string; noteKey: string }> = [
    { id: 'claude-sonnet-5', noteKey: 'image.settings.understandingModelNoteSonnet' },
    { id: 'gpt-4o-mini', noteKey: 'image.settings.understandingModelNoteGpt' },
    { id: 'gemini-2.5-flash', noteKey: 'image.settings.understandingModelNoteGemini' },
  ];

  const understandingCivitaiModel = computed(() =>
    String(get('系统.扩展.image.config.understanding.civitaiModel') ?? 'claude-sonnet-5'));

  function applyUnderstandingModel(id: string): void {
    setValue('系统.扩展.image.config.understanding.civitaiModel', id);
  }

  const understandingEngineOptions = computed<Array<{
    label: string;
    value: import('@/engine/image/types').ImageUnderstandingEngine;
    disabled: boolean;
  }>>(() => [
    {
      label: t('image.presets.engineCivitai'),
      value: 'civitai_vlm',
      disabled: !understandingCivitaiAvailable.value,
    },
    {
      label: understandingLlmInfo.value?.available
        ? t('image.presets.engineGeneralLlm', { model: understandingLlmInfo.value.model })
        : t('image.presets.engineGeneralLlmBare'),
      value: 'general_llm',
      disabled: !understandingLlmInfo.value?.available,
    },
  ]);
  const understandingNoEngine = computed(() =>
    understandingEngineOptions.value.every((o) => o.disabled));
  // 选中引擎失效时自动落到另一个可用引擎。apiStore 若在挂载后一拍才水合，
  // 本 watch 会随选项重算再次触发并自我纠正（瞬时切换不产生请求，无用户可见影响）
  watch(understandingEngineOptions, (opts) => {
    const current = opts.find((o) => o.value === understandingEngine.value);
    if (current?.disabled) {
      const fallback = opts.find((o) => !o.disabled);
      if (fallback) understandingEngine.value = fallback.value;
    }
  }, { immediate: true });
  const understandingLoading = ref(false);
  const understandingResult = ref<import('@/engine/image/types').ImageUnderstandingResult | null>(null);
  const understandingEditDraft = ref('');
  const understandingError = ref('');

  async function openUnderstandingForFile(file: File) {
    understandingFile.value = file;
    understandingMode.value = true;
    understandingResult.value = null;
    understandingError.value = '';
    understandingEditDraft.value = '';
    try {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(); img.src = objUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = 80; canvas.height = 56;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.drawImage(img, 0, 0, 80, 56); understandingCoverDataUrl.value = canvas.toDataURL('image/jpeg', 0.6); }
      URL.revokeObjectURL(objUrl);
    } catch { understandingCoverDataUrl.value = null; }
  }

  async function runUnderstanding() {
    if (!imageService || !understandingFile.value) return;
    understandingLoading.value = true;
    understandingError.value = '';
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read'));
        reader.readAsDataURL(understandingFile.value!);
      });
      const result = await imageService.analyzeImage({
        engine: understandingEngine.value,
        image: { id: generateReferenceId(), role: 'source', source: 'data_url', dataUrl },
        task: understandingTask.value,
        prompt: understandingExtra.value.trim() || undefined,
      });
      understandingResult.value = result;
      understandingEditDraft.value = result.positiveDraft;
      // 结构化解析降级：要标签却没标签 = 模型没按 JSON 出（原文已落 caption）
      if (understandingTask.value !== 'caption' && !result.tags?.length && result.caption) {
        eventBus.emit('ui:toast', { type: 'warning', message: t('image.toast.tagsNotParsed'), duration: 4000 });
      }
    } catch (err) {
      understandingError.value = classifyUnderstandingError((err as Error).message);
    } finally {
      understandingLoading.value = false;
    }
  }

  // 四类错误的 i18n 呈现（design §5.1）：引擎层错误是中文硬编码（引擎禁 import
  // vue-i18n），UI 层按稳定标记分类映射到 zh/en 文案；未识别的原样透出
  function classifyUnderstandingError(message: string): string {
    if (message.includes('拒绝分析')) return t('image.understanding.error.refused');
    if (message.includes('空响应（204')) return t('image.understanding.error.emptyResponse');
    if (message.includes('未将图片送达模型')) return t('image.understanding.error.imageDropped');
    return message;
  }

  function saveUnderstandingAsPreset(scope: 'npc' | 'scene') {
    if (!understandingResult.value) return;
    const preset: ArtistPreset = {
      id: `img_${Date.now()}`,
      name: understandingFile.value?.name?.replace(/\.\w+$/, '') ?? t('image.preset.defaultUnderstandingName'),
      scope,
      artistString: '',
      positive: understandingEditDraft.value || understandingResult.value.positiveDraft,
      negative: understandingResult.value.negativeDraft ?? '',
      pngMeta: {
        // vlm_ / llm_ 前缀（重建 epic §4）；历史 civitai_ 前缀数据保留可读
        source: `${understandingResult.value.provider === 'general_llm' ? 'llm' : 'vlm'}_${understandingResult.value.task}`,
        originalPrompt: understandingResult.value.positiveDraft,
        rawText: JSON.stringify(understandingResult.value.raw ?? {}),
        coverDataUrl: understandingCoverDataUrl.value ?? undefined,
        replicateParams: false,
      },
    };
    const list = [...artistPresets.value, preset];
    setValue('系统.扩展.image.artistPresets', list);
    selectedPresetId.value = preset.id;
    understandingMode.value = false;
    loadPresetIntoEditor();
    eventBus.emit('ui:toast', { type: 'success', message: scope === 'npc' ? t('image.toast.savedAsStylePresetNpc') : t('image.toast.savedAsStylePresetScene'), duration: 2000 });
  }

  function importImageForUnderstanding(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    if (!validateUploadSize(file)) return;
    void openUnderstandingForFile(file);
  }

  return {
    understandingMode,
    understandingFile,
    understandingCoverDataUrl,
    understandingTask,
    understandingExtra,
    understandingEngine,
    understandingCivitaiAvailable,
    understandingLlmInfo,
    UNDERSTANDING_MODEL_PRESETS,
    understandingCivitaiModel,
    applyUnderstandingModel,
    understandingEngineOptions,
    understandingNoEngine,
    understandingLoading,
    understandingResult,
    understandingEditDraft,
    understandingError,
    openUnderstandingForFile,
    runUnderstanding,
    classifyUnderstandingError,
    saveUnderstandingAsPreset,
    importImageForUnderstanding,
  };
}
