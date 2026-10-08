import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { eventBus } from '@/engine/core/event-bus';
import { identityT, makeStateAccess } from './test-helpers';
import { useModelRulesets } from './model-rulesets';
import { useRuleTemplates } from './rule-templates';
import { useTransformerPresets } from './transformers';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const RULESETS = '系统.扩展.image.modelRulesets';
const TEMPLATES = '系统.扩展.image.ruleTemplates';
const TRANSFORMERS = '系统.扩展.image.transformerPresets';

function rs(id: string, over: Record<string, unknown> = {}) {
  return { id, name: id, enabled: false, compatMode: false, baseModelRule: '', anchorModeModelRule: '', serializationStrategy: 's', npcTemplateId: '', sceneTemplateId: '', judgeTemplateId: '', ...over };
}

describe('useModelRulesets', () => {
  it('auto-selects the enabled ruleset immediately and when seeded later', async () => {
    const s = makeStateAccess({ [RULESETS]: [rs('a'), rs('b', { enabled: true, name: 'B', baseModelRule: 'base', anchorModeModelRule: 'anchor' })] });
    const m = useModelRulesets({ get: s.get, setValue: s.setValue, t: identityT });
    expect(m.editingModelRulesetId.value).toBe('b');
    expect(m.editModelRulesetName.value).toBe('B');
    expect(m.editModelRulesetBase.value).toBe('base');
    expect(m.editModelRulesetAnchor.value).toBe('anchor');
    expect(m.activeModelRuleset.value?.id).toBe('b');
    expect(m.modelRulesetOptions.value).toEqual([
      { label: 'a', value: 'a' },
      { label: 'Bimage.rules.enabledSuffix', value: 'b' },
    ]);

    const empty = makeStateAccess();
    const m2 = useModelRulesets({ get: empty.get, setValue: empty.setValue, t: identityT });
    expect(m2.editingModelRulesetId.value).toBe('');
    empty.tree[RULESETS] = [rs('x', { enabled: true })];
    await nextTick();
    expect(m2.editingModelRulesetId.value).toBe('x');
  });

  it('creates, saves, toggles and deletes with the original write sequence', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const emit = vi.spyOn(eventBus, 'emit');
    const s = makeStateAccess({ [RULESETS]: [rs('a', { enabled: true })] });
    const m = useModelRulesets({ get: s.get, setValue: s.setValue, t: identityT });

    m.createModelRuleset();
    expect(s.writes[0][0]).toBe(RULESETS);
    const created = (s.writes[0][1] as Array<Record<string, unknown>>)[1];
    expect(created).toMatchObject({ id: 'mrs_1700000000000', name: 'image.rules.rulesetDefaultName|{"n":2}', enabled: false, serializationStrategy: 'nai_character_segments' });
    expect(m.editingModelRulesetId.value).toBe('mrs_1700000000000');

    m.editModelRulesetName.value = 'renamed';
    m.editModelRulesetBase.value = 'B';
    m.editModelRulesetAnchor.value = 'A';
    m.saveModelRuleset();
    expect((s.writes[1][1] as Array<Record<string, unknown>>)[1]).toMatchObject({ name: 'renamed', baseModelRule: 'B', anchorModeModelRule: 'A' });
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.toast.modelRulesetSaved', duration: 1500 });

    // enabling the edited one disables the others
    m.toggleModelRulesetEnabled(true);
    expect((s.writes[2][1] as Array<{ id: string; enabled: boolean }>).map((r) => [r.id, r.enabled])).toEqual([['a', false], ['mrs_1700000000000', true]]);
    m.toggleModelRulesetCompat(true);
    expect((s.writes[3][1] as Array<{ id: string; compatMode: boolean }>)[1].compatMode).toBe(true);

    m.deleteModelRuleset();
    expect((s.writes[4][1] as Array<{ id: string }>).map((r) => r.id)).toEqual(['a']);
    expect(m.editingModelRulesetId.value).toBe('');
  });

  it('save is a no-op without a selection; export with nothing only toasts', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const s = makeStateAccess();
    const m = useModelRulesets({ get: s.get, setValue: s.setValue, t: identityT });
    m.saveModelRuleset();
    expect(s.setValue).not.toHaveBeenCalled();
    m.exportModelRulesets();
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'info', message: 'image.toast.noModelRulesetsToExport', duration: 1500 });
  });
});

