// App doc: docs/user-guide/pages/creation.md §2.10
import type { CreationChoices } from '@/engine/pipeline/sub-pipelines/character-init';
import type { CreationStep, GamePack, PresetEntry } from '@/engine/types/game-pack';

function asEntry(value: unknown): PresetEntry | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as PresetEntry
    : null;
}

function entryNarrative(value: unknown): string {
  const entry = asEntry(value);
  if (!entry) return typeof value === 'string' ? value : '';
  const name = typeof entry.name === 'string' ? entry.name : typeof entry.label === 'string' ? entry.label : '';
  const description = typeof entry.description === 'string' ? entry.description : '';
  return [name, description].filter(Boolean).join(' — ');
}

function selectedStep(gamePack: GamePack, sourceKey: string): CreationStep | undefined {
  return gamePack.creationFlow?.steps?.find((step) => {
    const source = step.dataSource?.replace(/^presets\./, '');
    return source === sourceKey;
  });
}

export function formatWorldContext(gamePack: GamePack, choices: CreationChoices): string {
  const step = selectedStep(gamePack, 'worlds');
  const world = step ? choices.selections[step.id] : undefined;
  const narrative = entryNarrative(world);
  return narrative ? `世界：${narrative}` : '世界：未指定';
}

export function formatSettledPlayerProfile(
  gamePack: GamePack,
  choices: CreationChoices,
  settledAttributes: Record<string, number>,
): string {
  const lines: string[] = [];

  for (const [path, value] of Object.entries(choices.formValues ?? {})) {
    if (value === '' || value === undefined || value === null) continue;
    lines.push(`${path.split('.').at(-1) ?? path}：${String(value)}`);
  }

  for (const step of gamePack.creationFlow?.steps ?? []) {
    const source = step.dataSource?.replace(/^presets\./, '');
    if (!source || source === 'worlds') continue;
    const selection = choices.selections[step.id];
    if (selection == null) continue;
    const values = Array.isArray(selection) ? selection : [selection];
    const narratives = values.map(entryNarrative).filter(Boolean);
    if (narratives.length > 0) lines.push(`${step.label}：${narratives.join('；')}`);
  }

  const innate = Object.entries(choices.attributes ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join('，');
  if (innate) lines.push(`先天属性：${innate}`);

  const settled = Object.entries(settledAttributes)
    .map(([key, value]) => `${key} ${value}`)
    .join('，');
  if (settled) lines.push(`后天属性：${settled}`);

  return lines.join('\n');
}

export function formatCreationPromptContext(
  gamePack: GamePack,
  choices: CreationChoices,
  settledAttributes: Record<string, number>,
): string {
  return `${formatWorldContext(gamePack, choices)}\n\n${formatSettledPlayerProfile(gamePack, choices, settledAttributes)}`.trim();
}
