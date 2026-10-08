import { eventBus } from '../event-bus';
import type { PipelineContext } from '../../pipeline/types';
import type { PostRoundEnv } from './types';
import { runMemoryTasks } from './memory-tasks';
import { runWorldHeartbeat, runPlotEvaluation, runNpcGeneration } from './world-tasks';
import { runPrivacyRepair, runFieldRepair } from './repair-tasks';
import { runAutoScene, runAutoPortrait, runAutoNarration } from './auto-media';

export type { PostRoundEnv } from './types';

/**
 * 主回合完成后的子管线调度 — moved from GameOrchestrator.runPostRoundSubPipelines.
 * Section order is behavior: memory, heartbeat, plot evaluation, NPC generation,
 * privacy repair, field repair, auto scene/portrait/narration, NPC memory, request-save.
 * No outer catch on purpose: a throw outside a section's own try aborts the remaining
 * tasks (E01-035, recorded in the audit side-list; not fixed by this refactor).
 */
export async function runPostRound(
  env: PostRoundEnv,
  ctx: PipelineContext,
  locationBefore: string | null,
): Promise<void> {
  await runMemoryTasks(env);
  await runWorldHeartbeat(env, ctx);
  await runPlotEvaluation(env, ctx);
  await runNpcGeneration(env, locationBefore);
  await runPrivacyRepair(env, ctx);
  await runFieldRepair(env);
  runAutoScene(env, ctx);
  runAutoPortrait(env, ctx);
  runAutoNarration(env, ctx);
  // ── Sprint Social-5: per-NPC memory summarizer ──
  // Kept inline in this frame (not a separate async section) on purpose: the final
  // request-save emit and the function return must stay in the same continuation as the
  // loop's last await, otherwise the fire-and-forget auto-media `.then` callbacks land
  // at a different point relative to the caller's flush/done sequence.
  if (env.sub.npcMemorySummarizer) {
    try {
      const candidates = env.sub.npcMemorySummarizer.findCandidates();
      for (const npcName of candidates) {
        await env.sub.npcMemorySummarizer.summarize(npcName);
        console.debug(`[Orchestrator] NpcMemorySummarizer completed for "${npcName}"`);
      }
    } catch (err) {
      console.debug('[Orchestrator] NpcMemorySummarizer failed:', err);
    }
  }

  // R-03: 子管线可能修改了记忆（refine/summary/compact）、NPC 列表、心跳状态等。
  eventBus.emit('engine:request-save', undefined);
}
