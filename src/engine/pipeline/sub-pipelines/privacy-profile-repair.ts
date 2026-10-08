/**
 * 私密信息修复子管线 — GAP_AUDIT §11.2 B (B1 + B2 combination)
 *
 * 触发条件：
 * 主管线 CommandExecutionStage 在执行 AI commands 后调用
 * `findIncompletePrivacy(stateManager, paths, genderFilter)` 检测缺失，
 * 若有缺失则在 `ctx.meta.pendingPrivacyRepair` 写入需要修复的实体清单，
 * 由 GameOrchestrator 在 `runPostRoundSubPipelines` 中消费此 flag 并调用本管线。
 *
 * 修复流程：
 * 1. 接收 incomplete 报告（NPC 名称列表 + playerBody 缺失标志）
 * 2. 组装专用 prompt（使用 `privacyProfileRepair` flow，独立的 usageType `'privacy_repair'`）
 * 3. 调用 AI，解析返回的 commands
 * 4. 应用 commands 到 stateManager
 * 5. 重新执行 findIncompletePrivacy，获得剩余的 incomplete
 * 6. 若仍有剩余且 attempt < maxRetries，回到步骤 2 继续
 * 7. 返回最终的 remaining（空数组表示全部修复成功）
 *
 * 关键设计：
 * - 使用独立的 `'privacy_repair'` usageType，用户可在 APIPanel 单独给它配置 API（通常不绑定到主回合 API）
 * - 重试次数由 `aga_ai_settings.privacyRepairRetries` 配置（默认 1 次，允许 0-5 次）
 * - 每次重试用的 prompt 只包含"仍缺失"的实体，避免重复 token 浪费
 * - 每次调用都 emit `ui:debug-prompt`，供 PromptAssemblyPanel 调试可见
 *
 * 对应 GAP_AUDIT §11.2 B：软警告（CommandExecutionStage 先 console.warn）+ 自动修复（本管线）。
 */
import type { StateManager } from '../../core/state-manager';
import type { CommandExecutor } from '../../core/command-executor';
import type { AIService } from '../../ai/ai-service';
import { AI_SETTINGS_STORAGE_KEY } from '../../ai/ai-service';
import type { AIMessage } from '../../ai/types';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { GamePack } from '../../types';
import type { EnginePathConfig } from '../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { appendChangesToLastNarrative } from '../../audit/audit-append';
import {
  findIncompletePrivacy,
  readNsfwSettings,
  type PrivacyIncompleteReport,
  type NsfwGenderFilter,
} from '../../validators/privacy-profile-validator';

/** 重试次数读取 — 与 GameOrchestrator.readAISettings 约定同一个 localStorage key */
const MAX_RETRIES_KEY = AI_SETTINGS_STORAGE_KEY;
const DEFAULT_MAX_RETRIES = 1;

function readMaxRetries(): number {
  try {
    const raw = localStorage.getItem(MAX_RETRIES_KEY);
    if (!raw) return DEFAULT_MAX_RETRIES;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed['privacyRepairRetries'];
    if (typeof v === 'number' && v >= 0 && v <= 5) return Math.floor(v);
    return DEFAULT_MAX_RETRIES;
  } catch {
    return DEFAULT_MAX_RETRIES;
  }
}

/** 修复结果 — 返回给调用方，供日志和 UI 展示 */
export interface PrivacyRepairResult {
  /** 是否全部修复成功（remaining 为空） */
  success: boolean;
  /** 实际执行的 API 调用次数（含首次） */
  attempts: number;
  /** 仍然缺失的实体列表（全部成功时为空） */
  remaining: PrivacyIncompleteReport;
}

export class PrivacyProfileRepairPipeline {
  constructor(
    private stateManager: StateManager,
    private commandExecutor: CommandExecutor,
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private gamePack: GamePack,
    private paths: EnginePathConfig,
  ) {}

  /**
   * 执行修复 — 接收初始 incomplete 报告，运行 retry 循环
   *
   * @param initialReport 首次 incomplete 检测的结果（由 CommandExecutionStage 提供）
   * @returns 修复结果 + 剩余缺失项
   */
  async execute(initialReport: PrivacyIncompleteReport): Promise<PrivacyRepairResult> {
    const { nsfwMode, nsfwGenderFilter } = readNsfwSettings(this.stateManager);
    if (!nsfwMode) {
      // nsfwMode 在此期间被关闭 — 不再需要修复
      return {
        success: true,
        attempts: 0,
        remaining: { npcNames: [], playerBodyMissing: false, get total() { return 0; } },
      };
    }

    const flow = this.gamePack.promptFlows['privacyProfileRepair'];
    if (!flow) {
      console.warn('[PrivacyRepair] No "privacyProfileRepair" prompt flow in Game Pack — cannot repair');
      return { success: false, attempts: 0, remaining: initialReport };
    }

    const maxRetries = readMaxRetries();
    let report = initialReport;
    let attempts = 0;
    const maxAttempts = maxRetries + 1; // +1 因为 maxRetries=0 也至少要跑一次首次调用

    while (report.total > 0 && attempts < maxAttempts) {
      attempts++;

      try {
        await this.runOneAttempt(report, nsfwGenderFilter, attempts);
      } catch (err) {
        console.error(`[PrivacyRepair] Attempt ${attempts}/${maxAttempts} failed:`, err);
        break; // 硬错误不再重试
      }

      // 重新扫描以判停
      report = findIncompletePrivacy(this.stateManager, this.paths, nsfwGenderFilter);
    }

    const success = report.total === 0;

    if (success) {
      console.log(`[PrivacyRepair] All entities repaired in ${attempts} attempt(s)`);
    } else {
      console.warn(
        `[PrivacyRepair] ${report.total} entit(ies) still incomplete after ${attempts} attempt(s):`,
        { npcs: report.npcNames, playerBody: report.playerBodyMissing },
      );
    }

    return { success, attempts, remaining: report };
  }

