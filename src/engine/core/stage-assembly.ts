/**
 * Pipeline stage assembly for GameOrchestrator (R5 step 2).
 *
 * Two explicit functions, NOT one factory with options: the round pipeline and the
 * enhanced-opening stage set differ in 5 places, and the opening one must stay as it was
 * (whether the opening should run SettingCapture is a product question, not decided here).
 *
 * | # | Difference                  | addRoundStages (main round)                    | buildOpeningStages (enhanced opening) |
 * |---|-----------------------------|------------------------------------------------|---------------------------------------|
 * | 1 | ContextAssembly useNewBuilder | `true` (context-piece prompt assembly)        | `false` (legacy flow path, so step1/step2FlowOverride works) |
 * | 2 | ContextAssembly gproxy flag + promptTransform | passed                        | not passed                            |
 * | 3 | PostProcess plotVector      | `subPipelines.plotVector` passed               | not passed                            |
 * | 4 | SettingCapture              | present (before PostProcess)                   | absent                                |
 * | 5 | ResponseRepair, ReasoningIngest, Render (and PlotVector inline stage) | present            | absent                                |
 */
import type { PipelineRunner } from '../pipeline/pipeline-runner';
import { PreProcessStage } from '../pipeline/stages/pre-process';
import { ContextAssemblyStage } from '../pipeline/stages/context-assembly';
import { AICallStage } from '../pipeline/stages/ai-call';
import { ResponseRepairStage } from '../pipeline/stages/response-repair';
import { BodyPolishStage } from '../pipeline/stages/body-polish-stage';
import { ReasoningIngestStage } from '../pipeline/stages/reasoning-ingest';
import { CommandExecutionStage } from '../pipeline/stages/command-execution';
import { PostProcessStage } from '../pipeline/stages/post-process';
import { RenderStage } from '../pipeline/stages/render';
import { SettingCaptureStage } from '../pipeline/stages/setting-capture';
import { parseSettingTagNames } from '../prompt/setting-tag-scanner';
import { parseAnchorStopwords, FALLBACK_CAPTURED_LABELS } from '../prompt/captured-entry-mutations';
import { DEFAULT_PROMPT_SETTINGS } from '../prompt/world-book';
import type { PromptSettings } from '../prompt/world-book';
import type { CapturedSettingLabels } from '../prompt/captured-entry-mutations';
import { SYSTEM_PATHS } from '../pipeline/system-paths';
import type { StateManager } from './state-manager';
import type { CommandExecutor } from './command-executor';
import type { BehaviorRunner } from '../behaviors/behavior-runner';
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { SaveManager } from '../persistence/save-manager';
import type {
  IMemoryManager,
  IMemoryRetriever,
  IEngramManager,
  IUnifiedRetriever,
  EnginePathConfig,
  IActionQueueConsumer,
} from '../pipeline/types';
import type { GamePack } from '../types';
import type { OpeningStages } from '../pipeline/sub-pipelines/enhanced-opening';
import type { SubPipelineBundle } from './game-orchestrator';

/** Dependencies shared by both stage sets. `subPipelines` is the orchestrator's own bundle object. */
export interface StageAssemblyDeps {
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  behaviorRunner: BehaviorRunner;
  aiService: AIService;
  responseParser: ResponseParser;
  promptAssembler: PromptAssembler;
  memoryManager: IMemoryManager;
  memoryRetriever: IMemoryRetriever;
  engramManager: IEngramManager;
  saveManager: SaveManager;
  pack: GamePack;
  paths: EnginePathConfig;
  unifiedRetriever?: IUnifiedRetriever;
  subPipelines: SubPipelineBundle;
  getActiveSlot: () => { profileId: string; slotId: string } | null;
}

/** The main round additionally feeds PreProcessStage from the action queue. */
export interface RoundStageDeps extends StageAssemblyDeps {
  actionQueue: IActionQueueConsumer;
}

