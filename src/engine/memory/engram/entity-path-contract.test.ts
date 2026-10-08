/**
 * Engram path-contract behaviour lock (refactor R4, step 0).
 *
 * `EntityBuilder.build` over a roster (ordinary / key / untyped NPCs, both relationship-status keys, locations,
 * with `includeAllNpcTypes` on and off), `EventBuilder.build` over game-time shapes, and the default path fields
 * `UnifiedRetriever` and `EngramEditor` fall back to when they are given no overrides. Stored byte for byte in
 * `pipeline/__snapshots__/path-contract/entity-builder.json`.
 */
import { describe, it, expect } from 'vitest';
import { EntityBuilder } from './entity-builder';
import type { EntityBuilderPaths } from './entity-builder';
import { EventBuilder } from './event-builder';
import type { EngramEventNode } from './event-builder';
import { EngramEditor } from './engram-editor';
import { UnifiedRetriever } from './unified-retriever';
import type { StateManager } from '../../core/state-manager';
import type { AIResponse } from '../../ai/types';
import { createMockStateManager } from '../../__test-utils__/state-manager.mock';
import { serializeContract } from '../../__test-utils__/path-contract';

type Obj = Record<string, unknown>;

const BUILDER_PATHS: EntityBuilderPaths = {
  playerName: '角色.基础信息.姓名',
  relationships: '社交.关系',
  npcDescriptionFields: { background: '背景', appearance: '外貌描述', description: '描述' },
};

const ROSTER: unknown[] = [
  { 名称: '甲', 类型: '重点', 关系状态: '挚友', 与玩家关系: '旧称', 位置: '茶馆', 背景: '出身江南', 外貌描述: '清瘦' },
  { 名称: '乙', 类型: '普通', 关系状态: '路人', 位置: '街口', 描述: '卖花的' },
  { 名称: '丙', 与玩家关系: '师徒', 位置: '山门', 背景: '', 外貌描述: '  ' , 描述: '看门人' },
  { 名称: '  丁  ', 类型: '同伴' },
  { 名称: '', 类型: '重点' },
  { 名称: 5, 类型: '重点' },
  { 类型: '重点' },
  null,
  '字符串',
  { 名称: '甲', 类型: '重点', 位置: '重复' },
  { 名称: '戊', 类型: '普通', 关系状态: '', 与玩家关系: '债主' },
];

function ev(id: string, over: Partial<EngramEventNode>): EngramEventNode {
  return {
    id,
    subject: '玩家',
    action: 'narrative',
    tags: [],
    text: '',
    summary: '',
    structured_kv: { event: '', role: [], location: [], time_anchor: '', causality: '', logic: [] },
    is_embedded: false,
    ...over,
  };
}

const EVENTS: EngramEventNode[] = [
  ev('e1', {
    roundNumber: 2,
    structured_kv: { event: 'x', role: ['玩家', '甲', '新人物'], location: ['青城山·玉虚宫', '茶馆'], time_anchor: '', causality: '', logic: [] },
  }),
  ev('e2', { roundNumber: 5, subject: 'player', object: '己', location: '山门' }),
];

function response(text: string, roles?: string[]): AIResponse {
  return { text, commands: [], raw: '', ...(roles ? { midTermMemory: { 相关角色: roles } } : {}) } as AIResponse;
}

const TIME_SHAPES: Record<string, unknown> = {
  full: { 年: 1, 月: 3, 日: 5, 小时: 14, 分钟: 20 },
  dateOnly: { 年: 2, 月: 1, 日: 9 },
  partial: { 月: 4 },
  hourOnly: { 年: 1, 月: 1, 日: 1, 小时: 3 },
  strings: { 年: '1', 月: '2', 日: '3' },
  empty: {},
  notObject: '第一天',
  missing: undefined,
};

describe('entity-builder', () => {
  it('EntityBuilder, EventBuilder and the default path fields', async () => {
    const result: Obj = {};

    const entityRows: Obj = {};
    for (const includeAll of [false, true]) {
      for (const withPlayer of [true, false]) {
        const tree: Obj = { 社交: { 关系: ROSTER } };
        if (withPlayer) tree.角色 = { 基础信息: { 姓名: '林' } };
        const { sm } = createMockStateManager(tree);
        const out = new EntityBuilder().build(EVENTS, sm as unknown as StateManager, BUILDER_PATHS, {
          includeAllNpcTypes: includeAll,
        });
        entityRows[`includeAll=${includeAll},player=${withPlayer}`] = out;
      }
    }
    {
      const { sm } = createMockStateManager({ 社交: { 关系: ROSTER }, 角色: { 基础信息: { 姓名: '林' } } });
      entityRows['noOptions'] = new EntityBuilder().build([], sm as unknown as StateManager, BUILDER_PATHS);
    }
    {
      const { sm } = createMockStateManager({ 社交: { 关系: '不是数组' } });
      entityRows['relationshipsNotArray'] = new EntityBuilder().build([], sm as unknown as StateManager, BUILDER_PATHS);
    }
    result.entityBuilder = entityRows;

    const eventRows: Obj = {};
    for (const [id, time] of Object.entries(TIME_SHAPES)) {
      const { sm } = createMockStateManager({
        角色: { 基础信息: { 姓名: '林', 当前位置: '青城山' } },
        世界: time === undefined ? {} : { 时间: time },
      });
      const built = new EventBuilder().build(response('你点了点头。接着离开。', ['甲', ' 乙 ']), sm, 7, {
        playerName: '角色.基础信息.姓名',
        playerLocation: '角色.基础信息.当前位置',
        gameTime: '世界.时间',
      });
      eventRows[id] = built.map((e) => ({ ...e, id: '<id>' }));
    }
    result.eventBuilder = eventRows;

    const { sm: bare } = createMockStateManager({});
    const bareSm = bare as unknown as StateManager;
    const retriever = new UnifiedRetriever({} as never, {} as never) as unknown as Obj;
    const retrieverWithPaths = new UnifiedRetriever({} as never, {} as never, undefined, undefined, undefined, undefined, {
      engramMemory: 'X.a',
    }) as unknown as Obj;
    const editor = new EngramEditor(bareSm, {} as never) as unknown as Obj;
    const editorWithOverrides = new EngramEditor(bareSm, {} as never, { npcNameField: 'N', relationships: 'R.r' }) as unknown as Obj;
    const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.map((k) => [k, o[k]]));
    result.unifiedRetrieverDefaults = pick(retriever, ['engramPath', 'roundNumberPath']);
    result.unifiedRetrieverPartial = pick(retrieverWithPaths, ['engramPath', 'roundNumberPath']);
    const editorKeys = [
      'engramPath', 'roundNumberPath', 'relationshipsPath', 'locationsPath', 'npcNameField', 'npcTypeField',
      'npcTypeExclude', 'locationNameField',
    ];
    result.engramEditorDefaults = pick(editor, editorKeys);
    result.engramEditorPartial = pick(editorWithOverrides, editorKeys);

    await expect(serializeContract(result)).toMatchFileSnapshot('../../pipeline/__snapshots__/path-contract/entity-builder.json');
  });

  it('the harness builds a non-empty roster', () => {
    const { sm } = createMockStateManager({ 社交: { 关系: ROSTER } });
    const out = new EntityBuilder().build([], sm as unknown as StateManager, BUILDER_PATHS);
    expect(out.length).toBeGreaterThan(2);
  });
});
