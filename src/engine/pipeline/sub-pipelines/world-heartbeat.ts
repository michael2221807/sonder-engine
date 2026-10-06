/**
 * 世界心跳子流水线 — 周期性世界模拟
 *
 * 设计目的：
 * 让游戏世界在玩家不参与时也有"生命力"。
 * 定期选择一批 NPC，通过 AI 模拟他们的自主行为，
 * 生成世界事件（如 NPC 之间的互动、位置变化、状态变化）。
 *
 * 触发时机：
 * 由主流水线根据回合计数或游戏时间间隔触发。
 * 典型配置：每 5-10 个回合执行一次。
 *
 * NPC 选择策略：
 * 1. 排除与玩家同一位置的 NPC（他们已在主回合中参与互动）
 * 2. 优先选择最近未被心跳处理过的 NPC（轮转公平性）
 * 3. 限制每次处理的 NPC 数量（避免 AI 调用过大）
 *
 * 流程：
 * 1. 筛选候选 NPC
 * 2. 组装 worldHeartbeat prompt flow（包含 NPC 信息和世界状态）
 * 3. 调用 AI 生成世界事件
 * 4. 解析响应中的 commands 并通过 CommandExecutor 执行
 *
 * 对应 STEP-02 §3.11 World Heartbeat。
 */
// App doc: docs/user-guide/pages/game-heartbeat.md §历史保留条数与遗忘回合数
import type { StateManager } from '../../core/state-manager';
import type { CommandExecutor } from '../../core/command-executor';
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { GamePack } from '../../types';
import type { EnginePathConfig, IEngramManager } from '../types';
import { DEFAULT_HEARTBEAT_HISTORY_LIMIT, DEFAULT_HEARTBEAT_FORGET_ROUNDS } from '../types';
import type { AIResponse } from '../../ai/types';
import type { StateChange } from '../../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { appendChangesToLastNarrative } from '../../audit/audit-append';
import { isColocatedLocation } from '../../social/npc-presence';
import { buildEnvironmentBlock } from '../../prompt/environment-block';

/** 每次心跳最多处理的 NPC 数量，控制 AI 调用的 token 消耗 */
const MAX_NPCS_PER_HEARTBEAT = 5;

