/**
 * B0-1 regression — pipeline error auto-rollback must actually run.
 *
 * The bug (shipped, never noticed): `GameOrchestrator.runRound()` recovered the
 * pre-round snapshot from `initialCtx.preRoundSnapshot`. But `PipelineRunner.run()`
 * copies the context (`let ctx = { ...initialContext }`) and every stage returns a
 * NEW object, so the caller's object is never written back. The expression was
 * therefore always `undefined` and the entire auto-rollback branch was dead code —
 * any mid-pipeline throw left the already-incremented `元数据.回合序号` behind.
 *
 * These tests pin all three links of the chain:
 *   1. the Runner really does not write back (the root cause),
 *   2. PreProcessStage really does persist the snapshot to the state tree first,
 *   3. `resolvePreRoundSnapshot()` recovers it from the state tree, and a rollback
 *      driven by that value restores the round number.
 */
import { describe, it, expect } from 'vitest';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { PreProcessStage } from '../pipeline/stages/pre-process';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { PipelineContext, PipelineStage, IActionQueueConsumer } from '../pipeline/types';
import type { StateManager } from './state-manager';
import { resolvePreRoundSnapshot } from './game-orchestrator';
import { createMockStateManager, type MockStateManager } from '../__test-utils__';

const paths = DEFAULT_ENGINE_PATHS;

const emptyQueue: IActionQueueConsumer = { consumeActions: () => [] };

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: 'go north',
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 0,
    meta: {},
    ...overrides,
  } as PipelineContext;
}

/** A stage that blows up — stands in for AICall / CommandExecution / PostProcess failing. */
class ExplodingStage implements PipelineStage {
  name = 'Exploding';
  async execute(): Promise<PipelineContext> {
    throw new Error('boom');
  }
}

function asStateManager(sm: MockStateManager): StateManager {
  return sm as unknown as StateManager;
}

