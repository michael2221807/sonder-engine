import type { PresetEntry } from '@/engine/types/game-pack';
import type { StatFieldDef } from '@/engine/pack/stat-section-reader';

function selectedEntries(selections: Record<string, unknown>): PresetEntry[] {
  const result: PresetEntry[] = [];
  for (const selection of Object.values(selections)) {
    const values = Array.isArray(selection) ? selection : [selection];
    for (const value of values) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result.push(value as PresetEntry);
      }
    }
  }
  return result;
}

export function settleCreationAttributes(
  innate: Record<string, number> | undefined,
  selections: Record<string, unknown>,
  statFields: StatFieldDef[],
  configuredAttributes: string[],
): Record<string, number> {
  const configured = new Set(configuredAttributes);
  const entries = selectedEntries(selections);
  const settled: Record<string, number> = {};

  for (const field of statFields) {
    if (!configured.has(field.key)) continue;
    const baseline = innate?.[field.key];
    if (typeof baseline !== 'number' || !Number.isFinite(baseline)) continue;

    let modifier = 0;
    for (const entry of entries) {
      const modifiers = entry.attribute_modifiers;
      if (modifiers === null || typeof modifiers !== 'object' || Array.isArray(modifiers)) continue;
      const value = (modifiers as Record<string, unknown>)[field.key];
      if (typeof value === 'number' && Number.isFinite(value)) modifier += value;
    }

    settled[field.key] = Math.min(field.maximum, Math.max(field.minimum, baseline + modifier));
  }

  return settled;
}
