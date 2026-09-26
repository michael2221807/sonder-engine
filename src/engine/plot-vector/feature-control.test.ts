import { afterEach, expect, it, vi } from 'vitest';
import { randomId, readPlotVectorControl, writePlotVectorControl, PLOT_VECTOR_CONTROL_EVENT } from './feature-control';
afterEach(() => vi.unstubAllGlobals());
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
