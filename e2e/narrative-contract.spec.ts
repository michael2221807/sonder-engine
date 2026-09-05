/**
 * Narrative Contract — user-facing surfaces (ZERO real API).
 *
 * Pins what a player can see after R2 S2 (docs/design/narrative-contract-v1-implementation-plan.md):
 *   1. 提示词面板 → 叙事契约 tab: the focal cast is 「重点」 ∪ 「关注」 from the relationship
 *      list (a 「普通」 NPC stays out), a clause typed + Enter lands in the list, and both
 *      the clause and the master switch survive a reload (state-tree persistence);
 *   2. a real split-gen round assembles offline and the step1 snapshot in Prompt 组装 carries
 *      the 「叙事契约」 piece with the clause text — the same wiring the model sees.
 *
 * Runs on desktop-1920 only (sidebar navigation). Run: npx playwright test narrative-contract
 */
import { test, expect, seedSave, enterSeededGame, LOCATION_NAME } from './fixtures/base';
import { makeSeedTree, PROFILE_ID, SLOT_ID } from './fixtures/seed-tree';
import type { Page } from '@playwright/test';

/**
 * The persisted contract, read straight from IndexedDB. `engine:request-save` is
 * fire-and-forget (game-orchestrator.ts), so a reload right after a click can race the
 * write; the spec waits for the disk to catch up instead of sleeping.
 */
async function storedContract(page: Page): Promise<{ enabled?: boolean; clauses?: unknown[] } | undefined> {
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
    return ext?.['narrativeContract'] as { enabled?: boolean; clauses?: unknown[] } | undefined;
  }, { key: `save_${PROFILE_ID}_${SLOT_ID}` });
}

const KEY_NPC = '沈墨琛';
const WATCHED_NPC = '许静姝';
const ORDINARY_NPC = '路人甲';
const CLAUSE = '沈墨琛表面霸道，底色是护不是猎。';

function npc(name: string, type: '重点' | '普通', extra: Record<string, unknown> = {}) {
  return { 名称: name, 类型: type, 好感度: 30, 位置: LOCATION_NAME, 描述: `${name}。`, 性别: '女', 年龄: 22, 记忆: [], 私聊历史: [], ...extra };
}

function contractTree() {
  return makeSeedTree({
    社交: {
      关系: [npc(KEY_NPC, '重点'), npc(WATCHED_NPC, '普通', { 关注: true }), npc(ORDINARY_NPC, '普通')],
      事件: { 事件记录: [] },
    },
  });
}

async function openContractTab(page: Page, gameShell: { goTab(tab: string): Promise<void> }) {
  await gameShell.goTab('prompts');
  await page.locator('[data-testid="prompt-tab-contract"]').click();
  await expect(page.locator('[data-testid="contract-tab"]')).toBeVisible();
}

test.describe('Narrative Contract surfaces', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar navigation specs run on desktop-1920 only');
  });

  test('契约 tab: cast = 重点 ∪ 关注, a clause is added with Enter, clause + switch survive a reload',
    { tag: ['@regression', '@prompts'] },
    async ({ page, gameShell }) => {
      await seedSave(page, { tree: contractTree() });
      await enterSeededGame(page);
      await openContractTab(page, gameShell);

      // Focal cast is derived from the relationship list — no control to configure.
      const chips = page.locator('[data-testid="contract-cast-chip"]');
      await expect(chips).toHaveText([KEY_NPC, WATCHED_NPC]);
      await expect(chips.filter({ hasText: ORDINARY_NPC })).toHaveCount(0);

      // Empty state, then one clause via Enter.
      await expect(page.locator('[data-testid="contract-clause-row"]')).toHaveCount(0);
      await page.locator('[data-testid="contract-clause-input"]').fill(CLAUSE);
      await page.locator('[data-testid="contract-clause-input"]').press('Enter');
      const rows = page.locator('[data-testid="contract-clause-row"]');
      await expect(rows).toHaveCount(1);
      await expect(rows.first().locator('textarea')).toHaveValue(CLAUSE);
      await expect(page.locator('[data-testid="contract-clause-input"]')).toHaveValue('');
      await expect.poll(async () => (await storedContract(page))?.clauses?.length, { timeout: 10_000 }).toBe(1);

      // Master switch off persists too.
      const master = page.locator('[data-testid="contract-enabled"]');
      await expect(master).toHaveAttribute('aria-checked', 'true');
      await master.click();
      await expect(master).toHaveAttribute('aria-checked', 'false');
      await expect.poll(async () => (await storedContract(page))?.enabled, { timeout: 10_000 }).toBe(false);

      // Reload: the contract lives in the state tree and was persisted by engine:request-save.
      await page.reload();
      await enterSeededGame(page);
      await openContractTab(page, gameShell);
      await expect(page.locator('[data-testid="contract-clause-row"]').first().locator('textarea')).toHaveValue(CLAUSE);
      await expect(page.locator('[data-testid="contract-enabled"]')).toHaveAttribute('aria-checked', 'false');
    });

  test('a real split-gen round assembles offline: the step1 snapshot in Prompt 组装 carries the 叙事契约 piece with the clause',
    { tag: ['@regression', '@prompts', '@debug'] },
    async ({ page, gameShell }) => {
      test.slow(); // full main-round assembly before the aborted AI call
      await seedSave(page, { tree: contractTree() });

      // Same offline recipe as context-compiler.spec.ts: one enabled config pointing at
      // loopback so the pipeline reaches ContextAssembly, split-gen ON, debug ON.
      await page.addInitScript(() => {
        localStorage.setItem('aga_api_management', JSON.stringify({
          apiConfigs: [{
            id: 'e2e-contract', name: 'contract', apiCategory: 'llm', provider: 'openai',
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

      // Write the clause through the UI (the only write path a player has).
      await openContractTab(page, gameShell);
      await page.locator('[data-testid="contract-clause-input"]').fill(CLAUSE);
      await page.locator('[data-testid="contract-clause-input"]').press('Enter');
      await expect(page.locator('[data-testid="contract-clause-row"]')).toHaveCount(1);

      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await gameShell.goTab('');
      await page.locator('.message-input').fill('我回头看他。');
      await page.locator('.send-btn').click();

      await gameShell.goTab('prompt-assembly');
      await expect(page.getByText('splitGenMainRoundStep1').first()).toBeVisible({ timeout: 30_000 });
      // The contract piece is listed among step1's builder pieces …
      await expect(page.locator('.source-breakdown-chip', { hasText: '叙事契约' }).first()).toBeVisible();
      // … and the assembled messages carry the player's clause and the derived cast.
      await expect(page.getByText(CLAUSE).first()).toBeVisible();
      await expect(page.getByText(`${KEY_NPC}、${WATCHED_NPC}`).first()).toBeVisible();
      expect(pageErrors, 'no uncaught page errors during a contract-on assembly').toEqual([]);
    });
});
