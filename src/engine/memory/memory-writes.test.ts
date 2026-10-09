import 'fake-indexeddb/auto';
/**
 * Memory write behaviour lock (refactor R6, step 0, group C).
 *
 * The real StateManager, EngramManager, EngramEditor, VectorStore (on a fake IndexedDB), Embedder, Reranker,
 * UnifiedRetriever, batch-solidify pipeline, MemoryManager and MemoryRetriever run together. Only the AI service is a
 * fake: it records every request and answers with a fixed reply per usage type. Embedding goes through the pseudo
 * vectors (no embedding API configured) except in the cases that stub `fetch` and record the whole request. After
 * every step the cases record `系统.扩展.engramMemory`, `记忆`, the VectorStore rows (vectors compacted to a hash),
 * every VectorStore call, the AI and fetch calls and the events. Written byte for byte to
 * `__snapshots__/memory-writes/<id>.json`.
 *
 * A refactor of the memory layer must leave every file unchanged. Snapshots are never rewritten with `-u` during the
 * refactor; a changed snapshot is a failed step. See docs/status/code-audit-2026-10/plans/R6-memory-save-sync.md §3.
 *
 * Determinism: Date is faked and advanced one minute per round (event ids are `evt_<time>_<random>`), Math.random is
 * fixed, `performance.now()` durations are masked, every case builds its own modules and its own IDBFactory, and the
 * fire-and-forget vectorisation / trimming promises are collected and awaited (`drain`) before a step is recorded.
 */
import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createHash } from 'node:crypto';
import { cloneDeep } from 'lodash-es';
import { createMockLocalStorage } from '../__test-utils__/local-storage.mock';
import { serialize, sha256Hex, errorInfo, dumpAllIdb } from '../__test-utils__/snapshot-lock';
import { pseudoEmbed } from './engram/embedder';
import { DEFAULT_ENGINE_PATHS as P } from '../pipeline/types';
import type { AIResponse } from '../ai/types';
import type { APIConfig } from '../ai/types';
import type { RetrievalContext } from './engram/unified-retriever';
import type { BatchSolidifyPaths } from './engram/batch-solidify-pipeline';
import type { EngramEdge } from './engram/knowledge-edge';
import type { EngramEntity } from './engram/entity-builder';
import type { EngramEventNode } from './engram/event-builder';
import type { MemoryPathConfig } from './memory-manager';

// A case builds its own modules and database; the first one of a file also pays the module transform, which is slow
// under a parallel run. A timed-out case is NOT cancelled: it would keep running and swap the globals of the next case.
vi.setConfig({ testTimeout: 120_000 });

const SNAPSHOT_DIR = '__snapshots__/memory-writes';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const FIXED_RANDOM = 0.123456;
const SLOT = { profileId: 'prof_m', slotId: 'slot_m' };
const ENGRAM_KEY = 'aga_engram_config';
const MEMORY_SETTINGS_KEY = 'aga_memory_settings';

type Json = Record<string, unknown>;

