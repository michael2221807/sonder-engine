<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md
/**
 * CreationView — Multi-step character creation wizard.
 *
 * Orchestrates the entire creation flow by:
 * 1. Consuming useCreationFlow() for step state, navigation, and validation
 * 2. Dynamically rendering the correct step component via `component :is`
 * 3. Displaying a progress indicator (step dots) at the top
 * 4. Providing prev/next/start-game navigation buttons at the bottom
 * 5. Showing a fullscreen loading overlay during AI generation and finalize
 *
 * The step ↔ component mapping is static — each CreationStep.type maps to
 * a known Vue component. This avoids dynamic imports and keeps the bundle
 * predictable. If a Game Pack declares a step type not in the map, StepForm
 * is used as a safe fallback.
 *
 * Finalization flow:
 *   User clicks "开始游戏" on the last step →
 *   buildChoices() produces a CreationChoices object →
 *   CharacterInitPipeline.run(choices) is invoked (if injected) →
 *   On success, navigate to /game
 *
 * Dependencies (inject):
 *   - 'gamePack'            → GamePack (required by useCreationFlow)
 *   - 'characterInitPipeline' → CharacterInitPipeline（未注入时见下方 fallback；STEP-03B M4.6 #5）
 *
 * §C4 GAP_AUDIT: 移除了 'saveManager' 依赖 —
 * CharacterInitPipeline 内部已经调用 saveManager.saveGame；
 * CreationView 不再需要读回存档，直接调 engineState.markLoaded() 即可。
 */
import {
  computed,
  ref,
  inject,
  markRaw,
  type Component,
} from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { set as _set } from 'lodash-es';
import { useCreationFlow } from '@/ui/composables/useCreationFlow';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import type { CharacterInitPipeline, CharacterInitResult } from '@/engine/pipeline/sub-pipelines/character-init';
import type { CreationStep, GameStateTree } from '@/engine/types';
import type { GamePack } from '@/engine/types/game-pack';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';

import StepSelectOne from '@/ui/components/creation/StepSelectOne.vue';
import StepSelectMany from '@/ui/components/creation/StepSelectMany.vue';
import StepAttributeAlloc from '@/ui/components/creation/StepAttributeAlloc.vue';
import StepForm from '@/ui/components/creation/StepForm.vue';
import StepConfirmation from '@/ui/components/creation/StepConfirmation.vue';
import EnhancedOpeningProgress from '@/ui/components/creation/EnhancedOpeningProgress.vue';
import EnhancedOpeningFailDialog from '@/ui/components/creation/EnhancedOpeningFailDialog.vue';
import type { PhaseErrorAction, PhaseErrorInfo, EnhancedOpeningSettings } from '@/engine/pipeline/sub-pipelines/enhanced-opening';
import LoadingOverlay from '@/ui/components/common/LoadingOverlay.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';

const router = useRouter();
const { t } = useI18n();
const engineState = useEngineStateStore();

// ─── Creation flow composable ─────────────────────────────────
const {
  steps,
  currentStepIndex,
  currentStep,
  totalSteps,
  progress,
  selections,
  formValues,
  attributes,
  canProceed,
  isFirstStep,
  isLastStep,
  isGenerating,
  generationError,
  remainingBudget,
  budgetSummary,
  validateFlow,
  next,
  prev,
  jumpTo,
  selectOne,
  toggleMany,
  setFormField,
  setAttribute,
  buildChoices,
  getPresetsForStep,
  addCustomPreset,
  updateCustomPreset,
  removeCustomPreset,
  reset,
} = useCreationFlow();

// ─── Optional pipeline injection ──────────────────────────────
// The second argument is a factory returning undefined — satisfies inject's
// overload that expects a default value or factory for optional deps.
const characterInitPipeline = inject<CharacterInitPipeline | null>('characterInitPipeline', null);
// §C4 GAP_AUDIT: saveManager inject 已移除 —
// CharacterInitPipeline 内部已经写存档，CreationView 不再需要读回
const gamePackInjected = inject<GamePack | undefined>('gamePack');

