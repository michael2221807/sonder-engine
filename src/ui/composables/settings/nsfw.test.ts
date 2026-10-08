import { describe, expect, it } from 'vitest';
import { defaultNsfw, parseNsfwSettings, type NsfwSettings } from './nsfw';

/** The parse inside loadNsfwSettings() in SettingsPanel.vue before the move, copied as it stood. */
function legacyParse(raw: string): NsfwSettings {
  const parsed = JSON.parse(raw) as Partial<NsfwSettings>;
  return {
    nsfwMode: typeof parsed.nsfwMode === 'boolean' ? parsed.nsfwMode : defaultNsfw.nsfwMode,
    nsfwGenderFilter:
      parsed.nsfwGenderFilter === 'all' ||
      parsed.nsfwGenderFilter === 'male' ||
      parsed.nsfwGenderFilter === 'female'
        ? parsed.nsfwGenderFilter
        : defaultNsfw.nsfwGenderFilter,
  };
}

const CORPUS = [
  '{}',
  '{"nsfwMode":true}',
  '{"nsfwMode":"yes","nsfwGenderFilter":"all"}',
  '{"nsfwMode":false,"nsfwGenderFilter":"male"}',
  '{"nsfwGenderFilter":"other"}',
  '{"nsfwMode":true,"nsfwGenderFilter":"female","extra":1}',
  '[]',
  '"text"',
  '0',
];

describe('parseNsfwSettings', () => {
  it('defaults to off / female', () => {
    expect(defaultNsfw).toEqual({ nsfwMode: false, nsfwGenderFilter: 'female' });
    expect(parseNsfwSettings('{}')).toEqual(defaultNsfw);
  });

  it('keeps valid stored values and falls back per field', () => {
    expect(parseNsfwSettings('{"nsfwMode":true,"nsfwGenderFilter":"male"}')).toEqual({ nsfwMode: true, nsfwGenderFilter: 'male' });
    expect(parseNsfwSettings('{"nsfwMode":"yes","nsfwGenderFilter":"x"}')).toEqual(defaultNsfw);
  });

  it('gives the same result as the inline code it replaced, including what it throws on', () => {
    for (const raw of CORPUS) expect(parseNsfwSettings(raw)).toEqual(legacyParse(raw));
    for (const raw of ['', '{', 'null']) {
      expect(() => parseNsfwSettings(raw)).toThrow();
      expect(() => legacyParse(raw)).toThrow();
    }
  });
});
