import { describe, it, expect } from 'vitest';
import type { WorldBook, WorldBookEntry, WorldBookScope } from './world-book';
import {
  buildCorpus,
  buildFocusedCorpus,
  extractPresentNpcNames,
  timeToOrdinal,
  isTimelineMatch,
  selectActiveEntries,
  selectActiveEntriesDetailed,
  buildWorldBookInjectionText,
  formatGameTimeForWorldBook,
  WORLD_BOOK_BUDGET,
} from './world-book-selector';
import { CAPTURED_SETTINGS_BOOK_ID, resolveCapturedBudgetRatio } from './world-book';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

// ─── Helpers ─────────────────────────────────────────────────

function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: overrides.id ?? 'e1',
    title: overrides.title ?? 'Test Entry',
    content: overrides.content ?? 'Test content for this entry.',
    type: overrides.type ?? 'world_lore',
    scope: overrides.scope ?? ['main'],
    injectionMode: overrides.injectionMode ?? 'always',
    enabled: overrides.enabled ?? true,
    shape: overrides.shape,
    keywords: overrides.keywords,
    priority: overrides.priority,
    timelineStart: overrides.timelineStart,
    timelineEnd: overrides.timelineEnd,
  };
}

function makeBook(entries: WorldBookEntry[], overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: overrides.id ?? 'book1',
    title: overrides.title ?? 'Test Book',
    entries,
    enabled: overrides.enabled ?? true,
  };
}

// ─── buildCorpus ─────────────────────────────────────────────

describe('buildCorpus', () => {
  it('combines all data sources into lowercase string', () => {
    const corpus = buildCorpus({
      environment: { location: 'Mountain Peak', weather: 'Rainy', time: 'Dawn' },
      socialNpcs: [{ name: 'Alice', identity: 'Warrior' }],
      npcFieldKeys: { name: 'name', identity: 'identity' },
      narrativeHistory: [{ content: 'The hero entered the cave.' }],
      worldEvents: [{ title: 'War', location: 'East', type: 'conflict' }],
      extraTexts: ['Dragon Lair'],
    });
    expect(corpus).toContain('mountain peak');
    expect(corpus).toContain('alice');
    expect(corpus).toContain('warrior');
    expect(corpus).toContain('the hero entered the cave.');
    expect(corpus).toContain('war');
    expect(corpus).toContain('dragon lair');
  });

  it('handles partial data sources without error', () => {
    const corpus = buildCorpus({
      environment: { location: 'Town' },
    });
    expect(corpus).toContain('town');
  });

  it('returns empty string for empty/undefined sources', () => {
    expect(buildCorpus({})).toBe('');
    expect(buildCorpus({ environment: undefined })).toBe('');
  });

  it('handles non-object/null world events gracefully', () => {
    const corpus = buildCorpus({
      worldEvents: [null, undefined, 42, 'string', { title: 'War' }] as unknown[],
    });
    expect(corpus).toContain('war');
  });

  it('handles non-object/null NPC entries gracefully', () => {
    const corpus = buildCorpus({
      socialNpcs: [null, undefined, { name: 'Bob' }] as unknown as Array<Record<string, unknown>>,
      npcFieldKeys: { name: 'name' },
    });
    expect(corpus).toContain('bob');
  });

  it('handles non-array narrativeHistory', () => {
    const corpus = buildCorpus({
      narrativeHistory: undefined,
    });
    expect(corpus).toBe('');
  });

  it('uses default NPC field keys when npcFieldKeys not provided', () => {
    const corpus = buildCorpus({
      socialNpcs: [{ name: 'DefaultKey' }],
    });
    expect(corpus).toContain('defaultkey');
  });

  it('handles extraTexts with non-string values', () => {
    const corpus = buildCorpus({
      extraTexts: [null, 42, 'Valid Text', undefined] as unknown as string[],
    });
    expect(corpus).toContain('valid text');
  });

  it('handles environment with non-string weather and time', () => {
    const corpus = buildCorpus({
      environment: { location: 'Town', weather: { desc: 'rainy' }, time: 12345 },
    });
    expect(corpus).toContain('town');
  });

  it('extracts NPC fields using provided keys', () => {
    const corpus = buildCorpus({
      socialNpcs: [{ '名称': '李明', '身份': '剑客', '位置': '天山' }],
      npcFieldKeys: { name: '名称', identity: '身份', location: '位置' },
    });
    expect(corpus).toContain('李明');
    expect(corpus).toContain('剑客');
    expect(corpus).toContain('天山');
  });
});

// ─── timeToOrdinal ───────────────────────────────────────────