// ─── Finalization state ───────────────────────────────────────
const isFinalizing = ref(false);
const finalizeError = ref<string | null>(null);

/**
 * §4.1c: 分步开局模式 — 从 StepConfirmation 的 "开始游戏" 按钮传来
 *
 * 默认 false（单次调用）；toggle 打开后 StepConfirmation.startGame 会
 * emit `{ __confirm: true, options: { generationMode: 'step' } }`，
 * `onStepSelect` 的 confirmation 分支将其捕获到此 ref，随后在 `onFinalize`
 * 时作为 `{ splitGen: true }` 传给 `characterInitPipeline.execute()`。
 */
const splitGenOpening = ref(false);

/** Story 0: Enhanced Opening toggle state — default on (D21) */
const enhancedOpeningEnabled = ref(true);

/** Enhanced opening progress phase + percentage for the progress UI */
const openingProgress = ref<{ phase: string; progress: number } | null>(null);

/** E1 streaming preview text */
const openingStreamText = ref('');

/** AbortController for cancelling enhanced opening */
let openingAbortController: AbortController | null = null;

/** Enhanced opening advanced settings (synced from StepConfirmation) */
const enhancedOpeningSettings = ref<EnhancedOpeningSettings | null>(null);

/** Rate-limit waiting state for progress UI */
const rateLimitWaitSeconds = ref<number | null>(null);

/** Failure dialog state */
const phaseError = ref<PhaseErrorInfo | null>(null);
let phaseErrorResolve: ((action: PhaseErrorAction) => void) | null = null;

function onPhaseErrorAction(action: PhaseErrorAction): void {
  phaseError.value = null;
  phaseErrorResolve?.(action);
  phaseErrorResolve = null;
}

async function handlePhaseError(info: PhaseErrorInfo): Promise<PhaseErrorAction> {
  phaseError.value = info;
  return new Promise<PhaseErrorAction>((resolve) => {
    phaseErrorResolve = resolve;
  });
}

/**
 * Map step types to their rendering components.
 * markRaw prevents Vue from making component constructors reactive
 * (they're static objects and reactivity adds overhead with no benefit).
 */
const componentMap: Record<string, Component> = {
  'select-one': markRaw(StepSelectOne),
  'select-many': markRaw(StepSelectMany),
  'attribute-allocation': markRaw(StepAttributeAlloc),
  'form': markRaw(StepForm),
  'confirmation': markRaw(StepConfirmation),
};

/** Resolve the component for the current step, falling back to StepForm */
const stepComponent = computed<Component>(() => {
  const type = currentStep.value?.type;
  if (!type) return markRaw(StepForm);
  return componentMap[type] ?? markRaw(StepForm);
});

/** Resolve preset data for the current step */
const currentPresets = computed(() => {
  if (!currentStep.value) return [];
  return getPresetsForStep(currentStep.value);
});

/**
 * 确认步骤：汇总此前各步的选择（供 StepConfirmation 展示摘要与姓名）
 */
function buildConfirmationSelection(): Record<string, { label: string; value: unknown }> {
  const out: Record<string, { label: string; value: unknown }> = {};
  for (const s of steps.value as CreationStep[]) {
    if (s.type === 'confirmation') break;
    let value: unknown;
    if (s.type === 'form') {
      value = formValues.value[s.id] ?? {};
    } else if (s.type === 'attribute-allocation') {
      value = attributes.value[s.id] ?? {};
    } else {
      value = selections.value[s.id];
    }
    out[s.id] = { label: s.label, value };
  }
  return out;
}

/** Current selection / form / 属性分配；确认步为前面各步的汇总对象 */
const currentSelection = computed(() => {
  if (!currentStep.value) return undefined;
  const step = currentStep.value;
  if (step.type === 'confirmation') {
    return buildConfirmationSelection();
  }
  if (step.type === 'form') {
    return formValues.value[step.id];
  }
  if (step.type === 'attribute-allocation') {
    return attributes.value[step.id];
  }
  return selections.value[step.id];
});

