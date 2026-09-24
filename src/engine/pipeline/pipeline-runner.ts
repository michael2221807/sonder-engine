/**
 * 管线运行器 — 按顺序执行注册的 Stage 并管理生命周期事件
 *
 * 运行器是管线的"调度中枢"，职责包括：
 * 1. 顺序执行 stages（PreProcess → ContextAssembly → AICall → ...）
 * 2. 在每个阶段前检查取消信号（用户点击"停止生成"）
 * 3. 在每个阶段前发送进度通知（UI 可显示当前阶段名称）
 * 4. 捕获阶段错误并通过事件总线广播（便于全局错误处理）
 * 5. 在回合开始/结束时发送生命周期事件
 *
 * 设计选择 — 为什么不用中间件模式（koa-style）：
 * 游戏回合的阶段是严格顺序的，不需要洋葱模型的 before/after 能力。
 * 线性管线更易理解和调试，行为模块通过 BehaviorRunner 的钩子
 * 实现了等效的"横切关注点"能力。
 *
 * 对应 STEP-03B M3.3。
 */
import type { PipelineStage, PipelineContext } from './types';
import { eventBus } from '../core/event-bus';

export class PipelineRunner {
  private stages: PipelineStage[] = [];

  /** 注册一个管线阶段（按调用顺序决定执行顺序） */
  addStage(stage: PipelineStage): void {
    this.stages.push(stage);
  }

  /**
   * 执行整个管线
   *
   * 采用不可变上下文传递：每个 stage.execute() 返回新的 context 对象，
   * Runner 用返回值替换 ctx 引用。这确保了：
   * - 各阶段不会意外修改前序阶段的数据
   * - 调试时可以在断点处检查每个阶段的输入/输出
   *
   * @param initialContext 初始上下文（由调用方构建，包含 userInput 等）
   * @returns 完成所有阶段后的最终上下文
   * @throws 当 abortSignal 被触发或某阶段抛出异常时
   */
  async run(initialContext: PipelineContext): Promise<PipelineContext> {
    if (this.stages.length === 0) {
      throw new Error('No pipeline stages registered. Call addStage() before run().');
    }

    let ctx = { ...initialContext };

    eventBus.emit('engine:round-start', { roundNumber: ctx.roundNumber });

    for (const stage of this.stages) {
      ctx.meta.roundOwnership?.guard();
      ctx.meta.plotVectorGuard?.();
      // 在启动每个阶段前检查取消信号，
      // 避免在用户已取消后继续执行耗时操作（特别是 AICallStage）
      if (ctx.abortSignal?.aborted && !ctx.meta.roundOwnership?.saved && !ctx.meta.plotVectorLifecycle?.saved) {
        throw new Error('Pipeline aborted');
      }

      ctx.onProgress?.({ i18nKey: 'engine.progress.stage', i18nParams: { name: stage.name }, message: `[${stage.name}]` });

      try {
        ctx = await stage.execute(ctx);
      } catch (err) {
        console.error(`[Pipeline] Stage "${stage.name}" failed:`, err);
        // 广播错误事件，UI 层可据此显示错误提示
        // 同时携带阶段名，便于定位是哪个环节出了问题
        eventBus.emit('engine:round-error', { stage: stage.name, error: err });
        throw err;
      }
    }

    eventBus.emit('engine:round-complete', {
      roundNumber: ctx.roundNumber,
      actionOptions: ctx.actionOptions ?? [],
    });
    return ctx;
  }
}
