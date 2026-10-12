/**
 * The round status bar: its own chips in one row, the active threads' gauges in a drawer below (ZERO real API).
 *
 * PO 2026-10-10: on a phone the bar was broken — the right-hand controls (search, bookmarks, voice, festival) could
 * not shrink and lay over the left-hand chips (search over 天气, bookmarks over the environment), and the gauges were
 * squeezed to no width at all; on a 1280px screen half of five gauges were cut off. Now the first row keeps the
 * round's own chips, which scroll sideways when they do not fit, and the fixed controls; the gauges open in a drawer
 * that pushes the story down — closed by default, kept per device, with a dot on its toggle when a value changed
 * while it was closed.
 * PO 2026-10-12: with several active threads only the focus thread's gauges showed (the newest thread activated by hand
 * takes the focus, so it read as "only the newest"); every active thread's gauges show now, one group per thread.
 *
 * Run: npx playwright test status-gauge-drawer
 */
import type { Page } from '@playwright/test';
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { FIVE_GAUGES, changeLiveGauges, seedFocusGauges, seedThreads } from './fixtures/plot-gauge-seed';

const TOGGLE = '[data-testid="gauge-drawer-toggle"]';
const DRAWER = '[data-testid="plot-gauge-strip"]';
const CHIPS = '[data-testid="status-chips"]';
const DOT = `${TOGGLE} .gauge-toggle__dot`;

async function openGameWithGauges(page: Page): Promise<void> {
  const ids = await seedSave(page);
  await seedFocusGauges(page, ids);
  await page.reload();
  await enterSeededGame(page);
  await expect(page.locator(TOGGLE)).toBeVisible();
}

test('the gauges open in a drawer below the bar: closed at first, kept open per device, every gauge in full',
  { tag: ['@regression'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one desktop run for the drawer itself; phones below');
    test.slow();
    await openGameWithGauges(page);
    const toggle = page.locator(TOGGLE);
    const drawer = page.locator(DRAWER);

    // Closed by default: the first row has no gauge, the drawer takes no room, the toggle counts the gauges.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.locator('.gauge-toggle__count')).toHaveText(String(FIVE_GAUGES.length));
    await expect(drawer).toBeHidden();
    await expect(page.locator('.status-bar__row .gauge-strip__item')).toHaveCount(0);

    const storyTopClosed = (await page.locator('.messages-area').boundingBox())!.y;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toBeVisible();
    for (const g of FIVE_GAUGES) await expect(drawer.getByText(g.name, { exact: true })).toBeVisible();
    await expect(drawer.getByText('775万元', { exact: true })).toBeVisible();
    await expect(drawer.getByText('29点', { exact: true })).toBeVisible();
    await expect(drawer.getByText('82%', { exact: true })).toBeVisible();
    // The drawer pushes the story down rather than lying over it: once it has opened (its height settles), the story
    // starts below it, and lower than it did with the drawer closed.
    let lastHeight = -1;
    await expect.poll(async () => {
      const h = (await drawer.boundingBox())?.height ?? 0;
      const settled = h > 40 && Math.abs(h - lastHeight) < 0.5;
      lastHeight = h;
      return settled;
    }, { timeout: 10_000, intervals: [300] }).toBe(true);
    const drawerBox = await drawer.boundingBox();
    const storyBox = await page.locator('.messages-area').boundingBox();
    expect(storyBox!.y).toBeGreaterThanOrEqual(drawerBox!.y + drawerBox!.height - 1);
    expect(storyBox!.y).toBeGreaterThan(storyTopClosed + 30);

    // Kept per device: after a reload the drawer is still open.
    await page.reload();
    await enterSeededGame(page);
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(DRAWER)).toBeVisible();

    await page.locator(TOGGLE).click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(DRAWER)).toBeHidden();
  });

test('a value that changes while the drawer is closed lights a dot on the toggle until the drawer is opened',
  { tag: ['@regression'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'the dot is the same on every screen');
    test.slow();
    await openGameWithGauges(page);
    const toggle = page.locator(TOGGLE);
    await expect(page.locator(DOT)).toHaveCount(0);

    await changeLiveGauges(page, { setCurrent: { g5: 31 } });
    await expect(page.locator(DOT)).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-label', /有新变化/);

    await toggle.click();
    await expect(page.locator(DOT)).toHaveCount(0);
    await expect(page.locator(DRAWER).getByText('31点', { exact: true })).toBeVisible();
    // A change while it is open is seen as it happens: closing it lights nothing.
    await changeLiveGauges(page, { setCurrent: { g1: 60 } });
    await toggle.click();
    await expect(page.locator(DOT)).toHaveCount(0);

    // Another set of gauges (another thread or save) is not a change the reader missed.
    await changeLiveGauges(page, { renameIds: { g2: 'g2b' }, setCurrent: { g2: 99 } });
    await page.waitForTimeout(500);
    await expect(page.locator(DOT)).toHaveCount(0);
  });

