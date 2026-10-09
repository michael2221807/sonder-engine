/**
 * The per-round viewers with the slimmed save data (存档瘦身 P1 B4, S7) — ZERO real API: the fake model answers on
 * loopback.
 *
 * - Δ (生效变更): a push is stored with the one entry it added; the viewer shows that entry, not the whole list (it
 *   used to show the start of the whole list — the oldest entry).
 * - Engram (记忆): at round start, a retrieval trace outside the latest five completed rounds keeps only the memories
 *   it injected; the viewer shows the filtered ones as counts by outcome.
 *
 * Run: npx playwright test round-viewers
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';
import { makeSeedTree } from './fixtures/seed-tree';
import type { Page, Route } from '@playwright/test';

const STORY = '集市里人声鼎沸。';
const EVENT = { 事件名称: '到了集市', 事件描述: STORY };

/** The round's reply: a story, and one event pushed onto the event log. */
async function fakeModel(page: Page): Promise<void> {
  const answer = (route: Route): Promise<void> => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { stream?: boolean };
    if (!body.stream) {
      const nothing = JSON.stringify({ text: '', commands: [], action_options: [], mid_term_memory: null, knowledge_facts: [] });
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: nothing } }] }) });
    }
    const reply = JSON.stringify({
      text: STORY,
      commands: [{ action: 'push', key: '社交.事件.事件记录', value: EVENT }],
      action_options: ['走', '停'], mid_term_memory: null, knowledge_facts: [],
    });
    const sse = (reply.match(/[\s\S]{1,24}/g) ?? [])
      .map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  };
  await page.route('http://127.0.0.1:1/**', answer);
}

/** A retrieval trace with one injected memory and three filtered ones. */
function trace(round: number): Record<string, unknown> {
  const candidate = (text: string, outcome: string) => ({ text, outcome, source: 'event', finalScore: 0.4, components: [] });
  return {
    query: `第${round}回合的检索`, capturedAt: 0, totalDurationMs: 9,
    candidates: [
      candidate(`第${round}回合用上的记忆`, 'injected'),
      candidate(`第${round}回合落选甲`, 'filtered-by-topK'),
      candidate(`第${round}回合落选乙`, 'filtered-by-topK'),
      candidate(`第${round}回合重复`, 'filtered-as-redundant'),
    ],
    pipeline: { vectorEventCount: 4, vectorEntityCount: 0, graphCount: 0, afterMerge: 4, afterRerank: 4, injectedCount: 1 },
    config: {
      minScore: 0.3, topK: 1, rerankEnabled: false, rerankTopN: 0, embeddingEnabled: true, shortTermWindow: 3,
      maxCandidates: 20, edgeBudget: 5, entityBudget: 5, eventBudget: 5,
    },
  };
}

/** Seven completed rounds, each reply with its retrieval trace; earlier events in the log. */
function sevenRounds(): Record<string, unknown> {
  const history: Array<Record<string, unknown>> = [];
  for (let round = 1; round <= 7; round++) {
    history.push({ role: 'user', content: `第${round}回合的输入` });
    history.push({ role: 'assistant', content: `第${round}回合的正文。`, _engramRead: trace(round), _metrics: { roundNumber: round } });
  }
  return makeSeedTree({
    元数据: { 回合序号: 7, 叙事历史: history },
    社交: { 事件: { 事件记录: [{ 事件名称: '最早的事件', 事件描述: '很久以前' }, { 事件名称: '第二件事', 事件描述: '不久之前' }] } },
  }) as unknown as Record<string, unknown>;
}

async function useFakeModel(page: Page): Promise<void> {
  await seedSave(page, { tree: sevenRounds() as never });
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-viewers', name: 'viewers', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: false, streaming: true, maxRetries: 0 }));
  });
  await page.reload();
  await fakeModel(page);
  await enterSeededGame(page);
}

type Provides = { stateManager: { get: (p: string) => unknown }; gameOrchestrator: { isBusy: boolean } };

function engineNow(page: Page): Promise<{ round: number; busy: boolean }> {
  return page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Provides } } };
    const provides = app.__vue_app__._context.provides;
    return { round: Number(provides.stateManager.get('元数据.回合序号') ?? 0), busy: provides.gameOrchestrator.isBusy };
  });
}

/** The open modal has finished its enter transition (its content is drawn, not just in the page). */
async function modalSettled(page: Page): Promise<void> {
  await expect(page.locator('.modal-backdrop').last()).not.toHaveClass(/modal-fade-enter/);
}

async function playRound(page: Page): Promise<void> {
  await goToGameTab(page, '');
  await page.locator('.message-input').fill('我去集市。');
  await page.locator('.send-btn').click();
  await expect.poll(() => engineNow(page), { timeout: 60_000 }).toEqual({ round: 8, busy: false });
  await expect(page.getByText(STORY).first()).toBeVisible();
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for what the viewers show');
  test.slow();
});

test.describe('Per-round viewers with the slimmed save data (offline, fake model on loopback)', () => {
  test('Δ shows the one event a push added, not the whole log', { tag: ['@regression', '@viewers'] }, async ({ page }, testInfo) => {
    await useFakeModel(page);
    await playRound(page);

    await page.getByRole('button', { name: '查看 1 条状态变更' }).last().click();
    const entry = page.getByTestId('delta-entry');
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('到了集市');
    await expect(entry).not.toContainText('最早的事件');
    await modalSettled(page);
    await page.screenshot({ path: testInfo.outputPath('delta-viewer.png'), animations: 'disabled' });
  });

  test('the memory viewer shows an earlier round\'s filtered memories as counts', { tag: ['@regression', '@viewers'] }, async ({ page }, testInfo) => {
    await useFakeModel(page);
    // Before the round: round 2's trace is whole (seven rounds, the latest five kept whole only from round start on).
    await playRound(page);

    // Round 2 left the window at this round's start (rounds 3–7 stay whole): its viewer shows counts. The message
    // list shows the latest five rounds; one "load earlier" (five more rounds) brings round 2 back.
    await page.locator('.load-more-btn').click();
    await expect(page.getByText('第2回合的正文。')).toBeVisible();
    await page.getByRole('button', { name: '查看本回合 Engram 详情' }).first().click();
    const trimmed = page.getByTestId('engram-trimmed');
    await expect(trimmed).toBeVisible();
    await expect(trimmed).toContainText('被淘汰 3 条');
    await expect(trimmed).toContainText('topK 截断 2');
    await expect(trimmed).toContainText('去重淘汰 1');
    await expect(page.getByText('第2回合用上的记忆')).toBeVisible();
    await modalSettled(page);
    await page.screenshot({ path: testInfo.outputPath('engram-viewer-trimmed.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');

    // The latest of the five whole rounds still lists its filtered memories.
    await page.getByRole('button', { name: '查看本回合 Engram 详情' }).last().click();
    await expect(page.getByTestId('engram-trimmed')).toHaveCount(0);
    await expect(page.locator('.erv__filtered-toggle')).toContainText('被淘汰 (3)');
    await modalSettled(page);
    await page.screenshot({ path: testInfo.outputPath('engram-viewer-whole.png'), animations: 'disabled' });
  });
});
