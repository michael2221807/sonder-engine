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

type NpcRecord = Record<string, unknown>;

function isNpc(v: unknown): v is NpcRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The names of the NPCs a batch of changes touched: through a `[name=X]` path; through an index path (a merged
 * push writes `list[i]`), resolved against the list as it is now; by a push onto the list (the new entry is the
 * last); or by a whole-list write (the entries that differ from before). Pure, for tests.
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
  const rel = escapeRegExp(relationshipsPath);
  const byName = new RegExp(`^${rel}\\[${escapeRegExp(nameKey)}=([^\\]]+)\\]`);
  const byIndex = new RegExp(`^${rel}(?:\\[(\\d+)\\]|\\.(\\d+))(?:[.[]|$)`);
  for (const change of changes) {
    const path = String(change.path ?? '').trim();
    const named = byName.exec(path);
    if (named) { names.add(named[1].trim()); continue; }
    const indexed = byIndex.exec(path);
    if (indexed) {
      const index = Number(indexed[1] ?? indexed[2]);
      add(path === `${relationshipsPath}[${index}]` || path === `${relationshipsPath}.${index}` ? change.newValue : currentList[index]);
      continue;
    }
    if (path !== relationshipsPath || !Array.isArray(change.newValue)) continue;
    if (change.action === 'push') { add(change.newValue[change.newValue.length - 1]); continue; }
    const before = new Map<string, string>();
    for (const old of Array.isArray(change.oldValue) ? change.oldValue : []) {
      if (isNpc(old) && typeof old[nameKey] === 'string') before.set(old[nameKey] as string, JSON.stringify(old));
    }
    for (const entry of change.newValue) {
      if (isNpc(entry) && typeof entry[nameKey] === 'string' && before.get(entry[nameKey] as string) !== JSON.stringify(entry)) add(entry);
    }
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
