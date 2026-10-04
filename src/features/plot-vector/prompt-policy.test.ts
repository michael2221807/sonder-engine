import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import manifest from '../../../public/packs/tianming/manifest.json';
import rules from '../../../public/packs/tianming/rules/plot-vector-prompts.json';
import { parseVectorPromptPolicy } from './prompt-policy';
import { AGA_GENESIS_SYSTEM, CARD_API, GENESIS_GUIDANCE } from './genesis/generation-prompt';
import { PromptRegistry } from '../../engine/prompt/prompt-registry';
import { PromptAssembler } from '../../engine/prompt/prompt-assembler';
import { TemplateEngine } from '../../engine/prompt/template-engine';
import { ContextAssemblyStage } from '../../engine/pipeline/stages/context-assembly';
import { MemoryRetriever } from '../../engine/memory/memory-retriever';
import { MemoryManager } from '../../engine/memory/memory-manager';
import { StateManager } from '../../engine/core/state-manager';
import { RoundOwnership } from '../../engine/core/round-ownership';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import type { GamePack, PromptFlowConfig } from '../../engine/types';
import { AICallStage } from '../../engine/pipeline/stages/ai-call';
import { ResponseParser } from '../../engine/ai/response-parser';
import type { AIService } from '../../engine/ai/ai-service';
import type { GenerateOptions } from '../../engine/ai/types';
import { eventBus } from '../../engine/core/event-bus';
import type { EmitAssemblyDebugParams } from '../../engine/core/prompt-debug';
import { AgaPlotVectorAdapter } from './aga-adapter';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { parseNativeRules } from './native-input';
import nativeRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { OpenAIProvider } from '../../engine/ai/providers/openai-provider';
import type { APIConfig, AIMessage } from '../../engine/ai/types';
import { extractPlotEvaluations } from '../../engine/plot/types';

const root = resolve('public/packs/tianming');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
function packFor(en: boolean, fragments = false): GamePack {
  const prompts = Object.fromEntries(manifest.prompts.map(id => {
    const localized = `prompts-en/${id}.md`;
    return [id, read(en && existsSync(resolve(root, localized)) ? localized : `prompts/${id}.md`)];
  }));
  // As PackLoader does: the Chinese fragments, overridden by the English ones for an English pack.
  const engineFragments = !fragments ? {} : { ...JSON.parse(read('prompts/engine-fragments.json')) as Record<string, string>,
    ...(en ? JSON.parse(read('prompts-en/engine-fragments.json')) as Record<string, string> : {}) };
  return { prompts, promptFlows: Object.fromEntries(Object.entries(manifest.promptFlows)
    .map(([id, path]) => [id, JSON.parse(read(path)) as PromptFlowConfig])), engineFragments, rules: {} } as GamePack;
}
const packs = [packFor(false), packFor(true)];
const packsWithFragments = [packFor(false, true), packFor(true, true)];
const oldFormat = '〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗';
const history = `历史原文保留 ${oldFormat}`;
const input = `玩家引用原文 ${oldFormat}`;
const behavior = { checkScheduledEvents: () => false, runOnContextAssembly: () => undefined,
  runAfterCommands: () => undefined, runOnRoundEnd: () => undefined };
