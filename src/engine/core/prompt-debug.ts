/**
 * Debug hooks for PromptAssemblyPanel — unified emit helpers.
 *
 * The panel needs two events per AI call:
 *
 *   1. `ui:debug-prompt`         — fired BEFORE the network request, captures
 *                                  the assembled messages / sources / vars.
 *   2. `ui:debug-prompt-response` — fired AFTER the response arrives, carries
 *                                  the parsed thinking text and the raw body.
 *
 * Callers previously hand-rolled both events, which led to two classes of
 * bugs:
 *   - sub-pipelines emitted assembly events but forgot `messageSources` /
 *     `generationId`, so the panel labelled every row "—" and its per-snapshot
 *     CoT attach logic had no handle to match on.
 *   - sub-pipelines emitted assembly events but never emitted the response
 *     event, so thinking was silently dropped even when the model produced it.
 *
 * Use these helpers from any flow that calls `aiService.generate`; they're
 * thin wrappers that never throw (debug-only plumbing).
 */
import { eventBus } from './event-bus';
import { extractThinkingBlocks } from '../ai/thinking-tags';
import type { AIMessage } from '../ai/types';
import type { MessageSourceTag } from '../prompt/prompt-assembler';
import type { CompileTrace } from '../pipeline/types';

/**
 * Match a raw AI response's thinking block(s). Mirrors
 * `ResponseParser.extractAndSanitize` but local so debug consumers don't have
 * to instantiate the parser just to surface CoT.
 */
export function extractThinkingFromRaw(raw: string): string | undefined {
  if (!raw) return undefined;
  return extractThinkingBlocks(raw);
}

export interface EmitAssemblyDebugParams {
  flow: string;
  variables: Record<string, string>;
  messages: AIMessage[];
  messageSources?: MessageSourceTag[];
  generationId?: string;
  roundNumber?: number;
  /** Context Compiler decisions for this call (split-gen step2 only). */
  compileTrace?: CompileTrace;
}

/** Pre-call emission. Captures the fully-assembled messages the caller will send. */
export function emitPromptAssemblyDebug(params: EmitAssemblyDebugParams): void {
  try {
    eventBus.emit('ui:debug-prompt', params);
  } catch {
    /* debug-only, never throw */
  }
}

export interface EmitResponseDebugParams {
  flow: string;
  generationId?: string;
  /** Parsed thinking text — pass undefined if the model has none. */
  thinking?: string;
  /** Raw AI body — useful when the parser crashes and the snapshot needs a fallback. */
  rawResponse?: string;
}

/** Post-call emission. Attaches CoT / raw body to the snapshot by generationId / flow. */
export function emitPromptResponseDebug(params: EmitResponseDebugParams): void {
  try {
    eventBus.emit('ui:debug-prompt-response', params);
  } catch {
    /* debug-only, never throw */
  }
}
