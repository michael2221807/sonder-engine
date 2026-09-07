import { describe, it, expect, vi } from 'vitest';
import { CharacterVectorProposePipeline, mergeProposals, CHARACTER_VECTOR_PROPOSE_INTERVAL } from './character-vector-propose';
import { StateManager } from '../../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { CharacterVectorEntry, CharacterVectorsState } from '../../prompt/character-vectors';
import type { GamePack } from '../../types';
import type { AIService } from '../../ai/ai-service';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { IMemoryManager } from '../types';

const paths = DEFAULT_ENGINE_PATHS;

function entry(over: Partial<CharacterVectorEntry> & { name: string }): CharacterVectorEntry {
  return { id: over.name, toward: '', never: '', direction: '', hidden: '', enabled: true, source: 'player', updatedRound: 1, ...over };
}

describe('mergeProposals', () => {
  it('never overwrites a player-written entry, replaces proposed ones, appends new names as proposed', () => {
    const current: CharacterVectorsState = { enabled: true, entries: [
      entry({ name: '沈墨琛', toward: '玩家写的', source: 'player' }),
      entry({ name: '林晚照', toward: '旧提议', source: 'proposed', enabled: false, id: 'keep-id' }),
    ] };
    const { next, applied } = mergeProposals(current, [
      entry({ name: '沈墨琛', toward: '世界写的' }),
      entry({ name: '林晚照', toward: '新提议' }),
      entry({ name: '白诗雅', direction: '红毯出道' }),
    ], 12);
    expect(applied).toBe(2);
    expect(next.entries.map((e) => [e.name, e.toward || e.direction, e.source, e.enabled, e.updatedRound, e.id])).toEqual([
      ['沈墨琛', '玩家写的', 'player', true, 1, '沈墨琛'],
      ['林晚照', '新提议', 'proposed', false, 12, 'keep-id'],
      ['白诗雅', '红毯出道', 'proposed', true, 12, '白诗雅'],
    ]);
  });
});

function makeState(over: Record<string, unknown> = {}) {
  const sm = new StateManager();
  sm.loadTree({
    元数据: { 回合序号: 10, 叙事历史: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '沈墨琛披上大衣。' }] },
    角色: { 基础信息: { 姓名: '韩素琴' } },
    社交: { 关系: [
      { 名称: '沈墨琛', 类型: '重点', 好感度: 30, 描述: '里世界掌权人' },
      { 名称: '林晚照', 类型: '重点', 好感度: 60 },
      { 名称: '路人甲', 类型: '普通' },
    ] },
    系统: { 扩展: { characterVectors: { enabled: true, entries: [] } } },
    ...over,
  });
  return sm;
}

function makePipeline(raw: string, state = makeState(), midTerm: Array<{ 相关角色: string[]; 事件时间: string; 记忆主体: string }> = [
  { 相关角色: ['韩素琴', '沈墨琛'], 事件时间: '1-1-1', 记忆主体: '沈墨琛暗中护她。' },
]) {
  const generate = vi.fn((_req: unknown) => Promise.resolve(raw));
  const assemble = vi.fn((_flow: unknown, _vars: Record<string, string>) => ({ messages: [{ role: 'system' as const, content: 'x' }], messageSources: ['flow:x'] }));
  const memory = { getMidTermEntries: () => midTerm, getLongTermEntries: () => [] } as unknown as IMemoryManager;
  const pack = {
    promptFlows: { characterVectorExtract: { id: 'characterVectorExtract', modules: [] } },
    engineFragments: {},
  } as unknown as GamePack;
  const pipeline = new CharacterVectorProposePipeline(
    { generate } as unknown as AIService,
    { assemble } as unknown as PromptAssembler,
    state,
    memory,
    pack,
    paths,
  );
  return { pipeline, generate, assemble, state };
}

describe('CharacterVectorProposePipeline.execute', () => {
  it('proposes only for main-cast members with recent material, drops the protagonist and unknown names, writes proposed entries', async () => {
    const raw = JSON.stringify({ vectors: [
      { name: '沈墨琛', toward: '当藏品', never: '不解释', direction: '护在加深', hidden: '他叫停了调教' },
      { name: '林晚照', toward: '没有近期材料，应被丢弃' },
      { name: '韩素琴', toward: '主角，应被丢弃' },
      { name: '陌生人', toward: '不在名单' },
    ] });
    const { pipeline, generate, assemble, state } = makePipeline(raw);
    await expect(pipeline.execute()).resolves.toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ usageType: 'memory_summary' });
    const vars = assemble.mock.calls[0]![1];
    expect(vars.CANDIDATE_NAMES).toBe('沈墨琛');
    expect(vars.PLAYER_NAME).toBe('韩素琴');
    expect(vars.CAST_PROFILES).toContain('沈墨琛');
    expect(vars.CAST_PROFILES).not.toContain('林晚照');
    expect(vars.RECENT_NARRATIVE).toContain('披上大衣');
    const stored = state.get<CharacterVectorsState>(paths.characterVectors)!;
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]).toMatchObject({ name: '沈墨琛', toward: '当藏品', hidden: '他叫停了调教', source: 'proposed', updatedRound: 10 });
  });

  it('is a no-op when the switch is off, when nobody has recent material, or when the response is unusable', async () => {
    const off = makeState({ 系统: { 扩展: { characterVectors: { enabled: false, entries: [] } } } });
    const p1 = makePipeline('{"vectors":[{"name":"沈墨琛","toward":"x"}]}', off);
    await expect(p1.pipeline.execute()).resolves.toBe(false);
    expect(p1.generate).not.toHaveBeenCalled();

    const p2 = makePipeline('{"vectors":[]}', makeState(), []);
    await expect(p2.pipeline.execute()).resolves.toBe(false);
    expect(p2.generate).not.toHaveBeenCalled();

    const p3 = makePipeline('not json at all');
    await expect(p3.pipeline.execute()).resolves.toBe(false);
    expect(p3.state.get<CharacterVectorsState>(paths.characterVectors)!.entries).toEqual([]);
  });

  it('keeps a player-written entry intact when the world proposes for the same name', async () => {
    const state = makeState({ 系统: { 扩展: { characterVectors: { enabled: true, entries: [entry({ name: '沈墨琛', toward: '玩家定的', source: 'player' })] } } } });
    const { pipeline } = makePipeline('{"vectors":[{"name":"沈墨琛","toward":"世界想改"}]}', state);
    await expect(pipeline.execute()).resolves.toBe(false);
    expect(state.get<CharacterVectorsState>(paths.characterVectors)!.entries[0]).toMatchObject({ toward: '玩家定的', source: 'player' });
  });

  it('cadence fires every N rounds', () => {
    expect(CharacterVectorProposePipeline.isCadenceRound(0)).toBe(false);
    expect(CharacterVectorProposePipeline.isCadenceRound(CHARACTER_VECTOR_PROPOSE_INTERVAL)).toBe(true);
    expect(CharacterVectorProposePipeline.isCadenceRound(CHARACTER_VECTOR_PROPOSE_INTERVAL + 1)).toBe(false);
  });
});
