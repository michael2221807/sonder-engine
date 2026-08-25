/**
 * 游戏管线类型定义
 *
 * 管线是引擎的核心游戏循环，将一次玩家输入拆分为若干顺序阶段：
 * PreProcess → ContextAssembly → AICall → CommandExecution → PostProcess → Render
 *
 * 每个阶段实现 PipelineStage 接口，通过 PipelineContext 在阶段间传递和累积数据。
 * 这种设计使得：
 * 1. 各阶段可独立测试和替换（如替换 AICallStage 为 mock）
 * 2. 子管线（记忆总结、世界心跳等）可复用相同的 Runner 机制
 * 3. 新阶段（如 COT、世界事件注入）可插入而不影响已有逻辑
 *
 * 依赖接口（I-prefixed）遵循依赖反转原则（DIP）：
 * 管线阶段只依赖抽象接口，不直接耦合 memory/behaviors 模块的具体实现。
 * 当 engine/memory/ 和 engine/behaviors/ 创建后，
 * 具体类实现这些接口即可无缝对接管线。
 *
 * 对应 STEP-03B M3.2。
 */
import type { AIMessage, AIResponse } from '../ai/types';
import type { BatchCommandResult, ChangeLog, QueuedAction } from '../types';
import type { StateManager } from '../core/state-manager';
import type {
  ImplicitMidTermEntry,
  LongTermEntry,
  MidTermEntry,
} from '../memory/memory-manager';

// ═══════════════════════════════════════════════════════════════
//  管线核心类型
// ═══════════════════════════════════════════════════════════════

/**
 * 管线执行上下文 — 在各 Stage 间传递和累积数据
 *
 * 采用不可变风格：每个 Stage 返回新的 context 对象（浅拷贝 + 修改字段），
 * 避免跨阶段的隐式副作用。Runner 用返回值替换 ctx 引用。
 */
/**
 * 阶段间临时数据袋（`PipelineContext.meta`）。
 *
 * 保留 `[key: string]: unknown` 索引签名以兼容前向扩展与任意键访问；下方已知字段
 * 提供类型，让常用键无需 `as` 断言即可获得类型安全（L-1：原为裸 `Record<string,unknown>`）。
 * 新增跨阶段字段时，优先在此登记类型而非依赖断言。
 */
export interface PipelineMeta {
  [key: string]: unknown;

  // ── 子管线分派标志（GameOrchestrator 读取） ──
  /** 短期记忆已满 → 触发 MemorySummaryPipeline */
  pendingSummary?: boolean;
  /** 到达心跳周期 → 触发 WorldHeartbeatPipeline */
  pendingHeartbeat?: boolean;
  /** 到达剧情评估点 → 触发 PlotEvaluationPipeline */
  pendingPlotEval?: boolean;
  /**
   * 私密档案补全报告（CommandExecutionStage → GameOrchestrator）。
   * 类型留 `unknown` 以避免与 command-execution 形成 import 环；消费侧自行断言。
   */
  pendingPrivacyRepair?: unknown;

  // ── Enhanced Opening（Story 0） ──
  /** 增强开局标记：ImageService 跳过 + PostProcess/ContextAssembly flow override */
  isEnhancedOpening?: boolean;
  /** Phase D 知识边，编排器 Phase F 注入合成 parsedResponse.knowledgeFacts */
  openingFacts?: Array<{ fact: string; sourceEntity: string; targetEntity: string }>;
  /** splitGen step1 的 flow 注册键覆盖（camelCase） */
  step1FlowOverride?: string;
  /** splitGen step2 的 flow 注册键覆盖（camelCase） */
  step2FlowOverride?: string;

  // ── 分步生成 / CoT（AICallStage） ──
  /** 分步生成开关 */
  splitGen?: boolean;
  /** 第 2 步预组装消息列表 */
  splitStep2Messages?: AIMessage[];
  /** 第 2 步消息来源标签 */
  splitStep2Sources?: string[];
  /** 思维链捕获开关 */
  cotEnabled?: boolean;
  /** 将 step1 thinking 注入 step2 */
  cotInjectStep2?: boolean;
  /** CoT 裁判开关（ContextAssembly 写、读） */
  cotJudgeEnabled?: boolean;
  /** step2 原始响应（PostProcess 消费） */
  rawResponseStep2?: string;
  /** 推理内容已摄入标记（ReasoningIngestStage） */
  reasoningIngested?: boolean;

  // ── 调试透传（AICallStage → debug recorder） ──
  debugVariables?: Record<string, string>;
  debugRoundNumber?: number;

  // ── 环境块（ContextAssembly → BodyPolish） ──
  environmentBlock?: string;
  worldEventContext?: string;

  // ── 身体润色结果（BodyPolishStage） ──
  polishApplied?: boolean;
  /** 是否为手动触发的润色（PostProcess 消费） */
  polishManual?: boolean;
  polishOriginalText?: string;
  polishModel?: string;
  polishDurationMs?: number;
}

