/**
 * World book persistence + captured-entry delete (MOCK DATA, ZERO real API).
 *
 * Regression for the 2026-09-09 report "角色档案世界书存档后丢失": a hand-written
 * profile world book (IndexedDB `aga-worldbook`, keyed by profileId) must survive
 *   1. a plain page reload (the debounced write actually reached IndexedDB),
 *   2. a manual game save (存档) followed by a reload, and
 *   3. a full-backup export → import roundtrip (the CLAUDE.md persistence gate at
 *      the UI level — `BackupBundle.worldBooks` is carried AND restored).
 * The slot-owned captured book lives in the state tree and is covered by
 * `slot-world-books-persistence.test.ts`; this spec is about the OTHER home.
 *
 * Also covers the two sibling reports from the same session: a manually added captured
 * entry can be hard-deleted (and stays deleted after a reload), and the manual-add
 * textarea renders with the panel's form styling (screenshot attached).
 *
 * Runs on desktop-1920 only.
 * Run: npx playwright test worldbook-persistence
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';

const BOOK_TITLE = 'e2e 手写世界书';
const ENTRY_TITLE = 'e2e 条目';
const ENTRY_CONTENT = '这个世界有两个月亮，潮汐每月两次达到顶峰。';
const MANUAL_CONTENT = '城北的钟楼每晚十点敲十三下。';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'persistence spec runs on desktop-1920 only');
});

// Seed → author → save/reload → reopen is three full app boots; the default 30 s is tight.
test.describe.configure({ timeout: 90_000 });

async function openWorldBookTab(page: Page): Promise<void> {
  await page.locator('.sidebar a[href="/game/prompts"]').first().click();
  await page.waitForURL(/\/game\/prompts$/);
  await page.locator('.tab-btn', { hasText: '世界书' }).click();
  await expect(page.locator('.wb-tab')).toBeVisible();
}

/** Create one profile book with one entry through the real UI and let the debounce flush. */
async function authorProfileEntry(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新建世界书' }).click();
  await page.locator('input.wb-book-title-input').first().fill(BOOK_TITLE);
  await page.getByRole('button', { name: '新增条目' }).click();
  await page.locator('.wb-editor-title').fill(ENTRY_TITLE);
  await page.locator('.wb-content-editor').fill(ENTRY_CONTENT);
  // scheduleSave debounces 300 ms; give IndexedDB a moment to commit.
  await page.waitForTimeout(800);
}

async function expectProfileEntryPresent(page: Page): Promise<void> {
  await expect(page.locator('input.wb-book-title-input').first()).toHaveValue(BOOK_TITLE);
  await expect(page.locator('.wb-entry-title', { hasText: ENTRY_TITLE })).toBeVisible();
  await page.locator('.wb-entry-item', { hasText: ENTRY_TITLE }).click();
  await expect(page.locator('.wb-content-editor')).toHaveValue(ENTRY_CONTENT);
}

test.describe('Profile world book — survives reload, manual save and backup roundtrip (offline)', () => {
  test('a hand-written entry is still there after a page reload',
    { tag: ['@regression', '@worldbook', '@persistence'] },
    async ({ page }) => {
      await seedSave(page);
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await authorProfileEntry(page);

      await page.reload();
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await expectProfileEntryPresent(page);
    });

  test('a hand-written entry is still there after saving the game (存档) and reloading',
    { tag: ['@regression', '@worldbook', '@persistence'] },
    async ({ page, gameShell, savePage }) => {
      const ids = await seedSave(page);
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await authorProfileEntry(page);

      await gameShell.goTab('save');
      await savePage.slot(ids.slotId).getByRole('button', { name: '保存', exact: true }).click();
      // A slot that already has data asks before overwriting; a fresh one saves straight away.
      const overwrite = page.getByRole('button', { name: '确认覆盖' });
      await overwrite.waitFor({ state: 'visible', timeout: 3000 }).then(() => overwrite.click()).catch(() => {});
      await page.waitForTimeout(800);

      await page.reload();
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await expectProfileEntryPresent(page);
    });

  test('a hand-written entry survives full-backup export → import',
    { tag: ['@regression', '@worldbook', '@persistence'] },
    async ({ page, gameShell, savePage }, testInfo) => {
      await seedSave(page);
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await authorProfileEntry(page);

      await gameShell.goTab('save');
      await savePage.openSettings();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        savePage.backupExportButton.click(),
      ]);
      const backupPath = testInfo.outputPath('full-backup.json');
      await download.saveAs(backupPath);

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        savePage.backupImportButton.click(),
      ]);
      await fileChooser.setFiles(backupPath);
      await expect(savePage.backupAcknowledge).toBeVisible({ timeout: 15_000 });
      await savePage.backupAcknowledge.click();
      await expect(savePage.backupConfirmButton).toBeEnabled();
      await Promise.all([
        page.waitForEvent('load', { timeout: 30_000 }),
        savePage.backupConfirmButton.click(),
      ]);

      // Post-import auto-resume lands in /game; if it fell back to Home, resume by hand.
      if (!/\/game(\/|$)/.test(page.url())) await enterSeededGame(page);
      await page.getByTestId('mode-toggle').waitFor({ state: 'visible', timeout: 15_000 });
      await openWorldBookTab(page);
      await expectProfileEntryPresent(page);
    });
});

test.describe('Captured settings — manual add is styled and can be hard-deleted (offline)', () => {
  test('a manually added setting can be deleted for good, and stays gone after a reload',
    { tag: ['@regression', '@worldbook'] },
    async ({ page }, testInfo) => {
      await seedSave(page);
      await enterSeededGame(page);
      await openWorldBookTab(page);

      // The 本存档 placeholder card carries the standing 手动添加 entry point.
      await page.locator('.wb-book-card--placeholder').getByRole('button', { name: '手动添加' }).click();
      const draft = page.locator('#wb-manual-draft');
      await expect(draft).toBeVisible();
      // Bug 3: the textarea must use the panel's input surface, not the browser default
      // (white box). Assert the computed background is not plain white/transparent.
      const bg = await draft.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toMatch(/^rgba?\(255, 255, 255(, 1)?\)$/);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      await draft.fill(MANUAL_CONTENT);
      await page.screenshot({ path: testInfo.outputPath('manual-draft.png'), fullPage: false });
      await page.locator('.wb-manual-draft__actions button').first().click(); // 保存修改

      // The entry lands in the captured book and is selected.
      const row = page.locator('.wb-entry-item', { hasText: MANUAL_CONTENT.slice(0, 8) });
      await expect(row).toBeVisible();
      await expect(page.locator('.wb-content-editor')).toHaveValue(MANUAL_CONTENT);
      await page.screenshot({ path: testInfo.outputPath('captured-entry-actions.png'), fullPage: false });

      // Bug 2: hard delete (confirm dialog accepted) → row disappears.
      page.once('dialog', (d) => { void d.accept(); });
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await expect(row).toHaveCount(0);
      await page.waitForTimeout(800); // engine:request-save flush

      await page.reload();
      await enterSeededGame(page);
      await openWorldBookTab(page);
      await expect(page.locator('.wb-entry-item', { hasText: MANUAL_CONTENT.slice(0, 8) })).toHaveCount(0);
      // The captured book object survives with zero entries (placeholder only shows before
      // the book exists), so assert the count the card displays.
      await expect(page.locator('.wb-book-card--captured').first()).toContainText('0 条目');
    });
});
