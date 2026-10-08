/**
 * Privacy-contract behaviour lock (refactor R4, step 0): what the NSFW validator accepts.
 *
 * About 20 profile objects go through `isPrivacyProfileComplete`, the player-body objects through
 * `isPlayerBodyComplete`, `findIncompletePrivacy` runs with all three gender filters, and `readNsfwSettings` is
 * read from the state tree and from a localStorage stub. Results are stored in
 * `pipeline/__snapshots__/path-contract/privacy-corpus.json`.
 */
import { describe, it, expect } from 'vitest';
import {
  findIncompletePrivacy,
  isPlayerBodyComplete,
  isPrivacyProfileComplete,
  readNsfwSettings,
} from './privacy-profile-validator';
import type { NsfwGenderFilter } from './privacy-profile-validator';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { StateManager } from '../core/state-manager';
import { createMockLocalStorage } from '../__test-utils__/local-storage.mock';
import { createMockStateManager } from '../__test-utils__/state-manager.mock';
import { serializeContract } from '../__test-utils__/path-contract';

type Obj = Record<string, unknown>;

function parts(descOverride: Obj = {}): Obj[] {
  const base: Obj[] = [
    { 部位名称: '嘴', 敏感度: 40, 开发度: 10, 特征描述: '唇形饱满' },
    { 部位名称: '胸部', 敏感度: 60, 开发度: 20, 特征描述: '丰满圆润' },
    { 部位名称: '小穴', 敏感度: 50, 开发度: 0, 特征描述: '粉嫩紧致' },
    { 部位名称: '屁穴', 敏感度: 30, 开发度: 0, 特征描述: '娇小紧缩' },
  ];
  return base.map((p) => ({ ...p, ...(descOverride[p.部位名称 as string] as Obj | undefined) }));
}

function virgin(over: Obj = {}): Obj {
  return {
    '是否为处女/处男': true,
    身体部位: parts(),
    性格倾向: '温顺',
    性取向: '异性恋',
    性癖好: ['被温柔对待'],
    性渴望程度: 40,
    性交总次数: 0,
    性伴侣名单: [],
    ...over,
  };
}

function nonVirgin(over: Obj = {}): Obj {
  return virgin({
    '是否为处女/处男': false,
    初夜夺取者: '前任',
    初夜时间: '三年前',
    初夜描述: '一个雨夜',
    性交总次数: 12,
    性伴侣名单: ['前任'],
    ...over,
  });
}

function without(o: Obj, key: string): Obj {
  const copy = { ...o };
  delete copy[key];
  return copy;
}

const PROFILES: Record<string, unknown> = {
  virgin: virgin(),
  nonVirgin: nonVirgin(),
  nullValue: null,
  undefinedValue: undefined,
  stringValue: 'text',
  arrayValue: [],
  emptyObject: {},
  missingPartnerList: without(virgin(), '性伴侣名单'),
  emptyKinks: virgin({ 性癖好: [] }),
  emptyPartnersNonVirgin: nonVirgin({ 性伴侣名单: [] }),
  placeholderText: virgin({ 性格倾向: '待生成' }),
  placeholderUpper: virgin({ 性取向: ' TBD ' }),
  placeholderNone: virgin({ 性格倾向: '无' }),
  blankText: virgin({ 性格倾向: '   ' }),
  nanNumber: virgin({ 性渴望程度: Number.NaN }),
  partsNotArray: virgin({ 身体部位: {} }),
  partsMissingMouth: virgin({ 身体部位: parts().filter((p) => p.部位名称 !== '嘴') }),
  partsEmptyDescription: virgin({ 身体部位: parts({ 小穴: { 特征描述: '' } }) }),
  partsPlaceholderDescription: virgin({ 身体部位: parts({ 屁穴: { 特征描述: '暂无' } }) }),
  partsExtra: virgin({ 身体部位: [...parts(), { 部位名称: '乳首', 特征描述: '粉色' }] }),
  nonVirginMissingFirstNight: without(nonVirgin(), '初夜时间'),
  nonVirginBlankFirstNight: nonVirgin({ 初夜描述: ' ' }),
  nonVirginPlaceholderFirstNight: nonVirgin({ 初夜夺取者: '未知' }),
  virginWithEmptyFirstNight: virgin({ 初夜夺取者: '' }),
  virginFlagMissing: without(virgin(), '是否为处女/处男'),
  virginFlagString: virgin({ '是否为处女/处男': 'false' }),
};

function body(over: Obj = {}): Obj {
  return {
    身高: 168,
    体重: 52,
    三围: { 胸围: 88, 腰围: 60, 臀围: 90 },
    敏感点: ['耳后'],
    开发度: { 胸部: 20 },
    ...over,
  };
}

