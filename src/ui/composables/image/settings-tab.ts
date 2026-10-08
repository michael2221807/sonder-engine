/**
 * Settings tab state: backend status, Civitai JSON validation and the whatif cost query (R7 step 3). The whatif fetch is moved as-is.
 */
import { type Ref, ref, computed } from 'vue';
import type { ImageBackendType } from '@/engine/image/types';
import { prepareCivitaiLora } from '@/engine/image/civitai-lora';
import type { CivitaiLoraShelfItem, CivitaiLoraScope } from '@/engine/image/types';
import type { AIService } from '@/engine/ai/ai-service';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import type { PanelTranslate, GetState } from './panel-deps';

export interface UseSettingsTabDeps {
  get: GetState;
  t: PanelTranslate;
  aiService: AIService | undefined;
  backend: Readonly<Ref<ImageBackendType>>;
  ALL_IMAGE_BACKENDS: Readonly<Ref<SelectOption[]>>;
}

export function useSettingsTab(deps: UseSettingsTabDeps) {
  const { get, t, aiService, backend, ALL_IMAGE_BACKENDS } = deps;

  // Settings tab state
  const settingsBackend = computed(() => String(get('系统.扩展.image.config.defaultBackend') ?? 'novelai'));
  const isNovelAIBackend = computed(() => settingsBackend.value === 'novelai');
  const settingsLoraPreviewScope = ref<CivitaiLoraScope>('character');
  const settingsTransformerIndependent = computed(() => get('系统.扩展.image.config.transformerIndependentModel') === true);

  /** 该后端当前配置的模型名——`resolveStyleParams` 判定 Seedream `seed` 是否适用要用它 */
  function configuredModelFor(bk: ImageBackendType): string | undefined {
    return aiService?.getImageConfigForBackend(bk)?.model || undefined;
  }

  const activeBackendStatus = computed(() => {
    const bk = backend.value;
    const label = ALL_IMAGE_BACKENDS.value.find((o) => o.value === bk)?.label ?? bk;
    const cfg = aiService?.getImageConfigForBackend(bk);
    return {
      label,
      model: cfg?.model ?? '',
      configured: !!cfg,
      apiName: cfg?.name ?? '',
    };
  });

  const civitaiNetworksJsonError = ref('');
  const civitaiControlNetsJsonError = ref('');
  function validateCivitaiJson(field: 'additionalNetworksJson' | 'controlNetsJson', errorRef: 'civitaiNetworksJsonError' | 'civitaiControlNetsJsonError') {
    const raw = String(get(`系统.扩展.image.config.civitai.${field}`) ?? '').trim();
    if (!raw) { (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = ''; return; }
    try { JSON.parse(raw); (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = ''; }
    catch (e) { (errorRef === 'civitaiNetworksJsonError' ? civitaiNetworksJsonError : civitaiControlNetsJsonError).value = t('image.civitai.jsonFormatError', { error: (e as Error).message }); }
  }

  const civitaiWhatifLoading = ref(false);
  const civitaiWhatifResult = ref('');
  async function runCivitaiWhatif() {
    civitaiWhatifLoading.value = true;
    civitaiWhatifResult.value = '';
    try {
      const apiConfig = aiService?.getImageConfigForBackend('civitai');
      if (!apiConfig) { civitaiWhatifResult.value = t('image.civitai.notConfigured'); return; }
      const base = apiConfig.url.replace(/\/+$/, '');
      const body: Record<string, unknown> = { prompt: 'cost estimate', width: 1024, height: 1024, quantity: 1, batchSize: 1 };
      if (apiConfig.model) body.model = apiConfig.model;
      const steps = get('系统.扩展.image.config.civitai.steps');
      if (steps != null) body.steps = steps;

      // Include LoRA shelf in whatif request
      const loraShelfRaw = get('系统.扩展.image.config.civitai.loras');
      const loraShelf: CivitaiLoraShelfItem[] = Array.isArray(loraShelfRaw) ? loraShelfRaw as CivitaiLoraShelfItem[] : [];
      const rawNetJson = String(get('系统.扩展.image.config.civitai.additionalNetworksJson') ?? '');
      const scope = settingsLoraPreviewScope.value;
      const prepared = prepareCivitaiLora({ shelf: loraShelf, scope, positivePrompt: body.prompt as string, rawAdditionalNetworksJson: rawNetJson });
      body.prompt = prepared.modifiedPositive;
      if (prepared.mergedAdditionalNetworksJson) {
        try { body.additionalNetworks = JSON.parse(prepared.mergedAdditionalNetworksJson); } catch { /* ignore parse error */ }
      }

      const res = await fetch(`${base}/v2/consumer/recipes/textToImage?whatif=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { civitaiWhatifResult.value = t('image.civitai.queryFailedHttp', { status: res.status }); return; }
      const data = await res.json();
      const cost = data?.cost ?? data?.totalCost ?? data?.jobs?.[0]?.cost;
      civitaiWhatifResult.value = cost != null ? t('image.civitai.estimatedCost', { cost }) : t('image.civitai.queryComplete', { data: JSON.stringify(data).slice(0, 120) });
    } catch (e) {
      civitaiWhatifResult.value = t('image.civitai.queryFailed', { error: (e as Error).message });
    } finally {
      civitaiWhatifLoading.value = false;
    }
  }

  return {
    settingsBackend,
    isNovelAIBackend,
    settingsLoraPreviewScope,
    settingsTransformerIndependent,
    configuredModelFor,
    activeBackendStatus,
    civitaiNetworksJsonError,
    civitaiControlNetsJsonError,
    validateCivitaiJson,
    civitaiWhatifLoading,
    civitaiWhatifResult,
    runCivitaiWhatif,
  };
}
