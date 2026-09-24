import { describe, expect, it, vi } from 'vitest';
import { ResponseParser } from '../../ai/response-parser';
import type { GenerateOptions } from '../../ai/types';
import { RoundStateUpdates } from '../../state-updates/round-state-updates';
import { StateManager } from '../../core/state-manager';
import type { AIService } from '../../ai/ai-service';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../types';
import { BodyPolishStage } from './body-polish-stage';
import { StateUpdateSettlementStage } from './state-update-settlement';

const contract = { inventoryPath: P.inventoryItems, nameField: '名称', quantityField: '数量',
  accounts: { cash: { path: '角色.背包.金钱.现金', decimals: 2 } } };
const template = '主角：{{PLAYER_NAME}}\n回合前背包：{{ITEMS_JSON}}\n余额：{{BALANCES_JSON}}\n已接受正文：{{NARRATIVE}}';
function prepared(): { ctx: PipelineContext; updates: RoundStateUpdates } {
  const updates = new RoundStateUpdates(() => ({ contract, prompt: 'existing v1 protocol',
    source: 'settlement', settlementTemplate: template }));
  const ctx: PipelineContext = { userInput: '继续', actionQueuePrompt: '',
    stateSnapshot: { 角色: { 基础信息: { 姓名: '韩素琴' }, 背包: { 物品: { old: { 名称: '旧包', 数量: 1 } }, 金钱: { 现金: 10 } } } },
    chatHistory: [], messages: [], worldEventTriggered: false, roundNumber: 8, generationId: 'test-8',
    parsedResponse: { text: '最终可见正文：她留下纸巾。', parseOk: true, commands: [] },
    promptMetrics: { step1: { inputTokens: 10, outputTokens: 10, breakdown: [] } },
    meta: { splitGen: true } };
  return { ctx: updates.prepare(ctx), updates };
}

describe('dedicated state settlement, zero-network', () => {
  it('uses final persisted narrative and only accepts the state_updates field from a fenced reply', async () => {
    const { ctx, updates } = prepared();
    const raw = '说明\n```json\n' + JSON.stringify({ state_updates: { version: 1, actions: [
      { op: 'acquire', ref: '__new_1', item: { 名称: '纸巾', 数量: 1 } },
    ] }, commands: [{ action: 'set', path: '角色.背包.金钱.现金', value: 0 }] }) + '\n```';
    const generate = vi.fn(async (_options: GenerateOptions) => raw);
    const checkpoint = { run: vi.fn() };
    ctx.meta.plotVectorCheckpoint = step => { expect(step).toBe('settlement'); return checkpoint; };
    const result = await new StateUpdateSettlementStage({ generate }, new ResponseParser(), updates).execute(ctx);
    const request = generate.mock.calls[0][0];
    expect(request).toMatchObject({ usageType: 'main', stream: false, singleAttempt: true, checkpoint });
    expect(request.messages[0].content).toBe('existing v1 protocol');
    expect(request.messages[1].content).toContain('韩素琴');
    expect(request.messages[1].content).toContain('最终可见正文：她留下纸巾。');
    expect(request.messages[1].content).toContain('"old"');
    expect(request.messages[1].content).toContain('"cash":10');
    expect(result.meta.stateSettlementStrict).toBe(false);
    expect(result.meta.stateSettlementRaw).toBe(raw);
    const compiled = updates.beforeCommands(result);
    expect(compiled.parsedResponse?.commands).toEqual([
      { action: 'set', key: `${P.inventoryItems}.pv_8_1`, value: { 名称: '纸巾', 数量: 1 } },
    ]);
    expect(result.promptMetrics?.settlement?.inputTokens).toBeGreaterThan(0);
    expect(result.promptMetrics?.settlement?.breakdown.reduce((n, row) => n + row.tokens, 0))
      .toBe(result.promptMetrics?.settlement?.inputTokens);
  });

  it('does not spend a settlement call when Step2 structure remains broken', async () => {
    const { ctx, updates } = prepared();
    ctx.parsedResponse = { text: '正文', parseOk: false };
    const generate = vi.fn(async (_options: GenerateOptions) => '{}');
    await expect(new StateUpdateSettlementStage({ generate }, new ResponseParser(), updates).execute(ctx))
      .rejects.toThrow('Step2 结构未修复');
    expect(generate).not.toHaveBeenCalled();
  });

  it('settles the polished text that will be saved, including when polish is enabled', async () => {
    const { ctx, updates } = prepared();
    const state = new StateManager(); state.loadTree({}); state.set('系统.设置.bodyPolish', true);
    const ai = { generate: vi.fn(async (options: GenerateOptions) => options.usageType === 'bodyPolish'
      ? '<正文>最终可见正文：她把纸巾交给晚照。</正文>'
      : '{"state_updates":{"version":1,"actions":[]}}'),
      getConfigForUsage: vi.fn(() => ({ model: 'test' })) } as unknown as AIService;
    const assembler = { renderSingle: () => 'polish contract' } as unknown as PromptAssembler;
    const polished = await new BodyPolishStage(ai, state, assembler).execute(ctx);
    expect(polished.parsedResponse?.text).toContain('交给晚照');
    await new StateUpdateSettlementStage(ai, new ResponseParser(), updates).execute(polished);
    const request = vi.mocked(ai.generate).mock.calls[1][0];
    expect(String(request.messages[1].content)).toContain('交给晚照');
    expect(String(request.messages[1].content)).not.toContain('她留下纸巾');
  });

  it('does not treat malformed or unrelated JSON as an empty state change', async () => {
    const { ctx, updates } = prepared();
    const generate = vi.fn(async (_options: GenerateOptions) => '{"commands":[]}');
    await expect(new StateUpdateSettlementStage({ generate }, new ResponseParser(), updates).execute(ctx))
      .rejects.toThrow('未返回可编译的 state_updates');
    expect(() => updates.beforeSave(ctx)).toThrow('尚未处理');
  });
});
