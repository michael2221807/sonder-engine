/**
 * 发送即复制 (Composer send → clipboard) — critical-journey e2e.
 *
 * Zero real API (inherits the api-guard barrel). Seeds a resumable save, types
 * an action into the composer and clicks 发送 — the trimmed input must land in
 * the system clipboard as a recovery safety net (MainGamePanel.handleComposerSend).
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

test('发送即复制: clicking send mirrors the trimmed input to the clipboard', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedSave(page);
  await enterSeededGame(page);

  const composer = page.locator('textarea.message-input');
  await expect(composer).toBeVisible();

  // Trailing whitespace on purpose — the clipboard must receive the TRIMMED text.
  await composer.fill('  我走向城门，观察守卫的换岗规律。  ');
  await page.locator('button.send-btn').click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('我走向城门，观察守卫的换岗规律。');
});
