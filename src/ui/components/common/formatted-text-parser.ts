/**
 * formatted-text-parser — 叙事正文的块级 + 行内解析器（纯函数，无 Vue / i18n 依赖）
 *
 * 从 FormattedText.vue 抽出，升级为两层解析，供富格式叙事渲染使用，并可单测。
 *
 * ── 两层结构 ──────────────────────────────────────────────────
 *
 * 块级（block）：按行拆分为 段落 / 标题 / 有序·无序列表 / 引用 / 分割线。
 *   - 引用与嵌套列表以「原始子文本」形式返回（`text` / `childText`），交由
 *     FormattedText 递归自调用渲染，天然支持任意嵌套且不必在此层递归。
 *
 * 行内（inline）：对每个块的文本内容按以下优先级解析——
 *   1. 〖类型:结果,...〗 判定块（最高优先级原子单位，即使包在对话引号内也先抽出）；
 *      首句没有冒号的 〖…〗 不是判定，去掉括号按正文解析（isSystemBracket）
 *   2. AGA 语义记号：【环境】 / `内心`（反引号） / "对话" / “对话”
 *   3. markdown 强调与链接：**粗** / __粗__ / *斜* / _斜_ / [text](url)
 *   NPC 名高亮不在此处理——它依赖运行时 props，由组件层在解析结果上二次注入。
 *
 * ── 关键取舍 ──────────────────────────────────────────────────
 * - 反引号 `` ` `` 保留 AGA「内心独白」语义，**不**当作 markdown 行内代码。
 * - 强调用 bold/italic 标志位附加在叶子 part 上（而非嵌套 part 树），使其能与
 *   对话 / 环境 / 内心等 AGA 语义颜色叠加（如 `"我**一定**回来"`）。
 * - 未闭合 / 不匹配的记号一律按普通文本保留，不吞后文。
 * - GFM 管道表格（`| … |` + `|---|` 分隔行）支持（2026-07-16 增补）。
 * - 三反引号代码块、脚注等超出「常用排版全套」范围，本模块不解析。
 */
import { isSystemBracket } from '@/engine/core/narrative-brackets';

// App doc: docs/user-guide/pages/game-main.md §3.4

// ─── Types ────────────────────────────────────────────────────

export interface JudgementData {
  type: string;
  /** A verdict's outcome; for a notice, its whole text after the key. */
  result: string;
  finalValue?: string;
  difficulty?: string;
  base?: string;
  lucky?: string;
  environment?: string;
  status?: string;
  details: string[];
  /**
   * A notice the verdict parse would cut short (`系统提示：车门关上，……`): `result` holds its whole sentence, shown as
   * text rather than an outcome. A notice the parse keeps whole (`系统提示：好感度变化`) is not flagged and looks as before.
   */
  notice?: boolean;
}

/** 行内叶子片段种类 */
export type InlineKind =
  | 'normal'
  | 'environment'
  | 'psychology'
  | 'dialogue'
  | 'judgement'
  | 'link'
  | 'npc-name';

/** 行内叶子片段。emphasis 用 bold/italic 标志位叠加。 */
export interface InlinePart {
  kind: InlineKind;
  text?: string;
  judgement?: JudgementData;
  href?: string;
  bold?: boolean;
  italic?: boolean;
}

/** 列表项：本项行内内容 + 可选的嵌套原始子文本（递归渲染） */
export interface ListItem {
  parts: InlinePart[];
  /** 缩进的嵌套内容（子列表 / 续行），交由上层递归渲染；无则 undefined */
  childText?: string;
}

/** 单元格对齐（来自表格分隔行 `:---` / `:--:` / `---:`）；null = 默认左对齐 */
export type TableAlign = 'left' | 'center' | 'right' | null;

/** 块级节点 */
export type Block =
  | { type: 'paragraph'; lines: InlinePart[][] }
  | { type: 'heading'; level: number; parts: InlinePart[] }
  | { type: 'hr' }
  | { type: 'blockquote'; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; headers: InlinePart[][]; align: TableAlign[]; rows: InlinePart[][][] };

// ─── Judgement parsing ────────────────────────────────────────

