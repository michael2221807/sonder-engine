/**
 * Context Compiler v1 — projection rules (plan §2, §5).
 *
 * Fixtures use the engine default field names via DEFAULT_ENGINE_PATHS; the compiler
 * itself never hardcodes them.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import {
  buildSentRegistry,
  compileStep2Context,
  projectLocations,
  projectWorldEvents,
  STEP2_FEW_SHOT_PAIRS,
  LEGACY_FEW_SHOT_PAIRS,
  SUB_PIPELINE_HISTORY_PAIRS,
  WORLD_EVENT_RECENT_COUNT,
  COMPILE_REASON,
} from './context-compiler';

const P = DEFAULT_ENGINE_PATHS;
const LF = P.locationFieldNames;
const EF = P.worldEventFieldNames;

function loc(name: string, parent?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [LF.name]: name, ...(parent ? { [LF.parent]: parent } : {}), [LF.description]: `desc of ${name}`, ...extra };
}

/** A · A·B · A·B·C (current) · A·B·D (sibling) · A·B·C·E (child) · A·F (uncle) · G (other root) */
const LOCATIONS = [
  loc('A'),
  loc('A·B', 'A'),
  loc('A·B·C', 'A·B', { NPC: ['甲'] }),
  loc('A·B·D', 'A·B'),
  loc('A·B·C·E', 'A·B·C'),
  loc('A·F', 'A'),
  loc('G'),
];

function ev(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 事件ID: `evt_${i}`, [EF.participants]: [], [EF.scope]: '', [EF.description]: `event ${i}`, ...extra };
}

describe('constants (PO decisions 2026-09-04)', () => {
  it('step2 gets 2 pairs when on, 3 when off; sub-pipelines 3; recent events 5', () => {
    expect(STEP2_FEW_SHOT_PAIRS).toBe(2);
    expect(LEGACY_FEW_SHOT_PAIRS).toBe(3);
    expect(SUB_PIPELINE_HISTORY_PAIRS).toBe(3);
    expect(WORLD_EVENT_RECENT_COUNT).toBe(5);
  });
});

describe('buildSentRegistry', () => {
  it('reads the builder piece ids', () => {
    expect(buildSentRegistry(['ai_role', 'world_prompt'])).toEqual({ worldDescriptionSent: true, engramBlockSent: false });
    expect(buildSentRegistry(['memory_engram'])).toEqual({ worldDescriptionSent: false, engramBlockSent: true });
    expect(buildSentRegistry([])).toEqual({ worldDescriptionSent: false, engramBlockSent: false });
  });
});

describe('projectLocations — neighbourhood view (same layer + direct parent/child)', () => {
  const fn = { name: LF.name, parent: LF.parent };

  it('keeps full detail for current, parent, siblings, children; skeleton for the rest; order preserved', () => {
    const r = projectLocations(LOCATIONS, 'A·B·C', fn);
    expect(r.currentNotFound).toBe(false);
    expect(r.detailCount).toBe(4); // C, B, D, E
    expect(r.skeletonCount).toBe(3); // A, A·F, G
    const names = r.projected.map((x) => (x as Record<string, unknown>)[LF.name]);
    expect(names).toEqual(LOCATIONS.map((l) => l[LF.name]));

    const byName = new Map(r.projected.map((x) => [(x as Record<string, unknown>)[LF.name] as string, x as Record<string, unknown>]));
    // detail entries are the original objects, untouched
    expect(byName.get('A·B·C')).toBe(LOCATIONS[2]);
    expect(byName.get('A·B')).toBe(LOCATIONS[1]);
    expect(byName.get('A·B·D')).toBe(LOCATIONS[3]);
    expect(byName.get('A·B·C·E')).toBe(LOCATIONS[4]);
    // skeleton = name (+ parent), nothing else — the uncle and the other root lose their description
    expect(byName.get('A·F')).toEqual({ [LF.name]: 'A·F', [LF.parent]: 'A' });
    expect(byName.get('G')).toEqual({ [LF.name]: 'G' });
    expect(byName.get('A')).toEqual({ [LF.name]: 'A' });
  });

  it('root as current: parent empty → no siblings; children kept', () => {
    const r = projectLocations(LOCATIONS, 'A', fn);
    expect(r.currentNotFound).toBe(false);
    // A itself + children A·B, A·F
    expect(r.detailCount).toBe(3);
    const detail = r.projected.filter((x) => LF.description in (x as Record<string, unknown>)).map((x) => (x as Record<string, unknown>)[LF.name]);
    expect(detail).toEqual(['A', 'A·B', 'A·F']);
  });

  it('current location missing from the list (dirty data): children still found, everything else skeleton', () => {
    const r = projectLocations(LOCATIONS, 'A·B·C·E·Z', fn);
    expect(r.currentNotFound).toBe(true);
    expect(r.detailCount).toBe(0);
    expect(r.skeletonCount).toBe(LOCATIONS.length);
    const r2 = projectLocations(LOCATIONS, 'A·B·C·E', fn); // exists but has no children → itself + parent + siblings(none)
    expect(r2.detailCount).toBe(2);
  });

  it('non-object entries pass through untouched', () => {
    const r = projectLocations([loc('A'), 'garbage', null], 'A', fn);
    expect(r.projected[1]).toBe('garbage');
    expect(r.projected[2]).toBeNull();
  });

  it('explicit connections join the neighbourhood only when includeConnections is on', () => {
    const withLinks = [...LOCATIONS.slice(0, 2), loc('A·B·C', 'A·B', { [LF.connections]: ['G'] }), ...LOCATIONS.slice(3)];
    const fnc = { ...fn, connections: LF.connections };
    const off = projectLocations(withLinks, 'A·B·C', fnc);
    expect(off.projected.find((x) => (x as Record<string, unknown>)[LF.name] === 'G')).toEqual({ [LF.name]: 'G' });
    const on = projectLocations(withLinks, 'A·B·C', fnc, { includeConnections: true });
    expect((on.projected.find((x) => (x as Record<string, unknown>)[LF.name] === 'G') as Record<string, unknown>)[LF.description]).toBe('desc of G');
    expect(on.detailCount).toBe(off.detailCount + 1);
  });
});