describe('timeToOrdinal', () => {
  it('returns null for whitespace-only string', () => {
    expect(timeToOrdinal('   ')).toBeNull();
  });

  it('parses valid time string to ordinal', () => {
    const ord = timeToOrdinal('0001:01:01:00:00');
    expect(ord).toBeTypeOf('number');
    expect(ord).toBeGreaterThan(0);
  });

  it('returns null for empty/undefined', () => {
    expect(timeToOrdinal()).toBeNull();
    expect(timeToOrdinal('')).toBeNull();
    expect(timeToOrdinal(undefined)).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(timeToOrdinal('abc')).toBeNull();
    expect(timeToOrdinal('2024-01-01')).toBeNull();
    expect(timeToOrdinal('1:2:3')).toBeNull();
  });

  it('later times produce larger ordinals', () => {
    const early = timeToOrdinal('0001:01:01:00:00')!;
    const late = timeToOrdinal('0001:06:15:12:30')!;
    expect(late).toBeGreaterThan(early);
  });
});

// ─── isTimelineMatch ─────────────────────────────────────────

describe('isTimelineMatch', () => {
  it('matches when no start/end are set', () => {
    expect(isTimelineMatch({ shape: 'time_injection' }, '0001:03:15:10:00')).toBe(true);
  });

  it('matches when current time is within range', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineStart: '0001:01:01:00:00', timelineEnd: '0001:12:31:23:59' },
      '0001:06:15:12:00',
    )).toBe(true);
  });

  it('does not match when current time is before start', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineStart: '0002:01:01:00:00' },
      '0001:06:15:12:00',
    )).toBe(false);
  });

  it('does not match when current time is after end', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineEnd: '0001:01:01:00:00' },
      '0001:06:15:12:00',
    )).toBe(false);
  });

  it('matches when only start is set and current >= start', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineStart: '0001:01:01:00:00' },
      '0002:01:01:00:00',
    )).toBe(true);
  });

  it('matches when only end is set and current <= end', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineEnd: '0010:01:01:00:00' },
      '0005:06:15:12:00',
    )).toBe(true);
  });

  it('does not match when current time is invalid and entry has constraints', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection', timelineStart: '0001:01:01:00:00' },
      'invalid-time',
    )).toBe(false);
  });

  it('matches when current time is invalid and entry has NO constraints', () => {
    expect(isTimelineMatch(
      { shape: 'time_injection' },
      'invalid-time',
    )).toBe(true);
  });
});

// ─── selectActiveEntries ─────────────────────────────────────

