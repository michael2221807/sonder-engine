/**
 * Text replace rules definitions and parsing helpers, moved out of SettingsPanel.vue (refactor R7 step 9).
 * The panel keeps the refs, the editor modal state and the toasts.
 */

export const TEXT_REPLACE_KEY = 'aga_text_replace_rules';

export interface TextReplaceRule {
  id: string;
  enabled: boolean;
  mode: 'regex' | 'text';
  pattern: string;
  replacement: string;
  ignoreCase: boolean;
  global: boolean;
}

/** The rules in a stored JSON text; throws when the text is not JSON (the caller's try/catch falls back). */
export function parseTextRules(text: string): TextReplaceRule[] {
  const raw = JSON.parse(text);
  return Array.isArray(raw) ? raw : [];
}

/** A fresh form for a new rule (a new object on every call, as the two literals it replaces were). */
export function emptyRuleForm(): Omit<TextReplaceRule, 'id'> {
  return { enabled: true, mode: 'text', pattern: '', replacement: '', ignoreCase: false, global: true };
}

/** The entries of an imported file that look like rules. */
export function filterImportedRules(items: unknown[]): TextReplaceRule[] {
  return items.filter(
    (item): item is TextReplaceRule =>
      typeof (item as TextReplaceRule).id === 'string' &&
      typeof (item as TextReplaceRule).pattern === 'string' &&
      typeof (item as TextReplaceRule).replacement === 'string',
  );
}
