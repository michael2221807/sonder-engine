// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { sectionMatchesSearchText, type NavCategory } from './nav-search';

/** sectionMatchesSearch() in SettingsPanel.vue before the move, with its refs turned into arguments. */
function legacy(search: string, cats: NavCategory[], container: HTMLElement | null, sectionId: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const cat = cats.find((c) => c.id === sectionId);
  if (cat && cat.label.toLowerCase().includes(q)) return true;
  if (!container) return true;
  const el = container.querySelector(`#${sectionId}`);
  if (!el) return true;
  return el.textContent?.toLowerCase().includes(q) ?? true;
}

function makeContainer(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = '<section id="settings-nsfw">Adult content switch</section><section id="settings-ui">Font size and Theme</section>';
  return root;
}

const CATS: NavCategory[] = [
  { id: 'settings-nsfw', label: 'NSFW' },
  { id: 'settings-ui', label: 'Interface' },
  { id: 'settings-data', label: 'Data' },
];

describe('sectionMatchesSearchText', () => {
  it('an empty or blank search shows every section', () => {
    const run = (s: string) => sectionMatchesSearchText(s, () => CATS[0], () => makeContainer(), 'settings-nsfw');
    expect(run('')).toBe(true);
    expect(run('   ')).toBe(true);
  });

  it('matches the category label ignoring case and surrounding spaces', () => {
    expect(sectionMatchesSearchText(' nsfw ', () => CATS[0], () => null, 'settings-nsfw')).toBe(true);
  });

  it('otherwise matches the section text, and hides a section whose text does not match', () => {
    const root = makeContainer();
    expect(sectionMatchesSearchText('theme', () => CATS[1], () => root, 'settings-ui')).toBe(true);
    expect(sectionMatchesSearchText('theme', () => CATS[0], () => root, 'settings-nsfw')).toBe(false);
  });

  it('shows the section when the container or the section element is missing', () => {
    expect(sectionMatchesSearchText('zzz', () => CATS[0], () => null, 'settings-nsfw')).toBe(true);
    expect(sectionMatchesSearchText('zzz', () => CATS[2], () => makeContainer(), 'settings-data')).toBe(true);
  });

  it('agrees with the inline code on a corpus', () => {
    const root = makeContainer();
    for (const search of ['', ' ', 'nsfw', 'NSFW', 'adult', 'font', 'theme', 'zzz', 'data', 'Interface']) {
      for (const cat of CATS) {
        expect(sectionMatchesSearchText(search, () => CATS.find((c) => c.id === cat.id), () => root, cat.id))
          .toBe(legacy(search, CATS, root, cat.id));
        expect(sectionMatchesSearchText(search, () => CATS.find((c) => c.id === cat.id), () => null, cat.id))
          .toBe(legacy(search, CATS, null, cat.id));
      }
    }
  });

  it('reads the category and the container lazily, exactly when the inline code read its refs', () => {
    const category = vi.fn(() => CATS[0]);
    const container = vi.fn(() => makeContainer());
    sectionMatchesSearchText('', category, container, 'settings-nsfw');
    expect(category).not.toHaveBeenCalled();
    expect(container).not.toHaveBeenCalled();
    sectionMatchesSearchText('nsfw', category, container, 'settings-nsfw');
    expect(category).toHaveBeenCalledTimes(1);
    expect(container).not.toHaveBeenCalled();
    sectionMatchesSearchText('adult', category, container, 'settings-nsfw');
    expect(container).toHaveBeenCalledTimes(1);
  });
});
