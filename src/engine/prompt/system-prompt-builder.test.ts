import { describe, it, expect } from 'vitest';
import { estimateTokens, buildSystemPrompt, GPROXY_CACHE_STATIC_PIECE_IDS } from './system-prompt-builder';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { createMockStateManager } from '../__test-utils__';
import type { StateManager } from '../core/state-manager';
import type { WorldBook, WorldBookEntry } from './world-book';

describe('phase-selected default format', () => {
  function build(formatPromptId?: string, edits: Record<string, string> = {}) {
    const { sm } = createMockStateManager({});
    return buildSystemPrompt({ stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS, packPrompts: { mainRound: 'single', splitGenStep1: 'narrative', ...edits },
      worldBooks: [], userInput: 'hello', playerName: 'player',
      cotEnabled: false, cotJudgeEnabled: false, splitGen: true, cotPseudoEnabled: false,
      formatPromptId, transformPrompt: (id, raw) => `${id}:${raw}` });
  }
  it('routes the default through its own module transform, leaving the legacy default intact', () => {
    expect(build().contextPieces.format_prompt).toBe('mainRound:single');
    expect(build('splitGenStep1').contextPieces.format_prompt).toBe('splitGenStep1:narrative');
  });
  // PO 2026-10-04 (P7): the story request sends the prompt as the player left it on the prompt page.
  it('sends the player\'s edit of the format the round uses, through that prompt\'s own transform', () => {
    expect(build('splitGenStep1', { splitGenStep1: 'custom' }).contextPieces.format_prompt).toBe('splitGenStep1:custom');
    expect(build(undefined, { mainRound: 'custom' }).contextPieces.format_prompt).toBe('mainRound:custom');
  });
  it('sends no piece for a slot whose prompt the player switched off', () => {
    const { sm } = createMockStateManager({});
    const on = buildSystemPrompt({ stateManager: sm as unknown as StateManager, paths: DEFAULT_ENGINE_PATHS,
      packPrompts: { mainRound: 'f', narratorFrame: 'NARRATOR', writeStyle: 'STYLE' }, worldBooks: [], userInput: 'hi', playerName: 'p',
      cotEnabled: false, cotJudgeEnabled: false, splitGen: false, cotPseudoEnabled: false });
    const off = buildSystemPrompt({ stateManager: sm as unknown as StateManager, paths: DEFAULT_ENGINE_PATHS,
      packPrompts: { mainRound: 'f', narratorFrame: '', writeStyle: 'STYLE' }, worldBooks: [], userInput: 'hi', playerName: 'p',
      cotEnabled: false, cotJudgeEnabled: false, splitGen: false, cotPseudoEnabled: false });
    expect(on.contextPieces.ai_role).toContain('NARRATOR');
    expect(off.contextPieces.ai_role).toBeUndefined();
    expect(JSON.stringify(off.messageEntries)).not.toContain('NARRATOR');
    expect(JSON.stringify(off.messageEntries)).toContain('STYLE');
  });
  it('does not silently drop the format when the selected module is missing', () => {
    expect(() => build('missing')).toThrow('Missing format prompt: missing');
  });
});

