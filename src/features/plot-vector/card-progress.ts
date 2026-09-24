import type { BoundCard } from './genesis/post-save';
import type { VectorSession } from '../../engine/plot-vector/core/session';
import { scriptStateKey } from '../../engine/plot-vector/core/runner';
import { scriptStoreAccountId } from './genesis/script-runtime';

export interface CardProgress { cardId: string; name: string; rows: Array<{ key: string; label: string; value: number; max?: number; delta?: number; channel?: string }> }
/** Display hints never execute code or infer an economy from variable names. */
export function readCardProgress(cards: BoundCard[], session: VectorSession, previous?: VectorSession): CardProgress[] {
  return cards.map(card => {
    const key = scriptStateKey(card.task.entry.id, card.ref);
    const initial = card.candidate.card.initialPersistentState;
    const state = session.scriptStates?.[key] ?? session.scriptStates?.[card.ref.hash] ?? initial;
    const before = previous?.scriptStates?.[key] ?? previous?.scriptStates?.[card.ref.hash] ?? initial;
    const hints: unknown = card.candidate.card.stateDisplay;
    const seen = new Set<string>();
    const rows: CardProgress['rows'] = [];
    const store = card.candidate.card.selfStore;
    if (store) {
      const accountId = scriptStoreAccountId(card.task.entry.id, card.ref);
      const balance = (source: VectorSession, channel: string) => (source.carriedAccounts[accountId] ?? [])
        .reduce((sum, entry) => sum + (entry.amounts[channel] ?? 0), 0);
      const channels = [...new Set(store.allowedIn)];
      for (const channel of channels) {
        const value = balance(session, channel);
        const old = previous ? balance(previous, channel) : 0;
        rows.push({ key: `store:${channel}`, label: channel, channel, value,
          ...(channels.length === 1 ? { max: store.cap } : {}),
          ...(previous ? { delta: value - old } : {}) });
      }
    }
    const candidates: unknown[] = Array.isArray(hints) ? hints.slice(0, 8) : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const hint = candidate as Record<string, unknown>;
      if (typeof hint.key !== 'string' || seen.has(hint.key)
        || !Object.hasOwn(initial, hint.key) || typeof initial[hint.key] !== 'number'
        || typeof hint.label !== 'string' || !hint.label.trim() || hint.label.length > 80) continue;
      const value = state[hint.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      seen.add(hint.key);
      const old = before[hint.key];
      rows.push({ key: hint.key, label: hint.label.trim(), value,
        ...(typeof hint.max === 'number' && Number.isFinite(hint.max) && hint.max > 0 ? { max: hint.max } : {}),
        ...(previous && typeof old === 'number' && Number.isFinite(old) ? { delta: value - old } : {}) });
    }
    return { cardId: card.task.entry.id, name: card.candidate.card.name, rows };
  }).filter(card => card.rows.length);
}