export interface PipelineContext {
  /** 用户输入文本（PreProcessStage 可能 prepend 了 action queue 内容） */
  userInput: string;
  /**
   * The player's input EXACTLY as it entered `runRound()` — never modified by any stage.
   *
   * Canon Capture validates every captured setting against text found inside a `<设定>`
   * tag in THIS string. `userInput` is unusable for that: `PreProcessStage` prepends the
   * action-queue description to it, so a panel action's text would become forgeable
   * "player evidence". Keeping the pristine input separate is what stops a machine-
   * generated line from being permanently recorded as something the player wrote.
   *
   * Optional so existing context constructors (enhanced opening) stay valid; consumers
   * fall back to `userInput` only where evidence is NOT at stake.
   */
  originalUserInput?: string;
  /** action queue 消费后格式化的操作描述（空字符串表示本回合无面板操作） */
  actionQueuePrompt: string;
  /**
   * 当前回合开始时的状态树快照（深拷贝）
   * 冻结一份给 AI 看，避免指令执行过程中的状态变化影响 prompt 的一致性
   */
  stateSnapshot: Record<string, unknown>;
  /** 叙事历史（user/assistant 消息对）— 从状态树 "元数据.叙事历史" 读取 */
  chatHistory: AIMessage[];
  /** 最终组装的消息列表（由 PromptAssembler 生成，传给 AIService） */
  messages: AIMessage[];
  /** AI 原始响应文本（sanitize 前） */
  rawResponse?: string;
  /** 解析后的结构化响应（text + commands + memory 等） */
  parsedResponse?: AIResponse;
  /** 指令执行结果（包含每条指令的成功/失败和变更日志） */
  commandResults?: BatchCommandResult;
  /** 最终叙事文本（渲染用） */
  narrativeText?: string;
  /** 行动选项列表（渲染用） */
  actionOptions?: string[];
  /**
   * 流式 chunk 回调 — 由调用方（UI 层）提供
   * AICallStage 透传给 AIService，实现打字机效果
   */
  onStreamChunk?: (chunk: string) => void;
  /**
   * 进度通知回调 — PipelineRunner 在每个阶段开始时调用
   * UI 层可据此显示 "正在组装上下文..." 等状态文本
   */
  onProgress?: (msg: string | { i18nKey: string; i18nParams?: Record<string, unknown>; message: string }) => void;
  /**
   * 取消信号 — 由 UI 层的 AbortController 控制
   * PipelineRunner 在每个阶段执行前检查，AIService 内部也监听此信号
   */
  abortSignal?: AbortSignal;
  /** 生成请求 ID（UUID），跨阶段保持一致，用于日志追踪和调试 */
  generationId: string;
  /** 当前回合序号（由 PreProcessStage 从状态树读取并递增） */
  roundNumber: number;
  /**
   * AICall 开始时的 performance.now() 时间戳（ms）。
   *
   * Phase 1 (2026-04-19) — 为 narrativeHistory 条目上的 `_metrics.startedAt` 字段
   * 提供数据来源。由 AICallStage 在发起 API 调用前填入。split-gen 下记录的是 step1
   * 的起点，`aiCallDurationMs` 覆盖两次 API 调用的总耗时。
   */
  aiCallStartedAt?: number;
  /**
   * AICall 端到端耗时（ms）。
   *
   * Phase 1 (2026-04-19) — single call: end − start；split-gen: step2 end − step1 start
   * （包含两次 API 的总 wall-clock 耗时）。由 AICallStage 填入，PostProcess 读取
   * 并写入 `_metrics.durationMs`。
   */
  aiCallDurationMs?: number;
  /**
   * 本回合开始前的状态树深拷贝（由 PreProcessStage 在递增回合序号前捕获）
   * PostProcessStage 将其写入 `paths.preRoundSnapshot`，用于 Rollback 功能
   */
  preRoundSnapshot?: Record<string, unknown>;
  /**
   * 当回合是否触发了世界事件
   * ContextAssemblyStage 通过 BehaviorRunner 检查，影响心跳和子管线决策
   */
  worldEventTriggered: boolean;
  /**
   * 自由扩展字段 — 用于阶段间传递临时数据
   * 例如：pendingSummary（标记需要执行记忆总结子管线）、
   * pendingHeartbeat（标记需要执行世界心跳）、worldEventContext（事件上下文文本）、
   * splitGen（分步生成开关）、splitStep2Messages（第2步预组装消息列表）
   *
   * Enhanced Opening 新增字段（Story 0）：
   * - isEnhancedOpening?: boolean — 增强开局标记；ImageService 跳过（Impl-Phase 1 已实现）；
   *   PostProcess user entry 跳过 + ContextAssembly flow override 属于 Impl-Phase 2
   * - openingFacts?: Array<{fact: string; sourceEntity: string; targetEntity: string}> — Phase D 知识边，
   *   由编排器 Phase F 注入到合成 parsedResponse.knowledgeFacts（Impl-Phase 2）
   * - step1FlowOverride?: string — splitGen step1 的 flow 注册键覆盖（camelCase，Impl-Phase 2）
   * - step2FlowOverride?: string — splitGen step2 的 flow 注册键覆盖（camelCase，Impl-Phase 2）
   *
   * L-1（2026-05-28）：类型由裸 `Record<string,unknown>` 升级为 `PipelineMeta`
   * （索引签名 + 已知字段类型化），常用键不再需要 `as` 断言。
   */
  meta: PipelineMeta;
}

/** 管线阶段接口 — 每个 Stage 实现此接口 */
export interface PipelineStage {
  /** 阶段名称（用于日志输出和进度通知的标识） */
  name: string;
  /**
   * 执行阶段逻辑
   * @param context 当前上下文（只读消费）
   * @returns 更新后的上下文（不可变风格，返回新对象）
   */
  execute(context: PipelineContext): Promise<PipelineContext>;
}

// ═══════════════════════════════════════════════════════════════
//  管线阶段依赖接口（Dependency Inversion）
// ═══════════════════════════════════════════════════════════════
//
// 管线阶段通过构造函数注入这些接口的实现。
// 之所以定义接口而非直接依赖具体类：
// 1. memory/behaviors 模块与管线同属 M3，允许并行开发
// 2. 单元测试时可注入 mock 实现
// 3. 避免 pipeline → memory → pipeline 的循环依赖

/**
 * 动作队列消费者 — PreProcessStage 用于获取排队的面板操作
 *
 * 实现方：engine/stores/engine-action-queue.ts 的 useActionQueueStore()
 * 面板操作（装备、使用、丢弃等）先入队，下次 AI 调用时由此接口消费
 */
export interface IActionQueueConsumer {
  /** 返回并清空所有排队动作（空数组表示本回合无面板操作） */
  consumeActions(): QueuedAction[];
}

