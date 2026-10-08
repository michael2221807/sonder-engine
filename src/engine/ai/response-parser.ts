/**
 * AI 响应解析器 — 从 AI 原始输出中提取结构化数据
 *
 * 解析流程：
 * 1. sanitize: 清理 <think>/<reasoning> 等思维链标签
 * 2. tryParseJson: 多策略提取 JSON（直接解析 / 代码块 / 花括号范围）
 * 3. 从 JSON 中提取 text, commands, midTermMemory, actionOptions 等
 *
 * 以上是主干；旁路块提取、`<正文>` 判定、信封抢救、CoT 伪标签剥离等步骤见 parse() 内的分节注释。
 *
 * 兼容说明：
 * - 优先使用 "commands" 字段（新键名）
 * - 回退到 "tavern_commands"（demo 遗留键名）
 * - 支持纯文本响应（无 JSON 时 text = 整个响应）
 *
 * 移植自 demo AIBidirectionalSystem.ts 的 JSON 解析逻辑。
 * 对应 STEP-03B M2.5。
 */
import type { AIResponse, RawSettingUpdate } from './types';
import { MAX_RAW_SETTING_UPDATES } from './types';
import type { Command } from '../types';
import { parseJsonWithRepairs } from './json-escape-sanitize';
import { THINKING_TAGS, extractThinkingBlocks, stripThinkingBlocks } from './thinking-tags';

/**
 * 尝试用原生 JSON.parse；失败就把字符串过一遍 escape sanitizer 再试；
 * 仍失败则做未转义引号愈合后最后一搏（round-62 事故：evidence 逐字引用
 * 玩家原文中的英文直引号炸掉整个 step2 JSON —— 见 healUnescapedQuotes）。
 * 返回解析出的对象或 null。
 */
function tryParseWithSanitizer(src: string): Record<string, unknown> | null {
  const parsed = parseJsonWithRepairs(src, 'escapes+quotes');
  return parsed === undefined ? null : (parsed as Record<string, unknown>);
}

/** Where a scan over a reply stands: inside how many objects, and inside a JSON string (after a backslash or not). */
interface ObjectScanState { depth: number; inString: boolean; escaped: boolean }

function newObjectScan(): ObjectScanState {
  return { depth: 0, inString: false, escaped: false };
}

/**
 * One character of the string-aware scan the reply scanners share: string state is tracked only inside an object
 * (`depth > 0`); outside JSON, quotes do not matter. Each scanner keeps its own checks around this step.
 */
function stepObjectScan(s: ObjectScanState, c: string): void {
  if (s.inString) {
    if (s.escaped) s.escaped = false;
    else if (c === '\\') s.escaped = true;
    else if (c === '"') s.inString = false;
  } else if (c === '{') s.depth++;
  else if (c === '}' && s.depth > 0) s.depth--;
  else if (c === '"' && s.depth > 0) s.inString = true;
}

/**
 * Lift `<tag>…</tag>` blocks out of a reply: the text without them, and each tag's contents (several blocks
 * of one tag are joined by a blank line). One pass over the text: inside a JSON object, string state is
 * tracked, so the same characters inside a JSON string are never taken; outside JSON (prose, or a block
 * before or after the JSON) quotes do not matter. A block's own content is skipped whole. An opening tag left
 * unclosed (a cut-off reply) takes the rest of the text. Tags that do not appear are absent from `sidecars`.
 */
export function liftSidecars(text: string, tags: readonly string[] | undefined): { text: string; sidecars: Record<string, string> } {
  const wanted = (tags ?? []).filter(Boolean);
  const found = new Map<string, string[]>();
  const scan = newObjectScan();
  let kept = '', i = 0;
  while (i < text.length) {
    const tag = scan.inString ? undefined : wanted.find(t => text.startsWith(`<${t}>`, i));
    if (tag) {
      const open = i + tag.length + 2, close = text.indexOf(`</${tag}>`, open);
      found.set(tag, [...(found.get(tag) ?? []), text.slice(open, close < 0 ? text.length : close).trim()]);
      i = close < 0 ? text.length : close + tag.length + 3;
      continue;
    }
    const c = text[i];
    stepObjectScan(scan, c);
    kept += c;
    i++;
  }
  return { text: kept.trim(), sidecars: Object.fromEntries([...found].map(([tag, blocks]) => [tag, blocks.join('\n\n')])) };
}

