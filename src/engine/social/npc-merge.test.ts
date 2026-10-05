import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import {
  normalizeNpcName,
  mergeNpcRecords,
  mergeDuplicateNpcArray,
  type NpcRecord,
} from './npc-merge';

const F = DEFAULT_ENGINE_PATHS.npcFieldNames;

/** A realistic "live" entry that has accumulated relational state */
function liveNpc(overrides: NpcRecord = {}): NpcRecord {
  return {
    [F.name]: '李明阳',
    [F.type]: '重要',
    [F.gender]: '女',
    [F.age]: 24,
    [F.location]: '青云茶馆',
    [F.affinity]: 72,
    [F.relationshipStatus]: '挚友',
    [F.description]: '茶馆老板娘',
    [F.appearance]: '一袭青衣，眉眼温婉。',
    [F.isPresent]: false,
    [F.memory]: ['与玩家在茶馆相识', { 内容: '一起躲过一场大雨', 时间: '1-03-02' }],
    [F.personalityTraits]: ['温柔', '细心'],
    [F.relationshipNetwork]: [{ 对象: '王五', 关系: '兄妹' }],
    ...overrides,
  };
}

/** A typical AI re-push: fresh introduction with reset progression values */
function repushedNpc(overrides: NpcRecord = {}): NpcRecord {
  return {
    [F.name]: '李明阳',
    [F.type]: '普通',
    [F.gender]: '女',
    [F.location]: '城南集市',
    [F.affinity]: 50,
    [F.relationshipStatus]: '陌生人',
    [F.description]: '茶馆老板娘，为人爽利，在城中人缘极好',
    [F.bodyDescription]: '身形高挑，体态匀称。',
    [F.isPresent]: true,
    [F.currentActivity]: '在集市挑选新茶',
    [F.memory]: ['与玩家在茶馆相识'],
    [F.personalityTraits]: ['细心', '爽朗'],
    ...overrides,
  };
}

describe('normalizeNpcName', () => {
  it('trims whitespace', () => {
    expect(normalizeNpcName(' 李明阳 ')).toBe('李明阳');
  });

  it('folds full-width variants via NFKC', () => {
    expect(normalizeNpcName('Ｌｉｎ')).toBe('Lin');
    expect(normalizeNpcName('李明阳　')).toBe('李明阳');
  });

  it('strips zero-width characters', () => {
    expect(normalizeNpcName('李​明阳﻿')).toBe('李明阳');
  });

  it('returns empty string for non-strings', () => {
    expect(normalizeNpcName(undefined)).toBe('');
    expect(normalizeNpcName(42)).toBe('');
    expect(normalizeNpcName(null)).toBe('');
  });

  it('does NOT fuzzy-match distinct CJK characters', () => {
    expect(normalizeNpcName('林月')).not.toBe(normalizeNpcName('林玥'));
  });
});

