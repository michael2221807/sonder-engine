// App doc: docs/user-guide/pages/game-main.md §3.17（回合前存档自检）
/**
 * Save-health check — runs BEFORE each round is generated.
 *
 * The problem it exists for (2026-09-09 incident): a browser can drop one IndexedDB
 * database (the image cache, the world-book library, the vector store) while leaving the
 * save tree intact. Nothing tells the player; the game keeps advancing on a damaged
 * foundation, and the next cloud upload propagates the damage. This check compares the
 * live side stores against what the save tree itself says should exist, so the composer
 * can stop the round and let the player decide before anything else happens.
 *
 * What counts as damage (deliberately narrow — an alarm that fires on normal edits gets
 * dismissed reflexively and then misses the real thing):
 * - images:      a selected image the tree references is not in the cache (an unreadable
 *                cache reaches the player the same way: no images);
 * - world books: the library cannot be read, or the tree recorded ≥1 book and the
 *                library now holds none (partial deletion is a normal edit);
 * - vectors:     the store cannot be read, or Engram has embedded events but the store
 *                holds none (a store that merely lags behind is normal).
 *
 * The three stores are independent, so their reads run concurrently: the check sits on
 * the send path, and every millisecond it takes widens the window in which a second
 * keystroke could race it.
 *
 * Engine-only: no i18n, no UI. The report carries numbers and ids; the panel words it.
 */
import type { EnginePathConfig } from '../pipeline/types';
import { collectAssetIdsFromTree } from './backup-service';
import { readWorldBookBaseline } from './save-health-baseline';

export type SaveHealthIssue =
  | 'images_missing'
  | 'world_books_unreadable'
  | 'world_books_lost'
  | 'vectors_unreadable'
  | 'vectors_lost';

export interface SaveHealthReport {
  damaged: boolean;
  issues: SaveHealthIssue[];
  round: number;
  images: { referenced: number; present: number; missingIds: string[] };
  worldBooks: { expected: number; present: number; unreadable: boolean; presentIds: string[] };
  vectors: { embeddedEvents: number; storedEventVectors: number; unreadable: boolean };
  /**
   * Stable identity of THIS set of findings. Acknowledging a report suppresses reports
   * with the same fingerprint for the session; a new loss (different ids / a new issue)
   * changes the fingerprint and is raised again.
   */
  fingerprint: string;
}

/** Narrow ports so the check can be exercised without IndexedDB. */
export interface SaveHealthDeps {
  /** The live state tree (read-only here). */
  tree: Record<string, unknown>;
  paths: Pick<EnginePathConfig, 'storageHealth' | 'engramMemory' | 'roundNumber'>;
  profileId: string;
  slotId: string;
  imageCache?: { listAll(): Promise<ReadonlyArray<{ id: string }>> };
  worldBookStorage?: { loadWorldBooks(profileId: string): Promise<ReadonlyArray<{ id: string }>> };
  vectorStore?: { load(profileId: string, slotId: string): Promise<{ eventVectors?: Record<string, unknown> }> };
}

function readPath(tree: unknown, path: string): unknown {
  let node: unknown = tree;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Events Engram has already embedded — the number of vectors the store should hold. */
function countEmbeddedEvents(tree: Record<string, unknown>, engramPath: string): number {
  const engram = readPath(tree, engramPath);
  if (!engram || typeof engram !== 'object') return 0;
  const events = (engram as { events?: unknown }).events;
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => !!e && typeof e === 'object' && (e as { is_embedded?: unknown }).is_embedded === true).length;
}

type Read<T> = { ok: true; value: T } | { ok: false };

/** Turn a store read into a settled result so one throwing store never hides the others. */
function settle<T>(p: Promise<T>): Promise<Read<T>> {
  return p.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
}

export async function runSaveHealthCheck(deps: SaveHealthDeps): Promise<SaveHealthReport> {
  const round = Number(readPath(deps.tree, deps.paths.roundNumber) ?? 0) || 0;

  // What the tree expects — all synchronous, computed before any store is touched.
  const referenced = new Set<string>();
  collectAssetIdsFromTree(deps.tree, referenced, false);
  const expectedIds = readWorldBookBaseline(deps.tree, deps.paths.storageHealth);
  const embeddedEvents = countEmbeddedEvents(deps.tree, deps.paths.engramMemory);

  // The three reads are independent — start them together.
  const imagesRead = referenced.size > 0 && deps.imageCache
    ? settle(deps.imageCache.listAll())
    : null;
  const booksRead = deps.worldBookStorage
    ? settle(deps.worldBookStorage.loadWorldBooks(deps.profileId))
    : null;
  const vectorsRead = embeddedEvents > 0 && deps.vectorStore
    ? settle(deps.vectorStore.load(deps.profileId, deps.slotId))
    : null;
  const [images, books, vectors] = await Promise.all([imagesRead, booksRead, vectorsRead]);

  const issues: SaveHealthIssue[] = [];

  // ── images: the tree's selected references vs the cache ──
  let missingIds: string[] = [];
  let presentImages = referenced.size;
  if (images) {
    if (images.ok) {
      const have = new Set(images.value.map((a) => a.id));
      missingIds = [...referenced].filter((id) => !have.has(id)).sort();
    } else {
      missingIds = [...referenced].sort();
    }
    presentImages = referenced.size - missingIds.length;
    if (missingIds.length > 0) issues.push('images_missing');
  }

  // ── world books: the tree's recorded ids vs the library ──
  let presentIds: string[] = [];
  let booksUnreadable = false;
  if (books) {
    if (books.ok) presentIds = books.value.map((b) => b.id).sort();
    else booksUnreadable = true;
    if (booksUnreadable) issues.push('world_books_unreadable');
    else if (expectedIds.length > 0 && presentIds.length === 0) issues.push('world_books_lost');
  }

  // ── vectors: embedded events vs stored event vectors ──
  let storedEventVectors = 0;
  let vectorsUnreadable = false;
  if (vectors) {
    if (vectors.ok) storedEventVectors = Object.keys(vectors.value?.eventVectors ?? {}).length;
    else vectorsUnreadable = true;
    if (vectorsUnreadable) issues.push('vectors_unreadable');
    else if (storedEventVectors === 0) issues.push('vectors_lost');
  }

  const fingerprint = [
    issues.join('|'),
    missingIds.join(','),
    booksUnreadable ? 'unreadable' : `${expectedIds.length}/${presentIds.length}`,
    vectorsUnreadable ? 'unreadable' : `${embeddedEvents}/${storedEventVectors}`,
  ].join('#');

  return {
    damaged: issues.length > 0,
    issues,
    round,
    images: { referenced: referenced.size, present: presentImages, missingIds },
    worldBooks: { expected: expectedIds.length, present: presentIds.length, unreadable: booksUnreadable, presentIds },
    vectors: { embeddedEvents, storedEventVectors, unreadable: vectorsUnreadable },
    fingerprint,
  };
}

/**
 * Whether the check's result may be written back as the new world-book record.
 *
 * Only a READABLE library that is not in the lost state counts: recording an empty list
 * while the store is wiped would erase the very expectation that detects the wipe.
 */
export function canRecordWorldBookBaseline(report: SaveHealthReport): boolean {
  return !report.worldBooks.unreadable && !report.issues.includes('world_books_lost');
}
