// App doc: docs/user-guide/pages/game-prompts.md §4.8
/**
 * CapturedSettingCoordinator — the single write entry point for captured settings.
 *
 * Why this exists (design §8.4): `SettingCaptureStage` writes inside the round pipeline,
 * where PostProcess persists the state and the Engram bridge runs. Everything the PLAYER
 * does — undo from a toast, edit / disable / restore / pin in the panel — happens OUTSIDE
 * that pipeline. If the UI called the pure mutation functions directly, three things
 * would silently rot:
 *
 *   1. the world-book entry would change but the Engram edge built from it would stay
 *      alive, so a retracted setting keeps steering retrieval;
 *   2. nothing would hit the disk — PostProcess's auto-save already ran, so the change
 *      would evaporate on refresh while the round it belonged to looks saved;
 *   3. a half-applied mutation (book updated, Engram sync failed) would have no owner.
 *
 * So every player-initiated write goes through here, in a fixed order:
 *   book mutation → Engram sync → persist → structured result (rollback on failure).
 *
 * The pure functions in `captured-entry-mutations.ts` stay pure and stay the only place
 * that knows the field mapping; this layer owns the side effects.
 */
import type { EnginePathConfig } from '../pipeline/types';
import type { WorldBook, WorldBookEntry } from './world-book';
import {
  addManualCapturedEntry,
  activeCapturedEntries,
  createCapturedBook,
  editCapturedEntry,
  findCapturedBook,
  MAX_ACTIVE_CAPTURED_ENTRIES,
  pinCapturedEntry,
  restoreCapturedEntry,
  retractCapturedEntry,
  upsertCapturedBook,
  type CapturedEntryPatch,
  type CapturedSettingLabels,
} from './captured-entry-mutations';
import type { CapturedSettingKind } from './world-book';

// ─── Result contract ────────────────────────────────────────

export type CapturedMutationFailure =
  | 'not_found'
  | 'no_book'
  | 'capacity'
  | 'not_retracted'
  | 'persist_failed'
  | 'internal_error';

export interface CapturedMutationResult {
  ok: boolean;
  reason?: CapturedMutationFailure;
  /** The entry after the mutation, when it succeeded. */
  entry?: WorldBookEntry;
  /** Non-fatal: the book changed but the graph projection could not be updated. */
  engramDegraded?: boolean;
}

/**
 * Engram side of a captured relationship.
 *
 * Deliberately a narrow port rather than a direct `EngramManager` dependency: P2 ships
 * the world-book half, P3 wires the graph half, and the panel must not need to know
 * which of those has landed. An absent bridge simply means "no projection" — the
 * world book keeps working, which is the whole point of Engram being optional.
 */
export interface CapturedEngramBridge {
  /** Invalidate every edge produced by this captured entry. */
  invalidate(entryId: string): Promise<void>;
  /** (Re)project an entry that is active again or whose meaning changed. */
  reproject(entry: WorldBookEntry): Promise<void>;
  /** False when Engram is off / edge mode inactive — skip silently, do not warn. */
  isActive(): boolean;
}

/**
 * The two state-tree operations this layer needs.
 *
 * Declared as its own port rather than `Pick<StateManager, 'get' | 'set'>`: the real
 * `set` returns a `StateChange` and takes a `source`, so a store-backed adapter could
 * only satisfy that shape through an `as` cast — which would silence a genuine signature
 * mismatch and quietly drop the `source` argument. A port the adapter can implement
 * honestly is the smaller lie-free option.
 */
export interface CapturedSettingStatePort {
  get<T = unknown>(path: string): T | undefined;
  set(path: string, value: unknown): void;
}

export interface CapturedSettingCoordinatorDeps {
  stateManager: CapturedSettingStatePort;
  paths: EnginePathConfig;
  /** Persist the state tree. Usually an `engine:request-save` emit. */
  persist: () => void | Promise<void>;
  /** Optional — absent until P3 wires the graph. */
  engram?: CapturedEngramBridge;
  /** Display labels + current round, needed only for manual adds. */
  getLabels?: () => CapturedSettingLabels;
  getRound?: () => number;
}

// ─── Coordinator ────────────────────────────────────────────

export class CapturedSettingCoordinator {
  constructor(private deps: CapturedSettingCoordinatorDeps) {}

  /**
   * Record a setting the player typed by hand (the post-failure fallback, design §6.4).
   *
   * Creates the captured book on demand — a save that never had an automatic capture
   * still gets a home for manual ones.
   */
  async addManual(input: {
    content: string;
    title?: string;
    keywords?: string[];
    kind?: CapturedSettingKind;
  }): Promise<CapturedMutationResult> {
    let previousBooks: WorldBook[] | undefined;
    try {
      const content = input.content?.trim();
      if (!content) return { ok: false, reason: 'not_found' };

      const labels = this.deps.getLabels?.();
      if (!labels) return { ok: false, reason: 'internal_error' };

      const books = this.readBooks();
      const book = findCapturedBook(books) ?? createCapturedBook(labels);
      if (activeCapturedEntries(book).length >= MAX_ACTIVE_CAPTURED_ENTRIES) {
        return { ok: false, reason: 'capacity' };
      }

      const { book: nextBook, entry } = addManualCapturedEntry(
        book,
        input,
        { round: this.deps.getRound?.() ?? 0, labels },
      );

      previousBooks = books;
      this.writeBooks(upsertCapturedBook(books, nextBook));

      try {
        await this.deps.persist();
      } catch (err) {
        console.error('[CapturedSetting] persist failed, rolling back:', err);
        this.writeBooks(previousBooks);
        return { ok: false, reason: 'persist_failed' };
      }
      return { ok: true, entry };
    } catch (err) {
      console.error('[CapturedSetting] manual add failed:', err);
      if (previousBooks) this.writeBooks(previousBooks);
      return { ok: false, reason: 'internal_error' };
    }
  }

