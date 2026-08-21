import { describe, it, expect } from 'vitest';
import {
  addManualCapturedEntry,
  filterAnchors,
  parseAnchorStopwords,
  addCapturedEntry,
  activeCapturedEntries,
  anchorsToKeywords,
  bumpInjectionCounters,
  buildCapturedTitle,
  capturedEntryId,
  createCapturedBook,
  editCapturedEntry,
  findCapturedBook,
  normalizeForIdentity,
  pinCapturedEntry,
  restoreCapturedEntry,
  retractCapturedEntry,
  upsertCapturedBook,
  CAPTURED_ENTRY_PRIORITY,
  MAX_ACTIVE_CAPTURED_ENTRIES,
  type CapturedSettingLabels,
  type SettingUpdateCandidate,
} from './captured-entry-mutations';
import { CAPTURED_SETTINGS_BOOK_ID } from './world-book';
import type { WorldBook } from './world-book';

const labels: CapturedSettingLabels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

function candidate(over: Partial<SettingUpdateCandidate> = {}): SettingUpdateCandidate {
  return {
    kind: 'character',
    statement: '林月从小怕水。',
    evidence: '林月从小怕水',
    anchors: ['林月', '怕水'],
    entities: ['林月'],
    ...over,
  };
}

const ctx = { round: 7, inputHash: 'hash', labels };

function bookWith(...cands: SettingUpdateCandidate[]): WorldBook {
  let book = createCapturedBook(labels);
  for (const c of cands) book = addCapturedEntry(book, c, ctx).book;
  return book;
}

describe('deterministic mapping', () => {
  it('id is stable for the same statement + anchors regardless of anchor order', () => {
    const a = capturedEntryId('林月从小怕水。', ['林月', '怕水']);
    const b = capturedEntryId('林月从小怕水。', ['怕水', '林月']);
    expect(a).toBe(b);
    expect(a).toMatch(/^cap_[0-9a-f]{8}$/);
  });

  it('id ignores case and whitespace differences', () => {
    expect(capturedEntryId('  Lin  fears water ', ['A']))
      .toBe(capturedEntryId('lin fears water', ['a']));
  });

  it('different statements produce different ids', () => {
    expect(capturedEntryId('A', ['x'])).not.toBe(capturedEntryId('B', ['x']));
  });

  it('collisions get a deterministic suffix instead of overwriting', () => {
    const base = capturedEntryId('X', ['a']);
    const next = capturedEntryId('X', ['a'], [base]);
    expect(next).toBe(`${base}_2`);
    expect(capturedEntryId('X', ['a'], [base, next])).toBe(`${base}_3`);
  });

  it('title is "<first entity> · <kind label>" when an entity is known', () => {
    expect(buildCapturedTitle(candidate(), labels)).toBe('林月 · 人物设定');
  });

  it('falls back to a statement excerpt, NOT the bare kind label, when nameless', () => {
    // The bare label duplicates the type badge shown beside it, so every nameless entry
    // would render as an identical-looking row.
    expect(buildCapturedTitle(candidate({ entities: [], statement: '这个世界有两个月亮。' }), labels))
      .toBe('这个世界有两个月亮');
  });

  it('elides an over-long excerpt', () => {
    const long = '一'.repeat(40);
    const title = buildCapturedTitle(candidate({ entities: [], statement: long }), labels);
    expect(title).toHaveLength(17); // 16 + ellipsis
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to the kind label when the statement is only punctuation', () => {
    expect(buildCapturedTitle(candidate({ kind: 'world_fact', entities: [], statement: '。。。' }), labels))
      .toBe('世界设定');
  });

  it('anchors become normalized, de-duplicated keywords', () => {
    expect(anchorsToKeywords([' 林月 ', '林月', 'ＡＢ', 'x', ''])).toEqual(['林月', 'ab']);
  });

  it('normalizeForIdentity folds case, width and whitespace', () => {
    expect(normalizeForIdentity(' Ａ  B ')).toBe('a b');
  });
});

describe('addCapturedEntry', () => {
  it('produces a standard WorldBookEntry with the fixed deterministic mapping', () => {
    const { entry } = addCapturedEntry(createCapturedBook(labels), candidate(), ctx);
    expect(entry.type).toBe('world_lore');
    expect(entry.scope).toEqual(['main']);
    expect(entry.injectionMode).toBe('match_any');
    expect(entry.priority).toBe(CAPTURED_ENTRY_PRIORITY);
    expect(entry.matchSource).toBe('focused');
    expect(entry.enabled).toBe(true);
    expect(entry.keywords).toEqual(['林月', '怕水']);
    expect(entry.content).toBe('林月从小怕水。');
  });

  it('records provenance metadata including the round and evidence', () => {
    const { entry } = addCapturedEntry(createCapturedBook(labels), candidate(), ctx);
    expect(entry.capturedSetting).toMatchObject({
      schemaVersion: 1,
      source: 'user-captured',
      kind: 'character',
      evidence: '林月从小怕水',
      capturedRound: 7,
      status: 'active',
      entityRefs: ['林月'],
      injectedCount: 0,
      originalContent: '林月从小怕水。',
    });
  });

  it('does not mutate the input book', () => {
    const book = createCapturedBook(labels);
    addCapturedEntry(book, candidate(), ctx);
    expect(book.entries).toHaveLength(0);
  });

  it('the model can never produce an always-inject entry', () => {
    const { entry } = addCapturedEntry(createCapturedBook(labels), candidate(), ctx);
    expect(entry.injectionMode).not.toBe('always');
  });
});

