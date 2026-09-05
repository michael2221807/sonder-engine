/**
 * Canon Capture ↔ `.aga-card` conversion (design §10.3).
 *
 * The load-bearing property is that a captured settings book NEVER travels twice: it is
 * unconditionally removed from the exported state tree, and only re-enters the card — as
 * an ordinary profile book — when the author ticked "include world books".
 */
import { describe, it, expect } from 'vitest';
import {
  convertCapturedBookForCard,
  extractCapturedBookFromTree,
  normalizeImportedWorldBook,
} from './captured-settings-card';
import { stripStateTreeForCard } from './card-stripper';
import { buildDefaultCardStripPaths } from './card-export-paths';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { CAPTURED_SETTINGS_BOOK_ID } from '../prompt/world-book';
import type { WorldBook } from '../prompt/world-book';
import {
  addCapturedEntry,
  createCapturedBook,
  retractCapturedEntry,
  type CapturedSettingLabels,
} from '../prompt/captured-entry-mutations';
import type { ExportFlags } from './game-card-bundle.types';

const paths = buildDefaultCardStripPaths();

const labels: CapturedSettingLabels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

function makeCapturedBook(): WorldBook {
  let book = createCapturedBook(labels);
  book = addCapturedEntry(book, {
    kind: 'character', statement: '林月从小怕水。', evidence: '林月从小怕水',
    anchors: ['林月', '怕水'], entities: ['林月'],
  }, { round: 3, inputHash: 'h', labels }).book;
  book = addCapturedEntry(book, {
    kind: 'world_fact', statement: '这个世界有两个月亮。', evidence: '这个世界有两个月亮',
    anchors: ['月亮'], entities: [],
  }, { round: 4, inputHash: 'h', labels }).book;
  return book;
}

function makeTree(book: WorldBook): Record<string, unknown> {
  return {
    角色: { 基础信息: { 姓名: '叶尘' } },
    系统: { 扩展: { slotWorldBooks: [book] } },
  };
}

const FLAGS: ExportFlags = {
  containsNsfw: false,
  includedWorldBooks: false,
  includedBuiltinOverrides: false,
  includedEngineConfig: false,
  includedSettings: false,
  includedApiTemplate: false,
  includedPromptSettings: false,
  includedHeroinePlan: false,
  includedPlotDirection: false,
  includedNarrativeContract: false,
  includedGenerationHistory: false,
  includedReferenceGallery: false,
} as unknown as ExportFlags;

describe('the captured book always leaves the state tree', () => {
  it('is stripped whether or not world books were included', () => {
    const tree = makeTree(makeCapturedBook());
    for (const included of [true, false]) {
      const stripped = stripStateTreeForCard(
        tree, paths, { ...FLAGS, includedWorldBooks: included }, 'fixed',
      );
      const ext = (stripped['系统'] as Record<string, unknown> | undefined)?.['扩展'] as
        | Record<string, unknown> | undefined;
      expect(ext?.['slotWorldBooks']).toBeUndefined();
    }
  });

  it('leaves the rest of the tree alone', () => {
    const stripped = stripStateTreeForCard(makeTree(makeCapturedBook()), paths, FLAGS, 'fixed');
    expect((stripped['角色'] as { 基础信息: { 姓名: string } }).基础信息.姓名).toBe('叶尘');
  });

  it('the strip path is its OWN field, not folded into gameplayHistory', () => {
    // Folding it in would make it unconditional, and the "include world books" tick
    // could never re-add it.
    expect(paths.capturedSettings).toBe(DEFAULT_ENGINE_PATHS.slotWorldBooks);
    expect(paths.gameplayHistory).not.toContain(DEFAULT_ENGINE_PATHS.slotWorldBooks);
  });
});

