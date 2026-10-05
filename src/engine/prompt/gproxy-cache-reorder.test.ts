/**
 * applyGproxyCacheReorder — gproxy prompt-cache message reorder.
 *
 * Background (2026-07-19): AGA's main-round prompt interleaves static rules with
 * per-round-volatile content, so there is no natural cacheable prefix. When the
 * per-config "gproxy 缓存" toggle is on, the builder hoists the guaranteed-static
 * pieces to the front as one contiguous block and appends a gproxy magic-cache
 * trigger string to the last of them, so gproxy stamps a `cache_control`
 * breakpoint covering the stable block (verified live: write→read on identical
 * prefix). This guards that reorder's correctness + purity.
 */
import { describe, it, expect } from 'vitest';
import {
  applyGproxyCacheReorder,
  buildSystemPrompt,
  GPROXY_CACHE_MAGIC_STRING,
  GPROXY_CACHE_STATIC_PIECE_IDS,
} from './system-prompt-builder';
import type { MessageEntry } from './world-book';
import { createMockStateManager } from '../__test-utils__/state-manager.mock';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { StateManager } from '../core/state-manager';

const mk = (id: string, role: MessageEntry['role'] = 'system', content = `c_${id}`): MessageEntry => ({
  id,
  title: id,
  category: '系统',
  role,
  content,
});

const ids = (entries: MessageEntry[]): string[] => entries.map((e) => e.id);

