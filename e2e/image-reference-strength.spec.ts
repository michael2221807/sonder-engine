/**
 * 参考重绘 · 「重绘幅度」能力门（referenceStrength）
 *
 * Why this lives in the browser suite (iron law 2 self-check): the fix is a
 * `v-if` binding a template block to a catalog-derived capability. The project
 * has no component-test layer (@vue/test-utils is not installed), so a wrong /
 * missing binding is catchable ONLY in a real browser. The capability DATA
 * itself is pinned in vitest (`descriptor.test.ts`), so this spec stays thin:
 * one surface, both branches.
 *
 * Fully offline: the panel reads the backend straight off the state tree
 * (系统.扩展.image.config.defaultBackend), so no API config is involved and the
 * apiGuard's zero-egress contract holds with the standard seed.
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import { goToGameTab } from './fixtures/navigation';

// Same guard as every sibling spec that navigates via `goToGameTab`: the
// sidebar link is off-screen in the mobile layouts (navigation.ts:22), so
// those projects can't drive it. Desktop-only, like game-card-epic.spec.ts:33.
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar-driven spec runs on desktop-1920 only');
});

/** Seed an image-enabled save pinned to one backend. */
function treeWithBackend(backend: 'novelai' | 'volcengine') {
  return makeSeedTree({
    系统: { 扩展: { image: { enabled: true, config: { defaultBackend: backend } } } },
  });
}

test.describe('参考重绘 · 重绘幅度能力门 (offline: full)', () => {
  test('后端有强度参数时（NovelAI）显示重绘幅度滑块',
    { tag: ['@regression', '@image', '@volcano-epic'] },
    async ({ page }) => {
      // GIVEN 一个开启图像生成、后端为 NovelAI 的存档
      await seedSave(page, { tree: treeWithBackend('novelai'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');

      // WHEN 打开参考重绘
      await page.getByTestId('ref-redraw-toggle').click();

      // THEN 滑块可见，且不显示"不支持"提示
      await expect(page.getByTestId('ref-denoise-slider')).toBeVisible();
      await expect(page.getByTestId('ref-strength-unsupported')).toHaveCount(0);
    });

  test('后端无强度参数时（火山方舟 Seedream）隐藏滑块并提示改用额外要求',
    { tag: ['@regression', '@image', '@volcano-epic'] },
    async ({ page }) => {
      // GIVEN 同一个存档，但后端切到火山方舟 Seedream
      await seedSave(page, { tree: treeWithBackend('volcengine'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');

      // WHEN 打开参考重绘（该后端支持图生图，所以整块仍然可见）
      await page.getByTestId('ref-redraw-toggle').click();

      // THEN 没有死控件：滑块不渲染，取而代之的是指向「额外要求」的提示
      await expect(page.getByTestId('ref-denoise-slider')).toHaveCount(0);
      const hint = page.getByTestId('ref-strength-unsupported');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('额外要求');
    });
});
