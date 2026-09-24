import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

test('release build refuses a previously enabled local preference', { tag: ['@plot-vector', '@story-d144'] },
  async ({ page, gameShell, plotVector }) => {
    test.skip(process.env.AGA_VECTOR_RELEASE_GATE !== '1', 'Run against the built preview only');
    await page.addInitScript(() => localStorage.setItem('aga_plot_vector_control', '{"enabled":true,"epoch":"old-preview"}'));
    await seedSave(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await expect(plotVector.toggle).toBeDisabled();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    await expect(plotVector.control).toContainText('当前仅在本地预览开放');
  });