/** Budget for the active step (passed as prop to step components) */
const currentBudget = computed(() => remainingBudget.value ?? 0);

/**
 * Loading overlay message — reflects the current async operation.
 * AI generation shows a different message than finalization.
 */
const loadingMessage = computed(() => {
  if (isFinalizing.value) return t('creation.loading.creatingWorld');
  if (isGenerating.value) return t('creation.loading.aiGenerating');
  return '';
});

const isLoadingVisible = computed(() => isGenerating.value || isFinalizing.value);

// ─── Event handlers ───────────────────────────────────────────

/**
 * 2026-04-14 Phase 2：用户提交了"+ 自定义" / "✏ 编辑"模态
 *
 * editingId 为 null = 新增；否则 = 编辑指定 user entry。
 * 写入完成后 toast 提示，IDB → reactive cache 自动刷新选择列表。
 * 失败（store 未注入 / IDB 错误）静默降级 + 错误 toast。
 */
async function onCustomSave(payload: { fields: Record<string, unknown>; editingId: string | null }): Promise<void> {
  const step = currentStep.value;
  if (!step) return;
  try {
    if (payload.editingId) {
      const ok = await updateCustomPreset(step, payload.editingId, payload.fields);
      if (ok) {
        eventBus.emit('ui:toast', { type: 'success', message: t('creation.toast.customUpdated'), duration: 1500 });
      } else {
        eventBus.emit('ui:toast', { type: 'error', message: t('creation.toast.updateFailed'), duration: 2500 });
      }
    } else {
      const entry = await addCustomPreset(step, payload.fields, 'manual');
      if (entry) {
        eventBus.emit('ui:toast', { type: 'success', message: t('creation.toast.customSaved', { label: step.label }), duration: 1500 });
      } else {
        eventBus.emit('ui:toast', { type: 'error', message: t('creation.toast.saveFailed'), duration: 2500 });
      }
    }
  } catch (err) {
    console.error('[CreationView] onCustomSave failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('creation.toast.saveItemFailed'), duration: 2500 });
  }
}

/** 删除一条用户自定义条目 */
async function onCustomRemove(id: string): Promise<void> {
  const step = currentStep.value;
  if (!step) return;
  try {
    const ok = await removeCustomPreset(step, id);
    if (ok) {
      eventBus.emit('ui:toast', { type: 'warning', message: t('creation.toast.customDeleted'), duration: 1500 });
    }
  } catch (err) {
    console.error('[CreationView] onCustomRemove failed:', err);
    eventBus.emit('ui:toast', { type: 'error', message: t('creation.toast.deleteFailed'), duration: 2500 });
  }
}

/**
 * Handle selection events from step components.
 * Routes to the correct mutation method based on the current step type.
 */
function onStepSelect(value: unknown): void {
  const step = currentStep.value;
  if (!step) return;

  switch (step.type) {
    case 'select-one':
      if (value && typeof value === 'object') {
        selectOne(step.id, value as Record<string, unknown>);
      }
      break;
    case 'select-many':
      if (value && typeof value === 'object') {
        toggleMany(step.id, value as Record<string, unknown>);
      }
      break;
    case 'form':
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const data = value as Record<string, unknown>;
        for (const [fieldKey, fieldVal] of Object.entries(data)) {
          setFormField(step.id, fieldKey, fieldVal);
        }
      }
      break;
    case 'attribute-allocation':
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [attr, v] of Object.entries(value as Record<string, unknown>)) {
          const n = typeof v === 'number' ? v : Number(v);
          setAttribute(step.id, attr, Number.isNaN(n) ? 0 : n);
        }
      }
      break;
    case 'confirmation': {
      // §4.1c: StepConfirmation 发两种 emit：
      //   - { __confirm: false, options: { generationMode } } — toggle 改变时持续同步
      //   - { __confirm: true, options: { generationMode } } — 用户点内部"开始游戏"按钮
      //
      // 前者用来实时同步 splitGenOpening；后者额外触发 onFinalize（把之前那个
      // "内部开始游戏按钮完全无效"的 dead-button 问题顺手修了）。
      //
      // 注意 buildChoices 不包含 generationMode（它只收集 selections/attributes/formValues），
      // 所以必须在这里单独捕获到 splitGenOpening ref。
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const payload = value as { __confirm?: boolean; options?: { generationMode?: string; enhancedOpening?: boolean; enhancedOpeningSettings?: EnhancedOpeningSettings } };
        if (payload.options && payload.options.generationMode !== undefined) {
          splitGenOpening.value = payload.options.generationMode === 'step';
        }
        if (payload.options && payload.options.enhancedOpening !== undefined) {
          enhancedOpeningEnabled.value = payload.options.enhancedOpening;
        }
        if (payload.options?.enhancedOpeningSettings) {
          enhancedOpeningSettings.value = payload.options.enhancedOpeningSettings;
        }
        if (payload.__confirm) {
          void onFinalize();
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Navigate to the next step; no-op if validation fails */
function onNext(): void {
  next();
}

/** Navigate to the previous step */
function onPrev(): void {
  prev();
}

/** Jump to a specific step by clicking a progress dot */
function onDotClick(index: number): void {
  jumpTo(index);
}

/**
 * Finalize the creation — build choices, run the init pipeline,
 * load the result into the engine state, and navigate to /game.
 */
async function onFinalize(): Promise<void> {
  if (isFinalizing.value) return;

  // Must reject an invalid build before clearGame() touches the active profile.
  if (!validateFlow()) {
    finalizeError.value = t('creation.error.invalidBuild');
    return;
  }

  isFinalizing.value = true;
  finalizeError.value = null;

  try {
    const choices = buildChoices();

    if (characterInitPipeline) {
      // Reset enhanced opening UI state
      openingProgress.value = null;
      openingStreamText.value = '';
      rateLimitWaitSeconds.value = null;
      openingAbortController = new AbortController();

      // BUG FIX: Clear active game BEFORE the pipeline starts.
      // The pipeline calls stateManager.loadTree() which overwrites the shared
      // reactive proxy with the new character's data. If activeProfileId still
      // points to the OLD character at that point, PostProcessStage.autoSave()
      // (triggered during enhanced opening Phase F) would save the new character's
      // data to the OLD character's IDB key, silently corrupting the old save.
      // clearGame() sets activeProfileId/activeSlotId to null, so getActiveSlot()
      // returns null and autoSave() safely no-ops.
      engineState.clearGame();

      const result: CharacterInitResult = await characterInitPipeline.execute(
        choices,
        {
          splitGen: splitGenOpening.value,
          enhancedOpening: enhancedOpeningEnabled.value,
          enhancedOpeningSettings: enhancedOpeningSettings.value ?? undefined,
          abortSignal: openingAbortController.signal,
          onProgress: (phase: string, progress: number) => {
            openingProgress.value = { phase, progress };
            // CR-4.2: Reset stream preview when Phase E starts (or retries)
            if (phase === 'phaseE' && progress === 0) {
              openingStreamText.value = '';
            }
          },
          onStreamChunk: splitGenOpening.value
            ? (chunk: string) => { openingStreamText.value += chunk; }
            : undefined,
          onPhaseError: handlePhaseError,
          onRateLimitWait: (seconds: number | null) => {
            rateLimitWaitSeconds.value = seconds;
          },
        },
      );
      openingAbortController = null;
      if (!result.success) {
        finalizeError.value = result.error ?? t('creation.error.creationFailed');
        return;
      }
      if (!gamePackInjected) {
        finalizeError.value = t('creation.error.missingGamePack');
        return;
      }
      /*
       * §C4 GAP_AUDIT: 跳过 saveManager.loadGame + engineState.loadGame 的往返。
       *
       * CharacterInitPipeline 执行过程中：
       * 1. stateManager.loadTree(initialState) 写入初始状态
       * 2. AI 生成的 commands 应用到同一 stateManager
       * 3. pipeline 内部 saveManager.saveGame(snapshot) 已经落盘
       *
       * 由于 engineStateStore.linkStateManager() 使 Pinia tree 与 stateManager.state
       * 共享同一 reactive proxy，pipeline 完成后 Pinia 已经持有完整状态。
       * 只需标记 isGameLoaded 并设置 activePackId/ProfileId/SlotId 元数据即可。
       *
       * 避免了：
       * - 1 次 IDB 读
       * - 1 次 JSON 序列化 + 反序列化
       * - 1 次 stateManager.loadTree（会清空当前 reactive proxy 再重填）
       */
      engineState.markLoaded(
        gamePackInjected.manifest.id,
        result.profileId,
        result.slotId,
      );
    } else {
      /*
       * Fallback when CharacterInitPipeline is not yet wired (bootstrap/main 未 provide)。
       * 最小树须包含 MainGamePanel 读的叙事历史/回合数（与 DEFAULT_ENGINE_PATHS 一致），
       * 否则进 /game 后对话区为空但仍算「已加载」。
       * 使用 lodash set 按路径写入，避免手写嵌套键与管线漂移。
       */
      const minimal: GameStateTree = {};
      _set(minimal, DEFAULT_ENGINE_PATHS.roundNumber, 0);
      _set(minimal, DEFAULT_ENGINE_PATHS.narrativeHistory, []);
      _set(minimal, DEFAULT_ENGINE_PATHS.characterBaseInfo, {});
      engineState.loadGame(
        minimal,
        'unknown',
        `profile_${Date.now()}`,
        'slot_auto',
      );
    }

    router.push('/game');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finalizeError.value = t('creation.error.creationFailedMsg', { msg });
    console.error('[CreationView] Finalization failed:', err);
  } finally {
    isFinalizing.value = false;
  }
}

function cancelEnhancedOpening(): void {
  openingAbortController?.abort();
  openingAbortController = null;
}

/** Reset the flow and return to step 1 */
function onReset(): void {
  reset();
  finalizeError.value = null;
}

/** Navigate back to the home page */
function goHome(): void {
  router.push('/');
}
</script>

<template>
  <div class="creation-view">
    <!-- Top bar with back button and title -->
    <header class="creation-header">
      <Tooltip :text="$t('creation.header.backHome')" position="bottom" interactive>
        <button class="btn-back" @click="goHome" :aria-label="$t('creation.header.backHome')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </Tooltip>
      <h1 class="creation-title">{{ $t('creation.header.title') }}</h1>
      <button class="btn-reset" @click="onReset" :disabled="isFirstStep && !Object.keys(selections).length">
        {{ $t('creation.header.reset') }}
      </button>
    </header>

    <!--
      Progress indicator — a row of dots representing each step.
      The current step is highlighted; completed steps are filled.
      Clicking a dot jumps to that step (backward always, forward only if validated).
    -->
    <nav class="progress-bar" :aria-label="$t('creation.progress.label')">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progress * 100}%` }" />
      </div>
      <div class="progress-dots">
        <button
          v-for="(step, idx) in steps"
          :key="step.id"
          class="progress-dot"
          :class="{
            active: idx === currentStepIndex,
            completed: idx < currentStepIndex,
          }"
          :aria-label="$t('creation.progress.stepLabel', { num: idx + 1, label: step.label })"
          :aria-current="idx === currentStepIndex ? 'step' : undefined"
          @click="onDotClick(idx)"
        >
          <span class="dot-inner" />
          <span class="dot-label">{{ step.label }}</span>
        </button>
      </div>
      <span class="progress-text">{{ currentStepIndex + 1 }} / {{ totalSteps }}</span>
    </nav>

    <!-- Dynamic step content area -->
    <main class="step-content">
      <Transition name="step-slide" mode="out-in">
        <component
          :is="stepComponent"
          :key="currentStep?.id"
          :step="currentStep"
          :presets="currentPresets"
          :selection="currentSelection"
          :budget="currentBudget"
          :budget-summary="budgetSummary"
          @select="onStepSelect"
          @custom-save="onCustomSave"
          @custom-remove="onCustomRemove"
        />
      </Transition>
    </main>

    <!-- Error display -->
    <Transition name="fade">
      <div
        v-if="finalizeError || generationError"
        class="error-banner"
        role="alert"
      >
        <span class="error-text">{{ finalizeError ?? generationError?.message }}</span>
        <Tooltip :text="$t('creation.error.dismiss')" position="left" interactive>
          <button
            class="error-dismiss"
            @click="finalizeError = null"
            :aria-label="$t('creation.error.dismiss')"
          >
            &times;
          </button>
        </Tooltip>
      </div>
    </Transition>

    <!-- Navigation buttons -->
    <footer class="creation-nav">
      <AgaButton
        variant="secondary"
        class="nav-btn"
        :disabled="isFirstStep || isFinalizing"
        @click="onPrev"
      >
        {{ $t('creation.nav.previous') }}
      </AgaButton>

      <AgaButton
        v-if="!isLastStep"
        variant="primary"
        class="nav-btn"
        data-testid="creation-next"
        :disabled="!canProceed || isFinalizing"
        @click="onNext"
      >
        {{ $t('creation.nav.next') }}
      </AgaButton>

      <AgaButton
        v-else
        variant="warning"
        class="nav-btn nav-btn--start"
        data-testid="creation-start"
        :disabled="!canProceed || isFinalizing"
        @click="onFinalize"
      >
        {{ $t('creation.nav.startGame') }}
      </AgaButton>
    </footer>

    <!-- Enhanced opening progress overlay -->
    <Teleport to="body">
      <div v-if="isFinalizing && enhancedOpeningEnabled && openingProgress && !phaseError" class="enhanced-opening-overlay">
        <EnhancedOpeningProgress
          :current-phase="openingProgress?.phase ?? null"
          :current-progress="openingProgress?.progress ?? 0"
          :stream-text="openingStreamText"
          :rate-limit-wait-seconds="rateLimitWaitSeconds"
          @cancel="cancelEnhancedOpening"
        />
      </div>
    </Teleport>

    <!-- Phase failure dialog -->
    <Teleport to="body">
      <EnhancedOpeningFailDialog
        v-if="phaseError"
        :phase="phaseError.phase"
        :reason="phaseError.reason"
        :available-actions="phaseError.availableActions"
        @action="onPhaseErrorAction"
      />
    </Teleport>

    <!-- Fullscreen loading overlay for AI generation and finalization (non-enhanced path) -->
    <LoadingOverlay
      :visible="isLoadingVisible && !(enhancedOpeningEnabled && openingProgress)"
      :message="loadingMessage"
      :fullscreen="true"
    />
  </div>
</template>

<style scoped>
/*
 * CreationView — sanctuary migration 2026-04-21.
 * Template + script untouched; only `<style scoped>` rewritten.
 * Off-grid view (no /game/* sidebars) so no sidebar-reserve pattern.
 *
 * Key changes:
 *   - All `#fff` removed from nav buttons (primary sage-muted beacon,
 *     start-game amber-muted "rare confirmation warmth", secondary neutral)
 *   - Progress fill + active dot: Tailwind indigo-rgba → sage + glow
 *   - Completed dot: --color-success → sage-500 (sanctuary palette)
 *   - Error banner: Tailwind red-rgba → tokenized rust color-mix
 *   - Title: serif + sanctuary letter-spacing
 *   - Motion tokenized; step-slide preserves existing crossfade direction
 */
