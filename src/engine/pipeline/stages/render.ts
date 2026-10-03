/**
 * 渲染阶段 — 管线的最后一个阶段，将处理结果推送给 UI 层
 *
 * 职责极其简单：提取叙事文本和行动选项，通过事件总线广播。
 * 这种设计是有意为之：
 *
 * 1. 管线不直接依赖 UI 框架（Vue/React/...），
 *    通过事件总线解耦使得引擎可以在无 UI 环境下运行（如测试、CLI）
 * 2. UI 组件订阅 'ui:round-rendered' 事件来更新视图，
 *    这是单向数据流：引擎 → 事件 → UI，UI 不回写引擎状态
 * 3. 渲染阶段不做数据转换（如 Markdown 渲染），
 *    那是 UI 组件的职责，引擎只传递原始文本
 *
 * 对应 STEP-03B M3.4 RenderStage。
 */
import type { PipelineStage, PipelineContext } from '../types';
import { eventBus } from '../../core/event-bus';

export class RenderStage implements PipelineStage {
  name = 'Render';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const narrativeText = ctx.parsedResponse?.text ?? '';
    // Off (the player's switch, PO 2026-10-03): no options on screen, whatever the model wrote; PostProcess keeps
    // none in the save either.
    const actionOptions = ctx.meta.actionOptionsEnabled === false ? [] : (ctx.parsedResponse?.actionOptions ?? []);

    // 广播渲染事件 — UI 层（如 MainGamePanel.vue）监听此事件更新视图
    // 载荷包含 roundNumber 和 judgement 是因为 UI 可能需要：
    // - 按回合号标记消息（如 "#42 轮"）
    // - 显示判定结果动画（如骰子滚动效果）
    eventBus.emit('ui:round-rendered', {
      narrativeText,
      actionOptions,
      roundNumber: ctx.roundNumber,
      judgement: ctx.parsedResponse?.judgement,
    });

    return { ...ctx, narrativeText, actionOptions };
  }
}
