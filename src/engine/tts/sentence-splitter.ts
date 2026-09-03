// App doc: docs/user-guide/pages/game-main.md §3.13 (配音 · CosyVoice)
/**
 * TTS 文本预处理 — 纯函数,无副作用,便于单测。
 *
 * 两步:
 *   1. stripMarkersForSpeech — 去掉 AGA 正文的 markdown/inline marker 记号,避免把
 *      `【环境】` / 反引号 / 引号 / 表格竖线 等读出来;并整块剔除 `〖判定/系统提示〗`
 *      (stripJudgementForSpeech) —— 判定是系统层信息,朗读会打断沉浸感。
 *   2. splitSentences — 把清洗后的整段切成"句"级细片段(tokenizer)。
 *   3. groupSentencesBySize — 把细片段按「目标字数 + 最多句数」智能拼回"段",
 *      供分句流式流水线逐段合成:逐段请求 streaming=1,当前段播放时预取下一段,
 *      首段快出声、段间近无缝。拼段让每次请求大小可控、避免单短句造成的卡顿。
 *
 * 分段策略(用户选定「字数为主,句数浮动」+ 两条智能改进):
 *   - 平衡断点:跨过目标字数时,比较"含跨界句"vs"不含"谁更接近目标,就近断,
 *     避免长句把段落冲到远超目标。
 *   - 短尾合并:结尾残段过短(< 目标字数一半)且并入不超最多句数时并进上一段,
 *     消灭"孤零零短段"造成的最明显卡顿。
 *   - 最多句数为硬上限(兜底延迟/停止粒度),即使短尾合并也不突破。
 */

/**
 * 剔除「判定 / 系统提示」块 — 这些是系统层信息(骰值、难度、状态变化),
 * 不属于叙事,朗读出来会打断沉浸感,故整块跳过而非去符号读内容。
 *
 * 覆盖三种写法:
 *   1. `〖类型:结果,判定值:X,难度:Y,...〗` —— AGA 唯一合法判定格式(也含
 *      `〖系统提示:好感度变化〗` 这类状态提示,pack core.md §四:`〖〗` = 系统判定/状态变化)。
 *      与 formatted-text-parser.findJudgementSlices **逐字同规则**:遇 `〖` 吃到最近的
 *      `〗`(嵌套的 `〖` 一并吞掉,与展示层一致),未闭合的 `〖` 不吞后文
 *      (只把孤立符号本身抹掉)。两处规则必须同步改,否则"看不到却读得到"。
 *   2. `<judge>...</judge>` 判定思考块 —— 正常链路里 response-parser 已剥掉标签,
 *      这里兜底原始文本直接传入的情形。
 *   3. `【判定:...】` / `【...,判定值:X,...】` / `【系统提示:...】` —— 模型偶尔用错括号
 *      (core.md 明确警告「用〖〗不是【】」)。只在内容是 `判定:` / `系统提示:` 这类
 *      冒号形式,或含 `判定值:` 字段时才剔除;`【环境】`、`【判定日快到了】`、
 *      `【任务】难度:高` 这类叙事标签不受影响。
 */
export function stripJudgementForSpeech(raw: string): string {
  if (!raw) return '';
  let t = raw;
  // 1) <judge>...</judge> 判定思考块(含未闭合时不吞尾,故要求闭合)
  t = t.replace(/<\s*judge\s*>[\s\S]*?<\s*\/\s*judge\s*>/gi, '');
  // 2) 〖...〗 判定/系统提示块 —— 用「最近的 〗 收口」逐段扫描,与展示层
  //    formatted-text-parser.findJudgementSlices 逐字同规则:遇 `〖` 就吃到下一个
  //    `〗`(即使中间又出现 `〖` 也一并吞掉,与展示层"孤立 〖 后的文本不渲染成正文"
  //    一致);找不到闭合的 `〗` 则停手,不吞后文。若改成正则 /〖[^〖〗]*〗/,
  //    孤立 `〖` 后面那段展示层不显示的文本会被朗读出来 —— 视听不一致。
  let out = '';
  let cursor = 0;
  while (cursor < t.length) {
    const open = t.indexOf('〖', cursor);
    if (open === -1) break;
    const close = t.indexOf('〗', open + 1);
    if (close === -1) break; // 未闭合 → 后文原样保留(展示层同样忽略这个 〖)
    out += t.slice(cursor, open);
    cursor = close + 1;
  }
  t = out + t.slice(cursor);
  // 3) 误用方括号的系统块:仅当内容确实是判定/系统提示语法时才剔除
  t = t.replace(/【([^【】]*)】/g, (whole, inner: string) => {
    const norm = inner.replace(/：/g, ':').replace(/，/g, ',').trim();
    // 收紧到「确实是判定语法」:`判定:` 形式的类型冒号,或带 `判定值:` 字段。
    // 不能只看「判定」两字开头 —— 那是日常词,会误伤 `【判定日快到了】`;
    // 也不能只看难度/基础/幸运,太泛,会误伤 `【任务】难度:高`。
    const looksLikeJudgement = /^判定\s*:/.test(norm) || /判定值\s*:/.test(norm);
    // 系统提示同属系统层信息(与 〖系统提示:…〗 对齐),要求冒号形式避免误伤叙事。
    const looksLikeSystemNote = /^系统提示\s*:/.test(norm);
    return looksLikeJudgement || looksLikeSystemNote ? '' : whole;
  });
  // 残留的孤立 〖 / 〗(未闭合)不该被读出来
  t = t.replace(/[〖〗]/g, '');
  return t;
}

