/**
 * Plot-vector board seed (extracted from plot-vector-board.spec.ts; also used by status-bar-hints.spec.ts).
 *
 * Handwritten deterministic cards in the contract format, never a fabricated model/story response. The pack's
 * literals come from seed-tree.ts; this helper only wires them into the seeded save through the engine's own
 * modules, imported in the page.
 */
import type { Page } from '@playwright/test';
import type { SeedIds } from './seed-save';
import { VECTOR_ATTRIBUTES, VECTOR_ENV_CARD, VECTOR_ENV_TAG, VECTOR_NOTEBOOK_ITEM, VECTOR_RULES_URL, VECTOR_STORE_CARD } from './seed-tree';

/**
 * Binds the diary and the environment tag to cards on the seeded save. `accept` also plays a round named like
 * the save's current round and accepts it, so the round title shows its impulse; `store` gives the diary the
 * store variant, placed on cell 01.
 */
export async function addBoardFixture(page: Page, ids: SeedIds, accept = false, store = false, notebookItem: Record<string, unknown> = VECTOR_NOTEBOOK_ITEM): Promise<void> {
  await page.evaluate(async ({ profileId, slotId, accept, store, notebook, attributes, envTag, envCard, storeCard, rulesUrl }) => {
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
    state.set(P.characterAttributes, attributes);
    state.set(P.environmentTags, [envTag]);
    const entry = projectSavedElements(state.toSnapshot()).entries.find((e: { id: string }) => e.id === 'item:notebook');
    const task = tasksAfterSave({ id: 'fixture', success: true, before: [], after: [entry] })[0];
    // The diary grows a level every round; the store variant keeps push in its own store.
    const bound = bindCard(task, store ? storeCard : POSITIVE_EXAMPLES[2].card);
    const env = projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries.find((e: { kind: string }) => e.kind === 'environment');
    const envTask = tasksAfterSave({ id: 'fixture', success: true, before: [], after: [env] })[0];
    const environment = bindCard(envTask, envCard);
    let component = { ...initialVectorState(), cards: [bound, environment] };
    if (accept) {
      if (store) component = { ...component, layout: { placements: { '01': 'item:notebook' }, tray: [] } };
      const { projectNativeInput, parseNativeRules } = await load('/src/features/plot-vector/native-input.ts');
      const rules = parseNativeRules(await (await fetch(rulesUrl)).json());
      // Named like a real round of this save, so the round title shows its impulse.
      const round = state.get(P.roundNumber) ?? 0;
      const prepared = prepareVector(component, projectSavedElements(state.toSnapshot(), { includeEnvironment: true }).entries,
        `${profileId}/${slotId}/${round}`, projectNativeInput(state.toSnapshot(), rules));
      component = acceptVector(component, prepared);
    }
    state.set(P.plotVector, component);
    await idbAdapter.set(key, state.toSnapshot());
  }, {
    ...ids, accept, store, notebook: notebookItem,
    attributes: VECTOR_ATTRIBUTES, envTag: VECTOR_ENV_TAG, envCard: VECTOR_ENV_CARD, storeCard: VECTOR_STORE_CARD, rulesUrl: VECTOR_RULES_URL,
  });
}
