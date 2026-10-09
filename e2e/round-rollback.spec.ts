/**
 * Rolling back the last round (存档瘦身 D1A, S2②) — ZERO real API: the fake model answers on loopback.
 *
 * The round-start snapshot is no longer kept inside the save: the game holds it in memory, and every save stores
 * the patch back to it. A rollback must still give back exactly the tree the round started from: right after the
 * round, after a refresh (the snapshot rebuilt from the saved patch), and after a full backup export and import
 * (the save went through JSON). "Exactly" is checked on the whole state tree, as JSON text, against the tree read
 * just before the round was sent — what the old whole snapshot held.
 *
 * Run: npx playwright test round-rollback
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';
import type { Page, Route } from '@playwright/test';

const STORIES = ['码头的风带着咸味。', '集市里人声鼎沸。'];
const PLACES = ['码头', '集市'];
const FIRST_INPUT = '我去码头。';
const SECOND_INPUT = '我再去集市看看。';

/**
 * One reply per round, told apart by the second round's input (only its request carries those words): its own story,
 * a new location and a new event (so a rollback has something to undo).
 */
async function fakeModel(page: Page): Promise<void> {
  const answer = (route: Route): Promise<void> => {
    const raw = route.request().postData() ?? '{}';
    const body = JSON.parse(raw) as { stream?: boolean };
    const n = raw.includes(SECOND_INPUT) ? 1 : 0;
    const reply = JSON.stringify({
      text: STORIES[n],
      commands: [
        { action: 'set', key: '角色.基础信息.当前位置', value: PLACES[n] },
        { action: 'push', key: '社交.事件.事件记录', value: { 事件名称: `到了${PLACES[n]}`, 事件描述: STORIES[n] } },
      ],
      action_options: ['走', '停'], mid_term_memory: null, knowledge_facts: [],
    });
    if (!body.stream) {
      // A sub-flow's call (field repair and the like): nothing to change.
      const nothing = JSON.stringify({ text: '', commands: [], action_options: [], mid_term_memory: null, knowledge_facts: [] });
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: nothing } }] }) });
    }
    const sse = (reply.match(/[\s\S]{1,24}/g) ?? [])
      .map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  };
  await page.route('http://127.0.0.1:1/**', answer);
}

async function useFakeModel(page: Page): Promise<{ profileId: string; slotId: string }> {
  const ids = await seedSave(page);
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-rollback', name: 'rollback', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: false, streaming: true, maxRetries: 0 }));
  });
  await page.reload();
  await fakeModel(page);
  await enterSeededGame(page);
  return ids;
}

type Provides = { stateManager: { get: (p: string) => unknown; toSnapshot: () => Record<string, unknown> }; gameOrchestrator: { isBusy: boolean } };

/** The round counter and whether the engine is still working on something. */
function engineNow(page: Page): Promise<{ round: number; busy: boolean }> {
  return page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Provides } } };
    const provides = app.__vue_app__._context.provides;
    return { round: Number(provides.stateManager.get('元数据.回合序号') ?? 0), busy: provides.gameOrchestrator.isBusy };
  });
}

/**
 * The whole state tree as JSON text, without the rollback data (what the old whole snapshot held). `asLoaded`: with
 * the history's change records in the form loading a save gives them (存档瘦身 D3A: a push or pull record keeps only
 * its entry) — until the round itself writes that form, a tree read back from a save holds it and the one in play
 * does not; the production function does it, so both sides of a comparison are in the same form.
 */
function storyTree(page: Page, asLoaded = false): Promise<string> {
  return page.evaluate(async (loaded) => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Provides } } };
    const tree = app.__vue_app__._context.provides.stateManager.toSnapshot();
    const meta = tree['元数据'] as Record<string, unknown>;
    delete meta['上次对话前快照'];
    const extension = (tree['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>;
    delete extension['rollbackPatch'];
    if (loaded) {
      // The save's format marker (the load that upgraded the save set it; the rolled-back tree keeps it).
      delete extension['saveFormat'];
      // A variable specifier: the dev server serves the module; typecheck:e2e does not resolve it.
      const url = '/src/engine/persistence/save-format/delta-compaction.ts';
      const { compactHistoryDeltas } = await import(/* @vite-ignore */ url) as { compactHistoryDeltas: (h: readonly unknown[]) => readonly unknown[] };
      meta['叙事历史'] = compactHistoryDeltas(meta['叙事历史'] as unknown[]);
    }
    return JSON.stringify(tree);
  }, asLoaded);
}