/**
 * 去掉朗读不需要的记号,保留纯可读文本。
 * - 〖判定〗/系统提示块 → **整块跳过不朗读**(见 stripJudgementForSpeech)
 * - 【标签】环境标记 → 去掉方括号标签,保留内容? 环境标记 `【环境】xxx` 中
 *   `【环境】` 是分类标签不该读,内容要读 → 去掉 `【...】` 整体前缀标签,
 *   但普通正文里的书名号《》要保留。这里只剥离 AGA 已知的分类标签。
 * - 反引号 `内心` → 去反引号,读内容
 * - markdown 强调/标题/列表符号 → 去掉
 * - 表格竖线/分隔行 → 折叠为空格
 */
export function stripMarkersForSpeech(raw: string): string {
  if (!raw) return '';
  let t = raw;

  // 代码块 ``` ... ``` 整体移除(朗读代码无意义)
  t = t.replace(/```[\s\S]*?```/g, ' ');
  // 判定/系统提示块整块跳过 —— 必须早于反引号与 【】 处理,避免判定内容被
  // 后续规则"去符号保留内容"重新混进朗读文本。
  t = stripJudgementForSpeech(t);
  // 行内反引号:去引号读内容(AGA 内心独白 `...`)
  t = t.replace(/`([^`]*)`/g, '$1');
  // AGA 分类标签:行首/句中的 【环境】等作为标签前缀 → 去掉方括号本身,保留其后
  // 内容。判定类 〖…〗/【判定…】已在 stripJudgementForSpeech 整块剔除,不会走到这里。
  t = t.replace(/【([^】]*)】/g, '$1，');
  // markdown 标题 #、引用 >、列表 -/*/数字. 前缀
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');
  t = t.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // markdown 强调 **bold** *italic* __x__ ~~x~~ → 去符号
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/~~([^~]+)~~/g, '$1');
  // markdown 表格:去掉竖线与分隔行
  t = t.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' '); // 分隔行 |---|---|
  t = t.replace(/\|/g, '，');                      // 单元格分隔 → 顿号停顿
  // markdown 链接 [text](url) → text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 图片 ![alt](url) → 去掉
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // 折叠多余空白
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t;
}

/** 句末标点(切句点,保留在片段尾部) */
const SENTENCE_END = /([。！？!?…]+|\n)/;
/** 次级切点(超长句时按这些软停顿再切) */
const SOFT_BREAK = /([，,；;：:])/;
/** 单句字符封顶 — 超过则按软停顿二次切,以此约束单次请求延迟与内存 */
const MAX_SEGMENT_LEN = 80;
/** 片段最短长度 — 短于此(即 1-2 字)的碎片并入前一段,避免极短音频卡顿;
 *  3 字及以上视为合法短句独立成段(如「下一行」)。 */
const MIN_SEGMENT_LEN = 3;

/**
 * 把清洗后的整段文本切成句级片段(供分句流式流水线逐句合成)。
 *
 * 规则:
 *   - 主切点:句末标点 。！？!?… 与换行(标点保留在片段尾)。
 *   - 超长片段(> MAX_SEGMENT_LEN)按软停顿 ，,；;：: 二次切,封顶单请求延迟。
 *   - 过短碎片(< MIN_SEGMENT_LEN)并入前一段,避免极短音频。
 *   - 空白/纯标点片段丢弃。
 *
 * 输入应为 stripMarkersForSpeech 的输出;直接传原始正文也安全(只是保留了记号)。
 */
export function splitSentences(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  // 1) 主切:句末标点/换行,保留标点在句尾。
  const primary: string[] = [];
  for (const part of cleaned.split(SENTENCE_END)) {
    if (!part) continue;
    if (SENTENCE_END.test(part)) {
      // 分隔符 → 附到上一片段尾部(换行折成句界,不入朗读)。
      if (part === '\n') continue;
      if (primary.length > 0) primary[primary.length - 1] += part;
      else primary.push(part);
    } else {
      primary.push(part);
    }
  }

  // 2) 超长片段按软停顿二次切。
  const sized: string[] = [];
  for (const seg of primary) {
    if (seg.length <= MAX_SEGMENT_LEN) {
      sized.push(seg);
      continue;
    }
    let buf = '';
    for (const chunk of seg.split(SOFT_BREAK)) {
      if (!chunk) continue;
      // 追加前预判:若当前 buf 非空且加上该 chunk 会超封顶,先把 buf flush 掉,
      // 避免"整个子句都追加进来后才发现超长"导致的一大坨片段。
      if (buf && buf.length + chunk.length > MAX_SEGMENT_LEN) {
        sized.push(buf);
        buf = '';
      }
      buf += chunk;
    }
    if (buf) sized.push(buf);
  }

  // 3) 归一化:去空白/纯标点片段;过短碎片并入前一段。
  const result: string[] = [];
  for (const raw of sized) {
    const s = raw.trim();
    if (!s) continue;
    // 纯标点(无任何字母/汉字/数字)不单独成段 → 并入前一段。
    const hasSpeakable = /[\p{L}\p{N}]/u.test(s);
    if (!hasSpeakable) {
      if (result.length > 0) result[result.length - 1] += s;
      continue;
    }
    if (s.length < MIN_SEGMENT_LEN && result.length > 0) {
      result[result.length - 1] += s;
    } else {
      result.push(s);
    }
  }
  return result;
}

/** 分段设置的安全边界(与 tts-settings normalize 保持一致) */
export const SEGMENT_TARGET_CHARS_MIN = 20;
export const SEGMENT_TARGET_CHARS_MAX = 1000;
export const SEGMENT_MAX_SENTENCES_MIN = 1;
export const SEGMENT_MAX_SENTENCES_MAX = 30;

/**
 * 把 splitSentences 产出的细句片段,按「目标字数 targetChars + 每段最多句数
 * maxSentences」智能拼成"段"。用户选定「字数为主,句数浮动」。
 *
 * 规则(逐句左到右贪心 + 两条智能改进):
 *   - 主控:段字数攒到 >= targetChars 即断(允许略超,保留完整句)。
 *   - 平衡断点:当加入某句会跨过 targetChars 时,比较"不含该句"(差 undershoot)
 *     与"含该句"(超 overshoot)谁更接近目标 —— undershoot <= overshoot 则在该句
 *     之前断(该句留给下一段),否则含该句后断。避免长句把段落冲到远超目标。
 *   - 硬上限:任一段句数不超过 maxSentences(到顶即断,兜底延迟/停止粒度)。
 *   - 短尾合并:末尾残段若过短(< targetChars/2)且并入后不超 maxSentences,
 *     并进上一段;否则自成一段。消灭孤零短段。
 *
 * 保证:除被硬上限截断的情形外,正常段字数 >= targetChars(平衡后接近目标);
 * 不切碎完整句子。空输入 → []。
 */
export function groupSentencesBySize(
  sentences: string[],
  targetChars: number,
  maxSentences: number,
): string[] {
  if (sentences.length === 0) return [];
  // 防御:参数落到安全区间(UI/持久化已 normalize,这里再兜一层)。
  const C = Math.min(Math.max(Math.round(targetChars) || SEGMENT_TARGET_CHARS_MIN, SEGMENT_TARGET_CHARS_MIN), SEGMENT_TARGET_CHARS_MAX);
  const S = Math.min(Math.max(Math.round(maxSentences) || SEGMENT_MAX_SENTENCES_MIN, SEGMENT_MAX_SENTENCES_MIN), SEGMENT_MAX_SENTENCES_MAX);

  const groups: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      groups.push(cur);
      cur = [];
      curLen = 0;
    }
  };

  for (const s of sentences) {
    // 平衡断点:cur 非空且加入 s 会跨过目标时,若当前段已更接近目标,则先断在 s 之前。
    if (cur.length > 0 && curLen + s.length >= C) {
      const undershoot = C - curLen;          // 不含 s:离目标还差多少(>=0,因 curLen<C)
      const overshoot = curLen + s.length - C; // 含 s:超出目标多少
      if (undershoot <= overshoot) flush();
    }
    cur.push(s);
    curLen += s.length;
    // 达目标字数,或到句数硬上限 → 断段。
    if (curLen >= C || cur.length >= S) flush();
  }

  // 末尾残段:过短且并入不超上限 → 并进上一段;否则自成一段。
  if (cur.length > 0) {
    const prev = groups[groups.length - 1];
    if (prev && curLen < C / 2 && prev.length + cur.length <= S) {
      prev.push(...cur);
    } else {
      groups.push(cur);
    }
  }

  return groups.map((g) => g.join(''));
}
