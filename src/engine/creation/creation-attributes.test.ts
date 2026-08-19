import { describe, expect, it } from 'vitest';
import { settleCreationAttributes } from './creation-attributes';
import type { StatFieldDef } from '@/engine/pack/stat-section-reader';

const fields: StatFieldDef[] = [
  { key: 'STR', minimum: 1, maximum: 20, max: 20, order: 1 },
  { key: 'WIS', minimum: 1, maximum: 20, max: 20, order: 2 },
];

describe('deterministic creation attribute settlement', () => {
  it('aggregates modifiers from single and multiple selections', () => {
    expect(settleCreationAttributes(
      { STR: 8, WIS: 5 },
      {
        origin: { attribute_modifiers: { STR: 2 } },
        talents: [
          { attribute_modifiers: { STR: 3, WIS: -2 } },
          { attribute_modifiers: { WIS: 4 } },
        ],
      },
      fields,
      ['STR', 'WIS'],
    )).toEqual({ STR: 13, WIS: 7 });
  });

  it('clamps to schema bounds and ignores unknown modifier keys', () => {
    expect(settleCreationAttributes(
      { STR: 19, WIS: 2 },
      { origin: { attribute_modifiers: { STR: 8, WIS: -9, LUCK: 100 } } },
      fields,
      ['STR', 'WIS', 'LUCK'],
    )).toEqual({ STR: 20, WIS: 1 });
  });

  it('processes only configured attributes discovered as stat bars', () => {
    expect(settleCreationAttributes(
      { STR: 5, WIS: 5 },
      {},
      fields,
      ['STR'],
    )).toEqual({ STR: 5 });
  });
});
