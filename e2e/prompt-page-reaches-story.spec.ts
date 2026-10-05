/**
 * The prompt page and the bookmarks reach the request that writes the story (ZERO real API).
 *
 * PO 2026-10-04 (P7, P15). A marker experiment on real requests showed the story request — split Step 1 and the
 * single call — sent every builder prompt as the pack wrote it: an edit or a switch on the 「内置提示词」 page reached
 * only Step 2. It also never carried the rounds the player bookmarked for it. The fake model answers on loopback and
 * keeps every request, so the test reads what the story request really carried.
 *
 * Run: npx playwright test prompt-page-reaches-story
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import { goToGameTab } from './fixtures/navigation';
import type { Page, Route } from '@playwright/test';

const STORY = '雨从檐角落下，他把伞往你那边偏了一点。';
const TAIL = { commands: [], action_options: ['走', '停'], mid_term_memory: null, knowledge_facts: [] };
const EDITED_STYLE = '【E2E文风】只写当场看得见的动作。';
/** The pack's own first lines of the two prompts the test edits and switches off. */
const PACK_STYLE = '【文风参考（取法，不复写）】';
const PACK_ANTI_CLICHE = '【反八股文约束 — 去 AI 腔】';
const BOOKMARK_LABEL = '〔收藏·第2回合·';
const JAILBREAK_HEADING = '# 虚构创作环境声明';
const CORE_HEADING = '# 核心规则 · GM 身份与输出格式';
const FORMAT_LINE = '按照上述规则的 JSON 格式输出本回合的叙事和状态变更。';

// Two full rounds so round 2 has a divider with the bookmark star (the opening has none).
const twoRoundTree = makeSeedTree({
  元数据: {
    回合序号: 2,
    叙事历史: [
      { role: 'user', content: '我环顾四周。' },
      { role: 'assistant', content: '青云城的喧嚣扑面而来，人流如织。', _metrics: { roundNumber: 1, durationMs: 0, inputTokens: 0, outputTokens: 0, startedAt: 0 } },
      { role: 'user', content: '我走向城中心的酒楼。' },
      { role: 'assistant', content: '你推开酒楼的木门，一股酒香扑面。掌柜抬头看你，眼神里藏着某种试探。', _metrics: { roundNumber: 2, durationMs: 0, inputTokens: 0, outputTokens: 0, startedAt: 0 } },
    ],
  },
});

interface SentBody { stream?: boolean; messages?: Array<{ content: unknown }> }

/** Every request body the round sent, in order. */
function fakeModel(page: Page, splitGen: boolean): Promise<SentBody[]> {
  const sent: SentBody[] = [];
  const answer = (route: Route): Promise<void> => {
    const body = JSON.parse(route.request().postData() ?? '{}') as SentBody;
    sent.push(body);
    const reply = !body.stream ? JSON.stringify(TAIL)
      : splitGen ? JSON.stringify({ text: STORY })
      : JSON.stringify({ text: STORY, ...TAIL });
    if (!body.stream) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }) });
    }
    const sse = (reply.match(/[\s\S]{1,16}/g) ?? [])
      .map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  };
  return page.route('http://127.0.0.1:1/**', answer).then(() => sent);
}

async function useFakeModel(page: Page, splitGen: boolean): Promise<SentBody[]> {
  await seedSave(page, { tree: twoRoundTree });
  await page.addInitScript((split) => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-story', name: 'story', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: split, streaming: true, maxRetries: 0 }));
  }, splitGen);
  await page.reload();
  const sent = await fakeModel(page, splitGen);
  await enterSeededGame(page);
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
const timesIn = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

