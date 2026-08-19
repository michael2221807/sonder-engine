// App doc: docs/user-guide/pages/creation.md §2.1.8
import type { CreationGenre, PresetEntry } from '@/engine/types/game-pack';

const CREATION_GENRES = new Set<CreationGenre>([
  'modern',
  'wuxia',
  'fantasy',
  'dystopia',
]);

export function isPresetEntry(value: unknown): value is PresetEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getCreationGenre(value: unknown): CreationGenre | null {
  if (!isPresetEntry(value)) return null;
  const genre = value.genre;
  return typeof genre === 'string' && CREATION_GENRES.has(genre as CreationGenre)
    ? genre as CreationGenre
    : null;
}

export function isWorldPresetVisible(entry: PresetEntry, nsfwEnabled: boolean): boolean {
  return entry.contentRating !== 'nsfw' || nsfwEnabled;
}

export function isChoicePresetVisible(
  entry: PresetEntry,
  selectedGenre: CreationGenre | null,
  nsfwEnabled: boolean,
): boolean {
  if (entry.adultOnly === true && !nsfwEnabled) return false;

  // Missing metadata is intentionally unrestricted. Old custom entries remain
  // usable without migration or backfilling.
  if (!selectedGenre || !Array.isArray(entry.genres)) return true;

  return entry.genres.includes('all') || entry.genres.includes(selectedGenre);
}

export function samePresetEntry(left: PresetEntry, right: PresetEntry): boolean {
  const leftKey = left.id ?? left.name;
  const rightKey = right.id ?? right.name;
  if (leftKey !== undefined || rightKey !== undefined) return leftKey === rightKey;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function retainVisiblePresetSelection(
  selection: unknown,
  visibleEntries: PresetEntry[],
): unknown {
  if (Array.isArray(selection)) {
    return selection
      .filter(isPresetEntry)
      .filter((entry) => visibleEntries.some((candidate) => samePresetEntry(entry, candidate)));
  }
  if (
    isPresetEntry(selection)
    && visibleEntries.some((candidate) => samePresetEntry(selection, candidate))
  ) {
    return selection;
  }
  return undefined;
}