// PO 2026-10-03: the player's action-options switch and word count reach the builder's request.
describe('buildSystemPrompt · action options and word count', () => {
  function build(prompt: Record<string, unknown> | undefined,
    opts: { formatPromptId?: string; actionOptionsBlock?: string; wordCountReq?: string } = {}) {
    const { sm } = createMockStateManager(prompt === undefined ? {} : { 系统: { 设置: { prompt } } });
    const { wordCountReq, ...rest } = opts;
    return buildSystemPrompt({ stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: { mainRound: 'format {{wordCount}}', splitGenStep1: 'narrative only', actionOptionsOff: 'OFF NOTE',
        ...(wordCountReq === undefined ? {} : { wordCountReq }) },
      worldBooks: [], userInput: 'hello', playerName: 'player',
      cotEnabled: false, cotJudgeEnabled: false, splitGen: false, cotPseudoEnabled: false, ...rest });
  }
  const ids = (r: ReturnType<typeof build>) => Object.keys(r.contextPieces);

  it('off: the note follows the default format, which asks for options; on, nothing is added', () => {
    const off = build({ enableActionOptions: false });
    expect(off.contextPieces.action_options_off).toBe('OFF NOTE');
    expect(ids(off).indexOf('action_options_off')).toBe(ids(off).indexOf('format_prompt') + 1);
    expect(build({ enableActionOptions: true }).contextPieces.action_options_off).toBeUndefined();
    expect(build(undefined).contextPieces.action_options_off).toBeUndefined();
  });
  it('a format the round selected (the narrative alone) needs no note', () => {
    expect(build({ enableActionOptions: false }, { formatPromptId: 'splitGenStep1' }).contextPieces.action_options_off).toBeUndefined();
  });
  it('a damaged switch counts as on, the default, so no reader sees it differently', () => {
    for (const value of [null, 0, '', 'false']) {
      expect(build({ enableActionOptions: value }).contextPieces.action_options_off).toBeUndefined();
    }
  });
  it('a single call carries the options module it is given, after the format', () => {
    const on = build({ enableActionOptions: true }, { actionOptionsBlock: 'STORY MODULE slow' });
    expect(on.contextPieces.action_options).toBe('STORY MODULE slow');
    expect(ids(on).indexOf('action_options')).toBeGreaterThan(ids(on).indexOf('format_prompt'));
  });
  it('a length module written for the band keeps its own words; an old minimum or a fixed number is replaced', () => {
    const band = '【Length】\n<字数>about {{wordCount}} characters, between {{wordCountMin}} and {{wordCountMax}}.</字数>';
    expect(build({ wordCountRequirement: 2500 }, { wordCountReq: band }).contextPieces.length_prompt)
      .toBe('【Length】\n<字数>about 2500 characters, between 2000 and 3000.</字数>');
    // A target of 150 inside "1500" must not pass for the current setting.
    for (const old of ['<字数>本次正文必须达到${wordCount}字以上。</字数>', '<字数>本次正文必须达到1500字以上。</字数>']) {
      const piece = build({ wordCountRequirement: 150 }, { wordCountReq: `【字数要求】\n${old}` }).contextPieces.length_prompt;
      expect(piece).toBe('【字数要求】\n<字数>本回合正文约 150 字，控制在 120–180 字之间。</字数>');
    }
    // A module with no block of its own gets the rule after it.
    expect(build({ wordCountRequirement: 800 }, { wordCountReq: '【字数要求】' }).contextPieces.length_prompt)
      .toBe('【字数要求】\n<字数>本回合正文约 800 字，控制在 640–960 字之间。</字数>');
  });
  it('the length rule asks for the player\'s target and its band (a fifth either way), not a minimum', () => {
    expect(build({ wordCountRequirement: 2500 }).contextPieces.length_prompt).toContain('约 2500 字，控制在 2000–3000 字之间');
    expect(build({ wordCountRequirement: 650 }).contextPieces.length_prompt).toContain('约 650 字，控制在 520–780 字之间');
    expect(build({ wordCountRequirement: 2500 }).contextPieces.length_prompt).not.toContain('以上');
  });
  it('the format and the length rule state the player\'s word count, or the default when it is unusable', () => {
    expect(build({ wordCountRequirement: 2500 }).contextPieces.format_prompt).toBe('format 2500');
    for (const value of [null, 0, 0.4, -5, 'abc']) {
      expect(build({ wordCountRequirement: value }).contextPieces.format_prompt).toBe('format 650');
    }
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for null/undefined input', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('estimates tokens as ceil(length / 3)', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('abcdefg')).toBe(3);
  });

  it('handles CJK text', () => {
    expect(estimateTokens('天命修仙')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(2);
  });

  it('handles mixed CJK and English', () => {
    const text = 'Hello 天命';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 3));
  });

  it('handles long strings', () => {
    const text = 'a'.repeat(3000);
    expect(estimateTokens(text)).toBe(1000);
  });
});

