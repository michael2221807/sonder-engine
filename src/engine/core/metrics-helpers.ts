/**
 * 每回合指标估算工具 — 为 narrativeHistory 条目上的 `_metrics` 字段提供
 * token 估算（输入/输出）。独立于 provider 层以避免循环依赖。
 *
 * 算法和 `BaseProvider.estimateTokens` 保持一致，便于二者的数字互相对照：
 *   - CJK 字符按 1 token/字
 *   - 非 CJK 字符按 4 字符/token（向上取整）
 *   - 每条消息固定 8 token 开销（roles + wrapper）
 *
 * 精度说明：这是粗估，不使用 tiktoken；在 CJK 为主的 prompt 上误差通常在 10-15%。
 * Phase 5 可选升级到 js-tiktoken（~400KB 额外包体积换 5-10% 精度）。
 */

import type { AIContentBlock } from '../ai/types';
import { IMAGE_BLOCK_TOKEN_BUDGET } from '../ai/content-blocks';

const OVERHEAD_PER_MESSAGE = 8;

/** CJK 字符判断 — 只看 CJK 统一汉字区段，够用且和 base-provider 算法一致 */
function countCjkChars(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return cjk;
}

/** 单段文本的 token 估算（不含消息开销） */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjkChars(text);
  const nonCjk = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(nonCjk / 4);
}

/** 整个消息列表的 token 估算（含每条消息的 8 token 开销）；图片块按固定预算计 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<{ content: string | AIContentBlock[] }>,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((sum, msg) => {
    if (Array.isArray(msg.content)) {
      const blocks: readonly AIContentBlock[] = msg.content;
      return sum + OVERHEAD_PER_MESSAGE + blocks.reduce((s: number, block: AIContentBlock) => (
        block.type === 'image'
          ? s + IMAGE_BLOCK_TOKEN_BUDGET
          : s + estimateTextTokens(block.text)
      ), 0);
    }
    return sum + OVERHEAD_PER_MESSAGE + estimateTextTokens(msg.content ?? '');
  }, 0);
}
