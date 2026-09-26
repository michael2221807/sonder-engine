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
function packFor(en: boolean): GamePack {
  const prompts = Object.fromEntries(manifest.prompts.map(id => {
    const localized = `prompts-en/${id}.md`;
    return [id, read(en && existsSync(resolve(root, localized)) ? localized : `prompts/${id}.md`)];
  }));
  return { prompts, promptFlows: Object.fromEntries(Object.entries(manifest.promptFlows)
    .map(([id, path]) => [id, JSON.parse(read(path)) as PromptFlowConfig])), engineFragments: {}, rules: {} } as GamePack;
}
const packs = [packFor(false), packFor(true)];
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
function harness(en: boolean, builder: boolean, split: boolean, cot: boolean, cache: boolean) {
  const pack = packs[Number(en)], state = new StateManager();
  state.loadTree({});
  state.set(P.roundNumber, 3);
  state.set(P.playerName, '测试角色');
  state.set('元数据.叙事历史', [{ role: 'assistant', content: history }]);
  state.set('系统.设置.cot', { enabled: cot, judgeEnabled: true });
  state.set('记忆.短期', [{ summary: history, round: 2 }]);
  const registry = new PromptRegistry();
  Object.entries(pack.prompts).forEach(([id, content]) => registry.register({ id, content, enabled: true }));
  const assembler = new PromptAssembler(registry, new TemplateEngine());
  const policy = parseVectorPromptPolicy(rules, pack.prompts.plotVectorMode)!;
  const stage = (active?: boolean, adapter?: AgaPlotVectorAdapter) => new ContextAssemblyStage(state, assembler, { retrieve: () => '' }, behavior,
    pack, P, undefined, undefined, () => [], () => [], builder, () => cache,
    active === undefined ? undefined : c => {
      if (!active) return;
      if (adapter) return adapter.promptTransform(c);
      c.meta.plotVectorPromptMode = true;
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
        }
        if (split) {
          expect(on.meta.splitStep2Followup).toBe(h.pack.prompts.splitGenStep2Followup.trim());
          expect(off.meta.splitStep2Followup).toBeUndefined();
          expect(structuredSources).not.toContain('module:historyFraming');
          expect(off.meta.splitStep2Sources).toContain('module:historyFraming');
        }
        expect(on.messages.some(m => typeof m.content === 'string' && m.content.includes(input))).toBe(true);
        expect(on.messages.some(m => typeof m.content === 'string' && m.content.includes(history))).toBe(true);
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
    const adapted = h.assembler.withTransform(h.policy.transform).renderSingle('mainRound', { EXTRA: oldFormat, GAME_STATE_JSON: oldFormat })!;
    expect(adapted).toContain(`自定义结尾 ${oldFormat}`);
    expect(adapted).toContain(`\n${oldFormat}\n`);
    expect(h.assembler.renderSingle('mainRound', {})!).toContain('必须使用判定');
    expect(h.policy.transform('unrelated', `原样\r\n${oldFormat}`)).toBe(`原样\r\n${oldFormat}`);
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

  it('ability regeneration and Step2 environment abilities use the same guidance and card domain as post-save genesis', () => {
    const repair = parseVectorPromptPolicy(rules, 'mode')!.abilityRepair!;
    expect(repair.field).toBe('abilities');
    expect(repair.template).toContain('{{ITEMS}}');
    expect(repair.guidance).toBe(GENESIS_GUIDANCE);
    const environment = parseVectorPromptPolicy(rules, 'mode')!.environmentAbility!;
    expect(environment.prompt).toBe(`${environment.instruction}\n\n${CARD_API}`);
    expect(AGA_GENESIS_SYSTEM).toBe(`${GENESIS_GUIDANCE}\n\n${CARD_API}`);
    // The pack wording describes the card format the engine reads, not the retired snippet format.
    for (const text of [environment.instruction, environment.repair, repair.template])
      expect(text).not.toMatch(/hooks|onVisit|effects|persistentState|runState|version/);
    expect(CARD_API).toMatch(/onPass/);
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
        // The environment-ability interface goes only where environment tags are written.
        expect(has(0, h.policy.environmentAbility!.prompt)).toBe(split ? 0 : 1);
        expect(requests[0].messages.some(m => String(m.content).includes(input))).toBe(true);
        if (split) {
          expect(has(1, h.policy.mode)).toBe(0);
          expect(has(1, h.policy.environmentAbility!.prompt)).toBe(1);
          expect(prepared.meta.splitStep2Sources?.[0]).toBe('environment-ability');
          // Everything supplied by the host remains unchanged, including state and history.
          expect(prepared.meta.splitStep2Messages?.slice(1)).toEqual(baseStep2);
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
