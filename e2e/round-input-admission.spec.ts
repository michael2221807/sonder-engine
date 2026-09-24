import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

test('busy submissions keep the draft; only an accepted submission clears it',
  { tag: ['@save', '@story-d174'] }, async ({ page, gameShell }) => {
    await seedSave(page); await enterSeededGame(page);
    await page.evaluate(async () => {
      const path = '/src/engine/core/event-bus.ts';
      const { eventBus } = await import(/* @vite-ignore */ path);
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      const host = app.__vue_app__._context.provides.gameOrchestrator as {
        _subPipelineActive: boolean; runner: { run: () => Promise<null> };
      };
      host._subPipelineActive = true;
      // Admission/UI only: no model, compilation or persistence is claimed here.
      host.runner.run = async () => {
        document.documentElement.dataset.acceptedInput = 'yes';
        eventBus.emit('engine:round-start');
        eventBus.emit('engine:round-complete', { actionOptions: [] });
        return null;
      };
    });
    await gameShell.send('这句输入不能丢失');
    await expect(gameShell.composer).toHaveValue('这句输入不能丢失');
    await expect(page.getByText('上一项操作仍在收尾，输入已保留，请稍后发送。', { exact: true })).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-accepted-input', 'yes');
    await page.evaluate(() => {
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      (app.__vue_app__._context.provides.gameOrchestrator as { _subPipelineActive: boolean })._subPipelineActive = false;
    });
    await gameShell.send('这句输入不能丢失');
    await expect(page.locator('html')).toHaveAttribute('data-accepted-input', 'yes');
    await expect(gameShell.composer).toHaveValue('');
  });