  /**
   * 单次修复尝试 — 组装 prompt、调 AI、应用 commands
   *
   * 每次只把仍缺失的实体传给 AI，不重复已修复的条目。
   */
  private async runOneAttempt(
    report: PrivacyIncompleteReport,
    genderFilter: NsfwGenderFilter,
    attempt: number,
  ): Promise<void> {
    const flow = this.gamePack.promptFlows['privacyProfileRepair'];
    if (!flow) return;

    const variables: Record<string, string> = {
      NPC_LIST: this.buildNpcListVariable(report.npcNames),
      NPC_COUNT: String(report.npcNames.length),
      PLAYER_BODY_MISSING: report.playerBodyMissing ? 'true' : 'false',
      GENDER_FILTER: genderFilter,
      ATTEMPT_NUMBER: String(attempt),
    };

    const assembled = this.promptAssembler.assemble(flow, variables);

    // Task data (NPC list + attempt metadata) + enforcement + anti-truncation
    // as a single user message. The flow only has a system module (instructions/format),
    // so this user message also prevents the assembler's placeholder injection.
    const taskData = this.promptAssembler.renderSingle('privacyRepairInput', variables) ?? '';
    const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
    const finalUserContent =
      (taskData ? `${taskData}\n\n` : '') +
      (enforcement ? `${enforcement}\n\n` : '') +
      `<修复任务>\n` +
      `请立即输出完整的 privacy profile 补齐 commands。要求：\n` +
      `1. **完整性**：报告中列出的 ${report.npcNames.length} 个 NPC 的 私密信息 必须全部补齐，不得遗漏任何一个。\n` +
      `2. **完整字段**：每个 NPC 的 私密信息 对象必须包含所有必需字段（见 privacyRepair prompt 规范），不得只给部分字段。\n` +
      (report.playerBodyMissing ? `3. **玩家法身**：角色.身体 也须补齐。\n` : '') +
      `4. **不截断**：即使需要输出大量 commands，也要完整输出所有条目，不得用 "(略)" / "(后续类似)" 敷衍。\n` +
      `5. **直接 JSON**：输出一个合法 JSON 对象，包含 commands 数组，无代码围栏、无解释文字、无 \`<thinking>\` 标签。\n` +
      `</修复任务>\n\n` +
      `现在请输出 commands JSON。`;
    const filteredMessages = assembled.messages.filter(
      (m) => !(m.role === 'user' && m.content === '请根据以上设定开始。'),
    );
    const filteredSources = assembled.messageSources.filter((s) => s !== 'placeholder');
    const finalMessages: AIMessage[] = [
      ...filteredMessages,
      { role: 'user', content: finalUserContent },
    ];
    const finalSources = [...filteredSources, 'current_input'];
    const generationId = `privacyProfileRepair_${attempt}_${Date.now()}`;

    // §G3: 修复管线的组装对 PromptAssemblyPanel 可见
    emitPromptAssemblyDebug({
      flow: `privacyProfileRepair#${attempt}`,
      variables,
      messages: finalMessages,
      messageSources: finalSources,
      generationId,
    });

    const rawResponse = await this.aiService.generate({
      messages: finalMessages,
      usageType: 'privacy_repair', // 新 usageType，独立 API 路由
    });

    emitPromptResponseDebug({
      flow: `privacyProfileRepair#${attempt}`,
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    const parsed = this.responseParser.parse(rawResponse);

    if (parsed.commands && parsed.commands.length > 0) {
      const result = this.commandExecutor.executeBatch(parsed.commands);
      console.log(
        `[PrivacyRepair] Attempt ${attempt}: applied ${parsed.commands.length} commands ` +
        `(${result.hasErrors ? 'some errors' : 'all ok'})`,
      );
      // Surface this sub-pipeline's changes to the round's audit trail so the
      // user sees 私密信息 补齐 alongside main-round commands in the Δ viewer.
      appendChangesToLastNarrative(
        this.stateManager,
        this.paths,
        'privacyRepair',
        result.changeLog.changes,
      );
    } else {
      console.warn(`[PrivacyRepair] Attempt ${attempt}: AI returned no commands`);
    }
  }

  /**
   * 构建 NPC_LIST prompt 变量 — 给每个 incomplete NPC 附带当前基础信息
   *
   * 这让 AI 生成 私密信息 时能考虑 NPC 的名称、类型、背景，
   * 避免纯粹"填空"式的机械生成。
   */
  private buildNpcListVariable(names: string[]): string {
    if (names.length === 0) return '（无）';

    const relationships = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(relationships)) {
      return names.map((n) => `- ${n}`).join('\n');
    }

    const byName = new Map<string, Record<string, unknown>>();
    for (const npc of relationships) {
      if (npc && typeof npc === 'object') {
        const name = String(npc['名称'] ?? '');
        if (name) byName.set(name, npc);
      }
    }

    return names
      .map((name) => {
        const npc = byName.get(name);
        if (!npc) return `- ${name}（未找到）`;
        const type = String(npc['类型'] ?? '未知');
        const gender = String(npc['性别'] ?? '未知');
        const desc = String(npc['描述'] ?? '');
        const bg = String(npc['背景'] ?? '');
        const lines = [`- ${name}（类型:${type}，性别:${gender}）`];
        if (desc) lines.push(`  描述：${desc}`);
        if (bg) lines.push(`  背景：${bg}`);
        return lines.join('\n');
      })
      .join('\n');
  }
}
