import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';
import type { SeedIds } from './fixtures/seed-save';
import { VECTOR_NOTEBOOK_ITEM } from './fixtures/seed-tree';

// The table's motion is checked by eye; these tests check what it does, so they run without it
// (the product then shows the table at once, with no sliding).
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });
// Each test seeds a save, reloads it and waits for background saves.
test.slow();

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
        // Named like a real round of this save, so the round title shows its impulse.
        const round = state.get(P.roundNumber) ?? 0;
        const prepared = prepareVector(component, projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries,
          `${profileId}/${slotId}/${round}`, projectNativeInput(state.toSnapshot(), rules));
        component = acceptVector(component, prepared);
      }
      state.set(P.plotVector, component);
      await idbAdapter.set(key, state.toSnapshot());
    }, { ...ids, accept, store, notebook: VECTOR_NOTEBOOK_ITEM });
}
/** The board state as written to disk. */
async function persisted(page: Page, ids: SeedIds) {
  return page.evaluate(async ({ profileId, slotId }) => {
    const path = '/src/engine/persistence/idb-adapter.ts';
    const { idbAdapter } = await import(/* @vite-ignore */ path);
    return (await idbAdapter.get(`save_${profileId}_${slotId}`)).系统.扩展.plotVector;
  }, ids);
}
/** The table writes the save when it closes: wait until the disk has what the check expects. */
async function savedUntil(page: Page, ids: SeedIds, check: (pv: Record<string, any>) => boolean) {
  await expect.poll(async () => check(await persisted(page, ids)), { timeout: 10_000 }).toBe(true);
}

test('the table keeps the player\'s arrangement across reload; moves are kept live and written when the table closes, never accepting a round',
  { tag: ['@plot-vector', '@story-d147', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await expect(plotVector.boardOpen).toHaveCount(0);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    // The environment is weather above the board; it takes no cell.
    await expect(plotVector.weather).toContainText('微风');
    await expect(plotVector.fixedStatusCell).not.toContainText('微风');
    // The hand: the saved notebook and the three supply cards, marked as supply.
    expect(await plotVector.handIds.evaluateAll(els => els.map(e => e.getAttribute('data-card')))).toEqual(['item:notebook', 'basic:push', 'basic:talk', 'basic:notice']);
    await expect(plotVector.handCard('basic:push')).toContainText('补给');
    // Exact numbers only behind the "?" (PO 2A).
    await expect(plotVector.nativeInput).toHaveCount(0);
    await plotVector.showExact();
    await expect(plotVector.nativeInput).toContainText('出发：推力 2 · 阻力 0 · 人际 2 · 机会 2 · 走 11 格');
    await expect(plotVector.nativeInput).toContainText('悟性 15 → 步数 +3');
    await page.getByTestId('vector-help-toggle').click();
    await plotVector.hoverDetail(plotVector.handCard('item:notebook'));
    await expect(plotVector.detail).toContainText('等级 0 / 50');
    await page.mouse.move(5, 5);
    // Tap the notebook, then cell 01: it is placed and kept without a save button.
    await plotVector.place('item:notebook', '01');
    await expect(plotVector.cellCard('01')).toContainText('随身日记');
    // PO 2026-09-30 B: while the table is open the save file is not written (the move lives in the game state).
    await expect(plotVector.board.locator('.vtable__handle--saved')).toBeAttached();
    expect((await persisted(page, ids)).layout?.placements?.['01'] ?? null).toBeNull();
    // Closing the table writes it once, and the badge says so (PO 2026-09-30).
    await plotVector.closeBoard();
    await expect(page.getByTestId('vector-save-note')).toContainText('已保存');
    await savedUntil(page, ids, pv => pv.layout?.placements?.['01'] === 'item:notebook');
    const saved = await persisted(page, ids);
    expect(saved.session.round).toBe(1); expect(saved.growth).toEqual({}); expect(saved.last).toBeUndefined();
    await page.goto('/'); await enterSeededGame(page); await plotVector.openBoard();
    await expect(plotVector.cellCard('01')).toContainText('随身日记');
    // A tap on a placed card takes it back into the hand.
    await plotVector.takeOff('01');
    await expect(plotVector.cellCard('01')).toHaveCount(0);
    await plotVector.closeBoard();
    await savedUntil(page, ids, pv => pv.layout?.placements?.['01'] === null);
    const after = await persisted(page, ids);
    expect(after.layout.tray).toEqual(['item:notebook', 'basic:push', 'basic:talk', 'basic:notice']);
    expect(after.session.round).toBe(1); expect(after.growth).toEqual({}); expect(after.last).toBeUndefined();
  });

test('leaving the story panel with the table open still writes the arrangement to its save',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await plotVector.place('item:notebook', '02');
    await expect(plotVector.board.locator('.vtable__handle--saved')).toBeAttached();
    // Straight to the save page without closing the table (browser Back does the same): the story panel is kept
    // alive in the background, so the table must close itself rather than float over the save page.
    await page.evaluate(async () => {
      const app = (document.querySelector('#app') as { __vue_app__?: { config: { globalProperties: { $router: { push(to: string): Promise<unknown> } } } } } | null)?.__vue_app__;
      await app?.config.globalProperties.$router.push('/game/save');
    });
    await expect(plotVector.board).toHaveCount(0);
    await savedUntil(page, ids, pv => pv.layout?.placements?.['02'] === 'item:notebook');
  });

