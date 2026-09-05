/**
 * Narrative Contract wiring into the NPC private-chat sub-pipeline (R2 second batch,
 * docs/design/narrative-contract-v1-implementation-plan.md S4).
 *
 * Same level as env-tags-wiring.test.ts: bracket-access the private variable builder
 * and pin that the contract block (clauses + focal cast) reaches `NARRATIVE_CONTRACT_BLOCK`
 * with the flow condition set — and that a save without clauses adds nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { NpcChatPipeline } from '@/engine/pipeline/sub-pipelines/npc-chat';

const P = DEFAULT_ENGINE_PATHS;
const F = P.npcFieldNames;

function makePipeline(map: Record<string, unknown>): NpcChatPipeline {
  const sm = { get: vi.fn((path: string) => map[path]) };
  const pack = {
    prompts: {},
    engineFragments: {
      narrativeContractTitle: '【叙事契约】',
      narrativeContractAuthority: '玩家声明：',
      narrativeContractCastLabel: '【主线人物】',
      narrativeContractPeripheralRule: '名单外只作背景。',
      narrativeContractCastSeparator: '、',
    },
  };
  // buildVariables also formats short-term memory; give it an empty list.
  const memoryManager = { getShortTermEntries: () => [] };
  return new NpcChatPipeline(
    sm as never, {} as never, {} as never, {} as never, {} as never, pack as never, P, memoryManager as never,
  );
}

type BuildVars = (npcName: string, npc: Record<string, unknown>, userMessage: string) => Record<string, string>;
const vars = (pipe: NpcChatPipeline, npc: Record<string, unknown>) =>
  (pipe as unknown as { buildVariables: BuildVars }).buildVariables.bind(pipe)(String(npc[F.name]), npc, '你好');

describe('NpcChatPipeline · narrative contract variables', () => {
  const relationships = [
    { [F.name]: '沈墨琛', [F.type]: '重点' },
    { [F.name]: '路人甲', [F.type]: P.npcTypeExclude },
    { [F.name]: '许静姝', [F.type]: P.npcTypeExclude, [F.attention]: true },
  ];

  it('carries the clauses and the 重点 ∪ 关注 cast, and arms the flow condition', () => {
    const pipe = makePipeline({
      [P.relationships]: relationships,
      [P.narrativeContract]: { enabled: true, clauses: [{ id: 'c', text: '沈墨琛底色是护不是猎。', enabled: true, source: 'player', createdRound: 3 }] },
    });
    const v = vars(pipe, relationships[0]);
    expect(v.NARRATIVE_CONTRACT).toBe('1');
    expect(v.NARRATIVE_CONTRACT_BLOCK).toBe([
      '【叙事契约】', '玩家声明：', '1. 沈墨琛底色是护不是猎。', '【主线人物】沈墨琛、许静姝', '名单外只作背景。',
    ].join('\n'));
    // The rest of the variable set is untouched.
    expect(v.NPC_NAME).toBe('沈墨琛');
    expect(v.USER_INPUT).toBe('你好');
  });

  it('adds nothing for a save without clauses (module condition stays falsy)', () => {
    const pipe = makePipeline({ [P.relationships]: relationships });
    const v = vars(pipe, relationships[0]);
    expect(v.NARRATIVE_CONTRACT).toBe('');
    expect(v.NARRATIVE_CONTRACT_BLOCK).toBe('');
  });
});