describe('extractCapturedBookFromTree', () => {
  it('finds the book before the strip runs', () => {
    const found = extractCapturedBookFromTree(makeTree(makeCapturedBook()), paths.capturedSettings);
    expect(found?.id).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(found?.entries).toHaveLength(2);
  });

  it('returns undefined for a save that never captured anything', () => {
    expect(extractCapturedBookFromTree({}, paths.capturedSettings)).toBeUndefined();
    expect(extractCapturedBookFromTree(
      { 系统: { 扩展: { slotWorldBooks: [] } } }, paths.capturedSettings,
    )).toBeUndefined();
  });

  it('matches by origin even if the id was customized', () => {
    const book = { ...makeCapturedBook(), id: 'renamed' };
    expect(extractCapturedBookFromTree(makeTree(book), paths.capturedSettings)?.id).toBe('renamed');
  });
});

describe('convertCapturedBookForCard', () => {
  it('strips every trace of save-local provenance', () => {
    const converted = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    for (const entry of converted.entries) {
      expect(entry.capturedSetting).toBeUndefined();
      expect(entry.matchSource).toBe('broad');
    }
  });

  it('re-owns the book so the recipient budgets it as authored lore', () => {
    // Left as `system-captured`, the recipient's selector would cap it at the auto
    // quota — but they never captured it; to them it is the author's writing.
    const converted = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    expect(converted.ownership).toBe('profile');
    expect(converted.origin).toBe('user-authored');
    expect(converted.builtin).toBe(false);
  });

  it('regenerates ids so importing cannot overwrite the recipient\'s own book', () => {
    // `importWorldBooks` saves under the incoming id keyed `profileId:book.id`.
    const converted = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    expect(converted.id).not.toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(converted.id).toMatch(/^wb_card_[0-9a-f]{8}$/);
    for (const entry of converted.entries) {
      expect(entry.id.startsWith(converted.id)).toBe(true);
    }
  });

  it('id is deterministic for the same card, and differs across cards', () => {
    const a = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    const b = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    const c = convertCapturedBookForCard(makeCapturedBook(), '另一张卡');
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it('does not ship entries the author undid', () => {
    const book = makeCapturedBook();
    const retracted = retractCapturedEntry(book, book.entries[0].id);
    const converted = convertCapturedBookForCard(retracted, '青云传');
    expect(converted.entries).toHaveLength(1);
    expect(converted.entries[0].content).toBe('这个世界有两个月亮。');
  });

  it('pins a keyword-less entry so it is not shipped permanently inert', () => {
    let book = createCapturedBook(labels);
    book = addCapturedEntry(book, {
      kind: 'world_fact', statement: '无锚点设定。', evidence: '无锚点设定',
      anchors: ['x'], entities: [],
    }, { round: 1, inputHash: 'h', labels }).book;
    book.entries[0].keywords = [];

    const converted = convertCapturedBookForCard(book, '卡');
    expect(converted.entries[0].injectionMode).toBe('always');
  });

  it('keeps the injectable content itself intact', () => {
    const converted = convertCapturedBookForCard(makeCapturedBook(), '青云传');
    expect(converted.entries.map((e) => e.content)).toEqual([
      '林月从小怕水。', '这个世界有两个月亮。',
    ]);
    expect(converted.entries[0].keywords).toEqual(['林月', '怕水']);
  });
});

describe('normalizeImportedWorldBook (import-side defence)', () => {
  it('re-owns a slot-owned book that slipped through an older exporter', () => {
    const raw = makeCapturedBook();
    const normalized = normalizeImportedWorldBook(raw);
    expect(normalized.ownership).toBe('profile');
    expect(normalized.origin).toBe('user-authored');
    expect(normalized.entries.every((e) => e.capturedSetting === undefined)).toBe(true);
    expect(normalized.entries.every((e) => e.matchSource === 'broad')).toBe(true);
  });

  it('leaves an ordinary profile book untouched (same object)', () => {
    const plain: WorldBook = { id: 'b', title: 'B', entries: [] };
    expect(normalizeImportedWorldBook(plain)).toBe(plain);
  });
});
