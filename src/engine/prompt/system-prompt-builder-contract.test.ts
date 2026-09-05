/**
 * `buildSystemPrompt` · narrative_contract piece (plan §3 S1).
 *
 * The block is pre-rendered by the caller; the builder wraps it in the pack slot
 * (player-overridable via builtin overrides), places it right after the narrative
 * constraints, and emits NOTHING when the block is empty.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, GPROXY_CACHE_STATIC_PIECE_IDS } from './system-prompt-builder';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { createMockStateManager } from '../__test-utils__';
import type { StateManager } from '../core/state-manager';

function build(block: string | undefined, packPrompts: Record<string, string> = {}, overrides: Array<{ slotId: string; userContent?: string; content?: string; enabled?: boolean }> = []) {
  const { sm } = createMockStateManager({ 系统: { 设置: { prompt: { enableWorldBook: false } } } });
  return buildSystemPrompt({
    stateManager: sm as unknown as StateManager,
    paths: DEFAULT_ENGINE_PATHS,
    packPrompts,
    builtinOverrides: overrides as never,
    worldBooks: [],
    userInput: '走路',
    playerName: '主角',
    cotEnabled: false,
    cotJudgeEnabled: false,
    splitGen: true,
    cotPseudoEnabled: false,
    narrativeContractBlock: block,
  });
}

describe('buildSystemPrompt · narrative_contract piece', () => {
  it('wraps the block in the pack slot text and places it after narrative_constraints', () => {
    const r = build('BLOCK-TEXT', { narrativeConstraints: '总约束', narrativeContract: '{{NARRATIVE_CONTRACT_BLOCK}}\n\n使用说明' });
    const ids = r.messageEntries.map((e) => e.id);
    const idx = ids.indexOf('narrative_contract');
    expect(ids.indexOf('narrative_constraints')).toBeGreaterThanOrEqual(0);
    expect(idx).toBe(ids.indexOf('narrative_constraints') + 1);
    expect(idx).toBeLessThan(ids.indexOf('player_input'));
    expect(r.messageEntries[idx].content).toBe('BLOCK-TEXT\n\n使用说明');
    expect(r.messageEntries[idx].role).toBe('system');
  });

  it('falls back to the bare block when the pack has no slot text', () => {
    const r = build('BLOCK-TEXT');
    expect(r.messageEntries.find((e) => e.id === 'narrative_contract')?.content).toBe('BLOCK-TEXT');
  });

  it('honours a player override of the slot text', () => {
    const r = build('BLOCK-TEXT', { narrativeContract: 'pack' }, [{ slotId: 'narrative_contract', userContent: '自定义 {{NARRATIVE_CONTRACT_BLOCK}}' }]);
    expect(r.messageEntries.find((e) => e.id === 'narrative_contract')?.content).toBe('自定义 BLOCK-TEXT');
  });

  it('emits no piece when the block is empty or absent (byte-identical prompt)', () => {
    const without = build(undefined, { narrativeContract: 'x {{NARRATIVE_CONTRACT_BLOCK}}' });
    const empty = build('', { narrativeContract: 'x {{NARRATIVE_CONTRACT_BLOCK}}' });
    expect(without.messageEntries.map((e) => e.id)).not.toContain('narrative_contract');
    expect(empty.messageEntries.map((e) => e.content)).toEqual(without.messageEntries.map((e) => e.content));
  });

  it('is a dynamic piece — never part of the gproxy static cache prefix', () => {
    expect(GPROXY_CACHE_STATIC_PIECE_IDS.has('narrative_contract')).toBe(false);
  });
});
