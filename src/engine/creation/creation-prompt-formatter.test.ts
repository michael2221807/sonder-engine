import { describe, expect, it } from 'vitest';
import type { GamePack } from '@/engine/types/game-pack';
import { formatCreationPromptContext, formatSettledPlayerProfile, formatWorldContext } from './creation-prompt-formatter';

const gamePack = {
  creationFlow: {
    steps: [
      { id: 'world', label: '世界', type: 'select-one', dataSource: 'presets.worlds' },
      { id: 'tier', label: '天资', type: 'select-one', dataSource: 'presets.talentTiers' },
      { id: 'origin', label: '出身', type: 'select-one', dataSource: 'presets.origins' },
      { id: 'trait', label: '特质', type: 'select-one', dataSource: 'presets.traits' },
      { id: 'talents', label: '天赋', type: 'select-many', dataSource: 'presets.talents' },
    ],
  },
} as GamePack;

const choices = {
  selections: {
    world: { name: 'City', description: 'A living city.', genre: 'modern', contentRating: 'general', id: 'w1' },
    tier: { name: 'Gifted', description: 'More build room.', total_points: 20, rarity: 4 },
    origin: { name: 'Courier', description: 'Knows every alley.', talent_cost: 7, genres: ['modern'], attribute_modifiers: { STR: 2 } },
    trait: { name: 'Composed', description: 'Keeps a clear head under pressure.', talent_cost: 4, genres: ['all'] },
    talents: [{ name: 'Alert', description: 'Notices pursuit.', talent_cost: 3, adultOnly: false }],
  },
  attributes: { STR: 8 },
  formValues: { 'character.name': 'Mira', 'character.age': 21 },
};

describe('creation prompt formatter', () => {
  it('projects only canonical world narrative', () => {
    expect(formatWorldContext(gamePack, choices)).toBe('世界：City — A living city.');
  });

  it('includes identity, choices, innate and settled attributes', () => {
    const profile = formatSettledPlayerProfile(gamePack, choices, { STR: 10 });
    expect(profile).toContain('name：Mira');
    expect(profile).toContain('出身：Courier — Knows every alley.');
    expect(profile).toContain('特质：Composed — Keeps a clear head under pressure.');
    expect(profile).toContain('天赋：Alert — Notices pursuit.');
    expect(profile).toContain('先天属性：STR 8');
    expect(profile).toContain('后天属性：STR 10');
  });

  it('does not expose filtering, cost, modifier or rarity metadata', () => {
    const output = formatCreationPromptContext(gamePack, choices, { STR: 10 });
    for (const forbidden of [
      'genre', 'contentRating', 'genres', 'adultOnly', 'talent_cost',
      'attribute_modifiers', 'total_points', 'rarity', '"id"',
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });
});
