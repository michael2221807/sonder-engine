/**
 * Narrative Contract — S0 pure functions (docs/design/narrative-contract-v1-implementation-plan.md §3 S0).
 *
 * Guards:
 * - focal cast = 「重点」 type (or unmarked) ∪ 「关注」 flag; 「普通」 excluded unless watched; de-duplicated
 * - block rendering: empty → '', cast-only, disabled clause / proposed clause / master switch
 * - reader degrades malformed state to the empty contract
 * - schema default gives old saves an empty contract with zero migration
 * - the raw contract never leaks into GAME_STATE_JSON
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { buildSchemaDefaultTree } from '../pipeline/state-defaults';
import { stringifySnapshotForPrompt } from '../memory/snapshot-sanitizer';
import { COMPILE_REASON } from './context-compiler';
import {
  activeClauses,
  buildNarrativeContractBlock,
  emptyNarrativeContract,
  narrativeContractTraceEntry,
  readNarrativeContract,
  resolveFocalCast,
  resolveNarrativeContractFragments,
  type NarrativeContractState,
} from './narrative-contract';

const paths = DEFAULT_ENGINE_PATHS;
const F = paths.npcFieldNames;

const fragments = resolveNarrativeContractFragments({
  narrativeContractTitle: '【叙事契约】',
  narrativeContractAuthority: '以下由玩家声明，优先级高于推断。',
  narrativeContractCastLabel: '【主线人物】',
  narrativeContractPeripheralRule: '不在名单里的人物只作背景。',
  narrativeContractCastSeparator: '、',
});

function npc(name: string, type?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [F.name]: name, ...(type === undefined ? {} : { [F.type]: type }), ...extra };
}

function contract(clauses: Array<Partial<NarrativeContractState['clauses'][number]> & { text: string }>, enabled = true): NarrativeContractState {
  return {
    enabled,
    clauses: clauses.map((c, i) => ({
      id: c.id ?? `c${i}`,
      text: c.text,
      enabled: c.enabled ?? true,
      source: c.source ?? 'player',
      createdRound: c.createdRound ?? 1,
    })),
  };
}

describe('resolveFocalCast — 重点 ∪ 关注', () => {
  it('includes 重点, unmarked and watched NPCs; excludes 普通', () => {
    const list = [
      npc('沈墨琛', '重点'),
      npc('乔诗诗'),                       // unmarked → key (Engram rule)
      npc('路人甲', paths.npcTypeExclude),  // 普通 → out
      npc('许静姝', paths.npcTypeExclude, { [F.attention]: true }), // 普通 but watched → in
      npc('陆知远', paths.npcTypeExclude, { [F.attention]: false }),
    ];
    expect(resolveFocalCast(list, paths)).toEqual(['沈墨琛', '乔诗诗', '许静姝']);
  });

  it('de-duplicates names, skips blanks and non-objects, tolerates a non-array', () => {
    const list = [npc('沈墨琛', '重点'), npc('沈墨琛', '重点'), npc('  ', '重点'), 'junk', null, npc('林晚照', '重点')];
    expect(resolveFocalCast(list, paths)).toEqual(['沈墨琛', '林晚照']);
    expect(resolveFocalCast(undefined, paths)).toEqual([]);
    expect(resolveFocalCast({ not: 'a list' }, paths)).toEqual([]);
  });

  it('reads the field names from the path config, never hardcoded', () => {
    const custom = { ...paths, npcTypeExclude: 'minor', npcFieldNames: { ...F, name: 'n', type: 't', attention: 'w' } };
    const list = [{ n: 'A', t: 'minor' }, { n: 'B', t: 'minor', w: true }, { n: 'C', t: 'lead' }];
    expect(resolveFocalCast(list, custom)).toEqual(['B', 'C']);
  });
});

describe('buildNarrativeContractBlock', () => {
  it('renders title, authority, numbered clauses, cast line and peripheral rule', () => {
    const block = buildNarrativeContractBlock({
      contract: contract([{ text: '沈墨琛底色是护不是猎。' }, { text: '条例只能由玩家修改。' }]),
      cast: ['韩素琴', '沈墨琛'],
      fragments,
    });
    expect(block).toBe([
      '【叙事契约】',
      '以下由玩家声明，优先级高于推断。',
      '1. 沈墨琛底色是护不是猎。',
      '2. 条例只能由玩家修改。',
      '【主线人物】韩素琴、沈墨琛',
      '不在名单里的人物只作背景。',
    ].join('\n'));
  });

  it('is empty when there is nothing to say', () => {
    expect(buildNarrativeContractBlock({ contract: emptyNarrativeContract(), cast: [], fragments })).toBe('');
  });

  it('does NOT render a cast-only block: without a clause the feature is untouched and injects nothing', () => {
    // Nearly every NPC in an existing save is 重点 — a cast-only block would change every
    // save's prompt without the player ever opening the tab.
    expect(buildNarrativeContractBlock({ contract: emptyNarrativeContract(), cast: ['韩素琴'], fragments })).toBe('');
  });

  it('renders clauses without a cast line when the cast is empty', () => {
    const block = buildNarrativeContractBlock({ contract: contract([{ text: 'x' }]), cast: [], fragments });
    expect(block).toBe('【叙事契约】\n以下由玩家声明，优先级高于推断。\n1. x');
  });

  it('omits disabled and proposed clauses; renumbers the rest', () => {
    const block = buildNarrativeContractBlock({
      contract: contract([
        { text: '关掉的', enabled: false },
        { text: '世界提议的', source: 'proposed' },
        { text: '接受的', source: 'accepted' },
        { text: '玩家写的' },
      ]),
      cast: [],
      fragments,
    });
    expect(block).not.toContain('关掉的');
    expect(block).not.toContain('世界提议的');
    expect(block).toContain('1. 接受的');
    expect(block).toContain('2. 玩家写的');
  });

  it('is empty when the master switch is off, even with clauses and cast', () => {
    expect(buildNarrativeContractBlock({ contract: contract([{ text: 'x' }], false), cast: ['A'], fragments })).toBe('');
  });

  it('omits label lines the pack did not provide and falls back to a comma separator', () => {
    const bare = resolveNarrativeContractFragments(undefined);
    const block = buildNarrativeContractBlock({ contract: contract([{ text: 'x' }]), cast: ['A', 'B'], fragments: bare });
    expect(block).toBe('1. x\nA, B');
  });
});

describe('readNarrativeContract', () => {
  const read = (value: unknown) => readNarrativeContract({ get: () => value as never }, paths);

  it('returns the empty contract for missing or malformed state', () => {
    expect(read(undefined)).toEqual({ enabled: true, clauses: [] });
    expect(read('nonsense')).toEqual({ enabled: true, clauses: [] });
    expect(read({ enabled: false, clauses: 'nope' })).toEqual({ enabled: false, clauses: [] });
  });

  it('normalises clauses: drops textless ones, defaults source/enabled/id/createdRound', () => {
    const out = read({ clauses: [{ text: '  a  ' }, { text: '' }, 7, { id: 'k', text: 'b', enabled: false, source: 'weird', createdRound: 'x' }] });
    expect(out.enabled).toBe(true);
    expect(out.clauses).toEqual([
      { id: 'clause-0', text: 'a', enabled: true, source: 'player', createdRound: 0 },
      { id: 'k', text: 'b', enabled: false, source: 'player', createdRound: 0 },
    ]);
    expect(activeClauses(out).map((c) => c.text)).toEqual(['a']);
  });
});

describe('persistence contract (CLAUDE.md 存档铁律)', () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'public/packs/tianming/schemas/state-schema.json'), 'utf-8')) as Record<string, unknown>;

  it('the pack schema defaults the contract to enabled + no clauses (old saves need no migration)', () => {
    const tree = buildSchemaDefaultTree(schema);
    const ext = (tree['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>;
    expect(ext['narrativeContract']).toEqual({ enabled: true, clauses: [] });
    expect(paths.narrativeContract).toBe('系统.扩展.narrativeContract');
  });

  it('the raw contract is stripped from GAME_STATE_JSON', () => {
    const snapshot = {
      系统: { 扩展: { narrativeContract: { enabled: true, clauses: [{ id: 'c', text: 'SECRET_PROPOSED', enabled: true, source: 'proposed', createdRound: 1 }] } } },
      世界: { 描述: 'kept' },
    };
    const json = stringifySnapshotForPrompt(snapshot, true, 0);
    expect(json).not.toContain('narrativeContract');
    expect(json).not.toContain('SECRET_PROPOSED');
    expect(json).toContain('kept');
  });
});

describe('narrativeContractTraceEntry', () => {
  it('records a keep action with the both-steps reason and counts', () => {
    expect(narrativeContractTraceEntry(120, 3, 5)).toEqual({
      target: 'contract', action: 'keep', reason: COMPILE_REASON.sentInBothSteps, before: 120, after: 120, detail: { clauses: 3, cast: 5 },
    });
  });
});
