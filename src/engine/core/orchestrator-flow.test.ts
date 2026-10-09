/**
 * Orchestrator round-flow behaviour lock (refactor R5, step 0).
 *
 * `GameOrchestrator` is built with its real constructor (real StateManager, real DEFAULT_ENGINE_PATHS, the real
 * tianming pack, real Pinia for the engine-state store) and driven through `runRound`, the post-round sub-pipeline
 * dispatch, the request-save coalescing and the rollback listener. Only `runner.run` is replaced (the same hook the
 * e2e specs use) and every collaborator is a recording fake. What a case did is stored byte for byte in
 * `__snapshots__/orchestrator-flow/<id>.json` as ONE time-ordered log: events (nested toasts included), state
 * writes, store calls, sub-pipeline / service calls (with `isBusy` at call time), saves and console output, plus the
 * outcome of each round and the host's lock state afterwards.
 *
 * A refactor of game-orchestrator.ts / stage assembly must leave every file unchanged. Snapshots are never
 * rewritten with `-u` during the refactor; a changed snapshot is a failed step.
 *
 * Determinism: only Date is faked (no full fake timers), Math.random and crypto.randomUUID are fixed, generation
 * ids are renumbered by first appearance, the event bus is cleared and the host destroyed after each case.
 *
 * Not covered here on purpose: the real stages' `execute` (own tests), the e2e hook surface (round-save-boundary
 * spec), `requested-save.test.ts` (kept as is).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GameOrchestrator, type SubPipelineBundle } from './game-orchestrator';
import { RollbackSnapshot } from './rollback-snapshot';
import { StateManager } from './state-manager';
import { eventBus } from './event-bus';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { PipelineContext, EnginePathConfig } from '../pipeline/types';
import { AI_SETTINGS_STORAGE_KEY } from '../ai/ai-service';
import { useEngineStateStore } from '../stores/engine-state';
import { useActionQueueStore } from '../stores/engine-action-queue';
import { usePromptDebugStore } from '../stores/engine-prompt';
import { loadPackFromDisk } from '../__test-utils__/load-pack-from-disk';
import { createMockLocalStorage } from '../__test-utils__/local-storage.mock';
import type { GamePack } from '../types';

// ── store fakes: the orchestrator reaches these two through their own modules; both write into the shared log ──

const shared = vi.hoisted(() => ({
  log: [] as unknown[][],
  promptDebugThrows: false,
}));

vi.mock('../stores/engine-action-queue', () => ({
  useActionQueueStore: () => ({
    consumeActions: () => { shared.log.push(['store', 'actionQueue.consumeActions']); return []; },
  }),
}));

vi.mock('../stores/engine-prompt', () => ({
  usePromptDebugStore: () => ({
    recordAssembly: (...args: unknown[]) => {
      shared.log.push(['store', 'promptDebug.recordAssembly', JSON.parse(JSON.stringify(args, (_k, v: unknown) => (v === undefined ? '__undefined__' : v)))]);
      if (shared.promptDebugThrows) throw new Error('pinia not ready');
    },
    attachResponse: (...args: unknown[]) => {
      shared.log.push(['store', 'promptDebug.attachResponse', JSON.parse(JSON.stringify(args, (_k, v: unknown) => (v === undefined ? '__undefined__' : v)))]);
      if (shared.promptDebugThrows) throw new Error('pinia not ready');
    },
  }),
}));

const SNAPSHOT_DIR = '__snapshots__/orchestrator-flow';
const UNDEFINED_MARK = '__undefined__';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const FIXED_RANDOM = 0.123456;
const P: EnginePathConfig = DEFAULT_ENGINE_PATHS;
const SELF_UUID_PREFIX = '00000000-0000-4000-8000-';

// ── serialisation (same writing as the R2/R3 locks: key order kept, undefined written as a mark) ──

function replacer(_key: string, v: unknown): unknown {
  if (v === undefined) return UNDEFINED_MARK;
  if (typeof v === 'function') return '<fn>';
  if (v instanceof Error) return `<Error: ${v.message}>`;
  if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return `<AbortSignal aborted=${v.aborted}>`;
  if (v && typeof v === 'object' && (v as object).constructor?.name === 'RoundOwnership') return '<RoundOwnership>';
  return v;
}

/** Deep, detached copy for the log (the value as it was when the call happened). */
function snap(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_MARK;
  return JSON.parse(JSON.stringify(value, replacer));
}

function serialize(value: unknown): string {
  return JSON.stringify(value, replacer, 2) + '\n';
}

/** Renumbers the stubbed generation ids by first appearance. */
function normalizeIds(text: string): string {
  const order = new Map<string, number>();
  return text.replace(new RegExp(`${SELF_UUID_PREFIX}\\d{12}`, 'g'), (id) => {
    if (!order.has(id)) order.set(id, order.size + 1);
    return `<gen#${order.get(id)}>`;
  });
}

function L(...entry: unknown[]): void { shared.log.push(entry); }

/** Lets every fire-and-forget `.then` land. Only Date is faked, so real timers are used. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── configurable results for the fakes ──

class Throws { constructor(readonly message: string) {} }
class Rejects { constructor(readonly message: string) {} }

type Results = Record<string, unknown>;

/** Returns the n-th item on the n-th call (the last one repeats). */
function seq(...items: unknown[]): () => unknown {
  let n = 0;
  return () => items[Math.min(n++, items.length - 1)];
}

// ── fixtures ──

type Json = Record<string, unknown>;
type TreeEdit = (tree: Json) => void;

const BASE_ROUND = 5;