describe('selectActiveEntries', () => {
  const baseParams = { activeScopes: ['main'] as WorldBookScope[], corpus: '', currentGameTime: '' };

  it('selects always+scope-match entries', () => {
    const books = [makeBook([makeEntry({ scope: ['main'] })])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(1);
  });

  it('skips entries with non-matching scope', () => {
    const books = [makeBook([makeEntry({ scope: ['opening'] })])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(0);
  });

  it('scope "all" matches any active scope', () => {
    const books = [makeBook([makeEntry({ scope: ['all'] })])];
    const result = selectActiveEntries({ ...baseParams, books, activeScopes: ['world_evolution'] });
    expect(result).toHaveLength(1);
  });

  it('selects match_any entry when keyword is in corpus', () => {
    const books = [makeBook([makeEntry({
      injectionMode: 'match_any',
      keywords: ['dragon'],
    })])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: 'a dragon appeared' });
    expect(result).toHaveLength(1);
  });

  it('skips match_any entry when keyword is NOT in corpus', () => {
    const books = [makeBook([makeEntry({
      injectionMode: 'match_any',
      keywords: ['dragon'],
    })])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: 'a wolf appeared' });
    expect(result).toHaveLength(0);
  });

  it('skips match_any entry with empty keywords array', () => {
    const books = [makeBook([makeEntry({
      injectionMode: 'match_any',
      keywords: [],
    })])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: 'anything' });
    expect(result).toHaveLength(0);
  });

  it('match_any keyword matching is case-insensitive', () => {
    const books = [makeBook([makeEntry({
      injectionMode: 'match_any',
      keywords: ['Dragon'],
    })])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: 'a DRAGON appeared' });
    expect(result).toHaveLength(1);
  });

  it('match_any with empty corpus does not inject', () => {
    const books = [makeBook([makeEntry({
      injectionMode: 'match_any',
      keywords: ['dragon'],
    })])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: '' });
    expect(result).toHaveLength(0);
  });

  it('filters time_injection entries by timeline', () => {
    const books = [makeBook([makeEntry({
      shape: 'time_injection',
      timelineStart: '0001:01:01:00:00',
      timelineEnd: '0001:06:30:23:59',
    })])];
    const inRange = selectActiveEntries({ ...baseParams, books, currentGameTime: '0001:03:15:12:00' });
    expect(inRange).toHaveLength(1);

    const outRange = selectActiveEntries({ ...baseParams, books, currentGameTime: '0002:01:01:00:00' });
    expect(outRange).toHaveLength(0);
  });

  it('filters timeline_outline entries by timeline too', () => {
    const books = [makeBook([makeEntry({
      shape: 'timeline_outline',
      timelineStart: '0005:01:01:00:00',
    })])];
    const before = selectActiveEntries({ ...baseParams, books, currentGameTime: '0003:01:01:00:00' });
    expect(before).toHaveLength(0);

    const after = selectActiveEntries({ ...baseParams, books, currentGameTime: '0006:01:01:00:00' });
    expect(after).toHaveLength(1);
  });

  it('skips disabled entries', () => {
    const books = [makeBook([makeEntry({ enabled: false })])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(0);
  });

  it('skips all entries from disabled book', () => {
    const books = [makeBook([makeEntry()], { enabled: false })];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(0);
  });

  it('skips entries with empty content', () => {
    const books = [makeBook([makeEntry({ content: '' })])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(0);
  });

  it('sorts by priority descending', () => {
    const books = [makeBook([
      makeEntry({ id: 'low', priority: 10 }),
      makeEntry({ id: 'high', priority: 100 }),
      makeEntry({ id: 'mid', priority: 50 }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result.map((e) => e.id)).toEqual(['high', 'mid', 'low']);
  });

  it('maintains insertion order for same priority (stable sort)', () => {
    const books = [makeBook([
      makeEntry({ id: 'a', priority: 50 }),
      makeEntry({ id: 'b', priority: 50 }),
      makeEntry({ id: 'c', priority: 50 }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('enforces budget — skips entries exceeding char limit', () => {
    const longContent = 'x'.repeat(5000);
    const books = [makeBook([
      makeEntry({ id: 'first', content: longContent, priority: 100 }),
      makeEntry({ id: 'second', content: longContent, priority: 50 }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books, maxChars: 6000 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('first');
  });

  it('uses max of active scopes for default budget', () => {
    const main = WORLD_BOOK_BUDGET.main;
    const opening = WORLD_BOOK_BUDGET.opening;
    expect(opening).toBeGreaterThan(main);

    const longContent = 'x'.repeat(main + 100);
    const books = [makeBook([
      makeEntry({ id: 'first', content: longContent, priority: 100, scope: ['all'] }),
      makeEntry({ id: 'second', content: 'short', priority: 50, scope: ['all'] }),
    ])];

    const resultMain = selectActiveEntries({ ...baseParams, books, activeScopes: ['main'] });
    expect(resultMain).toHaveLength(1);

    const resultBoth = selectActiveEntries({ ...baseParams, books, activeScopes: ['main', 'opening'] });
    expect(resultBoth).toHaveLength(2);
  });

  it('returns empty for empty books array', () => {
    const result = selectActiveEntries({ ...baseParams, books: [] });
    expect(result).toHaveLength(0);
  });

  it('recall scope with budget=0 returns all candidates (unlimited)', () => {
    const books = [makeBook([
      makeEntry({ id: 'a', content: 'x'.repeat(10000), scope: ['recall'] }),
      makeEntry({ id: 'b', content: 'y'.repeat(10000), scope: ['recall'] }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books, activeScopes: ['recall'] });
    expect(result).toHaveLength(2);
  });

  it('empty activeScopes defaults to main', () => {
    const books = [makeBook([
      makeEntry({ scope: ['main'] }),
      makeEntry({ id: 'opening-only', scope: ['opening'] }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books, activeScopes: [] });
    expect(result).toHaveLength(1);
    expect(result[0].scope).toContain('main');
  });

  it('handles entry with undefined content (fallback via ??)', () => {
    const entry = makeEntry();
    delete (entry as unknown as Record<string, unknown>).content;
    const books = [makeBook([entry])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(0);
  });

  it('handles entry with undefined scope (defaults to main)', () => {
    const entry = makeEntry();
    delete (entry as unknown as Record<string, unknown>).scope;
    const books = [makeBook([entry])];
    const result = selectActiveEntries({ ...baseParams, books });
    expect(result).toHaveLength(1);
  });

  it('handles match_any entry with undefined keywords (non-array)', () => {
    const entry = makeEntry({ injectionMode: 'match_any' });
    delete (entry as unknown as Record<string, unknown>).keywords;
    const books = [makeBook([entry])];
    const result = selectActiveEntries({ ...baseParams, books, corpus: 'anything' });
    expect(result).toHaveLength(0);
  });

  // BEHAVIOR CHANGE (2026-08-21, deliberate — design §7.2):
  // The old "the first entry is always admitted regardless of budget" exception was
  // removed. It let one oversized top-priority entry blow straight past the cap, and
  // with the two-pool budget there is no longer a meaningful "first" entry at all.
  it('an entry larger than the whole budget is now SKIPPED, not force-admitted', () => {
    const hugeContent = 'x'.repeat(50000);
    const books = [makeBook([makeEntry({ content: hugeContent })])];
    const result = selectActiveEntries({ ...baseParams, books, maxChars: 100 });
    expect(result).toHaveLength(0);
  });

  it('skipping an oversized entry does not block a smaller one behind it', () => {
    const books = [makeBook([
      makeEntry({ id: 'huge', priority: 100, content: 'x'.repeat(5000) }),
      makeEntry({ id: 'small', priority: 50, content: 'ok' }),
    ])];
    const result = selectActiveEntries({ ...baseParams, books, maxChars: 100 });
    expect(result.map((e) => e.id)).toEqual(['small']);
  });
});

// ─── buildWorldBookInjectionText ─────────────────────────────

describe('buildWorldBookInjectionText', () => {
  it('groups entries by type into separate text blocks', () => {
    const entries = [
      makeEntry({ type: 'world_lore', content: 'Lore content' }),
      makeEntry({ type: 'system_rule', content: 'Rule content' }),
      makeEntry({ type: 'command_rule', content: 'Command content' }),
      makeEntry({ type: 'output_rule', content: 'Output content' }),
    ];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toContain('Lore content');
    expect(result.systemRuleText).toContain('Rule content');
    expect(result.commandRuleText).toContain('Command content');
    expect(result.outputRuleText).toContain('Output content');
  });

  it('handles mixed types correctly', () => {
    const entries = [
      makeEntry({ id: 'l1', type: 'world_lore', content: 'Lore 1' }),
      makeEntry({ id: 'l2', type: 'world_lore', content: 'Lore 2' }),
      makeEntry({ id: 's1', type: 'system_rule', content: 'Rule 1' }),
    ];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toContain('Lore 1');
    expect(result.worldLoreText).toContain('Lore 2');
    expect(result.systemRuleText).toContain('Rule 1');
    expect(result.commandRuleText).toBe('');
    expect(result.outputRuleText).toBe('');
  });

  it('returns empty strings for no matching entries', () => {
    const result = buildWorldBookInjectionText([]);
    expect(result.worldLoreText).toBe('');
    expect(result.systemRuleText).toBe('');
    expect(result.commandRuleText).toBe('');
    expect(result.outputRuleText).toBe('');
    expect(result.selectedEntries).toHaveLength(0);
  });

  it('handles entry with empty title (no ### prefix)', () => {
    const entries = [makeEntry({ type: 'world_lore', title: '', content: 'Body only' })];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toContain('Body only');
    expect(result.worldLoreText).not.toContain('###');
  });

  it('skips entries with empty content in group text', () => {
    const entries = [makeEntry({ type: 'world_lore', content: '' })];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toBe('');
  });

  it('handles entry with unknown type gracefully', () => {
    const entries = [makeEntry({ type: 'unknown_type' as WorldBookEntry['type'], content: 'X' })];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toBe('');
    expect(result.systemRuleText).toBe('');
  });

  it('wraps each group in XML tags (engine-safe, no Chinese)', () => {
    const entries = [makeEntry({ type: 'world_lore', content: 'Some lore' })];
    const result = buildWorldBookInjectionText(entries);
    expect(result.worldLoreText).toMatch(/^<world_book_lore>/);
    expect(result.worldLoreText).toMatch(/<\/world_book_lore>$/);
  });

  it('entry with undefined type defaults to world_lore group', () => {
    const entry = makeEntry({ content: 'Default type' });
    delete (entry as unknown as Record<string, unknown>).type;
    const result = buildWorldBookInjectionText([entry]);
    expect(result.worldLoreText).toContain('Default type');
  });

  it('entry with undefined content in group text is skipped', () => {
    const entry = makeEntry({ type: 'world_lore' });
    delete (entry as unknown as Record<string, unknown>).content;
    const result = buildWorldBookInjectionText([entry]);
    expect(result.worldLoreText).toBe('');
  });

  it('entry with undefined title renders content without ### header', () => {
    const entry = makeEntry({ content: 'No title content' });
    delete (entry as unknown as Record<string, unknown>).title;
    const result = buildWorldBookInjectionText([entry]);
    expect(result.worldLoreText).toContain('No title content');
    expect(result.worldLoreText).not.toContain('###');
  });
});

// ─── B0-2: formatGameTimeForWorldBook ────────────────────────
//
// Regression for a shipped bug: `世界.时间` is an OBJECT, but SystemPromptBuilder
// passed `typeof gameTime === 'string' ? gameTime : ''` into the selector, i.e.
// always ''. `isTimelineMatch` rejects every entry that HAS a start/end when the
// current time is unparseable, so EVERY timeline-scoped world book entry (including
// SillyTavern-imported lorebooks) was silently disabled in the main round.

const TF = DEFAULT_ENGINE_PATHS.gameTimeFieldNames;

describe('formatGameTimeForWorldBook (B0-2)', () => {
  it('formats the game-time state object into YYYY:MM:DD:HH:MM', () => {
    expect(formatGameTimeForWorldBook({ 年: 1, 月: 1, 日: 15, 小时: 8, 分钟: 30 }, TF))
      .toBe('0001:01:15:08:30');
  });

  it('produces a value timeToOrdinal can actually parse', () => {
    const formatted = formatGameTimeForWorldBook({ 年: 3, 月: 12, 日: 2, 小时: 23, 分钟: 5 }, TF);
    expect(timeToOrdinal(formatted)).not.toBeNull();
  });

  it('defaults hour/minute to 0 when the pack only tracks calendar days', () => {
    expect(formatGameTimeForWorldBook({ 年: 2, 月: 4, 日: 9 }, TF)).toBe('0002:04:09:00:00');
  });

  it('accepts numeric strings (packs that store time as text fields)', () => {
    expect(formatGameTimeForWorldBook({ 年: '5', 月: '6', 日: '7', 小时: '1', 分钟: '2' }, TF))
      .toBe('0005:06:07:01:02');
  });

  it('passes through an already-valid formatted string', () => {
    expect(formatGameTimeForWorldBook('0001:02:03:04:05', TF)).toBe('0001:02:03:04:05');
  });

  it('returns empty string for unusable values', () => {
    expect(formatGameTimeForWorldBook(undefined, TF)).toBe('');
    expect(formatGameTimeForWorldBook(null, TF)).toBe('');
    expect(formatGameTimeForWorldBook('not a time', TF)).toBe('');
    expect(formatGameTimeForWorldBook([1, 2, 3], TF)).toBe('');
    expect(formatGameTimeForWorldBook({}, TF)).toBe('');
    expect(formatGameTimeForWorldBook({ 年: 1, 月: 2 }, TF)).toBe(''); // day missing
    expect(formatGameTimeForWorldBook({ 年: 'x', 月: 2, 日: 3 }, TF)).toBe('');
    expect(formatGameTimeForWorldBook({ 年: -1, 月: 2, 日: 3 }, TF)).toBe('');
  });

  it('returns empty string when the year overflows what the matcher accepts', () => {
    // timeToOrdinal only accepts 1-6 year digits — the round-trip guard must catch this.
    expect(formatGameTimeForWorldBook({ 年: 12345678, 月: 1, 日: 1 }, TF)).toBe('');
  });

  it('honours a pack that renames the time fields (engine stays content-free)', () => {
    const custom = { year: 'y', month: 'm', day: 'd', hour: 'h', minute: 'min' };
    expect(formatGameTimeForWorldBook({ y: 9, m: 8, d: 7, h: 6, min: 5 }, custom))
      .toBe('0009:08:07:06:05');
  });

  it('the formatted value makes timeline entries match again (the actual bug)', () => {
    const entry = makeEntry({
      id: 'festival',
      shape: 'time_injection',
      timelineStart: '0001:01:10:00:00',
      timelineEnd: '0001:01:20:00:00',
    });
    const gameTime = { 年: 1, 月: 1, 日: 15, 小时: 8, 分钟: 30 };

    // Before the fix the builder handed the selector '' →
    expect(isTimelineMatch(entry, '')).toBe(false);
    // After the fix →
    expect(isTimelineMatch(entry, formatGameTimeForWorldBook(gameTime, TF))).toBe(true);
  });

  it('an out-of-range timeline entry still does NOT match', () => {
    const entry = makeEntry({
      shape: 'time_injection',
      timelineStart: '0002:01:01:00:00',
    });
    const formatted = formatGameTimeForWorldBook({ 年: 1, 月: 6, 日: 1 }, TF);
    expect(isTimelineMatch(entry, formatted)).toBe(false);
  });

  it('selectActiveEntries admits a timeline entry once the real game time is supplied', () => {
    const books: WorldBook[] = [{
      id: 'b1',
      title: 'Book',
      entries: [makeEntry({
        id: 'tl',
        shape: 'time_injection',
        timelineStart: '0001:01:10:00:00',
        timelineEnd: '0001:01:20:00:00',
      })],
    }];
    const gameTime = { 年: 1, 月: 1, 日: 15, 小时: 8, 分钟: 30 };

    const before = selectActiveEntries({
      books, activeScopes: ['main'] as WorldBookScope[], corpus: '', currentGameTime: '',
    });
    expect(before).toHaveLength(0);

    const after = selectActiveEntries({
      books,
      activeScopes: ['main'] as WorldBookScope[],
      corpus: '',
      currentGameTime: formatGameTimeForWorldBook(gameTime, TF),
    });
    expect(after.map((e) => e.id)).toEqual(['tl']);
  });
});

// ═══════════════════════════════════════════════════════════════
//  P0 — two-pool budget, broad/focused corpora, explicit ordering
// ═══════════════════════════════════════════════════════════════

function userBook(entries: WorldBookEntry[], id = 'user_book'): WorldBook {
  return { id, title: 'User Book', enabled: true, entries };
}

function capturedBook(entries: WorldBookEntry[]): WorldBook {
  return {
    id: CAPTURED_SETTINGS_BOOK_ID,
    title: '自动设定集',
    enabled: true,
    builtin: true,
    ownership: 'slot',
    origin: 'system-captured',
    entries,
  };
}

function capturedEntry(overrides: Partial<WorldBookEntry> & { capturedRound?: number } = {}): WorldBookEntry {
  const { capturedRound = 1, ...rest } = overrides;
  return {
    ...makeEntry({
      injectionMode: 'match_any',
      keywords: ['林月'],
      priority: 40,
      ...rest,
    }),
    matchSource: 'focused',
    capturedSetting: {
      schemaVersion: 1,
      source: 'user-captured',
      kind: 'character',
      evidence: '林月从小怕水',
      capturedRound,
      inputHash: 'h',
      status: 'active',
      entityRefs: ['林月'],
      injectedCount: 0,
    },
  };
}

describe('broad / focused corpora (P0)', () => {
  it('buildFocusedCorpus only carries this round\'s signal', () => {
    const focused = buildFocusedCorpus({
      userInput: '我带她去码头',
      location: '城南',
      presentNpcNames: ['林月'],
      triggeredEventTexts: ['灯节开幕'],
    });
    expect(focused).toContain('码头');
    expect(focused).toContain('城南');
    expect(focused).toContain('林月');
    expect(focused).toContain('灯节开幕');
  });

  it('extractPresentNpcNames keeps only NPCs flagged present, via injected keys', () => {
    const npcs = [
      { 名称: '林月', 是否在场: true },
      { 名称: '张三', 是否在场: false },
      { 名称: '李四' },
      { 名称: '', 是否在场: true },
    ];
    expect(extractPresentNpcNames(npcs, '名称', '是否在场')).toEqual(['林月']);
    // Pack-renamed keys must work too (engine stays content-free).
    expect(extractPresentNpcNames([{ n: 'A', here: true }], 'n', 'here')).toEqual(['A']);
    expect(extractPresentNpcNames(undefined, '名称', '是否在场')).toEqual([]);
  });

  it('a focused entry matches when its NPC is PRESENT', () => {
    const books = [capturedBook([capturedEntry({ id: 'c1' })])];
    const result = selectActiveEntriesDetailed({
      books,
      activeScopes: ['main'],
      corpora: { broad: '', focused: buildFocusedCorpus({ presentNpcNames: ['林月'] }) },
    });
    expect(result.selected.map((e) => e.id)).toEqual(['c1']);
  });

  it('a focused entry does NOT match when its NPC merely exists in the full NPC table', () => {
    // This is the whole point of `focused`: the broad corpus contains every social NPC,
    // so without it a captured character setting would be a permanent resident.
    const broad = buildCorpus({
      socialNpcs: [{ 名称: '林月', 是否在场: false }],
      npcFieldKeys: { name: '名称' },
    });
    expect(broad).toContain('林月');

    const result = selectActiveEntriesDetailed({
      books: [capturedBook([capturedEntry({ id: 'c1' })])],
      activeScopes: ['main'],
      corpora: { broad, focused: buildFocusedCorpus({ presentNpcNames: [] }) },
    });
    expect(result.selected).toHaveLength(0);
    expect(result.skipped.find((x) => x.entryId === 'c1')?.reason).toBe('no_keyword');
  });

  it('a broad (legacy) entry still matches against the wide corpus', () => {
    const broad = buildCorpus({
      socialNpcs: [{ 名称: '林月', 是否在场: false }],
      npcFieldKeys: { name: '名称' },
    });
    const entry = makeEntry({ id: 'legacy', injectionMode: 'match_any', keywords: ['林月'] });
    const result = selectActiveEntriesDetailed({
      books: [userBook([entry])],
      activeScopes: ['main'],
      corpora: { broad, focused: '' },
    });
    expect(result.selected.map((e) => e.id)).toEqual(['legacy']);
  });

  it('the current input makes a keyword hit on the SAME round (was one round late)', () => {
    const broad = buildCorpus({ extraTexts: ['我在码头遇见了老渔夫'] });
    const entry = makeEntry({ id: 'dock', injectionMode: 'match_any', keywords: ['码头'] });
    const result = selectActiveEntries({
      books: [userBook([entry])],
      activeScopes: ['main'],
      corpora: { broad, focused: '' },
    });
    expect(result.map((e) => e.id)).toEqual(['dock']);
  });

  it('legacy single-corpus callers keep matching exactly as before', () => {
    const entry = makeEntry({ id: 'legacy', injectionMode: 'match_any', keywords: ['码头'] });
    const result = selectActiveEntries({
      books: [userBook([entry])],
      activeScopes: ['main'],
      corpus: '玩家来到码头',
    });
    expect(result.map((e) => e.id)).toEqual(['legacy']);
  });
});

describe('two-pool budget: hand-authored first, captured capped (P0 / D1)', () => {
  const filler = (n: number) => 'x'.repeat(n);

  it('hand-authored entries are admitted from the FULL budget, captured only from a share', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: 'u1', content: filler(300) })]),
        capturedBook([capturedEntry({ id: 'c1', content: filler(300), injectionMode: 'always' })]),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
      maxChars: 1000,
      capturedBudgetRatio: 0.6,
    });
    expect(result.selected.map((e) => e.id)).toEqual(['u1', 'c1']);
    expect(result.capturedCap).toBe(600);
    expect(result.capturedHits).toEqual(['c1']);
  });

  it('captured entries can NEVER push a hand-authored entry out', () => {
    // 20 captured entries, each big enough to swallow the budget on their own if they went first.
    const captured = Array.from({ length: 20 }, (_, i) =>
      capturedEntry({ id: `c${i}`, content: filler(200), injectionMode: 'always', capturedRound: i }));
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([
          makeEntry({ id: 'u1', content: filler(400), priority: 50 }),
          makeEntry({ id: 'u2', content: filler(400), priority: 50 }),
        ]),
        capturedBook(captured),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
      maxChars: 1000,
      capturedBudgetRatio: 0.6,
    });
    // Both hand-authored entries survive...
    expect(result.selected.map((e) => e.id)).toContain('u1');
    expect(result.selected.map((e) => e.id)).toContain('u2');
    // ...and the captured pool only gets what is left, capped.
    expect(result.capturedChars).toBeLessThanOrEqual(result.capturedCap);
    expect(result.userChars + result.capturedChars).toBeLessThanOrEqual(1000);
  });

  it('adding a captured pool does not change WHICH hand-authored entries are selected', () => {
    // This is the real acceptance metric: "the user pool selection is identical
    // with and without the captured pool" — not "every user entry always injects".
    const users = userBook(Array.from({ length: 12 }, (_, i) =>
      makeEntry({ id: `u${i}`, content: filler(100), priority: 50 })));
    const withoutCaptured = selectActiveEntriesDetailed({
      books: [users], activeScopes: ['main'], corpora: { broad: '', focused: '' }, maxChars: 700,
    });
    const withCaptured = selectActiveEntriesDetailed({
      books: [users, capturedBook([capturedEntry({ id: 'c1', content: filler(100), injectionMode: 'always' })])],
      activeScopes: ['main'], corpora: { broad: '', focused: '' }, maxChars: 700,
    });
    const userIdsOf = (r: { selected: WorldBookEntry[] }) =>
      r.selected.filter((e) => e.id.startsWith('u')).map((e) => e.id);
    expect(userIdsOf(withCaptured)).toEqual(userIdsOf(withoutCaptured));
  });

  it('captured entries never exceed their quota even when the budget has room', () => {
    const captured = Array.from({ length: 10 }, (_, i) =>
      capturedEntry({ id: `c${i}`, content: filler(100), injectionMode: 'always', capturedRound: i }));
    const result = selectActiveEntriesDetailed({
      books: [capturedBook(captured)],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
      maxChars: 1000,
      capturedBudgetRatio: 0.3,
    });
    expect(result.capturedCap).toBe(300);
    expect(result.capturedChars).toBeLessThanOrEqual(300);
    // The rest are reported as quota-limited, not silently dropped.
    expect(result.skipped.some((x) => x.reason === 'captured_quota')).toBe(true);
  });

  it('distinguishes "quota is the wall" from "the whole budget is the wall"', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: 'u1', content: filler(950) })]),
        capturedBook([capturedEntry({ id: 'c1', content: filler(200), injectionMode: 'always' })]),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
      maxChars: 1000,
      capturedBudgetRatio: 0.6,
    });
    expect(result.selected.map((e) => e.id)).toEqual(['u1']);
    expect(result.skipped.find((x) => x.entryId === 'c1')?.reason).toBe('budget');
  });

  it('an unlimited budget (recall scope) ignores the quota entirely', () => {
    const result = selectActiveEntriesDetailed({
      books: [capturedBook([capturedEntry({
        id: 'c1', injectionMode: 'always', content: filler(9999), scope: ['recall'],
      })])],
      activeScopes: ['recall'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.selected.map((e) => e.id)).toEqual(['c1']);
    expect(result.capturedHits).toEqual(['c1']);
  });

  it('resolveCapturedBudgetRatio clamps garbage into the supported range', () => {
    expect(resolveCapturedBudgetRatio(0.6)).toBe(0.6);
    expect(resolveCapturedBudgetRatio(0)).toBe(0.2);
    expect(resolveCapturedBudgetRatio(5)).toBe(0.8);
    expect(resolveCapturedBudgetRatio('nope')).toBe(0.6);
    expect(resolveCapturedBudgetRatio(undefined)).toBe(0.6);
  });
});

describe('explicit ordering + skip reasons (P0)', () => {
  it('hand-authored: priority desc → book.id asc → entry.id asc', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: 'b', priority: 50 }), makeEntry({ id: 'a', priority: 50 })], 'zbook'),
        userBook([makeEntry({ id: 'c', priority: 50 }), makeEntry({ id: 'hi', priority: 90 })], 'abook'),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.selected.map((e) => e.id)).toEqual(['hi', 'c', 'a', 'b']);
  });

  it('captured: pinned first → most recent first → id (priority is NOT used)', () => {
    const result = selectActiveEntriesDetailed({
      books: [capturedBook([
        capturedEntry({ id: 'old', injectionMode: 'always', capturedRound: 1, priority: 99 }),
        capturedEntry({ id: 'new', injectionMode: 'always', capturedRound: 9, priority: 1 }),
        capturedEntry({ id: 'pinnedOld', injectionMode: 'always', capturedRound: 0, priority: 1 }),
      ])],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    // All three are `always` (pinned); recency decides.
    expect(result.selected.map((e) => e.id)).toEqual(['new', 'old', 'pinnedOld']);
  });

  it('a player-pinned captured entry outranks a newer un-pinned one', () => {
    const result = selectActiveEntriesDetailed({
      books: [capturedBook([
        capturedEntry({ id: 'newer', injectionMode: 'match_any', keywords: ['林月'], capturedRound: 9 }),
        capturedEntry({ id: 'pinned', injectionMode: 'always', capturedRound: 1 }),
      ])],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '林月' },
    });
    expect(result.selected.map((e) => e.id)).toEqual(['pinned', 'newer']);
  });

  it('reports a reason for every entry that was considered but not injected', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        { id: 'off', title: 'Off', enabled: false, entries: [makeEntry({ id: 'inOffBook' })] },
        userBook([
          makeEntry({ id: 'disabled', enabled: false }),
          makeEntry({ id: 'blank', content: '   ' }),
          makeEntry({ id: 'wrongScope', scope: ['opening'] }),
          makeEntry({ id: 'noKw', injectionMode: 'match_any', keywords: ['nothere'] }),
          makeEntry({
            id: 'tooLate', shape: 'time_injection', timelineStart: '0009:01:01:00:00',
          }),
        ]),
      ],
      activeScopes: ['main'],
      corpora: { broad: 'corpus', focused: '' },
      currentGameTime: '0001:01:01:00:00',
    });
    const reasonOf = (id: string) => result.skipped.find((x) => x.entryId === id)?.reason;
    expect(reasonOf('inOffBook')).toBe('book_disabled');
    expect(reasonOf('disabled')).toBe('entry_disabled');
    expect(reasonOf('blank')).toBe('empty_content');
    expect(reasonOf('wrongScope')).toBe('scope');
    expect(reasonOf('noKw')).toBe('no_keyword');
    expect(reasonOf('tooLate')).toBe('timeline');
    expect(result.skipped.every((x) => x.estimatedChars > 0)).toBe(true);
  });

  it('capturedHits lists only injected captured entries — the write-back list', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: 'u1' })]),
        capturedBook([
          capturedEntry({ id: 'hit', injectionMode: 'always' }),
          capturedEntry({ id: 'miss', injectionMode: 'match_any', keywords: ['nowhere'] }),
        ]),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.capturedHits).toEqual(['hit']);
  });
});

