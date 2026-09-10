// App doc: docs/user-guide/pages/game-prompts.md §4（世界书 Tab · 存档集成）, game-save.md §3.2（完整备份）
/**
 * World Book + Built-in Prompt persistence — IndexedDB storage
 *
 * Manages two stores:
 * - `worldbooks`: User-created world book collections with entries
 * - `builtin-prompts`: User overrides of built-in prompt slots
 *
 * Key design: world books are per-profile (keyed by profileId),
 * built-in prompt overrides are per-pack (keyed by packId:slotId).
 */
import { openDB, type IDBPDatabase } from 'idb';
import type {
  WorldBook,
  WorldBookEntry,
  BuiltinPromptEntry,
  WorldBookPresetGroup,
  WorldBookExportData,
  BuiltinPromptExportData,
} from './world-book';

const DB_NAME = 'aga-worldbook';
const DB_VERSION = 1;

export class WorldBookStorage {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private getDB(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      const opening = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('worldbooks')) {
            db.createObjectStore('worldbooks');
          }
          if (!db.objectStoreNames.contains('builtin-prompts')) {
            db.createObjectStore('builtin-prompts');
          }
          if (!db.objectStoreNames.contains('preset-groups')) {
            db.createObjectStore('preset-groups');
          }
        },
        // 连接被浏览器异常关闭（存储驱逐 / 另一标签页 deleteDatabase）时丢弃
        // 缓存句柄，下一次 getDB() 自动重开，而非一直拿着死句柄报错。
        terminated: () => { if (this.dbPromise === opening) this.dbPromise = null; },
      });
      // open 自身失败时不要把 rejected promise 永久缓存。
      opening.catch(() => { if (this.dbPromise === opening) this.dbPromise = null; });
      this.dbPromise = opening;
    }
    return this.dbPromise;
  }

  // ─── World Books ──────────────────────────────────────────

  async saveWorldBook(profileId: string, book: WorldBook): Promise<void> {
    const db = await this.getDB();
    const plain = JSON.parse(JSON.stringify(book)) as WorldBook;
    await db.put('worldbooks', plain, `${profileId}:${book.id}`);
  }

  async loadWorldBooks(profileId: string): Promise<WorldBook[]> {
    const db = await this.getDB();
    const keys = await db.getAllKeys('worldbooks');
    const prefix = `${profileId}:`;
    const books: WorldBook[] = [];
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        const book = await db.get('worldbooks', key);
        if (book) books.push(book as WorldBook);
      }
    }
    return books;
  }

  async deleteWorldBook(profileId: string, bookId: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('worldbooks', `${profileId}:${bookId}`);
  }

  // ─── World Book Entries (convenience) ─────────────────────

  async addEntry(profileId: string, bookId: string, entry: WorldBookEntry): Promise<void> {
    const books = await this.loadWorldBooks(profileId);
    const book = books.find((b) => b.id === bookId);
    if (!book) return;
    book.entries.push(entry);
    book.updatedAt = Date.now();
    await this.saveWorldBook(profileId, book);
  }

  async updateEntry(profileId: string, bookId: string, entry: WorldBookEntry): Promise<void> {
    const books = await this.loadWorldBooks(profileId);
    const book = books.find((b) => b.id === bookId);
    if (!book) return;
    const idx = book.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      book.entries[idx] = { ...entry, updatedAt: Date.now() };
      book.updatedAt = Date.now();
      await this.saveWorldBook(profileId, book);
    }
  }

  async deleteEntry(profileId: string, bookId: string, entryId: string): Promise<void> {
    const books = await this.loadWorldBooks(profileId);
    const book = books.find((b) => b.id === bookId);
    if (!book) return;
    book.entries = book.entries.filter((e) => e.id !== entryId);
    book.updatedAt = Date.now();
    await this.saveWorldBook(profileId, book);
  }

  // ─── Built-in Prompt Overrides ────────────────────────────

  async saveBuiltinOverride(packId: string, entry: BuiltinPromptEntry): Promise<void> {
    const db = await this.getDB();
    await db.put('builtin-prompts', entry, `${packId}:${entry.slotId}`);
  }

  async loadBuiltinOverride(packId: string, slotId: string): Promise<BuiltinPromptEntry | undefined> {
    const db = await this.getDB();
    return db.get('builtin-prompts', `${packId}:${slotId}`) as Promise<BuiltinPromptEntry | undefined>;
  }

  async loadAllBuiltinOverrides(packId: string): Promise<BuiltinPromptEntry[]> {
    const db = await this.getDB();
    const keys = await db.getAllKeys('builtin-prompts');
    const prefix = `${packId}:`;
    const entries: BuiltinPromptEntry[] = [];
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        const entry = await db.get('builtin-prompts', key);
        if (entry) entries.push(entry as BuiltinPromptEntry);
      }
    }
    return entries;
  }

  async resetBuiltinOverride(packId: string, slotId: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('builtin-prompts', `${packId}:${slotId}`);
  }

  async resetAllBuiltinOverrides(packId: string): Promise<void> {
    const db = await this.getDB();
    const keys = await db.getAllKeys('builtin-prompts');
    const prefix = `${packId}:`;
    const tx = db.transaction('builtin-prompts', 'readwrite');
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        await tx.store.delete(key);
      }
    }
    await tx.done;
  }

  // ─── Preset Groups ────────────────────────────────────────

  async savePresetGroup(profileId: string, group: WorldBookPresetGroup): Promise<void> {
    const db = await this.getDB();
    await db.put('preset-groups', group, `${profileId}:${group.id}`);
  }

  async loadPresetGroups(profileId: string): Promise<WorldBookPresetGroup[]> {
    const db = await this.getDB();
    const keys = await db.getAllKeys('preset-groups');
    const prefix = `${profileId}:`;
    const groups: WorldBookPresetGroup[] = [];
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        const group = await db.get('preset-groups', key);
        if (group) groups.push(group as WorldBookPresetGroup);
      }
    }
    return groups;
  }

  async deletePresetGroup(profileId: string, groupId: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('preset-groups', `${profileId}:${groupId}`);
  }

  // ─── Export / Import ──────────────────────────────────────

  async exportWorldBooks(profileId: string): Promise<WorldBookExportData> {
    const books = await this.loadWorldBooks(profileId);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      books,
    };
  }

  async importWorldBooks(profileId: string, data: WorldBookExportData): Promise<number> {
    if (!data.books || !Array.isArray(data.books)) return 0;
    for (const book of data.books) {
      await this.saveWorldBook(profileId, {
        ...book,
        id: book.id || `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        updatedAt: Date.now(),
      });
    }
    return data.books.length;
  }

  async exportBuiltinOverrides(packId: string): Promise<BuiltinPromptExportData> {
    const entries = await this.loadAllBuiltinOverrides(packId);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    };
  }

  async importBuiltinOverrides(packId: string, data: BuiltinPromptExportData): Promise<number> {
    if (!data.entries || !Array.isArray(data.entries)) return 0;
    for (const entry of data.entries) {
      await this.saveBuiltinOverride(packId, entry);
    }
    return data.entries.length;
  }

  /**
   * Delete ALL built-in prompt overrides for a single pack (per-pack, unlike clearAll).
   * Used by Story 6 card-import undo / failure-rollback to revert a card's built-in overrides
   * exactly: clear the pack's entries, then re-import the pre-import snapshot.
   */
  async clearBuiltinOverrides(packId: string): Promise<void> {
    const db = await this.getDB();
    const prefix = `${packId}:`;
    const tx = db.transaction('builtin-prompts', 'readwrite');
    // Read keys INSIDE the transaction (no TOCTOU window vs a concurrent write).
    const keys = await tx.store.getAllKeys();
    for (const key of keys) {
      if (String(key).startsWith(prefix)) await tx.store.delete(key);
    }
    await tx.done;
  }

  /**
   * Atomic per-pack REPLACE of built-in overrides in a SINGLE transaction (Story 6 import undo /
   * rollback): delete the pack's existing entries then put the snapshot's entries, so a mid-restore
   * failure aborts the tx and rolls back rather than leaving the pack half-reverted.
   */
  async replaceBuiltinOverrides(packId: string, data: BuiltinPromptExportData): Promise<void> {
    const db = await this.getDB();
    const prefix = `${packId}:`;
    const tx = db.transaction('builtin-prompts', 'readwrite');
    const keys = await tx.store.getAllKeys();
    for (const key of keys) {
      if (String(key).startsWith(prefix)) await tx.store.delete(key);
    }
    if (data?.entries && Array.isArray(data.entries)) {
      for (const entry of data.entries) {
        await tx.store.put(entry, `${packId}:${entry.slotId}`);
      }
    }
    await tx.done;
  }

  // ─── Clear All ────────────────────────────────────────────

  async clearAll(): Promise<void> {
    const db = await this.getDB();
    await db.clear('worldbooks');
    await db.clear('builtin-prompts');
    await db.clear('preset-groups');
  }

  /**
   * Clear ONLY the `worldbooks` store.
   *
   * Backup import needs this split (2026-09-09 data-loss fix): a bundle that carries a
   * `worldBooks` section replaces the local books exactly, but a bundle WITHOUT that
   * section must leave hand-written books alone — while built-in overrides and preset
   * groups keep their wipe-then-restore semantics via {@link clearNonWorldBookStores}.
   */
  async clearWorldBooks(): Promise<void> {
    const db = await this.getDB();
    await db.clear('worldbooks');
  }

  /** Clear every store EXCEPT `worldbooks` (see {@link clearWorldBooks}). */
  async clearNonWorldBookStores(): Promise<void> {
    const db = await this.getDB();
    await db.clear('builtin-prompts');
    await db.clear('preset-groups');
  }
}
