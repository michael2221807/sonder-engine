/**
 * NPC 行为规则模块 — 处理玩家移动时 NPC 的跟随/留守/游荡逻辑
 *
 * 问题背景：
 * 当玩家移动到新地点时，NPC 的行为取决于其类型：
 * - 同伴型 NPC → 跟随玩家到新地点
 * - 固定型 NPC → 留在当前位置
 * - 特殊类型 → 可能游荡到随机地点
 *
 * Game Pack 通过 NpcBehaviorConfig 声明 NPC 类型和行为策略，
 * 本模块在 afterCommands 钩子中检测玩家位置变更并执行对应行为。
 *
 * 检测机制：
 * 本模块在 afterCommands 中扫描 changeLog，
 * 如果发现玩家当前位置发生了变更（set 操作），
 * 则遍历所有 NPC 并根据其类型执行行为策略。
 *
 * 配置示例（NpcBehaviorConfig）：
 * {
 *   "npcTypes": {
 *     "typeField": "类型",
 *     "types": {
 *       "同伴": { "onPlayerLeave": "follow-or-wander", "wanderLabel": "四处闲逛" },
 *       "商人": { "onPlayerLeave": "stay" },
 *       "路人": { "onPlayerLeave": "stay" }
 *     },
 *     "defaultType": "路人"
 *   }
 * }
 *
 * 对应 STEP-02 §3.10.9。
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { ChangeLog, NpcBehaviorConfig } from '../types';
import { TIANMING_LEGACY_NPC_KEYS } from '../pack/tianming-coupling';

/** NPC 行为配置的路径扩展 — 玩家位置和 NPC 列表由外部注入 */
interface NpcBehaviorPathConfig {
  playerLocation: string;
  npcList: string;
}

export class NpcBehaviorModule implements BehaviorModule {
  readonly id = 'npc-behavior';

  constructor(
    private config: NpcBehaviorConfig,
    private pathConfig: NpcBehaviorPathConfig,
  ) {}

  /**
   * afterCommands 钩子 — 检测玩家位置变更，执行 NPC 行为
   *
   * 只在 changeLog 中检测到位置变更时才执行，
   * 避免每次 AI 回复都遍历 NPC 列表。
   */
  afterCommands(stateManager: StateManager, changeLog: ChangeLog): void {
    const locationChange = this.detectPlayerLocationChange(changeLog);
    if (!locationChange) return;

    const { oldLocation, newLocation } = locationChange;
    this.processNpcBehaviors(stateManager, oldLocation, newLocation);
  }

  /**
   * 从 changeLog 中检测玩家位置变更
   *
   * 扫描所有变更记录，查找匹配玩家位置路径的 set 操作。
   * 返回变更前后的位置值，或 null（无位置变更）。
   */
  private detectPlayerLocationChange(
    changeLog: ChangeLog,
  ): { oldLocation: string; newLocation: string } | null {
    for (const change of changeLog.changes) {
      if (change.action !== 'set') continue;

      const isLocationPath = change.path === this.pathConfig.playerLocation;
      if (!isLocationPath) continue;

      const oldLoc = String(change.oldValue ?? '');
      const newLoc = String(change.newValue ?? '');

      if (oldLoc && newLoc && oldLoc !== newLoc) {
        return { oldLocation: oldLoc, newLocation: newLoc };
      }
    }
    return null;
  }

  /**
   * 对所有 NPC 执行行为策略
   *
   * 遍历 NPC 列表，对当前位于玩家旧位置的 NPC：
   * 1. 确定其类型（从配置的 typeField 读取）
   * 2. 查找对应类型的行为策略
   * 3. 执行策略（follow / stay / wander）
   */
  private processNpcBehaviors(
    stateManager: StateManager,
    oldLocation: string,
    newLocation: string,
  ): void {
    const npcListPath = this.findNpcListPath(stateManager);
    if (!npcListPath) return;

    const npcs = stateManager.get<Record<string, unknown>[]>(npcListPath);
    if (!Array.isArray(npcs)) return;

    const typeField = this.config.npcTypes.typeField;

    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      const npcLocation = String(npc[TIANMING_LEGACY_NPC_KEYS.locationAlias] ?? npc['currentLocation'] ?? '');

      // 只处理在玩家旧位置的 NPC
      if (npcLocation !== oldLocation) continue;

      const npcType = String(npc[typeField] ?? this.config.npcTypes.defaultType);
      const typeConfig = this.config.npcTypes.types[npcType];

      if (!typeConfig) continue;

      const npcName = String(npc['名称'] ?? npc['name'] ?? `NPC_${i}`);
      const locationField = npc[TIANMING_LEGACY_NPC_KEYS.locationAlias] !== undefined ? TIANMING_LEGACY_NPC_KEYS.locationAlias : 'currentLocation';
      const npcPath = `${npcListPath}[${i}].${locationField}`;

      switch (typeConfig.onPlayerLeave) {
        case 'follow-or-wander':
          /**
           * 同伴型行为 — 跟随玩家到新位置
           * "follow-or-wander" 表示：优先跟随，若有特殊条件则游荡
           * 当前简化实现为始终跟随，游荡逻辑留待未来扩展
           */
          stateManager.set(npcPath, newLocation, 'system');
          console.log(`[NpcBehavior] "${npcName}" follows player to "${newLocation}"`);
          break;

        case 'stay':
          // 固定型 — 不移动，什么都不做
          break;

        case 'wander': {
          /**
           * 游荡型 — 更新位置为游荡标签
           * 不设为具体地点，而是设为描述性标签（如"四处闲逛"），
           * 让 AI 在下次叙事时决定具体位置
           */
          const wanderLabel = typeConfig.wanderLabel ?? '未知位置';
          stateManager.set(npcPath, wanderLabel, 'system');
          console.log(`[NpcBehavior] "${npcName}" wanders: "${wanderLabel}"`);
          break;
        }

        default:
          console.warn(`[NpcBehavior] Unknown behavior "${typeConfig.onPlayerLeave}" for type "${npcType}"`);
      }
    }
  }

  /** 获取 NPC 列表路径（由 EnginePathConfig 注入） */
  private findNpcListPath(stateManager: StateManager): string | null {
    if (stateManager.has(this.pathConfig.npcList)) return this.pathConfig.npcList;
    return null;
  }
}
