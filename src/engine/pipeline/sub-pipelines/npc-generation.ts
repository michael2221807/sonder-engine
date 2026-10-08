/**
 * NPC 生成子流水线 — 为新到达的地点动态生成 NPC
 *
 * 触发时机：
 * 当玩家移动到一个尚未有 NPC 的新地点时，主流水线调用本子流水线。
 *
 * 设计目的：
 * 游戏世界的 NPC 不预先生成（节省初始化成本），
 * 而是在玩家实际到达时按需生成，确保世界的丰富性。
 *
 * 流程：
 * 1. 检查目标地点是否已有 NPC（有则跳过）
 * 2. 收集地点信息（名称、描述、类型等）
 * 3. 组装 npcGeneration prompt flow
 * 4. 调用 AI 生成 NPC 数据
 * 5. 解析响应中的 commands 并执行（将 NPC 数据写入状态树）
 *
 * 去重策略：
 * 使用地点名称作为唯一性检查 key。
 * 已有 NPC 的地点不会再次生成（即使 NPC 后来离开了该地点）。
 *
 * 对应 STEP-02 §5.3 Dynamic NPC Generation。
 */
import type { StateManager } from '../../core/state-manager';
import type { CommandExecutor } from '../../core/command-executor';
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { GamePack } from '../../types';
import type { EnginePathConfig } from '../types';
import { appendChangesToLastNarrative } from '../../audit/audit-append';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { SYSTEM_PATHS } from '../system-paths';
import { TIANMING_LEGACY_NPC_KEYS } from '../../pack/tianming-coupling';

export class NpcGenerationPipeline {
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
   * 执行 NPC 生成
   *
   * @param locationName 目标地点名称
   * @returns true 表示生成了新 NPC，false 表示跳过或失败
   */
  async execute(locationName: string): Promise<boolean> {
    if (this.locationHasNpcs(locationName)) {
      console.log(`[NpcGeneration] Location "${locationName}" already has NPCs, skipping`);
      return false;
    }

    const flow = this.gamePack.promptFlows['npcGeneration'];
    if (!flow) {
      console.warn('[NpcGeneration] No "npcGeneration" prompt flow found in Game Pack');
      return false;
    }

    try {
      const variables = this.buildGenerationVariables(locationName);
      const assembled = this.promptAssembler.assemble(flow, variables);
      const generationId = `npcGeneration_${locationName}_${Date.now()}`;

      // §G3: NPC 生成子管线的组装可见于 PromptAssemblyPanel
      emitPromptAssemblyDebug({
        flow: 'npcGeneration',
        variables,
        messages: assembled.messages,
        messageSources: assembled.messageSources,
        generationId,
      });

      const rawResponse = await this.aiService.generate({
        messages: assembled.messages,
        usageType: 'location_npc_generation',
      });

      emitPromptResponseDebug({
        flow: 'npcGeneration',
        generationId,
        thinking: extractThinkingFromRaw(rawResponse),
        rawResponse,
      });

      const parsed = this.responseParser.parse(rawResponse);

      if (parsed.commands && parsed.commands.length > 0) {
        const result = this.commandExecutor.executeBatch(parsed.commands);

        // 记录该地点已生成 NPC，防止重复生成
        this.markLocationGenerated(locationName);

        console.log(
          `[NpcGeneration] Generated NPCs for "${locationName}" ` +
          `(${parsed.commands.length} commands, ${result.hasErrors ? 'with errors' : 'OK'})`,
        );
        appendChangesToLastNarrative(
          this.stateManager,
          this.paths,
          'npcGeneration',
          result.changeLog.changes,
        );
        return !result.hasErrors;
      }

      console.log(`[NpcGeneration] AI returned no commands for "${locationName}"`);
      return false;
    } catch (err) {
      console.error(`[NpcGeneration] Failed for "${locationName}":`, err);
      return false;
    }
  }

  /**
   * 检查地点是否已有 NPC
   *
   * 检查策略（按优先级）：
   * 1. 地点对象的 NPC 列表字段是否非空
   * 2. 全局 NPC 列表中是否有当前位置为该地点的 NPC
   * 3. 已生成标记集合中是否包含该地点
   */
  private locationHasNpcs(locationName: string): boolean {
    // 策略 1: 检查地点对象的 NPC 列表
    const npcList = this.stateManager.get<unknown[]>(
      `${this.paths.locations}.${locationName}.NPC`,
    );
    if (Array.isArray(npcList) && npcList.length > 0) return true;

    // 策略 2: 检查全局 NPC 列表
    const globalNpcs = this.findGlobalNpcList();
    if (globalNpcs) {
      const hasNpcAtLocation = globalNpcs.some((npc) => {
        const npcLoc = String(npc[TIANMING_LEGACY_NPC_KEYS.locationAlias] ?? npc['currentLocation'] ?? '');
        return npcLoc === locationName;
      });
      if (hasNpcAtLocation) return true;
    }

    // 策略 3: 检查已生成标记
    const generated = this.stateManager.get<string[]>(SYSTEM_PATHS.generatedNpcLocations) ?? [];
    return generated.includes(locationName);
  }

  /** 构建 NPC 生成的 prompt 模板变量 */
  private buildGenerationVariables(locationName: string): Record<string, string> {
    const locationInfo = this.getLocationInfo(locationName);
    const existingNpcNames = this.getExistingNpcNames();
    const worldContext = this.getWorldContext();

    return {
      LOCATION_NAME: locationName,
      LOCATION_INFO: locationInfo,
      EXISTING_NPC_NAMES: existingNpcNames.join(', ') || '（无）',
      WORLD_CONTEXT: worldContext,
    };
  }

  /** 获取地点的详细信息（描述、类型等） */
  private getLocationInfo(locationName: string): string {
    const locObj = this.stateManager.get<Record<string, unknown>>(
      `${this.paths.locations}.${locationName}`,
    );
    if (locObj && typeof locObj === 'object') {
      const parts: string[] = [`名称: ${locationName}`];
      for (const key of Object.keys(locObj)) {
        if (key !== 'NPC' && key !== 'npcs') {
          parts.push(`${key}: ${String(locObj[key])}`);
        }
      }
      return parts.join('\n');
    }
    return `名称: ${locationName}`;
  }

  /**
   * 获取现有 NPC 名称列表 — 用于防止 AI 生成重名 NPC
   * 将已有名字传给 AI，在 prompt 中要求不要重复
   */
  private getExistingNpcNames(): string[] {
    const npcs = this.findGlobalNpcList();
    if (!npcs) return [];

    return npcs
      .map((npc) => String(npc['名称'] ?? npc['name'] ?? ''))
      .filter((name) => name.length > 0);
  }

  /** 获取世界背景上下文（供 AI 生成时参考） */
  private getWorldContext(): string {
    return this.stateManager.get<string>(this.paths.worldDescription) ?? '';
  }

  /** 标记地点已生成 NPC */
  private markLocationGenerated(locationName: string): void {
    this.stateManager.push(SYSTEM_PATHS.generatedNpcLocations, locationName, 'system');
  }

  /** 查找全局 NPC 列表 */
  private findGlobalNpcList(): Record<string, unknown>[] | null {
    const list = this.stateManager.get<unknown>(this.paths.npcList);
    if (Array.isArray(list)) {
      return list.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      );
    }
    return null;
  }
}