// ─── B0-2 integration: timeline world book entries reach the main-round prompt ───
//
// Unit-testing `formatGameTimeForWorldBook` proves the formatter; this proves the
// WIRING — that `buildSystemPrompt` feeds the formatted value to the selector and
// the entry actually lands in a context piece. Before the fix the builder passed
// `typeof gameTime === 'string' ? gameTime : ''` and every timeline entry vanished.
describe('buildSystemPrompt · world book timeline wiring (B0-2)', () => {
  function makeBook(): WorldBook {
    return {
      id: 'b1',
      title: 'Lore',
      enabled: true,
      entries: [{
        id: 'festival',
        title: '灯节',
        content: '城中正在举办灯节，夜市通宵不歇。',
        type: 'world_lore',
        scope: ['main'],
        injectionMode: 'always',
        shape: 'time_injection',
        timelineStart: '0001:01:10:00:00',
        timelineEnd: '0001:01:20:00:00',
        enabled: true,
      }],
    };
  }

  function build(gameTime: unknown) {
    const { sm } = createMockStateManager({
      世界: { 时间: gameTime, 信息: {}, 描述: '一个测试世界' },
      角色: { 基础信息: { 姓名: '林月', 当前位置: '城南' } },
      系统: { 设置: { prompt: { enableWorldBook: true } } },
    });
    return buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: {},
      worldBooks: [makeBook()],
      userInput: '我走进夜市。',
      playerName: '林月',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: false,
      cotPseudoEnabled: false,
    });
  }

  it('injects a timeline entry when the game time falls inside its range', () => {
    const result = build({ 年: 1, 月: 1, 日: 15, 小时: 8, 分钟: 30 });
    expect(result.worldBookHits?.map((h) => h.entryId)).toContain('festival');
    expect(result.contextPieces['world_prompt']).toContain('城中正在举办灯节');
  });

  it('does NOT inject it when the game time is outside the range', () => {
    const result = build({ 年: 1, 月: 3, 日: 1, 小时: 0, 分钟: 0 });
    expect(result.worldBookHits?.map((h) => h.entryId) ?? []).not.toContain('festival');
  });

  it('does NOT inject it when the game time is unusable (unknown time → no match)', () => {
    const result = build(undefined);
    expect(result.worldBookHits?.map((h) => h.entryId) ?? []).not.toContain('festival');
  });
});

// ─── P0: two-pool budget + focused corpus wiring, through the real builder ───

