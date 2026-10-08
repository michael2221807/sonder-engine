import type { AgaPlotVectorAdapter } from '../features/plot-vector/aga-adapter';
import type { AIService } from '../engine/ai/ai-service';
import type { ResponseParser } from '../engine/ai/response-parser';
import type { CommandExecutor } from '../engine/core/command-executor';
import type { StateManager } from '../engine/core/state-manager';
import type { EngramManager } from '../engine/memory/engram/engram-manager';
import type { MemoryManager } from '../engine/memory/memory-manager';
import type { MemoryRetriever } from '../engine/memory/memory-retriever';
import { CharacterVectorProposePipeline } from '../engine/pipeline/sub-pipelines/character-vector-propose';
import { FieldRepairPipeline } from '../engine/pipeline/sub-pipelines/field-repair';
import { LongTermCompactPipeline } from '../engine/pipeline/sub-pipelines/long-term-compact';
import { MemorySummaryPipeline } from '../engine/pipeline/sub-pipelines/memory-summary';
import { MidTermRefinePipeline } from '../engine/pipeline/sub-pipelines/mid-term-refine';
import { NpcChatPipeline } from '../engine/pipeline/sub-pipelines/npc-chat';
import { NpcGenerationPipeline } from '../engine/pipeline/sub-pipelines/npc-generation';
import { PrivacyProfileRepairPipeline } from '../engine/pipeline/sub-pipelines/privacy-profile-repair';
import { WorldHeartbeatPipeline } from '../engine/pipeline/sub-pipelines/world-heartbeat';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import { PlotDecomposer } from '../engine/plot/plot-decomposer';
import { PlotEvaluationPipeline } from '../engine/plot/plot-evaluation-pipeline';
import { PlotReviser } from '../engine/plot/plot-reviser';
import type { PromptAssembler } from '../engine/prompt/prompt-assembler';
import { NpcMemorySummarizer } from '../engine/social/npc-memory-summarizer';
import type { GamePack } from '../engine/types';

/** Late-bound holder: the plot-vector adapter is built inside the GameOrchestrator argument list (game-loop.ts). */
export interface PlotVectorHolder {
  adapter?: AgaPlotVectorAdapter;
}

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createSubPipelines(deps: {
  pack: GamePack | null;
  aiService: AIService;
  responseParser: ResponseParser;
  promptAssembler: PromptAssembler;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  memoryManager: MemoryManager;
  memoryRetriever: MemoryRetriever;
  engramManager: EngramManager;
  plotVectorHolder: PlotVectorHolder;
}) {
  const { pack, aiService, responseParser, promptAssembler, stateManager, commandExecutor, memoryManager, memoryRetriever, engramManager, plotVectorHolder } = deps;
  // ── GAP_AUDIT §G2: 实例化 4 个后置子管线 ──
  // 这些管线由 GameOrchestrator.runRound 在主回合结束后按条件触发：
  // - MemorySummary: 短期记忆满 → 总结为一条中期记忆条目
  // - MidTermRefine: 中期记忆满 → 精炼为长期记忆条目
  // - WorldHeartbeat: 到达心跳周期 → 为候选 NPC 更新状态
  // - NpcGeneration: 玩家移动到新地点 → 生成 1-3 个 NPC
  let memorySummaryPipeline: MemorySummaryPipeline | undefined;
  let midTermRefinePipeline: MidTermRefinePipeline | undefined;
  let characterVectorProposePipeline: CharacterVectorProposePipeline | undefined;
  let longTermCompactPipeline: LongTermCompactPipeline | undefined;
  let worldHeartbeatPipeline: WorldHeartbeatPipeline | undefined;
  let npcGenerationPipeline: NpcGenerationPipeline | undefined;
  let privacyRepairPipeline: PrivacyProfileRepairPipeline | undefined;
  let fieldRepairPipeline: FieldRepairPipeline | undefined;
  let npcMemSummarizer: NpcMemorySummarizer | undefined;

  if (pack) {
    memorySummaryPipeline = new MemorySummaryPipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
      stateManager, // 2026-04-11: worldview evolution 需要读游戏状态概要
      DEFAULT_ENGINE_PATHS, // 2026-04-11 CR M-09: 路径从 config 读，不再硬编码
    );
    midTermRefinePipeline = new MidTermRefinePipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
    );
    // Character Vectors (R2 second half, 2026-09-06): the world proposes per-NPC vectors after
    // the mid-term refine and every CHARACTER_VECTOR_PROPOSE_INTERVAL rounds.
    characterVectorProposePipeline = new CharacterVectorProposePipeline(
      aiService,
      promptAssembler,
      stateManager,
      memoryManager,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
    longTermCompactPipeline = new LongTermCompactPipeline(
      aiService,
      responseParser,
      promptAssembler,
      memoryManager,
      pack,
    );
    worldHeartbeatPipeline = new WorldHeartbeatPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
      engramManager,
    );
    npcGenerationPipeline = new NpcGenerationPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
    // Phase 4 (2026-04-19): Body polish was promoted from sub-pipeline to
    // `BodyPolishStage` inside the main pipeline (see game-orchestrator.ts).
    // The old `BodyPolishPipeline` sub-pipeline construction was removed from here.

    // Sprint Social-5: NPC memory summarizer
    npcMemSummarizer = new NpcMemorySummarizer(
      stateManager,
      aiService,
      promptAssembler,
      DEFAULT_ENGINE_PATHS,
    );

    privacyRepairPipeline = new PrivacyProfileRepairPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
    );

    fieldRepairPipeline = new FieldRepairPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      memoryRetriever,
      pack,
      DEFAULT_ENGINE_PATHS,
      // Step 3 also regenerates abilities that failed: environment tags and one item/talent/status per round (plot vector, when enabled).
      () => plotVectorHolder.adapter?.abilityRepairTask() ?? Promise.resolve(null),
    );
  }

  // Sprint Plot-1 P4: PlotEvaluationPipeline — 剧情节点评估
  let plotEvaluationPipeline: PlotEvaluationPipeline | undefined;
  let plotDecomposer: PlotDecomposer | undefined;
  let plotReviser: PlotReviser | undefined;
  if (pack) {
    plotEvaluationPipeline = new PlotEvaluationPipeline(
      stateManager,
      DEFAULT_ENGINE_PATHS,
    );
    plotDecomposer = new PlotDecomposer(
      aiService,
      responseParser,
      stateManager,
      pack,
      DEFAULT_ENGINE_PATHS,
      promptAssembler,
    );
    // Plot Revise & Extend epic — AI revision of an existing thread's pending region
    plotReviser = new PlotReviser(
      plotDecomposer,
      stateManager,
      pack,
      DEFAULT_ENGINE_PATHS,
    );
  }

  // §7.2 NPC 私聊子管线 — 独立于主回合的异步 1:1 对话
  // 通过 app.provide 暴露给 UI 层（RelationshipPanel / NpcChatModal）
  let npcChatPipeline: NpcChatPipeline | null = null;
  if (pack) {
    npcChatPipeline = new NpcChatPipeline(
      stateManager,
      commandExecutor,
      aiService,
      responseParser,
      promptAssembler,
      pack,
      DEFAULT_ENGINE_PATHS,
      memoryManager,
      engramManager,
    );
  }

  return { memorySummaryPipeline, midTermRefinePipeline, characterVectorProposePipeline, longTermCompactPipeline, worldHeartbeatPipeline, npcGenerationPipeline, privacyRepairPipeline, fieldRepairPipeline, npcMemSummarizer, plotEvaluationPipeline, plotDecomposer, plotReviser, npcChatPipeline };
}
