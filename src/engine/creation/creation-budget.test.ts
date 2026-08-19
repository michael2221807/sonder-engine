import { describe, expect, it } from 'vitest';
import type { CreationStep } from '@/engine/types/game-pack';
import {
  buildBudgetSummary,
  canAffordPresetCandidate,
  deriveCreationFlowVariables,
  validateFinalCreationChoices,
  validateCreationFlow,
  type CreationValidationState,
} from './creation-budget';

const steps: CreationStep[] = [
  { id: 'tier', label: 'tier', type: 'select-one', required: true, affects: { points: '$.total' } },
  { id: 'origin', label: 'origin', type: 'select-one', required: true, costField: 'cost', costSource: 'points' },
  { id: 'trait', label: 'trait', type: 'select-one', required: true, costField: 'cost', costSource: 'points' },
  { id: 'talents', label: 'talents', type: 'select-many', costField: 'cost', costSource: 'points' },
  { id: 'confirm', label: 'confirm', type: 'confirmation' },
];

function state(overrides: Partial<CreationValidationState> = {}): CreationValidationState {
  return {
    selections: {
      tier: { id: 'tier', total: 20 },
      origin: { id: 'origin-a', cost: 7 },
      trait: { id: 'trait-a', cost: 5 },
      talents: [],
    },
    attributes: {},
    formValues: {},
    flowVariables: { points: 20 },
    ...overrides,
  };
}

describe('shared creation budget', () => {
  it('aggregates all steps that consume the same source', () => {
    expect(buildBudgetSummary(steps, state(), 'points')).toEqual({
      source: 'points',
      total: 20,
      spent: 12,
      remaining: 8,
    });
  });

  it('allows replacing a single choice using the reclaimed current cost', () => {
    const summary = buildBudgetSummary(steps, state(), 'points');
    expect(canAffordPresetCandidate(steps[1]!, { cost: 16 }, state().selections.origin, summary)).toBe(false);
    expect(canAffordPresetCandidate(steps[1]!, { cost: 15 }, state().selections.origin, summary)).toBe(true);
  });

  it('uses incremental cost for multi-select and always permits deselection', () => {
    const withTalent = state({
      selections: { ...state().selections, talents: [{ id: 't1', cost: 8 }] },
    });
    const summary = buildBudgetSummary(steps, withTalent, 'points');
    expect(summary?.remaining).toBe(0);
    expect(canAffordPresetCandidate(steps[3]!, { id: 't2', cost: 1 }, withTalent.selections.talents, summary)).toBe(false);
    expect(canAffordPresetCandidate(steps[3]!, { id: 't1', cost: 8 }, withTalent.selections.talents, summary)).toBe(true);
  });

  it('supports negative-cost pack entries', () => {
    const negative = state({
      selections: { ...state().selections, talents: [{ cost: -3 }] },
    });
    expect(buildBudgetSummary(steps, negative, 'points')?.remaining).toBe(11);
  });

  it('rejects an over-budget flow at final validation', () => {
    const invalid = state({
      selections: { ...state().selections, talents: [{ cost: 9 }] },
    });
    expect(validateCreationFlow(steps, invalid)).toBe(false);
    expect(validateCreationFlow(steps, state())).toBe(true);
  });

  it('re-derives the point source from the tier selection at the engine boundary', () => {
    expect(deriveCreationFlowVariables(steps, state().selections)).toEqual({ points: 20 });
    const result = validateFinalCreationChoices(steps, {
      selections: state().selections,
    });
    expect(result.valid).toBe(true);
    expect(result.budgets).toEqual([{ source: 'points', total: 20, spent: 12, remaining: 8 }]);
  });

  it('rejects overspending and a missing budget source without trusting UI validation', () => {
    const overspent = validateFinalCreationChoices(steps, {
      selections: { ...state().selections, talents: [{ cost: 9 }] },
    });
    expect(overspent.valid).toBe(false);
    expect(overspent.errors).toContain('budget:points:overspent');

    const noTier = validateFinalCreationChoices(steps, {
      selections: { ...state().selections, tier: undefined },
    });
    expect(noTier.valid).toBe(false);
    expect(noTier.errors).toEqual(expect.arrayContaining([
      'budget:points:missing',
      'step:tier:required',
    ]));
  });
});