describe('projectWorldEvents — recent N + relevant M, original order', () => {
  const fieldNames = { participants: EF.participants, scope: EF.scope, description: EF.description };

  it('short logs (≤ recent) are untouched', () => {
    const events = [ev(1), ev(2), ev(3)];
    const r = projectWorldEvents(events, { presentNpcNames: [], locationKeys: [], fieldNames });
    expect(r.projected).toEqual(events);
    expect(r.dropped).toBe(0);
  });

  it('keeps the newest 5, adds up to 5 older relevant ones (newest first), dedups, preserves order', () => {
    const events = [
      ev(0, { [EF.participants]: ['甲'] }),        // relevant by NPC (oldest)
      ev(1, { [EF.description]: '在 C 发生' }),      // relevant by location leaf
      ev(2),
      ev(3, { [EF.participants]: ['乙'] }),         // 乙 not present → not relevant
      ev(4, { [EF.scope]: '波及 A·B·C' }),           // relevant by full path
      ev(5), ev(6), ev(7), ev(8), ev(9),             // recent 5
    ];
    const r = projectWorldEvents(events, { presentNpcNames: ['甲'], locationKeys: ['A·B·C', 'C'], fieldNames });
    expect(r.keptRecent).toBe(5);
    expect(r.keptRelevant).toBe(3);
    expect(r.dropped).toBe(2);
    expect(r.projected.map((e) => (e as Record<string, unknown>)['事件ID'])).toEqual(
      ['evt_0', 'evt_1', 'evt_4', 'evt_5', 'evt_6', 'evt_7', 'evt_8', 'evt_9'],
    );
  });

  it('caps relevant entries at M, choosing the most recent matches', () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(i, { [EF.participants]: ['甲'] }));
    const r = projectWorldEvents(events, { presentNpcNames: ['甲'], locationKeys: [], fieldNames, relevant: 2 });
    expect(r.keptRelevant).toBe(2);
    expect(r.projected.map((e) => (e as Record<string, unknown>)['事件ID'])).toEqual(
      ['evt_5', 'evt_6', 'evt_7', 'evt_8', 'evt_9', 'evt_10', 'evt_11'],
    );
  });
});

