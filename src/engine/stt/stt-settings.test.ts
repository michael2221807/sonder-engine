import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeSttSettings, loadSttSettings, saveSttSettings, STT_SETTINGS_STORAGE_KEY,
} from '@/engine/stt/stt-settings';
import { DEFAULT_STT_SETTINGS } from '@/engine/stt/types';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';

describe('normalizeSttSettings', () => {
  it('empty/garbage → defaults', () => {
    expect(normalizeSttSettings(null)).toEqual(DEFAULT_STT_SETTINGS);
    expect(normalizeSttSettings('x')).toEqual(DEFAULT_STT_SETTINGS);
    expect(normalizeSttSettings({})).toEqual(DEFAULT_STT_SETTINGS);
  });
  it('keeps valid fields', () => {
    const s = normalizeSttSettings({ enabled: false, backend: 'doubao', mode: 'stream', latency: 'fast', firstUseHint: false, hotwordEnabled: false, hotwordStrength: 'strong', pauseTolerance: 'long' });
    expect(s).toEqual({ enabled: false, backend: 'doubao', mode: 'stream', latency: 'fast', firstUseHint: false, hotwordEnabled: false, hotwordStrength: 'strong', pauseTolerance: 'long' });
  });
  it('unknown backend falls back to cosyvoice (epic P3)', () => {
    expect(normalizeSttSettings({ backend: 'bogus' }).backend).toBe('cosyvoice');
    expect(normalizeSttSettings({}).backend).toBe('cosyvoice');
  });
  it('rejects invalid enum values → fall back to default', () => {
    const s = normalizeSttSettings({ mode: 'bogus', latency: 'turbo', hotwordStrength: 'nuclear', pauseTolerance: 'forever' });
    expect(s.mode).toBe(DEFAULT_STT_SETTINGS.mode);
    expect(s.latency).toBe(DEFAULT_STT_SETTINGS.latency);
    expect(s.hotwordStrength).toBe(DEFAULT_STT_SETTINGS.hotwordStrength);
    expect(s.pauseTolerance).toBe(DEFAULT_STT_SETTINGS.pauseTolerance);
  });
  it('non-boolean toggles → default', () => {
    const s = normalizeSttSettings({ enabled: 'yes', firstUseHint: 1 });
    expect(s.enabled).toBe(DEFAULT_STT_SETTINGS.enabled);
    expect(s.firstUseHint).toBe(DEFAULT_STT_SETTINGS.firstUseHint);
  });
});

describe('load/save roundtrip', () => {
  let mock: ReturnType<typeof createMockLocalStorage>;
  beforeEach(() => { mock = createMockLocalStorage(); mock.install(); });
  afterEach(() => mock.restore());

  it('load with no stored value → defaults', () => {
    expect(loadSttSettings()).toEqual(DEFAULT_STT_SETTINGS);
  });
  it('save then load roundtrips', () => {
    saveSttSettings({ enabled: false, backend: 'doubao', mode: 'record', latency: 'stable', firstUseHint: false, hotwordEnabled: false, hotwordStrength: 'medium', pauseTolerance: 'short' });
    expect(loadSttSettings()).toEqual({ enabled: false, backend: 'doubao', mode: 'record', latency: 'stable', firstUseHint: false, hotwordEnabled: false, hotwordStrength: 'medium', pauseTolerance: 'short' });
  });
  it('save preserves unknown forward-compat keys (read-merge)', () => {
    localStorage.setItem(STT_SETTINGS_STORAGE_KEY, JSON.stringify({ futureFlag: 7 }));
    saveSttSettings({ ...DEFAULT_STT_SETTINGS, mode: 'stream' });
    const raw = JSON.parse(localStorage.getItem(STT_SETTINGS_STORAGE_KEY)!);
    expect(raw.futureFlag).toBe(7);
    expect(raw.mode).toBe('stream');
  });
  it('load tolerates malformed JSON → defaults', () => {
    localStorage.setItem(STT_SETTINGS_STORAGE_KEY, '{bad');
    expect(loadSttSettings()).toEqual(DEFAULT_STT_SETTINGS);
  });
});
