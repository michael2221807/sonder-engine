/**
 * Mobile adaptation feature tests — incremental coverage for Phase 1-4.
 *
 * These verify functional behavior, not just "no crash". /game-route tests SEED a
 * save (via the shared fixtures) so the game actually mounts — otherwise GameView
 * redirects /game→/ and the assertions would never run (vacuous false-greens).
 * Routed through ./fixtures/base so the apiGuard + offline contract apply here too.
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { disableApi } from './fixtures/disable-api';

// Non-/game tests still go offline by construction.
test.beforeEach(async ({ page }) => {
  await disableApi(page);
});

/** Seed a save and enter the rendered game (works on mobile + desktop viewports). */
async function enterGame(page: import('@playwright/test').Page): Promise<void> {
  await seedSave(page);
  await enterSeededGame(page);
  await expect(page).toHaveURL(/\/game(\/|$)/);
}

// ─── Phase 1: App Shell ─────────────────────────────────────────

test.describe('Phase 1 — App shell mobile adaptation', () => {
  test('mobile: glow-wrap fills full viewport (no inset)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await page.goto('/');
    const glowWrap = page.locator('.app-glow-wrap');
    await expect(glowWrap).toBeVisible();
    const box = await glowWrap.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).toBeTruthy();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(box!.y).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2);
  });

  test('mobile: glow bloom is hidden', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await page.goto('/');
    await expect(page.locator('.app-glow-bloom')).toBeHidden();
  });

  test('desktop: glow-wrap retains 10px inset', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await page.goto('/');
    const glowWrap = page.locator('.app-glow-wrap');
    await expect(glowWrap).toBeVisible();
    const box = await glowWrap.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.y).toBeGreaterThanOrEqual(8);
  });
});

// ─── Phase 2: Layout & Navigation (seeded /game) ────────────────

test.describe('Phase 2 — Mobile layout & MobileNavBar', () => {
  test('mobile: MobileNavBar is visible on /game route', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await enterGame(page);
    await expect(page.locator('.mobile-nav')).toBeVisible();
  });

  test('desktop: MobileNavBar does NOT exist in DOM', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await enterGame(page);
    await expect(page.locator('.mobile-nav')).toHaveCount(0);
  });

  test('mobile: LeftSidebar is hidden by default (off-screen drawer)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await enterGame(page);
    const sidebar = page.locator('.sidebar').first();
    const box = await sidebar.boundingBox();
    expect(box).toBeTruthy();
    // Off-screen via translateX(-100%): the right edge is at or left of the viewport edge.
    expect(box!.x + box!.width).toBeLessThanOrEqual(1);
  });

  test('desktop: LeftSidebar is visible as floating droplet', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await enterGame(page);
    const sidebar = page.locator('.sidebar').first();
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(40);
  });

  test('mobile: RightSidebar is hidden by default', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await enterGame(page);
    const sidebar = page.locator('.right-sidebar').first();
    const box = await sidebar.boundingBox();
    expect(box).toBeTruthy();
    const viewport = page.viewportSize()!;
    // Off-screen to the right: left edge at or beyond the viewport's right edge.
    expect(box!.x).toBeGreaterThanOrEqual(viewport.width - 1);
  });

  test('mobile: MobileNavBar has 5 items', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await enterGame(page);
    await expect(page.locator('.mobile-nav__item')).toHaveCount(5);
  });

  test('mobile: MobileNavBar items meet 44px touch target', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await enterGame(page);
    const items = page.locator('.mobile-nav__item');
    const count = await items.count();
    expect(count).toBe(5);
    for (let i = 0; i < count; i++) {
      const box = await items.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });
});

// ─── Phase 3: Interaction ───────────────────────────────────────

test.describe('Phase 3 — Hover quarantine & touch feedback', () => {
  test('desktop: TopBar buttons hover without crashing', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await enterGame(page);
    const btn = page.locator('.topbar__btn').first();
    await expect(btn).toBeVisible();
    await btn.hover();   // hover quarantine: must not throw / crash the app
  });
});

// ─── Cross-phase: Desktop regression guard ──────────────────────

test.describe('Desktop regression guard', () => {
  test('desktop: sidebar reserve CSS vars are set (not 0px)', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await enterGame(page);
    const leftReserve = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--sidebar-left-reserve').trim(),
    );
    expect(leftReserve).not.toBe('0px');
    expect(leftReserve).not.toBe('');
  });
});

// ─── Phase 4 P0: Core panels ────────────────────────────────────

test.describe('Phase 4 P0 — Home/Creation/Management mobile views', () => {
  test('mobile: Home buttons stack vertically', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await page.goto('/');
    const actions = page.locator('nav.actions[aria-label="主操作"]');
    await expect(actions).toBeVisible();
    const style = await actions.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(style).toBe('column');
  });

  test('mobile: Creation nav buttons meet 44px touch target', async ({ page, home, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await page.goto('/');
    // In-SPA nav (a direct goto('/creation') reloads and races the pack bootstrap → redirect).
    await home.newCharacter();
    await expect(page.locator('.progress-bar')).toBeVisible();
    // Creation nav migrated to AgaButton (root class .aga-btn) — the old
    // native `.btn` selector matched nothing and the count guard tripped.
    const navBtns = page.locator('.creation-nav .aga-btn');
    const count = await navBtns.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await navBtns.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('mobile: Management header wraps on narrow screen', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only test');
    await page.goto('/management');
    const header = page.locator('.mgmt-header');
    await expect(header).toBeVisible();
    const style = await header.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(style).toBe('wrap');
  });

  test('desktop: Home buttons remain horizontal', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only test');
    await page.goto('/');
    const actions = page.locator('nav.actions[aria-label="主操作"]');
    await expect(actions).toBeVisible();
    const style = await actions.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(style).toBe('row');
  });
});
