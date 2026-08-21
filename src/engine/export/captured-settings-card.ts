// App doc: docs/user-guide/pages/game-main.md §3.15.4
/**
 * Canon Capture ↔ `.aga-card` conversion.
 *
 * A captured settings book is slot-owned and full of provenance that only means anything
 * inside the save it came from: which turn it was recorded on, the player's own words, how
 * many times it has been injected. None of that survives a trip to someone else's game —
 * to the recipient, this is simply lore the author wrote.
 *
 * So the conversion strips provenance, re-owns the book to the profile, and re-ids it.
 * The re-id is not cosmetic: `WorldBookStorage.importWorldBooks` saves under the incoming
 * id, keyed `profileId:book.id`, so shipping the fixed `system_captured_settings` id would
 * silently OVERWRITE the recipient's own captured-settings book.
 *
 * Design: `docs/design/canon-ledger-setting-capture.md` §10.3.
 */
import type { WorldBook, WorldBookEntry } from '../prompt/world-book';
import { CAPTURED_SETTINGS_BOOK_ID } from '../prompt/world-book';

/** Deterministic, collision-resistant id for the exported copy. */
function cardBookId(sourceId: string, cardTitle: string): string {
  let hash = 0x811c9dc5;
  const seed = `${sourceId}|${cardTitle}`;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wb_card_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Convert a slot-owned captured book into a plain profile world book fit for a card.
 *
 * Every field that could make the recipient's engine treat it as machine-captured is
 * cleared, because on their side it is not:
 * - `capturedSetting` (evidence, capture round, hit counts) — meaningless off-save;
 * - `origin` → `user-authored`, so the two-pool budget does NOT cap it at the captured
 *   quota; to the recipient this is authored lore and competes as such;
 * - `matchSource` → `broad`, because the focused corpus is tuned for entries the player
 *   just wrote this session, not for imported background lore;
 * - `ownership` → `profile`, since profile IndexedDB has no notion of slot ownership.
 */
export function convertCapturedBookForCard(
  book: WorldBook,
  cardTitle: string,
): WorldBook {
  const entries: WorldBookEntry[] = book.entries
    // Retracted entries are the author's "I took that back" — do not ship them.
    .filter((e) => e.capturedSetting?.status !== 'retracted')
    .map((e, i) => {
      const { capturedSetting: _dropped, ...rest } = e;
      void _dropped;
      return {
        ...rest,
        id: `${cardBookId(book.id, cardTitle)}_${i}`,
        matchSource: 'broad' as const,
        // An entry with no keywords could never be retrieved on the other side; the
        // author pinned it for a reason, so keep it pinned rather than shipping something
        // that silently never fires.
        injectionMode: (e.keywords ?? []).length > 0 ? e.injectionMode : 'always',
        enabled: true,
        updatedAt: Date.now(),
      };
    });

  return {
    id: cardBookId(book.id, cardTitle),
    title: book.title,
    description: book.description,
    enabled: true,
    // Not `builtin`: on the recipient's side this is an ordinary book they may delete.
    builtin: false,
    ownership: 'profile',
    origin: 'user-authored',
    entries,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Locate the captured book inside a raw state tree, before it is stripped. */
export function extractCapturedBookFromTree(
  tree: Record<string, unknown>,
  slotWorldBooksPath: string,
): WorldBook | undefined {
  const segments = slotWorldBooksPath.split('.');
  let node: unknown = tree;
  for (const seg of segments) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  if (!Array.isArray(node)) return undefined;
  const books = node as WorldBook[];
  return books.find((b) => b?.id === CAPTURED_SETTINGS_BOOK_ID || b?.origin === 'system-captured');
}

/**
 * Normalize any world book arriving from a card.
 *
 * Defence in depth for the import side: a card built by an older or hand-edited exporter
 * could still carry `ownership: 'slot'`, and profile IndexedDB has no slot concept — an
 * entry marked that way would be shown under the wrong group and budgeted as captured
 * content the recipient never captured.
 */
export function normalizeImportedWorldBook(book: WorldBook): WorldBook {
  if (book.ownership !== 'slot' && book.origin !== 'system-captured') return book;
  return {
    ...book,
    ownership: 'profile',
    origin: 'user-authored',
    builtin: false,
    entries: book.entries.map((e) => {
      const { capturedSetting: _dropped, ...rest } = e;
      void _dropped;
      return { ...rest, matchSource: 'broad' as const };
    }),
  };
}
