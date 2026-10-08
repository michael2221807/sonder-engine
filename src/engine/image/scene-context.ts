// App doc: docs/user-guide/pages/game-image.md §Tab 3 — 角色数据注入
/**
 * Scene Context Builder — constructs scene generation context from game state.
 *
 * The original scene system uses explicit 大地点/中地点/小地点/具体地点 fields.
 * AGA stores locations as `·`-separated hierarchical paths (e.g., "东荒大陆·青云城·客栈").
 *
 * This module:
 * 1. Parses AGA location paths into hierarchical layers (innermost 3 levels)
 * 2. Builds scene context combining location + time + present NPCs
 * 3. Extracts character snapshot data for scene prompts
 */

// ═══════════════════════════════════════════════════════════
// §1 — Location hierarchy parsing
// ═══════════════════════════════════════════════════════════

export interface LocationHierarchy {
  /** Broad region (background/distant — 大地点) */
  broad: string;
  /** Mid-level area (midground — AGA's middle layer) */
  mid: string;
  /** Specific place (foreground/stage — 具体地点) */
  specific: string;
  /** Full original path */
  fullPath: string;
}

/**
 * Parse an AGA `·`-separated location path into a 3-layer hierarchy.
 *
 * Takes the innermost 3 layers as the user instructed.
 *
 * Examples:
 * - "东荒大陆·青云城·客栈" → broad="东荒大陆", mid="青云城", specific="客栈"
 * - "青云城·客栈" → broad="", mid="青云城", specific="客栈"
 * - "客栈" → broad="", mid="", specific="客栈"
 * - "大陆·国·城·街·店" → broad="城", mid="街", specific="店" (innermost 3)
 */
export function parseLocationHierarchy(locationPath: string): LocationHierarchy {
  const raw = (locationPath || '').trim();
  if (!raw) return { broad: '', mid: '', specific: '', fullPath: '' };

  const parts = raw.split('·').map((s) => s.trim()).filter(Boolean);

  if (parts.length === 0) return { broad: '', mid: '', specific: '', fullPath: raw };
  if (parts.length === 1) return { broad: '', mid: '', specific: parts[0], fullPath: raw };
  if (parts.length === 2) return { broad: '', mid: parts[0], specific: parts[1], fullPath: raw };

  // Take innermost 3 layers (user directive: "可以取最里面的三层")
  const specific = parts[parts.length - 1];
  const mid = parts[parts.length - 2];
  const broad = parts[parts.length - 3];

  return { broad, mid, specific, fullPath: raw };
}

// ═══════════════════════════════════════════════════════════
// §2 — Game time formatting
// ═══════════════════════════════════════════════════════════

export interface GameTime {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
}

/**
 * Format game time into a concise description string.
 * Returns time-of-day descriptor based on hour for scene prompts.
 */
export function formatGameTimeForScene(time: GameTime | null | undefined): string {
  if (!time) return '';

  const parts: string[] = [];

  if (time.hour !== undefined) {
    const h = time.hour;
    if (h >= 5 && h < 7) parts.push('黎明');
    else if (h >= 7 && h < 9) parts.push('清晨');
    else if (h >= 9 && h < 12) parts.push('上午');
    else if (h >= 12 && h < 14) parts.push('正午');
    else if (h >= 14 && h < 17) parts.push('下午');
    else if (h >= 17 && h < 19) parts.push('傍晚');
    else if (h >= 19 && h < 22) parts.push('夜晚');
    else parts.push('深夜');
  }

  if (time.month !== undefined) {
    const m = time.month;
    if (m >= 3 && m <= 5) parts.push('春季');
    else if (m >= 6 && m <= 8) parts.push('夏季');
    else if (m >= 9 && m <= 11) parts.push('秋季');
    else parts.push('冬季');
  }

  return parts.join('，');
}

// ═══════════════════════════════════════════════════════════
// §3 — Scene context assembly
// ═══════════════════════════════════════════════════════════

export type SceneCompositionMode = 'pure_landscape' | 'story_snapshot' | 'auto';

export interface SceneNpcDetail {
  name: string;
  appearance?: string;
  bodyDescription?: string;
  outfitStyle?: string;
  description?: string;
}

