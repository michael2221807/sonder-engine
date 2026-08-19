// App doc: docs/user-guide/pages/creation.md §2.1
/**
 * useCreationFlow — JSON-driven character creation flow composable
 *
 * Orchestrates the multi-step character creation process defined by a
 * GamePack's CreationFlowConfig. Each step can be one of:
 *
 *   select-one         — pick exactly one preset entry
 *   select-many        — pick N preset entries (optionally budget-constrained)
 *   attribute-allocation — distribute points across attributes
 *   form               — fill in free-form fields
 *   confirmation       — final review before committing
 *
 * Key design decisions:
 *
 * 1. **Flow-level variables** — Steps can declare `affects` mappings that
 *    populate variables used by later steps (e.g., a world selection that
 *    sets `pointBudget`). This allows fully data-driven inter-step deps.
 *
 * 2. **Point budget** — Steps with `costField`/`costSource` enforce that
 *    the total cost of selections doesn't exceed the budget variable.
 *
 * 3. **AI-generated presets** — Steps with `aiGeneration.enabled` can
 *    call the AI to produce custom preset entries on-the-fly.
 *
 * 4. **Validation** — `canProceed` is a computed boolean per step,
 *    checking required selections, budget limits, and form completeness.
 *
 * Dependencies are injected via Vue provide/inject:
 *   - 'gamePack'         → GamePack
 *   - 'aiService'        → AIService
 *   - 'promptAssembler'  → PromptAssembler
 *   - 'responseParser'   → ResponseParser
 *
 * Phase M4 — UI Composable Layer.
 */
import { ref, computed, inject, onMounted, onUnmounted, readonly } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import type { Ref, ComputedRef, DeepReadonly } from 'vue';
import type {
  GamePack,
  CreationFlowConfig,
  CreationStep,
  PresetEntry,
} from '@/engine/types';
import type { AIService } from '@/engine/ai/ai-service';
import type { PromptAssembler } from '@/engine/prompt/prompt-assembler';
import type { ResponseParser } from '@/engine/ai/response-parser';
import type { CreationChoices } from '@/engine/pipeline/sub-pipelines/character-init';
import type { CustomPresetStore, CustomPresetEntry } from '@/engine/persistence/custom-preset-store';
import {
  getCreationGenre,
  isChoicePresetVisible,
  isPresetEntry,
  isWorldPresetVisible,
  retainVisiblePresetSelection,
} from '@/engine/creation/preset-policy';
import {
  buildBudgetSummary,
  validateCreationFlow,
  validateCreationStep,
  type BudgetSummary,
  type CreationValidationState,
} from '@/engine/creation/creation-budget';

// ═══════════════════════════════════════════════════════════════
//  Internal helper types (not exported — keep API surface small)
// ═══════════════════════════════════════════════════════════════

/** Error info surfaced to the UI for AI generation failures */
interface GenerationError {
  message: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════
//  Public return type
// ═══════════════════════════════════════════════════════════════

export interface UseCreationFlowReturn {
  // ─── Reactive state ──────────────────────────────────────────
  /** All steps defined by the creation flow config */
  steps: ComputedRef<CreationStep[]>;
  /** Zero-based index of the active step */
  currentStepIndex: Ref<number>;
  /** The active step definition */
  currentStep: ComputedRef<CreationStep | undefined>;
  /** Total number of steps */
  totalSteps: ComputedRef<number>;
  /** Progress ratio [0, 1] — useful for progress bars */
  progress: ComputedRef<number>;

  /** Per-step selections (key = step.id, value = selected preset(s)) */
  selections: DeepReadonly<Ref<Record<string, unknown>>>;
  /** Per-step attribute allocations (key = step.id) */
  attributes: DeepReadonly<Ref<Record<string, Record<string, number>>>>;
  /** Per-step form values (key = step.id) */
  formValues: DeepReadonly<Ref<Record<string, Record<string, unknown>>>>;
  /** Flow-level variables populated via step `affects` declarations */
  flowVariables: DeepReadonly<Ref<Record<string, unknown>>>;

  /** Whether the current step passes all validation checks */
  canProceed: ComputedRef<boolean>;
  /** Whether we're on the first step */
  isFirstStep: ComputedRef<boolean>;
  /** Whether we're on the last step */
  isLastStep: ComputedRef<boolean>;
  /** Whether an AI generation request is in flight */
  isGenerating: Ref<boolean>;
  /** Latest AI generation error, if any */
  generationError: Ref<GenerationError | null>;

