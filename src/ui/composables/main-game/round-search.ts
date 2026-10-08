/**
 * Round lookup and full-text search over the displayed chat history
 * (R7 step 4). Pure functions moved out of MainGamePanel; the debounce timer,
 * the pinned-jump scrolling and the dropdown state stay in the panel.
 */

/** Minimal message shape the lookup / search need. */
export interface SearchableMessage {
  role: string;
  content?: string;
  _metrics?: { roundNumber?: number };
}

export interface SearchHit {
  roundNumber: number;
  role: string;
  snippet: string;
  globalIndex: number;
}

export const MAX_SEARCH_RESULTS = 50;

/** Round number shown for the message at `idx` (own metrics, then a later message's, then a count). */
export function roundForMessageAt(msgs: ReadonlyArray<SearchableMessage>, idx: number): number {
  const msg = msgs[idx];
  if (msg?._metrics?.roundNumber) return msg._metrics.roundNumber;
  for (let i = idx + 1; i < msgs.length; i++) {
    if (msgs[i]._metrics?.roundNumber) return msgs[i]._metrics!.roundNumber!;
  }
  let count = 0;
  for (let i = 0; i <= idx; i++) {
    if (msgs[i].role === 'assistant') count++;
  }
  return count || 1;
}

/**
 * Case-insensitive substring search. `getMessages` is a getter so the (possibly large)
 * history is only read once the query is long enough, like the original computed.
 */
export function searchMessages(
  getMessages: () => ReadonlyArray<SearchableMessage>,
  debouncedQuery: string,
): SearchHit[] {
  const q = debouncedQuery.trim();
  if (!q || q.length < 2) return [];
  const msgs = getMessages();
  const results: SearchHit[] = [];
  const qLower = q.toLowerCase();
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg.content) continue;
    const contentLower = msg.content.toLowerCase();
    const matchIdx = contentLower.indexOf(qLower);
    if (matchIdx === -1) continue;

    const round = roundForMessageAt(msgs, i);
    const start = Math.max(0, matchIdx - 30);
    const end = Math.min(msg.content.length, matchIdx + q.length + 30);
    const snippet =
      (start > 0 ? '…' : '') +
      msg.content.slice(start, end) +
      (end < msg.content.length ? '…' : '');

    results.push({ roundNumber: round, role: msg.role, snippet, globalIndex: i });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}
