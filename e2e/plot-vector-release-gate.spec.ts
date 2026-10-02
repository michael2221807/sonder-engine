/**
 * The P5 release gate on production builds (ZERO real API). Run against `vite preview` of a build, never the dev
 * server (which always has plot momentum):
 *   AGA_VECTOR_RELEASE_GATE=off — a build made with VITE_PLOT_VECTOR_RELEASE=off;
 *   AGA_VECTOR_RELEASE_GATE=on  — a default build.
 * Example: VITE_PLOT_VECTOR_RELEASE=off npx vite build --outDir dist/gate-off && npx vite preview --outDir dist/gate-off --port 4181
 *          then AGA_E2E_PORT=4181 AGA_VECTOR_RELEASE_GATE=off npx playwright test plot-vector-release-gate --project=desktop-1920
 * Unset, both tests are skipped; any other value is an error, so a mistyped run cannot pass by skipping everything.
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';

// Empty counts as unset (a CI expression may expand to nothing).
const GATE = process.env.AGA_VECTOR_RELEASE_GATE || undefined;
if (GATE !== undefined && GATE !== 'on' && GATE !== 'off') throw new Error(`AGA_VECTOR_RELEASE_GATE must be "on" or "off", not "${GATE}"`);

/** The page under test is a production build: with nothing on the port, Playwright would start the dev server. */
async function expectProductionBuild(page: Page) {
  await expect(page.locator('script[src*="@vite/client"]'), 'a vite preview of a build, not the dev server').toHaveCount(0);
}

test('a build with the release gate off refuses a previously enabled local preference', { tag: ['@plot-vector', '@story-d144'] },
  async ({ page, gameShell, plotVector }) => {
    test.skip(GATE !== 'off', 'Run against a preview built with VITE_PLOT_VECTOR_RELEASE=off only');
    // The key is the one the app writes: the default-build test below reads it back after turning the feature on.
    await page.addInitScript(() => localStorage.setItem('aga_plot_vector_control', '{"enabled":true,"epoch":"old-preview"}'));
    await seedSave(page); await expectProductionBuild(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await expect(plotVector.toggle).toBeDisabled();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    await expect(plotVector.control).toContainText('这个版本没有开放剧情动能');
  });

test('a default release build lets the player turn plot momentum on, off by default', { tag: ['@plot-vector'] },
  async ({ page, gameShell, plotVector }) => {
    test.skip(GATE !== 'on', 'Run against a preview of a default build only');
    await seedSave(page); await expectProductionBuild(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await expect(plotVector.toggle).toBeEnabled();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    await expect(plotVector.control).not.toContainText('这个版本没有开放剧情动能');
    await plotVector.toggleFeature();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aga_plot_vector_control') ?? 'null')?.enabled)).toBe(true);
  });