.creation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  position: relative;
  overflow: hidden;
}

/* ── Header ─────────────────────────────────────────────────── */

.creation-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1.25rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
}

.btn-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.btn-back:hover {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.creation-title {
  flex: 1;
  font-family: var(--font-serif-cjk);
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: var(--color-text);
}

.btn-reset {
  padding: 0.3rem 0.85rem;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.btn-reset:hover:not(:disabled) {
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  border-color: color-mix(in oklch, var(--color-danger) 45%, transparent);
  background: color-mix(in oklch, var(--color-danger) 8%, transparent);
}
.btn-reset:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* ── Progress indicator ─────────────────────────────────────── */

.progress-bar {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.875rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.progress-track {
  height: 2px;
  background: var(--color-border);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-sage-400);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400) 40%, transparent),
              0 0 14px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  border-radius: var(--radius-full);
  transition: width var(--duration-slow) var(--ease-out);
}

.progress-dots {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}
.progress-dots::-webkit-scrollbar { display: none; }

.progress-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.progress-dot:hover { opacity: 0.9; }

.dot-inner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--color-border);
  background: transparent;
  transition: background-color var(--duration-normal) var(--ease-out),
              border-color var(--duration-normal) var(--ease-out),
              box-shadow var(--duration-normal) var(--ease-out);
}

