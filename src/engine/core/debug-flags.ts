// App doc: docs/user-guide/pages/home.md §高级设置
/**
 * Debug flags — engine-side readers for the settings panel's advanced debug
 * toggles (设置 → 高级设置).
 *
 * SettingsPanel persists `{ debugMode, consoleDebug, aiLogging }` at
 * localStorage key `aga_debug_settings`. `debugMode` is the master switch:
 * the UI hides the two sub-toggles while it is off, and a persisted-but-hidden
 * sub-value must have no effect — so both helpers return false unless
 * `debugMode` itself is true.
 *
 * Reads are lazy (fresh localStorage parse per call, no caching): all callers
 * are per-round / per-AI-call frequency, and a lazy read means flipping the
 * toggle takes effect on the next call without any event wiring. The try/catch
 * plus `typeof` guard covers privacy-mode localStorage and the node test
 * environment (vitest runs the engine suite with environment: 'node').
 *
 * Content separation note: this module reads a UI-owned settings blob but
 * contains no game-specific content — it is engine infrastructure, same tier
 * as `engram-config.ts`.
 */

export const DEBUG_SETTINGS_KEY = 'aga_debug_settings';

interface DebugSettingsShape {
  debugMode?: unknown;
  consoleDebug?: unknown;
  aiLogging?: unknown;
}

function readSettings(): DebugSettingsShape {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(DEBUG_SETTINGS_KEY) ?? '{}') as DebugSettingsShape;
  } catch {
    return {};
  }
}

/**
 * "Console 详细日志" — verbose engine console logging.
 * Consumed by `logger.debug` / `logger.info`, which are otherwise silent in
 * production builds.
 */
export function isConsoleDebugEnabled(): boolean {
  const s = readSettings();
  return s.debugMode === true && s.consoleDebug === true;
}

/**
 * "AI API 完整记录（含 prompt/response）" — full request/response console
 * logging for every LLM call. Consumed by `AIService.doGenerate`.
 */
export function isAiLoggingEnabled(): boolean {
  const s = readSettings();
  return s.debugMode === true && s.aiLogging === true;
}
