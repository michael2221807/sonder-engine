import type { RawPromptTransform } from '../../engine/prompt/raw-prompt-transform';
import { CARD_API, GENESIS_GUIDANCE } from './genesis/generation-prompt';

export interface VectorPromptPolicy {
  transform: RawPromptTransform;
  mode: string;
  abilityBlock?: AbilityBlockPolicy;
  abilityRepair?: AbilityRepairPolicy;
}
/**
 * The round's abilities (rebuild plan §6.1, I21/I22): the request that writes the round's entries may append
 * one tagged block of cards after its JSON. Pack-owned tag and wording; the card domain is shared.
 */
export interface AbilityBlockPolicy {
  /** Tag of the block (lifted out of the reply before its JSON is parsed). */
  tag: string;
  /** The pack instruction alone. */
  instruction: string;
  /** What the request carries: the instruction and the card domain. */
  prompt: string;
}
/**
 * Step3 abilities for the backlog (pack-owned task text). They come back in their own top-level reply field,
 * never as commands on the saved entries.
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
  let abilityBlock: AbilityBlockPolicy | undefined;
  if (r.abilityBlock !== undefined) {
    const b = r.abilityBlock as Record<string, unknown> | null;
    if (!b || typeof b.tag !== 'string' || !/^[^<>\s/]+$/.test(b.tag) || typeof b.instruction !== 'string' || !b.instruction.trim()) return;
    abilityBlock = { tag: b.tag, instruction: b.instruction.trim(), prompt: `${b.instruction.trim()}\n\n${CARD_API}` };
  }
  let abilityRepair: AbilityRepairPolicy | undefined;
  if (r.abilityRepair !== undefined) {
    const a = r.abilityRepair as Record<string, unknown> | null;
    if (!a || typeof a.field !== 'string' || !a.field.trim() || typeof a.template !== 'string' || !a.template.includes('{{ITEMS}}')) return;
    abilityRepair = { field: a.field, template: a.template, guidance: GENESIS_GUIDANCE };
  }
  return { mode, abilityBlock, abilityRepair, transform };
}
