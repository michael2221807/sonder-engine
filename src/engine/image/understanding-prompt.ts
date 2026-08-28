// App doc: docs/user-guide/pages/game-image.md §图片提炼
/**
 * Shared prompt + response parsing for image understanding
 * （图片提炼重建 epic §3.3/§3.4 — Civitai VLM 与通用 LLM 两引擎共用）。
 *
 * Pure functions only — no fetch, no state. Both engines send one
 * vision call and expect strict JSON back; parsing degrades gracefully
 * (fenced JSON → bare JSON → whole text as caption).
 */
import type {
  ImageUnderstandingTag,
  ImageUnderstandingTask,
} from './reference-types';

export interface UnderstandingPromptParts {
  /** system 角色内容 */
  system: string;
  /** user 消息中与图片块并列的任务文本块 */
  taskText: string;
}

/**
 * Build the prompt pair for a given task mode (D4：三模式为提示词级差异)。
 * `extraPrompt` 为用户附加要求，原样附加（信任用户输入——本功能面向本人使用）。
 */
export function buildUnderstandingPrompt(
  task: ImageUnderstandingTask,
  extraPrompt?: string,
): UnderstandingPromptParts {
  const wantTags = task === 'tags' || task === 'both';
  const wantCaption = task === 'caption' || task === 'both';

  const fields: string[] = [];
  if (wantTags) {
    fields.push('"tags": an array of Danbooru-style tags (lowercase, underscore_joined) covering subject, style, composition, colors, lighting, and notable details');
  }
  if (wantCaption) {
    fields.push('"caption": one fluent English sentence (or two at most) describing the image');
  }

  const system = [
    'You are an image analysis assistant for an illustration prompt tool.',
    'Analyze the provided image and answer with STRICT JSON only.',
    'Describe EXACTLY what you see — never invent content that is not visible.',
  ].join(' ');

  const taskLines = [
    `Look at the image and return a JSON object with ${wantTags && wantCaption ? 'two fields' : 'one field'}:`,
    ...fields.map((f) => `- ${f}`),
    'Return ONLY the JSON object. No markdown fences, no commentary.',
  ];
  if (extraPrompt && extraPrompt.trim()) {
    taskLines.push(`Additional requirements from the user: ${extraPrompt.trim()}`);
  }

  return { system, taskText: taskLines.join('\n') };
}

export interface ParsedUnderstanding {
  tags?: ImageUnderstandingTag[];
  caption?: string;
  /** tags joined / caption / both merged — 与 ImageUnderstandingResult.positiveDraft 契约一致 */
  positiveDraft: string;
  /** true = 结构化 JSON 解析失败，整段文本降级为 caption */
  degraded: boolean;
}

/** 常见拒答语义（D6）：识别后调用方给专用错误，而不是把拒答文案存成画风预设 */
const REFUSAL_PATTERNS = [
  /i (?:can(?:no|')t|am unable to|won't) (?:assist|help|analyze|describe)/i,
  /(?:unable|not able) to (?:assist|help|analyze|describe|process) (?:with )?(?:this|that|the) (?:image|request)/i,
  /against (?:my|our) (?:content )?(?:policy|guidelines)/i,
  /无法(?:协助|帮助|分析|描述|处理)/,
  /(?:违反|不符合).{0,8}(?:政策|准则|规范)/,
];

export function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return REFUSAL_PATTERNS.some((p) => p.test(t));
}

function stripJsonFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Parse a model response into the understanding result shape.
 * 解析顺序：剥围栏 → JSON.parse → 字段提取；失败则整段文本降级为 caption
 * （degraded=true，调用方据此提示用户）。
 */
export function parseUnderstandingResponse(
  raw: string,
  task: ImageUnderstandingTask,
): ParsedUnderstanding {
  const stripped = stripJsonFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const text = raw.trim();
    return { caption: text || undefined, positiveDraft: text, degraded: true };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const text = raw.trim();
    return { caption: text || undefined, positiveDraft: text, degraded: true };
  }

  const obj = parsed as Record<string, unknown>;
  const tags: ImageUnderstandingTag[] = Array.isArray(obj.tags)
    ? obj.tags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => ({ text: t.trim() }))
    : [];
  const caption = typeof obj.caption === 'string' && obj.caption.trim()
    ? obj.caption.trim()
    : undefined;

  const tagString = tags.map((t) => t.text).join(', ');
  let positiveDraft: string;
  if (task === 'tags') positiveDraft = tagString;
  else if (task === 'caption') positiveDraft = caption ?? '';
  else positiveDraft = [tagString, caption].filter(Boolean).join(', ');

  return {
    tags: tags.length > 0 ? tags : undefined,
    caption,
    positiveDraft,
    degraded: false,
  };
}

/**
 * 防幻觉断言（Civitai VLM 专用，真实校准 2026-08-27）：
 *
 * 静默丢图（snake_case 陷阱，evidence §二.1）只在 **openai/ 路由**上以
 * 200 + 幻觉 JSON 的形态出现：丢图 promptTokens ≈ 纯文本（实测 77），
 * 真看图 ≈ 8550——鸿沟巨大，用「文本估算 + 500」下限稳判。
 * anthropic/google 路由的丢图形态是 204 空响应（describeImage 已独立拦截），
 * 且 anthropic 对小图只计 ~22 token（128px 实测总 109），任何文本加成下限
 * 都会误伤——因此断言只对 openai 路由生效。
 *
 * @param responseModel 响应中的 model 字段（带 vendor 前缀，如 "openai/gpt-4o-mini"）
 * @returns 应当拦截时返回下限值；不适用此断言时返回 null
 */
export function minPromptTokensWithImage(
  taskText: string,
  system: string,
  responseModel: string,
): number | null {
  if (!/^openai\//i.test(responseModel.trim())) return null;
  // 粗估：CJK 1 token/字，西文 4 字符/token（与 metrics-helpers 同法）
  const text = `${system}\n${taskText}`;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  const nonCjk = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(nonCjk / 4) + 500;
}
