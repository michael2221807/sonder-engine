/**
 * CommandExecutionStage — the main round's commands never write what the engine keeps (code review M-B, 2026-10-04).
 *
 * A paid single-call round once wrote `push 记忆 …` and replaced the whole memory object; a `set` or `delete` there
 * would do the same. The stage refuses commands on the round counter, the story history, the pre-round snapshot,
 * the reasoning ring, the bookmarks and the whole memory tree (and on the roots they live under, written whole); the
 * rest of the batch applies.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommandExecutionStage } from './command-execution';
import { StateManager } from '../../core/state-manager';
import { CommandExecutor } from '../../core/command-executor';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { IBehaviorRunner, PipelineContext } from '../types';
import type { Command } from '../../types';

function run(commands: Command[]) {
  const sm = new StateManager();
  const memory = { 短期: [{ summary: 's' }], 中期: [{ 记忆主体: 'm' }], 长期: [{ content: 'l' }], 隐式中期: [] };
  sm.loadTree({
    元数据: { 回合序号: 12, 叙事历史: [{ role: 'assistant', content: '正文' }], 剧情规划: '' },
    记忆: memory,
    社交: { 关系: [{ 名称: '林晚照', 好感度: 50 }] },
  });
  const memoryBefore = JSON.parse(JSON.stringify(memory)) as unknown;
  const afterCommands = vi.fn();
  const behaviorRunner = { runAfterCommands: afterCommands } as unknown as IBehaviorRunner;
  const stage = new CommandExecutionStage(new CommandExecutor(sm, ['元数据', '记忆', '社交']), behaviorRunner, sm, DEFAULT_ENGINE_PATHS);
  const ctx = { parsedResponse: { commands }, meta: {} } as unknown as PipelineContext;
  return { sm, memoryBefore, afterCommands, out: stage.execute(ctx) };
}

describe('CommandExecutionStage · paths the engine keeps', () => {
  it('refuses a round\'s writes to the memory tree, the story history and the round counter; the rest applies', async () => {
    const { sm, memoryBefore, afterCommands, out } = run([
      { action: 'push', key: '记忆', value: { 角色: '林晚照', 内容: '喂粥' } },
      { action: 'set', key: '记忆.短期', value: [] },
      { action: 'delete', key: '元数据.叙事历史' },
      { action: 'set', key: '元数据', value: {} },
      { action: 'add', key: '元数据.回合序号', value: 1 },
      { action: 'add', key: '社交.关系[名称=林晚照].好感度', value: 4 },
      { action: 'set', key: '元数据.剧情规划', value: '下一步' },
    ]);
    const { commandResults } = await out;
    expect(sm.get('记忆')).toEqual(memoryBefore);
    expect(sm.get('元数据.叙事历史')).toEqual([{ role: 'assistant', content: '正文' }]);
    expect(sm.get('元数据.回合序号')).toBe(12);
    // What the round may write still applies.
    expect(sm.get('社交.关系[名称=林晚照].好感度')).toBe(54);
    expect(sm.get('元数据.剧情规划')).toBe('下一步');
    expect(commandResults?.hasErrors).toBe(true);
    expect(commandResults?.results.filter((r) => !r.success).map((r) => r.command.key))
      .toEqual(['记忆', '记忆.短期', '元数据.叙事历史', '元数据', '元数据.回合序号']);
    // The behaviours see only what was applied.
    const changeLog = afterCommands.mock.calls[0][1] as { changes: Array<{ path: string }> };
    // (Changes carry the resolved path: the filter becomes the entry's index.)
    expect(changeLog.changes.map((c) => c.path)).toEqual(['社交.关系[0].好感度', '元数据.剧情规划']);
  });

  it('a round with nothing protected runs exactly as before', async () => {
    const { out } = run([{ action: 'add', key: '社交.关系[名称=林晚照].好感度', value: 1 }]);
    const { commandResults } = await out;
    expect(commandResults?.hasErrors).toBe(false);
    expect(commandResults?.results).toHaveLength(1);
  });
});