const BODIES: Record<string, unknown> = {
  full: body(),
  nullValue: null,
  arrayValue: [],
  emptyObject: {},
  missingHeight: without(body(), '身高'),
  nullWeight: body({ 体重: null }),
  nanHeight: body({ 身高: Number.NaN }),
  stringHeight: body({ 身高: '168cm' }),
  placeholderHeight: body({ 身高: '待生成' }),
  blankHeight: body({ 身高: '  ' }),
  sizeNotObject: body({ 三围: '88-60-90' }),
  sizeArray: body({ 三围: [88, 60, 90] }),
  sizeMissingWaist: body({ 三围: { 胸围: 88, 臀围: 90 } }),
  sizeNanHip: body({ 三围: { 胸围: 88, 腰围: 60, 臀围: Number.NaN } }),
  sizeStringBust: body({ 三围: { 胸围: '88', 腰围: 60, 臀围: 90 } }),
  pointsEmpty: body({ 敏感点: [] }),
  pointsNotArray: body({ 敏感点: '耳后' }),
  devEmpty: body({ 开发度: {} }),
  devArray: body({ 开发度: ['x'] }),
  devString: body({ 开发度: 'x' }),
};

function npc(name: unknown, gender: unknown, privacy: unknown): Obj {
  const o: Obj = { 名称: name };
  if (gender !== undefined) o['性别'] = gender;
  if (privacy !== undefined) o['私密信息'] = privacy;
  return o;
}

const ROSTER: unknown[] = [
  npc('甲', '女', virgin()),
  npc('乙', '男', undefined),
  npc('丙', 'female', {}),
  npc('丁', 'MALE', nonVirgin()),
  npc('戊', undefined, undefined),
  npc('  己  ', '女', undefined),
  npc('', '女', undefined),
  npc('甲', '女', undefined),
  npc(7, '男', undefined),
  null,
  'not-an-object',
  npc('庚', '其他', undefined),
];

const FILTERS: NsfwGenderFilter[] = ['all', 'male', 'female'];

describe('privacy-corpus', () => {
  it('validators, the roster scan and the settings reader', async () => {
    const result: Obj = {};

    const profileRows: Obj = {};
    for (const [id, value] of Object.entries(PROFILES)) profileRows[id] = isPrivacyProfileComplete(value);
    result.isPrivacyProfileComplete = profileRows;

    const bodyRows: Obj = {};
    for (const [id, value] of Object.entries(BODIES)) bodyRows[id] = isPlayerBodyComplete(value);
    result.isPlayerBodyComplete = bodyRows;

    const scan: Obj = {};
    for (const [label, playerBody] of [['bodyFull', body()], ['bodyMissing', undefined], ['bodyPartial', body({ 身高: null })]] as const) {
      const { sm } = createMockStateManager({
        社交: { 关系: ROSTER },
        角色: playerBody === undefined ? {} : { 身体: playerBody },
      });
      const rows: Obj = {};
      for (const filter of FILTERS) {
        const report = findIncompletePrivacy(sm as unknown as StateManager, DEFAULT_ENGINE_PATHS, filter);
        rows[filter] = { npcNames: report.npcNames, playerBodyMissing: report.playerBodyMissing, total: report.total };
      }
      scan[label] = rows;
    }
    // no roster at all
    {
      const { sm } = createMockStateManager({ 角色: { 身体: body() } });
      const report = findIncompletePrivacy(sm as unknown as StateManager, DEFAULT_ENGINE_PATHS, 'all');
      scan.noRoster = { npcNames: report.npcNames, playerBodyMissing: report.playerBodyMissing, total: report.total };
    }
    result.findIncompletePrivacy = scan;

    const settings: Obj = {};
    const treeCases: Array<[string, Obj, Record<string, string>]> = [
      ['stateBoth', { 系统: { nsfwMode: true, nsfwGenderFilter: 'male' } }, { aga_nsfw_settings: '{"nsfwMode":false,"nsfwGenderFilter":"all"}' }],
      ['stateModeOnly', { 系统: { nsfwMode: false } }, { aga_nsfw_settings: '{"nsfwMode":true,"nsfwGenderFilter":"all"}' }],
      ['stateFilterOnly', { 系统: { nsfwGenderFilter: 'all' } }, { aga_nsfw_settings: '{"nsfwMode":true,"nsfwGenderFilter":"male"}' }],
      ['stateInvalid', { 系统: { nsfwMode: 'yes', nsfwGenderFilter: 'both' } }, { aga_nsfw_settings: '{"nsfwMode":true,"nsfwGenderFilter":"male"}' }],
      ['localStorageOnly', {}, { aga_nsfw_settings: '{"nsfwMode":true,"nsfwGenderFilter":"all"}' }],
      ['localStorageInvalid', {}, { aga_nsfw_settings: '{"nsfwMode":"on","nsfwGenderFilter":"x"}' }],
      ['localStorageBrokenJson', {}, { aga_nsfw_settings: '{not json' }],
      ['nothing', {}, {}],
    ];
    for (const [id, tree, store] of treeCases) {
      const ls = createMockLocalStorage(store);
      ls.install();
      try {
        const { sm } = createMockStateManager(tree);
        settings[id] = readNsfwSettings(sm as unknown as StateManager);
      } finally {
        ls.restore();
      }
    }
    result.readNsfwSettings = settings;

    await expect(serializeContract(result)).toMatchFileSnapshot('../pipeline/__snapshots__/path-contract/privacy-corpus.json');
  });
});

it('keeps the harness honest: the corpus holds both complete and incomplete profiles', () => {
  expect(isPrivacyProfileComplete(PROFILES.virgin)).toBe(true);
  expect(isPrivacyProfileComplete(PROFILES.emptyObject)).toBe(false);
});
