import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext, PipelineStage } from '@/engine/pipeline/types';

vi.mock('@/engine/core/event-bus', () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    eventBus: {
      emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
      _emitted: emitted,
      _clear: () => { emitted.length = 0; },
    },
  };
});

const { PipelineRunner } = await import('@/engine/pipeline/pipeline-runner');
const { eventBus } = await import('@/engine/core/event-bus');
const { RoundOwnership } = await import('@/engine/core/round-ownership');
/** A round whose story is already saved. */
const saved = (signal: AbortSignal) =>
  Object.assign(new RoundOwnership(() => ({ profileId: 'p', slotId: 's' }), () => 0, signal), { saved: true });

function getEmitted() {
  return (eventBus as unknown as { _emitted: Array<{ event: string }> })._emitted;
}
function clearEmitted() {
  (eventBus as unknown as { _clear: () => void })._clear();
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userInput: 'test input',
    roundNumber: 1,
    meta: {},
    generationId: 'gen-1',
    ...overrides,
  } as PipelineContext;
}

function makeStage(name: string, transform?: (ctx: PipelineContext) => PipelineContext): PipelineStage {
  return {
    name,
    execute: async (ctx) => transform ? transform(ctx) : ctx,
  };
}

describe('PipelineRunner', () => {
  let runner: InstanceType<typeof PipelineRunner>;

  beforeEach(() => {
    runner = new PipelineRunner();
    clearEmitted();
  });

  it('throws when no stages registered', async () => {
    await expect(runner.run(makeCtx())).rejects.toThrow('No pipeline stages registered');
  });

  it('renders an already saved round after optional work is cancelled', async () => {
    const abort = new AbortController(); abort.abort();
    const render = vi.fn(async (ctx: PipelineContext) => ctx);
    runner.addStage({ name: 'Render', execute: render });
    await runner.run(makeCtx({ abortSignal: abort.signal, meta: { roundOwnership: saved(abort.signal) } }));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rechecks identity before rendering even when a vector round was saved', async () => {
    const render = vi.fn(async (ctx: PipelineContext) => ctx);
    runner.addStage({ name: 'Render', execute: render });
    await expect(runner.run(makeCtx({ meta: { roundOwnership: saved(new AbortController().signal),
      plotVectorGuard: () => { throw new Error('changed slot'); } } }))).rejects.toThrow('changed slot');
    expect(render).not.toHaveBeenCalled();
  });

  it('executes stages in order', async () => {
    const order: string[] = [];
    runner.addStage(makeStage('A', (ctx) => { order.push('A'); return ctx; }));
    runner.addStage(makeStage('B', (ctx) => { order.push('B'); return ctx; }));
    runner.addStage(makeStage('C', (ctx) => { order.push('C'); return ctx; }));
    await runner.run(makeCtx());
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('passes context through stages', async () => {
    runner.addStage(makeStage('A', (ctx) => ({ ...ctx, meta: { ...ctx.meta, fromA: true } })));
    runner.addStage(makeStage('B', (ctx) => ({ ...ctx, meta: { ...ctx.meta, fromB: true } })));
    const result = await runner.run(makeCtx());
    expect(result.meta['fromA']).toBe(true);
    expect(result.meta['fromB']).toBe(true);
  });

  it('emits round-start and round-complete events', async () => {
    runner.addStage(makeStage('X'));
    await runner.run(makeCtx({ roundNumber: 7 }));
    const events = getEmitted().map((e) => e.event);
    expect(events).toContain('engine:round-start');
    expect(events).toContain('engine:round-complete');
  });

  it('emits round-error on stage failure', async () => {
    runner.addStage({
      name: 'Failing',
      execute: async () => { throw new Error('boom'); },
    });
    await expect(runner.run(makeCtx())).rejects.toThrow('boom');
    expect(getEmitted().some((e) => e.event === 'engine:round-error')).toBe(true);
  });

  it('aborts on abortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    runner.addStage(makeStage('Never'));
    await expect(runner.run(makeCtx({ abortSignal: ac.signal }))).rejects.toThrow('Pipeline aborted');
  });

  it('calls onProgress for each stage with i18n object', async () => {
    const progress: Array<string | { i18nKey: string; i18nParams?: Record<string, unknown>; message: string }> = [];
    runner.addStage(makeStage('StageA'));
    runner.addStage(makeStage('StageB'));
    await runner.run(makeCtx({ onProgress: (msg: string | { i18nKey: string; i18nParams?: Record<string, unknown>; message: string }) => progress.push(msg) } as unknown as PipelineContext));
    expect(progress).toHaveLength(2);
    expect(progress[0]).toEqual({ i18nKey: 'engine.progress.stage', i18nParams: { name: 'StageA' }, message: '[StageA]' });
    expect(progress[1]).toEqual({ i18nKey: 'engine.progress.stage', i18nParams: { name: 'StageB' }, message: '[StageB]' });
  });

  it('propagates meta flags set by stages', async () => {
    runner.addStage(makeStage('FlagSetter', (ctx) => ({
      ...ctx,
      meta: { ...ctx.meta, pendingHeartbeat: true },
    })));
    runner.addStage(makeStage('Reader', (ctx) => {
      // downstream stage should see the flag
      expect(ctx.meta['pendingHeartbeat']).toBe(true);
      return ctx;
    }));
    const result = await runner.run(makeCtx());
    expect(result.meta['pendingHeartbeat']).toBe(true);
  });

  it('stops executing stages after abort mid-pipeline', async () => {
    const ac = new AbortController();
    const order: string[] = [];
    runner.addStage(makeStage('First', (ctx) => {
      order.push('first');
      ac.abort(); // abort after first stage
      return ctx;
    }));
    runner.addStage(makeStage('Second', (ctx) => {
      order.push('second');
      return ctx;
    }));
    await expect(runner.run(makeCtx({ abortSignal: ac.signal }))).rejects.toThrow('Pipeline aborted');
    expect(order).toEqual(['first']); // second never ran
  });
});
