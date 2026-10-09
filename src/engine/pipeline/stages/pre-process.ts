/**
 * 预处理阶段 — 管线的第一个阶段
 *
 * 职责：
 * 1. 消费动作队列（面板操作如装备、使用物品等）
 * 2. 将队列中的操作格式化为文本并 prepend 到用户输入
 * 3. 递增状态树中的回合序号
 *
 * 为什么动作队列在这里消费而非在 ContextAssembly：
 * 动作队列影响的是"用户输入"的内容，而非 prompt 模板变量。
 * 在最早的阶段处理可以保证后续所有阶段看到的 userInput 已包含面板操作。
 * 如果放到 ContextAssembly，那 userInput 和 actionQueuePrompt 的时序关系
 * 就会变得模糊，增加调试难度。
 *
 * 为什么格式化在这里做而非在 ActionQueueStore：
 * consumeActions() 返回结构化的 QueuedAction[]（M1 review fix），
 * 格式化逻辑属于"如何呈现给 AI"的决策，应由管线阶段控制。
 * Store 只负责排队/消费的数据管理。
 *
 * 对应 STEP-03B M3.4 PreProcessStage。
 */
import type { PipelineStage, PipelineContext, IActionQueueConsumer, EnginePathConfig } from '../types';
import type { StateManager } from '../../core/state-manager';
import type { RollbackSnapshot } from '../../core/rollback-snapshot';
import type { QueuedAction } from '../../types';

export class PreProcessStage implements PipelineStage {
  name = 'PreProcess';

  constructor(
    private stateManager: StateManager,
    private actionQueue: IActionQueueConsumer,
    private paths: EnginePathConfig,
    private rollbackSnapshot: RollbackSnapshot,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // Before any change (the round number included), take the whole tree as it is at round start, for Rollback.
    //
    // 存档瘦身 D1A: the snapshot goes to the in-memory holder only — no longer into the state tree (41% of a large
    // save, and three more whole-tree copies every round). The tree keeps a small marker naming it; every save turns
    // the marker into the patch back to the snapshot (rollback-snapshot.ts). The holder leaves the rollback data out
    // of the snapshot, so it never nests (Changelog: 2026-04-11 递归嵌套快照). The marker is in the tree before the AI
    // call: a round that fails before PostProcess can still be rolled back.
    const marker = this.rollbackSnapshot.capture(this.stateManager.toSnapshot());
    const preRoundSnapshot = this.rollbackSnapshot.get(marker);
    // A tree still holding the old whole snapshot (its format upgrade failed on load) lets go of it now.
    if (this.stateManager.has(this.paths.preRoundSnapshot)) this.stateManager.delete(this.paths.preRoundSnapshot, 'system');
    this.stateManager.set(this.paths.rollbackPatch, marker, 'system');

    const consumed = this.actionQueue.consumeActions();
    const actionQueuePrompt = this.formatActions(consumed);

    const userInput = actionQueuePrompt
      ? `${actionQueuePrompt}\n\n${ctx.userInput}`
      : ctx.userInput;

    const roundNumber = (this.stateManager.get<number>(this.paths.roundNumber) ?? 0) + 1;
    this.stateManager.set(this.paths.roundNumber, roundNumber, 'system');

    return { ...ctx, userInput, actionQueuePrompt, roundNumber, preRoundSnapshot };
  }

  /**
   * 将 QueuedAction[] 格式化为 AI 可读的文本
   *
   * 格式：[操作类型] 操作描述
   * 例如：
   *   [装备] 玩家装备了「破旧铁剑」
   *   [使用] 玩家使用了「小型回复药水」
   *
   * 使用 [type] 前缀让 AI 能区分操作类型，
   * 便于在 prompt 中用不同策略处理（如装备操作不消耗回合时间）
   */
  private formatActions(actions: QueuedAction[]): string {
    if (actions.length === 0) return '';
    return actions.map((a) => `[${a.type}] ${a.description}`).join('\n');
  }
}
