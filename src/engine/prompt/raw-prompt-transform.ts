/** Applied to resolved module text BEFORE rendering variables. Never receives history or user input. */
export type RawPromptTransform = (promptId: string, raw: string) => string;
