/**
 * 输入栏「名字速插」+ 工具抽屉 — critical-journey e2e (zero real API).
 *
 * Pins the four things that broke or could break in this surface:
 *  1. the teleported panel is NOT clipped by `.main-game-panel { overflow: hidden }`
 *     (the bug that made the old「+词」popover lose its top half);
 *  2. clicking a name splices it in at the caret and chains on a second click;
 *  3. the sort chips behave like RelationshipPanel's (second click flips ↑/↓, and the
 *     choice survives a reload);
 *  4. the collapsed tool drawer takes its keys out of the tab order (`inert`) and adds
 *     no horizontal overflow on a phone.
 */
import { test, expect } from './fixtures/base';
import { seedSave } from './fixtures/seed-save';
import { enterSeededGame } from './fixtures/navigation';
import { makeSeedTree } from './fixtures/seed-tree';

const HERE = '青云城';
const NEAR = '城南坊市';
const FAR = '寒潭';

/** Three NPCs (mixed presence/affinity) + three locations so sorting is observable. */
const richTree = makeSeedTree({
  角色: { 基础信息: { 当前位置: HERE } },
  社交: {
    关系: [
      { 名称: '林婉儿', 类型: '友人', 好感度: 40, 位置: HERE, 是否在场: true, 性别: '女', 记忆: [], 私聊历史: [] },
      { 名称: '赵无极', 类型: '对手', 好感度: 90, 位置: NEAR, 是否在场: false, 性别: '男', 记忆: [], 私聊历史: [] },
      { 名称: '阿福', 类型: '仆从', 好感度: 10, 位置: HERE, 是否在场: true, 性别: '男', 记忆: [], 私聊历史: [] },
    ],
  },
  世界: {
    地点信息: [
      { 名称: HERE, 描述: '繁华的修真城市。', 连接: [NEAR], NPC: ['林婉儿'], 类型: '城市', 上级: '' },
      { 名称: NEAR, 描述: '城南的坊市。', 连接: [HERE], NPC: [], 类型: '坊市', 上级: '' },
      { 名称: FAR, 描述: '城外的寒潭。', 连接: [], NPC: [], 类型: '野外', 上级: '' },
    ],
  },
  系统: { 探索记录: [HERE, NEAR] },
});

const composer = 'textarea.message-input';
const nameKey = 'button.name-ins__btn';
const toolsKey = 'button.tools-btn';
const panel = '.np';

async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  // The drawer defaults to open on a fresh device; expand it if a previous test in
  // this context collapsed it.
  if ((await page.locator(toolsKey).getAttribute('aria-expanded')) === 'false') {
    await page.locator(toolsKey).click();
  }
  await page.locator(nameKey).click();
  await expect(page.locator(panel)).toBeVisible();
}

