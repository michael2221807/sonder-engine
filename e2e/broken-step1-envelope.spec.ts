/**
 * A split-gen round whose step1 JSON cannot be parsed still shows the story, not its JSON source (ZERO real API).
 *
 * PO trial 2026-10-02: the narrative of a round began with `{"text":"` and every quote read `\"`. Step1's reply
 * had an unparseable envelope and the raw reply became the story (split-gen step1 has no repair stage). The
 * fake model here answers on loopback: step1 (streamed) with an envelope cut off before its closing quote,
 * step2 with valid structure.
 *
 * Run: npx playwright test broken-step1-envelope
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import type { Page, Route } from '@playwright/test';

const STEP1 = String.raw`{"text":"【玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，\"嗡\"地，白了半分。\n\n压进\"教养\"那两个字里。`;
const STEP2 = JSON.stringify({ commands: [], action_options: ['走', '停', '回头'], mid_term_memory: null, knowledge_facts: [] });

function answer(route: Route, step1 = STEP1): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}') as { stream?: boolean };
  if (!body.stream) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: STEP2 } }] }) });
  }
  const pieces = step1.match(/[\s\S]{1,12}/g) ?? [];
  const sse = pieces.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
}

test('a broken step1 envelope shows the story with plain quotes', { tag: ['@regression', '@round'] }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a parser path');
  test.slow();
  await seedSave(page);
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-envelope', name: 'envelope', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, streaming: true, maxRetries: 0 }));
  });
  await page.reload();
  await page.route('http://127.0.0.1:1/**', route => answer(route));
  await enterSeededGame(page);

  await page.locator('.message-input').fill('我跟着他往电梯走。');
  await page.locator('.send-btn').click();

  const story = page.getByText('你那颗脑子，"嗡"地，白了半分。').first();
  await expect(story).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('压进"教养"那两个字里。').first()).toBeVisible();
  // The round is finished (the stream bubble is gone) and what stays on screen has no JSON source.
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    return (app.__vue_app__._context.provides.gameOrchestrator as { isBusy: boolean }).isBusy;
  }), { timeout: 60_000 }).toBe(false);
  const shown = await page.locator('body').innerText();
  expect(shown).toContain('你那颗脑子，"嗡"地，白了半分。');
  expect(shown).not.toContain('{"text"');
  expect(shown).not.toContain('\\"');

  // What is saved is the story too.
  const saved = await page.evaluate(async () => {
    const path = '/src/engine/persistence/idb-adapter.ts';
    const { idbAdapter } = await import(/* @vite-ignore */ path);
    const { activeProfile: { profileId, slotId } } = await idbAdapter.get('storage_root');
    const tree = await idbAdapter.get(`save_${profileId}_${slotId}`);
    const history = tree.元数据.叙事历史 as Array<{ role: string; content: string; _rawResponse?: string }>;
    return history.filter(e => e.role === 'assistant').at(-1);
  });
  expect(saved?.content).toBe('【玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，"嗡"地，白了半分。\n\n压进"教养"那两个字里。');
  expect(saved?._rawResponse).toBe(STEP1);
});

/** The story of a round as the game shows it and as the save holds it. */
async function lastStory(page: Page): Promise<{ shown: string; saved: string | undefined }> {
  const shown = await page.locator('body').innerText();
  const saved = await page.evaluate(async () => {
    const path = '/src/engine/persistence/idb-adapter.ts';
    const { idbAdapter } = await import(/* @vite-ignore */ path);
    const { activeProfile: { profileId, slotId } } = await idbAdapter.get('storage_root');
    const tree = await idbAdapter.get(`save_${profileId}_${slotId}`);
    const history = tree.元数据.叙事历史 as Array<{ role: string; content: string }>;
    return history.filter(e => e.role === 'assistant').at(-1)?.content;
  });
  return { shown, saved };
}

// PO 2026-10-03, round 128: the CoT protocol asks for <正文>, the format for JSON; the model wrapped the whole
// reply in the tag (quotes unescaped, line breaks raw) and the story began with `{"text":"`.
const TAGGED = '<正文>{"text":"【楼道那盏声控灯，在你踩上最后一级台阶时，又"啪"地熄了。】\n\n你轻手轻脚地，推开了寝室那扇门。"}</正文>';
const TAGGED_STORY = '【楼道那盏声控灯，在你踩上最后一级台阶时，又"啪"地熄了。】\n\n你轻手轻脚地，推开了寝室那扇门。';

test('a step1 reply wrapped whole in <正文> shows its story, not the JSON', { tag: ['@regression', '@round'] }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a parser path');
  test.slow();
  await seedSave(page);
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-envelope', name: 'envelope', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, streaming: true, maxRetries: 0 }));
  });
  await page.reload();
  await page.route('http://127.0.0.1:1/**', route => answer(route, TAGGED));
  await enterSeededGame(page);
  await page.locator('.message-input').fill('我回到寝室。');
  await page.locator('.send-btn').click();
  await expect(page.getByText('你轻手轻脚地，推开了寝室那扇门。').first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    return (app.__vue_app__._context.provides.gameOrchestrator as { isBusy: boolean }).isBusy;
  }), { timeout: 60_000 }).toBe(false);
  const { shown, saved } = await lastStory(page);
  expect(shown).toContain('又"啪"地熄了。');
  expect(shown).not.toContain('{"text"');
  expect(shown).not.toContain('<正文>');
  expect(saved).toBe(TAGGED_STORY);
});

