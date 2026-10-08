/**
 * Request matrix — locks what ContextAssembly and AICall put on the wire (R1 prompt-assembly refactor, step 0).
 *
 * The prompt-assembly refactor must change no byte the model receives, no event the debug panel gets and no meta key a
 * later stage reads. This suite runs 13 realistic rounds plus one error case through the REAL chain and writes each
 * result to a file snapshot (`__snapshots__/request-matrix/<id>.json`); a snapshot that moves is a failure, and the
 * snapshots are never updated with `-u` while the refactor is under way (plan: docs/status/code-audit-2026-10/plans/
 * R1-prompt-assembly.md §3).
 *
 * What is real: the tianming pack loaded from disk by the real GamePackLoader, the prompt registry as main.ts builds
 * it (registerPack with the always-on prompts), the real TemplateEngine / PromptAssembler, the real StateManager
 * holding a full tree, the real MemoryManager + MemoryRetriever, the real behavior modules that hook context assembly
 * (MemoryCompilerModule, ContentFilterModule, registered in main.ts order), the real ContextAssemblyStage, the real
 * AICallStage and ResponseParser, the real event bus.
 *
 * What is a stand-in (all of them test-side, nothing in production code is touched):
 *  - the AI service: records every `generate` call and returns a fixed reply per call (a step-1 reply carries a
 *    <thinking> block);
 *  - the Engram unified retriever (hybrid mode): fixed text and a fixed read snapshot, can be told to throw;
 *  - the plot-momentum transform: built exactly as features/plot-vector/aga-adapter.ts `promptTransform` does
 *    (`parseVectorPromptPolicy(...).transform`, plus the two meta keys it writes). The PlotVector stage itself is not
 *    in this chain (it takes no part in the refactor);
 *  - the clock: Date.now is pinned. The assembly itself reads no clock; this guards the rest of the chain.
 *
 * Not in the chain by design: PreProcessStage (the action queue prefix), PlotVector, ResponseRepair and later stages.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextAssemblyStage } from './context-assembly';
import { AICallStage } from './ai-call';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { PromptRegistry } from '../../prompt/prompt-registry';
import { TemplateEngine } from '../../prompt/template-engine';
import { isPromptAlwaysOn } from '../../prompt/builtin-slots';
import { StateManager } from '../../core/state-manager';
import { eventBus } from '../../core/event-bus';
import { BehaviorRunner } from '../../behaviors/behavior-runner';
import { MemoryCompilerModule } from '../../behaviors/memory-compiler';
import { ContentFilterModule } from '../../behaviors/content-filter';
import { MemoryManager } from '../../memory/memory-manager';
import { MemoryRetriever } from '../../memory/memory-retriever';
import { DEFAULT_ENGRAM_CONFIG } from '../../memory/engram/engram-types';
import type { EngramConfig, EngramReadSnapshot } from '../../memory/engram/engram-types';
import { ResponseParser } from '../../ai/response-parser';
import type { AIService } from '../../ai/ai-service';
import type { AIMessage, GenerateOptions } from '../../ai/types';
import type { GamePack } from '../../types';
import type { WorldBook } from '../../prompt/world-book';
import type { RawPromptTransform } from '../../prompt/raw-prompt-transform';
import { parseVectorPromptPolicy } from '../../../features/plot-vector/prompt-policy';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { ContentFilterConfig } from '../../types';
import type { IEngramManager, IUnifiedRetriever, PipelineContext } from '../types';
import { loadPackFromDisk } from '../../__test-utils__/load-pack-from-disk';
import {
  makeArchiveWorldBook,
  makeFreshTree,
  makeRichTree,
} from '../../__test-utils__/fixtures/request-matrix-trees';

// ─────────────────────────────────────────────────────────────
//  Stand-ins
// ─────────────────────────────────────────────────────────────

const FIXED_NOW = 1_700_000_000_000;
const GENERATION_ID = 'gen-matrix';
const OPENING_GENERATION_ID = 'enhancedOpening_E_fixed';

const STEP1_REPLY = '<thinking>先交代雨声，再让她开口。</thinking>\n{"text":"林婉儿把茶盏转了半圈，雨声盖过了她的声音。"}';
const STEP2_REPLY = JSON.stringify({
  commands: [{ action: 'add', path: '世界.时间.分钟', value: 10 }],
  action_options: ['追问师门', '沉默等待', '换个话题'],
  mid_term_memory: { 相关角色: ['林婉儿'], 事件时间: '1-03-15-10-40', 记忆主体: '林婉儿提到了师门。' },
  knowledge_facts: [],
});
const SINGLE_REPLY = JSON.stringify({
  text: '林婉儿把茶盏转了半圈，雨声盖过了她的声音。',
  commands: [{ action: 'add', path: '世界.时间.分钟', value: 10 }],
  action_options: ['追问师门', '沉默等待', '换个话题'],
});

interface GenerateCall {
  usageType: string | undefined;
  generationId: string | undefined;
  stream: boolean | undefined;
  messages: AIMessage[];
}

/** An AI service that records what it is asked and answers with a fixed reply per call. */
function makeRecordingAi(): { service: AIService; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];
  const service = {
    generate: async (opts: GenerateOptions): Promise<string> => {
      calls.push({ usageType: opts.usageType, generationId: opts.generationId, stream: opts.stream, messages: opts.messages });
      if (opts.generationId?.endsWith('_step1')) return STEP1_REPLY;
      if (opts.generationId?.endsWith('_step2')) return STEP2_REPLY;
      return SINGLE_REPLY;
    },
  } as unknown as AIService;
  return { service, calls };
}