describe('buildSystemPrompt · world book pools & corpora (P0)', () => {
  function build(over: {
    worldBooks: WorldBook[];
    npcs?: Array<Record<string, unknown>>;
    userInput?: string;
    ratio?: number;
    triggeredEventTexts?: string[];
  }) {
    const { sm } = createMockStateManager({
      世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
      社交: { 关系: over.npcs ?? [] },
      角色: { 基础信息: { 姓名: '主角', 当前位置: '城南' } },
      系统: {
        设置: {
          prompt: {
            enableWorldBook: true,
            ...(over.ratio !== undefined ? { capturedEntryBudgetRatio: over.ratio } : {}),
          },
        },
      },
    });
    return buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: {},
      worldBooks: over.worldBooks,
      userInput: over.userInput ?? '我走进夜市。',
      playerName: '主角',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: false,
      cotPseudoEnabled: false,
      triggeredEventTexts: over.triggeredEventTexts,
    });
  }

  const lore = (over: Partial<WorldBookEntry> = {}): WorldBookEntry => ({
    id: 'e', title: 'T', content: 'C', type: 'world_lore', scope: ['main'],
    injectionMode: 'always', enabled: true, ...over,
  });

  const capturedBookOf = (entries: WorldBookEntry[]): WorldBook => ({
    id: 'system_captured_settings',
    title: '自动设定集',
    enabled: true,
    ownership: 'slot',
    origin: 'system-captured',
    entries,
  });

  // Plot Threads §7.3 — WIRING: the focus node's text must reach both corpora so a
  // Canon entry keyed on a plot noun is selected while that node is active.
  it('the focus plot node text feeds the world-book corpora (focused + broad)', () => {
    const plotTree = (title: string) => ({
      元数据: { 剧情导向: { activeArcIndex: 0, focusArcId: 'f', arcs: [{
        id: 'f', title: 'T', synopsis: '', status: 'active', gauges: [],
        nodes: [{ id: 'n', arcId: 'f', title, narrativeGoal: '', directive: '', completionHint: '', completionConditions: [],
          completionMode: 'hint_only', activationConditions: [], importance: 'skippable', opportunityTiers: [], status: 'active', consecutiveReachedCount: 0 }],
      }] } },
    });
    const captured = capturedBookOf([{ ...lore({ id: 'cap', keywords: ['禁药'], injectionMode: 'match_any' }), matchSource: 'focused' }]);
    const manual: WorldBook = { id: 'm', title: 'M', enabled: true, entries: [lore({ id: 'man', keywords: ['禁药'], injectionMode: 'match_any' })] };

    const { sm: off } = createMockStateManager({ ...plotTree('模拟考异常'), 系统: { 设置: { prompt: { enableWorldBook: true } } }, 世界: { 时间: {}, 信息: {}, 描述: 'w' }, 社交: { 关系: [] }, 角色: { 基础信息: { 姓名: '主角', 当前位置: '城南' } } });
    const without = buildSystemPrompt({ stateManager: off as unknown as StateManager, paths: DEFAULT_ENGINE_PATHS, packPrompts: {}, worldBooks: [captured, manual], userInput: '走路', playerName: '主角', cotEnabled: false, cotJudgeEnabled: false, splitGen: false, cotPseudoEnabled: false });
    expect(without.worldBookHits?.map((h) => h.entryId) ?? []).toEqual([]);

    const { sm: on } = createMockStateManager({ ...plotTree('发现禁药秘密'), 系统: { 设置: { prompt: { enableWorldBook: true } } }, 世界: { 时间: {}, 信息: {}, 描述: 'w' }, 社交: { 关系: [] }, 角色: { 基础信息: { 姓名: '主角', 当前位置: '城南' } } });
    const withNode = buildSystemPrompt({ stateManager: on as unknown as StateManager, paths: DEFAULT_ENGINE_PATHS, packPrompts: {}, worldBooks: [captured, manual], userInput: '走路', playerName: '主角', cotEnabled: false, cotJudgeEnabled: false, splitGen: false, cotPseudoEnabled: false });
    expect([...(withNode.worldBookHits?.map((h) => h.entryId) ?? [])].sort()).toEqual(['cap', 'man']);
  });

  it('a keyword typed THIS round matches immediately (no more one-round lag)', () => {
    const r = build({
      worldBooks: [{ id: 'b', title: 'B', entries: [
        lore({ id: 'dock', injectionMode: 'match_any', keywords: ['夜市'] }),
      ] }],
      userInput: '我走进夜市。',
    });
    expect(r.worldBookHits?.map((h) => h.entryId)).toContain('dock');
  });

  it('a focused captured entry fires when its NPC is present, not when it is merely known', () => {
    const captured = capturedBookOf([{
      ...lore({ id: 'cap', injectionMode: 'match_any', keywords: ['林月'], priority: 40 }),
      matchSource: 'focused',
    }]);

    const absent = build({ worldBooks: [captured], npcs: [{ 名称: '林月', 是否在场: false }] });
    expect(absent.worldBookHits?.map((h) => h.entryId) ?? []).not.toContain('cap');

    const present = build({ worldBooks: [captured], npcs: [{ 名称: '林月', 是否在场: true }] });
    expect(present.worldBookHits?.map((h) => h.entryId)).toContain('cap');
  });

  it('the round\'s triggered event feeds the focused corpus', () => {
    const captured = capturedBookOf([{
      ...lore({ id: 'cap', injectionMode: 'match_any', keywords: ['灯节'] }),
      matchSource: 'focused',
    }]);
    const without = build({ worldBooks: [captured] });
    expect(without.worldBookHits?.map((h) => h.entryId) ?? []).not.toContain('cap');

    const withEvent = build({ worldBooks: [captured], triggeredEventTexts: ['城中灯节开幕'] });
    expect(withEvent.worldBookHits?.map((h) => h.entryId)).toContain('cap');
  });

  it('surfaces capturedHits, skip reasons, budget accounting and hit provenance', () => {
    const r = build({
      worldBooks: [
        { id: 'ub', title: 'U', entries: [lore({ id: 'u1' })] },
        capturedBookOf([
          { ...lore({ id: 'cap' }), matchSource: 'focused' },
          { ...lore({ id: 'capMiss', injectionMode: 'match_any', keywords: ['nowhere'] }), matchSource: 'focused' },
        ]),
      ],
    });
    expect(r.capturedHits).toEqual(['cap']);
    expect(r.worldBookSkipped?.find((x) => x.entryId === 'capMiss')?.reason).toBe('no_keyword');
    expect(r.worldBookBudget?.budget).toBe(6000);
    expect(r.worldBookBudget?.capturedCap).toBe(Math.floor(6000 * 0.6));

    const hit = r.worldBookHits?.find((h) => h.entryId === 'cap');
    expect(hit?.origin).toBe('system-captured');
    expect(hit?.matchSource).toBe('focused');
    expect(hit?.bookId).toBe('system_captured_settings');
    const userHit = r.worldBookHits?.find((h) => h.entryId === 'u1');
    expect(userHit?.origin).toBe('user-authored');
    expect(userHit?.matchSource).toBe('broad');
  });

  it('reads capturedEntryBudgetRatio from prompt settings (consumed, not a dead control)', () => {
    const r = build({
      worldBooks: [capturedBookOf([{ ...lore({ id: 'cap' }), matchSource: 'focused' }])],
      ratio: 0.25,
    });
    expect(r.worldBookBudget?.capturedCap).toBe(Math.floor(6000 * 0.25));
  });

  it('labels hits correctly even when two books share an entry id', () => {
    const r = build({
      worldBooks: [
        { id: 'ub', title: 'U', entries: [lore({ id: 'same', title: 'hand' })] },
        capturedBookOf([{ ...lore({ id: 'same', title: 'cap' }), matchSource: 'focused' }]),
      ],
    });
    const hand = r.worldBookHits?.find((h) => h.title === 'hand');
    const cap = r.worldBookHits?.find((h) => h.title === 'cap');
    expect(hand?.origin).toBe('user-authored');
    expect(hand?.bookId).toBe('ub');
    expect(cap?.origin).toBe('system-captured');
    expect(cap?.bookId).toBe('system_captured_settings');
  });

  it('clamps an out-of-range stored ratio instead of trusting it', () => {
    const r = build({
      worldBooks: [capturedBookOf([{ ...lore({ id: 'cap' }), matchSource: 'focused' }])],
      ratio: 9,
    });
    expect(r.worldBookBudget?.capturedCap).toBe(Math.floor(6000 * 0.8));
  });
});

