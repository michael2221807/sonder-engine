import type { BehaviorRunner } from '../engine/behaviors/behavior-runner';
import { ComputedFieldsModule } from '../engine/behaviors/computed-fields';
import { ContentFilterModule } from '../engine/behaviors/content-filter';
import { CrossRefSyncModule } from '../engine/behaviors/cross-ref-sync';
import { EffectLifecycleModule } from '../engine/behaviors/effect-lifecycle';
import { NpcBehaviorModule } from '../engine/behaviors/npc-behavior';
import { ThresholdTriggersModule } from '../engine/behaviors/threshold-triggers';
import type { gameCalendar } from '../engine/behaviors/time-service';
import { ValidationRepairModule } from '../engine/behaviors/validation-repair';
import type { CommandExecutor } from '../engine/core/command-executor';
import type { StateManager } from '../engine/core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import type { ComputedFieldConfig, ContentFilterConfig, EffectLifecycleConfig, GamePack, IntegrityRule, NpcBehaviorConfig, ThresholdTriggerConfig } from '../engine/types';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function registerPackBehaviors(deps: {
  pack: GamePack | null;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  behaviorRunner: BehaviorRunner;
  calendar: ReturnType<typeof gameCalendar>;
}) {
  const { pack, stateManager, commandExecutor, behaviorRunner, calendar } = deps;
  // ── GAP_AUDIT §G1: 注册剩余行为模块（读 pack.rules 的 JSON 配置） ──
  //
  // 注册顺序依赖：
  // 1. TimeService 必须在 EffectLifecycle 之前（effect 的过期判断依赖已归一化的时间）
  // 2. ComputedFields 宜在 TimeService 之后（衍生字段可能引用时间相关值）
  // 3. ValidationRepair 最后，在其他模块可能产生的"修复机会"之后执行收尾校验
  //
  // 所有模块 config 来自 Game Pack 的 rules/*.json，
  // 不存在时模块不注册（引擎不强制依赖 pack 内容）。
  if (pack) {
    const rules = pack.rules as Record<string, unknown>;

    // ComputedFields — onCreation / onRoundEnd / onLoad 计算派生字段
    const computedConfig = rules['computedFields'] as { fields?: ComputedFieldConfig[] } | undefined;
    if (computedConfig?.fields?.length) {
      behaviorRunner.register(new ComputedFieldsModule(computedConfig.fields));
    }

    // EffectLifecycle — onRoundEnd / onGameLoad 清理过期 buff/debuff
    const effectConfig = rules['effectLifecycle'] as EffectLifecycleConfig | undefined;
    if (effectConfig?.effectsPath && effectConfig.effectSchema) {
      const effectLifecycle = new EffectLifecycleModule(effectConfig, calendar);
      behaviorRunner.register(effectLifecycle);
      // A status written by any flow (sub-pipelines, the assistant) starts on the game clock too (PO G1).
      commandExecutor.observeBatches(changeLog => effectLifecycle.stampWritten(stateManager, changeLog));
    }

    // ThresholdTriggers — onRoundEnd / onGameLoad 检查阈值触发事件
    const triggerConfig = rules['thresholdTriggers'] as { triggers?: ThresholdTriggerConfig[] } | undefined;
    if (triggerConfig?.triggers?.length) {
      behaviorRunner.register(new ThresholdTriggersModule(triggerConfig.triggers));
    }

    // NpcBehavior — afterCommands 钩子中处理玩家移动时的 NPC 跟随/留守
    const npcConfig = rules['npcBehavior'] as NpcBehaviorConfig | undefined;
    if (npcConfig?.npcTypes) {
      behaviorRunner.register(new NpcBehaviorModule(
        npcConfig,
        {
          playerLocation: DEFAULT_ENGINE_PATHS.playerLocation,
          npcList: DEFAULT_ENGINE_PATHS.npcList, // 已修正为 '社交.关系'
        },
      ));
    }

    // ContentFilter — onContextAssembly 钩子中按 nsfwMode 等评级开关剥离 prompt 中的敏感片段
    const filterConfig = rules['contentFilter'] as ContentFilterConfig | undefined;
    if (filterConfig?.contentRatings) {
      behaviorRunner.register(new ContentFilterModule(filterConfig));
    }

    // CrossRefSync — afterCommands 钩子中维护 NPC.位置 ↔ 地点.NPC 列表双向一致
    const syncConfig = rules['crossRefSync'] as { rules?: IntegrityRule[] } | undefined;
    if (syncConfig?.rules?.length) {
      behaviorRunner.register(new CrossRefSyncModule(syncConfig.rules));
    }

    // ValidationRepair — 最后注册，在其他模块执行完后做收尾的 schema 校验与字段修复
    // 不依赖 rules/*.json，直接读 pack.stateSchema
    behaviorRunner.register(new ValidationRepairModule(pack.stateSchema));
  }
}
