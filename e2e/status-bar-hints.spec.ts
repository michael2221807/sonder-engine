/**
 * Every hint in the round's status bar shows below its chip, in full and on screen (ZERO real API).
 *
 * PO 2026-10-04: the plot-momentum chip's hint (「平稳 · 人际易通」) flew up and was hidden. The status bar sits right
 * under the top bar, inside the game area that clips what leaves it: an in-flow bubble above a chip went under the
 * top bar. The same held for the environment chips, the festival chip, search and bookmarks. The bar's hints became
 * `fixed` (CLAUDE.md §8.1); then a long hint above a chip still left the top of the screen, so they show below now,
 * placed from the bubble's real size. The long case here is a plot gauge's description, which the model writes.
 * Review the same day: the story scrolling (as it does while text streams in) must not close them, a control's hint
 * must not lie over the panel that control opened, and the focus a closing dialog hands back must not bring one.
 *
 * Run: npx playwright test status-bar-hints
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { DISABLED_API_MANAGEMENT } from './fixtures/disable-api';
import { addBoardFixture } from './fixtures/plot-vector-seed';
import type { Locator, Page } from '@playwright/test';
import type { GameShellPage } from './pages/game-shell.page';
import type { PlotVectorPage } from './pages/plot-vector.page';
import type { SeedIds } from './fixtures/seed-save';

/** Five lines in a 240px bubble: the kind of hint that used to leave the screen. */
const LONG_GAUGE_DESCRIPTION = '旧城区的流言一天比一天多：茶馆、码头和学堂都有人在传，主角若不尽快澄清，名声会继续下滑，盟友也会开始疑心；降到零时，城里的人会彻底站到对立面去，再难回头。';

const IMPULSE = '[data-testid="vector-impulse"]';
const ENV = '.status-bar .env-chips';
const GAUGE = '.status-bar [data-testid="plot-gauge-strip"] .gauge-strip__item';
const SEARCH = '.status-bar .search-toggle-btn:not(.bookmark-toggle-btn)';
const BOOKMARK = '[data-testid="bookmark-toggle"]';
const VOICE = '[data-testid="voice-quick-chip"]';
const FESTIVAL = '.status-bar .festival-chip';

/** A festival, and a focus thread with a gauge shown in the main panel. */
async function seedFestivalAndGauge(page: Page, ids: SeedIds) {
  await page.evaluate(async ({ profileId, slotId, gaugeDescription }) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
    const { StateManager } = await load('/src/engine/core/state-manager.ts');
    const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
    const key = `save_${profileId}_${slotId}`, state = new StateManager();
    state.loadTree(await idbAdapter.get(key));
    state.set(P.festival, { 名称: '元宵', 描述: '花灯满街', 效果: '人多热闹' });
    state.set(P.plotDirection, {
      activeArcIndex: 0, focusArcId: 'arc_rumor', pendingConfirmations: [],
      arcs: [{
        id: 'arc_rumor', title: '流言', synopsis: '', status: 'active', lane: 0,
        gauges: [{
          id: 'g_rumor', name: '名声', description: gaugeDescription, min: 0, max: 100, current: 40, initialValue: 60,
          unit: '%', showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25,
        }],
        nodes: [{
          id: 'n1', arcId: 'arc_rumor', title: '澄清', narrativeGoal: '澄清流言', directive: '澄清', completionHint: '澄清',
          completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable',
          opportunityTiers: [], status: 'active', consecutiveReachedCount: 0, activatedAtRound: 1,
        }],
      }],
    });
    await idbAdapter.set(key, state.toSnapshot());
  }, { ...ids, gaugeDescription: LONG_GAUGE_DESCRIPTION });
}

/**
 * Voice is set up, so the voice chip shows. Its API points at a closed loopback port: nothing here plays a voice,
 * and if anything tried it would fail at once. Registered after `seedSave`'s own init script, so it runs after it.
 */
async function enableVoiceChip(page: Page) {
  await page.addInitScript((api) => {
    localStorage.setItem('aga_api_management', JSON.stringify(api));
    localStorage.setItem('aga_tts_settings', JSON.stringify({ enabled: true, backend: 'cosyvoice' }));
  }, {
    ...DISABLED_API_MANAGEMENT,
    apiConfigs: [...DISABLED_API_MANAGEMENT.apiConfigs, {
      id: 'e2e-tts', name: 'tts', apiCategory: 'tts', backend: 'cosyvoice', provider: 'openai',
      url: 'http://127.0.0.1:1', apiKey: '', model: '', temperature: 0, maxTokens: 1, enabled: true,
    }],
  });
}

