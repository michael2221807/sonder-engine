// Architecture: docs/architecture/image-generation-system.md
// App doc: docs/user-guide/pages/game-image.md §后台生成保护机制
/**
 * Image Service — Sprint Image-5
 *
 * Top-level orchestrator for the image generation subsystem.
 * Coordinates: tokenizer → composer → provider → cache.
 *
 * Per PRINCIPLES §3.9: gated by `系统.扩展.image.enabled` flag.
 * When disabled, all methods are no-ops.
 * Per PRINCIPLES §3.11: uses APIAssignment via AIService for API routing.
 * Per PRINCIPLES §3.14: parallelism classification on task types.
 */
import type { StateManager } from '../core/state-manager';
import type { AIService } from '../ai/ai-service';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { EnginePathConfig } from '../pipeline/types';
import { ImageTokenizer } from './tokenizer';
import { ImagePromptComposer } from './prompt-composer';
import { ImageProviderRegistry } from './provider-registry';
import { ImageAssetCache } from './asset-cache';
import { ImageTaskQueue } from './task-queue';
import type { ImageTask, ImageAsset, ImageBackendType, ImageSubjectType, CharacterAnchor, StylePreset, CivitaiLoraShelfItem, CivitaiLoraSnapshot, ImageReferenceInput, ImageUnderstandingRequest, ImageUnderstandingResult, SecretPartType } from './types';
import { supportsImageToImage, supportsImageUnderstanding } from './provider-capabilities';
import { describeImageWithGeneralLlm, getGeneralLlmInfo, type GeneralLlmInfo } from './llm-understanding';
import type { ImageUnderstandingEngine } from './reference-types';
import { blobToDataUrl } from './utils';
import { prepareCivitaiLora, resolveLoraScope, validateShelfForGeneration } from './civitai-lora';
import { joinPromptFragments } from './style-preset-injection';
import { normalizeSingleCharacterOutput, processTransformerOutput, type SerializationStrategy } from './output-processor';

const VALID_STRATEGIES: ReadonlySet<SerializationStrategy> = new Set([
  'flat', 'nai_character_segments', 'gemini_structured', 'grok_structured', 'sd_danbooru', 'seedream_narrative',
]);

function toSerializationStrategy(raw: string): SerializationStrategy {
  return VALID_STRATEGIES.has(raw as SerializationStrategy)
    ? raw as SerializationStrategy
    : 'nai_character_segments';
}
import { buildDirectCharacterPrompt } from './direct-prompt-builder';
import { getTransformerPresetContext } from './transformer-presets';
import type { TransformerPromptPreset, ModelTransformerBundle, TransformerDefaultsData } from './transformer-presets';
import { ImageStateManager, PLAYER_PSEUDO_NPC_ID } from './image-state-manager';
import type { SceneCompositionMode, GameTime } from './scene-context';
import { buildSceneContext } from './scene-context';
import { eventBus } from '../core/event-bus';

export class ImageService {
  private tokenizer: ImageTokenizer;
  private composer: ImagePromptComposer;
  private cache: ImageAssetCache;
  private queue: ImageTaskQueue;
  /** Centralized state manager for image archive CRUD */
  readonly state: ImageStateManager;
  /** Pack-level transformer defaults for i18n-aware prompt text */
  private _transformerDefaults?: TransformerDefaultsData;