/**
 * 记忆检索器 — ContextAssemblyStage 用于获取注入 prompt 的记忆文本
 *
 * 实现方：engine/memory/memory-retriever.ts
 * 从多层记忆（短期/中期/长期/Engram）检索与当前上下文相关的记忆片段，
 * 格式化为可直接嵌入 prompt 模板的文本块
 */
export interface IMemoryRetriever {
  /**
   * 根据当前游戏状态检索相关记忆，返回格式化后的注入文本
   *
   * @param stateManager 状态管理器
   * @param ctx 可选检索上下文 — playerName + recentNpcNames 用于隐式中期记忆
   *            的相关角色过滤（2026-04-11 重构新增）。未提供时降级到全量注入。
   */
  retrieve(
    stateManager: StateManager,
    ctx?: { playerName?: string; recentNpcNames?: string[]; skipShortTerm?: boolean },
  ): string;
}

/**
 * 行为运行器 — 管理引擎内置行为模块的生命周期钩子
 *
 * 实现方：engine/behaviors/behavior-runner.ts
 * 行为模块（时间服务、效果生命周期、交叉引用同步等）
 * 通过钩子在管线的特定时机执行，而非硬编码到管线阶段中。
 * 这使得新增行为模块只需注册到 Runner，无需修改管线代码。
 */
export interface IBehaviorRunner {
  /** 检查是否有定时世界事件到期（返回 true 表示本回合有事件触发） */
  checkScheduledEvents(stateManager: StateManager): boolean;
  /** 上下文组装阶段钩子 — MemoryCompiler、ContentFilter 等在此注入/修改模板变量 */
  runOnContextAssembly(stateManager: StateManager, variables: Record<string, string>): void;
  /** 指令执行后钩子 — CrossRefSync、ThresholdTriggers、NpcBehavior 在此响应状态变更 */
  runAfterCommands(stateManager: StateManager, changeLog: ChangeLog): void;
  /** 回合结束钩子 — TimeService、EffectLifecycle、ComputedFields 在此执行周期性逻辑 */
  runOnRoundEnd(stateManager: StateManager): void;
}

/**
 * 记忆管理器运行时配置 — `getEffectiveConfig` 返回的实际生效值
 *
 * 这些字段都是 `MemoryPathConfig` 默认值和 `localStorage.aga_memory_settings`
 * 用户覆盖合并 clamp 后的结果，表示**此刻**的记忆系统工作参数。
 */
export interface EffectiveMemoryConfig {
  shortTermCapacity: number;
  midTermRefineThreshold: number;
  longTermSummaryThreshold: number;
  longTermSummarizeCount: number;
  midTermKeep: number;
  longTermCap: number;
}

/**
 * 隐式中期记忆的合法输入格式（2026-04-11 CR M-05 修复）
 *
 * `appendImplicitMidTerm` 接受三种形态：
 * - 规范对象 `ImplicitMidTermEntry`
 * - 兼容字符串（旧格式，会被 wrap）
 * - 兼容英文字段对象（`{characters, gameTime, content}`，字段名自动映射）
 *
 * 不接受 `undefined`/`null`：调用者必须自己判空（post-process.ts 已按此约定调用）。
 */
export type ImplicitMidTermInput =
  | ImplicitMidTermEntry
  | string
  | Record<string, unknown>;

/**
 * 记忆管理器 — PostProcessStage 用于维护多层记忆体系
 *
 * 实现方：engine/memory/memory-manager.ts
 * 管理短期（最近叙事）→ 中期（AI 总结）→ 长期（压缩摘要）的记忆流转
 *
 * 2026-04-11 CR M-06 修复：补齐三方法（`shouldCompactLongTerm` / `fallbackTrimLongTerm`
 * / `getEffectiveConfig`）+ `commitSummaryResult`，让 orchestrator 和 sub-pipeline
 * 都能只依赖 IMemoryManager 而非具体类。
 */
export interface IMemoryManager {
  // ─── 写入 ───
  /** 追加叙事文本到短期记忆，附带当前回合号，保证排序一致性 */
  appendShortTerm(content: string, round: number): void;
  /**
   * 追加 AI 返回的隐式中期记忆条目（`mid_term_memory` 字段）。
   * 接受规范对象 / 兼容字符串 / 英文字段旧对象，不接受 null/undefined。
   */
  appendImplicitMidTerm(entry: ImplicitMidTermInput): void;
  /** 整体替换中期记忆数组（MidTermRefinePipeline 使用） */
  setMidTermEntries(entries: MidTermEntry[]): void;
  /** 整体替换长期记忆数组（LongTermCompactPipeline 使用） */
  setLongTermEntries(entries: LongTermEntry[]): void;
  /**
   * worldview evolution 原子提交：追加新长期记忆 + 替换中期为 toKeep
   * 保证两步之间不会因异常产生 "长期涨但中期未消费" 的半提交状态
   * （详见 memory-manager.ts commitSummaryResult 的 JSDoc）
   */
  commitSummaryResult(
    newLongTerm: LongTermEntry[],
    midTermKeep: MidTermEntry[],
  ): void;

  // ─── 读取 ───
  /** 读取全部短期记忆条目 */
  getShortTermEntries(): Array<{ round: number; summary: string; timestamp: number }>;
  /** 读取全部中期记忆条目 */
  getMidTermEntries(): MidTermEntry[];
  /** 读取全部长期记忆条目 */
  getLongTermEntries(): LongTermEntry[];
  /** 判断中期条目是否已被 in-place refine 过 */
  isMidTermEntryRefined(entry: MidTermEntry): boolean;

  // ─── 层级转换 ───
  /**
   * 短期记忆溢出时同步 shift + 升级隐式中期为正式中期（2026-04-11 重构）
   * @returns 本次实际升级到正式中期的条目数
   */
  shiftAndPromoteOldest(): number;
  /**
   * 长期记忆 FIFO fallback trim —— compact 管线失败时的退路
   * @returns 实际被裁剪的条目数（0 表示无需裁剪）
   */
  fallbackTrimLongTerm(): number;

