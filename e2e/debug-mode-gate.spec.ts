/**
 * Debug 模式 → Prompt 组装 sidebar entry gating (ZERO real API).
 *
 * Regression for the 2026-08-26 dead-control fix: the settings Debug 模式
 * toggle promises "显示 Prompt 组装面板入口" but historically nothing consumed
 * it — the sidebar entry was rendered unconditionally. This spec pins the
 * contract:
 *   1. fresh save, toggle off (default) → no Prompt 组装 entry in the sidebar;
 *   2. flip the toggle on in 设置 → 高级设置 → entry appears live (event bus);
 *   3. flip it off → entry disappears again;
 *   4. reload with the toggle persisted on → entry present from boot
 *      (localStorage read path, not just the event path).
 *
 * Runs on desktop-1920 only. Run: npx playwright test debug-mode-gate
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';

const ENTRY = '.sidebar a[href="/game/prompt-assembly"]';

function debugToggle(page: Page) {
  return page
    .locator('.setting-row', { has: page.locator('.setting-label', { hasText: 'Debug 模式' }) })
    .locator('button.aga-toggle');
}

test.describe('Debug 模式 gates the Prompt 组装 sidebar entry', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar entry specs run on desktop-1920 only');
  });
  test('entry hidden by default; toggle shows/hides it live and survives reload',
    { tag: ['@regression', '@settings'] },
    async ({ page, gameShell }) => {
      await seedSave(page);
      await enterSeededGame(page);

      // 1. Default (debugMode off): the sidebar must NOT offer the entry.
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator(ENTRY)).toHaveCount(0);

      // 2. Flip the toggle on → entry appears without a reload.
      await gameShell.goTab('settings');
      const toggle = debugToggle(page);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator(ENTRY)).toBeVisible();

      // The entry actually navigates (consumption, not just chrome).
      await page.locator(ENTRY).click();
      await page.waitForURL(/\/game\/prompt-assembly$/);

      // 3. Flip it off → entry disappears live.
      await gameShell.goTab('settings');
      await debugToggle(page).click();
      await expect(page.locator(ENTRY)).toHaveCount(0);

      // 4. Persisted-on boot path: turn it back on, reload, entry present.
      await debugToggle(page).click();
      await page.reload();
      await enterSeededGame(page);
      await expect(page.locator(ENTRY)).toBeVisible();
    });

  test('aiLogging on → [AI-LOG] request/error reach the console on a round attempt (offline)',
    { tag: ['@regression', '@settings'] },
    async ({ page }) => {
      test.slow(); // full main-round assembly before the (aborted) AI call
      await seedSave(page);

      // Registered AFTER seedSave's disableApi init script, so on the next boot
      // this runs later and wins: ONE enabled LLM config pointing at loopback
      // (so doGenerate reaches the [AI-LOG] hook instead of throwing "no config"),
      // plus all three debug toggles on. aga_ai_settings maxRetries:0 from
      // disableApi is left in place so the aborted call fails fast.
      await page.addInitScript(() => {
        localStorage.setItem('aga_api_management', JSON.stringify({
          apiConfigs: [{
            id: 'e2e-ailog', name: 'ailog', apiCategory: 'llm', provider: 'openai',
            url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop',
            temperature: 0, maxTokens: 1, enabled: true,
          }],
          apiAssignments: [],
        }));
        localStorage.setItem('aga_debug_settings', JSON.stringify({
          debugMode: true, consoleDebug: true, aiLogging: true,
        }));
      });
      await page.reload();

      // Highest-precedence route (registered last) — swallows the loopback call
      // BEFORE the api-guard's `**/v1/chat/completions` handler can record a hit.
      // Still zero egress: the request is aborted, never sent.
      await page.route('http://127.0.0.1:1/**', (route) => route.abort('connectionrefused'));

      await enterSeededGame(page);

      const aiLogRequest = page.waitForEvent('console',
        { predicate: (m) => m.text().startsWith('[AI-LOG] request'), timeout: 30_000 });
      const aiLogError = page.waitForEvent('console',
        { predicate: (m) => m.text().startsWith('[AI-LOG] error'), timeout: 30_000 });

      await page.locator('.message-input').fill('环顾四周');
      await page.locator('.send-btn').click();

      // Both sides of the hook fire: the pre-call request record and, because the
      // loopback call is aborted, the error record (instead of a response record).
      await aiLogRequest;
      await aiLogError;
    });
});