  /** Undo a capture (toast button or panel). Never deletes — the row stays restorable. */
  async retract(entryId: string): Promise<CapturedMutationResult> {
    return this.apply(entryId, (book) => ({ book: retractCapturedEntry(book, entryId) }), 'invalidate');
  }

  /** Bring a retracted entry back. Subject to the same capacity cap as a fresh capture. */
  async restore(entryId: string): Promise<CapturedMutationResult> {
    return this.apply(entryId, (book) => {
      const r = restoreCapturedEntry(book, entryId);
      return r.ok ? { book: r.book } : { book, failure: r.reason ?? 'internal_error' };
    }, 'reproject');
  }

  /**
   * Player edit from the panel.
   *
   * Editing `content` or `entityRefs` changes what the setting MEANS, so the graph
   * projection is rebuilt: the old edge is invalidated and a new one built from the new
   * meaning. Title / keyword / pin-only edits leave the graph alone — they change how
   * the entry is FOUND, not what it asserts.
   */
  async edit(entryId: string, patch: CapturedEntryPatch): Promise<CapturedMutationResult> {
    const semanticChange = patch.content !== undefined || patch.entityRefs !== undefined;
    return this.apply(
      entryId,
      (book) => ({ book: editCapturedEntry(book, entryId, patch) }),
      semanticChange ? 'reproject' : 'none',
    );
  }

  /**
   * Pin / unpin to always-inject.
   *
   * Only the player can do this. It is the deterministic escape hatch for a setting with
   * no natural keyword anchor ("this world has two moons"), which would otherwise never
   * match anything and sit in the book doing nothing.
   */
  async pin(entryId: string, pinned: boolean): Promise<CapturedMutationResult> {
    return this.apply(entryId, (book) => ({ book: pinCapturedEntry(book, entryId, pinned) }), 'none');
  }

  /** Disable without marking retracted — a softer "not right now" than undo. */
  async setEnabled(entryId: string, enabled: boolean): Promise<CapturedMutationResult> {
    return this.apply(
      entryId,
      (book) => ({
        book: {
          ...book,
          entries: book.entries.map((e) =>
            e.id === entryId ? { ...e, enabled, updatedAt: Date.now() } : e),
          updatedAt: Date.now(),
        },
      }),
      enabled ? 'reproject' : 'invalidate',
    );
  }

  // ── Internals ──

  private async apply(
    entryId: string,
    mutate: (book: WorldBook) => { book: WorldBook; failure?: CapturedMutationFailure },
    engramOp: 'invalidate' | 'reproject' | 'none',
  ): Promise<CapturedMutationResult> {
    let previousBooks: WorldBook[] | undefined;
    try {
      const books = this.readBooks();
      const book = findCapturedBook(books);
      if (!book) return { ok: false, reason: 'no_book' };
      if (!book.entries.some((e) => e.id === entryId)) return { ok: false, reason: 'not_found' };

      const { book: nextBook, failure } = mutate(book);
      if (failure) return { ok: false, reason: failure };

      // Snapshot for rollback BEFORE the first side effect.
      previousBooks = books;
      this.writeBooks(upsertCapturedBook(books, nextBook));

      const entry = nextBook.entries.find((e) => e.id === entryId);

      let engramDegraded = false;
      if (engramOp !== 'none' && this.deps.engram?.isActive()) {
        try {
          if (engramOp === 'invalidate') await this.deps.engram.invalidate(entryId);
          else if (entry) await this.deps.engram.reproject(entry);
        } catch (err) {
          // Non-fatal by design: the world book is the authority, Engram is a
          // projection. Report it so the caller can surface a degraded state rather
          // than pretending the graph is in sync.
          console.warn('[CapturedSetting] Engram sync failed (non-blocking):', err);
          engramDegraded = true;
        }
      }

      try {
        await this.deps.persist();
      } catch (err) {
        // Persistence IS fatal: an un-saved change is a lie the moment the page reloads.
        console.error('[CapturedSetting] persist failed, rolling back:', err);
        this.writeBooks(previousBooks);
        return { ok: false, reason: 'persist_failed' };
      }

      return { ok: true, entry, engramDegraded: engramDegraded || undefined };
    } catch (err) {
      console.error('[CapturedSetting] mutation failed:', err);
      if (previousBooks) this.writeBooks(previousBooks);
      return { ok: false, reason: 'internal_error' };
    }
  }

  private readBooks(): WorldBook[] {
    const raw = this.deps.stateManager.get<WorldBook[]>(this.deps.paths.slotWorldBooks);
    return Array.isArray(raw) ? raw : [];
  }

  private writeBooks(books: WorldBook[]): void {
    this.deps.stateManager.set(this.deps.paths.slotWorldBooks, books);
  }
}
