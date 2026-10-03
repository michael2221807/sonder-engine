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
    // PO 2026-10-01: the starting force as four gauges with their numbers, the steps as ticks, the attributes a ledger.
    expect((await plotVector.startGauges.allTextContents()).map(text => text.replace(/\s+/g, ''))).toEqual(['↑推力2', '↓阻力0', '◇人际2', '✦机会2', '步数11']);
    await expect(plotVector.ledger).toContainText(/悟性\s*15\s*→\s*步数\s*\+3/);
    await page.getByTestId('vector-help-toggle').click();
    await plotVector.hoverDetail(plotVector.handCard('item:notebook'));
    await expect(plotVector.detail.getByTestId('vector-card-growth')).toContainText('0 / 50 级');
    await page.mouse.move(5, 5);
    // Tap the notebook, then cell 01: it is placed and kept without a save button, and the handle lights once.
    await plotVector.watchHandleLight();
    await plotVector.place('item:notebook', '01');
    await expect(plotVector.cellCard('01')).toContainText('随身日记');
    await plotVector.handleLit();
    // PO 2026-09-30 B: while the table is open the save file is not written (the move lives in the game state).
    await plotVector.kept(board => board?.layout?.placements?.['01'] === 'item:notebook');
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
    await plotVector.kept(board => board?.layout?.placements?.['02'] === 'item:notebook');
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
    await plotVector.kept(board => board?.layout?.placements?.['01'] === 'item:notebook');
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
    await plotVector.kept(board => board?.shape === 'ring');
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
    await expect(plotVector.startGauges.first()).toContainText('push');
    await expect(plotVector.ledger).toContainText('Insight');
    await expect(page.getByTestId('vector-legend')).toContainText('Toward ease');
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
    await expect(plotVector.detail.getByTestId('vector-card-growth')).toContainText('1 / 50 级');
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

