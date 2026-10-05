/**
 * An interactive hint shows for keyboard focus on its control, not for focus a click left there (ZERO real API).
 *
 * P14 (PO 2026-10-04, 2B): the fixed hints (status bar, d45f91f) already showed on keyboard focus only; the other
 * interactive hints revealed on any focus inside them (`:focus-within`), so a click, or a dialog closing and giving
 * focus back to its button, brought a hint up 0.8 s later and kept it until the focus moved. They now follow the
 * same rule (`:has(:focus-visible)`).
 *
 * Run: npx playwright test tooltip-focus
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';

test('a click leaves no hint behind; keyboard focus on the same control shows it',
  { tag: ['@regression', '@ui'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'hover and keyboard focus are desktop behaviours');
    await seedSave(page);
    await enterSeededGame(page);
    await goToGameTab(page, 'prompts');
    await page.getByRole('button', { name: '内置提示词', exact: true }).click();
    await page.getByRole('button', { name: '展开', exact: true }).click();

    // An ordinary prompt's switch, wrapped in an interactive (in-flow) hint.
    const toggle = page.getByTestId('prompt-toggle-jailbreak');
    const bubble = page.locator('.tt-wrap--interactive').filter({ has: toggle }).locator('.tt-bubble');
    await toggle.click();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1500);              // past the 0.8 s reveal delay
    await expect(toggle).toBeFocused();           // the click left focus on it…
    await expect(bubble).toBeHidden();            // …and that brings no hint

    // The same control reached with the keyboard shows its hint.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await expect(bubble).toBeVisible({ timeout: 3000 });

    // Put the prompt back as it was.
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
