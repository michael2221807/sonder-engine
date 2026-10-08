import { CharacterVectorProposePipeline } from '../../pipeline/sub-pipelines/character-vector-propose';
import type { PostRoundEnv } from './types';

/**
 * Post-round memory tiers, character-vector proposals and long-term compaction.
 * Moved verbatim from GameOrchestrator.runPostRoundSubPipelines; statements outside
 * try blocks (memMgr.should*, roundNow read) intentionally propagate (E01-035).
 */
export async function runMemoryTasks(env: PostRoundEnv): Promise<void> {
  const { sub, stateManager } = env;
  // ── 1. 记忆层级触发（2026-04-11 重构） ──
  //
  // 四层记忆系统（short/implicit mid / mid / long），参照 demo + design note。
  //
  // 短→中的升级是**同步**完成的（`PostProcessStage` 调
  // `MemoryManager.shiftAndPromoteOldest()`，无 AI 调用）。所以这里不再
  // 检查 `pendingSummary` 标记，而是直接按**中期记忆当前条数**判断是否
  // 触发 AI 子管线。
  //
  // If-else 二选一（优先级：长期汇总 > in-place 精炼）：
  //   - mid >= 50 (longTermSummaryThreshold) → MemorySummaryPipeline
  //     执行 "worldview evolution" 产出 1-3 条长期记忆 + 消费掉旧中期
  //   - 否则 mid >= 25 (midTermRefineThreshold) → MidTermRefinePipeline
  //     执行 in-place 精炼（去重合并，标记 `已精炼`，不删减记忆点）
  //   - 否则 no-op
  //
  // 之所以 if-else：如果同时达到两个阈值（比如 mid=50 → 先 summary 消费
  // 到 mid=20），refine 就没必要再跑了。优先长期汇总让系统减负最多。
  //
  // 详见 `memory-manager.ts` 顶部 JSDoc 的"四层设计"。
  const memMgr = sub.memoryManager;
  let vectorProposeDue = false;
  if (memMgr) {
    if (memMgr.shouldSummarizeLongTerm() && sub.memorySummary) {
      try {
        const ok = await sub.memorySummary.execute();
        if (ok) console.log('[Orchestrator] MemorySummaryPipeline (worldview evolution) completed');
      } catch (err) {
        console.error('[Orchestrator] MemorySummaryPipeline failed:', err);
      }
    } else if (memMgr.shouldRefineMidTerm() && sub.midTermRefine) {
      try {
        const ok = await sub.midTermRefine.execute();
        if (ok) {
          console.log('[Orchestrator] MidTermRefinePipeline (in-place compress) completed');
          vectorProposeDue = true;
        }
      } catch (err) {
        console.error('[Orchestrator] MidTermRefinePipeline failed:', err);
      }
    }

    // ── Character Vectors (R2 second half): the world proposes per-NPC vectors ──
    // Fires after a successful refine (fresh, deduplicated material) and on a fixed
    // cadence in between, so a save sees proposals long before the refine threshold.
    const roundNow = stateManager.get<number>(env.paths.roundNumber) ?? 0;
    if (sub.characterVectorPropose && (vectorProposeDue || CharacterVectorProposePipeline.isCadenceRound(roundNow))) {
      try {
        const ok = await sub.characterVectorPropose.execute();
        if (ok) console.log('[Orchestrator] CharacterVectorProposePipeline completed');
      } catch (err) {
        console.error('[Orchestrator] CharacterVectorProposePipeline failed:', err);
      }
    }

    // ── 长期记忆溢出 → 二级精炼 → fallback FIFO ──
    //
    // 2026-04-11 新增（Feature B）：上一步 memorySummary 可能把新长期记忆
    // push 进来，如果导致长期记忆超过 cap，触发 LongTermCompactPipeline。
    // Compact 成功则 old entries 被合并为"主题存档"，否则 fallback 到 FIFO。
    //
    // 这里独立于上面的 if-else —— 因为 memorySummary 执行成功后可能新条目
    // 使长期记忆恰好溢出，需要**同轮**紧接着处理，不等下一回合。
    if (memMgr.shouldCompactLongTerm()) {
      let compacted = false;
      if (sub.longTermCompact) {
        try {
          compacted = await sub.longTermCompact.execute();
          if (compacted) console.log('[Orchestrator] LongTermCompactPipeline (theme archive) completed');
        } catch (err) {
          console.error('[Orchestrator] LongTermCompactPipeline failed:', err);
        }
      }
      // AI compact 失败或不可用 → fallback FIFO 兜底
      if (!compacted) {
        const trimmed = memMgr.fallbackTrimLongTerm();
        if (trimmed > 0) {
          console.log(`[Orchestrator] Long-term FIFO fallback trimmed ${trimmed} oldest entries`);
        }
      }
    }
  }
}
