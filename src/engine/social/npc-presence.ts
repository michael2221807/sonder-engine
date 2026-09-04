/**
 * NpcPresenceService — Sprint Social-2
 *
 * Partitions the NPC list into "present" (in current scene with player) and
 * "absent" (elsewhere) groups. Reads `paths.npcFieldNames.isPresent` boolean.
 *
 * Pure utility — no state mutation, no pipeline dependency. Used by:
 * - `NpcContextRenderer` (prompt partition)
 * - Future `RelationshipPanel.vue` (UI grouping in Social-3)
 */
import type { EnginePathConfig } from '../pipeline/types';
import type { StateManager } from '../core/state-manager';

export interface NpcRecord {
  [key: string]: unknown;
}

export interface PresencePartition {
  present: NpcRecord[];
  absent: NpcRecord[];
}

/**
 * Colocation rule shared by PostProcess `syncPresence` (writes `是否在场`) and the Context
 * Compiler's present-NPC fallback (reads it when presence is off). Locations are
 * hierarchical names joined by `separator`: an NPC at `A·B` is colocated with a player at
 * `A·B·C` and vice versa; `A·B` and `A·Bx` are not. Empty strings never match.
 */
export function isColocatedLocation(npcLocation: string, playerLocation: string, separator: string): boolean {
  if (!npcLocation || !playerLocation) return false;
  if (npcLocation === playerLocation) return true;
  if (!separator) return false;
  return playerLocation.startsWith(npcLocation + separator) || npcLocation.startsWith(playerLocation + separator);
}

export class NpcPresenceService {
  constructor(
    private stateManager: StateManager,
    private paths: EnginePathConfig,
  ) {}

  partition(): PresencePartition {
    const list = this.stateManager.get<NpcRecord[]>(this.paths.relationships) ?? [];
    const fieldName = this.paths.npcFieldNames?.isPresent ?? '是否在场';
    const present: NpcRecord[] = [];
    const absent: NpcRecord[] = [];

    for (const npc of list) {
      if (npc[fieldName] === true) {
        present.push(npc);
      } else {
        absent.push(npc);
      }
    }

    return { present, absent };
  }

  setPresence(npcName: string, value: boolean): void {
    const list = this.stateManager.get<NpcRecord[]>(this.paths.relationships);
    if (!Array.isArray(list)) return;

    const nameField = this.paths.npcFieldNames?.name ?? '名称';
    const presenceField = this.paths.npcFieldNames?.isPresent ?? '是否在场';
    const idx = list.findIndex((n) => n[nameField] === npcName);
    if (idx < 0) return;

    const updated = [...list];
    updated[idx] = { ...updated[idx], [presenceField]: value };
    this.stateManager.set(this.paths.relationships, updated, 'system');
  }

  clearAllPresence(): void {
    const list = this.stateManager.get<NpcRecord[]>(this.paths.relationships);
    if (!Array.isArray(list)) return;

    const presenceField = this.paths.npcFieldNames?.isPresent ?? '是否在场';
    const updated = list.map((n) => ({ ...n, [presenceField]: false }));
    this.stateManager.set(this.paths.relationships, updated, 'system');
  }
}
