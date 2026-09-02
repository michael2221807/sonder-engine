/**
 * name-inserter-helpers — 纯函数单测（收割 / 排序 / 过滤 / 插入）。
 *
 * 覆盖重点是「面板不会骗人」的几条：脏数据不产出空 chip、翻转方向不把空值浮上来、
 * 连点插入的光标能接力、附近排序的三环判定。
 */
import { describe, it, expect } from 'vitest';
import {
  harvestNpcEntries,
  harvestLocationEntries,
  sortNpcEntries,
  sortLocEntries,
  matchesQuery,
  insertNameAt,
} from './name-inserter-helpers';

describe('harvestNpcEntries', () => {
  it('读出名称/在场/好感/最后互动/位置', () => {
    const out = harvestNpcEntries([
      { 名称: '沈砚舟', 是否在场: true, 好感度: 72, 最后互动时间: '第12回合', 位置: '北市·当铺' },
    ]);
    expect(out).toEqual([
      { name: '沈砚舟', present: true, affinity: 72, lastInteraction: '第12回合', location: '北市·当铺' },
    ]);
  });

  it('丢弃无名称/空名称/非对象行，并按首次出现去重', () => {
    const out = harvestNpcEntries([
      null,
      'not-an-object',
      { 名称: '' },
      { 名称: '   ' },
      { 描述: '无名之辈' },
      { 名称: '柳如霜', 好感度: 41 },
      { 名称: '柳如霜', 好感度: 99 },
    ]);
    expect(out.map((n) => n.name)).toEqual(['柳如霜']);
    expect(out[0].affinity).toBe(41);
  });

  it('非数组输入返回空数组（未载入存档）', () => {
    expect(harvestNpcEntries(undefined)).toEqual([]);
    expect(harvestNpcEntries({ 名称: 'x' })).toEqual([]);
  });

  it('好感度非数字时不伪造 0', () => {
    const [row] = harvestNpcEntries([{ 名称: '阿箬', 好感度: '很高' }]);
    expect(row.affinity).toBeUndefined();
  });
});

describe('harvestLocationEntries', () => {
  const locs = [
    { 名称: '北市·当铺', 连接: ['北市大街'], 上级: '北市' },
    { 名称: '北市大街', 连接: [], 上级: '北市' },
    { 名称: '西巷酒垆', 连接: ['北市大街'], 上级: '西巷' },
    { 名称: '寒山寺', 连接: [] },
  ];

  it('标出当前所在地并计算三环距离', () => {
    const out = harvestLocationEntries(locs, ['北市·当铺', '北市大街', '西巷酒垆'], '北市·当铺');
    const byName = Object.fromEntries(out.map((l) => [l.name, l]));
    expect(byName['北市·当铺'].here).toBe(true);
    expect(byName['北市·当铺'].proximity).toBe(0);
    expect(byName['北市大街'].proximity).toBe(1); // 直连 + 同上级
    expect(byName['西巷酒垆'].proximity).toBe(2); // 已探索但不相邻
    expect(byName['寒山寺'].proximity).toBe(3);   // 未探索且不相邻
    expect(byName['寒山寺'].explored).toBe(false);
  });

  it('反向连接也算相邻（对方连到我）', () => {
    const out = harvestLocationEntries(
      [{ 名称: 'A', 连接: [] }, { 名称: 'B', 连接: ['A'] }],
      [],
      'A',
    );
    expect(out.find((l) => l.name === 'B')?.proximity).toBe(1);
  });

  it('玩家位置写法更细时仍能匹配到地点条目', () => {
    const out = harvestLocationEntries([{ 名称: '当铺', 连接: [] }], [], '北市·当铺');
    expect(out[0].here).toBe(true);
  });

  it('没有玩家位置时无人是 here，且不炸', () => {
    const out = harvestLocationEntries(locs, undefined, undefined);
    expect(out.every((l) => !l.here)).toBe(true);
    expect(out).toHaveLength(4);
  });

  it('脏数据（空名/重名/非对象）被过滤', () => {
    const out = harvestLocationEntries([null, { 名称: '' }, { 名称: '渡口' }, { 名称: '渡口' }], [], '');
    expect(out.map((l) => l.name)).toEqual(['渡口']);
  });
});