describe('compileStep2Context — end to end on a snapshot', () => {
  function snapshot(): Record<string, unknown> {
    return {
      元数据: { 回合序号: 83, 叙事历史: [{ role: 'user', content: 'x' }] },
      世界: {
        描述: 'WORLD-DESC-TEXT',
        信息: { 世界名称: 'W' },
        地点信息: LOCATIONS,
        天气: { 当前: '晴' },
      },
      world: { name: 'W', description: 'SEL-DESC' },
      角色: { 基础信息: { 姓名: '主角', 当前位置: 'A·B·C' }, 身体: { 敏感度: 1 } },
      社交: {
        关系: [{ 名称: '甲', 是否在场: true, 私密信息: { x: 1 } }, { 名称: '乙', 是否在场: false }],
        事件: { 事件记录: Array.from({ length: 8 }, (_, i) => ev(i, i === 0 ? { [EF.participants]: ['甲'] } : {})) },
      },
      记忆: { 短期: [{ summary: 'must be stripped by the always-strip rules' }] },
      系统: { 设置: { prompt: {} } },
    };
  }

  const base = {
    paths: P,
    presentNpcNames: ['甲'],
    memoryBlock: '# Engram\n- fact',
    nsfwMode: false,
  };

  it('projects locations + events, strips world description / selection / Engram block when step1 sent them; trace explains each', () => {
    const snap = snapshot();
    const r = compileStep2Context({ ...base, snapshot: snap, registry: buildSentRegistry(['world_prompt', 'memory_engram']) });
    const json = JSON.parse(r.gameStateJson) as Record<string, unknown>;
    const world = json['世界'] as Record<string, unknown>;
    expect(world['描述']).toBeUndefined();
    expect(json['world']).toBeUndefined();
    expect(world['天气']).toEqual({ 当前: '晴' }); // untouched neighbours survive
    const locs = world['地点信息'] as Array<Record<string, unknown>>;
    expect(locs).toHaveLength(LOCATIONS.length);
    expect(locs.find((l) => l[LF.name] === 'G')).toEqual({ [LF.name]: 'G' });
    expect(locs.find((l) => l[LF.name] === 'A·B·C')?.[LF.description]).toBe('desc of A·B·C');
    const events = ((json['社交'] as Record<string, unknown>)['事件'] as Record<string, unknown>)['事件记录'] as unknown[];
    expect(events).toHaveLength(6); // recent 5 + evt_0 (甲 present)
    expect(r.memoryBlock).toBe('');

    // Production sanitizer still applies: always-strip + NSFW (nsfwMode=false)
    expect((json['记忆'] as Record<string, unknown> | undefined)?.['短期']).toBeUndefined();
    expect((json['角色'] as Record<string, unknown>)['身体']).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('私密信息');

    const targets = r.trace.entries.map((e) => `${e.action}:${e.target}`);
    expect(targets).toEqual([
      `project:${P.locations}`,
      `project:${P.worldEvents}`,
      `strip:${P.worldDescription}`,
      `strip:${P.worldSelection}`,
      'strip:MEMORY_BLOCK',
    ]);
    for (const e of r.trace.entries) {
      expect(e.before).toBeGreaterThan(e.after);
      expect(e.reason.startsWith('compiler.reason.')).toBe(true);
    }
    expect(r.trace.savedTokens).toBeGreaterThan(0);
    expect(r.trace.entries[2].reason).toBe(COMPILE_REASON.sentInStep1);

    // Pure: the input snapshot is not mutated
    expect((snap['世界'] as Record<string, unknown>)['描述']).toBe('WORLD-DESC-TEXT');
    expect(((snap['世界'] as Record<string, unknown>)['地点信息'] as unknown[])[6]).toBe(LOCATIONS[6]);
  });

  it('does NOT strip what step1 did not send (registry-driven dedup)', () => {
    const r = compileStep2Context({ ...base, snapshot: snapshot(), registry: buildSentRegistry([]) });
    const json = JSON.parse(r.gameStateJson) as Record<string, unknown>;
    expect((json['世界'] as Record<string, unknown>)['描述']).toBe('WORLD-DESC-TEXT');
    expect(json['world']).toEqual({ name: 'W', description: 'SEL-DESC' });
    expect(r.memoryBlock).toBeUndefined();
    expect(r.trace.entries.map((e) => e.action)).toEqual(['project', 'project']);
  });

  it('caller strip paths (presence partition) are honoured alongside the compiler ones', () => {
    const r = compileStep2Context({
      ...base,
      snapshot: snapshot(),
      registry: buildSentRegistry(['world_prompt']),
      additionalStripPaths: [P.relationships],
    });
    const json = JSON.parse(r.gameStateJson) as Record<string, unknown>;
    expect((json['社交'] as Record<string, unknown>)['关系']).toBeUndefined();
    expect((json['世界'] as Record<string, unknown>)['描述']).toBeUndefined();
  });

  it('current location missing from the list → trace reason says so (plan §2.2)', () => {
    const snap = snapshot();
    ((snap['角色'] as Record<string, unknown>)['基础信息'] as Record<string, unknown>)['当前位置'] = 'Nowhere';
    const r = compileStep2Context({ ...base, snapshot: snap, registry: buildSentRegistry([]) });
    const locEntry = r.trace.entries.find((e) => e.target === P.locations);
    expect(locEntry?.reason).toBe(COMPILE_REASON.currentNotFound);
    expect(locEntry?.detail?.currentNotFound).toBe(true);
  });

  it('missing location / event arrays → no projection entries, no crash', () => {
    const snap = snapshot();
    delete (snap['世界'] as Record<string, unknown>)['地点信息'];
    (snap['社交'] as Record<string, unknown>)['事件'] = { 事件记录: [ev(1)] };
    const r = compileStep2Context({ ...base, snapshot: snap, registry: buildSentRegistry([]) });
    expect(r.trace.entries).toEqual([]);
    expect(JSON.parse(r.gameStateJson)).toBeTruthy();
  });
});