/** Fields only a dice verdict carries (环境/状态/结果 are everyday words a notice may use as well). */
const VERDICT_KEYS = new Set(['判定值', '难度', '基础', '幸运']);
/** The pack's key for a notice line (zh / en core: `〖系统提示：…〗` / `〖System Notice: …〗`). */
const NOTICE_KEY = /^(系统提示|system notice)$/i;
/** A verdict's outcome reads as one of these (成功 also covers 大成功 / 自动成功, 失败 also 大失败). */
const OUTCOME_WORD = /成功|失败|完美/;

/**
 * Parse 〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗。
 * 纯解析——缺省类型返回空串，展示层自行兜底文案（避免 i18n 依赖）。
 */
export function parseJudgement(raw: string): JudgementData {
  const normalized = raw.replace(/：/g, ':').replace(/，/g, ',');
  const parts = normalized.split(',').map((p) => p.trim());
  const [typeStr, resultStr] = (parts[0] ?? '').split(':').map((s) => s.trim());
  const data: JudgementData = {
    type: typeStr ?? '',
    result: resultStr ?? '',
    details: [],
  };
  let verdictFields = 0;
  // Text the parse leaves out: the first clause past its second colon, and every later clause it skips.
  let dropped = (parts[0] ?? '').split(':').slice(2).join(':').trim() !== '';
  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(':');
    if (colonIdx === -1) { if (parts[i]) dropped = true; continue; }
    const key = parts[i].slice(0, colonIdx).trim();
    const val = parts[i].slice(colonIdx + 1).trim();
    if (!key || !val) { if (key || val) dropped = true; continue; }
    if (VERDICT_KEYS.has(key)) verdictFields++;
    if (key === '判定值') data.finalValue = val;
    else if (key === '难度') data.difficulty = val;
    else if (key === '基础') data.base = val;
    else if (key === '幸运') data.lucky = val;
    else if (key === '环境') data.environment = val;
    else if (key === '状态') data.status = val;
    else if (key === '结果') {
      // AI sometimes generates 〖社交:判定,结果:成功,...〗 instead of 〖社交:成功,...〗
      if (!data.result || data.result === '判定') data.result = val;
      else if (val !== data.result) dropped = true;
    }
    else data.details.push(`${key}:${val}`);
  }
  // A notice the parse above cuts short says everything after its key instead (PO 2026-10-02: cut at the first
  // comma like a verdict, `系统提示：车门关上，……` showed only "车门关上"). A notice is a line under the notice key,
  // or a line with no verdict field whose first clause is no outcome (a time skip, a status note). A verdict keeps
  // its look even when the parse drops its tail (`行动:自动成功——日常事务，无需判定`, `战斗:大成功,伤害:12,暴击`), as
  // does any line the parse keeps whole; a line holding another 〖 is malformed and stays as parsed.
  const keyEnd = raw.search(/[:：]/);
  const notice = NOTICE_KEY.test(data.type) || (verdictFields === 0 && !OUTCOME_WORD.test(data.result));
  if (dropped && notice && keyEnd >= 0 && !raw.includes('〖')) {
    return { type: data.type, result: raw.slice(keyEnd + 1).trim(), details: [], notice: true };
  }
  return data;
}

/** A `〖…〗` range: a system line (verdict or notice) carries its parsed judgement; any other keeps its text. */
interface JudgementSlice {
  start: number;
  end: number;
  judgement?: JudgementData;
  prose?: string;
}

/**
 * 扫描所有 `〖...〗` 区间（非嵌套原子块）。未闭合的 `〖` 被忽略，留给后续解析。
 * 判定／系统提示（首句有冒号，`isSystemBracket`）成为判定块；其余是叙事自己的强调，按正文显示、不截断
 * （PO G2，与朗读的 stripJudgementForSpeech 同一规则）。
 */
function findJudgementSlices(text: string): JudgementSlice[] {
  const slices: JudgementSlice[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const openPos = text.indexOf('〖', cursor);
    if (openPos === -1) break;
    const closePos = text.indexOf('〗', openPos + 1);
    if (closePos === -1) break;
    const inner = text.slice(openPos + 1, closePos);
    slices.push(isSystemBracket(inner)
      ? { start: openPos, end: closePos + 1, judgement: parseJudgement(inner) }
      : { start: openPos, end: closePos + 1, prose: inner });
    cursor = closePos + 1;
  }
  return slices;
}

// ─── Inline: markdown emphasis / link enrichment ──────────────

