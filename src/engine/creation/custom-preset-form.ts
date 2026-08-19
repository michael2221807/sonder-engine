// App doc: docs/user-guide/pages/creation.md §2.7
import type { CustomPresetSchema } from '@/engine/types/game-pack';

export type CustomPresetFormIssueType = 'required' | 'number' | 'min' | 'max' | 'option';

export interface CustomPresetFormIssue {
  type: CustomPresetFormIssueType;
  key: string;
  label: string;
  limit?: number;
}

export function buildCustomPresetFormData(
  schema: CustomPresetSchema,
  initialData?: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (initialData && field.key in initialData) output[field.key] = initialData[field.key];
    else if (field.default !== undefined) output[field.key] = field.default;
    else if (field.type === 'number') output[field.key] = 0;
    else if (field.type === 'checkbox') output[field.key] = false;
    else if (field.type === 'select') output[field.key] = field.options?.[0] ?? '';
    else output[field.key] = '';
  }
  return output;
}

export function validateCustomPresetForm(
  schema: CustomPresetSchema,
  data: Record<string, unknown>,
): CustomPresetFormIssue[] {
  const issues: CustomPresetFormIssue[] = [];
  for (const field of schema.fields) {
    const value = data[field.key];
    if (
      field.required
      && (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))
    ) {
      issues.push({ type: 'required', key: field.key, label: field.label });
      continue;
    }
    if (field.type === 'number') {
      const number = Number(value);
      if (value !== '' && value !== null && Number.isFinite(number)) {
        if (typeof field.min === 'number' && number < field.min) {
          issues.push({ type: 'min', key: field.key, label: field.label, limit: field.min });
        }
        if (typeof field.max === 'number' && number > field.max) {
          issues.push({ type: 'max', key: field.key, label: field.label, limit: field.max });
        }
      } else if (field.required) {
        issues.push({ type: 'number', key: field.key, label: field.label });
      }
    } else if (
      field.type === 'select'
      && typeof value === 'string'
      && field.options
      && !field.options.includes(value)
    ) {
      issues.push({ type: 'option', key: field.key, label: field.label });
    }
  }
  return issues;
}

export function normalizeCustomPresetFormData(
  schema: CustomPresetSchema,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...data };
  for (const field of schema.fields) {
    if (field.type === 'number' && output[field.key] !== '' && output[field.key] !== null) {
      output[field.key] = Number(output[field.key]);
    } else if (field.type === 'checkbox') {
      output[field.key] = output[field.key] === true;
    } else if (field.type === 'select' && field.key === 'genres') {
      const raw = output[field.key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      output[field.key] = typeof value === 'string' && value ? [value] : [];
    }
  }
  return output;
}