  constructor(
    private stateManager: StateManager,
    private aiService: AIService,
    promptAssembler: PromptAssembler,
    private providerRegistry: ImageProviderRegistry,
    private paths: EnginePathConfig,
  ) {
    this.tokenizer = new ImageTokenizer(aiService, promptAssembler);
    this.composer = new ImagePromptComposer();
    this.cache = new ImageAssetCache();
    this.state = new ImageStateManager(stateManager, paths);
    this.queue = new ImageTaskQueue({
      onPersist: (tasks) => {
        stateManager.set('系统.扩展.image.tasks', tasks, 'system');
        eventBus.emit('engine:request-save');
        // Notify UI to re-render the queue list on ANY queue mutation
        // (create/update/remove/clear). The task queue is an in-memory Map
        // that Vue cannot track, so the panel's computeds rely on the
        // 'image:task-update' tick. Without this, clear/remove buttons had
        // no visible effect until the next generation fired the event.
        // Empty payload → the global toast listener ignores it (no status).
        eventBus.emit('image:task-update', {});
      },
    });

    // Listen for game load events to restore tasks from state tree
    eventBus.on('engine:state-changed', (data) => {
      if (data && typeof data === 'object' && (data as Record<string, unknown>).type === 'load') {
        this.restoreTasksFromState();
      }
    });

    // Global toast for task terminal states — fires regardless of whether
    // ImagePanel is mounted, so the user always gets feedback.
    eventBus.on<{ taskId?: string; status?: string; error?: string }>('image:task-update', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { status, error } = payload as { status?: string; error?: string };
      if (status === 'failed') {
        // error text is provider-specific dynamic content — no i18nKey, message-only intentional
        const msg = error ? `图像生成失败: ${error.slice(0, 120)}` : '图像生成失败';
        eventBus.emit('ui:toast', { type: 'error', message: msg, duration: 5000 });
      } else if (status === 'complete') {
        eventBus.emit('ui:toast', { type: 'success', i18nKey: 'engine.toast.imageGenComplete', message: '图像生成完成', duration: 2000 });
      }
    });
  }

  /** Set pack-level transformer defaults (called once at bootstrap after pack load) */
  setTransformerDefaults(data: TransformerDefaultsData | undefined): void {
    this._transformerDefaults = data;
  }

  /** Get pack-level transformer defaults (for UI to read and pass to getDefaultPresets) */
  getTransformerDefaults(): TransformerDefaultsData | undefined {
    return this._transformerDefaults;
  }

  /** Restore task queue from state tree (called after game load) */
  restoreTasksFromState(): void {
    const savedTasks = this.stateManager.get<ImageTask[]>('系统.扩展.image.tasks');
    // Always restore (even to empty): ImageService is a singleton that survives
    // game loads, so skipping the empty case would leak the previous game's
    // tasks into the newly-loaded save (they'd be re-persisted on the next
    // generation) and leave them showing in the queue tab.
    this.queue.restore(Array.isArray(savedTasks) ? savedTasks : []);
    this.recoverStuckTasks();
    // restore() deliberately does NOT persist (avoids a save-on-load), so it
    // never emits 'image:task-update' on its own. Emit here so a mounted
    // ImagePanel re-renders its queue computeds — otherwise a loaded save whose
    // tasks are all complete/failed (no stuck-task recovery to trigger it)
    // leaves the queue tab stale. Empty payload → global toast listener ignores.
    eventBus.emit('image:task-update', {});
  }

  private recoverStuckTasks(): void {
    const stuckStatuses: Set<string> = new Set(['generating', 'tokenizing', 'pending']);
    let recovered = 0;
    for (const task of this.queue.getAll()) {
      if (stuckStatuses.has(task.status)) {
        this.queue.updateStatus(task.id, 'failed', {
          error: '任务因页面刷新中断，请重试',
        });
        recovered++;
      }
    }
    if (recovered > 0) {
      console.warn(`[ImageService] Recovered ${recovered} stuck task(s) after reload`);
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'engine.toast.imageTasksRecovered',
        i18nParams: { count: recovered },
        message: `${recovered} 个图像生成任务因页面刷新中断`,
        duration: 4000,
      });
    }
  }

  private get enabled(): boolean {
    return this.stateManager.get<boolean>('系统.扩展.image.enabled') === true;
  }

  /**
   * Collect present NPCs and their scene-linked anchors for scene generation.
   * Returns `presentNpcs` (names) and `roleAnchors` (enabled + sceneLink anchors).
   */
  collectSceneRoleAnchors(): { presentNpcs: string[]; roleAnchors: Array<{ name: string; positive: string }> } {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return { presentNpcs: [], roleAnchors: [] };

    const nameKey = this.paths.npcFieldNames?.name ?? '名称';
    const presenceKey = this.paths.npcFieldNames?.isPresent ?? '是否在场';
    const presentNames = list
      .filter((n) => n[presenceKey] === true)
      .map((n) => String(n[nameKey] ?? ''))
      .filter(Boolean);

    if (presentNames.length === 0) return { presentNpcs: [], roleAnchors: [] };

    const anchors = this.stateManager.get<Array<Record<string, unknown>>>('系统.扩展.image.characterAnchors');
    if (!Array.isArray(anchors) || anchors.length === 0) return { presentNpcs: presentNames, roleAnchors: [] };

    const roleAnchors: Array<{ name: string; positive: string }> = [];
    for (const name of presentNames) {
      const anchor = anchors.find(
        (a) => a.npcName === name && a.enabled === true && a.sceneLink === true,
      );
      if (anchor && typeof anchor.positive === 'string' && anchor.positive.trim()) {
        roleAnchors.push({ name, positive: anchor.positive as string });
      }
    }

    return { presentNpcs: presentNames, roleAnchors };
  }

  /**
   * Look up the current image-gen API config's model name so archive records
   * can display which backend + model actually produced the image. Returns an
   * empty string if no config is bound — UI shows '未记录' in that case.
   */
  private getCurrentModelName(backend?: string): string {
    const config = backend
      ? this.aiService.getImageConfigForBackend(backend)
      : this.aiService.getConfigForUsage('imageGeneration');
    return config?.model ?? '';
  }

  private getCurrentApiConfigName(backend?: string): string {
    const config = backend
      ? this.aiService.getImageConfigForBackend(backend)
      : this.aiService.getConfigForUsage('imageGeneration');
    return config?.name ?? '';
  }

  /**
   * Resolve user-customized transformer presets from state tree.
   * Falls back to engine defaults if state tree has no custom presets.
   */
  private getCustomPresetOptions(): {
    customPresets?: TransformerPromptPreset[];
    customBundles?: ModelTransformerBundle[];
    transformerDefaults?: TransformerDefaultsData;
  } {
    const ruleTemplates = this.stateManager.get<Array<Record<string, unknown>>>('系统.扩展.image.ruleTemplates');
    const modelRulesets = this.stateManager.get<Array<Record<string, unknown>>>('系统.扩展.image.modelRulesets');

    const options: {
      customPresets?: TransformerPromptPreset[];
      customBundles?: ModelTransformerBundle[];
      transformerDefaults?: TransformerDefaultsData;
    } = {};

    // Pass pack-level transformer defaults for i18n-aware fallback text
    if (this._transformerDefaults) {
      options.transformerDefaults = this._transformerDefaults;
    }

    if (Array.isArray(ruleTemplates) && ruleTemplates.length > 0) {
      const scopeMap: Record<string, string> = { npc: 'npc', scene: 'scene', judge: 'scene_judge' };
      options.customPresets = ruleTemplates.map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        scope: (scopeMap[String(r.scope ?? '')] ?? 'npc') as 'npc' | 'scene' | 'scene_judge',
        prompt: String(r.baseRule ?? ''),
        anchorModePrompt: String(r.anchorRule ?? ''),
        sceneAnchorModePrompt: String(r.scope) === 'scene' ? String(r.anchorRule ?? '') : undefined,
        noAnchorFallbackPrompt: String(r.noAnchorFallback ?? ''),
        outputFormatPrompt: String(r.outputFormat ?? ''),
      }));
    }

    if (Array.isArray(modelRulesets) && modelRulesets.length > 0) {
      options.customBundles = modelRulesets.map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        enabled: r.enabled === true,
        modelPrompt: String(r.baseModelRule ?? ''),
        anchorModeModelPrompt: String(r.anchorModeModelRule ?? ''),
        serializationStrategy: toSerializationStrategy(String(r.serializationStrategy || '')),
        npcPresetId: String(r.npcTemplateId ?? ''),
        scenePresetId: String(r.sceneTemplateId ?? ''),
        sceneJudgePresetId: String(r.judgeTemplateId ?? ''),
      }));
    }

    return options;
  }

  /**
   * Generate a scene image from the current narrative context.
   */
  async generateSceneImage(params: {
    sceneDescription: string;
    location?: string;
    gameTime?: GameTime | null;
    weather?: string;
    /**
     * Festival from `世界.节日` — `{名称,描述,效果}` (P3 env-tags port 2026-04-19).
     * Passed through to tokenizer as `{{FESTIVAL_NAME}}`.
     */
    festival?: unknown;
    /**
     * Environment tag array from `世界.环境` (P3 env-tags port 2026-04-19).
     * Passed through to tokenizer as `{{ENVIRONMENT_TAGS}}`.
     */
    environment?: unknown;
    presentNpcs?: string[];
    npcDetails?: Array<{ name: string; appearance?: string; bodyDescription?: string; outfitStyle?: string; description?: string }>;
    compositionMode?: SceneCompositionMode;
    extraRequirements?: string;
    roleAnchors?: Array<{ name: string; positive: string }>;
    preset?: StylePreset;
    artistPrefix?: string;
    extraNegative?: string;
    backend: ImageBackendType;
    reference?: ImageReferenceInput;
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    const task = this.queue.create({
      subjectType: 'scene',
      width: params.preset?.width ?? 1024,
      height: params.preset?.height ?? 576,
      backend: params.backend,
      presetId: params.preset?.id,
    });

    try {
      this.queue.updateStatus(task.id, 'tokenizing');
      eventBus.emit('image:task-update', { taskId: task.id, status: 'tokenizing' });

      const isNovelAI = params.backend === 'novelai';
      const hasAnchors = (params.roleAnchors?.length ?? 0) > 0;
      const presetContext = getTransformerPresetContext(
        'scene',
        hasAnchors ? 'anchor' : 'default',
        this.getCustomPresetOptions(),
      );

      const sceneContext = buildSceneContext({
        narrativeText: params.sceneDescription,
        locationPath: params.location ?? '',
        gameTime: params.gameTime,
        weather: params.weather,
        festival: params.festival,
        environment: params.environment,
        presentNpcs: params.presentNpcs,
        npcDetails: params.npcDetails,
        compositionMode: params.compositionMode,
        extraRequirements: params.extraRequirements,
      });

      const tokenResult = await this.tokenizer.tokenizeScene({
        sceneContext,
        presetContext,
        roleAnchors: params.roleAnchors,
        isNovelAI,
      });

      // Process through output processor with serialization strategy
      const processedPositive = processTransformerOutput(tokenResult.rawResponse, {
        strategy: presetContext.serializationStrategy,
        isNovelAI,
      });

      const composedRaw = this.composer.compose({
        subjectTokens: processedPositive ? [processedPositive] : tokenResult.tokens,
        subjectNegative: tokenResult.negative,
        composition: 'scene',
        artistPrefix: joinPromptFragments([
          params.preset?.positivePrefix,
          params.artistPrefix,
          params.preset?.positiveSuffix,
        ]),
        extraNegative: joinPromptFragments([params.preset?.negative, params.extraNegative]),
        width: params.preset?.width,
        height: params.preset?.height,
      });

      // Civitai LoRA preparation (no-op for non-civitai)
      let composed = composedRaw;
      let civitaiProviderParams: Record<string, unknown> | undefined;
      let loraSnapshot: CivitaiLoraSnapshot | undefined;
      if (params.backend === 'civitai') {
        const prep = this.prepareCivitaiRequest(composedRaw, 'scene');
        composed = prep.composed;
        civitaiProviderParams = prep.providerParams;
        loraSnapshot = prep.snapshot;
      }

      const refMeta = params.reference ? {
        reference: { mode: 'image_to_image' as const, sourceAssetId: params.reference.assetId, denoiseStrength: params.reference.denoiseStrength, provider: params.backend },
      } : {};
      this.queue.updateStatus(task.id, 'generating', {
        positivePrompt: composed.positive,
        negativePrompt: composed.negative,
        providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
      });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'generating' });

      const blob = await this.callProvider(params.backend, composed, civitaiProviderParams, params.reference, params.styleParamOverrides);
      const asset = await this.storeAsset(task, blob, params.backend);

      this.queue.updateStatus(task.id, 'complete', { resultAssetId: asset.id });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'complete', assetId: asset.id });

      this.writeToSceneArchive(asset.id, this.queue.get(task.id)!);

      return this.queue.get(task.id)!;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.queue.updateStatus(task.id, 'failed', { error: msg });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'failed', error: msg });
      return this.queue.get(task.id)!;
    }
  }

  /**
   * Generate a character portrait using an anchor for consistency.
   * On success, also writes result to NPC's archive in state tree for Gallery browsing.
   */
  async generateCharacterImage(params: {
    characterName: string;
    description: string;
    appearance?: string;
    bodyDescription?: string;
    outfitStyle?: string;
    outfit?: string;
    anchor?: CharacterAnchor;
    preset?: StylePreset;
    backend: ImageBackendType;
    composition?: 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom';
    customComposition?: string;
    artStyle?: string;
    extraPrompt?: string;
    anchorPositive?: string;
    anchorNegative?: string;
    anchorStructuredFeatures?: import('./types').AnchorStructuredFeatures;
    artistPrefix?: string;
    extraNegative?: string;
    npcDataJson?: string;
    /** When false, bypass AI transformer and build prompt directly from NPC data.
     *  Default: true. Forced true for NovelAI backend.
     *  FRONTEND TODO: Settings tab "使用词组转化器" toggle (Phase 7) */
    useTransformer?: boolean;
    reference?: ImageReferenceInput;
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    // Concurrent generation lock (NPC生图进行中集合)
    const lockKey = params.characterName;
    if (this.state.isGenerating(lockKey)) {
      throw new Error(`[ImageService] Already generating for "${params.characterName}"`);
    }
    this.state.lockGeneration(lockKey);

    const task = this.queue.create({
      subjectType: 'character',
      targetCharacter: params.characterName,
      anchorId: params.anchor?.id,
      width: params.preset?.width ?? 832,
      height: params.preset?.height ?? 1216,
      backend: params.backend,
      presetId: params.preset?.id,
    });

    try {
      this.queue.updateStatus(task.id, 'tokenizing');
      eventBus.emit('image:task-update', { taskId: task.id, status: 'tokenizing' });

      const isNovelAI = params.backend === 'novelai';
      // NovelAI always uses transformer (forced ON)
      const shouldUseTransformer = isNovelAI || params.useTransformer !== false;
      const npcDataJson = params.npcDataJson ?? JSON.stringify({
        姓名: params.characterName,
        描述: params.description,
        外貌描述: params.appearance,
        身材描写: params.bodyDescription,
        衣着风格: params.outfitStyle ?? params.outfit,
        // Field aliases — direct-prompt-builder reads '外貌' / '身材' / '衣着'; duplicate keys ensure both direct and transformer mode see full data.
        外貌: params.appearance,
        身材: params.bodyDescription,
        衣着: params.outfitStyle ?? params.outfit,
      }, null, 2);

      let processedPositive: string;
      let negativeTokens: string[] | undefined;

      if (shouldUseTransformer) {
        // Resolve transformer preset based on scope + anchor mode
        const hasAnchor = Boolean(params.anchorPositive?.trim());
        const presetContext = getTransformerPresetContext('npc', hasAnchor ? 'anchor' : 'default', this.getCustomPresetOptions());

        const tokenResult = await this.tokenizer.tokenizeCharacter({
          characterName: params.characterName,
          npcDataJson,
          composition: params.composition,
          customComposition: params.customComposition,
          artStyle: params.artStyle,
          anchor: params.anchorPositive
            ? { positive: params.anchorPositive, negative: params.anchorNegative, structuredFeatures: params.anchorStructuredFeatures }
            : undefined,
          extraRequirements: params.extraPrompt,
          presetContext,
        });
        processedPositive = normalizeSingleCharacterOutput(tokenResult.rawResponse, { isNovelAI });
        negativeTokens = tokenResult.negative;
      } else {
        // Direct mode: bypass AI, build prompt from NPC data fields
        const directResult = buildDirectCharacterPrompt(npcDataJson, {
          composition: params.composition,
          artStyle: params.artStyle,
          extraRequirements: params.extraPrompt,
          isNovelAI,
        });
        processedPositive = directResult.prompt;
        negativeTokens = undefined;
      }

      const composedRaw = this.composer.compose({
        subjectTokens: processedPositive ? [processedPositive] : [],
        subjectNegative: negativeTokens,
        composition: params.composition ?? 'portrait',
        artistPrefix: joinPromptFragments([
          params.preset?.positivePrefix,
          params.artistPrefix,
          params.preset?.positiveSuffix,
        ]),
        width: params.preset?.width,
        height: params.preset?.height,
        extraNegative: joinPromptFragments([
          params.preset?.negative,
          params.anchorNegative,
          params.extraNegative,
        ]),
      });

      // Civitai LoRA preparation (no-op for non-civitai)
      let composed = composedRaw;
      let civitaiProviderParams: Record<string, unknown> | undefined;
      let loraSnapshot: CivitaiLoraSnapshot | undefined;
      if (params.backend === 'civitai') {
        const prep = this.prepareCivitaiRequest(composedRaw, 'character', params.characterName);
        composed = prep.composed;
        civitaiProviderParams = prep.providerParams;
        loraSnapshot = prep.snapshot;
      }

      const refMeta = params.reference ? {
        reference: { mode: 'image_to_image' as const, sourceAssetId: params.reference.assetId, denoiseStrength: params.reference.denoiseStrength, provider: params.backend },
      } : {};
      this.queue.updateStatus(task.id, 'generating', {
        positivePrompt: composed.positive,
        negativePrompt: composed.negative,
        providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
      });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'generating' });

      const blob = await this.callProvider(params.backend, composed, civitaiProviderParams, params.reference, params.styleParamOverrides);
      const asset = await this.storeAsset(task, blob, params.backend);

      this.queue.updateStatus(task.id, 'complete', { resultAssetId: asset.id });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'complete', assetId: asset.id });

      if (params.characterName) {
        const trimmed = this.state.writeNpcImageRecord(params.characterName, {
          id: asset.id,
          taskId: task.id,
          composition: params.composition ?? 'portrait',
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: composed.width,
          height: composed.height,
          backend: params.backend,
          model: this.getCurrentModelName(params.backend),
          apiConfigName: this.getCurrentApiConfigName(params.backend),
          artStyle: params.artStyle,
          createdAt: Date.now(),
          providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
        });
        this.deleteTrimmedAssets(trimmed);
      }

      return this.queue.get(task.id)!;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.queue.updateStatus(task.id, 'failed', { error: msg });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'failed', error: msg });
      return this.queue.get(task.id)!;
    } finally {
      this.state.unlockGeneration(lockKey);
    }
  }

  /**
   * Generate a secret part close-up image (NSFW).
   * Secret part image generation — ported
   */
  async generateSecretPartImage(params: {
    characterName: string;
    part: import('./types').SecretPartType;
    /**
     * Description of the target body part. Optional — if omitted, the service
     * looks up the NPC's `私密信息.身体部位` array and extracts the `特征描述`
     * for the matching `部位名称` (via SECRET_PART_TO_CN_NAME).
     */
    partDescription?: string;
    npcDataJson?: string;
    anchorPositive?: string;
    anchorNegative?: string;
    anchorStructuredFeatures?: import('./types').AnchorStructuredFeatures;
    preset?: StylePreset;
    artistPrefix?: string;
    extraNegative?: string;
    extraPrompt?: string;
    /** Overall art style label (画风 grid: 通用/动漫/写实/古风). Omitted = no style line. */
    artStyle?: string;
    backend: ImageBackendType;
    reference?: ImageReferenceInput;
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    // Composite lock key: NPC::part
    const lockKey = `${params.characterName}::${params.part}`;
    if (this.state.isGenerating(lockKey)) {
      throw new Error(`[ImageService] Already generating "${params.part}" for "${params.characterName}"`);
    }
    this.state.lockGeneration(lockKey);

    const task = this.queue.create({
      subjectType: 'secret_part',
      targetCharacter: params.characterName,
      part: params.part,
      width: params.preset?.width ?? 1024,
      height: params.preset?.height ?? 1024,
      backend: params.backend,
      presetId: params.preset?.id,
    });

    try {
      this.queue.updateStatus(task.id, 'tokenizing');
      eventBus.emit('image:task-update', { taskId: task.id, status: 'tokenizing' });

      const isNovelAI = params.backend === 'novelai';

      const resolvedEntry = this.resolveSecretPartEntry(params.characterName, params.part);
      const resolvedDescription = params.partDescription
        ?? (resolvedEntry ? (String(resolvedEntry['特征描述'] ?? '') || '') : '');

      const resolvedBodyDesc = this.resolveBodyDescription(params.characterName, params.part);

      // Secret-part flow historically runs WITHOUT the model-bundle system
      // prompt — preserved byte-identical for every legacy strategy. Only the
      // Doubao narrative ruleset wires the preset context through, so its
      // Chinese-narrative doctrine reaches this flow too (review Important
      // 2026-08-27: the hardcoded English mandates here escaped the ruleset).
      const secretPresetContext = getTransformerPresetContext(
        'npc',
        params.anchorPositive ? 'anchor' : 'default',
        this.getCustomPresetOptions(),
      );

      const tokenResult = await this.tokenizer.tokenizeSecretPart({
        characterName: params.characterName,
        part: params.part,
        partDescription: resolvedDescription,
        bodyPartEntry: resolvedEntry,
        bodyDescription: resolvedBodyDesc,
        npcDataJson: params.npcDataJson,
        anchor: params.anchorPositive
          ? { positive: params.anchorPositive, negative: params.anchorNegative, structuredFeatures: params.anchorStructuredFeatures }
          : undefined,
        isNovelAI,
        extraRequirements: params.extraPrompt,
        artStyle: params.artStyle,
        presetContext: secretPresetContext.serializationStrategy === 'seedream_narrative'
          ? secretPresetContext
          : undefined,
      });

      const processedPositive = normalizeSingleCharacterOutput(tokenResult.rawResponse, { isNovelAI });

      const composedRaw = this.composer.compose({
        subjectTokens: processedPositive ? [processedPositive] : tokenResult.tokens,
        subjectNegative: tokenResult.negative,
        composition: 'secret_part',
        artistPrefix: joinPromptFragments([
          params.preset?.positivePrefix,
          params.artistPrefix,
          params.preset?.positiveSuffix,
        ]),
        extraNegative: joinPromptFragments([
          params.preset?.negative,
          params.anchorNegative,
          params.extraNegative,
        ]),
        width: params.preset?.width,
        height: params.preset?.height,
      });

      // Civitai LoRA preparation (no-op for non-civitai)
      let composed = composedRaw;
      let civitaiProviderParams: Record<string, unknown> | undefined;
      let loraSnapshot: CivitaiLoraSnapshot | undefined;
      if (params.backend === 'civitai') {
        const prep = this.prepareCivitaiRequest(composedRaw, 'secret_part', params.characterName);
        composed = prep.composed;
        civitaiProviderParams = prep.providerParams;
        loraSnapshot = prep.snapshot;
      }

      const refMeta = params.reference ? {
        reference: { mode: 'image_to_image' as const, sourceAssetId: params.reference.assetId, denoiseStrength: params.reference.denoiseStrength, provider: params.backend },
      } : {};
      this.queue.updateStatus(task.id, 'generating', {
        positivePrompt: composed.positive,
        negativePrompt: composed.negative,
        providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
      });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'generating' });

      const blob = await this.callProvider(params.backend, composed, civitaiProviderParams, params.reference, params.styleParamOverrides);
      const asset = await this.storeAsset(task, blob, params.backend);

      this.queue.updateStatus(task.id, 'complete', { resultAssetId: asset.id });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'complete', assetId: asset.id });

      // Store result in both the secret archive AND the general history so
      // 图库/历史 tabs see the entry alongside portrait/full-body images.
      // Without the writeNpcImageRecord call, secret-part images live only in
      // 图片档案.香闺秘档 and are invisible to gallery which reads 生图历史.
      if (params.characterName) {
        const createdAt = Date.now();
        const modelName = this.getCurrentModelName(params.backend);
        const apiName = this.getCurrentApiConfigName(params.backend);
        const archiveMeta = { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta };
        const metaSpread = Object.keys(archiveMeta).length > 0 ? { providerMeta: archiveMeta } : {};

        // Delete previous secret-part blob before overwriting the archive entry
        const prevSecret = this.state.getSecretPartResult(params.characterName, params.part);
        const prevSecretId = typeof prevSecret?.id === 'string' ? prevSecret.id : '';
        if (prevSecretId && prevSecretId !== asset.id) {
          void this.cache.delete(prevSecretId).catch(() => {/* best effort */});
        }

        this.state.setSecretPartResult(params.characterName, params.part, {
          id: asset.id,
          taskId: task.id,
          part: params.part,
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: composed.width,
          height: composed.height,
          backend: params.backend,
          model: modelName,
          apiConfigName: apiName,
          createdAt,
          ...metaSpread,
        });
        const trimmed = this.state.writeNpcImageRecord(params.characterName, {
          id: asset.id,
          taskId: task.id,
          composition: 'secret_part',
          part: params.part,
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: composed.width,
          height: composed.height,
          backend: params.backend,
          model: modelName,
          apiConfigName: apiName,
          artStyle: params.artStyle,
          createdAt,
          ...metaSpread,
        });
        this.deleteTrimmedAssets(trimmed);
      }

      return this.queue.get(task.id)!;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.queue.updateStatus(task.id, 'failed', { error: msg });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'failed', error: msg });
      return this.queue.get(task.id)!;
    } finally {
      this.state.unlockGeneration(lockKey);
    }
  }

  getTaskQueue(): ImageTaskQueue { return this.queue; }
  getAssetCache(): ImageAssetCache { return this.cache; }

  // getReferenceConfig() 已随 WD 拆除删去（review 2026-08-27）：唯一消费点是旧提炼
  // 参数读取；UI 现直接走 get('系统.扩展.image.config.reference.*')，零消费方法不保留。

  /**
   * Regenerate an image using already-composed positive + negative prompts,
   * bypassing tokenizer and composer entirely. The prompts are passed through
   * unchanged to the backend provider. Supports cross-backend regeneration —
   * callers can pass any backend regardless of where the prompts originated.
   *
   * Results are written to the same archives as the originating flow:
   * - subjectType === 'scene' → sceneArchive 生图历史
   * - subjectType === 'character' → NPC / player 图片档案.生图历史
   * - subjectType === 'secret_part' → both 香闺秘档 and 生图历史
   *
   * Each stored record includes width/height/backend/prompts so subsequent
   * regenerations can chain (image → regen → regen → ...).
   */
  async regenerateFromPrompts(params: {
    positivePrompt: string;
    negativePrompt: string;
    width: number;
    height: number;
    backend: ImageBackendType;
    subjectType: import('./types').ImageSubjectType;
    /** Required for character + secret_part */
    targetCharacter?: string;
    /** Character composition (portrait/half-body/full-length/custom). Ignored for scene + secret_part. */
    composition?: 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom';
    /** Secret-part sub-type. Required when subjectType === 'secret_part'. */
    part?: import('./types').SecretPartType;
    /** Optional metadata passthrough for audit/display */
    artStyle?: string;
    reference?: ImageReferenceInput;
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    if ((params.subjectType === 'character' || params.subjectType === 'secret_part') && !params.targetCharacter) {
      throw new Error('[ImageService] regenerateFromPrompts requires targetCharacter for character/secret_part subjects');
    }
    if (params.subjectType === 'secret_part' && !params.part) {
      throw new Error('[ImageService] regenerateFromPrompts requires part for secret_part subject');
    }

    // Concurrent-generation lock — mirror the original flows so the same NPC/part
    // can't be regenerated in parallel and collide with an in-flight generation.
    const lockKey = params.subjectType === 'secret_part'
      ? `${params.targetCharacter}::${params.part}`
      : (params.targetCharacter ?? `scene::${Date.now()}`);
    if (params.subjectType !== 'scene' && this.state.isGenerating(lockKey)) {
      throw new Error(`[ImageService] Already generating "${lockKey}"`);
    }
    if (params.subjectType !== 'scene') this.state.lockGeneration(lockKey);

    const task = this.queue.create({
      subjectType: params.subjectType,
      targetCharacter: params.targetCharacter,
      part: params.part,
      width: params.width,
      height: params.height,
      backend: params.backend,
    });

    try {
      const composedRaw = {
        positive: params.positivePrompt,
        negative: params.negativePrompt,
        width: params.width,
        height: params.height,
      };

      // Civitai LoRA preparation (no-op for non-civitai)
      let composed = composedRaw;
      let civitaiProviderParams: Record<string, unknown> | undefined;
      let loraSnapshot: CivitaiLoraSnapshot | undefined;
      if (params.backend === 'civitai') {
        const prep = this.prepareCivitaiRequest(composedRaw, params.subjectType, params.targetCharacter);
        composed = prep.composed;
        civitaiProviderParams = prep.providerParams;
        loraSnapshot = prep.snapshot;
      }

      const refMeta = params.reference ? {
        reference: { mode: 'image_to_image' as const, sourceAssetId: params.reference.assetId, denoiseStrength: params.reference.denoiseStrength, provider: params.backend },
      } : {};
      this.queue.updateStatus(task.id, 'generating', {
        positivePrompt: composed.positive,
        negativePrompt: composed.negative,
        providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
      });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'generating' });

      const blob = await this.callProvider(params.backend, composed, civitaiProviderParams, params.reference, params.styleParamOverrides);
      const asset = await this.storeAsset(task, blob, params.backend);

      this.queue.updateStatus(task.id, 'complete', { resultAssetId: asset.id });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'complete', assetId: asset.id });

      const createdAt = Date.now();
      const modelName = this.getCurrentModelName(params.backend);
      const apiName = this.getCurrentApiConfigName(params.backend);
      const archiveMeta = { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta };
      const metaSpread = Object.keys(archiveMeta).length > 0 ? { providerMeta: archiveMeta } : {};
      if (params.subjectType === 'scene') {
        this.writeToSceneArchive(asset.id, this.queue.get(task.id)!);
      } else if (params.subjectType === 'secret_part' && params.targetCharacter && params.part) {
        const prevSecret = this.state.getSecretPartResult(params.targetCharacter, params.part);
        const prevSecretId = typeof prevSecret?.id === 'string' ? prevSecret.id : '';
        if (prevSecretId && prevSecretId !== asset.id) {
          void this.cache.delete(prevSecretId).catch(() => {/* best effort */});
        }
        this.state.setSecretPartResult(params.targetCharacter, params.part, {
          id: asset.id,
          taskId: task.id,
          part: params.part,
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: params.width,
          height: params.height,
          backend: params.backend,
          model: modelName,
          apiConfigName: apiName,
          createdAt,
          ...metaSpread,
        });
        const trimmed2 = this.state.writeNpcImageRecord(params.targetCharacter, {
          id: asset.id,
          taskId: task.id,
          composition: 'secret_part',
          part: params.part,
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: params.width,
          height: params.height,
          backend: params.backend,
          model: modelName,
          apiConfigName: apiName,
          createdAt,
          ...metaSpread,
        });
        this.deleteTrimmedAssets(trimmed2);
      } else if (params.subjectType === 'character' && params.targetCharacter) {
        const trimmed3 = this.state.writeNpcImageRecord(params.targetCharacter, {
          id: asset.id,
          taskId: task.id,
          composition: params.composition ?? 'portrait',
          status: 'complete',
          positivePrompt: composed.positive,
          negativePrompt: composed.negative,
          width: params.width,
          height: params.height,
          backend: params.backend,
          model: modelName,
          apiConfigName: apiName,
          artStyle: params.artStyle,
          createdAt,
          ...metaSpread,
        });
        this.deleteTrimmedAssets(trimmed3);
      }

      return this.queue.get(task.id)!;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.queue.updateStatus(task.id, 'failed', { error: msg });
      eventBus.emit('image:task-update', { taskId: task.id, status: 'failed', error: msg });
      return this.queue.get(task.id)!;
    } finally {
      if (params.subjectType !== 'scene') this.state.unlockGeneration(lockKey);
    }
  }

  /**
   * Look up a secret-part description from the NPC's `私密信息.身体部位` array.
   *
   * Maps engine `SecretPartType` → Chinese `部位名称` (the schema-level key):
   * breast → 胸部, vagina → 小穴, anus → 屁穴. `嘴` has no secret-part type
   * and is covered by the character portrait flow.
   *
   * Returns undefined if NPC not found / body-parts missing / part not listed.
   * Callers fall back to their own string when this returns undefined.
   */
  /**
   * Resolve the full body-part entry from 身体部位[] for a given part.
   * Returns the raw entry object with 特征描述, 特殊印记, 敏感度, 开发度, etc.
   */
  private resolveSecretPartEntry(
    characterName: string,
    part: import('./types').SecretPartType,
  ): Record<string, unknown> | undefined {
    const PART_TO_CN: Record<import('./types').SecretPartType, string> = {
      breast: '胸部',
      vagina: '小穴',
      anus: '屁穴',
    };
    const targetName = PART_TO_CN[part];
    if (!targetName) return undefined;

    if (characterName === PLAYER_PSEUDO_NPC_ID) {
      const bodyData = this.stateManager.get<Record<string, unknown>>('角色.身体');
      if (!bodyData || typeof bodyData !== 'object') return undefined;
      const parts = (bodyData as Record<string, unknown>)['身体部位'];
      if (!Array.isArray(parts)) return undefined;
      return parts.find(
        (p) => p && typeof p === 'object' && (p as Record<string, unknown>)['部位名称'] === targetName,
      ) as Record<string, unknown> | undefined;
    }

    const relationships = this.stateManager.get<Array<Record<string, unknown>>>(
      this.paths.relationships,
    );
    if (!Array.isArray(relationships)) return undefined;

    const npc = relationships.find(
      (r) => r && typeof r === 'object' && r[this.paths.npcFieldNames.name] === characterName,
    );
    if (!npc) return undefined;

    const privacy = npc[this.paths.npcFieldNames.privacyProfile];
    if (!privacy || typeof privacy !== 'object') return undefined;

    const parts = (privacy as Record<string, unknown>)['身体部位'];
    if (!Array.isArray(parts)) return undefined;

    return parts.find(
      (p) => p && typeof p === 'object' && (p as Record<string, unknown>)['部位名称'] === targetName,
    ) as Record<string, unknown> | undefined;
  }

  /**
   * Resolve the broader body description for a character (not per-part feature desc).
   * - Player: reads top-level fields from 角色.身体 (胸部描述/私处描述/生殖器描述)
   * - NPC: reads 身材描写 from the relationship record
   */
  private resolveBodyDescription(
    characterName: string,
    part: import('./types').SecretPartType,
  ): string | undefined {
    if (characterName === PLAYER_PSEUDO_NPC_ID) {
      const bodyData = this.stateManager.get<Record<string, unknown>>('角色.身体');
      if (!bodyData || typeof bodyData !== 'object') return undefined;
      const fields: string[] = [];
      if (part === 'breast') {
        const v = (bodyData as Record<string, unknown>)['胸部描述'];
        if (typeof v === 'string' && v.trim()) fields.push(v.trim());
      } else {
        const priv = (bodyData as Record<string, unknown>)['私处描述'];
        if (typeof priv === 'string' && priv.trim()) fields.push(priv.trim());
        if (part === 'vagina') {
          const gen = (bodyData as Record<string, unknown>)['生殖器描述'];
          if (typeof gen === 'string' && gen.trim()) fields.push(gen.trim());
        }
      }
      return fields.length > 0 ? fields.join('；') : undefined;
    }

    const relationships = this.stateManager.get<Array<Record<string, unknown>>>(
      this.paths.relationships,
    );
    if (!Array.isArray(relationships)) return undefined;
    const npc = relationships.find(
      (r) => r && typeof r === 'object' && r[this.paths.npcFieldNames.name] === characterName,
    );
    if (!npc) return undefined;
    const bodyDesc = npc[this.paths.npcFieldNames.bodyDescription];
    return typeof bodyDesc === 'string' && bodyDesc.trim() ? bodyDesc.trim() : undefined;
  }

  // ── Legacy delegations to ImageStateManager ──
  // These preserve the existing API surface while delegating to the centralized state manager.

  setNpcAvatar(npcName: string, assetId: string): void { this.state.setNpcAvatar(npcName, assetId); }
  setNpcPortrait(npcName: string, assetId: string): void { this.state.setNpcPortrait(npcName, assetId); }
  setNpcBackground(npcName: string, assetId: string): void { this.state.setNpcBackground(npcName, assetId); }
  clearNpcAvatar(npcName: string): void { this.state.clearNpcAvatar(npcName); }
  clearNpcPortrait(npcName: string): void { this.state.clearNpcPortrait(npcName); }
  clearNpcBackground(npcName: string): void { this.state.clearNpcBackground(npcName); }

  setNpcSecretPart(npcName: string, part: SecretPartType, assetId: string): void {
    const prevResult = this.state.getSecretPartResult(npcName, part);
    const prevId = typeof prevResult?.id === 'string' ? prevResult.id : '';
    if (prevId && prevId !== assetId) {
      void this.cache.delete(prevId).catch(() => {/* best effort */});
    }
    this.state.setSecretPartResult(npcName, part, { id: assetId, status: 'complete', part, createdAt: Date.now() });
  }

  clearNpcSecretPart(npcName: string, part: SecretPartType): void {
    const prevResult = this.state.getSecretPartResult(npcName, part);
    const prevId = typeof prevResult?.id === 'string' ? prevResult.id : '';
    this.state.clearSecretPartResult(npcName, part);
    if (prevId) void this.cache.delete(prevId).catch(() => {/* best effort */});
  }

  deleteNpcImage(npcName: string, imageId: string): void {
    this.state.deleteNpcImage(npcName, imageId);
    if (imageId) void this.cache.delete(imageId).catch(() => {/* best effort */});
  }

  clearNpcHistory(npcName: string): void {
    const history = this.state.getNpcImageHistory(npcName);
    const idsToDelete = new Set(history.map((r) => String(r.id ?? '')).filter(Boolean));
    const archive = this.state.getNpcArchive(npcName);
    if (archive) {
      for (const f of ['已选头像图片ID', '已选立绘图片ID', '已选背景图片ID']) {
        const v = String(archive[f] ?? '').trim();
        if (v) idsToDelete.add(v);
      }
      const secretArchive = archive['香闺秘档'] as Record<string, unknown> | undefined;
      if (secretArchive) {
        for (const partKey of ['胸部', '小穴', '屁穴']) {
          const entry = secretArchive[partKey] as Record<string, unknown> | undefined;
          const id = typeof entry?.id === 'string' ? entry.id : '';
          if (id) idsToDelete.add(id);
        }
      }
    }
    this.state.clearNpcHistory(npcName);
    for (const id of idsToDelete) {
      void this.cache.delete(id).catch(() => {/* best effort */});
    }
  }

  private deleteTrimmedAssets(ids: string[]): void {
    for (const id of ids) {
      void this.cache.delete(id).catch(() => {/* best effort */});
    }
  }

  /**
   * Remove IndexedDB blobs not referenced by any state-tree entry.
   * Safe to call on demand (e.g. from settings UI) — reads all cached
   * asset metadata, diffs against referenced IDs from the state tree,
   * and deletes the difference.
   */
  async pruneOrphanedAssets(): Promise<{ deleted: number; freedIds: string[] }> {
    const allAssets = await this.cache.listAll();
    const allCachedIds = new Set(allAssets.map((a) => a.id));
    if (allCachedIds.size === 0) return { deleted: 0, freedIds: [] };

    const referencedIds = this.collectAllReferencedAssetIds();
    const orphanIds: string[] = [];
    for (const id of allCachedIds) {
      if (!referencedIds.has(id)) orphanIds.push(id);
    }
    for (const id of orphanIds) {
      void this.cache.delete(id).catch(() => {/* best effort */});
    }
    if (orphanIds.length > 0) {
      console.info(`[ImageService] Pruned ${orphanIds.length} orphaned asset(s) from cache`);
    }
    return { deleted: orphanIds.length, freedIds: orphanIds };
  }

  private collectAllReferencedAssetIds(): Set<string> {
    const ids = new Set<string>();
    const addIfValid = (val: unknown) => {
      if (typeof val === 'string' && val.trim()) ids.add(val.trim());
    };
    const SELECTION_FIELDS = ['已选头像图片ID', '已选立绘图片ID', '已选背景图片ID'];
    const extractFromArchive = (archive: unknown) => {
      if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return;
      const a = archive as Record<string, unknown>;
      for (const f of SELECTION_FIELDS) addIfValid(a[f]);
      addIfValid(a['最近生图结果']);
      const history = a['生图历史'];
      if (Array.isArray(history)) {
        for (const entry of history) {
          if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
        }
      }
      const secret = a['香闺秘档'];
      if (secret && typeof secret === 'object') {
        for (const part of Object.values(secret as Record<string, unknown>)) {
          if (part && typeof part === 'object') {
            addIfValid((part as Record<string, unknown>).id);
            addIfValid((part as Record<string, unknown>).assetId);
          }
        }
      }
    };

    // Player archive
    const playerArchive = this.stateManager.get<Record<string, unknown>>('角色.图片档案');
    extractFromArchive(playerArchive);

    // NPC archives
    const relationships = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (Array.isArray(relationships)) {
      for (const npc of relationships) {
        if (npc && typeof npc === 'object') extractFromArchive(npc['图片档案']);
      }
    }

    // Scene archive
    const sceneArchive = this.stateManager.get<Record<string, unknown>>('系统.扩展.image.sceneArchive');
    if (sceneArchive && typeof sceneArchive === 'object') {
      addIfValid(sceneArchive['当前壁纸图片ID']);
      addIfValid(sceneArchive['最近生图结果']);
      const sceneHistory = sceneArchive['生图历史'];
      if (Array.isArray(sceneHistory)) {
        for (const entry of sceneHistory) {
          if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
        }
      }
    }

    // Reference library
    const refLib = this.stateManager.get<Array<Record<string, unknown>>>('系统.扩展.image.referenceLibrary');
    if (Array.isArray(refLib)) {
      for (const entry of refLib) {
        if (entry && typeof entry === 'object') addIfValid(entry.assetId);
      }
    }

    return ids;
  }

  private getCivitaiProviderParams(): Record<string, unknown> {
    const base = '系统.扩展.image.config.civitai';
    return {
      allowMatureContent: this.stateManager.get<boolean>(`${base}.allowMatureContent`) === true,
      scheduler: this.stateManager.get<string>(`${base}.scheduler`) ?? undefined,
      steps: this.stateManager.get<number>(`${base}.steps`) ?? undefined,
      cfgScale: this.stateManager.get<number>(`${base}.cfgScale`) ?? undefined,
      seed: this.stateManager.get<number>(`${base}.seed`) ?? undefined,
      clipSkip: this.stateManager.get<number>(`${base}.clipSkip`) ?? undefined,
      outputFormat: this.stateManager.get<string>(`${base}.outputFormat`) ?? undefined,
      additionalNetworksJson: this.stateManager.get<string>(`${base}.additionalNetworksJson`) ?? undefined,
      controlNetsJson: this.stateManager.get<string>(`${base}.controlNetsJson`) ?? undefined,
    };
  }

  private prepareCivitaiRequest(
    composed: { positive: string; negative: string; width: number; height: number },
    subjectType: ImageSubjectType,
    targetCharacter?: string,
  ): {
    composed: { positive: string; negative: string; width: number; height: number };
    providerParams: Record<string, unknown>;
    snapshot: CivitaiLoraSnapshot | undefined;
  } {
    const base = '系统.扩展.image.config.civitai';
    const shelf = this.stateManager.get<CivitaiLoraShelfItem[]>(`${base}.loras`) ?? [];
    const rawJson = this.stateManager.get<string>(`${base}.additionalNetworksJson`);
    const scope = resolveLoraScope(subjectType, targetCharacter);

    const validation = validateShelfForGeneration(shelf, scope);
    if (!validation.valid) {
      throw new Error(`[Civitai LoRA] ${validation.errors.join('; ')}`);
    }

    const prepared = prepareCivitaiLora({
      shelf,
      scope,
      positivePrompt: composed.positive,
      rawAdditionalNetworksJson: rawJson,
    });

    // Build provider params directly — avoids redundant state reads via getCivitaiProviderParams
    const providerParams: Record<string, unknown> = {
      allowMatureContent: this.stateManager.get<boolean>(`${base}.allowMatureContent`) === true,
      scheduler: this.stateManager.get<string>(`${base}.scheduler`) ?? undefined,
      steps: this.stateManager.get<number>(`${base}.steps`) ?? undefined,
      cfgScale: this.stateManager.get<number>(`${base}.cfgScale`) ?? undefined,
      seed: this.stateManager.get<number>(`${base}.seed`) ?? undefined,
      clipSkip: this.stateManager.get<number>(`${base}.clipSkip`) ?? undefined,
      outputFormat: this.stateManager.get<string>(`${base}.outputFormat`) ?? undefined,
      additionalNetworksJson: prepared.mergedAdditionalNetworksJson,
      controlNetsJson: this.stateManager.get<string>(`${base}.controlNetsJson`) ?? undefined,
    };

    return {
      composed: { ...composed, positive: prepared.modifiedPositive },
      providerParams,
      snapshot: prepared.snapshot.loras.length > 0 ? prepared.snapshot : undefined,
    };
  }

  private async callProvider(
    backend: ImageBackendType,
    composed: { positive: string; negative: string; width: number; height: number },
    presetParams?: Record<string, unknown>,
    reference?: ImageReferenceInput,
    styleParamOverrides?: Record<string, unknown>,
  ): Promise<Blob> {
    const config = this.aiService.getImageConfigForBackend(backend);
    if (!config) throw new Error(`[ImageService] 未找到 "${backend}" 后端的图像 API 配置 — 请在 API 管理中添加`);

    const provider = this.providerRegistry.resolve({
      backend,
      endpoint: config.url,
      apiKey: config.apiKey,
      model: config.model,
    });

    let resolvedParams: Record<string, unknown> | undefined = presetParams;
    if (!resolvedParams) {
      if (backend === 'novelai') {
        resolvedParams = {
          sampler: this.stateManager.get<string>('系统.扩展.image.config.novelai.sampler') ?? undefined,
          noiseSchedule: this.stateManager.get<string>('系统.扩展.image.config.novelai.noiseSchedule') ?? undefined,
          steps: this.stateManager.get<number>('系统.扩展.image.config.novelai.steps') ?? undefined,
          cfgScale: this.stateManager.get<number>('系统.扩展.image.config.novelai.cfgScale') ?? undefined,
          smea: this.stateManager.get<boolean>('系统.扩展.image.config.novelai.smea') ?? undefined,
          seed: this.stateManager.get<number>('系统.扩展.image.config.novelai.seed') ?? undefined,
        };
      } else if (backend === 'comfyui') {
        const workflowJson = this.stateManager.get<string>('系统.扩展.image.config.comfyui.workflowJson');
        const hasTemplate = typeof workflowJson === 'string' && workflowJson.trim() !== '';
        console.log('[ImageService] ComfyUI workflow template:',
          hasTemplate ? `found (${workflowJson!.length} chars)` : 'not configured — will use built-in basic workflow');
        resolvedParams = {
          workflowTemplate: hasTemplate ? workflowJson : undefined,
        };
      } else if (backend === 'civitai') {
        resolvedParams = this.getCivitaiProviderParams();
      }
    }

    if (styleParamOverrides && Object.keys(styleParamOverrides).length > 0) {
      resolvedParams = { ...resolvedParams, ...styleParamOverrides };
    }

    if (reference) {
      const refBase = '系统.扩展.image.config.reference';
      if (backend === 'civitai' && this.stateManager.get<boolean>(`${refBase}.civitai.imageToImageEnabled`) === false) {
        throw new Error('[ImageService] Civitai 参考重绘已在设置中禁用');
      }
      if (backend === 'novelai' && this.stateManager.get<boolean>(`${refBase}.novelai.imageToImageEnabled`) === false) {
        throw new Error('[ImageService] NovelAI 参考重绘已在设置中禁用');
      }
      if (!supportsImageToImage(provider)) {
        throw new Error(`[ImageService] "${backend}" 后端不支持参考图生成`);
      }
      const resolved = await this.resolveReferenceAsset(reference);
      return provider.imageToImage(
        composed.positive,
        composed.negative,
        composed.width,
        composed.height,
        resolved,
        resolvedParams,
      );
    }

    return provider.generate(
      composed.positive,
      composed.negative,
      composed.width,
      composed.height,
      resolvedParams,
    );
  }

  private async resolveReferenceAsset(ref: ImageReferenceInput): Promise<ImageReferenceInput> {
    if (ref.source === 'asset') {
      if (!ref.assetId) throw new Error('[ImageService] 参考图来源为 asset 但未提供 assetId');
      const entry = await this.cache.retrieve(ref.assetId);
      if (!entry) throw new Error(`[ImageService] 参考图资产 ${ref.assetId} 未找到`);
      const dataUrl = await blobToDataUrl(entry.blob);
      return { ...ref, dataUrl, source: 'data_url' };
    }
    if (!ref.dataUrl && !ref.url) {
      throw new Error('[ImageService] 参考图缺少 dataUrl 或 url');
    }
    return ref;
  }

  /**
   * 图片提炼编排（图片提炼重建 epic §3.5）：按 engine 分派到
   * Civitai VLM（chatCompletion）或通用 LLM（主对话配置，D3B）。
   * 旧 understandingEnabled 硬闸已移除——引擎选择本身即开关。
   */
  async analyzeImage(request: ImageUnderstandingRequest): Promise<ImageUnderstandingResult> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    const resolvedImage = await this.resolveReferenceAsset(request.image);
    const cfg = this.getUnderstandingConfig();
    const effective: ImageUnderstandingRequest = {
      ...request,
      image: resolvedImage,
      model: request.model ?? cfg.civitaiModel,
      temperature: request.temperature ?? cfg.temperature,
      maxNewTokens: request.maxNewTokens ?? cfg.maxNewTokens,
    };

    if (request.engine === 'general_llm') {
      return describeImageWithGeneralLlm(this.aiService, effective);
    }

    // civitai_vlm：走 civitai 图像 API 配置（token 鉴权 + allowMatureContent 透传，D6）
    const config = this.aiService.getImageConfigForBackend('civitai');
    if (!config) throw new Error('[ImageService] 未找到 Civitai 图像 API 配置。Civitai 视觉引擎需要先在 API 管理中配置 Civitai 图像 API，或切换到通用 LLM 引擎。');

    const provider = this.providerRegistry.resolve({
      backend: 'civitai',
      endpoint: config.url,
      apiKey: config.apiKey,
      model: config.model,
    });
    if (!supportsImageUnderstanding(provider)) {
      throw new Error('[ImageService] Civitai provider 不支持图片提炼');
    }

    const providerOptions: Record<string, unknown> = {
      allowMatureContent: this.stateManager.get<boolean>('系统.扩展.image.config.civitai.allowMatureContent') === true,
    };
    return provider.describeImage(effective, providerOptions);
  }

  /** 提炼设置（图片提炼重建 epic §4）；默认值与 save-migration 保持一致 */
  getUnderstandingConfig(): {
    defaultEngine: ImageUnderstandingEngine;
    civitaiModel: string;
    temperature: number;
    maxNewTokens: number;
  } {
    const base = '系统.扩展.image.config.understanding';
    const engine = this.stateManager.get<string>(`${base}.defaultEngine`);
    return {
      defaultEngine: engine === 'general_llm' ? 'general_llm' : 'civitai_vlm',
      civitaiModel: this.stateManager.get<string>(`${base}.civitaiModel`) ?? 'claude-sonnet-5',
      temperature: this.stateManager.get<number>(`${base}.temperature`) ?? 0.2,
      maxNewTokens: this.stateManager.get<number>(`${base}.maxNewTokens`) ?? 600,
    };
  }

  /** D3B「必须标明」：主对话 LLM 配置信息，供设置区/提炼面板标示与能力门控 */
  getGeneralLlmInfo(): GeneralLlmInfo {
    return getGeneralLlmInfo(this.aiService);
  }

  private async storeAsset(task: ImageTask, blob: Blob, backend: ImageBackendType): Promise<ImageAsset> {
    const asset: ImageAsset = {
      id: `asset_${task.id}_${Date.now()}`,
      taskId: task.id,
      storageKey: '',
      mimeType: blob.type || 'image/png',
      width: task.width,
      height: task.height,
      sizeBytes: blob.size,
      backend,
      createdAt: Date.now(),
      origin: 'generated',
    };
    asset.storageKey = asset.id;
    await this.cache.store(asset, blob);
    return asset;
  }

  private static readonly SCENE_ARCHIVE_PATH = '系统.扩展.image.sceneArchive';

  /**
   * Write a completed scene image to the scene archive in the state tree.
   * Enforces history limit and auto-saves.
   */
  writeToSceneArchive(assetId: string, task: ImageTask): void {
    const archivePath = ImageService.SCENE_ARCHIVE_PATH;
    const archive = (this.stateManager.get<Record<string, unknown>>(archivePath) ?? { 生图历史: [] }) as Record<string, unknown>;
    const history = Array.isArray(archive['生图历史']) ? [...(archive['生图历史'] as unknown[])] : [];

    const record: Record<string, unknown> = {
      id: assetId,
      taskId: task.id,
      status: task.status,
      positivePrompt: task.positivePrompt ?? '',
      negativePrompt: task.negativePrompt ?? '',
      width: task.width,
      height: task.height,
      backend: task.backend,
      model: this.getCurrentModelName(task.backend),
      apiConfigName: this.getCurrentApiConfigName(task.backend),
      createdAt: Date.now(),
    };
    if (task.providerMeta) record.providerMeta = task.providerMeta;

    history.unshift(record);

    // Enforce history limit (按场景图上限裁剪档案)
    const limit = this.stateManager.get<number>('系统.扩展.image.config.sceneHistoryLimit') ?? 10;
    if (history.length > limit) history.length = limit;

    this.stateManager.set(archivePath, {
      ...archive,
      '生图历史': history,
      '最近生图结果': assetId,
    }, 'system');

    eventBus.emit('engine:request-save');
  }

  getSceneArchive(): Record<string, unknown> {
    return (this.stateManager.get<Record<string, unknown>>(ImageService.SCENE_ARCHIVE_PATH) ?? { 生图历史: [] }) as Record<string, unknown>;
  }
}