export interface SceneContext {
  /** Parsed location hierarchy */
  location: LocationHierarchy;
  /** Formatted time-of-day description */
  timeDescription: string;
  /**
   * Weather string — raw value from `世界.天气` (P2 env-tags port, 2026-04-19).
   * Default `"晴"` when missing. Fed directly to image tokenizer as
   * `{{WEATHER}}`.
   */
  weather: string;
  /**
   * Festival name for image mood tokens (P3 env-tags port, 2026-04-19).
   * Empty string when the festival is the default `平日` AND has no
   * customization — treating this as "no decoration tokens needed".
   * Named festivals (元宵节/中秋/除夕) surface decoration / crowd cues
   * via the scene tokenizer.
   */
  festivalName: string;
  /**
   * Environment tag summary — comma-joined 名称 values from `世界.环境`
   * (P3 env-tags port, 2026-04-19). Example: `"暴雨倾盆、泥泞、昏暗"`.
   * Empty string when no environment tags active. Fed to image tokenizer
   * as `{{ENVIRONMENT_TAGS}}` for atmosphere / lighting / ground cues.
   */
  environmentSummary: string;
  /** Names of NPCs present at the current location */
  presentNpcs: string[];
  /** Detailed NPC data for selected characters (appearance, outfit, etc.) */
  npcDetails: SceneNpcDetail[];
  /** The narrative text to generate a scene from */
  narrativeText: string;
  /** User's composition preference */
  compositionMode: SceneCompositionMode;
  /** Extra user requirements */
  extraRequirements: string;
}

/**
 * Build a complete scene context from game state data.
 *
 * This is called by the image service before passing to tokenizeScene.
 * It assembles all relevant game state into a structured context object.
 *
 * P3 env-tags port (2026-04-19): `festival` + `environment` added so image
 * prompts can read the same state the main-round AI writes. See also
 * `deriveFestivalName` and `deriveEnvironmentSummary` below for the
 * defensive normalization logic.
 */
export function buildSceneContext(params: {
  /** Raw narrative text (e.g., last AI response) */
  narrativeText: string;
  /** Player's current location path (·-separated) */
  locationPath: string;
  /** Game time from state tree (世界.时间) */
  gameTime?: GameTime | null;
  /** Weather string from `世界.天气` (default `"晴"`) */
  weather?: string;
  /**
   * Festival object from `世界.节日` — `{名称, 描述, 效果}` shape.
   * Defensively accepts `unknown` because state-tree reads are untyped.
   */
  festival?: unknown;
  /**
   * Environment tag array from `世界.环境` — `Array<{名称,描述,效果}>`.
   * Defensively accepts `unknown` for the same reason.
   */
  environment?: unknown;
  /** List of NPC names present at the player's location */
  presentNpcs?: string[];
  /** Detailed NPC data for selected characters */
  npcDetails?: SceneNpcDetail[];
  /** User's composition choice */
  compositionMode?: SceneCompositionMode;
  /** Extra generation requirements */
  extraRequirements?: string;
}): SceneContext {
  return {
    location: parseLocationHierarchy(params.locationPath),
    timeDescription: formatGameTimeForScene(params.gameTime),
    weather: normalizeWeatherForScene(params.weather),
    festivalName: deriveFestivalName(params.festival),
    environmentSummary: deriveEnvironmentSummary(params.environment),
    presentNpcs: params.presentNpcs ?? [],
    npcDetails: params.npcDetails ?? [],
    narrativeText: (params.narrativeText || '').trim(),
    compositionMode: params.compositionMode ?? 'auto',
    extraRequirements: (params.extraRequirements || '').trim(),
  };
}

/**
 * Normalize weather for scene context. Empty / non-string → `"晴"` fallback
 * matches the schema default so downstream prompts always see a sensible
 * value. Trims whitespace.
 */
function normalizeWeatherForScene(weather: unknown): string {
  if (typeof weather !== 'string') return '晴';
  const trimmed = weather.trim();
  return trimmed.length > 0 ? trimmed : '晴';
}

/**
 * Derive the festival name to expose to image tokenizer.
 *
 * Returns empty string when the festival is the "no decoration" default
 * (`名称 === "平日"` AND both 描述 and 效果 empty). Any customization
 * surfaces the name so the tokenizer can add decoration tokens.
 *
 * Returning empty for 平日 is the correct signal: 平日 means "no special
 * festive atmosphere" → tokenizer should NOT add lantern / crowd tokens.
 *
 * **Note**: parallel logic exists at `src/ui/components/panels/environment/environment-helpers.ts`
 * `isFestivalVisible` (same `平日`-is-default rule). Engine and UI both need
 * this predicate but cannot share code (engine must not import from UI).
 * Any future change to the "default festival" semantics must be applied in
 * both locations — intentional duplication, documented drift risk.
 */