  // ─── Computed budget helpers ──────────────────────────────────
  /** Remaining budget for the current step (null if step has no budget) */
  remainingBudget: ComputedRef<number | null>;
  /** Total spent in the current step (null if step has no budget) */
  totalSpent: ComputedRef<number | null>;
  /** One cross-step budget summary shared by all construction steps and confirmation. */
  budgetSummary: ComputedRef<BudgetSummary | null>;
  /** Validate all steps without mutating navigation state. */
  validateFlow: () => boolean;

  // ─── Navigation ──────────────────────────────────────────────
  /** Advance to the next step (no-op if already last or validation fails) */
  next: () => boolean;
  /** Go back to the previous step (no-op if already first) */
  prev: () => void;
  /** Jump to a specific step by index (only backwards or validated forward) */
  jumpTo: (index: number) => boolean;

  // ─── Selection mutations ─────────────────────────────────────
  /** Set selection for a select-one step */
  selectOne: (stepId: string, item: PresetEntry) => void;
  /** Toggle an item in a select-many step */
  toggleMany: (stepId: string, item: PresetEntry) => void;
  /** Clear selection for a step */
  clearSelection: (stepId: string) => void;
  /** Set a single attribute value for an attribute-allocation step */
  setAttribute: (stepId: string, attrName: string, value: number) => void;
  /** Set a form field value for a form step */
  setFormField: (stepId: string, fieldKey: string, value: unknown) => void;

  // ─── AI generation ──────────────────────────────────────────
  /** Ask AI to generate a custom preset entry for the current step */
  generateCustomPreset: (userPrompt: string) => Promise<PresetEntry | null>;

  // ─── User-custom preset mutations (Phase 1, 2026-04-14) ────
  /** Add a user-custom preset entry for a step (manual or AI-generated) */
  addCustomPreset: (
    step: CreationStep,
    fields: Record<string, unknown>,
    generatedBy?: 'manual' | 'ai',
  ) => Promise<CustomPresetEntry | null>;
  /** Patch an existing user-custom preset (only `user_` ids accepted) */
  updateCustomPreset: (
    step: CreationStep,
    id: string,
    patch: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Remove a user-custom preset (only `user_` ids accepted) */
  removeCustomPreset: (step: CreationStep, id: string) => Promise<boolean>;

  // ─── Finalisation ────────────────────────────────────────────
  /** Build the CreationChoices object from all collected data */
  buildChoices: () => CreationChoices;
  /** Reset the entire flow to its initial state */
  reset: () => void;

  // ─── Preset data helpers ─────────────────────────────────────
  /** Resolve preset entries for a given step from the GamePack */
  getPresetsForStep: (step: CreationStep) => PresetEntry[];
}

// ═══════════════════════════════════════════════════════════════
//  Composable implementation
// ═══════════════════════════════════════════════════════════════

export function useCreationFlow(): UseCreationFlowReturn {
  // ─── Dependency injection ────────────────────────────────────
  const gamePack = inject<GamePack>('gamePack');
  const aiService = inject<AIService>('aiService');
  const promptAssembler = inject<PromptAssembler>('promptAssembler');
  const responseParser = inject<ResponseParser>('responseParser');
  /**
   * 2026-04-14：用户自定义预设仓库（Phase 1 引入）
   * 注入失败（例如旧 host 未 provide）时退化为不显示用户预设、不允许添加。
   */
  const customPresetStore = inject<CustomPresetStore | undefined>('customPresetStore', undefined);

  if (!gamePack) {
    throw new Error(
      '[useCreationFlow] GamePack not provided via inject("gamePack"). ' +
      'Ensure a parent component calls provide("gamePack", pack).',
    );
  }

  const flowConfig: CreationFlowConfig = gamePack.creationFlow;
  const packId = gamePack.manifest.id;
  // Creation visibility is a session snapshot. Settings cannot change while the
  // wizard is open, so deliberately do not add a storage watcher here.
  const nsfwEnabled = readNsfwSettingOnce();

  // ─── User-custom presets state ──────────────────────────────
  /**
   * Reactive cache of user-added presets per type, keyed by the dataSource key
   * (e.g. "worlds", "origins"). Populated on mount via customPresetStore.load();
   * mutated by addCustomPreset / updateCustomPreset / removeCustomPreset which
   * persist to IDB then refresh this ref.
   *
   * `getPresetsForStep` reads from this when merging with `gamePack.presets[key]`.
   */
  const userPresetsByType = ref<Record<string, CustomPresetEntry[]>>({});

  /** Re-load user presets from IDB into the reactive cache */
  async function refreshUserPresets(): Promise<void> {
    if (!customPresetStore) return;
    const data = await customPresetStore.load(packId);
    userPresetsByType.value = data.presets ?? {};
  }

  // 启动时从 IDB 加载（不阻塞 setup —— 加载完后 reactive 自动刷新 UI）
  onMounted(() => { void refreshUserPresets(); });

  // 监听独立导入事件（SavePanel 导入预设包时发出），实时刷新创角列表
  // 仅同 packId 的事件触发刷新，避免跨 pack 干扰
  const offCustomPresetsChanged = eventBus.on<{ packId?: string }>(
    'engine:custom-presets-changed',
    (payload) => {
      if (!payload || payload.packId === packId) {
        void refreshUserPresets();
      }
    },
  );
  onUnmounted(() => offCustomPresetsChanged());

  // ─── Core reactive state ─────────────────────────────────────

  const currentStepIndex = ref(0);

  /**
   * Selections per step. Structure varies by step type:
   *   select-one  → single PresetEntry
   *   select-many → PresetEntry[]
   */
  const selections = ref<Record<string, unknown>>({});

  /**
   * Attribute allocations per step.
   * Only populated for 'attribute-allocation' steps.
   * Shape: { [stepId]: { attrName: value, ... } }
   */
  const attributes = ref<Record<string, Record<string, number>>>({});

  /**
   * Form field values per step.
   * Only populated for 'form' steps.
   * Shape: { [stepId]: { fieldKey: value, ... } }
   */
  const formValues = ref<Record<string, Record<string, unknown>>>({});

  /**
   * Flow-level variables set by step `affects` declarations.
   * These are readable by later steps (e.g., for budget constraints).
   */
  const flowVariables = ref<Record<string, unknown>>({});

  const isGenerating = ref(false);
  const generationError = ref<GenerationError | null>(null);

  function readNsfwSettingOnce(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem('aga_nsfw_settings');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { nsfwMode?: unknown };
      return parsed.nsfwMode === true;
    } catch {
      return false;
    }
  }

