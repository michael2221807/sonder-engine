import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';
import type { SeedIds } from './fixtures/seed-save';
import { VECTOR_NOTEBOOK_ITEM } from './fixtures/seed-tree';

async function addBoardFixture(page: Page, ids: SeedIds, accept = false, store = false) {
    // Handwritten deterministic cards in the contract format, never a fabricated model/story response.
    await page.evaluate(async ({ profileId, slotId, accept, store, notebook }) => {
      const load = (p: string) => import(/* @vite-ignore */ p);
      const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
      const { StateManager } = await load('/src/engine/core/state-manager.ts');
      const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
      const { projectSavedElements } = await load('/src/features/plot-vector/saved-elements.ts');
      const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
      const { POSITIVE_EXAMPLES } = await load('/src/features/plot-vector/genesis/test-fixtures.ts');
      const { initialVectorState, bindCard, prepareVector, acceptVector } = await load('/src/features/plot-vector/runtime.ts');
      const key = `save_${profileId}_${slotId}`, state = new StateManager();
      state.loadTree(await idbAdapter.get(key));
      state.set(P.inventoryItems, { notebook });
      state.set(P.characterAttributes, { 体质: 10, 心性: 10, 魅力: 10, 直觉: 5, 气运: 15, 悟性: 15 });
      state.set(P.environmentTags, [{ 名称: '微风', 描述: '舒适的微风', 效果: '使人放松' }]);
      const entry = projectSavedElements(state.toSnapshot()).entries.find((e: {id: string}) => e.id === 'item:notebook');
      const task = tasksAfterSave({ id: 'fixture', success: true, before: [], after: [entry] })[0];
      // The diary grows a level every round; the store variant keeps up to 3 push in its own store.
      const card = store
        ? { for: '随身日记', type: 'item', summary: '把推力存起来，最多存 3 点。', onPass: 'return ctx.stored < 3 ? { store: { from: "push", amount: 3 - ctx.stored } } : {};' }
        : POSITIVE_EXAMPLES[2].card;
      const bound = bindCard(task, card);
      const env = projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries.find((e: {kind: string}) => e.kind === 'environment');
      const envTask = tasksAfterSave({ id: 'fixture', success: true, before: [], after: [env] })[0];
      const environment = bindCard(envTask, { for: '微风', type: 'environment', summary: '出发时推力 +1。', onPass: 'return { push: 1 };' });
      let component = { ...initialVectorState(), cards: [bound, environment] };
      if (accept) {
        if (store) component = { ...component, layout: { placements: { '01': 'item:notebook' }, tray: [] } };
        const { projectNativeInput, parseNativeRules } = await load('/src/features/plot-vector/native-input.ts');
        const rules = parseNativeRules(await (await fetch('/packs/tianming/rules/plot-vector.json')).json());
        const prepared = prepareVector(component, projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries,
          'fixture-accepted', projectNativeInput(state.toSnapshot(), rules));
        component = acceptVector(component, prepared);
      }
      state.set(P.plotVector, component);
      await idbAdapter.set(key, state.toSnapshot());
    }, { ...ids, accept, store, notebook: VECTOR_NOTEBOOK_ITEM });
}


