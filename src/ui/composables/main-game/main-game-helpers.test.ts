import { describe, expect, it, vi } from 'vitest';
import type { BookmarkedRound } from '@/engine/pipeline/types';
import { bookmarkSnippet, defaultBookmarkName, toggleBookmarkList } from './bookmarks';
import { MAX_SEARCH_RESULTS, roundForMessageAt, searchMessages, type SearchableMessage } from './round-search';
import { computeVisibleRange, countFoldedBefore, LOAD_MORE_INCREMENT, VISIBLE_ROUND_HALF, VISIBLE_ROUND_WINDOW } from './round-window';

type M = { role: string; content?: string; _metrics?: { roundNumber?: number } };

/** user, assistant, user, assistant ... for `rounds` rounds. */
function conversation(rounds: number): M[] {
  const out: M[] = [];
  for (let r = 1; r <= rounds; r++) {
    out.push({ role: 'user', content: `u${r}` });
    out.push({ role: 'assistant', content: `a${r}`, _metrics: { roundNumber: r } });
  }
  return out;
}
const positions = (msgs: M[]) => msgs.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));

describe('round window constants', () => {
  it('keep their published values', () => {
    expect([VISIBLE_ROUND_WINDOW, VISIBLE_ROUND_HALF, LOAD_MORE_INCREMENT]).toEqual([5, 2, 5]);
  });
});

describe('computeVisibleRange', () => {
  it('empty history and history without assistants', () => {
    expect(computeVisibleRange([], [], 'tail', 5, 0)).toEqual({ start: 0, end: 0 });
    const onlyUser = [{ role: 'user' }, { role: 'user' }];
    expect(computeVisibleRange(onlyUser, [], 'tail', 5, 0)).toEqual({ start: 0, end: 2 });
    expect(computeVisibleRange(onlyUser, [], 'pinned', 5, 1)).toEqual({ start: 0, end: 2 });
  });

  it('tail: shows everything when rounds <= count (including Infinity)', () => {
    const msgs = conversation(5);
    expect(computeVisibleRange(msgs, positions(msgs), 'tail', 5, 0)).toEqual({ start: 0, end: 10 });
    expect(computeVisibleRange(msgs, positions(msgs), 'tail', Infinity, 0)).toEqual({ start: 0, end: 10 });
  });

  it('tail: starts at the user message that precedes the first visible assistant', () => {
    const msgs = conversation(8);
    // last 5 rounds -> first visible assistant is round 4 at index 7, its user message at 6
    expect(computeVisibleRange(msgs, positions(msgs), 'tail', 5, 0)).toEqual({ start: 6, end: 16 });
    expect(computeVisibleRange(msgs, positions(msgs), 'tail', 1, 0)).toEqual({ start: 14, end: 16 });
  });

  it('tail: an assistant with no user message before it starts at itself', () => {
    const msgs: M[] = [{ role: 'assistant' }, { role: 'assistant' }, { role: 'assistant' }];
    expect(computeVisibleRange(msgs, [0, 1, 2], 'tail', 2, 0)).toEqual({ start: 1, end: 3 });
    expect(computeVisibleRange(msgs, [0, 1, 2], 'tail', 3, 0)).toEqual({ start: 0, end: 3 });
  });

  it('pinned: +-2 rounds around the target, clamped at both ends', () => {
    const msgs = conversation(10);
    const aPos = positions(msgs); // 1,3,5,...,19
    // target = assistant of round 5 (index 9): window rounds 3..7 -> messages 4..13 (exclusive end 14)
    expect(computeVisibleRange(msgs, aPos, 'pinned', 5, 9)).toEqual({ start: 4, end: 14 });
    // near the start: rounds 1..3
    expect(computeVisibleRange(msgs, aPos, 'pinned', 5, 1)).toEqual({ start: 0, end: 6 });
    // near the end: rounds 8..10 -> runs to the end of the history
    expect(computeVisibleRange(msgs, aPos, 'pinned', 5, 19)).toEqual({ start: 14, end: 20 });
  });

  it('pinned: a target past the last assistant centres on the last round; a user-message target on the next assistant', () => {
    const msgs = conversation(10);
    const aPos = positions(msgs);
    expect(computeVisibleRange(msgs, aPos, 'pinned', 5, 999)).toEqual({ start: 14, end: 20 });
    // index 8 is the user message of round 5 -> centre on the assistant at 9
    expect(computeVisibleRange(msgs, aPos, 'pinned', 5, 8)).toEqual(computeVisibleRange(msgs, aPos, 'pinned', 5, 9));
  });

  it('pinned ignores the tail count', () => {
    const msgs = conversation(10);
    const aPos = positions(msgs);
    expect(computeVisibleRange(msgs, aPos, 'pinned', 1, 9)).toEqual(computeVisibleRange(msgs, aPos, 'pinned', 99, 9));
  });
});

describe('countFoldedBefore', () => {
  it('counts assistant positions strictly before start', () => {
    expect(countFoldedBefore([1, 3, 5, 7], 0)).toBe(0);
    expect(countFoldedBefore([1, 3, 5, 7], 1)).toBe(0);
    expect(countFoldedBefore([1, 3, 5, 7], 2)).toBe(1);
    expect(countFoldedBefore([1, 3, 5, 7], 6)).toBe(3);
    expect(countFoldedBefore([1, 3, 5, 7], 100)).toBe(4);
    expect(countFoldedBefore([], 5)).toBe(0);
  });
});