function marker(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Provides } } };
    return app.__vue_app__._context.provides.stateManager.get('系统.扩展.rollbackPatch') ?? null;
  });
}

/** Send one round and wait until it is counted and the engine is free again (its save is written by then). */
async function playRound(page: Page, text: string, story: string): Promise<void> {
  await goToGameTab(page, '');
  const before = (await engineNow(page)).round;
  await page.locator('.message-input').fill(text);
  await page.locator('.send-btn').click();
  await expect.poll(() => engineNow(page), { timeout: 60_000 }).toEqual({ round: before + 1, busy: false });
  await expect(page.getByText(story).first()).toBeVisible();
}

const rollbackButton = (page: Page) => page.getByRole('button', { name: '回滚到上回合' });

/** Roll back through the composer button and its confirmation, and wait until the round is gone. */
async function rollBack(page: Page): Promise<void> {
  await goToGameTab(page, '');
  const before = (await engineNow(page)).round;
  await expect(rollbackButton(page)).toBeEnabled();
  await rollbackButton(page).click();
  await page.locator('.modal-btn--confirm').click();
  await expect.poll(() => engineNow(page), { timeout: 15_000 }).toEqual({ round: before - 1, busy: false });
}

/** Two rounds; returns the tree the second one started from (`asLoaded`: see storyTree). */
async function twoRounds(page: Page, asLoaded = false): Promise<string> {
  await playRound(page, FIRST_INPUT, STORIES[0]);
  const startOfSecond = await storyTree(page, asLoaded);
  await playRound(page, SECOND_INPUT, STORIES[1]);
  return startOfSecond;
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for what a rollback restores');
  test.slow();
});

test.describe('Rolling back the last round (offline, fake model on loopback)', () => {
  test('gives back the tree the round started from; once per round', { tag: ['@regression', '@rollback'] }, async ({ page }) => {
    await useFakeModel(page);
    const startOfSecond = await twoRounds(page);
    expect(await marker(page)).toMatch(/^round-start:\d+$/);

    await rollBack(page);
    expect(await storyTree(page)).toBe(startOfSecond);
    await expect(page.getByText(STORIES[1])).toHaveCount(0);
    await expect(page.getByText(STORIES[0]).first()).toBeVisible();
    // One rollback per round: nothing left to roll back to.
    expect(await marker(page)).toBeNull();
    await expect(rollbackButton(page)).toBeDisabled();
  });

  test('after a refresh, rebuilds the snapshot from the saved patch', { tag: ['@regression', '@rollback'] }, async ({ page }) => {
    await useFakeModel(page);
    const startOfSecond = await twoRounds(page, true);

    await page.reload();
    await enterSeededGame(page);
    expect(await marker(page)).toMatch(/^round-start:\d+$/);
    await rollBack(page);
    expect(await storyTree(page, true)).toBe(startOfSecond);
    await expect(page.getByText(STORIES[1])).toHaveCount(0);
  });

  test('after a full backup export and import, rebuilds it from the patch that went through JSON',
    { tag: ['@regression', '@rollback', '@persistence'] }, async ({ page, gameShell, savePage }, testInfo) => {
      await useFakeModel(page);
      const startOfSecond = await twoRounds(page, true);

      await gameShell.goTab('save');
      await savePage.openSettings();
      const [download] = await Promise.all([page.waitForEvent('download'), savePage.backupExportButton.click()]);
      const backupPath = testInfo.outputPath('full-backup.json');
      await download.saveAs(backupPath);
      const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), savePage.backupImportButton.click()]);
      await fileChooser.setFiles(backupPath);
      await expect(savePage.backupAcknowledge).toBeVisible({ timeout: 15_000 });
      await savePage.backupAcknowledge.click();
      await Promise.all([page.waitForEvent('load', { timeout: 15_000 }), savePage.backupConfirmButton.click()]);

      // A full restore resumes its active slot by itself after the reload (HomeView tryAutoResumeAfterImport).
      await page.waitForURL(/\/game(\/|$)/, { timeout: 15_000 });
      await page.getByTestId('mode-toggle').waitFor({ state: 'visible', timeout: 15_000 });
      await expect.poll(() => marker(page), { timeout: 15_000 }).toMatch(/^round-start:\d+$/);
      await rollBack(page);
      expect(await storyTree(page, true)).toBe(startOfSecond);
    });
});
