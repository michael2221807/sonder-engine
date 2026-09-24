import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

for (const preserveDraft of [false, true]) test(`successful regeneration clears only the submitted input, preserveDraft=${preserveDraft}`, async ({ page }) => {
  await seedSave(page); await enterSeededGame(page);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { writePlotVectorControl } = await load('/src/engine/plot-vector/feature-control.ts');
    const { eventBus } = await load('/src/engine/core/event-bus.ts');
    writePlotVectorControl(true);
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    const orchestrator = app.__vue_app__._context.provides.gameOrchestrator as { runner: { run: () => Promise<unknown> } };
    let count = 0;
    // Synthetic completion tests composer state only; no claim of an actual save.
    orchestrator.runner.run = async () => {
      if (++count === 1) throw new Error('测试失败');
      eventBus.emit('engine:round-complete', { actionOptions: [] });
      return null;
    };
    eventBus.emit('pipeline:user-input', { text: '原输入' });
  });
  await expect(page.getByTestId('regenerate-round')).toBeVisible();
  const input = page.locator('textarea.message-input');
  await input.fill(preserveDraft ? '留给下一轮的新草稿' : '原输入');
  await page.getByTestId('regenerate-round').click();
  await expect(page.getByTestId('round-recovery')).toBeHidden();
  await expect(input).toHaveValue(preserveDraft ? '留给下一轮的新草稿' : '');
});

test('failed round offers a visible single-use regeneration action with the unchanged input', async ({ page }) => {
  await seedSave(page); await enterSeededGame(page);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { writePlotVectorControl } = await load('/src/engine/plot-vector/feature-control.ts');
    const { eventBus } = await load('/src/engine/core/event-bus.ts');
    writePlotVectorControl(true);
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    const orchestrator = app.__vue_app__._context.provides.gameOrchestrator as {
      runner: { run: (ctx: { userInput: string; meta: { plotVectorRequestAttempt?: string } }) => Promise<never> };
    };
    const calls: Array<{ input: string; attempt?: string }> = [];
    // Synthetic pipeline failure: tests orchestration + UI, not model quality or state compilation.
    orchestrator.runner.run = async ctx => {
      calls.push({ input: ctx.userInput, attempt: ctx.meta.plotVectorRequestAttempt });
      document.documentElement.dataset.retryCalls = JSON.stringify(calls);
      throw new Error('测试：状态结果缺失');
    };
    eventBus.emit('pipeline:user-input', { text: '保持这句原输入' });
  });
  const notice = page.getByTestId('round-recovery');
  await expect(notice).toContainText('本回合未完成');
  await expect(notice).toContainText('可能产生新的费用');
  await page.waitForTimeout(5500);
  await expect(notice).toBeVisible();
  await page.getByTestId('regenerate-round').click();
  await expect(page.getByTestId('regenerate-round')).toBeDisabled();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-retry-calls') ?? '[]').length).toBe(2);
  const calls = JSON.parse(await page.locator('html').getAttribute('data-retry-calls') ?? '[]');
  expect(calls.map((x: {input: string}) => x.input)).toEqual(['保持这句原输入', '保持这句原输入']);
  expect(calls[0].attempt).toBeUndefined(); expect(calls[1].attempt).toBeTruthy();
  await notice.screenshot({ path: 'e2e/screenshots/plot-vector-round-retry.png' });
  await page.evaluate(async () => {
    const path = '/src/ui/i18n/index.ts';
    const { setI18nLocale } = await import(/* @vite-ignore */ path);
    await setI18nLocale('en');
  });
  await expect(page.getByTestId('regenerate-round')).toHaveText('Regenerate this round');
  await page.getByTestId('mode-toggle').click();
  await expect(notice).toBeHidden();
});