/** The story with an accepted round, an environment, a festival, a gauge and voice: every chip of the bar shows. */
async function openFullStatusBar(page: Page, gameShell: GameShellPage, plotVector: PlotVectorPage) {
  const ids = await seedSave(page);
  await addBoardFixture(page, ids, true);
  await seedFestivalAndGauge(page, ids);
  await enableVoiceChip(page);
  await page.reload();
  await enterSeededGame(page);
  await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
  for (const selector of [IMPULSE, ENV, GAUGE, SEARCH, BOOKMARK, VOICE, FESTIVAL]) await expect(page.locator(selector).first()).toBeVisible();
}

/** A toast shows in the same top-right corner and is meant to sit over everything: each step waits one out first. */
async function noToast(page: Page) {
  await expect.poll(() => page.locator('.toast__message').count(), { timeout: 20_000 }).toBe(0);
}

/** The hint bubble of a trigger (teleported to <body>, found through `aria-describedby`). */
function bubbleOf(trigger: Locator): Promise<{ hot: boolean; opacity: string }> {
  return trigger.evaluate((node) => {
    const id = node.closest('.tt-wrap')?.getAttribute('aria-describedby');
    const bubble = id ? document.getElementById(id) : null;
    return { hot: !!bubble?.classList.contains('tt-bubble--hot'), opacity: bubble ? getComputedStyle(bubble).opacity : 'none' };
  });
}

/** Waits until the trigger's hint has faded in (800 ms delay + 140 ms fade); a hint that never shows is reported by the caller. */
async function waitForHint(trigger: Locator) {
  await expect.poll(async () => (await bubbleOf(trigger)).opacity, { timeout: 5_000 }).toBe('1').catch(() => undefined);
}

interface HintLook {
  /** Visible, and the topmost element at its centre and inner corners is the bubble. */
  shown: boolean;
  coveredBy: string | null;
  /** The bubble starts at or below the chip's bottom edge. */
  below: boolean;
  /** The whole bubble is inside the viewport. */
  onScreen: boolean;
  height: number;
}

/** How the hint of `selector` shows after a deliberate hover. */
async function lookAtHint(page: Page, selector: string): Promise<HintLook> {
  const trigger = page.locator(selector).first();
  await noToast(page);
  await trigger.hover();
  await waitForHint(trigger);
  const look = await trigger.evaluate((node): HintLook => {
    const wrap = node.closest('.tt-wrap');
    const id = wrap?.getAttribute('aria-describedby');
    const bubble = id ? document.getElementById(id) : null;
    if (!wrap || !bubble) return { shown: false, coveredBy: 'no bubble', below: false, onScreen: false, height: 0 };
    const r = bubble.getBoundingClientRect();
    const t = wrap.getBoundingClientRect();
    // A hint takes no pointer events; for this one look, let it, so the hit test finds it unless it is covered.
    const before = bubble.style.pointerEvents;
    bubble.style.pointerEvents = 'auto';
    const points: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3],
    ];
    const over = points.map(([x, y]) => document.elementFromPoint(x, y)).find((top) => !top || (top !== bubble && !bubble.contains(top)));
    bubble.style.pointerEvents = before;
    const shown = getComputedStyle(bubble).opacity === '1' && over === undefined;
    return {
      shown,
      coveredBy: shown ? null : over ? `${over.tagName.toLowerCase()}.${[...over.classList].join('.')}` : 'hidden or off screen',
      below: r.top >= t.bottom - 0.5,
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      height: Math.round(r.height),
    };
  });
  await page.mouse.move(960, 700);
  await expect.poll(async () => (await bubbleOf(trigger)).hot).toBe(false);
  return look;
}

