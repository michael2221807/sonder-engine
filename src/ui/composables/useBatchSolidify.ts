// App doc: docs/user-guide/pages/game-relationship-graph.md §4.19.3
/**
 * useBatchSolidify — Vue composable for Engram batch solidify (Story 4).
 *
 * Wraps EngramBatchSolidifyPipeline with Vue reactive state for:
 * - One-click batch solidify button
 * - Progress phase tracking
 * - Coverage stats refresh
 */
import { ref } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import {
  EngramBatchSolidifyPipeline,
  detectMissingEngramData,
  type BatchSolidifyPhase,
  type BatchSolidifyResult,
  type BatchSolidifyPaths,
} from '@/engine/memory/engram/batch-solidify-pipeline';

const JAILBREAK_KEY = 'jailbreak';

export function useBatchSolidify() {
  const engramEditor = injectService('engramEditor');
  const engramManager = injectService('engramManager');
  const aiService = injectService('aiService');
  const stateManager = injectService('stateManager');
  const gamePack = injectService('gamePack', null);
  const promptAssembler = injectService('promptAssembler', undefined);
  const memoryRetriever = injectService('memoryRetriever', null);

  const available = !!(engramEditor && engramManager && aiService && stateManager);

  const { t } = useI18n();

  const phase = ref<BatchSolidifyPhase | 'idle'>('idle');
  const isRunning = ref(false);
  const lastResult = ref<BatchSolidifyResult | null>(null);
  const lastError = ref<string | null>(null);

  const paths: BatchSolidifyPaths = {
    relationships: DEFAULT_ENGINE_PATHS.relationships,
    locations: DEFAULT_ENGINE_PATHS.locations,
    engramMemory: DEFAULT_ENGINE_PATHS.engramMemory,
    playerName: DEFAULT_ENGINE_PATHS.playerName,
    roundNumber: DEFAULT_ENGINE_PATHS.roundNumber,
    npcNameField: DEFAULT_ENGINE_PATHS.npcFieldNames.name,
    npcTypeField: DEFAULT_ENGINE_PATHS.npcFieldNames.type,
    npcTypeExclude: DEFAULT_ENGINE_PATHS.npcTypeExclude,
    npcAppearanceField: DEFAULT_ENGINE_PATHS.npcFieldNames.appearance,
    npcDescriptionField: DEFAULT_ENGINE_PATHS.npcFieldNames.description,
    locationNameField: DEFAULT_ENGINE_PATHS.locationFieldNames.name,
    locationDescriptionField: DEFAULT_ENGINE_PATHS.locationFieldNames.description,
    narrativeHistory: DEFAULT_ENGINE_PATHS.narrativeHistory,
  };

  function getJailbreakPrompt(): string | undefined {
    // As the prompt page left it: edited, or none when switched off (item 2, PO 2026-10-05).
    const text = promptAssembler
      ? promptAssembler.effectiveText(JAILBREAK_KEY, gamePack?.prompts)
      : gamePack?.prompts?.[JAILBREAK_KEY] ?? '';
    return text.trim() || undefined;
  }

  async function run(): Promise<BatchSolidifyResult | null> {
    if (isRunning.value || !available) return null;

    isRunning.value = true;
    lastError.value = null;
    phase.value = 'idle';

    try {
      const pipeline = new EngramBatchSolidifyPipeline({
        aiService: aiService!,
        stateManager: stateManager!,
        engramEditor: engramEditor!,
        engramManager: engramManager!,
        paths,
        jailbreakPrompt: getJailbreakPrompt(),
        memoryRetriever: memoryRetriever ?? undefined,
      });

      const result = await pipeline.run((p) => {
        phase.value = p;
      });

      lastResult.value = result;

      if (result.alreadyComplete) {
        eventBus.emit('ui:toast', {
          type: 'info',
          i18nKey: 'engram.batchSolidify.nothingToGenerate',
          message: t('engram.batchSolidify.nothingToGenerate'),
        });
      } else if (result.created === 0 && result.skipped === 0) {
        eventBus.emit('ui:toast', {
          type: 'info',
          i18nKey: 'engram.batchSolidify.alreadyComplete',
          message: t('engram.batchSolidify.alreadyComplete'),
        });
      } else if (result.skipped > 0) {
        eventBus.emit('ui:toast', {
          type: 'success',
          i18nKey: 'engram.batchSolidify.completeWithSkipped',
          message: t('engram.batchSolidify.completeWithSkipped', {
            created: result.created,
            skipped: result.skipped,
          }),
        });
      } else {
        eventBus.emit('ui:toast', {
          type: 'success',
          i18nKey: 'engram.batchSolidify.complete',
          message: t('engram.batchSolidify.complete', { created: result.created }),
        });
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[BatchSolidify] Pipeline error:', msg);
      lastError.value = msg;
      phase.value = 'error';
      eventBus.emit('ui:toast', {
        type: 'error',
        i18nKey: 'engram.batchSolidify.error',
        message: t('engram.batchSolidify.error'),
      });
      return null;
    } finally {
      isRunning.value = false;
    }
  }

  function getProgressMessage(): string {
    switch (phase.value) {
      case 'scanning': return t('engram.batchSolidify.progress.scanning');
      case 'generating': return t('engram.batchSolidify.progress.generating');
      case 'applying': return t('engram.batchSolidify.progress.applying');
      default: return '';
    }
  }

  return {
    available,
    phase,
    isRunning,
    lastResult,
    lastError,
    run,
    getProgressMessage,
    detectMissing: () => available ? detectMissingEngramData(stateManager!, paths) : null,
  };
}
