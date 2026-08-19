// App doc: docs/user-guide/pages/creation.md
/**
 * Enhanced Opening Pipeline — orchestrates Phase A-G of Story 0.
 *
 * Replaces character-init steps 3-5 when enhancedOpening=true.
 * Phase A: world description (LLM, pure text)
 * Phase B: locations + inventory (LLM, JSON)
 * Phase C: NPC profiles (LLM, JSON)
 * Phase D: Engram knowledge edges (LLM, JSON → stashed for Phase F)
 * Phase E: opening narrative via splitGen (LLM ×2, reuses pipeline stages)
 * Phase F: PostProcess equivalent (no LLM, reuses CommandExecution + PostProcess stages)
 * Phase G: post-round sub-pipelines (reuses runPostRoundSubPipelines)
 *
 * Design doc: docs/plans/story-0-enhanced-opening-implementation.md
 */
import type { StateManager } from '../../core/state-manager';
import type { AIService } from '../../ai/ai-service';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { GamePack } from '../../types';
import type { EnginePathConfig, PipelineContext } from '../types';
import type { AIMessage } from '../../ai/types';
import type { ContextAssemblyStage } from '../stages/context-assembly';
import type { AICallStage } from '../stages/ai-call';
import type { BodyPolishStage } from '../stages/body-polish-stage';
import type { CommandExecutionStage } from '../stages/command-execution';
import type { PostProcessStage } from '../stages/post-process';
import type { CreationChoices } from './character-init';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { eventBus } from '../../core/event-bus';
import { mergeDuplicateNpcArray } from '../../social/npc-merge';
import {
  formatSettledPlayerProfile,
  formatWorldContext,
} from '../../creation/creation-prompt-formatter';

// ═══════════════════════════════════════════════════════════════
//  Public types
// ═══════════════════════════════════════════════════════════════

export interface OpeningStages {
  contextAssembly: ContextAssemblyStage;
  aiCall: AICallStage;
  bodyPolish: BodyPolishStage;
  commandExecution: CommandExecutionStage;
  postProcess: PostProcessStage;
}

export interface EnhancedOpeningSettings {
  enabled: boolean;
  locationRange: [number, number];
  npcRange: [number, number];
  edgeRange: [number, number];
  inventoryRange: [number, number];
  relationDensity: 'sparse' | 'medium' | 'dense';
  bypassRateLimitDuringOpening: boolean;
}

export const DEFAULT_ENHANCED_OPENING_SETTINGS: EnhancedOpeningSettings = {
  enabled: true,
  locationRange: [10, 20],
  npcRange: [5, 15],
  edgeRange: [5, 15],
  inventoryRange: [3, 8],
  relationDensity: 'medium',
  bypassRateLimitDuringOpening: false,
};

export type PhaseErrorAction = 'retry' | 'rollback' | 'exit';

export interface PhaseErrorInfo {
  phase: string;
  reason: string;
  availableActions: PhaseErrorAction[];
}

export interface EnhancedOpeningOptions {
  settings: EnhancedOpeningSettings;
  nsfwMode: boolean;
  choices: CreationChoices;
  abortSignal: AbortSignal;
  onProgress: (phase: string, progress: number) => void;
  onStreamChunk?: (chunk: string) => void;
  onPhaseError?: (info: PhaseErrorInfo) => Promise<PhaseErrorAction>;
  onRateLimitWait?: (seconds: number | null) => void;
  /**
   * D7 (card import only): optional author hint that steers the opening narrative style.
   * Surfaced to the Phase E1 prompt via `OPENING_SETUP_HINT`. New-game openings leave it unset.
   */
  firstRoundSetup?: string;
}

export interface EnhancedOpeningResult {
  success: boolean;
  cancelled?: boolean;
  phasesCompleted: string[];
  phasesFailed?: string;
  failureReason?: string;
  actionOptions: string[];
}

/** Knowledge fact from Phase D — snake_case as output by LLM */
interface RawKnowledgeFact {
  fact: string;
  source_entity: string;
  target_entity: string;
}

/** Normalized knowledge fact — camelCase matching AIResponse.knowledgeFacts */
export interface NormalizedKnowledgeFact {
  fact: string;
  sourceEntity: string;
  targetEntity: string;
}

// ═══════════════════════════════════════════════════════════════
//  Internal context passed between phases
// ═══════════════════════════════════════════════════════════════