function baseTree(): Json {
  return {
    元数据: {
      回合序号: BASE_ROUND,
      叙事历史: [
        { 类型: 'ai', 内容: '旧叙事', _engramWrite: { nodes: 1 } },
        { 类型: 'ai', 内容: '新叙事' },
      ],
      剧情导向: { 当前弧: 'arc1' },
    },
    角色: { 基础信息: { 姓名: '主角', 当前位置: '长安' } },
    世界: { 时间: { 年: 1, 月: 10, 日: 3, 小时: 21, 分钟: 30 }, 天气: '小雨', 节日: { 名称: '中秋节' }, 环境: [{ 名称: '雾气' }] },
    社交: {
      关系: [
        { 名称: '林暖', 性别: '女', 描述: '酒肆老板娘', 外貌描写: '黑发及腰', 是否主要角色: true, 图片档案: { 已选头像图片ID: '' } },
        { 名称: '关宇', 性别: '男', 描述: '游侠', 外貌描写: '剑眉星目', 是否主要角色: true, 图片档案: { 已选头像图片ID: 'avatar_1' } },
        { 名称: '路人甲', 性别: '男', 描述: '行商', 是否主要角色: false },
        { 名称: '苏晴', 性别: '女', 描述: '医女', 是否主要角色: true },
        { 名称: '', 性别: '女', 描述: '无名', 是否主要角色: true },
      ],
    },
    系统: {
      设置: { prompt: {} },
      扩展: {
        image: {
          enabled: true,
          config: {
            autoSceneOnRound: true,
            autoPortraitForMajorNpcs: false,
            defaultBackend: 'novelai',
            auto: { sceneResolution: '832x1216', sceneOrientation: 'portrait', sceneComposition: 'snapshot', npcStyle: 'anime' },
          },
        },
      },
    },
    记忆: { 中期: [], 长期: [] },
  };
}

let pack: GamePack;

// ── the host: the only place a GameOrchestrator is built ──

interface HostOptions {
  edit?: TreeEdit;
  results?: Results;
  /** Sub-pipeline bundle keys to leave out. */
  omit?: string[];
  noPaths?: boolean;
  plotVector?: boolean;
  engramEnabled?: boolean;
  aiSettings?: string;
  pack?: GamePack;
  run?: (ctx: PipelineContext, h: Host, n: number) => Promise<RunResult | void>;
}

interface RunResult { text?: string; meta?: Record<string, unknown> }

interface StageLike { name: string; constructor: { name: string }; [key: string]: unknown }
interface Priv {
  runner: { run: (c: PipelineContext) => Promise<PipelineContext>; stages: StageLike[] };
  runRound(text: string, sm: StateManager): Promise<void>;
  subPipelines: SubPipelineBundle;
  pendingSave: unknown;
  stateRevision: number;
  _getActiveSlot: () => { profileId: string; slotId: string } | null;
  createStagesForOpening(): Record<string, StageLike>;
}

interface Host {
  orch: GameOrchestrator;
  priv: Priv;
  sm: StateManager;
  bundle: SubPipelineBundle;
  outcomes: unknown[];
  store: ReturnType<typeof useEngineStateStore>;
  /** Runs one round through `runRound` and records how it ended. */
  round: (text?: string) => Promise<void>;
  /** What PreProcessStage does: snapshot first (to the holder, a marker into the tree), then the round number moves on. */
  preProcess: () => void;
  /** The round-start snapshot holder the orchestrator was built with (存档瘦身 D1A). */
  rollback: RollbackSnapshot;
}

const ls = createMockLocalStorage();