  // ─── Computed state ──────────────────────────────────────────

  const steps = computed(() => flowConfig.steps);
  const totalSteps = computed(() => flowConfig.steps.length);
  const currentStep = computed(() => flowConfig.steps[currentStepIndex.value]);
  const isFirstStep = computed(() => currentStepIndex.value === 0);
  const isLastStep = computed(() => currentStepIndex.value === totalSteps.value - 1);
  const progress = computed(() =>
    totalSteps.value > 0 ? (currentStepIndex.value + 1) / totalSteps.value : 0,
  );

  // ─── Budget helpers ──────────────────────────────────────────

  function getValidationState(): CreationValidationState {
    return {
      selections: selections.value,
      attributes: attributes.value,
      formValues: formValues.value,
      flowVariables: flowVariables.value,
    };
  }

  const budgetSummary = computed(() => {
    const step = currentStep.value;
    const source = step?.costSource
      ?? flowConfig.steps.find((candidate) => candidate.costSource)?.costSource;
    return source
      ? buildBudgetSummary(flowConfig.steps, getValidationState(), source)
      : null;
  });

  const remainingBudget = computed(() => budgetSummary.value?.remaining ?? null);
  const totalSpent = computed(() => budgetSummary.value?.spent ?? null);

  function validateFlow(): boolean {
    return validateCreationFlow(flowConfig.steps, getValidationState());
  }

  // ─── Validation ──────────────────────────────────────────────

  /**
   * Validate whether the current step allows proceeding.
   *
   * Rules per step type:
   * - select-one:          Must have a selection if required
   * - select-many:         Must have >= 1 selection if required; budget not exceeded
   * - attribute-allocation: All points must be allocated (total = totalPoints)
   * - form:                All required fields must be non-empty
   * - confirmation:        Always valid (review step)
   */
  const canProceed = computed(() => {
    const step = currentStep.value;
    if (!step) return false;
    if (step.type === 'confirmation') return validateFlow();
    return validateCreationStep(step, flowConfig.steps, getValidationState());
  });