/** A whole number the player set, or the default when it is missing or unusable. */
function settingOrDefault(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

export class WorldHeartbeatPipeline {
  constructor(
    private stateManager: StateManager,
    private commandExecutor: CommandExecutor,
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private gamePack: GamePack,
    private paths: EnginePathConfig,
    private engramManager?: IEngramManager,
  ) {}

  /**
   * 执行世界心跳
   *
   * 返回 true 表示心跳产生了状态变更，false 表示跳过或无变更。
   */
  async execute(): Promise<boolean> {
    const flow = this.gamePack.promptFlows['worldHeartbeat'];
    if (!flow) {
      console.warn('[WorldHeartbeat] No "worldHeartbeat" prompt flow found in Game Pack');
      return false;
    }

    const candidates = this.selectCandidateNpcs();
    if (candidates.length === 0) {
      console.log('[WorldHeartbeat] No candidate NPCs for heartbeat');
      return false;
    }

    try {
      const variables = this.buildHeartbeatVariables(candidates);
      const assembled = this.promptAssembler.assemble(flow, variables);
      const generationId = `worldHeartbeat_${Date.now()}`;

      // §G3: 世界心跳子管线的组装可见于 PromptAssemblyPanel
      emitPromptAssemblyDebug({
        flow: 'worldHeartbeat',
        variables,
        messages: assembled.messages,
        messageSources: assembled.messageSources,
        generationId,
      });

      const rawResponse = await this.aiService.generate({
        messages: assembled.messages,
        usageType: 'world_heartbeat',
      });

      emitPromptResponseDebug({
        flow: 'worldHeartbeat',
        generationId,
        thinking: extractThinkingFromRaw(rawResponse),
        rawResponse,
      });

      const parsed = this.responseParser.parse(rawResponse);

      let commandCount = 0;
      let success = true;
      let changes: StateChange[] = [];
      if (parsed.commands && parsed.commands.length > 0) {
        commandCount = parsed.commands.length;
        const result = this.commandExecutor.executeBatch(parsed.commands);
        success = !result.hasErrors;
        changes = result.changeLog.changes;
        console.log(
          `[WorldHeartbeat] Executed ${commandCount} commands, ` +
          `${success ? 'all succeeded' : 'with errors'}`,
        );
        appendChangesToLastNarrative(
          this.stateManager,
          this.paths,
          'worldHeartbeat',
          changes,
        );
      } else {
        console.log('[WorldHeartbeat] AI returned no commands');
      }

      const roundNum = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
      const npcNames = candidates.map((n) => String(n[this.paths.npcFieldNames.name] ?? '')).filter(Boolean);
      this.stateManager.push(this.paths.heartbeatHistory, {
        timestamp: new Date().toLocaleString(),
        回合: roundNum,
        result: commandCount > 0
          ? `更新了 ${npcNames.join('、')} 的状态（${commandCount} 条命令）`
          : `无状态变更（${npcNames.join('、')}）`,
        成功: success,
      }, 'system');
      this.trimHistory();

      if (this.engramManager?.isEnabled() && changes.length > 0) {
        try {
          // knowledgeFacts intentionally omitted — heartbeat prompt does not produce them.
          // V2 edges are skipped; events + entity refresh are the MVP scope.
          const syntheticResponse: AIResponse = {
            text: this.synthesizeHeartbeatText(npcNames, changes),
            commands: parsed.commands,
          };
          await this.engramManager.processResponse(syntheticResponse, this.stateManager);
        } catch (engramErr) {
          console.warn('[WorldHeartbeat] Engram processResponse failed (non-blocking):', engramErr);
        }
      }

      return true;
    } catch (err) {
      console.error('[WorldHeartbeat] Pipeline execution failed:', err);
      return false;
    }
  }

  /**
   * 筛选候选 NPC — 选出适合参与世界心跳的 NPC
   *
   * 排除规则：
   * 1. 与玩家同一位置（已在主回合参与互动）
   * 2. 不活跃/已死亡状态的 NPC
   */
  private selectCandidateNpcs(): Record<string, unknown>[] {
    const npcList = this.findNpcList();
    if (!npcList) return [];

    const playerLocation = this.getPlayerLocation();
    const fields = this.paths.npcFieldNames;
    // 遗忘回合数 (P8, demo worldHeartbeatService.ts:31-54): an NPC the main round has not updated for more than N
    // rounds sits the heartbeat out; 0 = never forget. An NPC with no record yet is kept (its clock starts at the
    // next load, NpcMainRoundUpdateModule).
    const round = settingOrDefault(this.stateManager.get<unknown>(this.paths.roundNumber), 0, 0);
    const forget = settingOrDefault(this.stateManager.get<unknown>(this.paths.heartbeatForgetRounds),
      DEFAULT_HEARTBEAT_FORGET_ROUNDS, 0);

    const candidates = npcList.filter((npc) => {
      // The pack's own location field: the old literal ('当前位置') was no NPC field, so the same-place rule never
      // applied (2026-10-04).
      const npcLocation = String(npc[fields.location] ?? '');
      const isAlive = npc[fields.deceased] !== true && npc['isDead'] !== true;

      // 排除与玩家同位置的 NPC — the same test presence uses, so a place and the room inside it (`城·客栈` and
      // `城·客栈·二楼`) count as one: the heartbeat never moves an NPC the story shows beside the player.
      if (playerLocation && isColocatedLocation(npcLocation, playerLocation, this.paths.locationPathSeparator)) return false;
      // 排除已死亡的 NPC
      if (!isAlive) return false;
      // Phase 6.2: 排除心跳锁定的 NPC（用户在 UI 中手动锁定，保持其状态不被 AI 修改）
      if (npc[fields.heartbeatLock] === true) return false;
      const lastUpdate = npc[fields.lastMainRoundUpdate];
      if (forget > 0 && typeof lastUpdate === 'number' && round - lastUpdate > forget) return false;

      return true;
    });

    /*
     * 从候选池中随机选取最多 MAX_NPCS_PER_HEARTBEAT 个
     * 使用 Fisher-Yates 洗牌的前 N 项，避免全量洗牌的开销
     */
    return this.sampleArray(candidates, MAX_NPCS_PER_HEARTBEAT);
  }

  /**
   * 构建心跳 prompt 的模板变量
   *
   * 变量名与 `prompts/worldHeartbeat.md` 中的 `{{NPC_BLOCKS}}` / `{{CONTEXT_BLOCK}}` 占位符严格一致。
   *
   * - `NPC_BLOCKS`：每个候选 NPC 的多字段摘要（名称/位置/类型/在做事项等），供 AI 代入视角
   * - `CONTEXT_BLOCK`：游戏时间 + 玩家位置等时空约束，限制 AI 生成的 NPC 状态合理性
   */
  private buildHeartbeatVariables(npcs: Record<string, unknown>[]): Record<string, string> {
    const f = this.paths.npcFieldNames;
    const npcBlocks = npcs.map((npc) => {
      const name = String(npc[f.name] ?? npc['name'] ?? '未知');
      const location = String(npc[f.location] ?? '未知');
      const type = String(npc[f.type] ?? '');
      const desc = String(npc[f.appearance] ?? npc[f.description] ?? '');
      const body = String(npc[f.bodyDescription] ?? '');
      const outfit = String(npc[f.outfitStyle] ?? '');
      const thought = String(npc[f.innerThought] ?? '');
      const doing = String(npc[f.currentActivity] ?? '');
      const traits = Array.isArray(npc[f.personalityTraits])
        ? (npc[f.personalityTraits] as string[]).join('、')
        : '';

      const lines: string[] = [`### ${name}`];
      if (type) lines.push(`- 类型: ${type}`);
      lines.push(`- 当前位置: ${location}`);
      if (desc) lines.push(`- 外貌描述: ${desc}`);
      if (body) lines.push(`- 身材描写: ${body}`);
      if (outfit) lines.push(`- 衣着风格: ${outfit}`);
      if (traits) lines.push(`- 性格: ${traits}`);
      if (thought) lines.push(`- 内心想法: ${thought}`);
      if (doing) lines.push(`- 在做事项: ${doing}`);
      return lines.join('\n');
    });

    const timeInfo = this.getGameTimeString();
    const playerLoc = this.getPlayerLocation() ?? '';
    const contextLines: string[] = [];
    if (timeInfo) contextLines.push(`游戏时间: ${timeInfo}`);
    if (playerLoc) contextLines.push(`玩家当前位置: ${playerLoc}`);

    // P2 env-tags port (2026-04-19): inject env block so NPCs can react to
    // weather / festival / environment in their "在做事项" / "内心想法"
    // updates. Heartbeat itself does NOT emit env/weather/festival writes —
    // those are main-round's responsibility (see worldHeartbeat.md disclaimer).
    const environmentBlock = buildEnvironmentBlock({
      weather: this.stateManager.get<unknown>(this.paths.weather),
      festival: this.stateManager.get<unknown>(this.paths.festival),
      environment: this.stateManager.get<unknown>(this.paths.environmentTags),
    });

    return {
      NPC_BLOCKS: npcBlocks.join('\n\n'),
      CONTEXT_BLOCK: contextLines.join('\n'),
      ENVIRONMENT_BLOCK: environmentBlock,
    };
  }

  private synthesizeHeartbeatText(npcNames: string[], changes: StateChange[]): string {
    const lines: string[] = [`[世界心跳] ${npcNames.join('、')} 的状态发生变化：`];
    for (const c of changes) {
      const field = c.path.split('.').pop() ?? c.path;
      const fmtVal = (v: unknown): string => {
        if (v === undefined || v === null) return '';
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 80 ? s.slice(0, 80) + '…' : s;
      };
      switch (c.action) {
        case 'set':
          if (c.newValue !== undefined) lines.push(`- ${field}: ${fmtVal(c.newValue)}`);
          break;
        case 'add':
          if (c.newValue !== undefined) lines.push(`- ${field} +${fmtVal(c.newValue)}`);
          break;
        case 'push':
          lines.push(`- ${field} 新增: ${fmtVal(c.newValue)}`);
          break;
        case 'pull':
          lines.push(`- ${field} 移除: ${fmtVal(c.oldValue)}`);
          break;
        case 'delete':
          lines.push(`- ${field} 已删除`);
          break;
      }
    }
    return lines.join('\n');
  }

  /**
   * Keep the newest N heartbeat records — the settings page's 历史保留条数 (P8, demo worldHeartbeatService.ts:265-268);
   * the history used to grow without end in the save. A smaller setting takes effect at the next heartbeat.
   */
  private trimHistory(): void {
    const history = this.stateManager.get<unknown[]>(this.paths.heartbeatHistory);
    if (!Array.isArray(history)) return;
    const limit = settingOrDefault(this.stateManager.get<unknown>(this.paths.heartbeatHistoryLimit),
      DEFAULT_HEARTBEAT_HISTORY_LIMIT, 1);
    if (history.length > limit) this.stateManager.set(this.paths.heartbeatHistory, history.slice(-limit), 'system');
  }

  /** 从状态树中查找 NPC 列表（路径由 EnginePathConfig 配置） */
  private findNpcList(): Record<string, unknown>[] | null {
    const list = this.stateManager.get<unknown>(this.paths.npcList);
    if (Array.isArray(list)) {
      return list.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      );
    }
    return null;
  }

  /** 获取玩家当前位置 */
  private getPlayerLocation(): string | null {
    const loc = this.stateManager.get<string>(this.paths.playerLocation);
    return typeof loc === 'string' && loc ? loc : null;
  }

  /** 获取游戏时间的文本表示 */
  private getGameTimeString(): string {
    const timeObj = this.stateManager.get<Record<string, unknown>>(this.paths.gameTime);
    if (timeObj && typeof timeObj === 'object') {
      return Object.entries(timeObj)
        .map(([k, v]) => `${k}:${String(v)}`)
        .join(' ');
    }
    return '';
  }

  /**
   * 从数组中随机采样 n 个元素
   * 不修改原数组，使用 Fisher-Yates 部分洗牌
   */
  private sampleArray<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return [...arr];

    const copy = [...arr];
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
      result.push(copy[i]);
    }
    return result;
  }
}
