/**
 * Phase 1 (2026-04-19) — per-turn metadata attachment tests.
 *
 * Target: `PostProcessStage.execute` attaches `_metrics`, `_thinking`,
 * `_rawResponse`, `_rawResponseStep2`, `_commands`, `_shortTermPreview` to the
 * assistant entry pushed into `narrativeHistory`.
 *
 * Approach: stub all 6 dependencies with minimal in-memory implementations.
 * We assert on the shape of the assistant entry that gets pushed to the
 * narrativeHistory path. The other side effects (memory, engram, autosave)
 * are mocked to no-ops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostProcessStage, collectCanonMutations } from './post-process';
import type {
  PipelineContext,
  EnginePathConfig,
  IMemoryManager,
  IEngramManager,
  IBehaviorRunner,
} from '../types';
import type { AIResponse } from '../../ai/types';
import type { Command } from '../../types';

const paths = {
  roundNumber: '元数据.回合序号',
  narrativeHistory: '元数据.叙事历史',
  playerLocation: '角色.基础信息.当前位置',
  explorationRecord: '系统.探索记录',
  locations: '世界.地点信息',
  heartbeatConfig: '世界.状态.心跳.配置',
  lastHeartbeatRound: '世界.状态.心跳.上次心跳回合序号',
  gameTime: '世界.时间',
  playerName: '角色.基础信息.姓名',
  bookmarkedRounds: '元数据.收藏楼层',
} as unknown as EnginePathConfig;

function makeStateManager() {
  const tree: Record<string, unknown> = {};
  const pushed: unknown[] = [];
  return {
    get: vi.fn((p: string) => tree[p]),
    set: vi.fn((p: string, v: unknown) => {
      tree[p] = v;
    }),
    push: vi.fn((p: string, v: unknown) => {
      const arr = (tree[p] as unknown[] | undefined) ?? [];
      arr.push(v);
      tree[p] = arr;
      pushed.push({ path: p, value: v });
    }),
    delete: vi.fn(),
    toSnapshot: vi.fn(() => tree),
    _pushed: pushed,
    _tree: tree,
  };
}

function makeMemoryManager(): IMemoryManager {
  return {
    appendShortTerm: vi.fn(),
    appendImplicitMidTerm: vi.fn(),
    setMidTermEntries: vi.fn(),
    setLongTermEntries: vi.fn(),
    commitSummaryResult: vi.fn(),
    getShortTermEntries: vi.fn(() => []),
    getMidTermEntries: vi.fn(() => []),
    getLongTermEntries: vi.fn(() => []),
    isMidTermEntryRefined: vi.fn(() => false),
    shiftAndPromoteOldest: vi.fn(() => 0),
    fallbackTrimLongTerm: vi.fn(() => 0),
    shouldRefineMidTerm: vi.fn(() => false),
    shouldSummarizeLongTerm: vi.fn(() => false),
    shouldCompactLongTerm: vi.fn(() => false),
    getEffectiveConfig: vi.fn(() => ({
      shortTermCapacity: 10,
      midTermRefineThreshold: 25,
      longTermSummaryThreshold: 50,
      longTermSummarizeCount: 3,
      midTermKeep: 20,
      longTermCap: 30,
    })),
    clearConfigCache: vi.fn(),
  };
}

function makeEngramManager(): IEngramManager {
  return {
    isEnabled: vi.fn(() => false),
    processResponse: vi.fn(),
    getConfig: vi.fn(() => ({}) as never),
    syncVectorsToState: vi.fn(),
  };
}

function makeBehaviorRunner(): IBehaviorRunner {
  return {
    checkScheduledEvents: vi.fn(() => false),
    runOnContextAssembly: vi.fn(),
    runAfterCommands: vi.fn(),
    runOnRoundEnd: vi.fn(),
  };
}

function makeSaveManager() {
  return {
    saveGame: vi.fn(),
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: 'test user input',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [
      { role: 'system', content: 'system prompt content' },
      { role: 'user', content: 'user turn content' },
    ],
    rawResponse: 'raw AI response text',
    parsedResponse: {
      text: 'parsed narrative text',
    } as AIResponse,
    commandResults: {
      results: [],
      changeLog: { source: 'command', timestamp: 0, changes: [] },
      hasErrors: false,
    },
    generationId: 'test-gen-id',
    roundNumber: 5,
    worldEventTriggered: false,
    meta: {},
    ...overrides,
  };
}

describe('PostProcessStage — Phase 1 per-turn metadata', () => {
  let sm: ReturnType<typeof makeStateManager>;
  let stage: PostProcessStage;

  beforeEach(() => {
    sm = makeStateManager();
    stage = new PostProcessStage(
      sm as never,
      makeMemoryManager(),
      makeEngramManager(),
      makeBehaviorRunner(),
      makeSaveManager() as never,
      paths,
      () => null, // no active slot → skip autosave
    );
  });

  function getAssistantEntry(): Record<string, unknown> | undefined {
    // Two pushes happen on narrativeHistory per round: user, then assistant.
    const narrativePushes = sm._pushed.filter(
      (e): e is { path: string; value: Record<string, unknown> } =>
        (e as { path: string }).path === '元数据.叙事历史',
    );
    const assistant = narrativePushes.find(
      (e) => (e.value as { role: string }).role === 'assistant',
    );
    return assistant?.value;
  }

  it('attaches _metrics with all five fields', async () => {
    const ctx = makeCtx({
      aiCallStartedAt: 1000.5,
      aiCallDurationMs: 2345.6,
    });
    await stage.execute(ctx);

    const entry = getAssistantEntry();
    expect(entry).toBeDefined();
    expect(entry?._metrics).toMatchObject({
      roundNumber: 5,
      durationMs: 2345.6,
      startedAt: 1000.5,
    });
    const metrics = entry?._metrics as { inputTokens: number; outputTokens: number };
    expect(metrics.inputTokens).toBeGreaterThan(0);
    expect(metrics.outputTokens).toBeGreaterThan(0);
  });

  it('persists step2 + total token fields and the per-source breakdown when promptMetrics is present (R1 P0)', async () => {
    const ctx = makeCtx({
      promptMetrics: {
        step1: { inputTokens: 100, outputTokens: 10, breakdown: [{ source: 'builder:a', tokens: 60 }, { source: 'builder:b', tokens: 40 }] },
        step2: { inputTokens: 300, outputTokens: 30, breakdown: [{ source: 'module:core', tokens: 300 }] },
      },
    });
    await stage.execute(ctx);

    const m = getAssistantEntry()?._metrics as Record<string, unknown>;
    expect(m).toMatchObject({
      inputTokens: 100, outputTokens: 10,
      step2InputTokens: 300, step2OutputTokens: 30,
      totalInputTokens: 400, totalOutputTokens: 40,
    });
    const breakdown = m.breakdown as { step1: unknown[]; step2: unknown[] };
    expect(breakdown.step1).toHaveLength(2);
    expect(breakdown.step2).toHaveLength(1);
  });

  it('single-call round: no step2/total fields, breakdown has step1 only', async () => {
    const ctx = makeCtx({
      promptMetrics: { step1: { inputTokens: 100, outputTokens: 10, breakdown: [{ source: 'builder:a', tokens: 100 }] } },
    });
    await stage.execute(ctx);
    const m = getAssistantEntry()?._metrics as Record<string, unknown>;
    expect(m.inputTokens).toBe(100);
    expect(m.step2InputTokens).toBeUndefined();
    expect(m.totalInputTokens).toBeUndefined();
    expect((m.breakdown as { step2?: unknown }).step2).toBeUndefined();
  });

  it('sets _metrics even when AICall did not populate timing (defensive defaults)', async () => {
    const ctx = makeCtx(); // no aiCallStartedAt / aiCallDurationMs
    await stage.execute(ctx);

    const entry = getAssistantEntry();
    expect(entry?._metrics).toMatchObject({
      roundNumber: 5,
      durationMs: 0,
      startedAt: 0,
    });
  });

  it('attaches _thinking only when present', async () => {
    const ctx1 = makeCtx({
      parsedResponse: { text: 'x', thinking: 'my thinking block' } as AIResponse,
    });
    await stage.execute(ctx1);
    expect(getAssistantEntry()?._thinking).toBe('my thinking block');

    // Fresh sm for second assertion
    sm = makeStateManager();
    stage = new PostProcessStage(
      sm as never,
      makeMemoryManager(),
      makeEngramManager(),
      makeBehaviorRunner(),
      makeSaveManager() as never,
      paths,
      () => null,
    );
    const ctx2 = makeCtx({
      parsedResponse: { text: 'x' } as AIResponse,
    });
    await stage.execute(ctx2);
    expect(getAssistantEntry()?._thinking).toBeUndefined();
  });

  it('attaches _rawResponse verbatim', async () => {
    const ctx = makeCtx({ rawResponse: '<正文>narrative</正文>' });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._rawResponse).toBe('<正文>narrative</正文>');
  });

  it('attaches _rawResponseStep2 when split-gen meta present', async () => {
    const ctx = makeCtx({
      meta: { rawResponseStep2: '{"commands": []}' },
    });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._rawResponseStep2).toBe('{"commands": []}');
  });

  it('omits _rawResponseStep2 for single-call rounds', async () => {
    const ctx = makeCtx();
    await stage.execute(ctx);
    expect(getAssistantEntry()?._rawResponseStep2).toBeUndefined();
  });

  it('收藏楼层: resets pending=true bookmarks to false after the round (one-shot)', async () => {
    sm._tree['元数据.收藏楼层'] = [
      { id: 'a', round: 1, createdAt: 1, name: 'A', content: 'ca', pending: true },
      { id: 'b', round: 2, createdAt: 2, name: 'B', content: 'cb', pending: false },
      { id: 'c', round: 3, createdAt: 3, name: 'C', content: 'cc', pending: true },
    ];
    await stage.execute(makeCtx());
    const list = sm._tree['元数据.收藏楼层'] as Array<{ id: string; pending: boolean; name: string }>;
    expect(list.map((b) => b.pending)).toEqual([false, false, false]);
    // Names / content untouched.
    expect(list[0].name).toBe('A');
  });

  it('收藏楼层: does not write when nothing is pending', async () => {
    sm._tree['元数据.收藏楼层'] = [
      { id: 'a', round: 1, createdAt: 1, name: 'A', content: 'ca', pending: false },
    ];
    await stage.execute(makeCtx());
    const setCalls = (sm.set as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(setCalls.some((c) => c[0] === '元数据.收藏楼层')).toBe(false);
  });

  it('attaches _commands when parsedResponse has commands', async () => {
    const commands: Command[] = [
      { action: 'set', key: '角色.姓名', value: '张三' },
      { action: 'add', key: '角色.体力', value: 10 },
    ];
    const ctx = makeCtx({
      parsedResponse: { text: 'x', commands } as AIResponse,
    });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._commands).toEqual(commands);
  });

  it('omits _commands when commands array is empty', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'x', commands: [] } as AIResponse,
    });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._commands).toBeUndefined();
  });

  it('attaches _shortTermPreview from midTermMemory.记忆主体', async () => {
    const ctx = makeCtx({
      parsedResponse: {
        text: 'x',
        midTermMemory: {
          相关角色: ['张三'],
          事件时间: '2026-04-19',
          记忆主体: '主角遇到了一个重要的分岔路口，需要做出选择。',
        },
      } as AIResponse,
    });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._shortTermPreview).toBe(
      '主角遇到了一个重要的分岔路口，需要做出选择。',
    );
  });

  it('truncates long _shortTermPreview to 80 chars', async () => {
    const long = 'a'.repeat(200);
    const ctx = makeCtx({
      parsedResponse: {
        text: 'x',
        midTermMemory: { 相关角色: [], 事件时间: '', 记忆主体: long },
      } as AIResponse,
    });
    await stage.execute(ctx);
    const preview = getAssistantEntry()?._shortTermPreview as string | undefined;
    expect(preview?.length).toBe(80);
  });

  it('handles string midTermMemory (legacy format)', async () => {
    const ctx = makeCtx({
      parsedResponse: {
        text: 'x',
        midTermMemory: '简单字符串形式的中期记忆',
      } as AIResponse,
    });
    await stage.execute(ctx);
    expect(getAssistantEntry()?._shortTermPreview).toBe('简单字符串形式的中期记忆');
  });

  it('preserves existing _delta behavior alongside new metadata', async () => {
    const ctx = makeCtx({
      commandResults: {
        results: [],
        changeLog: {
          source: 'command',
          timestamp: 1,
          changes: [
            {
              path: '角色.姓名',
              action: 'set',
              oldValue: 'A',
              newValue: 'B',
              timestamp: 1,
            },
          ],
        },
        hasErrors: false,
      },
    });
    await stage.execute(ctx);
    const entry = getAssistantEntry();
    expect(Array.isArray(entry?._delta)).toBe(true);
    expect((entry?._delta as unknown[]).length).toBe(1);
    expect(entry?._metrics).toBeDefined();
  });

  it('role and content fields are unchanged', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'narrative body' } as AIResponse,
    });
    await stage.execute(ctx);
    const entry = getAssistantEntry();
    expect(entry?.role).toBe('assistant');
    expect(entry?.content).toBe('narrative body');
  });
});

// ─── Canon Capture: what PostProcess hands the graph (P3) ───

describe('collectCanonMutations', () => {
  function ctxWith(settingCapture: unknown): PipelineContext {
    return { meta: { settingCapture } } as unknown as PipelineContext;
  }

  const accepted = {
    entryId: 'cap_1',
    candidate: {
      kind: 'relationship',
      statement: '林月是玩家的妹妹。',
      evidence: '林月是我的妹妹',
      anchors: ['林月'],
      entities: ['林月', '玩家'],
    },
  };

  it('maps accepted captures into graph-shaped mutations', () => {
    const out = collectCanonMutations(ctxWith({ accepted: [accepted] }));
    expect(out).toEqual([{
      entryId: 'cap_1',
      kind: 'relationship',
      statement: '林月是玩家的妹妹。',
      entities: ['林月', '玩家'],
      op: 'add',
    }]);
  });

  it('returns nothing when the round captured nothing', () => {
    expect(collectCanonMutations(ctxWith(undefined))).toEqual([]);
    expect(collectCanonMutations(ctxWith({ accepted: [] }))).toEqual([]);
    expect(collectCanonMutations({ meta: {} } as unknown as PipelineContext)).toEqual([]);
  });

  it('survives a partial result from the fail-soft capture stage', () => {
    // SettingCaptureStage is fail-soft and can write an incomplete result; a shape
    // surprise here must not sink an otherwise complete round.
    const out = collectCanonMutations(ctxWith({
      accepted: [
        { entryId: 'cap_ok', candidate: { kind: 'character', statement: 'ok', entities: [] } },
        { entryId: 123, candidate: { kind: 'relationship', statement: 'x' } },
        { candidate: { kind: 'relationship', statement: 'no id' } },
        { entryId: 'cap_no_statement', candidate: { kind: 'relationship' } },
        null,
      ],
    }));
    expect(out.map((m) => m.entryId)).toEqual(['cap_ok']);
  });

  it('does not pre-filter by kind — projection rules live in canon-projection', () => {
    // Keeping the filter in one place means the panel and the graph cannot disagree
    // about what is projectable.
    const out = collectCanonMutations(ctxWith({
      accepted: [{ entryId: 'cap_t', candidate: { kind: 'character', statement: '林月怕水。', entities: ['林月'] } }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('character');
  });

  it('never emits a retraction — undo is out-of-round only', () => {
    const out = collectCanonMutations(ctxWith({ accepted: [accepted] }));
    expect(out.every((m) => m.op === 'add')).toBe(true);
  });
});