  // ─── Affects processing ──────────────────────────────────────

  /**
   * After a selection changes, evaluate the step's `affects` mappings
   * to update flow-level variables.
   *
   * `affects` is a Record<string, string> where:
   *   key   = flow variable name (e.g., "pointBudget")
   *   value = path within the selected item, prefixed with "$." (e.g., "$.total_points")
   *
   * This enables purely data-driven inter-step dependencies:
   * a world selection can set a point budget consumed by a later talent step.
   */
  function processAffects(step: CreationStep, selectedValue: unknown): void {
    if (!step.affects) return;

    for (const [varName, pathExpr] of Object.entries(step.affects)) {
      if (typeof pathExpr !== 'string') continue;

      // Resolve the value from the selected item
      let resolved: unknown;

      if (pathExpr.startsWith('$.')) {
        // Dot-path within the selected object (e.g., "$.total_points")
        const objectPath = pathExpr.slice(2);
        if (selectedValue !== null && typeof selectedValue === 'object') {
          resolved = getNestedValue(selectedValue as Record<string, unknown>, objectPath);
        }
      } else {
        // Literal value
        resolved = pathExpr;
      }

      if (resolved !== undefined) {
        flowVariables.value[varName] = resolved;
      }
    }
  }

  /**
   * Simple dot-path accessor for plain objects.
   * We avoid importing lodash here to keep composable deps minimal.
   */
  function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const segments = path.split('.');
    let current: unknown = obj;
    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  // ─── Preset resolution ───────────────────────────────────────

  /**
   * Resolve the preset data array for a step.
   *
   * `step.dataSource` uses the format "presets.{key}" where {key}
   * maps to `gamePack.presets[key]`. We also handle bare keys
   * (without the "presets." prefix) as a fallback.
   */
  function getPresetsForStep(step: CreationStep): PresetEntry[] {
    if (!step.dataSource) return [];

    let key = step.dataSource;
    // Strip the "presets." namespace prefix if present
    if (key.startsWith('presets.')) {
      key = key.slice(8);
    }

    // ── Pack-bundled presets ──
    const packEntries = gamePack?.presets[key];
    const packList: PresetEntry[] = Array.isArray(packEntries)
      ? packEntries.filter(isPresetEntry)
      : [];
    // 给 pack 项打 source: 'pack' 标签（不会污染原始 gamePack.presets，因为我们 spread 复制）
    const packTagged: PresetEntry[] = packList.map((p) => ({ ...p, source: 'pack' as const }));

    // ── User-added custom presets ──
    // 2026-04-14：从 customPresetStore 注入的 reactive cache 取出 user 项，
    //              已带 source: 'user' 字段。前置（unshift 语义），与 demo 一致。
    const userList = userPresetsByType.value[key] ?? [];

    // ID 冲突保护：不允许 user_xxx 与 pack id 撞车（add/replaceAll 已强制 user_ 前缀）
    const packIds = new Set(packTagged.map((p) => (p.id ?? p.name) as string));
    const userFiltered = userList.filter((u) => !packIds.has(u.id));

    const merged = [...userFiltered, ...packTagged];
    if (key === 'worlds') {
      return merged.filter((entry) => isWorldPresetVisible(entry, nsfwEnabled));
    }
    if (key === 'origins' || key === 'traits' || key === 'talents') {
      const selectedGenre = getCreationGenre(selections.value.world);
      return merged.filter((entry) => isChoicePresetVisible(entry, selectedGenre, nsfwEnabled));
    }
    return merged;
  }

  // ─── User-custom preset mutations (Phase 1) ─────────────────

  /**
   * 添加用户自定义预设
   *
   * 解析 step.dataSource 拿到 presetType key，调 customPresetStore.add，
   * 然后 refreshUserPresets 让 UI 看到新项。
   *
   * @returns 新建的 entry（含生成的 id），失败返回 null
   */
  async function addCustomPreset(
    step: CreationStep,
    fields: Record<string, unknown>,
    generatedBy: 'manual' | 'ai' = 'manual',
  ): Promise<CustomPresetEntry | null> {
    if (!customPresetStore) return null;
    const key = resolvePresetTypeKey(step);
    if (!key) return null;
    const entry = await customPresetStore.add(packId, key, fields, generatedBy);
    await refreshUserPresets();
    return entry;
  }

