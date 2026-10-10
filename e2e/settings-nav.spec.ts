/**
 * The settings page's side navigation and search, in both entries: the Home modal and the game page (ZERO real API).
 *
 * 2026-10-09 fix: a click jumped to the right section, but the highlight then went its own way — the intersection
 * observer skipped its bookkeeping while a click scrolled, kept sections long gone in its "visible" set and lit the
 * first of them for good; while reading, a long section held the light while the next ones scrolled past. The memory
 * section sat at the bottom of the page though the nav lists it before 高级设置. Search only read what was on screen,
 * so rows behind a master switch (配音 → 音色) or the folded Engram group were never found, and Engram / About ignored
 * the search altogether.
 *
 * Run: npx playwright test settings-nav
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';

const NAV_OF: Record<string, string> = {
  'settings-nsfw': '内容过滤', 'settings-ai-features': 'AI 功能开关', 'settings-audio': '配音', 'settings-voice-input': '语音输入',
  'settings-ui': '界面偏好', 'settings-game': '游戏设置', 'settings-action': '行动选项', 'settings-heartbeat': '世界心跳',
  'settings-npc': 'NPC 设置', 'settings-plot': '剧情导向', 'settings-memory': '记忆系统', 'settings-engram': '记忆系统',
  'settings-advanced': '高级设置', 'settings-scale': '界面缩放', 'settings-data': '数据管理',
};

/** The section ids whose top edge sits at the top of the scroll area, and whether it is scrolled to the end. */
async function topOfContent(content: Locator): Promise<{ atTop: string[]; atEnd: boolean }> {
  return content.evaluate((c) => {
    const top = c.getBoundingClientRect().top;
    const atTop = [...c.querySelectorAll<HTMLElement>('[id^="settings-"]')]
      .filter((s) => s.getClientRects().length > 0 && Math.abs(s.getBoundingClientRect().top - top) < 3)
      .map((s) => s.id);
    return { atTop, atEnd: c.scrollTop >= c.scrollHeight - c.clientHeight - 2 };
  });
}

/** The side-nav entry of the section being read: the last one whose top passed 30% of the visible height. */
async function sectionBeingRead(content: Locator): Promise<string | undefined> {
  return content.evaluate((c, navOf) => {
    const top = c.getBoundingClientRect().top;
    const line = c.clientHeight * 0.3;
    const ids = [...c.querySelectorAll<HTMLElement>('[id^="settings-"]')]
      .filter((s) => navOf[s.id] && s.getClientRects().length > 0 && s.getBoundingClientRect().top - top <= line)
      .map((s) => s.id);
    return navOf[ids[ids.length - 1]];
  }, NAV_OF);
}

async function expectNavFollowsClicksAndScrolling(page: Page, entries: string[]): Promise<void> {
  const nav = page.locator('.settings-nav');
  const content = page.locator('.settings-content');
  const active = nav.locator('.settings-nav__item--active');
  await expect(nav.locator('.settings-nav__item')).toHaveText(entries);

  // Every entry, down and back up: the clicked entry stays lit, and its section lands at the top (or the page ends).
  for (const name of [...entries, ...[...entries].reverse()]) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(active).toHaveText(name);
    const id = Object.keys(NAV_OF).find((key) => NAV_OF[key] === name) as string;
    await expect.poll(async () => {
      const { atTop, atEnd } = await topOfContent(content);
      return atTop.includes(id) || atEnd;
    }, { message: `${name} lands at the top`, timeout: 15_000 }).toBe(true);
    await expect(active).toHaveText(name);
  }

  // Reading top to bottom: the wheel hands the page back to the reader, then each section's heading is brought just
  // past the highlight line (30% down) and the lit entry must be that section's — the short ones included.
  await content.evaluate((c) => { c.scrollTop = 0; });
  await content.hover();
  await page.mouse.wheel(0, 1);
  await expect(active).toHaveText(entries[0]);
  const stops = await content.evaluate((c, navOf) => {
    const top = c.getBoundingClientRect().top;
    const line = c.clientHeight * 0.3;
    const max = c.scrollHeight - c.clientHeight;
    return [...c.querySelectorAll<HTMLElement>('[id^="settings-"]')]
      .filter((s) => navOf[s.id] && s.getClientRects().length > 0)
      .map((s) => ({ nav: navOf[s.id], scrollTop: Math.round(c.scrollTop + s.getBoundingClientRect().top - top - line + 10) }))
      .filter((stop) => stop.scrollTop > 0 && stop.scrollTop < max - 2);
  }, NAV_OF);
  expect(stops.length).toBeGreaterThan(entries.length - 3);
  for (const stop of stops) {
    await content.evaluate((c, y) => { c.scrollTop = y; }, stop.scrollTop);
    await expect(active, `reading at ${stop.scrollTop}`).toHaveText(stop.nav);
    expect(await sectionBeingRead(content)).toBe(stop.nav);
  }
  // At the very end the last entry lights, even if its section never reaches the line.
  await content.evaluate((c) => { c.scrollTop = c.scrollHeight; });
  await expect(active).toHaveText(entries[entries.length - 1]);
}