describe('B0-1 · pre-round snapshot recovery', () => {
  it('PipelineRunner does NOT write stage results back into the caller\'s context object', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 4 } });
    const runner = new PipelineRunner();
    runner.addStage(new PreProcessStage(asStateManager(sm), emptyQueue, paths));

    const initialCtx = makeCtx();
    const finalCtx = await runner.run(initialCtx);

    // The stage DID produce a snapshot...
    expect(finalCtx.preRoundSnapshot).toBeDefined();
    // ...but the caller's own object was never touched. This is the root cause:
    // reading `initialCtx.preRoundSnapshot` in the catch block can never work.
    expect(initialCtx.preRoundSnapshot).toBeUndefined();
    expect(initialCtx.roundNumber).toBe(0);
  });

  it('PreProcessStage persists the snapshot to the state tree BEFORE incrementing the round', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 7 }, 角色: { 基础信息: { 姓名: '林月' } } });
    const stage = new PreProcessStage(asStateManager(sm), emptyQueue, paths);

    await stage.execute(makeCtx());

    const persisted = sm.get<Record<string, unknown>>(paths.preRoundSnapshot);
    expect(persisted).toBeDefined();
    // Snapshot holds the PRE-increment round number...
    expect((persisted as { 元数据: { 回合序号: number } }).元数据.回合序号).toBe(7);
    // ...while the live tree has already advanced.
    expect(sm.get<number>(paths.roundNumber)).toBe(8);
  });

  it('resolvePreRoundSnapshot recovers from the state tree even when ctx is the untouched initial object', () => {
    const { sm } = createMockStateManager({
      元数据: { 回合序号: 3, 上次对话前快照: { 元数据: { 回合序号: 3 } } },
    });

    const recovered = resolvePreRoundSnapshot(asStateManager(sm), paths, { ctx: makeCtx() });

    expect(recovered).not.toBeNull();
    expect((recovered as { 元数据: { 回合序号: number } }).元数据.回合序号).toBe(3);
  });

  it('returns null when neither the state tree nor the ctx holds a usable snapshot', () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths, { ctx: makeCtx() })).toBeNull();
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths, { ctx: null })).toBeNull();
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths)).toBeNull();
  });

  it('rejects non-object snapshots (array / primitive) from either source', () => {
    const { sm } = createMockStateManager({ 元数据: { 上次对话前快照: ['not', 'a', 'tree'] } });
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths, { ctx: makeCtx() })).toBeNull();

    const { sm: sm2 } = createMockStateManager({});
    const ctx = makeCtx({ preRoundSnapshot: 'nope' as unknown as Record<string, unknown> });
    expect(resolvePreRoundSnapshot(asStateManager(sm2), paths, { ctx })).toBeNull();
  });

  it('end-to-end: a stage throwing mid-pipeline can be rolled back to the pre-round round number', async () => {
    const { sm } = createMockStateManager({
      元数据: { 回合序号: 11 },
      角色: { 基础信息: { 当前位置: '码头' } },
    });
    const runner = new PipelineRunner();
    runner.addStage(new PreProcessStage(asStateManager(sm), emptyQueue, paths));
    runner.addStage(new ExplodingStage());

    const initialCtx = makeCtx();
    await expect(runner.run(initialCtx)).rejects.toThrow('boom');

    // Dirty state right after the throw: the round number已被 PreProcess 递增。
    expect(sm.get<number>(paths.roundNumber)).toBe(12);

    // This is exactly what GameOrchestrator's catch block now does.
    const snapshot = resolvePreRoundSnapshot(asStateManager(sm), paths, {
      roundBefore: 11,
      ctx: initialCtx,
    });
    expect(snapshot).not.toBeNull();
    sm.rollbackTo(snapshot as Record<string, unknown>);

    expect(sm.get<number>(paths.roundNumber)).toBe(11);
    expect(sm.get<string>(paths.playerLocation)).toBe('码头');
  });

  it('the ctx fallback still works for callers that DO hold a populated context', () => {
    const { sm } = createMockStateManager({});
    const ctx = makeCtx({ preRoundSnapshot: { 元数据: { 回合序号: 2 } } });
    const recovered = resolvePreRoundSnapshot(asStateManager(sm), paths, { ctx });
    expect((recovered as { 元数据: { 回合序号: number } }).元数据.回合序号).toBe(2);
  });

  // ── Correlation guard (code review 2026-08-21) ──────────────
  //
  // `paths.preRoundSnapshot` survives across rounds, so "a snapshot exists" is NOT
  // proof that THIS attempt dirtied anything. If PreProcessStage throws before it
  // increments the round number, applying the leftover snapshot from an EARLIER round
  // would silently discard a completed round's narrative/commands/memory.

  it('returns null when the round number did not advance (PreProcess never completed)', () => {
    const { sm } = createMockStateManager({
      // Leftover snapshot from an earlier round — must NOT be applied.
      元数据: { 回合序号: 5, 上次对话前快照: { 元数据: { 回合序号: 4 } } },
    });
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths, { roundBefore: 5 })).toBeNull();
  });

  it('still recovers when the round number DID advance', () => {
    const { sm } = createMockStateManager({
      元数据: { 回合序号: 6, 上次对话前快照: { 元数据: { 回合序号: 5 } } },
    });
    const recovered = resolvePreRoundSnapshot(asStateManager(sm), paths, { roundBefore: 5 });
    expect((recovered as { 元数据: { 回合序号: number } }).元数据.回合序号).toBe(5);
  });

  it('the guard also blocks the ctx fallback, not just the state-tree source', () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 2 } });
    const ctx = makeCtx({ preRoundSnapshot: { 元数据: { 回合序号: 1 } } });
    expect(resolvePreRoundSnapshot(asStateManager(sm), paths, { roundBefore: 2, ctx })).toBeNull();
  });

  it('end-to-end: PreProcess throwing before the snapshot write leaves the previous round intact', async () => {
    // Round 5 completed normally: tree carries its snapshot and real content.
    const { sm } = createMockStateManager({
      元数据: { 回合序号: 5, 上次对话前快照: { 元数据: { 回合序号: 4 }, 角色: { 基础信息: { 当前位置: '旧城' } } } },
      角色: { 基础信息: { 当前位置: '码头' } },
    });
    const roundBefore = sm.get<number>(paths.roundNumber) ?? 0;

    // Round 6's PreProcess dies before doing anything (simulated by a throwing first stage).
    const runner = new PipelineRunner();
    runner.addStage(new ExplodingStage());
    await expect(runner.run(makeCtx())).rejects.toThrow('boom');

    const snapshot = resolvePreRoundSnapshot(asStateManager(sm), paths, { roundBefore });
    expect(snapshot).toBeNull(); // → orchestrator skips the rollback

    // Round 5's state is untouched — this is the regression the guard prevents.
    expect(sm.get<number>(paths.roundNumber)).toBe(5);
    expect(sm.get<string>(paths.playerLocation)).toBe('码头');
  });
});
