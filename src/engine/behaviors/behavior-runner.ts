/**
 * 行为运行器 — 管理所有 BehaviorModule 的注册和生命周期钩子分发
 *
 * 核心职责：
 * 1. 维护已注册模块的有序列表
 * 2. 在引擎流水线的各阶段按注册顺序调用对应钩子
 * 3. 每个钩子调用都做 try/catch 隔离 — 一个模块出错不影响其他模块
 *
 * 设计考量：
 * - 模块注册顺序即执行顺序（如 time-service 应在 effect-lifecycle 前注册，
 *   因为 effect-lifecycle 的过期判断依赖归一化后的时间）
 * - 所有 dispatch 方法都是同步的 — 行为模块不做 IO 操作
 * - 错误只记录日志，不抛出 — 避免一个 bug 导致整个流水线崩溃
 *
 * 对应 STEP-02 §3.10、STEP-03B M3。
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { ChangeLog } from '../types';

export class BehaviorRunner {
  /** 按注册顺序排列的模块列表 */
  private modules: BehaviorModule[] = [];

  /** 注册一个行为模块（追加到末尾，调用顺序 = 注册顺序） */
  register(module: BehaviorModule): void {
    if (this.modules.some((m) => m.id === module.id)) {
      console.warn(`[BehaviorRunner] Module "${module.id}" already registered, skipping duplicate`);
      return;
    }
    this.modules.push(module);
  }

  /** 移除指定 ID 的模块 */
  unregister(moduleId: string): void {
    this.modules = this.modules.filter((m) => m.id !== moduleId);
  }

  /** 获取已注册的模块列表（只读） */
  getModules(): readonly BehaviorModule[] {
    return this.modules;
  }

  // ─── 钩子分发 — 每个方法对应一个生命周期阶段 ───

  /** AI 指令执行完成后 — 分发 afterCommands 钩子 */
  runAfterCommands(stateManager: StateManager, changeLog: ChangeLog): void {
    this.dispatch('afterCommands', (mod) => mod.afterCommands?.(stateManager, changeLog));
  }

  /** 回合结束 — 分发 onRoundEnd 钩子 */
  runOnRoundEnd(stateManager: StateManager): void {
    this.dispatch('onRoundEnd', (mod) => mod.onRoundEnd?.(stateManager));
  }

  /** 游戏加载 — 分发 onGameLoad 钩子 */
  runOnGameLoad(stateManager: StateManager): void {
    this.dispatch('onGameLoad', (mod) => mod.onGameLoad?.(stateManager));
  }

  /** 创角完成 — 分发 onCreation 钩子 */
  runOnCreation(stateManager: StateManager): void {
    this.dispatch('onCreation', (mod) => mod.onCreation?.(stateManager));
  }

  /** 上下文组装 — 分发 onContextAssembly 钩子 */
  runOnContextAssembly(stateManager: StateManager, variables: Record<string, string>): void {
    this.dispatch('onContextAssembly', (mod) => mod.onContextAssembly?.(stateManager, variables));
  }

  /** 清空所有模块 — 切换 Game Pack 或重置引擎时调用 */
  clear(): void {
    this.modules = [];
  }

  // ─── 内部 ───

  /**
   * 通用分发逻辑 — 遍历模块并调用回调，每个模块独立 try/catch
   *
   * 这样设计可以确保即使某个第三方/自定义行为模块有 bug，
   * 也不会导致后续模块被跳过或整个游戏循环崩溃。
   */
  private dispatch(hookName: string, invoke: (mod: BehaviorModule) => void): void {
    for (const mod of this.modules) {
      try {
        invoke(mod);
      } catch (err) {
        console.error(
          `[BehaviorRunner] ${hookName} error in "${mod.id}":`,
          err,
        );
      }
    }
  }
}