/** What the unified retriever read: fixed, and naming the NPC who is in the scene, so the NPC tiers have a signal. */
const READ_SNAPSHOT: EngramReadSnapshot = {
  query: 'fixed-query',
  capturedAt: FIXED_NOW,
  totalDurationMs: 7,
  candidates: [
    { text: '[叶尘→林婉儿] 叶尘在茶馆结识了林婉儿。', finalScore: 0.82, source: 'edge', components: [], outcome: 'injected' },
    { text: '林婉儿：青云宗内门弟子。', finalScore: 0.7, source: 'entity', components: [], outcome: 'injected', entityName: '林婉儿' },
    { text: '苏小棠：后山药圃学徒。', finalScore: 0.2, source: 'entity', components: [], outcome: 'filtered-by-topK', entityName: '苏小棠' },
  ],
  pipeline: { vectorEventCount: 0, vectorEntityCount: 2, graphCount: 1, afterMerge: 3, afterRerank: 3, injectedCount: 2 },
  config: {
    minScore: 0.3, topK: 20, rerankEnabled: false, rerankTopN: 10, embeddingEnabled: true, shortTermWindow: 5,
    maxCandidates: 20, edgeBudget: 10, entityBudget: 5, eventBudget: 5,
  },
};

const RETRIEVED_TEXT = '### 检索到的记忆\n1. 叶尘在茶馆结识了林婉儿。\n2. 林婉儿与苏小棠同出青云宗。';

interface RetrieveCall { query: string; playerName: string; locationDesc: string; recentNpcNames: string[] }

function makeFakeUnifiedRetriever(failing: boolean, snapshot: EngramReadSnapshot = READ_SNAPSHOT): { retriever: IUnifiedRetriever; calls: RetrieveCall[] } {
  const calls: RetrieveCall[] = [];
  const retriever: { lastReadSnapshot: EngramReadSnapshot | null; retrieve: IUnifiedRetriever['retrieve'] } = {
    lastReadSnapshot: null,
    retrieve: async (query, context) => {
      calls.push({ query, playerName: context.playerName, locationDesc: context.locationDesc, recentNpcNames: [...(context.recentNpcNames ?? [])] });
      if (failing) throw new Error('embedding backend unavailable');
      retriever.lastReadSnapshot = snapshot;
      return RETRIEVED_TEXT;
    },
  };
  return { retriever, calls };
}

function makeFakeEngramManager(config: EngramConfig): IEngramManager {
  return {
    isEnabled: () => config.enabled,
    processResponse: async () => null,
    getConfig: () => config,
    syncVectorsToState: async () => undefined,
  };
}

// ─────────────────────────────────────────────────────────────
//  Case description and runner
// ─────────────────────────────────────────────────────────────

type TreeKind = 'R' | 'F';
type RequestKind = 'single' | 'split' | 'opening';
type EngramKind = 'off' | 'hybrid' | 'hybrid-edges' | 'hybrid-throws';

