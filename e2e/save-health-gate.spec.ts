/**
 * Pre-round save-health gate (MOCK DATA, ZERO real API).
 *
 * Regression for the 2026-09-09 incident: a browser dropped the image cache and the
 * world-book library while the save tree survived, and the game kept advancing on the
 * damaged save. The gate runs BEFORE `pipeline:user-input` is emitted:
 *   1. a save whose tree references an image the cache does not hold blocks the round
 *      with the gate modal;
 *   2. 「去存档管理」 restores the typed text and navigates to the save panel;
 *   3. 「继续生成」 lets the round through and does not nag again for the same findings;
 *   4. a healthy save never sees the modal.
 * The offline API guard means a round that does start fails fast, and the panel's
 * safety net then restores the typed text — that restore is the spec's proof that a
 * round was actually dispatched.
 *
 * Runs on desktop-1920 only.
 * Run: npx playwright test save-health-gate
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import type { Page } from '@playwright/test';

const INPUT = '走进妆造室，看看谁在。';
const MISSING_IMAGE_ID = 'asset_img_e2e_missing_avatar';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'gate spec runs on desktop-1920 only');
});
test.describe.configure({ timeout: 90_000 });

function composer(page: Page) {
  return page.locator('textarea').first();
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.describe('Save-health gate before a round (offline)', () => {
  test('a save referencing a missing image is blocked, 去存档管理 keeps the text, 继续 lets it through once',
    { tag: ['@regression', '@save', '@persistence'] },
    async ({ page }, testInfo) => {
      await seedSave(page, {
        tree: makeSeedTree({ 角色: { 图片档案: { 已选头像图片ID: MISSING_IMAGE_ID } } }),
      });
      await enterSeededGame(page);

      await send(page, INPUT);
      const gate = page.getByTestId('save-health-gate');
      await expect(gate).toBeVisible();
      await expect(gate).toContainText('1'); // 1 of 1 referenced images missing
      await page.waitForTimeout(600); // let the modal's enter transition settle before the evidence shot
      await page.screenshot({ path: testInfo.outputPath('save-health-gate.png') });

      // Exit 1: go fix it — the typed text must not be lost and the round must not run.
      await page.getByTestId('save-health-go-save').click();
      await page.waitForURL(/\/game\/save$/);
      await page.locator('.sidebar a[href="/game"]').first().click();
      await page.waitForURL(/\/game$/);
      await expect(composer(page)).toHaveValue(INPUT);

      // Exit 2: knowingly continue — the modal closes and the same findings do not nag again.
      await composer(page).press('Enter');
      await expect(gate).toBeVisible();
      await page.getByTestId('save-health-continue').click();
      await expect(gate).toBeHidden();
      // Proof the round was handed to the pipeline: offline it fails at once and the
      // panel's existing safety net puts the text back into the composer — the only
      // path that restores it after a send.
      await expect(composer(page)).toHaveValue(INPUT, { timeout: 15_000 });

      // Same findings again → no nag; the send goes straight through.
      await composer(page).press('Enter');
      await expect(gate).toBeHidden({ timeout: 3000 });
      await expect(composer(page)).toHaveValue(INPUT, { timeout: 15_000 });
    });

  test('a healthy save never sees the gate',
    { tag: ['@regression', '@save'] },
    async ({ page }) => {
      await seedSave(page);
      await enterSeededGame(page);
      await send(page, INPUT);
      await expect(page.getByTestId('save-health-gate')).toBeHidden({ timeout: 3000 });
      // The round ran (and, offline, failed) — the safety net restored the text.
      await expect(composer(page)).toHaveValue(INPUT, { timeout: 15_000 });
    });
});
