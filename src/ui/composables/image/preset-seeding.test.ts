import { describe, expect, it } from 'vitest';
import { getDefaultModelBundles, getDefaultPresets } from '@/engine/image/transformer-presets';
import type { ModelRuleset } from './model-rulesets';
import type { RuleTemplate } from './rule-templates';
import {
  engineBundleToModelRuleset,
  enginePresetToRuleTemplate,
  mergeRulesetLocale,
  mergeTemplateLocale,
  reconcileBuiltins,
} from './preset-seeding';

function ruleset(id: string, over: Partial<ModelRuleset> = {}): ModelRuleset {
  return {
    id, name: id, enabled: false, compatMode: false, baseModelRule: '', anchorModeModelRule: '',
    serializationStrategy: 'nai_character_segments', npcTemplateId: '', sceneTemplateId: '', judgeTemplateId: '', ...over,
  };
}
function template(id: string, over: Partial<RuleTemplate> = {}): RuleTemplate {
  return { id, name: id, scope: 'npc', baseRule: '', anchorRule: '', noAnchorFallback: '', outputFormat: '', transformerPresetId: '', ...over };
}

describe('reconcileBuiltins', () => {
  const defaults = [ruleset('a', { name: 'A-new', baseModelRule: 'base-new' }), ruleset('b')];

  it('writes the locale defaults when nothing is stored (undefined, non-array, empty)', () => {
    for (const existing of [undefined, [], null as unknown as ModelRuleset[], 'x' as unknown as ModelRuleset[]]) {
      const plan = reconcileBuiltins(existing, defaults, undefined, mergeRulesetLocale);
      expect(plan.write).toBe(true);
      expect(plan.value).toBe(defaults);
    }
  });

  it('keeps user entries, refreshes built-in locale text and appends missing built-ins', () => {
    const stored = [ruleset('a', { name: 'A-old', enabled: true, baseModelRule: 'base-old', compatMode: true }), ruleset('user')];
    const plan = reconcileBuiltins(stored, defaults, undefined, mergeRulesetLocale);
    expect(plan.write).toBe(true);
    expect(plan.value.map((r) => r.id)).toEqual(['a', 'user', 'b']);
    // locale text refreshed, user-owned flags kept
    expect(plan.value[0]).toMatchObject({ name: 'A-new', baseModelRule: 'base-new', enabled: true, compatMode: true });
    expect(plan.value[1]).toBe(stored[1]);
  });

  it('does not write when nothing is missing and the pack ships no defaults', () => {
    const stored = [ruleset('a'), ruleset('b')];
    const plan = reconcileBuiltins(stored, defaults, undefined, mergeRulesetLocale);
    expect(plan.write).toBe(false);
    expect(plan.value).toBe(stored);
  });

  it('still writes (refreshed text) when the pack ships transformer defaults', () => {
    const stored = [ruleset('a', { name: 'A-old' }), ruleset('b')];
    const plan = reconcileBuiltins(stored, defaults, { presets: {} }, mergeRulesetLocale);
    expect(plan.write).toBe(true);
    expect(plan.value[0].name).toBe('A-new');
  });

  it('works for rule templates with their own merge fields', () => {
    const locale = [template('t1', { name: 'T1', baseRule: 'B', anchorRule: 'A', noAnchorFallback: 'F', outputFormat: 'O' })];
    const stored = [template('t1', { name: 'old', transformerPresetId: 'keep-me' })];
    const plan = reconcileBuiltins(stored, locale, undefined, mergeTemplateLocale);
    expect(plan.write).toBe(false); // nothing missing, no pack defaults
    const forced = reconcileBuiltins(stored, locale, true, mergeTemplateLocale);
    expect(forced.value[0]).toMatchObject({ name: 'T1', baseRule: 'B', anchorRule: 'A', noAnchorFallback: 'F', outputFormat: 'O', transformerPresetId: 'keep-me' });
  });
});

describe('engine -> UI mappers', () => {
  it('maps every built-in bundle to a ModelRuleset with compatMode off', () => {
    const bundles = getDefaultModelBundles();
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      const r = engineBundleToModelRuleset(b);
      expect(r).toEqual({
        id: b.id, name: b.name, enabled: b.enabled, compatMode: false,
        baseModelRule: b.modelPrompt, anchorModeModelRule: b.anchorModeModelPrompt,
        serializationStrategy: b.serializationStrategy,
        npcTemplateId: b.npcPresetId, sceneTemplateId: b.scenePresetId, judgeTemplateId: b.sceneJudgePresetId,
      });
    }
  });

  it('maps preset scopes (scene_judge -> judge) and scene anchor prompt precedence', () => {
    const presets = getDefaultPresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      const r = enginePresetToRuleTemplate(p);
      expect(r.id).toBe(p.id);
      expect(r.baseRule).toBe(p.prompt);
      expect(r.transformerPresetId).toBe('');
      expect(r.scope).toBe(p.scope === 'scene_judge' ? 'judge' : p.scope === 'scene' ? 'scene' : 'npc');
      const anchor = p.scope === 'scene' ? (p.sceneAnchorModePrompt ?? p.anchorModePrompt ?? '') : (p.anchorModePrompt ?? '');
      expect(r.anchorRule).toBe(anchor);
    }
  });
});
