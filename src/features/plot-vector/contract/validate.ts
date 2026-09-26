/**
 * The one check a card gets, when it is bound (rebuild plan §5). A card whose conditions never fire on
 * the samples is still bound (D7); only a card that fails on every sample, cannot compile, or is not a
 * card at all is refused. A refused card drops only its ability: the entry stays and waits (D8).
 */
import { compiledPass, runPass } from './compile';
import { CARD_TYPES, LIMITS, type CardSpec, type CardType, type GrowthSpec, type GrowthTrigger, type PassValues } from './types';

type Plain = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined);
const GROWTH_TRIGGERS: readonly GrowthTrigger[] = ['trigger', 'round', 'placedRound'];

export type CardCheck = { ok: true; spec: CardSpec } | { ok: false; reason: string };

function readGrowthSpec(value: unknown): GrowthSpec | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return 'invalid';
  const on = value.on, every = value.every, max = value.max;
  if (typeof on !== 'string' || !(GROWTH_TRIGGERS as readonly string[]).includes(on)) return 'invalid';
  if (typeof every !== 'number' || !Number.isFinite(every) || every < 1) return 'invalid';
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) return 'invalid';
  if (value.add !== undefined && !isRecord(value.add)) return 'invalid';
  if (value.burst !== undefined && !isRecord(value.burst)) return 'invalid';
  return {
    on: on as GrowthTrigger, every: Math.floor(every), max: Math.min(LIMITS.growthMax, Math.floor(max)),
    ...(isRecord(value.add) ? { add: value.add } : {}), ...(isRecord(value.burst) ? { burst: value.burst } : {}),
  };
}

/** Read the card fields (§2.2); no code is run here. */
export function readCardSpec(raw: unknown): CardCheck {
  if (!isRecord(raw)) return { ok: false, reason: 'the ability is not an object' };
  const name = text(raw.for, LIMITS.nameChars);
  if (!name) return { ok: false, reason: '"for" must name the entry' };
  if (typeof raw.type !== 'string' || !(CARD_TYPES as readonly string[]).includes(raw.type))
    return { ok: false, reason: `"type" must be one of ${CARD_TYPES.join(', ')}` };
  const summary = text(raw.summary, LIMITS.summaryChars);
  if (!summary) return { ok: false, reason: `"summary" must be one sentence of at most ${LIMITS.summaryChars} characters` };
  if (typeof raw.onPass !== 'string' || !raw.onPass.trim()) return { ok: false, reason: '"onPass" must be a function body' };
  if (raw.onPass.length > LIMITS.sourceChars) return { ok: false, reason: `"onPass" is longer than ${LIMITS.sourceChars} characters` };
  const growth = readGrowthSpec(raw.growth);
  if (growth === 'invalid') return { ok: false, reason: '"growth" needs on (trigger|round|placedRound), every ≥ 1 and max ≥ 1' };
  return { ok: true, spec: { for: name, type: raw.type as CardType, summary, onPass: raw.onPass, ...(growth ? { growth } : {}) } };
}

/** Fixed sample values covering empty/balanced/one-sided shuttles, both directions, first and later passes, level 0 and higher. */
export const SAMPLE_VALUES: readonly PassValues[] = [
  { push: 0, drag: 0, social: 0, chance: 0, pass: 1, step: 1, back: false, level: 0, stored: 0 },
  { push: 5, drag: 5, social: 5, chance: 5, pass: 1, step: 2, back: true, level: 0, stored: 0 },
  { push: 20, drag: 1, social: 2, chance: 0, pass: 2, step: 5, back: false, level: 3, stored: 5 },
  { push: 1, drag: 18, social: 0, chance: 3, pass: 3, step: 7, back: true, level: 1, stored: 0 },
  { push: 2, drag: 0, social: 15, chance: 12, pass: 1, step: 8, back: false, level: 10, stored: 30 },
  { push: 8, drag: 6, social: 4, chance: 9, pass: 4, step: 11, back: true, level: 50, stored: 12 },
];

/** Bind-time check: compiles, and does not throw on every sample. */
export function checkCardSpec(spec: CardSpec): { ok: true } | { ok: false; reason: string } {
  const compiled = compiledPass(spec.onPass);
  if ('error' in compiled) return { ok: false, reason: compiled.error };
  const errors: string[] = [];
  SAMPLE_VALUES.forEach((values, i) => {
    const out = runPass(compiled.compiled, values, `sample:${i}`);
    if (!out.ok) errors.push(out.error);
  });
  if (errors.length === SAMPLE_VALUES.length) return { ok: false, reason: `onPass fails on every sample: ${errors[0]}` };
  return { ok: true };
}

/** Read and check a card the model wrote. */
export function validateCard(raw: unknown): CardCheck {
  const read = readCardSpec(raw);
  if (!read.ok) return read;
  const checked = checkCardSpec(read.spec);
  return checked.ok ? read : checked;
}
