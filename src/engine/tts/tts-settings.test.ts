import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadTtsSettings, saveTtsSettings, normalizeTtsSettings, TTS_SETTINGS_STORAGE_KEY,
} from '@/engine/tts/tts-settings';
import { DEFAULT_TTS_SETTINGS } from '@/engine/tts/types';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';

let mock: ReturnType<typeof createMockLocalStorage>;

beforeEach(() => {
  mock = createMockLocalStorage();
  mock.install();
});
afterEach(() => {
  mock.restore();
});

describe('normalizeTtsSettings', () => {
  it('fills defaults for empty/garbage input', () => {
    expect(normalizeTtsSettings(null)).toEqual(DEFAULT_TTS_SETTINGS);
    expect(normalizeTtsSettings('nope')).toEqual(DEFAULT_TTS_SETTINGS);
    expect(normalizeTtsSettings(42)).toEqual(DEFAULT_TTS_SETTINGS);
  });

  it('clamps rate to [0.5, 2] and volume to [0, 1]', () => {
    expect(normalizeTtsSettings({ rate: 99 }).rate).toBe(2);
    expect(normalizeTtsSettings({ rate: 0.01 }).rate).toBe(0.5);
    expect(normalizeTtsSettings({ volume: 5 }).volume).toBe(1);
    expect(normalizeTtsSettings({ volume: -1 }).volume).toBe(0);
  });

  it('coerces transmissionMode to stream unless exactly "full" (migrates legacy "segment")', () => {
    expect(normalizeTtsSettings({ transmissionMode: 'full' }).transmissionMode).toBe('full');
    expect(normalizeTtsSettings({ transmissionMode: 'stream' }).transmissionMode).toBe('stream');
    // legacy value from the pre-streaming implementation → migrated to 'stream'
    expect(normalizeTtsSettings({ transmissionMode: 'segment' as unknown as 'full' }).transmissionMode).toBe('stream');
    expect(normalizeTtsSettings({ transmissionMode: 'weird' as unknown as 'full' }).transmissionMode).toBe('stream');
  });

  it('backend: keeps doubao, falls back to cosyvoice for unknown/missing (epic P2)', () => {
    expect(normalizeTtsSettings({ backend: 'doubao' }).backend).toBe('doubao');
    expect(normalizeTtsSettings({ backend: 'bogus' }).backend).toBe('cosyvoice');
    expect(normalizeTtsSettings({}).backend).toBe('cosyvoice');
  });

  it('sanitizes favorites, dropping entries with no speaker', () => {
    const favs = normalizeTtsSettings({
      favorites: [
        { speaker: 'jok老师', instruct: '四川话' },
        { speaker: '', instruct: 'x' },
        { instruct: 'no-speaker' },
        'garbage',
      ] as unknown as [],
    }).favorites;
    expect(favs).toEqual([{ speaker: 'jok老师', instruct: '四川话' }]);
  });
});

describe('load / save roundtrip', () => {
  it('returns defaults when nothing stored', () => {
    expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
  });

  it('persists and reloads settings identically', () => {
    const settings = {
      ...DEFAULT_TTS_SETTINGS,
      enabled: true,
      autoNarrateOnRound: true,
      defaultSpeaker: 'jok老师',
      defaultInstruct: '四川话',
      rate: 1.2,
      volume: 0.7,
      favorites: [{ speaker: 'coolkey', instruct: '' }],
    };
    saveTtsSettings(settings);
    expect(loadTtsSettings()).toEqual(settings);
  });

  it('read-merge preserves unknown forward-compat keys in storage', () => {
    localStorage.setItem(TTS_SETTINGS_STORAGE_KEY, JSON.stringify({ enabled: true, futureField: 'keep-me' }));
    saveTtsSettings({ ...DEFAULT_TTS_SETTINGS, enabled: false });
    const raw = JSON.parse(localStorage.getItem(TTS_SETTINGS_STORAGE_KEY)!);
    expect(raw.futureField).toBe('keep-me');
    expect(raw.enabled).toBe(false);
  });

  it('recovers from malformed stored JSON', () => {
    localStorage.setItem(TTS_SETTINGS_STORAGE_KEY, '{ not valid json');
    expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
  });
});
