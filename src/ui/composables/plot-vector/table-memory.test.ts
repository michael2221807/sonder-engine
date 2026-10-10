// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATING_VERSION, type CardRating } from '@/features/plot-vector/rating';
import type { TableCard, TableModel } from '@/features/plot-vector/table-model';
import {
  compareSeen,
  createTierCacheDropper,
  PREFS_KEY,
  ratingsKey,
  readPrefs,
  readRatingCache,
  readSeen,
  seenKey,
  writeRatingCache,
  writeSeen,
  type SeenCard,
} from './table-memory';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

const label = (zh: string) => ({ zh, en: zh });
function card(id: string, over: Partial<TableCard> = {}): TableCard {
  return { id, kind: 'item', name: label(id), resting: false, ...over } as TableCard;
}
function model(cards: TableCard[], forming: Array<{ id: string; kind: string; name: string }> = []): Pick<TableModel, 'cards' | 'forming'> {
  return { cards: Object.fromEntries(cards.map((c) => [c.id, c])), forming: forming as never };
}
const validRating = (ratio: number): CardRating => ({
  ratio, tier: 'common', triggerRate: 0.5, version: RATING_VERSION,
  profile: { perTrip: { push: 1, drag: 0, social: 0, chance: 0 }, perAct: { push: 1, drag: 0, social: 0, chance: 0 }, route: false, store: false },
}) as CardRating;

describe('readPrefs', () => {
  it('defaults: animate on, exact off', () => {
    expect(readPrefs()).toEqual({ animate: true, exact: false });
  });
  it('reads stored switches; only an explicit false / true changes them', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ animate: false, exact: true }));
    expect(readPrefs()).toEqual({ animate: false, exact: true });
    localStorage.setItem(PREFS_KEY, JSON.stringify({ animate: 'no', exact: 1 }));
    expect(readPrefs()).toEqual({ animate: true, exact: false });
  });
  it('survives corrupted JSON', () => {
    localStorage.setItem(PREFS_KEY, '{not json');
    expect(readPrefs()).toEqual({ animate: true, exact: false });
  });
});

describe('seen record', () => {
  it('round-trips through writeSeen / readSeen with the v2 envelope', () => {
    const cards: Record<string, SeenCard> = { a: { kind: 'item', name: label('A'), level: 2 } };
    writeSeen('s/1', cards);
    expect(JSON.parse(localStorage.getItem(seenKey('s/1'))!)).toEqual({ v: 2, cards });
    expect(readSeen('s/1')).toEqual(cards);
  });
  it('reads the old ids-only array (non-string ids dropped), and null for missing / empty / broken data', () => {
    localStorage.setItem(seenKey('old'), JSON.stringify(['a', 7, 'b']));
    expect(readSeen('old')).toEqual({ a: {}, b: {} });
    expect(readSeen('missing')).toBeNull();
    localStorage.setItem(seenKey('bad'), '{oops');
    expect(readSeen('bad')).toBeNull();
    localStorage.setItem(seenKey('nocards'), JSON.stringify({ v: 2 }));
    expect(readSeen('nocards')).toBeNull();
    localStorage.setItem(seenKey('scalar'), JSON.stringify(5));
    expect(readSeen('scalar')).toBeNull();
  });
  it('writeSeen swallows a failing storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => writeSeen('s', {})).not.toThrow();
  });
});

describe('rating cache', () => {
  it('round-trips current ratings', () => {
    writeRatingCache('s', new Map([['a', validRating(2)]]));
    const back = readRatingCache('s');
    expect([...back.keys()]).toEqual(['a']);
    expect(back.get('a')?.ratio).toBe(2);
  });
  it('drops entries that are not current ratings, and everything for a wrong version', () => {
    localStorage.setItem(ratingsKey('s'), JSON.stringify({ v: RATING_VERSION, ratings: { good: validRating(1), bad: { version: 1 } } }));
    expect([...readRatingCache('s').keys()]).toEqual(['good']);
    localStorage.setItem(ratingsKey('s'), JSON.stringify({ v: RATING_VERSION - 1, ratings: { good: validRating(1) } }));
    expect(readRatingCache('s').size).toBe(0);
  });
  it('is empty for missing or corrupted data', () => {
    expect(readRatingCache('none').size).toBe(0);
    localStorage.setItem(ratingsKey('x'), 'nope');
    expect(readRatingCache('x').size).toBe(0);
    localStorage.setItem(ratingsKey('y'), JSON.stringify({ v: RATING_VERSION }));
    expect(readRatingCache('y').size).toBe(0);
  });
});

