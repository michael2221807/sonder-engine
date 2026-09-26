import type { RawPromptTransform } from '../../engine/prompt/raw-prompt-transform';
import { CARD_API, GENESIS_GUIDANCE } from './genesis/generation-prompt';

export interface VectorPromptPolicy {
  transform: RawPromptTransform;
  mode: string;
  environmentAbility?: EnvironmentAbilityPolicy;
  abilityRepair?: AbilityRepairPolicy;
}
/** Environment abilities written by Step2 with the environment tags (pack-owned wording, one interface). */
export interface EnvironmentAbilityPolicy {
  /** Field on each environment tag that carries its card (rebuild plan §2.2). */
  field: string;
  /** Step2 interface: pack instruction + the shared card domain. */
  prompt: string;
  /** The pack instruction alone (Step3 adds the shared card domain once for all its tasks). */
  instruction: string;
  /** Step3 repair block template with `{{PATH}}` and `{{ITEMS}}`. */
  repair: string;
}
/**
 * Step3 regeneration of item/talent/status abilities that failed (pack-owned task text). The new abilities
 * come back in their own top-level reply field, never as commands on the saved entries.
 */
export interface AbilityRepairPolicy {
  /** Top-level reply field that carries `[{ id, card }]`. */
  field: string;
  /** Task template with `{{ITEMS}}`. */
  template: string;
  /** The same guidance post-save generation uses (Step3 adds the shared card domain once). */
  guidance: string;
}
interface Replacement { promptId: string; from: string; to: string }

/** Pack-owned literal edits. No regex over rendered state, history, or player input. */
export function parseVectorPromptPolicy(raw: unknown, mode: unknown): VectorPromptPolicy | undefined {
  if (!raw || typeof raw !== 'object' || typeof mode !== 'string' || !mode.trim()) return;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.disabledModules) || !r.disabledModules.every(x => typeof x === 'string')
    || !Array.isArray(r.replacements)) return;
  const replacements: Replacement[] = [];
  for (const entry of r.replacements) {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    if (typeof e.promptId !== 'string' || typeof e.from !== 'string' || !e.from || typeof e.to !== 'string') return;
    replacements.push({ promptId: e.promptId, from: e.from.replace(/\r\n/g, '\n'), to: e.to });
  }
  const disabled = new Set(r.disabledModules as string[]);
  const transform: RawPromptTransform = (id, text) => {
    if (disabled.has(id)) return '';
    const edits = replacements.filter(e => e.promptId === id);
    if (!edits.length) return text;
    let result = text.replace(/\r\n/g, '\n');
    for (const edit of edits) result = result.split(edit.from).join(edit.to);
    return result;
  };
  let environmentAbility: EnvironmentAbilityPolicy | undefined;
  if (r.environmentAbility !== undefined) {
    const e = r.environmentAbility as Record<string, unknown> | null;
    if (!e || typeof e.field !== 'string' || !e.field.trim() || typeof e.instruction !== 'string' || !e.instruction.trim()
      || typeof e.repair !== 'string' || !e.repair.includes('{{ITEMS}}') || !e.repair.includes('{{PATH}}')) return;
    environmentAbility = { field: e.field, prompt: `${e.instruction.trim()}\n\n${CARD_API}`, instruction: e.instruction.trim(), repair: e.repair };
  }
  let abilityRepair: AbilityRepairPolicy | undefined;
  if (r.abilityRepair !== undefined) {
    const a = r.abilityRepair as Record<string, unknown> | null;
    if (!a || typeof a.field !== 'string' || !a.field.trim() || typeof a.template !== 'string' || !a.template.includes('{{ITEMS}}')) return;
    abilityRepair = { field: a.field, template: a.template, guidance: GENESIS_GUIDANCE };
  }
  return { mode, environmentAbility, abilityRepair, transform };
}