  // ─── 阈值判定 ───
  /** 中期记忆是否达到 in-place refine 阈值（默认 25） */
  shouldRefineMidTerm(): boolean;
  /** 中期记忆是否达到 worldview evolution 阈值（默认 50） */
  shouldSummarizeLongTerm(): boolean;
  /** 长期记忆是否超过 cap，需要触发 LongTermCompactPipeline（默认 30） */
  shouldCompactLongTerm(): boolean;

  // ─── 运行时配置 ───
  /**
   * 获取实时生效的记忆配置（每次调用都重新读 localStorage 覆盖）
   * 用于 sub-pipeline 按用户设置决定窗口/阈值。
   */
  getEffectiveConfig(): EffectiveMemoryConfig;
  /** R-04: 清除 getEffectiveConfig 缓存（rollback 后调用） */
  clearConfigCache(): void;
}

/**
 * Engram 知识图谱管理器 — PostProcessStage 用于更新结构化记忆
 *
 * 实现方：engine/memory/engram/engram-manager.ts
 * 从 AI 响应中提取事件、构建实体和事实边、写入状态树、异步向量化。
 * 整个流程中只有向量化是异步非阻塞的，其余操作同步完成。
 */
export interface IEngramManager {
  /** 检查 Engram 功能是否启用（由 Game Pack 配置控制） */
  isEnabled(): boolean;
  /**
   * 处理 AI 响应：提取事件 → 构建实体 → FactBuilder 边构建 → 写入状态树 → 异步向量化
   * 返回写入快照供 UI 可视化，Engram 未启用时返回 null
   */
  processResponse(
    response: AIResponse,
    stateManager: StateManager,
    options?: import('../memory/engram/engram-manager').ProcessResponseOptions,
  ): Promise<import('../memory/engram/engram-types').EngramWriteSnapshot | null>;
  /** 获取当前 Engram 配置（ContextAssemblyStage 用于检索模式决策） */
  getConfig(): import('../memory/engram/engram-types').EngramConfig;
  /**
   * 将 IndexedDB 向量数据同步到当前状态树 —— rollback 后调用
   *
   * 状态树恢复到快照后，IndexedDB 里可能残留被回退回合的向量。
   * 此方法删除不在当前 events/entities 中的孤立向量。fire-and-forget。
   */
  syncVectorsToState(stateManager: StateManager): Promise<void>;
}

/**
 * 统一检索器 — ContextAssemblyStage 在 hybrid 模式下使用（V2 三路并行检索）
 *
 * 实现方：engine/memory/engram/unified-retriever.ts
 */
export interface IUnifiedRetriever {
  retrieve(query: string, context: import('../memory/engram/unified-retriever').RetrievalContext, stateManager: StateManager): Promise<string>;
  /** Last read snapshot captured during retrieve(), null if not yet called or Engram disabled */
  readonly lastReadSnapshot?: import('../memory/engram/engram-types').EngramReadSnapshot | null;
}

// ═══════════════════════════════════════════════════════════════
//  引擎路径配置（消除硬编码的状态树路径）
// ═══════════════════════════════════════════════════════════════

/**
 * 引擎状态树路径映射 — 将语义名称映射到 Game Pack 定义的 dot-path
 *
 * 设计动机：
 * 管线阶段和行为模块需要读写状态树中的特定路径（如回合序号、叙事历史），
 * 但这些路径由 Game Pack 的 state-schema 定义（可能是中文、英文或任意命名）。
 * 通过此配置将路径外部化，引擎代码不再包含硬编码的 Game Pack 路径。
 *
 * Game Pack 在 manifest.enginePaths（或 rules/engine-paths.json）中提供这些映射。
 */
