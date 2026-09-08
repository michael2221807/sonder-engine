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
  return { id: over.name, heading: '', tension: '', unconfirmed: '', enabled: true, source: 'player', updatedRound: 1, ...over };
}

describe('mergeProposals', () => {
  it('never overwrites a player-written or player-edited (accepted) entry, replaces proposed ones, appends new names as proposed', () => {
    const current: CharacterVectorsState = { enabled: true, entries: [
      entry({ name: '沈墨琛', heading: '玩家写的', source: 'player' }),
      entry({ name: '林晚照', heading: '旧提议', source: 'proposed', enabled: false, id: 'keep-id' }),
      entry({ name: '乔诗诗', heading: '玩家改过的提议', source: 'accepted' }),
    ] };
    const { next, applied } = mergeProposals(current, [
      entry({ name: '沈墨琛', heading: '世界写的' }),
      entry({ name: '林晚照', heading: '新提议' }),
      entry({ name: '乔诗诗', heading: '世界想改回去' }),
      entry({ name: '白诗雅', tension: '防着她，又拿她当尺子' }),
    ], 12);
    expect(applied).toBe(2);
    expect(next.entries.map((e) => [e.name, e.heading || e.tension, e.source, e.enabled, e.updatedRound, e.id])).toEqual([
      ['沈墨琛', '玩家写的', 'player', true, 1, '沈墨琛'],
      ['林晚照', '新提议', 'proposed', false, 12, 'keep-id'],
      ['乔诗诗', '玩家改过的提议', 'accepted', true, 1, '乔诗诗'],
      ['白诗雅', '防着她，又拿她当尺子', 'proposed', true, 12, '白诗雅'],
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
      { name: '沈墨琛', heading: '往护偏', tension: '护了，却不认', unconfirmed: '他叫停了调教' },
      { name: '林晚照', heading: '没有近期材料，应被丢弃' },
      { name: '韩素琴', heading: '主角，应被丢弃' },
      { name: '陌生人', heading: '不在名单' },
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
    expect(stored.entries[0]).toMatchObject({ name: '沈墨琛', heading: '往护偏', tension: '护了，却不认', unconfirmed: '他叫停了调教', source: 'proposed', updatedRound: 10 });
  });

  it('still accepts a legacy four-field response (migrated by the normaliser)', async () => {
    const { pipeline, state } = makePipeline('{"vectors":[{"name":"沈墨琛","toward":"当藏品","never":"不解释","direction":"护在加深","hidden":"他叫停了调教"}]}');
    await expect(pipeline.execute()).resolves.toBe(true);
    expect(state.get<CharacterVectorsState>(paths.characterVectors)!.entries[0]).toMatchObject({ heading: '当藏品; 护在加深', tension: '不解释', unconfirmed: '他叫停了调教' });
  });

  it('hands the model the existing vectors in the v2 shape', async () => {
    const state = makeState({ 系统: { 扩展: { characterVectors: { enabled: true, entries: [entry({ name: '沈墨琛', heading: '往护偏', source: 'proposed' })] } } } });
    const { pipeline, assemble } = makePipeline('{"vectors":[]}', state);
    await pipeline.execute();
    expect(assemble.mock.calls[0]![1].EXISTING_VECTORS).toBe(JSON.stringify({ name: '沈墨琛', heading: '往护偏', tension: '', unconfirmed: '', source: 'proposed' }));
  });

  it('is a no-op when the switch is off, when nobody has recent material, or when the response is unusable', async () => {
    const off = makeState({ 系统: { 扩展: { characterVectors: { enabled: false, entries: [] } } } });
    const p1 = makePipeline('{"vectors":[{"name":"沈墨琛","heading":"x"}]}', off);
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
    const state = makeState({ 系统: { 扩展: { characterVectors: { enabled: true, entries: [entry({ name: '沈墨琛', heading: '玩家定的', source: 'player' })] } } } });
    const { pipeline } = makePipeline('{"vectors":[{"name":"沈墨琛","heading":"世界想改"}]}', state);
    await expect(pipeline.execute()).resolves.toBe(false);
    expect(state.get<CharacterVectorsState>(paths.characterVectors)!.entries[0]).toMatchObject({ heading: '玩家定的', source: 'player' });
  });

  it('cadence fires every N rounds', () => {
    expect(CharacterVectorProposePipeline.isCadenceRound(0)).toBe(false);
    expect(CharacterVectorProposePipeline.isCadenceRound(CHARACTER_VECTOR_PROPOSE_INTERVAL)).toBe(true);
    expect(CharacterVectorProposePipeline.isCadenceRound(CHARACTER_VECTOR_PROPOSE_INTERVAL + 1)).toBe(false);
  });
});

describe('CharacterVectorProposePipeline.executeDetailed (manual trigger)', () => {
  it('reports each outcome by status so the button can toast it', async () => {
    const off = makeState({ 系统: { 扩展: { characterVectors: { enabled: false, entries: [] } } } });
    expect((await makePipeline('{}', off).pipeline.executeDetailed({ manual: true })).status).toBe('disabled');
    expect((await makePipeline('{"vectors":[]}', makeState(), []).pipeline.executeDetailed()).status).toBe('noCandidates');
    expect((await makePipeline('garbage').pipeline.executeDetailed()).status).toBe('empty');
    const failing = makePipeline('x');
    (failing.generate as unknown as { mockImplementation: (f: () => Promise<string>) => void }).mockImplementation(() => Promise.reject(new Error('no config')));
    expect((await failing.pipeline.executeDetailed()).status).toBe('failed');
    const ok = makePipeline('{"vectors":[{"name":"沈墨琛","heading":"往护偏"}]}');
    expect(await ok.pipeline.executeDetailed()).toMatchObject({ status: 'written', applied: 1, candidates: ['沈墨琛'] });
  });

  it('manual: an old save whose mid-term memory is gone still gets candidates from long-term memory and the latest narrative', async () => {
    const state = makeState();
    const { pipeline, generate, assemble } = makePipeline('{"vectors":[{"name":"沈墨琛","heading":"往护偏"},{"name":"林晚照","heading":"往更信赖偏"}]}', state, []);
    // Automatic run: no mid-term material → skip, no call.
    expect((await pipeline.executeDetailed()).status).toBe('noCandidates');
    expect(generate).not.toHaveBeenCalled();
    // Manual run: 沈墨琛 is named in the latest narrative ('沈墨琛披上大衣。'); 林晚照 is nowhere → not a candidate.
    const r = await pipeline.executeDetailed({ manual: true });
    expect(r).toMatchObject({ status: 'written', applied: 1, candidates: ['沈墨琛'] });
    expect((assemble.mock.calls[0]![1]).CANDIDATE_NAMES).toBe('沈墨琛');
    expect(state.get<CharacterVectorsState>(paths.characterVectors)!.entries.map((e) => e.name)).toEqual(['沈墨琛']);
  });
});
