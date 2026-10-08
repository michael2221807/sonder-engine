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
import { supportsImageToImage, supportsImageUnderstanding, clampReferencesForBackend } from './provider-capabilities';
// 「还有谁在引用」与备份采集器同源——见 cleanupEvictedTaskAssets 的注释。
import { collectAssetIdsFromTree } from './asset-refs';
import { describeImageWithGeneralLlm, getGeneralLlmInfo, type GeneralLlmInfo } from './llm-understanding';
import type { ImageUnderstandingEngine } from './reference-types';
import { blobToDataUrl } from './utils';
import { prepareCivitaiLora, resolveLoraScope, validateShelfForGeneration } from './civitai-lora';
import { joinPromptFragments } from './style-preset-injection';
import { normalizeSingleCharacterOutput, processTransformerOutput, type SerializationStrategy } from './output-processor';
import { SYSTEM_PATHS } from '../pipeline/system-paths';
import { TIANMING_IMAGE_ARCHIVE_KEYS, TIANMING_SECRET_PART_CN } from '../pack/tianming-coupling';

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

type ComposedImagePrompt = { positive: string; negative: string; width: number; height: number };
type ReferenceMeta = { reference?: NonNullable<ImageTask['providerMeta']>['reference'] };

/**
 * One image-generation run. The public flows keep their own enabled check,
 * argument validation and lock acquisition (all before `runGeneration`), and
 * hand over only what differs between them.
 */