export interface EnginePathConfig {
  /** 回合序号（如 "元数据.回合序号"） */
  roundNumber: string;
  /** 叙事历史（如 "元数据.叙事历史"） */
  narrativeHistory: string;
  /** 游戏内时间对象（如 "世界.时间"，值为 {年, 月, 日}） */
  gameTime: string;
  /** 玩家名字（如 "角色.基础信息.姓名"） */
  playerName: string;
  /** 玩家当前位置（如 "角色.基础信息.当前位置"） */
  playerLocation: string;
  /** 角色基础信息子树根路径（如 "角色.基础信息"） */
  characterBaseInfo: string;
  /** 角色属性子树根路径（如 "角色.属性"） */
  characterAttributes: string;
  /** 角色年龄（如 "角色.基础信息.年龄"） */
  characterAge: string;
  /** 角色性别（如 "角色.基础信息.性别"） */
  characterGender: string;
  /** 角色地位名称（如 "角色.可变属性.地位.名称"） */
  characterOccupation: string;
  /** 角色地位描述（如 "角色.可变属性.地位.描述"） */
  characterDescription: string;
  /**
   * 角色特质路径（如 "角色.基础信息.特质"）— {名称, 描述} 对象
   */
  characterTraits: string;
  /** 角色出身路径（如 "角色.身份.出身"）— 创角只读 {名称, 描述} */
  characterOrigin: string;
  /** 角色天赋档次路径（如 "角色.身份.天赋档次"）— 创角只读 string */
  characterTalentTier: string;
  /**
   * 角色先天六维路径（如 "角色.身份.先天六维"）— 创角基线对象，1-10 范围
   * 与 `characterAttributes`（后天六维，1-20）区分：前者是玩家分配的基线，
   * 后者是基线 + 出身修正 + 天赋修正后的运行时值
   */
  characterInnateStats: string;
  /** 背包物品列表（如 "角色.背包.物品"） */
  inventoryItems: string;
  /** 背包货币（如 "角色.背包.金钱"） */
  inventoryCurrency: string;
  /** 心跳配置对象（如 "世界.状态.心跳.配置"，结构见 HeartbeatConfig） */
  heartbeatConfig: string;
  /** 心跳是否启用（如 "世界.状态.心跳.配置.enabled"） */
  heartbeatEnabled: string;
  /** 心跳触发周期（如 "世界.状态.心跳.配置.period"） */
  heartbeatPeriod: string;
  /** 上次心跳回合序号（如 "世界.状态.心跳.上次心跳回合序号"） */
  lastHeartbeatRound: string;
  /** 心跳历史（如 "世界.状态.心跳.历史"） */
  heartbeatHistory: string;
  /** 上次心跳执行时间戳（如 "世界.状态.心跳.上次执行时间"） */
  heartbeatLastRun: string;
  /** 世界事件列表（如 "世界.事件"） */
  worldEvents: string;
  /** 社交关系表（如 "社交.关系"） */
  relationships: string;
  /** 世界描述（如 "世界.描述"） */
  worldDescription: string;
  /**
   * 当前天气（string，如 "世界.天气"，值为 "晴"/"阴雨"/etc.）
   *
   * 2026-04-19 env-tags port. 每回合主回合/心跳回合的 commands 必须包含
   * `set 世界.天气` —— 强制 re-emission 替代 expiry 逻辑。默认 "晴"。
   */
  weather: string;
  /**
   * 当前节日（object，如 "世界.节日"，值为 {名称, 描述, 效果}）
   *
   * 2026-04-19 env-tags port. 默认 {名称:"平日", 描述:"", 效果:""} 表示无节日；
   * 每回合 AI 强制 set；UI 侧用 isFestivalVisible() 决定是否显示 chip。
   */
  festival: string;
  /**
   * 环境标签数组（如 "世界.环境"，值为 Array<{名称, 描述, 效果}>）
   *
   * 2026-04-19 env-tags port. 每回合 AI 用 `set` 整体替换数组（无 push/delete）；
   * 上限 3 条；引擎不做 lifecycle / expiry 管理。
   */
  environmentTags: string;
  /** Engram 记忆存储路径（如 "系统.扩展.engramMemory"） */
  engramMemory: string;
  /** NPC 列表（如 "NPC列表"） */
  npcList: string;
  /** 地点列表（如 "世界.地点信息"） */
  locations: string;
  /** 体力（{当前, 上限}，如 "角色.可变属性.体力"） */
  vitalHealth: string;
  /** 精力（{当前, 上限}，如 "角色.可变属性.精力"） */
  vitalEnergy: string;
  /** 状态效果数组（buff/debuff，如 "角色.效果"） */
  statusEffects: string;
  /** 声望数值（如 "角色.可变属性.声望"） */
  reputation: string;
  /** 天赋列表（如 "角色.身份.天赋"）— [{名称, 描述}, ...] */
  talents: string;
  /** 游戏时间·小时（如 "世界.时间.小时"） */
  gameTimeHour: string;
  /** 游戏时间·分钟（如 "世界.时间.分钟"） */
  gameTimeMinute: string;
  /**
   * 游戏时间对象的字段名映射（B0-2, 2026-08-20）
   *
   * `gameTime` 路径指向的是一个 `{年, 月, 日, 小时, 分钟}` 对象。世界书 timeline
   * 过滤需要把它格式化为 `YYYY:MM:DD:HH:MM` 字符串，而 `src/engine/` 不得硬编码
   * 中文字段名（CLAUDE.md §4 引擎/内容分离），因此和 `npcFieldNames` 一样通过
   * 此映射注入。Game Pack 可通过 manifest 的 enginePaths 覆写。
   */
  gameTimeFieldNames: EngineGameTimeFieldNames;
  /** 上次对话前快照路径（用于 Rollback，如 "元数据.上次对话前快照"） */
  preRoundSnapshot: string;
  /**
   * Slot-owned world books (Canon Capture) — `WorldBook[]` living INSIDE the state tree
   * (e.g. "系统.扩展.slotWorldBooks").
   *
   * Why the state tree and not `WorldBookStorage`: books stored in IndexedDB are keyed
   * `profileId:book.id`, so every save slot of a profile would share them and they would
   * NOT roll back with the round. Putting auto-captured settings in the state tree makes
   * them slot-scoped, rollback-correct, and carried by save / backup / cloud sync for
   * free — no second persistence path to keep in sync.
   *
   * Stripped from `GAME_STATE_JSON` (see `PROMPT_ALWAYS_STRIP_PATHS`): the entries reach
   * the model through the world-book budget block, never as raw state.
   */
  slotWorldBooks: string;
  /**
   * Last Canon Capture outcome for this slot (e.g. "系统.扩展.settingCaptureLast").
   *
   * Why it exists (2026-08-21 real-API acceptance finding): the only feedback for a
   * capture round was a 10-second toast. A player reading a 3000-character reply missed
   * it, found the world-book tab empty, and had NO way to learn what happened or to
   * reach the manual-add fallback. This record backs a persistent banner in the panel.
   * Written ONLY on rounds that carried a tag — saves that never use the feature stay
   * byte-identical — and it rolls back with the round like everything else.
   */
  settingCaptureLast: string;
  /**
   * 玩家已探索地点名称数组（如 "系统.探索记录"）
   * 由引擎 PostProcessStage 在每回合自动维护，无需 AI 命令写入。
   * 用于地图面板的探索状态节点样式（已探索绿边框 / 未探索降低透明度）。
   */
  explorationRecord: string;

