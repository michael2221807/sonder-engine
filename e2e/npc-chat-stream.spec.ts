/**
 * A private chat streams the NPC's words, not the JSON reply being written (ZERO real API).
 *
 * 2026-10-03 release check: a private chat's reply is a JSON object with the words under `text` (npcChat format),
 * and the chat streamed it as it came — the bubble showed `{"text":"…` while the NPC answered. The fake model here
 * streams such a reply; a MutationObserver records every text an NPC bubble shows, so even a brief state is caught.
 *
 * Run: npx playwright test npc-chat-stream
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';

const WORDS = '【她揉了揉眼睛】"还好……就是脸还有点胀。"';
const REPLY = JSON.stringify({ text: WORDS, commands: [] });

test('a private chat streams the NPC\'s words, never the JSON reply', { tag: ['@regression'] }, async ({ page, gameShell }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a stream');
  await seedSave(page, { tree: makeSeedTree({ 社交: { 关系: [
    { 名称: '林婉儿', 类型: '友人', 好感度: 40, 是否在场: true, 性别: '女', 描述: '同寝的室友。', 记忆: [], 私聊历史: [] },
  ] } }) });
  await page.addInitScript(() => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-chat', name: 'chat', apiCategory: 'llm', provider: 'openai',
        url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop', temperature: 0, maxTokens: 1000, enabled: true }],
      apiAssignments: [],
    }));
    const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, streaming: true, maxRetries: 0 }));
  });
  await page.reload();
  await page.route('http://127.0.0.1:1/**', (route) => {
    const pieces = REPLY.match(/[\s\S]{1,6}/g) ?? [];
    const sse = pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  await enterSeededGame(page);
  await gameShell.goTab('relationships');
  await page.locator('.roster-list .rc', { hasText: '林婉儿' }).click();
  await page.locator('.rd-action-btn', { hasText: '私聊' }).click();
  const modal = page.locator('.npc-chat-modal');
  await modal.waitFor({ state: 'visible' });

  // Every text an NPC bubble shows from here on, the streaming one included.
  await page.evaluate(() => {
    const w = window as unknown as { __bubbles: string[] };
    w.__bubbles = [];
    const root = document.querySelector('.npc-chat-modal');
    if (!root) return;
    new MutationObserver(() => {
      for (const bubble of root.querySelectorAll('.chat-message--npc .chat-bubble')) w.__bubbles.push((bubble as HTMLElement).innerText);
    }).observe(root, { subtree: true, childList: true, characterData: true });
  });
  await modal.locator('.chat-textarea').fill('你还好吗？');
  await modal.locator('.btn-send').click();
  await expect(modal.locator('.chat-message--npc .chat-bubble').last()).toContainText('还好……就是脸还有点胀。');
  await expect(modal.locator('.btn-send')).toHaveText('发送');

  const seen = await page.evaluate(() => (window as unknown as { __bubbles: string[] }).__bubbles.filter(Boolean));
  expect(seen.length).toBeGreaterThan(0);
  for (const text of seen) {
    expect(text).not.toContain('{"text"');
    expect(text).not.toContain('"commands"');
  }
  expect(seen.at(-1)).toContain('还好……就是脸还有点胀。');
});
