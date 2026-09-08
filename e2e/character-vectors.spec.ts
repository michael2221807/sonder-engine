/**
 * Character Vectors — user-facing surfaces (ZERO real API).
 *
 * Pins what a player can see after the character-vector v1 plan (S3/S5), v2 lines
 * (heading / tension / unconfirmed, 2026-09-08):
 *   1. 角色 → 关系: a main-cast NPC's card carries a vector card; three lines typed + saved
 *      land in the card, survive a reload (state-tree persistence), and the 叙事契约 tab
 *      lists the NPC in "injected next turn" because the NPC is 在场;
 *   2. a real split-gen round assembles offline and the step1 snapshot in Prompt 组装
 *      carries the 「人物向量」 piece with the NPC's line — and never the protagonist.
 *
 * Runs on desktop-1920 only (sidebar navigation). Run: npx playwright test character-vectors
 */
import { test, expect, seedSave, enterSeededGame, LOCATION_NAME } from './fixtures/base';
import { makeSeedTree, PROFILE_ID, SLOT_ID } from './fixtures/seed-tree';
import type { Page } from '@playwright/test';

async function storedVectors(page: Page): Promise<{ enabled?: boolean; entries?: Array<Record<string, unknown>> } | undefined> {
  return page.evaluate(async ({ key }) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('aga-saves', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tree = await new Promise<Record<string, unknown> | undefined>((res, rej) => {
      const req = db.transaction('data', 'readonly').objectStore('data').get(key);
      req.onsuccess = () => res(req.result as Record<string, unknown> | undefined);
      req.onerror = () => rej(req.error);
    });
    db.close();
    const sys = tree?.['系统'] as Record<string, unknown> | undefined;
    const ext = sys?.['扩展'] as Record<string, unknown> | undefined;
    return ext?.['characterVectors'] as { enabled?: boolean; entries?: Array<Record<string, unknown>> } | undefined;
  }, { key: `save_${PROFILE_ID}_${SLOT_ID}` });
}

const KEY_NPC = '沈墨琛';
const AWAY_NPC = '林晚照';
const HEADING = '往护偏，独她一份';
const TENSION = '占有着她，又护着她；护了，却不认、不承诺';
const UNCONFIRMED = '他叫停了那场人为调教';

function npc(name: string, present: boolean) {
  return { 名称: name, 类型: '重点', 好感度: 30, 位置: LOCATION_NAME, 描述: `${name}。`, 性别: '男', 年龄: 30, 是否在场: present, 记忆: [], 私聊历史: [] };
}

function vectorTree() {
  return makeSeedTree({
    社交: { 关系: [npc(KEY_NPC, true), npc(AWAY_NPC, false)], 事件: { 事件记录: [] } },
  });
}

async function openRelations(page: Page, gameShell: { goTab(tab: string): Promise<void> }) {
  await gameShell.goTab('character');
  await page.getByRole('tab', { name: /关系|Relations/ }).first().click();
  await expect(page.locator('[data-testid="vector-card"]').first()).toBeVisible();
}

