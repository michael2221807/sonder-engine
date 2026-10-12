/**
 * Plot threads and their gauges for the status bar's gauge drawer (status-gauge-drawer.spec.ts), written into the seeded slot
 * before the game loads; and a live write of a gauge's value through the running app's state store, as a round would.
 */
import type { Page } from '@playwright/test';
import type { SeedIds } from './seed-save';

export interface SeedGauge {
  id: string;
  name: string;
  current: number;
  max: number;
  unit: string;
}

/** Five gauges like a real save's (percentages, money, points), with an environment tag and a festival. */
export const FIVE_GAUGES: SeedGauge[] = [
  { id: 'g1', name: '条例服从度', current: 82, max: 100, unit: '%' },
  { id: 'g2', name: '档案评级热度', current: 33, max: 100, unit: '%' },
  { id: 'g3', name: '外婆治疗费缺口', current: 775, max: 1000, unit: '万元' },
  { id: 'g4', name: '反差体质失控度', current: 70, max: 100, unit: '%' },
  { id: 'g5', name: '人性锚点', current: 29, max: 100, unit: '点' },
];

/** A thread to seed: its gauges, its status (active by default) and its scheduler lane. */
export interface SeedThread {
  id: string;
  title: string;
  gauges: SeedGauge[];
  status?: 'active' | 'completed' | 'scheduled';
  lane?: number;
}

/** One active focus thread (档案) with `gauges`. */
export async function seedFocusGauges(page: Page, ids: SeedIds, gauges: SeedGauge[] = FIVE_GAUGES): Promise<void> {
  await seedThreads(page, ids, [{ id: 'arc_a', title: '档案', gauges }], 'arc_a');
}

/** Several threads; `focusArcId` is the focus thread. */
export async function seedThreads(page: Page, ids: SeedIds, threads: SeedThread[], focusArcId: string): Promise<void> {
  await page.evaluate(async ({ profileId, slotId, threads, focusArcId }) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
    const { StateManager } = await load('/src/engine/core/state-manager.ts');
    const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
    const key = `save_${profileId}_${slotId}`, state = new StateManager();
    state.loadTree(await idbAdapter.get(key));
    state.set(P.festival, { 名称: '元宵', 描述: '花灯满街', 效果: '人多热闹' });
    state.set(P.environmentTags, [{ 名称: '疏落隐贵、流光满窗', 描述: '灯火', 效果: '' }]);
    state.set(P.plotDirection, {
      activeArcIndex: null, focusArcId, pendingConfirmations: [],
      arcs: threads.map((t, i) => ({
        id: t.id, title: t.title, synopsis: '', status: t.status ?? 'active', lane: t.lane ?? i,
        gauges: t.gauges.map((g) => ({
          id: g.id, name: g.name, description: `${g.name}的说明`, min: 0, max: g.max, current: g.current, initialValue: g.current,
          unit: g.unit, showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25,
        })),
        nodes: [{
          id: `n1_${t.id}`, arcId: t.id, title: '澄清', narrativeGoal: '澄清', directive: '澄清', completionHint: '澄清',
          completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'skippable',
          opportunityTiers: [], status: 'active', consecutiveReachedCount: 0, activatedAtRound: 1,
        }],
      })),
    });
    await idbAdapter.set(key, state.toSnapshot());
  }, { ...ids, threads, focusArcId });
}

/** Changes one thread's gauges (`arcIndex`, the first by default) in the running game, as a round's command would, through the app's own store. */
export async function changeLiveGauges(page: Page, change: { setCurrent?: Record<string, number>; renameIds?: Record<string, string>; arcIndex?: number }): Promise<void> {
  await page.evaluate(async (change) => {
    // Through a variable, like the seed above: the browser resolves this path, the e2e type-check must not.
    const load = (p: string) => import(/* @vite-ignore */ p);
    const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
    const app = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { get: (p: string) => unknown; setValue: (p: string, v: unknown) => void }> } } } };
    };
    const store = app.__vue_app__.config.globalProperties.$pinia._s.get('engineState');
    if (!store) throw new Error('engineState store not found');
    const plot = JSON.parse(JSON.stringify(store.get(P.plotDirection))) as { arcs: Array<{ gauges: Array<{ id: string; current: number }> }> };
    for (const gauge of plot.arcs[change.arcIndex ?? 0].gauges) {
      if (change.setCurrent && gauge.id in change.setCurrent) gauge.current = change.setCurrent[gauge.id];
      if (change.renameIds && gauge.id in change.renameIds) gauge.id = change.renameIds[gauge.id];
    }
    store.setValue(P.plotDirection, plot);
  }, change);
}
