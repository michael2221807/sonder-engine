// App doc: docs/user-guide/pages/creation.md §2.1.7
import type { CreationStep, PresetEntry } from '@/engine/types/game-pack';

export interface BudgetSummary {
  source: string;
  total: number;
  spent: number;
  remaining: number;
}

export interface CreationValidationState {
  selections: Record<string, unknown>;
  attributes: Record<string, Record<string, number>>;
  formValues: Record<string, Record<string, unknown>>;
  flowVariables: Record<string, unknown>;
}

export interface FinalCreationChoices {
  selections: Record<string, unknown>;
  attributes?: Record<string, number>;
  formValues?: Record<string, unknown>;
}

export interface FinalCreationValidationResult {
  valid: boolean;
  errors: string[];
  budgets: BudgetSummary[];
}

export function getEntryCost(entry: unknown, costField?: string): number {
  if (!costField || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 0;
  const value = (entry as Record<string, unknown>)[costField];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getSelectionCost(selection: unknown, costField?: string): number {
  const entries = Array.isArray(selection) ? selection : selection == null ? [] : [selection];
  return entries.reduce((sum, entry) => sum + getEntryCost(entry, costField), 0);
}

export function buildBudgetSummary(
  steps: CreationStep[],
  state: Pick<CreationValidationState, 'selections' | 'flowVariables'>,
  source: string,
): BudgetSummary | null {
  const total = state.flowVariables[source];
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  const spent = steps
    .filter((step) => step.costSource === source)
    .reduce(
      (sum, step) => sum + getSelectionCost(state.selections[step.id], step.costField),
      0,
    );
  return { source, total, spent, remaining: total - spent };
}

function readSelectionPath(selection: unknown, pathExpression: string): unknown {
  if (!pathExpression.startsWith('$.')) return pathExpression;
  let current = selection;
  for (const segment of pathExpression.slice(2).split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Rebuild flow variables from the selected presets instead of trusting UI state. */
export function deriveCreationFlowVariables(
  steps: CreationStep[],
  selections: Record<string, unknown>,
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const step of steps) {
    const selection = selections[step.id];
    if (selection == null || !step.affects) continue;
    for (const [name, expression] of Object.entries(step.affects)) {
      const value = readSelectionPath(selection, expression);
      if (value !== undefined) variables[name] = value;
    }
  }
  return variables;
}

/**
 * Authoritative validation at the CharacterInit boundary. The creation UI has a
 * richer step-local state shape, so the engine independently validates the
 * flattened CreationChoices it actually receives.
 */
export function validateFinalCreationChoices(
  steps: CreationStep[],
  choices: FinalCreationChoices,
): FinalCreationValidationResult {
  const errors: string[] = [];
  const variables = deriveCreationFlowVariables(steps, choices.selections);
  const budgetSources = [...new Set(
    steps.map((step) => step.costSource).filter((source): source is string => !!source),
  )];
  const budgets: BudgetSummary[] = [];

  for (const source of budgetSources) {
    const summary = buildBudgetSummary(steps, {
      selections: choices.selections,
      flowVariables: variables,
    }, source);
    if (!summary) {
      errors.push(`budget:${source}:missing`);
    } else {
      budgets.push(summary);
      if (summary.remaining < 0) errors.push(`budget:${source}:overspent`);
    }
  }

  for (const step of steps) {
    if (step.type === 'select-one' && step.required && choices.selections[step.id] == null) {
      errors.push(`step:${step.id}:required`);
    }
    if (step.type === 'select-many' && step.required) {
      const selected = choices.selections[step.id];
      if (!Array.isArray(selected) || selected.length === 0) errors.push(`step:${step.id}:required`);
    }
    if (step.type === 'attribute-allocation') {
      const allocation = choices.attributes;
      const values = (step.attributes ?? []).map((key) => allocation?.[key]);
      if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        errors.push(`step:${step.id}:attributes-missing`);
        continue;
      }
      const numbers = values as number[];
      if (numbers.some((value) => value < 0)) errors.push(`step:${step.id}:attributes-negative`);
      if (step.perAttributeMax != null && numbers.some((value) => value > step.perAttributeMax!)) {
        errors.push(`step:${step.id}:attributes-max`);
      }
      if (step.totalPoints != null && numbers.reduce((sum, value) => sum + value, 0) !== step.totalPoints) {
        errors.push(`step:${step.id}:attributes-total`);
      }
    }
    if (step.type === 'form') {
      for (const field of step.fields ?? []) {
        if (!field.required) continue;
        const value = choices.formValues?.[field.key];
        if (value === undefined || value === null || value === '') {
          errors.push(`step:${step.id}:field:${field.key}:required`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, budgets };
}

export function validateCreationStep(
  step: CreationStep,
  steps: CreationStep[],
  state: CreationValidationState,
): boolean {
  if (step.costSource) {
    const summary = buildBudgetSummary(steps, state, step.costSource);
    if (summary && summary.remaining < 0) return false;
  }

  switch (step.type) {
    case 'select-one':
      return !step.required || state.selections[step.id] != null;
    case 'select-many': {
      const selection = state.selections[step.id];
      const items = Array.isArray(selection) ? selection : [];
      return !step.required || items.length > 0;
    }
    case 'attribute-allocation': {
      const allocation = state.attributes[step.id];
      if (!allocation || step.totalPoints == null) return false;
      const values = Object.values(allocation);
      if (values.some((value) => value < 0)) return false;
      if (step.perAttributeMax != null && values.some((value) => value > step.perAttributeMax!)) {
        return false;
      }
      return values.reduce((sum, value) => sum + value, 0) === step.totalPoints;
    }
    case 'form': {
      const values = state.formValues[step.id] ?? {};
      return (step.fields ?? []).every((field) => {
        if (!field.required) return true;
        const value = values[field.key];
        return value !== undefined && value !== null && value !== '';
      });
    }
    case 'confirmation':
      return true;
    default:
      return false;
  }
}

export function validateCreationFlow(
  steps: CreationStep[],
  state: CreationValidationState,
): boolean {
  return steps.every((step) => validateCreationStep(step, steps, state));
}

export function canAffordPresetCandidate(
  step: CreationStep,
  candidate: PresetEntry,
  currentSelection: unknown,
  summary: BudgetSummary | null,
): boolean {
  if (!summary || !step.costField || step.costSource !== summary.source) return true;
  const candidateCost = getEntryCost(candidate, step.costField);
  if (step.type === 'select-one') {
    const currentCost = getSelectionCost(currentSelection, step.costField);
    return summary.remaining + currentCost - candidateCost >= 0;
  }
  if (step.type === 'select-many') {
    const selected = Array.isArray(currentSelection) ? currentSelection : [];
    const candidateKey = candidate.id ?? candidate.name;
    const alreadySelected = selected.some((entry) => {
      if (entry === null || typeof entry !== 'object') return false;
      const record = entry as PresetEntry;
      return (record.id ?? record.name) === candidateKey;
    });
    return alreadySelected || summary.remaining - candidateCost >= 0;
  }
  return true;
}
