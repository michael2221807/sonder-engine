/**
 * Pins every R4 path constant to the literal it replaced (refactor R4, step 1).
 *
 * The expected values below were taken from the sources at 0c152a8 (`git show 0c152a8:<file>`), not from the
 * constants. A constant that drifts from its literal fails here; a call site that picks the wrong constant is caught
 * by the byte-for-byte snapshots and the back-substitution check of each step. The whole set is also written to
 * `__snapshots__/path-contract/constants.json`, which the back-substitution script reads.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from './types';
import { SYSTEM_PATHS } from './system-paths';
import * as TIANMING from '../pack/tianming-coupling';
import { serializeContract } from '../__test-utils__/path-contract';

describe('SYSTEM_PATHS', () => {
  it('equals the literals used before R4', () => {
    expect(SYSTEM_PATHS).toEqual({
      settings: '系统.设置',
      promptSettings: '系统.设置.prompt',
      bodyPolish: '系统.设置.bodyPolish',
      presenceEnabled: '系统.设置.social.presenceEnabled',
      cotEnabled: '系统.设置.cot.enabled',
      cotJudgeEnabled: '系统.设置.cot.judgeEnabled',
      cotInjectStep2: '系统.设置.cot.injectStep2',
      cotReasoningRingSize: '系统.设置.cot.reasoningRingSize',
      plotSettings: '系统.设置.plot',
      plotEnabled: '系统.设置.plot.enabled',
      plotMaxActiveThreads: '系统.设置.plot.maxActiveThreads',
      nsfwMode: '系统.nsfwMode',
      nsfwGenderFilter: '系统.nsfwGenderFilter',
      actionOptions: '系统.actionOptions',
      actionOptionsMode: '系统.actionOptions.mode',
      actionOptionsPace: '系统.actionOptions.pace',
      actionOptionsCustomPrompt: '系统.actionOptions.customPrompt',
      generatedNpcLocations: '系统.已生成NPC地点',
      image: {
        root: '系统.扩展.image',
        enabled: '系统.扩展.image.enabled',
        config: '系统.扩展.image.config',
        tasks: '系统.扩展.image.tasks',
        sceneArchive: '系统.扩展.image.sceneArchive',
        referenceLibrary: '系统.扩展.image.referenceLibrary',
      },
    });
  });
});

describe('new DEFAULT_ENGINE_PATHS keys', () => {
  it('equals the literals used before R4', () => {
    const p = DEFAULT_ENGINE_PATHS;
    expect({
      shortTermMemory: p.shortTermMemory,
      implicitMidTermMemory: p.implicitMidTermMemory,
      currentActionOptions: p.currentActionOptions,
      heroinePlan: p.heroinePlan,
      playerBody: p.playerBody,
      playerImageArchive: p.playerImageArchive,
      heartbeatRoot: p.heartbeatRoot,
      imageArchive: p.npcFieldNames.imageArchive,
    }).toEqual({
      shortTermMemory: '记忆.短期',
      implicitMidTermMemory: '记忆.隐式中期',
      currentActionOptions: '元数据.当前行动选项',
      heroinePlan: '元数据.女主规划',
      playerBody: '角色.身体',
      playerImageArchive: '角色.图片档案',
      heartbeatRoot: '世界.状态.心跳',
      imageArchive: '图片档案',
    });
  });

  it('does not collide with the environment-tag paths', () => {
    const env = [DEFAULT_ENGINE_PATHS.weather, DEFAULT_ENGINE_PATHS.festival, DEFAULT_ENGINE_PATHS.environmentTags];
    for (const v of [
      DEFAULT_ENGINE_PATHS.shortTermMemory, DEFAULT_ENGINE_PATHS.implicitMidTermMemory,
      DEFAULT_ENGINE_PATHS.currentActionOptions, DEFAULT_ENGINE_PATHS.heroinePlan, DEFAULT_ENGINE_PATHS.playerBody,
      DEFAULT_ENGINE_PATHS.playerImageArchive, DEFAULT_ENGINE_PATHS.heartbeatRoot,
    ]) {
      expect(env).not.toContain(v);
    }
  });
});

// Step 7 adds keys to the register; they are pinned in their own block below so the earlier snapshot stays as it was.
const STEP7_KEYS = ['TIANMING_SECRET_PART_CN'];
function registerWithoutStep7(): Record<string, unknown> {
  const all: Record<string, unknown> = { ...TIANMING };
  for (const k of STEP7_KEYS) delete all[k];
  return all;
}

describe('TIANMING_* register', () => {
  it('equals the literals used before R4', () => {
    const exportsOnly = registerWithoutStep7();
    expect(exportsOnly).toEqual({
      TIANMING_PRIVACY_REQUIRED_FIELDS: [
        '是否为处女/处男', '身体部位', '性格倾向', '性取向', '性癖好', '性渴望程度', '性交总次数', '性伴侣名单',
      ],
      TIANMING_PRIVACY_PARTNER_LIST_FIELD: '性伴侣名单',
      TIANMING_PRIVACY_BODY_PARTS: { field: '身体部位', nameKey: '部位名称', descriptionKey: '特征描述' },
      TIANMING_PRIVACY_REQUIRED_PART_NAMES: ['嘴', '胸部', '小穴', '屁穴'],
      TIANMING_PRIVACY_VIRGIN_FIELD: '是否为处女/处男',
      TIANMING_PRIVACY_NON_VIRGIN_FIELDS: ['初夜夺取者', '初夜时间', '初夜描述'],
      TIANMING_PLAYER_BODY_REQUIRED_FIELDS: ['身高', '体重', '三围', '敏感点', '开发度'],
      TIANMING_PLAYER_BODY_SHAPE: {
        sizes: '三围',
        sizeKeys: ['胸围', '腰围', '臀围'],
        sensitivePoints: '敏感点',
        development: '开发度',
      },
      TIANMING_PRIVACY_PLACEHOLDERS: [
        '待生成', '待ai生成', '暂无', '无', '未知', '未定义', 'tbd', 'todo', 'placeholder',
      ],
      TIANMING_GENDER_VALUES: { female: '女', male: '男' },
      TIANMING_IMAGE_ARCHIVE_KEYS: {
        secretChamber: '香闺秘档',
        generationHistory: '生图历史',
        selectedAvatarId: '已选头像图片ID',
      },
      TIANMING_VITAL_FIELDS: { current: '当前', cap: '上限' },
      TIANMING_PROTAGONIST_EDITABLE: {
        whitelist: ['基础信息.姓名', '基础信息.年龄', '基础信息.性别', '基础信息.特质', '基础信息.外貌', '背包'],
        blacklist: ['属性', '可变属性', '效果', '图片档案', '身体'],
        gray: ['身份.先天六维', '身份.出身', '身份.天赋'],
      },
      TIANMING_MEMORY_ENTRY_CONTENT_KEY: '内容',
      TIANMING_LEGACY_NPC_KEYS: {
        relationToPlayer: '与玩家关系',
        appearanceAlias: '外貌描写',
        locationAlias: '当前位置',
      },
      TIANMING_LOCATION_NPC_KEY: 'NPC',
    });
  });

  it('keeps the divergent aliases apart from the npcFieldNames entries they resemble', () => {
    const F = DEFAULT_ENGINE_PATHS.npcFieldNames;
    expect(TIANMING.TIANMING_LEGACY_NPC_KEYS.appearanceAlias).not.toBe(F.appearance);
    expect(TIANMING.TIANMING_LEGACY_NPC_KEYS.locationAlias).not.toBe(F.location);
    expect(TIANMING.TIANMING_LEGACY_NPC_KEYS.relationToPlayer).not.toBe(F.relationshipStatus);
    expect(DEFAULT_ENGINE_PATHS.locationFieldNames.npcList).toContain(TIANMING.TIANMING_LOCATION_NPC_KEY);
  });
});

describe('constants snapshot', () => {
  it('writes the whole set for the back-substitution script', async () => {
    const tianming = registerWithoutStep7();
    await expect(
      serializeContract({ SYSTEM_PATHS, TIANMING: tianming, DEFAULT_ENGINE_PATHS }),
    ).toMatchFileSnapshot('__snapshots__/path-contract/constants.json');
  });
});

describe('image subsystem register (R4 step 7)', () => {
  it('pins the secret-part names to the literals used before', () => {
    expect(TIANMING.TIANMING_SECRET_PART_CN).toEqual({ breast: '胸部', vagina: '小穴', anus: '屁穴' });
  });

  it('writes the step 7 constants for the back-substitution script', async () => {
    await expect(
      serializeContract({ TIANMING_SECRET_PART_CN: TIANMING.TIANMING_SECRET_PART_CN }),
    ).toMatchFileSnapshot('__snapshots__/path-contract/image-constants.json');
  });
});
