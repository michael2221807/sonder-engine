import type { StateManager } from '../state-manager';
import type { EnginePathConfig } from '../../pipeline/types';
import type { SubPipelineBundle } from '../game-orchestrator';

/**
 * Environment handed to every post-round section.
 * `sub` is the orchestrator's own SubPipelineBundle object (same identity, never a copy),
 * because `worldbook:updated` mutates `sub.worldBooks` in place.
 */
export interface PostRoundEnv {
  sub: SubPipelineBundle;
  stateManager: StateManager;
  paths: EnginePathConfig;
}