interface GenerationJob {
  /** Literal for `queue.create`; key order is part of the persisted task shape. */
  create: Parameters<ImageTaskQueue['create']>[0];
  /** Generation lock to release in `finally`; undefined = the flow holds no lock. */
  lockKey?: string;
  /** Whether the flow passes through (and announces) the `tokenizing` phase. */
  tokenize: boolean;
  backend: ImageBackendType;
  civitai: { subjectType: ImageSubjectType; target?: string };
  references?: ImageReferenceInput[];
  styleParamOverrides?: Record<string, unknown>;
  /**
   * Builds the prompt pair; runs inside the try so failures mark the task failed.
   * May return synchronously: the redraw flow has no async work before `generating`,
   * and awaiting a plain value would add a microtask its original code never had.
   */
  compose: () => ComposedImagePrompt | Promise<ComposedImagePrompt>;
  /** Writes the archive entries after the task is complete; runs inside the try. */
  archive: (ctx: {
    task: ImageTask;
    asset: ImageAsset;
    composed: ComposedImagePrompt;
    loraSnapshot: CivitaiLoraSnapshot | undefined;
    refMeta: ReferenceMeta;
  }) => void;
}

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
        stateManager.set(SYSTEM_PATHS.image.tasks, tasks, 'system');
        eventBus.emit('engine:request-save');
        // Notify UI to re-render the queue list on ANY queue mutation
        // (create/update/remove/clear). The task queue is an in-memory Map
        // that Vue cannot track, so the panel's computeds rely on the
        // 'image:task-update' tick. Without this, clear/remove buttons had
        // no visible effect until the next generation fired the event.
        // Empty payload → the global toast listener ignores it (no status).
        eventBus.emit('image:task-update', {});
      },
      onEvict: (evicted) => { void this.cleanupEvictedTaskAssets(evicted); },
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
    const savedTasks = this.stateManager.get<ImageTask[]>(SYSTEM_PATHS.image.tasks);
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
    return this.stateManager.get<boolean>(SYSTEM_PATHS.image.enabled) === true;
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

    const anchors = this.stateManager.get<Array<Record<string, unknown>>>(`${SYSTEM_PATHS.image.root}.characterAnchors`);
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
    const ruleTemplates = this.stateManager.get<Array<Record<string, unknown>>>(`${SYSTEM_PATHS.image.root}.ruleTemplates`);
    const modelRulesets = this.stateManager.get<Array<Record<string, unknown>>>(`${SYSTEM_PATHS.image.root}.modelRulesets`);

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
    /** 参考图**有序**列表（多图参考重绘 epic S2）。顺序=提示词里的「图N」。 */
    references?: ImageReferenceInput[];
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    return this.runGeneration({
      create: {
        subjectType: 'scene',
        width: params.preset?.width ?? 1024,
        height: params.preset?.height ?? 576,
        backend: params.backend,
        presetId: params.preset?.id,
      },
      tokenize: true,
      backend: params.backend,
      civitai: { subjectType: 'scene' },
      references: params.references,
      styleParamOverrides: params.styleParamOverrides,
      compose: async () => {
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
        return composedRaw;
      },
      archive: ({ task, asset }) => {
        this.writeToSceneArchive(asset.id, this.queue.get(task.id)!);
      },
    });
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
     *  Default: true. Forced true for NovelAI backend. */
    useTransformer?: boolean;
    /** 参考图**有序**列表（多图参考重绘 epic S2）。顺序=提示词里的「图N」。 */
    references?: ImageReferenceInput[];
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    // Concurrent generation lock (NPC生图进行中集合)
    const lockKey = params.characterName;
    if (this.state.isGenerating(lockKey)) {
      throw new Error(`[ImageService] Already generating for "${params.characterName}"`);
    }
    this.state.lockGeneration(lockKey);

    return this.runGeneration({
      create: {
        subjectType: 'character',
        targetCharacter: params.characterName,
        anchorId: params.anchor?.id,
        width: params.preset?.width ?? 832,
        height: params.preset?.height ?? 1216,
        backend: params.backend,
        presetId: params.preset?.id,
      },
      lockKey,
      tokenize: true,
      backend: params.backend,
      civitai: { subjectType: 'character', target: params.characterName },
      references: params.references,
      styleParamOverrides: params.styleParamOverrides,
      compose: async () => {
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
        return composedRaw;
      },
      archive: ({ task, asset, composed, loraSnapshot, refMeta }) => {
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
      },
    });
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
    /** 参考图**有序**列表（多图参考重绘 epic S2）。顺序=提示词里的「图N」。 */
    references?: ImageReferenceInput[];
    styleParamOverrides?: Record<string, unknown>;
  }): Promise<ImageTask> {
    if (!this.enabled) throw new Error('[ImageService] Image generation is disabled');

    // Composite lock key: NPC::part
    const lockKey = `${params.characterName}::${params.part}`;
    if (this.state.isGenerating(lockKey)) {
      throw new Error(`[ImageService] Already generating "${params.part}" for "${params.characterName}"`);
    }
    this.state.lockGeneration(lockKey);

    return this.runGeneration({
      create: {
        subjectType: 'secret_part',
        targetCharacter: params.characterName,
        part: params.part,
        width: params.preset?.width ?? 1024,
        height: params.preset?.height ?? 1024,
        backend: params.backend,
        presetId: params.preset?.id,
      },
      lockKey,
      tokenize: true,
      backend: params.backend,
      civitai: { subjectType: 'secret_part', target: params.characterName },
      references: params.references,
      styleParamOverrides: params.styleParamOverrides,
      compose: async () => {
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
        return composedRaw;
      },
      archive: ({ task, asset, composed, loraSnapshot, refMeta }) => {
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
          this.deletePreviousSecretBlob(params.characterName, params.part, asset.id);

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
      },
    });
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
    /** 参考图**有序**列表（多图参考重绘 epic S2）。顺序=提示词里的「图N」。 */
    references?: ImageReferenceInput[];
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

    return this.runGeneration({
      create: {
        subjectType: params.subjectType,
        targetCharacter: params.targetCharacter,
        part: params.part,
        width: params.width,
        height: params.height,
        backend: params.backend,
      },
      lockKey: params.subjectType !== 'scene' ? lockKey : undefined,
      tokenize: false,
      backend: params.backend,
      civitai: { subjectType: params.subjectType, target: params.targetCharacter },
      references: params.references,
      styleParamOverrides: params.styleParamOverrides,
      compose: () => {
        const composedRaw = {
          positive: params.positivePrompt,
          negative: params.negativePrompt,
          width: params.width,
          height: params.height,
        };
        return composedRaw;
      },
      archive: ({ task, asset, composed, loraSnapshot, refMeta }) => {
        const createdAt = Date.now();
        const modelName = this.getCurrentModelName(params.backend);
        const apiName = this.getCurrentApiConfigName(params.backend);
        const archiveMeta = { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta };
        const metaSpread = Object.keys(archiveMeta).length > 0 ? { providerMeta: archiveMeta } : {};
        if (params.subjectType === 'scene') {
          this.writeToSceneArchive(asset.id, this.queue.get(task.id)!);
        } else if (params.subjectType === 'secret_part' && params.targetCharacter && params.part) {
          this.deletePreviousSecretBlob(params.targetCharacter, params.part, asset.id);
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
      },
    });
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
      breast: TIANMING_SECRET_PART_CN.breast,
      vagina: TIANMING_SECRET_PART_CN.vagina,
      anus: TIANMING_SECRET_PART_CN.anus,
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
    this.deletePreviousSecretBlob(npcName, part, assetId);
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
      for (const f of [TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId, '已选立绘图片ID', '已选背景图片ID']) {
        const v = String(archive[f] ?? '').trim();
        if (v) idsToDelete.add(v);
      }
      const secretArchive = archive[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber] as Record<string, unknown> | undefined;
      if (secretArchive) {
        for (const partKey of [TIANMING_SECRET_PART_CN.breast, TIANMING_SECRET_PART_CN.vagina, TIANMING_SECRET_PART_CN.anus]) {
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
   * Shared skeleton of the four generation flows: create the task, (tokenize),
   * compose, prepare Civitai, mark generating, call the provider, store the
   * asset, complete, archive; any failure marks the task failed; the lock (if
   * any) is released last. The lock itself is taken by the caller, outside any
   * try, before this runs.
   */
  private async runGeneration(job: GenerationJob): Promise<ImageTask> {
    const task = this.queue.create(job.create);

    try {
      if (job.tokenize) {
        this.queue.updateStatus(task.id, 'tokenizing');
        eventBus.emit('image:task-update', { taskId: task.id, status: 'tokenizing' });
      }

      const pending = job.compose();
      const composedRaw = pending instanceof Promise ? await pending : pending;

      // Civitai LoRA preparation (no-op for non-civitai)
      const { composed, civitaiProviderParams, loraSnapshot } = this.applyCivitai(job.backend, composedRaw, job.civitai.subjectType, job.civitai.target);

      const refMeta = this.buildReferenceMeta(job.references, job.backend);
      this.markGenerating(task.id, composed, loraSnapshot, refMeta);

      const blob = await this.callProvider(job.backend, composed, civitaiProviderParams, job.references, job.styleParamOverrides);
      const asset = await this.storeAsset(task, blob, job.backend);

      this.completeTask(task.id, asset.id);

      job.archive({ task, asset, composed, loraSnapshot, refMeta });

      return this.queue.get(task.id)!;
    } catch (err) {
      return this.failTask(task.id, err);
    } finally {
      if (job.lockKey !== undefined) this.state.unlockGeneration(job.lockKey);
    }
  }

  /**
   * Archive/task `reference` metadata for an image-to-image request; `{}` when
   * there are no references. Returns a fresh literal on every call.
   */
  private buildReferenceMeta(
    references: ImageReferenceInput[] | undefined,
    backend: ImageBackendType,
  ) {
    return references?.length ? {
      reference: {
        mode: 'image_to_image' as const,
        // 有序：归档的 id 序列必须与发给 provider 的 image 数组同序，否则
        // 「图1/图2」的语义在复现历史任务时会错位。
        // 与 image 数组**下标对齐**：未持久化的项（dataUrl-only）记空串占位。
        // 早先的 .filter() 会把中间项抽掉，让 index 1 实际指向图3——正好违反
        // 本字段自己声明的顺序契约（review Important 2026-08-29）。
        sourceAssetIds: references.map((r) => r.assetId ?? ''),
        // 幅度是整单一个值（NovelAI/Civitai 单图；豆包无此参数）→ 取首张。
        denoiseStrength: references[0].denoiseStrength,
        provider: backend,
      },
    } : {};
  }

  /** Civitai LoRA preparation (no-op for non-civitai backends). */
  private applyCivitai(
    backend: ImageBackendType,
    composedRaw: { positive: string; negative: string; width: number; height: number },
    subjectType: ImageSubjectType,
    targetCharacter?: string,
  ): {
    composed: { positive: string; negative: string; width: number; height: number };
    civitaiProviderParams: Record<string, unknown> | undefined;
    loraSnapshot: CivitaiLoraSnapshot | undefined;
  } {
    let composed = composedRaw;
    let civitaiProviderParams: Record<string, unknown> | undefined;
    let loraSnapshot: CivitaiLoraSnapshot | undefined;
    if (backend === 'civitai') {
      const prep = this.prepareCivitaiRequest(composedRaw, subjectType, targetCharacter);
      composed = prep.composed;
      civitaiProviderParams = prep.providerParams;
      loraSnapshot = prep.snapshot;
    }
    return { composed, civitaiProviderParams, loraSnapshot };
  }

  /** Move a task to `generating` and announce it (status update first, then the event). */
  private markGenerating(
    taskId: string,
    composed: { positive: string; negative: string },
    loraSnapshot: CivitaiLoraSnapshot | undefined,
    refMeta: ReferenceMeta,
  ): void {
    this.queue.updateStatus(taskId, 'generating', {
      positivePrompt: composed.positive,
      negativePrompt: composed.negative,
      providerMeta: { ...(loraSnapshot ? { civitai: loraSnapshot } : {}), ...refMeta },
    });
    eventBus.emit('image:task-update', { taskId, status: 'generating' });
  }

  private completeTask(taskId: string, assetId: string): void {
    this.queue.updateStatus(taskId, 'complete', { resultAssetId: assetId });
    eventBus.emit('image:task-update', { taskId, status: 'complete', assetId });
  }

  private failTask(taskId: string, err: unknown): ImageTask {
    const msg = (err as Error).message ?? String(err);
    this.queue.updateStatus(taskId, 'failed', { error: msg });
    eventBus.emit('image:task-update', { taskId, status: 'failed', error: msg });
    return this.queue.get(taskId)!;
  }

  /** Best-effort delete of the secret-part blob that is about to be overwritten. */
  private deletePreviousSecretBlob(npcName: string, part: SecretPartType, newAssetId: string): void {
    const prevSecret = this.state.getSecretPartResult(npcName, part);
    const prevSecretId = typeof prevSecret?.id === 'string' ? prevSecret.id : '';
    if (prevSecretId && prevSecretId !== newAssetId) {
      void this.cache.delete(prevSecretId).catch(() => {/* best effort */});
    }
  }

  private getCivitaiProviderParams(): Record<string, unknown> {
    const base = `${SYSTEM_PATHS.image.config}.civitai`;
    return this.readCivitaiProviderParams(this.stateManager.get<string>(`${base}.additionalNetworksJson`) ?? undefined);
  }

  /** Civitai provider params from the state tree; the merged-networks JSON is supplied by the caller. */
  private readCivitaiProviderParams(additionalNetworksJson: string | undefined): Record<string, unknown> {
    const base = `${SYSTEM_PATHS.image.config}.civitai`;
    return {
      allowMatureContent: this.stateManager.get<boolean>(`${base}.allowMatureContent`) === true,
      scheduler: this.stateManager.get<string>(`${base}.scheduler`) ?? undefined,
      steps: this.stateManager.get<number>(`${base}.steps`) ?? undefined,
      cfgScale: this.stateManager.get<number>(`${base}.cfgScale`) ?? undefined,
      seed: this.stateManager.get<number>(`${base}.seed`) ?? undefined,
      clipSkip: this.stateManager.get<number>(`${base}.clipSkip`) ?? undefined,
      outputFormat: this.stateManager.get<string>(`${base}.outputFormat`) ?? undefined,
      additionalNetworksJson,
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
    const base = `${SYSTEM_PATHS.image.config}.civitai`;
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

    const providerParams = this.readCivitaiProviderParams(prepared.mergedAdditionalNetworksJson);

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
    references?: ImageReferenceInput[],
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
          sampler: this.stateManager.get<string>(`${SYSTEM_PATHS.image.config}.novelai.sampler`) ?? undefined,
          noiseSchedule: this.stateManager.get<string>(`${SYSTEM_PATHS.image.config}.novelai.noiseSchedule`) ?? undefined,
          steps: this.stateManager.get<number>(`${SYSTEM_PATHS.image.config}.novelai.steps`) ?? undefined,
          cfgScale: this.stateManager.get<number>(`${SYSTEM_PATHS.image.config}.novelai.cfgScale`) ?? undefined,
          smea: this.stateManager.get<boolean>(`${SYSTEM_PATHS.image.config}.novelai.smea`) ?? undefined,
          seed: this.stateManager.get<number>(`${SYSTEM_PATHS.image.config}.novelai.seed`) ?? undefined,
        };
      } else if (backend === 'comfyui') {
        const workflowJson = this.stateManager.get<string>(`${SYSTEM_PATHS.image.config}.comfyui.workflowJson`);
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

    if (references?.length) {
      const refBase = `${SYSTEM_PATHS.image.config}.reference`;
      if (backend === 'civitai' && this.stateManager.get<boolean>(`${refBase}.civitai.imageToImageEnabled`) === false) {
        throw new Error('[ImageService] Civitai 参考重绘已在设置中禁用');
      }
      if (backend === 'novelai' && this.stateManager.get<boolean>(`${refBase}.novelai.imageToImageEnabled`) === false) {
        throw new Error('[ImageService] NovelAI 参考重绘已在设置中禁用');
      }
      if (!supportsImageToImage(provider)) {
        throw new Error(`[ImageService] "${backend}" 后端不支持参考图生成`);
      }
      // 多图门控（PO 决策① 2026-08-29）：不支持多图的后端在这里就截断到首张，
      // 不把「其实只有第 1 张生效」留给 provider 去悄悄处理。UI 侧已按能力位
      // 不给多选，走到这里说明是非 UI 调用方或历史任务复现。
      const { effective, dropped } = clampReferencesForBackend(backend, references);
      if (dropped > 0) {
        console.warn(
          `[ImageService] "${backend}" 不支持多参考图，${references.length} 张已截断为第 1 张（丢弃 ${dropped} 张）`,
        );
      }
      // 顺序即语义（提示词里的「图1/图2」），resolve 必须保序 → 不能用
      // Promise.all 之外的乱序写法；这里逐张 resolve 后原序传下去。
      const resolved = await Promise.all(effective.map((r) => this.resolveReferenceAsset(r)));
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
      allowMatureContent: this.stateManager.get<boolean>(`${SYSTEM_PATHS.image.config}.civitai.allowMatureContent`) === true,
    };
    return provider.describeImage(effective, providerOptions);
  }

  /**
   * 任务队列淘汰收尾（PO 决策 2026-08-29：「沿用 50 条上限，给出提示，超出就删
   * 最旧，该删的也删」）。
   *
   * 为什么必须做：备份采集器 `collectAssetIdsFromTree` 从任务归档里取参考图
   * assetId。任务被淘汰后这些 id 就不再被采集——图片本体却还躺在 IndexedDB 里，
   * 既不进备份也没人清，纯属越积越多的孤儿。
   *
   * 判定「还有没有人要」**复用备份采集器本身**，不另写一套：这个功能已经因为
   * 「两套系统对『被引用』理解不一致」出过一次 CRITICAL（删素材库条目卡死云同步），
   * 同源是唯一可靠的防线。素材库里的图（用户主动囤的）在 includeReferenceAssets
   * =true 下也会被算作引用 → 永远不会被这里删掉。
   */
  private async cleanupEvictedTaskAssets(evicted: ImageTask[]): Promise<void> {
    const candidates = new Set<string>();
    for (const task of evicted) {
      const ref = task.providerMeta?.reference;
      if (!ref) continue;
      for (const id of ref.sourceAssetIds ?? []) if (id) candidates.add(id);
      if (ref.sourceAssetId) candidates.add(ref.sourceAssetId);
    }
    if (candidates.size === 0) return;

    // 淘汰后的存档树里还被引用的一律保留（includeReferenceAssets=true：保护面
    // 尽量大，宁可留下也不误删）。
    const stillReferenced = new Set<string>();
    const tree = this.stateManager.getTree() as unknown as Record<string, unknown>;
    collectAssetIdsFromTree(tree, stillReferenced, true);

    const orphans = [...candidates].filter((id) => !stillReferenced.has(id));
    if (orphans.length === 0) return;

    let deleted = 0;
    for (const id of orphans) {
      try { await this.cache.delete(id); deleted++; } catch { /* best effort */ }
    }
    console.debug(`[ImageService] 任务淘汰：清理 ${deleted}/${orphans.length} 张无人引用的参考图`);
    eventBus.emit('ui:toast', {
      type: 'info',
      i18nKey: 'engine.toast.imageTasksEvicted',
      message: `生图记录超过 ${ImageTaskQueue.MAX_FINISHED} 条，已移除最旧的 ${evicted.length} 条`
        + (deleted > 0 ? `，并清理 ${deleted} 张不再被引用的参考图` : ''),
      id: 'image-tasks-evicted',
      duration: 4000,
    });
  }

  /** 提炼设置（图片提炼重建 epic §4）；默认值与 save-migration 保持一致 */
  getUnderstandingConfig(): {
    defaultEngine: ImageUnderstandingEngine;
    civitaiModel: string;
    temperature: number;
    maxNewTokens: number;
  } {
    const base = `${SYSTEM_PATHS.image.config}.understanding`;
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

  private static readonly SCENE_ARCHIVE_PATH = SYSTEM_PATHS.image.sceneArchive;

  /**
   * Write a completed scene image to the scene archive in the state tree.
   * Enforces history limit and auto-saves.
   */
  writeToSceneArchive(assetId: string, task: ImageTask): void {
    const archivePath = ImageService.SCENE_ARCHIVE_PATH;
    const archive = (this.stateManager.get<Record<string, unknown>>(archivePath) ?? { [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [] }) as Record<string, unknown>;
    const history = Array.isArray(archive[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]) ? [...(archive[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory] as unknown[])] : [];

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
    const limit = this.stateManager.get<number>(`${SYSTEM_PATHS.image.config}.sceneHistoryLimit`) ?? 10;
    if (history.length > limit) history.length = limit;

    this.stateManager.set(archivePath, {
      ...archive,
      [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: history,
      '最近生图结果': assetId,
    }, 'system');

    eventBus.emit('engine:request-save');
  }

  getSceneArchive(): Record<string, unknown> {
    return (this.stateManager.get<Record<string, unknown>>(ImageService.SCENE_ARCHIVE_PATH) ?? { [TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory]: [] }) as Record<string, unknown>;
  }
}
