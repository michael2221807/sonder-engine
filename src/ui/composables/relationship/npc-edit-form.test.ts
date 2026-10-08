import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { clonePrivacy, editFormToNpcData, emptyEditForm, newEditForm, npcToEditForm, type NpcRelation } from './npc-edit-form';

const F = DEFAULT_ENGINE_PATHS.npcFieldNames;

describe('clonePrivacy', () => {
  it('returns a new empty object for nothing', () => {
    expect(clonePrivacy(undefined)).toEqual({});
    expect(clonePrivacy(undefined)).not.toBe(clonePrivacy(undefined));
  });

  it('deep-copies the profile', () => {
    const p = { '是否为处女/处男': false, 身体部位: [{ 部位名称: '嘴', 敏感度: 3 }], 性癖好: ['a'] };
    const c = clonePrivacy(p);
    expect(c).toEqual(p);
    c.身体部位![0].敏感度 = 9;
    c.性癖好!.push('b');
    expect(p.身体部位[0].敏感度).toBe(3);
    expect(p.性癖好).toEqual(['a']);
  });
});

describe('the two default forms are not merged', () => {
  it('the initial form has an empty type, the 「新增」 form has 普通; everything else is equal', () => {
    const initial = emptyEditForm();
    const added = newEditForm();
    expect(initial.类型).toBe('');
    expect(added.类型).toBe('普通');
    expect({ ...added, 类型: '' }).toEqual(initial);
  });

  it('both are zeroed forms with the documented defaults, fresh on every call', () => {
    expect(emptyEditForm()).toEqual({
      名称: '', 类型: '', 好感度: 50, 位置: '', 描述: '', 外貌描述: '', 身材描写: '', 衣着风格: '', 性别: '', 年龄: 20,
      背景: '', 内心想法: '', 在做事项: '', 性格特征: [], 记忆: [], 关注: false, 心跳锁定: false, 私密信息: {},
      核心性格特征: '', 关系状态: '', 好感度突破条件: '', 关系突破条件: '', 关系网变量: [], 总结记忆: [],
    });
    const a = newEditForm();
    a.性格特征.push('x');
    a.私密信息['k'] = 1;
    expect(newEditForm().性格特征).toEqual([]);
    expect(newEditForm().私密信息).toEqual({});
  });
});

describe('npcToEditForm', () => {
  it('fills defaults for a bare NPC (type empty, affinity 50, age 20)', () => {
    const form = npcToEditForm({ 名称: '林暖' }, F);
    expect(form).toEqual({ ...emptyEditForm(), 名称: '林暖' });
  });

  it('copies fields, keeps non-numbers out of the numeric slots, and copies the lists', () => {
    const npc: NpcRelation = {
      名称: '林暖', 类型: '重要', 好感度: 0, 年龄: '十八' as unknown as number, 性格特征: ['温柔'], 记忆: ['m1'],
      关注: true, 心跳锁定: false, 私密信息: { 性格倾向: 'x' },
      [F.corePersonality]: '稳重', [F.relationshipStatus]: '朋友', [F.affinityBreakthrough]: 'a', [F.relationshipBreakthrough]: 'b',
      [F.relationshipNetwork]: [{ 对象: '关宇', 关系: '兄妹' }],
      [F.memorySummaries]: [{ 摘要: 's', 涵盖范围: '1-3', 生成时间: 't' }],
    };
    const form = npcToEditForm(npc, F);
    expect(form.好感度).toBe(0);
    expect(form.年龄).toBe(20);
    expect(form.关注).toBe(true);
    expect(form.核心性格特征).toBe('稳重');
    expect(form.关系状态).toBe('朋友');
    expect(form.好感度突破条件).toBe('a');
    expect(form.关系突破条件).toBe('b');
    expect(form.关系网变量).toEqual([{ 对象: '关宇', 关系: '兄妹', 备注: '' }]);
    expect(form.总结记忆).toEqual([{ 摘要: 's', 涵盖范围: '1-3', 生成时间: 't' }]);
    form.性格特征.push('新');
    form.记忆.push('新');
    form.私密信息.性格倾向 = 'changed';
    form.总结记忆[0].摘要 = 'changed';
    expect(npc.性格特征).toEqual(['温柔']);
    expect(npc.记忆).toEqual(['m1']);
    expect(npc.私密信息).toEqual({ 性格倾向: 'x' });
    expect((npc[F.memorySummaries] as Array<{ 摘要: string }>)[0].摘要).toBe('s');
  });

  it('treats a non-array list as empty', () => {
    const form = npcToEditForm({ 名称: 'x', 性格特征: 'oops' as unknown as string[], [F.relationshipNetwork]: 'oops' }, F);
    expect(form.性格特征).toEqual([]);
    expect(form.关系网变量).toEqual([]);
  });
});

describe('editFormToNpcData', () => {
  it('writes the plain fields and puts the pack-defined fields under the configured keys', () => {
    const form = { ...newEditForm(), 名称: '新人', 核心性格特征: 'c', 关系状态: 's', 好感度突破条件: 'a', 关系突破条件: 'b', 关系网变量: [{ 对象: 'o', 关系: 'r', 备注: '' }], 总结记忆: [] };
    const data = editFormToNpcData(form, F);
    expect(data['名称']).toBe('新人');
    expect(data['类型']).toBe('普通');
    expect(data[F.corePersonality]).toBe('c');
    expect(data[F.relationshipStatus]).toBe('s');
    expect(data[F.affinityBreakthrough]).toBe('a');
    expect(data[F.relationshipBreakthrough]).toBe('b');
    expect(data[F.relationshipNetwork]).toBe(form.关系网变量);
    expect(data[F.memorySummaries]).toBe(form.总结记忆);
    expect(Object.keys(data).length).toBe(24);
  });

  it('round-trips an NPC through the form without losing the edited fields', () => {
    const npc: NpcRelation = { 名称: '林暖', 类型: '重要', 好感度: 70, 位置: '酒肆', 性别: '女', 年龄: 18, 性格特征: ['温柔'], 记忆: [], 关注: true, 心跳锁定: true };
    const data = editFormToNpcData(npcToEditForm(npc, F), F);
    expect(data).toMatchObject({ 名称: '林暖', 类型: '重要', 好感度: 70, 位置: '酒肆', 性别: '女', 年龄: 18, 性格特征: ['温柔'], 关注: true, 心跳锁定: true });
  });
});
