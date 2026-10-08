/**
 * Built-in preset seeding (R7 step 2): the two engine -> UI mappers that used to sit in
 * ImagePanel, plus `reconcileBuiltins`, the pure plan behind the panel onMounted seeding.
 * The panel still performs the `get` / `setValue` calls, in the original order.
 */
import type { TransformerPromptPreset, ModelTransformerBundle } from '@/engine/image/transformer-presets';
import type { RuleTemplate } from './rule-templates';
import type { ModelRuleset } from './model-rulesets';

// Convert engine TransformerPromptPreset → UI RuleTemplate
export function enginePresetToRuleTemplate(p: TransformerPromptPreset): RuleTemplate {
  const scopeMap: Record<string, 'npc' | 'scene' | 'judge'> = { npc: 'npc', scene: 'scene', scene_judge: 'judge' };
  return {
    id: p.id,
    name: p.name,
    scope: scopeMap[p.scope] ?? 'npc',
    baseRule: p.prompt,
    anchorRule: p.scope === 'scene' ? (p.sceneAnchorModePrompt ?? p.anchorModePrompt ?? '') : (p.anchorModePrompt ?? ''),
    noAnchorFallback: p.noAnchorFallbackPrompt ?? '',
    outputFormat: p.outputFormatPrompt ?? '',
    transformerPresetId: '',
  };
}

// Convert engine ModelTransformerBundle → UI ModelRuleset
export function engineBundleToModelRuleset(b: ModelTransformerBundle): ModelRuleset {
  return {
    id: b.id,
    name: b.name,
    enabled: b.enabled,
    compatMode: false,
    baseModelRule: b.modelPrompt,
    anchorModeModelRule: b.anchorModeModelPrompt,
    serializationStrategy: b.serializationStrategy,
    npcTemplateId: b.npcPresetId,
    sceneTemplateId: b.scenePresetId,
    judgeTemplateId: b.sceneJudgePresetId,
  };
}

/** What the panel should write back for one built-in list. */
export interface ReconcilePlan<T> {
  /** `false` = leave the stored list untouched (no `setValue`). */
  write: boolean;
  value: T[];
}

/**
 * Decide how to seed / refresh a built-in list (model rulesets or rule templates).
 * - nothing stored yet: write the locale defaults;
 * - otherwise refresh the built-in entries via `mergeLocale`, keep user entries, append
 *   missing built-ins; write only when something was missing or the pack ships defaults.
 */
export function reconcileBuiltins<T extends { id: string }>(
  existing: T[] | undefined,
  localeDefaults: T[],
  packDefaults: unknown,
  mergeLocale: (existing: T, localeVersion: T) => T,
): ReconcilePlan<T> {
  const defaultIds = new Set(localeDefaults.map(r => r.id));
  if (!Array.isArray(existing) || existing.length === 0) {
    return { write: true, value: localeDefaults };
  }
  const existingIds = new Set(existing.map(r => r.id));
  const localeMap = new Map(localeDefaults.map(r => [r.id, r]));
  const updated = existing.map(r => {
    const localeVer = localeMap.get(r.id);
    if (localeVer && defaultIds.has(r.id)) {
      return mergeLocale(r, localeVer);
    }
    return r;
  });
  const missing = localeDefaults.filter(r => !existingIds.has(r.id));
  if (missing.length > 0 || packDefaults) {
    return { write: true, value: [...updated, ...missing] };
  }
  return { write: false, value: existing };
}

/** Refresh a stored built-in ruleset with its locale text (other fields stay). */
export function mergeRulesetLocale(r: ModelRuleset, localeVer: ModelRuleset): ModelRuleset {
  return { ...r, name: localeVer.name, baseModelRule: localeVer.baseModelRule, anchorModeModelRule: localeVer.anchorModeModelRule };
}

/** Refresh a stored built-in rule template with its locale text. */
export function mergeTemplateLocale(r: RuleTemplate, localeVer: RuleTemplate): RuleTemplate {
  return { ...r, name: localeVer.name, baseRule: localeVer.baseRule, anchorRule: localeVer.anchorRule, noAnchorFallback: localeVer.noAnchorFallback, outputFormat: localeVer.outputFormat };
}