function buildHost(opts: HostOptions = {}): Host {
  shared.log.length = 0;
  shared.promptDebugThrows = false;
  setActivePinia(createPinia());
  const store = useEngineStateStore();
  store.activeProfileId = 'p1';
  store.activeSlotId = 's1';

  ls.storage.clear();
  if (opts.aiSettings !== undefined) ls.storage.setItem(AI_SETTINGS_STORAGE_KEY, opts.aiSettings);

  const tree = baseTree();
  opts.edit?.(tree);
  const sm = new StateManager();
  sm.loadTree(tree);
  const rollback = new RollbackSnapshot(P);

  const results: Results = opts.results ?? {};
  let host: Host | undefined;
  const busy = (): boolean | string => host ? host.orch.isBusy : '<no host>';

  /** Resolves a fake's return value: configured value / function / default; `Throws` throws. */
  function resolve(name: string, args: unknown[], fallback: unknown): unknown {
    const configured = name in results ? results[name] : fallback;
    const value = typeof configured === 'function' ? (configured as (...a: unknown[]) => unknown)(...args) : configured;
    if (value instanceof Throws) throw new Error(value.message);
    return value;
  }
  /** Synchronous fake: logs, then returns or throws. */
  const sync = (name: string, fallback: unknown) => (...args: unknown[]): unknown => {
    L('call', name, snap(args), { busy: busy() });
    return resolve(name, args, fallback);
  };
  /** Async fake: a throw becomes a rejection, like the real pipelines' `execute`. */
  const asyncFn = (name: string, fallback: unknown) => async (...args: unknown[]): Promise<unknown> => {
    L('call', name, snap(args), { busy: busy() });
    return resolve(name, args, fallback);
  };
  /** Fire-and-forget fake that returns a promise synchronously (the image service). */
  const promising = (name: string, fallback: unknown) => (...args: unknown[]): Promise<unknown> => {
    L('call', name, snap(args), { busy: busy() });
    const value = resolve(name, args, fallback);
    return value instanceof Rejects ? Promise.reject(new Error(value.message)) : Promise.resolve(value);
  };

  const bundle: SubPipelineBundle = {
    memoryManager: {
      shouldSummarizeLongTerm: sync('memoryManager.shouldSummarizeLongTerm', false),
      shouldRefineMidTerm: sync('memoryManager.shouldRefineMidTerm', false),
      shouldCompactLongTerm: sync('memoryManager.shouldCompactLongTerm', false),
      fallbackTrimLongTerm: sync('memoryManager.fallbackTrimLongTerm', 0),
      clearConfigCache: sync('memoryManager.clearConfigCache', undefined),
    } as unknown as SubPipelineBundle['memoryManager'],
    memorySummary: { execute: asyncFn('memorySummary.execute', false) } as unknown as SubPipelineBundle['memorySummary'],
    midTermRefine: { execute: asyncFn('midTermRefine.execute', false) } as unknown as SubPipelineBundle['midTermRefine'],
    characterVectorPropose: { execute: asyncFn('characterVectorPropose.execute', false) } as unknown as SubPipelineBundle['characterVectorPropose'],
    longTermCompact: { execute: asyncFn('longTermCompact.execute', false) } as unknown as SubPipelineBundle['longTermCompact'],
    worldHeartbeat: { execute: asyncFn('worldHeartbeat.execute', false) } as unknown as SubPipelineBundle['worldHeartbeat'],
    plotEvaluation: { execute: asyncFn('plotEvaluation.execute', false) } as unknown as SubPipelineBundle['plotEvaluation'],
    npcGeneration: { execute: asyncFn('npcGeneration.execute', false) } as unknown as SubPipelineBundle['npcGeneration'],
    privacyRepair: {
      execute: asyncFn('privacyRepair.execute', { success: true, attempts: 1, remaining: { total: 0 } }),
    } as unknown as SubPipelineBundle['privacyRepair'],
    fieldRepair: {
      execute: asyncFn('fieldRepair.execute', { attempts: 0, success: true, remaining: { total: 0 } }),
    } as unknown as SubPipelineBundle['fieldRepair'],
    npcMemorySummarizer: {
      findCandidates: sync('npcMemorySummarizer.findCandidates', []),
      summarize: asyncFn('npcMemorySummarizer.summarize', true),
    } as unknown as SubPipelineBundle['npcMemorySummarizer'],
    imageService: {
      collectSceneRoleAnchors: sync('imageService.collectSceneRoleAnchors', { presentNpcs: ['林暖'], roleAnchors: [{ npcName: '林暖', positive: '1girl' }] }),
      generateSceneImage: promising('imageService.generateSceneImage', { id: 'img1' }),
      generateCharacterImage: promising('imageService.generateCharacterImage', { id: 'img2' }),
    } as unknown as SubPipelineBundle['imageService'],
    ttsService: {
      clearRoundAudio: sync('ttsService.clearRoundAudio', undefined),
      getSettings: sync('ttsService.getSettings', { enabled: false, autoNarrateOnRound: false }),
      speak: promising('ttsService.speak', undefined),
    } as unknown as SubPipelineBundle['ttsService'],
    worldBooks: [{ id: 'wb0', name: '初始世界书' }] as unknown as SubPipelineBundle['worldBooks'],
    paths: opts.noPaths ? undefined : P,
    stateEditInProgress: () => { const v = resolve('stateEditInProgress', [], false); return v === true; },
  };
  if (opts.plotVector) {
    bundle.plotVector = {
      promptTransform: (ctx: PipelineContext) => { L('call', 'plotVector.promptTransform', snap({ roundNumber: ctx.roundNumber })); return undefined; },
      prepare: async (ctx: PipelineContext) => { L('call', 'plotVector.prepare'); return ctx; },
      beforeSave: async () => { L('call', 'plotVector.beforeSave'); },
      afterSave: async () => { L('call', 'plotVector.afterSave'); },
      dispose: () => { L('call', 'plotVector.dispose'); },
    };
  }
  for (const key of opts.omit ?? []) delete (bundle as Record<string, unknown>)[key];

  const engram = {
    isEnabled: () => opts.engramEnabled === true,
    syncVectorsToState: async (sm2: unknown) => {
      L('call', 'engram.syncVectorsToState', { isStateManager: sm2 === sm });
      if ('engram.syncVectorsToState' in results && results['engram.syncVectorsToState'] instanceof Rejects) {
        throw new Error((results['engram.syncVectorsToState'] as Rejects).message);
      }
    },
  };

  const saveManager = {
    saveGame: async (profileId: string, slotId: string, liveTree: unknown,
      meta: unknown, commit: { guard: () => void; committed: () => void }) => {
      L('save', 'start', { profileId, slotId, round: sm.get<number>(P.roundNumber), treeIsLive: liveTree === sm.liveTree(), meta: snap(meta) });
      if (results['save.beforeGuard']) (results['save.beforeGuard'] as () => void)();
      try { commit.guard(); } catch (err) { L('save', 'guard-threw', err instanceof Error ? err.message : String(err)); throw err; }
      commit.committed();
      L('save', 'committed');
    },
  };

  const aiService = {
    getConfigForUsage: (usage: string) => {
      L('call', 'aiService.getConfigForUsage', usage);
      return { gproxyPromptCache: results['gproxy'] === true };
    },
  };

  const orch = new GameOrchestrator(
    sm,
    {} as never, // commandExecutor
    {} as never, // behaviorRunner
    aiService as never,
    {} as never, // responseParser
    {} as never, // promptAssembler
    bundle.memoryManager!,
    {} as never, // memoryRetriever
    engram as never,
    saveManager as never,
    opts.pack ?? pack,
    P,
    undefined,
    bundle,
    {
      // Same closures main.ts injects; the stores are mocked above.
      getActiveSlot: () => {
        const s = useEngineStateStore();
        if (!s.activeProfileId || !s.activeSlotId) return null;
        return { profileId: s.activeProfileId, slotId: s.activeSlotId };
      },
      actionQueue: { consumeActions: () => useActionQueueStore().consumeActions() },
      promptDebug: {
        recordAssembly: (...args) => usePromptDebugStore().recordAssembly(...args),
        attachResponse: (...args) => usePromptDebugStore().attachResponse(...args),
      },
    },
    rollback,
  );
  const priv = orch as unknown as Priv;

  const outcomes: unknown[] = [];
  let runIndex = 0;
  let host2!: Host;
  const preProcess = (): void => {
    const marker = rollback.capture(sm.toSnapshot());
    if (sm.has(P.preRoundSnapshot)) sm.delete(P.preRoundSnapshot, 'system');
    sm.set(P.rollbackPatch, marker, 'system');
    sm.set(P.roundNumber, (sm.get<number>(P.roundNumber) ?? 0) + 1, 'system');
  };

  // The e2e hook: replace the runner's run, keep its real stages.
  priv.runner.run = async (ctx: PipelineContext): Promise<PipelineContext> => {
    L('run', 'start', snap(ctx));
    eventBus.emit('engine:round-start', { roundNumber: ctx.roundNumber });
    try {
      const script = opts.run ?? (async () => { host2.preProcess(); return {}; });
      const res: RunResult = (await script(ctx, host2, runIndex++)) ?? {};
      const roundNumber = sm.get<number>(P.roundNumber) ?? 0;
      const final: PipelineContext = {
        ...ctx,
        roundNumber,
        parsedResponse: { text: res.text ?? '叙事正文' } as unknown as PipelineContext['parsedResponse'],
        meta: { ...ctx.meta, ...(res.meta ?? {}) },
      };
      eventBus.emit('engine:round-complete', { roundNumber, actionOptions: [] });
      return final;
    } catch (err) {
      eventBus.emit('engine:round-error', { stage: 'AICall', error: err });
      throw err;
    }
  };

  host2 = {
    orch, priv, sm, bundle, outcomes, store, preProcess, rollback,
    round: async (text = '玩家输入') => {
      try {
        await priv.runRound(text, sm);
        outcomes.push({ resolved: true });
      } catch (err) {
        outcomes.push({ rejected: err instanceof Error ? err.message : String(err) });
      }
      await settle();
    },
  };
  host = host2;
  startRecording();
  return host2;
}