describe('createTierCacheDropper', () => {
  const key = (slot: string) => `aga:plotVector:tiers:${slot}`;
  it('removes the old tiers-only record once per slot', () => {
    const drop = createTierCacheDropper();
    localStorage.setItem(key('a'), '1');
    drop('a');
    expect(localStorage.getItem(key('a'))).toBeNull();
    localStorage.setItem(key('a'), '2'); // written again later
    drop('a');
    expect(localStorage.getItem(key('a'))).toBe('2'); // already dropped once: left alone
    localStorage.setItem(key('b'), '3');
    drop('b');
    expect(localStorage.getItem(key('b'))).toBeNull();
  });
  it('every dropper keeps its own memory (one per table instance, not shared)', () => {
    const first = createTierCacheDropper();
    const second = createTierCacheDropper();
    localStorage.setItem(key('s'), '1');
    first('s');
    expect(localStorage.getItem(key('s'))).toBeNull();
    localStorage.setItem(key('s'), '2');
    second('s'); // a fresh instance still cleans up
    expect(localStorage.getItem(key('s'))).toBeNull();
  });
});

describe('compareSeen', () => {
  it('builds the record from cards and forming cards', () => {
    const { record } = compareSeen(model(
      [card('a', { line: label('L'), tier: 'rare', level: { value: 3 }, resting: true }), card('b')],
      [{ id: 'f', kind: 'item', name: 'Forming' }],
    ), null);
    expect(record.a).toEqual({ kind: 'item', name: label('a'), line: label('L'), tier: 'rare', level: 3, resting: true });
    expect(record.b).toEqual({ kind: 'item', name: label('b') });
    expect(record.f).toEqual({ kind: 'item', name: { zh: 'Forming', en: 'Forming' } });
  });

  it('first visit (no previous record): nothing has arrived', () => {
    const { arrivals } = compareSeen(model([card('a')]), null);
    expect(arrivals).toEqual({ fresh: [], leveled: [], charged: [], departed: [] });
  });

  it('new cards are fresh; growth is leveled; coming back from rest is charged', () => {
    const before = {
      grow: { kind: 'talent', level: 1 },
      rest: { kind: 'supply', resting: true },
      same: { kind: 'item' },
      stay: { kind: 'supply', resting: true },
    } as Record<string, Partial<SeenCard>>;
    const { arrivals } = compareSeen(model([
      card('new'),
      card('grow', { kind: 'talent', level: { value: 2 } }),
      card('rest', { kind: 'supply', resting: false }),
      card('same'),
      card('stay', { kind: 'supply', resting: true }),
    ]), before);
    expect(arrivals.fresh).toEqual(['new']);
    expect(arrivals.leveled).toEqual(['grow']);
    expect(arrivals.charged).toEqual(['rest']);
    expect(arrivals.departed).toEqual([]);
  });

  it('a level that did not grow, or that had none before, is not "leveled"', () => {
    const { arrivals } = compareSeen(model([card('a', { level: { value: 1 } }), card('b', { level: { value: 5 } })]), { a: { level: 1 }, b: {} });
    expect(arrivals.leveled).toEqual([]);
  });

  it('only used-up supply cards with a remembered name depart, carrying line and tier', () => {
    const before = {
      gone: { kind: 'supply', name: label('Gone'), line: label('Line'), tier: 'rare' },
      noName: { kind: 'supply' },
      item: { kind: 'item', name: label('Item') },
      kept: { kind: 'supply', name: label('Kept') },
    } as Record<string, Partial<SeenCard>>;
    const { arrivals } = compareSeen(model([card('kept', { kind: 'supply' })]), before);
    expect(arrivals.departed).toEqual([
      { id: 'gone', kind: 'supply', name: label('Gone'), line: label('Line'), tier: 'rare', resting: false },
    ]);
  });
});
