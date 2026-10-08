import { parseJsonWithRepairs } from './json-escape-sanitize';
import { stripThinkOrThinkingBlocks } from './thinking-tags';

/**
 * JSON 块提取工具 — 2026-04-11 CR M-08 修复
 *
 * 背景：记忆子管线（mid-term-refine / memory-summary / long-term-compact）需要
 * 从 AI 响应中提取特定 key 的 JSON 对象作为 last-resort fallback。旧版本用贪婪
 * 正则 `/\{[\s\S]*"key"[\s\S]*\}/`，在以下场景会失败：
 *
 * 1. AI 响应同时包含多个 JSON 块（比如一个 chain-of-thought 块 + 一个正式输出
 *    块），贪婪正则会从第一个 `{` 匹配到最后一个 `}`，把两块中间的文本也吞进去，
 *    JSON.parse 必然失败
 * 2. AI 用 markdown 代码栅栏包裹 JSON（```json ... ```），围栏字符和说明文字
 *    混入匹配结果
 * 3. 嵌套 JSON 中 key 只在内层出现，贪婪会抓到外层对象
 *
 * 解决方案：
 *
 * 1. 先把 markdown 代码栅栏剥离（`stripMarkdownFences`）
 * 2. 用括号平衡扫描找出所有顶层 `{...}` 块（`findBalancedJsonBlocks`）
 * 3. 依次尝试 JSON.parse 每一块，返回第一个包含目标 key 的有效对象
 *
 * 这个工具**只负责文本层面的 JSON 抽取**，不负责字段校验或归一化——那是调用方
 * 的责任（memory 子管线会继续用自己的 normalize 函数处理抽出的对象）。
 */

/**
 * 剥离 markdown 代码栅栏
 *
 * 处理三种格式：
 * - ` ```json\n{...}\n``` ` — 带语言标签
 * - ` ```\n{...}\n``` ` — 不带语言标签
 * - 原文本不含围栏 — 原样返回
 *
 * 只替换围栏本身（` ``` ` 三个反引号），不替换 JSON 内部内容。
 */
export function stripMarkdownFences(text: string): string {
  // First try closed fences; fallback strips an unclosed opening fence (truncated output)
  const stripped = text.replace(/```(?:json|javascript|js)?\s*\n([\s\S]*?)\n?```/gi, '$1');
  if (stripped !== text) return stripped;
  return text.replace(/^```(?:json|javascript|js)?\s*\n/i, '');
}

/**
 * 括号平衡扫描，找出文本中所有顶层 `{...}` 块
 *
 * 使用简单的括号计数 + 字符串字面量感知（跳过字符串里的 `{`/`}`）。
 * 不处理注释（JSON 本来就没有注释），不处理转义错误（交给 JSON.parse 报错）。
 *
 * 返回每个块的原始文本数组，顺序按出现先后。
 */
export function findBalancedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (text[i] !== '{') {
      i++;
      continue;
    }

    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    while (i < n) {
      const ch = text[i];

      if (escape) {
        escape = false;
        i++;
        continue;
      }

      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        i++;
        continue;
      }

      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          blocks.push(text.slice(start, i + 1));
          i++;
          break;
        }
      }

      i++;
    }

    // 未闭合的块：跳过，继续从下一个字符扫描
    if (depth !== 0) {
      i = start + 1;
    }
  }

  return blocks;
}

/**
 * 从 AI 响应中提取第一个包含指定 key 的 JSON 对象
 *
 * @param rawResponse AI 返回的原始文本
 * @param requiredKey 必须存在的 key 名（如 `"refined"` 或 `"long_term_memories"`）
 * @returns 成功解析且包含 requiredKey 的对象；找不到返回 `null`
 *
 * 调用方应继续用自己的 normalize 函数处理返回的对象，本函数不做字段校验。
 */
export function extractJsonObjectByKey(
  rawResponse: string,
  requiredKey: string,
): Record<string, unknown> | null {
  const stripped = stripMarkdownFences(rawResponse);
  const blocks = findBalancedJsonBlocks(stripped);

  for (const block of blocks) {
    // 2026-04-19: 原文失败后过一遍 escape sanitizer 再试一次
    // 修复 LLM \X stutter bug（参见 json-escape-sanitize.ts 头注）
    const parsed = parseJsonWithRepairs(block, 'escapes');
    if (parsed === undefined) continue;

    // 递归查找 requiredKey —— 支持嵌套对象（例如 `{semantic_memory: {long_term_memories: [...]}}`）
    if (containsKey(parsed, requiredKey)) {
      return parsed as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Shared front half of the assistant and preset reply parsers: take the `<think>` / `<thinking>`
 * blocks out, take the markdown fences off, find the balanced `{...}` blocks and parse each one as is
 * (no repair). `visit` is called with each block that parses to a plain object (not an array, not
 * null) and the block's index; anything it throws is swallowed, so a block it cannot use is skipped.
 * Returns the cleaned text so a caller can still try it whole.
 */
export function scanJsonObjectBlocks(
  raw: string,
  visit: (obj: Record<string, unknown>, index: number) => void,
): string {
  const cleaned = stripMarkdownFences(stripThinkOrThinkingBlocks(raw));
  const blocks = findBalancedJsonBlocks(cleaned);
  blocks.forEach((blk, idx) => {
    try {
      const obj = JSON.parse(blk) as Record<string, unknown>;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      visit(obj, idx);
    } catch {
      /* skip a block that is not JSON, or that visit cannot use */
    }
  });
  return cleaned;
}

/** 递归查找对象树中是否存在某个 key */
function containsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some((v) => containsKey(v, key));
  }
  const record = obj as Record<string, unknown>;
  if (key in record) return true;
  for (const v of Object.values(record)) {
    if (containsKey(v, key)) return true;
  }
  return false;
}

/**
 * Tolerant JSON extraction shared across batch AI pipelines (Story 4 solidify,
 * Story 7 card edge classify): scan candidate '{' start positions from the END
 * of the raw response and return the first JSON.parse-able value accepted by
 * `accept`. Survives thinking tags, prose preambles and code fences.
 */
export function parseLooseJson<T>(raw: string, accept: (v: unknown) => v is T): T | null {
  const openBraces: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') openBraces.push(i);
  }

  for (let i = openBraces.length - 1; i >= 0; i--) {
    const candidate = raw.slice(openBraces[i]);
    const closeIdx = candidate.lastIndexOf('}');
    if (closeIdx < 0) continue;

    const parsed = parseJsonWithRepairs(candidate.slice(0, closeIdx + 1), 'none');
    if (parsed === undefined) continue;
    try {
      if (accept(parsed)) return parsed;
    } catch {
      continue;
    }
  }

  return null;
}
