// App doc: docs/user-guide/pages/game-plot.md §开始条件弹窗（PlotTriggerPicker）
// Design: docs/design/plot-parallel-threads-scheduler.md §D3 (trigger semantics table)
/**
 * Plot Threads — deterministic trigger evaluation.
 *
 * Cross-thread sequencing is decided HERE, never by the AI (§8.1). Pure
 * functions over the plot state so the store, the pipeline and the scheduler
 * UI ("前置已放弃" hint) all agree.
 */
import type { PlotArc, PlotGauge, ThreadActivation, ThreadTrigger } from './types';
import { evaluateGaugeCondition, getActiveArcs } from './types';

export interface TriggerContext {
  arcs: PlotArc[];
  currentRound: number;
}

export type TriggerVerdict =
  | { satisfied: true }
  | { satisfied: false; reason: 'waiting' | 'target_abandoned' | 'target_missing' | 'empty' };

/** Union of every active thread's gauges — ids are globally unique (G13). */
export function collectActiveGauges(arcs: PlotArc[]): PlotGauge[] {
  return getActiveArcs({ arcs }).flatMap(a => a.gauges);
}

export function evaluateThreadTrigger(trigger: ThreadTrigger, ctx: TriggerContext): TriggerVerdict {
  switch (trigger.type) {
    case 'thread_completed': {
      const target = ctx.arcs.find(a => a.id === trigger.arcId);
      if (!target) return { satisfied: false, reason: 'target_missing' };
      if (target.status === 'completed') return { satisfied: true };
      // Abandoned is NOT completion: the scheduled thread keeps waiting and the
      // UI surfaces "前置已放弃" so the author can re-route or start it by hand.
      if (target.status === 'abandoned') return { satisfied: false, reason: 'target_abandoned' };
      return { satisfied: false, reason: 'waiting' };
    }
    case 'node_completed': {
      const target = ctx.arcs.find(a => a.id === trigger.arcId);
      if (!target) return { satisfied: false, reason: 'target_missing' };
      const node = target.nodes.find(n => n.id === trigger.nodeId);
      if (!node) return { satisfied: false, reason: 'target_missing' };
      // A skipped node has still "ended" in the linear chain.
      if (node.status === 'completed' || node.status === 'skipped') return { satisfied: true };
      if (target.status === 'abandoned') return { satisfied: false, reason: 'target_abandoned' };
      return { satisfied: false, reason: 'waiting' };
    }
    case 'round_reached':
      return ctx.currentRound >= trigger.round
        ? { satisfied: true }
        : { satisfied: false, reason: 'waiting' };
    case 'gauge': {
      const gauges = collectActiveGauges(ctx.arcs);
      if (!gauges.some(g => g.id === trigger.condition.gaugeId)) {
        return { satisfied: false, reason: 'target_missing' };
      }
      return evaluateGaugeCondition(trigger.condition, gauges)
        ? { satisfied: true }
        : { satisfied: false, reason: 'waiting' };
    }
    default:
      return { satisfied: false, reason: 'target_missing' };
  }
}

/**
 * AND over all triggers. An empty trigger list never satisfies (the UI must
 * not save one); the first failing trigger's reason is reported so the
 * scheduler can explain why a thread is still waiting.
 */
export function evaluateThreadActivation(
  activation: ThreadActivation | undefined,
  ctx: TriggerContext,
): TriggerVerdict {
  if (!activation || activation.triggers.length === 0) return { satisfied: false, reason: 'empty' };
  for (const trigger of activation.triggers) {
    const v = evaluateThreadTrigger(trigger, ctx);
    if (!v.satisfied) return v;
  }
  return { satisfied: true };
}

/**
 * Drop triggers that point at a deleted thread (and `node_completed` triggers
 * that point at a deleted node). Returns the number of triggers removed so the
 * caller can warn. Mutates `arcs` in place.
 */
export function pruneDanglingTriggers(arcs: PlotArc[], removedArcId: string): number {
  let removed = 0;
  for (const arc of arcs) {
    if (!arc.activation) continue;
    const before = arc.activation.triggers.length;
    arc.activation.triggers = arc.activation.triggers.filter(t =>
      !((t.type === 'thread_completed' || t.type === 'node_completed') && t.arcId === removedArcId),
    );
    removed += before - arc.activation.triggers.length;
  }
  return removed;
}