async function expectSearchFindsHiddenRows(page: Page, inGame: boolean): Promise<void> {
  const search = page.locator('.settings-search');
  const navItems = page.locator('.settings-nav__item:visible');
  const blocks = page.locator('.settings-content [id^="settings-"]:visible');

  // A row behind the voice-over master switch (off by default).
  await search.fill('音色');
  await expect(navItems).toHaveText(['配音']);
  await expect(blocks).toHaveCount(1);
  await expect(page.locator('#settings-audio')).toBeVisible();

  // Engram follows the search under 记忆系统, and opens its fold when it matches.
  await search.fill('');
  if (await page.locator('.engram-body').count()) await page.locator('.engram-header').click();
  await expect(page.locator('.engram-body')).toHaveCount(0);
  await search.fill('重排');
  await expect(navItems).toHaveText(['记忆系统']);
  await expect(page.locator('#settings-engram')).toBeVisible();
  await expect(page.locator('.engram-body')).toHaveCount(1);

  // A game-page row is found in the game and not on Home.
  await search.fill('思维链');
  if (inGame) await expect(navItems).toHaveText(['AI 功能开关']);
  else await expect(page.getByText('没有匹配的设置')).toBeVisible();

  await search.fill('不存在的设置');
  await expect(page.getByText('没有匹配的设置')).toBeVisible();
  await expect(blocks).toHaveCount(0);

  await search.fill('');
  await expect(page.getByText('没有匹配的设置')).toHaveCount(0);
  await expect(page.locator('#settings-about')).toBeVisible();
}

const HOME_ENTRIES = ['内容过滤', 'AI 功能开关', '配音', '语音输入', '界面偏好', '游戏设置', '行动选项', '记忆系统', '高级设置', '界面缩放', '数据管理'];
const GAME_ENTRIES = ['内容过滤', 'AI 功能开关', '配音', '语音输入', '界面偏好', '游戏设置', '行动选项', '世界心跳', 'NPC 设置', '剧情导向', '记忆系统', '高级设置', '界面缩放', '数据管理'];

test('Home settings: the side nav follows clicks and reading, and search finds rows that are not on screen',
  { tag: ['@regression', '@settings'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'the side nav is hidden on phones');
    // Two dozen smooth scrolls; software-rendered Chromium (no GPU, CI too) draws ~4 frames a second.
    test.setTimeout(300_000);
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expectNavFollowsClicksAndScrolling(page, HOME_ENTRIES);
    await expectSearchFindsHiddenRows(page, false);
  });

test('game settings: the side nav follows clicks and reading, and search finds rows that are not on screen',
  { tag: ['@regression', '@settings'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'the side nav is hidden on phones');
    // Two dozen smooth scrolls; software-rendered Chromium (no GPU, CI too) draws ~4 frames a second.
    test.setTimeout(300_000);
    await seedSave(page);
    await enterSeededGame(page);
    await goToGameTab(page, 'settings');
    await expectNavFollowsClicksAndScrolling(page, GAME_ENTRIES);
    await expectSearchFindsHiddenRows(page, true);
  });
