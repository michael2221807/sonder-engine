import { describe, expect, it } from 'vitest';
import type { NpcRelation } from './npc-edit-form';
import { compareBySortMode, type SortMode } from './npc-roster';

/** compareBySortMode() in RelationshipPanel.vue before the move, copied as it stood (sortMode was a ref). */
function legacy(sortMode: { value: SortMode }, a: NpcRelation, b: NpcRelation): number {
  switch (sortMode.value) {
    case 'affinity':
      return (b.好感度 ?? 0) - (a.好感度 ?? 0);
    case 'gender': {
      const ga = a.性别 ?? '';
      const gb = b.性别 ?? '';
      if (ga !== gb) return ga.localeCompare(gb);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'importance': {
      const am = a['是否主要角色'] ? 1 : 0;
      const bm = b['是否主要角色'] ? 1 : 0;
      if (am !== bm) return bm - am;
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'recent': {
      const ta = a['最后互动时间'] as string | undefined;
      const tb = b['最后互动时间'] as string | undefined;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      if (ta && tb) return tb.localeCompare(ta);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'location': {
      const la = (a.位置 ?? '') as string;
      const lb = (b.位置 ?? '') as string;
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      if (la !== lb) return la.localeCompare(lb);
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    case 'presence': {
      const pa = a['是否在场'] ? 1 : 0;
      const pb = b['是否在场'] ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
    }
    default:
      return (a.名称 ?? '').localeCompare(b.名称 ?? '');
  }
}

const MODES: SortMode[] = ['name', 'affinity', 'gender', 'importance', 'recent', 'location', 'presence'];

const npcs: NpcRelation[] = [
  { 名称: '林暖', 好感度: 72, 性别: '女', 是否主要角色: true, 最后互动时间: '2026-10-02', 位置: '酒肆', 是否在场: true },
  { 名称: '关宇', 好感度: -20, 性别: '男', 是否主要角色: false, 最后互动时间: '2026-10-05', 位置: '码头', 是否在场: false },
  { 名称: '阿七', 性别: '女', 位置: '' },
  { 名称: '沈青', 好感度: 72, 是否主要角色: true, 最后互动时间: '2026-10-05', 位置: '酒肆', 是否在场: true },
  { 名称: '', 位置: '码头' },
  { 名称: '无名' },
];

describe('compareBySortMode', () => {
  it('orders by name in the default branch (also for an unknown mode)', () => {
    expect([...npcs].sort((a, b) => compareBySortMode('name', a, b)).map((n) => n.名称)).toEqual(
      [...npcs].map((n) => n.名称).sort((a, b) => a.localeCompare(b)),
    );
    expect(compareBySortMode('bogus' as SortMode, npcs[0], npcs[1])).toBe(npcs[0].名称.localeCompare(npcs[1].名称));
  });

  it('affinity puts the higher first and treats a missing value as 0', () => {
    expect(compareBySortMode('affinity', npcs[0], npcs[1])).toBeLessThan(0);
    expect(compareBySortMode('affinity', npcs[2], npcs[1])).toBeLessThan(0);
    expect(compareBySortMode('affinity', npcs[0], npcs[3])).toBe(0);
  });

  it('importance and presence put flagged NPCs first, then fall back to the name', () => {
    expect(compareBySortMode('importance', npcs[0], npcs[1])).toBeLessThan(0);
    expect(compareBySortMode('presence', npcs[1], npcs[0])).toBeGreaterThan(0);
    expect(compareBySortMode('importance', npcs[2], npcs[5])).toBe(npcs[2].名称.localeCompare(npcs[5].名称));
  });

  it('recent puts the most recently met first and NPCs never met last', () => {
    expect(compareBySortMode('recent', npcs[1], npcs[0])).toBeLessThan(0);
    expect(compareBySortMode('recent', npcs[0], npcs[2])).toBeLessThan(0);
    expect(compareBySortMode('recent', npcs[2], npcs[0])).toBeGreaterThan(0);
  });

  it('location puts NPCs with a place first, then orders places', () => {
    expect(compareBySortMode('location', npcs[0], npcs[2])).toBeLessThan(0);
    expect(compareBySortMode('location', npcs[2], npcs[0])).toBeGreaterThan(0);
    expect(compareBySortMode('location', npcs[0], npcs[1])).toBe('酒肆'.localeCompare('码头'));
  });

  it('gives the same result as the inline code for every mode and every pair', () => {
    for (const mode of MODES) {
      for (const a of npcs) {
        for (const b of npcs) {
          expect(compareBySortMode(mode, a, b)).toBe(legacy({ value: mode }, a, b));
        }
      }
    }
  });

  it('sorts a list identically to the inline comparator', () => {
    for (const mode of MODES) {
      const got = [...npcs].sort((a, b) => compareBySortMode(mode, a, b)).map((n) => n.名称);
      const want = [...npcs].sort((a, b) => legacy({ value: mode }, a, b)).map((n) => n.名称);
      expect(got).toEqual(want);
    }
  });
});
