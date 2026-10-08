/**
 * Path-contract behaviour lock (refactor R4, step 0): the path tables and what they strip.
 *
 * Locks, byte for byte in `__snapshots__/path-contract/<name>.json`:
 *  - the values `DEFAULT_ENGINE_PATHS` already had (new keys may be added, these may not change);
 *  - `PREFERENCE_PATHS`, the card strip paths and the protagonist policy;
 *  - the prompt-privacy boundary: `stringifySnapshotForPrompt` (NSFW on and off), `makeNsfwStripReplacer` and the
 *    assistant `AttachmentBuilder` strip, run over a tree that holds a value at every stripped path AND at the
 *    paths next to them that must stay.
 *
 * The strip lists below are written out here on purpose, independent of the module constants.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_PATHS, PREFERENCE_PATHS } from './types';
import { buildDefaultCardStripPaths, buildDefaultProtagonistPolicy } from '../export/card-export-paths';
import { makeNsfwStripReplacer, stringifySnapshotForPrompt } from '../memory/snapshot-sanitizer';
import { AttachmentBuilder } from '../services/assistant/attachment-builder';
import type { StateManager } from '../core/state-manager';
import { createMockStateManager } from '../__test-utils__/state-manager.mock';
import { recordOutcome, serializeContract } from '../__test-utils__/path-contract';

const DIR = '__snapshots__/path-contract';

/** Every key `DEFAULT_ENGINE_PATHS` had at 0c152a8 (written out; new keys are not in this list). */
const EXISTING_KEYS = [
  'roundNumber', 'narrativeHistory', 'gameTime', 'playerName', 'playerLocation', 'characterBaseInfo',
  'characterAttributes', 'characterAge', 'characterGender', 'characterOccupation', 'characterDescription',
  'characterTraits', 'characterOrigin', 'characterTalentTier', 'characterInnateStats', 'inventoryItems',
  'inventoryCurrency', 'heartbeatConfig', 'heartbeatEnabled', 'heartbeatPeriod', 'lastHeartbeatRound',
  'heartbeatHistory', 'heartbeatLastRun', 'heartbeatHistoryLimit', 'heartbeatForgetRounds', 'npcDemotionThreshold',
  'worldEvents', 'relationships', 'worldDescription', 'weather', 'festival', 'environmentTags', 'engramMemory',
  'npcList', 'locations', 'vitalHealth', 'vitalEnergy', 'statusEffects', 'reputation', 'talents', 'gameTimeHour',
  'gameTimeMinute', 'gameTimeFieldNames', 'preRoundSnapshot', 'slotWorldBooks', 'settingCaptureLast',
  'storageHealth', 'narrativeContract', 'characterVectors', 'plotVector', 'explorationRecord', 'reasoningHistory',
  'storyPlan', 'plotDirection', 'memoryMidTerm', 'memoryLongTerm', 'bookmarkedRounds', 'locationFieldNames',
  'locationPathSeparator', 'worldEventFieldNames', 'worldSelection', 'npcTypeExclude', 'npcTypeKey',
  'npcFieldNames',
] as const;

/** The npcFieldNames keys at 0c152a8 (a new key may be added to the object; these may not change). */
const EXISTING_NPC_FIELD_KEYS = [
  'name', 'type', 'gender', 'age', 'location', 'affinity', 'description', 'appearance', 'bodyDescription',
  'outfitStyle', 'background', 'innerThought', 'currentActivity', 'personalityTraits', 'memory',
  'privateChatHistory', 'privacyProfile', 'memorySummaries', 'isPresent', 'isMajorRole', 'attention',
  'relationshipStatus', 'corePersonality', 'affinityBreakthrough', 'relationshipBreakthrough',
  'relationshipNetwork', 'lastInteractionTime', 'lastMainRoundUpdate', 'deceased', 'heartbeatLock',
] as const;

describe('path tables', () => {
  it('engine-paths-existing', async () => {
    const paths = DEFAULT_ENGINE_PATHS as unknown as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of EXISTING_KEYS) picked[k] = paths[k];
    const npc = DEFAULT_ENGINE_PATHS.npcFieldNames as unknown as Record<string, unknown>;
    const pickedNpc: Record<string, unknown> = {};
    for (const k of EXISTING_NPC_FIELD_KEYS) pickedNpc[k] = npc[k];
    picked.npcFieldNames = pickedNpc;
    await expect(serializeContract(picked)).toMatchFileSnapshot(`${DIR}/engine-paths-existing.json`);
  });

  it('preference-paths', async () => {
    await expect(serializeContract(PREFERENCE_PATHS)).toMatchFileSnapshot(`${DIR}/preference-paths.json`);
  });

  it('card-strip-paths', async () => {
    await expect(serializeContract(buildDefaultCardStripPaths())).toMatchFileSnapshot(`${DIR}/card-strip-paths.json`);
  });

  it('protagonist-policy', async () => {
    await expect(serializeContract(buildDefaultProtagonistPolicy())).toMatchFileSnapshot(`${DIR}/protagonist-policy.json`);
  });
});