describe('addManualCapturedEntry', () => {
  it('titles itself from the content, not the bare kind label', () => {
    const { entry } = addManualCapturedEntry(
      createCapturedBook(labels),
      { content: '这个世界有两个月亮。' },
      { round: 5, labels },
    );
    expect(entry.title).toBe('这个世界有两个月亮');
    expect(entry.capturedSetting?.source).toBe('user-edited');
    expect(entry.capturedSetting?.evidence).toBe('这个世界有两个月亮。');
  });

  it('pins a keyword-less entry so it is not silently unreachable', () => {
    const { entry } = addManualCapturedEntry(
      createCapturedBook(labels), { content: '没有关键词。' }, { round: 1, labels },
    );
    expect(entry.injectionMode).toBe('always');
    expect(entry.capturedSetting?.pinnedByUser).toBe(true);
  });

  it('uses keyword matching when keywords are supplied', () => {
    const { entry } = addManualCapturedEntry(
      createCapturedBook(labels), { content: '林月住在城南。', keywords: ['林月'] }, { round: 1, labels },
    );
    expect(entry.injectionMode).toBe('match_any');
    expect(entry.keywords).toEqual(['林月']);
  });

  it('respects an explicit title', () => {
    const { entry } = addManualCapturedEntry(
      createCapturedBook(labels), { content: 'x', title: '我的标题' }, { round: 1, labels },
    );
    expect(entry.title).toBe('我的标题');
  });
});

describe('retract / restore', () => {
  it('retract disables and marks, but never deletes', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const next = retractCapturedEntry(book, id);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].enabled).toBe(false);
    expect(next.entries[0].capturedSetting?.status).toBe('retracted');
    expect(activeCapturedEntries(next)).toHaveLength(0);
  });

  it('retracting an unknown id is a no-op that returns the same book', () => {
    const book = bookWith(candidate());
    expect(retractCapturedEntry(book, 'nope')).toBe(book);
  });

  it('restore brings it back', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const r = restoreCapturedEntry(retractCapturedEntry(book, id), id);
    expect(r.ok).toBe(true);
    expect(r.book.entries[0].enabled).toBe(true);
    expect(r.book.entries[0].capturedSetting?.status).toBe('active');
  });

  it('restore is refused when the active cap is already full', () => {
    // Restoring must not be a hole through the 200-entry limit.
    let book = createCapturedBook(labels);
    for (let i = 0; i < MAX_ACTIVE_CAPTURED_ENTRIES; i++) {
      book = addCapturedEntry(book, candidate({ statement: `设定 ${i}`, anchors: [`k${i}`] }), ctx).book;
    }
    const extra = addCapturedEntry(book, candidate({ statement: '额外', anchors: ['extra'] }), ctx);
    const retracted = retractCapturedEntry(extra.book, extra.entry.id);
    expect(activeCapturedEntries(retracted)).toHaveLength(MAX_ACTIVE_CAPTURED_ENTRIES);

    const r = restoreCapturedEntry(retracted, extra.entry.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capacity');
    expect(r.book.entries.find((e) => e.id === extra.entry.id)?.enabled).toBe(false);
  });

  it('restore reports not_found / not_retracted instead of silently doing nothing', () => {
    const book = bookWith(candidate());
    expect(restoreCapturedEntry(book, 'nope').reason).toBe('not_found');
    expect(restoreCapturedEntry(book, book.entries[0].id).reason).toBe('not_retracted');
  });
});

describe('edit / pin', () => {
  it('edit updates content and flips source to user-edited', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const next = editCapturedEntry(book, id, { content: '林月其实很会游泳。' });
    expect(next.entries[0].content).toBe('林月其实很会游泳。');
    expect(next.entries[0].capturedSetting?.source).toBe('user-edited');
  });

  it('originalContent is written once and NEVER overwritten by later edits', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const once = editCapturedEntry(book, id, { content: '第一次改' });
    const twice = editCapturedEntry(once, id, { content: '第二次改' });
    expect(twice.entries[0].capturedSetting?.originalContent).toBe('林月从小怕水。');
    expect(twice.entries[0].content).toBe('第二次改');
  });

  it('edit clamps content to the length cap', () => {
    const book = bookWith(candidate());
    const next = editCapturedEntry(book, book.entries[0].id, { content: 'x'.repeat(500) });
    expect(next.entries[0].content).toHaveLength(240);
  });

  it('pin flips injectionMode to always and records who did it', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const pinned = pinCapturedEntry(book, id, true);
    expect(pinned.entries[0].injectionMode).toBe('always');
    expect(pinned.entries[0].capturedSetting?.pinnedByUser).toBe(true);

    const unpinned = pinCapturedEntry(pinned, id, false);
    expect(unpinned.entries[0].injectionMode).toBe('match_any');
    expect(unpinned.entries[0].capturedSetting?.pinnedByUser).toBe(false);
  });
});