describe('roundForMessageAt', () => {
  it('uses the message own round number first', () => {
    expect(roundForMessageAt(conversation(3), 3)).toBe(2);
  });
  it('falls back to the next message that has one (a user message takes its answer\'s round)', () => {
    expect(roundForMessageAt(conversation(3), 2)).toBe(2);
  });
  it('counts assistants for legacy history without metrics, and never returns 0', () => {
    const legacy: M[] = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }];
    expect(roundForMessageAt(legacy, 3)).toBe(2);
    expect(roundForMessageAt(legacy, 4)).toBe(2);
    expect(roundForMessageAt(legacy, 0)).toBe(1);
    expect(roundForMessageAt([{ role: 'user' }], 0)).toBe(1);
  });
  it('a metrics roundNumber of 0 counts as absent', () => {
    expect(roundForMessageAt([{ role: 'assistant', _metrics: { roundNumber: 0 } }], 0)).toBe(1);
  });
});

describe('searchMessages', () => {
  const run = (msgs: SearchableMessage[], q: string) => searchMessages(() => msgs, q);

  it('does not even read the history for queries shorter than 2 characters', () => {
    const getter = vi.fn(() => [] as SearchableMessage[]);
    expect(searchMessages(getter, '')).toEqual([]);
    expect(searchMessages(getter, '  ')).toEqual([]);
    expect(searchMessages(getter, 'a')).toEqual([]);
    expect(searchMessages(getter, ' a ')).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
    searchMessages(getter, 'ab');
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('matches case-insensitively, reports round / role / global index and skips empty messages', () => {
    const msgs: M[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'The DRAGON sleeps', _metrics: { roundNumber: 4 } },
      { role: 'assistant', content: 'nothing here' },
    ];
    expect(run(msgs, '  dragon ')).toEqual([{ roundNumber: 4, role: 'assistant', snippet: 'The DRAGON sleeps', globalIndex: 1 }]);
  });

  it('adds an ellipsis on the side that was cut (30 chars of context each way)', () => {
    const content = `${'x'.repeat(50)}NEEDLE${'y'.repeat(50)}`;
    const [hit] = run([{ role: 'assistant', content }], 'needle');
    expect(hit.snippet).toBe(`…${'x'.repeat(30)}NEEDLE${'y'.repeat(30)}…`);
    const [head] = run([{ role: 'assistant', content: `NEEDLE${'y'.repeat(50)}` }], 'needle');
    expect(head.snippet).toBe(`NEEDLE${'y'.repeat(30)}…`);
    const [tail] = run([{ role: 'assistant', content: `${'x'.repeat(50)}NEEDLE` }], 'needle');
    expect(tail.snippet).toBe(`…${'x'.repeat(30)}NEEDLE`);
  });

  it('stops after 50 hits', () => {
    const msgs: M[] = Array.from({ length: 80 }, (_, i) => ({ role: 'assistant', content: `hit ${i}` }));
    const hits = run(msgs, 'hit');
    expect(MAX_SEARCH_RESULTS).toBe(50);
    expect(hits).toHaveLength(50);
    expect(hits[49].globalIndex).toBe(49);
  });
});

describe('bookmark helpers', () => {
  const bm = (round: number, over: Partial<BookmarkedRound> = {}): BookmarkedRound => ({ id: `bm_${round}`, round, createdAt: 1, name: `n${round}`, content: `c${round}`, pending: false, ...over });

  it('defaultBookmarkName: first 10 non-space chars, fallback only when empty', () => {
    const unnamed = vi.fn(() => 'UNNAMED');
    expect(defaultBookmarkName('  a b c d e f g h i j k l ', unnamed)).toBe('abcdefghij');
    expect(defaultBookmarkName('短文', unnamed)).toBe('短文');
    expect(unnamed).not.toHaveBeenCalled();
    expect(defaultBookmarkName(' \n\t ', unnamed)).toBe('UNNAMED');
    expect(defaultBookmarkName('', unnamed)).toBe('UNNAMED');
    expect(unnamed).toHaveBeenCalledTimes(2);
  });

  it('toggleBookmarkList removes an existing round without building an entry or mutating the input', () => {
    const list = [bm(5), bm(3)];
    const make = vi.fn(() => bm(9));
    const next = toggleBookmarkList(list, 3, make);
    expect(next.map((b) => b.round)).toEqual([5]);
    expect(list.map((b) => b.round)).toEqual([5, 3]);
    expect(make).not.toHaveBeenCalled();
  });

  it('toggleBookmarkList adds a new round and keeps newest-first order', () => {
    const list = [bm(5), bm(1)];
    const next = toggleBookmarkList(list, 3, () => bm(3));
    expect(next.map((b) => b.round)).toEqual([5, 3, 1]);
    expect(list).toHaveLength(2);
    expect(toggleBookmarkList([], 2, () => bm(2)).map((b) => b.round)).toEqual([2]);
    expect(toggleBookmarkList(list, 9, () => bm(9)).map((b) => b.round)).toEqual([9, 5, 1]);
  });

  it('bookmarkSnippet collapses whitespace and truncates at n', () => {
    expect(bookmarkSnippet('  a \n\n b\tc ')).toBe('a b c');
    const long = 'x'.repeat(60);
    expect(bookmarkSnippet(long)).toBe('x'.repeat(48) + '…');
    expect(bookmarkSnippet('x'.repeat(48))).toBe('x'.repeat(48));
    expect(bookmarkSnippet('abcdef', 3)).toBe('abc…');
  });
});
