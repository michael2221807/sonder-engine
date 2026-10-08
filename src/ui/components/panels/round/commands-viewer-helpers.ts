/**
 * Pure helpers for CommandsViewer.vue, extracted for unit-testability.
 * No Vue / reactive imports.
 */

export interface Command {
  action: 'set' | 'add' | 'push' | 'delete' | 'pull';
  key: string;
  value?: unknown;
}

export interface CommandStats {
  set: number;
  add: number;
  push: number;
  delete: number;
  pull: number;
  total: number;
}

/** Count each action type + total. Unknown/unrecognized action strings are counted in `total` only. */
export function computeCommandStats(commands: ReadonlyArray<Command>): CommandStats {
  const s: CommandStats = { set: 0, add: 0, push: 0, delete: 0, pull: 0, total: 0 };
  const known: ReadonlySet<Command['action']> = new Set(['set', 'add', 'push', 'delete', 'pull']);
  for (const c of commands) {
    s.total++;
    if (known.has(c.action)) s[c.action]++;
  }
  return s;
}

/**
 * Format a command value for compact display (≤ 60 chars).
 * - null / undefined  → "—"
 * - object            → JSON.stringify, truncated with "…"
 * - primitive         → String(), truncated with "…"
 * - stringify failure → "[对象]"
 */
export function formatCommandValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    } catch {
      return '[对象]';
    }
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

export const COMMAND_ACTION_LABEL: Record<string, string> = {
  set: 'SET',
  add: 'ADD',
  push: 'PUSH',
  delete: 'DEL',
  pull: 'PULL',
};
