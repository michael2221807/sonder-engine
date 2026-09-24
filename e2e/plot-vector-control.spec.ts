import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

test('actual main-round failure with no API rolls back vector state and remains usable',
  { tag: ['@plot-vector', '@story-d144'] }, async ({ page, gameShell, plotVector }) => {
    await seedSave(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await plotVector.toggleFeature(); await gameShell.goTab('');
    await page.evaluate(async () => {
      const path = '/src/engine/core/event-bus.ts';
      const { eventBus } = await import(/* @vite-ignore */ path);
      let starts = 0;
      eventBus.on('engine:round-start', () => { document.documentElement.dataset.vectorRoundStarts = String(++starts); });
      eventBus.once('engine:round-start', () => eventBus.emit('pipeline:user-input', { text: 'duplicate input event' }));
      eventBus.once('engine:round-error', (event: {stage: string; error: Error}) => {
        document.documentElement.dataset.vectorRoundFailed = 'true';
        document.documentElement.dataset.vectorFailureStage = event.stage;
        document.documentElement.dataset.vectorFailureReason = event.error.message;
      });
    });
    await gameShell.send('静静观察周围。');
    await expect(page.locator('html')).toHaveAttribute('data-vector-round-failed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-vector-round-starts', '1');
    await expect(page.locator('html')).toHaveAttribute('data-vector-failure-stage', 'AICall');
    await expect(page.locator('html')).toHaveAttribute('data-vector-failure-reason', /API/);
    await expect(gameShell.composer).toBeEnabled();
    await gameShell.goTab('settings'); await plotVector.toggleFeature();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    const state = await page.evaluate(async () => {
      const path = '/src/engine/stores/engine-state.ts';
      const { useEngineStateStore } = await import(/* @vite-ignore */ path);
      return useEngineStateStore().tree;
    });
    expect(state.系统.扩展.plotVector.session.round).toBe(1);
    expect(state.系统.扩展.plotVector.tasks).toEqual([]);
  });

test('local AGA control defaults off, survives refresh and disables without deleting saved data',
  { tag: ['@plot-vector', '@story-d144'] }, async ({ page, gameShell, plotVector }) => {
    await seedSave(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await expect(plotVector.control).toBeVisible();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    await plotVector.toggleFeature();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await enterSeededGame(page); await gameShell.goTab('settings');
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'true');
    await plotVector.toggleFeature();
    await expect(plotVector.toggle).toHaveAttribute('aria-checked', 'false');
    await expect(plotVector.control).toContainText('保留已有卡牌');
    const kept = await page.evaluate(async () => {
      const path = '/src/engine/persistence/idb-adapter.ts';
      const { idbAdapter } = await import(/* @vite-ignore */ path);
      const root = await idbAdapter.get('storage_root');
      const { profileId, slotId } = root.activeProfile;
      return (await idbAdapter.get(`save_${profileId}_${slotId}`)).系统.扩展.plotVector;
    });
    expect(kept).toMatchObject({ version: 1, cards: [], session: { round: 1 } });
    await page.screenshot({ path: 'e2e/screenshots/plot-vector-control.png' });
  });

test('real Worker and guarded IndexedDB commit support saved abilities without a model call',
  { tag: ['@plot-vector', '@story-d144'] }, async ({ page }) => {
    await seedSave(page);
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { VectorWorkerClient } = await load('/src/features/plot-vector/worker-client.ts');
      const { initialVectorState } = await load('/src/features/plot-vector/runtime.ts');
      const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
      const { POSITIVE_EXAMPLES } = await load('/src/features/plot-vector/genesis/test-fixtures.ts');
      const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
      const sample = POSITIVE_EXAMPLES[2];
      const task = tasksAfterSave({ id: 'seed', success: true, before: [], after: [sample.entry] })[0];
      const worker = new VectorWorkerClient();
      const bound = await worker.execute({ kind: 'validate', task, output: sample.output, attempts: 1 });
      const state = { ...initialVectorState(), cards: [bound], layout: { placements: { '01': sample.entry.id }, tray: [] } };
      const prepared = await worker.execute({ kind: 'prepare', state, entries: [sample.entry], id: 'once' });
      const accepted = await worker.execute({ kind: 'accept', state, prepared });
      const twice = await worker.execute({ kind: 'accept', state: accepted, prepared });
      await idbAdapter.setGuarded('e2e_vector_commit', accepted, () => {});
      let refused = false, count = 0;
      try { await idbAdapter.setGuarded('e2e_vector_commit', state, () => { if (++count === 2) throw new Error('cancel'); }); }
      catch { refused = true; }
      const saved = await idbAdapter.get('e2e_vector_commit');
      return { refused, preserved: JSON.stringify(saved) === JSON.stringify(accepted), once: JSON.stringify(twice) === JSON.stringify(accepted),
        growth: Object.values(accepted.session.scriptStates).some((s: any) => s.pages === 1), prompt: prepared.prompt.length > 0 };
    });
    expect(result).toEqual({ refused: true, preserved: true, once: true, growth: true, prompt: true });
  });