describe('useTransformerPresets', () => {
  it('creates / saves / deletes scoped presets', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42);
    const emit = vi.spyOn(eventBus, 'emit');
    const s = makeStateAccess({ [TRANSFORMERS]: [{ id: 'x', name: 'X', scope: 'scene', prompt: 'px' }] });
    const m = useTransformerPresets({ get: s.get, setValue: s.setValue, t: identityT });
    expect(m.scopedTransformers.value).toEqual([]); // default scope is npc

    m.newTransformerName.value = '  ';
    m.createTransformerPreset();
    expect(s.writes[0][1]).toEqual([
      { id: 'x', name: 'X', scope: 'scene', prompt: 'px' },
      { id: 'tf_42', name: 'image.transformer.defaultName|{"id":42}', scope: 'npc', prompt: '' },
    ]);
    expect(m.selectedTransformerId.value).toBe('tf_42');
    expect(m.scopedTransformers.value.map((p) => p.id)).toEqual(['tf_42']);

    m.editTransformerPrompt.value = 'new prompt';
    m.saveTransformerPreset();
    expect((s.writes[1][1] as Array<{ prompt: string }>)[1].prompt).toBe('new prompt');
    expect(emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'image.toast.transformerPresetSaved', duration: 1500 });

    m.deleteTransformerPreset();
    expect((s.writes[2][1] as Array<{ id: string }>).map((p) => p.id)).toEqual(['x']);
    expect(m.selectedTransformerId.value).toBe('');
    expect(m.editTransformerPrompt.value).toBe('');
  });
});

describe('useRuleTemplates', () => {
  function tpl(id: string, scope: 'npc' | 'scene' | 'judge', over: Record<string, unknown> = {}) {
    return { id, name: id, scope, baseRule: `base-${id}`, anchorRule: `anchor-${id}`, noAnchorFallback: 'nf', outputFormat: 'of', transformerPresetId: 'tp', ...over };
  }
  function make(initial: Record<string, unknown>) {
    const s = makeStateAccess(initial);
    const modelRulesets = ref([rs('m1')]);
    const m = useRuleTemplates({ get: s.get, setValue: s.setValue, t: identityT, transformerPresets: ref([
      { id: 'n1', name: 'N1', scope: 'npc', prompt: '' },
      { id: 's1', name: 'S1', scope: 'scene', prompt: '' },
      { id: 'x1', name: 'X1', scope: 'secret', prompt: '' },
    ]), modelRulesets: modelRulesets as never });
    return { s, m };
  }

  it('selects the first template of the scope immediately and loads it into the editor', async () => {
    const { m } = make({ [TEMPLATES]: [tpl('a', 'scene'), tpl('b', 'npc'), tpl('c', 'npc')] });
    expect(m.editingRuleId.value).toBe('b');
    expect(m.editRuleName.value).toBe('b');
    expect(m.editBaseRule.value).toBe('base-b');
    expect(m.editRuleTransformerId.value).toBe('tp');
    m.ruleScope.value = 'scene';
    await nextTick();
    expect(m.editingRuleId.value).toBe('a'); // previous selection not in scope -> first of new scope
    expect(m.editRuleOptions.value).toEqual([{ label: 'a', value: 'a' }]);
    expect(m.activeRuleOptions.value[0]).toEqual({ label: 'image.presets.notUsed', value: '' });
    expect(m.currentTransformerOptions.value.map((o) => o.value)).toEqual(['', 's1']);
  });

  it('active rule ids are per scope and read from the stored rules at setup time', () => {
    const { s, m } = make({
      [TEMPLATES]: [],
      '系统.扩展.image.rules.activeNpcRule': 'rn',
      '系统.扩展.image.rules.activeSceneRule': 'rs',
    });
    expect(m.currentActiveRuleId.value).toBe('rn');
    m.ruleScope.value = 'scene';
    expect(m.currentActiveRuleId.value).toBe('rs');
    m.ruleScope.value = 'judge';
    expect(m.currentActiveRuleId.value).toBe('');
    m.currentActiveRuleId.value = 'rj';
    s.tree['系统.扩展.image.rules'] = { keep: 1 };
    m.saveActiveRules();
    expect(s.writes.at(-1)).toEqual(['系统.扩展.image.rules', { keep: 1, activeNpcRule: 'rn', activeSceneRule: 'rs', activeJudgeRule: 'rj' }]);
  });

  it('creates with scope-specific default names, saves, and deletes clearing the active rule', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7);
    const { s, m } = make({ [TEMPLATES]: [tpl('a', 'npc')], '系统.扩展.image.rules.activeNpcRule': 'a' });
    m.createRuleTemplate();
    const list = s.writes[0][1] as Array<Record<string, unknown>>;
    expect(list[1]).toMatchObject({ id: 'rule_7', name: 'image.rules.npcRuleName|{"n":2}', scope: 'npc', baseRule: '' });
    expect(m.editingRuleId.value).toBe('rule_7');

    m.editRuleName.value = 'N';
    m.editBaseRule.value = 'BR';
    m.saveRuleTemplate();
    expect((s.writes[1][1] as Array<Record<string, unknown>>)[1]).toMatchObject({ name: 'N', baseRule: 'BR' });

    m.selectEditRule('a');
    m.deleteRuleTemplate();
    expect(m.currentActiveRuleId.value).toBe(''); // active rule cleared because it was deleted
    expect(m.editingRuleId.value).toBe('');
  });
});