interface Case {
  id: string;
  request: RequestKind;
  tree: TreeKind;
  userInput: string;
  /** Dot-path writes applied to the tree before it is loaded (the player's switches). */
  settings?: Record<string, unknown>;
  /** Context Compiler switch (`ctx.meta.contextCompiler`); the app default is on. */
  contextCompiler?: boolean;
  gproxyCache?: boolean;
  /** Plot momentum on: the round's prompt transform comes from the pack's plot-vector prompt policy. */
  plotMomentum?: boolean;
  engram?: EngramKind;
  /** NPC relevance filter: the NPC count from which it applies (`minNpcCountForFilter`); default is the matrix's 2. */
  npcFilterMinCount?: number;
  /** NPC relevance filter: how many recent rounds of player-NPC edges count as a signal; default is the matrix's 5; a negative value moves the cut-off past every edge. */
  npcRecentWindow?: number;
  /** NPC relevance filter: graph hops from the read's NPCs; default is the matrix's 1. */
  npcBfsHops?: number;
  /** What the stand-in retriever read; default is READ_SNAPSHOT, which names the NPC who is in the scene. */
  readSnapshot?: EngramReadSnapshot;
  /** The prompt page: edits and switches on the registry. */
  promptPage?: (registry: PromptRegistry) => void;
  /** Enhanced opening: the author's opening-style hint. */
  openingSetupHint?: string;
}

const MEMORY_PATHS = {
  shortTermPath: '记忆.短期',
  midTermPath: '记忆.中期',
  longTermPath: '记忆.长期',
  implicitMidTermPath: '记忆.隐式中期',
  semanticMemoryPath: DEFAULT_ENGINE_PATHS.engramMemory,
  shortTermCapacity: 5,
  midTermRefineThreshold: 25,
  longTermSummaryThreshold: 50,
  longTermSummarizeCount: 50,
  midTermKeep: 0,
  longTermCap: 30,
};

