/**
 * 多图参考重绘 · 能力门 + 排序（multiReference）
 *
 * Why this lives in the browser suite (iron law 2 self-check): the deliverable
 * is (a) a `v-if` gating the multi-picker on a catalog-derived capability and
 * (b) a reorder interaction whose visible contract is the 「图N」badge following
 * the item. Both are template/DOM behavior with no component-test layer in this
 * repo (@vue/test-utils is not installed), so only a real browser can catch a
 * wrong binding. The capability DATA is pinned in vitest (`descriptor.test.ts`)
 * and the engine-side ordering in `volcengine.test.ts` — this spec stays thin.
 *
 * Fully offline: the panel reads the backend straight off the state tree, and
 * files are attached via setInputFiles (no network). apiGuard's zero-egress
 * contract holds with the standard seed.
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import { goToGameTab } from './fixtures/navigation';

// Sidebar-driven like every sibling spec (navigation.ts:22) → desktop only.
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar-driven spec runs on desktop-1920 only');
});

function treeWithBackend(backend: 'novelai' | 'civitai' | 'volcengine') {
  return makeSeedTree({
    系统: { 扩展: { image: { enabled: true, config: { defaultBackend: backend } } } },
  });
}

/** 1×1 px PNG — 只用于填充选择器，绝不会被发送（零 API 契约）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: TINY_PNG });

test.describe('多图参考重绘 · 能力门 (offline: full)', () => {
  test('豆包 Seedream：渲染多图选择器，单图控件让位',
    { tag: ['@regression', '@image', '@multi-ref'] },
    async ({ page }) => {
      await seedSave(page, { tree: treeWithBackend('volcengine'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByTestId('ref-redraw-toggle').click();

      await expect(page.getByTestId('npc-multi-ref')).toBeVisible();
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('0 / 14');
    });

  for (const backend of ['novelai', 'civitai'] as const) {
    test(`${backend}：只支持单图 → 不渲染多图选择器（无死控件）`,
      { tag: ['@regression', '@image', '@multi-ref'] },
      async ({ page }) => {
        await seedSave(page, { tree: treeWithBackend(backend), sessionType: 'play' });
        await enterSeededGame(page);
        await goToGameTab(page, 'image');
        await page.getByTestId('ref-redraw-toggle').click();

        // 多图选择器不存在；原来的单张上传控件仍在
        await expect(page.getByTestId('npc-multi-ref')).toHaveCount(0);
        await expect(page.getByText('参考图来源', { exact: false })).toBeVisible();
      });
  }
});

test.describe('多图参考重绘 · 顺序即语义 (offline: full)', () => {
  test('加入三张后编号为 图1/图2/图3，排序后编号跟随移动',
    { tag: ['@regression', '@image', '@multi-ref'] },
    async ({ page }) => {
      await seedSave(page, { tree: treeWithBackend('volcengine'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByTestId('ref-redraw-toggle').click();

      await page.getByTestId('npc-multi-ref-file').setInputFiles([file('a.png'), file('b.png'), file('c.png')]);

      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('3 / 14');
      await expect(page.getByTestId('npc-multi-ref-badge-0')).toHaveText('图1');
      await expect(page.getByTestId('npc-multi-ref-badge-2')).toHaveText('图3');

      // 第 1 张不能再往前；把第 3 张往前挪一位后仍是 3 张、编号连续
      await expect(page.getByTestId('npc-multi-ref-up-0')).toBeDisabled();
      await page.getByTestId('npc-multi-ref-up-2').click();
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('3 / 14');
      await expect(page.getByTestId('npc-multi-ref-badge-1')).toHaveText('图2');

      // 移除一张 → 计数与编号同步收缩（编号是位置而非固定 id）
      await page.getByTestId('npc-multi-ref-remove-0').click();
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('2 / 14');
      await expect(page.getByTestId('npc-multi-ref-badge-0')).toHaveText('图1');
      await expect(page.getByTestId('npc-multi-ref-item-2')).toHaveCount(0);
    });
});

test.describe('多图参考重绘 · 其余入口不漂移 (offline: full)', () => {
  // 第一轮 review 正是因为「四个入口各写各的」抓到 3 个独立缺陷，所以每个入口
  // 都要有自己的能力门断言，不能只测手动 NPC 那一处。
  for (const [backend, expected] of [['volcengine', 1], ['novelai', 0]] as const) {
    test(`场景入口：${backend} 的多图选择器${expected ? '渲染' : '不渲染'}`,
      { tag: ['@regression', '@image', '@multi-ref'] },
      async ({ page }) => {
        await seedSave(page, { tree: treeWithBackend(backend), sessionType: 'play' });
        await enterSeededGame(page);
        await goToGameTab(page, 'image');
        await page.getByRole('tab', { name: '场景壁纸', exact: true }).click();
        await page.getByTestId('scene-ref-redraw-toggle').click();
        await expect(page.getByTestId('scene-multi-ref')).toHaveCount(expected);
      });
  }

  test('切换 NPC 会清空已选参考图（不把上个角色的图带过去）',
    { tag: ['@regression', '@image', '@multi-ref'] },
    async ({ page }) => {
      await seedSave(page, {
        tree: makeSeedTree({
          系统: { 扩展: { image: { enabled: true, config: { defaultBackend: 'volcengine' } } } },
          社交: { 关系: [{ 名称: '甲', 性别: '女' }, { 名称: '乙', 性别: '女' }] },
        }),
        sessionType: 'play',
      });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByTestId('ref-redraw-toggle').click();
      await page.getByTestId('npc-multi-ref-file').setInputFiles([file('a.png'), file('b.png')]);
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('2 / 14');

      // 换到另一个 NPC —— 列表必须归零（review Minor 2026-08-29）
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: '乙' }).click();
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('0 / 14');
    });
});