// 链接：[text](url)。url 不含空白与右括号。text 不跨行。
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;
// 粗+斜：***...*** 或 ___...___，内部首尾非空白。
const BOLD_ITALIC_RE = /(\*\*\*|___)(?=\S)([\s\S]+?)(?<=\S)\1/;
// 加粗：**...** 或 __...__，内部首尾非空白。
const STRONG_RE = /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/;
// 斜体：*...* 或 _..._，内部首尾不是空白/相同强调符（避免吞掉 ** 的一半）。
const EM_RE = /(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_]|[^\s*_])\1/;

/**
 * 安全化链接 href：仅放行 http/https/mailto 与站内相对路径，其余（含
 * javascript: / data: 等）降级为 '#'，防止 XSS。
 *
 * 先剥离 ASCII 控制字符（含 TAB / CR / LF）——浏览器解析 URL 时会忽略串内任意
 * 位置的这些字符，若不剥离，`java\tscript:` 会绕过 scheme 检测直达 href。
 */
export function sanitizeUrl(raw: string): string {
  const url = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (url === '') return '#';
  // 站内绝对路径（单 /，非协议相对 //）/ 锚点 / 查询：安全
  if (/^\/(?!\/)/.test(url) || /^[#?]/.test(url)) return url;
  // 带 scheme 的（含被伪装的 //协议相对）：仅放行白名单
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
    return '#';
  }
  // 协议相对 //host → 视为跨源，不放行
  if (url.startsWith('//')) return '#';
  // 无 scheme 的裸域名 / 文件名：按相对处理，安全
  return url;
}

/**
 * markdown 记号预算：一段文本中 `*` `_` `[` 的数量上限。超过则跳过 markdown
 * 富化（仅按普通文本渲染），防止 emphasis / link 正则在含大量未闭合记号的
 * 病态输入（如 AI 写的 `3 * 5`、错列表）上退化到 O(n²) 拖垮流式主线程。
 * 真实叙事正文一段内的强调记号远不及此，几乎不会触发降级。
 */
const MARKDOWN_DELIM_BUDGET = 200;

function withinMarkdownBudget(text: string): boolean {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // '*' = 42, '[' = 91, '_' = 95
    if (c === 42 || c === 91 || c === 95) {
      if (++n > MARKDOWN_DELIM_BUDGET) return false;
    }
  }
  return true;
}

interface EmphasisCandidate {
  idx: number;
  type: 'link' | 'bolditalic' | 'strong' | 'em';
  match: RegExpExecArray;
}

/**
 * 对一段（已确定 baseKind 的）文本做 markdown 强调 / 链接富化，递归下降。
 * bold / italic 为继承的强调状态。不匹配的强调符按普通文本保留。
 */
function enrichInline(
  text: string,
  baseKind: InlineKind,
  bold: boolean,
  italic: boolean,
): InlinePart[] {
  if (text === '') return [];

  // 病态输入护栏：记号过多时跳过 markdown 富化，直接按普通文本渲染，
  // 避免 emphasis/link 正则退化到 O(n²) 拖垮流式主线程。
  if (!withinMarkdownBudget(text)) {
    return [makeLeaf(baseKind, text, bold, italic)];
  }

  const candidates: EmphasisCandidate[] = [];
  const link = LINK_RE.exec(text);
  if (link) candidates.push({ idx: link.index, type: 'link', match: link });
  const boldItalic = BOLD_ITALIC_RE.exec(text);
  if (boldItalic) candidates.push({ idx: boldItalic.index, type: 'bolditalic', match: boldItalic });
  const strong = STRONG_RE.exec(text);
  if (strong) candidates.push({ idx: strong.index, type: 'strong', match: strong });
  const em = EM_RE.exec(text);
  if (em) candidates.push({ idx: em.index, type: 'em', match: em });

  if (candidates.length === 0) {
    return [makeLeaf(baseKind, text, bold, italic)];
  }

  // 最靠前者优先；同位置时 link > ***粗斜*** > **粗** > *斜*
  const order = { link: 0, bolditalic: 1, strong: 2, em: 3 };
  candidates.sort((a, b) => a.idx - b.idx || order[a.type] - order[b.type]);
  const c = candidates[0];
  const m = c.match;
  const before = text.slice(0, c.idx);
  const after = text.slice(c.idx + m[0].length);

  const parts: InlinePart[] = [];
  if (before) parts.push(...enrichInline(before, baseKind, bold, italic));

  if (c.type === 'link') {
    const leaf: InlinePart = { kind: 'link', text: m[1], href: sanitizeUrl(m[2]) };
    if (bold) leaf.bold = true;
    if (italic) leaf.italic = true;
    parts.push(leaf);
  } else if (c.type === 'bolditalic') {
    parts.push(...enrichInline(m[2], baseKind, true, true));
  } else if (c.type === 'strong') {
    parts.push(...enrichInline(m[2], baseKind, true, italic));
  } else {
    parts.push(...enrichInline(m[2], baseKind, bold, true));
  }

  if (after) parts.push(...enrichInline(after, baseKind, bold, italic));
  return parts;
}

