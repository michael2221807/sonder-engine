import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReasoningIngestStage } from '@/engine/pipeline/stages/reasoning-ingest';
import type { PipelineContext, EnginePathConfig } from '@/engine/pipeline/types';
import type { AIResponse } from '@/engine/ai/types';

const mockPaths = {
  reasoningHistory: '元数据.推理历史',
  storyPlan: '元数据.剧情规划',
} as EnginePathConfig;

function makeStateManager(data: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...data };
  return {
    get: vi.fn(<T>(path: string): T | undefined => {
      return store[path] as T | undefined;
    }),
    set: vi.fn((path: string, value: unknown) => {
      store[path] = value;
    }),
    _store: store,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: '',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    generationId: 'test',
    roundNumber: 1,
    meta: {},
    ...overrides,
  };
}

describe('ReasoningIngestStage', () => {
  let sm: ReturnType<typeof makeStateManager>;
  let stage: ReasoningIngestStage;

  beforeEach(() => {
    sm = makeStateManager();
    stage = new ReasoningIngestStage(sm as never, mockPaths);
  });

  it('self-skips when cotEnabled is false (baseline preservation)', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'narrative', thinking: 'should be ignored' } as AIResponse,
      meta: { cotEnabled: false },
    });
    const out = await stage.execute(ctx);
    expect(sm.set).not.toHaveBeenCalled();
    expect(out).toBe(ctx);
  });

  it('self-skips when cotEnabled is absent (default OFF)', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'narrative', thinking: 'ignored' } as AIResponse,
      meta: {},
    });
    await stage.execute(ctx);
    expect(sm.set).not.toHaveBeenCalled();
  });

  it('no-ops when cotEnabled but no thinking in response', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'narrative' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    expect(sm.set).not.toHaveBeenCalled();
  });

  it('pushes thinking to empty ring', async () => {
    sm._store['元数据.推理历史'] = [];
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'round 1 reasoning' } as AIResponse,
      meta: { cotEnabled: true },
    });
    const result = await stage.execute(ctx);
    expect(sm.set).toHaveBeenCalledWith(
      '元数据.推理历史',
      ['round 1 reasoning'],
      'system',
    );
    expect(result.meta.reasoningIngested).toBe(true);
  });

  it('appends to existing ring', async () => {
    sm._store['元数据.推理历史'] = ['prev1', 'prev2'];
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'round 3' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    expect(sm.set).toHaveBeenCalledWith(
      '元数据.推理历史',
      ['prev1', 'prev2', 'round 3'],
      'system',
    );
  });

  it('enforces default ring size (3) — evicts oldest on overflow', async () => {
    sm._store['元数据.推理历史'] = ['r1', 'r2', 'r3'];
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'r4' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    const written = sm.set.mock.calls[0][1] as string[];
    expect(written).toEqual(['r2', 'r3', 'r4']);
    expect(written).toHaveLength(3);
  });

  it('respects custom ring size from state', async () => {
    sm._store['元数据.推理历史'] = ['r1', 'r2', 'r3', 'r4', 'r5'];
    sm._store['系统.设置.cot.reasoningRingSize'] = 5;
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'r6' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    const written = sm.set.mock.calls[0][1] as string[];
    expect(written).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
    expect(written).toHaveLength(5);
  });

  it('clamps invalid ring size to default', async () => {
    sm._store['元数据.推理历史'] = ['r1', 'r2', 'r3'];
    sm._store['系统.设置.cot.reasoningRingSize'] = 0;
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'r4' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    const written = sm.set.mock.calls[0][1] as string[];
    expect(written).toHaveLength(3);
  });

  it('does not mutate the original history array', async () => {
    const original = ['r1', 'r2'];
    sm._store['元数据.推理历史'] = original;
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'r3' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    expect(original).toEqual(['r1', 'r2']);
  });

  it('handles undefined reasoning history gracefully', async () => {
    const ctx = makeCtx({
      parsedResponse: { text: 'n', thinking: 'first' } as AIResponse,
      meta: { cotEnabled: true },
    });
    await stage.execute(ctx);
    expect(sm.set).toHaveBeenCalledWith(
      '元数据.推理历史',
      ['first'],
      'system',
    );
  });
});
