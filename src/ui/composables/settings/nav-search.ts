/**
 * The settings page's side navigation and search definitions, moved out of SettingsPanel.vue (refactor R7 step 9).
 * The panel keeps the refs, the scroll spy and its lifecycle calls.
 */

export interface NavCategory {
  id: string;
  label: string;
}

/**
 * Whether a section still shows for the search text. `category` and `container` are read lazily (the container only when the label did not
 * already match), so the reactive reads of a caller's computed stay exactly as before.
 */
export function sectionMatchesSearchText(
  search: string,
  category: () => NavCategory | undefined,
  container: () => HTMLElement | null,
  sectionId: string,
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const cat = category();
  if (cat && cat.label.toLowerCase().includes(q)) return true;
  const root = container();
  if (!root) return true;
  const el = root.querySelector(`#${sectionId}`);
  if (!el) return true;
  return el.textContent?.toLowerCase().includes(q) ?? true;
}
