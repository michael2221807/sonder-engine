/**
 * Character creation — first-time wizard → enter game (ZERO real API).
 *
 * Walks the tianming 8-step creation wizard deterministically (no conditional logic):
 * select-one ×4 → skip optional talents → balance attributes → fill the name → turn OFF
 * enhanced opening (so finalize takes the low-load path) → start. With no API config the
 * opening generation degrades gracefully (try/caught → null) and the pipeline still routes
 * to /game. disableApi prevents any outbound attempt; the apiGuard asserts zero egress.
 *
 * Runs on desktop-1920 only.
 * Run: npx playwright test creation
 */
import { test, expect } from './fixtures/base';
import { disableApi } from './fixtures/disable-api';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'creation spec runs on desktop-1920 only');
});

test.describe('Character creation — first-time wizard → game (offline)', () => {
  test('filters worlds and shared choices from the NSFW setting captured before creation',
    { tag: ['@regression', '@creation', '@story-7'] },
    async ({ page, home, creation }) => {
      await disableApi(page);
      await page.addInitScript(() => {
        localStorage.setItem('aga_nsfw_settings', JSON.stringify({ nsfwMode: false, nsfwGenderFilter: 'female' }));
      });
      await page.goto('/');
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      await home.newCharacter();

      await expect(creation.presetCards).toHaveCount(4);
      await expect(creation.presetCards.filter({ hasText: '表里世界' })).toHaveCount(0);
      await creation.selectPreset('人间潮汐'); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await expect(creation.presetCards.filter({ hasText: '会所签约人' })).toHaveCount(0);
    });

  test('shows all worlds and modern adult choices for a general modern world when NSFW is enabled',
    { tag: ['@regression', '@creation', '@story-7'] },
    async ({ page, home, creation }) => {
      await disableApi(page);
      await page.addInitScript(() => {
        localStorage.setItem('aga_nsfw_settings', JSON.stringify({ nsfwMode: true, nsfwGenderFilter: 'female' }));
      });
      await page.goto('/');
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      await home.newCharacter();

      await expect(creation.presetCards).toHaveCount(8);
      await expect(creation.presetCards.filter({ hasText: '表里世界' })).toHaveCount(1);
      await creation.selectPreset('人间潮汐'); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await expect(creation.presetCards.filter({ hasText: '会所签约人' })).toHaveCount(1);
      await expect(creation.presetCards.filter({ hasText: '和亲贡礼' })).toHaveCount(0);
    });

  test('consumes one shared point budget across origin, trait, talents, and confirmation',
    { tag: ['@regression', '@creation', '@story-2'] },
    async ({ page, home, creation }) => {
      await disableApi(page);
      await page.goto('/');
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      await home.newCharacter();

      await creation.selectPreset('人间潮汐'); await creation.next();
      await creation.selectPreset('寻常'); await creation.next();

      await expect(creation.budgetSummary).toContainText('已用 0 / 20，剩余 20');
      await creation.addCustomChoice({
        stepLabel: '出身',
        name: '七点测试出身',
        description: '用于验证跨步骤共享预算会真实扣除七点，而不是每一步重新获得整份预算。',
        cost: 7,
        genre: 'modern',
      });
      await creation.selectPreset('七点测试出身');
      await expect(creation.budgetSummary).toContainText('已用 7 / 20，剩余 13');
      await creation.next();

      await expect(creation.budgetSummary).toContainText('已用 7 / 20，剩余 13');
      await creation.selectPreset('守序');
      await expect(creation.budgetSummary).toContainText('已用 12 / 20，剩余 8');
      await creation.next();

      await expect(creation.budgetSummary).toContainText('已用 12 / 20，剩余 8');
      await creation.addCustomChoice({
        stepLabel: '天赋',
        name: '九点超支天赋',
        description: '用于验证只剩八点时，九点候选会被禁用且不能绕过共享预算加入构筑。',
        cost: 9,
        genre: 'modern',
      });
      await expect(creation.presetCards.filter({ hasText: '九点超支天赋' })).toBeDisabled();
      await expect(creation.budgetSummary).toContainText('已用 12 / 20，剩余 8');
      await creation.next();
      await creation.balanceAttributes(); await creation.next();
      await creation.fillName('预算验证'); await creation.next();
      await expect(creation.budgetSummary).toContainText('已用 12 / 20，剩余 8');
    });

  test('enters the enhanced-opening browser path and exposes its offline failure recovery',
    { tag: ['@regression', '@creation', '@story-7'] },
    async ({ page, home, creation }) => {
      await disableApi(page);
      await page.goto('/');
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      await home.newCharacter();

      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await creation.next();
      await creation.balanceAttributes(); await creation.next();
      await creation.fillName('增强开场验证'); await creation.next();
      await creation.start();

      await expect(creation.enhancedOpeningFailureTitle).toBeVisible({ timeout: 15_000 });
      await creation.exitEnhancedOpening();
      await expect(creation.startButton).toBeEnabled({ timeout: 15_000 });
    });

  test('walk the tianming 8-step wizard and start the game (opening degrades, zero API)',
    { tag: ['@regression', '@creation', '@story-0'] },
    async ({ page, home, creation }) => {
      await disableApi(page);
      await page.goto('/');
      // Kill animations so the wizard's <Transition mode="out-in"> step-slide is instant —
      // otherwise a select click can land on a leaving step's card mid-transition.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      // Enter creation by in-SPA nav (a direct goto('/creation') reloads and races the
      // async pack bootstrap → the router guard would redirect to home).
      await home.newCharacter();
      await expect(creation.progressBar).toBeVisible({ timeout: 15_000 });

      // Steps 0-3 — select-one (world / talentTier / origin / trait): pick the first option.
      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();
      await creation.selectFirstPreset(); await creation.next();

      // Step 4 — talents (select-many, optional): skip.
      await creation.next();

      // Step 5 — attributes: distribute evenly (one click fills the budget), then next.
      await creation.balanceAttributes(); await creation.next();

      // Step 6 — identity form: the name is the only required field.
      await creation.fillName('天命'); await creation.next();

      // Step 7 — confirm: turn OFF enhanced opening (low-load degraded path offline) → start.
      await creation.toggleEnhancedOpening();
      await creation.start();

      // The character-init pipeline degrades gracefully with no API and routes to /game.
      await page.waitForURL(/\/game(\/|$)/, { timeout: 30_000 });
      await expect(page.getByTestId('mode-toggle')).toBeVisible({ timeout: 15_000 });
      // apiGuard auto-fixture asserts zero egress in teardown.
    });
});
