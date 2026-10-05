/**
 * NPC main-round update — records the round the main round last updated each NPC, which is what the world
 * heartbeat's 遗忘回合数 (forget after N rounds) measures. Ported from the demo's `上次主回合更新回合`
 * (worldHeartbeatService.ts:31-54, P8 / PO 2026-10-04).
 *
 * - afterCommands: only the main round's command stage calls it (command-execution.ts). The heartbeat, private chats
 *   and field repair run their commands straight through CommandExecutor, so they never count — as in the demo,
 *   where the heartbeat never writes this field. Every NPC the round's commands touched gets the current round.
 * - onGameLoad: an NPC without a record starts its clock at the current round. An older save has none, and the
 *   demo's "missing = 0" would forget every NPC of a long game at once; an NPC added by another flow (a new
 *   location's people) starts at the next load.
 */
// App doc: docs/user-guide/pages/game-heartbeat.md §遗忘回合数
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { ChangeLog, StateChange } from '../types';
import type { EngineNpcFieldNames } from '../pipeline/types';
import { MAX_ARRAY_CAPACITY } from '../core/command-executor';

type NpcRecord = Record<string, unknown>;

function isNpc(v: unknown): v is NpcRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The names of the NPCs a batch of changes touched. The batch is read from its last change back to its first,
 * undoing each whole-list or whole-record write as it goes (they carry the value as it was), so an index or filter
 * path is resolved against the list as it stood when that change was made — not after a later pull in the same
 * batch shifted it (code review L1). A change counts through:
 * - a `[name=X]` path: X, matched exactly as StateManager matches it; a rename through it, the new name;
 * - a whole-record write (`list[i]`, `list[k=v]`): the record written;
 * - any other index or filter path: the record it resolved to then;
 * - a push onto the list: the new last entry; a list write: the entries that differ from before.
 * A no-op — a filter that matched nothing records neither an old nor a new value — touches nobody (review L2). A
 * push that filled the list to its capacity may have evicted the oldest entry without a change of its own, so the
 * changes before it count only when they name the NPC themselves. Pure, for tests.
 */
export function touchedNpcNames(
  changes: readonly StateChange[],
  relationshipsPath: string,
  nameKey: string,
  currentList: readonly unknown[],
): Set<string> {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (isNpc(value) && typeof value[nameKey] === 'string' && value[nameKey]) names.add(value[nameKey] as string);
  };
  const matches = (item: unknown, key: string, value: string) => isNpc(item) && String(item[key]) === value;
  // The list right after the change being read; null once it can no longer be known.
  let list: readonly unknown[] | null = currentList;
  const entryPath = new RegExp(`^${escapeRegExp(relationshipsPath)}(?:\\[(\\d+)\\]|\\.(\\d+)|\\[([^=\\]]+)=([^\\]]+)\\])(.*)$`);
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (change.oldValue === undefined && change.newValue === undefined) continue;
    const path = String(change.path ?? '').trim();

    if (path === relationshipsPath) {
      const after = Array.isArray(change.newValue) ? change.newValue : [];
      if (change.action === 'push') {
        add(after[after.length - 1]);
      } else if (change.action === 'set') {
        const before = new Map<string, string>();
        for (const old of Array.isArray(change.oldValue) ? change.oldValue : []) {
          if (isNpc(old) && typeof old[nameKey] === 'string') before.set(old[nameKey] as string, JSON.stringify(old));
        }
        for (const entry of after) {
          if (isNpc(entry) && typeof entry[nameKey] === 'string' && before.get(entry[nameKey] as string) !== JSON.stringify(entry)) add(entry);
        }
      }
      list = change.action === 'push' && after.length >= MAX_ARRAY_CAPACITY ? null
        : Array.isArray(change.oldValue) ? change.oldValue : [];
      continue;
    }

    const entry = entryPath.exec(path);
    const rest = entry?.[5] ?? '';
    if (!entry || (rest !== '' && rest[0] !== '.' && rest[0] !== '[')) continue;
    const indexText = entry[1] ?? entry[2];
    const [filterKey, filterValue] = [entry[3], entry[4]];
    const at = indexText !== undefined ? Number(indexText)
      : list ? list.findIndex((item) => matches(item, filterKey, filterValue)) : -1;

    if (rest === '') {
      // The whole record: the one written counts; undo it so the earlier changes see the list as it was.
      if (change.action === 'set') add(change.newValue);
      if (list && at !== -1) {
        const copy = list.slice();
        copy[at] = change.oldValue;
        list = copy;
      } else {
        list = null;
      }
      continue;
    }
    if (filterKey === nameKey) {
      names.add(rest === `.${nameKey}` && change.action === 'set' && typeof change.newValue === 'string'
        ? change.newValue : filterValue);
      continue;
    }
    if (!list) continue;
    // A filter on the field this change rewrote matches the record by its new value.
    const resolved = at !== -1 ? at : filterKey !== undefined && rest === `.${filterKey}` && change.action === 'set'
      ? list.findIndex((item) => matches(item, filterKey, String(change.newValue))) : -1;
    if (resolved !== -1) add(list[resolved]);
  }
  return names;
}

export class NpcMainRoundUpdateModule implements BehaviorModule {
  readonly id = 'npc-main-round-update';

  constructor(
    private relationshipsPath: string,
    private roundNumberPath: string,
    private fields: EngineNpcFieldNames,
  ) {}

  afterCommands(stateManager: StateManager, changeLog: ChangeLog): void {
    const list = stateManager.get<unknown[]>(this.relationshipsPath);
    if (!Array.isArray(list)) return;
    const names = touchedNpcNames(changeLog.changes, this.relationshipsPath, this.fields.name, list);
    if (names.size === 0) return;
    const round = this.round(stateManager);
    for (const name of names) {
      const at = list.findIndex((npc) => isNpc(npc) && npc[this.fields.name] === name);
      if (at === -1 || (list[at] as NpcRecord)[this.fields.lastMainRoundUpdate] === round) continue;
      stateManager.set(`${this.relationshipsPath}[${at}].${this.fields.lastMainRoundUpdate}`, round, 'system');
    }
  }

  onGameLoad(stateManager: StateManager): void {
    const list = stateManager.get<unknown[]>(this.relationshipsPath);
    if (!Array.isArray(list)) return;
    const key = this.fields.lastMainRoundUpdate;
    if (!list.some((npc) => isNpc(npc) && typeof npc[key] !== 'number')) return;
    const round = this.round(stateManager);
    stateManager.set(this.relationshipsPath,
      list.map((npc) => (isNpc(npc) && typeof npc[key] !== 'number' ? { ...npc, [key]: round } : npc)), 'system');
  }

  private round(stateManager: StateManager): number {
    const value = stateManager.get<unknown>(this.roundNumberPath);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