  /**
   * NPC 字段名映射 —— Sprint Social-1 引入的**子对象先例**。
   *
   * 背景：`relationships` 路径（'社交.关系'）下是数组，每项是一个 NPC 对象。
   * 引擎代码需要按**字段名**读写 NPC 对象的具体字段（如 `npc['是否在场']`），
   * 但不应硬编码 Chinese 字段字面量（PRINCIPLES §3.3 内容中立要求 + CLAUDE.md §5
   * 引擎/内容分离）。此子对象集中承载 NPC 对象上的字段 key 映射。
   *
   * 架构先例（decisions.md §1.1, 2026-04-15 amendment）：
   * 这是 `EnginePathConfig` 首次引入**子对象值**（之前所有 key 都是单个 dot-path 字符串）。
   * 未来其他子系统可以加类似的 `xxxFieldNames` 子对象（例如 image 系统）。
   * 子对象中的值是**字段名 key**（不是完整 dot-path）；引擎代码组合使用：
   *   `paths.relationships + '[名称=' + npc + '].' + paths.npcFieldNames.isPresent`
   *
   * 详细字段说明见 `EngineNpcFieldNames`。
   */
  npcFieldNames: EngineNpcFieldNames;

  /**
   * CoT 推理历史数组路径（如 "元数据.推理历史"）— Sprint CoT-2
   *
   * 存储 ReasoningIngestStage 从每轮 `AIResponse.thinking` 捕获的推理文本。
   * FIFO ring 上限由 `系统.设置.cot.reasoningRingSize` 控制（默认 3）。
   * 注入模板变量 `{{PREV_THINKING}}` 供 ContextAssemblyStage 使用。
   * 已加入 `PROMPT_ALWAYS_STRIP_PATHS` 避免在 GAME_STATE_JSON 中重复。
   */
  reasoningHistory: string;

  /**
   * 剧情规划路径（如 "元数据.剧情规划"）— Sprint CoT-2
   *
   * 可选的 `<story_plan>` 标签内容（CoT-3 启用后由 AI 输出）。
   * 同样通过 `PROMPT_ALWAYS_STRIP_PATHS` 剥离以避免 JSON 重复。
   */
  storyPlan: string;

  /**
   * 剧情导向系统根路径（如 "元数据.剧情导向"）— Sprint Plot-1
   *
   * 存储 PlotDirectionState：弧线列表、活跃弧线索引、临时评估结果。
   * 通过 `PROMPT_ALWAYS_STRIP_PATHS` 剥离——AI 通过 PLOT_* 模板变量
   * 接收剧情信息，不需要看原始数据模型。
   */
  plotDirection: string;
  /**
   * 中期记忆数组路径（如 "记忆.中期"）— Plot Threads §7.1：PlotDecomposer 记忆段。
   * 条目形状 `{记忆主体, …}[]`（memory-system.md §3）。
   */
  memoryMidTerm: string;
  /** 长期记忆数组路径（如 "记忆.长期"）— 同上。 */
  memoryLongTerm: string;

  /**
   * 收藏楼层路径（如 "元数据.收藏楼层"）— 玩家手动收藏的重要回合书签数组。
   *
   * 每项为 BookmarkedRound：{id, round, createdAt, name, userInput?, content, pending}。
   * `content` 是叙事正文快照（自包含，抗回滚/裁剪）。`pending=true` 者由
   * ContextAssemblyStage 组装为 `{{BOOKMARKED_ROUNDS_BLOCK}}` 注入下一回合，
   * PostProcessStage 在回合收尾统一复位为 false（一次性注入）。
   * 通过 `PROMPT_ALWAYS_STRIP_PATHS` 剥离，避免在 GAME_STATE_JSON 中重复。
   */
  bookmarkedRounds: string;

  /** Location field names (Story 4 — Engram batch solidify needs location name/description/connections) */
  locationFieldNames: EngineLocationFieldNames;

  /** NPC type value to exclude from Engram coverage (default: '普通') */
  npcTypeExclude: string;
}

/** Location object field name mappings — same pattern as EngineNpcFieldNames */
export interface EngineLocationFieldNames {
  name: string;
  description: string;
  connections: string;
  npcList: string[];
}

/**
 * 收藏楼层条目 — 玩家手动收藏的一个回合书签。
 *
 * 存储在状态树 `bookmarkedRounds` 路径下的数组元素。字段名是通用英文 key
 * （内容中立，符合引擎/内容分离），`content` 承载与游戏无关的叙事正文快照。
 * 引擎（ContextAssembly / PostProcess）与 UI（MainGamePanel / MemoryPanel）共用此形状。
 */
export interface BookmarkedRound {
  /** 稳定唯一 id，如 `bm_<round>_<createdAt>` */
  id: string;
  /** 收藏时的回合序号 */
  round: number;
  /** 收藏创建时间（epoch ms） */
  createdAt: number;
  /** 玩家命名（收藏时自动给默认名，可随时改） */
  name: string;
  /** AI 叙事正文快照（自包含，抗回滚/裁剪；捕获玩家当时屏幕上所见的版本） */
  content: string;
  /** 是否"待注入下一回合"。默认 false；选中即 true，注入消费后由 PostProcess 复位 false */
  pending: boolean;
}

/**
 * NPC 对象上各字段的 key 名称映射
 *
 * 值是 NPC 对象内的 key（**不是**从根起的完整 dot-path）。与 `relationships`
 * (`'社交.关系'`) 配合使用：引擎代码通过 `npc[paths.npcFieldNames.memory]` 访问
 * `npc.记忆`，不直接写 `npc['记忆']`。
 *
 * **命名约定**：
 * - camelCase 英文 key 在引擎侧暴露（通用、国际化中立）
 * - 默认值在 `DEFAULT_ENGINE_PATHS.npcFieldNames` 中给出（中文字段名，与天命 pack
 *   的 state-schema 对齐）
 * - 若未来 Game Pack 需要不同字段名，通过 pack manifest 的 `enginePaths.npcFieldNames`
 *   覆写（目前与其他路径一致：静态契约，`engine-paths.json` 暂未启用覆写）
 */
/**
 * 游戏时间对象的字段 key 映射。
 *
 * 默认值在 `DEFAULT_ENGINE_PATHS.gameTimeFieldNames` 中给出（中文字段名，与天命 pack
 * 的 state-schema `世界.时间` 对齐）。消费方：`formatGameTimeForWorldBook()`。
 */