/** Installs the recorders. Called last in buildHost so construction is not part of what a case did. */
function startRecording(): void {
  shared.log.length = 0;
  const emit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    L('event', event, slimEvent(event, payload));
    emit(event, payload);
  });
  const origSet = StateManager.prototype.set;
  vi.spyOn(StateManager.prototype, 'set').mockImplementation(function (this: StateManager, ...a: Parameters<typeof origSet>) {
    L('state', 'set', a[0], a[0] === P.preRoundSnapshot ? summarizeTree(a[1]) : snap(a[1]), a[2] ?? 'system');
    return origSet.apply(this, a);
  });
  const origPush = StateManager.prototype.push;
  vi.spyOn(StateManager.prototype, 'push').mockImplementation(function (this: StateManager, ...a: Parameters<typeof origPush>) {
    L('state', 'push', a[0], snap(a[1]));
    return origPush.apply(this, a);
  });
  const origDelete = StateManager.prototype.delete;
  vi.spyOn(StateManager.prototype, 'delete').mockImplementation(function (this: StateManager, ...a: Parameters<typeof origDelete>) {
    L('state', 'delete', a[0]);
    return origDelete.apply(this, a);
  });
  const origRollback = StateManager.prototype.rollbackTo;
  vi.spyOn(StateManager.prototype, 'rollbackTo').mockImplementation(function (this: StateManager, ...a: Parameters<typeof origRollback>) {
    L('state', 'rollbackTo', summarizeTree(a[0]), snap(a[1]));
    return origRollback.apply(this, a);
  });
  const origLoad = StateManager.prototype.loadTree;
  vi.spyOn(StateManager.prototype, 'loadTree').mockImplementation(function (this: StateManager, ...a: Parameters<typeof origLoad>) {
    L('state', 'loadTree', Object.keys(a[0]));
    return origLoad.apply(this, a);
  });
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      L('console', level, ...args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `<Error: ${a.message}>` : String(a))));
    });
  }
}

/** A whole-tree snapshot is logged as its round number, location and top-level keys (the tree itself is not the point). */
function summarizeTree(tree: unknown): unknown {
  const t = tree as Json | undefined;
  if (!t || typeof t !== 'object') return snap(tree);
  return {
    keys: Object.keys(t),
    round: ((t['元数据'] as Json | undefined) ?? {})['回合序号'],
    location: (((t['角色'] as Json | undefined)?.['基础信息'] as Json | undefined) ?? {})['当前位置'],
  };
}

function slimEvent(event: string, payload: unknown): unknown {
  if (event === 'engine:state-changed' && payload && typeof payload === 'object') {
    const p = payload as { change?: { path?: string; action?: string }; source?: string; type?: string };
    if (p.change) return { path: p.change.path, action: p.change.action, source: p.source };
    return { type: p.type };
  }
  return snap(payload);
}

async function expectSnapshot(id: string, h: Host, extra: Record<string, unknown> = {}): Promise<void> {
  await settle();
  const doc = {
    outcomes: h.outcomes,
    log: shared.log,
    after: {
      isBusy: h.orch.isBusy,
      pendingSave: snap(h.priv.pendingSave),
      stateRevision: h.priv.stateRevision,
      roundNumber: h.sm.get<number>(P.roundNumber),
      activeSlot: snap(h.priv._getActiveSlot()),
    },
    ...extra,
  };
  await expect(normalizeIds(serialize(doc))).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}

let hostForCleanup: Host | undefined;
let uuidCounter = 0;

