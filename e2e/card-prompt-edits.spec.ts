/**
 * A game card carries its author's prompt edits, and an importer who ticks them gets them in the next round
 * (ZERO real API).
 *
 * Code review 2026-10-04 (H1, M5): cards export the prompt page's edits as `promptEdits`, but the import wizard only
 * offered its "built-in prompt overrides" row for the old field, so a new card's edits could not be taken. This
 * walks the whole chain on real files and the real UI: an edit on the author's device → card export with the box
 * ticked → the importer's device (no edit of its own) imports the card, the row is there, ticked → the edit is where
 * the prompt page keeps edits and, with no reload, the next round's story request carries it (the registry is told
 * to reload: `prompt:edits-replaced`). The fake model answers on loopback and keeps every request.
 *
 * Run: npx playwright test card-prompt-edits
 */
import { test, expect, seedSave, enterSeededGame, decodeCardFile } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';
import type { Page, Route } from '@playwright/test';

const AUTHOR_STYLE = '【作者的文风】只写当场看得见的动作，不写心理分析。';
const STYLE_KEY = 'aga_prompt_tianming_writeStyle';
const STORY = '雨从檐角落下，他把伞往你那边偏了一点。';
const TAIL = { commands: [], action_options: ['走', '停'], mid_term_memory: null, knowledge_facts: [] };

interface SentBody { stream?: boolean; messages?: Array<{ content: unknown }> }

/** The fake model: every request body it was sent, in order. */
async function useFakeModel(page: Page): Promise<SentBody[]> {
  const sent: SentBody[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-card', name: 'card', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, streaming: true, maxRetries: 0 }));
  });
  await page.route('http://127.0.0.1:1/**', (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as SentBody;
    sent.push(body);
    if (!body.stream) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(TAIL) } }] }) });
    }
    const reply = JSON.stringify({ text: STORY });
    const sse = (reply.match(/[\s\S]{1,16}/g) ?? [])
      .map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  return sent;
}

/** The round counter and whether the engine is still working on something. */
function engineNow(page: Page): Promise<{ round: number; busy: boolean }> {
  return page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    const provides = app.__vue_app__._context.provides;
    const sm = provides.stateManager as { get: (p: string) => unknown };
    return { round: Number(sm.get('元数据.回合序号') ?? 0), busy: (provides.gameOrchestrator as { isBusy: boolean }).isBusy };
  });
}

const textOf = (body: SentBody | undefined): string =>
  (body?.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

test('a card carries the author\'s prompt edits; ticked at import, they reach the next round without a reload',
  { tag: ['@regression', '@card', '@prompts'] },
  async ({ page, home, gameShell, savePage, cardExport, cardImport }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a card and a round');
    test.slow();
    await seedSave(page);
    const sent = await useFakeModel(page);
    // ── The author's device: an edit on the prompt page.
    await page.addInitScript(([key, text]) => {
      if (!sessionStorage.getItem('e2e-importer')) localStorage.setItem(key, text);
    }, [STYLE_KEY, AUTHOR_STYLE] as const);
    await page.reload();
    await enterSeededGame(page);

    await gameShell.goTab('save');
    await savePage.openExportFlow();
    await expect(cardExport.gatePass).toBeVisible({ timeout: 15_000 });
    await cardExport.fillTitle('作者的提示词');
    await page.locator('.ckl-row', { hasText: '内置提示词改动' }).locator('input[type="checkbox"]').check();
    const [download] = await Promise.all([page.waitForEvent('download'), cardExport.exportButton.click()]);
    const cardPath = testInfo.outputPath('prompt-edits.aga-card');
    await download.saveAs(cardPath);
    expect(decodeCardFile(cardPath).bundle.promptEdits).toEqual({
      version: 1, packId: 'tianming', entries: [{ id: 'writeStyle', content: AUTHOR_STYLE }],
    });

    // ── The importer's device: no edit of its own.
    await page.evaluate((key) => { sessionStorage.setItem('e2e-importer', '1'); localStorage.removeItem(key); }, STYLE_KEY);
    await page.goto('/');
    await home.importCard();
    await cardImport.pickFile(cardPath);
    await expect(cardImport.previewHeading()).toBeVisible({ timeout: 15_000 });
    await cardImport.next();   // → protagonist
    await cardImport.next();   // → global
    const row = page.locator('.cif-check', { hasText: '内置提示词覆盖' });
    await expect(row).toBeVisible();
    await row.locator('input[type="checkbox"]').check();
    await cardImport.doImport();
    await expect(cardImport.doneHeading()).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), STYLE_KEY)).toBe(AUTHOR_STYLE);
    await cardImport.enterGame();
    await page.waitForURL(/\/game(\/|$)/);

    // ── The prompt page shows it as an edit.
    await goToGameTab(page, 'prompts');
    await page.getByRole('button', { name: '内置提示词', exact: true }).click();
    await page.getByRole('button', { name: '展开', exact: true }).click();
    const styleCard = page.locator('.prompt-card').filter({ has: page.getByTestId('prompt-toggle-writeStyle') });
    await expect(styleCard.locator('.modified-badge')).toBeVisible();

    // ── The next round, with no reload since the import, sends it.
    await goToGameTab(page, '');
    await expect.poll(() => engineNow(page).then((e) => e.busy), { timeout: 60_000 }).toBe(false);
    const before = (await engineNow(page)).round;
    sent.length = 0;
    await page.locator('.message-input').fill('我接过伞。');
    await page.locator('.send-btn').click();
    await expect.poll(() => engineNow(page), { timeout: 60_000 }).toEqual({ round: before + 1, busy: false });
    const story = textOf(sent.find((b) => b.stream));
    expect(story).toContain(AUTHOR_STYLE);
    expect(story).not.toContain('【文风参考（取法，不复写）】');
  });