describe('mergeNpcRecords', () => {
  it('volatile fields: incoming wins (current state is newer)', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    expect(merged[F.location]).toBe('城南集市');
    expect(merged[F.isPresent]).toBe(true);
    expect(merged[F.currentActivity]).toBe('在集市挑选新茶');
  });

  it('progression fields: base wins (accumulated state must survive)', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    expect(merged[F.affinity]).toBe(72);
    expect(merged[F.relationshipStatus]).toBe('挚友');
  });

  it('identity fields: base wins when both present', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    expect(merged[F.type]).toBe('重要');
  });

  it('the main-round stamp: the later round wins from either side', () => {
    const key = F.lastMainRoundUpdate;
    expect(mergeNpcRecords(liveNpc({ [key]: 3 }), repushedNpc({ [key]: 40 }), F)[key]).toBe(40);
    expect(mergeNpcRecords(liveNpc({ [key]: 40 }), repushedNpc({ [key]: 3 }), F)[key]).toBe(40);
    // A stamp that is no round number on the base yields to one that is.
    expect(mergeNpcRecords(liveNpc({ [key]: '3' }), repushedNpc({ [key]: 40 }), F)[key]).toBe(40);
  });

  it('descriptive text: longer version wins regardless of side', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    // incoming description is longer → adopted
    expect(merged[F.description]).toBe('茶馆老板娘，为人爽利，在城中人缘极好');
    // base appearance is the only non-empty one → kept
    expect(merged[F.appearance]).toBe('一袭青衣，眉眼温婉。');
  });

  it('fills fields missing on base (the field-repair scenario)', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    expect(merged[F.bodyDescription]).toBe('身形高挑，体态匀称。');
  });

  it('empty incoming values never clobber base values', () => {
    const merged = mergeNpcRecords(
      liveNpc(),
      repushedNpc({ [F.appearance]: '', [F.affinity]: undefined, [F.memory]: [] }),
      F,
    );
    expect(merged[F.appearance]).toBe('一袭青衣，眉眼温婉。');
    expect(merged[F.affinity]).toBe(72);
    expect((merged[F.memory] as unknown[]).length).toBe(2);
  });

  it('memory arrays: union with near-duplicate filtering', () => {
    const merged = mergeNpcRecords(
      liveNpc(),
      repushedNpc({
        [F.memory]: [
          '与玩家在茶馆相识', // exact dup → filtered
          '收到玩家赠送的桂花糕', // new → appended
        ],
      }),
      F,
    );
    const memory = merged[F.memory] as unknown[];
    expect(memory).toHaveLength(3);
    expect(memory[2]).toBe('收到玩家赠送的桂花糕');
  });

  it('trait arrays: deep-equality union preserving base order', () => {
    const merged = mergeNpcRecords(liveNpc(), repushedNpc(), F);
    expect(merged[F.personalityTraits]).toEqual(['温柔', '细心', '爽朗']);
  });

  it('privacyProfile: fill-missing merge, base fields kept', () => {
    const merged = mergeNpcRecords(
      liveNpc({ [F.privacyProfile]: { 敏感点: '耳垂', 经验: '未知' } }),
      repushedNpc({ [F.privacyProfile]: { 敏感点: '锁骨', 癖好: '轻咬' } }),
      F,
    );
    expect(merged[F.privacyProfile]).toEqual({
      敏感点: '耳垂',
      经验: '未知',
      癖好: '轻咬',
    });
  });

  it('unknown pack-specific fields: fill-missing, base wins on scalar conflict', () => {
    const merged = mergeNpcRecords(
      liveNpc({ 门派: '青云门' }),
      repushedNpc({ 门派: '天音阁', 修为: '筑基' }),
      F,
    );
    expect(merged['门派']).toBe('青云门');
    expect(merged['修为']).toBe('筑基');
  });

  it('keeps base name spelling (incoming variant never overwrites)', () => {
    const merged = mergeNpcRecords(
      liveNpc(),
      repushedNpc({ [F.name]: '李明阳 ' }),
      F,
    );
    expect(merged[F.name]).toBe('李明阳');
  });

  it('does not mutate its inputs', () => {
    const base = liveNpc();
    const incoming = repushedNpc();
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    const incomingSnapshot = JSON.parse(JSON.stringify(incoming));
    mergeNpcRecords(base, incoming, F);
    expect(base).toEqual(baseSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });
});

describe('mergeDuplicateNpcArray', () => {
  it('returns the same reference when there are no duplicates', () => {
    const arr = [liveNpc(), { [F.name]: '王五' }];
    const { result, mergedCount } = mergeDuplicateNpcArray(arr, F);
    expect(result).toBe(arr);
    expect(mergedCount).toBe(0);
  });

  it('fuses later duplicates into the first occurrence, preserving position', () => {
    const arr = [
      { [F.name]: '王五', [F.affinity]: 10 },
      liveNpc(),
      { [F.name]: '赵六' },
      repushedNpc(),
    ];
    const { result, mergedCount, mergedNames } = mergeDuplicateNpcArray(arr, F);
    expect(mergedCount).toBe(1);
    expect(mergedNames).toEqual(['李明阳']);
    expect(result).toHaveLength(3);
    expect(result.map((n) => n[F.name])).toEqual(['王五', '李明阳', '赵六']);
    // fused entry carries data from both copies
    expect(result[1][F.affinity]).toBe(72);
    expect(result[1][F.isPresent]).toBe(true);
    expect(result[1][F.bodyDescription]).toBe('身形高挑，体态匀称。');
  });

  it('matches names across whitespace/width variants', () => {
    const arr = [liveNpc(), repushedNpc({ [F.name]: ' 李明阳　' })];
    const { result, mergedCount } = mergeDuplicateNpcArray(arr, F);
    expect(mergedCount).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0][F.name]).toBe('李明阳');
  });

  it('fuses three copies of the same NPC into one', () => {
    const arr = [
      liveNpc(),
      repushedNpc(),
      repushedNpc({ [F.currentActivity]: '回茶馆的路上', 修为: '金丹' }),
    ];
    const { result, mergedCount } = mergeDuplicateNpcArray(arr, F);
    expect(mergedCount).toBe(2);
    expect(result).toHaveLength(1);
    expect(result[0][F.currentActivity]).toBe('回茶馆的路上');
    expect(result[0]['修为']).toBe('金丹');
    expect(result[0][F.affinity]).toBe(72);
  });

  it('leaves nameless or malformed entries untouched', () => {
    const arr: NpcRecord[] = [
      { [F.description]: '无名条目' },
      liveNpc(),
      'garbage' as unknown as NpcRecord,
      { [F.name]: '' },
    ];
    const { result, mergedCount } = mergeDuplicateNpcArray(arr, F);
    expect(mergedCount).toBe(0);
    expect(result).toBe(arr);
  });

  it('handles empty and single-element arrays', () => {
    expect(mergeDuplicateNpcArray([], F).mergedCount).toBe(0);
    expect(mergeDuplicateNpcArray([liveNpc()], F).mergedCount).toBe(0);
  });
});
