import { test, expect } from './fixtures/base';
import { collectPageErrors } from './fixtures/page-errors';

/**
 * Environment smoke test — verifies the e2e toolchain itself:
 * Vite dev server boots, Vue mounts, no uncaught boot errors.
 * Keep the assertions app-agnostic so it never breaks on UI redesigns — it is the
 * "environment broken vs app broken" isolator, and the @smoke tag wires it into CI.
 *
 * It imports from `./fixtures/base` so the apiGuard auto-fixture runs here too: the
 * CI @smoke gate is then genuinely protected against real-API egress (it does NOT
 * disableApi — it boots the real app; the guard aborts + fails on any egress, so a
 * future mount-time API call surfaces as a CI failure instead of a silent token bill).
 */
test('app boots: Vue mounts and renders without page errors', { tag: '@smoke' }, async ({ page }, testInfo) => {
  const pageErrors = collectPageErrors(page);

  await page.goto('/');

  await expect(page.locator('#app > *').first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(/Sonder/);

  // Let deferred chunks/async components settle so late boot errors are caught.
  await page.waitForLoadState('networkidle');
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: `e2e/screenshots/${testInfo.project.name}-smoke-home.png`,
  });
  // apiGuard auto-fixture asserts zero real-API egress in teardown.
});
