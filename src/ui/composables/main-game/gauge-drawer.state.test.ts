// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';

/** The game state the drawer reads, by path; the module under test reads it through useGameState. */
const values = new Map<string, Ref<unknown>>();
vi.mock('@/ui/composables/useGameState', () => ({
  useGameState: () => ({
    useValue: (path: string) => {
      if (!values.has(path)) values.set(path, ref(undefined));
      return values.get(path);
    },
  }),
}));

function plotWith(current: number[], ids = current.map((_, i) => `g${i + 1}`)) {
  return {
    activeArcIndex: 0, focusArcId: 'a', pendingConfirmations: [],
    arcs: [{
      id: 'a', title: '档案', synopsis: '', status: 'active', lane: 0, nodes: [],
      gauges: current.map((c, i) => ({
        id: ids[i], name: ids[i], description: '', min: 0, max: 100, current: c, initialValue: c, unit: '%',
        showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25,
      })),
    }],
  };
}

async function load() {
  const { DEFAULT_ENGINE_PATHS } = await import('@/engine/pipeline/types');
  const plot = (v: unknown) => {
    if (!values.has(DEFAULT_ENGINE_PATHS.plotDirection)) values.set(DEFAULT_ENGINE_PATHS.plotDirection, ref(undefined));
    values.get(DEFAULT_ENGINE_PATHS.plotDirection)!.value = v;
  };
  const mod = await import('./gauge-drawer');
  const { eventBus } = await import('@/engine/core/event-bus');
  return { mod, plot, eventBus };
}

/** Mounts the drawer the way the panel's setup does, in a scope the test can stop (the panel unmounting). */
function mount(mod: typeof import('./gauge-drawer')) {
  const scope = effectScope();
  const drawer = scope.run(() => mod.useGaugeDrawer())!;
  return { drawer, unmount: () => scope.stop() };
}

beforeEach(() => {
  vi.resetModules();
  values.clear();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('useGaugeDrawer', () => {
  it('is closed by default and keeps its open state on the device', async () => {
    const { mod, plot } = await load();
    plot(plotWith([10, 20]));
    const { drawer } = mount(mod);
    expect(drawer.open.value).toBe(false);
    expect(drawer.count.value).toBe(2);
    expect(drawer.groups.value).toHaveLength(1);
    drawer.toggle();
    expect(drawer.open.value).toBe(true);
    expect(localStorage.getItem(mod.GAUGE_DRAWER_OPEN_KEY)).toBe('1');

    vi.resetModules();
    const again = await load();
    again.plot(plotWith([10, 20]));
    expect(mount(again.mod).drawer.open.value).toBe(true);
  });

  it('lights the dot for a change while closed, puts it out on opening, and sees changes while open', async () => {
    const { mod, plot } = await load();
    plot(plotWith([10, 20]));
    const { drawer } = mount(mod);
    await nextTick();
    expect(drawer.unseenChange.value).toBe(false);

    plot(plotWith([10, 25]));
    await nextTick();
    expect(drawer.unseenChange.value).toBe(true);

    drawer.toggle();
    await nextTick();
    expect(drawer.unseenChange.value).toBe(false);
    plot(plotWith([40, 25]));
    await nextTick();
    drawer.toggle();
    await nextTick();
    expect(drawer.unseenChange.value).toBe(false);
  });

  it('a change while the panel is away (another tab) still shows when it comes back', async () => {
    const { mod, plot } = await load();
    plot(plotWith([10, 20]));
    const first = mount(mod);
    await nextTick();
    first.unmount();
    plot(plotWith([10, 30]));
    const { drawer } = mount(mod);
    await nextTick();
    expect(drawer.unseenChange.value).toBe(true);
  });

  it('opening another save with the same gauge ids and other values lights nothing', async () => {
    const { mod, plot, eventBus } = await load();
    plot(plotWith([10, 20]));
    const { drawer } = mount(mod);
    await nextTick();
    // engine-state.loadGame writes the tree, then announces the opened save, in the same tick.
    plot(plotWith([70, 80]));
    eventBus.emit('engine:game-opened', { profileId: 'p2', slotId: 's2' });
    await nextTick();
    expect(drawer.unseenChange.value).toBe(false);
  });

  it('storage that throws leaves the drawer working, closed', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { mod, plot } = await load();
    plot(plotWith([10]));
    const { drawer } = mount(mod);
    expect(drawer.open.value).toBe(false);
    expect(() => drawer.toggle()).not.toThrow();
    expect(drawer.open.value).toBe(true);
  });
});