test.describe('Character Vectors surfaces', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar navigation specs run on desktop-1920 only');
  });

  test('vector card: lines typed + saved on an NPC survive a reload and the contract tab projects the present NPC',
    { tag: ['@regression', '@relationships', '@prompts'] },
    async ({ page, gameShell }) => {
      await seedSave(page, { tree: vectorTree() });
      await enterSeededGame(page);
      await openRelations(page, gameShell);

      // The key NPC's card is empty → open the editor and write three lines.
      const card = page.locator('[data-testid="vector-card"]').first();
      await card.locator('[data-testid="vector-add"]').click();
      await card.locator('[data-testid="vector-input-heading"]').fill(HEADING);
      await card.locator('[data-testid="vector-input-tension"]').fill(TENSION);
      await card.locator('[data-testid="vector-input-unconfirmed"]').fill(UNCONFIRMED);
      await card.locator('[data-testid="vector-save"]').click();
      await expect(card.locator('[data-testid="vector-line-heading"]')).toHaveText(HEADING);
      await expect(card.locator('[data-testid="vector-line-tension"]')).toHaveText(TENSION);
      await expect(card.locator('[data-testid="vector-line-unconfirmed"]')).toHaveText(UNCONFIRMED);
      await expect.poll(async () => (await storedVectors(page))?.entries?.length, { timeout: 10_000 }).toBe(1);

      // The contract tab lists the NPC as injected next turn (it is 在场).
      await gameShell.goTab('prompts');
      await page.locator('[data-testid="prompt-tab-contract"]').click();
      await expect(page.locator('[data-testid="contract-vector-chip"]')).toHaveText([KEY_NPC]);
      await expect(page.locator('[data-testid="contract-vector-row"]')).toHaveCount(1);

      // Reload: the vector lives in the state tree.
      await page.reload();
      await enterSeededGame(page);
      await openRelations(page, gameShell);
      await expect(page.locator('[data-testid="vector-card"]').first().locator('[data-testid="vector-line-heading"]')).toHaveText(HEADING);
    });

  test('a real split-gen round assembles offline: the step1 snapshot in Prompt 组装 carries the 人物向量 piece with the NPC line',
    { tag: ['@regression', '@prompts', '@debug'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: vectorTree() });
      await page.addInitScript(() => {
        localStorage.setItem('aga_api_management', JSON.stringify({
          apiConfigs: [{
            id: 'e2e-vectors', name: 'vectors', apiCategory: 'llm', provider: 'openai',
            url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop',
            temperature: 0, maxTokens: 1, enabled: true,
          }],
          apiAssignments: [],
        }));
        const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
        localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, contextCompiler: true, maxRetries: 0 }));
        localStorage.setItem('aga_debug_settings', JSON.stringify({ debugMode: true, consoleDebug: true, aiLogging: false }));
      });
      await page.reload();
      await page.route('http://127.0.0.1:1/**', (route) => route.abort('connectionrefused'));
      await enterSeededGame(page);

      await openRelations(page, gameShell);
      const card = page.locator('[data-testid="vector-card"]').first();
      await card.locator('[data-testid="vector-add"]').click();
      await card.locator('[data-testid="vector-input-heading"]').fill(HEADING);
      await card.locator('[data-testid="vector-save"]').click();
      await expect(card.locator('[data-testid="vector-line-heading"]')).toHaveText(HEADING);

      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await gameShell.goTab('');
      await page.locator('.message-input').fill('我回头看他。');
      await page.locator('.send-btn').click();

      await gameShell.goTab('prompt-assembly');
      await expect(page.getByText('splitGenMainRoundStep1').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.source-breakdown-chip', { hasText: '人物向量' }).first()).toBeVisible();
      await expect(page.getByText(`- ${KEY_NPC}：`).first()).toBeVisible();
      expect(pageErrors, 'no uncaught page errors during a vectors-on assembly').toEqual([]);
    });

  test('"让世界写向量" runs the proposal pipeline on demand: offline it degrades to one error toast, no page errors',
    { tag: ['@regression', '@relationships'] },
    async ({ page, gameShell }) => {
      await seedSave(page, { tree: vectorTree() });
      await enterSeededGame(page);
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openRelations(page, gameShell);

      const button = page.locator('[data-testid="vector-generate"]');
      await expect(button).toBeEnabled();
      await button.click();
      // Offline the run degrades to one toast — `noCandidates` (the seed has no memory naming the
      // cast) or `failed` (no API config) — and never throws; the round is untouched.
      await expect(page.getByText(/世界写向量失败|记忆里还没有主线人物的材料|Writing vectors failed|no material on the main cast/)).toBeVisible({ timeout: 15_000 });
      await expect(button).toBeEnabled();
      await expect(page.locator('[data-testid="vector-card"]').first().locator('[data-testid="vector-add"]')).toBeVisible();
      expect(pageErrors).toEqual([]);

      // The same trigger lives on the contract tab next to the vectors section.
      await gameShell.goTab('prompts');
      await page.locator('[data-testid="prompt-tab-contract"]').click();
      await expect(page.locator('[data-testid="contract-vector-generate"]')).toBeVisible();
    });
});