  /** 更新用户预设字段（仅 user_ 前缀的 id 可改） */
  async function updateCustomPreset(
    step: CreationStep,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    if (!customPresetStore) return false;
    const key = resolvePresetTypeKey(step);
    if (!key) return false;
    const ok = await customPresetStore.update(packId, key, id, patch);
    if (ok) await refreshUserPresets();
    return ok;
  }

  /** 删除用户预设（仅 user_ 前缀的 id 可删；同时若选中项被删，清空 selection） */
  async function removeCustomPreset(step: CreationStep, id: string): Promise<boolean> {
    if (!customPresetStore) return false;
    const key = resolvePresetTypeKey(step);
    if (!key) return false;
    const ok = await customPresetStore.remove(packId, key, id);
    if (ok) {
      await refreshUserPresets();
      // 如果被删的项当前正被选中，把 selection 清掉避免悬空
      // CR-2026-04-14 P1-4：先判数组（数组本身 typeof === 'object'），
      // 否则空数组分支会先走单选清理逻辑（虽然当前 id 比较为 false 不会出错，但脆弱）
      const sel = selections.value[step.id];
      if (Array.isArray(sel)) {
        selections.value[step.id] = (sel as PresetEntry[]).filter((p) => p.id !== id);
      } else if (sel && typeof sel === 'object' && (sel as PresetEntry).id === id) {
        selections.value[step.id] = step.type === 'select-many' ? [] : null;
      }
    }
    return ok;
  }

  /** 解析 step.dataSource → 真实的 preset type key（脱掉 "presets." 前缀） */
  function resolvePresetTypeKey(step: CreationStep): string | null {
    if (!step.dataSource) return null;
    return step.dataSource.startsWith('presets.')
      ? step.dataSource.slice(8)
      : step.dataSource;
  }

  // ─── Selection mutations ─────────────────────────────────────

  function selectOne(stepId: string, item: PresetEntry): void {
    selections.value[stepId] = item;

    // Process affects for the step
    const step = flowConfig.steps.find((s) => s.id === stepId);
    if (step) {
      processAffects(step, item);
    }

    if (stepId === 'world') {
      clearSelectionsHiddenByWorld();
    }
  }

  function clearSelectionsHiddenByWorld(): void {
    for (const step of flowConfig.steps) {
      if (step.id === 'world' || (step.type !== 'select-one' && step.type !== 'select-many')) {
        continue;
      }
      const selected = selections.value[step.id];
      if (selected == null) continue;
      const visible = getPresetsForStep(step);
      const retained = retainVisiblePresetSelection(selected, visible);
      if (retained === undefined) {
        delete selections.value[step.id];
      } else {
        selections.value[step.id] = retained;
      }
    }
  }

  /**
   * Toggle an item in a select-many step.
   *
   * Matching uses the `id` field if present, falling back to
   * JSON equality for entries without explicit IDs.
   */
  function toggleMany(stepId: string, item: PresetEntry): void {
    const current = selections.value[stepId];
    const items: PresetEntry[] = Array.isArray(current) ? [...(current as PresetEntry[])] : [];

    const existingIndex = findItemIndex(items, item);

    if (existingIndex >= 0) {
      // Already selected → remove
      items.splice(existingIndex, 1);
    } else {
      // Not selected → add (budget check happens in canProceed, not here)
      items.push(item);
    }

    selections.value[stepId] = items;

    // Re-process affects with the full selection array
    const step = flowConfig.steps.find((s) => s.id === stepId);
    if (step) {
      processAffects(step, items);
    }
  }

  function clearSelection(stepId: string): void {
    delete selections.value[stepId];
  }

  /**
   * Find an item's index in an array by `id` field or JSON equality.
   * Returns -1 if not found.
   */
  function findItemIndex(items: PresetEntry[], target: PresetEntry): number {
    const targetId = target.id;
    if (targetId !== undefined) {
      return items.findIndex((existing) => existing.id === targetId);
    }
    const targetJson = JSON.stringify(target);
    return items.findIndex((existing) => JSON.stringify(existing) === targetJson);
  }

