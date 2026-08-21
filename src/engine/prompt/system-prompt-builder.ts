// App doc: docs/user-guide/pages/game-main.md §3.15.3（世界书注入与配额）
/**
 * SystemPromptBuilder — replaces PromptAssembler with context-piece architecture.
 *
 * Builds named context pieces from game state + prompts + world book,
 * then assembles them into ordered message entries for the API call.
 *
 * Ported from the original systemPromptBuilder (1598 lines)
 * and mainStoryRequest (message assembly).
 *
 * Phase 1: Skeleton with piece definitions and build interface.
 * Phase 2 (Sprint 2): Full implementation of all formatters.
 */
import type { StateManager } from '../core/state-manager';
import type {
  MessageEntry,
  SystemPromptBuildResult,
  WorldBook,
  BuiltinPromptEntry,
  PromptSettings,
} from './world-book';
import { formatHeroinePlanForContext, type HeroinePlan } from '../story/heroine-plan';
import { DEFAULT_PROMPT_SETTINGS, resolveCapturedBudgetRatio } from './world-book';
import { BUILTIN_SLOTS } from './builtin-slots';
import type { EnginePathConfig } from '../pipeline/types';
import {
  buildCorpus,
  buildFocusedCorpus,
  extractPresentNpcNames,
  selectActiveEntriesDetailed,
  buildWorldBookInjectionText,
  formatGameTimeForWorldBook,
  type WorldBookInjectionResult,
} from './world-book-selector';

/**
 * gproxy magic-cache trigger string (1-hour TTL variant). Embedded at the end of
 * the static prefix; gproxy detects it, STRIPS it, and stamps an Anthropic
 * `cache_control` breakpoint on that block (so it never reaches the model).
 * Requires the gproxy provider to have `enable_magic_cache` on. Verified live
 * (write→read on identical prefix, 2026-07-19). Not game content — a proxy
 * protocol constant, engine-legal.
 */
export const GPROXY_CACHE_MAGIC_STRING =
  'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_1FAS5GV9R5H29T5Y2J9584K6O95M2NBVW52C95CX984FRJY';

/**
 * Piece IDs that are byte-stable across rounds within a session — pure pack
 * slots + session-level settings (perspective / word count / story style), never
 * derived from per-round game state. ONLY these are hoisted into the cached
 * prefix. Deliberately EXCLUDES `world_prompt` (carries per-round keyword-matched
 * world-book lore), all `world_map` / `npc_*` / `memory_*` / `state_*` / `wb_*`
 * (state-derived), and `extra_prompt` (user role). Order here is irrelevant —
 * reorder preserves each piece's original insertion order.
 */
export const GPROXY_CACHE_STATIC_PIECE_IDS: ReadonlySet<string> = new Set([
  'ai_role',
  'write_style',
  'write_anti_cliche',
  'write_emotion_guard',
  'write_no_control',
  'perspective_prompt',
  'length_prompt',
  'narrative_constraints',
  'format_prompt',
  'cot_core',
  'cot_judge',
]);

/** Trailing conversation pieces that MUST stay last (the user/assistant turn). */
const GPROXY_CACHE_TAIL_PIECE_IDS: ReadonlySet<string> = new Set([
  'player_input',
  'start_task',
  'cot_masquerade',
]);

