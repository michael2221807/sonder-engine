import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import zhCN from '@/ui/i18n/locales/zh-CN/index';
import {
  SETTINGS_SECTIONS, flattenMessageKeys, isSearchableKey, normalizeSearch, pickActiveNav, searchableText,
  sectionMatchesSearchText, sectionSearchKeys, type SettingsSectionDef,
} from './nav-search';

const ZH_KEYS = flattenMessageKeys(zhCN);
const zh = (key: string): string => (zhCN as Record<string, unknown>)[key] as string
  ?? key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zhCN) as string;
const section = (id: string): SettingsSectionDef => {
  const def = SETTINGS_SECTIONS.find((d) => d.id === id);
  if (!def) throw new Error(id);
  return def;
};

describe('flattenMessageKeys', () => {
  it('keeps flat dotted keys and spells nested ones out', () => {
    expect(flattenMessageKeys({ 'a.b': 'x', c: { d: { e: 'y' }, f: 'z' } })).toEqual(['a.b', 'c.d.e', 'c.f']);
  });

  it('reads both shapes of the real locale (flat settings file, nested stt file)', () => {
    expect(ZH_KEYS).toContain('settings.audio.speaker.label');
    expect(ZH_KEYS).toContain('stt.settings.backend.label');
  });
});

describe('isSearchableKey', () => {
  it('takes names, explanations, titles and subsection headers, not toasts or button words', () => {
    expect(isSearchableKey('settings.audio.speaker.label')).toBe(true);
    expect(isSearchableKey('settings.memory.sectionDesc')).toBe(true);
    expect(isSearchableKey('settings.aiFeatures.subsection.image')).toBe(true);
    expect(isSearchableKey('settings.audio.speaker.fetchErr')).toBe(false);
    expect(isSearchableKey('settings.data.clearAll.btn')).toBe(false);
  });
});

describe('sectionSearchKeys on the real locale', () => {
  it('gives every section something to be found by', () => {
    for (const def of SETTINGS_SECTIONS) {
      expect(sectionSearchKeys(def, ZH_KEYS, true).length, def.id).toBeGreaterThan(0);
    }
  });

  it('finds rows behind a master switch or a fold (the voice of the narration, Engram rerank)', () => {
    const audio = sectionSearchKeys(section('settings-audio'), ZH_KEYS, false).map(zh);
    expect(audio.some((text) => text.includes('音色'))).toBe(true);
    expect(sectionSearchKeys(section('settings-engram'), ZH_KEYS, false)).toContain('settings.engram.rerank.enabled.label');
  });

  it('leaves rows of the game page out on Home, and the Home-only explanation out in the game', () => {
    const home = sectionSearchKeys(section('settings-ai-features'), ZH_KEYS, false);
    const game = sectionSearchKeys(section('settings-ai-features'), ZH_KEYS, true);
    expect(home).not.toContain('settings.aiFeatures.cot.label');
    expect(home).not.toContain('settings.aiFeatures.subsection.image');
    expect(game).toContain('settings.aiFeatures.cot.label');
    expect(home).toContain('settings.aiFeatures.textOptimization.label');
    const uiHome = sectionSearchKeys(section('settings-ui'), ZH_KEYS, false);
    const uiGame = sectionSearchKeys(section('settings-ui'), ZH_KEYS, true);
    expect(uiHome).toContain('settings.ui.showActions.descOutside');
    expect(uiHome).not.toContain('settings.ui.showActions.desc');
    expect(uiGame).toContain('settings.ui.showActions.desc');
    expect(uiGame).not.toContain('settings.ui.showActions.descOutside');
  });

  it('indexes only keys the settings page really shows (a removed row is not found by search)', () => {
    const dir = path.resolve(__dirname, '../../components');
    const sources = [
      path.join(dir, 'panels/SettingsPanel.vue'),
      ...fs.readdirSync(path.join(dir, 'settings')).map((f) => path.join(dir, 'settings', f)),
    ].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const def of SETTINGS_SECTIONS) {
      for (const key of new Set([...sectionSearchKeys(def, ZH_KEYS, true), ...sectionSearchKeys(def, ZH_KEYS, false)])) {
        expect(sources.includes(`'${key}'`), `${key} is used on the page`).toBe(true);
      }
    }
  });

  it('does not let one section claim another section\'s keys', () => {
    const owner = new Map<string, string>();
    for (const def of SETTINGS_SECTIONS) {
      for (const key of sectionSearchKeys(def, ZH_KEYS, true)) {
        expect(owner.get(key), key).toBeUndefined();
        owner.set(key, def.id);
      }
    }
  });
});