function makeLeaf(kind: InlineKind, text: string, bold: boolean, italic: boolean): InlinePart {
  const leaf: InlinePart = { kind, text };
  if (bold) leaf.bold = true;
  if (italic) leaf.italic = true;
  return leaf;
}

// ─── Inline: AGA markers (environment / psychology / dialogue) ─

interface AgaSpan {
  kind: InlineKind;
  text: string;
}

/**
 * 对不含 `〖...〗` 的一段文本按 AGA 记号优先策略拆分：
 * 【环境】 / `内心`（反引号） / "对话" / “对话” / 普通文本。
 * （移植自原 parseNonJudgementSegment，仅返回 {kind,text}，强调交给 enrichInline。）
 */
function parseAgaMarkers(text: string): AgaSpan[] {
  const spans: AgaSpan[] = [];
  let idx = 0;

  while (idx < text.length) {
    const markers: Array<{ pos: number; close: string; kind: InlineKind }> = ([
      { pos: text.indexOf('【', idx), close: '】', kind: 'environment' as const },
      { pos: text.indexOf('`', idx), close: '`', kind: 'psychology' as const },
      { pos: text.indexOf('"', idx), close: '"', kind: 'dialogue' as const },
      { pos: text.indexOf('“', idx), close: '”', kind: 'dialogue' as const },
    ] as const).filter((mk) => mk.pos !== -1);

    if (markers.length === 0) {
      const remaining = text.slice(idx);
      if (remaining) spans.push({ kind: 'normal', text: remaining });
      break;
    }

    markers.sort((a, b) => a.pos - b.pos);
    const { pos: openPos, close, kind } = markers[0];

    if (openPos > idx) {
      spans.push({ kind: 'normal', text: text.slice(idx, openPos) });
    }

    const closePos = text.indexOf(close, openPos + 1);
    if (closePos === -1) {
      spans.push({ kind: 'normal', text: text.slice(openPos) });
      break;
    }

    const inner = text.slice(openPos + 1, closePos);
    const displayText = kind === 'environment'
      ? `【${inner}】`
      : kind === 'psychology'
        ? `\`${inner}\``
        : (text[openPos] === '"' ? `"${inner}"` : `“${inner}”`);
    spans.push({ kind, text: displayText });

    idx = closePos + close.length;
  }

  return spans;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 可注入 NPC 名高亮的片段种类。对话 " " / 内心 ` ` 刻意排除：名字在
 *  引语内属于"被说出的话"，保持语义整色不打断（2026-08-03 决策，随
 *  environment 高亮修复一并编码进测试）。 */
const NPC_HIGHLIGHTABLE_KINDS: ReadonlySet<InlineKind> = new Set(['normal', 'environment']);

/**
 * 在已解析的行内片段上注入 NPC 名高亮。切分 `normal` 与 `environment`（【】
 * 旁白）片段，保留其 bold/italic 标志位；environment 内命中的名字额外继承
 * italic，使其贴合环境文本的斜体节奏。依赖运行时 names，故独立于
 * parseInline 由展示层调用。
 */
export function highlightNpcNames(parts: InlinePart[], names: string[]): InlinePart[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return parts;
  const pattern = new RegExp(`(${sorted.map(escapeRegExp).join('|')})`, 'g');

  const result: InlinePart[] = [];
  for (const part of parts) {
    if (!NPC_HIGHLIGHTABLE_KINDS.has(part.kind) || !part.text) {
      result.push(part);
      continue;
    }
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(part.text)) !== null) {
      if (match.index > lastIdx) {
        result.push({ ...part, text: part.text.slice(lastIdx, match.index) });
      }
      const npc: InlinePart = { kind: 'npc-name', text: match[0] };
      if (part.bold) npc.bold = true;
      if (part.italic || part.kind === 'environment') npc.italic = true;
      result.push(npc);
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx === 0) {
      result.push(part);
    } else if (lastIdx < part.text.length) {
      result.push({ ...part, text: part.text.slice(lastIdx) });
    }
  }
  return result;
}

