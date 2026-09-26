/**
 * 指令执行阶段 — 将 AI 返回的结构化指令应用到状态树
 *
 * AI 通过 commands 数组（set/add/delete/push/pull）修改游戏状态。
 * 本阶段将这些指令委托给 CommandExecutor 执行，然后触发行为模块的
 * afterCommands 钩子以响应状态变更。
 *
 * 执行顺序的重要性：
 * 1. 先执行指令（状态树变更）
 * 2. 再触发行为模块（基于变更做二次处理）
 * 这确保行为模块看到的是指令执行后的状态，而非执行前的状态。
 *
 * 例如 CrossRefSync 需要在 NPC 位置变更后同步地点的 NPC 列表，
 * ThresholdTriggers 需要在数值变更后检查是否突破阈值。
 * 这些都依赖于先看到指令执行的结果。
 *
 * §11.2 B: 在行为模块钩子之后，扫描 NPC/玩家身体的 `私密信息` / `角色.身体`
 * 完整性（仅当 nsfwMode=true），把缺失条目写入 `ctx.meta.pendingPrivacyRepair`
 * 供 GameOrchestrator 在 runPostRoundSubPipelines 中消费并触发修复子管线。
 *
 * 对应 STEP-03B M3.4 CommandExecutionStage + GAP_AUDIT §11.2。
 */
import type { PipelineStage, PipelineContext, IBehaviorRunner, EnginePathConfig } from '../types';
import type { CommandExecutor } from '../../core/command-executor';
import type { StateManager } from '../../core/state-manager';
import { findIncompletePrivacy, readNsfwSettings } from '../../validators/privacy-profile-validator';
import { eventBus } from '../../core/event-bus';

export class CommandExecutionStage implements PipelineStage {
  name = 'CommandExecution';

  constructor(
    private commandExecutor: CommandExecutor,
    private behaviorRunner: IBehaviorRunner,
    private stateManager: StateManager,
    /** §11.2 B: 私密信息校验需要引擎路径（relationships / 角色.身体 等） */
    private paths: EnginePathConfig,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // 无指令时跳过 — AI 纯叙事回复（无状态变更）是正常情况
    if (!ctx.parsedResponse?.commands?.length) {
      return ctx;
    }

    // ── 1. 批量执行指令 ──
    // CommandExecutor.executeBatch 按顺序执行每条指令，
    // 即使某条失败也会继续执行剩余指令（fail-soft 策略）。
    // 返回值包含每条指令的成功/失败状态和完整的变更日志。
    const commandResults = this.commandExecutor.executeBatch(
      ctx.parsedResponse.commands,
    );

    // ── 2. 行为模块 afterCommands 钩子 ──
    // 传入变更日志（而非指令列表），让行为模块关注"发生了什么变化"
    // 而非"AI 下达了什么指令"。这使得行为模块与指令格式解耦。
    //
    // 在此钩子中运行的模块：
    // - CrossRefSync:     NPC 位置 ↔ 地点 NPC 列表双向同步
    // - ThresholdTriggers: 数值突破阈值时发送事件或执行动作
    // - NpcBehavior:      玩家位置变更时决定 NPC 跟随/留守
    this.behaviorRunner.runAfterCommands(
      this.stateManager,
      commandResults.changeLog,
    );

    // ── 3. §11.2 B: 私密信息完整性扫描 ──
    // 仅在 nsfwMode=true 时扫描；不完整的条目会触发下一阶段（runPostRoundSubPipelines）
    // 中的 PrivacyProfileRepairPipeline。
    //
    // 扫描整个 NPC 列表而非仅 changeLog 中变更的 NPC，原因：
    // 1. 用户首次开启 nsfwMode 后，既存 NPC 也需要被补齐（批量一次修复）
    // 2. AI 可能 set 已存在 NPC 的其他字段但遗漏 私密信息，此时 changeLog 里
    //    的条目是字段级的（如 `社交.关系[名称=X].好感度`），而非整个 NPC 对象
    // 3. 扫描成本较低（只是字段存在性检查，不涉及 AI 调用）
    this.runPrivacyValidation(ctx);

    return { ...ctx, commandResults };
  }

  /**
   * §11.2 B: 私密信息校验 — 软警告 + 写 pending flag
   *
   * 使用 ctx.meta.pendingPrivacyRepair 传递给 GameOrchestrator 的
   * runPostRoundSubPipelines()，避免直接耦合到下游管线调度。
   */
  private runPrivacyValidation(ctx: PipelineContext): void {
    const { nsfwMode, nsfwGenderFilter } = readNsfwSettings(this.stateManager);
    if (!nsfwMode) return;

    const report = findIncompletePrivacy(this.stateManager, this.paths, nsfwGenderFilter);
    if (report.total === 0) return;

    // 软警告：console.warn + UI toast（不阻塞游戏）
    console.warn(
      `[PrivacyValidator] ${report.total} entit(ies) missing 私密信息:`,
      { npcs: report.npcNames, playerBody: report.playerBodyMissing },
    );
    eventBus.emit('ui:toast', {
      type: 'warning',
      i18nKey: 'engine.toast.missingFieldsDetected',
      i18nParams: { count: report.total },
      message: `检测到 ${report.total} 项缺失的扩展字段，将自动补齐`,
      duration: 2500,
    });

    // 写 pending flag，传给下游子管线调度
    ctx.meta['pendingPrivacyRepair'] = report;
  }
}