for (const splitGen of [true, false]) {
  test(`${splitGen ? 'split Step 1' : 'single call'}: the page's edit and switch, and the picked bookmark, reach the story`,
    { tag: ['@regression', '@round'] }, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for what a round asks for');
      test.slow();
      const sent = await useFakeModel(page, splitGen);

      // ── The prompt page: edit the style, switch the anti-cliche rules off ──
      await goToGameTab(page, 'prompts');
      await page.getByRole('button', { name: '内置提示词', exact: true }).click();
      await page.getByRole('button', { name: '展开', exact: true }).click();
      // The round's own format cannot be switched off: every round needs it to know what to write.
      for (const id of ['mainRound', 'splitGenStep1']) {
        await expect(page.getByTestId(`prompt-toggle-${id}`)).toBeDisabled();
        await expect(page.getByTestId(`prompt-toggle-${id}`)).toHaveAttribute('aria-checked', 'true');
      }
      // The page shows each click at once (it used to show nothing until a reload, so a second click switched the
      // prompt off again instead of back on).
      const antiCliche = page.getByTestId('prompt-toggle-antiCliche');
      await antiCliche.click();
      await expect(antiCliche).toHaveAttribute('aria-checked', 'false');
      await antiCliche.click();
      await expect(antiCliche).toHaveAttribute('aria-checked', 'true');
      await antiCliche.click();
      await expect(antiCliche).toHaveAttribute('aria-checked', 'false');
      const styleCard = page.locator('.prompt-card').filter({ has: page.getByTestId('prompt-toggle-writeStyle') });
      await styleCard.locator('.prompt-title-area').click();
      await page.locator('.prompt-editor').fill(EDITED_STYLE);
      await page.getByRole('button', { name: '保存修改' }).click();
      await expect(styleCard.locator('.modified-badge')).toBeVisible();
      // Opened again, it shows what was saved, not the pack's text.
      await styleCard.locator('.prompt-title-area').click();
      await expect(page.locator('.prompt-editor')).toHaveValue(EDITED_STYLE);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.locator('.prompt-editor')).toHaveCount(0);

      // ── Bookmark round 2 and pick it for the next round ──
      await goToGameTab(page, '');
      await page.getByTestId('round-bookmark-btn').first().click();
      await page.getByTestId('bookmark-toggle').click();
      await page.getByTestId('bookmark-row').locator('.bookmark-check').check();
      await expect(page.locator('.bookmark-selcount')).toContainText('已选 1 条');
      await page.getByTestId('bookmark-toggle').click();
      await expect(page.getByTestId('bookmark-panel')).toHaveCount(0);

      // ── One round ──
      const before = (await engineNow(page)).round;
      await page.locator('.message-input').fill('我坐下来，要了一壶酒。');
      await page.locator('.send-btn').click();
      await expect.poll(() => engineNow(page), { timeout: 60_000 }).toEqual({ round: before + 1, busy: false });
      await expect(page.getByText(STORY).first()).toBeVisible();

      // The story request is the round's first streamed one (split Step 2 asks without streaming).
      const story = textOf(sent.find((b) => b.stream));
      expect(story).toContain(EDITED_STYLE);
      expect(story).not.toContain(PACK_STYLE);
      expect(story).not.toContain(PACK_ANTI_CLICHE);
      expect(story).toContain('玩家收藏的历史片段');
      expect(timesIn(story, BOOKMARK_LABEL)).toBe(1);
      // The format prompt no longer opens with a context section the story request cannot fill (it rendered empty).
      expect(story).toContain(FORMAT_LINE);
      expect(story).not.toContain('# 主回合上下文');
      if (splitGen) {
        // Step 1 writes only the story; Step 2 reads the page, the bookmarks, the jailbreak and the protocol as before.
        expect(story).not.toContain(CORE_HEADING);
        const step2 = textOf(sent.find((b) => !b.stream));
        expect(step2).toContain(BOOKMARK_LABEL);
        expect(step2).toContain(JAILBREAK_HEADING);
        expect(step2).toContain(CORE_HEADING);
      } else {
        // P13: a single call writes the commands too — the jailbreak opens it, the protocol precedes the format.
        expect(story).toContain(JAILBREAK_HEADING);
        expect(story.indexOf(JAILBREAK_HEADING)).toBeLessThan(story.indexOf(CORE_HEADING));
        expect(story.indexOf(CORE_HEADING)).toBeLessThan(story.indexOf(FORMAT_LINE));
      }

      // The pick was for one round: it is cleared once the round is done.
      await page.getByTestId('bookmark-toggle').click();
      await expect(page.locator('.bookmark-selcount')).toContainText('已选 0 条');
      await expect(page.getByTestId('bookmark-row').locator('.bookmark-check')).not.toBeChecked();
    });
}

// Code review H2/M1/M2 (2026-10-04): a switch that decides nothing is not offered, and a save without a change is no
// edit (kept, it would freeze the pack's text of today and travel in cards).
test('the prompt page locks the switches that decide nothing, and a save without a change stores nothing',
  { tag: ['@regression', '@prompts'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for the prompt page');
    await seedSave(page);
    await enterSeededGame(page);
    await goToGameTab(page, 'prompts');
    await page.getByRole('button', { name: '内置提示词', exact: true }).click();
    await page.getByRole('button', { name: '展开', exact: true }).click();
    // Every round needs these: on, locked.
    for (const id of ['mainRound', 'splitGenStep1', 'splitGenStep2', 'splitGenStep2Followup', 'wordCountReq']) {
      await expect(page.getByTestId(`prompt-toggle-${id}`)).toBeDisabled();
      await expect(page.getByTestId(`prompt-toggle-${id}`)).toHaveAttribute('aria-checked', 'true');
    }
    // A setting chooses these (second person by default): they show the choice, locked.
    await expect(page.getByTestId('prompt-toggle-perspectiveSecond')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('prompt-toggle-perspectiveFirst')).toHaveAttribute('aria-checked', 'false');
    for (const id of ['perspectiveFirst', 'perspectiveSecond', 'storyStyleGeneral']) {
      await expect(page.getByTestId(`prompt-toggle-${id}`)).toBeDisabled();
    }
    // An ordinary prompt keeps its switch.
    await expect(page.getByTestId('prompt-toggle-jailbreak')).toBeEnabled();
    // Opened and saved without a change: no edit.
    const card = page.locator('.prompt-card').filter({ has: page.getByTestId('prompt-toggle-jailbreak') });
    await card.locator('.prompt-title-area').click();
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('.prompt-editor')).toHaveCount(0);
    await expect(card.locator('.modified-badge')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('aga_prompt_tianming_jailbreak'))).toBeNull();
    // An always-on prompt emptied is still sent as the pack's text: saving it empty is a reset, not an edit.
    const format = page.locator('.prompt-card').filter({ has: page.getByTestId('prompt-toggle-mainRound') });
    await format.locator('.prompt-title-area').click();
    await page.locator('.prompt-editor').fill('');
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('.prompt-editor')).toHaveCount(0);
    await expect(format.locator('.modified-badge')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('aga_prompt_tianming_mainRound'))).toBeNull();
  });