/**
 * 行内解析入口：先抽出 〖判定〗 原子块，其余文本走 AGA 记号 + markdown 富化。
 */
export function parseInline(text: string): InlinePart[] {
  if (!text) return [];
  const slices = findJudgementSlices(text);

  const runSegment = (seg: string): InlinePart[] => {
    const spans = parseAgaMarkers(seg);
    const out: InlinePart[] = [];
    for (const span of spans) {
      out.push(...enrichInline(span.text, span.kind, false, false));
    }
    return out;
  };

  if (slices.length === 0) return runSegment(text);

  const parts: InlinePart[] = [];
  let cursor = 0;
  for (const s of slices) {
    if (s.start > cursor) parts.push(...runSegment(text.slice(cursor, s.start)));
    if (s.judgement) parts.push({ kind: 'judgement', judgement: s.judgement });
    else if (s.prose) parts.push(...runSegment(s.prose));
    cursor = s.end;
  }
  if (cursor < text.length) parts.push(...runSegment(text.slice(cursor)));
  return parts;
}

// ─── Block parsing ────────────────────────────────────────────

// 分割线：三个及以上的 - * _（可夹空白），独占一行。
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
// ATX 标题：1~6 个 #，后跟空白，尾部可选 # 收尾。
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
// 引用：> 前缀，可选一个空格。
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
// 列表项：缩进 + 标记（- * + 或 数字. / 数字)）+ 空白 + 内容。
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

// ─── Table parsing (GFM pipe tables) ──────────────────────────

// Runaway backstops (far above any real narrative table) so pathological AI
// output — a line with thousands of `|`, or an enormous body — can't spawn an
// unbounded DOM / parseInline fan-out. Mirrors MARKDOWN_DELIM_BUDGET's intent.
const MAX_TABLE_COLS = 64;
const MAX_TABLE_ROWS = 500;

/** 表格分隔行：`|:---|:--:|---:|`（每格为 `:?-+:?`，至少一根 `-`）。 */
function isTableDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const inner = t.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/** 按未转义的 `|` 切分表格行，去掉首尾竖线，还原 `\|` 转义。 */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** 从分隔行单元格推断对齐。 */
function parseTableAlign(cell: string): TableAlign {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** 把一行 cells 规整到 colCount 列（不足补空、超出截断），逐格行内解析。 */
function toRowCells(raw: string[], colCount: number): InlinePart[][] {
  const cells: InlinePart[][] = [];
  for (let c = 0; c < colCount; c++) {
    cells.push(parseInline(raw[c] ?? ''));
  }
  return cells;
}

interface ParsedTable {
  block: Extract<Block, { type: 'table' }>;
  next: number;
}

/**
 * 从 lines[start]（表头行）解析一个 GFM 管道表格。调用前须确认 lines[start]
 * 含 `|` 且 lines[start+1] 是分隔行。
 */
function parseTable(lines: string[], start: number): ParsedTable {
  const headerCells = splitTableRow(lines[start]);
  const colCount = headerCells.length;
  const alignCells = splitTableRow(lines[start + 1]);
  const align: TableAlign[] = [];
  for (let c = 0; c < colCount; c++) align.push(parseTableAlign(alignCells[c] ?? ''));

  const headers = toRowCells(headerCells, colCount);
  const rows: InlinePart[][][] = [];
  let i = start + 2;
  while (
    i < lines.length &&
    lines[i].trim() !== '' &&
    lines[i].includes('|') &&
    !isTableDelimiterRow(lines[i])
  ) {
    // Consume every body row (advance i) but cap what we materialize, so an
    // absurdly tall table can't spawn an unbounded DOM.
    if (rows.length < MAX_TABLE_ROWS) rows.push(toRowCells(splitTableRow(lines[i]), colCount));
    i += 1;
  }
  return { block: { type: 'table', headers, align, rows }, next: i };
}

/** 缩进宽度（Tab 记为 2）。 */
function indentWidth(s: string): number {
  const lead = /^[ \t]*/.exec(s)?.[0] ?? '';
  return lead.replace(/\t/g, '  ').length;
}

/** 从行首去掉 n 列缩进（含 Tab 展开）。 */
function dedent(line: string, n: number): string {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < n) {
    const ch = line[i];
    if (ch === ' ') { removed += 1; i += 1; }
    else if (ch === '\t') { removed += 2; i += 1; }
    else break;
  }
  return line.slice(i);
}

