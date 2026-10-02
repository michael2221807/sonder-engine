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
import type { Route } from '@playwright/test';

const STEP1 = String.raw`{"text":"【玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，\"嗡\"地，白了半分。\n\n压进\"教养\"那两个字里。`;
const STEP2 = JSON.stringify({ commands: [], action_options: ['走', '停', '回头'], mid_term_memory: null, knowledge_facts: [] });

function answer(route: Route): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}') as { stream?: boolean };
  if (!body.stream) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: STEP2 } }] }) });
  }
  const pieces = STEP1.match(/[\s\S]{1,12}/g) ?? [];
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
  await page.route('http://127.0.0.1:1/**', answer);
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