describe('applyGproxyCacheReorder', () => {
  it('hoists static pieces to front, keeps dynamic in the middle, tail last', () => {
    // Realistic-ish interleaving: static + volatile mixed, conversation tail at end.
    const input: MessageEntry[] = [
      mk('ai_role'),
      mk('world_prompt'),          // dynamic (has world-book lore)
      mk('world_map'),             // dynamic
      mk('write_style'),           // static
      mk('memory_long'),           // dynamic
      mk('length_prompt'),         // static
      mk('state_environment'),     // dynamic
      mk('format_prompt'),         // static
      mk('player_input', 'assistant'),
      mk('start_task', 'user'),
      mk('cot_masquerade', 'assistant'),
    ];

    const out = applyGproxyCacheReorder(input);

    expect(ids(out)).toEqual([
      // static block (original relative order preserved)
      'ai_role', 'write_style', 'length_prompt', 'format_prompt',
      // dynamic block (original relative order preserved)
      'world_prompt', 'world_map', 'memory_long', 'state_environment',
      // tail (unchanged, last)
      'player_input', 'start_task', 'cot_masquerade',
    ]);
  });

  it('appends the magic string to the LAST static piece only', () => {
    const input: MessageEntry[] = [
      mk('ai_role', 'system', 'ROLE'),
      mk('memory_long', 'system', 'MEM'),
      mk('format_prompt', 'system', 'FORMAT'),
      mk('start_task', 'user', '开始任务'),
    ];
    const out = applyGproxyCacheReorder(input);

    const roleEntry = out.find((e) => e.id === 'ai_role')!;
    const formatEntry = out.find((e) => e.id === 'format_prompt')!;
    // last static piece (format_prompt) carries the marker at the very end
    expect(formatEntry.content).toBe(`FORMAT\n${GPROXY_CACHE_MAGIC_STRING}`);
    // earlier static piece is untouched
    expect(roleEntry.content).toBe('ROLE');
    // exactly one occurrence across the whole prompt
    const total = out.reduce((n, e) => n + (e.content.split(GPROXY_CACHE_MAGIC_STRING).length - 1), 0);
    expect(total).toBe(1);
  });

  it('the cached static block is byte-identical across two rounds with different volatile content', () => {
    // Round A and B differ ONLY in volatile pieces (time/memory). The hoisted+marked
    // static prefix must be identical → this is what makes the cache READ (not just write).
    const roundA: MessageEntry[] = [
      mk('ai_role', 'system', 'ROLE'),
      mk('write_style', 'system', 'STYLE'),
      mk('state_environment', 'system', '时间: 09:00'),
      mk('start_task', 'user', '开始任务'),
    ];
    const roundB: MessageEntry[] = [
      mk('ai_role', 'system', 'ROLE'),
      mk('write_style', 'system', 'STYLE'),
      mk('state_environment', 'system', '时间: 21:30'), // volatile differs
      mk('start_task', 'user', '开始任务'),
    ];
    const outA = applyGproxyCacheReorder(roundA);
    const outB = applyGproxyCacheReorder(roundB);

    // Prefix up to & including the marked static block is identical across rounds.
    const staticPrefix = (out: MessageEntry[]) => {
      const markedIdx = out.findIndex((e) => e.content.includes(GPROXY_CACHE_MAGIC_STRING));
      return out.slice(0, markedIdx + 1).map((e) => `${e.role}:${e.content}`);
    };
    expect(staticPrefix(outA)).toEqual(staticPrefix(outB));
  });

  it('returns a shallow copy unchanged when there are NO static pieces (no marker)', () => {
    const input: MessageEntry[] = [
      mk('world_map'),
      mk('memory_long'),
      mk('start_task', 'user'),
    ];
    const out = applyGproxyCacheReorder(input);
    expect(ids(out)).toEqual(['world_map', 'memory_long', 'start_task']);
    expect(out.some((e) => e.content.includes(GPROXY_CACHE_MAGIC_STRING))).toBe(false);
    expect(out).not.toBe(input); // new array
  });

  it('does not mutate the input entries', () => {
    const input: MessageEntry[] = [
      mk('ai_role', 'system', 'ROLE'),
      mk('format_prompt', 'system', 'FORMAT'),
      mk('memory_long', 'system', 'MEM'),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyGproxyCacheReorder(input);
    expect(input).toEqual(snapshot); // originals untouched (order + content)
  });

  it('static id set includes exactly the intended pieces', () => {
    expect([...GPROXY_CACHE_STATIC_PIECE_IDS].sort()).toEqual(
      ['ai_role', 'cot_core', 'cot_judge', 'format_prompt', 'jailbreak', 'length_prompt',
       'narrative_constraints', 'narrative_rules', 'output_protocol', 'perspective_prompt', 'write_anti_cliche',
       'write_emotion_guard', 'write_no_control', 'write_style'].sort(),
    );
  });

  it('static id set excludes volatile/lore-bearing pieces (guards misclassification)', () => {
    // These MUST NOT be cached — misclassifying any as static breaks cache hits.
    for (const volatile of ['world_prompt', 'world_map', 'npc_away', 'memory_long',
      'memory_mid', 'memory_engram', 'bookmarked_rounds', 'state_environment', 'state_role', 'wb_system_rules']) {
      expect(GPROXY_CACHE_STATIC_PIECE_IDS.has(volatile)).toBe(false);
    }
    // Core static rules ARE included.
    for (const stable of ['ai_role', 'write_style', 'format_prompt', 'cot_core']) {
      expect(GPROXY_CACHE_STATIC_PIECE_IDS.has(stable)).toBe(true);
    }
  });
});

describe('buildSystemPrompt — gproxyCache gating (control toggle)', () => {
  // Minimal fixture: pack prompts for a couple of static slots (narratorFrame→ai_role,
  // writeStyle→write_style, mainRound→format_prompt) + a player name so the VOLATILE
  // state_role piece appears. format_prompt is pushed LATE (after state_role), so a
  // correct hoist must move it BEFORE state_role in the ON case.
  const build = (gproxyCache: boolean): MessageEntry[] => {
    const { sm } = createMockStateManager({
      玩家: { 姓名: 'P' },
      社交: { 关系: [] },
    });
    return buildSystemPrompt({
      stateManager: sm as unknown as StateManager,
      paths: DEFAULT_ENGINE_PATHS,
      packPrompts: { narratorFrame: 'ROLE', writeStyle: 'STYLE', antiCliche: 'ANTI', mainRound: 'FORMAT' },
      worldBooks: [],
      userInput: 'hello',
      playerName: 'P',
      cotEnabled: false,
      cotJudgeEnabled: false,
      splitGen: false,
      cotPseudoEnabled: false,
      gproxyCache,
    }).messageEntries;
  };

  it('consumes the antiCliche pack prompt as the write_anti_cliche piece (slot → builder wiring)', () => {
    // Anti-slop preset (2026-08-06): pack prompt `antiCliche` must surface as a
    // system message via the write_anti_cliche slot, positioned after write_style.
    const entries = build(false);
    const anti = entries.find((e) => e.id === 'write_anti_cliche');
    expect(anti).toBeDefined();
    expect(anti!.role).toBe('system');
    expect(anti!.content).toBe('ANTI');
    const styleIdx = entries.findIndex((e) => e.id === 'write_style');
    expect(entries.findIndex((e) => e.id === 'write_anti_cliche')).toBe(styleIdx + 1);
  });

  it('OFF (default behavior): no magic string; static format_prompt still trails volatile state_role', () => {
    const off = build(false);
    expect(off.some((e) => e.content.includes(GPROXY_CACHE_MAGIC_STRING))).toBe(false);
    const roleIdx = off.findIndex((e) => e.id === 'state_role');
    const fmtIdx = off.findIndex((e) => e.id === 'format_prompt');
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(fmtIdx).toBeGreaterThan(roleIdx); // original order: volatile before this static piece
  });

  it('ON: exactly one magic string on the last static piece, and static hoisted before the volatile piece', () => {
    const on = build(true);
    const total = on.reduce((n, e) => n + (e.content.split(GPROXY_CACHE_MAGIC_STRING).length - 1), 0);
    expect(total).toBe(1);
    const roleIdx = on.findIndex((e) => e.id === 'state_role');
    const fmtIdx = on.findIndex((e) => e.id === 'format_prompt');
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThan(fmtIdx); // hoisted: static now precedes the volatile piece
    expect(on.find((e) => e.id === 'format_prompt')!.content.endsWith(GPROXY_CACHE_MAGIC_STRING)).toBe(true);
  });
});
