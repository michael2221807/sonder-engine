import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStatFields } from '@/engine/pack/stat-section-reader';

const packRoot = 'public/packs/tianming';
const genres = ['modern', 'wuxia', 'fantasy', 'dystopia'] as const;

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(`${packRoot}/${relativePath}`, 'utf8')) as T;
}

describe('Tianming creation pack contract', () => {
  it('keeps the candidate catalog pre-release until product approval', () => {
    const manifest = json<Record<string, unknown>>('manifest.json');
    expect(manifest.version).toBe('0.5.0');
    expect(manifest.description).toBe('天命 Game Pack — 六维创角系统，4+4 世界，七档天资，56 出身，48 特质，77 天赋');
  });

  it('ships exactly one general and one NSFW world for every launch genre', () => {
    const worlds = json<Array<Record<string, unknown>>>('presets/worlds.json');
    expect(worlds).toHaveLength(8);
    expect(new Set(worlds.map((world) => world.id)).size).toBe(worlds.length);

    for (const genre of genres) {
      expect(worlds.filter((world) => world.genre === genre && world.contentRating === 'general')).toHaveLength(1);
      expect(worlds.filter((world) => world.genre === genre && world.contentRating === 'nsfw')).toHaveLength(1);
    }

    const innerOuterWorld = worlds.find((world) => world.name === '表里世界');
    expect(innerOuterWorld).toMatchObject({ genre: 'modern', contentRating: 'nsfw' });
    expect(String(innerOuterWorld?.description)).not.toMatch(/浣海市|天穹俱乐部|素琴|神秘男人|夹层清册/);

    expect(worlds.map((world) => world.name)).toEqual([
      '人间潮汐',
      '山河有信',
      '水晶纪元',
      '新巴别城',
      '表里世界',
      '承嗣令',
      '欲晶圣约',
      '承重者协议',
    ]);
  });

  it('gives every shared option explicit genre and adult visibility metadata', () => {
    const allowedScopes = new Set<string>(['all', ...genres]);
    const expectedCounts: Record<string, number> = {
      'origins.json': 56,
      'traits.json': 48,
      'talents.json': 77,
    };

    for (const file of ['origins.json', 'traits.json', 'talents.json']) {
      const entries = json<Array<Record<string, unknown>>>(`presets/${file}`);
      expect(entries).toHaveLength(expectedCounts[file]);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);

      for (const entry of entries) {
        expect(typeof entry.name).toBe('string');
        expect(typeof entry.description).toBe('string');
        expect((entry.description as string).length).toBeGreaterThanOrEqual(45);
        expect(typeof entry.talent_cost).toBe('number');
        expect(typeof entry.adultOnly).toBe('boolean');
        expect(Array.isArray(entry.genres)).toBe(true);
        expect((entry.genres as string[]).length).toBeGreaterThan(0);
        expect((entry.genres as string[]).every((genre) => allowedScopes.has(genre))).toBe(true);
      }

      for (const genre of genres) {
        const applies = (entry: Record<string, unknown>) => {
          const scopes = entry.genres as string[];
          return scopes.includes('all') || scopes.includes(genre);
        };
        expect(entries.some((entry) => entry.adultOnly === false && applies(entry))).toBe(true);
        expect(entries.some((entry) => entry.adultOnly === true && applies(entry))).toBe(true);

        const genreSpecific = entries.filter((entry) => (entry.genres as string[]).includes(genre));
        const requiredGeneral = file === 'traits.json' ? 3 : file === 'origins.json' ? 4 : 5;
        const requiredAdult = file === 'traits.json' ? 5 : file === 'origins.json' ? 6 : 8;
        expect(genreSpecific.filter((entry) => entry.adultOnly === false).length).toBeGreaterThanOrEqual(requiredGeneral);
        expect(genreSpecific.filter((entry) => entry.adultOnly === true).length).toBeGreaterThanOrEqual(requiredAdult);
      }
    }
  });

  it('keeps every launch world buildable at the lowest point tier', () => {
    const worlds = json<Array<Record<string, unknown>>>('presets/worlds.json');
    const tiers = json<Array<Record<string, unknown>>>('presets/talent-tiers.json');
    const lowestBudget = Math.min(...tiers.map((tier) => Number(tier.total_points)));
    const origins = json<Array<Record<string, unknown>>>('presets/origins.json');
    const traits = json<Array<Record<string, unknown>>>('presets/traits.json');
    const visible = (entry: Record<string, unknown>, world: Record<string, unknown>) => {
      const scopes = entry.genres as string[];
      const genreMatch = scopes.includes('all') || scopes.includes(String(world.genre));
      const ratingMatch = entry.adultOnly !== true || world.contentRating === 'nsfw';
      return genreMatch && ratingMatch;
    };

    for (const world of worlds) {
      const originCosts = origins.filter((entry) => visible(entry, world)).map((entry) => Number(entry.talent_cost));
      const traitCosts = traits.filter((entry) => visible(entry, world)).map((entry) => Number(entry.talent_cost));
      expect(originCosts.length, `${String(world.name)} origin pool`).toBeGreaterThan(0);
      expect(traitCosts.length, `${String(world.name)} trait pool`).toBeGreaterThan(0);
      expect(Math.min(...originCosts) + Math.min(...traitCosts)).toBeLessThanOrEqual(lowestBudget);
    }
  });

  it('excludes rejected names and product-banned wording from runtime catalogs', () => {
    const runtimeText = ['worlds.json', 'origins.json', 'traits.json', 'talents.json']
      .map((file) => readFileSync(`${packRoot}/presets/${file}`, 'utf8'))
      .join('\n');
    expect(runtimeText).not.toMatch(/人格商品化|夹层清册|七曜大陆|白塔协议/);
  });

  it('uses schema-bounded stat bars for creation modifiers', () => {
    const schema = json<Record<string, unknown>>('schemas/state-schema.json');
    const fields = readStatFields(schema, '角色.属性');
    const keys = new Set(fields.map((field) => field.key));
    expect(fields).toHaveLength(6);
    expect(fields.every((field) => field.minimum === 1 && field.maximum === 20)).toBe(true);

    const rootProperties = schema.properties as Record<string, Record<string, unknown>>;
    const characterProperties = rootProperties['角色'].properties as Record<string, Record<string, unknown>>;
    const statProperties = characterProperties['属性'].properties as Record<string, Record<string, unknown>>;
    for (const field of Object.values(statProperties)) {
      expect(field['x-creation-min']).toBe(1);
      expect(field['x-max']).toBe(20);
      expect(field).not.toHaveProperty('minimum');
      expect(field).not.toHaveProperty('maximum');
    }

    for (const file of ['origins.json', 'traits.json', 'talents.json']) {
      const entries = json<Array<Record<string, unknown>>>(`presets/${file}`);
      for (const entry of entries) {
        const modifiers = entry.attribute_modifiers;
        if (!modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers)) continue;
        expect(Object.keys(modifiers).every((key) => keys.has(key))).toBe(true);
      }
    }
  });

  it('does not retain pseudo-machine fields without runtime consumers', () => {
    const forbidden = ['cultivation_speed', 'base_multiplier', 'special_effects', 'effects'];
    for (const file of ['origins.json', 'traits.json', 'talents.json']) {
      const entries = json<Array<Record<string, unknown>>>(`presets/${file}`);
      for (const entry of entries) {
        expect(forbidden.filter((key) => key in entry)).toEqual([]);
      }
    }
  });

  it('opening prompt forbids AI writes to deterministic character attributes', () => {
    const opening = readFileSync(`${packRoot}/prompts/opening.md`, 'utf8');
    expect(opening).toContain('不得计算、修改或输出任何 `角色.属性.*` command');
    expect(opening).not.toContain('值 = 先天六维 + 出身修正 + 天赋修正');
  });
});
