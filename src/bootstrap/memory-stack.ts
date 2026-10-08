import type { BehaviorRunner } from '../engine/behaviors/behavior-runner';
import { MemoryCompilerModule } from '../engine/behaviors/memory-compiler';
import { NarrativeEnvelopeRepairModule } from '../engine/behaviors/narrative-envelope-repair';
import type { StateManager } from '../engine/core/state-manager';
import { DEFAULT_MEMORY_SETTINGS, MemoryManager } from '../engine/memory/memory-manager';
import { MemoryRetriever } from '../engine/memory/memory-retriever';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createMemoryStack(deps: {
  stateManager: StateManager;
  behaviorRunner: BehaviorRunner;
}) {
  const { stateManager, behaviorRunner } = deps;
  // ── #2: 实例化记忆服务 ──
  //
  // 2026-04-11 重构（四层记忆系统）：
  // - shortTermCapacity = 5（降低自 8，match demo + design note）
  // - midTermRefineThreshold = 25（in-place 精炼阈值）
  // - longTermSummaryThreshold = 50（worldview evolution 阈值）
  // - 隐式中期和短期 1:1 配对，由 MemoryManager.shiftAndPromoteOldest 同步 shift
  // - MemoryRetriever 现在依赖 MemoryManager 做隐式中期的相关角色过滤
  const memoryPathConfig = {
    shortTermPath: DEFAULT_ENGINE_PATHS.shortTermMemory,
    midTermPath: DEFAULT_ENGINE_PATHS.memoryMidTerm,
    longTermPath: DEFAULT_ENGINE_PATHS.memoryLongTerm,
    implicitMidTermPath: DEFAULT_ENGINE_PATHS.implicitMidTermMemory,
    semanticMemoryPath: DEFAULT_ENGINE_PATHS.engramMemory,
    // 默认值 —— 可被 localStorage `aga_memory_settings` 运行时覆盖（SettingsPanel UI）
    ...DEFAULT_MEMORY_SETTINGS,
  };
  const memoryManager = new MemoryManager(stateManager, memoryPathConfig);
  // NarrativeEnvelopeRepairModule：读档时修好存成 JSON 外壳（`{"text":"…`）的回合正文、短期记忆与收藏楼层快照（2026-10-03）
  behaviorRunner.register(new NarrativeEnvelopeRepairModule(
    DEFAULT_ENGINE_PATHS.narrativeHistory, memoryPathConfig.shortTermPath, DEFAULT_ENGINE_PATHS.bookmarkedRounds));
  const memoryRetriever = new MemoryRetriever(memoryPathConfig, memoryManager);

  // MemoryCompilerModule：在上下文组装阶段将结构化记忆注入 prompt 变量
  behaviorRunner.register(new MemoryCompilerModule(memoryManager));

  return { memoryManager, memoryRetriever };
}
