/**
 * Game Card Epic — integration test (MOCK DATA ONLY, ZERO real API).
 *
 * Covers the epic's core product line without spending a single API token:
 *   1. Story 9 写卡模式: toggle hides the composer, opens the guide, and the
 *      sessionType survives a reload + re-entry (SC-7).
 *   2. Story 5+6 导出→导入 roundtrip: export the seeded save to a real .aga-card
 *      (pure serialization, zero AI), then import THAT file back (world data
 *      survives; the opening generation degrades gracefully with no API).
 *
 * Why this is AI-free: no API is ever configured (the disableApi init script seeds
 * one DISABLED config), so every AIService.getConfigForUsage() returns undefined →
 * LLM generate throws "no config" BEFORE any fetch, the embedder falls back to
 * pseudoEmbed, and image generation is gated off in the seed. The auto `apiGuard`
 * fixture (base.ts) records any real LLM/embedding/image/github egress and asserts
 * the list is empty at the end of every test.
 *
 * The save is seeded directly into IndexedDB (via seedSave) to skip the heavy
 * Story-0 opening pipeline. The shared fixtures + page objects live in e2e/fixtures
 * and e2e/pages; this spec is the reference consumer of that layer.
 *
 * Runs on desktop-1920 only (seed + modal flows are desktop-oriented).
 * Run: npx playwright test game-card-epic
 */
import {
  test, expect,
  seedSave, enterSeededGame,
  decodeCardFile, assertNoSecrets,
  LOCATION_NAME, NPC_NAME,
} from './fixtures/base';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'integration spec runs on desktop-1920 only');
});

test.describe('Game Card Epic — integration (mock data, zero real API)', () => {
  test('Story 9 写卡模式: toggle auto-opens guide + in-panel notice + persists across reload',
    { tag: ['@regression', '@card', '@session', '@story-9'] },
    async ({ page, gameShell }) => {
      await seedSave(page);
      await enterSeededGame(page);

      const toggle = gameShell.modeToggle;
      await expect(toggle).toContainText('游玩模式');
      await expect(gameShell.composer).toBeVisible();   // play-mode composer

      // Toggle → writing mode auto-opens the card-writing guide (SESSION-1 fix).
      await gameShell.toggleMode();
      await expect(toggle).toContainText('写卡模式');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/\/game\/card-guide$/);
      await expect(page.locator('.card-guide__title')).toHaveText('游戏卡创作指南');

      // Safety-net (JOURNEY-2): back on the main panel while still in writing mode →
      // the composer is hidden and the in-panel notice replaces it.
      await gameShell.goTab('');
      await expect(gameShell.composer).toHaveCount(0);
      await expect(gameShell.wbNotice).toBeVisible();
      await gameShell.openGuideFromNotice();   // notice → guide
      await expect(page).toHaveURL(/\/game\/card-guide$/);

      // Persistence: sessionType is per-slot; re-enter after a reload → still
      // writing mode, and the guide auto-opens again on resume (SESSION-1 immediate).
      await page.reload();
      await enterSeededGame(page);
      await expect(gameShell.modeToggle).toContainText('写卡模式');
      await expect(page).toHaveURL(/\/game\/card-guide$/);
      // apiGuard auto-fixture asserts zero egress in teardown.
    });

  test('Story 5+6 导出→导入 roundtrip: zero AI, bundle valid, world survives',
    { tag: ['@regression', '@card', '@story-5', '@story-6'] },
    async ({ page, home, gameShell, savePage, cardExport, cardImport }, testInfo) => {
      // P9: export plus import runs close to 30 s on a loaded machine (2026-10-04: alone it passed once, failed once).
      test.slow();
      await seedSave(page);
      await enterSeededGame(page);

      // ── Export (Story 5) — navigate in-SPA to the Save panel, open the export modal.
      await gameShell.goTab('save');
      await savePage.openExportFlow();

      // Seed guarantees the D18 coverage gate passes → the form unlocks.
      await expect(cardExport.gatePass).toBeVisible({ timeout: 15_000 });
      await cardExport.fillTitle('集成测试卡');

      await expect(cardExport.exportButton).toBeEnabled();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        cardExport.exportButton.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^card-.+-\d{8}\.aga-card$/);

      // ── Validate the exported bundle (gzip envelope → JSON).
      const cardPath = testInfo.outputPath('roundtrip.aga-card');
      await download.saveAs(cardPath);
      const envelope = decodeCardFile(cardPath);
      expect(envelope.format).toBe('aga-card');
      expect(envelope.bundle.bundleType).toBe('card');
      expect(envelope.bundle.cardMeta.title).toBe('集成测试卡');
      expect(envelope.bundle.cardMeta.packId).toBe('tianming');
      // World preserved, gameplay history stripped, no secrets leaked.
      const bundleJson = JSON.stringify(envelope.bundle);
      expect(bundleJson).toContain(LOCATION_NAME);
      expect(bundleJson).toContain(NPC_NAME);
      expect(envelope.bundle.engram.entities.length).toBeGreaterThanOrEqual(2);
      assertNoSecrets(bundleJson);                            // no API-key markers
      expect(envelope.bundle.stateTree?.元数据?.叙事历史 ?? []).toEqual([]);  // play history stripped

      // ── Import (Story 6) — back to HomeView, import the file we just exported.
      await page.goto('/');
      await home.importCard();
      await cardImport.pickFile(cardPath);

      // Preview proves the world survived export→decode.
      await expect(cardImport.previewHeading()).toBeVisible({ timeout: 15_000 });
      await expect(cardImport.stage).toContainText('1 处地点');
      await expect(cardImport.stage).toContainText('1 位人物');

      // preview → protagonist → global → import (SFW + fixed protagonist: no NSFW gate).
      await cardImport.next();    // → protagonist
      await cardImport.next();    // → global
      await cardImport.doImport();

      // Import succeeds even though the opening degrades (no API): success screen appears.
      await expect(cardImport.doneHeading()).toBeVisible({ timeout: 30_000 });
      await cardImport.enterGame();
      await page.waitForURL(/\/game(\/|$)/);
      // apiGuard auto-fixture asserts zero egress in teardown.
    });
});
