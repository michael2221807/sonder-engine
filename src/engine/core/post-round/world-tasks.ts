import type { PipelineContext } from '../../pipeline/types';
import type { PostRoundEnv } from './types';

/** Post-round world tasks (heartbeat, plot evaluation, NPC generation). Moved verbatim. */
export async function runWorldHeartbeat(env: PostRoundEnv, ctx: PipelineContext): Promise<void> {
  const { sub, stateManager } = env;
  // ── 3. 世界心跳 ──
  if (ctx.meta['pendingHeartbeat'] === true && sub.worldHeartbeat) {
    try {
      const ok = await sub.worldHeartbeat.execute();
      if (ok && sub.paths) {
        // 心跳成功 → 记录本回合为最新心跳回合（供下次周期判断）
        stateManager.set(
          sub.paths.lastHeartbeatRound,
          ctx.roundNumber,
          'system',
        );
      }
    } catch (err) {
      console.error('[Orchestrator] WorldHeartbeatPipeline failed:', err);
    }
  }
}

export async function runPlotEvaluation(env: PostRoundEnv, ctx: PipelineContext): Promise<void> {
  const { sub, stateManager } = env;
  // ── 3.5. Plot evaluation (Sprint Plot-1 P3, GAP-02 fix) ──
  if (ctx.meta['pendingPlotEval'] === true && sub.plotEvaluation) {
    // Set evaluating flag on state tree so PlotPanel's store watch can block hot-swap
    if (sub.paths) {
      stateManager.set(sub.paths.plotDirection + '._evaluating', true, 'system');
    }
    try {
      const ok = await sub.plotEvaluation.execute();
      if (ok) {
        console.debug('[Orchestrator] PlotEvaluationPipeline completed');
      } else {
        console.debug('[Orchestrator] PlotEvaluationPipeline skipped (no active arc/node)');
      }
    } catch (err) {
      console.error('[Orchestrator] PlotEvaluationPipeline failed:', err);
    } finally {
      if (sub.paths) {
        stateManager.set(sub.paths.plotDirection + '._evaluating', false, 'system');
      }
    }
  }
}

export async function runNpcGeneration(env: PostRoundEnv, locationBefore: string | null): Promise<void> {
  const { sub, stateManager } = env;
  // ── 4. NPC 自动生成（玩家移动到新地点时触发） ──
  if (
    sub.npcGeneration &&
    sub.paths
  ) {
    const locationAfter = stateManager.get<string>(sub.paths.playerLocation) ?? null;
    if (locationAfter && locationAfter !== locationBefore) {
      try {
        const ok = await sub.npcGeneration.execute(locationAfter);
        if (ok) console.log(`[Orchestrator] NpcGenerationPipeline generated NPCs for "${locationAfter}"`);
      } catch (err) {
        console.error('[Orchestrator] NpcGenerationPipeline failed:', err);
      }
    }
  }
}