describe('sortNpcEntries', () => {
  const list = [
    { name: '苏婉', present: false, affinity: 88, lastInteraction: '09' },
    { name: '沈砚舟', present: true, affinity: 72, lastInteraction: '12' },
    { name: '阿箬', present: true, affinity: undefined, lastInteraction: undefined },
  ];

  it('present：在场优先，同组按名称（localeCompare = 拼音序，阿 < 沈）', () => {
    expect(sortNpcEntries(list, 'present', true).map((n) => n.name)).toEqual(['阿箬', '沈砚舟', '苏婉']);
  });

  it('present 反向：不在场优先', () => {
    expect(sortNpcEntries(list, 'present', false)[0].name).toBe('苏婉');
  });

  it('affinity：高→低；无好感的行两个方向都沉底', () => {
    expect(sortNpcEntries(list, 'affinity', true).map((n) => n.name)).toEqual(['苏婉', '沈砚舟', '阿箬']);
    expect(sortNpcEntries(list, 'affinity', false).map((n) => n.name)).toEqual(['沈砚舟', '苏婉', '阿箬']);
  });

  it('recent：最近互动优先，无记录沉底', () => {
    expect(sortNpcEntries(list, 'recent', true).map((n) => n.name)).toEqual(['沈砚舟', '苏婉', '阿箬']);
    expect(sortNpcEntries(list, 'recent', false)[2].name).toBe('阿箬');
  });

  it('不修改入参数组', () => {
    const copy = [...list];
    sortNpcEntries(list, 'name', false);
    expect(list).toEqual(copy);
  });
});

describe('sortLocEntries', () => {
  const list = [
    { name: '寒山寺', here: false, explored: false, proximity: 3 as const },
    { name: '北市·当铺', here: true, explored: true, proximity: 0 as const },
    { name: '西巷酒垆', here: false, explored: true, proximity: 2 as const },
  ];

  it('near：由近及远', () => {
    expect(sortLocEntries(list, 'near', true).map((l) => l.name)).toEqual(['北市·当铺', '西巷酒垆', '寒山寺']);
    expect(sortLocEntries(list, 'near', false)[0].name).toBe('寒山寺');
  });

  it('explored：已探索优先', () => {
    expect(sortLocEntries(list, 'explored', true)[2].name).toBe('寒山寺');
  });

  it('name：纯名称序', () => {
    const asc = sortLocEntries(list, 'name', true).map((l) => l.name);
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b)));
  });
});

describe('matchesQuery', () => {
  it('空查询全过', () => {
    expect(matchesQuery('   ', '沈砚舟')).toBe(true);
  });
  it('任一字段命中即可（人物可按位置搜）', () => {
    expect(matchesQuery('当铺', '沈砚舟', '北市·当铺')).toBe(true);
    expect(matchesQuery('当铺', '沈砚舟', undefined)).toBe(false);
  });
  it('英文大小写不敏感', () => {
    expect(matchesQuery('ALICE', 'alice')).toBe(true);
  });
});

describe('insertNameAt', () => {
  it('插到光标处并把光标推到名字之后', () => {
    const r = insertNameAt('我去找。', 3, 3, '沈砚舟');
    expect(r.text).toBe('我去找沈砚舟。');
    expect(r.caret).toBe(6);
  });

  it('有选区时替换选区', () => {
    const r = insertNameAt('我去找他。', 3, 4, '柳如霜');
    expect(r.text).toBe('我去找柳如霜。');
  });

  it('连点两次可接力（用上一次的 caret 继续插）', () => {
    const first = insertNameAt('', 0, 0, '沈砚舟');
    const second = insertNameAt(first.text, first.caret, first.caret, '柳如霜');
    expect(second.text).toBe('沈砚舟柳如霜');
    expect(second.caret).toBe(6);
  });

  it('中文之间不加空格', () => {
    expect(insertNameAt('我看向', 3, 3, '苏婉').text).toBe('我看向苏婉');
  });

  it('英文单词相邻时补一个空格（前后都补）', () => {
    expect(insertNameAt('I meet', 6, 6, 'Alice').text).toBe('I meet Alice');
    expect(insertNameAt('meets me', 6, 6, 'Alice').text).toBe('meets Alice me');
  });

  it('越界的选区被夹住，不产生 undefined 片段', () => {
    const r = insertNameAt('abc', 99, 120, '甲');
    expect(r.text).toBe('abc甲');
    expect(r.caret).toBe(4);
  });

  it('倒置的选区（end < start）也安全', () => {
    const r = insertNameAt('abcdef', 4, 1, '甲');
    expect(r.text).toBe('abcd甲ef');
  });
});