/** Parameters for building the system prompt */
export interface SystemPromptBuildParams {
  stateManager: StateManager;
  paths: EnginePathConfig;
  /** Pack prompt content by ID (loaded from manifest.prompts) */
  packPrompts: Record<string, string>;
  /** User-edited built-in prompt overrides */
  builtinOverrides: BuiltinPromptEntry[];
  /** User world books (enabled only) */
  worldBooks: WorldBook[];
  /** Current user input for this round */
  userInput: string;
  /** Player name (for template rendering) */
  playerName: string;
  /** Whether CoT is enabled */
  cotEnabled: boolean;
  /** Whether CoT judge is enabled */
  cotJudgeEnabled: boolean;
  /**
   * Whether split-gen mode is active.
   *
   * Canon Capture is the first real consumer: in split mode step1 writes the prose and
   * step2 emits the structured fields, so step1 gets the AUTHORITY prompt (it must obey
   * the setting this turn) but NOT the capture prompt (it must not be asked for JSON).
   */
  splitGen: boolean;
  /** CoT masquerade pseudo-history prompt */
  cotPseudoEnabled: boolean;
  /**
   * gproxy prompt cache — when true, reorder the guaranteed-static system pieces
   * (pack-slot rules + world base) to the FRONT as one contiguous prefix, then
   * append a gproxy magic-cache trigger string to the last of them so gproxy
   * stamps an Anthropic `cache_control` breakpoint there. Off (default) = no
   * reorder, no marker (identical to legacy output). See [[GPROXY_CACHE_STATIC_PIECE_IDS]].
   */
  gproxyCache?: boolean;
  /** Pre-built engram/unified retrieval block (if hybrid mode active) */
  engramRetrievalBlock?: string;
  /** Implicit mid-term memory entries (from MemoryRetriever) */
  implicitMidTermBlock?: string;
  /** Raw narrative history (last 12 entries, NO XML wrapping) for world book corpus */
  narrativeHistoryForCorpus?: Array<{ content: string }>;
  /**
   * Text of the world event triggered THIS round, if any — part of the focused
   * world-book corpus. Absent when no event fired.
   */
  triggeredEventTexts?: string[];
  /**
   * True when this round carries a well-formed `<设定>` tag AND capture is enabled.
   *
   * Gates the two Canon Capture prompt pieces. When false, not one extra character
   * reaches the model — the feature costs nothing on ordinary rounds.
   */
  settingCaptureActive?: boolean;
}

/**
 * Resolve the effective content for a built-in slot.
 *
 * Priority: user override (from builtinOverrides) > pack default > empty
 */
function resolveSlotContent(
  slotId: string,
  builtinOverrides: BuiltinPromptEntry[],
  packPrompts: Record<string, string>,
): string {
  // 1. Check user override
  const override = builtinOverrides.find((e) => e.slotId === slotId && e.enabled !== false);
  if (override?.userContent != null && override.userContent.trim()) {
    return override.userContent;
  }

  // 2. Check pack default
  const slotDef = BUILTIN_SLOTS[slotId];
  if (slotDef?.defaultPromptId && packPrompts[slotDef.defaultPromptId]) {
    return packPrompts[slotDef.defaultPromptId];
  }

  // 3. Check override content (non-user-edited)
  if (override?.content?.trim()) {
    return override.content;
  }

  return '';
}

/**
 * Render template variables in prompt content.
 * Supports ${playerName} and {{VAR}} syntax.
 */
function renderTemplateVars(content: string, vars: Record<string, string>): string {
  let rendered = content;
  // ${var} syntax
  rendered = rendered.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '');
  // {{VAR}} syntax (AGA style)
  rendered = rendered.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  return rendered;
}

/**
 * Estimate token count for a string.
 * Rough: Chinese chars / 2, English chars / 4, average to chars / 3.
 */
/**
 * Step 3: Apply writing settings — inject word count into write_req prompts.
 * Applies writing settings (word count injection).
 */
function applyWritingSettings(promptId: string, content: string, wordCount: number): string {
  if (promptId !== 'write_req' && promptId !== 'wordCountReq') return content;
  const lengthRule = `<字数>本次<正文>标签内内容必须达到${wordCount}字以上。</字数>`;
  // Replace existing <字数> block if present
  if (/<字数>[\s\S]*?<\/字数>/m.test(content)) {
    return content.replace(/<字数>[\s\S]*?<\/字数>/m, lengthRule);
  }
  return `${content.trim()}\n${lengthRule}`;
}

/**
 * Step 5: Filter by feature toggles — strip PROMPT_FEATURE blocks based on settings.
 * Filters prompt content by feature toggles (按功能开关过滤提示词内容 + 解析功能附加块).
 *
 * Feature blocks are HTML comments: <!-- PROMPT_FEATURE:xxx:START -->...<!-- PROMPT_FEATURE:xxx:END -->
 * If the feature is disabled, the block is removed entirely.
 */