test('optional board keeps explicit choices across reload; preview and layout save never accept a round',
  { tag: ['@plot-vector', '@story-d147', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await expect(plotVector.boardOpen).toHaveCount(0);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await expect(plotVector.nativeInput.locator('summary')).toHaveText('出发时：推力 2 · 人际 2 · 机会 2 · 走 11 格');
    await plotVector.nativeInput.locator('summary').click();
    await expect(plotVector.nativeInput).toContainText('悟性 · 15 → 行程 +3');
    // The environment acts like weather at each departure; it takes no cell.
    await expect(plotVector.weather).toContainText('微风（出发时推力 +1。）');
    await expect(plotVector.fixedStatusCell).not.toContainText('微风');
    // Leave empty + the saved notebook + the three basic supply cards (marked as such).
    await expect(plotVector.cellChoice('01').locator('option')).toHaveCount(5);
    await expect(plotVector.cellChoice('01').locator('option', { hasText: '基础补给' })).toHaveCount(3);
    await plotVector.progress.locator('summary').click();
    await expect(plotVector.progress).toContainText('级数 0 / 50');
    await expect(plotVector.cellChoice('01')).toHaveValue('');
    await plotVector.chooseCard('01', 'item:notebook');
    await plotVector.boardPreview.click();
    await expect(plotVector.boardPreview).toBeEnabled();
    await expect(plotVector.progress).toContainText('级数 0 / 50');
    await plotVector.replay.focus(); await plotVector.replay.press('Home'); await plotVector.replay.press('ArrowRight');
    await expect(plotVector.board.getByText('这一步触发：随身日记')).toBeVisible();
    const previewState = await page.evaluate(async () => {
      const path = '/src/engine/stores/engine-state.ts';
      const { useEngineStateStore } = await import(/* @vite-ignore */ path);
      return useEngineStateStore().tree.系统.扩展.plotVector;
    });
    expect(previewState.layout).toBeUndefined();
    expect(previewState.session.round).toBe(1); expect(previewState.growth).toEqual({});
    await plotVector.boardSave.click();
    await expect(plotVector.board.getByRole('status')).toHaveText('摆法已保存，下个回合自动沿用。');
    await expect(plotVector.cellChoice('01')).toHaveValue('item:notebook');
    await page.goto('/'); await enterSeededGame(page); await plotVector.openBoard();
    await expect(plotVector.cellChoice('01')).toHaveValue('item:notebook');
    await plotVector.chooseCard('01', ''); await plotVector.boardSave.click();
    await expect(plotVector.board.getByRole('status')).toHaveText('摆法已保存，下个回合自动沿用。');
    const persisted = await page.evaluate(async ({ profileId, slotId }) => {
      const path = '/src/engine/persistence/idb-adapter.ts';
      const { idbAdapter } = await import(/* @vite-ignore */ path);
      return (await idbAdapter.get(`save_${profileId}_${slotId}`)).系统.扩展.plotVector;
    }, ids);
    expect(persisted.layout.placements['01']).toBeNull(); expect(persisted.layout.tray).toEqual(['item:notebook', 'basic:push', 'basic:talk', 'basic:notice']);
    expect(persisted.session.round).toBe(1); expect(persisted.growth).toEqual({}); expect(persisted.last).toBeUndefined();

  });

test('clearing the board takes every chosen card off and saves an empty arrangement',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await expect(plotVector.boardClear).toBeDisabled();
    await plotVector.chooseCard('01', 'item:notebook');
    await plotVector.chooseCard('02', 'basic:push');
    await expect(plotVector.boardClear).toBeEnabled();
    await plotVector.boardClear.click();
    for (const cell of ['01', '02', '03', '04', '05']) await expect(plotVector.cellChoice(cell)).toHaveValue('');
    await expect(plotVector.weather).toContainText('微风'); // weather is not the player's to place
    await expect(plotVector.boardClear).toBeDisabled();
    await plotVector.boardSave.click();
    await expect(plotVector.board.getByRole('status')).toHaveText('摆法已保存，下个回合自动沿用。');
    const persisted = await page.evaluate(async ({ profileId, slotId }) => {
      const path = '/src/engine/persistence/idb-adapter.ts';
      const { idbAdapter } = await import(/* @vite-ignore */ path);
      return (await idbAdapter.get(`save_${profileId}_${slotId}`)).系统.扩展.plotVector.layout.placements;
    }, ids);
    expect(['01', '02', '03', '04', '05'].map(cell => persisted[cell])).toEqual([null, null, null, null, null]);
  });

test('optional board fits a narrow viewport and renders English with its bottom controls reachable',
  { tag: ['@plot-vector', '@story-d147', '@story-d148'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    await seedSave(page); await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature();
    await plotVector.switchToEnglishAndResume();
    await plotVector.openBoard();
    await expect(plotVector.nativeInput.locator('summary')).toContainText('Starting: push');
    await expect(plotVector.cellChoice('01')).toBeVisible();
    await plotVector.nativeInput.locator('summary').click();
    await expect(plotVector.nativeInput).toContainText('Insight');
    if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: 'e2e/screenshots/plot-vector-board.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(plotVector.boardPreview).toHaveText('Preview trip');
    await expect(plotVector.cellChoice('01')).toBeVisible();
    expect(await plotVector.board.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await plotVector.fixedStatusCell.scrollIntoViewIfNeeded();
    await expect(plotVector.fixedStatusCell).toBeInViewport();
    await plotVector.boardPreview.click();
    await expect(plotVector.boardPreview).toBeEnabled();
    if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: 'e2e/screenshots/plot-vector-board-mobile-en.png' });
  });


test('accepted board progress survives disk reload without accepting it again',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    const ids = await seedSave(page);
    // Real runtime acceptance of a handwritten fixture, not a fabricated story turn.
    await addBoardFixture(page, ids, true);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard(); await plotVector.showLast();
    await expect(plotVector.nativeInput.locator('summary')).toContainText('走 11 格');
    await plotVector.progress.locator('summary').click();
    await expect(plotVector.progress).toContainText('级数 1 / 50 (+1)');
    if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: 'e2e/screenshots/plot-vector-progress.png' });
  });

test('the store of a card is the engine balance after disk reload',
  { tag: ['@plot-vector', '@story-d194'] }, async ({ page, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids, true, true);
    await enterSeededGame(page);
    await page.evaluate(async () => {
      const path = '/src/engine/plot-vector/feature-control.ts';
      const { writePlotVectorControl } = await import(/* @vite-ignore */ path);
      writePlotVectorControl(true);
    });
    const dismissStorageNotice = async () => {
      const close = page.getByRole('button', { name: '关闭通知' });
      if (await close.isVisible()) await close.click();
    };
    await dismissStorageNotice();
    await plotVector.openBoard(); await plotVector.showLast();
    await expect(plotVector.board.locator('[data-cell="01"] .progress')).toContainText('存量 3 / 30 (+3)');
    await page.goto('/'); await enterSeededGame(page); await dismissStorageNotice();
    await plotVector.openBoard(); await plotVector.showLast();
    await expect(plotVector.board.locator('[data-cell="01"] .progress')).toContainText('存量 3 / 30 (+3)');
  });
