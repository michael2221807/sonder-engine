// App doc: docs/user-guide/pages/game-main.md §3.5（指标药丸 · 分步两次调用合计计量）
/**
 * 后处理阶段 — 管线的倒数第二个阶段，处理记忆、行为钩子和持久化
 *
 * 这是管线中副作用最密集的阶段，集中处理"AI 回复之后"需要做的所有事情。
 * 之所以集中而非拆分为多个小阶段：
 * - 记忆写入、行为钩子、自动存档之间有时序依赖
 * - 拆分会增加上下文传递的复杂度，且单独测试的收益不高
 * - 通过方法拆分（而非阶段拆分）保持内部可读性
 *
 * 执行顺序的设计考量：
 * 1. 先写入记忆（短期 → 隐式中期 → 语义）
 * 2. 再处理 Engram（依赖上一步的记忆数据）
 * 3. 再检查总结阈值（在记忆写入后才能准确判断）
 * 4. 再运行行为钩子（TimeService 等在记忆和指令都处理完后执行）
 * 5. 再检查心跳（依赖行为钩子更新的时间数据）
 * 6. 最后追加叙事历史和自动存档（确保所有状态变更都已完成）
 *
 * 对应 STEP-03B M3.4 PostProcessStage。
 */
import type {
  PipelineStage,
  PipelineContext,
  IBehaviorRunner,
  IMemoryManager,
  IEngramManager,
  HeartbeatConfig,
  EnginePathConfig,
  BookmarkedRound,
} from '../types';
import type { StateManager } from '../../core/state-manager';
import type { CanonMutationInput } from '../../memory/engram/canon-projection';
import type { SaveManager } from '../../persistence/save-manager';
import { eventBus } from '../../core/event-bus';
import { deduplicateLocations } from '../../behaviors/location-dedup';
import { estimateMessagesTokens, estimateTextTokens } from '../../core/metrics-helpers';
import { extractPlotEvaluations } from '../../plot/types';

/**
 * Pull this round's accepted captures out of `ctx.meta` in the shape the graph needs.
 *
 * Reads defensively: `SettingCaptureStage` is fail-soft and may have written a partial
 * result, and a shape surprise here must not sink an otherwise complete round.
 */
export function collectCanonMutations(ctx: PipelineContext): CanonMutationInput[] {
  const result = ctx.meta?.['settingCapture'] as
    | { accepted?: Array<{ entryId?: unknown; candidate?: { kind?: unknown; statement?: unknown; entities?: unknown } }> }
    | undefined;
  const accepted = result?.accepted;
  if (!Array.isArray(accepted) || accepted.length === 0) return [];

  const out: CanonMutationInput[] = [];
  for (const item of accepted) {
    const entryId = typeof item?.entryId === 'string' ? item.entryId : '';
    const kind = typeof item?.candidate?.kind === 'string' ? item.candidate.kind : '';
    const statement = typeof item?.candidate?.statement === 'string' ? item.candidate.statement : '';
    const entities = Array.isArray(item?.candidate?.entities)
      ? item.candidate.entities.filter((e): e is string => typeof e === 'string')
      : [];
    if (!entryId || !kind || !statement) continue;
    out.push({ entryId, kind, statement, entities, op: 'add' });
  }
  return out;
}

export class PostProcessStage implements PipelineStage {
  name = 'PostProcess';

  // 2026-04-11 CR C-02 修复：移除叙事历史 FIFO cap。
  //
  // 旧版本有 MAX_NARRATIVE_HISTORY = 200，长游戏（>100 回合）会永久丢失最早的叙事原文，
  // 与小说导出需求直接冲突。用户 2026-04-11 决策：MVP 阶段不做 cap，回合数一般不会高到
  // 需要 FIFO。ContextAssembly 仍会把全量 narrativeHistory 注入 chatHistory，但：
  //   - 当前 MVP 回合数有限，token 可控
  //   - 未来若真需要 prompt 层截断，应该在 ContextAssembly 里做"只发送最近 N 条给 AI"，
  //     而 narrativeHistory 本身保持 append-only 以支持小说导出
  //
  // 详见 docs/status/cr-memory-refactor-2026-04-11.md §C-02 + design doc memory-system.md §8。

