// App doc: docs/user-guide/pages/game-save.md §2.5.3
/**
 * Card-export strip/keep/reset path config — Story 5 (P2).
 *
 * The stripper functions in card-stripper.ts are pack-agnostic: they operate on
 * an injected CardStripPaths config and contain ZERO hardcoded field names. The
 * default config below sources most paths from DEFAULT_ENGINE_PATHS; the few not
 * present there are literals (same pragmatic precedent as snapshot-sanitizer.ts,
 * which hardcodes the prompt strip list). Candidates to migrate into
 * EnginePathConfig later: memory tiers, 可变属性, 身体, 女主规划, 系统.设置.prompt, 图片档案.
 *
 * Path syntax mirrors snapshot-sanitizer: a "*" segment matches any object key or
 * array index (e.g. "社交.关系.*.记忆" = the 记忆 field of every relationship entry).
 */
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { EnginePathConfig } from '../pipeline/types';

export interface CardStripPaths {
  /** Gameplay-history subtrees — always deleted (never travel in a shared card). */
  gameplayHistory: string[];
  /** Secret subtrees (image transformer apiKey/endpoint) — always deleted. */
  secrets: string[];
  /** NSFW subtrees — deleted only when the card does NOT include adult content (U1). */
  nsfw: string[];
  /** Image generation history — deleted unless the author opts in (U11). */
  generationHistory: string[];
  /** Reference gallery — deleted unless the author opts in (U11). */
  referenceGallery: string[];
  /** 游戏设定 (U7①) — kept only when includedPromptSettings; re-attached after systemSettings strip. */
  promptSettings: string;
  /** 剧情规划·女主线 (U7②) — kept only when includedHeroinePlan. */
  heroinePlan: string;
  /** 剧情走向 (U7③) — kept (with progress reset) only when includedPlotDirection. */
  plotDirection: string;
  /** Engram graph — extracted to bundle.engram by the service, then cleared here (G5). */
  engramMemory: string;
  /**
   * Canon Capture's slot-owned settings book (`系统.扩展.slotWorldBooks`).
   *
   * Its own field rather than a member of `gameplayHistory`, because the handling is
   * CONDITIONAL: the book always leaves the state tree, but when the author ticks
   * "include world books" it re-enters the card through the `worldBooks` payload instead.
   * Putting it in the unconditional list would make that choice impossible to honour.
   */
  capturedSettings: string;
  /**
   * Narrative Contract (`系统.扩展.narrativeContract`, R2 2026-09-05) — the author's
   * "melody" for the world. Kept by default (it is part of "how this world is written");
   * deleted only when the author unticks it (`includedNarrativeContract`).
   */
  narrativeContract: string;
  /** Variable attributes reset to baseline (reputation→0, vitals→full) — injected so the stripper stays literal-free. */
  variableReset: {
    reputationPath: string;
    vitalPaths: string[];
    vitalCurrentField: string;
    vitalCapField: string;
  };
  /** Wholesale UI-settings parent — always deleted (promptSettings re-attached if kept). */
  systemSettings: string;
  /** Character subtree root (e.g. "角色"). Deleted from stateTree only in blank protagonist mode. */
  characterRoot: string;
}

// ─── Protagonist editability policy (P4) ─────────────────────────

/**
 * Which character fields a template-mode card may expose for player editing.
 * Paths are relative to the character root. The stripper/UI are pack-agnostic;
 * the literals live here (snapshot-sanitizer precedent).
 */
export interface ProtagonistPolicy {
  /** Character subtree root (e.g. "角色"). */
  characterRoot: string;
  /** Player-name path relative to characterRoot (e.g. "基础信息.姓名") — fixed-mode non-empty check. */
  playerNameRelPath: string;
  /** Safe editable prefixes (no derivation impact). */
  editableWhitelist: string[];
  /** Never editable (derived / gameplay artifacts). */
  editableBlacklist: string[];
  /** Editable only with a derivation warning (trigger attribute recompute when modifiers exist). */
  editableGray: string[];
}

