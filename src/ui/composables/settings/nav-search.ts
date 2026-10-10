// App doc: docs/user-guide/pages/home.md §1.3.2 导航与搜索
/**
 * The settings page's side navigation and search definitions, moved out of SettingsPanel.vue (refactor R7 step 9).
 * The panel keeps the refs, the scroll listener and its lifecycle calls.
 *
 * 2026-10-09 fix: search reads every label and description of a section from the locale messages (so rows behind a
 * master switch or a collapsed group are found too), sections that have no side-nav entry of their own (Engram, About)
 * follow the search, and the highlighted entry is computed from where the sections sit, not from a set of
 * intersection events that went stale while a click scrolled the page.
 */

export interface NavCategory {
  id: string;
  label: string;
}

/**
 * Locale keys a section is searched by. `only` keeps a group to the game page or to Home, for rows that show on one
 * of them only; the longest matching prefix decides, so a narrower group can carve rows out of a wider one.
 */
export interface SearchKeyGroup {
  prefix: string;
  only?: 'game' | 'home';
}

/** One searchable block of the page. `nav` is the side-nav entry it belongs to (null: none, like About). */
export interface SettingsSectionDef {
  id: string;
  nav: string | null;
  keys: readonly SearchKeyGroup[];
}

/** Every block of the page that search can show or hide. Order does not matter: the page's layout decides. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'settings-nsfw', nav: 'settings-nsfw', keys: [{ prefix: 'settings.nsfw.' }] },
  {
    id: 'settings-ai-features',
    nav: 'settings-ai-features',
    keys: [
      { prefix: 'settings.aiFeatures.' },
      { prefix: 'settings.aiFeatures.cot.', only: 'game' },
      { prefix: 'settings.aiFeatures.bodyPolish.', only: 'game' },
      { prefix: 'settings.aiFeatures.presence.', only: 'game' },
      { prefix: 'settings.aiFeatures.imageGen.', only: 'game' },
      { prefix: 'settings.aiFeatures.subsection.image', only: 'game' },
      { prefix: 'settings.plotVector.' },
    ],
  },
  { id: 'settings-audio', nav: 'settings-audio', keys: [{ prefix: 'settings.audio.' }] },
  { id: 'settings-voice-input', nav: 'settings-voice-input', keys: [{ prefix: 'stt.settings.' }] },
  {
    id: 'settings-ui',
    nav: 'settings-ui',
    keys: [
      { prefix: 'settings.ui.' },
      { prefix: 'settings.ui.showActions.desc', only: 'game' },
      { prefix: 'settings.ui.showActions.descOutside', only: 'home' },
    ],
  },
  { id: 'settings-game', nav: 'settings-game', keys: [{ prefix: 'settings.game.' }] },
  { id: 'settings-action', nav: 'settings-action', keys: [{ prefix: 'settings.action.' }] },
  { id: 'settings-heartbeat', nav: 'settings-heartbeat', keys: [{ prefix: 'settings.heartbeat.' }] },
  { id: 'settings-npc', nav: 'settings-npc', keys: [{ prefix: 'settings.npc.' }] },
  { id: 'settings-plot', nav: 'settings-plot', keys: [{ prefix: 'settings.plot.' }] },
  { id: 'settings-memory', nav: 'settings-memory', keys: [{ prefix: 'settings.memory.' }] },
  { id: 'settings-engram', nav: 'settings-memory', keys: [{ prefix: 'settings.engram.' }] },
  { id: 'settings-advanced', nav: 'settings-advanced', keys: [{ prefix: 'settings.advanced.' }] },
  { id: 'settings-scale', nav: 'settings-scale', keys: [{ prefix: 'settings.scale.' }] },
  { id: 'settings-data', nav: 'settings-data', keys: [{ prefix: 'settings.data.' }] },
  { id: 'settings-about', nav: null, keys: [{ prefix: 'settings.about.' }] },
];

/** Key endings that are what a reader sees as a row's name or explanation (toasts, errors and button words are not). */
const SEARCHABLE_LEAVES = new Set(['label', 'desc', 'descOutside', 'sectionTitle', 'sectionDesc', 'title', 'description']);

export function isSearchableKey(key: string): boolean {
  if (key.includes('.subsection.')) return true;
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  return SEARCHABLE_LEAVES.has(leaf);
}

/** The dotted keys of a locale message tree; the settings file is flat ("settings.x.y") while others nest. */
export function flattenMessageKeys(messages: unknown, prefix = ''): string[] {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(messages as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenMessageKeys(v, key));
    else out.push(key);
  }
  return out;
}

/** The locale keys a section is searched by on this page (`inGame`: the game page, else Home). */
export function sectionSearchKeys(def: SettingsSectionDef, allKeys: readonly string[], inGame: boolean): string[] {
  const out: string[] = [];
  for (const key of allKeys) {
    if (!isSearchableKey(key)) continue;
    let best: SearchKeyGroup | null = null;
    for (const group of def.keys) {
      if (key.startsWith(group.prefix) && (!best || group.prefix.length > best.prefix.length)) best = group;
    }
    if (!best) continue;
    if (best.only === 'game' && !inGame) continue;
    if (best.only === 'home' && inGame) continue;
    out.push(key);
  }
  return out;
}

/** An indexed text as search reads it: lower-cased, without `{count}`-style placeholders (never what a reader sees). */
export function searchableText(text: string): string {
  return text.replace(/\{\w+\}/g, '').toLowerCase();
}

/** The trimmed, lower-cased search text; empty means no search. */
export function normalizeSearch(search: string): string {
  return search.trim().toLowerCase();
}

/**
 * Whether a section shows for the search text: its side-nav label, any of its indexed texts, or the text it shows
 * right now (values, options picked) contains the query. `navLabel`, `texts` and `domText` are read lazily, in that
 * order, and only until one matches.
 */
export function sectionMatchesSearchText(
  search: string,
  navLabel: () => string | undefined,
  texts: () => readonly string[],
  domText: () => string | null,
): boolean {
  const q = normalizeSearch(search);
  if (!q) return true;
  if (navLabel()?.toLowerCase().includes(q)) return true;
  if (texts().some((text) => text.toLowerCase().includes(q))) return true;
  return domText()?.toLowerCase().includes(q) ?? false;
}

/** A section's side-nav entry and where its top edge sits, in px from the top of the scroll area's visible part. */
export interface SectionBox {
  nav: string;
  top: number;
}

/**
 * The side-nav entry to highlight: the last section whose top edge has passed `line` (px below the visible top).
 * Scrolled to the very bottom, the last section that shows in `viewportHeight` wins, so a short final section that
 * can never reach the line still lights up.
 */
export function pickActiveNav(
  boxes: readonly SectionBox[],
  line: number,
  atBottom: boolean,
  viewportHeight: number,
): string | null {
  if (boxes.length === 0) return null;
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  if (atBottom) {
    const shown = sorted.filter((b) => b.top < viewportHeight);
    if (shown.length > 0) return shown[shown.length - 1].nav;
  }
  let active = sorted[0].nav;
  for (const box of sorted) {
    if (box.top > line) break;
    active = box.nav;
  }
  return active;
}