test.describe('status-bar hints', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'hints show on hover; touch screens have none');
    test.slow();
  });

  test('every hint shows below its chip, in full and on screen', { tag: ['@regression'] }, async ({ page, gameShell, plotVector }) => {
    await openFullStatusBar(page, gameShell, plotVector);
    for (const selector of [GAUGE, IMPULSE, ENV, SEARCH, BOOKMARK, VOICE, FESTIVAL]) {
      const look = await lookAtHint(page, selector);
      expect.soft({ shown: look.shown, coveredBy: look.coveredBy, below: look.below, onScreen: look.onScreen }, selector)
        .toEqual({ shown: true, coveredBy: null, below: true, onScreen: true });
      // The gauge's hint really is the long case: five lines of 12px text, not one.
      if (selector === GAUGE) expect.soft(look.height, 'long gauge hint height').toBeGreaterThan(80);
    }
  });

  test('the story scrolling leaves a showing hint be; a scroll that can move the chip closes it', { tag: ['@regression'] }, async ({ page, gameShell, plotVector }) => {
    await openFullStatusBar(page, gameShell, plotVector);
    const chip = page.locator(IMPULSE);
    const showHint = async () => {
      await page.mouse.move(960, 700);
      await noToast(page);
      await chip.hover();
      await waitForHint(chip);
      expect(await bubbleOf(chip), 'the hint shows').toEqual({ hot: true, opacity: '1' });
    };
    await showHint();
    // While text streams in, the story scrolls to its end again and again.
    await page.locator('.messages-container').dispatchEvent('scroll');
    await page.waitForTimeout(200);
    expect(await bubbleOf(chip), 'after the story scrolled').toEqual({ hot: true, opacity: '1' });
    // The game panel around the bar clips its overflow and can be scrolled (scrollIntoView does): it can move the chip.
    await page.locator('.main-game-panel').dispatchEvent('scroll');
    await expect.poll(async () => (await bubbleOf(chip)).hot, { message: 'after the panel around the bar scrolled' }).toBe(false);
    // A scroll the window reports itself (no element to tell from) closes it too.
    await showHint();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect.poll(async () => (await bubbleOf(chip)).hot, { message: 'after the window scrolled' }).toBe(false);
  });

  test('a control\'s hint stays off while its panel is open; a closing dialog\'s focus brings no hint, keyboard focus does', { tag: ['@regression'] }, async ({ page, gameShell, plotVector }) => {
    await openFullStatusBar(page, gameShell, plotVector);
    const closeModal = () => page.locator('.modal-backdrop .modal-close').click();
    for (const [selector, panel, close, dialog] of [
      [SEARCH, page.locator('.search-panel'), () => page.locator(SEARCH).click(), false],
      [BOOKMARK, page.getByTestId('bookmark-panel'), () => page.locator(BOOKMARK).click(), false],
      [VOICE, page.locator('.voice-popover'), () => page.locator(VOICE).click(), false],
      [ENV, page.locator('.modal-backdrop'), closeModal, true],
      [FESTIVAL, page.locator('.modal-backdrop'), closeModal, true],
    ] as const) {
      const trigger = page.locator(selector).first();
      await noToast(page);
      await trigger.click(); // the pointer stays on the control, which keeps the focus
      await expect(panel, selector).toBeVisible();
      // Search, bookmarks and voice open a panel beside their control, so their hint needs its own guard. A dialog
      // covers its chip and takes the focus, and the browser then closes the hint by itself (pointerleave, focusout).
      await page.waitForTimeout(1200); // longer than the hint's 800 ms delay and its fade: it would show by now
      expect.soft(await bubbleOf(trigger), `${selector} with its panel open`).toEqual({ hot: false, opacity: '0' });
      await close();
      await expect(panel).toBeHidden();
      await page.mouse.move(960, 700);
      if (dialog) {
        // The dialog hands the focus back to its chip; with the pointer elsewhere, no hint should come with it.
        await page.waitForTimeout(1200);
        expect.soft(await bubbleOf(trigger), `${selector} after its dialog closed`).toEqual({ hot: false, opacity: '0' });
      }
    }
    // Keyboard focus still shows a hint: Tab from search lands on bookmarks.
    await page.locator(SEARCH).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(BOOKMARK)).toBeFocused();
    await waitForHint(page.locator(BOOKMARK));
    expect(await bubbleOf(page.locator(BOOKMARK)), 'bookmarks reached by Tab').toEqual({ hot: true, opacity: '1' });
    // A dialog opened and closed from the keyboard hands the focus back as keyboard focus: the hint shows.
    await page.keyboard.press('Tab'); // voice
    await page.keyboard.press('Tab'); // festival
    await expect(page.locator(FESTIVAL)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal-backdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-backdrop')).toBeHidden();
    await expect(page.locator(FESTIVAL)).toBeFocused();
    await waitForHint(page.locator(FESTIVAL));
    expect(await bubbleOf(page.locator(FESTIVAL)), 'festival after its dialog closed by Escape').toEqual({ hot: true, opacity: '1' });
  });
});