// ─── P0 code-review regressions (2026-08-21) ─────────────────

describe('P0 code-review regressions', () => {
  const filler = (n: number) => 'x'.repeat(n);

  it('a NaN ratio falls back to the default instead of removing the cap entirely', () => {
    // `x > NaN` is always false, so an unguarded NaN cap would make the captured pool
    // completely unbounded — worse than "uncapped by ratio", it would ignore the budget.
    const captured = Array.from({ length: 20 }, (_, i) =>
      capturedEntry({ id: `c${i}`, content: filler(200), injectionMode: 'always', capturedRound: i }));
    const result = selectActiveEntriesDetailed({
      books: [capturedBook(captured)],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
      maxChars: 1000,
      capturedBudgetRatio: Number.NaN,
    });
    expect(result.capturedCap).toBe(600); // floor(1000 * 0.6)
    expect(result.capturedChars).toBeLessThanOrEqual(600);
  });

  it('attribution survives two books holding entries with the SAME id', () => {
    // Entry ids are only unique WITHIN a book — an id-keyed lookup would mislabel one.
    const dupe = 'dup_id';
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: dupe, title: 'hand-written' })], 'user_book'),
        capturedBook([capturedEntry({ id: dupe, title: 'captured', injectionMode: 'always' })]),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.selectedInfo).toHaveLength(2);
    const byTitle = (t: string) => result.selectedInfo.find((i) => i.entry.title === t);
    expect(byTitle('hand-written')?.origin).toBe('user-authored');
    expect(byTitle('hand-written')?.bookId).toBe('user_book');
    expect(byTitle('captured')?.origin).toBe('system-captured');
    expect(byTitle('captured')?.bookId).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(byTitle('captured')?.matchSource).toBe('focused');
  });

  it('selectedInfo stays aligned with selected (same entries, same order)', () => {
    const result = selectActiveEntriesDetailed({
      books: [
        userBook([makeEntry({ id: 'u2', priority: 10 }), makeEntry({ id: 'u1', priority: 90 })]),
        capturedBook([capturedEntry({ id: 'c1', injectionMode: 'always' })]),
      ],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.selectedInfo.map((i) => i.entry)).toEqual(result.selected);
  });

  it('the unlimited (recall) path reports unlimited=true and a non-misleading cap', () => {
    const result = selectActiveEntriesDetailed({
      books: [capturedBook([capturedEntry({
        id: 'c1', injectionMode: 'always', content: filler(500), scope: ['recall'],
      })])],
      activeScopes: ['recall'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.unlimited).toBe(true);
    expect(result.capturedChars).toBeGreaterThan(0);
    // capturedCap must not be 0 here — a UI rendering `used / cap` would read that as
    // "infinitely over budget" rather than "no cap".
    expect(result.capturedCap).toBe(result.capturedChars);
  });

  it('a bounded scope reports unlimited=false', () => {
    const result = selectActiveEntriesDetailed({
      books: [userBook([makeEntry({ id: 'u1' })])],
      activeScopes: ['main'],
      corpora: { broad: '', focused: '' },
    });
    expect(result.unlimited).toBe(false);
    expect(result.budget).toBe(WORLD_BOOK_BUDGET.main);
  });
});
