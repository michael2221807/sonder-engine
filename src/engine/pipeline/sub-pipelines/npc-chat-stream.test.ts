import { describe, it, expect } from 'vitest';
import { NpcChatPipeline } from './npc-chat';
import { StateManager } from '../../core/state-manager';
import { ResponseParser } from '../../ai/response-parser';
import { DEFAULT_ENGINE_PATHS } from '../types';

/**
 * A private chat's reply is a JSON object with the words under `text` (npcChat format). 2026-10-03 release check:
 * the chat streamed the reply as it came, so the bubble showed `{"text":"…` while the NPC answered — the main
 * round's live text had long read the story out of the envelope; the chat now does the same.
 */
function chatWith(reply: string, pieceSize: number) {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 回合序号: 7 }, 社交: { 关系: [{ 名称: '林婉儿', 私聊历史: [] }] } } as never);
  const ai = {
    async generate({ onStreamChunk }: { onStreamChunk?: (chunk: string) => void }): Promise<string> {
      for (const piece of reply.match(new RegExp(`[\\s\\S]{1,${pieceSize}}`, 'g')) ?? []) onStreamChunk?.(piece);
      return reply;
    },
  };
  const assembler = { assemble: () => ({ messages: [{ role: 'system', content: '私聊' }], messageSources: ['npcChat'] }), renderSingle: () => '' };
  const pipe = new NpcChatPipeline(sm, { executeBatch: () => undefined } as never, ai as never, new ResponseParser(), assembler as never,
    { promptFlows: { npcChat: {} }, rules: {} } as never, DEFAULT_ENGINE_PATHS, {} as never);
  // The prompt's variables are not what this is about.
  Object.assign(pipe as unknown as Record<string, unknown>, { buildVariables: () => ({}) });
  return { pipe, sm };
}

describe('NpcChatPipeline streams the words of a reply, not its JSON', () => {
  const WORDS = '【她揉了揉眼睛】"还好……就是脸还有点胀。"\n`他怎么还没睡。`';
  for (const size of [1, 4, 17]) {
    it(`a JSON reply streams only its words (pieces of ${size})`, async () => {
      const { pipe, sm } = chatWith(JSON.stringify({ text: WORDS, commands: [] }), size);
      let shown = '';
      const result = await pipe.chat('林婉儿', '你还好吗？', (chunk) => { shown += chunk; });
      expect(result).toEqual({ success: true, reply: WORDS });
      expect(shown).toBe(WORDS);
      const history = sm.get<Array<{ role: string; content: string }>>('社交.关系.0.私聊历史')!;
      expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(history[1].content).toBe(WORDS);
    });
  }
  it('a reply in plain words still streams as it comes', async () => {
    const { pipe } = chatWith('还好，就是有点疼。', 3);
    let shown = '';
    const result = await pipe.chat('林婉儿', '你还好吗？', (chunk) => { shown += chunk; });
    expect(result.success).toBe(true);
    expect(shown).toBe('还好，就是有点疼。');
  });
});
