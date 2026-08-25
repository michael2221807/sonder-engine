/**
 * AI 响应解析器 — 从 AI 原始输出中提取结构化数据
 *
 * 解析流程：
 * 1. sanitize: 清理 <think>/<reasoning> 等思维链标签
 * 2. tryParseJson: 多策略提取 JSON（直接解析 / 代码块 / 花括号范围）
 * 3. 从 JSON 中提取 text, commands, midTermMemory, actionOptions 等
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
import { sanitizeJsonEscapes, healUnescapedQuotes } from './json-escape-sanitize';

/**
 * 尝试用原生 JSON.parse；失败就把字符串过一遍 escape sanitizer 再试；
 * 仍失败则做未转义引号愈合后最后一搏（round-62 事故：evidence 逐字引用
 * 玩家原文中的英文直引号炸掉整个 step2 JSON —— 见 healUnescapedQuotes）。
 * 返回解析出的对象或 null。
 */
function tryParseWithSanitizer(src: string): Record<string, unknown> | null {
  try {
    return JSON.parse(src) as Record<string, unknown>;
  } catch {
    // 继续走 sanitizer
  }
  const sanitized = sanitizeJsonEscapes(src);
  try {
    return JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    // 继续走 quote healer
  }
  try {
    return JSON.parse(healUnescapedQuotes(sanitized)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class ResponseParser {
  /**
   * 思维链标签的匹配模式（英文标签名 —— PRINCIPLES §3.17）
   *
   * 匹配 `<think>`, `<thinking>`, `<reasoning>`, `<thought>` 及对应关闭标签。
   * 大小写不敏感 (`/gi`)。非贪婪 `[\s\S]*?`。
   */
  private static readonly THINKING_TAG_PATTERN =
    '<(?:think|thinking|reasoning|thought)>([\\s\\S]*?)<\\/(?:think|thinking|reasoning|thought)>';

  /**
   * 清理 AI 原始输出 — 销毁式 strip（pre-migration 行为）
   *
   * 移除所有思维链标签。当 CoT toggle OFF 时由 parse() 调用此方法，
   * 保持与 pre-migration 完全一致（PRINCIPLES §3.9.3 baseline）。
   */
  sanitize(raw: string): string {
    return raw.replace(new RegExp(ResponseParser.THINKING_TAG_PATTERN, 'gi'), '').trim();
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
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(ResponseParser.THINKING_TAG_PATTERN, 'gi');
    while ((match = re.exec(raw)) !== null) {
      const content = match[1]?.trim();
      if (content) blocks.push(content);
    }
    const sanitized = raw.replace(new RegExp(ResponseParser.THINKING_TAG_PATTERN, 'gi'), '').trim();
    return {
      sanitized,
      thinking: blocks.length > 0 ? blocks.join('\n\n') : undefined,
    };
  }

  /**
   * 解析 AI 响应 → 结构化 AIResponse
   *
   * @param raw AI 原始输出字符串
   * @param options.captureThinking 是否捕获 thinking 块（CoT toggle ON 时为 true）。
   *   false（默认）= 销毁式 strip，与 pre-migration 行为 byte-identical。
   *   true = 捕获 thinking 内容填入 AIResponse.thinking + strip from text。
   */
  parse(raw: string, options?: { captureThinking?: boolean }): AIResponse {
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

    // Extract <正文> block before JSON parsing — some models put narrative
    // outside the JSON in CoT-style tags instead of inside json.text.
    const narrativeFromTag = this.extractNarrativeTag(sanitized);
    const textForJson = narrativeFromTag
      ? sanitized.replace(/<正文>[\s\S]*?<\/正文>/gi, '').trim()
      : sanitized;

    const json = this.tryParseJson(textForJson);

    if (json) {
      const rawText = String(json.text ?? json['叙事文本'] ?? '');
      // When both <正文> tag and json.text exist, pick the longer one.
      // Models with CoT prompts often put real narrative in the tag and a
      // short placeholder like "(见上方正文)" in json.text.
      const resolvedText = narrativeFromTag && narrativeFromTag.length >= rawText.length
        ? narrativeFromTag
        : (rawText || narrativeFromTag || '');
      return {
        text: this.stripNarrativeWrapperTags(resolvedText),
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
      };
    }

    // JSON parse 全部策略失败 —— 退化到整段文本当作 narrative。
    // If a <正文> tag was found, use its content as text; otherwise use the full sanitized text.
    // `parseOk: false` 通知下游（如 ResponseRepairStage）走补救路径。
    return {
      text: this.stripNarrativeWrapperTags(narrativeFromTag ?? sanitized),
      thinking,
      raw: sanitized,
      parseOk: false,
    };
  }

  /**
   * CoT 伪标签剥离 — 2026-04-19
   *
   * CoT-ON 主回合的 prompt 同时告诉模型两件互相冲突的事：
   *   1. `core.md` 铁律："直接输出 JSON，字段是 `text`"
   *   2. `cot-preamble` / `cot-masquerade` / `wordCountReq`："把正文包在 `<正文>...</正文>` 里"
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
  /**
   * Extract content from `<正文>...</正文>` tags.
   *
   * Some models (especially with CoT prompts) place the narrative text in
   * a `<正文>` tag outside the JSON rather than inside `json.text`. This
   * method captures that content so parse() can use it as fallback when
   * the JSON has no `text` field.
   */
  private extractNarrativeTag(text: string): string | null {
    const match = text.match(/<正文>([\s\S]*?)<\/正文>/i);
    return match?.[1]?.trim() || null;
  }

  private stripNarrativeWrapperTags(text: string): string {
    if (!text) return text;
    // Match both opening `<tag>` and closing `</tag>` — keep inner content.
    // Tag names match the CoT protocol pseudo-tags that should never appear
    // in rendered narrative.
    const CoT_TAG_RE = /<\s*\/?\s*(正文|短期记忆|变量规划|剧情规划|judge)\s*>/gi;
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
   * - 50 字软上限 — 超出时截断（AI 有时不守字数规则）
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

  private static readonly KNOWN_KEYS = new Set([
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