  function setAttribute(stepId: string, attrName: string, value: number): void {
    if (!attributes.value[stepId]) {
      attributes.value[stepId] = {};
    }
    attributes.value[stepId][attrName] = value;
  }

  function setFormField(stepId: string, fieldKey: string, value: unknown): void {
    if (!formValues.value[stepId]) {
      formValues.value[stepId] = {};
    }
    formValues.value[stepId][fieldKey] = value;
  }

  // ─── Navigation ──────────────────────────────────────────────

  /**
   * Advance to the next step.
   * Returns false if validation fails or we're already at the last step.
   */
  function next(): boolean {
    if (isLastStep.value) return false;
    if (!canProceed.value) return false;

    currentStepIndex.value++;
    initializeStep(currentStep.value);
    return true;
  }

  function prev(): void {
    if (isFirstStep.value) return;
    currentStepIndex.value--;
  }

  /**
   * Jump to a specific step by index.
   *
   * Forward jumps are only allowed if all intermediate steps validate.
   * Backward jumps are always allowed (user can revisit and modify).
   */
  function jumpTo(index: number): boolean {
    if (index < 0 || index >= totalSteps.value) return false;

    // Backward jump — always allowed
    if (index <= currentStepIndex.value) {
      currentStepIndex.value = index;
      return true;
    }

    // Forward jump — validate all intermediate steps
    const savedIndex = currentStepIndex.value;
    for (let i = savedIndex; i < index; i++) {
      currentStepIndex.value = i;
      if (!canProceed.value) {
        // Restore to the failing step so the user can see what's missing
        return false;
      }
    }

    currentStepIndex.value = index;
    initializeStep(currentStep.value);
    return true;
  }

  /**
   * Initialize a step's default values if not already set.
   * Called when navigating to a step for the first time.
   */
  function initializeStep(step: CreationStep | undefined): void {
    if (!step) return;

    if (step.type === 'attribute-allocation' && !attributes.value[step.id]) {
      const alloc: Record<string, number> = {};
      for (const attr of step.attributes ?? []) {
        alloc[attr] = 0;
      }
      attributes.value[step.id] = alloc;
    }

    if (step.type === 'form' && !formValues.value[step.id]) {
      const values: Record<string, unknown> = {};
      for (const field of step.fields ?? []) {
        if (field.default !== undefined) {
          values[field.key] = field.default;
        }
      }
      if (Object.keys(values).length > 0) {
        formValues.value[step.id] = values;
      }
    }
  }

  // ─── AI preset generation ───────────────────────────────────

  /**
   * Request the AI to generate a custom preset entry for the current step.
   *
   * Flow:
   * 1. Look up the step's aiGeneration config (promptFlow + promptModule)
   * 2. Build context variables from current selections
   * 3. Assemble prompt via PromptAssembler
   * 4. Call AIService.generate()
   * 5. Parse response via ResponseParser
   * 6. Extract and return the generated preset entry
   *
   * Returns null on failure (error stored in `generationError`).
   */
  async function generateCustomPreset(userPrompt: string): Promise<PresetEntry | null> {
    const step = currentStep.value;
    if (!step?.aiGeneration?.enabled) {
      generationError.value = {
        message: 'AI generation is not enabled for this step',
        timestamp: Date.now(),
      };
      return null;
    }

    if (!aiService || !promptAssembler || !responseParser) {
      generationError.value = {
        message: 'AI services not available — ensure aiService, promptAssembler, and responseParser are provided via inject()',
        timestamp: Date.now(),
      };
      return null;
    }

    isGenerating.value = true;
    generationError.value = null;

    try {
      // Resolve the prompt flow for AI generation
      const flow = gamePack?.promptFlows[step.aiGeneration.promptFlow];
      if (!flow) {
        throw new Error(
          `Prompt flow "${step.aiGeneration.promptFlow}" not found in GamePack`,
        );
      }

      // Build template variables from current flow state
      const variables: Record<string, string> = {
        USER_PROMPT: userPrompt,
        STEP_ID: step.id,
        STEP_LABEL: step.label,
        CURRENT_SELECTIONS: JSON.stringify(selections.value, null, 2),
        FLOW_VARIABLES: JSON.stringify(flowVariables.value, null, 2),
      };

      const assembled = promptAssembler.assemble(flow, variables);
      const rawResponse = await aiService.generate({
        messages: assembled.messages,
        usageType: 'instruction_generation',
      });

      const parsed = responseParser.parse(rawResponse);

      // The AI should return a JSON object representing the new preset entry.
      // We try to extract it from the parsed response's text or raw JSON.
      const entry = extractPresetFromResponse(parsed.text, parsed.raw);
      if (!entry) {
        throw new Error('AI response did not contain a valid preset entry');
      }

      return entry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      generationError.value = { message, timestamp: Date.now() };
      console.error('[useCreationFlow] AI generation failed:', err);
      return null;
    } finally {
      isGenerating.value = false;
    }
  }

