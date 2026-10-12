// App doc: docs/user-guide/pages/game-main.md §3.1 剧情度量抽屉
/**
 * The round status bar's gauge drawer (2026-10-10): the active threads' gauges left the bar's first row for a drawer
 * that opens below it. This module holds what the drawer shows, whether it is open (kept per device) and whether a
 * value changed while it was closed (the toggle's dot).
 *
 * 2026-10-12 (PO): every active thread's gauges show, grouped by thread, the focus thread first — before, only the
 * focus thread's did (design plot-parallel-threads-scheduler.md §5.4), which read as "only the newest thread".
 *
 * Open state and the "seen" values live at module level: the panel mounts again on every tab switch, and neither
 * should reset then.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import { SYSTEM_PATHS } from '@/engine/pipeline/system-paths';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { resolveFocusArc } from '@/engine/plot/types';
import type { PlotArc, PlotDirectionState, PlotGauge } from '@/engine/plot/types';
import { useGameState } from '@/ui/composables/useGameState';

export interface MainPanelGauge {
  gauge: PlotGauge;
  /** 0–100, where `current` sits between `min` and `max`. */
  pct: number;
  /** The value as the bar shows it: a percentage for `%` gauges, else the number and its unit. */
  text: string;
  /** The thread the gauge belongs to. */
  arcId: string;
  thread: string;
  /** Unique in the drawer: thread, gauge id and, for a gauge id repeated in one thread, its occurrence. */
  key: string;
}

/** One active thread's gauges in the drawer. */
export interface MainPanelGaugeGroup {
  arcId: string;
  title: string;
  /** The thread's lane colour, when it has one. */
  color?: string;
  focus: boolean;
  gauges: MainPanelGauge[];
}

function toMainPanelGauge(arc: PlotArc, gauge: PlotGauge, occurrence: number): MainPanelGauge {
  const range = gauge.max - gauge.min;
  const pct = range > 0 ? Math.round(((gauge.current - gauge.min) / range) * 100) : 0;
  return {
    gauge, pct, text: gauge.unit === '%' ? `${pct}%` : `${gauge.current}${gauge.unit}`, arcId: arc.id, thread: arc.title,
    key: `${arc.id}\u0001${gauge.id}${occurrence > 0 ? `\u0001${occurrence}` : ''}`,
  };
}

/** Lane order as the scheduler, the plot panel and the injector use it: no lane goes last, ties keep the list order. */
function byLane(a: { arc: PlotArc; index: number }, b: { arc: PlotArc; index: number }): number {
  const la = a.arc.lane ?? Infinity;
  const lb = b.arc.lane ?? Infinity;
  if (la !== lb) return la < lb ? -1 : 1;
  return a.index - b.index;
}

/**
 * Every active thread's gauges flagged for the main panel, one group per thread: the focus thread first, then the
 * others in their scheduler lane order (a thread without a lane after those with one). A thread with no such gauge
 * has no group. None when the main-panel setting or plot direction is off.
 */
export function mainPanelGaugeGroups(
  plotState: PlotDirectionState | undefined,
  showInMainPanel: boolean | undefined,
  plotEnabled: boolean | undefined,
): MainPanelGaugeGroup[] {
  if (showInMainPanel === false || plotEnabled === false || !plotState) return [];
  const focus = resolveFocusArc(plotState);
  const active = plotState.arcs
    .map((arc, index) => ({ arc, index }))
    .filter(({ arc }) => arc.status === 'active')
    .sort((a, b) => {
      if (a.arc.id === focus?.id) return -1;
      if (b.arc.id === focus?.id) return 1;
      return byLane(a, b);
    });
  const groups: MainPanelGaugeGroup[] = [];
  for (const { arc } of active) {
    const occurrences = new Map<string, number>();
    const gauges = arc.gauges.filter((g) => g.showInMainPanel).map((g) => {
      const occurrence = occurrences.get(g.id) ?? 0;
      occurrences.set(g.id, occurrence + 1);
      return toMainPanelGauge(arc, g, occurrence);
    });
    if (gauges.length === 0) continue;
    groups.push({ arcId: arc.id, title: arc.title, color: arc.color, focus: arc.id === focus?.id, gauges });
  }
  return groups;
}

