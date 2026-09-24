import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

for (const enabled of [false, true]) test(`settings cannot save an unfinished round, vector=${enabled}`,
  { tag: ['@save', '@story-d173'] }, async ({ page, gameShell, plotVector }, testInfo) => {
  await seedSave(page); await enterSeededGame(page);
  const baseline = await page.evaluate(async enabled => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { writePlotVectorControl } = await load('/src/engine/plot-vector/feature-control.ts');
    const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
    const { eventBus } = await load('/src/engine/core/event-bus.ts');
    const { DEFAULT_ENGINE_PATHS: paths } = await load('/src/engine/pipeline/types.ts');
    writePlotVectorControl(enabled);
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    const host = app.__vue_app__._context.provides.gameOrchestrator as {
      isBusy: boolean; runner: { stages: Array<{ name: string; execute: () => Promise<never> }> };
      _stateManager: { get: (path: string) => number };
    };
    if (host.isBusy) throw new Error('fixture must be idle');
    const root = await idbAdapter.get('storage_root');
    const { profileId, slotId } = root.activeProfile;
    const tree = await idbAdapter.get(`save_${profileId}_${slotId}`);
    // Only suspend the unavailable AI boundary. Real PreProcess, orchestrator,
    // settings, save queue, rollback and IndexedDB all remain in use.
    const ai = host.runner.stages.find(stage => stage.name === 'AICall');
    if (!ai) throw new Error('AI stage missing');
    ai.execute = async () => {
      document.documentElement.dataset.waitingRound = String(host._stateManager.get(paths.roundNumber));
      await new Promise<void>(resolve => {
        (window as unknown as { releaseRound: () => void }).releaseRound = resolve;
      });
      throw new Error('offline interrupted request');
    };
    eventBus.emit('pipeline:user-input', { text: '离线保存边界测试' });
    return { round: tree.元数据.回合序号, history: tree.元数据.叙事历史?.length ?? 0 };
  }, enabled);
  await expect(page.locator('html')).toHaveAttribute('data-waiting-round', String(baseline.round + 1));
  await gameShell.goTab('settings');
  const stored = () => page.evaluate(async () => {
    const path = '/src/engine/persistence/idb-adapter.ts';
    const { idbAdapter } = await import(/* @vite-ignore */ path);
    const { activeProfile: { profileId, slotId } } = await idbAdapter.get('storage_root');
    const tree = await idbAdapter.get(`save_${profileId}_${slotId}`);
    return { round: tree.元数据.回合序号, history: tree.元数据.叙事历史?.length ?? 0 };
  });
  // Observe the queue directly: the mounted settings page issued its save request.
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    return !!(app.__vue_app__._context.provides.gameOrchestrator as { pendingSave: unknown }).pendingSave;
  })).toBe(true);
  expect(await stored()).toEqual(baseline);
  if (enabled) {
    await plotVector.toggleFeature();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    expect(await stored()).toEqual(baseline);
  }
  await page.evaluate(() => (window as unknown as { releaseRound: () => void }).releaseRound());
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    return (app.__vue_app__._context.provides.gameOrchestrator as { isBusy: boolean }).isBusy;
  })).toBe(false);
  expect(await stored()).toEqual(baseline);
  await page.reload();
  await enterSeededGame(page);
  expect(await stored()).toEqual(baseline);
  await testInfo.attach('persistence-check', { body: JSON.stringify({ enabled, baseline, reloaded: await stored() }), contentType: 'application/json' });
});
