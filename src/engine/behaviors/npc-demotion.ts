/**
 * NPC demotion — a key NPC the main round has left alone for more than N rounds becomes an ordinary one. Ported from
 * the demo's runNpcMaintenance (worldHeartbeatService.ts:281-321), which runs at the end of every round outside the
 * opening (AIBidirectionalSystem.ts:2474); the settings page's 「NPC 降级阈值」 (PO 2026-10-05 5A).
 *
 * - Key: the pack's key type (`npcTypeKey`, 重点) or no type at all, as in the demo (`npc.类型 || '重点'`). Any
 *   other type (同伴, 商人, 敌对 …) is a classification of its own and is never demoted (2026-10-05: the first
 *   version demoted every type but 普通, so a hostile NPC stopped being hostile after a few quiet rounds).
 * - Never demoted: an NPC the player watches (`attention`, the demo's 实时关注), and one without a main-round record
 *   (`lastMainRoundUpdate`, kept by NpcMainRoundUpdateModule) — the demo leaves those alone too.
 * - Runs on round end (post-process), after the round's commands have stamped the NPCs they touched.
 */
// App doc: docs/user-guide/pages/home.md §NPC 设置 · game-heartbeat.md §NPC 降级
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { EngineNpcFieldNames } from '../pipeline/types';
import { DEFAULT_NPC_DEMOTION_THRESHOLD } from '../pipeline/types';

type NpcRecord = Record<string, unknown>;

function isNpc(v: unknown): v is NpcRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The threshold the player set: a whole number from 1, or the default when it is missing or unusable. */
export function demotionThresholdOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_NPC_DEMOTION_THRESHOLD;
}

export class NpcDemotionModule implements BehaviorModule {
  readonly id = 'npc-demotion';

  constructor(
    private relationshipsPath: string,
    private roundNumberPath: string,
    private thresholdPath: string,
    private keyType: string,
    private ordinaryType: string,
    private fields: EngineNpcFieldNames,
  ) {}

  onRoundEnd(stateManager: StateManager): void {
    const list = stateManager.get<unknown[]>(this.relationshipsPath);
    if (!Array.isArray(list)) return;
    const threshold = demotionThresholdOf(stateManager.get<unknown>(this.thresholdPath));
    const roundValue = stateManager.get<unknown>(this.roundNumberPath);
    const round = typeof roundValue === 'number' && Number.isFinite(roundValue) ? roundValue : 0;
    const { type, attention, lastMainRoundUpdate } = this.fields;
    list.forEach((npc, at) => {
      if (!isNpc(npc) || npc[attention] === true) return;
      const kind = npc[type];
      if (kind !== undefined && kind !== null && kind !== '' && kind !== this.keyType) return;
      const last = npc[lastMainRoundUpdate];
      if (typeof last !== 'number' || round - last <= threshold) return;
      stateManager.set(`${this.relationshipsPath}[${at}].${type}`, this.ordinaryType, 'system');
    });
  }
}