  constructor(
    private stateManager: StateManager,
    private memoryManager: IMemoryManager,
    private engramManager: IEngramManager,
    private behaviorRunner: IBehaviorRunner,
    private saveManager: SaveManager,
    private paths: EnginePathConfig,
    /**
     * 由 Orchestrator 注入 — 返回当前活跃的 profileId/slotId，
     * 避免在引擎类中调用 useEngineStateStore()（Pinia 上下文违反）。
     */
    private getActiveSlot: () => { profileId: string; slotId: string } | null,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // 无 AI 响应时跳过（理论上不应发生，但 defensive coding）
    if (!ctx.parsedResponse) return ctx;

    // ── 1 + 2. 同步追加短期 + 隐式中期（1:1 配对不变量，CR C-01） ──
    //
    // 不变量：短期和隐式中期数组必须等长，且同一位置的两条来自同一回合。
    //
    // 双重防御：
    // - 策略 C：mainRound.md 要求 AI 每回合都必须输出 mid_term_memory（不允许 null）
    // - 策略 A：若 AI 违反约束（null / 空 / 解析失败），引擎插入 `_占位: true` 占位条目
    //   占位条目会被 MemoryRetriever / MidTermRefine / MemorySummary 过滤，不污染
    //   AI 上下文，但在结构上保证 `shiftAndPromoteOldest` 升级时不会错配回合
    if (ctx.parsedResponse.text) {
      this.memoryManager.appendShortTerm(ctx.parsedResponse.text, ctx.roundNumber);

      const midEntry = ctx.parsedResponse.midTermMemory;
      if (midEntry) {
        this.memoryManager.appendImplicitMidTerm(midEntry);
      } else {
        console.warn(
          `[PostProcess] AI 未输出本回合 mid_term_memory (round ${ctx.roundNumber})，` +
          `插入占位条目以维持 1:1 配对不变量`,
        );
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.missingMidTermMemory',
          i18nParams: { round: ctx.roundNumber },
          message: `AI 未按要求输出本回合中期记忆 (round ${ctx.roundNumber})，已插入占位`,
          duration: 3500,
        });
        this.memoryManager.appendImplicitMidTerm({
          相关角色: [],
          事件时间: '',
          记忆主体: `[占位 · round ${ctx.roundNumber}] AI 未输出本回合隐式中期`,
          _占位: true,
        });
      }
    }

    // ── 3. 检查 knowledge_facts 输出 ──
    if (this.engramManager.isEnabled() && !ctx.parsedResponse.knowledgeFacts) {
      console.warn(
        `[PostProcess] AI 未输出 knowledge_facts (round ${ctx.roundNumber})`,
      );
    }

    // ── 4. 更新 Engram（事件提取 → 实体构建 → 事实边构建 → 向量化） ──
    if (this.engramManager.isEnabled()) {
      // Canon Capture rides along in the SAME write. A separate `processResponse()` for
      // captured settings would rebuild every Event and Entity and re-run the round's
      // embedding just to add one relationship edge.
      const canonMutations = collectCanonMutations(ctx);

      const engramWriteSnapshot = await this.engramManager.processResponse(
        ctx.parsedResponse,
        this.stateManager,
        ctx.meta?.isEnhancedOpening
          ? { defaultEdgeCore: true, defaultEdgeSource: 'opening', canonMutations }
          : (canonMutations.length > 0 ? { canonMutations } : undefined),
      );
      if (engramWriteSnapshot) {
        ctx.meta['engramWrite'] = engramWriteSnapshot;
      }
    }

    // V2: pendingReviewPairs written directly from FactBuilder inside processResponse

    // ── 5. 短期记忆溢出 → 同步 shift + 升级隐式中期为正式中期 ──
    //
    // 2026-04-11 重构（参照 demo + design note）：
    //
    // 旧版本：短期满 → 设 `pendingSummary` → orchestrator 调 `MemorySummaryPipeline`
    // 做 AI 总结产出中期记忆。这带来不必要的 AI 调用开销，且短期 vs 隐式中期
    // 没有配对关系，数据质量依赖 AI 二次总结。
    //
    // 新版本：短期和隐式中期 **1:1 配对**（每轮 AI 都输出 `mid_term_memory`
    // 作为结构化总结，应用时和短期纯叙事同时 push）。短期溢出时：
    //   - Shift 最旧短期（丢弃）
    //   - Shift 最旧隐式中期 → **升级为正式中期记忆**（shape 相同，直接 move）
    //   - 无 AI 调用，无 token 开销
    //
    // 中期记忆在 `game-orchestrator` 检查阈值后按需触发 AI pipeline：
    //   - mid >= 50 → `MemorySummaryPipeline` (worldview evolution → 长期记忆)
    //   - mid >= 25 → `MidTermRefinePipeline` (in-place 精炼，标 `已精炼`)
    //   - 二选一，if-else 优先长期汇总
    //
    // 详见 `memory-manager.ts` 顶部 JSDoc 的"四层设计"。
    const promoted = this.memoryManager.shiftAndPromoteOldest();
    if (promoted > 0) {
      console.log(`[PostProcess] Promoted ${promoted} implicit mid-term entries to mid-term`);
    }

    // ── 6. 行为模块 onRoundEnd 钩子 ──
    // 在此钩子中运行的模块：
    // - TimeService:       递增游戏内时间、处理进位
    // - EffectLifecycle:   清理过期的 buff/debuff
    // - ComputedFields:    重新计算派生字段（如体力百分比）
    this.behaviorRunner.runOnRoundEnd(this.stateManager);

    // ── 7. 检查世界心跳触发 ──
    // 心跳是周期性的 NPC 行为更新（每 N 回合执行一次）
    // 触发条件：启用 + 距上次心跳已过 N 回合
    if (this.shouldRunHeartbeat(ctx)) {
      ctx.meta['pendingHeartbeat'] = true;
    }

    // ── 7.5. Plot evaluation flag (Sprint Plot-1 P3, GAP-01 fix) ──
    // Always run the pipeline when an active arc exists, even if AI omits plot_evaluation.
    // This ensures autoDecrement ticks, maxRounds timeouts fire, and consecutiveReachedCount
    // resets correctly on rounds without AI evaluation.
    // Plot Threads: "active" is derived from arc status (several threads may be
    // active), and the pipeline must also run when every thread is merely
    // `scheduled` — otherwise a `round_reached` trigger could never fire.
    {
      const plotState = this.stateManager.get<{ arcs?: Array<{ status?: string }> }>(this.paths.plotDirection);
      const needsPipeline = Array.isArray(plotState?.arcs)
        && plotState.arcs.some(a => a?.status === 'active' || a?.status === 'scheduled');

      if (needsPipeline) {
        // Write every per-thread verdict (array) if the AI provided any; otherwise the pipeline reads an empty list
        try {
          if (ctx.parsedResponse?.customFields) {
            const plotEvals = extractPlotEvaluations(ctx.parsedResponse.customFields);
            if (plotEvals.length > 0) {
              this.stateManager.set(
                this.paths.plotDirection + '._lastEvaluation',
                plotEvals,
                'system',
              );
            }
          }
        } catch (err) {
          console.warn('[PostProcess] Failed to extract plot_evaluation:', err);
        }
        ctx.meta['pendingPlotEval'] = true;
      }
    }

    // preRoundSnapshot 已在 PreProcessStage 立即持久化（不再延迟到此处）

    // ── 9. 探索记录自动追踪 ──
    // 每回合结束后检查玩家当前位置是否已在探索记录中。
    // 如未记录则自动追加，无需 AI 命令介入。
    // 这样 MapPanel 的探索状态样式无需依赖 prompt 工程，引擎层保证数据完整性。
    // 注意：stateManager.push() 在目标路径不存在时会自动创建数组。
    this.trackExploration();

    // ── 9.2. NPC 在场状态自动同步 ──
    // 根据 NPC 的「位置」字段与玩家当前位置做前缀匹配，
    // 自动设置「是否在场」。兜底逻辑——即使 AI 忘记发 set 命令也能保持一致。
    this.syncPresence();

    // ── 9.5. 地点去重合并 ──
    // AI 可能生成结构性重复地点（"S市" 和 "中国·S市" 是同一地方的不同路径表达）。
    // 每回合检测并合并，防止地图出现重复树。
    const deduped = deduplicateLocations(
      this.stateManager,
      this.paths.locations,
      this.paths.explorationRecord,
      this.paths.playerLocation,
    );
    if (deduped > 0) {
      console.log(`[PostProcess] Deduplicated ${deduped} location entries`);
    }

    // ── 9.6. 清理旧 schema 残留字段 ──
    // NPC列表 已从 state-schema.json 移除（NPC 数据在 社交.关系），
    // 但旧存档可能仍有空的 NPC列表 数组残留。每回合清理一次。
    const staleNpcList = this.stateManager.get<unknown>('NPC列表');
    if (Array.isArray(staleNpcList) && staleNpcList.length === 0) {
      this.stateManager.delete('NPC列表');
    }

    // ── 10. 追加叙事历史 ──
    // 将用户输入和 AI 回复作为消息对追加到状态树的叙事历史。
    // assistant 条目附加 _delta（本回合的状态变更列表）供 Delta Viewer 展示，
    // _delta 字段以下划线前缀区分，AI 上下文组装阶段只读取 role/content，不受影响。
    //
    // S-06 known: _delta 随叙事存储，小说导出时需要过滤掉。
    // 当前暂不分离存储（Delta Viewer 依赖就近查找），导出功能实现时在导出接口做 strip。
    // ── 10.0. 持久化行动选项 ──
    // 将当前回合的行动选项写入状态树，这样刷新/退出后重新加载时 UI 能恢复。
    // 每回合覆写（不是 push），因为只需要保留最新回合的选项。
    const actionOpts = ctx.parsedResponse?.actionOptions;
    if (Array.isArray(actionOpts) && actionOpts.length > 0) {
      this.stateManager.set('元数据.当前行动选项', actionOpts, 'system');
    } else {
      this.stateManager.set('元数据.当前行动选项', [], 'system');
    }

    // Enhanced opening has no user input — skip the fake user entry (I1)
    if (!ctx.meta?.isEnhancedOpening) {
      this.stateManager.push(
        this.paths.narrativeHistory,
        { role: 'user', content: ctx.userInput },
        'system',
      );
    }

    const deltaChanges = ctx.commandResults?.changeLog?.changes ?? [];
    const assistantEntry: Record<string, unknown> = {
      role: 'assistant',
      content: ctx.parsedResponse.text,
    };
    if (deltaChanges.length > 0) {
      // Tag main-round commands so post-turn sub-pipelines (field repair,
      // world heartbeat, etc.) can append their own changes under different
      // source tags while sharing the same `_delta` array.
      assistantEntry._delta = deltaChanges.map((c) => ({ ...c, source: 'main' }));
    }

    // ── Phase 1 (2026-04-19): per-turn metadata capture ──
    //
    // All underscore-prefixed fields are UI-private — they do NOT reach the AI.
    // Two layers of defense:
    //   1. context-assembly.ts:wrap() only reads role/content when building chatHistory
    //   2. snapshot-sanitizer.ts strips 元数据.叙事历史 from GAME_STATE_JSON entirely
    // See docs/research/mrjh-migration/06-round-divider-plan.md §1.1 for file:line refs.
    // `inputTokens` / `outputTokens` keep their historical meaning (the step1 / narrative
    // call) so older saves and tooling stay comparable. The split-gen second call is metered
    // in the step2* / total* fields (R1 prompt ledger P0, 2026-09-03: step2 was ~1.6× step1
    // on real saves and had never been recorded). `breakdown` says which context piece cost
    // what — the raw material for Context-Compiler budgeting.
    const pm = ctx.promptMetrics;
    const step1Input = pm?.step1.inputTokens ?? estimateMessagesTokens(ctx.messages);
    const step1Output = pm?.step1.outputTokens ?? estimateTextTokens(ctx.rawResponse ?? '');
    assistantEntry._metrics = {
      roundNumber: ctx.roundNumber,
      durationMs: ctx.aiCallDurationMs ?? 0,
      inputTokens: step1Input,
      outputTokens: step1Output,
      startedAt: ctx.aiCallStartedAt ?? 0,
      ...(pm?.step2
        ? {
            step2InputTokens: pm.step2.inputTokens,
            step2OutputTokens: pm.step2.outputTokens,
            totalInputTokens: step1Input + pm.step2.inputTokens,
            totalOutputTokens: step1Output + pm.step2.outputTokens,
          }
        : {}),
      ...(pm
        ? { breakdown: { step1: pm.step1.breakdown, ...(pm.step2 ? { step2: pm.step2.breakdown } : {}) } }
        : {}),
    };
    if (ctx.parsedResponse.thinking) {
      assistantEntry._thinking = ctx.parsedResponse.thinking;
    }
    if (ctx.rawResponse) {
      assistantEntry._rawResponse = ctx.rawResponse;
    }
    const step2Raw = ctx.meta['rawResponseStep2'];
    if (typeof step2Raw === 'string' && step2Raw.length > 0) {
      assistantEntry._rawResponseStep2 = step2Raw;
    }
    if (ctx.parsedResponse.commands && ctx.parsedResponse.commands.length > 0) {
      assistantEntry._commands = ctx.parsedResponse.commands;
    }
    const implicitMid = ctx.parsedResponse.midTermMemory;
    if (implicitMid) {
      const subject = typeof implicitMid === 'string'
        ? implicitMid
        : (implicitMid as { 记忆主体?: string }).记忆主体 ?? '';
      if (subject && subject.trim()) {
        assistantEntry._shortTermPreview = subject.slice(0, 80);
      }
    }

    // ── Engram per-round snapshots ──
    if (ctx.meta['engramWrite']) {
      assistantEntry._engramWrite = ctx.meta['engramWrite'];
    }
    if (ctx.meta['engramRead']) {
      assistantEntry._engramRead = ctx.meta['engramRead'];
    }
    if (ctx.meta['npcRelevance']) {
      assistantEntry._npcRelevance = ctx.meta['npcRelevance'];
    }

    // ── Phase 4 (2026-04-19): polish metadata ──
    //
    // Set by BodyPolishStage when it successfully applied polish. We persist
    // the pre-polish text under `_polish.originalText` so the RoundDivider
    // can offer a "优化 / 原文" toggle (see MainGamePanel `showingOriginalForRound`).
    if (ctx.meta.polishApplied === true) {
      assistantEntry._polish = {
        applied: true,
        originalText: String(ctx.meta.polishOriginalText ?? ''),
        model: String(ctx.meta.polishModel ?? 'unknown'),
        durationMs: Number(ctx.meta.polishDurationMs ?? 0),
        manual: Boolean(ctx.meta.polishManual),
        polishedAt: Date.now(),
      };
      // Include polish time in the visible duration so users see total wall-clock.
      const metrics = assistantEntry._metrics as { durationMs: number } | undefined;
      if (metrics) {
        metrics.durationMs = (ctx.aiCallDurationMs ?? 0) + Number(ctx.meta.polishDurationMs ?? 0);
      }
    }

    this.stateManager.push(this.paths.narrativeHistory, assistantEntry, 'system');

    // ── 10b. 收藏楼层一次性消费 ──
    // 本回合已把 pending=true 的收藏经 {{BOOKMARKED_ROUNDS_BLOCK}} 注入过 prompt，
    // 现在统一复位 pending，保证"只注入一次"（PM 决策 2026-07-18）。
    // 放在 autoSave 之前，使复位随本回合持久化落盘。此阶段每回合仅执行一次
    // （split-gen 只影响 context-assembly / ai-call），故不会漏消费或重复消费。
    this.consumePendingBookmarks();

    // ── 11. 自动存档 ──
    // 在所有状态变更完成后保存，确保存档包含完整的回合结果
    // 只在有活跃的档案和槽位时存档（创角流程中可能还未创建）
    await this.autoSave();

    return ctx;
  }

  /**
   * 收藏楼层一次性消费 —— 把本回合注入过的收藏 `pending` 复位为 false。
   *
   * ContextAssemblyStage 已将 `pending=true` 的收藏注入本回合 prompt；此处复位保证
   * "只注入一次"（PM 决策 2026-07-18，默认不注入 / 选中后只对下一回合注入一次）。
   * 无 pending 时整体不写（避免无意义的状态变更事件）。
   */
  private consumePendingBookmarks(): void {
    const list = this.stateManager.get<BookmarkedRound[]>(this.paths.bookmarkedRounds);
    if (!Array.isArray(list) || list.length === 0) return;
    if (!list.some((b) => b && b.pending === true)) return;
    const next = list.map((b) => (b && b.pending === true ? { ...b, pending: false } : b));
    this.stateManager.set(this.paths.bookmarkedRounds, next, 'system');
  }

  /**
   * 探索记录自动追踪
   *
   * 读取当前玩家位置，若不在探索记录数组中则追加。
   * 使用 includes() 去重，确保同一地点不会被记录多次。
   * push() 在路径不存在时自动创建数组，无需在 opening.md 手动初始化。
   */
  private trackExploration(): void {
    const currentLocation = this.stateManager.get<string>(this.paths.playerLocation);
    if (!currentLocation || typeof currentLocation !== 'string') return;

    const record = this.stateManager.get<string[]>(this.paths.explorationRecord) ?? [];
    if (!record.includes(currentLocation)) {
      this.stateManager.push(this.paths.explorationRecord, currentLocation, 'system');
    }
  }

  /**
   * NPC 在场状态自动同步
   *
   * 比较每个 NPC 的「位置」和玩家「当前位置」：
   * - NPC 位置与玩家位置相同，或互为前缀（同一区域） → 是否在场=true
   * - 否则 → 是否在场=false
   * 仅在 presenceEnabled 开启时执行。
   */
  private syncPresence(): void {
    const enabled = this.stateManager.get<boolean>('系统.设置.social.presenceEnabled');
    if (!enabled) return;

    const playerLoc = this.stateManager.get<string>(this.paths.playerLocation) ?? '';
    if (!playerLoc) return;

    const f = this.paths.npcFieldNames;
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list) || list.length === 0) return;

    let changed = false;
    const updated = list.map((npc) => {
      const npcLoc = (npc[f.location] as string) ?? '';
      if (!npcLoc) return npc;

      const isColocated = npcLoc === playerLoc
        || playerLoc.startsWith(npcLoc + '·')
        || npcLoc.startsWith(playerLoc + '·');

      if (npc[f.isPresent] !== isColocated) {
        changed = true;
        return { ...npc, [f.isPresent]: isColocated };
      }
      return npc;
    });

    if (changed) {
      this.stateManager.set(this.paths.relationships, updated, 'system');
    }
  }

  /**
   * 判断是否应触发世界心跳
   *
   * 心跳配置存储在状态树 "世界.状态.心跳.配置" 路径，
   * 使用 HeartbeatConfig 接口确保类型安全（替代 any 断言）。
   *
   * 触发条件：
   * - 心跳已启用
   * - 当前回合距上次心跳回合 ≥ 配置的周期数值
   */
  private shouldRunHeartbeat(ctx: PipelineContext): boolean {
    const config = this.stateManager.get<HeartbeatConfig>(this.paths.heartbeatConfig);
    if (!config?.enabled) return false;

    const period = config.period ?? 5;
    const lastRound = Number(
      this.stateManager.get(this.paths.lastHeartbeatRound) ?? 0,
    );

    return ctx.roundNumber - lastRound >= period;
  }

  /**
   * 自动存档 — 每回合结束后将完整状态持久化
   *
   * 存档元数据包含游戏内时间、角色名、当前位置等摘要信息，
   * 用于存档列表的快速展示（无需加载完整状态树）。
   */
  private async autoSave(): Promise<void> {
    const slot = this.getActiveSlot();
    if (!slot) return;

    const snapshot = this.stateManager.toSnapshot();
    const timeData = this.stateManager.get(this.paths.gameTime);

    await this.saveManager.saveGame(
      slot.profileId,
      slot.slotId,
      snapshot,
      {
        gameTime: timeData !== undefined ? JSON.stringify(timeData) : undefined,
        characterName: this.stateManager.get<string>(this.paths.playerName),
        currentLocation: this.stateManager.get<string>(this.paths.playerLocation),
      },
    );
  }
}