export interface EngineGameTimeFieldNames {
  /** 年 key（默认 '年'） */
  year: string;
  /** 月 key（默认 '月'） */
  month: string;
  /** 日 key（默认 '日'） */
  day: string;
  /** 小时 key（默认 '小时'） */
  hour: string;
  /** 分钟 key（默认 '分钟'） */
  minute: string;
}

export interface EngineNpcFieldNames {
  /** NPC 名称字段 key（默认 '名称'） */
  name: string;
  /** NPC 类型字段 key（默认 '类型'；用于 RelationshipPanel 分类） */
  type: string;
  /** 性别 key（默认 '性别'；供 nsfwGenderFilter 匹配） */
  gender: string;
  /** 年龄 key（默认 '年龄'） */
  age: string;
  /** 当前所在位置 key（默认 '位置'） */
  location: string;
  /** 好感度数值 key（默认 '好感度'） */
  affinity: string;
  /** 一句话描述 key（默认 '描述'） */
  description: string;
  /**
   * 完整外貌描述 key（默认 '外貌描述'）
   *
   * 区别于 `description`（一句话身份/气质概述），`appearance` 是完整视觉描写段。
   * image tokenizer / anchor extractor 的主要视觉输入。`world heartbeat` 允许
   * 随长期剧情事件更新（衰老/伤疤/染发等）。
   */
  appearance: string;
  /**
   * 身材描写 key（默认 '身材描写'）
   *
   * 身高、体态、胸部/臀部/腰线、肌肉/脂肪分布等。与 `appearance` 分开存放，
   * 使 `generateCharacterImage` 不必从外貌字符串里解析身体维度。
   */
  bodyDescription: string;
  /**
   * 衣着风格 key（默认 '衣着风格'）
   *
   * NPC 日常衣着偏好（材质、色调、款式、常驻佩饰）。临时/场景穿着由
   * `currentActivity` 或叙事文本承担。
   */
  outfitStyle: string;
  /** 背景经历 key（默认 '背景'） */
  background: string;
  /** NPC 当前内心想法 key（默认 '内心想法'） */
  innerThought: string;
  /** NPC 正在做的事 key（默认 '在做事项'） */
  currentActivity: string;
  /** 性格特征标签数组 key（默认 '性格特征'） */
  personalityTraits: string;
  /**
   * 记忆条目数组 key（默认 '记忆'）
   *
   * 条目形态在 Sprint Social-1 起支持两种：
   * - 旧：`string`（存量存档）
   * - 新：`{ 内容: string, 时间?: string }`
   * schema 用 oneOf 允许并存；渲染/写入侧通过
   * `src/engine/social/npc-memory-format.ts` 的 `formatMemoryEntry` 处理。
   */
  memory: string;
  /**
   * per-NPC 总结记忆数组 key（默认 '总结记忆'）
   *
   * 当 memory 数组长度超过 `rules/npc-memory.json.threshold` 时由
   * 未来的 NpcMemorySummaryPipeline (Sprint Social-5) 生成批量摘要 push 入此数组。
   * Social-1 只建立 schema + path 契约，不启用总结逻辑。
   */
  memorySummaries: string;
  /**
   * NPC 私聊历史 key（默认 '私聊历史'）
   *
   * 由现有 NpcChatPipeline 维护；每项 `{ role, content, timestamp }`。
   * 独立于 `元数据.叙事历史`，只影响该 NPC 的私聊子管线。
   */
  privateChatHistory: string;
  /**
   * PrivacyProfile 子对象 key（默认 '私密信息'）
   *
   * 成人内容专属；`snapshot-sanitizer` 的 `NSFW_STRIP_PATHS`
   * 使用 `'社交.关系.*.私密信息'` 通配符路径在 nsfwMode=false 时从 prompt 剥离。
   */
  privacyProfile: string;
  /**
   * 是否在场 boolean key（默认 '是否在场'）
   *
   * Sprint Social-2 起由 `NpcPresenceService` 读写；AI 通过
   * `set 社交.关系[名称=X].是否在场 = true/false` 切换。Social-1 仅建立 schema
   * 字段，未启用行为。
   */
  isPresent: string;
  /**
   * 是否主要角色 boolean key（默认 '是否主要角色'）
   *
   * UI 可作为置顶/筛选依据；prompt 可据此给主要 NPC 更重的描写权重。
   */
  isMajorRole: string;
  /**
   * 关系状态文本 key（默认 '关系状态'）
   *
   * 玩家与 NPC 的关系标签（如 陌生/朋友/恋人/敌对）。具体标签值由 pack prompt
   * 约定，引擎不枚举。
   */
  relationshipStatus: string;
  /**
   * 核心性格特征单句 key（默认 '核心性格特征'）
   *
   * 用于关系演化时保持人格锚定；AI 在长对话中据此避免性格漂移。
   */
  corePersonality: string;
  /**
   * 好感度突破条件文本 key（默认 '好感度突破条件'）
   *
   * 下一阶段好感提升的触发条件。仅为 AI 内部参考字段，不直接驱动逻辑。
   */
  affinityBreakthrough: string;
  /**
   * 关系突破条件文本 key（默认 '关系突破条件'）
   *
   * 关系状态升级/转折的触发条件。与 affinityBreakthrough 类似，仅作 AI 参考。
   */
  relationshipBreakthrough: string;
  /**
   * 关系网变量数组 key（默认 '关系网变量'）
   *
   * NPC 与其他 NPC 之间的命名关系（who-what-who）。用于多角色叙事的
   * 一致性（例如某 NPC 是玩家目标角色的姐姐，会影响对玩家的态度）。
   */
  relationshipNetwork: string;
  /**
   * 最后互动时间文本 key（默认 '最后互动时间'）
   *
   * Sprint Social-2 起用作**离场刷新锚点** —— 离场 NPC 的 prompt 块
   * 显示 "最后一次互动：X 年前" 让 AI 做时序推演。
   */
  lastInteractionTime: string;
}

