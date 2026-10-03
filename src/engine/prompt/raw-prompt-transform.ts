/**
 * Applied to resolved module text BEFORE rendering variables. Never receives history or user input (recent story
 * has its own, narrower view: PipelineMeta.historyStoryOnly, which only leaves system lines out).
 */
export type RawPromptTransform = (promptId: string, raw: string) => string;
