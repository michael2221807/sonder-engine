import { afterEach, expect, it, vi } from 'vitest';
import { readPlotVectorControl, writePlotVectorControl, writePlotVectorSettlementMode, PLOT_VECTOR_CONTROL_EVENT } from './feature-control';
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
it('keeps inline as the old default and invalidates request identity when the experimental mode changes', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)});
  vi.stubGlobal('window', new EventTarget());
  expect(readPlotVectorControl().settlement).toBe('inline');
  writePlotVectorControl(true);
  const before = readPlotVectorControl();
  writePlotVectorSettlementMode('separate');
  const after = readPlotVectorControl();
  expect(after).toMatchObject({ enabled: true, settlement: 'separate' });
  expect(after.epoch).not.toBe(before.epoch);
  writePlotVectorControl(false);
  expect(readPlotVectorControl().settlement).toBe('separate');
});
