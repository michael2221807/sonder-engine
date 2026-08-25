/**
 * JSON 非法转义 sanitizer — 2026-04-19
 *
 * 背景：LLM 偶尔会在 JSON 字符串值里 stutter 一个裸反斜杠（例如 `\你`），
 * 产生 `Unexpected token '你'` 级别的 SyntaxError。这不是 AGA 的 bug —— 是
 * 模型输出的 bug —— 但 AGA 迁移时简化掉了 ming demo 里的正则兜底（见
 * `AIBidirectionalSystem.ts:1381`），整个响应 fall-through 变成纯文本，
 * commands / mid_term_memory / action_options 全部丢失。
 *
 * 这个 sanitizer 的策略是在 `JSON.parse` 之前做最小侵入修正：
 *
 * - 保留所有合法转义：`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`
 * - 把非法转义 `\X`（X 不是上面这些）里的反斜杠吃掉，保留后面那个字符
 * - 只在 JSON 字符串字面量内部动手（外面的反斜杠不可能合法出现，保守起见不碰）
 * - 字符串起止由未转义的双引号界定；正确处理 `\\"` 这种连续转义
 *
 * 这样 `"\n\你站起身"` 里的 `\n` 仍然解析成换行，`\你` 会被修成 `你`，原本会
 * 抛 SyntaxError 的输入得以通过原生 JSON.parse，commands/memory 等结构化
 * 字段得到保留。
 *
 * 只处理 *JSON 源* 的转义问题；不处理 markdown 围栏、尾随逗号、未闭合
 * 字符串等其他常见 LLM 输出瑕疵——那些交给调用方或其他 sanitizer。
 */

/** 合法的 JSON 字符串转义字符（`\u` 单独处理）—— 出现这些之后的反斜杠不动 */
const VALID_ESCAPE_CHARS = '"\\/bfnrtu';

/**
 * 愈合字符串字面量内部的**未转义双引号** — 2026-08-25
 *
 * 事故背景（round-62 设定捕获）：设定提取协议要求 evidence 逐字引用玩家标记原文，
 * 玩家原文里带英文直引号（`看上去"养尊处优"的女性`），模型忠实照抄进 JSON 字符串值
 * 却没有转义 → 整个 step2 响应 JSON 非法 → 五个结构化字段全部丢失。"逐字引用"是
 * 产品要求，玩家文本含英文引号是常态，所以这必须在解析器层治好，不能指望模型转义。
 *
 * 启发式（业界通行的 LLM quote-healing）：字符串内部遇到 `"` 时向后看第一个非空白
 * 字符——是 `}` `]` `:` 或到达结尾 → 视为真正的闭引号；是 `,` 时再多看一步，逗号后的
 * 非空白字符必须是合法的 JSON 值起始（`"` `{` `[` 数字 `-` t/f/n）才算闭合，否则
 * （如 `他说"你好", 然后走了`）判为内容引号。否则视为内容，改写成 `\"`。
 *
 * 诚实的边界说明（2026-08-25 review）：这是启发式，不是解析器。本来就能解析的输入
 * 绝不会被改坏（只在两级解析都失败后调用）；但对**本来就非法**的输入，极端形态
 * （内容引号后紧跟 ASCII 逗号 + 恰似 JSON 值起始的内容）理论上可能愈合出"合法但
 * 语义损坏"的结果而非解析失败。证据字段有下游逐字校验门兜底（损坏必被拒）；
 * commands 无此门，属已知残余风险——若真实出现，应升级为按字段作用域的愈合。
 */
export function healUnescapedQuotes(src: string): string {
  if (!src || typeof src !== 'string') return src;

  const n = src.length;
  let out = '';
  let i = 0;
  let inString = false;

  while (i < n) {
    const c = src[i];

    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < n) {
      // 已合法化的转义对（本函数在 sanitizeJsonEscapes 之后运行）——原样搬走
      out += c + src[i + 1];
      i += 2;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      const next = j < n ? src[j] : '';
      let closes = next === '' || next === '}' || next === ']' || next === ':';
      if (!closes && next === ',') {
        // A real closing-quote-then-comma is followed by the NEXT value or key —
        // which must start like JSON (`"` `{` `[` digit `-` true/false/null).
        // Content like `他说"你好", 然后走了` fails this and stays inside the string.
        let k = j + 1;
        while (k < n && /\s/.test(src[k])) k++;
        closes = k < n && /["{[\-0-9tfn]/.test(src[k]);
      }
      if (closes) {
        inString = false;
        out += c;
      } else {
        out += '\\"';
      }
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * 清洗 JSON 源字符串里字符串字面量内部的非法 `\X` 转义
 *
 * 对于 `\uXXXX` 这种需要 4 位 hex follow 的转义，若 `u` 后面 4 位不是合法
 * hex，则把 `\u` 当作非法转义，删除反斜杠。这避免把一个只写了 `\u` 的
 * 残缺模型输出变成合法但乱套的字符。
 *
 * 时间复杂度 O(n)；对非 AI 返回（正常的 JSON）零开销。
 */
export function sanitizeJsonEscapes(src: string): string {
  if (!src || typeof src !== 'string') return src;

  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;

  while (i < n) {
    const c = src[i];

    if (!inString) {
      // 非字符串区——只关心进入字符串的开引号
      if (c === '"') {
        inString = true;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // inString = true
    if (c === '"') {
      inString = false;
      out += c;
      i++;
      continue;
    }

    if (c === '\\') {
      if (i + 1 >= n) {
        // 收尾裸反斜杠 —— 无论如何都不合法，吃掉
        i++;
        continue;
      }
      const next = src[i + 1];

      if (next === 'u') {
        // \uXXXX —— 验证 4 位 hex
        if (i + 5 < n && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          out += '\\u';
          i += 2;
          continue;
        }
        // \u 后面不是合法 hex —— 吃掉反斜杠，留下 u
        out += 'u';
        i += 2;
        continue;
      }

      if (VALID_ESCAPE_CHARS.includes(next)) {
        // 合法转义（包括 \\）—— 连同 next 一起搬走，不对 next 再做扫描
        out += '\\' + next;
        i += 2;
        continue;
      }

      // 非法转义 `\X` —— 吃掉反斜杠，保留 X
      out += next;
      i += 2;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
