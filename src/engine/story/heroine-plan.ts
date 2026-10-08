/**
 * Heroine Plan system — ported from original heroinePlan model
 *
 * Provides structured data models for managing heroine-related storylines,
 * including stage progression, individual heroine entries, interaction events,
 * and scene/camera planning.
 *
 * This system is optional — enabled via 系统.设置.prompt.enableHeroinePlan.
 * When enabled, its data is stored at 元数据.女主规划 in the state tree
 * and injected as a context piece by SystemPromptBuilder.
 */

// ─── Stage Progression ──────────────────────────────────────

interface HeroineStageProgression {
  /** Stage name (e.g., "初识期", "暧昧期", "确认关系") */
  stageName: string;
  /** Goals for this stage */
  stageGoals: string[];
  /** Primary heroines being pushed in this stage */
  primaryHeroines: string[];
  /** Secondary heroines */
  secondaryHeroines: string[];
  /** Characters that must not exceed their current relationship level */
  restrictedCharacters: string[];
  /** Related story quests */
  relatedQuests: string[];
  /** Conditions to consider this stage complete */
  completionCriteria: string[];
  /** Conditions to switch to the next stage */
  switchConditions: string[];
}

// ─── Individual Heroine Entry ───────────────────────────────

export interface HeroineEntry {
  /** Heroine name */
  name: string;
  /** Type (e.g., "主线女主", "支线女主", "隐藏女主") */
  type: string;
  /** Current relationship status with the player */
  currentRelationStatus: string;
  /** Current stage in the progression */
  currentStage: string;
  /** Facts that have been established in-game */
  establishedFacts: string[];
  /** Goals for the current stage */
  stageGoals: string[];
  /** Methods to progress the relationship */
  progressionMethods: string[];
  /** Factors that block progression */
  blockingFactors: string[];
  /** Conditions that allow breakthroughs past blocks */
  breakthroughConditions: string[];
  /** What happens if progression fails */
  failureRollback: string[];
}

// ─── Interaction Events ─────────────────────────────────────

export interface HeroineInteractionEvent {
  /** Related heroine */
  heroineName: string;
  /** Event name */
  eventName: string;
  /** Event description */
  eventDescription: string;
  /** Planned trigger time (game time format) */
  plannedTriggerTime: string;
  /** Earliest possible trigger */
  earliestTriggerTime: string;
  /** Latest possible trigger (deadline) */
  latestTriggerTime: string;
  /** Prerequisites that must be met */
  prerequisites: string[];
  /** Trigger conditions */
  triggerConditions: string[];
  /** Conditions that block the event */
  blockConditions: string[];
  /** Outcomes on success */
  successOutcomes: string[];
  /** Outcomes on failure */
  failureOutcomes: string[];
  /** Related quests */
  relatedQuests: string[];
  /** Current status (e.g., "待触发", "进行中", "已完成", "已取消") */
  status: string;
}

// ─── Scene/Camera Planning ──────────────────────────────────

interface HeroineScenePlan {
  /** Related heroine */
  heroineName: string;
  /** Scene title */
  sceneTitle: string;
  /** Scene content description */
  sceneContent: string;
  /** When to trigger */
  triggerTime: string;
  /** Trigger conditions */
  triggerConditions: string[];
  /** Related events */
  relatedEvents: string[];
  /** Related quests */
  relatedQuests: string[];
  /** Content to be committed to memory after the scene */
  retentionContent: string[];
  /** Current status */
  status: string;
}

// ─── Full Heroine Plan ──────────────────────────────────────

export interface HeroinePlan {
  /** Stage progression timeline */
  stageProgression: HeroineStageProgression[];
  /** Individual heroine entries */
  heroineEntries: HeroineEntry[];
  /** Interaction events */
  interactionEvents: HeroineInteractionEvent[];
  /** Scene/camera plans */
  scenePlans: HeroineScenePlan[];
}

/**
 * Format a HeroinePlan into a text block for AI context injection.
 * Formats the 女主剧情规划 context piece for AI injection.
 */
export function formatHeroinePlanForContext(plan: HeroinePlan): string {
  const sections: string[] = [];

  if (plan.stageProgression.length > 0) {
    sections.push('## 阶段推进');
    for (const stage of plan.stageProgression) {
      sections.push(`### ${stage.stageName}`);
      if (stage.stageGoals.length) sections.push(`目标: ${stage.stageGoals.join('、')}`);
      if (stage.primaryHeroines.length) sections.push(`主推: ${stage.primaryHeroines.join('、')}`);
      if (stage.completionCriteria.length) sections.push(`完成判定: ${stage.completionCriteria.join('、')}`);
    }
  }

  if (plan.heroineEntries.length > 0) {
    sections.push('\n## 女主条目');
    for (const h of plan.heroineEntries) {
      sections.push(`### ${h.name} (${h.type})`);
      sections.push(`关系: ${h.currentRelationStatus} | 阶段: ${h.currentStage}`);
      if (h.stageGoals.length) sections.push(`目标: ${h.stageGoals.join('、')}`);
      if (h.blockingFactors.length) sections.push(`阻断: ${h.blockingFactors.join('、')}`);
    }
  }

  if (plan.interactionEvents.length > 0) {
    const pending = plan.interactionEvents.filter((e) => e.status !== '已完成' && e.status !== '已取消');
    if (pending.length > 0) {
      sections.push('\n## 待触发互动事件');
      for (const e of pending) {
        sections.push(`- [${e.heroineName}] ${e.eventName}: ${e.eventDescription} (${e.status})`);
      }
    }
  }

  if (plan.scenePlans.length > 0) {
    const pending = plan.scenePlans.filter((s) => s.status !== '已完成' && s.status !== '已取消');
    if (pending.length > 0) {
      sections.push('\n## 待触发镜头规划');
      for (const s of pending) {
        sections.push(`- [${s.heroineName}] ${s.sceneTitle}: ${s.sceneContent.slice(0, 100)} (${s.status})`);
      }
    }
  }

  return sections.length > 0 ? `【女主剧情规划】\n${sections.join('\n')}` : '';
}

/**
 * Create an empty heroine plan.
 */
export function createEmptyHeroinePlan(): HeroinePlan {
  return {
    stageProgression: [],
    heroineEntries: [],
    interactionEvents: [],
    scenePlans: [],
  };
}