// ─── P1: Canon Capture prompt injection gating ───────────────

describe('buildSystemPrompt · Canon Capture prompt pieces (P1)', () => {
  function build(over: { active?: boolean; splitGen?: boolean; capture?: boolean } = {}) {
    const { sm } = createMockStateManager({
      世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
      角色: { 基础信息: { 姓名: '主角', 当前位置: '城南' } },
      系统: { 设置: { prompt: {
        enableWorldBook: true,
        ...(over.capture === undefined ? {} : { enableSettingCapture: over.capture }),
      } } },
    });
    return buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: {
        settingAuthority: '【作者设定】本回合立即生效。',
        settingCapture: '【提取协议】输出 setting_updates。',
      },
      worldBooks: [],
      userInput: '我走进夜市。<设定>林月怕水</设定>',
      playerName: '主角',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: over.splitGen ?? false,
      cotPseudoEnabled: false,
      settingCaptureActive: over.active ?? true,
    });
  }

  it('injects BOTH pieces on a tagged single-call round', () => {
    const r = build();
    expect(r.contextPieces['setting_authority']).toContain('作者设定');
    expect(r.contextPieces['setting_capture']).toContain('setting_updates');
  });

  it('injects NOTHING when the round carries no tag', () => {
    const r = build({ active: false });
    expect(r.contextPieces['setting_authority']).toBeUndefined();
    expect(r.contextPieces['setting_capture']).toBeUndefined();
  });

  it('split-gen step1 gets the AUTHORITY prompt but never the capture prompt', () => {
    // step1 writes the prose, so it must obey the setting immediately (D5) — but asking
    // it for structured JSON would break the split contract.
    const r = build({ splitGen: true });
    expect(r.contextPieces['setting_authority']).toContain('作者设定');
    expect(r.contextPieces['setting_capture']).toBeUndefined();
  });

  it('an untagged round is byte-identical to one built with the feature absent', () => {
    const withFlag = build({ active: false });
    const { sm } = createMockStateManager({
      世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
      角色: { 基础信息: { 姓名: '主角', 当前位置: '城南' } },
      系统: { 设置: { prompt: { enableWorldBook: true } } },
    });
    const withoutFlag = buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: {
        settingAuthority: '【作者设定】本回合立即生效。',
        settingCapture: '【提取协议】输出 setting_updates。',
      },
      worldBooks: [],
      userInput: '我走进夜市。<设定>林月怕水</设定>',
      playerName: '主角',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: false,
      cotPseudoEnabled: false,
      // settingCaptureActive omitted entirely
    });
    expect(withFlag.messageEntries.map((e) => e.content))
      .toEqual(withoutFlag.messageEntries.map((e) => e.content));
  });

  it('the capture pieces stay OUT of the gproxy static cache prefix', () => {
    // They appear only on tagged rounds; putting them in the "guaranteed static" prefix
    // would invalidate the whole cached block every time a player marks a setting.
    expect(GPROXY_CACHE_STATIC_PIECE_IDS.has('setting_authority')).toBe(false);
    expect(GPROXY_CACHE_STATIC_PIECE_IDS.has('setting_capture')).toBe(false);
  });

  it('the capture pieces are dropped when the feature toggle is off', () => {
    // `filterByFeatureToggles` must recognise `setting_capture` EXPLICITLY — the
    // `default: true` fallback would otherwise leave the block in the prompt.
    const { sm } = createMockStateManager({
      世界: { 时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 }, 信息: {}, 描述: 'w' },
      角色: { 基础信息: { 姓名: '主角' } },
      系统: { 设置: { prompt: { enableWorldBook: true, enableSettingCapture: false } } },
    });
    const r = buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: {
        settingCapture:
          '<!-- PROMPT_FEATURE:setting_capture:START -->输出 setting_updates。<!-- PROMPT_FEATURE:setting_capture:END -->',
        settingAuthority: '作者设定',
      },
      worldBooks: [],
      userInput: 'x',
      playerName: 'p',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: false,
      cotPseudoEnabled: false,
      settingCaptureActive: true,
    });
    expect(r.contextPieces['setting_capture']).toBeUndefined();
  });
});

