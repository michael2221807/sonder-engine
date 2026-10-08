/**
 * Audit-append helper — funnels sub-pipeline change logs into the UI's
 * existing round-level `_delta` display on the assistant narrative entry.
 *
 * Design rationale
 * ----------------
 * The main round's `PostProcessStage` attaches `changeLog.changes[]` to the
 * most recent assistant narrative entry's `_delta` field. `DeltaViewer.vue`
 * renders that field inside the per-message "Δ" badge.
 *
 * Sub-pipelines (privacy repair, field repair, world heartbeat, NPC
 * generation) run AFTER post-process for the same turn, so by the time they
 * execute there already IS a last-assistant-entry to append to.
 * This helper performs that append in one place, tagging every change with a
 * `source` so the UI can label "心跳" / "补齐" / "生成" separately from "主线".
 *
 * If no assistant entry exists yet (e.g., opening scene first run), we fall
 * back silently — the audit is non-critical and must not break the pipeline.
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { StateChange } from '../types/state';

/**
 * Source tag attached to each audit change. Matches the DeltaViewer UI labels.
 */
export type AuditSource =
  | 'main'
  | 'privacyRepair'
  | 'fieldRepair'
  | 'edgeReview'
  | 'worldHeartbeat'
  | 'npcGeneration'
  | 'bodyPolish';

/** A change record as stored on the narrative entry's _delta, with source tag. */
type TaggedChange = StateChange & { source?: AuditSource };

/**
 * Append a batch of changes to the last assistant narrative entry's `_delta`.
 * Each change gets tagged with the provided source.
 *
 * Swallows missing-entry / non-array errors — audit is best-effort.
 */
export function appendChangesToLastNarrative(
  stateManager: StateManager,
  paths: EnginePathConfig,
  source: AuditSource,
  changes: StateChange[],
): void {
  if (!changes || changes.length === 0) return;

  const history = stateManager.get<Array<Record<string, unknown>>>(paths.narrativeHistory);
  if (!Array.isArray(history) || history.length === 0) return;

  // Scan backwards for the most recent assistant entry; tool messages and user
  // echoes shouldn't carry audit deltas.
  let targetIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant') {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return;

  const entry = { ...history[targetIdx] };
  const existing: TaggedChange[] = Array.isArray(entry._delta)
    ? [...(entry._delta as TaggedChange[])]
    : [];

  const tagged: TaggedChange[] = changes.map((c) => ({ ...c, source }));
  entry._delta = [...existing, ...tagged];

  const nextHistory = [...history];
  nextHistory[targetIdx] = entry;
  stateManager.set(paths.narrativeHistory, nextHistory, 'system');
}
