import { describe, expect, it } from 'vitest';
import type { CustomPresetSchema } from '@/engine/types/game-pack';
import {
  buildCustomPresetFormData,
  normalizeCustomPresetFormData,
  validateCustomPresetForm,
} from './custom-preset-form';

const schema: CustomPresetSchema = {
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'talent_cost', label: 'Cost', type: 'number', min: 0, max: 30 },
    { key: 'genres', label: 'Genre', type: 'select', required: true, options: ['all', 'modern'] },
    { key: 'adultOnly', label: 'Adult', type: 'checkbox', default: false },
  ],
};

describe('custom preset form contract', () => {
  it('initializes select/checkbox defaults and preserves edit values', () => {
    expect(buildCustomPresetFormData(schema)).toEqual({
      name: '', talent_cost: 0, genres: 'all', adultOnly: false,
    });
    expect(buildCustomPresetFormData(schema, {
      name: 'Edited', talent_cost: 4, genres: ['modern'], adultOnly: true,
    })).toEqual({
      name: 'Edited', talent_cost: 4, genres: ['modern'], adultOnly: true,
    });
  });

  it('normalizes submitted values without stringifying booleans', () => {
    expect(normalizeCustomPresetFormData(schema, {
      name: 'Entry', talent_cost: '7', genres: 'modern', adultOnly: true,
    })).toEqual({
      name: 'Entry', talent_cost: 7, genres: ['modern'], adultOnly: true,
    });
  });

  it('rejects negative custom costs and invalid select values', () => {
    expect(validateCustomPresetForm(schema, {
      name: 'Entry', talent_cost: -1, genres: 'fantasy', adultOnly: false,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'min', key: 'talent_cost' }),
      expect.objectContaining({ type: 'option', key: 'genres' }),
    ]));
  });
});