test('the table floats above the input row, which stays in view: a press on it closes the table and focuses the input',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    const catcher = page.getByTestId('vector-input-catcher');
    // A small phone has no room above its input: there the table covers it (still clear of the screen's edges).
    const covered = (await catcher.count()) === 0;
    const table = await plotVector.board.boundingBox();
    const input = await page.locator('textarea.message-input').boundingBox();
    if (covered) {
      expect(table!.y + table!.height).toBeLessThan(page.viewportSize()!.height);
      return;
    }
    // PO 2026-09-30 A: not on the bottom edge, above the input row with a gap.
    expect(table!.y + table!.height).toBeLessThanOrEqual(input!.y - 8);
    await plotVector.place('item:notebook', '01');
    await expect(plotVector.board.locator('.vtable__handle--saved')).toBeAttached();
    // A press where the input shows (it lies under the catcher; on a phone the row's buttons wrap below it).
    await page.mouse.click(input!.x + 40, input!.y + input!.height / 2);
    await expect(plotVector.board).toHaveCount(0);
    await expect(page.locator('textarea.message-input')).toBeFocused();
    await savedUntil(page, ids, pv => pv.layout?.placements?.['01'] === 'item:notebook');
    // A press on the badge (also in that row) only closes the table; the caret is not moved.
    await page.locator('textarea.message-input').blur();
    await plotVector.openBoard();
    const badge = await plotVector.boardOpen.boundingBox();
    await page.mouse.click(badge!.x + badge!.width / 2, badge!.y + badge!.height / 2);
    await expect(plotVector.board).toHaveCount(0);
    await expect(page.locator('textarea.message-input')).not.toBeFocused();
    // Keyboard focus reaching the input closes the table and stays in the input.
    await plotVector.openBoard();
    await page.locator('textarea.message-input').focus();
    await expect(plotVector.board).toHaveCount(0);
    await expect(page.locator('textarea.message-input')).toBeFocused();
  });

test('cards move by dragging, swap on an occupied cell, and the sweep takes every card off',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await expect(plotVector.boardClear).toBeDisabled();
    // A card picked up by a tap, then a drag instead (PO 2026-10-01): the drag wins and nothing stays held.
    // (A card in view without scrolling the hand, so the drag below still finds the first card.)
    await plotVector.handCard('basic:push').click();
    await expect(plotVector.board.locator('.vcard--selected')).toHaveCount(1);
    await plotVector.drag('item:notebook', '01');
    await expect(plotVector.board.locator('.vcard--selected')).toHaveCount(0);
    await expect(plotVector.board.locator('.vcell--hint')).toHaveCount(0);
    await plotVector.drag('basic:push', '02');
    await expect(plotVector.cellCard('01')).toContainText('随身日记');
    await expect(plotVector.cellCard('02')).toContainText('顺势');
    // A later tap on an empty cell moves nothing.
    await plotVector.cell('03').click();
    await expect(plotVector.cellCard('03')).toHaveCount(0);
    // Onto an occupied cell: the two swap.
    const from = await plotVector.cellCard('02').boundingBox(), to = await plotVector.cell('01').boundingBox();
    await page.mouse.move(from!.x + 40, from!.y + 40); await page.mouse.down();
    await page.mouse.move(from!.x + 50, from!.y + 20, { steps: 3 });
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(plotVector.cellCard('01')).toContainText('顺势');
    await expect(plotVector.cellCard('02')).toContainText('随身日记');
    await expect(plotVector.boardClear).toBeEnabled();
    await plotVector.boardClear.click();
    for (const cell of ['01', '02', '03', '04', '05']) await expect(plotVector.cellCard(cell)).toHaveCount(0);
    await expect(plotVector.weather).toContainText('微风'); // weather is not the player's to place
    await expect(plotVector.boardClear).toBeDisabled();
    await plotVector.closeBoard();
    await savedUntil(page, ids, pv => ['01', '02', '03', '04', '05'].every(cell => pv.layout?.placements?.[cell] === null));
  });

