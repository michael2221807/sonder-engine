/**
 * SillyTavern Lorebook → AGA WorldBook converter.
 *
 * Supports the standard ST export format: { entries: { "0": {...}, "1": {...}, ... } }
 * Also supports array-style entries: { entries: [...] }
 */
import type { WorldBook, WorldBookEntry, WorldBookInjectionMode } from './world-book';

// ─── ST Types (subset of fields we actually read) ──────────

interface STLorebookEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  disable?: boolean;
  order?: number;
  displayIndex?: number;
}

// ─── Detection ─────────────────────────────────────────────

function isSTEntry(val: unknown): val is STLorebookEntry {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.content === 'string' && (Array.isArray(obj.key) || typeof obj.comment === 'string');
}

export function isSTLorebook(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (!obj.entries || typeof obj.entries !== 'object') return false;

  const entries = obj.entries as Record<string, unknown>;
  if (Array.isArray(entries)) {
    return entries.length > 0 && isSTEntry(entries[0]);
  }
  const keys = Object.keys(entries);
  return keys.length > 0 && isSTEntry(entries[keys[0]]);
}

// ─── Conversion ────────────────────────────────────────────

function mapEntry(st: STLorebookEntry, index: number): WorldBookEntry {
  const keywords: string[] = [];
  if (Array.isArray(st.key))
    keywords.push(...st.key.filter((k) => typeof k === 'string' && k.length > 0));
  if (Array.isArray(st.keysecondary))
    keywords.push(...st.keysecondary.filter((k) => typeof k === 'string' && k.length > 0));

  const hasKeywords = keywords.length > 0;
  const isConstant = st.constant === true;
  const injectionMode: WorldBookInjectionMode = isConstant || !hasKeywords ? 'always' : 'match_any';

  return {
    id: `we_st_${Date.now()}_${index}`,
    title: st.comment || `Entry ${st.uid ?? index}`,
    content: st.content ?? '',
    type: 'world_lore',
    shape: 'normal',
    scope: ['main'],
    injectionMode,
    keywords: injectionMode === 'match_any' ? keywords : [],
    priority: typeof st.order === 'number' ? st.order : 50,
    enabled: st.disable !== true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function convertSTLorebook(raw: unknown, bookTitle?: string): WorldBook | null {
  if (!isSTLorebook(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const entriesObj = obj.entries as Record<string, unknown>;

  let stEntries: STLorebookEntry[];
  if (Array.isArray(entriesObj)) {
    stEntries = entriesObj.filter(isSTEntry);
  } else {
    stEntries = Object.keys(entriesObj)
      .sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      })
      .map((k) => entriesObj[k])
      .filter(isSTEntry);
  }

  if (stEntries.length === 0) return null;

  const entries = stEntries.map((e, i) => mapEntry(e, i));

  return {
    id: `wb_st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: bookTitle ?? 'Imported ST Lorebook',
    entries,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
