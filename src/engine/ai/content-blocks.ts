/**
 * Multimodal content-block helpers（图片提炼 epic P0）
 *
 * `AIMessage.content` widened to `string | AIContentBlock[]`. Every consumer
 * that previously assumed `string` funnels through these helpers so the
 * assumptions live in one place:
 *
 * - wire serialization is provider-specific (see OpenAIProvider.toWireMessages)
 * - token estimation for image blocks uses a fixed budget — base64 length is
 *   NOT a token count (an image billed by vision models is bounded, while its
 *   base64 text can be hundreds of KB)
 * - debug/UI surfaces render image blocks as a short placeholder, never the
 *   raw base64 payload
 */
import type { AIContentBlock, AIMessage } from './types';

/**
 * Fixed token budget per image block for context-window estimation.
 * Conservative upper bound across target models (OpenAI high-detail tiles /
 * Claude ~1.15 tokens per 750px² region); over-estimating only shrinks
 * maxTokens, never overflows the window.
 */
export const IMAGE_BLOCK_TOKEN_BUDGET = 1600;

export function isBlockContent(
  content: AIMessage['content'],
): content is AIContentBlock[] {
  return Array.isArray(content);
}

export function messageHasImageBlocks(message: AIMessage): boolean {
  return isBlockContent(message.content)
    && message.content.some((b) => b.type === 'image');
}

export function messagesHaveImageBlocks(messages: AIMessage[]): boolean {
  return messages.some(messageHasImageBlocks);
}

/**
 * Collapse content to plain text: text blocks joined by newline, image blocks
 * dropped. For flows that must stay text-only (prefill conversion, logging).
 */
export function contentToText(content: AIMessage['content']): string {
  if (!isBlockContent(content)) return content;
  return content
    .filter((b): b is Extract<AIContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Debug/display rendering: image blocks become a short `[图片 <mime> ≈<n>KB]`
 * placeholder instead of the base64 payload (PromptPanel / PromptAssemblyPanel).
 */
export function contentToDebugText(content: AIMessage['content']): string {
  if (!isBlockContent(content)) return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : imagePlaceholder(b.dataUrl)))
    .join('\n');
}

/**
 * Debug-safe copy of a message list: every content collapsed to display text
 * (image blocks → placeholder). For loggers/exports that JSON.stringify
 * messages — raw base64 must never reach console, clipboard, or files.
 */
export function messagesToDebugSafe(
  messages: readonly AIMessage[],
): Array<{ role: AIMessage['role']; content: string }> {
  return messages.map((m) => ({ role: m.role, content: contentToDebugText(m.content) }));
}

function imagePlaceholder(dataUrl: string): string {
  const mime = /^data:([^;]+);/.exec(dataUrl)?.[1] ?? 'image';
  // base64 → bytes ≈ len × 3/4
  const kb = Math.max(1, Math.round((dataUrl.length * 3) / 4 / 1024));
  return `[图片 ${mime} ≈${kb}KB]`;
}