interface ParsedList {
  block: Extract<Block, { type: 'list' }>;
  next: number;
}

/**
 * 从 lines[start] 起解析一个列表。缩进 ≥ baseIndent+2 的行归入当前项的
 * childText（嵌套子列表 / 续行），交由上层递归渲染；空行或更浅缩进结束列表。
 */
function parseList(lines: string[], start: number): ParsedList {
  const first = LIST_RE.exec(lines[start]);
  // first 一定匹配（调用前已判定），此断言仅为类型收窄。
  const baseIndent = first ? indentWidth(first[1]) : 0;
  const ordered = first ? /\d/.test(first[2]) : false;

  const items: ListItem[] = [];
  let current: ListItem | null = null;
  let childLines: string[] = [];
  let i = start;

  const flushChild = (): void => {
    if (current && childLines.length) {
      current.childText = childLines.join('\n').replace(/\s+$/, '');
    }
    childLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') break;

    const indent = indentWidth(line);
    const m = LIST_RE.exec(line);

    if (m && indent <= baseIndent + 1) {
      // 同级列表项
      flushChild();
      current = { parts: parseInline(m[3]) };
      items.push(current);
      i += 1;
      continue;
    }

    if (indent >= baseIndent + 2 && current) {
      // 嵌套内容（子列表 / 缩进续行）→ 归入当前项 childText，去掉基础缩进
      childLines.push(dedent(line, baseIndent + 2));
      i += 1;
      continue;
    }

    if (m && indent < baseIndent) break; // 更浅的列表 → 交回上层
    break; // 其它非列表行 → 结束列表
  }

  flushChild();
  return { block: { type: 'list', ordered, items }, next: i };
}

/** 归一化换行：字面 "\n"、CRLF、CR 一律转为 \n。 */
function normalizeNewlines(raw: string): string {
  return (raw ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * 顶层解析：原始正文 → 块级节点数组。段落内单换行保留为软换行（每行一条
 * InlinePart[]，展示层以 <br> 呈现），与既有 pre-wrap 观感一致。
 */
export function parseNarrative(raw: string): Block[] {
  const text = normalizeNewlines(raw);
  if (!text.trim()) {
    // 全空白 → 单段落，保留原文（可能是有意的空白占位）
    return [{ type: 'paragraph', lines: [[{ kind: 'normal', text }]] }];
  }

  const lines = text.split('\n');
  const blocks: Block[] = [];
  let para: InlinePart[][] | null = null;

  const flushPara = (): void => {
    if (para && para.length) blocks.push({ type: 'paragraph', lines: para });
    para = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { flushPara(); i += 1; continue; }

    if (HR_RE.test(line)) { flushPara(); blocks.push({ type: 'hr' }); i += 1; continue; }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, parts: parseInline(h[2]) });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(BLOCKQUOTE_RE, '$1'));
        i += 1;
      }
      blocks.push({ type: 'blockquote', text: inner.join('\n') });
      continue;
    }

    if (LIST_RE.test(line)) {
      flushPara();
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // Table (checked AFTER lists so a `- a | b` list item is never mistaken for
    // a header): a `|`-bearing header row immediately followed by a delimiter
    // row whose cell count MATCHES the header (GFM strictness → far fewer false
    // positives on ad-hoc `---|---` prose dividers), within the column cap.
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
      const headerCols = splitTableRow(line).length;
      if (
        headerCols >= 1 &&
        headerCols <= MAX_TABLE_COLS &&
        splitTableRow(lines[i + 1]).length === headerCols
      ) {
        flushPara();
        const { block, next } = parseTable(lines, i);
        blocks.push(block);
        i = next;
        continue;
      }
    }

    if (!para) para = [];
    para.push(parseInline(line));
    i += 1;
  }

  flushPara();
  return blocks;
}
