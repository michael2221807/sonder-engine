/**
 * Referenced-image collection lock (refactor R3, step 0).
 *
 * `collectAssetIdsFromTree` decides which cached images a backup carries and which a cleanup may delete. The ids go
 * into a Set, and the Set's insertion order is the order `exportByIds` exports the blobs in, which is the byte
 * layout of the backup bundle. So the snapshot stores `[...ids]` in order, for four trees under both values of
 * `includeReferenceAssets`. Moving the function to `image/asset-refs.ts` must leave every file unchanged.
 */
import { describe, it, expect } from 'vitest';
import { _testExports } from '../persistence/backup-service';

const { collectAssetIdsFromTree } = _testExports;
const SNAPSHOT_DIR = '__snapshots__/asset-refs';
const UNDEFINED_MARK = '__undefined__';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

type Json = Record<string, unknown>;

/** Every place the collector reads, in a layout where the visiting order is visible in the ids. */
const FULL_TREE: Json = {
  角色: {
    图片档案: {
      已选头像图片ID: 'p_avatar', 已选立绘图片ID: 'p_portrait', 已选背景图片ID: 'p_bg', 最近生图结果: 'p_last',
      生图历史: [{ id: 'p_h1' }, { id: 'p_h2' }, { id: 'p_last' }],
      香闺秘档: { 胸部: { assetId: 'p_sec_breast', id: 'p_sec_breast_id' }, 小穴: { assetId: 'p_sec_vagina' } },
    },
  },
  社交: {
    关系: [
      {
        名称: 'A',
        图片档案: {
          已选头像图片ID: 'a_avatar', 已选立绘图片ID: 'a_portrait', 已选背景图片ID: '', 最近生图结果: 'a_h1',
          生图历史: [{ id: 'a_h1' }, { id: 'a_h2' }],
          香闺秘档: { 屁穴: { assetId: 'a_sec_anus' } },
        },
      },
      { 名称: 'B', 图片档案: { 已选头像图片ID: 'b_avatar', 生图历史: [{ id: 'b_h1' }, { id: 'p_h1' }] } },
    ],
  },
  系统: {
    扩展: {
      image: {
        sceneArchive: { 当前壁纸图片ID: 's_wall', 最近生图结果: 's_last', 生图历史: [{ id: 's_h1' }, { id: 's_last' }] },
        tasks: [
          { providerMeta: { reference: { sourceAssetIds: ['t_ref1', '', 't_ref2'], sourceAssetId: 't_ref_legacy' } } },
          { providerMeta: { reference: { sourceAssetIds: ['t_ref2', 'a_avatar'] } } },
        ],
        referenceLibrary: [{ assetId: 'lib_1' }, { assetId: 'lib_2' }, { assetId: 't_ref1' }],
      },
    },
  },
};

/** Whitespace, duplicates, wrong types, holes and wrong shapes: what a damaged or hand-edited tree holds. */
const ODD_TREE: Json = {
  角色: {
    图片档案: {
      已选头像图片ID: '  padded  ', 已选立绘图片ID: 42, 已选背景图片ID: null, 最近生图结果: '   ',
      生图历史: [null, 'string', { id: 'dup' }, { id: 'dup' }, { id: ' dup ' }, { id: { nested: 'x' } }, { noId: true }],
      香闺秘档: { 胸部: null, 小穴: 'text', 屁穴: { assetId: ['not', 'a', 'string'] } },
    },
  },
  社交: {
    关系: [
      null,
      'not an npc',
      { 名称: 'C', 图片档案: [] },
      { 名称: 'D', 图片档案: { 已选头像图片ID: 'd_avatar', 生图历史: 'not an array' } },
      { 名称: 'E' },
    ],
  },
  系统: {
    扩展: {
      image: {
        sceneArchive: { 当前壁纸图片ID: 'dup', 生图历史: [null, { id: 's_odd' }] },
        tasks: [null, 'x', {}, { providerMeta: {} }, { providerMeta: { reference: { sourceAssetIds: 'not an array', sourceAssetId: 'legacy_only' } } }],
        referenceLibrary: [null, { assetId: '' }, { assetId: 'lib_odd' }],
      },
    },
  },
};

/** The old single-value reference format next to the new array, and the scene archive without a history. */
const LEGACY_TREE: Json = {
  角色: {},
  社交: { 关系: [{ 名称: 'F', 图片档案: { 最近生图结果: 'f_last', 生图历史: [] } }] },
  系统: {
    扩展: {
      image: {
        sceneArchive: { 当前壁纸图片ID: 'legacy_wall' },
        tasks: [
          { providerMeta: { reference: { sourceAssetId: 'legacy_1' } } },
          { providerMeta: { reference: { sourceAssetIds: ['new_1', 'new_2'], sourceAssetId: 'legacy_1' } } },
        ],
        referenceLibrary: [{ assetId: 'lib_legacy' }],
      },
    },
  },
};

const EMPTY_TREE: Json = {};

const TREES: Record<string, Json> = { full: FULL_TREE, odd: ODD_TREE, legacy: LEGACY_TREE, empty: EMPTY_TREE };

describe('collectAssetIdsFromTree · insertion order lock', () => {
  it('four trees under both reference-library flags', async () => {
    const table: Record<string, { withoutReferenceLibrary: string[]; withReferenceLibrary: string[]; seeded: string[] }> = {};
    for (const [name, tree] of Object.entries(TREES)) {
      const plain = new Set<string>();
      collectAssetIdsFromTree(tree, plain);
      const withLib = new Set<string>();
      collectAssetIdsFromTree(tree, withLib, true);
      // A Set that already holds ids keeps their position: the collector must only append new ones.
      const seeded = new Set<string>(['seed_1', 'p_h2']);
      collectAssetIdsFromTree(tree, seeded, true);
      table[name] = { withoutReferenceLibrary: [...plain], withReferenceLibrary: [...withLib], seeded: [...seeded] };
    }
    await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/trees.json`);
  });
});