test.describe('composer name inserter', () => {
  test.beforeEach(async ({ page }) => {
    await seedSave(page, { tree: richTree });
    await enterSeededGame(page);
  });

  test('panel opens above the composer, fully inside the viewport (not clipped)', async ({ page }) => {
    await openPanel(page);

    const box = await page.locator(panel).boundingBox();
    const vp = page.viewportSize();
    expect(box).not.toBeNull();
    expect(vp).not.toBeNull();
    if (!box || !vp) return;

    // Every edge inside the viewport — the old in-flow popover failed the top edge.
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);

    // Teleported to <body>, so no ancestor's overflow can crop it.
    const parentIsBody = await page.evaluate(() => document.querySelector('.np')?.parentElement === document.body);
    expect(parentIsBody).toBe(true);

    // Tabs, search and sorts are all actually rendered (the clipped popover showed none).
    await expect(page.locator('.np__tab')).toHaveCount(2);
    await expect(page.locator('.np__search input')).toBeVisible();
    await expect(page.locator('.np .sort-chip').first()).toBeVisible();
  });

  test('clicking names inserts at the caret and chains', async ({ page }) => {
    await page.locator(composer).fill('我看向');
    await openPanel(page);

    await page.locator('.name-chip__main', { hasText: '林婉儿' }).click();
    await expect(page.locator(composer)).toHaveValue('我看向林婉儿');

    // Panel stays open → a second name appends right after the caret.
    await expect(page.locator(panel)).toBeVisible();
    await page.locator('.name-chip__main', { hasText: '阿福' }).click();
    await expect(page.locator(composer)).toHaveValue('我看向林婉儿阿福');
  });

  test('locations tab lists places and marks the current one', async ({ page }) => {
    await openPanel(page);
    await page.locator('.np__tab', { hasText: '地点' }).click();

    await expect(page.locator('.name-chip')).toHaveCount(3);
    await expect(page.locator('.name-chip--here .name-chip__name')).toHaveText(HERE);

    await page.locator('.name-chip__main', { hasText: FAR }).click();
    await expect(page.locator(composer)).toHaveValue(FAR);
  });

  test('search filters, and an empty result explains itself', async ({ page }) => {
    await openPanel(page);
    await page.locator('.np__search input').fill('赵');
    await expect(page.locator('.name-chip')).toHaveCount(1);

    await page.locator('.np__search input').fill('不存在的名字');
    await expect(page.locator('.name-chip')).toHaveCount(0);
    await expect(page.locator('.np__empty')).toBeVisible();
  });

  test('sort chips: pick a mode, click again to flip, choice survives reload', async ({ page }) => {
    await openPanel(page);

    const affinity = page.locator('.np .sort-chip', { hasText: '好感' });
    await affinity.click();
    await expect(affinity).toHaveClass(/sort-chip--active/);
    await expect(affinity.locator('.sort-arrow')).toHaveText('↑');
    // 好感 asc = high → low.
    await expect(page.locator('.name-chip__name').first()).toHaveText('赵无极');

    await affinity.click();
    await expect(affinity.locator('.sort-arrow')).toHaveText('↓');
    await expect(page.locator('.name-chip__name').first()).toHaveText('阿福');

    await page.reload();
    await enterSeededGame(page);
    await openPanel(page);
    await expect(page.locator('.np .sort-chip', { hasText: '好感' })).toHaveClass(/sort-chip--active/);
    await expect(page.locator('.name-chip__name').first()).toHaveText('阿福');
  });

  test('copy icon writes the name to the clipboard without inserting it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only here');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPanel(page);

    await page.locator('.name-chip', { hasText: '林婉儿' }).locator('.name-chip__copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('林婉儿');
    await expect(page.locator(composer)).toHaveValue('');
  });

  test('drawer: collapsing hides the three tool keys and removes them from the tab order', async ({ page }) => {
    const drawer = page.locator('#composer-tools');
    await expect(page.locator(toolsKey)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(nameKey)).toBeVisible();

    await page.locator(toolsKey).click();
    await expect(page.locator(toolsKey)).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toHaveAttribute('inert', '');
    // Rolled up to zero width — the keys are no longer reachable or hoverable.
    await expect.poll(async () => (await drawer.boundingBox())?.width ?? -1).toBeLessThanOrEqual(1);

    // Choice is remembered for the next session.
    await page.reload();
    await enterSeededGame(page);
    await expect(page.locator(toolsKey)).toHaveAttribute('aria-expanded', 'false');
  });

  test('mobile: an open drawer never makes the composer scroll sideways', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only invariant');
    await expect(page.locator(toolsKey)).toHaveAttribute('aria-expanded', 'true');

    const report = await page.evaluate(() => {
      const measure = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? { sel, scrollW: el.scrollWidth, clientW: el.clientWidth } : { sel, scrollW: 0, clientW: 0 };
      };
      return {
        vw: document.documentElement.clientWidth,
        docScrollW: document.documentElement.scrollWidth,
        surfaces: [measure('.input-area'), measure('.input-row'), measure('.composer-actions')],
      };
    });
    expect(report.docScrollW).toBeLessThanOrEqual(report.vw);
    for (const s of report.surfaces) {
      expect(s.scrollW, `${s.sel} must not overflow horizontally`).toBeLessThanOrEqual(s.clientW + 1);
    }

    // And the panel itself stays inside a narrow screen.
    await openPanel(page);
    const box = await page.locator(panel).boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(report.vw + 1);
    }
  });

/**
 * Regression gate for the merge of the retired「+词」key into this panel: that key was
 * gated ONLY on (STT configured + save loaded). A save with no NPCs and no locations must
 * therefore still expose the voice dictionary — otherwise a working feature vanished
 * behind an unrelated precondition (code review, 2026-09-02).
 */
  test('empty save with STT configured still reaches the voice dictionary', async ({ page }) => {
  const emptyTree = makeSeedTree({
    社交: { 关系: [] },
    世界: { 地点信息: [] },
    系统: { 探索记录: [] },
  });
  await seedSave(page, { tree: emptyTree });
  await page.addInitScript(() => {
    const raw = localStorage.getItem('aga_api_management');
    const data = raw ? JSON.parse(raw) : { apiConfigs: [], apiAssignments: [] };
    data.apiConfigs = [
      ...(data.apiConfigs ?? []).filter((c: { id?: string }) => c.id !== 'stt-e2e'),
      { id: 'stt-e2e', name: 'STT', apiCategory: 'stt', backend: 'cosyvoice', provider: 'openai',
        url: 'http://127.0.0.1:9880', apiKey: '', model: 'whisper', enabled: true },
    ];
    localStorage.setItem('aga_api_management', JSON.stringify(data));
  });
  await page.reload();
  await enterSeededGame(page);

  await openPanel(page);
  // No names to show…
  await expect(page.locator('.name-chip')).toHaveCount(0);
  await expect(page.locator('.np__empty')).toBeVisible();
  // …but the dictionary row is still reachable, and its confirm key stays inside the panel.
  await page.locator('.np__footToggle').click();
  const input = page.locator('.np__lex input');
  const addBtn = page.locator('.np__lexAdd');
  await expect(input).toBeVisible();
  await expect(addBtn).toBeDisabled();

  await input.fill('沈砚舟');
  const [panelBox, btnBox] = [await page.locator('.np').boundingBox(), await addBtn.boundingBox()];
  expect(panelBox).not.toBeNull();
  expect(btnBox).not.toBeNull();
  if (panelBox && btnBox) {
    // The old「+词」row let this key punch through the popover's padding on a narrow box.
    expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    expect(btnBox.x).toBeGreaterThanOrEqual(panelBox.x);
  }
  await addBtn.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('aga_stt_custom_lexicon')))
    .toContain('沈砚舟');
});
});