test('a round saved as its envelope before the fix is healed when the game loads', { tag: ['@regression', '@save'] }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a load-time repair');
  const broken = TAGGED.replace('<正文>', '').replace('</正文>', '');
  await seedSave(page, { tree: makeSeedTree({ 元数据: { 叙事历史: [
    { role: 'user', content: '我回到寝室。' },
    { role: 'assistant', content: broken, _rawResponse: TAGGED },
  ] }, 记忆: { 短期: [{ round: 3, summary: broken, timestamp: 1 }] } }) });
  await enterSeededGame(page);
  await expect(page.getByText('你轻手轻脚地，推开了寝室那扇门。').first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('{"text"');
  // The live game holds the healed story (and memory); the raw reply is kept as it was.
  const live = await page.evaluate(() => {
    type App = { config: { globalProperties: { $pinia: { _s: Map<string, { tree: Record<string, unknown> }> } } } };
    const app = (document.querySelector('#app') as { __vue_app__?: App } | null)?.__vue_app__;
    const tree = app?.config.globalProperties.$pinia._s.get('engineState')?.tree as
      { 元数据: { 叙事历史: Array<{ content: string; _rawResponse?: string }> }; 记忆: { 短期: Array<{ summary: string }> } };
    const last = tree.元数据.叙事历史.at(-1);
    return { content: last?.content, raw: last?._rawResponse, memory: tree.记忆.短期.at(-1)?.summary };
  });
  expect(live).toEqual({ content: TAGGED_STORY, raw: TAGGED, memory: TAGGED_STORY });
});

// 2026-10-03 release check (real replies). Round 2: the CoT protocol's own shape — the tags and the planning blocks
// after the story streamed into the bubble and stayed there while step 2 ran. Round 3: the reply wrapped in <正文>
// with its story escaped twice — `\"` and `\n` on screen and in the save.
const COT_STEP1 = `<thinking>先把这一回合想清楚。</thinking>\n\n<正文>\n${TAGGED_STORY}\n</正文>\n\n<短期记忆>\n记下这一夜。\n</短期记忆>\n\n<变量规划>\n锚点+2\n</变量规划>\n\n<剧情规划>\n- 保留：会诊\n</剧情规划>`;
const ONCE = JSON.stringify(TAGGED_STORY).slice(1, -1);
const TWICE_STEP1 = `<正文>\n${JSON.stringify({ text: ONCE })}\n</正文>\n\n<短期记忆>\n记下这一夜。\n</短期记忆>`;

/** Step 2 waits a while, so the bubble can be read as it stands between the two steps. */
async function answerSlowStep2(route: Route, step1: string): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}') as { stream?: boolean };
  if (!body.stream) await new Promise(resolve => setTimeout(resolve, 4000));
  return answer(route, step1);
}

for (const [name, step1] of [['the CoT protocol shape', COT_STEP1], ['a story escaped twice in the tag', TWICE_STEP1]] as const) {
  test(`${name}: the bubble and the round show only the story`, { tag: ['@regression', '@round'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a parser path');
    test.slow();
    await seedSave(page);
    await page.addInitScript(() => {
      localStorage.setItem('aga_api_management', JSON.stringify({
        apiConfigs: [{ id: 'e2e-envelope', name: 'envelope', apiCategory: 'llm', provider: 'openai',
          url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
        apiAssignments: [],
      }));
      const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
      localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, streaming: true, maxRetries: 0 }));
    });
    await page.reload();
    await page.route('http://127.0.0.1:1/**', route => answerSlowStep2(route, step1));
    await enterSeededGame(page);
    await page.locator('.message-input').fill('我回到寝室。');
    await page.locator('.send-btn').click();

    // Step 1 is in, step 2 is still out: the bubble holds the whole story and nothing else.
    const bubble = page.locator('.message--streaming .message-text');
    await expect(bubble).toContainText('你轻手轻脚地，推开了寝室那扇门。', { timeout: 60_000 });
    const live = await bubble.innerText();
    expect(live).toContain('又"啪"地熄了。');
    for (const leak of ['<正文>', '</正文>', '短期记忆', '记下这一夜', '剧情规划', '\\"', '\\n', '{"text"']) expect(live).not.toContain(leak);

    await expect.poll(() => page.evaluate(() => {
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      return (app.__vue_app__._context.provides.gameOrchestrator as { isBusy: boolean }).isBusy;
    }), { timeout: 60_000 }).toBe(false);
    const { shown, saved } = await lastStory(page);
    expect(shown).toContain('又"啪"地熄了。');
    for (const leak of ['<正文>', '记下这一夜', '\\"', '{"text"']) expect(shown).not.toContain(leak);
    expect(saved).toBe(TAGGED_STORY);
  });
}

test('a round saved still escaped once is healed when the game loads', { tag: ['@regression', '@save'] }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a load-time repair');
  await seedSave(page, { tree: makeSeedTree({ 元数据: { 叙事历史: [
    { role: 'user', content: '我回到寝室。' },
    { role: 'assistant', content: ONCE, _rawResponse: TWICE_STEP1 },
  ] } }) });
  await enterSeededGame(page);
  await expect(page.getByText('你轻手轻脚地，推开了寝室那扇门。').first()).toBeVisible();
  const shown = await page.locator('body').innerText();
  expect(shown).toContain('又"啪"地熄了。');
  expect(shown).not.toContain('\\"');
  const live = await page.evaluate(() => {
    type App = { config: { globalProperties: { $pinia: { _s: Map<string, { tree: Record<string, unknown> }> } } } };
    const app = (document.querySelector('#app') as { __vue_app__?: App } | null)?.__vue_app__;
    const tree = app?.config.globalProperties.$pinia._s.get('engineState')?.tree as
      { 元数据: { 叙事历史: Array<{ content: string; _rawResponse?: string }> } };
    const last = tree.元数据.叙事历史.at(-1);
    return { content: last?.content, raw: last?._rawResponse };
  });
  expect(live).toEqual({ content: TAGGED_STORY, raw: TWICE_STEP1 });
});
