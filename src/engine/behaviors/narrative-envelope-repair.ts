/**
 * 叙事外壳自愈 — 读档时修好存坏的回合正文
 *
 * Until 2026-10-03 a reply the parser could not read as JSON, or one the model wrapped whole in `<正文>`, was
 * saved with its envelope as the story, and the player saw `{"text":"…` at the top of the round; and a reply that
 * escaped its story twice inside `<正文>` was saved with every line break a literal `\n` and every quote a `\"`.
 * The parser no longer does either; this heals the rounds saved before, on load: the story of each round in the
 * narrative history (and the text kept before a polish), then the short-term memory the next rounds read and the
 * story snapshot of a bookmarked round — a broken text in either of the last two would also show the model the
 * envelope or the escapes to copy.
 *
 * Only what is evidently broken is touched, entry by entry (a long history is not rewritten):
 * - an envelope (`{"text":…`, bare or in the tag) is read for its story;
 * - escapes are decoded only when the round's own raw reply (`_rawResponse`, kept as it was) read again gives
 *   exactly that, so a story that shows a backslash of its own is never changed, and a healed round reads the same
 *   on every later load;
 * - a short-term memory or a bookmark holds a round's story as it was: it is healed when it is a text the history
 *   healed (or an envelope).
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import { repairStoredNarrative, rereadStoredNarrative } from '../ai/response-parser';

type Entry = Record<string, unknown>;

export class NarrativeEnvelopeRepairModule implements BehaviorModule {
  readonly id = 'narrative-envelope-repair';

  constructor(
    private historyPath: string,
    private shortTermPath: string,
    private bookmarksPath: string,
  ) {}

  onGameLoad(stateManager: StateManager): void {
    /** Each text the history healed, and what it became: the same text elsewhere is the same story. */
    const healedTexts = new Map<string, string>();
    const healRound = (text: unknown, raw: unknown): string | null => {
      if (typeof text !== 'string') return null;
      const next = repairStoredNarrative(text) ?? rereadStoredNarrative(text, raw);
      if (next) healedTexts.set(text, next);
      return next;
    };
    const healCopy = (text: unknown): string | null =>
      typeof text === 'string' ? repairStoredNarrative(text) ?? healedTexts.get(text) ?? null : null;

    const rounds = this.heal(stateManager, this.historyPath, (entry) => {
      if (entry.role !== 'assistant') return null;
      const content = healRound(entry.content, entry._rawResponse);
      const polish = entry._polish && typeof entry._polish === 'object' ? entry._polish as Entry : null;
      const original = polish ? healRound(polish.originalText, entry._rawResponse) : null;
      if (!content && !original) return null;
      return { ...entry, ...(content ? { content } : {}), ...(original && polish ? { _polish: { ...polish, originalText: original } } : {}) };
    });
    const memories = this.heal(stateManager, this.shortTermPath, (entry) => {
      const summary = healCopy(entry.summary);
      return summary ? { ...entry, summary } : null;
    });
    const bookmarks = this.heal(stateManager, this.bookmarksPath, (entry) => {
      const content = healCopy(entry.content);
      return content ? { ...entry, content } : null;
    });
    if (rounds + memories + bookmarks > 0) {
      console.log(`[NarrativeEnvelopeRepair] Healed ${rounds} round(s), ${memories} short-term memor(ies) and ${bookmarks} bookmark(s) saved with an envelope or escapes`);
    }
  }

  /** Rewrite each entry of the array at `path` that `fix` returns a replacement for; the count rewritten. */
  private heal(stateManager: StateManager, path: string, fix: (entry: Entry) => Entry | null): number {
    const entries = stateManager.get<unknown[]>(path);
    if (!Array.isArray(entries)) return 0;
    let count = 0;
    entries.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const next = fix(entry as Entry);
      if (!next) return;
      stateManager.set(`${path}.${i}`, next, 'system');
      count++;
    });
    return count;
  }
}
