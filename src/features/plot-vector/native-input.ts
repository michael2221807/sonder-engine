import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { readPath } from './saved-elements';
import type { LocalizedLabel } from '../../engine/plot-vector/core/types';

type Target = 'S+' | 'S-' | 'Y' | 'J' | 'visits';
interface AttributeRule { key: string; label: LocalizedLabel; target: Target; divisor: number; max: number }
export interface NativeRules { id: string; baseVisits: number; attributes: AttributeRule[] }
export interface NativeInput {
  ruleId: string;
  payload: Record<string, number>;
  visitBudget: number;
  contributions: Array<{ label: LocalizedLabel; value: number | null; target: Target; amount: number }>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Bad pack rules disable this optional mapping, never prevent loading a game. */
export function parseNativeRules(value: unknown): NativeRules | undefined {
  if (!object(value) || typeof value.id !== 'string' || !finite(value.baseVisits)
    || !Number.isInteger(value.baseVisits) || value.baseVisits < 1 || value.baseVisits > 64
    || !Array.isArray(value.attributes) || value.attributes.length > 32) return;
  const attributes: AttributeRule[] = [];
  for (const row of value.attributes) {
    if (!object(row) || typeof row.key !== 'string' || !row.key || !object(row.label)
      || typeof row.label.zh !== 'string' || typeof row.label.en !== 'string'
      || !['S+', 'S-', 'Y', 'J', 'visits'].includes(String(row.target))
      || !finite(row.divisor) || row.divisor < 0.01 || !finite(row.max) || row.max < 0 || row.max > 1000) return;
    attributes.push({ key: row.key, label: { zh: row.label.zh, en: row.label.en }, target: row.target as Target, divisor: row.divisor, max: row.max });
  }
  return { id: value.id, baseVisits: value.baseVisits, attributes };
}
/** Read saved runtime attributes only. Neither prose nor the player's layout is input. */
export function projectNativeInput(snapshot: unknown, rules?: NativeRules): NativeInput {
  const payload: Record<string, number> = { 'S+': 0, 'S-': 0, Y: 0, J: 0 };
  const contributions: NativeInput['contributions'] = [];
  let visits = rules?.baseVisits ?? 10;
  const attrs = readPath(snapshot, P.characterAttributes);
  for (const rule of rules?.attributes ?? []) {
    const raw = object(attrs) && Object.hasOwn(attrs, rule.key) ? attrs[rule.key] : undefined;
    const value = finite(raw) ? raw : null;
    const amount = value === null ? 0 : Math.min(rule.max, Math.max(0, value)) / rule.divisor;
    contributions.push({ label: rule.label, value, target: rule.target, amount: rule.target === 'visits' ? Math.floor(amount) : amount });
    if (rule.target === 'visits') visits += Math.floor(amount);
    else payload[rule.target] = Math.min(1000, payload[rule.target] + amount);
  }
  return { ruleId: rules?.id ?? 'unconfigured', payload, visitBudget: Math.min(64, visits), contributions };
}