/** Top-level keys the parser reads; any other top-level key is kept in `customFields`. */
const KNOWN_RESPONSE_KEYS = new Set([
  'text', '叙事文本',
  'commands', 'tavern_commands', '指令',
  'mid_term_memory', '中期记忆',
  'action_options', '行动选项',
  'judgement',
  'semantic_memory',
  'knowledge_facts',
  'setting_updates',
  'memoryEntry', 'memory_entry', '记忆条目',
]);

/** `{"text":` — how a reply envelope's narrative key opens (the key's alias included); the head patterns below all start from it. */
export const ENVELOPE_KEY_HEAD = String.raw`\{\s*"(?:text|叙事文本)"\s*:`;
export const ENVELOPE_HEAD = new RegExp(String.raw`^${ENVELOPE_KEY_HEAD}\s*"`);
const ENVELOPE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
const QUOTED_KEY = /^"(?:[^"\\]|\\.)*"\s*:/;
const LOOSE_KEY = /^(?:'([^'\\]*)'|([^\s'":,{}[\]]+))\s*:/;

/**
 * Whether the quote just before `from` ends the narrative value: the object ends, the reply ends, or the next key
 * follows — any double-quoted key, or one of the reply's own keys written single-quoted or bare (`, commands:`),
 * which prose never is.
 */
function closesEnvelopeValue(text: string, from: number): boolean {
  let j = from;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length || text[j] === '}') return true;
  if (text[j] !== ',') return false;
  j++;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return true;
  const rest = text.slice(j, j + 200);
  if (QUOTED_KEY.test(rest)) return true;
  const loose = LOOSE_KEY.exec(rest);
  return !!loose && KNOWN_RESPONSE_KEYS.has(loose[1] ?? loose[2]);
}

/**
 * Where the narrative value of the reply's envelope starts: the first top-level object (outside any other object;
 * prose before it may have braces of its own) that opens with `"text":"`, or else the first `{"` of the reply if
 * that is the envelope. A `"text"` nested inside another object is never the narrative. -1 without one.
 */
function envelopeValueStart(text: string): number {
  const scan = newObjectScan();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!scan.inString && c === '{') {
      const head = scan.depth === 0 ? ENVELOPE_HEAD.exec(text.slice(i, i + 200)) : null;
      if (head) return i + head[0].length;
    }
    stepObjectScan(scan, c);
  }
  // An unbalanced brace in the prose (`好的，{`) hides the envelope from the scan above. Then the first thing
  // that opens like a JSON object has to be the envelope itself.
  const first = /\{\s*"/.exec(text);
  const head = first ? ENVELOPE_HEAD.exec(text.slice(first.index, first.index + 200)) : null;
  return first && head ? first.index + head[0].length : -1;
}

/**
 * The narrative of a reply whose JSON could not be parsed, read out of its `{"text":"…` envelope. The value is
 * read leniently: escapes are decoded (an unknown one keeps its character, as the escape sanitizer does), a raw
 * line break stays, a quote that is not followed by the end of the object or the next key is part of the text,
 * and a reply cut off before the closing quote (or inside an escape) gives everything before it. Without such an
 * envelope: null.
 */
export function salvageEnvelopeText(text: string): string | null {
  let i = envelopeValueStart(text);
  if (i < 0) return null;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) break;
      const hex = next === 'u' ? text.slice(i + 2, i + 6) : '';
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (next === 'u' && hex.length < 4 && /^[0-9a-fA-F]*$/.test(hex)) {
        break; // the reply was cut off inside a \uXXXX escape
      } else {
        out += ENVELOPE_ESCAPES[next] ?? next;
        i += 2;
      }
      continue;
    }
    if (c === '"' && closesEnvelopeValue(text, i + 1)) break;
    out += c;
    i++;
  }
  return out.trim() || null;
}

const NARRATIVE_OPEN = '<正文>';
const NARRATIVE_CLOSE = '</正文>';

/**
 * The first closed `<正文>…</正文>` block that does not stand inside a JSON string, with its content and span;
 * null without one. A tag inside a JSON string (`{"text":"<正文>…"}`) is part of that value — its content there is
 * still JSON-escaped — and is left to the JSON. Valid JSON can hold a tag only inside a string, so one found
 * between braces but outside any string (after a stray `{` in prose) still counts. One pass, tracking string state
 * inside objects like `liftSidecars`; outside JSON, quotes do not matter.
 */