function filterByFeatureToggles(content: string, settings: PromptSettings): string {
  const featureBlockRegex = /<!--\s*PROMPT_FEATURE:([a-z0-9_-]+):START\s*-->([\s\S]*?)<!--\s*PROMPT_FEATURE:\1:END\s*-->/giu;

  const isFeatureEnabled = (featureId: string): boolean => {
    switch (featureId.toLowerCase()) {
      case 'nocontrol': return settings.enableNoControl;
      case 'action_options': return settings.enableActionOptions;
      // Canon Capture must be recognised EXPLICITLY. The `default: true` below means an
      // unknown feature id stays switched on — so relying on it would leave the capture
      // instructions in the prompt even with the feature turned off, breaking the
      // "zero token delta when disabled" guarantee.
      case 'setting_capture': return settings.enableWorldBook && settings.enableSettingCapture;
      default: return true; // unknown features default to enabled
    }
  };

  let result = content;
  let previous = '';
  // Iterative replacement (handles nested blocks)
  while (result !== previous) {
    previous = result;
    result = result.replace(featureBlockRegex, (_match, featureId: string, body: string) =>
      isFeatureEnabled(featureId) ? body.trim() : ''
    );
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Full rendering pipeline for a prompt — 5-step chain:
 * 1. Slot override resolution (done by resolveSlotContent)
 * 2. Template variable replacement
 * 3. Writing settings application (word count)
 * 4. (Realm block replacement — N/A in AGA)
 * 5. Feature toggle filtering
 */
function renderPromptPipeline(
  slotId: string,
  rawContent: string,
  vars: Record<string, string>,
  settings: PromptSettings,
): string {
  if (!rawContent.trim()) return '';
  let content = renderTemplateVars(rawContent, vars);
  content = applyWritingSettings(slotId, content, settings.wordCountRequirement);
  content = filterByFeatureToggles(content, settings);
  return content;
}

/** Estimate token count (rough: chars / 3 average for mixed CJK + English) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

/**
 * Build the system prompt as ordered message entries.
 *
 * This is the MAIN entry point. It:
 * 1. Resolves all built-in slot content (with world book overrides)
 * 2. Reads game state to build dynamic context pieces (NPC, world, player, etc.)
 * 3. Applies prompt settings (perspective, word count)
 * 4. Assembles into ordered MessageEntry[]
 */
export function buildSystemPrompt(params: SystemPromptBuildParams): SystemPromptBuildResult {
  const {
    stateManager,
    paths,
    packPrompts,
    builtinOverrides,
    worldBooks,
    userInput,
    playerName,
    cotEnabled,
    cotJudgeEnabled,
    cotPseudoEnabled,
    // First real consumer of this flag (it was declared but unused until Canon Capture):
    // split-gen step1 must get the authority prompt but NOT the capture prompt.
    splitGen,
    gproxyCache = false,
  } = params;

  const templateVars: Record<string, string> = {
    playerName,
    wordCount: String(params.stateManager.get<number>('系统.设置.prompt.wordCountRequirement') ?? 650),
  };

  // Read prompt settings from state tree
  const rawSettings = stateManager.get<Partial<PromptSettings>>('系统.设置.prompt');
  const settings: PromptSettings = { ...DEFAULT_PROMPT_SETTINGS, ...rawSettings };

  // Helper to resolve + render a slot through the full 5-step pipeline
  const slot = (slotId: string): string => {
    const raw = resolveSlotContent(slotId, builtinOverrides, packPrompts);
    return renderPromptPipeline(slotId, raw, templateVars, settings);
  };

  // Helper to render a raw pack prompt through the pipeline (for prompts not tied to a slot)
  const renderPackPrompt = (promptId: string): string => {
    const raw = packPrompts[promptId] ?? '';
    return renderPromptPipeline(promptId, raw, templateVars, settings);
  };

  // ── Build context pieces ──────────────────────────────────

  const contextPieces: Record<string, string> = {};
  const entries: MessageEntry[] = [];

  const push = (id: string, title: string, category: string, role: 'system' | 'user' | 'assistant', content: string, options?: { isUserInput?: boolean }) => {
    const trimmed = (content || '').trim();
    if (!trimmed) return;
    contextPieces[id] = trimmed;
    entries.push({ id, title, category, role, content: trimmed, isUserInput: options?.isUserInput });
  };

  // ── 1. AI Role Declaration ──
  push('ai_role', 'AI角色声明', '系统', 'system', slot('narrator_role'));

  // ── 2. World Prompt (world info + world book lore) ──
  const worldSelection = stateManager.get<Record<string, unknown>>('world');
  const worldInfo = stateManager.get<Record<string, unknown>>('世界.信息');
  const worldName = (worldSelection?.['name'] ?? worldInfo?.['世界名称'] ?? '') as string;
  const aiWorldDesc = stateManager.get<string>(paths.worldDescription) ?? '';
  const selectionDesc = (worldSelection?.['description'] ?? worldInfo?.['世界背景'] ?? worldInfo?.['描述'] ?? '') as string;
  const worldDesc = aiWorldDesc || selectionDesc;

  // Shared state reads (used by world book corpus + NPC sections + environment)
  const relationships = stateManager.get<Array<Record<string, unknown>>>(paths.relationships) ?? [];
  const currentLocation = stateManager.get<string>(paths.playerLocation) ?? '';
  const npcNameKey = paths.npcFieldNames?.name ?? '名称';

  // World Book injection (all 4 types) — gated by enableWorldBook
  const worldBookEnabled = settings.enableWorldBook !== false && worldBooks.length > 0;
  let wbResult: WorldBookInjectionResult | undefined;
  let worldBookHits: SystemPromptBuildResult['worldBookHits'];
  let worldBookSkipped: SystemPromptBuildResult['worldBookSkipped'];
  let capturedHits: SystemPromptBuildResult['capturedHits'];
  let worldBookBudget: SystemPromptBuildResult['worldBookBudget'];

  if (worldBookEnabled) {
    const worldEvents = stateManager.get<unknown[]>(paths.worldEvents) ?? [];
    const gameTime = stateManager.get<unknown>(paths.gameTime);
    // B0-2: `世界.时间` is an OBJECT, but this builder used to hand the selector
    // `typeof gameTime === 'string' ? gameTime : ''` — i.e. always '' — which made
    // `isTimelineMatch()` reject EVERY timeline-scoped entry. Format it properly.
    const gameTimeText = formatGameTimeForWorldBook(gameTime, paths.gameTimeFieldNames);

    // NOTE (code review 2026-08-21): the formatted value is deliberately NOT fed into
    // the keyword corpus. `YYYY:MM:DD:HH:MM` is a MACHINE format for `isTimelineMatch`;
    // the corpus is human-readable text matched with `corpus.includes(keyword)`. Putting
    // a digit string that is present every single round into the corpus would make any
    // world-book keyword containing a short numeric substring ("01", "15", …) match
    // unconditionally, forever. The corpus keeps its previous behavior here (the raw
    // object is coerced to '' by `textOf()`), so B0-2 changes timeline matching only.
    const corpus = buildCorpus({
      environment: {
        location: currentLocation,
        weather: stateManager.get<unknown>(paths.weather),
        time: gameTime,
      },
      socialNpcs: relationships,
      npcFieldKeys: {
        name: paths.npcFieldNames?.name,
        identity: paths.npcFieldNames?.description,
        relation: paths.npcFieldNames?.type,
        location: paths.npcFieldNames?.location,
      },
      narrativeHistory: params.narrativeHistoryForCorpus,
      worldEvents,
      // Fixes "the keyword fires one round late": the corpus previously held only
      // state and PAST narrative, so a keyword the player just typed could not match
      // until the next round. `userInput` (action-queue prefix included — panel
      // actions are real round content) closes that gap for BOTH corpora.
      extraTexts: [userInput],
    });

    // Focused corpus — only this round's signal. Auto-captured entries match against
    // this so that a character setting does not become a permanent resident merely
    // because its NPC exists somewhere in the social table.
    const focused = buildFocusedCorpus({
      userInput,
      location: currentLocation,
      presentNpcNames: extractPresentNpcNames(
        relationships,
        paths.npcFieldNames?.name ?? '名称',
        paths.npcFieldNames?.isPresent ?? '是否在场',
      ),
      triggeredEventTexts: params.triggeredEventTexts,
    });

    const selection = selectActiveEntriesDetailed({
      books: worldBooks,
      activeScopes: ['main'],
      corpora: { broad: corpus, focused },
      currentGameTime: gameTimeText,
      capturedBudgetRatio: resolveCapturedBudgetRatio(settings.capturedEntryBudgetRatio),
    });
    const selected = selection.selected;

    wbResult = buildWorldBookInjectionText(selected);
    // Attribution comes straight from the selector, which still had the book in hand.
    // Do NOT re-derive it by looking the entry id up across books: ids are only unique
    // WITHIN a book, so a collision would silently mislabel an entry's origin/pool.
    worldBookHits = selection.selectedInfo.map(({ entry, bookId, origin, matchSource }) => ({
      entryId: entry.id,
      title: entry.title,
      type: entry.type,
      matchedKeywords: entry.injectionMode === 'match_any' ? entry.keywords : undefined,
      bookId,
      origin,
      matchSource,
    }));
    worldBookSkipped = selection.skipped;
    capturedHits = selection.capturedHits;
    worldBookBudget = {
      budget: selection.budget,
      userChars: selection.userChars,
      capturedChars: selection.capturedChars,
      capturedCap: selection.capturedCap,
      unlimited: selection.unlimited,
    };
  }

  const worldPrompt = [
    worldName ? `世界名称：${worldName}` : '',
    worldDesc ? `\n世界总览\n${worldDesc}` : '',
    wbResult?.worldLoreText ?? '',
  ].filter(Boolean).join('\n\n');
  push('world_prompt', '世界观提示词', '系统', 'system', worldPrompt);

  // ── 3. Map & Buildings ──
  const locationInfo = stateManager.get<unknown[]>('世界.地点信息');
  if (Array.isArray(locationInfo) && locationInfo.length > 0) {
    const mapText = `【地图与建筑】\n当前具体地点: ${currentLocation}\n地图列表:\n${locationInfo.map((l) => `- ${JSON.stringify(l)}`).join('\n')}`;
    push('world_map', '地图与建筑', '系统', 'system', mapText);
  }

  // ── 4. Off-scene NPCs ──
  const offSceneNpcs = relationships.filter((npc) => npc['是否在场'] !== true);
  if (offSceneNpcs.length > 0) {
    const offSceneText = `【以下为不在场角色】(源于社交)\n${offSceneNpcs.map((npc, i) => {
      const name = npc[npcNameKey] ?? '?';
      const gender = npc['性别'] ?? '';
      const relation = npc['与玩家关系'] ?? '';
      const affinity = npc['好感度'] ?? 50;
      const desc = npc['描述'] ?? '';
      const isMajor = npc['是否主要角色'] ? '是' : '否';
      return `- [${i}] 姓名: ${name}\n  性别: ${gender}\n  关系状态: ${relation}\n  好感度: ${affinity}\n  简介: ${String(desc).slice(0, 100)}\n  是否主要角色: ${isMajor}`;
    }).join('\n')}`;
    push('npc_away', '以下为不在场角色', '系统', 'system', offSceneText);
  }

  // ── 5. Other Prompts (world book system_rule / command_rule / output_rule) ──
  if (wbResult?.systemRuleText) {
    push('wb_system_rules', '世界书系统规则', '系统', 'system', wbResult.systemRuleText);
  }
  if (wbResult?.commandRuleText) {
    push('wb_command_rules', '世界书命令规则', '系统', 'system', wbResult.commandRuleText);
  }

  // ── 5b. Writing prompts (style, emotion guard, noControl) ──
  push('write_style', '写作文风', '系统', 'system', slot('write_style'));
  push('write_anti_cliche', '反八股文', '系统', 'system', slot('write_anti_cliche'));
  push('write_emotion_guard', '避免极端情绪', '系统', 'system', slot('write_emotion_guard'));
  if (settings.enableNoControl) {
    push('write_no_control', '禁止操控玩家', '系统', 'system', slot('write_no_control'));
  }

  // ── 6. Perspective Prompt ──
  const perspectiveMap: Record<string, string> = {
    '第一人称': 'write_perspective_first',
    '第二人称': 'write_perspective_second',
    '第三人称': 'write_perspective_third',
  };
  const perspectiveSlotId = perspectiveMap[settings.perspective] ?? 'write_perspective_second';
  push('perspective_prompt', '叙事人称提示词', '系统', 'system', slot(perspectiveSlotId));

  // ── 7. Word Count ──
  const wordCountContent = slot('write_req') ||
    `【字数要求】\n<字数>本次<正文>标签内内容必须达到${settings.wordCountRequirement}字以上。</字数>\n- 正文指 \`<正文>\` 中除【判定】外的叙事与对白总和。`;
  push('length_prompt', '字数要求提示词', '系统', 'system', wordCountContent);

  // ── 8. Long-term Memory ──
  const longTerm = stateManager.get<Array<{ content: string; category?: string }>>('记忆.长期') ?? [];
  if (longTerm.length > 0) {
    const longText = `【长期记忆】\n${longTerm.map((e) => `${e.category ? `[${e.category}] ` : ''}${e.content}`).join('\n')}`;
    push('memory_long', '长期记忆', '记忆', 'system', longText);
  } else {
    push('memory_long', '长期记忆', '记忆', 'system', '【长期记忆】\n暂无');
  }

  // ── 9. Mid-term Memory ──
  const midTerm = stateManager.get<Array<Record<string, unknown>>>('记忆.中期') ?? [];
  if (midTerm.length > 0) {
    const midText = `【中期记忆】\n${midTerm.map((e) => {
      const roles = Array.isArray(e['相关角色']) ? `【相关角色: ${(e['相关角色'] as string[]).join('、')}】` : '';
      const time = e['事件时间'] ? `【${e['事件时间']}】` : '';
      const body = e['记忆主体'] ?? '';
      return `${roles}${time}${body}`;
    }).join('\n')}`;
    push('memory_mid', '中期记忆', '记忆', 'system', midText);
  } else {
    push('memory_mid', '中期记忆', '记忆', 'system', '【中期记忆】\n暂无');
  }

  // ── 9b. Implicit Mid-term Memory ──
  if (params.implicitMidTermBlock?.trim()) {
    push('memory_implicit', '隐式中期记忆', '记忆', 'system', `【隐式记忆（AI 标记）】\n${params.implicitMidTermBlock}`);
  }

  // ── 9c. Engram / Unified Retrieval ──
  if (params.engramRetrievalBlock?.trim()) {
    push('memory_engram', 'Engram · 事实/实体/事件', '记忆', 'system', `# Engram 知识图谱检索\n${params.engramRetrievalBlock}`);
  }

  // ── 10. Story Plan ──
  const storyPlan = stateManager.get<string>(paths.storyPlan) ?? '';
  push('story_plan', '剧情安排', '系统', 'system',
    storyPlan ? `【剧情安排】\n${storyPlan}` : '【剧情安排】\n暂无');

  // ── 11. On-scene NPCs ──
  const onSceneNpcs = relationships.filter((npc) => npc['是否在场'] === true);
  if (onSceneNpcs.length > 0) {
    const onSceneText = `【以下为在场角色】(源于社交)\n${onSceneNpcs.map((npc, i) => {
      const name = npc[npcNameKey] ?? '?';
      const gender = npc['性别'] ?? '';
      const identity = npc['身份'] ?? npc['描述'] ?? '';
      const relation = npc['与玩家关系'] ?? '';
      const affinity = npc['好感度'] ?? 50;
      const desc = npc['描述'] ?? '';
      const personality = Array.isArray(npc['性格特征']) ? (npc['性格特征'] as string[]).join('、') : '';
      const isMajor = npc['是否主要角色'] ? '是' : '否';
      const memory = Array.isArray(npc['记忆']) ? (npc['记忆'] as Array<string | Record<string, unknown>>).slice(-3).map((m) => typeof m === 'string' ? m : (m as Record<string, unknown>)['内容'] ?? m).join('\n    ') : '';
      return `- [${i}] 姓名: ${name}\n  性别: ${gender}\n  身份: ${identity}\n  关系状态: ${relation}\n  好感度: ${affinity}\n  简介: ${String(desc).slice(0, 200)}\n  核心性格特征: ${personality}\n  是否主要角色: ${isMajor}${memory ? `\n  记忆 (最近3条):\n    ${memory}` : ''}`;
    }).join('\n')}`;
    push('npc_present', '以下为在场角色', '系统', 'system', onSceneText);
  }

  // ── 12. Heroine Plan (uses structured formatter) ──
  const heroinePlanRaw = stateManager.get<HeroinePlan>('元数据.女主规划');
  if (heroinePlanRaw) {
    const formattedPlan = formatHeroinePlanForContext(heroinePlanRaw);
    if (formattedPlan) {
      push('heroine_plan', '女主剧情规划', '系统', 'system', formattedPlan);
    }
  }

  // ── 13. World State ──
  {
    const worldDesc = stateManager.get<string>('世界.描述') ?? '';
    const weather = stateManager.get<unknown>(paths.weather);
    const festival = stateManager.get<unknown>(paths.festival);
    const worldEvents = stateManager.get<unknown[]>(paths.worldEvents) ?? [];
    const worldParts: string[] = [];
    if (worldDesc) worldParts.push(`描述: ${worldDesc}`);
    if (weather) worldParts.push(`天气: ${typeof weather === 'string' ? weather : JSON.stringify(weather)}`);
    if (festival && typeof festival === 'object') {
      const f = festival as Record<string, unknown>;
      if (f['名称'] && f['名称'] !== '平日') worldParts.push(`节日: ${JSON.stringify(festival)}`);
    }
    if (worldEvents.length > 0) worldParts.push(`世界事件: ${JSON.stringify(worldEvents.slice(-5))}`);
    push('state_world', '世界', '系统', 'system',
      worldParts.length > 0 ? `【世界】\n${worldParts.join('\n')}` : '【世界】\n无');
  }

  // ── 14. Environment State ──
  {
    const gameTime = stateManager.get<unknown>(paths.gameTime);
    const envTags = stateManager.get<unknown>(paths.environmentTags);
    const envParts: string[] = [];
    if (gameTime) envParts.push(`时间: ${JSON.stringify(gameTime)}`);
    envParts.push(`当前位置: ${currentLocation}`);
    if (envTags) envParts.push(`环境: ${JSON.stringify(envTags)}`);
    push('state_environment', '当前环境', '系统', 'system', `【当前环境】\n${envParts.join('\n')}`);
  }

  // ── 15. Player State ──
  const playerIdentity = stateManager.get<Record<string, unknown>>('角色.基础信息') ?? {};
  const playerAttrs = stateManager.get<Record<string, unknown>>('角色.属性');
  const playerBody = stateManager.get<unknown>('角色.身体');
  const playerEffects = stateManager.get<unknown>('角色.效果');
  const roleParts = [];
  roleParts.push(`姓名: ${playerName}`);
  if (playerIdentity['性别']) roleParts.push(`性别: ${playerIdentity['性别']}`);
  if (playerIdentity['年龄']) roleParts.push(`年龄: ${playerIdentity['年龄']}`);
  if (playerIdentity['描述']) roleParts.push(`描述: ${playerIdentity['描述']}`);
  if (playerAttrs) roleParts.push(`属性: ${JSON.stringify(playerAttrs)}`);
  if (playerBody) roleParts.push(`身体: ${JSON.stringify(playerBody)}`);
  if (playerEffects) roleParts.push(`效果: ${JSON.stringify(playerEffects)}`);
  push('state_role', '用户角色数据', '系统', 'system', `【用户角色数据】\n${roleParts.join('\n')}`);

  // ── 16. (Sect removed — not in AGA scope per user directive) ──

  // ── 17. Task List ──
  const tasks = stateManager.get<unknown[]>('社交.任务');
  push('state_tasks', '任务列表', '系统', 'system',
    Array.isArray(tasks) && tasks.length > 0 ? `【任务列表】\n${JSON.stringify(tasks, null, 2)}` : '【任务列表】\n无');

  // ── 18. Agreement List ──
  const agreements = stateManager.get<unknown[]>('社交.约定');
  push('state_agreements', '约定列表', '系统', 'system',
    Array.isArray(agreements) && agreements.length > 0 ? `【约定列表】\n${JSON.stringify(agreements, null, 2)}` : '【约定列表】\n无');

  // ── 19. Short-term Memory (即时剧情回顾) — returned separately ──
  const shortTerm = stateManager.get<Array<{ summary: string; round?: number }>>('记忆.短期') ?? [];
  const shortMemoryContext = shortTerm.length > 0
    ? `【即时剧情回顾】\n${shortTerm.map((e) => typeof e === 'string' ? e : (e.summary ?? '')).join('\n')}`
    : '';

  // ── 20. Narrative Constraints + Story Style (radio group: one active at a time) ──
  const constraintsBase = slot('narrative_constraints');
  const storyStyleMap: Record<string, string> = {
    general: 'storyStyleGeneral',
    harem: 'storyStyleHarem',
    pureLove: 'storyStylePureLove',
    cultivation: 'storyStyleCultivation',
    shura: 'storyStyleShura',
    ntlHarem: 'storyStyleNtlHarem',
  };
  const stylePromptId = storyStyleMap[settings.storyStyle] ?? 'storyStyleGeneral';
  const styleContent = renderPackPrompt(stylePromptId);
  const fullConstraints = [constraintsBase, styleContent ? `\n\n【剧情风格偏好】\n${styleContent}` : ''].filter(Boolean).join('');
  push('narrative_constraints', '叙事总约束 + 风格偏好', '系统', 'system', fullConstraints);

  // ── 21. Extra Prompt ──
  if (settings.customSystemPrompt?.trim()) {
    push('extra_prompt', '额外要求提示词', '用户', 'user', settings.customSystemPrompt.trim());
  }

  // ── 22. Format/Output Protocol ──
  push('format_prompt', '输出格式提示词', '系统', 'system', slot('format_prompt'));

  // ── 22a. Canon Capture (only when THIS round carries a <设定> tag) ──
  //
  // Both pieces are DYNAMIC and must stay out of `GPROXY_CACHE_STATIC_PIECE_IDS`:
  // they appear only on tagged rounds, so putting them in the "guaranteed static"
  // cache prefix would invalidate the whole prefix every time a player marks a
  // setting. A round with no tag emits neither, keeping the prompt byte-identical
  // to what it was before this feature existed.
  if (params.settingCaptureActive) {
    // step1 of split-gen writes the narrative → it needs to know the tag is
    // authoritative, but must not be asked to emit structured fields.
    push('setting_authority', '作者设定标记', '系统', 'system', slot('setting_authority'));
    if (!splitGen) {
      push('setting_capture', '设定提取协议', '系统', 'system', slot('setting_capture'));
    }
  }

  // ── 22b. World Book Output Rules (after format prompt) ──
  if (wbResult?.outputRuleText) {
    push('wb_output_rules', '世界书输出规则', '系统', 'system', wbResult.outputRuleText);
  }

  // ── 23. CoT ──
  if (cotEnabled) {
    push('cot_core', 'COT提示词', '系统', 'system', slot('main_cot'));
    if (cotJudgeEnabled) {
      push('cot_judge', '判定COT提示词', '系统', 'system', slot('main_cot_judge'));
    }
  }

  // ── 24. Player Input (as assistant message) ──
  push('player_input', '最新用户输入', '助手', 'assistant',
    `以下是用户最新输入内容：\n<用户输入>${userInput}</用户输入>`,
    { isUserInput: true });

  // ── 25. Start Task (as user message) ──
  push('start_task', '开始任务', '用户', 'user', '开始任务');

  // ── 26. CoT Masquerade (as assistant prefill) ──
  if (cotEnabled && cotPseudoEnabled) {
    push('cot_masquerade', 'COT伪装历史消息', '助手', 'assistant', slot('cot_masquerade'));
  }

  // ── Build runtime prompt states ──
  const runtimePromptStates: Record<string, boolean> = {};
  for (const [key] of Object.entries(BUILTIN_SLOTS)) {
    runtimePromptStates[key] = !!contextPieces[key];
  }

  return {
    contextPieces,
    // gproxy cache: hoist static prefix to front + append magic string. Off = unchanged.
    messageEntries: gproxyCache ? applyGproxyCacheReorder(entries) : entries,
    shortMemoryContext,
    runtimePromptStates,
    worldBookHits,
    worldBookSkipped,
    capturedHits,
    worldBookBudget,
  };
}

/**
 * Reorder message entries for gproxy prompt caching: move the guaranteed-static
 * system pieces ([[GPROXY_CACHE_STATIC_PIECE_IDS]]) to the FRONT as one contiguous
 * cacheable prefix, keep every other piece (dynamic system + user-role extras) in
 * original relative order, and keep the trailing conversation turn last. The
 * [[GPROXY_CACHE_MAGIC_STRING]] is appended to the LAST static piece so gproxy
 * stamps the cache breakpoint covering the whole static block.
 *
 * Relative order WITHIN each group is preserved (stable partition). Returns new
 * entry objects (the marked one gets a fresh `content`); input array untouched.
 * No-op (returns a shallow copy) when there are no static pieces to hoist.
 *
 * Pure function — exported for unit testing.
 */
export function applyGproxyCacheReorder(entries: MessageEntry[]): MessageEntry[] {
  const staticEntries: MessageEntry[] = [];
  const dynamicEntries: MessageEntry[] = [];
  const tailEntries: MessageEntry[] = [];

  for (const e of entries) {
    if (GPROXY_CACHE_STATIC_PIECE_IDS.has(e.id)) staticEntries.push(e);
    else if (GPROXY_CACHE_TAIL_PIECE_IDS.has(e.id)) tailEntries.push(e);
    else dynamicEntries.push(e);
  }

  if (staticEntries.length === 0) return [...entries]; // nothing to hoist/cache

  // Append the magic string to the LAST static piece → breakpoint covers the block.
  const lastIdx = staticEntries.length - 1;
  staticEntries[lastIdx] = {
    ...staticEntries[lastIdx],
    content: `${staticEntries[lastIdx].content}\n${GPROXY_CACHE_MAGIC_STRING}`,
  };

  return [...staticEntries, ...dynamicEntries, ...tailEntries];
}