/**
 * 默认路径配置 — 与参考 Game Pack（天命 tianming）state schema 对齐
 *
 * 须与 `engine/stores/engine-state.ts` 中顶栏/侧栏展示用的 getter 保持同一套字段。
 * 曾不一致示例：playerName 用「身份.名字」而 UI 读「姓名」会导致 prompt 变量与界面不同步。
 */
export const DEFAULT_ENGINE_PATHS: EnginePathConfig = {
  roundNumber: '元数据.回合序号',
  narrativeHistory: '元数据.叙事历史',
  // 世界时间是 {年, 月, 日} 对象，路径统一为 '世界.时间'（原 '元数据.时间' 已从 schema 删除）
  gameTime: '世界.时间',
  playerName: '角色.基础信息.姓名',
  playerLocation: '角色.基础信息.当前位置',
  characterBaseInfo: '角色.基础信息',
  characterAttributes: '角色.属性',
  // 年龄在 基础信息 子对象内，修复了之前错误的顶层 '角色.年龄' 路径
  characterAge: '角色.基础信息.年龄',
  characterGender: '角色.基础信息.性别',
  characterOccupation: '角色.可变属性.地位.名称',
  characterDescription: '角色.可变属性.地位.描述',
  characterTraits: '角色.基础信息.特质',
  characterOrigin: '角色.身份.出身',
  characterTalentTier: '角色.身份.天赋档次',
  characterInnateStats: '角色.身份.先天六维',
  inventoryItems: '角色.背包.物品',
  inventoryCurrency: '角色.背包.金钱',
  heartbeatConfig: '世界.状态.心跳.配置',
  // heartbeatEnabled / heartbeatPeriod 是 heartbeatConfig 对象的叶子路径（用于 UI 独立读写）
  heartbeatEnabled: '世界.状态.心跳.配置.enabled',
  heartbeatPeriod: '世界.状态.心跳.配置.period',
  lastHeartbeatRound: '世界.状态.心跳.上次心跳回合序号',
  heartbeatHistory: '世界.状态.心跳.历史',
  heartbeatLastRun: '世界.状态.心跳.上次执行时间',
  worldEvents: '社交.事件.事件记录',
  relationships: '社交.关系',
  worldDescription: '世界.描述',
  weather: '世界.天气',
  festival: '世界.节日',
  environmentTags: '世界.环境',
  engramMemory: '系统.扩展.engramMemory',
  // tianming 的 NPC 存放在 '社交.关系'（core.md / opening.md / RelationshipPanel 均读写此路径）。
  // 旧值 'NPC列表' 是 schema 中的孤儿顶层字段，从未被 AI 或 UI 使用。
  // 世界心跳、NPC 生成子管线依赖此路径找到候选 NPC，使用 '社交.关系' 才能与 Game Pack 契约一致。
  npcList: '社交.关系',
  locations: '世界.地点信息',
  vitalHealth: '角色.可变属性.体力',
  vitalEnergy: '角色.可变属性.精力',
  statusEffects: '角色.效果',
  reputation: '角色.可变属性.声望',
  talents: '角色.身份.天赋',
  gameTimeHour: '世界.时间.小时',
  gameTimeMinute: '世界.时间.分钟',
  gameTimeFieldNames: {
    year: '年',
    month: '月',
    day: '日',
    hour: '小时',
    minute: '分钟',
  },
  preRoundSnapshot: '元数据.上次对话前快照',
  slotWorldBooks: '系统.扩展.slotWorldBooks',
  settingCaptureLast: '系统.扩展.settingCaptureLast',
  explorationRecord: '系统.探索记录',
  reasoningHistory: '元数据.推理历史',
  storyPlan: '元数据.剧情规划',
  plotDirection: '元数据.剧情导向',
  memoryMidTerm: '记忆.中期',
  memoryLongTerm: '记忆.长期',
  bookmarkedRounds: '元数据.收藏楼层',
  locationFieldNames: {
    name: '名称',
    description: '描述',
    connections: '连接',
    npcList: ['NPC', '常驻NPC'],
  },
  npcTypeExclude: '普通',
  npcFieldNames: {
    // 基础信息（现有字段；本 sprint 前引擎代码硬编码，本 sprint 起统一走此映射）
    name: '名称',
    type: '类型',
    gender: '性别',
    age: '年龄',
    location: '位置',
    affinity: '好感度',
    description: '描述',
    appearance: '外貌描述',
    bodyDescription: '身材描写',
    outfitStyle: '衣着风格',
    background: '背景',
    innerThought: '内心想法',
    currentActivity: '在做事项',
    personalityTraits: '性格特征',
    memory: '记忆',
    privateChatHistory: '私聊历史',
    privacyProfile: '私密信息',
    // Social-1 新增字段（schema 已落，行为由 Social-2+ 启用）
    memorySummaries: '总结记忆',
    isPresent: '是否在场',
    isMajorRole: '是否主要角色',
    relationshipStatus: '关系状态',
    corePersonality: '核心性格特征',
    affinityBreakthrough: '好感度突破条件',
    relationshipBreakthrough: '关系突破条件',
    relationshipNetwork: '关系网变量',
    lastInteractionTime: '最后互动时间',
  },
};

// ═══════════════════════════════════════════════════════════════
//  辅助类型
// ═══════════════════════════════════════════════════════════════

/**
 * 心跳配置结构 — 从状态树的 heartbeatConfig 路径读取
 *
 * 字段使用 enabled/period 作为引擎端的规范名称。
 * Game Pack 可使用任意命名，但存储时必须符合此结构。
 */
export interface HeartbeatConfig {
  /** 是否启用世界心跳 */
  enabled: boolean;
  /** 心跳触发周期（每 N 回合执行一次） */
  period: number;
}