function setIn(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/** Keys of ctx.meta that a later stage or the debug panel reads from this stage (plan §3). */
const META_KEYS = [
  'splitStep2Messages', 'splitStep2Sources', 'splitStep2Followup',
  'debugVariables', 'debugRoundNumber',
  'cotEnabled', 'cotJudgeEnabled', 'cotInjectStep2',
  'actionOptionsEnabled', 'environmentBlock',
  'capturedHits', 'settingCaptureActive',
  'worldBookSkipped', 'worldBookBudget',
  'compileTrace', 'npcRelevance', 'engramRead',
] as const;

interface RecordedEvent { name: string; payload: unknown }

interface RunResult {
  ctxOut?: PipelineContext;
  error?: string;
  assemblyEvents: RecordedEvent[];
  aiEvents: RecordedEvent[];
  generateCalls: GenerateCall[];
  retrieveCalls: RetrieveCall[];
}

let pack: GamePack;

beforeAll(async () => {
  pack = await loadPackFromDisk('tianming');
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  // The stage and the pack loader are chatty; the output is not under test.
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  eventBus.clear();
});

async function runCase(c: Case, packOverride?: GamePack): Promise<RunResult> {
  const usedPack = packOverride ?? pack;

  // The save.
  const tree = c.tree === 'R' ? makeRichTree() : makeFreshTree();
  for (const [path, value] of Object.entries(c.settings ?? {})) setIn(tree, path, value);
  const stateManager = new StateManager();
  stateManager.loadTree(tree);

  // The prompt registry as main.ts builds it, then the prompt page's edits.
  const registry = new PromptRegistry();
  registry.registerPack(usedPack.prompts, isPromptAlwaysOn);
  c.promptPage?.(registry);
  const assembler = new PromptAssembler(registry, new TemplateEngine());

  // Memory and behavior modules, in main.ts order.
  const memoryManager = new MemoryManager(stateManager, MEMORY_PATHS);
  const memoryRetriever = new MemoryRetriever(MEMORY_PATHS, memoryManager);
  const behaviorRunner = new BehaviorRunner();
  behaviorRunner.register(new MemoryCompilerModule(memoryManager));
  behaviorRunner.register(new ContentFilterModule(usedPack.rules['contentFilter'] as ContentFilterConfig));

  // Engram.
  const engramKind = c.engram ?? 'off';
  let engramManager: IEngramManager | undefined;
  let unified: ReturnType<typeof makeFakeUnifiedRetriever> | undefined;
  if (engramKind !== 'off') {
    const config: EngramConfig = {
      ...DEFAULT_ENGRAM_CONFIG,
      enabled: true,
      retrievalMode: 'hybrid',
      knowledgeEdgeMode: engramKind === 'hybrid-edges' ? 'active' : 'off',
      npcRelevanceFilter: { enabled: true, recentRoundWindow: c.npcRecentWindow ?? 5, bfsHops: c.npcBfsHops ?? 1, minNpcCountForFilter: c.npcFilterMinCount ?? 2 },
    };
    engramManager = makeFakeEngramManager(config);
    unified = makeFakeUnifiedRetriever(engramKind === 'hybrid-throws', c.readSnapshot);
  }

  // Plot momentum: aga-adapter.ts promptTransform, minus the host plumbing (control, owner, guard).
  let getPromptTransform: ((ctx: PipelineContext) => RawPromptTransform | undefined) | undefined;
  if (c.plotMomentum) {
    const policy = parseVectorPromptPolicy(usedPack.rules['plotVectorPrompts'], usedPack.prompts['plotVectorMode']);
    if (!policy) throw new Error('the tianming pack must carry a plot-vector prompt policy');
    getPromptTransform = (ctx) => {
      ctx.meta.plotVectorPromptMode = true;
      ctx.meta.historyStoryOnly = true;
      return policy.transform;
    };
  }

  const worldBooks: WorldBook[] = c.tree === 'R' ? [makeArchiveWorldBook()] : [];
  const stage = new ContextAssemblyStage(
    stateManager,
    assembler,
    memoryRetriever,
    behaviorRunner,
    usedPack,
    DEFAULT_ENGINE_PATHS,
    engramManager,
    unified?.retriever,
    () => worldBooks,
    // game-orchestrator.ts:310 (main round) passes true, :1093 (enhanced opening) passes false.
    c.request !== 'opening',
    () => c.gproxyCache === true,
    getPromptTransform,
  );

  const { service, calls } = makeRecordingAi();
  const aiStage = new AICallStage(service, new ResponseParser());

  // The context, shaped as the orchestrator (main round) and enhanced-opening.ts (phase E) build it.
  const roundNumber = c.request === 'opening' ? 0 : Number(stateManager.get('元数据.回合序号'));
  const meta: PipelineContext['meta'] = c.request === 'opening'
    ? {
        splitGen: true,
        isEnhancedOpening: true,
        step1FlowOverride: 'openingEnhancedStep1',
        step2FlowOverride: 'openingEnhancedStep2',
        openingSetupHint: c.openingSetupHint ?? '',
      }
    : { splitGen: c.request === 'split', contextCompiler: c.contextCompiler ?? true };
  const ctx: PipelineContext = {
    userInput: c.userInput,
    originalUserInput: c.request === 'opening' ? undefined : c.userInput,
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    roundNumber,
    generationId: c.request === 'opening' ? OPENING_GENERATION_ID : GENERATION_ID,
    meta,
  };

  // Record the events the chain emits, split by the stage that emitted them.
  const events: RecordedEvent[] = [];
  const names = ['worldbook:selection', 'ui:debug-prompt', 'ui:debug-prompt-response'] as const;
  const unsubs = names.map((name) => eventBus.on(name, (payload) => { events.push({ name, payload }); }));

  const result: RunResult = { assemblyEvents: [], aiEvents: [], generateCalls: calls, retrieveCalls: unified?.calls ?? [] };
  try {
    result.ctxOut = await stage.execute(ctx);
    result.assemblyEvents = events.slice();
    await aiStage.execute(result.ctxOut);
    result.aiEvents = events.slice(result.assemblyEvents.length);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.assemblyEvents = events.slice();
  } finally {
    for (const off of unsubs) off();
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
//  Serialization (what goes into the file snapshot)
// ─────────────────────────────────────────────────────────────

/**
 * A field that holds the very same array/object as one already written is recorded as a reference, not a second copy:
 * the debug events and the AI call share the context's arrays by design (plan §5 item 4: "must not be cloned"), so
 * the reference is part of what is locked, and the file stays a tenth of the size.
 */
function serialize(c: Case, r: RunResult): string {
  const seen = new Map<object, string>();
  const remember = <T extends object | undefined>(value: T, label: string): T | { $sameObjectAs: string } => {
    if (value === undefined) return value;
    const earlier = seen.get(value);
    if (earlier) return { $sameObjectAs: earlier };
    seen.set(value, label);
    return value;
  };

  const out: Record<string, unknown> = { case: { id: c.id, request: c.request, tree: c.tree, userInput: c.userInput } };
  if (r.error !== undefined) {
    out.error = r.error;
    out.assemblyEvents = r.assemblyEvents.map((e) => ({ name: e.name, payload: e.payload }));
    return JSON.stringify(out, null, 2);
  }
  const ctxOut = r.ctxOut!;

  const meta: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    const value = ctxOut.meta[key as keyof typeof ctxOut.meta] as unknown;
    if (value === undefined) continue;
    meta[key] = typeof value === 'object' && value !== null ? remember(value, `contextAssembly.meta.${key}`) : value;
  }
  // Recorded before `meta` is written so that `messages` is the first holder of its array.
  const messages = remember(ctxOut.messages, 'contextAssembly.messages');
  const messageSources = remember(ctxOut.messageSources, 'contextAssembly.messageSources');
  const chatHistory = remember(ctxOut.chatHistory, 'contextAssembly.chatHistory');

  const eventOut = (events: RecordedEvent[], scope: string): unknown[] => events.map((e, i) => {
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return { name: e.name, payload };
    const written: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      written[key] = typeof value === 'object' && value !== null ? remember(value, `${scope}[${i}].${e.name}.${key}`) : value;
    }
    return { name: e.name, payload: written };
  });

  out.contextAssembly = {
    messages,
    messageSources,
    chatHistory,
    meta,
    events: eventOut(r.assemblyEvents, 'contextAssembly.events'),
  };
  out.aiCall = {
    generate: r.generateCalls.map((g, i) => ({
      usageType: g.usageType,
      generationId: g.generationId,
      stream: g.stream,
      messages: remember(g.messages, `aiCall.generate[${i}].messages`),
    })),
    events: eventOut(r.aiEvents, 'aiCall.events'),
  };
  if (r.retrieveCalls.length > 0) out.unifiedRetrieveCalls = r.retrieveCalls;
  return JSON.stringify(out, null, 2);
}

async function lock(c: Case, result: RunResult): Promise<void> {
  await expect(serialize(c, result)).toMatchFileSnapshot(`__snapshots__/request-matrix/${c.id}.json`);
}

// ─────────────────────────────────────────────────────────────
//  The matrix (plan §3)
// ─────────────────────────────────────────────────────────────

const INPUT_PLAIN = '我继续追问她：那个人是谁？';
const INPUT_TAGGED = '我握住她的手腕。<设定>林婉儿的师父是青云宗的执法长老，她从不对外人提起。</设定>';
const INPUT_FIRST = '我走出客栈，打量四周。';

const OPTIONS_OFF = { '系统.设置.prompt.enableActionOptions': false };
const COT_ON = { '系统.设置.cot.enabled': true };
const COT_AND_JUDGE = { '系统.设置.cot.enabled': true, '系统.设置.cot.judgeEnabled': true };

const CASES: Case[] = [
  // ── single call, new builder ──
  { id: 'S1', request: 'single', tree: 'R', userInput: INPUT_PLAIN },
  {
    id: 'S2', request: 'single', tree: 'R', userInput: INPUT_PLAIN, gproxyCache: true,
    settings: {
      ...COT_AND_JUDGE,
      '系统.nsfwMode': true,
      '系统.actionOptions.mode': 'story',
      '系统.actionOptions.pace': 'slow',
    },
  },
  { id: 'S3', request: 'single', tree: 'R', userInput: INPUT_TAGGED, plotMomentum: true, settings: OPTIONS_OFF },
  {
    id: 'S4', request: 'single', tree: 'F', userInput: INPUT_FIRST, engram: 'hybrid',
    settings: { '系统.设置.prompt.enableWorldBook': false },
  },

  // ── split generation, step 1 (new builder) + step 2 (flow assembler) ──
  { id: 'P1', request: 'split', tree: 'R', userInput: INPUT_PLAIN },
  { id: 'P2', request: 'split', tree: 'R', userInput: INPUT_TAGGED, settings: { ...COT_ON, '系统.nsfwMode': true } },
  { id: 'P3', request: 'split', tree: 'R', userInput: INPUT_PLAIN, plotMomentum: true, settings: OPTIONS_OFF },
  {
    id: 'P4', request: 'split', tree: 'R', userInput: INPUT_PLAIN, engram: 'hybrid-edges',
    settings: { '系统.设置.social.presenceEnabled': true },
  },
  { id: 'P5', request: 'split', tree: 'R', userInput: INPUT_PLAIN, contextCompiler: false, settings: OPTIONS_OFF },
  {
    id: 'P6', request: 'split', tree: 'R', userInput: INPUT_TAGGED, engram: 'hybrid-throws', settings: OPTIONS_OFF,
    // The prompt page: one prompt the story request builds from is rewritten, one switched off, and a prompt that
    // Step 2's flow loads is rewritten too.
    promptPage: (registry) => {
      registry.setUserContent('writeStyle', '【页面改写】文风：克制，少形容词。');
      registry.setEnabled('antiCliche', false);
      registry.setUserContent('core', '【页面改写】核心规则占位。');
    },
  },
  { id: 'P7', request: 'split', tree: 'F', userInput: INPUT_FIRST },
  // NPC relevance with too few NPCs for the filter (the app default threshold is 10): falls back to the plain split.
  {
    id: 'P8', request: 'split', tree: 'R', userInput: INPUT_PLAIN, engram: 'hybrid-edges', npcFilterMinCount: 10,
    settings: { '系统.设置.social.presenceEnabled': true },
  },
  // An NPC who is in the scene but whom the read does not name (the read names only the absent NPC).
  {
    id: 'P9', request: 'split', tree: 'R', userInput: INPUT_PLAIN, engram: 'hybrid-edges', npcRecentWindow: -100000, npcBfsHops: 0,
    settings: { '系统.设置.social.presenceEnabled': true },
    readSnapshot: {
      ...READ_SNAPSHOT,
      candidates: [
        { text: '苏小棠：后山药圃学徒。', finalScore: 0.8, source: 'entity', components: [], outcome: 'injected', entityName: '苏小棠' },
      ],
    },
  },

  // ── enhanced opening (legacy flow assembler, flow overrides) ──
  { id: 'O1', request: 'opening', tree: 'F', userInput: '' },
  {
    id: 'O2', request: 'opening', tree: 'R', userInput: '', openingSetupHint: '开场请从雨夜的茶馆写起，基调压抑。',
    settings: { ...COT_ON, '系统.nsfwMode': true, '系统.设置.social.presenceEnabled': true },
  },
];

describe('request matrix · what ContextAssembly + AICall send', () => {
  for (const c of CASES) {
    it(`${c.id}: ${c.request} / ${c.tree}`, async () => {
      const result = await runCase(c);
      // A case that errors is not a lock, it is a broken fixture; the one deliberate error case is X1 below.
      expect(result.error, `${c.id} must assemble without error`).toBeUndefined();
      // Sanity: the case really exercised the request kind it names.
      if (c.request === 'single') expect(result.generateCalls).toHaveLength(1);
      else expect(result.generateCalls).toHaveLength(2);
      await lock(c, result);
    });
  }

  it('X1: enhanced opening with a missing flow override stops with a named error', async () => {
    const c: Case = { id: 'X1', request: 'opening', tree: 'F', userInput: '' };
    const flows = { ...pack.promptFlows };
    delete flows['openingEnhancedStep1'];
    const result = await runCase(c, { ...pack, promptFlows: flows });
    expect(result.error).toBe(
      "[ContextAssembly] Required flow override 'openingEnhancedStep1' not found — Enhanced Opening cannot proceed",
    );
    expect(result.generateCalls).toHaveLength(0);
    await lock(c, result);
  });

  it('X2: enhanced opening with a missing Step 2 flow override stops with a named error', async () => {
    const c: Case = { id: 'X2', request: 'opening', tree: 'F', userInput: '' };
    const flows = { ...pack.promptFlows };
    delete flows['openingEnhancedStep2'];
    const result = await runCase(c, { ...pack, promptFlows: flows });
    expect(result.error).toBe(
      "[ContextAssembly] Required flow override 'openingEnhancedStep2' not found — Enhanced Opening cannot proceed",
    );
    expect(result.generateCalls).toHaveLength(0);
    await lock(c, result);
  });
});
