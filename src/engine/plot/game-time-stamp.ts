// App doc: docs/user-guide/pages/game-plot.md §标尺与横轴 (日期轴采样)
// Design: docs/design/plot-parallel-threads-scheduler.md §D4 / §4.2
/**
 * Plot Threads — game-time snapshot helper.
 *
 * The ONLY place the plot subsystem touches the pack's game-time object.
 * Field names come from `EnginePathConfig.gameTimeFieldNames`, so no Chinese
 * keys leak into engine code. Store, pipeline and UI all call this instead of
 * assembling a stamp themselves (design review fix #8).
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { GameTimeStamp } from './types';

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Map a raw game-time object to a `GameTimeStamp`. Returns `undefined` when
 * nothing numeric could be read (e.g. a pack without a time object), so
 * callers can leave the node field unset instead of storing `{}`.
 */
export function toGameTimeStamp(
  raw: unknown,
  fieldNames: EnginePathConfig['gameTimeFieldNames'],
): GameTimeStamp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const stamp: GameTimeStamp = {};
  const year = num(r[fieldNames.year]);
  const month = num(r[fieldNames.month]);
  const day = num(r[fieldNames.day]);
  const hour = num(r[fieldNames.hour]);
  const minute = num(r[fieldNames.minute]);
  if (year !== undefined) stamp.year = year;
  if (month !== undefined) stamp.month = month;
  if (day !== undefined) stamp.day = day;
  if (hour !== undefined) stamp.hour = hour;
  if (minute !== undefined) stamp.minute = minute;
  return Object.keys(stamp).length > 0 ? stamp : undefined;
}

/** Read the current game time from the state tree as a `GameTimeStamp`. */
export function readGameTimeStamp(
  stateManager: Pick<StateManager, 'get'>,
  paths: Pick<EnginePathConfig, 'gameTime' | 'gameTimeFieldNames'>,
): GameTimeStamp | undefined {
  return toGameTimeStamp(stateManager.get<unknown>(paths.gameTime), paths.gameTimeFieldNames);
}

/**
 * Whole days since an arbitrary epoch, for ordering / interpolation on the
 * scheduler's date axis. Month length is taken as 30 and year as 360 days —
 * the axis only needs monotonic ordering and rough spacing, not calendar
 * accuracy (packs define their own calendars).
 */
export function gameTimeToDayOrdinal(stamp: GameTimeStamp | undefined): number | null {
  if (!stamp) return null;
  const y = stamp.year ?? 0;
  const m = stamp.month ?? 1;
  const d = stamp.day ?? 1;
  if (stamp.year === undefined && stamp.month === undefined && stamp.day === undefined) return null;
  const frac = ((stamp.hour ?? 0) * 60 + (stamp.minute ?? 0)) / (24 * 60);
  return y * 360 + (m - 1) * 30 + (d - 1) + frac;
}
