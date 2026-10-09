import { BehaviorRunner } from '../engine/behaviors/behavior-runner';
import { NpcDedupModule } from '../engine/behaviors/npc-dedup';
import { NpcDemotionModule } from '../engine/behaviors/npc-demotion';
import { NpcMainRoundUpdateModule } from '../engine/behaviors/npc-main-round-update';
import { TimeService, gameCalendar } from '../engine/behaviors/time-service';
import { CommandExecutor, composePushGuards, schemaArrayItemTypes, schemaDeclaresArray, schemaDeclaresPath, schemaNumberBounds } from '../engine/core/command-executor';
import { StateManager } from '../engine/core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import { buildMemoryPushDedupGuard } from '../engine/social/memory-dedup';
import { buildRelationshipMergeGuard } from '../engine/social/relationship-merge-guard';
import { useEngineStateStore } from '../engine/stores/engine-state';
import type { GamePack } from '../engine/types';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createStateKernel(deps: {
  pack: GamePack | null;
}) {
  const { pack } = deps;
  const stateManager = new StateManager();

  // §11.4: 从 pack.stateSchema 动态提取顶层 properties 作为 CommandExecutor 的路径根白名单
  // 这能让 AI 生成的写入路径在运行时被检测为未知根段（console.warn + toast）
  // 零硬编码：pack 更换或 schema 扩充时自动适配
  const schemaRoots: string[] | null = pack
    ? Object.keys(
        ((pack.stateSchema as { properties?: Record<string, unknown> }).properties) ?? {},
      )
    : null;
  const memoryFieldName = DEFAULT_ENGINE_PATHS.npcFieldNames.memory;
  // Push 守卫组合：.记忆 近似去重（抑制）+ 社交.关系 同名 NPC 融合（合并进已有条目，
  // 不丢数据、不打断回合 — 见 relationship-merge-guard.ts / npc-merge.ts 的合并策略）
  const pushDedupGuard = composePushGuards(
    buildMemoryPushDedupGuard(memoryFieldName),
    buildRelationshipMergeGuard(
      stateManager,
      DEFAULT_ENGINE_PATHS.relationships,
      DEFAULT_ENGINE_PATHS.npcFieldNames,
    ),
  );
  // Numeric ranges the pack schema declares (e.g. an affinity of -100~100) bound set/add writes; declared lists and
  // their item types keep a set from replacing a list with one value (E1).
  const commandExecutor = new CommandExecutor(stateManager, schemaRoots, pushDedupGuard,
    pack ? (path => schemaNumberBounds(pack.stateSchema, path)) : undefined,
    pack ? (path => schemaDeclaresArray(pack.stateSchema, path)) : undefined,
    pack ? (path => schemaDeclaresPath(pack.stateSchema, path)) : undefined,
    pack ? (path => schemaArrayItemTypes(pack.stateSchema, path)) : undefined);

  const behaviorRunner = new BehaviorRunner();

  // One calendar for every module that reads the game clock. TimeService once got only 年/月/日, so it carried
  // fallback `hour`/`minute` fields while the real 分钟 grew without end and EffectLifecycle (which read 分钟)
  // expired every new status at round end (2026-09-26, PO D1).
  const calendar = gameCalendar(DEFAULT_ENGINE_PATHS);

  // ── #21: 注册行为模块 ──
  // TimeService：推进游戏内时间进位（分钟→小时→日→月→年 归一化）
  behaviorRunner.register(new TimeService(calendar, DEFAULT_ENGINE_PATHS.characterAge));

  // NpcDedupModule：社交.关系 同名 NPC 兜底融合（onRoundEnd + onGameLoad）
  // push 级守卫（relationship-merge-guard）覆盖 CommandExecutor 路径；此模块
  // 兜住整数组 set（助手 replace-array / GameVariablePanel 原始 JSON）与历史脏存档
  behaviorRunner.register(new NpcDedupModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // NpcMainRoundUpdateModule：记下主回合最后一次更新每位 NPC 的回合（心跳「遗忘回合数」按它算），
  // 读档时给还没有记录的 NPC 补上当前回合。排在去重之后：给融合后的列表记。
  behaviorRunner.register(new NpcMainRoundUpdateModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.roundNumber,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // NpcDemotionModule：回合结束时，超过「NPC 降级阈值」回合没被主回合更新的「重点」（或没写类型的）NPC 降为普通（demo runNpcMaintenance）。
  // 依赖上一个模块记下的「上次主回合更新回合」。
  behaviorRunner.register(new NpcDemotionModule(
    DEFAULT_ENGINE_PATHS.relationships,
    DEFAULT_ENGINE_PATHS.roundNumber,
    DEFAULT_ENGINE_PATHS.npcDemotionThreshold,
    DEFAULT_ENGINE_PATHS.npcTypeKey,
    DEFAULT_ENGINE_PATHS.npcTypeExclude,
    DEFAULT_ENGINE_PATHS.npcFieldNames,
  ));

  // ── #3: 将 Pinia tree 绑定到 StateManager 的 reactive 对象 ──
  // 必须在 createPinia() 之后、任何 UI 读取状态之前调用。
  // 绑定后 StateManager 的所有写操作自动反映到 Vue 响应式系统。
  const engineStateStore = useEngineStateStore();
  engineStateStore.linkStateManager(stateManager);
  // 读档时分发 onGameLoad 行为钩子（npc-dedup 融合 / effect-lifecycle 清理 /
  // validation-repair 修复）——2026-07-05 前这些钩子只在创角后触发，真实读档从不执行
  engineStateStore.linkBehaviorRunner(behaviorRunner);

  return { stateManager, commandExecutor, behaviorRunner, calendar, engineStateStore };
}
