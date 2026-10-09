/**
 * ReasoningIngestStage — Sprint CoT-2
 *
 * Additive pipeline stage (PRINCIPLES §3.9): always registered in the
 * pipeline, self-skips when CoT flag is OFF. When ON, captures the
 * `thinking` field from `parsedResponse` and persists it to the state tree
 * as a FIFO ring at `paths.reasoningHistory`.
 *
 * Slot: between AICallStage and CommandExecutionStage.
 *
 * Behavior:
 * - flag OFF → return ctx unchanged (byte-identical to pre-migration)
 * - flag ON + thinking present → push to ring, enforce size cap
 * - flag ON + no thinking → no-op (no state write)
 *
 * Ring size is configurable via `系统.设置.cot.reasoningRingSize` (default 3).
 * Rollback safety: `元数据.推理历史` is inside the whole-tree round-start snapshot PreProcessStage hands to the
 * rollback holder (存档瘦身 D1A).
 */
import type { PipelineStage, PipelineContext, EnginePathConfig } from '../types';
import type { StateManager } from '../../core/state-manager';
import { SYSTEM_PATHS } from '../system-paths';

const DEFAULT_RING_SIZE = 3;

export class ReasoningIngestStage implements PipelineStage {
  name = 'ReasoningIngest';

  constructor(
    private stateManager: StateManager,
    private paths: EnginePathConfig,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const cotEnabled = ctx.meta.cotEnabled === true;
    if (!cotEnabled) return ctx;

    const thinking = ctx.parsedResponse?.thinking;
    if (!thinking) return ctx;

    const ringSize = this.readRingSize();
    const historyPath = this.paths.reasoningHistory;

    const history = this.stateManager.get<string[]>(historyPath) ?? [];
    const updated = [...history, thinking];

    if (updated.length > ringSize) {
      updated.splice(0, updated.length - ringSize);
    }

    this.stateManager.set(historyPath, updated, 'system');

    return {
      ...ctx,
      meta: { ...ctx.meta, reasoningIngested: true },
    };
  }

  private readRingSize(): number {
    const raw = this.stateManager.get<number>(SYSTEM_PATHS.cotReasoningRingSize);
    if (typeof raw === 'number' && raw >= 1 && raw <= 10) return raw;
    return DEFAULT_RING_SIZE;
  }
}
