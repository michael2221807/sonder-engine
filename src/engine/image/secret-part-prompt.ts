// App doc: docs/user-guide/pages/game-image.md §私密部位生成区
/**
 * Secret Part Prompt Utilities — ported
 *
 * Per-body-part close-up descriptions and post-processing for
 * private/NSFW image generation (胸部/小穴/屁穴).
 *
 * Wuxia terms generalized: "武侠/仙侠" removed from system prompts.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ FRONTEND TODO (Phase 3-4: Manual Tab Secret Part Panel)        │
 * │                                                                 │
 * │ This is NOT user-accessible until the Manual tab adds the      │
 * │ fuchsia-themed secret part panel.                              │
 * │ Needs: art style grid, resolution, artist preset, per-part     │
 * │ generate buttons, "全部生成" button.                            │
 * │ See original design doc §F                                    │
 * └─────────────────────────────────────────────────────────────────┘
 */
import type { SecretPartType } from './types';
import { cleanPromptOutput } from './output-processor';

// ═══════════════════════════════════════════════════════════
// §1 — Part descriptions
// ═══════════════════════════════════════════════════════════

/**
 * Build the macro focus description for a specific body part.
 * Build secret-part macro description — ported verbatim
 */
export function buildSecretPartDescription(part: SecretPartType): string {
  if (part === 'breast') {
    return '胸部微距特写 (Breasts Macro Photography)。极近距离裁切，画面完全被胸部占据，聚焦于乳头纹理、乳晕色泽 (Pink nipples, Detailed areola) 以及皮肤的透光感 (Subsurface scattering)，背景需完全虚化或仅保留极小比例。';
  }
  if (part === 'vagina') {
    return '阴部核心特写 (Crotch/Pussy Macro Focus)。超近距离紧裁切，聚焦于花径、湿润程度 (Wetness, Pussy juice) 以及皮肤纹理，强调真实的肉感与微距细节，严禁退回全身或半身视角。';
  }
  return '后庭局部特写 (Ass/Anus Extreme Close-up)。超近距离裁切，画面被臀部与后庭占据，聚焦于皮肤褶皱、肉感 (Skin texture, Fleshy) 以及后庭细节 (Detailed anus)，强调微距级别的细节呈现。';
}

// ═══════════════════════════════════════════════════════════
// §2 — System prompt builders
// ═══════════════════════════════════════════════════════════

/**
 * Build NovelAI-specific system prompt for secret part generation.
 * Build secret part system prompt — ported verbatim, wuxia terms generalized
 */
export function buildSecretPartSystemPrompt(params: {
  part: SecretPartType;
  isNovelAI: boolean;
  hasAnchor: boolean;
  compatMode?: boolean;
  stylePromptInput?: string;
  /** Overall art style label from the UI grid (通用/动漫/写实/古风). Omitted = no style line. */
  artStyle?: string;
}): string {
  const description = buildSecretPartDescription(params.part);

  if (params.isNovelAI) {
    return [
      '你是 NovelAI V4/V4.5 专用的私密部位特写提示词专家。',
      '任务：根据输入的角色资料、角色锚点和目标部位描述，生成稳定、可画的英文 tags。',
      '【输出策略】：可以使用 NovelAI 权重分组语法来组织构图、主体、局部细节和附加风格要求，但不要默认补充固定质量串或固定画风串。',
      '【构图规范】：极速聚焦（Macro Focus）。目标部位必须撑满画面，禁止任何退回半身、全身或普通人像的倾向。',
      '【视觉纹理】：重点描述 skins texture, subsurface scattering, glistening moisture, soft shadows, rim lighting。',
      '【解剖约束】：严格执行"单体准则"。禁止出现重复乳头、多重生殖器或镜像复制。若资料中包含多项描述，应提炼为单一、稳定的视觉焦点。',
      '【风格对齐】：跟随输入资料、额外要求和风格词，不要擅自附加档案页、参考页、拼贴页、多分镜或固定画风底座。',
      params.hasAnchor ? '【锚点对齐】：优先继承与目标部位稳定相关的身体特征，让局部细节与角色保持一致。' : '',
      '禁止生成：face, eyes, hair, arms, legs, background scenery, furniture, clothes (除非作为边缘遮挡)。',
      params.artStyle ? `【画风要求】：整体画风为「${params.artStyle}」。在不破坏微距特写构图的前提下体现该画风的质感与渲染方式。` : '',
      params.compatMode && params.stylePromptInput ? '请自然吸收并整合额外提供的风格词：' + params.stylePromptInput : '',
      `本次目标：${description}`,
      '输出结构：请只输出 <提示词>...</提示词>。',
    ].filter(Boolean).join('\n');
  }

  return [
    '你是私密部位特写提示词转换器。',
    '任务：将角色资料、角色锚点与部位描述转化为稳定、可画的生图短语（英文 tags）。',
    '画面要求：纯粹的微距特写 (Macro shot)。目标部位占据 90% 以上画面，强调纹理、颜色、光泽与边缘细节。',
    '禁止退步：严禁生成包含头部、四肢或大幅场景的提示词。',
    '单体约束：画面中只能有一个目标器官，严禁任何形式的解剖重复或畸变镜像。',
    '质感表现：优先体现肤质（如玉、细腻）、湿润感、光影层次（侧逆光、柔光）以及布料的物理挤压关系。',
    '风格要求：跟随输入资料、额外要求和风格提示词；不要默认补充固定质量串、固定二次元风格串或固定写实风格串。',
    params.artStyle ? `画风要求：整体画风为「${params.artStyle}」。在保持微距特写构图的前提下体现该画风的质感与渲染方式。` : '',
    params.hasAnchor ? '锚点对齐：优先继承与目标部位稳定相关的身体特征，让局部细节与角色保持一致。' : '',
    '输出格式：使用英文逗号分隔的短语串。',
    params.compatMode && params.stylePromptInput ? '请吸收额外风格词并整合：' + params.stylePromptInput : '',
    `本次目标：${description}`,
    '输出结构：请只输出 <提示词>...</提示词>。',
  ].filter(Boolean).join('\n');
}