async function snapDoc(id: string, doc: unknown): Promise<void> {
  await expect(serialize(doc)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${id}.json`);
}

// ─── volatile values ───

/** Deep copy for recording: `totalDurationMs` is a measured duration, everything else is kept. */
function norm(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) out[k] = k === 'totalDurationMs' ? '<ms>' : norm(v);
    return out;
  }
  return value;
}

/**
 * Vectors are long float lists: record how they are kept (a Float32Array since 存档瘦身 D4A), the dimension and a hash of
 * the values.
 */
function compactVectorData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Json = {};
  for (const [k, v] of Object.entries(data as Json)) {
    if (k.endsWith('Vectors') && v && typeof v === 'object') {
      const compact: Json = {};
      for (const [id, vec] of Object.entries(v as Json)) {
        compact[id] = vec instanceof Float32Array || Array.isArray(vec)
          ? { kept: vec instanceof Float32Array ? 'Float32Array' : 'number[]', dim: vec.length, sha256: sha256Hex(JSON.stringify(Array.from(vec as ArrayLike<number>))) }
          : vec;
      }
      out[k] = compact;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** A small deterministic vector for a text (what a remote embedding API would answer). */
function remoteVector(text: string): number[] {
  const hex = createHash('sha256').update(text).digest('hex');
  return Array.from({ length: 6 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255);
}

/** State-change events carry the whole changed value: record the path, the action and the source only. */
function slimPayload(event: string, payload: unknown): unknown {
  if (event === 'engine:state-changed' && payload && typeof payload === 'object') {
    const p = payload as { change?: { path?: string; action?: string }; source?: string; type?: string };
    if (p.change) return { path: p.change.path, action: p.change.action, source: p.source };
    return { type: p.type };
  }
  return payload === undefined ? undefined : structuredClone(payload);
}

// ─── the environment of one case ───

interface FetchCall { method: string; url: string; headers: unknown; body: unknown }
type Reply = string | ((req: Json) => string | Promise<string>);

interface EnvOptions {
  engramConfig?: Json | null;
  memorySettings?: Json;
  tree?: Json;
  slot?: { profileId: string; slotId: string } | null;
  apiConfigs?: Record<string, APIConfig>;
  replies?: Record<string, Reply>;
  /** `fetch` answers for the embedding and rerank endpoints (when apiConfigs point at them). */
  fetchMode?: 'ok' | 'fail';
}

const ENGRAM_ON: Json = { enabled: true, knowledgeEdgeMode: 'active', debug: false };

async function makeEnv(o: EnvOptions = {}) {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);

  const lsInit: Record<string, string> = {};
  const cfg = o.engramConfig === undefined ? ENGRAM_ON : o.engramConfig;
  if (cfg) lsInit[ENGRAM_KEY] = JSON.stringify(cfg);
  if (o.memorySettings) lsInit[MEMORY_SETTINGS_KEY] = JSON.stringify(o.memorySettings);
  const ls = createMockLocalStorage(lsInit);
  vi.stubGlobal('localStorage', ls.storage);

  const fetchLog: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fetchLog.push({ method: init?.method ?? 'GET', url, headers: init?.headers, body });
    if (o.fetchMode === 'fail') return new Response('upstream down', { status: 500 });
    if (url.endsWith('/v1/embeddings')) {
      const inputs = (body as { input: string[] }).input;
      return new Response(JSON.stringify({ data: inputs.map((t) => ({ embedding: remoteVector(t) })) }), { status: 200 });
    }
    if (url.endsWith('/v1/rerank')) {
      const docs = (body as { documents: string[] }).documents;
      const results = docs.map((_, index) => ({ index, relevance_score: Math.round((0.95 - index * 0.07) * 100) / 100 }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });

  const [smMod, mgrMod, edMod, vecMod, embMod, rrMod, urMod, bsMod, mmMod, mrMod, busMod, idbMod] = await Promise.all([
    import('../core/state-manager'),
    import('./engram/engram-manager'),
    import('./engram/engram-editor'),
    import('./engram/vector-store'),
    import('./engram/embedder'),
    import('./engram/reranker'),
    import('./engram/unified-retriever'),
    import('./engram/batch-solidify-pipeline'),
    import('./memory-manager'),
    import('./memory-retriever'),
    import('../core/event-bus'),
    import('../persistence/idb-adapter'),
  ]);

  // ── AI fake ──
  const aiCalls: unknown[] = [];
  const usageLookups: string[] = [];
  const aiService = {
    getConfigForUsage: (usage: string) => { usageLookups.push(usage); return o.apiConfigs?.[usage]; },
    generate: async (req: Json) => {
      aiCalls.push(structuredClone(req));
      const reply = o.replies?.[String(req['usageType'])];
      if (typeof reply === 'function') return reply(req);
      return reply ?? '';
    },
  };

  // ── what reaches IndexedDB for the vector rows (the persistence-level view of every VectorStore call) ──
  // The promises are collected too: vectorisation and trimming are fire-and-forget, `drain` waits for them.
  const pending: Array<Promise<unknown>> = [];
  const vecLog: Array<{ op: string; key: string; value?: unknown }> = [];
  const adapter = idbMod.idbAdapter as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const op of ['get', 'set', 'delete'] as const) {
    const original = adapter[op];
    vi.spyOn(adapter, op as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const key = String(args[0]);
      if (key.startsWith('engram_vectors_')) {
        vecLog.push(op === 'set' ? { op, key, value: compactVectorData(cloneDeep(args[1])) } : { op, key });
      }
      const result = original.apply(this, args);
      if (key.startsWith('engram_vectors_')) pending.push(result.catch(() => undefined));
      return result;
    } as never);
  }
  const mgrProto = mgrMod.EngramManager.prototype as unknown as { vectorizeAsync: (...a: unknown[]) => Promise<void> };
  const vectorizeOriginal = mgrProto.vectorizeAsync;
  vi.spyOn(mgrProto, 'vectorizeAsync').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const promise = vectorizeOriginal.apply(this, args);
    pending.push(promise.catch(() => undefined));
    return promise;
  } as never);

  const emits: Array<{ event: string; payload: unknown }> = [];
  const emit = busMod.eventBus.emit.bind(busMod.eventBus);
  vi.spyOn(busMod.eventBus, 'emit').mockImplementation((event: string, payload?: unknown) => {
    emits.push({ event, payload: slimPayload(event, payload) });
    return (emit as (e: string, p?: unknown) => void)(event, payload);
  });

  const sm = new smMod.StateManager();
  sm.loadTree(structuredClone(o.tree ?? baseTree()));
  const slot = o.slot === undefined ? SLOT : o.slot;
  const manager = new mgrMod.EngramManager(aiService as never, undefined, () => slot);
  const vectors = new vecMod.VectorStore();

  const lastHeavy: Record<string, string> = {};
  const env = {
    sm, manager, vectors, ls, aiService, aiCalls, usageLookups, fetchLog, vecLog, emits,
    mods: { mgrMod, edMod, vecMod, embMod, rrMod, urMod, bsMod, mmMod, mrMod, busMod },
    slot,
    async drain(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (pending.length === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (pending.length === 0) return;
        }
        await Promise.allSettled(pending.splice(0));
      }
      throw new Error('vectorisation did not settle');
    },
    /** The rows the VectorStore wrote to IndexedDB (vectors compacted). */
    async vectorRows(): Promise<unknown> {
      const dump = await dumpAllIdb();
      const rows = (dump['aga-saves']?.['data'] ?? []).filter(([k]) => k.startsWith('engram_vectors_'));
      return rows.map(([k, v]) => [k, compactVectorData(v)]);
    },
    /** One recorded step: state, vector rows and what happened since the previous step. */
    async step(label: string, extra: Json = {}): Promise<Json> {
      await env.drain();
      const heavy: Json = {
        engramMemory: norm(cloneDeep(sm.get(P.engramMemory))),
        memory: norm(cloneDeep(sm.get('记忆'))),
        vectorRows: await env.vectorRows(),
      };
      const shown: Json = {};
      for (const [k, v] of Object.entries(heavy)) {
        const text = JSON.stringify(v);
        shown[k] = lastHeavy[k] === text ? '<unchanged since the previous step>' : v;
        lastHeavy[k] = text;
      }
      return {
        label,
        ...extra,
        ...shown,
        vectorCalls: vecLog.splice(0),
        aiCalls: aiCalls.splice(0),
        fetchCalls: fetchLog.splice(0),
        emits: emits.splice(0),
      };
    },
    /** Moves the clock to the start of round `n` and the state to round `n`. */
    round(n: number): void {
      vi.setSystemTime(new Date(NOW.getTime() + n * 60_000));
      sm.set(P.roundNumber, n, 'system');
    },
  };
  return env;
}

type Env = Awaited<ReturnType<typeof makeEnv>>;

function baseTree(): Json {
  return {
    元数据: { 回合序号: 0, 叙事历史: [] },
    角色: { 基础信息: { 姓名: '陆沉', 当前位置: '青石镇' } },
    世界: {
      时间: { 年: 1, 月: 3, 日: 5, 小时: 14, 分钟: 20 },
      地点信息: [
        { 名称: '青石镇', 描述: '山脚下的小镇，酒肆与药铺并立。', 连接: ['后山'], NPC: ['Lin Nuan'] },
        { 名称: '后山', 描述: '终年云雾的山林。' },
      ],
    },
    社交: {
      关系: [
        { 名称: 'Lin Nuan', 类型: '重点', 背景: 'Runs the tavern in Qingshi town.', 外貌描述: 'bright eyes, long black hair', 描述: 'tavern owner', 位置: '青石镇' },
        { 名称: 'Guan Yu', 类型: '重点', 背景: 'A wandering swordsman.', 外貌描述: 'sharp brows', 描述: 'swordsman' },
        { 名称: 'Extra Wang', 类型: '普通', 描述: 'a passer-by' },
      ],
    },
    记忆: { 短期: [], 中期: [], 长期: [], 隐式中期: [] },
    系统: { 扩展: {} },
  };
}

function response(text: string, over: Partial<AIResponse> = {}): AIResponse {
  return { text, ...over };
}

function mid(roles: string[], body: string): AIResponse['midTermMemory'] {
  return { 相关角色: roles, 事件时间: '1年3月5日', 记忆主体: body };
}

function fact(fact: string, sourceEntity: string, targetEntity: string): { fact: string; sourceEntity: string; targetEntity: string } {
  return { fact, sourceEntity, targetEntity };
}

let warnSpy: MockInstance<typeof console.warn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const warnings = (): unknown[] => warnSpy.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '<non-string>'));

async function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: norm(await fn()) };
  } catch (err) {
    return { threw: errorInfo(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M1 · three rounds of processResponse
// ═══════════════════════════════════════════════════════════════════════════════════════════

const ROUND_1 = response('陆沉来到青石镇的酒肆，遇见了老板娘林暖。林暖笑着递上一碗热茶。', {
  midTermMemory: mid(['陆沉', 'Lin Nuan'], '陆沉在酒肆遇见 Lin Nuan，她递来热茶。'),
  knowledgeFacts: [
    fact('Lin Nuan runs the tavern in Qingshi town where Lu Chen first met her', 'Lin Nuan', '陆沉'),
    fact('Lin Nuan keeps the tavern in Qingshi town', 'Lin Nuan', '青石镇'),
  ],
});
const ROUND_2 = response('第二天清晨，陆沉在酒肆后院练剑，Guan Yu 恰好路过，二人切磋了几招。', {
  midTermMemory: mid(['陆沉', 'Guan Yu'], '陆沉与 Guan Yu 在酒肆后院切磋。'),
  knowledgeFacts: [
    // the same statement again: reinforced, not duplicated (same edge id)
    fact('Lin Nuan runs the tavern in Qingshi town where Lu Chen first met her', 'Lin Nuan', '陆沉'),
    // the same meaning worded differently and longer: merged into the existing edge (the edge id changes)
    fact('In Qingshi town Lin Nuan runs the tavern where Lu Chen first met her that morning', 'Lin Nuan', '陆沉'),
    fact('Guan Yu spars with Lu Chen in the tavern backyard', 'Guan Yu', '陆沉'),
    // close to an edge of ANOTHER entity pair: flagged for review
    fact('Guan Yu keeps the tavern in Qingshi town', 'Guan Yu', '青石镇'),
  ],
});
const ROUND_3 = response('傍晚，Lin Nuan 告诉陆沉，Guan Yu 其实是她多年未见的旧友。', {
  midTermMemory: mid(['陆沉', 'Lin Nuan', 'Guan Yu'], 'Lin Nuan 说出 Guan Yu 是旧友。'),
  knowledgeFacts: [
    fact('Lin Nuan and Guan Yu are old friends who have not met for years', 'Lin Nuan', 'Guan Yu'),
    // the opposite claim about the same pair, reversed
    fact('Guan Yu is a stranger to Lin Nuan and has never met her', 'Guan Yu', 'Lin Nuan'),
    // two near-identical facts in one round: merged inside the round, the longer one is kept
    fact('Guan Yu drinks at the tavern every evening', 'Guan Yu', '青石镇'),
    fact('Guan Yu drinks at the tavern every single evening', 'Guan Yu', '青石镇'),
  ],
});

describe('R6 step 0 · C · engram writes', () => {
  it('M1 three rounds of processResponse: events, entities, edges, vectors (active edges, edges off, disabled, no slot)', async () => {
    const out: Json = {};

    const env = await makeEnv();
    const steps: Json[] = [];
    for (const [i, resp] of [ROUND_1, ROUND_2, ROUND_3].entries()) {
      env.round(i + 1);
      const snapshot = await env.manager.processResponse(resp, env.sm);
      steps.push(await env.step(`round ${i + 1}`, { returned: norm(snapshot) }));
    }
    out['activeEdges'] = steps;

    const off = await makeEnv({ engramConfig: { enabled: true, knowledgeEdgeMode: 'off' } });
    off.round(1);
    const offSnap = await off.manager.processResponse(ROUND_1, off.sm);
    out['edgesOff'] = await off.step('round 1', { returned: norm(offSnap) });

    const disabled = await makeEnv({ engramConfig: { enabled: false } });
    disabled.round(1);
    const none = await disabled.manager.processResponse(ROUND_1, disabled.sm);
    out['engineDisabled'] = await disabled.step('round 1', { returned: none, isEnabled: disabled.manager.isEnabled() });

    const noSlot = await makeEnv({ slot: null });
    noSlot.round(1);
    const noSlotSnap = await noSlot.manager.processResponse(ROUND_1, noSlot.sm);
    out['noActiveSlot'] = await noSlot.step('round 1', { returned: norm(noSlotSnap) });

    const emptyText = await makeEnv();
    emptyText.round(1);
    const emptySnap = await emptyText.manager.processResponse(response('   '), emptyText.sm);
    out['emptyNarrative'] = await emptyText.step('round 1', { returned: norm(emptySnap) });

    out['warnings'] = warnings();
    await snapDoc('M1-three-rounds', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M2 · active edge mode: stubs, sentence-like names, pending enrichment, user entities, canon facts
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it('M2 active edge mode: stub entities, rejected sentence-like names, restored stubs and user entities, canon mutations', async () => {
    // pruning off, so the user entity and the "ordinary" NPC are not filtered away (the prune-on run is at the end)
    const env = await makeEnv({ engramConfig: { ...ENGRAM_ON, pruneToImportantNpcs: false } });
    const userEntity: EngramEntity = {
      name: 'Old Hermit', type: 'npc', summary: 'a hermit the player wrote down', attributes: {}, firstSeen: 0, lastSeen: 0,
      mentionCount: 0, is_embedded: false, source: 'user', userEditedAtRound: 0,
    };
    env.sm.set(P.engramMemory, {
      events: [], entities: [userEntity], relations: [], v2Edges: [],
      meta: { lastUpdated: 0, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5 },
    }, 'system');
    const steps: Json[] = [];

    env.round(1);
    const r1 = await env.manager.processResponse(response('陆沉在山道上遇到了一口古井和一位隐士，隐士讲起古井的来历。', {
      midTermMemory: mid(['陆沉'], '陆沉在山道遇到古井与隐士。'),
      knowledgeFacts: [
        fact('The Old Well lies on the mountain path where Lu Chen met the hermit', 'Old Well', '陆沉'),            // stub: unknown endpoint
        fact('Lu Chen heard the hermit tell where the old well came from', '陆沉', '那位总是坐在井边讲述来历的隐士先生'), // sentence-like name: refused
        fact('A stranger meets another stranger on the road', 'Stranger One', 'Stranger Two'),                       // both unknown: dropped
        fact('too short', 'Lin Nuan', '陆沉'),                                                                       // below the length filter
        fact('Old Hermit guards the secret of the old well for years', 'Old Hermit', 'Old Well'),                    // user entity + stub
      ],
    }), env.sm);
    steps.push(await env.step('round 1', { returned: norm(r1) }));

    env.round(2);
    const r2 = await env.manager.processResponse(response('第二天，陆沉回到酒肆，Lin Nuan 问起了古井的传闻。', {
      midTermMemory: mid(['陆沉', 'Lin Nuan'], '陆沉向 Lin Nuan 讲起古井。'),
      knowledgeFacts: [fact('Lin Nuan asks Lu Chen about the rumour of the old well', 'Lin Nuan', 'Old Well')],
    }), env.sm);
    steps.push(await env.step('round 2: the stub survives the rebuild', { returned: norm(r2) }));

    env.round(3);
    const r3 = await env.manager.processResponse(response('陆沉在酒肆里听 Guan Yu 说起了他们的约定，约定写成了设定。'), env.sm, {
      canonMutations: [
        { entryId: 'canon_1', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] },
        { entryId: 'canon_2', kind: 'relationship', statement: '林月是玩家的妹妹', entities: ['林月', '陆沉'] },
        { entryId: 'canon_3', kind: 'character', statement: 'Guan Yu fears water', entities: ['Guan Yu'] },
        { entryId: 'canon_4', kind: 'relationship', statement: 'ignored retraction', entities: ['Guan Yu', 'Lin Nuan'], op: 'retract' },
      ],
    });
    steps.push(await env.step('round 3: canon mutations ride the same write', { returned: norm(r3) }));

    env.round(4);
    const r4 = await env.manager.processResponse(response('陆沉与 Guan Yu 比剑。', {
      knowledgeFacts: [fact('Guan Yu spars with Lu Chen on the mountain path every dawn', 'Guan Yu', '陆沉')],
    }), env.sm, {
      includeAllNpcTypes: true,
      defaultEdgeCore: true,
      defaultEdgeSource: 'opening',
    });
    steps.push(await env.step('round 4: includeAllNpcTypes and the batch defaults', { returned: norm(r4) }));

    // the same user entity with the default pruning: the important-NPC filter does not exempt it
    const pruned = await makeEnv();
    pruned.sm.set(P.engramMemory, {
      events: [], entities: [userEntity], relations: [], v2Edges: [],
      meta: { lastUpdated: 0, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5 },
    }, 'system');
    pruned.round(1);
    const pr = await pruned.manager.processResponse(response('陆沉遇到一位隐士。', {
      knowledgeFacts: [fact('Old Hermit guards the secret of the old well for years', 'Old Hermit', 'Old Well')],
    }), pruned.sm);
    steps.push(await pruned.step('default pruning with a user entity', { returned: norm(pr) }));
    await snapDoc('M2-active-edges', { steps, warnings: warnings() });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M3 · remote embedding and rerank
  // ═════════════════════════════════════════════════════════════════════════════════════════

  const REMOTE: Record<string, APIConfig> = {
    embedding: { name: 'emb', url: 'https://embed.test/', apiKey: 'k-emb', model: 'embed-m' } as APIConfig,
    rerank: { name: 'rr', url: 'https://rerank.test', apiKey: 'k-rr', model: 'rerank-m', apiCategory: 'rerank' } as APIConfig,
  };
  const RETRIEVE_CTX: RetrievalContext = { playerName: '陆沉', locationDesc: '青石镇', recentNpcNames: ['Lin Nuan'] };

  it('M3 remote embedding and rerank: the writes call /v1/embeddings, retrieval embeds the query and reranks', async () => {
    const out: Json = {};
    for (const mode of ['ok', 'fail'] as const) {
      const env = await makeEnv({
        apiConfigs: REMOTE,
        fetchMode: mode,
        engramConfig: { ...ENGRAM_ON, embeddingModel: 'embed-m', rerank: { enabled: true, topN: 4 } },
      });
      const steps: Json[] = [];
      for (const [i, resp] of [ROUND_1, ROUND_2, ROUND_3].entries()) {
        env.round(i + 1);
        const snapshot = await env.manager.processResponse(resp, env.sm);
        steps.push(await env.step(`round ${i + 1}`, { returned: norm(snapshot) }));
      }
      env.round(12);
      const reranker = new env.mods.rrMod.Reranker(env.aiService as never);
      const embedder = new env.mods.embMod.Embedder(env.aiService as never);
      const retriever = new env.mods.urMod.UnifiedRetriever(
        env.vectors, embedder, reranker,
        { embedding: { enabled: true, topK: 8, minScore: 0.1 }, rerank: { enabled: true, topN: 4 }, shortTermWindow: 2, maxCandidates: 8 },
        undefined, () => env.slot,
      );
      const text = await retriever.retrieve('Lin Nuan tavern Lu Chen old friends', RETRIEVE_CTX, env.sm);
      steps.push(await env.step('retrieve', { returned: text, readSnapshot: norm(retriever.lastReadSnapshot) }));
      out[mode] = { steps, usageLookups: env.usageLookups.length };
    }
    out['warnings'] = warnings();
    await snapDoc('M3-remote-embedding-rerank', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M4 · pruning: important NPCs and the trim limits
  // ═════════════════════════════════════════════════════════════════════════════════════════

  function longRound(n: number, repeat: number): AIResponse {
    const facts = [
      fact(`Extra Wang keeps asking about the weather in the market square on day ${n}`, 'Extra Wang', '集市广场'),
      fact('Extra Wang sells vegetables at the market square every single morning', 'Extra Wang', '集市广场'),
      fact(`Guan Yu trains Lu Chen in swordsmanship during round ${n} behind the tavern`, 'Guan Yu', '陆沉'),
    ];
    return response(`第${n}回合：陆沉在青石镇度过了平静的一天。${'他把今天发生的事情仔细记在了心里，'.repeat(repeat)}`, {
      midTermMemory: mid(['陆沉', 'Guan Yu'], `第${n}回合的记忆。`),
      knowledgeFacts: facts,
    });
  }

  it('M4 pruning: important-NPC filter, count trim, token trim, entity cap', async () => {
    const out: Json = {};
    const variants: Array<[string, Json, number]> = [
      ['countTrim', { ...ENGRAM_ON, pruneToImportantNpcs: true, trim: { trigger: 'count', countLimit: 10, keepRecent: 3, tokenLimit: 6000 }, maxEntities: 5 }, 3],
      ['tokenTrim', { ...ENGRAM_ON, pruneToImportantNpcs: true, trim: { trigger: 'token', countLimit: 120, keepRecent: 2, tokenLimit: 500 } }, 14],
      ['noImportantFilter', { ...ENGRAM_ON, pruneToImportantNpcs: false, trim: { trigger: 'count', countLimit: 10, keepRecent: 3, tokenLimit: 6000 } }, 3],
    ];
    for (const [name, engramConfig, repeat] of variants) {
      const env = await makeEnv({ engramConfig });
      const seedEdge = (id: string, over: Partial<EngramEdge>): EngramEdge => ({
        id, sourceEntity: 'Extra Wang', targetEntity: '集市广场', fact: `seeded fact ${id} about the market square`, episodes: [],
        is_embedded: true, createdAtRound: 0, lastSeenRound: 0, ...over,
      });
      env.sm.set(P.engramMemory, {
        events: [],
        entities: [],
        relations: [],
        v2Edges: [
          seedEdge('seed_three_episodes', { episodes: ['a', 'b', 'c'] }),
          seedEdge('seed_batch_sync', { source: 'batch-sync' }),
          seedEdge('seed_user', { source: 'user' }),
          seedEdge('seed_user_canon', { source: 'user-canon' }),
          seedEdge('seed_opening', { source: 'opening' }),
          seedEdge('seed_card_import', { source: 'card-import' }),
          seedEdge('seed_core', { core: true }),
          seedEdge('seed_dropped', {}),
          seedEdge('seed_important_endpoint', { sourceEntity: 'Guan Yu', targetEntity: '集市广场' }),
          seedEdge('seed_player_endpoint', { sourceEntity: '陆沉', targetEntity: '集市广场' }),
        ],
        meta: { lastUpdated: 0, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5 },
      }, 'system');
      const steps: Json[] = [];
      for (let n = 1; n <= 13; n++) {
        env.round(n);
        const snapshot = await env.manager.processResponse(longRound(n, repeat), env.sm);
        if (n === 3 || n === 13) steps.push(await env.step(`round ${n}`, { returned: norm(snapshot) }));
        else await env.drain();
      }
      out[name] = steps;
    }
    await snapDoc('M4-pruning', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M5 · legacy data and the schema migrations
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it('M5 legacy data is cleared with its vectors, v3 and v4 states migrate to v5', async () => {
    const out: Json = {};
    const goodEvent = (id: string, round: number): EngramEventNode => ({
      id, subject: '陆沉', action: 'narrative', tags: ['narrative'], text: `old event ${id}`, summary: `old event ${id}`,
      structured_kv: { event: id, role: ['陆沉'], location: ['青石镇'], time_anchor: '', causality: '承接', logic: [] },
      is_embedded: true, roundNumber: round,
    });
    const seedVectors = async (env: Env): Promise<void> => {
      await env.vectors.save(SLOT.profileId, SLOT.slotId, {
        eventVectors: { evt_old: [0.1, 0.2] }, entityVectors: { Ghost: [0.3, 0.4] }, edgeVectors: { edge_old: [0.5, 0.6] }, model: 'old-model', dim: 2,
      });
      env.vecLog.length = 0;
    };

    const legacy = await makeEnv();
    legacy.sm.set(P.engramMemory, {
      events: [{ id: 'evt_legacy', subject: '陆沉', action: 'narrative', tags: [], text: 'legacy event without summary', roundNumber: 1 }],
      entities: [{ name: 'Ghost', type: 'npc', summary: '', attributes: {}, firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: true }],
      relations: [], v2Edges: [], meta: { lastUpdated: 5, eventCount: 1, embeddedEventCount: 1, embeddedEntityCount: 1, schemaVersion: 3 },
    }, 'system');
    await seedVectors(legacy);
    legacy.round(5);
    const legacySnap = await legacy.manager.processResponse(ROUND_1, legacy.sm);
    out['legacyEventsWithoutSummary'] = await legacy.step('round 5', { returned: norm(legacySnap) });

    const v3 = await makeEnv();
    v3.sm.set(P.engramMemory, {
      events: [goodEvent('evt_v3', 1)],
      entities: [{ name: 'Lin Nuan', type: 'npc', summary: 'tavern owner', attributes: {}, firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: true }],
      relations: [],
      v2Edges: [
        { id: 'edge_v3_a', sourceEntity: 'Lin Nuan', targetEntity: '陆沉', fact: 'Lin Nuan serves tea to Lu Chen at the tavern', episodes: ['evt_v3'], is_embedded: true, createdAtRound: 1, lastSeenRound: 1, invalidatedAtRound: 2, temporalStatus: 'historical' },
        { id: 'edge_v3_b', sourceEntity: 'Lin Nuan', targetEntity: 'Guan Yu', fact: 'Lin Nuan and Guan Yu grew up in the same town', episodes: [], is_embedded: false, createdAtRound: 1, lastSeenRound: 1 },
      ],
      meta: { lastUpdated: 5, eventCount: 1, embeddedEventCount: 1, embeddedEntityCount: 1, schemaVersion: 3 },
    }, 'system');
    await seedVectors(v3);
    v3.round(5);
    const v3Snap = await v3.manager.processResponse(response('陆沉在酒肆喝茶。'), v3.sm);
    out['v3ToV5'] = await v3.step('round 5', { returned: norm(v3Snap) });

    const v4 = await makeEnv();
    v4.sm.set(P.engramMemory, {
      events: [goodEvent('evt_v4', 1)], entities: [], relations: [],
      v2Edges: [{ id: 'edge_v4', sourceEntity: 'Lin Nuan', targetEntity: '陆沉', fact: 'Lin Nuan serves tea to Lu Chen at the tavern', episodes: [], is_embedded: true, createdAtRound: 2, lastSeenRound: 3, invalidatedAtRound: 4 }],
      meta: { lastUpdated: 5, eventCount: 1, embeddedEventCount: 1, embeddedEntityCount: 0, schemaVersion: 4, v2PendingReview: [{ newFact: 'x', oldEdgeId: 'edge_v4', similarity: 0.7 }] },
    }, 'system');
    v4.round(5);
    const v4Snap = await v4.manager.processResponse(response('陆沉离开了酒肆。'), v4.sm);
    out['v4ToV5'] = await v4.step('round 5', { returned: norm(v4Snap) });

    const noSchema = await makeEnv();
    noSchema.sm.set(P.engramMemory, { events: [], meta: {} }, 'system');
    noSchema.round(1);
    const nsSnap = await noSchema.manager.processResponse(response('陆沉第一次来到青石镇。'), noSchema.sm);
    out['eventsOnlyNoMeta'] = await noSchema.step('round 1', { returned: norm(nsSnap) });
    await snapDoc('M5-legacy-and-migrations', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M6 · canon entries: invalidate and re-project
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it('M6 invalidateCanonEntries and reprojectCanonEntry', async () => {
    const out: Json = {};
    const env = await makeEnv();
    env.round(1);
    await env.manager.processResponse(response('陆沉与 Guan Yu 结为兄弟。'), env.sm, {
      canonMutations: [
        { entryId: 'canon_a', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] },
        { entryId: 'canon_b', kind: 'relationship', statement: 'Lin Nuan is the landlady of the tavern Lu Chen lives in', entities: ['Lin Nuan', '陆沉'] },
      ],
    });
    out['setup'] = await env.step('after the canon round');

    env.round(2);
    out['invalidateNothing'] = await attempt(() => env.manager.invalidateCanonEntries(env.sm, []));
    out['invalidateNotAnArray'] = await attempt(() => env.manager.invalidateCanonEntries(env.sm, undefined as never));
    out['invalidateUnknown'] = await attempt(() => env.manager.invalidateCanonEntries(env.sm, ['canon_zzz']));
    out['invalidateOne'] = await attempt(() => env.manager.invalidateCanonEntries(env.sm, ['canon_a']));
    out['invalidateAgain'] = await attempt(() => env.manager.invalidateCanonEntries(env.sm, ['canon_a']));
    out['afterInvalidate'] = await env.step('after invalidation');

    env.round(3);
    out['restore'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_a', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] }));
    out['edit'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_b', kind: 'relationship', statement: 'Lin Nuan is the cousin of Lu Chen and lives next door', entities: ['Lin Nuan', '陆沉'] }));
    out['newEntityStub'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_c', kind: 'relationship', statement: '林月是玩家的妹妹', entities: ['林月', '陆沉'] }));
    out['sentenceLikeName'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_d', kind: 'relationship', statement: 'Somebody stands by Lu Chen at the gate', entities: ['那位总是站在城门口等着陆沉回来的人', '陆沉'] }));
    out['becomesTrait'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_a', kind: 'character', statement: 'Guan Yu fears water', entities: ['Guan Yu'] }));
    out['retractOp'] = await attempt(() => env.manager.reprojectCanonEntry(env.sm, { entryId: 'canon_b', kind: 'relationship', statement: 'x', entities: ['Lin Nuan', '陆沉'], op: 'retract' }));
    out['afterReproject'] = await env.step('after re-projection');

    const off = await makeEnv({ engramConfig: { enabled: true, knowledgeEdgeMode: 'off' } });
    out['edgesOff'] = await attempt(() => off.manager.reprojectCanonEntry(off.sm, { entryId: 'canon_a', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] }));
    const disabled = await makeEnv({ engramConfig: { enabled: false } });
    out['engineDisabled'] = await attempt(() => disabled.manager.reprojectCanonEntry(disabled.sm, { entryId: 'canon_a', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] }));

    const empty = await makeEnv();
    out['emptyEngramInvalidate'] = { result: await attempt(() => empty.manager.invalidateCanonEntries(empty.sm, ['canon_a'])), engramKeyWritten: empty.sm.get(P.engramMemory) !== undefined };
    out['emptyEngramReproject'] = { result: await attempt(() => empty.manager.reprojectCanonEntry(empty.sm, { entryId: 'canon_a', kind: 'relationship', statement: 'Guan Yu is the sworn brother of Lu Chen', entities: ['Guan Yu', '陆沉'] })) };
    out['emptyEngramState'] = await empty.step('empty engram after both');
    out['warnings'] = warnings();
    await snapDoc('M6-canon-entries', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M7 · EngramEditor: every write, the errors, the coverage stats
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it('M7 EngramEditor writes and coverage stats (also from an empty engram)', async () => {
    const env = await makeEnv();
    const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
    const steps: Json[] = [];
    const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      env.round(steps.length + 1);
      const result = await attempt(fn);
      steps.push(await env.step(label, { result }));
    };

    // from nothing at all: the editor builds its own empty structure
    await run('createEntity on an empty engram', () => editor.createEntity({ name: 'Alchemist Zhou', type: 'npc', summary: 'brews pills at the back of the clinic', attributes: { age: 40 } }));
    const coverageEmpty = editor.getCoverageStats();

    // a world to edit: one round of the manager
    env.round(20);
    await env.manager.processResponse(ROUND_1, env.sm);
    await env.manager.processResponse(response('陆沉与 Guan Yu 同行。', { knowledgeFacts: [fact('Guan Yu travels together with Lu Chen along the mountain road', 'Guan Yu', '陆沉')] }), env.sm);
    steps.push(await env.step('world built by the manager'));

    await run('createEntity (immediate vectorize)', async () => editor.createEntity({ name: 'Blacksmith Li', type: 'npc', summary: 'forges swords' }, { vectorize: 'immediate' }));
    await run('createEntity duplicate', () => editor.createEntity({ name: 'Blacksmith Li' }));
    await run('createEntity empty name', () => editor.createEntity({ name: '   ' }));
    await run('updateEntity', () => editor.updateEntity('Blacksmith Li', { summary: 'forges swords and ploughshares', attributes: { forge: 'east gate' }, type: 'npc' }));
    await run('updateEntity unknown', () => editor.updateEntity('Nobody', { summary: 'x' }));
    await run('renameEntity (cascades the edges)', () => editor.renameEntity('Guan Yu', 'Guan Yunchang'));
    await run('renameEntity conflict', () => editor.renameEntity('Guan Yunchang', 'Lin Nuan'));
    await run('renameEntity empty', () => editor.renameEntity('Guan Yunchang', ' '));
    await run('createEdge with one stubbed endpoint', () => editor.createEdge({ sourceEntity: 'Blacksmith Li', targetEntity: 'Iron Gate', fact: 'Blacksmith Li works by the Iron Gate every day', core: true }));
    await run('createEdge no known endpoint', () => editor.createEdge({ sourceEntity: 'Nobody A', targetEntity: 'Nobody B', fact: 'Nobody A knows Nobody B very well' }));
    await run('createEdge fact too short', () => editor.createEdge({ sourceEntity: 'Blacksmith Li', targetEntity: 'Lin Nuan', fact: 'short' }));
    await run('createEdge twice', async () => {
      await editor.createEdge({ sourceEntity: 'Blacksmith Li', targetEntity: 'Lin Nuan', fact: 'Blacksmith Li buys charcoal from Lin Nuan' }, { vectorize: 'immediate' });
      return editor.createEdge({ sourceEntity: 'Blacksmith Li', targetEntity: 'Lin Nuan', fact: 'Blacksmith Li buys charcoal from Lin Nuan' });
    });
    const edgeId = (env.sm.get<{ v2Edges: EngramEdge[] }>(P.engramMemory)?.v2Edges ?? []).find((e) => e.fact.startsWith('Blacksmith Li works'))?.id ?? 'missing';
    await run('updateEdge (identity changes)', () => editor.updateEdge(edgeId, { fact: 'Blacksmith Li works by the Iron Gate from dawn', confidence: 0.9 }));
    const edgeId2 = (env.sm.get<{ v2Edges: EngramEdge[] }>(P.engramMemory)?.v2Edges ?? []).find((e) => e.fact.startsWith('Blacksmith Li works'))?.id ?? 'missing';
    await run('updateEdge flag only', () => editor.updateEdge(edgeId2, { core: false }));
    await run('updateEdge fact too short', () => editor.updateEdge(edgeId2, { fact: 'x' }));
    await run('updateEdge unknown', () => editor.updateEdge('edge_missing', { core: true }));
    await run('markEdgeCore', () => editor.markEdgeCore(edgeId2, true));
    await run('markEdgeCore unknown', () => editor.markEdgeCore('edge_missing', true));
    await run('bulkCreateEntities', () => editor.bulkCreateEntities([
      { name: 'Herbalist Qin', summary: 'sells herbs' }, { name: '后山', type: 'location' }, { name: 'Herbalist Qin' }, { name: ' ' },
    ]));
    await run('bulkCreateEdges', () => editor.bulkCreateEdges([
      { sourceEntity: 'Herbalist Qin', targetEntity: '后山', fact: 'Herbalist Qin picks herbs on the back mountain' },
      { sourceEntity: 'Herbalist Qin', targetEntity: 'Stranger', fact: 'Herbalist Qin sells herbs to every Stranger' },
      { sourceEntity: 'Unknown A', targetEntity: 'Unknown B', fact: 'Unknown A and Unknown B never appear anywhere' },
      { sourceEntity: 'Herbalist Qin', targetEntity: '后山', fact: 'Herbalist Qin picks herbs on the back mountain' },
      { sourceEntity: 'Herbalist Qin', targetEntity: '后山', fact: 'short' },
    ], { defaultCore: false, defaultSource: 'batch-sync' }));
    await run('bulkMarkEdgesCore', () => editor.bulkMarkEdgesCore([edgeId2, 'edge_missing'], false));
    await run('deleteEntity with cascade', () => editor.deleteEntity('Blacksmith Li'));
    await run('deleteEntity without cascade', () => editor.deleteEntity('Herbalist Qin', { cascade: false }));
    await run('deleteEntity unknown', () => editor.deleteEntity('Nobody'));
    await run('deleteEdge', async () => {
      const edges = env.sm.get<{ v2Edges: EngramEdge[] }>(P.engramMemory)?.v2Edges ?? [];
      return editor.deleteEdge(edges[0].id);
    });
    await run('deleteEdge unknown', () => editor.deleteEdge('edge_missing'));
    await run('vectorizePending', () => editor.vectorizePending());

    // coverage: array-shaped locations (the production shape) and Record-shaped locations
    const coverage = editor.getCoverageStats();
    const recordTree = {
      社交: { 关系: [{ 名称: 'Lin Nuan', 类型: '重点' }, { 名称: 'Ghost NPC', 类型: '重点' }, { 名称: 'Extra Wang', 类型: '普通' }] },
      世界: { 地点信息: { loc1: { 名称: '青石镇' }, loc2: { 名称: '后山' }, loc3: { 名称: 'Missing Place' }, bad: 'not a location' } },
      系统: {
        扩展: {
          engramMemory: {
            events: [], entities: [
              { name: 'Lin Nuan', type: 'npc' }, { name: '青石镇', type: 'location' }, { name: 'Stub Place', type: 'location', _pendingEnrichment: true },
            ],
            v2Edges: [{ source: 'opening' }, { source: 'user' }, { source: 'user-canon' }, { source: 'batch-sync' }, { source: 'card-import' }, { source: 'ai' }, {}],
          },
        },
      },
    };
    const coverageRecord = editor.getCoverageStatsForTree(recordTree);
    const coverageNoEngram = editor.getCoverageStatsForTree({ 社交: { 关系: [] } });
    await snapDoc('M7-editor-writes', {
      steps, coverageEmpty, coverage, coverageRecord, coverageNoEngram,
      coverageMatchesTreeWalk: JSON.stringify(coverage) === JSON.stringify(editor.getCoverageStatsForTree(env.sm.toSnapshot())),
      warnings: warnings(),
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M8 · batch solidify
  // ═════════════════════════════════════════════════════════════════════════════════════════

  const SOLIDIFY_PATHS: BatchSolidifyPaths = {
    relationships: P.relationships,
    locations: P.locations,
    engramMemory: P.engramMemory,
    playerName: P.playerName,
    roundNumber: P.roundNumber,
    npcNameField: '名称',
    npcTypeField: '类型',
    npcTypeExclude: '普通',
    npcAppearanceField: '外貌描述',
    npcDescriptionField: '描述',
    locationNameField: '名称',
    locationDescriptionField: '描述',
    narrativeHistory: P.narrativeHistory,
  };

  async function solidifyEnv(reply: Reply | undefined, tree: Json = solidifyTree()): Promise<Env> {
    return makeEnv({ tree, replies: reply === undefined ? {} : { engram_batch_solidify: reply } });
  }

  function solidifyTree(): Json {
    const tree = baseTree();
    (tree['元数据'] as Json)['叙事历史'] = [
      { role: 'user', content: '去酒肆看看' }, { role: 'assistant', content: '陆沉走进了酒肆。' },
      { role: 'user', content: '和老板娘聊聊' }, { role: 'assistant', content: 'Lin Nuan 笑着迎了上来。' },
    ];
    (tree['记忆'] as Json)['短期'] = [{ round: 1, summary: '陆沉走进酒肆', timestamp: 1 }, { 内容: '第二条短期记忆' }, '第三条短期记忆'];
    // an NPC with no description anywhere: the AI is asked for one
    (tree['社交'] as { 关系: Json[] }).关系.push({ 名称: 'Silent Monk', 类型: '重点' });
    return tree;
  }

  async function seedSolidifyEngram(env: Env): Promise<void> {
    // a partly built graph: Lin Nuan is known, a deleted NPC still has an edge, one description is stale
    env.round(3);
    env.sm.set(P.engramMemory, {
      events: [],
      entities: [
        { name: '陆沉', type: 'player', summary: '玩家角色', attributes: {}, firstSeen: 0, lastSeen: 3, mentionCount: 1, is_embedded: true },
        { name: 'Lin Nuan', type: 'npc', summary: 'an outdated description', attributes: {}, firstSeen: 1, lastSeen: 3, mentionCount: 2, is_embedded: true },
        { name: 'Gone NPC', type: 'npc', summary: 'was deleted from the state tree', attributes: {}, firstSeen: 1, lastSeen: 2, mentionCount: 1, is_embedded: true },
      ],
      relations: [],
      v2Edges: [
        { id: 'edge_gone', sourceEntity: 'Gone NPC', targetEntity: '陆沉', fact: 'Gone NPC once travelled with Lu Chen on the road', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 2 },
        { id: 'edge_ok', sourceEntity: 'Lin Nuan', targetEntity: '陆沉', fact: 'Lin Nuan serves tea to Lu Chen at the tavern', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 3 },
      ],
      meta: { lastUpdated: 3, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 3, schemaVersion: 5 },
    }, 'system');
    await env.vectors.save(SLOT.profileId, SLOT.slotId, {
      eventVectors: {}, entityVectors: { 陆沉: [1, 0], 'Lin Nuan': [0, 1], 'Gone NPC': [1, 1] }, edgeVectors: { edge_gone: [1, 0], edge_ok: [0, 1] }, model: 'm', dim: 2,
    });
    env.vecLog.length = 0;
  }

  const GOOD_REPLY = [
    '<thinking>working it out</thinking>',
    'Here is the JSON you asked for:',
    '```json',
    JSON.stringify({
      knowledge_facts: [
        { source_entity: 'Silent Monk', target_entity: '青石镇', fact: 'Silent Monk meditates in the Qingshi town temple every dawn' },
        { source_entity: 'Guan Yu', target_entity: 'Lin Nuan', fact: 'Guan Yu drinks at the tavern that Lin Nuan runs' },
        { source_entity: 'Ghost', target_entity: 'Lin Nuan', fact: 'Ghost is not anywhere in the world data at all' },
        { source_entity: 'Guan Yu', target_entity: '后山', fact: 'too short' },
        { source_entity: 'Guan Yu', target_entity: 'Nowhere', fact: 'Guan Yu hides a sword somewhere that is not a place' },
      ],
      entity_descriptions: [
        { name: 'Silent Monk', summary: 'A monk who has taken a vow of silence and lives in the temple.' },
        { name: 'Guan Yu', summary: 'should not overwrite the description from the state tree' },
        { name: '   ', summary: 'blank name' },
      ],
    }),
    '```',
  ].join('\n');

  it('M8 batch solidify: a normal reply, an unparseable reply, nothing to do, a failing AI, engram disabled', async () => {
    const out: Json = {};
    const progressOf = (progress: string[]) => (phase: string) => { progress.push(phase); };

    {
      const env = await solidifyEnv(GOOD_REPLY);
      await seedSolidifyEngram(env);
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const retriever = new env.mods.mrMod.MemoryRetriever(MEMORY_PATHS);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager,
        paths: SOLIDIFY_PATHS, jailbreakPrompt: '  JAILBREAK TEXT  ', memoryRetriever: retriever,
      });
      const progress: string[] = [];
      const result = await attempt(() => pipeline.run(progressOf(progress)));
      out['normalReply'] = await env.step('after run', { result, progress });
      const again: string[] = [];
      env.round(4);
      const second = await attempt(() => pipeline.run(progressOf(again)));
      out['normalReplyRunAgain'] = await env.step('second run', { result: second, progress: again });
    }

    {
      const env = await solidifyEnv('I cannot produce JSON today, sorry.');
      await seedSolidifyEngram(env);
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager, paths: SOLIDIFY_PATHS,
      });
      const progress: string[] = [];
      const result = await attempt(() => pipeline.run(progressOf(progress)));
      out['unparseableReply'] = await env.step('after run', { result, progress });
    }

    {
      const env = await solidifyEnv(JSON.stringify({ knowledge_facts: [{ source_entity: 'Nowhere', target_entity: 'Ghost', fact: 'Nowhere is next to Ghost for no reason at all' }], entity_descriptions: [] }));
      await seedSolidifyEngram(env);
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager, paths: SOLIDIFY_PATHS,
      });
      const progress: string[] = [];
      const result = await attempt(() => pipeline.run(progressOf(progress)));
      out['onlyInvalidFacts'] = await env.step('after run', { result, progress });
    }

    {
      // nothing missing: every NPC and place already has an entity and an edge
      const tree = baseTree();
      (tree['社交'] as { 关系: Json[] }).关系 = [{ 名称: 'Lin Nuan', 类型: '重点', 外貌描述: 'bright eyes' }];
      (tree['世界'] as Json)['地点信息'] = [{ 名称: '青石镇', 描述: 'a small town' }];
      const env = await solidifyEnv('unused', tree);
      env.round(3);
      env.sm.set(P.engramMemory, {
        events: [],
        entities: [
          { name: '陆沉', type: 'player', summary: '玩家角色', attributes: {}, firstSeen: 0, lastSeen: 3, mentionCount: 1, is_embedded: true },
          { name: 'Lin Nuan', type: 'npc', summary: 'stale', attributes: {}, firstSeen: 1, lastSeen: 3, mentionCount: 1, is_embedded: true },
          { name: '青石镇', type: 'location', summary: 'a small town', attributes: {}, firstSeen: 1, lastSeen: 3, mentionCount: 1, is_embedded: true },
        ],
        relations: [],
        v2Edges: [
          { id: 'e1', sourceEntity: 'Lin Nuan', targetEntity: '青石镇', fact: 'Lin Nuan runs the tavern in Qingshi town', episodes: [], is_embedded: true, createdAtRound: 1, lastSeenRound: 3 },
        ],
        meta: { lastUpdated: 3, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 3, schemaVersion: 5 },
      }, 'system');
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager, paths: SOLIDIFY_PATHS,
      });
      const progress: string[] = [];
      const result = await attempt(() => pipeline.run(progressOf(progress)));
      out['alreadyComplete'] = await env.step('after run', { result, progress });
    }

    {
      const env = await solidifyEnv(() => { throw new Error('ai boom'); });
      await seedSolidifyEngram(env);
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager, paths: SOLIDIFY_PATHS,
      });
      const progress: string[] = [];
      const result = await attempt(() => pipeline.run(progressOf(progress)));
      out['aiThrows'] = await env.step('after run', { result, progress });
    }

    {
      const env = await makeEnv({ engramConfig: { enabled: false } });
      const editor = new env.mods.edMod.EngramEditor(env.sm, env.manager);
      const pipeline = new env.mods.bsMod.EngramBatchSolidifyPipeline({
        aiService: env.aiService as never, stateManager: env.sm, engramEditor: editor, engramManager: env.manager, paths: SOLIDIFY_PATHS,
      });
      out['engramDisabled'] = await attempt(() => pipeline.run());
    }
    out['warnings'] = warnings();
    await snapDoc('M8-batch-solidify', out);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // M9 · MemoryManager (four layers) and MemoryRetriever
  // ═════════════════════════════════════════════════════════════════════════════════════════

  const MEMORY_PATHS: MemoryPathConfig = {
    shortTermPath: '记忆.短期',
    midTermPath: '记忆.中期',
    longTermPath: '记忆.长期',
    implicitMidTermPath: '记忆.隐式中期',
    shortTermCapacity: 5,
    midTermRefineThreshold: 25,
    longTermSummaryThreshold: 50,
    longTermSummarizeCount: 50,
    midTermKeep: 0,
    longTermCap: 30,
  };

  async function memoryScenario(memorySettings: Json | undefined): Promise<Json> {
    const env = await makeEnv({ memorySettings, engramConfig: null });
    const mm = new env.mods.mmMod.MemoryManager(env.sm, MEMORY_PATHS);
    const retriever = new env.mods.mrMod.MemoryRetriever(MEMORY_PATHS, mm);
    const bare = new env.mods.mrMod.MemoryRetriever(MEMORY_PATHS);
    const steps: Json[] = [];
    const record = async (label: string, result?: unknown, full = false): Promise<void> => {
      const memory = cloneDeep(env.sm.get('记忆')) as Record<string, unknown[]>;
      const counts = Object.fromEntries(Object.entries(memory).map(([k, v]) => [k, v.length]));
      steps.push({ label, result: norm(result), memory: full ? norm(memory) : { counts }, emits: env.emits.splice(0) });
    };

    await record('effective config', mm.getEffectiveConfig());
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 1000));
      mm.appendShortTerm(`第${i}回合的叙事。`, i);
    }
    await record('six short-term entries', { full: mm.isShortTermFull(), entries: mm.getShortTermEntries().length });
    mm.appendImplicitMidTerm(mid(['陆沉', 'Lin Nuan'], '陆沉与 Lin Nuan 聊起茶。') as never);
    mm.appendImplicitMidTerm('a plain string entry');
    mm.appendImplicitMidTerm({ content: 'english keys', characters: ['Guan Yu'], gameTime: '1年4月1日' });
    mm.appendImplicitMidTerm({ 记忆主体: '[占位 · round 4]', _占位: true, 相关角色: [], 事件时间: '' });
    mm.appendImplicitMidTerm('   ');
    mm.appendImplicitMidTerm(7 as never);
    await record('implicit entries appended (blank and non-object ones refused)', mm.getImplicitMidTerm());
    mm.shiftAndPromoteOldest();
    await record('promotion with mismatched lengths warns', undefined, true);
    mm.setShortTermEntries([]);
    mm.setMidTermEntries([]);
    mm.setLongTermEntries([]);
    env.sm.set('记忆.隐式中期', [], 'system');
    for (let i = 1; i <= 7; i++) {
      mm.appendShortTerm(`补齐${i}`, i);
      mm.appendImplicitMidTerm(mid(i % 2 ? ['陆沉'] : ['Guan Yu'], `隐式记忆 ${i}`) as never);
    }
    await record('seven paired entries (the implicit list overflows its buffer and is trimmed)', undefined, true);
    env.sm.set('记忆.隐式中期', [], 'system');
    env.sm.set('记忆.短期', [], 'system');
    for (let i = 1; i <= 7; i++) {
      mm.pushShortTermEntry({ round: i, summary: `短期 ${i}`, timestamp: i });
      env.sm.push('记忆.隐式中期', i === 2 ? { 记忆主体: '占位', _占位: true, 相关角色: [], 事件时间: '' } : { 相关角色: ['陆沉'], 事件时间: `t${i}`, 记忆主体: `隐式 ${i}` }, 'system');
    }
    await record('paired entries pushed directly', { promoted: mm.shiftAndPromoteOldest(), mid: mm.getMidTermEntries() }, true);

    for (let i = 1; i <= 30; i++) mm.pushMidTermEntry({ 相关角色: ['陆沉'], 事件时间: `m${i}`, 记忆主体: `中期 ${i}`, ...(i % 3 === 0 ? { 已精炼: true } : {}) } as never);
    await record('thirty mid-term entries', { shouldRefine: mm.shouldRefineMidTerm(), shouldSummarize: mm.shouldSummarizeLongTerm(), refined: mm.isMidTermEntryRefined(mm.getMidTermEntries()[2]) });
    const commit = await attempt(async () => mm.commitSummaryResult([{ content: '长期一', category: '主线', createdAt: 1 } as never], mm.getMidTermEntries().slice(-3)));
    await record('commitSummaryResult', commit, true);
    const originalSet = env.sm.set.bind(env.sm);
    vi.spyOn(env.sm, 'set').mockImplementation(((path: string, value: unknown, source?: 'system') => {
      if (path === '记忆.中期') throw new Error('mid-term write boom');
      return originalSet(path, value, source);
    }) as never);
    const commitFail = await attempt(async () => mm.commitSummaryResult([{ content: '长期二', category: '主线', createdAt: 2 } as never], []));
    vi.mocked(env.sm.set).mockRestore();
    await record('commitSummaryResult with a failing mid-term write rolls the long-term write back', commitFail, true);

    for (let i = 3; i <= 40; i++) mm.pushLongTermEntry({ content: `长期 ${i}`, category: i % 2 ? '主线' : '世界观', createdAt: i } as never);
    await record('forty long-term entries', { shouldCompact: mm.shouldCompactLongTerm() });
    await record('fallbackTrimLongTerm', { trimmed: mm.fallbackTrimLongTerm(), left: mm.getLongTermEntries().length }, true);

    // the effective config is cached for five seconds
    env.ls.storage.setItem(MEMORY_SETTINGS_KEY, JSON.stringify({ shortTermLimit: 2, longTermCap: 7, midTermKeep: 999, bogus: 1 }));
    const cached = mm.getEffectiveConfig();
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    const refreshed = mm.getEffectiveConfig();
    mm.clearConfigCache();
    await record('settings override read after the cache expires', { cached, refreshed, afterClear: mm.getEffectiveConfig() });
    env.ls.storage.setItem(MEMORY_SETTINGS_KEY, '{not json');
    mm.clearConfigCache();
    await record('broken settings fall back to the path defaults', mm.getEffectiveConfig());
    env.ls.storage.removeItem(MEMORY_SETTINGS_KEY);
    mm.clearConfigCache();

    const filtered = {
      player: mm.filterImplicitByRelevantChars('陆沉', []),
      npc: mm.filterImplicitByRelevantChars('', ['Guan Yu']),
      shortName: mm.filterImplicitByRelevantChars('云', []),
      none: mm.filterImplicitByRelevantChars('Nobody', ['Nobody Else']),
    };
    await record('filterImplicitByRelevantChars', filtered);

    steps.push({
      label: 'retriever output',
      withContext: retriever.retrieve(env.sm, { playerName: '陆沉', recentNpcNames: ['Guan Yu'] }),
      withContextSkippingShortTerm: retriever.retrieve(env.sm, { playerName: '陆沉', recentNpcNames: [], skipShortTerm: true }),
      noContext: retriever.retrieve(env.sm),
      withoutManager: bare.retrieve(env.sm),
      withoutManagerWithContext: bare.retrieve(env.sm, { playerName: '陆沉' }),
    });
    env.sm.set('记忆', { 短期: [], 中期: [], 长期: [], 隐式中期: [] }, 'system');
    steps.push({ label: 'retriever output on empty memory', empty: retriever.retrieve(env.sm), bare: bare.retrieve(env.sm) });
    return { steps, pathConfig: mm.getPathConfig() };
  }

  it('M9 MemoryManager four layers and MemoryRetriever, with and without aga_memory_settings', async () => {
    const withoutOverride = await memoryScenario(undefined);
    const withOverride = await memoryScenario({ shortTermLimit: 3, midTermRefineThreshold: 10, longTermSummaryThreshold: 20, longTermSummarizeCount: 5, midTermKeep: 2, longTermCap: 12 });
    await snapDoc('M9-memory-manager', { withoutOverride, withOverride, warnings: warnings() });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // R1–R6 · UnifiedRetriever.retrieve corpus
  // ═════════════════════════════════════════════════════════════════════════════════════════

  const CORPUS_EVENTS: EngramEventNode[] = [
    ['evt_r1', 1, 'Lu Chen arrives at the Qingshi tavern and meets Lin Nuan, who serves hot tea'],
    ['evt_r2', 2, 'Guan Yu fights Lu Chen in the tavern backyard and loses the sparring match'],
    ['evt_r3', 3, 'The village elder warns everyone about a storm coming over the back mountain'],
    ['evt_r4', 8, 'Lin Nuan tells Lu Chen that Guan Yu is an old friend she has not seen for years'],
    ['evt_r5', 9, 'A merchant caravan stops at Qingshi town to sell silk and iron tools'],
    ['evt_r6', 10, 'Lu Chen walks the back mountain path at night under heavy fog'],
  ].map(([id, round, text]) => ({
    id: id as string, subject: '陆沉', action: 'narrative', tags: ['narrative'], text: text as string, summary: text as string,
    structured_kv: { event: text as string, role: [], location: [], time_anchor: '', causality: '承接', logic: [] },
    is_embedded: true, roundNumber: round as number,
    ...(id === 'evt_r4' ? { midTermSummary: 'Lin Nuan names Guan Yu as an old friend.' } : {}),
  }));

  const entity = (name: string, type: EngramEntity['type'], summary: string): EngramEntity => ({
    name, type, summary, attributes: {}, firstSeen: 1, lastSeen: 10, mentionCount: 2, is_embedded: true,
  });
  const CORPUS_ENTITIES: EngramEntity[] = [
    entity('陆沉', 'player', '玩家角色'),
    entity('Lin Nuan', 'npc', 'Runs the tavern in Qingshi town, bright eyes and long black hair'),
    entity('Guan Yu', 'npc', 'A wandering swordsman with sharp brows'),
    entity('Village Elder', 'npc', 'The oldest person in the village, knows every storm'),
    entity('青石镇', 'location', 'A small town at the foot of the mountain'),
    entity('后山', 'location', 'A foggy forest behind the town'),
  ];
  const edge = (id: string, s: string, t: string, text: string, over: Partial<EngramEdge> = {}): EngramEdge => ({
    id, sourceEntity: s, targetEntity: t, fact: text, episodes: ['evt_r1'], is_embedded: true, createdAtRound: 1, lastSeenRound: 8, ...over,
  });
  const CORPUS_EDGES: EngramEdge[] = [
    edge('edge_1', 'Lin Nuan', '陆沉', 'Lin Nuan serves hot tea to Lu Chen at the Qingshi tavern'),
    edge('edge_2', 'Lin Nuan', 'Guan Yu', 'Lin Nuan and Guan Yu are old friends from the same town'),
    edge('edge_3', 'Guan Yu', '陆沉', 'Guan Yu spars with Lu Chen in the tavern backyard'),
    edge('edge_4', 'Village Elder', '后山', 'Village Elder warns about storms over the back mountain'),
    edge('edge_5', '后山', '青石镇', 'The back mountain rises right behind Qingshi town'),
    edge('edge_6', 'Lin Nuan', '青石镇', 'Lin Nuan keeps the oldest tavern in Qingshi town'),
    edge('edge_old', 'Guan Yu', 'Lin Nuan', 'Guan Yu is a stranger to Lin Nuan and has never met her', { invalidAtRound: 7, temporalStatus: 'superseded' }),
    edge('edge_gone', 'Guan Yu', '后山', 'Guan Yu lived on the back mountain before the storm hit', { invalidAtRound: 6, temporalStatus: 'historical' }),
  ];

  async function corpusEnv(opts: { events?: EngramEventNode[]; entities?: EngramEntity[]; edges?: EngramEdge[]; withVectors?: boolean; remote?: boolean; fetchMode?: 'ok' | 'fail' } = {}) {
    const env = await makeEnv({ apiConfigs: opts.remote ? REMOTE : undefined, fetchMode: opts.fetchMode });
    env.round(12);
    const events = opts.events ?? CORPUS_EVENTS;
    const entities = opts.entities ?? CORPUS_ENTITIES;
    const edges = opts.edges ?? CORPUS_EDGES;
    env.sm.set(P.engramMemory, { events, entities, relations: [], v2Edges: edges, meta: { lastUpdated: 1, eventCount: events.length, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5 } }, 'system');
    if (opts.withVectors !== false) {
      const vec = opts.remote ? remoteVector : (t: string) => pseudoEmbed(t);
      await env.vectors.save(SLOT.profileId, SLOT.slotId, {
        eventVectors: Object.fromEntries(events.map((e) => [e.id, vec(e.summary)])),
        entityVectors: Object.fromEntries(entities.map((e) => [e.name, vec(`${e.name} ${e.summary}`)])),
        edgeVectors: Object.fromEntries(edges.map((e) => [e.id, vec(e.fact)])),
        model: 'corpus', dim: opts.remote ? 6 : 384,
      });
    }
    env.vecLog.length = 0;
    return env;
  }

  async function retrieveCase(env: Env, label: string, query: string, ctx: RetrievalContext, config: Json | (() => Json | undefined) | undefined, withReranker: boolean, mode: { slot?: boolean } = {}): Promise<Json> {
    const embedder = new env.mods.embMod.Embedder(env.aiService as never);
    const reranker = withReranker ? new env.mods.rrMod.Reranker(env.aiService as never) : undefined;
    const recorded: unknown[] = [];
    const recorder = {
      recordRetrieve: (info: unknown) => { recorded.push({ recordRetrieve: norm(info) }); },
      recordReadSnapshot: (snap: unknown) => { recorded.push({ recordReadSnapshot: norm(snap) }); },
    };
    const retriever = new env.mods.urMod.UnifiedRetriever(
      env.vectors, embedder, reranker, config as never, recorder, mode.slot === false ? () => null : () => env.slot,
    );
    const text = await retriever.retrieve(query, ctx, env.sm);
    return { label, query, text, readSnapshot: norm(retriever.lastReadSnapshot), recorder: recorded, step: await env.step(label) };
  }

  const FULL_CONFIG = { embedding: { enabled: true, topK: 10, minScore: 0.05 }, rerank: { enabled: false, topN: 5 }, shortTermWindow: 3, maxCandidates: 12 };
  const CTX: RetrievalContext = { playerName: '陆沉', locationDesc: '青石镇', recentNpcNames: ['Lin Nuan'] };

  it('R1 retrieve with embedding: cosine + BM25 + BFS + RRF over the stored vectors', async () => {
    const env = await corpusEnv();
    const cases: Json[] = [];
    cases.push(await retrieveCase(env, 'tavern and tea', 'Lin Nuan tavern tea Lu Chen', CTX, FULL_CONFIG, false));
    cases.push(await retrieveCase(env, 'old friends', 'old friends Guan Yu', { ...CTX, recentNpcNames: [] }, FULL_CONFIG, false));
    cases.push(await retrieveCase(env, 'config as a getter', 'storm back mountain', CTX, () => ({ ...FULL_CONFIG, maxCandidates: 4 }), false));
    cases.push(await retrieveCase(env, 'no config at all', 'storm back mountain', CTX, undefined, false));
    await snapDoc('R1-embedding', { cases });
  });

  it('R2 retrieve without embedding: BM25 and BFS only', async () => {
    const env = await corpusEnv();
    const cases: Json[] = [];
    const noEmb = { ...FULL_CONFIG, embedding: { enabled: false, topK: 10, minScore: 0.05 } };
    cases.push(await retrieveCase(env, 'tavern and tea', 'Lin Nuan tavern tea Lu Chen', CTX, noEmb, false));
    cases.push(await retrieveCase(env, 'nothing matches', 'zzzz qqqq', { playerName: 'Nobody', locationDesc: '', recentNpcNames: [] }, noEmb, false));
    const noSlot = await corpusEnv();
    cases.push(await retrieveCase(noSlot, 'embedding on but no slot', 'Lin Nuan tavern', CTX, FULL_CONFIG, false, { slot: false }));
    const empty = await corpusEnv({ events: [] });
    cases.push(await retrieveCase(empty, 'no events at all', 'Lin Nuan tavern', CTX, FULL_CONFIG, false));
    const noVectors = await corpusEnv({ withVectors: false });
    cases.push(await retrieveCase(noVectors, 'embedding on but no stored vectors', 'Lin Nuan tavern', CTX, FULL_CONFIG, false));
    await snapDoc('R2-no-embedding', { cases });
  });

  it('R3 retrieve with graph expansion: a chain of edges is walked two hops from the seeds', async () => {
    const chain: EngramEdge[] = [
      edge('c1', '陆沉', 'Alpha', 'Lu Chen walks with Alpha along the river bank'),
      edge('c2', 'Alpha', 'Beta', 'Alpha trades goods with Beta every market day'),
      edge('c3', 'Beta', 'Gamma', 'Beta owes Gamma a great debt of silver'),
      edge('c4', 'Gamma', 'Delta', 'Gamma hides Delta in the old cellar'),
      edge('c5', 'Delta', 'Epsilon', 'Delta sends letters to Epsilon at midnight'),
    ];
    const entities = [entity('陆沉', 'player', '玩家'), ...['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((n) => entity(n, 'npc', `${n} the villager`))];
    const env = await corpusEnv({ edges: chain, entities });
    const noEmb = { ...FULL_CONFIG, embedding: { enabled: false, topK: 3, minScore: 0.05 }, maxCandidates: 20 };
    const cases: Json[] = [];
    cases.push(await retrieveCase(env, 'seeds are the player', 'where is the river', { playerName: '陆沉', locationDesc: '', recentNpcNames: [] }, noEmb, false));
    cases.push(await retrieveCase(env, 'seeds are player and Gamma', 'Gamma cellar', { playerName: '陆沉', locationDesc: '', recentNpcNames: ['Gamma'] }, noEmb, false));
    await snapDoc('R3-graph-expansion', { cases });
  });

  it('R4 retrieve with the rerank endpoint (native, fallback on failure, unavailable)', async () => {
    const out: Json = {};
    const rerankOn = { ...FULL_CONFIG, rerank: { enabled: true, topN: 4 } };
    const ok = await corpusEnv({ remote: true });
    out['nativeRerank'] = [
      await retrieveCase(ok, 'rerank ok', 'Lin Nuan tavern tea Lu Chen', CTX, rerankOn, true),
    ];
    const fail = await corpusEnv({ remote: true, fetchMode: 'fail' });
    out['rerankEndpointDown'] = [await retrieveCase(fail, 'rerank 500', 'Lin Nuan tavern tea Lu Chen', CTX, rerankOn, true)];
    const unavailable = await corpusEnv();
    out['rerankNotConfigured'] = [await retrieveCase(unavailable, 'rerank without an api', 'Lin Nuan tavern tea Lu Chen', CTX, rerankOn, true)];
    const llm = await makeEnv({ apiConfigs: { rerank: { name: 'llm', url: 'https://llm.test', apiKey: 'k', model: 'chat', apiCategory: 'llm' } as APIConfig }, replies: { rerank: '{"results": []}' } });
    llm.round(12);
    llm.sm.set(P.engramMemory, { events: CORPUS_EVENTS, entities: CORPUS_ENTITIES, relations: [], v2Edges: CORPUS_EDGES, meta: { schemaVersion: 5 } }, 'system');
    out['llmRerank'] = [await retrieveCase(llm, 'rerank through the chat model', 'Lin Nuan tavern tea Lu Chen', CTX, { ...rerankOn, embedding: { enabled: false, topK: 10, minScore: 0.05 } }, true)];
    out['warnings'] = warnings();
    await snapDoc('R4-rerank', out);
  });

  it('R5 retrieve historical facts: invalidated edges that match the query are appended', async () => {
    const env = await corpusEnv();
    const noEmb = { ...FULL_CONFIG, embedding: { enabled: false, topK: 10, minScore: 0.05 } };
    const cases: Json[] = [];
    cases.push(await retrieveCase(env, 'stranger never met', 'Guan Yu is a stranger to Lin Nuan and has never met her', CTX, noEmb, false));
    cases.push(await retrieveCase(env, 'lived on the mountain', 'Guan Yu lived on the back mountain before the storm hit', CTX, noEmb, false));
    cases.push(await retrieveCase(env, 'both historical edges', 'Guan Yu stranger lived back mountain storm', CTX, noEmb, false));
    await snapDoc('R5-historical', { cases });
  });

  it('R6 retrieve budgets: the 3000 character cut, event window and candidate caps', async () => {
    const longText = (i: number) => `Person${i} remembers a long story about the Qingshi tavern and the old friends who visit it, ${'with many details about tea and swords and storms over the mountain, '.repeat(3)}`;
    const manyEdges: EngramEdge[] = Array.from({ length: 40 }, (_, i) => edge(`long_${i}`, 'Lin Nuan', '陆沉', `${longText(i)} number ${i}`));
    const manyEvents: EngramEventNode[] = Array.from({ length: 30 }, (_, i) => ({
      ...CORPUS_EVENTS[0], id: `evt_long_${i}`, text: `${longText(i)} event ${i}`, summary: `${longText(i)} event ${i}`, roundNumber: i % 12,
    }));
    const env = await corpusEnv({ edges: manyEdges, events: manyEvents, withVectors: false });
    const cfg = (maxCandidates: number, shortTermWindow: number) => ({ embedding: { enabled: false, topK: 50, minScore: 0.05 }, rerank: { enabled: false, topN: 5 }, shortTermWindow, maxCandidates });
    const cases: Json[] = [];
    cases.push(await retrieveCase(env, 'many candidates, long text', 'Qingshi tavern old friends tea swords storms mountain', CTX, cfg(100, 2), false));
    cases.push(await retrieveCase(env, 'few candidates', 'Qingshi tavern old friends tea swords storms mountain', CTX, cfg(2, 2), false));
    cases.push(await retrieveCase(env, 'wide event window', 'Qingshi tavern old friends tea swords storms mountain', CTX, cfg(10, 11), false));
    await snapDoc('R6-budgets', { cases: cases.map((c) => ({ ...c, textLength: (c['text'] as string).length })) });
  });
});
