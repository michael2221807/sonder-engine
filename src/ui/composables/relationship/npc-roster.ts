/**
 * The NPC list order of RelationshipPanel, moved out of RelationshipPanel.vue (refactor R7 step 8).
 * The sort mode is passed in; the panel keeps the ref and reads it in the comparator as before.
 */
import type { NpcRelation } from './npc-edit-form';

export type SortMode = 'name' | 'affinity' | 'gender' | 'importance' | 'recent' | 'location' | 'presence';

/** The order within a group for a sort mode (the caller applies the direction and the attention pin). */
export function compareBySortMode(sortMode: SortMode, a: NpcRelation, b: NpcRelation): number {
  switch (sortMode) {
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
