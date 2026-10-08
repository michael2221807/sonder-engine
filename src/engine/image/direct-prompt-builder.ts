/**
 * Direct Prompt Builder — bypasses AI transformer for NPC → prompt conversion.
 *
 * Ported from `buildNpcDirectImagePrompt`
 *
 * Used when:
 * - User disables transformer in Settings (toggle OFF)
 * - Transformer API is unavailable
 * - Non-NovelAI backends where direct Chinese prompts work
 *
 * Reads NPC data JSON fields and assembles a prompt string directly.
 * NovelAI gets English tags + gender + composition keywords.
 * Other backends get Chinese description text.
 *
 * Used by image-service.generateCharacterImage when `useTransformer` is false (forced on for NovelAI).
 */
import { normalizeNaiWeightSyntax } from './output-processor';

export interface DirectPromptOptions {
  composition?: 'portrait' | 'half-body' | 'full-length' | 'scene' | 'custom';
  artStyle?: string;
  extraRequirements?: string;
  isNovelAI?: boolean;
}

export interface DirectPromptResult {
  rawDescription: string;
  prompt: string;
}

// ── NPC data field reading — ported ──

/** Read NPC text field */
function readTextField(data: Record<string, unknown>, key: string): string {
  const value = data?.[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Read NPC object fragment — flatten object to "key:value" pairs */
function readObjectFragment(data: Record<string, unknown>, key: string): string {
  const source = data?.[key];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  return Object.entries(source as Record<string, unknown>)
    .map(([name, value]) => {
      if (typeof value === 'string' && value.trim()) return `${name}:${value.trim()}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `${name}:${value}`;
      return '';
    })
    .filter(Boolean)
    .join('，');
}

/** Read NPC array fragment — flatten array to comma-separated names */
function readArrayFragment(data: Record<string, unknown>, key: string): string {
  const source = data?.[key];
  if (!Array.isArray(source)) return '';
  return source
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)?.['名称'] === 'string') {
        return ((item as Record<string, unknown>)['名称'] as string).trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('，');
}

/** Generate NovelAI character count tag — ported */
function inferNaiGenderTag(data: Record<string, unknown>): string {
  const gender = readTextField(data, '性别');
  if (gender === '女') return '1girl';
  if (gender === '男') return '1man';
  return 'solo';
}

/**
 * Build an image prompt directly from NPC data without AI transformer.
 *
 * Build NPC direct image prompt — ported
 *
 * Field reading order: 性别 → 年龄 → 身份 → 境界 → 简介 →
 * 核心性格特征 → 性格 → 外貌 → 身材 → 衣着, then complex fields
 * (当前装备, 背包, 补充视觉设定), then composition/gender tags.
 */
export function buildDirectCharacterPrompt(
  npcDataJson: string,
  options?: DirectPromptOptions,
): DirectPromptResult {
  let source: Record<string, unknown>;
  try {
    const parsed = JSON.parse(npcDataJson || '{}');
    source = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    source = {};
  }

  const isNovelAI = options?.isNovelAI === true;

  // Core visual fields (verbatim field order from original).
  // AGA NPC records use `外貌描述 / 身材描写 / 衣着风格` (longer, self-documenting);
  // the original codebase uses `外貌 / 身材 / 衣着`. image-service serializes both key sets, but
  // when callers hand-roll npcDataJson (assistant, legacy paths) we fall back
  // to the AGA names so no visual field silently drops out.
  const fragments = [
    readTextField(source, '性别'),
    readTextField(source, '年龄') ? `${readTextField(source, '年龄')}岁` : '',
    readTextField(source, '身份'),
    readTextField(source, '境界'),
    readTextField(source, '简介') || readTextField(source, '描述'),
    readTextField(source, '核心性格特征'),
    readTextField(source, '性格'),
    readTextField(source, '外貌') || readTextField(source, '外貌描述'),
    readTextField(source, '身材') || readTextField(source, '身材描写'),
    readTextField(source, '衣着') || readTextField(source, '衣着风格'),
  ];

  // Complex fields
  const equipment = readObjectFragment(source, '当前装备');
  if (equipment) fragments.push(`装备：${equipment}`);
  const inventory = readArrayFragment(source, '背包');
  if (inventory) fragments.push(`随身物品：${inventory}`);
  const visualOverrides = readObjectFragment(source, '补充视觉设定');
  if (visualOverrides) fragments.push(`补充设定：${visualOverrides}`);

  // Composition + backend-specific tags
  const comp = options?.composition ?? 'portrait';
  if (isNovelAI) {
    const genderTag = inferNaiGenderTag(source);
    if (comp === 'full-length') {
      fragments.push(genderTag, 'full body, standing, character focus');
    } else {
      fragments.push(genderTag, 'portrait, upper body, face focus');
    }
  } else {
    if (comp === 'full-length') fragments.push('全身角色，站姿，角色主体');
  }

  // Extra requirements
  if (options?.extraRequirements?.trim()) {
    fragments.push(options.extraRequirements.trim());
  }

  // Join and normalize
  const rawPrompt = fragments.filter(Boolean).join(isNovelAI ? ', ' : '，');
  const prompt = isNovelAI ? normalizeNaiWeightSyntax(rawPrompt) : rawPrompt;

  return {
    rawDescription: JSON.stringify(source, null, 2),
    prompt,
  };
}