describe('injection counters', () => {
  it('bumps only the entries that were actually injected', () => {
    const book = bookWith(
      candidate({ statement: 'A', anchors: ['a'] }),
      candidate({ statement: 'B', anchors: ['b'] }),
    );
    const [first, second] = book.entries;
    const next = bumpInjectionCounters(book, [first.id], 12);
    expect(next.entries[0].capturedSetting?.injectedCount).toBe(1);
    expect(next.entries[0].capturedSetting?.lastInjectedRound).toBe(12);
    expect(next.entries[1].capturedSetting?.injectedCount).toBe(0);
    expect(next.entries[1].capturedSetting?.lastInjectedRound).toBeUndefined();
    expect(second.capturedSetting?.injectedCount).toBe(0); // input untouched
  });

  it('accumulates across rounds', () => {
    const book = bookWith(candidate());
    const id = book.entries[0].id;
    const twice = bumpInjectionCounters(bumpInjectionCounters(book, [id], 1), [id], 2);
    expect(twice.entries[0].capturedSetting?.injectedCount).toBe(2);
    expect(twice.entries[0].capturedSetting?.lastInjectedRound).toBe(2);
  });

  it('returns the same book when nothing was hit (no pointless state write)', () => {
    const book = bookWith(candidate());
    expect(bumpInjectionCounters(book, [], 1)).toBe(book);
    expect(bumpInjectionCounters(book, ['unknown'], 1)).toBe(book);
  });
});

describe('book helpers', () => {
  it('createCapturedBook is slot-owned, system-captured and delete-protected', () => {
    const book = createCapturedBook(labels);
    expect(book.id).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(book.ownership).toBe('slot');
    expect(book.origin).toBe('system-captured');
    expect(book.builtin).toBe(true);
    expect(book.title).toBe('自动设定集');
  });

  it('findCapturedBook matches by id or by origin', () => {
    const byId: WorldBook = { id: CAPTURED_SETTINGS_BOOK_ID, title: 'x', entries: [] };
    const byOrigin: WorldBook = { id: 'other', title: 'x', origin: 'system-captured', entries: [] };
    const plain: WorldBook = { id: 'plain', title: 'x', entries: [] };
    expect(findCapturedBook([plain, byId])?.id).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(findCapturedBook([plain, byOrigin])?.id).toBe('other');
    expect(findCapturedBook([plain])).toBeUndefined();
    expect(findCapturedBook(undefined)).toBeUndefined();
  });

  it('upsertCapturedBook inserts once then replaces in place', () => {
    const book = createCapturedBook(labels);
    const inserted = upsertCapturedBook([], book);
    expect(inserted).toHaveLength(1);
    const replaced = upsertCapturedBook(inserted, { ...book, title: 'renamed' });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].title).toBe('renamed');
  });
});

// ─── P1 code-review: anchor quality filter (design §6.2 rule 6) ───

describe('filterAnchors', () => {
  it('drops single-character anchors', () => {
    // A one-char anchor matches almost any sentence, making the entry a permanent
    // budget resident that contributes nothing to relevance.
    const r = filterAnchors(['林', '林月', '水']);
    expect(r.kept).toEqual(['林月']);
    expect(r.dropped).toEqual(['林', '水']);
  });

  it('drops pack-declared stopwords', () => {
    const r = filterAnchors(['林月', '这个', '因为'], ['这个', '因为', '的']);
    expect(r.kept).toEqual(['林月']);
    expect(r.dropped).toEqual(['这个', '因为']);
  });

  it('matches stopwords case- and width-insensitively', () => {
    expect(filterAnchors(['ＴＨＥ'], ['the']).kept).toEqual([]);
  });

  it('keeps everything when the pack declares no stopwords (engine ships no word list)', () => {
    expect(filterAnchors(['林月', '怕水']).kept).toEqual(['林月', '怕水']);
  });

  it('reports dropped anchors so the caller can explain a rejection', () => {
    const r = filterAnchors(['的'], ['的']);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(['的']);
  });
});

describe('parseAnchorStopwords', () => {
  it('splits on whitespace and commas of both widths', () => {
    expect(parseAnchorStopwords('的 了，是,在')).toEqual(['的', '了', '是', '在']);
  });

  it('returns an empty list for missing config (no filtering, not a default word list)', () => {
    expect(parseAnchorStopwords(undefined)).toEqual([]);
    expect(parseAnchorStopwords('   ')).toEqual([]);
  });
});