interface PhaseContext {
  stateManager: StateManager;
  aiService: AIService;
  promptAssembler: PromptAssembler;
  gamePack: GamePack;
  paths: EnginePathConfig;
  options: EnhancedOpeningOptions;
  worldDescription: string;
  locationNames: string[];
  npcSummaryList: string;
  openingFacts: NormalizedKnowledgeFact[];
}

// ═══════════════════════════════════════════════════════════════
//  JSON validation helpers
// ═══════════════════════════════════════════════════════════════

function extractJSON(raw: string, phaseLabel: string): unknown {
  const cleaned = raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    ?? cleaned.match(/```(?:json)?\s*\n?([\s\S]+)/);
  const jsonStr = fenced ? fenced[1].trim() : cleaned;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`${phaseLabel}: JSON parse failed — ${e instanceof Error ? e.message : 'unknown error'}. Input starts with: ${jsonStr.slice(0, 200)}`);
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('取消') || msg.includes('abort') || msg.includes('cancelled')) return true;
  }
  return false;
}

function validateLocations(
  data: unknown,
): { locations: Array<Record<string, unknown>>; inventory: Array<Record<string, unknown>> } {
  if (!data || typeof data !== 'object') throw new Error('Phase B: response is not an object');
  const obj = data as Record<string, unknown>;

  const locations = obj.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('Phase B: "locations" must be a non-empty array');
  }
  for (const loc of locations) {
    if (!loc || typeof loc !== 'object') throw new Error('Phase B: location entry is not an object');
    const l = loc as Record<string, unknown>;
    if (typeof l['名称'] !== 'string' || !l['名称']) {
      throw new Error('Phase B: location missing required field "名称"');
    }
  }

  const inventory = Array.isArray(obj.inventory) ? obj.inventory : [];
  for (const item of inventory) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (typeof it['名称'] !== 'string' || !it['名称']) {
      throw new Error('Phase B: inventory item missing required field "名称"');
    }
  }

  return {
    locations: locations as Array<Record<string, unknown>>,
    inventory: inventory as Array<Record<string, unknown>>,
  };
}

function validateNpcs(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') throw new Error('Phase C: response is not an object');
  const obj = data as Record<string, unknown>;

  const npcs = obj.npcs;
  if (!Array.isArray(npcs) || npcs.length === 0) {
    throw new Error('Phase C: "npcs" must be a non-empty array');
  }
  for (const npc of npcs) {
    if (!npc || typeof npc !== 'object') throw new Error('Phase C: NPC entry is not an object');
    const n = npc as Record<string, unknown>;
    if (typeof n['名称'] !== 'string' || !n['名称']) {
      throw new Error('Phase C: NPC missing required field "名称"');
    }
  }
  return npcs as Array<Record<string, unknown>>;
}

function validateKnowledgeFacts(data: unknown): RawKnowledgeFact[] {
  if (!data || typeof data !== 'object') throw new Error('Phase D: response is not an object');
  const obj = data as Record<string, unknown>;

  const facts = obj.knowledge_facts;
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error('Phase D: "knowledge_facts" must be a non-empty array');
  }

  const result: RawKnowledgeFact[] = [];
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    const item = f as Record<string, unknown>;
    const fact = typeof item.fact === 'string' ? item.fact.trim() : '';
    const src = typeof item.source_entity === 'string' ? item.source_entity.trim() : '';
    const tgt = typeof item.target_entity === 'string' ? item.target_entity.trim() : '';
    if (fact && src && tgt) {
      result.push({ fact, source_entity: src, target_entity: tgt });
    }
  }
  const dropped = facts.length - result.length;
  if (dropped > 0) {
    console.warn(`[EnhancedOpening] Phase D: ${dropped}/${facts.length} knowledge_facts dropped (missing fact/source_entity/target_entity)`);
  }
  if (result.length === 0) {
    throw new Error('Phase D: no valid knowledge_facts after validation');
  }
  return result;
}

function normalizeKnowledgeFacts(raw: RawKnowledgeFact[]): NormalizedKnowledgeFact[] {
  return raw.map((f) => ({
    fact: f.fact,
    sourceEntity: f.source_entity,
    targetEntity: f.target_entity,
  }));
}

// ═══════════════════════════════════════════════════════════════
//  Prompt assembly helper
// ═══════════════════════════════════════════════════════════════

function assembleFlowMessages(
  flowId: string,
  gamePack: GamePack,
  promptAssembler: PromptAssembler,
  variables: Record<string, string>,
): { messages: AIMessage[]; generationId: string } {
  const flow = gamePack.promptFlows[flowId];
  if (!flow) throw new Error(`Enhanced Opening: prompt flow "${flowId}" not found in Game Pack`);

  const assembled = promptAssembler.assemble(flow, variables);
  const generationId = `enhancedOpening_${flowId}_${Date.now()}`;

  emitPromptAssemblyDebug({
    flow: flowId,
    variables,
    messages: assembled.messages,
    messageSources: assembled.messageSources,
    generationId,
  });

  return { messages: assembled.messages, generationId };
}

// ═══════════════════════════════════════════════════════════════
//  Phase execution functions
// ═══════════════════════════════════════════════════════════════

async function executePhaseA(ctx: PhaseContext): Promise<string> {
  ctx.options.onProgress('phaseA', 0);

  const playerProfile = buildPlayerProfileString(ctx);
  const worldSelection = buildWorldSelectionString(ctx);

  const variables: Record<string, string> = {
    WORLD_SELECTION: worldSelection,
    PLAYER_PROFILE: playerProfile,
  };

  const { messages, generationId } = assembleFlowMessages(
    'openingEnhancedA', ctx.gamePack, ctx.promptAssembler, variables,
  );

  const rawResponse = await ctx.aiService.generate({
    messages,
    stream: false,
    usageType: 'world_generation',
    signal: ctx.options.abortSignal,
    generationId,
  });

  emitPromptResponseDebug({
    flow: 'openingEnhancedA',
    generationId,
    thinking: extractThinkingFromRaw(rawResponse),
    rawResponse,
  });

  const worldDescription = rawResponse
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .trim();

  if (!worldDescription) throw new Error('Phase A: empty world description');

  ctx.stateManager.set(ctx.paths.worldDescription, worldDescription, 'system');
  ctx.options.onProgress('phaseA', 100);

  return worldDescription;
}

async function executePhaseB(ctx: PhaseContext): Promise<string[]> {
  ctx.options.onProgress('phaseB', 0);

  const playerProfile = buildPlayerProfileString(ctx);
  const variables: Record<string, string> = {
    WORLD_DESCRIPTION: ctx.worldDescription,
    PLAYER_PROFILE: playerProfile,
    LOCATION_MIN: String(ctx.options.settings.locationRange[0]),
    LOCATION_MAX: String(ctx.options.settings.locationRange[1]),
    INVENTORY_MIN: String(ctx.options.settings.inventoryRange[0]),
    INVENTORY_MAX: String(ctx.options.settings.inventoryRange[1]),
  };

  const { messages, generationId } = assembleFlowMessages(
    'openingEnhancedB', ctx.gamePack, ctx.promptAssembler, variables,
  );

  const rawResponse = await ctx.aiService.generate({
    messages,
    stream: false,
    usageType: 'world_generation',
    signal: ctx.options.abortSignal,
    generationId,
  });

  emitPromptResponseDebug({
    flow: 'openingEnhancedB',
    generationId,
    thinking: extractThinkingFromRaw(rawResponse),
    rawResponse,
  });

  const parsed = extractJSON(rawResponse, 'Phase B');
  const { locations, inventory } = validateLocations(parsed);

  for (const loc of locations) {
    ctx.stateManager.push(ctx.paths.locations, loc, 'system');
  }
  for (const item of inventory) {
    ctx.stateManager.push(ctx.paths.inventoryItems, item, 'system');
  }

  const locationNames = locations.map((l) => String(l['名称']));
  ctx.options.onProgress('phaseB', 100);

  return locationNames;
}

async function executePhaseC(ctx: PhaseContext): Promise<string> {
  ctx.options.onProgress('phaseC', 0);

  const playerProfile = buildPlayerProfileString(ctx);
  // C-1: NSFW private-profile section is pack-resident content (engine/content separation —
  // the Chinese 私密信息 field text lives in the pack, not in engine code). When nsfwMode is on,
  // inject the pack's openingEnhancedCNsfw fragment so the AI generates the 私密信息 nested object;
  // otherwise leave it empty (and strip any 私密信息 below).
  let nsfwSection = '';
  if (ctx.options.nsfwMode) {
    nsfwSection = ctx.gamePack.prompts['openingEnhancedCNsfw'] ?? '';
    if (!nsfwSection) {
      // I-3: make the degradation observable — without the pack fragment the AI generates NPCs
      // with no 私密信息, forcing Phase G PrivacyProfileRepair to backfill every one of them.
      console.warn('[EnhancedOpening] Phase C: nsfwMode=true but "openingEnhancedCNsfw" prompt is missing/empty in the pack — NPCs will be generated without private profiles; Phase G PrivacyProfileRepair will have to backfill all of them.');
    }
  }
  const variables: Record<string, string> = {
    WORLD_DESCRIPTION: ctx.worldDescription,
    LOCATIONS_LIST: ctx.locationNames.join('、'),
    PLAYER_PROFILE: playerProfile,
    NPC_MIN: String(ctx.options.settings.npcRange[0]),
    NPC_MAX: String(ctx.options.settings.npcRange[1]),
    NSFW_SECTION: nsfwSection,
  };

  const { messages, generationId } = assembleFlowMessages(
    'openingEnhancedC', ctx.gamePack, ctx.promptAssembler, variables,
  );

  const rawResponse = await ctx.aiService.generate({
    messages,
    stream: false,
    usageType: 'world_generation',
    signal: ctx.options.abortSignal,
    generationId,
  });

  emitPromptResponseDebug({
    flow: 'openingEnhancedC',
    generationId,
    thinking: extractThinkingFromRaw(rawResponse),
    rawResponse,
  });

  const parsed = extractJSON(rawResponse, 'Phase C');
  const npcs = validateNpcs(parsed);

  for (const npc of npcs) {
    // C-1: only strip 私密信息 when NSFW is off. When on, keep the AI-generated private profile;
    // Phase G PrivacyProfileRepair backfills any fields the AI left incomplete.
    if (!ctx.options.nsfwMode) {
      delete npc['私密信息'];
    }
    if (!Array.isArray(npc['记忆'])) npc['记忆'] = [];
    if (!Array.isArray(npc['关系网变量'])) npc['关系网变量'] = [];

    ctx.stateManager.push(ctx.paths.relationships, npc, 'system');
  }

  // C-2: Phase C bypasses CommandExecutor (direct stateManager.push), so the
  // relationship merge guard never sees these writes. Fuse any duplicate 名称
  // here — batch-internal (AI returned the same name twice) or vs entries
  // already in the tree — instead of letting a second entry survive.
  const relArr = ctx.stateManager.get<Record<string, unknown>[]>(ctx.paths.relationships);
  if (Array.isArray(relArr)) {
    const mergeResult = mergeDuplicateNpcArray(relArr, ctx.paths.npcFieldNames);
    if (mergeResult.mergedCount > 0) {
      ctx.stateManager.set(ctx.paths.relationships, mergeResult.result, 'system');
      console.log(
        `[EnhancedOpening] Phase C: fused ${mergeResult.mergedCount} duplicate NPC entr(ies): ` +
        mergeResult.mergedNames.join('、'),
      );
    }
  }

  const npcSummaryList = npcs
    .map((n) => `${n['名称']}（${n['描述'] ?? ''}）`)
    .join('、');

  ctx.options.onProgress('phaseC', 100);
  return npcSummaryList;
}

async function executePhaseD(ctx: PhaseContext): Promise<NormalizedKnowledgeFact[]> {
  ctx.options.onProgress('phaseD', 0);

  const playerName = ctx.stateManager.get<string>(ctx.paths.playerName) ?? '';
  const playerDesc = ctx.stateManager.get<string>(ctx.paths.characterDescription) ?? '';

  const variables: Record<string, string> = {
    WORLD_DESCRIPTION: ctx.worldDescription,
    NPC_SUMMARY_LIST: ctx.npcSummaryList,
    LOCATIONS_LIST: ctx.locationNames.join('、'),
    PLAYER_NAME: playerName,
    PLAYER_DESCRIPTION: playerDesc,
    EDGE_MIN: String(ctx.options.settings.edgeRange[0]),
    EDGE_MAX: String(ctx.options.settings.edgeRange[1]),
    // M-1: relationship-network density (sparse/medium/dense, from D22 advanced settings).
    // Engine passes the raw enum token; the pack prompt (openingEnhancedD.md) explains each
    // level and references {{RELATION_DENSITY}} — keeps density semantics on the pack side.
    RELATION_DENSITY: ctx.options.settings.relationDensity,
  };

  const { messages, generationId } = assembleFlowMessages(
    'openingEnhancedD', ctx.gamePack, ctx.promptAssembler, variables,
  );

  const rawResponse = await ctx.aiService.generate({
    messages,
    stream: false,
    usageType: 'world_generation',
    signal: ctx.options.abortSignal,
    generationId,
  });

  emitPromptResponseDebug({
    flow: 'openingEnhancedD',
    generationId,
    thinking: extractThinkingFromRaw(rawResponse),
    rawResponse,
  });

  const parsed = extractJSON(rawResponse, 'Phase D');
  const rawFacts = validateKnowledgeFacts(parsed);
  const normalized = normalizeKnowledgeFacts(rawFacts);

  ctx.options.onProgress('phaseD', 100);
  return normalized;
}

// ═══════════════════════════════════════════════════════════════
//  Player profile string builder
// ═══════════════════════════════════════════════════════════════

function buildPlayerProfileString(ctx: PhaseContext): string {
  const settled: Record<string, number> = {};
  for (const attr of Object.keys(ctx.options.choices.attributes ?? {})) {
    const value = ctx.stateManager.get<unknown>(`${ctx.paths.characterAttributes}.${attr}`);
    if (typeof value === 'number') settled[attr] = value;
  }
  return formatSettledPlayerProfile(ctx.gamePack, ctx.options.choices, settled);
}

function buildWorldSelectionString(ctx: PhaseContext): string {
  return formatWorldContext(ctx.gamePack, ctx.options.choices);
}

// ═══════════════════════════════════════════════════════════════
//  Main orchestrator class
// ═══════════════════════════════════════════════════════════════

export class EnhancedOpeningPipeline {
  // Impl-Phase 2: will become private once Phase E/F/G code uses them internally
  readonly gameOrchestrator: { runPostRoundForOpening: (ctx: PipelineContext, sm: StateManager) => Promise<void> };
  readonly stages: OpeningStages;

  constructor(
    private stateManager: StateManager,
    private aiService: AIService,
    private promptAssembler: PromptAssembler,
    private gamePack: GamePack,
    gameOrchestrator: { runPostRoundForOpening: (ctx: PipelineContext, sm: StateManager) => Promise<void> },
    stages: OpeningStages,
    private paths: EnginePathConfig,
  ) {
    this.gameOrchestrator = gameOrchestrator;
    this.stages = stages;
  }

  async execute(options: EnhancedOpeningOptions): Promise<EnhancedOpeningResult> {
    const baselineSnapshot = this.stateManager.toSnapshot();
    const phasesCompleted: string[] = [];

    // CR-3.2: Bypass rate limiting during opening if configured
    const savedRlEnabled = this.aiService.rateLimiterEnabled;
    if (options.settings.bypassRateLimitDuringOpening && savedRlEnabled) {
      this.aiService.configureRateLimiter({ enabled: false });
    }

    // CR-3.3: Wire rate-limit toast events to progress UI
    let rateLimitCleanup: (() => void) | null = null;
    if (options.onRateLimitWait) {
      const handler = (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Record<string, unknown>;
        if (p.id !== 'rate-limiter-queue') return;
        const params = p.i18nParams as Record<string, unknown> | undefined;
        const seconds = typeof params?.seconds === 'number' ? params.seconds : null;
        rateLimitActive = true;
        options.onRateLimitWait?.(seconds);
      };
      eventBus.on('ui:toast', handler);
      rateLimitCleanup = () => eventBus.off('ui:toast', handler);
    }

    // Wrap onProgress to clear rate-limit wait state on phase transitions.
    // Note: rateLimitCleanup in the finally block depends on all error paths exiting
    // through execute()'s try/catch — if runPhase is ever extracted, this must be revisited.
    let rateLimitActive = false;
    const originalOnProgress = options.onProgress;
    const wrappedOnProgress = (phase: string, progress: number) => {
      if (rateLimitActive) {
        rateLimitActive = false;
        options.onRateLimitWait?.(null);
      }
      originalOnProgress(phase, progress);
    };
    const effectiveOptions: EnhancedOpeningOptions = { ...options, onProgress: wrappedOnProgress };

    const phaseCtx: PhaseContext = {
      stateManager: this.stateManager,
      aiService: this.aiService,
      promptAssembler: this.promptAssembler,
      gamePack: this.gamePack,
      paths: this.paths,
      options: effectiveOptions,
      worldDescription: '',
      locationNames: [],
      npcSummaryList: '',
      openingFacts: [],
    };

    const phaseActions: Record<string, PhaseErrorAction[]> = {
      A: ['retry', 'exit'],
      B: ['retry', 'rollback', 'exit'],
      C: ['retry', 'rollback', 'exit'],
      D: ['retry', 'rollback', 'exit'],
      E: ['retry', 'exit'],
      F: ['retry', 'exit'],
      G: ['retry', 'exit'],
    };

    const runPhase = async <T>(
      phase: string,
      fn: () => Promise<T>,
      rollbackSnapshot?: Record<string, unknown>,
    ): Promise<T> => {
      while (true) {
        try {
          return await fn();
        } catch (err) {
          if (isAbortError(err)) throw err;

          if (!options.onPhaseError) throw err;

          const actions = [...(phaseActions[phase] ?? ['retry', 'exit'])];

          const action = await options.onPhaseError({
            phase,
            reason: err instanceof Error ? err.message : String(err),
            availableActions: actions,
          });

          if (action === 'retry') {
            continue;
          }
          if (action === 'rollback' && rollbackSnapshot) {
            this.stateManager.loadTree(rollbackSnapshot);
            throw err;
          }
          throw err;
        }
      }
    };

    try {
      // ── Phase A ──
      phaseCtx.worldDescription = await runPhase('A', () => executePhaseA(phaseCtx));
      const snapAfterA = this.stateManager.toSnapshot();
      phasesCompleted.push('A');

      // ── Phase B ──
      phaseCtx.locationNames = await runPhase('B', () => executePhaseB(phaseCtx), snapAfterA);
      const snapAfterB = this.stateManager.toSnapshot();
      phasesCompleted.push('B');

      // ── Phase C ──
      phaseCtx.npcSummaryList = await runPhase('C', () => executePhaseC(phaseCtx), snapAfterB);
      phasesCompleted.push('C');

      // ── Phase D ──
      phaseCtx.openingFacts = await runPhase('D', () => executePhaseD(phaseCtx));
      phasesCompleted.push('D');

      // ── Phase E ──
      effectiveOptions.onProgress('phaseE', 0);
      const phaseEResult = await runPhase('E', () => this.executePhaseE(phaseCtx));
      phasesCompleted.push('E');

      // ── Phase F ──
      effectiveOptions.onProgress('phaseF', 0);
      const phaseFCtx = await runPhase('F', () => this.executePhaseF(phaseCtx, phaseEResult));
      phasesCompleted.push('F');
      effectiveOptions.onProgress('phaseF', 100);

      // ── Phase G ──
      effectiveOptions.onProgress('phaseG', 0);
      await runPhase('G', () => this.gameOrchestrator.runPostRoundForOpening(phaseFCtx, this.stateManager));
      phasesCompleted.push('G');
      effectiveOptions.onProgress('phaseG', 100);

      const actionOpts = this.stateManager.get<string[]>('元数据.当前行动选项') ?? [];

      return {
        success: true,
        phasesCompleted,
        actionOptions: actionOpts,
      };
    } catch (err) {
      this.stateManager.loadTree(baselineSnapshot);

      if (isAbortError(err)) {
        return {
          success: false,
          cancelled: true,
          phasesCompleted,
          actionOptions: [],
        };
      }

      return {
        success: false,
        phasesCompleted,
        phasesFailed: getFailedPhase(phasesCompleted),
        failureReason: err instanceof Error ? err.message : String(err),
        actionOptions: [],
      };
    } finally {
      // CR-3.2: Restore rate limiter to its original state
      if (options.settings.bypassRateLimitDuringOpening && savedRlEnabled) {
        this.aiService.configureRateLimiter({ enabled: true });
      }
      // CR-3.3: Remove rate-limit toast listener
      rateLimitCleanup?.();
    }
  }

  /**
   * Story 6 card import — generate the opening narrative on a state tree that ALREADY
   * holds the card's world. Runs ONLY Phase E (narrative) → F (persist + postprocess) → G
   * (post-round sub-pipelines, writes 元数据.当前行动选项), skipping the from-scratch A–D
   * world generation.
   *
   * Why no world reconstruction is needed: Phase E generates from `stateManager.toSnapshot()`
   * (the card's populated tree), not from `phaseCtx.worldDescription/npcSummaryList` (those are
   * only passed between A–D). `openingFacts` is [] — the card's engram is already written into
   * the tree by the import pipeline (P3), so it is NOT re-injected here. `options.choices` is
   * unused by E–F–G (only A–D read it); the caller passes an empty CreationChoices.
   *
   * On any failure the tree is rolled back to the pre-opening baseline. This method does NOT
   * touch the creation-flow `execute` above (zero regression risk to character creation).
   */
  async executeImportOpening(options: EnhancedOpeningOptions): Promise<EnhancedOpeningResult> {
    const baselineSnapshot = this.stateManager.toSnapshot();
    const phasesCompleted: string[] = [];

    const savedRlEnabled = this.aiService.rateLimiterEnabled;
    if (options.settings.bypassRateLimitDuringOpening && savedRlEnabled) {
      this.aiService.configureRateLimiter({ enabled: false });
    }

    let rateLimitActive = false;
    let rateLimitCleanup: (() => void) | null = null;
    if (options.onRateLimitWait) {
      const handler = (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Record<string, unknown>;
        if (p.id !== 'rate-limiter-queue') return;
        const params = p.i18nParams as Record<string, unknown> | undefined;
        const seconds = typeof params?.seconds === 'number' ? params.seconds : null;
        rateLimitActive = true;
        options.onRateLimitWait?.(seconds);
      };
      eventBus.on('ui:toast', handler);
      rateLimitCleanup = () => eventBus.off('ui:toast', handler);
    }
    const wrappedOnProgress = (phase: string, progress: number) => {
      if (rateLimitActive) { rateLimitActive = false; options.onRateLimitWait?.(null); }
      options.onProgress(phase, progress);
    };
    const effectiveOptions: EnhancedOpeningOptions = { ...options, onProgress: wrappedOnProgress };

    const phaseCtx: PhaseContext = {
      stateManager: this.stateManager,
      aiService: this.aiService,
      promptAssembler: this.promptAssembler,
      gamePack: this.gamePack,
      paths: this.paths,
      options: effectiveOptions,
      worldDescription: '',  // unused by E–F–G (Phase E reads the world from the state snapshot)
      locationNames: [],
      npcSummaryList: '',
      openingFacts: [],      // card engram already in the tree (import P3) — do not re-inject
    };

    let runningPhase = '';
    const runPhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
      runningPhase = phase;
      while (true) {
        try {
          return await fn();
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (!options.onPhaseError) throw err;
          const action = await options.onPhaseError({
            phase,
            reason: err instanceof Error ? err.message : String(err),
            availableActions: ['retry', 'exit'],
          });
          if (action === 'retry') continue;
          throw err;
        }
      }
    };

    try {
      effectiveOptions.onProgress('phaseE', 0);
      const phaseEResult = await runPhase('E', () => this.executePhaseE(phaseCtx));
      phasesCompleted.push('E');

      effectiveOptions.onProgress('phaseF', 0);
      const phaseFCtx = await runPhase('F', () => this.executePhaseF(phaseCtx, phaseEResult));
      phasesCompleted.push('F');
      effectiveOptions.onProgress('phaseF', 100);

      effectiveOptions.onProgress('phaseG', 0);
      await runPhase('G', () => this.gameOrchestrator.runPostRoundForOpening(phaseFCtx, this.stateManager));
      phasesCompleted.push('G');
      effectiveOptions.onProgress('phaseG', 100);

      const actionOpts = this.stateManager.get<string[]>('元数据.当前行动选项') ?? [];
      return { success: true, phasesCompleted, actionOptions: actionOpts };
    } catch (err) {
      this.stateManager.loadTree(baselineSnapshot);
      if (isAbortError(err)) {
        return { success: false, cancelled: true, phasesCompleted, actionOptions: [] };
      }
      return {
        success: false,
        phasesCompleted,
        phasesFailed: runningPhase || undefined,
        failureReason: err instanceof Error ? err.message : String(err),
        actionOptions: [],
      };
    } finally {
      if (options.settings.bypassRateLimitDuringOpening && savedRlEnabled) {
        this.aiService.configureRateLimiter({ enabled: true });
      }
      rateLimitCleanup?.();
    }
  }

  /**
   * Phase E: manual splitGen — ContextAssembly + AICall + BodyPolish.
   * Skips PreProcess (avoids roundNumber 0→1), ResponseRepair, ReasoningIngest, Render.
   */
  private async executePhaseE(phaseCtx: PhaseContext): Promise<PhaseEResult> {
    const aiCallStartedAt = performance.now();

    // Build PipelineContext for ContextAssembly + AICall
    let ctx: PipelineContext = {
      userInput: '',
      actionQueuePrompt: '',
      stateSnapshot: this.stateManager.toSnapshot(),
      chatHistory: [],
      messages: [],
      roundNumber: 0,
      generationId: `enhancedOpening_E_${Date.now()}`,
      worldEventTriggered: false,
      onStreamChunk: phaseCtx.options.onStreamChunk,
      abortSignal: phaseCtx.options.abortSignal,
      onProgress: (msg) => {
        if (typeof msg === 'string') phaseCtx.options.onProgress('phaseE', 50);
      },
      meta: {
        splitGen: true,
        isEnhancedOpening: true,
        step1FlowOverride: 'openingEnhancedStep1',
        step2FlowOverride: 'openingEnhancedStep2',
        // D7: author opening-style hint (card import only) → surfaced to the E1 prompt
        // via the OPENING_SETUP_HINT variable. Empty for new-game openings.
        openingSetupHint: phaseCtx.options.firstRoundSetup?.trim() ?? '',
      },
    };

    // ContextAssembly: assembles messages using the flow overrides
    ctx = await this.stages.contextAssembly.execute(ctx);

    // AICall: executes splitGen step1 (streaming) + step2 (non-streaming)
    ctx = await this.stages.aiCall.execute(ctx);

    // BodyPolish: polishes E1 narrative text (no-op if bodyPolish=false)
    ctx = await this.stages.bodyPolish.execute(ctx);

    const aiCallDurationMs = performance.now() - aiCallStartedAt;

    // E2 knowledge_facts discard (immutable): if AI still output them, drop before Phase F
    if (ctx.parsedResponse?.knowledgeFacts) {
      ctx = { ...ctx, parsedResponse: { ...ctx.parsedResponse, knowledgeFacts: undefined } };
    }

    phaseCtx.options.onProgress('phaseE', 100);

    return {
      ctx,
      aiCallStartedAt,
      aiCallDurationMs,
    };
  }

  /**
   * Phase F: construct synthetic parsedResponse, run CommandExecution + PostProcess.
   * Injects Phase D openingFacts into knowledgeFacts so Engram processes them.
   */
  private async executePhaseF(
    phaseCtx: PhaseContext,
    phaseE: PhaseEResult,
  ): Promise<PipelineContext> {
    let ctx = phaseE.ctx;

    if (!ctx.parsedResponse) {
      throw new Error('[EnhancedOpening] Phase F: parsedResponse absent after Phase E — cannot inject openingFacts or persist narrative');
    }

    // Immutable injection: Phase D knowledge_facts + timing metadata
    ctx = {
      ...ctx,
      parsedResponse: {
        ...ctx.parsedResponse,
        knowledgeFacts: phaseCtx.openingFacts.length > 0
          ? phaseCtx.openingFacts
          : ctx.parsedResponse.knowledgeFacts,
      },
      aiCallStartedAt: phaseE.aiCallStartedAt,
      aiCallDurationMs: phaseE.aiCallDurationMs,
    };

    // CommandExecutionStage
    ctx = await this.stages.commandExecution.execute(ctx);

    // PostProcessStage (isEnhancedOpening=true → skips user entry)
    ctx = await this.stages.postProcess.execute(ctx);

    return ctx;
  }
}

interface PhaseEResult {
  ctx: PipelineContext;
  aiCallStartedAt: number;
  aiCallDurationMs: number;
}

function getFailedPhase(completed: string[]): string {
  const allPhases = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  for (const p of allPhases) {
    if (!completed.includes(p)) return p;
  }
  return 'unknown';
}
