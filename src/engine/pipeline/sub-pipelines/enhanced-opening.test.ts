/**
 * Enhanced Opening Pipeline unit tests — covers §6.1 test plan from
 * docs/plans/story-0-enhanced-opening-implementation.md.
 *
 * Test categories:
 * 1. Phase A-D prompt output structure (mock AI → JSON parse + state write)
 * 2. Synthetic parsedResponse injection (Phase D facts → knowledgeFacts)
 * 3. Toggle routing (enhancedOpening=true → orchestrator)
 * 4. Phase failure + Rollback (loadTree(baselineSnapshot))
 * 5. C7 roundNumber stays 0
 * 6. E2 knowledge_facts discard
 * 7. Rate-limit bypass (configureRateLimiter save/restore)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EnhancedOpeningPipeline,
  DEFAULT_ENHANCED_OPENING_SETTINGS,
  type EnhancedOpeningOptions,
  type EnhancedOpeningSettings,
  type OpeningStages,
  type NormalizedKnowledgeFact,
} from './enhanced-opening';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import type { PipelineContext } from '@/engine/pipeline/types';

// ── Mock prompt-debug (avoid side-effects) ──────────────────────
vi.mock('../../core/prompt-debug', () => ({
  emitPromptAssemblyDebug: vi.fn(),
  emitPromptResponseDebug: vi.fn(),
  extractThinkingFromRaw: vi.fn(() => null),
}));

// ── Mock event-bus ──────────────────────────────────────────────
const mockEventBusOn = vi.fn();
const mockEventBusOff = vi.fn();
vi.mock('../../core/event-bus', () => ({
  eventBus: {
    on: (...args: unknown[]) => mockEventBusOn(...args),
    off: (...args: unknown[]) => mockEventBusOff(...args),
    emit: vi.fn(),
  },
}));

// ═══════════════════════════════════════════════════════════════
//  Mock fixtures
// ═══════════════════════════════════════════════════════════════

const PHASE_A_RESPONSE = '这是一个古老的修仙世界，灵气充沛，宗门林立。';

const PHASE_B_RESPONSE = JSON.stringify({
  locations: [
    { '名称': '青云镇', '描述': '一个宁静的小镇', '类型': '城镇' },
    { '名称': '玄天峰', '描述': '高耸入云的山峰', '类型': '山脉' },
  ],
  inventory: [
    { '名称': '木剑', '描述': '朴素的木制长剑' },
  ],
});

const PHASE_C_RESPONSE = JSON.stringify({
  npcs: [
    { '名称': '张三', '描述': '镇上的铁匠', '记忆': [], '关系网变量': [] },
    { '名称': '李四', '描述': '行脚商人', '记忆': [], '关系网变量': [] },
  ],
});

const PHASE_D_RESPONSE = JSON.stringify({
  knowledge_facts: [
    { fact: '张三与李四是旧识', source_entity: '张三', target_entity: '李四' },
    { fact: '青云镇是修仙起点', source_entity: '青云镇', target_entity: '玩家' },
  ],
});

interface MockStateManager {
  toSnapshot: ReturnType<typeof vi.fn>;
  loadTree: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
}

function makeStateManager(pathMap: Record<string, unknown> = {}): MockStateManager {
  const baseline = { _snapshot: 'baseline' };
  let snapCounter = 0;
  return {
    toSnapshot: vi.fn(() => ({ ...baseline, _snap: snapCounter++ })),
    loadTree: vi.fn(),
    get: vi.fn((path: string) => pathMap[path]),
    set: vi.fn(),
    push: vi.fn(),
  };
}

function makeAiService(responses: string[]): {
  generate: ReturnType<typeof vi.fn>;
  configureRateLimiter: ReturnType<typeof vi.fn>;
  rateLimiterEnabled: boolean;
  _rlEnabled: boolean;
} {
  const queue = [...responses];
  const svc = {
    _rlEnabled: false,
    generate: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('[test] AI generate called more times than responses supplied');
      return next;
    }),
    configureRateLimiter: vi.fn(),
    get rateLimiterEnabled() { return svc._rlEnabled; },
  };
  return svc;
}

function makePromptAssembler(): { assemble: ReturnType<typeof vi.fn> } {
  return { assemble: vi.fn(() => ({ messages: [], messageSources: [] })) };
}

const NSFW_SECTION_FIXTURE = '   - **私密信息**（NSFW 模式已开启，必填）— 嵌套对象，含身体部位/性取向/性渴望程度等字段。';

function makeGamePack(): Record<string, unknown> {
  return {
    promptFlows: {
      openingEnhancedA: { id: 'openingEnhancedA', modules: [] },
      openingEnhancedB: { id: 'openingEnhancedB', modules: [] },
      openingEnhancedC: { id: 'openingEnhancedC', modules: [] },
      openingEnhancedD: { id: 'openingEnhancedD', modules: [] },
      openingEnhancedStep1: { id: 'openingEnhancedStep1', modules: [] },
      openingEnhancedStep2: { id: 'openingEnhancedStep2', modules: [] },
    },
    // GamePack.prompts is a non-optional Record<string,string> at runtime (pack-loader fills it).
    // C-1: the NSFW private-profile fragment is pack-resident; engine reads it for Phase C.
    prompts: {
      openingEnhancedCNsfw: NSFW_SECTION_FIXTURE,
    },
  };
}

function makeStages(): {
  stages: OpeningStages;
  phaseEParsedResponse: Record<string, unknown>;
} {
  const phaseEParsedResponse: Record<string, unknown> = {
    text: '清晨的阳光穿过竹帘...',
    commands: [{ action: 'set', path: '世界.时间.小时', value: 8 }],
    actionOptions: ['探索', '修炼', '对话'],
    knowledgeFacts: undefined,
  };

  const stages = {
    contextAssembly: {
      execute: vi.fn(async (ctx: PipelineContext) => ({
        ...ctx,
        messages: [{ role: 'system' as const, content: 'test' }],
      })),
    },
    aiCall: {
      execute: vi.fn(async (ctx: PipelineContext) => ({
        ...ctx,
        parsedResponse: { ...phaseEParsedResponse },
        rawResponse: '清晨的阳光穿过竹帘...',
      })),
    },
    bodyPolish: {
      execute: vi.fn(async (ctx: PipelineContext) => ctx),
    },
    commandExecution: {
      execute: vi.fn(async (ctx: PipelineContext) => ctx),
    },
    postProcess: {
      execute: vi.fn(async (ctx: PipelineContext) => ctx),
    },
  } as unknown as OpeningStages;

  return { stages, phaseEParsedResponse };
}

function makeOrchestrator(): { runPostRoundForOpening: ReturnType<typeof vi.fn> } {
  return { runPostRoundForOpening: vi.fn(async () => {}) };
}

function makeDefaultOptions(overrides: Partial<EnhancedOpeningOptions> = {}): EnhancedOpeningOptions {
  return {
    settings: { ...DEFAULT_ENHANCED_OPENING_SETTINGS },
    nsfwMode: false,
    choices: { selections: {}, attributes: {}, formValues: {} },
    abortSignal: new AbortController().signal,
    onProgress: vi.fn(),
    onStreamChunk: vi.fn(),
    onPhaseError: undefined,
    ...overrides,
  };
}

function makePipeline(deps: {
  sm?: MockStateManager;
  ai?: ReturnType<typeof makeAiService>;
  pa?: ReturnType<typeof makePromptAssembler>;
  gp?: Record<string, unknown>;
  go?: ReturnType<typeof makeOrchestrator>;
  stages?: OpeningStages;
} = {}): {
  pipeline: EnhancedOpeningPipeline;
  sm: MockStateManager;
  ai: ReturnType<typeof makeAiService>;
  go: ReturnType<typeof makeOrchestrator>;
  stages: OpeningStages;
} {
  const sm = deps.sm ?? makeStateManager({
    [DEFAULT_ENGINE_PATHS.playerName]: '测试角色',
    [DEFAULT_ENGINE_PATHS.characterGender]: '男',
    [DEFAULT_ENGINE_PATHS.characterDescription]: '一个普通人',
  });
  const ai = deps.ai ?? makeAiService([
    PHASE_A_RESPONSE,
    PHASE_B_RESPONSE,
    PHASE_C_RESPONSE,
    PHASE_D_RESPONSE,
  ]);
  const pa = deps.pa ?? makePromptAssembler();
  const gp = deps.gp ?? makeGamePack();
  const go = deps.go ?? makeOrchestrator();
  const { stages } = deps.stages ? { stages: deps.stages } : makeStages();

  const pipeline = new EnhancedOpeningPipeline(
    sm as never,
    ai as never,
    pa as never,
    gp as never,
    go as never,
    stages,
    DEFAULT_ENGINE_PATHS,
  );

  return { pipeline, sm, ai, go, stages };
}

// ═══════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Phase A-D output structure and state writes', () => {
  it('Phase A writes world description to correct path', async () => {
    const { pipeline, sm } = makePipeline();
    await pipeline.execute(makeDefaultOptions());

    expect(sm.set).toHaveBeenCalledWith(
      DEFAULT_ENGINE_PATHS.worldDescription,
      PHASE_A_RESPONSE,
      'system',
    );
  });

  it('injects the same narrative-only player profile into phases A, B, and C', async () => {
    const pa = makePromptAssembler();
    const sm = makeStateManager({
      [DEFAULT_ENGINE_PATHS.playerName]: 'Mira',
      [`${DEFAULT_ENGINE_PATHS.characterAttributes}.STR`]: 10,
    });
    const gp = {
      ...makeGamePack(),
      creationFlow: {
        steps: [
          { id: 'world', label: 'World', type: 'select-one', dataSource: 'presets.worlds' },
          { id: 'tier', label: 'Tier', type: 'select-one', dataSource: 'presets.talentTiers' },
          { id: 'origin', label: 'Origin', type: 'select-one', dataSource: 'presets.origins' },
          { id: 'trait', label: 'Trait', type: 'select-one', dataSource: 'presets.traits' },
          { id: 'talents', label: 'Talents', type: 'select-many', dataSource: 'presets.talents' },
        ],
      },
    };
    const choices = {
      selections: {
        world: { name: 'World Nine', description: 'Canonical world text', genre: 'fantasy', contentRating: 'general' },
        tier: { name: 'Twenty', total_points: 20 },
        origin: { name: 'Courier', description: 'Knows the roads', talent_cost: 7, genres: ['fantasy'], attribute_modifiers: { STR: 2 } },
        trait: { name: 'Calm', description: 'Keeps focus', talent_cost: 5, adultOnly: false },
        talents: [{ name: 'Alert', description: 'Notices danger', talent_cost: 3 }],
      },
      attributes: { STR: 8 },
      formValues: { name: 'Mira' },
    };
    const { pipeline } = makePipeline({ pa, sm, gp });

    await pipeline.execute(makeDefaultOptions({ choices }));

    const phaseVars = ['openingEnhancedA', 'openingEnhancedB', 'openingEnhancedC'].map((id) => {
      const call = pa.assemble.mock.calls.find((args: unknown[]) => (args[0] as { id?: string })?.id === id);
      return call?.[1] as Record<string, string>;
    });
    const profiles = phaseVars.map((variables) => variables.PLAYER_PROFILE);
    expect(new Set(profiles).size).toBe(1);
    expect(profiles[0]).toContain('Courier');
    expect(profiles[0]).toContain('Knows the roads');
    expect(profiles[0]).toContain('STR 10');
    expect(profiles[0]).not.toMatch(/talent_cost|attribute_modifiers|genres|adultOnly|total_points/);
    expect(phaseVars[0].WORLD_SELECTION).toContain('Canonical world text');
    expect(phaseVars[0].WORLD_SELECTION).not.toMatch(/genre|contentRating/);
  });

  it('Phase B writes locations and inventory via push', async () => {
    const { pipeline, sm } = makePipeline();
    await pipeline.execute(makeDefaultOptions());

    const pushCalls = sm.push.mock.calls;
    const locationPushes = pushCalls.filter(
      (c: unknown[]) => c[0] === DEFAULT_ENGINE_PATHS.locations,
    );
    const inventoryPushes = pushCalls.filter(
      (c: unknown[]) => c[0] === DEFAULT_ENGINE_PATHS.inventoryItems,
    );

    expect(locationPushes).toHaveLength(2);
    expect(locationPushes[0][1]).toHaveProperty('名称', '青云镇');
    expect(locationPushes[1][1]).toHaveProperty('名称', '玄天峰');
    expect(inventoryPushes).toHaveLength(1);
    expect(inventoryPushes[0][1]).toHaveProperty('名称', '木剑');
  });

  it('Phase C writes NPC profiles via push with forced empty arrays', async () => {
    const { pipeline, sm } = makePipeline();
    await pipeline.execute(makeDefaultOptions());

    const npcPushes = sm.push.mock.calls.filter(
      (c: unknown[]) => c[0] === DEFAULT_ENGINE_PATHS.relationships,
    );

    expect(npcPushes).toHaveLength(2);
    const npc1 = npcPushes[0][1] as Record<string, unknown>;
    expect(npc1['名称']).toBe('张三');
    expect(npc1['记忆']).toEqual([]);
    expect(npc1['关系网变量']).toEqual([]);
  });

  it('Phase C strips 私密信息 when nsfwMode=false', async () => {
    const npcWithNsfw = JSON.stringify({
      npcs: [{ '名称': '王五', '描述': '...', '私密信息': { sensitive: true } }],
    });
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, npcWithNsfw, PHASE_D_RESPONSE]);
    const { pipeline, sm } = makePipeline({ ai });

    await pipeline.execute(makeDefaultOptions({ nsfwMode: false }));

    const npcPushes = sm.push.mock.calls.filter(
      (c: unknown[]) => c[0] === DEFAULT_ENGINE_PATHS.relationships,
    );
    const npc = npcPushes[0][1] as Record<string, unknown>;
    expect(npc).not.toHaveProperty('私密信息');
  });

  it('Phase C injects NSFW section and retains 私密信息 when nsfwMode=true (C-1)', async () => {
    const npcWithNsfw = JSON.stringify({
      npcs: [{ '名称': '王五', '描述': '...', '私密信息': { '是否为处女/处男': true } }],
    });
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, npcWithNsfw, PHASE_D_RESPONSE]);
    const pa = makePromptAssembler();
    const { pipeline, sm } = makePipeline({ ai, pa });

    await pipeline.execute(makeDefaultOptions({ nsfwMode: true }));

    // (a) NSFW_SECTION variable is non-empty (pack fragment injected) for Phase C
    const cCall = pa.assemble.mock.calls.find(
      (c: unknown[]) => (c[0] as { id?: string })?.id === 'openingEnhancedC',
    );
    expect(cCall).toBeDefined();
    const cVars = cCall![1] as Record<string, string>;
    // I-2: assert the engine pulled the exact pack fragment through (proves gamePack.prompts wiring,
    // not a tautology against a hardcoded substring).
    expect(cVars.NSFW_SECTION).toBe(NSFW_SECTION_FIXTURE);

    // (b) AI-generated 私密信息 is RETAINED (not stripped) when nsfwMode=true
    const npcPushes = sm.push.mock.calls.filter(
      (c: unknown[]) => c[0] === DEFAULT_ENGINE_PATHS.relationships,
    );
    const npc = npcPushes[0][1] as Record<string, unknown>;
    expect(npc).toHaveProperty('私密信息');
  });

  it('Phase C passes empty NSFW_SECTION when nsfwMode=false (C-1)', async () => {
    const pa = makePromptAssembler();
    const { pipeline } = makePipeline({ pa });

    await pipeline.execute(makeDefaultOptions({ nsfwMode: false }));

    const cCall = pa.assemble.mock.calls.find(
      (c: unknown[]) => (c[0] as { id?: string })?.id === 'openingEnhancedC',
    );
    expect(cCall).toBeDefined();
    const cVars = cCall![1] as Record<string, string>;
    expect(cVars.NSFW_SECTION).toBe('');
  });

  it('Phase D injects relationDensity into prompt variables (M-1)', async () => {
    const pa = makePromptAssembler();
    const { pipeline } = makePipeline({ pa });

    await pipeline.execute(makeDefaultOptions({
      settings: { ...DEFAULT_ENHANCED_OPENING_SETTINGS, relationDensity: 'dense' },
    }));

    const dCall = pa.assemble.mock.calls.find(
      (c: unknown[]) => (c[0] as { id?: string })?.id === 'openingEnhancedD',
    );
    expect(dCall).toBeDefined();
    const dVars = dCall![1] as Record<string, string>;
    expect(dVars.RELATION_DENSITY).toBe('dense');
  });

  it('Phase D extracts and normalizes knowledge_facts', async () => {
    const { pipeline } = makePipeline();
    const result = await pipeline.execute(makeDefaultOptions());

    expect(result.success).toBe(true);
    expect(result.phasesCompleted).toContain('D');
  });

  it('Phase A rejects empty world description', async () => {
    const ai = makeAiService(['', PHASE_B_RESPONSE, PHASE_C_RESPONSE, PHASE_D_RESPONSE]);
    const { pipeline, sm } = makePipeline({ ai });

    const result = await pipeline.execute(makeDefaultOptions());

    expect(result.success).toBe(false);
    expect(result.failureReason).toContain('empty world description');
    expect(sm.loadTree).toHaveBeenCalled();
  });

  it('Phase B rejects missing locations field', async () => {
    const badB = JSON.stringify({ inventory: [] });
    const ai = makeAiService([PHASE_A_RESPONSE, badB, PHASE_C_RESPONSE, PHASE_D_RESPONSE]);
    const { pipeline } = makePipeline({ ai });

    const result = await pipeline.execute(makeDefaultOptions());

    expect(result.success).toBe(false);
    expect(result.phasesFailed).toBe('B');
  });

  it('Phase D rejects empty knowledge_facts', async () => {
    const badD = JSON.stringify({ knowledge_facts: [] });
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, PHASE_C_RESPONSE, badD]);
    const { pipeline } = makePipeline({ ai });

    const result = await pipeline.execute(makeDefaultOptions());

    expect(result.success).toBe(false);
    expect(result.phasesFailed).toBe('D');
  });
});

describe('Synthetic parsedResponse injection (Phase D → Phase F)', () => {
  it('Phase F receives Phase D knowledgeFacts in parsedResponse', async () => {
    const { stages: mockStages } = makeStages();
    const { pipeline } = makePipeline({ stages: mockStages });

    await pipeline.execute(makeDefaultOptions());

    const postProcessCalls = (mockStages.postProcess.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(postProcessCalls.length).toBeGreaterThan(0);

    const phaseFCtx = postProcessCalls[0][0] as PipelineContext;
    expect(phaseFCtx.parsedResponse).toBeDefined();

    const facts = phaseFCtx.parsedResponse!.knowledgeFacts as NormalizedKnowledgeFact[];
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({
      fact: '张三与李四是旧识',
      sourceEntity: '张三',
      targetEntity: '李四',
    });
    expect(facts[1]).toEqual({
      fact: '青云镇是修仙起点',
      sourceEntity: '青云镇',
      targetEntity: '玩家',
    });
  });
});

describe('Phase failure + Rollback', () => {
  it('restores baseline snapshot when Phase C fails', async () => {
    const badC = JSON.stringify({ npcs: [] });
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, badC, PHASE_D_RESPONSE]);
    const { pipeline, sm } = makePipeline({ ai });

    const result = await pipeline.execute(makeDefaultOptions());

    expect(result.success).toBe(false);
    expect(result.phasesFailed).toBe('C');
    expect(result.phasesCompleted).toEqual(['A', 'B']);
    // Verify loadTree called with the first snapshot (baseline captured by execute())
    expect(sm.loadTree).toHaveBeenCalledTimes(1);
    const restoredSnapshot = sm.loadTree.mock.calls[0][0];
    expect(restoredSnapshot).toHaveProperty('_snapshot', 'baseline');
  });

  it('restores baseline snapshot on user cancel (AbortError)', async () => {
    const controller = new AbortController();
    const ai = makeAiService([PHASE_A_RESPONSE]);
    ai.generate.mockImplementationOnce(async () => PHASE_A_RESPONSE);
    ai.generate.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    const { pipeline, sm } = makePipeline({ ai });
    const result = await pipeline.execute(makeDefaultOptions({ abortSignal: controller.signal }));

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(sm.loadTree).toHaveBeenCalledTimes(1);
    expect(sm.loadTree.mock.calls[0][0]).toHaveProperty('_snapshot', 'baseline');
  });

  it('rollback action in onPhaseError restores previous phase snapshot', async () => {
    const badC = JSON.stringify({ npcs: [] });
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, badC, PHASE_D_RESPONSE]);
    const { pipeline, sm } = makePipeline({ ai });

    const result = await pipeline.execute(makeDefaultOptions({
      onPhaseError: async () => 'exit',
    }));

    expect(result.success).toBe(false);
    expect(sm.loadTree).toHaveBeenCalled();
  });
});

describe('C7 roundNumber stays 0', () => {
  it('Phase E PipelineContext has roundNumber=0', async () => {
    const { stages: mockStages } = makeStages();
    const { pipeline } = makePipeline({ stages: mockStages });

    await pipeline.execute(makeDefaultOptions());

    const ctxAssemblyCalls = (mockStages.contextAssembly.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(ctxAssemblyCalls.length).toBeGreaterThan(0);

    const ctx = ctxAssemblyCalls[0][0] as PipelineContext;
    expect(ctx.roundNumber).toBe(0);
  });
});

describe('E2 knowledge_facts discard', () => {
  it('strips knowledgeFacts from Phase E output before Phase F', async () => {
    const { stages: mockStages, phaseEParsedResponse } = makeStages();
    // Simulate AI returning knowledge_facts in E2
    phaseEParsedResponse.knowledgeFacts = [
      { fact: 'bogus', sourceEntity: 'x', targetEntity: 'y' },
    ];

    const { pipeline } = makePipeline({ stages: mockStages });
    await pipeline.execute(makeDefaultOptions());

    // Phase F's postProcess should receive Phase D facts, not E2 facts
    const postProcessCalls = (mockStages.postProcess.execute as ReturnType<typeof vi.fn>).mock.calls;
    const phaseFCtx = postProcessCalls[0][0] as PipelineContext;
    const facts = phaseFCtx.parsedResponse!.knowledgeFacts as NormalizedKnowledgeFact[];
    // Should be Phase D's 2 facts, not the bogus E2 fact
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toBe('张三与李四是旧识');
  });
});

describe('Rate-limit bypass (CR-3.2)', () => {
  it('disables rate limiter before execution and restores after', async () => {
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, PHASE_C_RESPONSE, PHASE_D_RESPONSE]);
    ai._rlEnabled = true; // Simulate rate limiter being enabled

    const { pipeline } = makePipeline({ ai });

    const settings: EnhancedOpeningSettings = {
      ...DEFAULT_ENHANCED_OPENING_SETTINGS,
      bypassRateLimitDuringOpening: true,
    };

    await pipeline.execute(makeDefaultOptions({ settings }));

    expect(ai.configureRateLimiter).toHaveBeenCalledWith({ enabled: false });
    expect(ai.configureRateLimiter).toHaveBeenCalledWith({ enabled: true });
    // Verify disable happened before restore
    const calls = ai.configureRateLimiter.mock.calls as Array<[{ enabled: boolean }]>;
    const disableIdx = calls.findIndex(c => c[0].enabled === false);
    const restoreIdx = calls.findIndex(c => c[0].enabled === true);
    expect(disableIdx).toBeLessThan(restoreIdx);
  });

  it('does not touch rate limiter when bypass=false', async () => {
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, PHASE_C_RESPONSE, PHASE_D_RESPONSE]);
    ai._rlEnabled = true;

    const { pipeline } = makePipeline({ ai });
    await pipeline.execute(makeDefaultOptions());

    expect(ai.configureRateLimiter).not.toHaveBeenCalled();
  });

  it('does not restore rate limiter if it was already disabled', async () => {
    const ai = makeAiService([PHASE_A_RESPONSE, PHASE_B_RESPONSE, PHASE_C_RESPONSE, PHASE_D_RESPONSE]);
    ai._rlEnabled = false; // Already disabled

    const { pipeline } = makePipeline({ ai });
    await pipeline.execute(makeDefaultOptions({
      settings: { ...DEFAULT_ENHANCED_OPENING_SETTINGS, bypassRateLimitDuringOpening: true },
    }));

    expect(ai.configureRateLimiter).not.toHaveBeenCalled();
  });
});

describe('Full pipeline success path', () => {
  it('completes all 7 phases and returns success', async () => {
    const { pipeline } = makePipeline();
    const onProgress = vi.fn();

    const result = await pipeline.execute(makeDefaultOptions({ onProgress }));

    expect(result.success).toBe(true);
    expect(result.phasesCompleted).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(result.cancelled).toBeUndefined();

    // Verify progress was reported for each phase
    const progressPhases = onProgress.mock.calls.map((c: unknown[]) => c[0]);
    expect(progressPhases).toContain('phaseA');
    expect(progressPhases).toContain('phaseB');
    expect(progressPhases).toContain('phaseE');
    expect(progressPhases).toContain('phaseG');
  });

  it('calls gameOrchestrator.runPostRoundForOpening in Phase G', async () => {
    const { pipeline, go } = makePipeline();

    await pipeline.execute(makeDefaultOptions());

    expect(go.runPostRoundForOpening).toHaveBeenCalledTimes(1);
  });

  it('Phase E uses isEnhancedOpening=true and flow overrides in context', async () => {
    const { stages: mockStages } = makeStages();
    const { pipeline } = makePipeline({ stages: mockStages });

    await pipeline.execute(makeDefaultOptions());

    const ctx = (mockStages.contextAssembly.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as PipelineContext;
    expect(ctx.meta?.isEnhancedOpening).toBe(true);
    expect(ctx.meta?.splitGen).toBe(true);
    expect(ctx.meta?.step1FlowOverride).toBe('openingEnhancedStep1');
    expect(ctx.meta?.step2FlowOverride).toBe('openingEnhancedStep2');
  });
});

describe('Rate-limit wait callback (CR-3.3)', () => {
  it('registers and cleans up eventBus listener for rate-limit toasts', async () => {
    const { pipeline } = makePipeline();
    const onRateLimitWait = vi.fn();

    await pipeline.execute(makeDefaultOptions({ onRateLimitWait }));

    expect(mockEventBusOn).toHaveBeenCalledWith('ui:toast', expect.any(Function));
    expect(mockEventBusOff).toHaveBeenCalledWith('ui:toast', expect.any(Function));
  });

  it('only clears rate-limit wait when a wait was active', async () => {
    const { pipeline } = makePipeline();
    const onRateLimitWait = vi.fn();

    await pipeline.execute(makeDefaultOptions({ onRateLimitWait }));

    // Without any rate-limit toasts being emitted, onRateLimitWait(null) should NOT be called
    // because the guard prevents clearing when no wait is active
    const nullCalls = onRateLimitWait.mock.calls.filter((c: unknown[]) => c[0] === null);
    expect(nullCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Story 6 — executeImportOpening (E→F→G on a card-populated tree)
// ═══════════════════════════════════════════════════════════════

describe('executeImportOpening (Story 6 card import)', () => {
  it('runs only Phase E→F→G (skips A-D world regen) and returns actionOptions from the tree', async () => {
    const sm = makeStateManager({ '元数据.当前行动选项': ['探索', '修炼'] });
    const { pipeline, go, stages } = makePipeline({ sm });
    const onProgress = vi.fn();
    const result = await pipeline.executeImportOpening(makeDefaultOptions({ onProgress }));
    expect(result.success).toBe(true);
    expect(result.phasesCompleted).toEqual(['E', 'F', 'G']);
    expect(result.actionOptions).toEqual(['探索', '修炼']);
    expect(go.runPostRoundForOpening).toHaveBeenCalledTimes(1); // Phase G
    expect(stages.contextAssembly.execute as ReturnType<typeof vi.fn>).toHaveBeenCalled(); // Phase E ran
    const phases = onProgress.mock.calls.map((c: unknown[]) => c[0]);
    expect(phases).toContain('phaseE');
    expect(phases).toContain('phaseG');
    expect(phases).not.toContain('phaseA'); // A-D are skipped on import
  });

  it('Phase E failure rolls the tree back to the (card-populated) baseline', async () => {
    const sm = makeStateManager();
    const { stages } = makeStages();
    (stages.aiCall.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('AI E failed'));
    const { pipeline } = makePipeline({ sm, stages });
    const result = await pipeline.executeImportOpening(makeDefaultOptions({ onPhaseError: undefined }));
    expect(result.success).toBe(false);
    expect(result.phasesFailed).toBe('E');
    expect(sm.loadTree).toHaveBeenCalled(); // rolled back to the pre-opening baseline (the card world)
  });

  it('AbortError → { success:false, cancelled:true } (⑦ skip-opening / cancel)', async () => {
    const { stages } = makeStages();
    (stages.aiCall.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const { pipeline } = makePipeline({ stages });
    const result = await pipeline.executeImportOpening(makeDefaultOptions());
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  it('rate-limit bypass: disables then restores around the opening', async () => {
    const ai = makeAiService([]);
    ai._rlEnabled = true;
    const { pipeline } = makePipeline({ ai });
    await pipeline.executeImportOpening(
      makeDefaultOptions({ settings: { ...DEFAULT_ENHANCED_OPENING_SETTINGS, bypassRateLimitDuringOpening: true } }),
    );
    expect(ai.configureRateLimiter).toHaveBeenCalledWith({ enabled: false });
    expect(ai.configureRateLimiter).toHaveBeenCalledWith({ enabled: true });
  });

  it('empty CreationChoices ({selections:{}}) does not break E→F→G', async () => {
    const { pipeline } = makePipeline();
    const result = await pipeline.executeImportOpening(makeDefaultOptions({ choices: { selections: {} } }));
    expect(result.success).toBe(true);
  });
});
