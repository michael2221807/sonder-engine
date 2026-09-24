/**
 * The e2e import root. EVERY spec imports `{ test, expect }` from here, never from
 * `@playwright/test` directly — so every test inherits the zero-real-API guarantee
 * with no opt-in, and gets the page objects on demand.
 *
 * Re-exports the helper layer (seed-tree / seed-save / navigation / card-bundle /
 * disable-api) so a spec can import everything from one place.
 */
import { test as base, expect } from '@playwright/test';
import { installApiGuard, type GuardState } from './api-guard';
import { HomePage } from '../pages/home.page';
import { GameShellPage } from '../pages/game-shell.page';
import { SavePage } from '../pages/save.page';
import { CardExportPage } from '../pages/card-export.page';
import { CardImportPage } from '../pages/card-import.page';
import { SaveToCardPage } from '../pages/save-to-card.page';
import { CreationPage } from '../pages/creation.page';
import { PlotVectorPage } from '../pages/plot-vector.page';

interface Fixtures {
  /** The egress guard state (auto-installed; asserted empty in teardown). */
  apiGuard: GuardState;
  home: HomePage;
  gameShell: GameShellPage;
  savePage: SavePage;
  cardExport: CardExportPage;
  cardImport: CardImportPage;
  saveToCard: SaveToCardPage;
  creation: CreationPage;
  plotVector: PlotVectorPage;
}

export const test = base.extend<Fixtures>({
  // auto: every spec is guarded against real-API egress without opting in.
  apiGuard: [async ({ page }, use) => {
    const state = await installApiGuard(page);
    await use(state);
    expect(state.hits, `unexpected real-API egress: ${state.hits.join(', ')}`).toEqual([]);
    expect(state.violations, `unexpected cross-origin egress: ${state.violations.join(', ')}`).toEqual([]);
  }, { auto: true }],

  // Page objects — lazily constructed (unused ones are never built).
  home: async ({ page }, use) => { await use(new HomePage(page)); },
  gameShell: async ({ page }, use) => { await use(new GameShellPage(page)); },
  savePage: async ({ page }, use) => { await use(new SavePage(page)); },
  cardExport: async ({ page }, use) => { await use(new CardExportPage(page)); },
  cardImport: async ({ page }, use) => { await use(new CardImportPage(page)); },
  saveToCard: async ({ page }, use) => { await use(new SaveToCardPage(page)); },
  creation: async ({ page }, use) => { await use(new CreationPage(page)); },
  plotVector: async ({ page }, use) => { await use(new PlotVectorPage(page)); },
});

// Re-export ONLY the symbols specs consume through this barrel. Everything else
// (makeSeedTree, deepMerge, disableApi, BLOCKED_PATTERNS, the id constants…) stays
// importable from its source module and is consumed WITHIN the layer — re-barreling
// it here unconsumed would violate the CLAUDE.md "every export must be consumed" gate.
export { expect };
export { seedSave } from './seed-save';
export { enterSeededGame } from './navigation';
export { decodeCardFile, assertNoSecrets } from './card-bundle';
export { LOCATION_NAME, NPC_NAME } from './seed-tree';