  /**
   * Attempt to extract a preset entry object from the AI response.
   *
   * Strategy:
   * 1. Try parsing the text as JSON directly
   * 2. Try extracting a JSON code block
   * 3. Try finding a JSON object between the first { and last }
   */
  function extractPresetFromResponse(
    text: string,
    raw: string | undefined,
  ): PresetEntry | null {
    const candidates = [text, raw].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );

    for (const candidate of candidates) {
      // Strategy 1: direct parse
      try {
        const obj = JSON.parse(candidate) as unknown;
        if (isPresetEntry(obj)) return obj;
      } catch { /* continue */ }

      // Strategy 2: ```json ... ``` code block (also handles unclosed fence)
      const codeBlock = candidate.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
        ?? candidate.match(/```(?:json)?\s*\n?([\s\S]+)/);
      if (codeBlock?.[1]) {
        try {
          const obj = JSON.parse(codeBlock[1]) as unknown;
          if (isPresetEntry(obj)) return obj;
        } catch { /* continue */ }
      }

      // Strategy 3: first { to last }
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const obj = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as unknown;
          if (isPresetEntry(obj)) return obj;
        } catch { /* continue */ }
      }
    }

    return null;
  }

  /** Type guard: check that a parsed value is a non-null, non-array object */
  // ─── Finalisation ────────────────────────────────────────────

  /**
   * Build the CreationChoices object consumed by CharacterInitPipeline.
   *
   * Merges all step selections, attribute allocations, and form values
   * into the structure expected by the pipeline.
   */
  function buildChoices(): CreationChoices {
    // Merge all attribute-allocation steps into a single map
    const mergedAttributes: Record<string, number> = {};
    for (const alloc of Object.values(attributes.value)) {
      for (const [attr, val] of Object.entries(alloc)) {
        mergedAttributes[attr] = val;
      }
    }

    // Merge all form steps into a single map
    const mergedFormValues: Record<string, unknown> = {};
    for (const stepValues of Object.values(formValues.value)) {
      for (const [key, val] of Object.entries(stepValues)) {
        mergedFormValues[key] = val;
      }
    }

    return {
      selections: { ...selections.value },
      attributes: Object.keys(mergedAttributes).length > 0 ? mergedAttributes : undefined,
      formValues: Object.keys(mergedFormValues).length > 0 ? mergedFormValues : undefined,
    };
  }

  /**
   * Reset the entire creation flow back to step 0 with no selections.
   * Useful for "start over" functionality.
   */
  function reset(): void {
    currentStepIndex.value = 0;
    selections.value = {};
    attributes.value = {};
    formValues.value = {};
    flowVariables.value = {};
    isGenerating.value = false;
    generationError.value = null;

    // Initialize the first step's defaults
    initializeStep(currentStep.value);
  }

  // ─── Initialize first step on mount ──────────────────────────
  initializeStep(currentStep.value);

  // ─── Public API ──────────────────────────────────────────────

  return {
    steps,
    currentStepIndex,
    currentStep,
    totalSteps,
    progress,

    selections: readonly(selections),
    attributes: readonly(attributes),
    formValues: readonly(formValues),
    flowVariables: readonly(flowVariables),

    canProceed,
    isFirstStep,
    isLastStep,
    isGenerating,
    generationError,

    remainingBudget,
    totalSpent,
    budgetSummary,
    validateFlow,

    next,
    prev,
    jumpTo,

    selectOne,
    toggleMany,
    clearSelection,
    setAttribute,
    setFormField,

    generateCustomPreset,

    addCustomPreset,
    updateCustomPreset,
    removeCustomPreset,

    buildChoices,
    reset,

    getPresetsForStep,
  };
}