/** Adds the main-round stages to `runner`, in the original order. */
export function addRoundStages(runner: PipelineRunner, deps: RoundStageDeps): void {
  const {
    stateManager, commandExecutor, behaviorRunner, aiService, responseParser, promptAssembler,
    memoryManager, memoryRetriever, engramManager, saveManager, pack, paths, unifiedRetriever,
    subPipelines, getActiveSlot, actionQueue,
  } = deps;
  runner.addStage(new PreProcessStage(stateManager, actionQueue, paths));
  runner.addStage(
    new ContextAssemblyStage(
      stateManager,
      promptAssembler,
      memoryRetriever,
      behaviorRunner,
      pack,
      paths,
      engramManager,    // E.2: 用于读取 retrievalMode
      unifiedRetriever, // E.2: hybrid 路径使用
      () => subPipelines.worldBooks ?? [],    // World book getter (supports live updates)
      true, // useNewBuilder — enable context-piece prompt assembly
      // gproxy cache flag — read live from the resolved main LLM config each round
      () => aiService.getConfigForUsage('main')?.gproxyPromptCache === true,
      ctx => subPipelines.plotVector?.promptTransform?.(ctx),
    ),
  );
  if (subPipelines.plotVector) {
    const port = subPipelines.plotVector;
    runner.addStage({ name: 'PlotVector', execute: ctx => port.prepare(ctx) });
  }
  runner.addStage(new AICallStage(aiService, responseParser));
  // 2026-04-19 修复 \你 stutter：当 ResponseParser 三个 tryParseJson 策略 +
  // escape sanitizer 都救不回来时（JSON 被截断 / 缺闭合括号 等严重畸形），
  // 这里发一次修复调用把 commands / memory / options 抢回来，避免本回合
  // 状态变更全部丢失。no-op 当 parseOk=true。
  runner.addStage(new ResponseRepairStage(aiService, responseParser));
  // Phase 4 (2026-04-19): polish between AICall and ReasoningIngest so
  // `parsedResponse.text` is polished before PostProcess persists the
  // narrative entry. Previous sub-pipeline implementation ran AFTER the
  // pipeline — too late, the original text was already stored.
  runner.addStage(new BodyPolishStage(aiService, stateManager, promptAssembler));
  runner.addStage(new ReasoningIngestStage(stateManager, paths));
  runner.addStage(new CommandExecutionStage(commandExecutor, behaviorRunner, stateManager, paths));
  // Canon Capture — after commands are applied, before PostProcess persists history
  // and triggers the auto-save, so the captured settings are part of the SAME round
  // (and therefore the same rollback unit) as the narrative that introduced them.
  runner.addStage(
    new SettingCaptureStage(stateManager, paths, {
      isEnabled: () => {
        const settings: PromptSettings = {
          ...DEFAULT_PROMPT_SETTINGS,
          ...(stateManager.get<Partial<PromptSettings>>(SYSTEM_PATHS.promptSettings) ?? {}),
        };
        // The world-book master switch gates BOTH extraction and injection; the
        // feature switch gates extraction only (existing entries keep working).
        return settings.enableWorldBook !== false && settings.enableSettingCapture !== false;
      },
      getTagNames: () => parseSettingTagNames(pack.engineFragments?.settingTagNames),
      getAnchorStopwords: () => parseAnchorStopwords(pack.engineFragments?.settingAnchorStopwords),
      getLabels: (): CapturedSettingLabels => ({
        bookTitle: pack.engineFragments?.settingBookTitle ?? FALLBACK_CAPTURED_LABELS.bookTitle,
        kind: {
          character: pack.engineFragments?.settingKindCharacter ?? FALLBACK_CAPTURED_LABELS.kind.character,
          relationship: pack.engineFragments?.settingKindRelationship ?? FALLBACK_CAPTURED_LABELS.kind.relationship,
          world_fact: pack.engineFragments?.settingKindWorldFact ?? FALLBACK_CAPTURED_LABELS.kind.world_fact,
        },
      }),
    }),
  );
  runner.addStage(
    new PostProcessStage(
      stateManager,
      memoryManager,
      engramManager,
      behaviorRunner,
      saveManager,
      paths,
      getActiveSlot,
      subPipelines.plotVector,
    ),
  );
  runner.addStage(new RenderStage());
}

/**
 * NEW-I1 + NEW-C3: stage instances for the enhanced opening pipeline.
 *
 * Uses the same dependency instances as the main pipeline, ensuring consistent behavior.
 * The opening pipeline calls stage.execute() manually instead of going through PipelineRunner.
 */
export function buildOpeningStages(deps: StageAssemblyDeps): OpeningStages {
  const {
    stateManager, commandExecutor, behaviorRunner, aiService, responseParser, promptAssembler,
    memoryManager, memoryRetriever, engramManager, saveManager, pack, paths, unifiedRetriever,
    subPipelines, getActiveSlot,
  } = deps;
  return {
    contextAssembly: new ContextAssemblyStage(
      stateManager,
      promptAssembler,
      memoryRetriever,
      behaviorRunner,
      pack,
      paths,
      engramManager,
      unifiedRetriever,
      () => subPipelines.worldBooks ?? [],
      // Use legacy flow-based path so step1/step2FlowOverride works
      false,
    ),
    aiCall: new AICallStage(aiService, responseParser),
    bodyPolish: new BodyPolishStage(aiService, stateManager, promptAssembler),
    commandExecution: new CommandExecutionStage(
      commandExecutor,
      behaviorRunner,
      stateManager,
      paths,
    ),
    postProcess: new PostProcessStage(
      stateManager,
      memoryManager,
      engramManager,
      behaviorRunner,
      saveManager,
      paths,
      getActiveSlot,
    ),
  };
}
