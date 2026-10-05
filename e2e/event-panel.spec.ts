/**
 * The event panel shows the world's timeline and nothing that does nothing (ZERO real API).
 *
 * PO 2026-10-05 (7A): the collapsible 「事件配置」 section (intervals, type switches, custom templates, re-roll) wrote a
 * part of the save nothing ever read, so it is gone. The timeline — heartbeat history and world events, newest first —
 * stays.
 *
 * Run: npx playwright test event-panel
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import { goToGameTab } from './fixtures/navigation';

const tree = makeSeedTree({
  世界: { 状态: { 心跳: { 历史: [{ 标题: '林婉儿去了药铺', 描述: '她替师父取一味药。', 回合: 2 }] } } },
  社交: { 事件: { 事件记录: [{ 事件名称: '宗门大比开幕', 事件描述: '青云宗三年一度的大比在城外开幕。', 回合: 3 }] } },
});

test('the event panel shows the timeline, newest first, and no settings that do nothing',
  { tag: ['@regression', '@events'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for the panel content');
    test.slow();
    await seedSave(page, { tree });
    await enterSeededGame(page);
    await goToGameTab(page, 'events');
    const items = page.locator('.timeline-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('宗门大比开幕');
    await items.first().click();
    await expect(page.locator('.event-description')).toContainText('三年一度');
    await expect(page.locator('.config-toggle')).toHaveCount(0);
    await expect(page.getByText('事件配置')).toHaveCount(0);
    await expect(page.locator('.event-panel input, .event-panel button')).toHaveCount(0);
  });