test('a card says what it does: marks on its face, the effect, how it grows, and the same marks on the bars and in the legend',
  { tag: ['@plot-vector', '@story-pv-1001'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    // A touch screen has no hover, so the shared Tooltip never shows there (CLAUDE.md §8.1); the hints are desktop-only.
    const hover = !testInfo.project.use.hasTouch;
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    // PO 2026-10-01: the engine's marks beside the kind, by the direction of the bars.
    await expect(plotVector.marks('basic:push')).toHaveText('↑');
    await expect(plotVector.marks('basic:talk')).toHaveText('◇');
    await expect(plotVector.marks('item:notebook')).toHaveText('✦');
    const hub = plotVector.board.locator('.vtrack__hub');
    for (const end of ['↓ 逆', '顺 ↑', '◇ 人际', '✦ 机会']) await expect(hub).toContainText(end);
    // Hovering the marks names them, and the card's details wait while the pointer is on them.
    await plotVector.marks('basic:push').hover();
    if (hover) {
      await expect(plotVector.tooltip('这张卡：↑ 往顺')).toBeVisible();
      await page.waitForTimeout(1200);
      await expect(plotVector.detail).toHaveCount(0);
    }
    await page.mouse.move(5, 5);
    // The detail: the model's sentence, the measured mark with its strength, no growth for a card that does not grow.
    await plotVector.hoverDetail(plotVector.handCard('basic:push').locator('.vcard__name'));
    const effects = plotVector.detail.getByTestId('vector-card-effects');
    await expect(effects).toContainText('效果');
    await expect(effects.getByTestId('vector-tok')).toHaveText('↑往顺');
    await expect(plotVector.detail.getByTestId('vector-card-growth')).toHaveCount(0);
    await effects.getByTestId('vector-tok').hover();
    if (hover) await expect(plotVector.tooltip('往顺：推力更多或阻力更少')).toContainText('亮一条');
    await page.mouse.move(5, 5);
    // A growing card: its level, the line to the next, and its rule in one sentence from the engine's glossary.
    await plotVector.hoverDetail(plotVector.handCard('item:notebook').locator('.vcard__name'));
    const growth = plotVector.detail.getByTestId('vector-card-growth');
    await expect(growth).toContainText('0 级');
    await expect(growth).toContainText('每过 1 回合升一级，最多 50 级。它自己的规则里也用到了等级，升级后效果会跟着变。');
    await expect(plotVector.detail).toContainText('来历');
    await growth.locator('.vdetail__prog').hover();
    if (hover) await expect(plotVector.tooltip('再过 1 回合升到 1 级')).toBeVisible();
    await page.mouse.move(5, 5);
    // Exact numbers sit in the bubbles; what this trip brought is its own row; no pass counts anywhere.
    await plotVector.showExact();
    await expect(page.getByTestId('vector-legend').getByTestId('vector-tok')).toHaveText(['↑往顺', '↓往逆', '◇人际', '✦机会', '↻改路线', '▣存放']);
    await page.getByTestId('vector-help-toggle').click();
    await plotVector.hoverDetail(plotVector.handCard('basic:push').locator('.vcard__name'));
    await expect(plotVector.detail.getByTestId('vector-card-effects').getByTestId('vector-tok')).toContainText(/推力 \+[\d.]+／次/);
    await expect(plotVector.detail).toContainText('3/3');
    // A card in the hand took no part in the trip: no trip row for it.
    await expect(plotVector.detail.getByTestId('vector-card-trip')).toHaveCount(0);
    await page.mouse.move(5, 5);
    // On the board it did: what it brought this trip, in bubbles; no pass counts anywhere.
    await plotVector.place('basic:push', '01');
    await expect(plotVector.cellCard('01')).toContainText('顺势');
    // The trip with it is worked out and kept before its details are read.
    await plotVector.kept(board => board?.layout?.placements?.['01'] === 'basic:push');
    await plotVector.hoverDetail(plotVector.cellCard('01').locator('.vcard__name'));
    const trip = plotVector.detail.getByTestId('vector-card-trip');
    await expect(trip).toContainText('这一趟带来');
    await expect(trip.getByTestId('vector-tok').first()).toContainText(/推力\+[\d.]+/);
    await expect(plotVector.detail).not.toContainText('触发');
  });

/** The round start as the adapter sends it: this save's trip worked out by the runtime, through the app's own bus. */
async function startRound(page: Page, ids: SeedIds) {
  await page.evaluate(async ({ profileId, slotId }) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const own = performance.getEntriesByType('resource').map(e => e.name).find(name => name.includes('/src/engine/core/event-bus.ts'));
    const { eventBus } = await load(own ?? '/src/engine/core/event-bus.ts');
    const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
    const { StateManager } = await load('/src/engine/core/state-manager.ts');
    const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
    const { projectSavedElements } = await load('/src/features/plot-vector/saved-elements.ts');
    const { readVectorState, prepareVector } = await load('/src/features/plot-vector/runtime.ts');
    const { projectNativeInput, parseNativeRules } = await load('/src/features/plot-vector/native-input.ts');
    const { roundOpening } = await load('/src/features/plot-vector/table-model.ts');
    const state = new StateManager();
    state.loadTree(await idbAdapter.get(`save_${profileId}_${slotId}`));
    const component = { ...readVectorState(state.get(P.plotVector)), layout: { placements: { '01': 'item:notebook', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } };
    const rules = parseNativeRules(await (await fetch('/packs/tianming/rules/plot-vector.json')).json());
    const prepared = prepareVector(component, projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries,
      `${profileId}/${slotId}/9`, projectNativeInput(state.toSnapshot(), rules));
    eventBus.emit('plotVector:round-started', roundOpening(component, prepared));
  }, ids);
}

test('a round start plays its trip in a ribbon above the input, the badge walking with it; a press puts it away',
  { tag: ['@plot-vector', '@story-pv-1001'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    // Reduced motion: only the result, in the bars' marks and colours; it floats above the input row.
    await startRound(page, ids);
    await expect(plotVector.opening).toHaveClass(/vopen--in/);
    const result = page.getByTestId('vector-opening-result');
    for (const end of ['↓ 逆', '顺 ↑', '◇ 人际', '✦ 机会']) await expect(result).toContainText(end);
    const ribbon = await plotVector.opening.boundingBox(), input = await page.locator('textarea.message-input').boundingBox();
    expect(ribbon!.y + ribbon!.height).toBeLessThanOrEqual(input!.y);
    await plotVector.opening.click();
    await expect(plotVector.opening).toHaveCount(0);
    // With motion: the shuttle walks the miniature board and the badge lights the same cells; then it goes by itself.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await startRound(page, ids);
    await expect(plotVector.opening).toBeVisible();
    await expect(plotVector.boardOpen.locator('.vbadge__cell--lit')).toHaveCount(1, { timeout: 3000 });
    await expect(result).toBeVisible({ timeout: 5000 });
    await expect(plotVector.opening).toHaveCount(0, { timeout: 8000 });
    await expect(plotVector.boardOpen.locator('.vbadge__cell--lit')).toHaveCount(0);
    // While the table is open over the input, the round start shows no ribbon.
    await plotVector.openBoard();
    await startRound(page, ids);
    await page.waitForTimeout(300);
    await expect(plotVector.opening).toHaveCount(0);
  });

test('on a phone with the ring board a card is carried by touch, and the table holds the page still under it',
  { tag: ['@plot-vector', '@story-pv-1001'] }, async ({ page, gameShell, plotVector }, testInfo) => {
    // PO 2026-10-01: on an iPhone the ring board's drag snapped back — iOS scrolled the (taller) table and cancelled
    // the drag. Chromium honours touch-action, so it cannot reproduce that; this checks the touch drag on the ring
    // and that the table's touchmove listener holds the page once a card is carried (the iOS fix). The iPhone itself
    // is the PO's check.
    test.skip(!testInfo.project.use.hasTouch, 'touch drags are a phone gesture');
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    await plotVector.openBoard();
    await plotVector.shapeRing.click();
    await expect(plotVector.board.locator('.vtrack--ring')).toBeVisible();
    // Real touch events: the browser decides whether a touch scrolls, which mouse events never ask.
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
      const w = window as unknown as { __moves: Array<{ held: boolean; far: number }>; __from: { x: number; y: number } };
      w.__moves = [];
      window.addEventListener('touchstart', e => { w.__from = { x: e.touches[0].clientX, y: e.touches[0].clientY }; w.__moves = []; }, true);
      window.addEventListener('touchmove', e => {
        const t = e.touches[0];
        w.__moves.push({ held: e.defaultPrevented, far: Math.hypot(t.clientX - w.__from.x, t.clientY - w.__from.y) });
      });
    });
    const touchDrag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const centre = async (loc: ReturnType<Page['locator']>) => { const b = (await loc.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    /** Moves past the drag threshold (6 px) were all held: the card was carried, the page did not scroll. */
    const heldOnceCarried = async () => {
      const moves = await page.evaluate(() => (window as unknown as { __moves: Array<{ held: boolean; far: number }> }).__moves);
      const carried = moves.filter(m => m.far >= 8);
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.every(m => m.held)).toBe(true);
    };
    // From the hand up into a cell that is on screen together with the hand.
    await plotVector.handCard('item:notebook').scrollIntoViewIfNeeded();
    const viewport = page.viewportSize()!;
    let target = '';
    for (const id of ['05', '04', '03', '02', '01']) {
      const b = await plotVector.cell(id).boundingBox();
      if (b && b.y >= 0 && b.y + b.height <= viewport.height) { target = id; break; }
    }
    expect(target).not.toBe('');
    await touchDrag(await centre(plotVector.handCard('item:notebook')), await centre(plotVector.cell(target)));
    await expect(plotVector.cellCard(target)).toContainText('随身日记');
    await heldOnceCarried();
    // From that cell to another one on screen.
    let other = '';
    for (const id of ['01', '02', '03', '04', '05']) {
      if (id === target) continue;
      const b = await plotVector.cell(id).boundingBox();
      if (b && b.y >= 0 && b.y + b.height <= viewport.height) { other = id; break; }
    }
    expect(other).not.toBe('');
    await touchDrag(await centre(plotVector.cellCard(target)), await centre(plotVector.cell(other)));
    await expect(plotVector.cellCard(other)).toContainText('随身日记');
    await expect(plotVector.cellCard(target)).toHaveCount(0);
    await heldOnceCarried();
  });

/**
 * The engine around a round, through the app's own bus: the story is shown (`engine:round-complete`) while the
 * passes after it (Step3 and the rest) still keep the orchestrator busy, until `engine:sub-pipelines-done`. A
 * sub-pipeline retry flips the panel back to "writing" (`ai:retrying`). `busy` / `free` change the engine silently,
 * as a background save (`requestedSaveActive`) does.
 */
async function engineRound(page: Page, step: 'start' | 'story-shown' | 'retrying' | 'finished' | 'busy' | 'free') {
  await page.evaluate(async step => {
    const path = '/src/engine/core/event-bus.ts';
    const { eventBus } = await import(/* @vite-ignore */ path);
    const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
    const host = app.__vue_app__._context.provides.gameOrchestrator as { _subPipelineActive: boolean };
    if (step === 'start') eventBus.emit('engine:round-start');
    if (step === 'story-shown') { host._subPipelineActive = true; eventBus.emit('engine:round-complete', { actionOptions: [] }); }
    if (step === 'retrying') eventBus.emit('ai:retrying', { attempt: 1, maxRetries: 2 });
    if (step === 'finished') { host._subPipelineActive = false; eventBus.emit('engine:sub-pipelines-done'); }
    if (step === 'busy') host._subPipelineActive = true;
    if (step === 'free') host._subPipelineActive = false;
  }, step);
}

test('while the engine finishes a round after its story is shown, the table waits, locked, and opens by itself',
  { tag: ['@plot-vector', '@regression'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    const lock = page.getByTestId('vector-board-locked');

    // PO 2026-10-02: opened right after the story was shown, the table said it could not open until reopened.
    await engineRound(page, 'start');
    await engineRound(page, 'story-shown');
    await plotVector.boardOpen.click();
    await expect(lock).toContainText('这一回合正在收尾');
    await expect(plotVector.note).not.toContainText('打不开');
    await engineRound(page, 'finished');
    await expect(lock).toHaveCount(0);
    await expect(plotVector.handCard('item:notebook')).toBeVisible();
    await expect(plotVector.note).toHaveText('');
    await plotVector.closeBoard();

    // Opened during the round: locked while the story is written, still locked while the round is finished — also
    // through a retry of a pass after it — then read.
    await engineRound(page, 'start');
    await plotVector.boardOpen.click();
    await expect(lock).toContainText('故事正在写');
    await engineRound(page, 'story-shown');
    await expect(lock).toContainText('这一回合正在收尾');
    await engineRound(page, 'retrying');
    await expect(lock).toContainText('故事正在写');
    await engineRound(page, 'finished');
    await expect(lock).toHaveCount(0);
    await expect(plotVector.handCard('item:notebook')).toBeVisible();
    await expect(plotVector.note).toHaveText('');
  });

test('a move that meets a busy engine is put back and kept once the engine is free, also when it frees without a word',
  { tag: ['@plot-vector', '@regression'] }, async ({ page, gameShell, plotVector }) => {
    const ids = await seedSave(page);
    await addBoardFixture(page, ids);
    await enterSeededGame(page);
    await gameShell.goTab('settings'); await plotVector.toggleFeature(); await gameShell.goTab('');
    const lock = page.getByTestId('vector-board-locked');
    await plotVector.openBoard();

    // The engine is busy (a background save holds it) when the move walks: the walk is refused, the table waits.
    await engineRound(page, 'busy');
    await plotVector.place('item:notebook', '01');
    await expect(lock).toContainText('这一回合正在收尾');
    // It frees itself without an event: the table looks again by itself, puts the move back and keeps it.
    await engineRound(page, 'free');
    await expect(lock).toHaveCount(0);
    await expect(plotVector.cellCard('01')).toContainText('随身日记');
    await plotVector.kept(board => board?.layout?.placements?.['01'] === 'item:notebook');
    await expect(plotVector.note).toHaveText('');

    // The engine turns busy right after a move, before the move is kept: its keeping is refused, the table waits,
    // and keeps it once the engine says it is done.
    await plotVector.place('basic:push', '02');
    await engineRound(page, 'busy');
    await expect(lock).toContainText('这一回合正在收尾');
    await engineRound(page, 'finished');
    await plotVector.kept(board => board?.layout?.placements?.['02'] === 'basic:push' && board?.layout?.placements?.['01'] === 'item:notebook');
    await expect(lock).toHaveCount(0);
  });