function ctx(split: boolean): PipelineContext {
  return { userInput: input, originalUserInput: input, actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [],
    messages: [], worldEventTriggered: false, roundNumber: 3, generationId: 'policy',
    meta: { splitGen: split, roundOwnership: new RoundOwnership(() => ({ profileId: 'p', slotId: 's' }), () => 0, new AbortController().signal) } };
}
function harness(en: boolean, builder: boolean, split: boolean, cot: boolean, cache: boolean, fragments = false) {
  const pack = (fragments ? packsWithFragments : packs)[Number(en)], state = new StateManager();
  state.loadTree({});
  state.set(P.roundNumber, 3);
  state.set(P.playerName, '测试角色');
  state.set('元数据.叙事历史', [{ role: 'assistant', content: history }]);
  state.set('系统.设置.cot', { enabled: cot, judgeEnabled: true });
  state.set('系统.设置.prompt', { wordCountRequirement: 2500 });
  state.set('记忆.短期', [{ summary: history, round: 2 }]);
  const registry = new PromptRegistry();
  Object.entries(pack.prompts).forEach(([id, content]) => registry.register({ id, content, enabled: true }));
  const assembler = new PromptAssembler(registry, new TemplateEngine());
  const policy = parseVectorPromptPolicy(rules, pack.prompts.plotVectorMode)!;
  // The real keyword retriever (Engram off is the default): its short-term section quotes the recent story too.
  const memoryPaths = { shortTermPath: '记忆.短期', midTermPath: '记忆.中期', longTermPath: '记忆.长期', implicitMidTermPath: '记忆.隐式中期',
    shortTermCapacity: 5, midTermRefineThreshold: 25, longTermSummaryThreshold: 50, longTermSummarizeCount: 50, midTermKeep: 0, longTermCap: 30 };
  const retriever = new MemoryRetriever(memoryPaths, new MemoryManager(state, memoryPaths));
  const stage = (active?: boolean, adapter?: AgaPlotVectorAdapter) => new ContextAssemblyStage(state, assembler, retriever, behavior,
    pack, P, undefined, undefined, () => [], builder, () => cache,
    active === undefined ? undefined : c => {
      if (!active) return;
      if (adapter) return adapter.promptTransform(c);
      // As the adapter does (aga-adapter promptTransform): the mode, and the model's view of recent story.
      c.meta.plotVectorPromptMode = true;
      c.meta.historyStoryOnly = true;
      return policy.transform;
    });
  return { pack, state, registry, assembler, policy, stage, ctx: () => ctx(split) };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// PO 2026-10-03: the action-options settings of 「提示词与世界书管理」 reach every assembly (they did not before).
describe('the player\'s action-options switch, mode and pace reach the request (real pack, zero network)', () => {
  for (const en of [false, true]) for (const builder of [false, true]) for (const split of [false, true]) {
    it(`locale=${en ? 'en' : 'zh'} builder=${builder} split=${split}`, async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      const h = harness(en, builder, split, false, false, true);
      const offNote = en ? 'turned action options off' : '玩家关闭了行动选项';
      const actionModule = en ? '# Action Options Specification (active' : '# 行动选项规范（启用时生效）';
      const storyModule = en ? '# Action Options Specification — Story-Driven Mode' : '# 行动选项规范 — 剧情导向模式';
      // The pack's own pace texts, in the pack's language.
      const slowHint = en ? 'Current pacing is **slow pace**' : '当前节奏为**慢节奏**';
      const fastHint = en ? 'Current pacing is **fast pace**' : '当前节奏为**快节奏**';
      const structuredMessages = (c: PipelineContext) => c.meta.splitStep2Messages ?? c.messages;
      const structuredOf = (c: PipelineContext) => structuredMessages(c).map(m => String(m.content)).join('\n');
      for (const active of [false, true]) {
        // Off: no options module, the "off" note, and the round knows it (the follow-up and PostProcess read it).
        h.state.set('系统.设置.prompt', { enableActionOptions: false });
        const off = await h.stage(active).execute(h.ctx());
        expect(off.meta.actionOptionsEnabled).toBe(false);
        expect(structuredOf(off)).toContain(offNote);
        expect(structuredOf(off)).not.toContain(actionModule);
        expect(structuredOf(off)).not.toContain(storyModule);
        // A flow places the note after every module that asks for options (the single call says so in its words).
        if (split || !builder) {
          const asking = structuredMessages(off).filter(m => m.role === 'system' && String(m.content).includes('action_options'));
          expect(String(asking.at(-1)?.content)).toContain(offNote);
        }
        // On, story mode, slow: the story module with the slow pace hint, also in a single call.
        h.state.set('系统.设置.prompt', { enableActionOptions: true });
        h.state.set('系统.actionOptions', { mode: 'story', pace: 'slow', customPrompt: '' });
        const story = await h.stage(active).execute(h.ctx());
        expect(story.meta.actionOptionsEnabled).toBe(true);
        expect(structuredOf(story)).not.toContain(offNote);
        expect(structuredOf(story)).toContain(storyModule);
        expect(structuredOf(story)).toContain(slowHint);
        expect(structuredOf(story)).not.toContain(fastHint);
        // On, action mode: the action module.
        h.state.set('系统.actionOptions', { mode: 'action', pace: 'fast', customPrompt: '' });
        const action = await h.stage(active).execute(h.ctx());
        expect(structuredOf(action)).toContain(actionModule);
        expect(structuredOf(action)).not.toContain(storyModule);
        expect(structuredOf(action)).toContain(fastHint);
        // A damaged mode reads as the default instead of loading no module at all.
        h.state.set('系统.actionOptions', { mode: 'Story', pace: 'quick', customPrompt: '' });
        const damaged = await h.stage(active).execute(h.ctx());
        expect(structuredOf(damaged)).toContain(actionModule);
        expect(structuredOf(damaged)).toContain(fastHint);
      }
    });
  }
});

