/**
 * debug-flags — readers for 设置 → 高级设置 debug toggles (2026-08-26 dead-control fix).
 *
 * Contract under test:
 *   - `debugMode` is the master switch: sub-flags persisted true while the
 *     master is off must read as false (the UI hides them; hidden = inert).
 *   - Missing key / malformed JSON / non-boolean values / no localStorage at
 *     all (node env, privacy mode) → false, never a throw.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isConsoleDebugEnabled, isAiLoggingEnabled, DEBUG_SETTINGS_KEY } from './debug-flags';

function stubStorage(value: string | null): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === DEBUG_SETTINGS_KEY ? value : null),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('debug-flags', () => {
  it('both flags on when master + sub-toggle are true', () => {
    stubStorage(JSON.stringify({ debugMode: true, consoleDebug: true, aiLogging: true }));
    expect(isConsoleDebugEnabled()).toBe(true);
    expect(isAiLoggingEnabled()).toBe(true);
  });

  it('master switch off gates persisted sub-toggles (hidden = inert)', () => {
    stubStorage(JSON.stringify({ debugMode: false, consoleDebug: true, aiLogging: true }));
    expect(isConsoleDebugEnabled()).toBe(false);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('sub-toggles are independent of each other', () => {
    stubStorage(JSON.stringify({ debugMode: true, consoleDebug: true, aiLogging: false }));
    expect(isConsoleDebugEnabled()).toBe(true);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('missing key → false', () => {
    stubStorage(null);
    expect(isConsoleDebugEnabled()).toBe(false);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('malformed JSON → false, no throw', () => {
    stubStorage('{not json');
    expect(isConsoleDebugEnabled()).toBe(false);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('non-boolean truthy values (e.g. "true" strings) do NOT count as enabled', () => {
    stubStorage(JSON.stringify({ debugMode: 'true', consoleDebug: 1, aiLogging: 'yes' }));
    expect(isConsoleDebugEnabled()).toBe(false);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('no localStorage global (node env / privacy mode) → false, no throw', () => {
    // vitest runs with environment:'node' — there is no localStorage unless stubbed.
    expect(typeof localStorage).toBe('undefined');
    expect(isConsoleDebugEnabled()).toBe(false);
    expect(isAiLoggingEnabled()).toBe(false);
  });

  it('reads are lazy — a flip takes effect on the next call without events', () => {
    stubStorage(JSON.stringify({ debugMode: true, aiLogging: false }));
    expect(isAiLoggingEnabled()).toBe(false);
    stubStorage(JSON.stringify({ debugMode: true, aiLogging: true }));
    expect(isAiLoggingEnabled()).toBe(true);
  });
});