// P13 (PO 2026-10-04): a single call writes the whole round — the story and its commands — so it carries what the
// pack's own round flow does: the jailbreak first, and the output protocol (core) right before the format prompt,
// which refers to it as the rules above. A real single-call round without it wrote a path the state tree lacks.
describe('buildSystemPrompt · a single call carries the jailbreak and the output protocol', () => {
  function build(splitGen: boolean, edits: Record<string, string> = {}, gproxyCache = false) {
    const { sm } = createMockStateManager({});
    return buildSystemPrompt({ stateManager: sm as unknown as StateManager, paths: DEFAULT_ENGINE_PATHS,
      packPrompts: { mainRound: 'FORMAT', narratorFrame: 'NARRATOR', jailbreak: 'JAILBREAK', core: 'CORE RULES', ...edits },
      worldBooks: [], userInput: 'hi', playerName: 'p',
      cotEnabled: false, cotJudgeEnabled: false, splitGen, cotPseudoEnabled: false, gproxyCache,
      // As the round's real transform: a switched-off (empty) prompt stays empty.
      transformPrompt: (id, raw) => raw && `${id}:${raw}` });
  }
  const ids = (r: ReturnType<typeof build>) => r.messageEntries.map((e) => e.id);

  it('the jailbreak opens the request; the protocol sits right before the format that refers to it', () => {
    const single = build(false);
    expect(ids(single)[0]).toBe('jailbreak');
    expect(single.contextPieces.jailbreak).toBe('jailbreak:JAILBREAK');
    expect(single.contextPieces.output_protocol).toBe('core:CORE RULES');
    expect(ids(single).indexOf('output_protocol')).toBe(ids(single).indexOf('format_prompt') - 1);
  });
  it('they are sent as the player left them: edited, or not at all when switched off', () => {
    const edited = build(false, { jailbreak: 'MINE', core: '' });
    expect(edited.contextPieces.jailbreak).toBe('jailbreak:MINE');
    expect(edited.contextPieces.output_protocol).toBeUndefined();
    expect(JSON.stringify(edited.messageEntries)).not.toContain('CORE RULES');
  });
  it('split Step 1 writes only the story and carries neither (Step 2 carries both through its flow)', () => {
    const step1 = build(true);
    expect(step1.contextPieces.jailbreak).toBeUndefined();
    expect(step1.contextPieces.output_protocol).toBeUndefined();
  });
  it('both are the same every round: with the gproxy cache on they lead the cached prefix, the jailbreak first', () => {
    const cached = ids(build(false, {}, true));
    expect(cached[0]).toBe('jailbreak');
    expect(cached.indexOf('output_protocol')).toBeLessThan(cached.indexOf('memory_long'));
    expect(GPROXY_CACHE_STATIC_PIECE_IDS.has('jailbreak')).toBe(true);
    expect(GPROXY_CACHE_STATIC_PIECE_IDS.has('output_protocol')).toBe(true);
  });
});