describe('sectionMatchesSearchText', () => {
  const none = () => [] as string[];

  it('an empty or blank search shows every section, reading nothing', () => {
    const label = vi.fn(() => 'x');
    const texts = vi.fn(none);
    const dom = vi.fn(() => null);
    expect(sectionMatchesSearchText('', label, texts, dom)).toBe(true);
    expect(sectionMatchesSearchText('   ', label, texts, dom)).toBe(true);
    expect(label).not.toHaveBeenCalled();
    expect(texts).not.toHaveBeenCalled();
    expect(dom).not.toHaveBeenCalled();
  });

  it('matches the nav label, then the indexed texts, then what the section shows, ignoring case and spaces', () => {
    expect(sectionMatchesSearchText(' nsfw ', () => 'NSFW', none, () => null)).toBe(true);
    expect(sectionMatchesSearchText('voice', () => 'Audio', () => ['default voice'], () => null)).toBe(true);
    expect(sectionMatchesSearchText('42', () => 'Audio', none, () => 'rate 42')).toBe(true);
  });

  it('hides a section nothing of which matches, and one that is not on the page', () => {
    expect(sectionMatchesSearchText('zzz', () => 'Audio', () => ['voice'], () => 'rate')).toBe(false);
    expect(sectionMatchesSearchText('zzz', () => undefined, none, () => null)).toBe(false);
  });

  it('stops reading once something matched', () => {
    const texts = vi.fn(() => ['voice']);
    const dom = vi.fn(() => 'voice');
    sectionMatchesSearchText('audio', () => 'Audio', texts, dom);
    expect(texts).not.toHaveBeenCalled();
    sectionMatchesSearchText('voice', () => 'Audio', texts, dom);
    expect(texts).toHaveBeenCalledTimes(1);
    expect(dom).not.toHaveBeenCalled();
  });

  it('normalizes the search text', () => {
    expect(normalizeSearch('  Engram ')).toBe('engram');
  });

  it('reads indexed texts without their placeholders', () => {
    expect(searchableText('UI Scale ({value}%)')).toBe('ui scale (%)');
    expect(searchableText('{count} rules')).toBe(' rules');
  });
});

describe('pickActiveNav', () => {
  const boxes = [
    { nav: 'a', top: -900 },
    { nav: 'b', top: -40 },
    { nav: 'c', top: 120 },
    { nav: 'd', top: 700 },
  ];

  it('lights the last section whose top passed the line, not the first one still on screen', () => {
    // b is still on screen (its top is above, its body below); c's heading crossed the line, so c is the one read.
    expect(pickActiveNav(boxes, 240, false, 800)).toBe('c');
    expect(pickActiveNav(boxes, 100, false, 800)).toBe('b');
  });

  it('does not depend on the order the boxes come in', () => {
    expect(pickActiveNav([...boxes].reverse(), 240, false, 800)).toBe('c');
  });

  it('lights the first section while none has reached the line yet', () => {
    expect(pickActiveNav([{ nav: 'a', top: 24 }, { nav: 'b', top: 500 }], 10, false, 800)).toBe('a');
  });

  it('at the very bottom, lights the last section that shows', () => {
    expect(pickActiveNav(boxes, 240, true, 800)).toBe('d');
    expect(pickActiveNav(boxes, 240, true, 600)).toBe('c');
  });

  it('gives nothing when no section shows', () => {
    expect(pickActiveNav([], 240, false, 800)).toBeNull();
  });

  it('two blocks of one entry (memory and Engram) keep that entry lit across both', () => {
    const memory = [{ nav: 'memory', top: -600 }, { nav: 'memory', top: -100 }, { nav: 'advanced', top: 500 }];
    expect(pickActiveNav(memory, 240, false, 800)).toBe('memory');
  });
});