.progress-dot.active .dot-inner {
  background: var(--color-sage-400);
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 4px color-mix(in oklch, var(--color-sage-400) 18%, transparent),
              0 0 10px color-mix(in oklch, var(--color-sage-400) 40%, transparent),
              0 0 16px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

.progress-dot.completed .dot-inner {
  background: var(--color-sage-500);
  border-color: var(--color-sage-500);
}

.dot-label {
  font-family: var(--font-serif-cjk);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.progress-dot.active .dot-label {
  color: var(--color-sage-300);
  font-weight: 500;
}
.progress-dot.completed .dot-label { color: var(--color-text-secondary); }

.progress-text {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  align-self: flex-end;
}

/* ── Step content area ──────────────────────────────────────── */

.step-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 1.75rem;
  min-height: 0;
}

/* ── Error banner ───────────────────────────────────────────── */

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0 1.25rem;
  padding: 0.5rem 0.875rem;
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 40%, transparent);
  border-radius: var(--radius-md);
  flex-shrink: 0;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-danger) 6%, transparent);
}

.error-text {
  flex: 1;
  font-size: 0.82rem;
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
}

.error-dismiss {
  background: transparent;
  border: none;
  color: color-mix(in oklch, var(--color-danger) 80%, var(--color-text));
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out);
}
.error-dismiss:hover {
  background: color-mix(in oklch, var(--color-danger) 20%, transparent);
}