describe('real pack judgment transition, zero network', () => {
  for (const en of [false, true]) for (const builder of [false, true]) for (const split of [false, true])
    for (const cot of [false, true]) for (const cache of (builder ? [false, true] : [false])) {
      it(`locale=${en ? 'en' : 'zh'} builder=${builder} split=${split} cot=${cot} cache=${cache}`, async () => {
        vi.spyOn(console, 'debug').mockImplementation(() => {});
        const h = harness(en, builder, split, cot, cache);
        const before = h.state.toSnapshot();
        const legacy = await h.stage().execute(h.ctx());
        const off = await h.stage(false).execute(h.ctx());
        expect(off.messages).toEqual(legacy.messages);
        expect(off.meta.splitStep2Messages).toEqual(legacy.meta.splitStep2Messages);
        const on = await h.stage(true).execute(h.ctx());
        if (builder) {
          const format = (c: PipelineContext) => c.messages[c.messageSources!.indexOf('builder:format_prompt')]?.content;
          expect(format(off)).toBe(format(legacy));
          if (split) {
            expect(format(on)).toContain(en ? 'Body Text Only' : '仅正文');
            expect(format(on)).not.toContain('"commands":');
          } else {
            expect(format(on)).toContain('"commands":');
          }
        }
        const activeRules = on.messages.filter((_, i) => /^(module:|builder:)/.test(on.messageSources?.[i] ?? '')
          && !/state_|memory_|history|player_input/.test(on.messageSources?.[i] ?? '')).map(m => m.content).join('\n');
        expect(activeRules).not.toContain(oldFormat);
        expect(activeRules).not.toMatch(/最终判定值 =|Final Judgement Value =|<judge>|大失败=重罚|Critical Failure = severe injury/);
        const structuredContext = split ? on.meta.splitStep2Messages! : on.messages;
        const structuredSources = split ? on.meta.splitStep2Sources! : on.messageSources!;
        const phaseSource = split ? 'module:splitGenStep2' : builder ? 'builder:format_prompt' : 'module:mainRound';
        const phase = String(structuredContext[structuredSources.indexOf(phaseSource)]?.content);
        expect(phase).toContain('"commands"');
        for (const [index, source] of structuredSources.entries()) if (source === 'module:core') {
          const core = String(structuredContext[index].content);
          // Items and money are written by the original commands again.
          expect(core).toContain('set/delete 角色.背包');
          expect(core).not.toMatch(/\{"text":|\| `text` \|/);
          expect(core).toContain('mid_term_memory');
          expect(core).toContain('knowledge_facts');
          expect(core).toContain(en ? '**The narrative is only the story**' : '**正文只写故事**');
        }
        // PO 2026-10-02 (A, replacing D2 of 2026-09-26): with the mode on the narrative writes no notice at all. No rule
        // names a bracket form or a notice (naming a retired form invites it, I27), and the recent story the model
        // sees has its system lines left out: apart from the player's own words, no 〖 reaches the model.
        const everything = on.messages.concat(on.meta.splitStep2Messages ?? []).map(m => String(m.content)).join('\n');
        expect(everything.split(input).join('')).not.toContain('〖');
        expect(everything).not.toMatch(/系统提示|System Notice/);
        expect(h.policy.mode).toContain(en ? 'no rolls, scores, notices or annotation lines' : '不写骰点、分数或任何提示、标注行');
        expect(h.policy.mode).not.toMatch(/〖|系统提示|System Notice/);
        // The judgement mode (the feature off) keeps its markers and its notice example, word for word, wherever core
        // is sent (the builder's single call has no core module at all).
        const offAll = off.messages.concat(off.meta.splitStep2Messages ?? []).map(m => String(m.content)).join('\n');
        if (off.messageSources!.concat(off.meta.splitStep2Sources ?? []).includes('module:core')) {
          expect(offAll).toContain(en ? '- `〖〗` = system judgement / status change' : '- `〖〗` = 系统判定 / 状态变化');
          expect(offAll).toContain(en ? 'Correct: `〖System Notice: Affinity Changed〗`' : '正确：`〖系统提示：好感度变化〗`');
        }
        if (split) {
          expect(on.meta.splitStep2Followup).toBe(h.pack.prompts.splitGenStep2Followup.trim());
          expect(off.meta.splitStep2Followup).toBeUndefined();
          expect(structuredSources).not.toContain('module:historyFraming');
          expect(off.meta.splitStep2Sources).toContain('module:historyFraming');
        }
        // The player's input is never changed. Recent story keeps its words without its system line when on, and is
        // sent verbatim when off.
        // PO 2026-10-03: the narrative call asks for the word-count setting as a target with its band (2B), never a
        // hard-coded 500-1500 or a minimum against it.
        for (const assembled of [on, off]) {
          const narrativeCall = assembled.messages.map(m => String(m.content)).join('\n');
          // The length module, in the pack's own language, on every path (builder and flows).
          expect(narrativeCall).toContain(en ? 'about 2500 characters, between 2000 and 3000' : '约 2500 字，控制在 2000–3000 字之间');
          expect(narrativeCall).not.toMatch(/500-1500|字以上|at least 2500|2500\+ characters|\{\{wordCount/);
        }
        expect(on.messages.some(m => typeof m.content === 'string' && m.content.includes(input))).toBe(true);
        expect(everything).toContain('历史原文保留');
        expect(everything).not.toContain(history);
        expect(off.messages.concat(off.meta.splitStep2Messages ?? []).some(m => String(m.content).includes(history))).toBe(true);
        const structured = (on.meta.splitStep2Messages ?? on.messages).map(m => m.content).join('\n');
        expect(structured).toContain('commands');
        expect(structured).toContain('action_options');
        expect(structured).toContain('世界.环境');
        expect(structured).toContain('世界.天气');
        expect(structured).toContain('世界.节日');
        // Rollback: the optional board must not append reconciliation rules to the base pack.
        const inventoryContract = en ? 'Persist items according to what the player holds at round end'
          : '物品按回合结束时的实际持有情况入档';
        expect(structured).not.toContain(inventoryContract);
        expect((off.meta.splitStep2Messages ?? off.messages).map(m => m.content).join('\n')).not.toContain(inventoryContract);
        expect(on.messages.concat(on.meta.splitStep2Messages ?? []).map(m => String(m.content)).join('\n')).not.toContain('state_updates');
        expect(h.policy.mode).not.toMatch(/扫码|QR payments|Example fragment|示例片段/);
        expect(h.policy.transform('historyFraming', h.pack.prompts.historyFraming)).toBe(h.pack.prompts.historyFraming);
        expect(h.state.toSnapshot()).toEqual(before);
      });
    }

  it('all literal edits match a current pack module; other text and interpolation remain intact', () => {
    const editKeys = rules.replacements.map(e => JSON.stringify([e.promptId, e.from]));
    expect(new Set(editKeys).size).toBe(editKeys.length);
    for (const edit of rules.replacements) expect(packs.some(p => p.prompts[edit.promptId]?.replace(/\r\n/g, '\n').includes(edit.from))).toBe(true);
    const h = harness(false, false, false, true, false);
    h.registry.setUserContent('mainRound', h.pack.prompts.mainRound + '\n自定义结尾 {{EXTRA}}');
    // A value filled into the module's own placeholder is never edited either (2026-10-04: the format prompt's context
    // placeholders moved out to splitGenContext; its word count is still filled in).
    const adapted = h.assembler.withTransform(h.policy.transform).renderSingle('mainRound', { EXTRA: oldFormat, wordCount: oldFormat })!;
    expect(adapted).toContain(`自定义结尾 ${oldFormat}`);
    expect(adapted).toContain(`约${oldFormat}字`);
    expect(h.assembler.renderSingle('mainRound', {})!).toContain('必须使用判定');
    expect(h.policy.transform('unrelated', `原样\r\n${oldFormat}`)).toBe(`原样\r\n${oldFormat}`);
  });

  it('no module that takes part in a round still asks for a numerical verdict once the mode is on', () => {
    // Body polish keeps old verdict blocks already in history, and the image/card helpers use "judge" in another sense.
    const outside = new Set(['bodyPolish', 'imageSceneJudge', 'cardEdgeClassify', 'wordCountReq', 'assistantInjectionContract']);
    for (const pack of packs) {
      const policy = parseVectorPromptPolicy(rules, pack.prompts.plotVectorMode)!;
      for (const [id, text] of Object.entries(pack.prompts)) {
        if (outside.has(id) || id === 'plotVectorMode') continue;
        const out = policy.transform(id, text);
        expect(out, id).not.toMatch(/环境:E|判定决定|判定系统|判定格式|必须使用判定|judgement roll|the dice decide|Judgement System/);
      }
    }
  });

  it('the mode text never mentions the old verdict it replaced, and keeps the story free of annotation lines (I27)', () => {
    // Naming the retired verdict made the model write a placeholder line ("判定跳过…") where one used to be.
    for (const pack of packs) {
      expect(pack.prompts.plotVectorMode).not.toMatch(/判定|算分|scoring procedure|verdict formats|rerun/);
      expect(pack.prompts.plotVectorMode).toMatch(/正文只写故事本身|The narrative is only the story/);
    }
  });

  it('leaves the inventory and money lines of the pack untouched', () => {
    for (const pack of packs) {
      const policy = parseVectorPromptPolicy(rules, pack.prompts.plotVectorMode)!;
      const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n').filter(line => line.includes('角色.背包.'));
      expect(lines(policy.transform('core', pack.prompts.core))).toEqual(lines(pack.prompts.core));
    }
  });

  it('does not enable an incomplete or malformed pack policy', () => {
    expect(parseVectorPromptPolicy(rules, '')).toBeUndefined();
    expect(parseVectorPromptPolicy(rules, 123)).toBeUndefined();
    expect(parseVectorPromptPolicy(rules, 'mode')).toMatchObject({ mode: 'mode' });
    expect(parseVectorPromptPolicy({ ...rules, replacements: [{ from: '' }] }, 'mode')).toBeUndefined();
    expect(parseVectorPromptPolicy(null, 'mode')).toBeUndefined();
    expect(parseVectorPromptPolicy({ ...rules, abilityRepair: { field: 'abilities', template: 'no placeholder' } }, 'mode')).toBeUndefined();
  });

  it('the ability block of a round, Step3 regeneration and the player retry share one guidance and card domain', () => {
    const repair = parseVectorPromptPolicy(rules, 'mode')!.abilityRepair!;
    expect(repair.field).toBe('abilities');
    expect(repair.template).toContain('{{ITEMS}}');
    expect(repair.guidance).toBe(GENESIS_GUIDANCE);
    const block = parseVectorPromptPolicy(rules, 'mode')!.abilityBlock!;
    expect(block.tag).toBe('能力');
    expect(block.prompt).toBe(`${block.instruction}\n\n${GENESIS_GUIDANCE}\n\n${CARD_API}`);
    expect(block.instruction).toContain('<能力>');
    expect(AGA_GENESIS_SYSTEM.startsWith(`${GENESIS_GUIDANCE}\n\n${CARD_API}\n`)).toBe(true);
    // The card domain describes one card; each caller says what to output (an array, `{id, card}` items, or one card).
    expect(CARD_API).not.toMatch(/只输出/);
    expect(AGA_GENESIS_SYSTEM).toMatch(/只输出这一张卡/);
    // The pack wording describes the card format the engine reads, not the retired snippet format.
    for (const text of [block.instruction, repair.template])
      expect(text).not.toMatch(/hooks|onVisit|effects|persistentState|runState|version|\{\{PATH\}\}/);
    expect(CARD_API).toMatch(/onPass/);
    // A malformed block declaration disables the policy instead of half-enabling it.
    expect(parseVectorPromptPolicy({ ...rules, abilityBlock: { tag: '能 力', instruction: 'x' } }, 'mode')).toBeUndefined();
    expect(parseVectorPromptPolicy({ ...rules, abilityBlock: { tag: '能力', instruction: '' } }, 'mode')).toBeUndefined();
  });

  for (const en of [false, true]) it(`leaves opening and explicit phase overrides on their existing builder format, en=${en}`, async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const h = harness(en, true, true, false, false);
    for (const extra of [{ isEnhancedOpening: true }, { step1FlowOverride: 'splitGenMainRoundStep1' }]) {
      const c = h.ctx();
      Object.assign(c.meta, extra);
      const result = await h.stage(true).execute(c);
      const index = result.messageSources!.indexOf('builder:format_prompt');
      expect(result.messages[index].content).toContain('"commands":');
      expect(result.messages[index].content).not.toContain(en ? 'Body Text Only' : '仅正文');
    }
  });

  for (const en of [false, true]) for (const builder of [false, true]) for (const split of [false, true]) for (const conditional of [false, true]) {
    it(`routes existing contracts by phase through real pack requests: en=${en}, builder=${builder}, split=${split}, conditional=${conditional}`, async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      const h = harness(en, builder, split, true, true);
      if (conditional) h.state.set(P.plotDirection, { activeArcIndex: 0, arcs: [{
        id: 'arc', title: '测试线', status: 'active', synopsis: '',
        gauges: [{ id: 'g', name: '进展', min: 0, max: 100, current: 1, initialValue: 0,
          unit: '', description: '', aiUpdatable: true, maxDeltaPerRound: 10 }],
        nodes: [{ id: 'node', arcId: 'arc', title: '当前节点', status: 'active', activatedAtRound: 1,
          completionHint: '抵达', completionConditions: [], completionMode: 'hint_only', activationConditions: [],
          importance: 'skippable', opportunityTiers: [], consecutiveReachedCount: 0, directive: '行进', narrativeGoal: '到达' }],
      }] });
      writePlotVectorControl(true);
      const adapter = new AgaPlotVectorAdapter(h.state, { generate: vi.fn() },
        { saveGame: vi.fn() }, () => ({ profileId: 'phase', slotId: 'test' }),
        parseNativeRules(nativeRules), h.policy);
      const requests: GenerateOptions[] = [];
      const reply = { text: '本轮正文', commands: [],
        action_options: ['继续', '休息', '交谈'], mid_term_memory: '记忆', knowledge_facts: [],
        ...(conditional ? { setting_updates: [], plot_evaluation: [{ thread: '测试线', node_reached: false,
          confidence: 0.2, evidence: '仍在路上', gauge_updates: [{ gauge_id: '进展', delta: 1 }] }] } : {}) };
      const ai = { generate: async (o: GenerateOptions) => { requests.push(o); return JSON.stringify(reply); } } as unknown as AIService;
      try {
        const context = h.ctx();
        if (conditional) context.userInput = context.originalUserInput = `${input}<设定>测试角色喜欢音乐</设定>`;
        const assembled = await h.stage(true, adapter).execute(context);
        const baseStep2 = structuredClone(assembled.meta.splitStep2Messages);
        const prepared = await adapter.prepare(assembled);
        const result = await new AICallStage(ai, new ResponseParser()).execute(prepared);
        expect(requests).toHaveLength(split ? 2 : 1);
        const has = (index: number, content: string) => requests[index].messages.filter(m => m.content === content).length;
        if (builder && split) {
          const formatIndex = prepared.messageSources!.indexOf('builder:format_prompt');
          expect(requests[0].messages[formatIndex].content).toContain(en ? 'Body Text Only' : '仅正文');
          expect(requests[0].messages[formatIndex].content).not.toContain('"commands":');
        }
        expect(has(0, h.policy.mode)).toBe(1);
        // The ability block goes only with the request that writes the round's entries, late in its context.
        expect(has(0, h.policy.abilityBlock!.prompt)).toBe(split ? 0 : 1);
        expect(prepared.meta.responseSidecars).toEqual(['能力']);
        expect(requests[0].messages.some(m => String(m.content).includes(input))).toBe(true);
        if (split) {
          expect(has(1, h.policy.mode)).toBe(0);
          expect(has(1, h.policy.abilityBlock!.prompt)).toBe(1);
          const at = prepared.meta.splitStep2Sources!.indexOf('ability-block');
          expect(prepared.meta.splitStep2Sources!.slice(at + 1).every(source => !source.startsWith('module:'))).toBe(true);
          // Everything supplied by the host remains unchanged, including state and history.
          expect(prepared.meta.splitStep2Messages?.filter((_, i) => i !== at)).toEqual(baseStep2);
          expect(requests[1].messages.at(-2)).toEqual({ role: 'assistant', content: JSON.stringify({ text: reply.text }) });
          expect(requests[1].messages.at(-1)?.role).toBe('user');
          expect(requests[1].messages.at(-1)?.content).toBe(h.pack.prompts.splitGenStep2Followup.trim());
          expect(String(requests[1].messages.at(-1)?.content)).not.toMatch(/state_updates|commands|setting_updates|knowledge_facts/);
        }
        expect(requests.every(r => r.messages.every(m => !String(m.content).includes('state_updates')))).toBe(true);
        const structuredRequest = requests[split ? 1 : 0];
        const sources = split ? prepared.meta.splitStep2Sources! : prepared.messageSources!;
        const from = (pattern: RegExp) => sources.flatMap((source, i) => pattern.test(source) ? [String(structuredRequest.messages[i].content)] : []);
        const capture = from(/^(module:settingCapture|builder:setting_capture)$/);
        const evaluation = from(/^(module:plotEvaluationStep2|builder:plot_evaluation_step2)$/);
        // Existing legacy single-call flow has no settingCapture module.
        // Preserve/report that boundary rather than claiming a new integration here.
        expect(capture).toHaveLength(conditional && (builder || split) ? 1 : 0);
        expect(evaluation).toHaveLength(conditional ? 1 : 0);
        if (conditional) {
          if (builder || split) expect(capture[0]).toContain('setting_updates');
          expect(evaluation[0]).toContain('plot_evaluation');
          expect(evaluation[0]).toContain('gauge_updates');
          expect(result.parsedResponse?.settingUpdates).toEqual([]);
          expect(result.parsedResponse?.customFields?.plot_evaluation).toEqual(reply.plot_evaluation);
          expect(extractPlotEvaluations(result.parsedResponse?.customFields)).toMatchObject([
            { thread: '测试线', node_reached: false, gauge_updates: [{ gauge_id: '进展', delta: 1 }] },
          ]);
        }
      } finally { adapter.dispose(); }
    });
  }

  // Phase 4: "a light nudge, never a verdict" is said once, in the mode text; nothing else in the real requests restates it.
  const DOCTRINE = { zh: /蝴蝶翅膀|不是成败|成败阈值|不作为成败|成功概率|补骰|不必回应|作少量可选推动|不另编数值裁决|自动受伤|不是必须兑现/,
    en: /butterfly|outcome command|outcome roll|success\/failure|success probability|substitute roll|replacement roll|optional nudge|automatic injury|must be honoured/i };
  for (const en of [false, true]) for (const builder of [false, true]) for (const split of [false, true]) {
    it(`the nudge doctrine appears once, in the mode text only: en=${en}, builder=${builder}, split=${split}`, async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      const h = harness(en, builder, split, true, false);
      h.state.set(P.characterAttributes, { 体质: 12, 心性: 10, 魅力: 12, 直觉: 5, 气运: 15, 悟性: 15 });
      writePlotVectorControl(true);
      const adapter = new AgaPlotVectorAdapter(h.state, { generate: vi.fn() }, { saveGame: vi.fn() },
        () => ({ profileId: 'once', slotId: 'test' }), parseNativeRules(nativeRules), h.policy);
      const requests: GenerateOptions[] = [];
      const ai = { generate: async (o: GenerateOptions) => { requests.push(o); return JSON.stringify({ text: '正文', commands: [], action_options: ['a', 'b', 'c'] }); } } as unknown as AIService;
      try {
        const prepared = await adapter.prepare(await h.stage(true, adapter).execute(h.ctx()));
        await new AICallStage(ai, new ResponseParser()).execute(prepared);
        const all = requests.flatMap(r => r.messages.map(m => String(m.content)));
        expect(all.filter(c => c.includes('维度说明与数值'))).toHaveLength(1); // the impulse data is in the request
        const restating = all.filter(c => DOCTRINE[en ? 'en' : 'zh'].test(c));
        expect(restating).toEqual([h.policy.mode]);
        // Step2 still carries the ability block and never the impulse data.
        if (split) expect(requests[1].messages.some(m => String(m.content).includes('维度说明与数值'))).toBe(false);
      } finally { adapter.dispose(); }
    });
  }

  for (const split of [false, true]) it(`debug snapshot is the final request, split=${split}`, async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const h = harness(false, true, split, true, true);
    writePlotVectorControl(true);
    h.state.set(P.characterAttributes, { 体质: 5, 心性: 8, 魅力: 9, 悟性: 1, 直觉: 3, 气运: 4 });
    const adapter = new AgaPlotVectorAdapter(h.state, { generate: vi.fn() },
      { saveGame: vi.fn() }, () => ({ profileId: 'test', slotId: 'test' }),
      parseNativeRules(nativeRules), h.policy);
    const events: EmitAssemblyDebugParams[] = [];
    const unsubscribe = eventBus.on<EmitAssemblyDebugParams>('ui:debug-prompt', e => { events.push(e); });
    try {
      const assembled = await h.stage(true, adapter).execute(h.ctx());
      expect(events).toHaveLength(0);
      const c = await adapter.prepare(assembled);
      const userIndex = c.messages.map(m => m.role).lastIndexOf('user');
      expect(c.messageSources).toContain('plot-vector');
      expect(c.messages.slice(userIndex + 1).every(m => m.role === 'assistant')).toBe(true);
      expect(c.messageSources!.indexOf('plot-vector-mode')).toBeLessThan(userIndex);
      expect(c.messageSources!.indexOf('plot-vector')).toBeLessThan(userIndex);
      const generate = vi.fn(async (_options: GenerateOptions): Promise<string> => { throw new Error('boundary reached'); });
      await expect(new AICallStage({ generate } as unknown as AIService, new ResponseParser()).execute(c)).rejects.toThrow('boundary reached');
      expect(events).toHaveLength(1);
      expect(events[0].messages).toEqual(generate.mock.calls[0][0].messages);
      expect(events[0].messageSources).toEqual(c.messageSources);
      expect(events[0].roundNumber).toBe(3);
      expect(events[0].variables).toBeDefined();
      // Exercise the actual OpenAI-compatible serializer used by gproxy. The
      // transport only checks shape and returns a rejection, never fake prose.
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const wire = JSON.parse(String(init.body)) as { messages: AIMessage[] };
        expect(wire.messages).toEqual(c.messages);
        const lastUser = wire.messages.map(m => m.role).lastIndexOf('user');
        expect(wire.messages.slice(lastUser + 1).every(m => m.role === 'assistant')).toBe(true);
        return new Response('offline boundary', { status: 503 });
      });
      vi.stubGlobal('fetch', fetch);
      const config = { id: 'test', name: 'test', provider: 'openai', url: 'http://local.invalid', apiKey: 'test-only',
        model: 'claudecode/claude-opus-4-8', temperature: 1, maxTokens: 16000, contextWindow: 1000000, enabled: true } as APIConfig;
      await expect(new OpenAIProvider(config).generate({ messages: c.messages, stream: false })).rejects.toThrow('503');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); adapter.dispose(); }
  });
});
