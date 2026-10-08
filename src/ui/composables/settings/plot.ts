/**
 * Plot direction settings definitions and the stored-value parser, moved out of SettingsPanel.vue
 * (refactor R7 step 9). The panel keeps the ref, the state-tree sync and the watchers.
 */
import { DEFAULT_MAX_ACTIVE_THREADS } from '@/engine/plot/types';
import type { AxisMode as PlotTimelineAxis } from '@/ui/components/panels/plot/scheduler-layout';

export const PLOT_SETTINGS_KEY = 'aga_plot_settings';

export interface PlotSettings {
  enabled: boolean;
  criticalConfirmGate: boolean;
  confidenceThreshold: number;
  showGaugesInMainPanel: boolean;
  opportunityMaxTier: 1 | 2 | 3;
  autoAdvanceSkippable: boolean;
  showEvalLog: boolean;
  /** Plot Threads D2: how many threads may be active at once (1-5). */
  maxActiveThreads: number;
  /**
   * Plot Threads D4: scheduler view axis. Persisted in this blob for reload, but
   * the LIVE value is the state tree (`系统.设置.plot.timelineAxis`) — both this
   * panel and the scheduler's own toggle write it through `writePlotTimelineAxis`,
   * so the two controls never hold two copies (review fix, 2026-08-22).
   */
  timelineAxis: PlotTimelineAxis;
}

export const defaultPlotSettings: PlotSettings = {
  enabled: true,
  criticalConfirmGate: true,
  confidenceThreshold: 0.7,
  showGaugesInMainPanel: true,
  opportunityMaxTier: 3,
  autoAdvanceSkippable: true,
  showEvalLog: false,
  maxActiveThreads: DEFAULT_MAX_ACTIVE_THREADS,
  timelineAxis: 'round',
};

/** The settings in a stored JSON text; throws when the text is not JSON (the caller's try/catch falls back). */
export function parsePlotSettings(text: string): PlotSettings {
  const raw = JSON.parse(text) as Partial<PlotSettings>;
  // Plot Threads: validate on load (same discipline as loadLowLoadSettings) — a
  // NaN cap would silently disable the concurrency limit in plot-store.activateArc.
  const cap = typeof raw.maxActiveThreads === 'number' && Number.isFinite(raw.maxActiveThreads)
    ? Math.max(1, Math.min(5, Math.round(raw.maxActiveThreads)))
    : defaultPlotSettings.maxActiveThreads;
  const axis: PlotTimelineAxis = raw.timelineAxis === 'date' ? 'date' : 'round';
  return { ...defaultPlotSettings, ...raw, maxActiveThreads: cap, timelineAxis: axis };
}
