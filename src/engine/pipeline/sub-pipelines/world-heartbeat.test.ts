import { describe, it, expect, vi } from 'vitest';
import { WorldHeartbeatPipeline } from './world-heartbeat';
import { createMockStateManager } from '../../__test-utils__/state-manager.mock';

vi.mock('../../core/prompt-debug', () => ({
  emitPromptAssemblyDebug: vi.fn(),
  emitPromptResponseDebug: vi.fn(),
  extractThinkingFromRaw: vi.fn(() => ''),
}));

vi.mock('../../audit/audit-append', () => ({
  appendChangesToLastNarrative: vi.fn(),
}));

vi.mock('../../prompt/environment-block', () => ({
  buildEnvironmentBlock: vi.fn(() => ''),
}));

function createPipeline(
  stateData: Record<string, unknown>,
  fieldOverrides: Record<string, string> = {},
  pathOverrides: Record<string, string> = {},
) {
  const { sm } = createMockStateManager(stateData);

  const paths = {
    npcList: 'NPC列表',
    playerLocation: '角色.当前位置',
    gameTime: '世界.时间',
    roundNumber: '回合数',
    heartbeatHistory: '心跳历史',
    heartbeatHistoryLimit: '心跳历史条数',
    heartbeatForgetRounds: '心跳遗忘回合数',
    weather: '世界.天气',
    festival: '世界.节日',
    environmentTags: '世界.环境',
    npcFieldNames: {
      name: '名称',
      location: '当前位置',
      type: '类型',
      appearance: '外貌',
      description: '描述',
      bodyDescription: '身材描写',
      outfitStyle: '衣着风格',
      innerThought: '内心想法',
      currentActivity: '在做事项',
      personalityTraits: '性格特征',
      lastMainRoundUpdate: '上次主回合更新回合',
      deceased: '已死亡',
      heartbeatLock: '心跳锁定',
      ...fieldOverrides,
    },
    ...pathOverrides,
  };

  const aiService = { generate: vi.fn().mockResolvedValue('{}') };
  const responseParser = { parse: vi.fn().mockReturnValue({ commands: [] }) };
  const promptAssembler = {
    assemble: vi.fn().mockReturnValue({ messages: [], messageSources: [] }),
  };
  const commandExecutor = {
    executeBatch: vi.fn().mockReturnValue({
      hasErrors: false,
      changeLog: { changes: [] },
    }),
  };
  const gamePack = {
    promptFlows: { worldHeartbeat: { id: 'worldHeartbeat', steps: [] } },
  };

  const pipeline = new WorldHeartbeatPipeline(
    sm as never,
    commandExecutor as never,
    aiService as never,
    responseParser as never,
    promptAssembler as never,
    gamePack as never,
    paths as never,
  );

  return { pipeline, sm, aiService, responseParser, promptAssembler, commandExecutor };
}

