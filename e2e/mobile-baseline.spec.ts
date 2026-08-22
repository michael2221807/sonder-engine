/**
 * Mobile adaptation screenshot CAPTURE (NOT golden visual regression).
 *
 * Captures full-page screenshots at three viewport sizes (desktop-1920, mobile-390,
 * mobile-360) for key pages as a manual eyeballing aid + a crash check (page renders,
 * #app visible). It deliberately does NOT use Playwright's `toHaveScreenshot()` golden
 * comparison — there is no pass/fail pixel diff. Golden visual-regression gating is not
 * adopted (see docs/design/e2e-testing-framework-design.md §7 decision 3); adopting it
 * would need Docker-normalized baselines + a binary-diff review workflow.
 *
 * Phase 0.4 of docs/design/mobile-adaptation-plan.md.
 */
import { test, expect } from './fixtures/base';
import { disableApi } from './fixtures/disable-api';

// Guarded + offline by construction (apiGuard via base + disableApi before boot).
test.beforeEach(async ({ page }) => {
  await disableApi(page);
});

test.describe('Visual regression baseline — Home', () => {
  test('homepage renders without crash', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/Sonder/);
    await expect(page.locator('#app')).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-home.png`, fullPage: true });
  });
});

test.describe('Visual regression baseline — Creation', () => {
  test('creation page renders without crash', async ({ page }) => {
    await page.goto('/creation');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#app')).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-creation.png`, fullPage: true });
  });
});

test.describe('Visual regression baseline — Management', () => {
  test('management page renders without crash', async ({ page }) => {
    await page.goto('/management');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#app')).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-management.png`, fullPage: true });
  });
});
