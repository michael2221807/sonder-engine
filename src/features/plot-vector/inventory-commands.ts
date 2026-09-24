import type { Command } from '../../engine/types';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';

/** Explicit create aliases, never name matching or narrative inference. Pure and replayable. */
export function resolveInventoryCommands(commands: readonly Command[], ids: readonly string[], round: number) {
  const root = P.inventoryItems;
  const known = new Set(ids), aliases = new Map<string, string>();
  const accepted: Command[] = [], rejected: Array<{ index: number; key: string; reason: string }> = [];
  const reject = (index: number, c: Command, reason: string) => rejected.push({ index, key: c.key, reason });
  for (const [index, c] of commands.entries()) {
    if (c.key === root || root.startsWith(c.key + '.') || c.key.startsWith(root + '[')) {
      reject(index, c, 'Inventory must be updated through individual item references'); continue;
    }
    if (!c.key.startsWith(root + '.')) { accepted.push(c); continue; }
    const tail = c.key.slice(root.length + 1), [ref] = tail.split('.');
    const suffix = tail.slice(ref.length);
    let id = aliases.get(ref);
    if (!id && known.has(ref)) id = ref;
    if (!id && /^__new_[1-9][0-9]{0,2}$/.test(ref) && c.action === 'set' && !suffix
      && c.value && typeof c.value === 'object' && !Array.isArray(c.value)) {
      const base = `pv_${round}_${ref.slice(6)}`;
      id = base;
      for (let n = 1; known.has(id); n++) id = `${base}_${n}`;
      aliases.set(ref, id); known.add(id);
    }
    if (!id) { reject(index, c, 'Unknown item reference; creation requires __new_N'); continue; }
    accepted.push({ ...c, key: `${root}.${id}${suffix}` });
  }
  return { commands: accepted, rejected };
}
