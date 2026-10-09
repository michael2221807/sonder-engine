import { describe, it, expect } from 'vitest';
import { NpcChatPipeline } from './npc-chat';
import { StateManager } from '../../core/state-manager';
import { ResponseParser } from '../../ai/response-parser';
import { DEFAULT_ENGINE_PATHS } from '../types';

// PO 2026-10-03: undoing a private chat takes the chat back, never a setting changed meanwhile.
describe('NpcChatPipeline.rollbackLastChat', () => {
  it('restores the chat and keeps the player\'s settings as they are now', () => {
    const sm = new StateManager();
    sm.loadTree({ 元数据: { 回合序号: 7 }, 社交: { 关系: [{ 名称: '林婉儿', 私聊历史: [] }] },
      系统: { 设置: { prompt: { wordCountRequirement: 650 } }, actionOptions: { mode: 'action' } } });
    const pipe = new NpcChatPipeline(sm, {} as never, {} as never, {} as never, {} as never, {} as never,
      DEFAULT_ENGINE_PATHS, {} as never);
    // As a chat round does: the snapshot first, then the chat and, meanwhile, the player's settings change.
    Object.assign(pipe as unknown as Record<string, unknown>,
      { _lastChatSnapshot: sm.toSnapshot(), _lastChatNpcName: '林婉儿', _lastChatRound: 7 });
    sm.set('社交.关系', [{ 名称: '林婉儿', 私聊历史: [{ role: 'user', content: '在吗' }] }], 'system');
    sm.set('系统.设置.prompt', { wordCountRequirement: 2500, enableActionOptions: false }, 'user');
    sm.set('系统.actionOptions', { mode: 'story' }, 'user');

    expect(pipe.rollbackLastChat()).toEqual({ success: true });
    expect(sm.get('社交.关系')).toEqual([{ 名称: '林婉儿', 私聊历史: [] }]);
    expect(sm.get('系统.设置.prompt')).toEqual({ wordCountRequirement: 2500, enableActionOptions: false });
    expect(sm.get('系统.actionOptions')).toEqual({ mode: 'story' });
    expect(pipe.canRollbackChat).toBe(false);
  });

  it('after a chat undo the main round can no longer be rolled back, as before (存档瘦身 D1A: the marker goes too)', async () => {
    const sm = new StateManager();
    sm.loadTree({ 元数据: { 回合序号: 7, 上次对话前快照: { 元数据: { 回合序号: 6 } } }, 社交: { 关系: [{ 名称: '林婉儿', 私聊历史: [] }] },
      系统: { 扩展: { rollbackPatch: 'round-start:3' } } });
    const ai = { async generate(): Promise<string> { return JSON.stringify({ text: '嗯。', commands: [] }); } };
    const assembler = { assemble: () => ({ messages: [{ role: 'system', content: '私聊' }], messageSources: ['npcChat'] }), renderSingle: () => '' };
    const pipe = new NpcChatPipeline(sm, { executeBatch: () => undefined } as never, ai as never, new ResponseParser(), assembler as never,
      { promptFlows: { npcChat: {} }, rules: {} } as never, DEFAULT_ENGINE_PATHS, {} as never);
    Object.assign(pipe as unknown as Record<string, unknown>, { buildVariables: () => ({}) });
    expect((await pipe.chat('林婉儿', '在吗')).success).toBe(true);

    expect(pipe.rollbackLastChat()).toEqual({ success: true });
    expect(sm.get(DEFAULT_ENGINE_PATHS.rollbackPatch)).toBeUndefined();
    expect(sm.get(DEFAULT_ENGINE_PATHS.preRoundSnapshot)).toBeUndefined();
    expect(sm.get('社交.关系')).toEqual([{ 名称: '林婉儿', 私聊历史: [] }]);
  });
});