/* ── Navigation footer ──────────────────────────────────────── */

.creation-nav {
  display: flex;
  justify-content: center;
  gap: 0.625rem;
  padding: 0.875rem 1.25rem;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
}

/* Nav buttons reuse the AgaButton primitive (variants secondary/primary/warning);
   .nav-btn only restores this footer's generous threshold-moment padding +
   letter-spacing (wider than AgaButton's default md size). */
.nav-btn {
  padding: 0.625rem 2rem;
  letter-spacing: 0.06em;
}

/* "开始游戏" — amber warm beacon (rare confirmation, brief-compliant).
   AgaButton variant=warning already supplies the amber fill + glow; this only
   adds the threshold-moment text-shadow that makes starting a new game feel
   like a one-shot warm event. Amber is explicitly allowed for "narrative
   emphasis / confirmation" per .impeccable.md. */
.nav-btn--start:hover:not(:disabled) {
  text-shadow: 0 0 6px color-mix(in oklch, var(--color-amber-400) 30%, transparent);
}

/* ── Step slide transition — sanctuary ease-out ── */

.step-slide-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out),
              transform var(--duration-normal) var(--ease-out);
}
.step-slide-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out);
}
.step-slide-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.step-slide-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}

/* ── Fade transition ── */

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── Responsive ── */

@media (max-width: 767px) {
  .creation-nav .nav-btn {
    min-height: 44px;
  }
}

@media (max-width: 480px) {
  .creation-header {
    padding: 0.5rem 0.75rem;
  }
  .step-content {
    padding: 1rem 0.875rem;
  }
  .progress-bar {
    padding: 0.5rem 0.875rem;
  }
  .creation-nav {
    padding: 0.625rem 0.875rem;
  }
  .nav-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.78rem;
  }
}

.enhanced-opening-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--glass-overlay-bg, rgba(0, 0, 0, 0.6));
  backdrop-filter: var(--glass-overlay-blur, blur(8px));
}
</style>
