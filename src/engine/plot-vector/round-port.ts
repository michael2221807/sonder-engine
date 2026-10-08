import type { PipelineContext } from '../pipeline/types';

/** Injected component: engine pipeline never imports a game-specific board. */
export interface PlotVectorRoundPort {
  promptTransform?(ctx: PipelineContext): import('../prompt/raw-prompt-transform').RawPromptTransform | undefined;
  prepare(ctx: PipelineContext): Promise<PipelineContext>;
  beforeSave(ctx: PipelineContext): Promise<void>;
  afterSave(ctx: PipelineContext): Promise<void>;
  dispose(): void;
}
