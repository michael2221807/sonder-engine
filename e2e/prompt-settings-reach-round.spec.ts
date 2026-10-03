/**
 * The 「提示词与世界书管理」 settings reach the next round (ZERO real API).
 *
 * PO trial 2026-10-03: with 2500 words and action options off, the next round still wrote the old length and still
 * offered options; the 剧情/行动 and 快速/慢速 choices had no effect either. The format prompts had a fixed
 * "500-1500字", the switch only changed a builder module that the options modules then contradicted, and the
 * prompt page kept its own mode and pace that nothing read. The fake model answers on loopback and keeps every
 * request it is sent, so the test reads what the round really asked for.
 *
 * Run: npx playwright test prompt-settings-reach-round
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { goToGameTab } from './fixtures/navigation';
import type { Page, Route } from '@playwright/test';

const STORY = '雨从檐角落下，他把伞往你那边偏了一点。';
const OPTIONS = ['走', '停', '回头'];
const TAIL = { commands: [], action_options: OPTIONS, mid_term_memory: null, knowledge_facts: [] };

/** Every request body the round sent, in order. */
function fakeModel(page: Page, splitGen: boolean): Promise<string[]> {
  const sent: string[] = [];
  const answer = (route: Route): Promise<void> => {
    const raw = route.request().postData() ?? '{}';
    sent.push(raw);
    const body = JSON.parse(raw) as { stream?: boolean };
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

async function useFakeModel(page: Page, splitGen: boolean): Promise<string[]> {
  await seedSave(page);
  await page.addInitScript((split) => {
    localStorage.setItem('aga_api_management', JSON.stringify({
      apiConfigs: [{ id: 'e2e-settings', name: 'settings', apiCategory: 'llm', provider: 'openai',
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

async function openSettingsTab(page: Page): Promise<void> {
  await goToGameTab(page, 'prompts');
  await page.getByRole('button', { name: '游戏设定' }).click();
}

async function pick(page: Page, testId: string, option: string): Promise<void> {
  await page.getByTestId(testId).locator('.aga-select__trigger').click();
  await page.getByRole('option', { name: option }).click();
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

/** Send one round and wait until it is counted and the engine is free again. */
async function playRound(page: Page, text: string): Promise<void> {
  await goToGameTab(page, '');
  const before = (await engineNow(page)).round;
  await page.locator('.message-input').fill(text);
  await page.locator('.send-btn').click();
  await expect.poll(() => engineNow(page), { timeout: 60_000 }).toEqual({ round: before + 1, busy: false });
  await expect(page.getByText(STORY).first()).toBeVisible();
}

const shownOptions = (page: Page) => page.locator('.action-options');

for (const splitGen of [true, false]) {
  test(`${splitGen ? 'split' : 'single-call'}: word count and the options switch, mode and pace reach the round`,
    { tag: ['@regression', '@round'] }, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for what a round asks for');
      test.slow();
      const sent = await useFakeModel(page, splitGen);

      // 2500 words, options off.
      await openSettingsTab(page);
      const words = page.locator('input.settings-input[type="number"]');
      await words.fill('2500');
      await words.blur();
      const optionsSwitch = page.getByRole('switch', { name: '启用行动选项生成' });
      await expect(optionsSwitch).toHaveAttribute('aria-checked', 'true');
      await optionsSwitch.click();
      await expect(optionsSwitch).toHaveAttribute('aria-checked', 'false');
      // Off hides the style choices: they would do nothing.
      await expect(page.getByTestId('prompt-action-mode')).toHaveCount(0);

      await playRound(page, '我接过伞。');
      let asked = sent.join('\n');
      expect(asked).toContain('2500字以上');
      expect(asked).not.toContain('500-1500');
      expect(asked).not.toContain('650字以上');
      expect(asked).toContain('玩家关闭了行动选项');
      expect(asked).not.toContain('# 行动选项规范');
      // The model offered options anyway; none are shown.
      await expect(shownOptions(page)).toHaveCount(0);

      // On again, story-led and slow: the round asks for that.
      await openSettingsTab(page);
      await optionsSwitch.click();
      await expect(optionsSwitch).toHaveAttribute('aria-checked', 'true');
      await pick(page, 'prompt-action-mode', '剧情导向');
      await pick(page, 'prompt-action-pace', '慢节奏');
      // One setting for the device: the settings page reads the same choice.
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aga_action_options_settings') ?? '{}')))
        .toMatchObject({ mode: 'story', pace: 'slow' });

      sent.length = 0;
      await playRound(page, '我们沿着河走。');
      asked = sent.join('\n');
      expect(asked).toContain('2500字以上');
      expect(asked).toContain('剧情导向模式');
      expect(asked).toContain('当前节奏为**慢节奏**');
      expect(asked).not.toContain('当前节奏为**快节奏**');
      expect(asked).not.toContain('玩家关闭了行动选项');
      await expect(shownOptions(page)).toBeVisible();
      for (const option of OPTIONS) await expect(shownOptions(page).getByText(option, { exact: true })).toBeVisible();

      // Action-led and fast again: the other module and the other pace.
      await openSettingsTab(page);
      await pick(page, 'prompt-action-mode', '行动导向');
      await pick(page, 'prompt-action-pace', '快节奏');
      sent.length = 0;
      await playRound(page, '我停下脚步。');
      asked = sent.join('\n');
      expect(asked).toContain('# 行动选项规范（启用时生效）');
      expect(asked).not.toContain('剧情导向模式');
      expect(asked).not.toContain('当前节奏为**慢节奏**');

      // Off again: the options on screen leave at once, before any new round, and the settings page says why.
      await expect(shownOptions(page)).toBeVisible();
      await openSettingsTab(page);
      await optionsSwitch.click();
      await expect(optionsSwitch).toHaveAttribute('aria-checked', 'false');
      await goToGameTab(page, '');
      await expect(page.getByText(STORY).first()).toBeVisible();
      await expect(shownOptions(page)).toHaveCount(0);
      await goToGameTab(page, 'settings');
      await expect(page.getByTestId('settings-action-off-note')).toBeVisible();
    });
}

test('the settings page shows the choice made on the prompt page, and keeps pace in story mode',
  { tag: ['@regression'] }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'one viewport is enough for a shared setting');
    await seedSave(page);
    await page.reload();
    await enterSeededGame(page);
    await openSettingsTab(page);
    await pick(page, 'prompt-action-mode', '剧情导向');
    await pick(page, 'prompt-action-pace', '慢节奏');
    // The game itself carries the choice, where the round reads it.
    expect(await page.evaluate(() => {
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      const sm = app.__vue_app__._context.provides.stateManager as { get: (p: string) => unknown };
      return sm.get('系统.actionOptions');
    })).toMatchObject({ mode: 'story', pace: 'slow' });

    // The settings page shows that choice, and its pace row stays in story mode (it used to show only for action-led).
    await goToGameTab(page, 'settings');
    const section = page.locator('#settings-action');
    await expect(section.locator('input[type="radio"][value="story"]')).toBeChecked();
    await expect(section.locator('input[type="radio"][value="slow"]')).toBeChecked();
    await expect(section.locator('input[type="radio"][value="slow"]')).toBeVisible();
  });
