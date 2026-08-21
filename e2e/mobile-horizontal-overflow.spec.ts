/**
 * Mobile horizontal-overflow regression gate (2026-08-21 bug).
 *
 * iOS Safari can touch-pan an `overflow-x: hidden` axis whenever ANY descendant
 * creates horizontal scrollable overflow — hidden absolutely-positioned tooltip
 * bubbles were enough to let the whole game page wobble sideways during
 * vertical pull gestures. Fixes under test:
 *  - Tooltip.vue hides `.tt-bubble` entirely on touch devices (display:none)
 *  - `.game-layout__main` / `.messages-container` use `overflow-x: clip`
 *
 * This spec pins the invariant: in the seeded mobile game view, the main scroll
 * surfaces have ZERO horizontal scrollable overflow. (Deliberately scoped to the
 * chrome surfaces — narrative markdown tables scroll inside their own
 * `overflow-x:auto` wrappers and are allowed to.)
 */
import { test, expect } from './fixtures/base';
import { seedSave } from './fixtures/seed-save';
import { enterSeededGame } from './fixtures/navigation';

test('mobile game view has no horizontal scrollable overflow on chrome surfaces', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile-only invariant');
  await seedSave(page);
  await enterSeededGame(page);

  const report = await page.evaluate(() => {
    const measure = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? { sel, scrollW: el.scrollWidth, clientW: el.clientWidth } : { sel, scrollW: 0, clientW: 0 };
    };
    return {
      vw: document.documentElement.clientWidth,
      docScrollW: document.documentElement.scrollWidth,
      surfaces: [
        measure('.game-layout__main'),
        measure('.main-game-panel'),
        measure('.messages-container'),
        measure('.input-area'),
        measure('.status-bar'),
      ],
    };
  });

  expect(report.docScrollW).toBeLessThanOrEqual(report.vw);
  for (const s of report.surfaces) {
    expect(s.scrollW, `${s.sel} must not overflow horizontally`).toBeLessThanOrEqual(s.clientW + 1);
  }
});
