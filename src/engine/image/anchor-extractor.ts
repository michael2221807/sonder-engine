/**
 * Character Anchor Extractor — ported
 *
 * Extracts structured visual features via AI. The AI analyzes NPC data and produces:
 * - positivePrompt: stable visual anchor tags (English)
 * - negativePrompt: things to visually avoid
 * - features: 10 structured feature categories (appearance/figure/bust/etc.)
 *
 * Per PRINCIPLES §3.16: anchor.entityRef references Engram entity (unidirectional).
 */
import type { AnchorStructuredFeatures } from './types';
import type { AIService } from '../ai/ai-service';

// ═══════════════════════════════════════════════════════════
// AI-powered anchor extraction — ported
// ═══════════════════════════════════════════════════════════

export interface AnchorExtractionResult {
  name: string;
  positivePrompt: string;
  negativePrompt: string;
  structuredFeatures?: AnchorStructuredFeatures;
  notes?: string;
}

/** System prompt for anchor extraction — verbatim from original (no wuxia terms present) */
const ANCHOR_EXTRACTION_SYSTEM_PROMPT = [
  '你是角色视觉锚点提取器。',
  '你的任务是从角色资料中提取可长期复用的稳定外观锚点，用于后续保持角色一致性。',
  '提取重点放在外貌、脸型、五官、发型、发色、瞳色、肤色、身材、胸部/罩杯、年龄感、常驻服装基底和长期可见特征。',
  '当资料缺少关键稳定外观时，可以依据身份、时代、气质和已有外貌描述做保守补全，优先选择常见、低冲突、容易长期保持一致的视觉表达。',
  '正面提示词要尽量完整，适合直接作为稳定角色锚点追加到图像模型。',
  '正面提示词只保留长期可见、长期稳定的视觉信息，让每个词都服务于持续复用。',
  '如果角色具有门派、职业、种族、血统、异色瞳、伤痕、纹身、泪痣、兽耳、角等长期可见特征，请结构化保留。',
  '如果角色资料包含多套装束，请选择最常驻、最核心、最能长期识别角色的那一套服装基底。',
  '提示词使用英文 tag 风格，按逗号分隔。',
  '提示词中直接写可见外观和可见身份道具，不写人名、称呼、IP 名称或剧情标签。',
  '负面提示词在资料明确给出长期需要规避的视觉特征时填写，否则保持空字符串。',
  '输出必须是 JSON，字段：positivePrompt, negativePrompt, features, notes。',
  'notes 用简短文字说明哪些内容来自保守补全。',
  'features 内字段固定为：appearance, figure, bust, hairstyle, hairColor, eyes, skinTone, ageAppearance, baseOutfit, specialTraits。',
  '每个 features 字段都必须是字符串数组或空数组。',
  'positivePrompt 直接输出可用于生图的英文提示词。',
  '直接输出 JSON 对象，不要在 JSON 前后添加任何说明文字或 Markdown 代码围栏。',
].join('\n');

/** Remove character name fragments from prompt text */
function removeNameFromPrompt(prompt: string, displayName: string): string {
  if (!prompt || !displayName.trim()) return prompt;
  const escaped = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prompt
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !new RegExp(escaped, 'iu').test(t))
    .join(', ');
}

/** Remove character name from structured feature arrays */
function removeNameFromFeatures(
  features: AnchorStructuredFeatures | undefined,
  displayName: string,
): AnchorStructuredFeatures | undefined {
  if (!features || !displayName.trim()) return features;
  const escaped = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'iu');
  const clean = (arr: string[] | undefined): string[] | undefined =>
    arr?.filter((t) => t && !re.test(t));
  return {
    appearance: clean(features.appearance),
    figure: clean(features.figure),
    bust: clean(features.bust),
    hairstyle: clean(features.hairstyle),
    hairColor: clean(features.hairColor),
    eyes: clean(features.eyes),
    skinTone: clean(features.skinTone),
    ageAppearance: clean(features.ageAppearance),
    baseOutfit: clean(features.baseOutfit),
    specialTraits: clean(features.specialTraits),
  };
}

function parseFeatureArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item: unknown) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Extract character anchor via AI.
 *
 * Extract character anchor prompt tags — ported
 *
 * Calls an LLM with temperature 0.5 and JSON response format to extract
 * stable visual features from NPC data into a reusable anchor record.
 */
export async function extractAnchorViaAI(
  aiService: AIService,
  npcDataJson: string,
  options?: { displayName?: string; extraRequirements?: string },
): Promise<AnchorExtractionResult> {
  const displayName = (options?.displayName || '').trim() || '角色锚点';

  const taskPrompt = [
    '请根据以下角色资料提取角色视觉锚点。',
    options?.extraRequirements ? `额外要求：${options.extraRequirements}` : '',
    '',
    npcDataJson,
  ].filter(Boolean).join('\n');

  const rawResponse = await aiService.generate({
    messages: [
      { role: 'system', content: ANCHOR_EXTRACTION_SYSTEM_PROMPT },
      { role: 'assistant', content: `【本次任务】\n${taskPrompt}` },
      { role: 'user', content: '开始任务' },
    ],
    stream: false,
    usageType: 'imageCharacterTokenizer',
  });

  // Parse JSON response
  let parsed: Record<string, unknown>;
  try {
    // Strip markdown fences and any leading/trailing text before/after JSON
    let cleaned = rawResponse
      .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
      .replace(/\s*```[\s\S]*$/i, '')
      .trim();
    // If no fences found, try to extract JSON object directly
    if (!cleaned.startsWith('{')) {
      const jsonStart = rawResponse.indexOf('{');
      const jsonEnd = rawResponse.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        cleaned = rawResponse.slice(jsonStart, jsonEnd + 1);
      }
    }
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error(`角色锚点提取失败：模型返回内容不是有效 JSON。${rawResponse.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('角色锚点提取结果不是有效 JSON 对象');
  }

  const features: AnchorStructuredFeatures = {
    appearance: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).appearance : undefined),
    figure: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).figure : undefined),
    bust: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).bust : undefined),
    hairstyle: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).hairstyle : undefined),
    hairColor: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).hairColor : undefined),
    eyes: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).eyes : undefined),
    skinTone: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).skinTone : undefined),
    ageAppearance: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).ageAppearance : undefined),
    baseOutfit: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).baseOutfit : undefined),
    specialTraits: parseFeatureArray(parsed.features && typeof parsed.features === 'object' ? (parsed.features as Record<string, unknown>).specialTraits : undefined),
  };

  const hasFeatures = Object.values(features).some((arr) => Array.isArray(arr) && arr.length > 0);
  const positivePrompt = typeof parsed.positivePrompt === 'string' ? parsed.positivePrompt.trim() : '';
  const negativePrompt = typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt.trim() : '';

  if (!positivePrompt && !hasFeatures) {
    const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : '';
    throw new Error(notes || '角色锚点提取结果为空，模型未返回可用的稳定外观内容。');
  }

  return {
    name: displayName,
    positivePrompt: removeNameFromPrompt(positivePrompt, displayName),
    negativePrompt: removeNameFromPrompt(negativePrompt, displayName),
    structuredFeatures: removeNameFromFeatures(hasFeatures ? features : undefined, displayName),
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : undefined,
  };
}