test("every active thread's gauges show, one group per thread, the focus thread first; a finished thread's do not",
  { tag: ['@regression'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-360', 'one phone width is enough for the groups');
    test.slow();
    const ids = await seedSave(page);
    await seedThreads(page, ids, [
      { id: 'arc_old', title: '旧案', lane: 0, gauges: [{ id: 'o1', name: '旧案进度', current: 40, max: 100, unit: '%' }] },
      { id: 'arc_done', title: '已结的线', lane: 1, status: 'completed', gauges: [{ id: 'd1', name: '结案度量', current: 100, max: 100, unit: '%' }] },
      { id: 'arc_new', title: '新案', lane: 2, gauges: [
        { id: 'n1', name: '新案线索', current: 3, max: 10, unit: '条' },
        { id: 'n2', name: '新案压力', current: 55, max: 100, unit: '%' },
      ] },
    ], 'arc_new');
    await page.reload();
    await enterSeededGame(page);
    const toggle = page.locator(TOGGLE);
    await expect(toggle.locator('.gauge-toggle__count')).toHaveText('3');
    await toggle.click();
    const drawer = page.locator(DRAWER);
    await expect(drawer).toBeVisible();
    // Two groups: the focus thread (新案) first and marked, then the other active one; the finished thread has none.
    const heads = drawer.locator('.gauge-strip__thread');
    await expect(heads).toHaveCount(2);
    await expect(heads.nth(0)).toHaveAttribute('data-arc-id', 'arc_new');
    await expect(heads.nth(0).locator('.gauge-strip__thread-focus')).toBeVisible();
    await expect(heads.nth(1)).toHaveAttribute('data-arc-id', 'arc_old');
    await expect(heads.nth(1).locator('.gauge-strip__thread-focus')).toHaveCount(0);
    for (const name of ['新案线索', '新案压力', '旧案进度']) await expect(drawer.getByText(name, { exact: true })).toBeVisible();
    await expect(drawer.getByText('3条', { exact: true })).toBeVisible();
    await expect(drawer.getByText('结案度量')).toHaveCount(0);
    // A change on the thread that is not the focus lights the dot too.
    await toggle.click();
    await changeLiveGauges(page, { arcIndex: 0, setCurrent: { o1: 45 } });
    await expect(page.locator(DOT)).toHaveCount(1);
    // On a phone the groups fit on screen too.
    if (page.viewportSize()!.width < 768) {
      await toggle.click();
      await page.waitForTimeout(700);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      const cut = await drawer.locator('.gauge-strip__name, .gauge-strip__thread-title').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
      expect(cut).toEqual([]);
    }
  });

test('on a phone the chips scroll sideways, the controls stay put, nothing overflows and no gauge name is cut',
  { tag: ['@regression', '@mobile'] }, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the phone layout');
    test.slow();
    await openGameWithGauges(page);
    const vw = page.viewportSize()!.width;
    const chips = page.locator(CHIPS);

    const layout = await page.evaluate(({ CHIPS, TOGGLE }) => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const row = document.querySelector<HTMLElement>(CHIPS)!;
      return {
        docScrollW: document.documentElement.scrollWidth,
        chipsOverflow: getComputedStyle(row).overflowX,
        chipsScrollable: row.scrollWidth > row.clientWidth,
        chipsRight: box(CHIPS).right,
        controls: [TOGGLE, '.status-bar .search-toggle-btn:not(.bookmark-toggle-btn)', '[data-testid="bookmark-toggle"]'].map((sel) => {
          const r = box(sel);
          return { sel, left: r.left, right: r.right, width: r.width };
        }),
      };
    }, { CHIPS, TOGGLE });
    expect(layout.docScrollW).toBeLessThanOrEqual(vw);
    expect(layout.chipsOverflow).toBe('auto');
    expect(layout.chipsScrollable, 'more chips than fit: they scroll').toBe(true);
    for (const c of layout.controls) {
      expect(c.width, `${c.sel} has room`).toBeGreaterThan(20);
      expect(c.left, `${c.sel} right of the chips, not over them`).toBeGreaterThanOrEqual(layout.chipsRight - 1);
      expect(c.right, `${c.sel} on screen`).toBeLessThanOrEqual(vw);
    }
    // The round counter is not faded while nothing is scrolled; at the far end the start fades instead.
    await expect(chips).toHaveClass(/status-bar__left--more-after/);
    await expect(chips).not.toHaveClass(/status-bar__left--more-before/);
    await chips.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(chips).toHaveClass(/status-bar__left--more-before/);
    await expect(chips).not.toHaveClass(/status-bar__left--more-after/);
    await expect(page.locator('.status-bar .festival-chip')).toBeInViewport();

    await page.locator(TOGGLE).click();
    await expect(page.locator(DRAWER)).toBeVisible();
    await page.waitForTimeout(700); // the drawer's opening
    const names = await page.locator('.gauge-strip__name').evaluateAll((els) => els.map((el) => ({
      text: el.textContent, cut: el.scrollWidth > el.clientWidth, right: el.getBoundingClientRect().right,
    })));
    expect(names).toHaveLength(FIVE_GAUGES.length);
    for (const n of names) {
      expect(n.cut, `${n.text} shows in full`).toBe(false);
      expect(n.right, `${n.text} on screen`).toBeLessThanOrEqual(vw);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);
  });
