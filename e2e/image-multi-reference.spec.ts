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
import { deflateSync as zlibDeflateSync, crc32 as zlibCrc32 } from 'node:zlib';

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

/**
 * 运行时造一张「偏大」参考图（>600KB 阈值）——不落二进制 fixture 进仓库。
 * 噪声像素 + zlib level 0，保证压不下去，稳定越过 isReferenceOversized 阈值。
 */
function makeOversizedPng(w = 900, h = 700): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlibCrc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;  // 8-bit RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let i = 1; i < row.length; i++) row[i] = (y * 31 + i * 17 + ((i * y) % 251)) & 0xff;
    rows.push(row);
  }
  const idat = zlibDeflateSync(Buffer.concat(rows), { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

  test('参考图偏大时：出现体积提示 + 「压缩」按钮，点击后角标消失（多图超时修复）',
    { tag: ['@regression', '@image', '@multi-ref'] },
    async ({ page }) => {
      await seedSave(page, { tree: treeWithBackend('volcengine'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByTestId('ref-redraw-toggle').click();

      // GIVEN 一张偏大的参考图（真实根因：大图让上游按总像素审核，多图累加后超时）
      await page.getByTestId('npc-multi-ref-file').setInputFiles({
        name: 'big.png', mimeType: 'image/png', buffer: makeOversizedPng(),
      });

      // THEN 代价被显性化：单图「大」角标 + 汇总提示条 + 压缩按钮
      await expect(page.getByTestId('npc-multi-ref-oversized-0')).toBeVisible();
      const bar = page.getByTestId('npc-multi-ref-oversize-bar');
      await expect(bar).toBeVisible();
      const compress = page.getByTestId('npc-multi-ref-compress');
      await expect(compress).toBeVisible();

      // WHEN 用户主动选择压缩（PO 决策：绝不静默改图）
      await compress.click();

      // THEN 角标与提示条消失 = 已降到阈值内；图仍在列表里（不是被删掉）
      await expect(page.getByTestId('npc-multi-ref-oversized-0')).toHaveCount(0);
      await expect(bar).toHaveCount(0);
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('1 / 14');
    });

  test('压缩进行中删掉另一张：用户的改动不被压缩结果回滚（并发编辑竞态）',
    { tag: ['@regression', '@image', '@multi-ref'] },
    async ({ page }) => {
      await seedSave(page, { tree: treeWithBackend('volcengine'), sessionType: 'play' });
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByTestId('ref-redraw-toggle').click();

      // GIVEN 两张偏大的图（都会进入压缩队列）
      await page.getByTestId('npc-multi-ref-file').setInputFiles([
        { name: 'a.png', mimeType: 'image/png', buffer: makeOversizedPng() },
        { name: 'b.png', mimeType: 'image/png', buffer: makeOversizedPng(880, 680) },
      ]);
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('2 / 14');

      // WHEN 点压缩后立刻删掉第 2 张（压缩仍在异步进行）
      await page.getByTestId('npc-multi-ref-compress').click();
      await page.getByTestId('npc-multi-ref-remove-1').click();

      // THEN 删除不会被压缩收工时的旧快照复活
      await expect(page.getByTestId('npc-multi-ref-count')).toContainText('1 / 14');
      await expect(page.getByTestId('npc-multi-ref-item-1')).toHaveCount(0);
      // 且剩下那张确实被压过（角标消失）
      await expect(page.getByTestId('npc-multi-ref-oversized-0')).toHaveCount(0);
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