// ─── Prompt privacy boundary ──────────────────────────────────────

/** Paths that are always stripped from GAME_STATE_JSON (`*` = any array index). */
const ALWAYS_STRIPPED = [
  '系统.扩展.plotVector', '元数据.叙事历史', '元数据.上次对话前快照', '元数据.当前行动选项', '元数据.推理历史',
  '元数据.剧情规划', '元数据.剧情导向', '元数据.收藏楼层', '记忆.短期', '记忆.中期', '记忆.长期', '记忆.隐式中期',
  '系统.扩展.engramMemory', '系统.扩展.image', '系统.扩展.slotWorldBooks', '系统.扩展.settingCaptureLast',
  '系统.扩展.storageHealth', '系统.扩展.narrativeContract', '系统.扩展.characterVectors', '系统.设置',
  '系统.actionOptions', '世界.状态.心跳', '角色.图片档案', '社交.关系.*.图片档案', '社交.关系.*.私聊历史',
  '社交.关系.*.总结记忆', '社交.关系.*.上次主回合更新回合', 'NPC列表',
];
/** Stripped only while NSFW is off. */
const NSFW_STRIPPED = ['社交.关系.*.私密信息', '角色.身体'];
/** Paths next to the stripped ones that must stay in the prompt. */
const KEPT_NEIGHBOURS = [
  '系统.扩展.语义记忆', '系统.探索记录', '系统.nsfwMode', '系统.nsfwGenderFilter', '系统.npcDemotionThreshold',
  '系统.已生成NPC地点', '系统.扩展.image.config', '系统.扩展.其他', '元数据.女主规划', '元数据.回合序号',
  '世界.状态.其他键', '世界.状态.天气', '世界.描述', '角色.基础信息.姓名', '角色.身体描述', '角色.属性',
  '记忆.语义', 'NPC列表2', '社交.关系.*.名称', '社交.关系.*.记忆', '社交.关系.*.身体部位',
  '社交.关系.*.图片档案备注', '社交.关系.*.位置', '社交.事件.事件记录',
];

type Node = Record<string, unknown> | unknown[];

function setAt(root: Record<string, unknown>, path: string, idx: number): void {
  const segs = path.split('.');
  let cur: Node = root;
  for (let i = 0; i < segs.length; i++) {
    const raw = segs[i];
    const seg = raw === '*' ? String(idx) : raw;
    const last = i === segs.length - 1;
    const bag = cur as Record<string, unknown>;
    if (last) {
      const existing = bag[seg];
      if (existing && typeof existing === 'object') return; // a deeper path already made this an object
      bag[seg] = `v:${path}@${idx}`;
      return;
    }
    let next = bag[seg];
    if (!next || typeof next !== 'object') {
      next = segs[i + 1] === '*' ? [] : {};
      bag[seg] = next;
    }
    cur = next as Node;
  }
}

function buildFullTree(nsfwMode: boolean): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const all = [...KEPT_NEIGHBOURS, ...ALWAYS_STRIPPED, ...NSFW_STRIPPED];
  // deeper paths first, so a parent that is also a leaf stays an object
  const ordered = [...all].sort((a, b) => b.split('.').length - a.split('.').length);
  for (const idx of [0, 1]) for (const p of ordered) setAt(root, p, idx);
  (root.系统 as Record<string, unknown>).nsfwMode = nsfwMode;
  return root;
}

describe('sanitizer-full', () => {
  it('stringifySnapshotForPrompt, the replacer and the attachment strip', async () => {
    const result: Record<string, unknown> = {};
    const treeOff = buildFullTree(false);
    const treeOn = buildFullTree(true);
    result.treeOff = treeOff;
    result.promptNsfwOff = stringifySnapshotForPrompt(treeOff, false);
    result.promptNsfwOn = stringifySnapshotForPrompt(treeOn, true);
    result.promptNsfwOffIndented = stringifySnapshotForPrompt(treeOff, false, 2);
    result.promptAdditional = stringifySnapshotForPrompt(treeOff, true, 0, ['世界.描述', '社交.关系.*.名称']);
    result.replacer = JSON.stringify(treeOff, makeNsfwStripReplacer());

    const specs = [
      '社交', '社交.关系', '社交.关系.0', '社交.关系.0.私密信息', '角色', '角色.身体', '角色.基础信息.姓名',
      '$.角色', '世界', '系统', '系统.扩展', '不存在.路径',
    ];
    const attach: Record<string, unknown> = {};
    for (const [label, tree] of [['nsfwOff', treeOff], ['nsfwOn', treeOn]] as const) {
      const { sm } = createMockStateManager(tree);
      const builder = new AttachmentBuilder({ stateManager: sm as unknown as StateManager, gamePack: null });
      const rows: Record<string, unknown> = {};
      for (const p of specs) rows[p] = recordOutcome(() => builder.build({ path: p, scope: 'context' }));
      attach[label] = rows;
    }
    result.attachments = attach;
    await expect(serializeContract(result)).toMatchFileSnapshot(`${DIR}/sanitizer-full.json`);
  });
});