beforeEach(async () => {
  pack ??= await loadPackFromDisk();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
  uuidCounter = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `${SELF_UUID_PREFIX}${String(++uuidCounter).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  ls.install();
  hostForCleanup = undefined;
});

afterEach(async () => {
  await settle();
  hostForCleanup?.orch.destroy();
  eventBus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  ls.restore();
  shared.promptDebugThrows = false;
});

/** Builds the host for a case and remembers it for cleanup. */
function host(opts?: HostOptions): Host {
  const h = buildHost(opts);
  hostForCleanup = h;
  return h;
}

/** Final-ctx meta for a round that asks for post-round work. */
const asks = (meta: Record<string, unknown>) =>
  async (_ctx: PipelineContext, h: Host): Promise<RunResult> => { h.preProcess(); return { meta }; };

// ═══════════════════════════════════════════════════════════════
// F · the round itself
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · round', () => {
  it('F1 ordinary rounds: initial context shape for streaming on/off, splitGen, contextCompiler, bad settings JSON', async () => {
    const h = host({
      run: async (ctx, hh, n) => {
        hh.preProcess();
        if (n === 0) ctx.onStreamChunk?.('第一块');
        return { text: `正文${n}` };
      },
    });
    await h.round('第一回合');
    ls.storage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify({ streaming: false, splitGen: true, contextCompiler: false }));
    await h.round('第二回合');
    ls.storage.setItem(AI_SETTINGS_STORAGE_KEY, '{not json');
    await h.round('第三回合');
    await expectSnapshot('F1', h);
  });

  it('F2 a pipeline error after PreProcess rolls the round back; an error before it does not', async () => {
    const h = host({
      engramEnabled: true,
      run: async (_ctx, hh, n) => {
        if (n === 0) { hh.preProcess(); hh.sm.set('角色.基础信息.当前位置', '洛阳', 'system'); }
        throw new Error('model down');
      },
    });
    await h.round('会失败');
    await h.round('更早失败');
    await expectSnapshot('F2', h);
  });

  it('F3 "Pipeline aborted" after PreProcess is rolled back without a console.error', async () => {
    const h = host({
      run: async (_ctx, hh) => { hh.preProcess(); throw new Error('Pipeline aborted'); },
    });
    await h.round('被中止');
    await expectSnapshot('F3', h);
  });

  it('F4 switching slot mid-round: the failed round is not rolled back', async () => {
    const h = host({
      run: async (_ctx, hh) => {
        hh.preProcess();
        hh.store.activeSlotId = 's2';
        throw new Error('model down');
      },
    });
    await h.round('切档');
    await expectSnapshot('F4', h);
  });

  it('F5 input while a round is running is refused with a toast and keeps the first round intact', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = host({
      run: async (_ctx, hh) => { hh.preProcess(); await gate; return {}; },
    });
    const first = h.round('第一条');
    await settle();
    await h.round('第二条');
    L('probe', 'isBusy while first runs', h.orch.isBusy);
    release();
    await first;
    await expectSnapshot('F5', h);
  });

  it('F6 input while an external editor holds the state is refused', async () => {
    const h = host({ results: { stateEditInProgress: true } });
    await h.round('编辑中');
    await expectSnapshot('F6', h);
  });

  it('F7 pipeline:cancel aborts the running round; empty input is ignored; the event path starts a round', async () => {
    const h = host({
      run: async (ctx, hh) => {
        hh.preProcess();
        await new Promise<void>((_resolve, reject) => {
          ctx.abortSignal?.addEventListener('abort', () => reject(new Error('Pipeline aborted')));
        });
        return {};
      },
    });
    eventBus.emit('pipeline:user-input', { text: '' });
    eventBus.emit('pipeline:user-input', { text: '会被取消' });
    await settle();
    L('probe', 'isBusy before cancel', h.orch.isBusy);
    eventBus.emit('pipeline:cancel');
    await settle();
    await expectSnapshot('F7', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// M · memory tiers
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · memory', () => {
  it('M1 summary succeeds, compact fails -> FIFO fallback', async () => {
    const h = host({
      results: {
        'memoryManager.shouldSummarizeLongTerm': true,
        'memorySummary.execute': true,
        'memoryManager.shouldCompactLongTerm': true,
        'longTermCompact.execute': new Throws('compact down'),
        'memoryManager.fallbackTrimLongTerm': 3,
      },
    });
    await h.round();
    await expectSnapshot('M1', h);
  });

  it('M2 refine succeeds -> character vectors proposed; compact succeeds; summary throwing is contained', async () => {
    const h = host({
      results: {
        'memoryManager.shouldRefineMidTerm': true,
        'midTermRefine.execute': seq(true, false, new Throws('refine down')),
        'characterVectorPropose.execute': seq(true, true),
        'memoryManager.shouldCompactLongTerm': true,
        'longTermCompact.execute': true,
      },
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('M2', h);
  });

  it('M3 a cadence round proposes character vectors without a refine; summary failure is contained', async () => {
    const h = host({
      edit: (t) => { (t['元数据'] as Json)['回合序号'] = 9; },
      results: {
        'memoryManager.shouldSummarizeLongTerm': true,
        'memorySummary.execute': new Throws('summary down'),
        'characterVectorPropose.execute': seq(false, new Throws('propose down')),
      },
    });
    await h.round();
    await expectSnapshot('M3', h);
  });

  it('M4 shouldSummarizeLongTerm throws -> every later task is skipped, done still fires, runRound rejects (E01-035 as is)', async () => {
    const h = host({
      results: { 'memoryManager.shouldSummarizeLongTerm': new Throws('memory broke') },
      run: asks({ pendingHeartbeat: true, pendingPlotEval: true }),
    });
    await h.round();
    await expectSnapshot('M4', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// W · world tasks
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · world', () => {
  it('W1 heartbeat: success writes the round, false and a throw do not', async () => {
    const h = host({
      results: { 'worldHeartbeat.execute': seq(true, false, new Throws('heartbeat down')) },
      run: asks({ pendingHeartbeat: true }),
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('W1', h);
  });

  it('W2 plot evaluation: _evaluating is set true, then false in finally, also on a throw', async () => {
    const h = host({
      results: { 'plotEvaluation.execute': seq(true, false, new Throws('eval down')) },
      run: asks({ pendingPlotEval: true }),
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('W2', h);
  });

  it('W3 location change triggers NPC generation; same location and a throw', async () => {
    const h = host({
      results: { 'npcGeneration.execute': seq(true, new Throws('npc down')) },
      run: async (_ctx, hh, n) => {
        hh.preProcess();
        if (n === 0) hh.sm.set(P.playerLocation, '洛阳', 'system');
        if (n === 1) hh.sm.set(P.playerLocation, '扬州', 'system');
        return {};
      },
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('W3', h);
  });

  it('W4 bundle without paths: heartbeat/eval write nothing, NPC generation skipped, fallbacks for location and round', async () => {
    const h = host({
      noPaths: true,
      results: {
        'worldHeartbeat.execute': true,
        'plotEvaluation.execute': true,
        'ttsService.getSettings': { enabled: true, autoNarrateOnRound: true },
        'fieldRepair.execute': { attempts: 0, success: true, remaining: { total: 0 }, edgeReviewResult: { invalidated: 1, reviewed: 2 } },
      },
      edit: (t) => {
        const image = ((t['系统'] as Json)['扩展'] as Json)['image'] as Json;
        (image['config'] as Json)['autoPortraitForMajorNpcs'] = true;
      },
      run: asks({ pendingHeartbeat: true, pendingPlotEval: true }),
    });
    await h.round();
    await expectSnapshot('W4', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// R · repairs
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · repair', () => {
  it('R1 privacy repair: success toast, incomplete toast, throw', async () => {
    const h = host({
      results: {
        'privacyRepair.execute': seq(
          { success: true, attempts: 2, remaining: { total: 0 } },
          { success: false, attempts: 3, remaining: { total: 4 } },
          new Throws('repair down'),
        ),
      },
      run: asks({ pendingPrivacyRepair: { total: 2, npcs: ['林暖'] } }),
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('R1', h);
  });

  it('R2 field repair: nothing, extra unresolved only, basic success, basic incomplete, extra resolved only, throw', async () => {
    const h = host({
      results: {
        'fieldRepair.execute': seq(
          { attempts: 0, success: true, remaining: { total: 0 } },
          { attempts: 1, success: true, remaining: { total: 0 }, extra: { resolved: false } },
          { attempts: 2, success: true, remaining: { total: 0 }, fieldsNeeded: true, entityEnrichResult: { enriched: 2, remaining: 1 } },
          { attempts: 3, success: false, remaining: { total: 5 }, fieldsNeeded: true },
          { attempts: 1, success: true, remaining: { total: 0 }, extra: { resolved: true } },
          new Throws('field repair down'),
        ),
      },
    });
    for (let i = 0; i < 6; i++) await h.round();
    await expectSnapshot('R2', h);
  });

  it('R3 edge review is written back onto the latest narrative entry that has _engramWrite', async () => {
    const h = host({
      results: {
        'fieldRepair.execute': seq(
          { attempts: 0, success: true, remaining: { total: 0 }, edgeReviewResult: { invalidated: 2, reviewed: 5 } },
          { attempts: 0, success: true, remaining: { total: 0 }, edgeReviewResult: { invalidated: 0, reviewed: 3 } },
        ),
      },
    });
    await h.round();
    h.sm.set(P.narrativeHistory, [{ 类型: 'ai', 内容: '没有写入标记' }], 'system');
    await h.round();
    await expectSnapshot('R3', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// A · automatic media
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · auto media', () => {
  it('A1 auto scene: portrait snapshot with resolution, landscape default, bad resolution; toast after resolve', async () => {
    const h = host();
    await h.round();
    h.sm.set('系统.扩展.image.config.auto.sceneOrientation', 'landscape');
    h.sm.set('系统.扩展.image.config.auto.sceneResolution', '');
    h.sm.set('系统.扩展.image.config.auto.sceneComposition', 'landscape');
    await h.round();
    h.sm.set('系统.扩展.image.config.auto.sceneResolution', 'abc');
    h.sm.set('系统.扩展.image.config.auto.sceneOrientation', 'portrait');
    await h.round();
    await expectSnapshot('A1', h);
  });

  it('A2 auto scene: reject shows no toast; a synchronous throw is contained; no role anchors', async () => {
    const h = host({
      results: {
        'imageService.generateSceneImage': seq(new Rejects('gen failed'), new Throws('trigger failed'), { id: 'ok' }),
        'imageService.collectSceneRoleAnchors': seq(
          { presentNpcs: ['林暖'], roleAnchors: [{ npcName: '林暖', positive: '1girl' }] },
          { presentNpcs: [], roleAnchors: [] },
          { presentNpcs: [], roleAnchors: [] },
        ),
      },
    });
    await h.round();
    await h.round();
    await h.round();
    await expectSnapshot('A2', h);
  });

  it('A3 auto portraits: major/all, gender filter, existing avatar skipped, appearance falls back, one failure', async () => {
    const h = host({
      edit: (t) => {
        const image = ((t['系统'] as Json)['扩展'] as Json)['image'] as Json;
        (image['config'] as Json)['autoSceneOnRound'] = false;
        (image['config'] as Json)['autoPortraitForMajorNpcs'] = true;
      },
      results: {
        'imageService.generateCharacterImage': (arg: unknown) =>
          (arg as { characterName?: string }).characterName === '苏晴' ? new Rejects('portrait failed') : { id: 'p' },
      },
    });
    await h.round();
    h.sm.set('系统.扩展.image.config.auto.genderFilter', 'female');
    h.sm.set('系统.扩展.image.config.auto.importanceFilter', 'all');
    h.sm.set('系统.扩展.image.config.auto.npcStyle', 'no-such-style');
    await h.round();
    h.sm.set('系统.扩展.image.config.auto.genderFilter', 'male');
    h.sm.delete('系统.扩展.image.config.auto.npcStyle');
    await h.round();
    await expectSnapshot('A3', h);
  });

  it('A4 auto narration: on, off, settings throw; enhanced opening skips narration and images', async () => {
    const h = host({
      edit: (t) => {
        const image = ((t['系统'] as Json)['扩展'] as Json)['image'] as Json;
        (image['config'] as Json)['autoPortraitForMajorNpcs'] = true;
      },
      results: {
        'ttsService.getSettings': seq(
          { enabled: true, autoNarrateOnRound: true },
          { enabled: true, autoNarrateOnRound: false },
          new Throws('tts settings down'),
          { enabled: true, autoNarrateOnRound: true },
        ),
      },
      run: async (_ctx, hh, n) => { hh.preProcess(); return n === 3 ? { meta: { isEnhancedOpening: true } } : {}; },
    });
    for (let i = 0; i < 4; i++) await h.round();
    await expectSnapshot('A4', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// N · NPC memory
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · npc memory', () => {
  it('N1 a throw in the middle of the candidate loop ends the loop; findCandidates throwing is contained', async () => {
    const h = host({
      results: {
        'npcMemorySummarizer.findCandidates': seq(['甲', '乙', '丙'], new Throws('find down')),
        'npcMemorySummarizer.summarize': seq(true, new Throws('summarize down'), true),
      },
    });
    await h.round();
    await h.round();
    await expectSnapshot('N1', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// S · save and rollback
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · save and rollback', () => {
  it('S1 rollback: no snapshot -> toast; with snapshot -> full sequence; refused while an editor holds the state', async () => {
    const h = host({
      engramEnabled: true,
      results: { stateEditInProgress: seq(false, false, false, true) },
    });
    eventBus.emit('engine:rollback-requested');
    await settle();
    h.sm.set(P.preRoundSnapshot, { 元数据: { 回合序号: 4 }, 角色: { 基础信息: { 当前位置: '旧地点' } } }, 'system');
    h.sm.set(P.roundNumber, 6, 'system');
    eventBus.emit('engine:rollback-requested');
    await settle();
    h.sm.set(P.preRoundSnapshot, { 元数据: { 回合序号: 3 } }, 'system');
    eventBus.emit('engine:rollback-requested');
    await settle();
    await expectSnapshot('S1', h);
  });

  it('S4 rollback through the held snapshot: once per round; a marker naming nothing held is taken out with a toast', async () => {
    const h = host({ engramEnabled: true });
    // A round started: PreProcess handed the snapshot over and marked the tree; the round then changed the story.
    h.preProcess();
    h.sm.set('角色.基础信息.当前位置', '洛阳', 'system');
    eventBus.emit('engine:rollback-requested');
    await settle();
    L('probe', 'held after rollback', h.rollback.current() === undefined ? 'nothing' : 'a snapshot');
    eventBus.emit('engine:rollback-requested');
    await settle();
    h.sm.set(P.rollbackPatch, 'round-start:404', 'system');
    eventBus.emit('engine:rollback-requested');
    await settle();
    L('probe', 'marker after', snap(h.sm.get(P.rollbackPatch)));
    await expectSnapshot('S4', h);
  });

  it('S2 request-save during sub-pipelines is merged and written once at the end', async () => {
    const h = host({
      results: {
        'worldHeartbeat.execute': () => {
          eventBus.emit('engine:request-save');
          eventBus.emit('engine:request-save');
          return true;
        },
      },
      run: asks({ pendingHeartbeat: true }),
    });
    await h.round();
    eventBus.emit('engine:request-save');
    await settle();
    await expectSnapshot('S2', h);
  });

  it('S3 guard throws (state loaded mid-save) -> engine:save-error with the message', async () => {
    let live: Host | undefined;
    const h = host({
      // Between taking the revision and the guard the player loads another tree: the old request must be cancelled.
      results: { 'save.beforeGuard': () => { live!.sm.loadTree(live!.sm.toSnapshot()); } },
    });
    live = h;
    eventBus.emit('engine:request-save');
    await settle();
    await expectSnapshot('S3', h);
  });
});

// ═══════════════════════════════════════════════════════════════
// B · bridges and assembly
// ═══════════════════════════════════════════════════════════════

describe('orchestrator flow · bridges and assembly', () => {
  it('B1 worldbook:updated keeps the same bundle object; debug-prompt events reach the store; a failing store only warns', async () => {
    const h = host();
    const stage = (name: string): StageLike => h.priv.runner.stages.find((s) => s.name === name)!;
    const getWorldBooks = (): unknown => (stage('ContextAssembly').getWorldBooks as () => unknown)();
    const books = [{ id: 'wb1', name: '新世界书' }];
    L('probe', 'before', snap(getWorldBooks()));
    eventBus.emit('worldbook:updated', books);
    L('probe', 'after update, same array', getWorldBooks() === books, h.priv.subPipelines === h.bundle);
    eventBus.emit('worldbook:updated', undefined);
    L('probe', 'after undefined', snap(getWorldBooks()));
    eventBus.emit('ui:debug-prompt', {
      flow: 'mainRound', variables: { A: '1' }, messages: [{ role: 'user', content: 'hi' }],
      messageSources: ['s1'], generationId: 'g1', roundNumber: 6, compileTrace: { pieces: [] },
    });
    eventBus.emit('ui:debug-prompt', { flow: 'sparse' });
    eventBus.emit('ui:debug-prompt', undefined);
    eventBus.emit('ui:debug-prompt-response', { flow: 'mainRound', generationId: 'g1', thinking: 'think', rawResponse: 'raw' });
    eventBus.emit('ui:debug-prompt-response', undefined);
    shared.promptDebugThrows = true;
    eventBus.emit('ui:debug-prompt', { flow: 'mainRound', messages: [] });
    eventBus.emit('ui:debug-prompt-response', { flow: 'mainRound' });
    await expectSnapshot('B1', h);
  });

  it('B2 runPostRoundForOpening: location read once, NPC generation no-op, busy during the run, done event', async () => {
    const h = host({
      results: {
        'worldHeartbeat.execute': true,
        'npcGeneration.execute': true,
      },
    });
    const ctx = {
      userInput: '', originalUserInput: '', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [],
      roundNumber: 6, meta: { pendingHeartbeat: true },
      parsedResponse: { text: '开局正文' },
    } as unknown as PipelineContext;
    await h.orch.runPostRoundForOpening(ctx, h.sm);
    await settle();
    L('probe', 'isBusy after', h.orch.isBusy);
    await expectSnapshot('B2', h);
  });

  /** Everything a refactor of the stage assembly could change, read through the stages' own fields. */
  async function assemblyProbe(h: Host): Promise<Record<string, unknown>> {
    const stages = h.priv.runner.stages;
    const byName = (name: string): StageLike => stages.find((s) => s.name === name)!;
    const opening = h.priv.createStagesForOpening();
    const ca = byName('ContextAssembly');
    const sc = byName('SettingCapture');
    const deps = sc['deps'] as Record<string, () => unknown>;
    const post = byName('PostProcess');
    const ctx = { roundNumber: 6, meta: {} } as unknown as PipelineContext;
    const isEnabledAcrossSettings: unknown[] = [deps.isEnabled()];
    h.sm.set('系统.设置.prompt', { enableWorldBook: false }, 'user');
    isEnabledAcrossSettings.push(deps.isEnabled());
    h.sm.set('系统.设置.prompt', { enableSettingCapture: false }, 'user');
    isEnabledAcrossSettings.push(deps.isEnabled());
    h.sm.set('系统.设置.prompt', { enableWorldBook: true, enableSettingCapture: true }, 'user');
    isEnabledAcrossSettings.push(deps.isEnabled());
    const plotStage = stages.find((s) => s.name === 'PlotVector');
    return {
      roundStages: stages.map((s) => `${s.name}:${s.constructor.name}`),
      openingStages: Object.fromEntries(Object.entries(opening).map(([k, s]) => [k, `${s.name}:${s.constructor.name}`])),
      roundContextAssembly: {
        useNewBuilder: ca['useNewBuilder'],
        getWorldBooks: snap((ca['getWorldBooks'] as () => unknown)()),
        getGproxyCacheEnabled: (ca['getGproxyCacheEnabled'] as () => boolean)(),
        getPromptTransform: snap((ca['getPromptTransform'] as (c: PipelineContext) => unknown)(ctx)),
      },
      openingContextAssembly: {
        useNewBuilder: opening.contextAssembly['useNewBuilder'],
        getWorldBooks: snap((opening.contextAssembly['getWorldBooks'] as () => unknown)()),
        getGproxyCacheEnabled: opening.contextAssembly['getGproxyCacheEnabled'] === undefined ? '<absent>' : '<present>',
        getPromptTransform: opening.contextAssembly['getPromptTransform'] === undefined ? '<absent>' : '<present>',
      },
      settingCapture: {
        isEnabledAcrossSettings,
        tagNames: snap(deps.getTagNames()),
        anchorStopwords: snap(deps.getAnchorStopwords()),
        labels: snap(deps.getLabels()),
      },
      postProcess: {
        sameActiveSlotClosure: post['getActiveSlot'] === h.priv._getActiveSlot,
        hasBundlePlotVector: post['plotVector'] !== undefined && post['plotVector'] === h.bundle.plotVector,
        openingSameActiveSlotClosure: opening.postProcess['getActiveSlot'] === h.priv._getActiveSlot,
        openingHasPlotVector: opening.postProcess['plotVector'] !== undefined,
        sameMemoryManager: post['memoryManager'] === h.bundle.memoryManager,
        openingSameMemoryManager: opening.postProcess['memoryManager'] === h.bundle.memoryManager,
      },
      openingFreshInstances: opening.aiCall !== byName('AICall') && opening.commandExecution !== byName('CommandExecution'),
      sharedDeps: {
        stateManager: ca['stateManager'] === opening.contextAssembly['stateManager'],
        pack: ca['pack'] === opening.contextAssembly['pack'],
        paths: ca['paths'] === opening.contextAssembly['paths'],
      },
      plotVectorStageExecute: plotStage
        ? snap(await (plotStage as unknown as { execute: (c: PipelineContext) => Promise<unknown> }).execute(ctx))
        : '<no PlotVector stage>',
    };
  }

  it('B3 stage assembly (no plot vector): round stages in order, opening stages, closure results', async () => {
    const h = host({ results: { gproxy: true } });
    const probe = await assemblyProbe(h);
    await expectSnapshot('B3', h, { probe });
  });

  it('B3p stage assembly with a plot-vector port: extra PlotVector stage, promptTransform and PostProcess wiring', async () => {
    const h = host({ plotVector: true });
    const probe = await assemblyProbe(h);
    await expectSnapshot('B3p', h, { probe });
  });

  it('B3f stage assembly with a pack that fills the capture fragments: the closures read the pack', async () => {
    const h = host({
      pack: { ...pack, engineFragments: { ...(pack.engineFragments ?? {}), settingBookTitle: '标题', settingKindCharacter: '人物' } },
    });
    const probe = await assemblyProbe(h);
    await expectSnapshot('B3f', h, { probe });
  });
});
