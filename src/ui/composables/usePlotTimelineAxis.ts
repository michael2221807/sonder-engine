// App doc: docs/user-guide/pages/game-plot.md §标尺与横轴 (回合/日期切换与设置同步)
/**
 * usePlotTimelineAxis — the ONE writer for 设置→剧情导向→时间线横轴.
 *
 * Two controls change this value (SettingsPanel's select and the scheduler's
 * 回合/日期 toggle). Both go through here so the state tree and the persisted
 * `aga_plot_settings` blob never disagree (P3 review fix, 2026-08-22).
 *
 * Design: docs/design/plot-parallel-threads-scheduler.md §4.4 / D4
 */
import type { AxisMode } from '@/ui/components/panels/plot/scheduler-layout';

export const PLOT_SETTINGS_STORAGE_KEY = 'aga_plot_settings';
export const PLOT_TIMELINE_AXIS_PATH = '系统.设置.plot.timelineAxis';

export function writePlotTimelineAxis(
  setValue: (path: string, value: unknown) => void,
  mode: AxisMode,
): void {
  setValue(PLOT_TIMELINE_AXIS_PATH, mode);
  try {
    const raw = JSON.parse(localStorage.getItem(PLOT_SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    raw['timelineAxis'] = mode;
    localStorage.setItem(PLOT_SETTINGS_STORAGE_KEY, JSON.stringify(raw));
  } catch { /* storage unavailable or corrupt — the state tree still holds the live value */ }
}