export function buildDefaultProtagonistPolicy(p: EnginePathConfig = DEFAULT_ENGINE_PATHS): ProtagonistPolicy {
  const root = p.characterBaseInfo.split('.')[0]; // 角色
  return {
    characterRoot: root,
    playerNameRelPath: p.playerName.slice(root.length + 1), // 基础信息.姓名
    editableWhitelist: ['基础信息.姓名', '基础信息.年龄', '基础信息.性别', '基础信息.特质', '基础信息.外貌', '背包'],
    editableBlacklist: ['属性', '可变属性', '效果', '图片档案', '身体'],
    editableGray: ['身份.先天六维', '身份.出身', '身份.天赋'],
  };
}

/** Join a relationship-list path with an NPC field as a wildcard path: "社交.关系.*.<field>". */
function npcField(relationships: string, field: string): string {
  return `${relationships}.*.${field}`;
}

/**
 * Assemble the default card strip/keep/reset paths from an EnginePathConfig.
 * Called at the composition root (main.ts) and injected into GameCardExportService.
 */
export function buildDefaultCardStripPaths(p: EnginePathConfig = DEFAULT_ENGINE_PATHS): CardStripPaths {
  const rel = p.relationships;
  const npc = p.npcFieldNames;
  return {
    gameplayHistory: [
      p.roundNumber,                              // 元数据.回合序号 — turn counter is play progress, not world setup (schema default 0 restored on import)
      p.narrativeHistory,                         // 元数据.叙事历史
      p.reasoningHistory,                         // 元数据.推理历史
      p.storyPlan,                                // 元数据.剧情规划
      p.preRoundSnapshot,                         // 元数据.上次对话前快照
      '元数据.当前行动选项',
      '记忆.短期', '记忆.中期', '记忆.长期', '记忆.隐式中期',
      p.statusEffects,                            // 角色.效果
      p.worldEvents,                              // 社交.事件.事件记录 (OD6: 全剥离)
      npcField(rel, npc.memory),                  // 社交.关系.*.记忆
      npcField(rel, npc.privateChatHistory),      // 社交.关系.*.私聊历史
      p.heartbeatHistory,                         // 世界.状态.心跳.历史
      p.lastHeartbeatRound,                       // 世界.状态.心跳.上次心跳回合序号
      p.heartbeatLastRun,                         // 世界.状态.心跳.上次执行时间
      '系统.actionOptions',
      '系统.扩展.image.tasks',                    // image task queue (runtime; positive/negative prompts may carry NSFW tags) — F3
    ],
    secrets: [
      '系统.扩展.image.config',                   // transformer apiKey/endpoint (snapshot-sanitizer.ts:87-89)
    ],
    nsfw: [
      '角色.身体',
      npcField(rel, npc.privacyProfile),          // 社交.关系.*.私密信息
      '角色.图片档案.香闺秘档',                   // player NSFW part images
      npcField(rel, '图片档案.香闺秘档'),         // NPC NSFW part images
    ],
    generationHistory: [
      '角色.图片档案.生图历史',
      npcField(rel, '图片档案.生图历史'),
      '系统.扩展.image.sceneArchive.生图历史',
    ],
    referenceGallery: [
      '系统.扩展.image.referenceLibrary',
    ],
    promptSettings: '系统.设置.prompt',
    heroinePlan: '元数据.女主规划',
    plotDirection: p.plotDirection,               // 元数据.剧情导向
    engramMemory: p.engramMemory,                 // 系统.扩展.engramMemory
    capturedSettings: p.slotWorldBooks,           // 系统.扩展.slotWorldBooks
    narrativeContract: p.narrativeContract,       // 系统.扩展.narrativeContract
    variableReset: {
      reputationPath: p.reputation,               // 角色.可变属性.声望
      vitalPaths: [p.vitalHealth, p.vitalEnergy], // 角色.可变属性.体力 / 精力
      vitalCurrentField: '当前',
      vitalCapField: '上限',
    },
    systemSettings: '系统.设置',
    characterRoot: p.characterBaseInfo.split('.')[0], // 角色
  };
}