// ═══════════════════════════════════════════════════════════
// §3 — Task data builder
// ═══════════════════════════════════════════════════════════

/**
 * Build task data for secret part generation (goes as assistant message).
 * Build task data for secret part generation — ported verbatim, wuxia terms generalized
 */
export function buildSecretPartTaskData(params: {
  part: SecretPartType;
  rawDescription: string;
  isNovelAI: boolean;
  anchorPositive?: string;
  anchorInjected?: string;
  compatMode?: boolean;
  stylePromptInput?: string;
  /** Overall art style label from the UI grid (通用/动漫/写实/古风). Omitted = no style line. */
  artStyle?: string;
  extraRequirements?: string;
}): string {
  const hasAnchor = Boolean(params.anchorPositive?.trim());

  if (params.isNovelAI) {
    return [
      '【角色与目标部位资料】',
      params.rawDescription,
      hasAnchor ? `\n【角色稳定视觉锚点】\n${params.anchorPositive!.trim()}` : '',
      params.anchorInjected ? `\n【部位裁剪锚点】\n${params.anchorInjected}` : '',
      '',
      '【输出要求】',
      `目标部位：${params.part === 'breast' ? '胸部' : params.part === 'vagina' ? '小穴' : '屁穴'}`,
      '输出语言：以英文 tags 为主，必要时可保留专有名词。',
      '格式：请只输出 <提示词>...</提示词>，其中内容使用英文逗号分隔。',
      '重点：只保留目标部位特写和最小必要周边，让局部细节完整、清晰、可画。',
      '镜头要求：必须是 extreme close-up / ultra tight crop，目标部位占据画面主体，不能退成普通近景。',
      '数量要求：只允许一个目标部位，不允许重复、镜像复制、并排复制。',
      '禁止内容：face, portrait, upper body, half body, full body, legs, hands, multiple people, room focus, scenery focus。',
      params.artStyle ? `画风：${params.artStyle}` : '',
      params.compatMode && params.stylePromptInput ? `额外风格正面提示词：${params.stylePromptInput}` : '',
      params.extraRequirements ? `附加要求：${params.extraRequirements}` : '附加要求：无',
    ].filter(Boolean).join('\n');
  }

  return [
    '【角色与目标部位资料】',
    params.rawDescription,
    hasAnchor ? `\n【角色稳定视觉锚点】\n${params.anchorPositive!.trim()}` : '',
    params.anchorInjected ? `\n【部位裁剪锚点】\n${params.anchorInjected}` : '',
    '',
    '【额外生成要求】',
    `目标部位：${params.part === 'breast' ? '胸部' : params.part === 'vagina' ? '小穴' : '屁穴'}`,
    '构图：部位特写 / 仅展示目标部位及其必要周边',
    '画面保持局部聚焦、单主体表达，禁止参考页、拼贴页、多分镜或宫格化排版。',
    '画面要求：描述必须具体、可见、可画，优先写形状、颜色、肌理、湿润感、边缘和布料裁切。',
    '镜头要求：必须是 extreme close-up / ultra tight crop，目标部位占据画面主体，不能退成普通近景。',
    '数量要求：只允许一个目标部位，不允许重复、镜像复制、并排复制。',
    '禁止内容：face, portrait, upper body, half body, full body, legs, hands, multiple people, room focus, scenery focus。',
    '格式：请只输出 <提示词>...</提示词>。',
    params.artStyle ? `画风：${params.artStyle}` : '',
    params.compatMode && params.stylePromptInput ? `额外风格正面提示词：${params.stylePromptInput}` : '',
    params.extraRequirements ? `附加要求：${params.extraRequirements}` : '附加要求：无',
  ].filter(Boolean).join('\n');
}

// ═══════════════════════════════════════════════════════════
// §4 — Post-processing
// ═══════════════════════════════════════════════════════════

/** Tags that would pull the image back to portrait/body — must strip for close-ups */
const COMPOSITION_DENY_RE = /^(?:portrait|headshot|upper body|half body|waist-?up|full body|cowboy shot|wide shot|mid shot|long shot|standing|sitting|kneeling|running|walking|looking at viewer|face focus|facial focus|scenery|environment|landscape|room|indoors|outdoors|background|establishing shot)$/i;

/**
 * Strip composition/body tags that would pull a close-up back to portrait/full-body.
 * Reinforce secret-part close-up tags — ported verbatim regex
 */
export function reinforceSecretPartPrompt(prompt: string): string {
  const source = cleanPromptOutput(prompt);
  if (!source) return '';
  return source
    .replace(/\r?\n+/g, ', ')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((token) => !COMPOSITION_DENY_RE.test(token))
    .join(', ');
}
