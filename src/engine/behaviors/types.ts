/**
 * 行为模块接口定义
 *
 * 每个行为模块实现此接口的可选生命周期钩子，
 * 由 BehaviorRunner 在引擎流水线的对应阶段统一调度。
 *
 * 设计原则：
 * - 模块之间互不依赖 — BehaviorRunner 保证调用顺序但不强制耦合
 * - 单个模块失败不阻塞其他模块 — BehaviorRunner 做 try/catch 隔离
 * - 钩子为可选实现 — 模块只实现自己关心的生命周期阶段
 *
 * 对应 STEP-02 §3.10 Engine Built-in Behavior Modules。
 */
import type { StateManager } from '../core/state-manager';
import type { ChangeLog } from '../types';

export interface BehaviorModule {
  /** 模块唯一标识 — 用于日志和调试 */
  id: string;

  /**
   * AI 指令执行完成后触发
   * 适用于需要在状态变更后做后处理的模块
   * （如 time-service 根据 AI 设置的时间做进位归一化）
   */
  afterCommands?(stateManager: StateManager, changeLog: ChangeLog): void;

  /**
   * 回合结束时触发（AI 响应完全处理完毕后）
   * 适用于需要在每轮末尾做汇总/清理的模块
   * （如 effect-lifecycle 清理过期 buff、computed-fields 重新计算）
   */
  onRoundEnd?(stateManager: StateManager): void;

  /**
   * 游戏加载（读档）时触发
   * 适用于需要在加载后做一次性初始化/修复的模块
   * （如 validation-repair 检查存档完整性）
   */
  onGameLoad?(stateManager: StateManager): void;

  /**
   * 创角完成时触发（仅在创建新角色时调用一次）
   * 适用于需要初始化衍生数据的模块
   * （如 computed-fields 计算初始派生值）
   */
  onCreation?(stateManager: StateManager): void;

  /**
   * Prompt 上下文组装阶段触发
   * 模块可向 variables 字典写入模板变量，供 PromptAssembler 使用
   * （如 memory-compiler 将记忆数据编译为 prompt 文本）
   */
  onContextAssembly?(stateManager: StateManager, variables: Record<string, string>): void;
}
