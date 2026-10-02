import { afterEach, expect, it, vi } from 'vitest';
import { randomId, readPlotVectorControl, releaseOpen, writePlotVectorControl, PLOT_VECTOR_CONTROL_EVENT, PLOT_VECTOR_CONTROL_KEY } from './feature-control';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('the release gate stays open only for unset, empty or on/true/1/yes, in any case; any other value closes it', () => {
  for (const value of [undefined, '', ' ', 'on', 'ON', 'true', '1', 'yes']) expect(releaseOpen(value), String(value)).toBe(true);
  for (const value of ['off', 'OFF', ' Off ', 'false', 'FALSE', '0', 'no', 'disabled', 'closed', 'off.']) expect(releaseOpen(value), value).toBe(false);
});
it('a build with the gate off reads a stored choice as off and refuses to turn the feature on', async () => {
  vi.stubEnv('VITE_PLOT_VECTOR_RELEASE', 'off');
  vi.resetModules();
  const values = new Map([[PLOT_VECTOR_CONTROL_KEY, JSON.stringify({ enabled: true, epoch: 'from-an-open-build' })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', new EventTarget());
  const closed = await import('./feature-control');
  expect(closed.plotVectorAvailable).toBe(false);
  expect(closed.readPlotVectorControl().enabled).toBe(false);
  expect(() => closed.writePlotVectorControl(true)).toThrow();
  // The player's choice is kept as it was, for a build that opens the feature again.
  expect(JSON.parse(values.get(PLOT_VECTOR_CONTROL_KEY) ?? 'null')).toEqual({ enabled: true, epoch: 'from-an-open-build' });
});
it('can invalidate old tasks on LAN HTTP where randomUUID is unavailable', () => {
  const values = new Map<string, string>();
  const random = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', {getRandomValues: random});
  vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)});
  const target = new EventTarget(), listener = vi.fn();
  vi.stubGlobal('window', target); target.addEventListener(PLOT_VECTOR_CONTROL_EVENT, listener);
  writePlotVectorControl(false); const first = readPlotVectorControl();
  writePlotVectorControl(false); const second = readPlotVectorControl();
  expect(first.enabled).toBe(false); expect(second.enabled).toBe(false);
  expect(first.epoch).not.toBe(second.epoch); expect(listener).toHaveBeenCalledTimes(2);
});
it('ids stay strongly random without randomUUID, and never fall back to Math.random', () => {
  const random = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', {getRandomValues: random});
  const weak = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('weak randomness used'); });
  const ids = new Set(Array.from({ length: 64 }, () => randomId()));
  expect(ids.size).toBe(64);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/); // 128 bits; also a valid CSP nonce
  vi.stubGlobal('crypto', {});
  expect(() => randomId()).toThrow();
  expect(weak).not.toHaveBeenCalled();
  weak.mockRestore();
});
