/**
 * The save's own settings are offered on the game page only (ZERO real API).
 *
 * P10 (2026-10-03 review, fixed 2026-10-04): the heartbeat, NPC and plot sections and the AI feature rows of the
 * settings page showed whenever a save was in memory. Back on Home the save still is, so they could be changed there,
 * but 继续游戏 loads the save again and the change was lost. Like the action-options switch before them, they now
 * show on the game page only.
 *
 * Run: npx playwright test settings-in-game-only
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';

const SECTIONS = ['#settings-heartbeat', '#settings-npc', '#settings-plot'];
const ROWS = ['思维链推理（CoT）', '文本润色（Body Polish）'];

test('the save\'s own settings show on the game page, and not on Home while the save is still in memory',
  { tag: ['@regression', '@settings'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for which sections show');
    test.slow();
    await seedSave(page);
    await enterSeededGame(page);

    await goToGameTab(page, 'settings');
    for (const section of SECTIONS) await expect(page.locator(section)).toHaveCount(1);
    for (const row of ROWS) await expect(page.getByText(row, { exact: true })).toBeVisible();

    // Back to Home without reloading: the save stays in memory.
    await page.getByRole('button', { name: '返回首页' }).click();
    await page.getByRole('button', { name: '不保存退出' }).click();
    await page.waitForURL(/\/$/);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    // The device's own settings are there; the save's are not (a change here would be lost on 继续游戏).
    await expect(page.locator('#settings-action')).toHaveCount(1);
    for (const section of SECTIONS) await expect(page.locator(section)).toHaveCount(0);
    for (const row of ROWS) await expect(page.getByText(row, { exact: true })).toHaveCount(0);
    for (const nav of ['世界心跳', 'NPC 设置', '剧情导向']) {
      await expect(page.locator('.settings-nav').getByText(nav, { exact: true })).toHaveCount(0);
    }
  });
