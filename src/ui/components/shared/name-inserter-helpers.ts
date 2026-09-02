// App doc: docs/user-guide/pages/game-main.md §3.16 (名字速插)
/**
 * name-inserter-helpers — pure data shaping for the composer's「名字」panel.
 *
 * Responsibility split (mirrors useSttLexicon, which harvests the SAME two
 * sources for STT hotwords): this file lives under `src/ui/` precisely BECAUSE it
 * needs game-field knowledge (NPC / location entry shapes). `src/engine/` must stay
 * content-agnostic (CLAUDE.md §4), so the field names arrive via
 * `DEFAULT_ENGINE_PATHS.npcFieldNames` / `.locationFieldNames` rather than being
 * hardcoded here — a pack that renames 「名称」 keeps working.
 *
 * Everything here is a pure function so the sort/filter/insert rules can be unit
 * tested without mounting the panel (name-inserter-helpers.test.ts).
 */
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';

/** One row of the 人物 tab. */
export interface NpcNameEntry {
  name: string;
  /** 是否在场 — drives the leading dot and the default sort. */
  present: boolean;
  /** 好感度; undefined when the pack/save has never written one. */
  affinity?: number;
  /** 最后互动时间 — free-form string in the save; compared lexicographically. */
  lastInteraction?: string;
  /** 位置 — searchable so "找当铺里的人" works by typing the place. */
  location?: string;
}

/** One row of the 地点 tab. */
export interface LocNameEntry {
  name: string;
  /** 玩家当前所在地 — amber dot. */
  here: boolean;
  /** 出现在 系统.探索记录 中。 */
  explored: boolean;
  /**
   * Proximity rank for the「附近」sort — 0 here, 1 directly connected / same
   * parent, 2 explored elsewhere, 3 everything else. A real graph distance would
   * need a BFS over 连接 on every keystroke; this three-ring approximation is what
   * the player actually perceives as "near me" and costs one pass.
   */
  proximity: 0 | 1 | 2 | 3;
}

export type NpcSortMode = 'present' | 'affinity' | 'recent' | 'name';
export type LocSortMode = 'near' | 'explored' | 'name';