describe('WorldHeartbeatPipeline', () => {
  // P8 (PO 2026-10-04): the settings page's 遗忘回合数 and 历史保留条数 now do what they say (demo
  // worldHeartbeatService.ts:31-54, 265-268).
  describe('the settings page: forget after N rounds, keep N records', () => {
    const blocks = (promptAssembler: { assemble: { mock: { calls: unknown[][] } } }) =>
      (promptAssembler.assemble.mock.calls[0]?.[1] as Record<string, string> | undefined)?.['NPC_BLOCKS'] ?? '';

    it('leaves out an NPC the main round has not updated for more than N rounds (30 by default)', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: '久未出场', 当前位置: '酒馆', 上次主回合更新回合: 5 },
          { 名称: '刚出场', 当前位置: '酒馆', 上次主回合更新回合: 38 },
          { 名称: '没有记录', 当前位置: '酒馆' },
        ],
        回合数: 40,
        心跳历史: [],
      });
      await pipeline.execute();
      expect(blocks(promptAssembler)).not.toContain('久未出场');
      expect(blocks(promptAssembler)).toContain('刚出场');
      expect(blocks(promptAssembler)).toContain('没有记录');
    });

    it('uses the player\'s own number, and 0 forgets no one', async () => {
      const strict = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [{ 名称: '三回合前', 当前位置: '酒馆', 上次主回合更新回合: 37 }, { 名称: '上回合', 当前位置: '酒馆', 上次主回合更新回合: 39 }],
        回合数: 40, 心跳历史: [], 心跳遗忘回合数: 2,
      });
      await strict.pipeline.execute();
      expect(blocks(strict.promptAssembler)).not.toContain('三回合前');
      expect(blocks(strict.promptAssembler)).toContain('上回合');
      const never = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [{ 名称: '很久以前', 当前位置: '酒馆', 上次主回合更新回合: 1 }],
        回合数: 400, 心跳历史: [], 心跳遗忘回合数: 0,
      });
      await never.pipeline.execute();
      expect(blocks(never.promptAssembler)).toContain('很久以前');
    });

    it('keeps the newest N records of its history (20 by default), the player\'s N when set', async () => {
      const old = Array.from({ length: 25 }, (_, i) => ({ 回合: i }));
      const byDefault = createPipeline({
        角色: { 当前位置: '集市' }, NPC列表: [{ 名称: '甲', 当前位置: '酒馆' }], 回合数: 30, 心跳历史: old,
      });
      await byDefault.pipeline.execute();
      const kept = byDefault.sm.get<Array<{ 回合: number }>>('心跳历史')!;
      expect(kept).toHaveLength(20);
      expect(kept[0].回合).toBe(6);
      expect(kept[19].回合).toBe(30);
      const five = createPipeline({
        角色: { 当前位置: '集市' }, NPC列表: [{ 名称: '甲', 当前位置: '酒馆' }], 回合数: 30, 心跳历史: old, 心跳历史条数: 5,
      });
      await five.pipeline.execute();
      expect(five.sm.get<unknown[]>('心跳历史')).toHaveLength(5);
    });

    // The pack's NPC location field is 位置; the same-place rule read a literal that is no NPC field (2026-10-04).
    it('the same-place rule reads the pack\'s own NPC location field', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [{ 名称: '同处一地', 位置: '集市' }, { 名称: '别处', 位置: '酒馆' }],
        回合数: 1, 心跳历史: [],
      }, { location: '位置' });
      await pipeline.execute();
      expect(blocks(promptAssembler)).toContain('别处');
      expect(blocks(promptAssembler)).not.toContain('同处一地');
    });

    // Code review M2: presence counts a place and a room inside it as one; the heartbeat now agrees.
    it('a place and a room inside it count as the same place, as for presence', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '青云城·客栈·二楼' },
        NPC列表: [{ 名称: '楼下掌柜', 当前位置: '青云城·客栈' }, { 名称: '城外樵夫', 当前位置: '青云城外' }],
        回合数: 1, 心跳历史: [],
      }, {}, { locationPathSeparator: '·' });
      await pipeline.execute();
      expect(blocks(promptAssembler)).toContain('城外樵夫');
      expect(blocks(promptAssembler)).not.toContain('楼下掌柜');
    });
  });

  describe('NPC candidate selection', () => {
    it('excludes NPCs at player location', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: '张三', 当前位置: '集市', 类型: '商人' },
          { 名称: '李四', 当前位置: '酒馆', 类型: '路人' },
        ],
        回合数: 1,
        心跳历史: [],
      });

      await pipeline.execute();

      const callArgs = promptAssembler.assemble.mock.calls[0];
      const variables = callArgs[1] as Record<string, string>;
      expect(variables['NPC_BLOCKS']).toContain('李四');
      expect(variables['NPC_BLOCKS']).not.toContain('张三');
    });

    it('excludes dead NPCs', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: '死者', 当前位置: '酒馆', 已死亡: true },
          { 名称: '活人', 当前位置: '酒馆' },
        ],
        回合数: 1,
        心跳历史: [],
      });

      await pipeline.execute();

      const callArgs = promptAssembler.assemble.mock.calls[0];
      const variables = callArgs[1] as Record<string, string>;
      expect(variables['NPC_BLOCKS']).toContain('活人');
      expect(variables['NPC_BLOCKS']).not.toContain('死者');
    });

    it('excludes heartbeat-locked NPCs', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: '锁定者', 当前位置: '酒馆', 心跳锁定: true },
          { 名称: '普通人', 当前位置: '酒馆' },
        ],
        回合数: 1,
        心跳历史: [],
      });

      await pipeline.execute();

      const callArgs = promptAssembler.assemble.mock.calls[0];
      const variables = callArgs[1] as Record<string, string>;
      expect(variables['NPC_BLOCKS']).toContain('普通人');
      expect(variables['NPC_BLOCKS']).not.toContain('锁定者');
    });

    it('returns false when no candidates', async () => {
      const { pipeline } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: '张三', 当前位置: '集市' },
        ],
        回合数: 1,
        心跳历史: [],
      });

      const result = await pipeline.execute();
      expect(result).toBe(false);
    });

    it('limits candidates to MAX_NPCS_PER_HEARTBEAT (5)', async () => {
      const npcs = Array.from({ length: 10 }, (_, i) => ({
        名称: `NPC_${i}`,
        当前位置: '远方',
        类型: '路人',
      }));
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: npcs,
        回合数: 1,
        心跳历史: [],
      });

      await pipeline.execute();

      const callArgs = promptAssembler.assemble.mock.calls[0];
      const variables = callArgs[1] as Record<string, string>;
      const npcBlocks = variables['NPC_BLOCKS'].split('### ').filter(Boolean);
      expect(npcBlocks.length).toBeLessThanOrEqual(5);
    });

    it('supports English field names (isDead, currentLocation)', async () => {
      const { pipeline, promptAssembler } = createPipeline({
        角色: { 当前位置: '集市' },
        NPC列表: [
          { 名称: 'Alice', currentLocation: '酒馆', isDead: false },
          { 名称: 'Bob', currentLocation: '酒馆', isDead: true },
        ],
        回合数: 1,
        心跳历史: [],
      });

      await pipeline.execute();

      const callArgs = promptAssembler.assemble.mock.calls[0];
      const variables = callArgs[1] as Record<string, string>;
      expect(variables['NPC_BLOCKS']).toContain('Alice');
      expect(variables['NPC_BLOCKS']).not.toContain('Bob');
    });
  });

  describe('missing prompt flow', () => {
    it('returns false when worldHeartbeat flow is missing', async () => {
      const { sm } = createMockStateManager({});
      const pipeline = new WorldHeartbeatPipeline(
        sm as never,
        null as never,
        null as never,
        null as never,
        null as never,
        { promptFlows: {} } as never,
        {} as never,
      );
      const result = await pipeline.execute();
      expect(result).toBe(false);
    });
  });
});