export function deriveFestivalName(festival: unknown): string {
  if (!festival || typeof festival !== 'object') return '';
  const f = festival as Record<string, unknown>;
  const name = typeof f.名称 === 'string' ? f.名称.trim() : '';
  if (!name) return '';
  if (name !== '平日') return name;
  // Name is 平日 — only surface if desc or effect was customized
  const desc = typeof f.描述 === 'string' ? f.描述.trim() : '';
  const effect = typeof f.效果 === 'string' ? f.效果.trim() : '';
  return desc || effect ? name : '';
}

/**
 * Derive comma-joined environment tag summary for image tokenizer.
 *
 * Joins 名称 values with `、` (CJK enumeration comma, matches UI chip
 * convention). Filters malformed entries silently. Empty input / empty
 * after filtering → empty string.
 */
export function deriveEnvironmentSummary(environment: unknown): string {
  if (!Array.isArray(environment)) return '';
  const names: string[] = [];
  for (const raw of environment) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.名称 !== 'string') continue;
    const name = o.名称.trim();
    if (name) names.push(name);
  }
  return names.join('、');
}

// ═══════════════════════════════════════════════════════════
// §4 — Scene response parsing
// ═══════════════════════════════════════════════════════════

import {
  extractLastTagBlock,
  extractFirstMatchingTagContent,
  cleanPromptOutput,
} from './output-processor';

export type SceneType = 'landscape' | 'snapshot';

export interface ParsedSceneResponse {
  sceneType: SceneType;
  judgmentExplanation: string;
  promptContent: string;
}

/**
 * Parse the scene transformer's AI response to extract scene type + prompt content.
 *
 * Parse scene transformer AI response — ported
 *
 * The AI outputs structured tags:
 * - <场景判定>适合场景快照 / 不适合场景快照</场景判定>
 * - <场景类型>场景快照 / 风景场景</场景类型>
 * - <判定说明>...</判定说明>
 * - <提示词结构>...</提示词结构>
 */
export function parseSceneResponse(rawText: string): ParsedSceneResponse {
  const mainPayload = extractAfterLastSceneJudgment(rawText);

  const judgmentText = extractFirstMatchingTagContent(mainPayload, ['场景判定', '判定']);
  const sceneTypeText = extractFirstMatchingTagContent(mainPayload, ['场景类型', '输出类型', '模式']);
  const explanation = extractFirstMatchingTagContent(mainPayload, ['判定说明', '说明', '理由'])
    .replace(/^[•\-]\s*/gm, '')
    .trim();

  const structuredBlock = extractLastTagBlock(mainPayload, '提示词结构');
  const tagContent = extractFirstMatchingTagContent(mainPayload, ['词组', '生图词组']);
  const promptContent = structuredBlock
    || tagContent
    || cleanPromptOutput(mainPayload);

  // Only test judgment + scene type fields, not explanation (which may contain narrative content)
  const judgmentFields = `${judgmentText}\n${sceneTypeText}`;
  const explicitlyNotSnapshot = /不适合场景快照|风景场景|风景|景观|山水|landscape/i.test(judgmentFields);
  const explicitlySnapshot = /适合场景快照|场景快照/i.test(`${judgmentText}\n${sceneTypeText}`)
    && !/不适合/i.test(`${judgmentText}\n${sceneTypeText}`);

  const sceneType: SceneType = explicitlySnapshot && !explicitlyNotSnapshot
    ? 'snapshot'
    : 'landscape';

  return {
    sceneType,
    judgmentExplanation: explanation || (sceneType === 'landscape'
      ? '当前正文缺少足够稳定的单帧画面证据，已优先转为风景背景镜头。'
      : '当前正文具备明确地点、空间关系与可视化细节，可在背景优先前提下生成场景快照。'),
    promptContent,
  };
}

/** Extract text after the last scene judgment tag — ported */
function extractAfterLastSceneJudgment(rawText: string): string {
  const source = rawText || '';
  const regex = /<\s*场景判定\s*>/gi;
  let lastIndex = -1;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(source))) {
    lastIndex = match.index;
  }
  return lastIndex >= 0 ? source.slice(lastIndex) : source;
}
