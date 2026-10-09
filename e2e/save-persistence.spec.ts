/**
 * Save persistence — full-backup export→import roundtrip (MOCK DATA, ZERO real API).
 *
 * Exercises BackupService.exportAll → importAll at the UI level (the CLAUDE.md
 * persistence gate) with no API: seed a save, export a full backup to a download,
 * then re-import that exact file. The roundtrip proves format compatibility without
 * parsing the bundle internals; the post-import page reload is the deterministic
 * success signal (executeImport only schedules the reload on success). The disableApi
 * init script re-applies on the reload, so the whole flow stays offline.
 *
 * Runs on desktop-1920 only.
 * Run: npx playwright test save-persistence
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { statSync } from 'node:fs';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'persistence spec runs on desktop-1920 only');
});

test.describe('Save persistence — full-backup roundtrip (offline)', () => {
  test('export a full backup and re-import it: roundtrip succeeds, zero API',
    { tag: ['@regression', '@save', '@persistence'] },
    async ({ page, gameShell, savePage }, testInfo) => {
      const ids = await seedSave(page);
      await enterSeededGame(page);
      await gameShell.goTab('save');

      // The seeded slot renders with the seeded character (proves load + render).
      await expect(savePage.slot(ids.slotId)).toContainText(ids.protagonist);
      // The seed records no size; the save in play is measured as the panel opens (存档瘦身 D9A: saving no longer
      // measures it every round), and shows in the one size format.
      await expect(savePage.slotSize(ids.slotId)).toHaveText(/^(\d+ KB|\d+\.\d MB)$/);

      // Reveal the full-backup controls (collapsed behind the settings gear).
      await savePage.openSettings();

      // ── Export a full backup → download.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        savePage.backupExportButton.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^full-backup-\d{4}-\d{2}-\d{2}\.json$/);
      const backupPath = testInfo.outputPath('full-backup.json');
      await download.saveAs(backupPath);
      expect(statSync(backupPath).size).toBeGreaterThan(100);   // a non-empty backup

      // ── Re-import that exact file (programmatic <input> → filechooser).
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        savePage.backupImportButton.click(),
      ]);
      await fileChooser.setFiles(backupPath);

      // The confirm modal detects a FULL (destructive) backup → the acknowledge gate appears.
      await expect(savePage.backupAcknowledge).toBeVisible({ timeout: 15_000 });
      await expect(savePage.backupConfirmButton).toBeDisabled();   // gated until acknowledged
      // backup-acknowledge is now an AgaToggle (button[role=switch]), not a native
      // checkbox — use click() (Playwright .check() only works on input checkbox/radio).
      await savePage.backupAcknowledge.click();
      await expect(savePage.backupConfirmButton).toBeEnabled();

      // Confirm → importAll succeeds → the app reloads (executeImport only schedules
      // window.location.reload() on a successful full restore).
      await Promise.all([
        page.waitForEvent('load', { timeout: 15_000 }),
        savePage.backupConfirmButton.click(),
      ]);

      // The full restore WIPES then re-imports IndexedDB. Confirm the seeded profile +
      // character actually survived the roundtrip (read the persisted data directly —
      // robust to the post-reload auto-resume navigation; toPass retries transient nav).
      await expect(async () => {
        const restored = await page.evaluate(async ({ p, s }) => {
          const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open('aga-saves', 1);
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
          });
          const get = <T>(k: string) => new Promise<T>((res, rej) => {
            const req = db.transaction('data', 'readonly').objectStore('data').get(k);
            req.onsuccess = () => res(req.result as T); req.onerror = () => rej(req.error);
          });
          const root = await get<{ profiles?: Record<string, unknown> } | undefined>('storage_root');
          const tree = await get<Record<string, unknown> | undefined>(`save_${p}_${s}`);
          const basic = (tree?.['角色'] as Record<string, unknown> | undefined)?.['基础信息'] as Record<string, unknown> | undefined;
          return { hasProfile: !!root?.profiles?.[p], characterName: basic?.['姓名'] as string | undefined };
        }, { p: ids.profileId, s: ids.slotId });
        expect(restored.hasProfile).toBe(true);
        expect(restored.characterName).toBe(ids.protagonist);
      }).toPass({ timeout: 20_000 });
      // apiGuard auto-fixture asserts zero egress in teardown.
    });
});
