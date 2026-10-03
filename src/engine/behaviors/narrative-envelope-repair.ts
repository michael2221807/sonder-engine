/**
 * 叙事外壳自愈 — 读档时修好存成 JSON 外壳的回合正文
 *
 * Until 2026-10-03 a reply the parser could not read as JSON, or one the model wrapped whole in `<正文>`, was
 * saved with its envelope as the story, and the player saw `{"text":"…` at the top of the round. The parser no
 * longer does that (ResponseParser places the narrative tag by where it stands); this heals the rounds saved
 * before, on load: the story of each round in the narrative history (and the text kept before a polish), the
 * short-term memory the next rounds read, and the story snapshot of a bookmarked round — a broken round in either
 * of the last two would also show the model the envelope to copy. Only text that is such an envelope is touched,
 * entry by entry (a long history is not rewritten); the model's raw reply (`_rawResponse`) stays as it was.
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import { repairStoredNarrative } from '../ai/response-parser';

type Entry = Record<string, unknown>;

const healed = (text: unknown): string | null => (typeof text === 'string' ? repairStoredNarrative(text) : null);

export class NarrativeEnvelopeRepairModule implements BehaviorModule {
  readonly id = 'narrative-envelope-repair';

  constructor(
    private historyPath: string,
    private shortTermPath: string,
    private bookmarksPath: string,
  ) {}

  onGameLoad(stateManager: StateManager): void {
    const rounds = this.heal(stateManager, this.historyPath, (entry) => {
      if (entry.role !== 'assistant') return null;
      const content = healed(entry.content);
      const polish = entry._polish && typeof entry._polish === 'object' ? entry._polish as Entry : null;
      const original = polish ? healed(polish.originalText) : null;
      if (!content && !original) return null;
      return { ...entry, ...(content ? { content } : {}), ...(original && polish ? { _polish: { ...polish, originalText: original } } : {}) };
    });
    const memories = this.heal(stateManager, this.shortTermPath, (entry) => {
      const summary = healed(entry.summary);
      return summary ? { ...entry, summary } : null;
    });
    const bookmarks = this.heal(stateManager, this.bookmarksPath, (entry) => {
      const content = healed(entry.content);
      return content ? { ...entry, content } : null;
    });
    if (rounds + memories + bookmarks > 0) {
      console.log(`[NarrativeEnvelopeRepair] Healed ${rounds} round(s), ${memories} short-term memor(ies) and ${bookmarks} bookmark(s) saved as a JSON envelope`);
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
