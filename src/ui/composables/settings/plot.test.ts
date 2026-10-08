import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ACTIVE_THREADS } from '@/engine/plot/types';
import { defaultPlotSettings, parsePlotSettings, type PlotSettings } from './plot';

type Axis = PlotSettings['timelineAxis'];

/** The parse inside loadPlotSettings() in SettingsPanel.vue before the move, copied as it stood. */
function legacyLoad(text: string): PlotSettings {
  const raw = JSON.parse(text) as Partial<PlotSettings>;
  const cap = typeof raw.maxActiveThreads === 'number' && Number.isFinite(raw.maxActiveThreads)
    ? Math.max(1, Math.min(5, Math.round(raw.maxActiveThreads)))
    : defaultPlotSettings.maxActiveThreads;
  const axis: Axis = raw.timelineAxis === 'date' ? 'date' : 'round';
  return { ...defaultPlotSettings, ...raw, maxActiveThreads: cap, timelineAxis: axis };
}

const CORPUS = [
  '{}',
  '{"maxActiveThreads":0}',
  '{"maxActiveThreads":2.6}',
  '{"maxActiveThreads":99}',
  '{"maxActiveThreads":-4}',
  '{"maxActiveThreads":"3"}',
  '{"maxActiveThreads":null}',
  '{"timelineAxis":"date"}',
  '{"timelineAxis":"week"}',
  '{"enabled":false,"criticalConfirmGate":false,"confidenceThreshold":0.2,"opportunityMaxTier":1,"unknown":true}',
  '[]',
  '"x"',
];

describe('parsePlotSettings', () => {
  it('returns the defaults for an empty blob', () => {
    expect(parsePlotSettings('{}')).toEqual(defaultPlotSettings);
    expect(defaultPlotSettings.maxActiveThreads).toBe(DEFAULT_MAX_ACTIVE_THREADS);
  });

  it('keeps the thread cap in 1-5 and rounds it; a non-number falls back to the default', () => {
    expect(parsePlotSettings('{"maxActiveThreads":0}').maxActiveThreads).toBe(1);
    expect(parsePlotSettings('{"maxActiveThreads":2.6}').maxActiveThreads).toBe(3);
    expect(parsePlotSettings('{"maxActiveThreads":99}').maxActiveThreads).toBe(5);
    expect(parsePlotSettings('{"maxActiveThreads":"3"}').maxActiveThreads).toBe(DEFAULT_MAX_ACTIVE_THREADS);
  });

  it('only accepts date as a non-default timeline axis', () => {
    expect(parsePlotSettings('{"timelineAxis":"date"}').timelineAxis).toBe('date');
    expect(parsePlotSettings('{"timelineAxis":"week"}').timelineAxis).toBe('round');
  });

  it('gives the same result as the inline code it replaced, including what it throws on', () => {
    for (const text of CORPUS) expect(parsePlotSettings(text)).toEqual(legacyLoad(text));
    for (const text of ['', '{', 'null']) {
      expect(() => parsePlotSettings(text)).toThrow();
      expect(() => legacyLoad(text)).toThrow();
    }
  });
});