function narrativeTagOutsideJson(text: string): { content: string; start: number; end: number } | null {
  const scan = newObjectScan();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (scan.inString) {
      stepObjectScan(scan, c);
      continue;
    }
    if (text.startsWith(NARRATIVE_OPEN, i)) {
      const close = text.indexOf(NARRATIVE_CLOSE, i + NARRATIVE_OPEN.length);
      if (close < 0) return null;
      return { content: text.slice(i + NARRATIVE_OPEN.length, close).trim(), start: i, end: close + NARRATIVE_CLOSE.length };
    }
    stepObjectScan(scan, c);
  }
  return null;
}

/** A JSON string's content decoded leniently: known escapes decoded, any other `\\x` keeps its character. */
function decodeLooseJsonString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, escapeReplacer(ENVELOPE_ESCAPES));
}

/** The replacer for a `\\(uXXXX|x)` match: a `u` escape becomes its character, a known one is looked up in `table`, any other keeps its character. */
function escapeReplacer(table: Readonly<Record<string, string>>): (match: string, e: string) => string {
  return (_, e) => (e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (table[e] ?? e));
}

/** The CoT protocol's blocks written after the story (`<正文>` comes first). */
export const COT_BLOCKS: readonly string[] = ['短期记忆', '变量规划', '剧情规划'];
/** The CoT protocol's pseudo-tags — never part of a story; the stream's display takes out the same ones. */
export const COT_PSEUDO_TAGS: readonly string[] = ['正文', ...COT_BLOCKS, 'judge'];
/** Thinking blocks a reply may carry — never part of a story. */
export { THINKING_TAGS };
/** The JSON escapes a story escaped twice still carries after one decode, and what each reads as. */
export const RESIDUAL_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
const RESIDUAL_ESCAPE = /\\(u[0-9a-fA-F]{4}|[ntr"\\/])/g;

/**
 * Whether a story still carries a second layer of JSON escapes: a model that wraps its whole reply in `<正文>` may
 * escape the story twice (`\\n`, `\\\"` — 2026-10-03 release check, round 3), and one decode then leaves every
 * line break a literal `\n` and every quote a `\"`. So: a literal `\n` and not one real line break, or a `\"` and
 * not one plain quote. A story that merely shows a backslash of its own — a path, a code line, a face like
 * `\(^o^)/` — has real line breaks or plain quotes beside it, or neither sign at all, and is left alone.
 */
export function escapedTwice(text: string): boolean {
  return (/\\n/.test(text) && !text.includes('\n')) || (/\\"/.test(text) && !/(?:^|[^\\])"/.test(text));
}

/**
 * A story with a second layer of JSON escapes (`escapedTwice`) decoded once more — the JSON escapes only; any other
 * backslash is the story's own. Any other text is returned as it is.
 */
export function decodeResidualEscapes(text: string): string {
  if (!escapedTwice(text)) return text;
  return text.replace(RESIDUAL_ESCAPE, escapeReplacer(RESIDUAL_ESCAPES));
}

/** Whether a tag's content is a reply object (its narrative under `text`), maybe in a code fence. */
export const REPLY_HEAD = new RegExp('^(?:```(?:json|JSON)?\\s*)?' + ENVELOPE_KEY_HEAD);

/** A stored narrative that is really a reply's JSON envelope, bare or inside `<正文>` (both the 2026-10-02/03 leaks). */
export const STORED_ENVELOPE = new RegExp(String.raw`^(?:<正文>\s*)?${ENVELOPE_KEY_HEAD}`);

/**
 * The narrative a stored round should have shown, when what was stored is the reply's JSON envelope (a parser
 * before 2026-10-03 kept `{"text":"…` as the story when the reply was unparseable or wrapped in `<正文>`); null
 * when the text is not such an envelope or nothing better can be read from it. Used to heal saved rounds on load.
 */
export function repairStoredNarrative(text: string): string | null {
  const trimmed = text.trim();
  if (!STORED_ENVELOPE.test(trimmed)) return null;
  const repaired = new ResponseParser().parse(trimmed).text.trim();
  return repaired && repaired !== trimmed && !STORED_ENVELOPE.test(repaired) ? repaired : null;
}

/**
 * The story a saved round should show when what was stored is that story with a second layer of escapes still in
 * it (a parser before 2026-10-03 decoded one layer of a reply that escaped its story twice). The round's own raw
 * reply is the evidence: read again, it must give exactly the stored text with that layer decoded. So a story that
 * shows a backslash of its own is never touched, and a healed round reads the same on every later load. Null
 * without a raw reply, or when the stored text is not that.
 */
export function rereadStoredNarrative(stored: string, rawResponse: unknown): string | null {
  if (typeof rawResponse !== 'string' || !rawResponse.trim()) return null;
  const current = stored.trim();
  // Without the second layer's sign the text decodes to itself and nothing can match: no need to read the reply.
  if (!escapedTwice(current)) return null;
  const fresh = new ResponseParser().parse(rawResponse).text.trim();
  return fresh && fresh !== current && decodeResidualEscapes(current).trim() === fresh ? fresh : null;
}

/** Where `parse` found the story and what it left to read as JSON (see `locateNarrative`). */
interface LocatedNarrative {
  tag: { content: string; start: number; end: number } | null;
  tagJson: Record<string, unknown> | null;
  replyInTag: boolean;
  narrativeFromTag: string | null;
  outsideTag: string;
  textForJson: string;
}

/** The lifted sidecar blocks as `parse` spreads them into its result (nothing when none was lifted). */
type ReplySidecars = { sidecars?: Record<string, string> };

export class ResponseParser {
  /**
   * 清理 AI 原始输出 — 销毁式 strip（pre-migration 行为）
   *
   * 移除所有思维链标签。当 CoT toggle OFF 时由 parse() 调用此方法，
   * 保持与 pre-migration 完全一致（PRINCIPLES §3.9.3 baseline）。
   */
  sanitize(raw: string): string {
    return stripThinkingBlocks(raw).trim();
  }

  /**
   * 捕获 + 清理 AI 原始输出（Sprint CoT-1 新增）
   *
   * 先提取所有 thinking 块内容并拼接；然后 strip 标签。
   * 当 CoT toggle ON 时由 parse() 调用此方法。
   *
   * 返回 { sanitized, thinking }：
   * - `sanitized` — 与 `sanitize()` 完全一致的清理文本（标签已 strip）
   * - `thinking` — 拼接的思考内容（多个 thinking 块之间用 `\n\n` 分隔）；
   *   若无 thinking 块则为 undefined
   */
  extractAndSanitize(raw: string): { sanitized: string; thinking: string | undefined } {
    const thinking = extractThinkingBlocks(raw);
    const sanitized = stripThinkingBlocks(raw).trim();
    return { sanitized, thinking };
  }

  /**
   * 解析 AI 响应 → 结构化 AIResponse
   *
   * @param raw AI 原始输出字符串
   * @param options.captureThinking 是否捕获 thinking 块（CoT toggle ON 时为 true）。
   *   false（默认）= 销毁式 strip，与 pre-migration 行为 byte-identical。
   *   true = 捕获 thinking 内容填入 AIResponse.thinking + strip from text。
   */
  parse(raw: string, options?: { captureThinking?: boolean; sidecars?: readonly string[] }): AIResponse {
    const capture = options?.captureThinking === true;

    let sanitized: string;
    let thinking: string | undefined;

    if (capture) {
      const result = this.extractAndSanitize(raw);
      sanitized = result.sanitized;
      thinking = result.thinking;
    } else {
      sanitized = this.sanitize(raw);
    }
    // A feature's own block after the JSON is lifted out first, so it can neither break the JSON nor be lost with it.
    const lifted = options?.sidecars?.length ? liftSidecars(sanitized, options.sidecars) : undefined;
    if (lifted) sanitized = lifted.text;
    const sidecars = lifted && Object.keys(lifted.sidecars).length ? { sidecars: lifted.sidecars } : {};

    const located = this.locateNarrative(sanitized);
    const json = this.parseReplyJson(located);
    if (json) return this.toAIResponse(json, located.narrativeFromTag, thinking, sanitized, sidecars);
    return this.toFailedResponse(located, thinking, sanitized, sidecars);
  }

  /** Where the story stands in a sanitized reply: the `<正文>` tag outside the JSON (if any) and what is left to parse as JSON. */
  private locateNarrative(sanitized: string): LocatedNarrative {
    // Extract <正文> block before JSON parsing — some models put narrative
    // outside the JSON in CoT-style tags instead of inside json.text.
    // The tag is judged by where it stands (2026-10-03, the `{"text":"` leak's root): the CoT protocol asks for the
    // narrative in <正文> while the format asks for a JSON reply, and a model that does both writes either
    // `{"text":"<正文>…</正文>"}` (a tag inside the JSON string: the JSON's own business) or
    // `<正文>{"text":"…"}</正文>` (the whole reply in the tag: its content is the reply to parse, not the story).
    const tag = narrativeTagOutsideJson(sanitized);
    const tagJson = tag && /^(?:```(?:json)?\s*)?\{/i.test(tag.content) ? this.tryParseJson(tag.content) : null;
    // The tag holds the reply when its content is an object carrying the narrative (parsed), or reads like one.
    const replyInTag = tag !== null && (
      (tagJson !== null && (typeof tagJson.text === 'string' || typeof tagJson['叙事文本'] === 'string'))
      || REPLY_HEAD.test(tag.content));
    const narrativeFromTag = tag && !replyInTag ? tag.content || null : null;
    const outsideTag = tag ? (sanitized.slice(0, tag.start) + sanitized.slice(tag.end)).trim() : '';
    const textForJson = !tag ? sanitized : replyInTag ? tag.content : outsideTag;

    return { tag, tagJson, replyInTag, narrativeFromTag, outsideTag, textForJson };
  }

  /** The reply's JSON object, read from the tag, from the text outside it, or from a loose reply around a tag; null if none parses. */
  private parseReplyJson(located: LocatedNarrative): Record<string, unknown> | null {
    const { tag, tagJson, replyInTag, outsideTag, textForJson } = located;
    let json = replyInTag ? tagJson : this.tryParseJson(textForJson);
    if (replyInTag && tag && outsideTag) {
      // Fields the model wrote after the tag, in a JSON block of their own, still count; the tag's own win.
      const extra = this.tryParseJson(outsideTag);
      const story = json ? null : salvageEnvelopeText(tag.content);
      if (extra && (json || story)) json = { ...extra, ...(json ?? {}), ...(story ? { text: story } : {}) };
    }
    if (!json && !tag) {
      // A tag inside the JSON string of a reply too loose to parse (raw line breaks, unescaped quotes in the story):
      // without the tag the rest may parse — keep its fields; the story is the tag's content, decoded.
      const inner = /<正文>([\s\S]*?)<\/正文>/.exec(textForJson);
      const rest = inner ? this.tryParseJson(textForJson.replace(inner[0], '')) : null;
      if (inner && rest) {
        const story = decodeLooseJsonString(inner[1].trim());
        const other = String(rest.text ?? rest['叙事文本'] ?? '');
        json = { ...rest, text: story.length >= other.length ? story : other };
      }
    }
    return json;
  }

  /** The parsed reply as an AIResponse. */
  private toAIResponse(
    json: Record<string, unknown>,
    narrativeFromTag: string | null,
    thinking: string | undefined,
    sanitized: string,
    sidecars: ReplySidecars,
  ): AIResponse {
    const rawText = String(json.text ?? json['叙事文本'] ?? '');
    // When both <正文> tag and json.text exist, pick the longer one.
    // Models with CoT prompts often put real narrative in the tag and a
    // short placeholder like "(见上方正文)" in json.text.
    const resolvedText = narrativeFromTag && narrativeFromTag.length >= rawText.length
      ? narrativeFromTag
      : (rawText || narrativeFromTag || '');
    return {
      text: this.stripNarrativeWrapperTags(decodeResidualEscapes(resolvedText)),
      commands: this.normalizeCommands(
        json.commands ?? json.tavern_commands ?? json['指令'] ?? [],
      ),
      midTermMemory: (json.mid_term_memory ?? json['中期记忆']) as AIResponse['midTermMemory'],
      actionOptions: this.normalizeActionOptions(
        json.action_options ?? json['行动选项'] ?? [],
      ),
      judgement: json.judgement as AIResponse['judgement'],
      semanticMemory: json.semantic_memory as Record<string, unknown> | undefined,
      knowledgeFacts: this.normalizeKnowledgeFacts(json.knowledge_facts),
      settingUpdates: this.normalizeSettingUpdates(json.setting_updates),
      memoryEntry: this.normalizeMemoryEntry(json.memoryEntry ?? json.memory_entry ?? json['记忆条目']),
      customFields: this.collectCustomFields(json),
      thinking,
      raw: sanitized,
      parseOk: true,
      ...sidecars,
    };
  }

  /** The reply when no JSON could be read: the story from the tag or the envelope, else the whole sanitized text; `parseOk: false`. */
  private toFailedResponse(
    located: LocatedNarrative,
    thinking: string | undefined,
    sanitized: string,
    sidecars: ReplySidecars,
  ): AIResponse {
    const { narrativeFromTag, textForJson } = located;
    // JSON parse 全部策略失败 —— 退化到整段文本当作 narrative。
    // A <正文> tag wins; otherwise the narrative is read out of a `{"text":"…` envelope (split-gen step1 has no
    // repair stage behind it, so this is the only thing between the player and the JSON source); otherwise the
    // full sanitized text.
    // `parseOk: false` 通知下游（如 ResponseRepairStage）走补救路径。
    // A story read out of a tag or an envelope may still be escaped once; the whole reply as the text stays exactly
    // the reply (ResponseRepairStage tells "no story could be read" by that sameness).
    const story = narrativeFromTag ?? salvageEnvelopeText(textForJson);
    return {
      text: this.stripNarrativeWrapperTags(story !== null ? decodeResidualEscapes(story) : sanitized),
      thinking,
      raw: sanitized,
      parseOk: false,
      ...sidecars,
    };
  }

  /**
   * CoT 伪标签剥离 — 2026-04-19
   *
   * CoT-ON 主回合的 prompt 同时告诉模型两件互相冲突的事：
   *   1. `core.md` 铁律："直接输出 JSON，字段是 `text`"
   *   2. `cot-preamble` / `cot-masquerade`："把正文包在 `<正文>...</正文>` 里"（`wordCountReq` 2026-10-03 起不再点名标签）
   *
   * 多数模型选 (1) 走 JSON 格式，但因为 (2) 在多个系统提示词里反复强调
   * `<正文>` tag，模型顺手把开头的 `<正文>` 字面量塞进 `json.text` 字符串里
   * （往往有头无尾——生成器到引号前就闭合了）。结果 UI 每回合正文开头多一个
   * `<正文>` 碎片。
   *
   * 根本治理是让 CoT 提示词统一到 JSON 语义，但 pack 层的 prompt 文件是用户
   * 可改的——我们不能假设未来所有 pack 都会跟上。这里做引擎侧防御：把所有
   * CoT 协议伪标签（`<正文>` / `<短期记忆>` / `<变量规划>` / `<剧情规划>` /
   * `<judge>`）从 narrative text 里剥掉，只拿内容。不动 thinking 标签（那是
   * 独立处理的），也不动 `【…】` / `〖…〗` / `"…"` 这些真正用于排版的符号。
   */
  private stripNarrativeWrapperTags(text: string): string {
    if (!text) return text;
    // Match both opening `<tag>` and closing `</tag>` — keep inner content.
    // Tag names match the CoT protocol pseudo-tags that should never appear
    // in rendered narrative.
    const CoT_TAG_RE = new RegExp(`<\\s*\\/?\\s*(${COT_PSEUDO_TAGS.join('|')})\\s*>`, 'gi');
    return text.replace(CoT_TAG_RE, '').trim();
  }

  /**
   * 多策略 JSON 提取
   *
   * 每个策略先 raw 尝试一次，失败再用 `sanitizeJsonEscapes` 清掉非法
   * `\X` 转义再试（2026-04-19 修复 LLM \你 stutter bug）。
   *
   * 策略优先级：
   * 1. 直接 JSON.parse（AI 返回纯 JSON）
   * 2. 提取 ```json ... ``` 代码块（常见的 markdown 包裹）
   * 3. 查找第一个 { 到最后一个 }（AI 在 JSON 前后加了叙述文本）
   */
  private tryParseJson(text: string): Record<string, unknown> | null {
    // 策略 1: 直接解析
    const direct = tryParseWithSanitizer(text);
    if (direct) return direct;

    // 策略 2: 提取 ```json ... ``` 代码块 (also handles unclosed fence from truncated output)
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      ?? text.match(/```(?:json)?\s*\n?([\s\S]+)/);
    if (codeBlockMatch?.[1]) {
      const fromBlock = tryParseWithSanitizer(codeBlockMatch[1]);
      if (fromBlock) return fromBlock;
    }

    // 策略 3: 查找花括号范围
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const fromBraces = tryParseWithSanitizer(text.slice(firstBrace, lastBrace + 1));
      if (fromBraces) return fromBraces;
    }

    return null;
  }

  /** 合法的 command action 值 */
  private static readonly VALID_ACTIONS = new Set(['set', 'add', 'delete', 'push', 'pull']);

  /**
   * 规范化 commands 数组
   * 严格校验 action 必须是合法值。
   *
   * 兼容两种路径字段名：
   * - "path"（提示词模板使用）→ 规范化为 "key"（Command 接口字段）
   * - "key"（旧格式/直接写入）→ 原样保留
   */
  private normalizeCommands(raw: unknown): Command[] {
    if (!Array.isArray(raw)) return [];
    const result: Command[] = [];
    for (const c of raw) {
      if (c === null || typeof c !== 'object') continue;
      const obj = c as Record<string, unknown>;
      // Accept both "action" (prompt convention) and "type" (some models use this)
      const action = (typeof obj.action === 'string' ? obj.action : typeof obj.type === 'string' ? obj.type : '') as string;
      if (!action || !ResponseParser.VALID_ACTIONS.has(action)) continue;
      // Accept both "path" (prompt convention) and "key" (Command interface)
      const pathOrKey = obj.key ?? obj.path;
      if (typeof pathOrKey !== 'string') continue;
      result.push({ action: action as Command['action'], key: pathOrKey, value: obj.value });
    }
    return result;
  }

  /**
   * §7.2 CR-R2: 规范化 memoryEntry 字段
   *
   * - 非字符串或空字符串 → `undefined`（让 AIResponse.memoryEntry 不出现）
   * - 合法字符串 → trim 后返回
   * - 80 字软上限 — 超出时截断（AI 有时不守字数规则）
   */
  private normalizeMemoryEntry(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    // 软限制：超过 80 字截断并加省略号（给 AI 一点弹性空间超 50 字）
    if (trimmed.length > 80) {
      return `${trimmed.slice(0, 79)}…`;
    }
    return trimmed;
  }

  /** 规范化行动选项列表 — 过滤空值并 trim */
  private normalizeActionOptions(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .map((o) => o.trim());
  }


  private normalizeKnowledgeFacts(
    raw: unknown,
  ): Array<{ fact: string; sourceEntity: string; targetEntity: string }> | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;

    const result: Array<{ fact: string; sourceEntity: string; targetEntity: string }> = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const fact = typeof obj.fact === 'string' ? obj.fact.trim() : '';
      const src = typeof obj.source_entity === 'string' ? obj.source_entity.trim() : '';
      const tgt = typeof obj.target_entity === 'string' ? obj.target_entity.trim() : '';
      if (fact.length >= 10 && src && tgt && src !== tgt) {
        result.push({ fact, sourceEntity: src, targetEntity: tgt });
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private static readonly KNOWN_KEYS = KNOWN_RESPONSE_KEYS;

  /**
   * Canon Capture: shape-normalize `setting_updates` WITHOUT judging its contents.
   *
   * Contract: keep every plain object the model produced (up to a memory bound) and
   * hand them to `SettingCaptureStage`, which owns validation AND the per-candidate
   * rejection reason shown to the player. Dropping malformed items here would turn a
   * reportable rejection into an invisible one.
   *
   * Returns `undefined` when the key is absent or is not an array, so downstream can
   * tell "model never answered" from "model answered with nothing".
   */
  private normalizeSettingUpdates(raw: unknown): RawSettingUpdate[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: RawSettingUpdate[] = [];
    for (const item of raw) {
      if (out.length >= MAX_RAW_SETTING_UPDATES) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      out.push({
        kind: o['kind'],
        statement: o['statement'],
        evidence: o['evidence'],
        anchors: o['anchors'],
        entities: o['entities'],
      });
    }
    return out;
  }

  /**
   * Sprint Plot-1: 收集 JSON 中未被显式提取的顶级 key。
   * 返回 undefined 如果没有额外字段（避免无意义的空对象）。
   */
  private collectCustomFields(json: Record<string, unknown>): Record<string, unknown> | undefined {
    let result: Record<string, unknown> | undefined;
    for (const key of Object.keys(json)) {
      if (ResponseParser.KNOWN_KEYS.has(key)) continue;
      if (!result) result = {};
      result[key] = json[key];
    }
    return result;
  }
}