test('both board shapes can be played; the chosen one is saved with the arrangement',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await expect(plotVector.shapeLine).toHaveAttribute('aria-pressed', 'true');
    await plotVector.shapeRing.click();
    await expect(plotVector.board.locator('.vtrack--ring')).toBeVisible();
    await expect(plotVector.board.locator('.vtable__handle--saved')).toBeAttached();
    await plotVector.closeBoard();
    await savedUntil(page, ids, pv => pv.shape === 'ring');
    await expect(plotVector.boardOpen).toHaveClass(/vbadge--ring/);
    await page.goto('/'); await enterSeededGame(page); await plotVector.openBoard();
    await expect(plotVector.shapeRing).toHaveAttribute('aria-pressed', 'true');
    await plotVector.place('item:notebook', '03');
    await expect(plotVector.cellCard('03')).toContainText('随身日记');
    await plotVector.shapeLine.click();
    await expect(plotVector.board.locator('.vtrack--ring')).toHaveCount(0);
    await plotVector.closeBoard();
    await savedUntil(page, ids, pv => pv.shape === 'line' && pv.layout?.placements?.['03'] === 'item:notebook');
  });

test('the table fits a narrow viewport and renders English',
  { tag: ['@plot-vector', '@story-d147', '@story-d148'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    await seedSave(page); await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature();
    await plotVector.switchToEnglishAndResume();
    await plotVector.openBoard();
    await plotVector.showExact();
    await expect(plotVector.nativeInput).toContainText('Start: push');
    await expect(plotVector.nativeInput).toContainText('Insight');
    await page.getByTestId('vector-help-toggle').click();
    await expect(plotVector.handCard('basic:push')).toContainText('Supply');
    if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: 'e2e/screenshots/plot-vector-board.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(plotVector.cell('01')).toBeVisible();
    expect(await plotVector.board.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await plotVector.fixedStatusCell.scrollIntoViewIfNeeded();
    await expect(plotVector.fixedStatusCell).toBeInViewport();
    await plotVector.place('basic:push', '01');
    await expect(plotVector.cellCard('01')).toContainText('Momentum');
    await plotVector.shapeRing.click();
    expect(await plotVector.board.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: 'e2e/screenshots/plot-vector-board-mobile-en.png' });
  });

test('an accepted round: its impulse beside the round title, its growth in the card, its trip to replay',
  { tag: ['@plot-vector', '@story-d148'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    const ids = await seedSave(page);
    // Real runtime acceptance of a handwritten fixture, not a fabricated story turn.
    await addBoardFixture(page, ids, true);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await expect(plotVector.impulse).toBeVisible();
    await expect(plotVector.impulse).toHaveText(/^(顺势|平稳|稍有阻力|阻力重重)( · (人际易通|机会易现))?$/);
    await plotVector.openBoard();
    await expect(plotVector.replay).toBeEnabled();
    await plotVector.showExact();
    await page.getByTestId('vector-help-toggle').click();
    await plotVector.hoverDetail(plotVector.handCard('item:notebook'));
    await expect(plotVector.detail).toContainText('等级 1 / 50');
    await page.mouse.move(5, 5);
    await plotVector.replay.click();
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
    await plotVector.openBoard();
    await expect(plotVector.cellCard('01').locator('.vcard__stored')).toBeVisible();
    const stored = async () => (await persisted(page, ids)).session.carriedAccounts;
    const before = await stored();
    await page.goto('/'); await enterSeededGame(page); await dismissStorageNotice();
    await plotVector.openBoard();
    await expect(plotVector.cellCard('01').locator('.vcard__stored')).toBeVisible();
    expect(await stored()).toEqual(before);
  });