export const NPC_SORT_MODES: readonly NpcSortMode[] = ['present', 'affinity', 'recent', 'name'];
export const LOC_SORT_MODES: readonly LocSortMode[] = ['near', 'explored', 'name'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Harvest NPC names from `社交.关系`.
 *
 * Rows without a usable 名称 are dropped (the panel must never render a chip that
 * inserts an empty string), and duplicates collapse to the first occurrence —
 * the relationship array can legitimately hold a same-name row mid-merge
 * (see memory project_npc_dedup_merge).
 */
export function harvestNpcEntries(raw: unknown): NpcNameEntry[] {
  const f = DEFAULT_ENGINE_PATHS.npcFieldNames;
  const out: NpcNameEntry[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const name = readString(row, f.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const affinity = row[f.affinity];
    out.push({
      name,
      present: row[f.isPresent] === true,
      affinity: typeof affinity === 'number' ? affinity : undefined,
      lastInteraction: readString(row, f.lastInteractionTime),
      location: readString(row, f.location),
    });
  }
  return out;
}

/**
 * Harvest location names from `世界.地点信息`, enriched with the exploration
 * record and the player's current location.
 *
 * `playerLocation` is matched loosely (exact, or either side containing the
 * other) because the save writes free-form strings such as 「北市·当铺」 while the
 * location entry may be 「当铺」 — MapPanel resolves the same way.
 */
export function harvestLocationEntries(
  raw: unknown,
  exploredRaw: unknown,
  playerLocation: string | undefined,
): LocNameEntry[] {
  const f = DEFAULT_ENGINE_PATHS.locationFieldNames;
  const rows: Array<{ name: string; parent?: string; connections: string[] }> = [];
  const seen = new Set<string>();

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = asRecord(item);
      if (!row) continue;
      const name = readString(row, f.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // 上级 has no entry in locationFieldNames (the pack contract only maps
      // name/description/connections/npcList); MapPanel reads it literally too.
      const conn = row[f.connections];
      rows.push({
        name,
        parent: readString(row, '上级'),
        connections: Array.isArray(conn) ? conn.filter((c): c is string => typeof c === 'string') : [],
      });
    }
  }

  const explored = new Set(
    Array.isArray(exploredRaw) ? exploredRaw.filter((e): e is string => typeof e === 'string') : [],
  );

  const here = playerLocation?.trim() ?? '';
  const isHere = (name: string): boolean =>
    !!here && (name === here || here.includes(name) || name.includes(here));

  const hereRow = rows.find((r) => isHere(r.name));
  const neighbours = new Set<string>();
  if (hereRow) {
    for (const c of hereRow.connections) neighbours.add(c);
    for (const r of rows) {
      // Two-way: a location that lists 「here」 as its own connection is also adjacent.
      if (r.connections.includes(hereRow.name)) neighbours.add(r.name);
      if (hereRow.parent && r.parent === hereRow.parent) neighbours.add(r.name);
    }
    neighbours.delete(hereRow.name);
  }

  return rows.map((r) => {
    const atHere = isHere(r.name);
    const isExplored = explored.has(r.name);
    const proximity: LocNameEntry['proximity'] = atHere
      ? 0
      : neighbours.has(r.name)
        ? 1
        : isExplored
          ? 2
          : 3;
    return { name: r.name, here: atHere, explored: isExplored, proximity };
  });
}

/**
 * Sort NPC rows.
 *
 * `asc === true` is the mode's own natural order (在场优先 / 好感高优先 / 最近优先 /
 * 名称正序); clicking the active chip a second time flips it — identical to
 * RelationshipPanel's sort bar so the gesture transfers.
 */
export function sortNpcEntries(list: NpcNameEntry[], mode: NpcSortMode, asc: boolean): NpcNameEntry[] {
  const dir = asc ? 1 : -1;
  const byName = (a: NpcNameEntry, b: NpcNameEntry): number => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    let r = 0;
    switch (mode) {
      case 'present':
        r = (b.present ? 1 : 0) - (a.present ? 1 : 0) || byName(a, b);
        break;
      case 'affinity': {
        const av = a.affinity;
        const bv = b.affinity;
        // Rows the save never scored sink below scored ones in BOTH directions —
        // flipping the arrow should reorder the scored names, not float the blanks.
        if (av === undefined && bv === undefined) r = byName(a, b);
        else if (av === undefined) return 1;
        else if (bv === undefined) return -1;
        else r = bv - av || byName(a, b);
        break;
      }
      case 'recent': {
        const at = a.lastInteraction;
        const bt = b.lastInteraction;
        if (!at && !bt) r = byName(a, b);
        else if (!at) return 1;
        else if (!bt) return -1;
        else r = bt.localeCompare(at) || byName(a, b);
        break;
      }
      default:
        r = byName(a, b);
    }
    return r * dir;
  });
}

/** Sort location rows (see sortNpcEntries for the direction contract). */
export function sortLocEntries(list: LocNameEntry[], mode: LocSortMode, asc: boolean): LocNameEntry[] {
  const dir = asc ? 1 : -1;
  const byName = (a: LocNameEntry, b: LocNameEntry): number => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    let r = 0;
    switch (mode) {
      case 'near':
        r = a.proximity - b.proximity || byName(a, b);
        break;
      case 'explored':
        r = (b.explored ? 1 : 0) - (a.explored ? 1 : 0) || byName(a, b);
        break;
      default:
        r = byName(a, b);
    }
    return r * dir;
  });
}

/** Case-insensitive contains-match over a row's name plus any extra searchable text. */
export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

/**
 * Splice a name into the composer text at the caret / over the selection.
 *
 * Returns the next text AND where the caret should land, so the panel can chain
 * inserts: click 沈砚舟, click 柳如霜 → 「沈砚舟柳如霜」 with the caret still trailing.
 * A separator is inserted only between two ASCII word characters (English names);
 * CJK never gets a space, which is what the narrative text actually wants.
 */
export function insertNameAt(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  name: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);

  const needsLead = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(name);
  const needsTail = /[A-Za-z0-9]$/.test(name) && /^[A-Za-z0-9]/.test(after);
  const piece = `${needsLead ? ' ' : ''}${name}${needsTail ? ' ' : ''}`;

  return { text: `${before}${piece}${after}`, caret: start + piece.length };
}