/** Every value the drawer shows, by thread and gauge: what "seen" compares. */
export type GaugeSnapshot = Record<string, number>;

export function gaugeSnapshot(groups: readonly MainPanelGaugeGroup[]): GaugeSnapshot {
  const out: GaugeSnapshot = {};
  for (const group of groups) for (const g of group.gauges) out[g.key] = g.gauge.current;
  return out;
}

/**
 * The values the reader has seen, after this change. While the drawer is open, or before anything was seen: all of
 * them. Closed: what was seen stays; a gauge that just appeared (a thread activated) counts as seen at the value it
 * came with, so its arrival is no "change"; a gauge gone (a thread ended) is dropped.
 */
export function nextSeen(seen: GaugeSnapshot | null, current: GaugeSnapshot, open: boolean): GaugeSnapshot {
  if (open || !seen) return { ...current };
  const next: GaugeSnapshot = {};
  for (const [key, value] of Object.entries(current)) next[key] = key in seen ? seen[key] : value;
  return next;
}

/** A gauge the reader has seen shows another value now, and the drawer is closed. */
export function hasUnseenChange(seen: GaugeSnapshot | null, current: GaugeSnapshot, open: boolean): boolean {
  if (open || !seen) return false;
  return Object.entries(current).some(([key, value]) => key in seen && seen[key] !== value);
}

/** localStorage key of the drawer's open state (a device's UI preference; the `aga_` prefix puts it in backups). */
export const GAUGE_DRAWER_OPEN_KEY = 'aga_gauge_drawer_open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(GAUGE_DRAWER_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(GAUGE_DRAWER_OPEN_KEY, open ? '1' : '0');
  } catch { /* storage blocked: the drawer still works for this visit */ }
}

const drawerOpen = ref(readOpen());
const seenSnapshot = ref<GaugeSnapshot | null>(null);

// A save opened (loaded, continued, another slot): its gauges are new to the reader even when their ids are the same
// as the last save's, so nothing seen carries over — the next snapshot is taken as seen. Subscribed once for the page.
eventBus.on('engine:game-opened', () => { seenSnapshot.value = null; });

export interface GaugeDrawer {
  groups: ComputedRef<MainPanelGaugeGroup[]>;
  /** How many gauges the drawer shows, over all groups. */
  count: ComputedRef<number>;
  open: Ref<boolean>;
  unseenChange: ComputedRef<boolean>;
  toggle: () => void;
}

/** The drawer for the status bar. Call once in the panel's setup; its watcher ends with the panel. */
export function useGaugeDrawer(): GaugeDrawer {
  const { useValue } = useGameState();
  const plotState = useValue<PlotDirectionState | undefined>(DEFAULT_ENGINE_PATHS.plotDirection);
  // Same literal SettingsPanel writes (no path constant exists for it; moved here unchanged from PlotGaugeStrip).
  const showInMainPanel = useValue<boolean | undefined>('系统.设置.plot.showGaugesInMainPanel');
  const plotEnabled = useValue<boolean | undefined>(SYSTEM_PATHS.plotEnabled);

  const groups = computed(() => mainPanelGaugeGroups(plotState.value, showInMainPanel.value, plotEnabled.value));
  const count = computed(() => groups.value.reduce((n, g) => n + g.gauges.length, 0));
  const snapshot = computed(() => gaugeSnapshot(groups.value));

  watch([snapshot, drawerOpen], ([current, open]) => {
    seenSnapshot.value = nextSeen(seenSnapshot.value, current, open);
  }, { immediate: true });

  const unseenChange = computed(() => hasUnseenChange(seenSnapshot.value, snapshot.value, drawerOpen.value));

  function toggle(): void {
    drawerOpen.value = !drawerOpen.value;
    writeOpen(drawerOpen.value);
  }

  return { groups, count, open: drawerOpen, unseenChange, toggle };
}
