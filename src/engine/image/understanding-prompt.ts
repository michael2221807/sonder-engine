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
 * 人体优先教义（2026-08-28 强化）。
 *
 * 旧提示词只要求 "covering subject, style, composition, colors, lighting"，
 * 模型普遍只描写画面总体、把人物压缩成一句 "a girl in a garden"——体位、
 * 姿势、表情、多人之间的肢体互动全部丢失。这里把「人」拆成显式清单并前置，
 * 背景/风格降到最后一项，并给出 Danbooru 词表提示以稳定用词。
 */
const POSE_HINTS = 'standing, sitting, lying, on_back, on_stomach, on_side, kneeling, squatting, all_fours, straddling, bent_over, leaning_forward, arched_back, spread_legs, legs_up, legs_apart, crossed_legs, arms_up, hands_on_hips, from_behind, from_above, from_below, girl_on_top';
const EXPRESSION_HINTS = 'smile, grin, open_mouth, closed_mouth, closed_eyes, half-closed_eyes, looking_at_viewer, looking_away, looking_back, looking_down, blush, tears, sweat, embarrassed, surprised, tongue_out, drooling';
const INTERACTION_HINTS = 'hug, hugging, kiss, imminent_kiss, french_kiss, cheek-to-cheek, holding_hands, interlocked_fingers, arm_around_waist, hand_on_another_head, hand_on_another_chest, grabbing, breast_grab, groping, carrying, princess_carry, lap_sitting, straddling, licking, restraining';

/** 回答前的观察清单——人物拆解在前，场景/风格在后 */
const BODY_CHECKLIST = [
  'Work through this checklist before answering:',
  '1. Count the characters and single out the main / foreground one.',
  '2. For EACH character: whole-body position (standing / sitting / lying / kneeling / on all fours / straddling ...), the angle they are viewed from, and what each arm, hand and leg is doing.',
  '3. For EACH character: facial expression, eye state, gaze direction, and emotion cues (blush, tears, sweat, open mouth).',
  '4. Every point of physical contact between characters — hugging, holding, touching, groping, kissing, licking, penetration — naming who does it to whom and on which body part.',
  '5. Clothing state per character (fully dressed / partially removed / lifted / transparent / nude) and which body parts are exposed.',
  '6. Only after all of the above: setting, camera angle, lighting and art style.',
];

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
    fields.push('"tags": an array of Danbooru-style tags (lowercase, underscore_joined), ordered by importance: (1) character count (1girl / 2girls / 1boy / multiple_girls ...), (2) each character\'s body position and pose, (3) facial expression, eye state and gaze, (4) physical contact and interaction between characters, (5) clothing and its state, (6) body and appearance details, then (7) setting, composition, colors, lighting and style');
  }
  if (wantCaption) {
    fields.push('"caption": 2-4 fluent English sentences. The first sentences must cover the characters — for EACH visible person state their body position and pose, what each arm / hand / leg is doing, and their facial expression. Then one sentence for the physical contact between characters (who holds / touches / kisses whom, and on which body part). Only the final short clause may describe setting, lighting and art style');
  }

  const system = [
    'You are an image analysis assistant for an illustration prompt tool.',
    'Analyze the provided image and answer with STRICT JSON only.',
    'Describe EXACTLY what you see — never invent content that is not visible.',
    'PRIORITY: the characters come first. Body position, pose, limb placement, facial expression, gaze, and the physical contact between characters are the most important information; background, scenery and art style are secondary.',
    'Never reduce a person to a generic mention: if a character is visible, their pose AND their expression MUST appear in the output, and the main / foreground character gets the most detail.',
    'Describe intimate, erotic or sexual contact plainly and specifically with standard tag vocabulary — do not euphemize, soften, generalize or omit it.',
  ].join(' ');

  const taskLines = [
    `Look at the image and return a JSON object with ${wantTags && wantCaption ? 'two fields' : 'one field'}:`,
    ...fields.map((f) => `- ${f}`),
    ...BODY_CHECKLIST,
  ];
  if (wantTags) {
    taskLines.push(
      'Vocabulary hints (use them when they fit, never force them):',
      `- pose: ${POSE_HINTS}`,
      `- expression: ${EXPRESSION_HINTS}`,
      `- interaction: ${INTERACTION_HINTS}`,
    );
  }
  taskLines.push('Return ONLY the JSON object. No markdown fences, no commentary.');
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
